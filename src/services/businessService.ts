/**
 * Business service — onboarding and membership reads.
 *
 * create_business() is the only client path for creating a business.
 * The RPC is SECURITY DEFINER, derives the caller from auth.uid(), and
 * creates the business, OWNER membership and 21 default accounts in a
 * single transaction.
 */

import { supabase } from '../lib/supabase';
import type { BusinessProfile } from '../types';
import { toBusinessProfile, toBusinessUpdate } from '../lib/dbTypes';
import type { BusinessSettingsPatch, DbBusiness } from '../lib/dbTypes';

/* -------------------------------------------------------------------------- */
/* Memberships                                                                 */
/* -------------------------------------------------------------------------- */

export interface Membership {
  businessId: string;
  userId: string;
  role: 'OWNER' | 'ACCOUNTANT' | 'VIEWER';
  createdAt: string;
}

/**
 * Fetch the current user's business memberships.
 * RLS on business_memberships ensures only the caller's rows are returned.
 */
export async function getMyMemberships(): Promise<{
  memberships: Membership[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from('business_memberships')
    .select('business_id, user_id, role, created_at');

  if (error) return { memberships: [], error: error.message };

  const memberships: Membership[] = (data ?? []).map((row) => ({
    businessId: row.business_id as string,
    userId: row.user_id as string,
    role: row.role as Membership['role'],
    createdAt: row.created_at as string,
  }));

  return { memberships, error: null };
}

/* -------------------------------------------------------------------------- */
/* Business CRUD                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Load a single business by ID. RLS enforces that only members can read it.
 */
export async function getBusiness(
  businessId: string,
): Promise<{ business: BusinessProfile | null; error: string | null }> {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('id', businessId)
    .single();

  if (error) return { business: null, error: error.message };
  return { business: toBusinessProfile(data as DbBusiness), error: null };
}

/**
 * Persist business settings.
 *
 * Security is the database's job: 002 grants UPDATE on exactly the writable
 * columns, and the `businesses_update_owner` RLS policy restricts the write to
 * an OWNER. When RLS hides the row the update matches nothing, so we surface a
 * clear message instead of a success.
 *
 * The updated row is returned and should be treated as the canonical state.
 */
export async function updateBusiness(
  businessId: string,
  patch: BusinessSettingsPatch,
): Promise<{ business: BusinessProfile | null; error: string | null }> {
  const { data, error } = await supabase
    .from('businesses')
    .update(toBusinessUpdate(patch))
    .eq('id', businessId)
    .select('*')
    .single();

  if (error) {
    const message = error.code === 'PGRST116'
      ? 'Only the owner of this business can change its settings.'
      : error.message;
    return { business: null, error: message };
  }
  if (!data) return { business: null, error: 'The business settings were not saved.' };
  return { business: toBusinessProfile(data as DbBusiness), error: null };
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
 * Create a new business via the `create_business` RPC.
 *
 * The RPC is atomic: it creates the business row, an OWNER membership
 * for auth.uid(), and 21 default accounts. It returns the created
 * business row.
 */
export async function createBusiness(
  params: CreateBusinessParams,
): Promise<{ business: BusinessProfile | null; error: string | null }> {
  const { data, error } = await supabase.rpc('create_business', {
    p_business_name: params.businessName,
    p_owner_name: params.ownerName ?? '',
    p_email: params.email ?? '',
    p_phone: params.phone ?? '',
    p_pan_number: params.panNumber ?? '',
    p_address: params.address ?? '',
    p_city: params.city ?? '',
    p_currency_symbol: params.currencySymbol ?? 'NPR',
    p_fiscal_year_start_month: params.fiscalYearStartMonth ?? 4,
    p_vat_registered: params.vatRegistered ?? false,
    p_vat_rate: params.vatRate ?? 13,
    p_track_inventory: params.trackInventory ?? false,
  });

  if (error) return { business: null, error: error.message };

  // The RPC returns a single business row (not an array).
  const row = data as DbBusiness;
  if (!row?.id) return { business: null, error: 'No business was returned by create_business.' };

  return { business: toBusinessProfile(row), error: null };
}
