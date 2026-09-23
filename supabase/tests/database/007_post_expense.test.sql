-- 007_post_expense.test.sql
-- pgTAP test suite for public.post_expense() RPC (migration 007).
-- Run with: supabase test db
--
-- Covers the Stage 4 requirements:
--   A-V  security, account validation, amounts, VAT policy, settlement mapping,
--        journal semantics, atomicity/rollback, idempotency (including the
--        generated-reference retry), server reference allocation, payload shape
--        and reload.
-- Comment labels name the cases; a case may make more than one assertion.

begin;
create extension if not exists pgtap with schema extensions;

select plan(61);

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
-- Fixtures: Alice (Owner A), Bob (Owner B), Carol (Viewer A), Dan (Accountant A)
-- Business A starts unregistered for VAT. Both businesses get the 21-account
-- default chart from create_business().
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
  v_biz_b uuid;
begin
  select id into v_biz_a from public.businesses where business_name = 'Business A';
  select id into v_biz_b from public.businesses where business_name = 'Business B';

  insert into public.business_memberships (business_id, user_id, role)
  values (v_biz_a, 'c3333333-3333-4333-8333-333333333333', 'VIEWER'),
         (v_biz_a, 'd4444444-4444-4444-8444-444444444444', 'ACCOUNTANT');
end $$;

-- Look businesses up by immutable creator, not the renameable name.
create function pg_temp.biz_a() returns uuid language sql security definer as $$
  select id from public.businesses
   where created_by = 'a1111111-1111-4111-8111-111111111111' limit 1;
$$;
create function pg_temp.biz_b() returns uuid language sql security definer as $$
  select id from public.businesses
   where created_by = 'b2222222-2222-4222-8222-222222222222' limit 1;
$$;
create function pg_temp.acct(p_business uuid, p_code text) returns uuid language sql security definer as $$
  select id from public.accounts where business_id = p_business and code = p_code limit 1;
$$;
grant execute on function pg_temp.biz_a() to authenticated, anon;
grant execute on function pg_temp.biz_b() to authenticated, anon;
grant execute on function pg_temp.acct(uuid, text) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------
-- 01 anon cannot execute at all
set local role anon;
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-ANON', '2026-01-01'::date, 100, 0, 100, 'CASH', 'Item', null, 'k-anon', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '42501', NULL,
  'anon cannot call post_expense'
);
reset role;

-- 02 a JWT without a subject
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-NOSUB', '2026-01-01'::date, 100, 0, 100, 'CASH', 'Item', null, 'k-nosub', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '28000', NULL,
  'a caller without auth.uid() is rejected'
);
reset role;

-- 03 non-member (Bob) is rejected
select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-NONMEMBER', '2026-01-01'::date, 100, 0, 100, 'CASH', 'Item', null, 'k-nonmember', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '42501', NULL,
  'a non-member cannot post an expense to Business A'
);
reset role;

-- 04 VIEWER (Carol) is rejected
select pg_temp.act_as('c3333333-3333-4333-8333-333333333333');
set local role authenticated;
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-VIEWER', '2026-01-01'::date, 100, 0, 100, 'CASH', 'Item', null, 'k-viewer', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '42501', NULL,
  'a VIEWER cannot post an expense'
);
reset role;

-- ---------------------------------------------------------------------------
-- Account validation
-- ---------------------------------------------------------------------------
-- 05 cross-tenant account is rejected
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-CROSSACCT', '2026-01-01'::date, 100, 0, 100, 'CASH', 'Item', null, 'k-crossacct', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_b(), '5020')),
  '22023', NULL,
  'an account belonging to another business is rejected'
);

-- 06 a non-EXPENSE account is rejected
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-ASSET', '2026-01-01'::date, 100, 0, 100, 'CASH', 'Item', null, 'k-asset', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '1010')),
  '22023', NULL,
  'a non-EXPENSE account cannot be used as a category'
);

-- 07 an archived expense account is rejected
reset role;
update public.accounts set is_active = false
 where business_id = pg_temp.biz_a() and code = '5080';
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-ARCHIVED', '2026-01-01'::date, 100, 0, 100, 'CASH', 'Item', null, 'k-archived', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5080')),
  '22023', NULL,
  'an archived expense account is rejected'
);

