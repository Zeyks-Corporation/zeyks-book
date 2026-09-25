/**
 * Zeyks Book — business lifecycle.
 *
 * createBusiness seeds the tenant: the business document, the caller's
 * membership row (which every security-rule check resolves through), the
 * starter chart of accounts and the default fiscal year. Membership rows are
 * created only here and by the invite function — never by clients.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { seedChartOfAccounts } from './posting';

const db = getFirestore();

const NAME_MAX = 120;

export const createBusiness = onCall<{
  business_name: string; owner_name?: string; email?: string; phone?: string;
  pan_number?: string; address?: string; city?: string; currency_symbol?: string;
  fiscal_year_start_month?: number; vat_registered?: boolean; vat_rate?: number; track_inventory?: boolean;
}>(
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to create a business.');

    const name = (request.data?.business_name ?? '').trim();
    if (!name || name.length > NAME_MAX) {
      throw new HttpsError('invalid-argument', 'Please give the business a name of at most 120 characters.');
    }

    const businessRef = db.collection('businesses').doc();
    const membershipRef = db.collection('businessMemberships').doc(`${uid}_${businessRef.id}`);

    await db.runTransaction(async (tx) => {
      tx.set(businessRef, {
        business_name: name,
        owner_name: (request.data?.owner_name ?? '').trim(),
        email: (request.data?.email ?? '').trim(),
        phone: (request.data?.phone ?? '').trim(),
        pan_number: (request.data?.pan_number ?? '').trim(),
        address: (request.data?.address ?? '').trim(),
        city: (request.data?.city ?? '').trim(),
        currency: 'NPR',
        currency_symbol: (request.data?.currency_symbol ?? 'NPR').trim() || 'NPR',
        calendar: 'BS',
        fiscal_year_start_month: Number(request.data?.fiscal_year_start_month ?? 4) || 4, // Shrawan opens the statutory fiscal year
        vat_registered: Boolean(request.data?.vat_registered ?? false),
        vat_rate: Number(request.data?.vat_rate ?? 13) || 13,
        track_inventory: Boolean(request.data?.track_inventory ?? false),
        owner_uid: uid,
        created_at: FieldValue.serverTimestamp(),
      });
      tx.set(membershipRef, {
        uid,
        business_id: businessRef.id,
        business_name: name,
        role: 'OWNER',
        created_at: FieldValue.serverTimestamp(),
      });
    });

    // Seed the starter chart (idempotent — a re-run leaves existing rows alone).
    await seedChartOfAccounts(businessRef.id);

    return { business_id: businessRef.id, role: 'OWNER' };
  },
);

export const updateBusiness = onCall<Record<string, unknown>>(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to change settings.');

  const businessId = String(request.data?.business_id ?? '');
  if (!businessId) throw new HttpsError('invalid-argument', 'Which business?');

  const membership = await db.collection('businessMemberships').doc(`${uid}_${businessId}`).get();
  if (!membership.exists || (membership.data() as { role?: string }).role !== 'OWNER') {
    throw new HttpsError('permission-denied', 'Only the owner of this business can change its settings.');
  }

  // Only these fields may change, and each is validated — clients cannot push
  // arbitrary keys into the document.
  const allowed = ['business_name', 'owner_name', 'email', 'phone', 'vat_registered', 'vat_rate', 'track_inventory', 'fiscal_year_start_month'] as const;
  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (request.data?.[key] !== undefined) patch[key] = request.data[key];
  }
  if (patch.business_name !== undefined) {
    const name = String(patch.business_name).trim();
    if (!name || name.length > NAME_MAX) throw new HttpsError('invalid-argument', 'Please give the business a valid name.');
    patch.business_name = name;
  }
  if (patch.vat_rate !== undefined) {
    const rate = Number(patch.vat_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new HttpsError('invalid-argument', 'VAT rate must be between 0 and 100.');
    patch.vat_rate = rate;
  }
  if (patch.fiscal_year_start_month !== undefined) {
    const month = Number(patch.fiscal_year_start_month);
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new HttpsError('invalid-argument', 'Fiscal year start month must be 1–12.');
    patch.fiscal_year_start_month = month;
  }
  if (Object.keys(patch).length === 0) throw new HttpsError('invalid-argument', 'Nothing to update.');

  await db.collection('businesses').doc(businessId).update({ ...patch, updated_at: FieldValue.serverTimestamp() });
  return { success: true };
});
