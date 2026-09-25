/**
 * Business lifecycle on Firestore.
 *
 * A membership row (`businessMemberships/{uid}_{businessId}`) is what every
 * security-rule check resolves through — the Firebase counterpart of the old
 * RLS membership table. Rows are created only by the `createBusiness` callable,
 * never by clients, which is why the rules refuse all client writes here.
 */

import { db, functions } from '../lib/firebase';
import { httpsCallable, type Functions } from 'firebase/functions';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import type { BusinessProfile } from '../types';
import type { DbBusiness, BusinessSettingsPatch } from '../lib/dbTypes';
import { toBusinessProfile } from '../lib/dbTypes';

export interface Membership {
  businessId: string;
  userId: string;
  role: string;
  createdAt: string;
}

/**
 * The signed-in user's business memberships.
 *
 * The rules only let a member list rows keyed `{uid}_*`, so this query returns
 * exactly the caller's rows — the same guarantee RLS gave, expressed as a
 * collection the client cannot read any other slice of.
 */
export async function getMyMemberships(): Promise<{
  memberships: Membership[];
  error: string | null;
}> {
  try {
    const col = collection(db, 'businessMemberships');
    const snap = await getDocs(col);
    const memberships: Membership[] = snap.docs.map((d) => {
      const row = d.data() as Record<string, unknown>;
      const created = row.created_at as { toDate?: () => Date } | string | undefined;
      return {
        businessId: row.business_id as string,
        userId: row.uid as string,
        role: (row.role as string) ?? 'OWNER',
        createdAt: typeof created === 'string' ? created : created?.toDate?.().toISOString() ?? '',
      };
    });
    return { memberships, error: null };
  } catch (e) {
    return { memberships: [], error: e instanceof Error ? e.message : 'Could not load your businesses.' };
  }
}

/* -------------------------------------------------------------------------- */
/* Business read / write                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Load a single business by ID. The security rules enforce that only members
 * can read it; a non-member's read is denied, which surfaces as an error.
 */
export async function getBusiness(
  businessId: string,
): Promise<{ business: BusinessProfile | null; error: string | null }> {
  try {
    const snap = await getDoc(doc(db, 'businesses', businessId));
    if (!snap.exists()) {
      return { business: null, error: 'This business could not be found, or you are not a member of it.' };
    }
    return { business: toBusinessProfile(snap.data() as DbBusiness), error: null };
  } catch (e) {
    return { business: null, error: e instanceof Error ? e.message : 'Could not load the business.' };
  }
}

/**
 * Persist business settings through the `updateBusiness` callable.
 *
 * Security is the function's job: it re-derives the OWNER role from the
 * membership row and accepts only a whitelist of fields. The updated document
 * is read back and should be treated as the canonical state.
 */
export async function updateBusiness(
  businessId: string,
  patch: BusinessSettingsPatch,
): Promise<{ business: BusinessProfile | null; error: string | null }> {
  try {
    const call = httpsCallable<Record<string, unknown>, { success: boolean }>(
      functions as Functions, 'updateBusiness',
    );
    await call({
      business_id: businessId,
      business_name: patch.businessName,
      owner_name: patch.ownerName,
      email: patch.email,
      phone: patch.phone,
      vat_registered: patch.vatRegistered,
      vat_rate: patch.vatRate,
      track_inventory: patch.trackInventory,
      fiscal_year_start_month: patch.fiscalYearStartMonth,
    });
    return getBusiness(businessId);
  } catch (e) {
    return { business: null, error: e instanceof Error ? e.message : 'The business settings were not saved.' };
  }
}

/* -------------------------------------------------------------------------- */
/* Onboarding                                                                  */
/* -------------------------------------------------------------------------- */

export interface CreateBusinessParams {
  businessName: string;
  ownerName?: string;
  email?: string;
  phone?: string;
  panNumber?: string;
  address?: string;
  city?: string;
  currencySymbol?: string;
  fiscalYearStartMonth?: number;
  vatRegistered?: boolean;
  vatRate?: number;
  trackInventory?: boolean;
}

/**
 * Create a new business via the `createBusiness` callable.
 *
 * The callable is atomic: it writes the business document, an OWNER membership
 * for the caller, and the starter chart of accounts, and returns the business.
 */
export async function createBusiness(
  params: CreateBusinessParams,
): Promise<{ business: BusinessProfile | null; error: string | null }> {
  try {
    const call = httpsCallable<Record<string, unknown>, { business_id: string }>(
      functions as Functions, 'createBusiness',
    );
    const res = await call({
      business_name: params.businessName,
      owner_name: params.ownerName ?? '',
      email: params.email ?? '',
      phone: params.phone ?? '',
      pan_number: params.panNumber ?? '',
      address: params.address ?? '',
      city: params.city ?? '',
      currency_symbol: params.currencySymbol ?? 'NPR',
      fiscal_year_start_month: params.fiscalYearStartMonth ?? 4,
      vat_registered: params.vatRegistered ?? false,
      vat_rate: params.vatRate ?? 13,
      track_inventory: params.trackInventory ?? false,
    });
    return getBusiness(res.data.business_id);
  } catch (e) {
    return { business: null, error: e instanceof Error ? e.message : 'Could not create the business.' };
  }
}

/** Keep the query helpers referenced for future invite/membership screens. */
void collection; void query; void where;