-- 08 Cost of goods sold is reserved for purchases
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-COGS', '2026-01-01'::date, 100, 0, 100, 'CASH', 'Item', null, 'k-cogs', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5010')),
  '22023', NULL,
  'account 5010 is rejected for expenses'
);

-- ---------------------------------------------------------------------------
-- Creation and journal semantics (Business A: no VAT)
-- ---------------------------------------------------------------------------
-- 09 owner can create an expense
select isnt(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), 'EXP-OWNER', '2026-01-01'::date,
    1000, 0, 1000, 'CASH', 'Stationery', null, 'k-owner', false
  )->'expense'->>'id')),
  NULL,
  'an OWNER can create an expense'
);

-- 10 journal: Dr category, Cr Cash
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.expenses where reference = 'EXP-OWNER')),
  '5020:1000:0, 1010:0:1000',
  'an expense debits the category account and credits Cash 1010'
);

-- 11 an expense never writes a settlement row
select is(
  (select count(*) from public.payments where business_id = pg_temp.biz_a())::int,
  0,
  'an expense creates zero payment rows (it is settled at posting time)'
);

-- 12 ACCOUNTANT (Dan) can create
select pg_temp.act_as('d4444444-4444-4444-8444-444444444444');
select isnt(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5030'), 'EXP-ACCOUNTANT', '2026-01-02'::date,
    500, 0, 500, 'BANK', 'Broadband', null, 'k-accountant', false
  )->'expense'->>'id')),
  NULL,
  'an ACCOUNTANT can create an expense'
);

-- 13 accountant's journal credits the settlement account
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.expenses where reference = 'EXP-ACCOUNTANT')),
  '5030:500:0, 1020:0:500',
  'a BANK expense credits Bank 1020'
);

-- ---------------------------------------------------------------------------
-- Settlement wallet mapping
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');

-- 14 eSewa settles to its wallet when it is present and active
select isnt(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5040'), 'EXP-ESEWA', '2026-01-03'::date,
    100, 0, 100, 'ESEWA', 'Rent paid online', null, 'k-esewa', false
  )->'expense'->>'id')),
  NULL,
  'an eSewa expense is accepted'
);
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.expenses where reference = 'EXP-ESEWA')),
  '5040:100:0, 1040:0:100',
  'an eSewa expense credits the eSewa wallet 1040'
);

-- 15 Khalti settles to its wallet
select is(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5050'), 'EXP-KHALTI', '2026-01-04'::date,
    200, 0, 200, 'KHALTI', 'Courier', null, 'k-khalti', false
  )->'expense'->>'id')) is not null,
  true,
  'a Khalti expense is accepted'
);
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.expenses where reference = 'EXP-KHALTI')),
  '5050:200:0, 1050:0:200',
  'a Khalti expense credits the Khalti wallet 1050'
);

-- 16 the wallet fallback in the RPC is defence in depth: the chart cannot be
--    customised, because system wallet accounts cannot be archived at all.
reset role;
select throws_ok(
  $$update public.accounts set is_active = false where code = '1050'$$,
  '23001', NULL,
  'a system wallet account cannot be archived, so the fallback branch is defensive only'
);
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

-- ---------------------------------------------------------------------------
-- Amount, date and description validation
-- ---------------------------------------------------------------------------
-- 17 zero amount
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-ZERO', '2026-01-01'::date, 0, 0, 0, 'CASH', 'Item', null, 'k-zero', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '22023', NULL,
  'a zero amount is rejected'
);

-- 18 negative tax
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-NEGTAX', '2026-01-01'::date, 100, -10, 90, 'CASH', 'Item', null, 'k-negtax', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '22023', NULL,
  'a negative tax amount is rejected'
);

-- 19 total must equal amount + tax
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-BADTOTAL', '2026-01-01'::date, 100, 0, 999, 'CASH', 'Item', null, 'k-badtotal', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '22023', NULL,
  'a total that does not equal amount plus tax is rejected'
);

-- 20 total must be positive
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-ZEROTOTAL', '2026-01-01'::date, 100, 0, 0, 'CASH', 'Item', null, 'k-zerototal', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '22023', NULL,
  'a non-positive total is rejected'
);

-- 21 invalid payment method
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-BADMETHOD', '2026-01-01'::date, 100, 0, 100, 'CHEQUE', 'Item', null, 'k-badmethod', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '22023', NULL,
  'an unknown payment method is rejected'
);

