-- 001_rls_tenancy.test.sql
-- pgTAP. Run with:  supabase test db
--
-- Covers
--   1. an authenticated member can read their own business
--   2. a non-member cannot read a business
--   3. a member cannot access another business's customer (and related tenant tables)
-- plus the role rules the policies encode (OWNER / VIEWER / anon) and the
-- column-level write grants.
--
-- Everything runs inside one transaction that is rolled back. Fixtures are test
-- users and businesses created through the real signup trigger and create_business().
-- No financial documents are inserted except two customers used to probe isolation.

begin;
create extension if not exists pgtap with schema extensions;

select plan(31);

-- Sets the JWT claims that auth.uid() reads. The role switch is done by the caller.
create function pg_temp.act_as(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_uid::text, 'role', 'authenticated')::text,
    true
  );
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures: alice (OWNER of A), bob (OWNER of B), carol (VIEWER of A)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a1111111-1111-4111-8111-111111111111',
   'authenticated', 'authenticated', 'alice@zeyks.test', '{"full_name":"Alice"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b2222222-2222-4222-8222-222222222222',
   'authenticated', 'authenticated', 'bob@zeyks.test', '{"full_name":"Bob"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c3333333-3333-4333-8333-333333333333',
   'authenticated', 'authenticated', 'carol@zeyks.test', '{"full_name":"Carol"}'::jsonb, now(), now());

-- 01-02 signup trigger (004)
select is(
  (select count(*) from public.profiles
    where id in ('a1111111-1111-4111-8111-111111111111',
                 'b2222222-2222-4222-8222-222222222222',
                 'c3333333-3333-4333-8333-333333333333'))::int,
  3,
  'signing up creates a profile row for each auth user'
);
select is(
  (select full_name from public.profiles where id = 'a1111111-1111-4111-8111-111111111111'),
  'Alice',
  'profile full_name is taken from signup metadata'
);

-- 03-04 alice and bob each create a business through the RPC
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select lives_ok($$select public.create_business('Alice Traders')$$, 'alice creates business A');

reset role;
select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
set local role authenticated;
select lives_ok($$select public.create_business('Bob Traders')$$, 'bob creates business B');

reset role;
select set_config('test.biz_a', (select id::text from public.businesses where business_name = 'Alice Traders'), true);
select set_config('test.biz_b', (select id::text from public.businesses where business_name = 'Bob Traders'), true);

-- Fixture rows written as the table owner (bypasses RLS): one customer per business,
-- and carol joins business A as a VIEWER.
insert into public.customers (business_id, name) values
  (current_setting('test.biz_a')::uuid, 'Customer of A'),
  (current_setting('test.biz_b')::uuid, 'Customer of B');
insert into public.business_memberships (business_id, user_id, role)
values (current_setting('test.biz_a')::uuid, 'c3333333-3333-4333-8333-333333333333', 'VIEWER');

-- ---------------------------------------------------------------------------
-- alice (OWNER of A)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

