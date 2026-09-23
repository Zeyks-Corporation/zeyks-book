-- 002_security_helpers_and_rls.sql
-- Membership helpers, table grants and row level security policies.
--
--   auth.uid() -> business_memberships -> businesses -> business-owned rows
--
-- Model
--   * Reads:  every member of a business (OWNER, ACCOUNTANT, VIEWER) can read its rows.
--   * Writes: financial tables (documents, items, journal, gateway) have NO write
--     path for clients at all. They are written only by SECURITY DEFINER RPCs
--     (003 and later) and the server (service_role).
--   * Client-writable: profiles.full_name, businesses settings (OWNER only),
--     accounts insert/update (OWNER or ACCOUNTANT, never system accounts).
--   * No DELETE or TRUNCATE privilege and no DELETE policy exists anywhere.
--   * Roles come from business_memberships, never from JWT claims, so a role
--     change takes effect on the next request.

-- ============================================================================
-- Helper functions
-- ============================================================================
-- SECURITY DEFINER so they can read business_memberships without being subject
-- to that table's own RLS policy. That is what keeps the policies non-recursive:
-- every business-owned table asks a helper, and the helper never asks a policy.
-- Each one pins search_path, fully qualifies every relation, and wraps
-- auth.uid() in a sub-select so it is evaluated once per statement.

create function public.is_member(p_business_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
      from public.business_memberships m
     where m.business_id = p_business_id
       and m.user_id = (select auth.uid())
  );
$$;

create function public.can_write(p_business_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
      from public.business_memberships m
     where m.business_id = p_business_id
       and m.user_id = (select auth.uid())
       and m.role in ('OWNER', 'ACCOUNTANT')
  );
$$;

create function public.is_owner(p_business_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
      from public.business_memberships m
     where m.business_id = p_business_id
       and m.user_id = (select auth.uid())
       and m.role = 'OWNER'
  );
$$;

-- Supabase's default privileges make new functions executable by anon and
-- authenticated. Reset explicitly, then grant only what is intended.
revoke all on function
  public.is_member(uuid), public.can_write(uuid), public.is_owner(uuid)
  from public, anon, authenticated;
grant execute on function
  public.is_member(uuid), public.can_write(uuid), public.is_owner(uuid)
  to authenticated;

-- ============================================================================
-- Table privileges (authenticated only; anon receives nothing)
-- ============================================================================
-- 001 revoked everything from anon and authenticated. Grants here are the
-- complete list. RLS then narrows them to the caller's businesses.

grant select on
  public.profiles,
  public.businesses,
  public.business_memberships,
  public.customers,
  public.suppliers,
  public.accounts,
  public.journal_entries,
  public.journal_lines,
  public.sales,
  public.sale_items,
  public.purchases,
  public.purchase_items,
  public.expenses,
  public.payments,
  public.gateway_transactions
to authenticated;

-- Column-level write grants: identity, tenancy and system columns are absent
-- on purpose, so a client cannot even attempt to set them.
grant update (full_name) on public.profiles to authenticated;

grant update (
  business_name, owner_name, email, phone, pan_number, address, city,
  currency_symbol, fiscal_year_start_month, vat_registered, vat_rate, track_inventory
) on public.businesses to authenticated;

grant insert (business_id, code, name, type, description) on public.accounts to authenticated;
grant update (name, description, is_active) on public.accounts to authenticated;

-- ============================================================================
-- Row level security policies
-- ============================================================================
-- RLS was enabled in 001. A table with no policy for an operation denies it.

-- profiles ------------------------------------------------------------------
-- Insert: only through the auth.users trigger (004). Delete: never.
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- businesses ----------------------------------------------------------------
-- Insert: only through create_business(). Delete: never.
create policy businesses_select_member on public.businesses
  for select to authenticated
  using (public.is_member(id));

create policy businesses_update_owner on public.businesses
  for update to authenticated
  using (public.is_owner(id))
  with check (public.is_owner(id));

-- business_memberships ------------------------------------------------------
-- Own rows only, compared directly to auth.uid(): no sub-query on this table,
-- so no recursion. Writes: only through RPCs.
create policy business_memberships_select_own on public.business_memberships
  for select to authenticated
  using (user_id = (select auth.uid()));

-- parties (rows are created inside the posting RPCs) -------------------------
create policy customers_select_member on public.customers
  for select to authenticated
  using (public.is_member(business_id));

create policy suppliers_select_member on public.suppliers
  for select to authenticated
  using (public.is_member(business_id));

-- accounts ------------------------------------------------------------------
-- A trigger (001) additionally freezes id/business/code/type/system flag,
-- refuses to archive system accounts, and refuses to archive accounts that
-- still carry a balance.
create policy accounts_select_member on public.accounts
  for select to authenticated
  using (public.is_member(business_id));

create policy accounts_insert_writer on public.accounts
  for insert to authenticated
  with check (public.can_write(business_id) and system_account = false);

create policy accounts_update_writer on public.accounts
  for update to authenticated
  using (public.can_write(business_id))
  with check (public.can_write(business_id));

-- journal (read only for clients) ---------------------------------------------
create policy journal_entries_select_member on public.journal_entries
  for select to authenticated
  using (public.is_member(business_id));

create policy journal_lines_select_member on public.journal_lines
  for select to authenticated
  using (public.is_member(business_id));

-- documents and items (read only for clients) -----------------------------------
create policy sales_select_member on public.sales
  for select to authenticated
  using (public.is_member(business_id));

create policy sale_items_select_member on public.sale_items
  for select to authenticated
  using (public.is_member(business_id));

create policy purchases_select_member on public.purchases
  for select to authenticated
  using (public.is_member(business_id));

create policy purchase_items_select_member on public.purchase_items
  for select to authenticated
  using (public.is_member(business_id));

create policy expenses_select_member on public.expenses
  for select to authenticated
  using (public.is_member(business_id));

create policy payments_select_member on public.payments
  for select to authenticated
  using (public.is_member(business_id));

-- gateway transactions (server writes only) --------------------------------------
create policy gateway_transactions_select_member on public.gateway_transactions
  for select to authenticated
  using (public.is_member(business_id));

-- ============================================================================
-- Safety nets: fail the migration if the model above is not what got applied
-- ============================================================================

do $$
declare
  v_bad text;
begin
  -- 1. Every public table has RLS enabled AND at least one policy.
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and (not c.relrowsecurity
          or not exists (select 1 from pg_policies p
                          where p.schemaname = 'public' and p.tablename = c.relname));
  if v_bad is not null then
    raise exception 'Tables without RLS or without any policy: %', v_bad;
  end if;

  -- 2. No DELETE policy (and no catch-all ALL policy) on any table.
  select string_agg(p.tablename || '.' || p.policyname, ', ') into v_bad
    from pg_policies p
   where p.schemaname = 'public' and p.cmd in ('DELETE', 'ALL');
  if v_bad is not null then
    raise exception 'Forbidden DELETE/ALL policies exist: %', v_bad;
  end if;

  -- 3. anon holds no table privilege at all.
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'anon has table privileges on: %', v_bad;
  end if;

  -- 4. authenticated holds no table-level write privilege anywhere. Its only
  --    writes are the column-level grants above, narrowed further by RLS.
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'authenticated has table-level write privileges on: %', v_bad;
  end if;
end $$;