-- 22a the boundary date — today in the business timezone — is accepted, so the
--     rule is "not after today" as judged server-side, never by the browser
select isnt(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), 'EXP-TODAY',
    (now() at time zone 'Asia/Kathmandu')::date,
    100, 0, 100, 'CASH', 'Boundary probe', null, 'k-today', false
  )->'expense'->>'id')),
  NULL,
  'the boundary date (today in the business timezone) is accepted'
);

-- 22b the next day is rejected
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-FUTURE', ((now() at time zone 'Asia/Kathmandu')::date + interval '1 day')::date,
    100, 0, 100, 'CASH', 'Item', null, 'k-future', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '22023', NULL,
  'a future expense date is rejected'
);

-- 22c ...and the message names the timezone that decided "today", proving the
--     browser's local date played no part
select throws_like(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-FUTURE2', ((now() at time zone 'Asia/Kathmandu')::date + interval '2 days')::date,
    100, 0, 100, 'CASH', 'Item', null, 'k-future2', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '%cannot be in the future (today in Asia/Kathmandu is %',
  'the rejection names the business timezone that decided today'
);

-- 23 empty description
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-NODESC', '2026-01-01'::date, 100, 0, 100, 'CASH', '   ', null, 'k-nodesc', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '22023', NULL,
  'a blank description is rejected'
);

-- 24 precision the numeric(14,2) column cannot represent
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-PRECISION', '2026-01-01'::date, 100.005, 0, 100.005, 'CASH', 'Item', null, 'k-precision', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '22023', NULL,
  'an amount with more than two decimal places is rejected'
);

-- 25 duplicate reference
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-OWNER', '2026-01-05'::date, 100, 0, 100, 'CASH', 'Item', null, 'k-dup', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '23505', NULL,
  'a duplicate expense reference is rejected'
);

-- ---------------------------------------------------------------------------
-- Atomicity: a failure mid-post leaves nothing behind
-- ---------------------------------------------------------------------------
-- Baseline counts, then a trigger that fails the journal line insert AFTER the
-- journal entry row has been written. Fixtures run as the table owner.
reset role;

create temp table atomic_before as
  select (select count(*) from public.expenses where business_id = pg_temp.biz_a())        as expenses,
         (select count(*) from public.journal_entries where business_id = pg_temp.biz_a()) as entries,
         (select count(*) from public.journal_lines where business_id = pg_temp.biz_a())   as lines;

create function pg_temp.fail_journal_lines() returns trigger
language plpgsql as $$
begin
  raise exception 'injected failure after the journal entry was prepared' using errcode = 'P0001';
end $$;

create trigger zz_fail_journal_lines before insert on public.journal_lines
  for each row execute function pg_temp.fail_journal_lines();

-- 26 the injected failure surfaces as an error
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-ATOMIC', '2026-01-06'::date, 750, 0, 750, 'CASH', 'Atomic probe', null, 'k-atomic', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  'P0001', NULL,
  'a failure while writing the journal surfaces as an error'
);

reset role;
drop trigger zz_fail_journal_lines on public.journal_lines;

-- 27-29 nothing from the failed post survives
select is(
  (select count(*) from public.expenses where business_id = pg_temp.biz_a()),
  (select expenses from atomic_before),
  'the failed post leaves zero expense rows'
);
select is(
  (select count(*) from public.journal_entries where business_id = pg_temp.biz_a()),
  (select entries from atomic_before),
  'the failed post leaves zero journal entries'
);
select is(
  (select count(*) from public.journal_lines where business_id = pg_temp.biz_a()),
  (select lines from atomic_before),
  'the failed post leaves zero journal lines'
);

select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

-- ---------------------------------------------------------------------------
-- VAT policy
-- ---------------------------------------------------------------------------
-- 30 not registered for VAT: Business B rejects any tax
select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-B-VAT', '2026-01-01'::date, 1000, 130, 1130, 'CASH', 'Item', null, 'k-b-vat', false
  )$$, pg_temp.biz_b(), pg_temp.acct(pg_temp.biz_b(), '5020')),
  '22023', NULL,
  'an unregistered business cannot post a taxed expense'
);
reset role;

-- Business A becomes VAT registered
update public.businesses set vat_registered = true, vat_rate = 13 where id = pg_temp.biz_a();
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