-- 05 TEST 1: member reads own business
select is(
  (select count(*) from public.businesses where id = current_setting('test.biz_a')::uuid)::int,
  1,
  'member can read their own business'
);
-- 06 a member of A cannot read business B (TEST 2 is also asserted from bob's side below)
select is(
  (select count(*) from public.businesses where id = current_setting('test.biz_b')::uuid)::int,
  0,
  'member cannot read a business they do not belong to'
);
-- 07-09 TEST 3: tenant isolation on customers and accounts
select is(
  (select count(*) from public.customers)::int,
  1,
  'member sees only their own business customers'
);
select is(
  (select count(*) from public.customers where business_id = current_setting('test.biz_b')::uuid)::int,
  0,
  'member cannot read another business customer'
);
select is(
  (select count(*) from public.accounts where business_id = current_setting('test.biz_b')::uuid)::int,
  0,
  'member cannot read another business chart of accounts'
);
-- 10 write attempts across the tenant boundary
select throws_ok(
  $$insert into public.customers (business_id, name) values (current_setting('test.biz_b')::uuid, 'Intruder')$$,
  '42501', NULL,
  'clients cannot insert customers directly (RPC only), least of all into another business'
);
select throws_ok(
  $$insert into public.accounts (business_id, code, name, type)
    values (current_setting('test.biz_b')::uuid, '6000', 'Intruder', 'EXPENSE')$$,
  '42501', NULL,
  'member cannot create an account in another business'
);
-- 12 owner writes inside their own business
select lives_ok(
  $$insert into public.accounts (business_id, code, name, type)
    values (current_setting('test.biz_a')::uuid, '6000', 'Custom expense', 'EXPENSE')$$,
  'owner can create an ordinary account in their own business'
);
select throws_ok(
  $$insert into public.accounts (business_id, code, name, type, system_account)
    values (current_setting('test.biz_a')::uuid, '6001', 'Fake system', 'EXPENSE', true)$$,
  '42501', NULL,
  'clients cannot create system accounts'
);
select lives_ok(
  $$update public.businesses set city = 'Pokhara' where id = current_setting('test.biz_a')::uuid$$,
  'owner can update business settings'
);
select throws_ok(
  $$update public.businesses set created_by = 'b2222222-2222-4222-8222-222222222222'
    where id = current_setting('test.biz_a')::uuid$$,
  '42501', NULL,
  'created_by is not client-writable'
);
-- cross-tenant update: allowed by grants, filtered to zero rows by RLS (verified below)
select lives_ok(
  $$update public.businesses set business_name = 'HACKED' where id = current_setting('test.biz_b')::uuid$$,
  'cross-tenant update statement runs but matches no rows'
);

-- ---------------------------------------------------------------------------
-- bob (OWNER of B, not a member of A)
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
set local role authenticated;

select is(
  (select count(*) from public.businesses)::int,
  1,
  'non-member sees exactly one business: their own'
);
select is(
  (select count(*) from public.businesses where id = current_setting('test.biz_a')::uuid)::int,
  0,
  'non-member cannot read business A'
);
select is(
  (select count(*) from public.customers where business_id = current_setting('test.biz_a')::uuid)::int,
  0,
  'non-member cannot read business A customers'
);
select is(
  (select count(*) from public.business_memberships)::int,
  1,
  'a user sees only their own membership rows'
);
select is(
  (select count(*) from public.profiles)::int,
  1,
  'a user sees only their own profile'
);
select throws_ok(
  $$insert into public.accounts (business_id, code, name, type)
    values (current_setting('test.biz_a')::uuid, '6002', 'Intruder', 'EXPENSE')$$,
  '42501', NULL,
  'non-member cannot create an account in business A'
);

-- ---------------------------------------------------------------------------
-- carol (VIEWER of A)
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.act_as('c3333333-3333-4333-8333-333333333333');
set local role authenticated;

select is(
  (select count(*) from public.businesses where id = current_setting('test.biz_a')::uuid)::int,
  1,
  'viewer can read the business'
);
select is(
  (select count(*) from public.customers where business_id = current_setting('test.biz_a')::uuid)::int,
  1,
  'viewer can read business customers'
);
select throws_ok(
  $$insert into public.accounts (business_id, code, name, type)
    values (current_setting('test.biz_a')::uuid, '6003', 'Viewer account', 'EXPENSE')$$,
  '42501', NULL,
  'viewer cannot create accounts (needs OWNER or ACCOUNTANT)'
);
select lives_ok(
  $$update public.businesses set business_name = 'VIEWER EDIT' where id = current_setting('test.biz_a')::uuid$$,
  'viewer update statement runs but matches no rows'
);

-- ---------------------------------------------------------------------------
-- anon: no privileges at all
-- ---------------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok(
  $$select count(*) from public.businesses$$,
  '42501', NULL,
  'anon has no access to businesses'
);

-- ---------------------------------------------------------------------------
-- Verify the RLS-filtered updates changed nothing (as the table owner)
-- ---------------------------------------------------------------------------
reset role;
select is(
  (select business_name from public.businesses where id = current_setting('test.biz_b')::uuid),
  'Bob Traders',
  'alice could not rename business B'
);
select is(
  (select business_name from public.businesses where id = current_setting('test.biz_a')::uuid),
  'Alice Traders',
  'viewer carol could not rename business A'
);
select is(
  (select city from public.businesses where id = current_setting('test.biz_a')::uuid),
  'Pokhara',
  'owner alice did update the city of business A'
);
select is(
  (select count(*) from public.accounts
    where business_id = current_setting('test.biz_a')::uuid and code = '6000' and system_account = false)::int,
  1,
  'owner-created account exists and is an ordinary (non-system) account'
);

select * from finish();
rollback;
