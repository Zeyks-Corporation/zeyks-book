-- 003_create_business.test.sql
-- pgTAP. Run with:  supabase test db
--
-- Covers
--   7. create_business creates exactly one business and one OWNER membership
--   8. create_business creates only the default chart of accounts and no
--      financial transactions
-- plus caller validation (anon, no JWT subject, missing profile), input
-- validation, atomicity, and that the internal seeder is not client-callable.

begin;
create extension if not exists pgtap with schema extensions;

select plan(22);

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
-- Fixtures: alice, bob, and "ghost" (a user whose profile row is missing)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a1111111-1111-4111-8111-111111111111',
   'authenticated', 'authenticated', 'alice@zeyks.test', '{"full_name":"Alice"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b2222222-2222-4222-8222-222222222222',
   'authenticated', 'authenticated', 'bob@zeyks.test', '{"full_name":"Bob"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd4444444-4444-4444-8444-444444444444',
   'authenticated', 'authenticated', 'ghost@zeyks.test', '{"full_name":"Ghost"}'::jsonb, now(), now());
delete from public.profiles where id = 'd4444444-4444-4444-8444-444444444444';

-- ---------------------------------------------------------------------------
-- Caller validation
-- ---------------------------------------------------------------------------
-- 01 anon cannot execute the function at all
set local role anon;
select throws_ok(
  $$select public.create_business('Anon Co')$$,
  '42501', NULL,
  'anon cannot call create_business'
);
reset role;

-- 02 a JWT without a subject: no identity, no business
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  $$select public.create_business('No Subject Co')$$,
  '28000', NULL,
  'a caller without an auth.uid() is rejected'
);
reset role;

-- 03 a user with no profile row is rejected with a clear error
select pg_temp.act_as('d4444444-4444-4444-8444-444444444444');
set local role authenticated;
select throws_ok(
  $$select public.create_business('Ghost Co')$$,
  '23503', NULL,
  'a user without a profile row cannot create a business'
);
reset role;

-- ---------------------------------------------------------------------------
-- Input validation and atomicity (alice)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

-- 04 blank name
select throws_ok(
  $$select public.create_business('   ')$$,
  '22023', NULL,
  'a blank business name is rejected'
);
-- 05 bad PAN reaches the table CHECK; nothing may be left behind
select throws_ok(
  $$select public.create_business('Bad PAN Co', p_pan_number => '123')$$,
  '23514', NULL,
  'an invalid PAN number is rejected'
);
reset role;
select is(
  (select count(*) from public.businesses where business_name = 'Bad PAN Co')::int
  + (select count(*) from public.business_memberships m
       join public.businesses b on b.id = m.business_id where b.business_name = 'Bad PAN Co')::int,
  0,
  'a failed create_business leaves no partial rows (06)'
);

-- ---------------------------------------------------------------------------
-- TEST 7 and 8: the happy path
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select lives_ok($$select public.create_business('Alice Traders')$$, 'alice creates a business (07)');
reset role;

select set_config('test.biz_a', (select id::text from public.businesses where business_name = 'Alice Traders'), true);

-- TEST 7: exactly one business, exactly one membership, and it is OWNER
select is(
  (select count(*) from public.businesses where created_by = 'a1111111-1111-4111-8111-111111111111')::int,
  1,
  'exactly one business exists for alice'
);
select is(
  (select count(*) from public.business_memberships where business_id = current_setting('test.biz_a')::uuid)::int,
  1,
  'exactly one membership exists for the new business'
);
select is(
  (select role from public.business_memberships
    where business_id = current_setting('test.biz_a')::uuid
      and user_id = 'a1111111-1111-4111-8111-111111111111'),
  'OWNER',
  'the caller is the OWNER'
);
select is(
  (select created_by from public.businesses where id = current_setting('test.biz_a')::uuid),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'created_by comes from auth.uid(), not from a parameter'
);
select is(
  (select currency || '/' || timezone || '/' || fiscal_year_start_month || '/' || vat_registered
          || '/' || vat_rate || '/' || track_inventory
     from public.businesses where id = current_setting('test.biz_a')::uuid),
  'NPR/Asia/Kathmandu/4/false/13.00/false',
  'defaults: NPR, Asia/Kathmandu, fiscal year from month 4, VAT off at 13%, inventory off'
);

-- TEST 8: only the default chart of accounts, and no financial transactions
select is(
  (select count(*) from public.accounts where business_id = current_setting('test.biz_a')::uuid)::int,
  21,
  'the default chart has 21 accounts'
);
select is(
  (select count(*) from public.accounts
    where business_id = current_setting('test.biz_a')::uuid and system_account)::int,
  13,
  '13 of them are system accounts'
);
select is(
  (select array_agg(code order by code) from public.accounts where business_id = current_setting('test.biz_a')::uuid),
  array['1010','1020','1030','1040','1050','1060','1070','2010','2020','3010','3020',
        '4010','4020','5010','5020','5030','5040','5050','5060','5070','5080'],
  'the chart contains exactly the approved account codes'
);
select is(
  (select array_agg(code order by code) from public.accounts
    where business_id = current_setting('test.biz_a')::uuid and system_account),
  array['1010','1020','1030','1040','1050','1060','1070','2010','2020','3010','3020','4010','5010'],
  'the system accounts are exactly the ones named in ACCOUNT_CODES'
);
select is(
  (select count(*) from public.accounts
    where business_id = current_setting('test.biz_a')::uuid and not is_active)::int,
  0,
  'every default account starts active'
);
select is(
  (select sum(n)::int from (
     select count(*) as n from public.customers            where business_id = current_setting('test.biz_a')::uuid
     union all select count(*) from public.suppliers       where business_id = current_setting('test.biz_a')::uuid
     union all select count(*) from public.sales           where business_id = current_setting('test.biz_a')::uuid
     union all select count(*) from public.sale_items      where business_id = current_setting('test.biz_a')::uuid
     union all select count(*) from public.purchases       where business_id = current_setting('test.biz_a')::uuid
     union all select count(*) from public.purchase_items  where business_id = current_setting('test.biz_a')::uuid
     union all select count(*) from public.expenses        where business_id = current_setting('test.biz_a')::uuid
     union all select count(*) from public.payments        where business_id = current_setting('test.biz_a')::uuid
     union all select count(*) from public.gateway_transactions where business_id = current_setting('test.biz_a')::uuid
     union all select count(*) from public.journal_entries where business_id = current_setting('test.biz_a')::uuid
     union all select count(*) from public.journal_lines   where business_id = current_setting('test.biz_a')::uuid
   ) t),
  0,
  'no customers, suppliers, documents, payments or journal entries are created'
);

-- ---------------------------------------------------------------------------
-- Return value, trimming, and a second user
-- ---------------------------------------------------------------------------
select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
set local role authenticated;
select is(
  (public.create_business('  Bob Co  ', p_city => ' Kathmandu ', p_vat_registered => true)).business_name,
  'Bob Co',
  'the created business is returned, with the name trimmed'
);
select is(
  (select city || '/' || vat_registered from public.businesses where business_name = 'Bob Co'),
  'Kathmandu/true',
  'optional parameters are honoured and trimmed'
);
select is(
  (select count(*) from public.accounts)::int,
  21,
  'bob sees only his own 21 default accounts, not alice''s'
);
reset role;

-- ---------------------------------------------------------------------------
-- The internal seeder is not callable by clients
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  $$select public.seed_default_chart_of_accounts(current_setting('test.biz_a')::uuid)$$,
  '42501', NULL,
  'authenticated clients cannot call the internal chart seeder'
);
reset role;

select * from finish();
rollback;