-- 31 registered, but the tax does not match the applicable rate
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-WRONGVAT', '2026-01-01'::date, 1000, 50, 1050, 'CASH', 'Item', null, 'k-wrongvat', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '22023', NULL,
  'a tax amount inconsistent with the VAT rate is rejected'
);

-- 32 VAT-exclusive expense accepted
select isnt(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), 'EXP-VAT-EXCL', '2026-01-07'::date,
    1000, 130, 1130, 'BANK', 'VAT exclusive', null, 'k-vat-excl', false
  )->'expense'->>'id')),
  NULL,
  'a VAT-exclusive expense is accepted'
);

-- 33 VAT journal: Dr category, Dr VAT receivable 1070, Cr Bank
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.expenses where reference = 'EXP-VAT-EXCL')),
  '5020:1000:0, 1070:130:0, 1020:0:1130',
  'a taxed expense debits the category and VAT receivable 1070'
);

-- 34 VAT-inclusive expense accepted with an explicit mode
select isnt(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5040'), 'EXP-VAT-INCL', '2026-01-08'::date,
    1000, 130, 1130, 'CASH', 'VAT inclusive', null, 'k-vat-incl', true
  )->'expense'->>'id')),
  NULL,
  'a VAT-inclusive expense is accepted when the mode flag says so'
);

-- 35 inclusive journal is identical in shape
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.expenses where reference = 'EXP-VAT-INCL')),
  '5040:1000:0, 1070:130:0, 1010:0:1130',
  'the inclusive posting uses the same debit/credit structure'
);

-- 36 the claimed mode is persisted, so the fingerprint describes the document
select is(
  (select price_includes_vat from public.expenses where reference = 'EXP-VAT-INCL'),
  true,
  'the explicitly claimed VAT mode is persisted'
);

-- 37 an omitted mode is normalised and persisted, never left null
select is(
  (select price_includes_vat from public.expenses where reference = 'EXP-VAT-EXCL'),
  false,
  'a normalised VAT mode is persisted when the caller omits it'
);

-- ---------------------------------------------------------------------------
-- Server reference allocation
-- ---------------------------------------------------------------------------
-- 38 blank reference allocates EXP-YYYYMMDD-001
select is(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), '', '2026-03-01'::date,
    100, 0, 100, 'CASH', 'Auto one', null, 'k-idem-auto', false
  )->'expense'->>'reference')),
  'EXP-20260301-001',
  'a blank reference is allocated EXP-YYYYMMDD-001'
);

-- 39 the next blank reference on the same date increments
select is(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), '', '2026-03-01'::date,
    100, 0, 100, 'CASH', 'Auto two', null, 'k-auto-2', false
  )->'expense'->>'reference')),
  'EXP-20260301-002',
  'the next blank reference on the same date increments'
);

-- 40 a supplied reference is honoured
select is(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), 'EXP-SUPPLIED-1', '2026-03-05'::date,
    100, 0, 100, 'CASH', 'Supplied', null, 'k-supplied', false
  )->'expense'->>'reference')),
  'EXP-SUPPLIED-1',
  'a supplied reference is kept'
);

-- 41 a different date starts its own sequence
select is(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), '', '2026-03-02'::date,
    100, 0, 100, 'CASH', 'Auto other day', null, 'k-auto-3', false
  )->'expense'->>'reference')),
  'EXP-20260302-001',
  'the expense counter is scoped per business and date'
);

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------
-- 42 THE key case: a retry that still sends a blank reference replays the
--    original document instead of looking like a new request.
select is(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), '', '2026-03-01'::date,
    100, 0, 100, 'CASH', 'Auto one', null, 'k-idem-auto', false
  )->'expense'->>'id')),
  (select id::text from public.expenses where reference = 'EXP-20260301-001'),
  'a blank-reference retry returns the original expense'
);

-- 43 exactly one document
select is(
  (select count(*) from public.expenses where reference = 'EXP-20260301-001')::int,
  1,
  'the retry leaves exactly one expense row'
);

-- 44 exactly one journal entry for it
select is(
  (select count(*) from public.journal_entries
    where source_id = (select id from public.expenses where reference = 'EXP-20260301-001'))::int,
  1,
  'the retry leaves exactly one journal entry'
);

