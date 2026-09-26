import { supabase } from '../lib/supabase';
import { toAccount } from '../lib/dbTypes';
import type { Account } from '../types';

/** Add an account through the column-scoped, membership-checked table policy. */
export async function createAccount(
  businessId: string,
  draft: Pick<Account, 'code' | 'name' | 'type' | 'description'>,
): Promise<Account> {
  const { data, error } = await supabase
    .from('accounts')
    .insert({
      business_id: businessId,
      code: draft.code,
      name: draft.name.trim(),
      type: draft.type,
      description: draft.description?.trim() || null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return toAccount(data as Record<string, unknown>);
}

/** Archive an account; RLS and the database trigger validate access and balance. */
export async function archiveAccount(businessId: string, accountId: string): Promise<Account> {
  const { data, error } = await supabase
    .from('accounts')
    .update({ is_active: false })
    .eq('business_id', businessId)
    .eq('id', accountId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return toAccount(data as Record<string, unknown>);
}

/** Edit the fields permitted by the accounts table's column-scoped grant. */
export async function updateAccount(
  businessId: string,
  accountId: string,
  changes: Pick<Account, 'name' | 'description'>,
): Promise<Account> {
  const { data, error } = await supabase
    .from('accounts')
    .update({ name: changes.name.trim(), description: changes.description?.trim() || null })
    .eq('business_id', businessId)
    .eq('id', accountId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return toAccount(data as Record<string, unknown>);
}
