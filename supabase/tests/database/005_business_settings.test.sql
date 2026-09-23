-- 005_business_settings.test.sql
-- pgTAP. Run with:  supabase test db
--
-- Covers Phase A / A4: business settings persist through the existing
-- column-level UPDATE grants and the OWNER RLS policy.
--   * an OWNER may update only the granted settings columns
--   * ACCOUNTANT / VIEWER / non-members may not
--   * identity/system columns are not client-writable
--   * anon has no write path at all
--   * column CHECK constraints still reject bad values
-- No migration is added by this phase; these tests exercise 001/002 as deployed.

begin;
create extension if not exists pgtap with schema extensions;

select plan(16);

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
-- Fixtures: Alice (owner A), Bob (owner B), Carol (viewer A), Dan (accountant A)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a1111111-1111-4111-8111-111111111111',
   'authenticated', 'authenticated', 'alice@zeyks.test', '{"full_name":"Alice"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b2222222-2222-4222-8222-222222222222',
   'authenticated', 'authenticated', 'bob@zeyks.test', '{"full_name":"Bob"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c3333333-3333-4333-8333-333333333333',
   'authenticated', 'authenticated', 'carol@zeyks.test', '{"full_name":"Carol"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd4444444-4444-4444-8444-444444444444',
   'authenticated', 'authenticated', 'dan@zeyks.test', '{"full_name":"Dan"}'::jsonb, now(), now());

select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.create_business('Business A');
reset role;

select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
set local role authenticated;
select public.create_business('Business B');
reset role;

do $$
declare
  v_biz_a uuid;
begin
  select id into v_biz_a from public.businesses where business_name = 'Business A';
  insert into public.business_memberships (business_id, user_id, role)
  values (v_biz_a, 'c3333333-3333-4333-8333-333333333333', 'VIEWER'),
         (v_biz_a, 'd4444444-4444-4444-8444-444444444444', 'ACCOUNTANT');
end $$;

-- Look businesses up by their immutable creator, not the renameable name.
create function pg_temp.biz_a() returns uuid language sql security definer as $$
  select id from public.businesses
   where created_by = 'a1111111-1111-4111-8111-111111111111' limit 1;
$$;
create function pg_temp.biz_b() returns uuid language sql security definer as $$
  select id from public.businesses
   where created_by = 'b2222222-2222-4222-8222-222222222222' limit 1;
$$;
grant execute on function pg_temp.biz_a() to authenticated, anon;
grant execute on function pg_temp.biz_b() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 01-03  OWNER can persist the granted settings columns
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
update public.businesses
   set business_name = 'Himal Traders'
 where id = pg_temp.biz_a();
reset role;
select is(
  (select business_name from public.businesses where id = pg_temp.biz_a()),
  'Himal Traders',
  'owner can change business_name'
);

select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
update public.businesses
   set owner_name = 'Ram Bahadur',
       email = 'ram@example.com',
       phone = '9800000000',
       pan_number = '123456789',
       address = 'Thamel',
       city = 'Kathmandu',
       vat_registered = true,
       vat_rate = 13,
       fiscal_year_start_month = 7,
       track_inventory = true
 where id = pg_temp.biz_a();
reset role;
select ok(
  (select owner_name = 'Ram Bahadur'
       and email = 'ram@example.com'
       and phone = '9800000000'
       and pan_number = '123456789'
       and address = 'Thamel'
       and city = 'Kathmandu'
       and vat_registered
       and vat_rate = 13
       and fiscal_year_start_month = 7
       and track_inventory
     from public.businesses where id = pg_temp.biz_a()),
  'owner can persist every granted settings column'
);

select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
update public.businesses set currency_symbol = 'रू' where id = pg_temp.biz_a();
reset role;
select is(
  (select currency_symbol from public.businesses where id = pg_temp.biz_a()),
  'रू',
  'owner can change currency_symbol'
);