-- 45 exactly one set of journal lines (an untaxed expense has two: debit
--    category, credit settlement)
select is(
  (select count(*) from public.journal_lines
    where journal_entry_id = (select journal_entry_id from public.expenses where reference = 'EXP-20260301-001'))::int,
  2,
  'the retry does not duplicate the journal lines'
);

-- 46 same key, different amount
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, '', '2026-03-01'::date,
    999, 0, 999, 'CASH', 'Auto one', null, 'k-idem-auto', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '23505', NULL,
  'reusing an idempotency key with a different amount is rejected'
);

-- 47 same key, different account
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, '', '2026-03-01'::date,
    100, 0, 100, 'CASH', 'Auto one', null, 'k-idem-auto', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5030')),
  '23505', NULL,
  'reusing an idempotency key with a different account is rejected'
);

-- 48 same key, different VAT mode
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, 'EXP-VAT-INCL', '2026-01-08'::date,
    1000, 130, 1130, 'CASH', 'VAT inclusive', null, 'k-vat-incl', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5040')),
  '23505', NULL,
  'reusing an idempotency key with a different VAT mode is rejected'
);

-- 49 same key, different payment method
select throws_ok(
  format($$select public.post_expense(
    '%s'::uuid, '%s'::uuid, '', '2026-03-01'::date,
    100, 0, 100, 'BANK', 'Auto one', null, 'k-idem-auto', false
  )$$, pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020')),
  '23505', NULL,
  'reusing an idempotency key with a different payment method is rejected'
);

-- 50 a replay carrying a supplied reference never trips the duplicate check
select is(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), 'EXP-SUPPLIED-1', '2026-03-05'::date,
    100, 0, 100, 'CASH', 'Supplied', null, 'k-supplied', false
  )->'expense'->>'id')),
  (select id::text from public.expenses where reference = 'EXP-SUPPLIED-1'),
  'an exact replay with a supplied reference returns the original expense'
);

-- ---------------------------------------------------------------------------
-- Blank keys are not keys
-- ---------------------------------------------------------------------------
-- 51 an empty key is stored as null, and can be reused
select is(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), '', '2026-04-01'::date,
    100, 0, 100, 'CASH', 'Blank key', null, '', false
  )->'expense'->>'id')) is not null,
  true,
  'an empty idempotency key is accepted and treated as no key'
);

-- 52 a whitespace-only key is also treated as no key, so the second post is a
--    genuinely new document rather than a replay
select is(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), '', '2026-04-01'::date,
    100, 0, 100, 'CASH', 'Blank key', null, '   ', false
  )->'expense'->>'reference')),
  'EXP-20260401-002',
  'a whitespace-only key is normalised to null (a new document, not a replay)'
);

-- ---------------------------------------------------------------------------
-- Return payload, reload and balancing
-- ---------------------------------------------------------------------------
-- 53-55 the payload carries the expense, its journal entry and its lines
select is(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), 'EXP-PAYLOAD', '2026-05-01'::date,
    250, 0, 250, 'CASH', 'Payload probe', null, 'k-payload', false
  ) ? 'expense')),
  true,
  'the returned payload contains the expense'
);
select is(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), 'EXP-PAYLOAD-2', '2026-05-02'::date,
    250, 0, 250, 'CASH', 'Payload probe 2', null, 'k-payload-2', false
  ) ? 'journal_entry')),
  true,
  'the returned payload contains the journal entry'
);
select is(
  (select (public.post_expense(
    pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), 'EXP-PAYLOAD-3', '2026-05-03'::date,
    250, 0, 250, 'CASH', 'Payload probe 3', null, 'k-payload-3', false
  ) ? 'journal_lines')),
  true,
  'the returned payload contains the journal lines'
);

-- 56 the row survives a reload
select is(
  (select count(*) from public.expenses where reference = 'EXP-PAYLOAD')::int,
  1,
  'the expense row persists for a reload'
);

-- 57 every expense journal entry balances
select is(
  (select count(*) from (
     select je.id
       from public.journal_entries je
       join public.journal_lines jl on jl.journal_entry_id = je.id
      where je.business_id = pg_temp.biz_a()
        and je.source_type = 'EXPENSE'
      group by je.id
     having sum(jl.debit) <> sum(jl.credit)
   ) unbalanced)::int,
  0,
  'every expense journal entry balances (debits = credits)'
);

select * from finish();
rollback;
