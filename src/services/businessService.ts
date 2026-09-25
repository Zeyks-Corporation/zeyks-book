/**
 * Business lifecycle service — onboarding, memberships, and settings.
 *
 * Uses Supabase database for storage.
 * User identity comes from Firebase Auth, synchronized to Supabase Auth.
 */

import { supabase, syncSupabaseSession } from '../lib/supabase';
import { auth } from '../lib/firebase';
import type { BusinessProfile } from '../types';
import type { DbBusiness, BusinessSettingsPatch } from '../lib/dbTypes';
import { toBusinessProfile, toBusinessUpdate } from '../lib/dbTypes';

export interface Membership {
  businessId: string;
  userId: string;
  role: 'OWNER' | 'ACCOUNTANT' | 'VIEWER';
  createdAt: string;
}

/**
 * Fetch the current user's business memberships.
 * Ensures the database session is synchronized before querying.
 */
export async function getMyMemberships(): Promise<{
  memberships: Membership[];
  error: string | null;
}> {
  try {
    if (auth.currentUser) {
      await syncSupabaseSession(auth.currentUser);
    }

    const { data, error } = await supabase
      .from('business_memberships')
      .select('business_id, user_id, role, created_at');

    if (error) {
      return { memberships: [], error: error.message };
    }

    const memberships: Membership[] = (data ?? []).map((row) => ({
      businessId: row.business_id as string,
      userId: row.user_id as string,
      role: (row.role as Membership['role']) || 'OWNER',
      createdAt: (row.created_at as string) || '',
    }));

    return { memberships, error: null };
  } catch (e) {
    return {
      memberships: [],
      error: e instanceof Error ? e.message : 'Could not load your businesses.',
    };
  }
}

/**
 * Load a single business by ID.
 */
export async function getBusiness(
  businessId: string,
): Promise<{ business: BusinessProfile | null; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', businessId)
      .single();

    if (error) {
      return {
        business: null,
        error: error.message || 'This business could not be found, or you are not a member of it.',
      };
    }

    return { business: toBusinessProfile(data as DbBusiness), error: null };
  } catch (e) {
    return {
      business: null,
      error: e instanceof Error ? e.message : 'Could not load the business.',
    };
  }
}

/**
 * Persist business settings.
 */
export async function updateBusiness(
  businessId: string,
  patch: BusinessSettingsPatch,
): Promise<{ business: BusinessProfile | null; error: string | null }> {
  try {
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
  } catch (e) {
    return {
      business: null,
      error: e instanceof Error ? e.message : 'The business settings were not saved.',
    };
  }
}

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
 * Create a new business via the atomic `create_business` RPC.
 */
export async function createBusiness(
  params: CreateBusinessParams,
): Promise<{ business: BusinessProfile | null; error: string | null }> {
  try {
    if (auth.currentUser) {
      await syncSupabaseSession(auth.currentUser);
    }

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

    if (error) {
      return { business: null, error: error.message };
    }

    const row = data as DbBusiness;
    if (!row?.id) {
      return { business: null, error: 'No business was returned by create_business.' };
    }

    return { business: toBusinessProfile(row), error: null };
  } catch (e) {
    return {
      business: null,
      error: e instanceof Error ? e.message : 'Could not create the business.',
    };
  }
}
