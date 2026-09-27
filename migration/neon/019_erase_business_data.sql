-- 019_erase_business_data.sql
-- "Erase everything" — wipe a business back to its freshly-created state.
--
-- Scope
--   * Deletes every sales row, sale item, purchase row, purchase item, expense,
--     payment, gateway transaction, journal line, journal entry, customer,
--     supplier, and account the business owns.
--   * Re-seeds the 21 default accounts (the same chart create_business wrote
--     on day one) so the post_sale / post_purchase / void_* rules find their
--     system references on the next click.
--   * Leaves the business row, the OWNER membership and the caller's profile
--     untouched. The signed-in person does not need to onboard again.
--   * Only an OWNER of the business may erase it. ACCOUNTANT and VIEWER cannot.
--
-- Order
--   * Child rows first (sale_items, purchase_items, journal_lines), then the
--     parents (sales, purchases, journal_entries), then the parties
--     (customers, suppliers), then accounts. A foreign key without ON DELETE
--     CASCADE would otherwise refuse an early parent delete.

-- ============================================================================
-- erase_business_data
-- ============================================================================

create function public.erase_business_data(p_business_id uuid)
returns table (table_name text, deleted bigint)
language plpgsql security definer set search_path = ''
as $$
declare
  v_count bigint;
begin
  -- Only the OWNER of this business may erase its data.
  if not exists (
    select 1 from public.business_memberships m
     where m.business_id = p_business_id
       and m.user_id = (select auth.uid())
       and m.role = 'OWNER'
  ) then
    raise exception 'Only the owner of this business can erase its data.';
  end if;

  -- Child rows first
  delete from public.sale_items where business_id = p_business_id;
  get diagnostics v_count = row_count;
  table_name := 'sale_items'; deleted := v_count; return next;

  delete from public.purchase_items where business_id = p_business_id;
  get diagnostics v_count = row_count;
  table_name := 'purchase_items'; deleted := v_count; return next;

  delete from public.journal_lines where business_id = p_business_id;
  get diagnostics v_count = row_count;
  table_name := 'journal_lines'; deleted := v_count; return next;

  -- Documents and payments
  delete from public.gateway_transactions where business_id = p_business_id;
  get diagnostics v_count = row_count;
  table_name := 'gateway_transactions'; deleted := v_count; return next;

  delete from public.payments where business_id = p_business_id;
  get diagnostics v_count = row_count;
  table_name := 'payments'; deleted := v_count; return next;

  delete from public.expenses where business_id = p_business_id;
  get diagnostics v_count = row_count;
  table_name := 'expenses'; deleted := v_count; return next;

  delete from public.purchases where business_id = p_business_id;
  get diagnostics v_count = row_count;
  table_name := 'purchases'; deleted := v_count; return next;

  delete from public.sales where business_id = p_business_id;
  get diagnostics v_count = row_count;
  table_name := 'sales'; deleted := v_count; return next;

  delete from public.journal_entries where business_id = p_business_id;
  get diagnostics v_count = row_count;
  table_name := 'journal_entries'; deleted := v_count; return next;

  -- Parties (no FK from documents anymore, so safe)
  delete from public.customers where business_id = p_business_id;
  get diagnostics v_count = row_count;
  table_name := 'customers'; deleted := v_count; return next;

  delete from public.suppliers where business_id = p_business_id;
  get diagnostics v_count = row_count;
  table_name := 'suppliers'; deleted := v_count; return next;

  -- Accounts (system accounts cannot be archived but can be deleted by a
  -- SECURITY DEFINER function whose owner bypasses RLS — there is no DELETE
  -- trigger on accounts, only the guard_account_update BEFORE UPDATE trigger).
  delete from public.accounts where business_id = p_business_id;
  get diagnostics v_count = row_count;
  table_name := 'accounts'; deleted := v_count; return next;

  -- Reseed the chart so the business can keep recording sales and purchases.
  perform public.seed_default_chart_of_accounts(p_business_id);

  return;
end $$;

revoke all on function public.erase_business_data(uuid) from public, anon, authenticated;
grant execute on function public.erase_business_data(uuid) to authenticated;

-- ============================================================================
-- Safety nets: nothing about the data model changes here, but verify the
-- function stays callable and stays locked to authenticated only.
-- ============================================================================

do $$
declare v_bad text;
begin
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('erase_business_data')
     and not exists (
       select 1 from information_schema.routine_privileges rp
        where rp.routine_schema = 'public'
          and rp.routine_name = p.proname
          and rp.grantee = 'authenticated'
          and rp.privilege_type = 'EXECUTE'
     );
  if v_bad is not null then
    raise exception 'erase_business_data must remain EXECUTE-granted to authenticated, missing on: %', v_bad;
  end if;
end $$;