-- ---------------------------------------------------------------------------
-- 04-06  Non-owners cannot change settings (RLS makes the update a no-op)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('d4444444-4444-4444-8444-444444444444'); -- ACCOUNTANT
set local role authenticated;
update public.businesses set business_name = 'Renamed by Dan' where id = pg_temp.biz_a();
reset role;
select is(
  (select business_name from public.businesses where id = pg_temp.biz_a()),
  'Himal Traders',
  'an ACCOUNTANT cannot change business settings'
);

select pg_temp.act_as('c3333333-3333-4333-8333-333333333333'); -- VIEWER
set local role authenticated;
update public.businesses set business_name = 'Renamed by Carol' where id = pg_temp.biz_a();
reset role;
select is(
  (select business_name from public.businesses where id = pg_temp.biz_a()),
  'Himal Traders',
  'a VIEWER cannot change business settings'
);

select pg_temp.act_as('b2222222-2222-4222-8222-222222222222'); -- owner of B only
set local role authenticated;
update public.businesses set business_name = 'Renamed by Bob' where id = pg_temp.biz_a();
reset role;
select is(
  (select business_name from public.businesses where id = pg_temp.biz_a()),
  'Himal Traders',
  'a non-member cannot change another business'
);

-- ---------------------------------------------------------------------------
-- 07  ...but an owner can still change their own business
-- ---------------------------------------------------------------------------
select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
set local role authenticated;
update public.businesses set business_name = 'Business B2' where id = pg_temp.biz_b();
reset role;
select is(
  (select business_name from public.businesses where id = pg_temp.biz_b()),
  'Business B2',
  'an owner can still change their own business'
);

-- ---------------------------------------------------------------------------
-- 08-10  CHECK constraints still reject bad values
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  $$update public.businesses set pan_number = '123' where id = pg_temp.biz_a()$$,
  '23514', NULL,
  'a malformed PAN is rejected'
);
select throws_ok(
  $$update public.businesses set fiscal_year_start_month = 13 where id = pg_temp.biz_a()$$,
  '23514', NULL,
  'an out-of-range fiscal year month is rejected'
);
select throws_ok(
  $$update public.businesses set currency_symbol = 'USD' where id = pg_temp.biz_a()$$,
  '23514', NULL,
  'an unsupported currency symbol is rejected'
);
reset role;

-- ---------------------------------------------------------------------------
-- 11-13  Identity/system columns are not client-writable (column privileges)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  $$update public.businesses set currency = 'NPR' where id = pg_temp.biz_a()$$,
  '42501', NULL,
  'currency is not a client-writable column'
);
select throws_ok(
  $$update public.businesses set created_by = 'b2222222-2222-4222-8222-222222222222' where id = pg_temp.biz_a()$$,
  '42501', NULL,
  'created_by is not a client-writable column'
);
select throws_ok(
  $$update public.businesses set timezone = 'Asia/Kathmandu' where id = pg_temp.biz_a()$$,
  '42501', NULL,
  'timezone is not a client-writable column'
);
reset role;

-- ---------------------------------------------------------------------------
-- 14  anon has no write path
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok(
  $$update public.businesses set business_name = 'Anon Co' where id = pg_temp.biz_a()$$,
  '42501', NULL,
  'anon cannot update businesses'
);
reset role;

-- ---------------------------------------------------------------------------
-- 15-16  Reads are unaffected: members read, non-members do not
-- ---------------------------------------------------------------------------
select pg_temp.act_as('d4444444-4444-4444-8444-444444444444'); -- ACCOUNTANT of A
set local role authenticated;
select is(
  (select count(*)::int from public.businesses where id = pg_temp.biz_a()),
  1,
  'an ACCOUNTANT can still read business A'
);
select is(
  (select count(*)::int from public.businesses where id = pg_temp.biz_b()),
  0,
  'a non-member cannot read business B'
);
reset role;

select * from finish();
rollback;
