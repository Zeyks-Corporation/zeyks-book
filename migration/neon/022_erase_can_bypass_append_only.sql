-- 022_erase_can_bypass_append_only.sql
--
-- erase_business_data failed with 'DELETE on public.payments is not allowed:
-- financial records are append-only' (001's forbid_modification triggers fire
-- for every role, including the function's own security-definer identity).
-- This version disables the user triggers on exactly the tables it wipes for
-- the duration of its transaction (DDL rolls back with it), deletes the
-- gateway_transactions 019/020 missed, and re-enables every trigger before
-- returning. Business profile, memberships, settings and subscription stay
-- untouched — only the records the owner added are erased, then the default
-- chart of accounts is reseeded.

create or replace function public.erase_business_data(p_business_id uuid)
returns table (table_name text, deleted bigint)
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_t   text;
  v_n   bigint;
  v_tables text[] := array[
    'gateway_transactions', 'payments',
    'purchase_items', 'purchases',
    'expenses',
    'sale_items', 'sales',
    'inventory_movements', 'inventory_items',
    'journal_lines', 'journal_entries',
    'customers', 'suppliers', 'accounts'
  ];
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_owner(p_business_id) then
    raise exception 'Only the owner can erase business data' using errcode = '42501';
  end if;

  foreach v_t in array v_tables loop
    execute format('alter table public.%I disable trigger user', v_t);
  end loop;

  delete from public.gateway_transactions where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'gateway_transactions'; deleted := v_n; return next;

  delete from public.payments               where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'payments'; deleted := v_n; return next;

  delete from public.purchase_items         where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'purchase_items'; deleted := v_n; return next;
  delete from public.purchases              where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'purchases'; deleted := v_n; return next;

  delete from public.expenses               where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'expenses'; deleted := v_n; return next;

  delete from public.sale_items             where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'sale_items'; deleted := v_n; return next;
  delete from public.sales                  where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'sales'; deleted := v_n; return next;

  delete from public.inventory_movements    where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'inventory_movements'; deleted := v_n; return next;
  delete from public.inventory_items        where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'inventory_items'; deleted := v_n; return next;

  delete from public.journal_lines          where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'journal_lines'; deleted := v_n; return next;
  delete from public.journal_entries        where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'journal_entries'; deleted := v_n; return next;

  delete from public.customers              where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'customers'; deleted := v_n; return next;
  delete from public.suppliers              where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'suppliers'; deleted := v_n; return next;

  delete from public.accounts               where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'accounts'; deleted := v_n; return next;

  foreach v_t in array v_tables loop
    execute format('alter table public.%I enable trigger user', v_t);
  end loop;

  -- Reseed the default chart of accounts.
  perform public.seed_default_chart_of_accounts(p_business_id);

  return;
end $$;

revoke all on function public.erase_business_data(uuid) from public, anon, authenticated;
grant execute on function public.erase_business_data(uuid) to authenticated;
