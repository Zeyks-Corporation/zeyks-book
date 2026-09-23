-- 016_purchase_payment.test.sql
-- pgTAP suite: the PURCHASE (money-out) side of settlement.
-- Run with: supabase test db
--
-- Transactional (begin/rollback): every fixture below is rolled back, so a rerun
-- starts clean. The genuine two-session races for purchase payments live in
-- 017_purchase_payment_concurrency.test.sql, which must commit its fixtures.
--
-- Why this file exists: post_payment already supported SALE and PURCHASE before
-- Stage 9, and 009/012 pin the shared mechanics. What was NOT pinned is the
-- purchase side on its own terms: the wallet mapping when the money goes OUT,
-- the payable account and its snapshot, tenant/role refusal against a purchase,
-- over-settlement and the embedded upfront against a purchase, the money-out
-- reference format, atomic rollback, and sequence integrity for supplier
-- payments. Those are the assertions here; the sale cases stay in 009.
--
-- The rule this suite exists to protect (001/009): a supplier payment is NOT a
-- second architecture. It is the same post_payment, the same journal shape, the
-- same paid/due derivation — only the direction, the counterpart account and the
-- reference prefix differ. Nothing here may be written by the browser.
--
-- Comment labels name the cases; a case may make more than one assertion.

begin;
create extension if not exists pgtap with schema extensions;

select plan(80);

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
-- Business A is VAT registered and tracks inventory (real seeded chart, so the
-- eSewa/Khalti wallets 1040/1050 exist). Business C is a synthetic tenant that
-- never had those wallets, so the money-out fallback to 1020 is reachable.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a9111111-1111-4111-8111-1111111111a9',
   'authenticated', 'authenticated', 'po-alice@zeyks.test', '{"full_name":"Alice"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b9222222-2222-4222-8222-2222222222b9',
   'authenticated', 'authenticated', 'po-bob@zeyks.test', '{"full_name":"Bob"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c9333333-3333-4333-8333-3333333333c9',
   'authenticated', 'authenticated', 'po-carol@zeyks.test', '{"full_name":"Carol"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd9444444-4444-4444-8444-4444444444d9',
   'authenticated', 'authenticated', 'po-dan@zeyks.test', '{"full_name":"Dan"}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
select public.create_business(
  'Purchase Payment Business A', 'Alice', '', '', '', '', '', 'NPR', 4::smallint, true, 13::numeric, true
);
reset role;

select pg_temp.act_as('b9222222-2222-4222-8222-2222222222b9');
set local role authenticated;
select public.create_business('Purchase Payment Business B');
reset role;

do $$
declare
  v_biz_a uuid;
begin
  select id into v_biz_a from public.businesses where business_name = 'Purchase Payment Business A';

  insert into public.business_memberships (business_id, user_id, role)
  values (v_biz_a, 'c9333333-3333-4333-8333-3333333333c9', 'VIEWER'),
         (v_biz_a, 'd9444444-4444-4444-8444-4444444444d9', 'ACCOUNTANT');
end $$;

-- Business C: no 1040/1050 at all (accounts can never be archived), so a
-- supplier payment made by eSewa/Khalti has to fall back to the bank account.
insert into public.businesses (
  id, created_by, business_name, owner_name, currency_symbol,
  fiscal_year_start_month, vat_registered, vat_rate, track_inventory, timezone
) values (
  'cc000000-0000-4000-8000-0000000000c9', 'a9111111-1111-4111-8111-1111111111a9',
  'Purchase Payment Business C', 'Alice', 'NPR', 4, false, 0, false, 'Asia/Kathmandu'
);

insert into public.business_memberships (business_id, user_id, role)
values ('cc000000-0000-4000-8000-0000000000c9', 'a9111111-1111-4111-8111-1111111111a9', 'OWNER');

insert into public.accounts (business_id, code, name, type, description, system_account) values
  ('cc000000-0000-4000-8000-0000000000c9', '1010', 'Cash in hand',     'ASSET',     null, true),
  ('cc000000-0000-4000-8000-0000000000c9', '1020', 'Bank account',     'ASSET',     null, true),
  ('cc000000-0000-4000-8000-0000000000c9', '1030', 'Accounts receivable', 'ASSET',  null, true),
  ('cc000000-0000-4000-8000-0000000000c9', '2010', 'Accounts payable', 'LIABILITY', null, true),
  ('cc000000-0000-4000-8000-0000000000c9', '4010', 'Sales revenue',    'REVENUE',   null, true),
  ('cc000000-0000-4000-8000-0000000000c9', '5010', 'Cost of goods sold', 'EXPENSE', null, true);

create function pg_temp.biz_a() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Purchase Payment Business A';
$$;
create function pg_temp.biz_b() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Purchase Payment Business B';
$$;
create function pg_temp.biz_c() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Purchase Payment Business C';
$$;
create function pg_temp.purchase_id(p_reference text) returns uuid language sql security definer as $$
  select id from public.purchases where reference_number = p_reference;
$$;
create function pg_temp.pay_id(p_reference text) returns uuid language sql security definer as $$
  select id from public.payments where reference = p_reference;
$$;
grant execute on function
  pg_temp.biz_a(), pg_temp.biz_b(), pg_temp.biz_c(), pg_temp.purchase_id(text), pg_temp.pay_id(text)
  to authenticated, anon;

-- Thin forwarder so the assertions stay readable. SECURITY INVOKER on purpose:
-- the RPC is still called under the caller's own role and identity, exactly like
-- a direct call from the browser.
create function pg_temp.pay(
  p_biz uuid, p_type text, p_doc uuid, p_amount numeric,
  p_method text default 'CASH', p_date date default null,
  p_ref text default '', p_notes text default null, p_key text default null
) returns jsonb language sql as $$
  select public.post_payment(p_biz, p_type, p_doc, p_amount, p_method, p_date, p_ref, p_notes, p_key);
$$;
grant execute on function pg_temp.pay(uuid, text, uuid, numeric, text, date, text, text, text)
  to authenticated, anon;

create temp table calls (name text primary key, payload jsonb);
grant all on calls to authenticated;

create temp table failed (name text primary key, sqlstate text, message text);
grant all on failed to authenticated;

-- Records a refusal instead of aborting the transaction, so both the sqlstate
-- and the message the person would see are assertable.
create function pg_temp.pay_expect(
  p_name text, p_biz uuid, p_type text, p_doc uuid, p_amount numeric,
  p_method text default 'CASH', p_date date default null,
  p_ref text default '', p_notes text default null, p_key text default null
) returns void language plpgsql as $$
begin
  perform public.post_payment(p_biz, p_type, p_doc, p_amount, p_method, p_date, p_ref, p_notes, p_key);
  insert into failed values (p_name, 'none', 'no error was raised');
exception when others then
  insert into failed values (p_name, sqlstate, sqlerrm);
end $$;
grant execute on function
  pg_temp.pay_expect(text, uuid, text, uuid, numeric, text, date, text, text, text)
  to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Documents: three credit purchases for the method cases, one for partial/full,
-- one with an embedded upfront row, one for idempotency/rollback, one to void,
-- and one whose supplier payment will be voided to restore its balance.
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;

select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Cash supplier',
  p_reference_number := 'PP-M1', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
  p_idempotency_key := 'k-pp-m1', p_price_includes_vat := false
);

select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Bank supplier',
  p_reference_number := 'PP-M2', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb,
  p_idempotency_key := 'k-pp-m2', p_price_includes_vat := false
);

select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Wallet supplier',
  p_reference_number := 'PP-M3', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb,
  p_idempotency_key := 'k-pp-m3', p_price_includes_vat := false
);

select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Wallet supplier',
  p_reference_number := 'PP-M4', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb,
  p_idempotency_key := 'k-pp-m4', p_price_includes_vat := false
);

select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Staged supplier',
  p_reference_number := 'PP-O1', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
  p_idempotency_key := 'k-pp-o1', p_price_includes_vat := false
);

select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Upfront supplier',
  p_reference_number := 'PP-E1', p_date := current_date - 1,
  p_subtotal := 900, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 900,
  p_upfront_paid := 300, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":900,"discount":0,"total":900}]'::jsonb,
  p_idempotency_key := 'k-pp-e1', p_price_includes_vat := false
);

select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Key supplier',
  p_reference_number := 'PP-K1', p_date := current_date - 1,
  p_subtotal := 5000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 5000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":5000,"discount":0,"total":5000}]'::jsonb,
  p_idempotency_key := 'k-pp-k1', p_price_includes_vat := false
);

select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Voided supplier',
  p_reference_number := 'PP-V1', p_date := current_date - 1,
  p_subtotal := 600, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 600,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":600,"discount":0,"total":600}]'::jsonb,
  p_idempotency_key := 'k-pp-v1', p_price_includes_vat := false
);

select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Undone supplier',
  p_reference_number := 'PP-U1', p_date := current_date - 1,
  p_subtotal := 800, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 800,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":800,"discount":0,"total":800}]'::jsonb,
  p_idempotency_key := 'k-pp-u1', p_price_includes_vat := false
);

reset role;

-- Bob's bill in his own business, for the cross-tenant cases
select pg_temp.act_as('b9222222-2222-4222-8222-2222222222b9');
set local role authenticated;
select public.post_purchase(
  p_business_id := pg_temp.biz_b(), p_supplier_id := null, p_supplier_name := 'B supplier',
  p_reference_number := 'PP-B1', p_date := current_date - 1,
  p_subtotal := 400, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 400,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":400,"discount":0,"total":400}]'::jsonb,
  p_idempotency_key := 'k-pp-b1', p_price_includes_vat := false
);
reset role;

-- The wallet-less business C: two small bills, paid by eSewa and by Khalti
select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
select public.post_purchase(
  p_business_id := pg_temp.biz_c(), p_supplier_id := null, p_supplier_name := 'Fallback supplier',
  p_reference_number := 'PP-C1', p_date := current_date - 1,
  p_subtotal := 300, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 300,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":300,"discount":0,"total":300}]'::jsonb,
  p_idempotency_key := 'k-pp-c1', p_price_includes_vat := false
);
select public.post_purchase(
  p_business_id := pg_temp.biz_c(), p_supplier_id := null, p_supplier_name := 'Fallback supplier',
  p_reference_number := 'PP-C2', p_date := current_date - 1,
  p_subtotal := 200, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 200,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":200,"discount":0,"total":200}]'::jsonb,
  p_idempotency_key := 'k-pp-c2', p_price_includes_vat := false
);
reset role;

-- ---------------------------------------------------------------------------
-- Setup
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from public.accounts where business_id = pg_temp.biz_a() and code in ('1040', '1050')),
  2::bigint, 'P01 setup: business A carries both wallet accounts, so the wallet mapping is reachable'
);
select is(
  (select count(*) from public.accounts where business_id = pg_temp.biz_c() and code in ('1040', '1050')),
  0::bigint, 'P02 setup: the fallback business has no wallet account of any kind'
);
select is(
  (select count(*) from public.payments p join public.purchases x on x.id = p.linked_purchase_id
    where x.business_id = pg_temp.biz_a() and x.reference_number = 'PP-E1'),
  1::bigint, 'P03 setup: PP-E1 starts with only its embedded upfront row settled'
);
select is(
  (select count(*) from public.payments p join public.purchases x on x.id = p.linked_purchase_id
    where x.business_id = pg_temp.biz_a() and x.reference_number = 'PP-O1'),
  0::bigint, 'P04 setup: PP-O1 (the partial/full case) starts with nothing settled'
);

-- ---------------------------------------------------------------------------
-- Access control and tenant isolation — asserted against a PURCHASE
-- ---------------------------------------------------------------------------
-- Clear the transaction-local claims FIRST: pg_temp.act_as() sets them with
-- is_local = true, so the last fixture's identity would otherwise still be
-- active and this would not be an unauthenticated call at all.
select set_config('request.jwt.claims', '', true);
select pg_temp.pay_expect('unauth', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-M1'), 100,
                          'CASH', current_date - 1, '', null, 'k-unauth');
select is((select sqlstate from failed where name = 'unauth'), '28000'::text,
          'P05 a caller with no identity cannot settle a bill');
select is((select count(*) from public.payments where idempotency_key = 'k-unauth'),
          0::bigint, 'P05b the unauthenticated attempt wrote nothing');

select pg_temp.act_as('b9222222-2222-4222-8222-2222222222b9');
set local role authenticated;
select pg_temp.pay_expect('nonmember', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-M1'), 100,
                          'CASH', current_date - 1, '', null, 'k-nonmember');
select is((select sqlstate from failed where name = 'nonmember'), '42501'::text,
          'P06 a non-member cannot settle another tenant''s bill');
reset role;

select pg_temp.act_as('c9333333-3333-4333-8333-3333333333c9');
set local role authenticated;
select pg_temp.pay_expect('viewer', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-M1'), 100,
                          'CASH', current_date - 1, '', null, 'k-viewer');
select is((select sqlstate from failed where name = 'viewer'), '42501'::text,
          'P07 a VIEWER cannot post a supplier payment');
reset role;

select pg_temp.act_as('d9444444-4444-4444-8444-4444444444d9');
set local role authenticated;
insert into calls
select 'accountant', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-M1'), 100,
                                 'CASH', current_date - 1, '', 'accountant payment', 'k-accountant');
select is((select count(*) from public.payments where idempotency_key = 'k-accountant'), 1::bigint,
          'P08 an ACCOUNTANT can pay a supplier (a write role)');
reset role;

select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
insert into calls
select 'owner', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-M1'), 400,
                            'CASH', current_date - 1, '', 'owner payment', 'k-owner');
select is((select count(*) from public.payments where idempotency_key = 'k-owner'), 1::bigint,
          'P09 an OWNER can pay a supplier');

-- Alice, in her own business, naming Bob's bill: the row is simply not found.
select pg_temp.pay_expect('cross_tenant', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-B1'), 100,
                          'CASH', current_date - 1, '', null, 'k-cross');
select is((select sqlstate from failed where name = 'cross_tenant'), '22023'::text,
          'P10 another tenant''s bill cannot be settled from this business');
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_b() and p.linked_purchase_id = pg_temp.purchase_id('PP-B1')),
          0::bigint, 'P11 the cross-tenant attempt wrote nothing into that tenant either');

select pg_temp.pay_expect('unknown', pg_temp.biz_a(), 'PURCHASE',
                          '00000000-0000-4000-8000-0000000000ff'::uuid, 100,
                          'CASH', current_date - 1, '', null, 'k-unknown');
select is((select sqlstate from failed where name = 'unknown'), '22023'::text,
          'P12 a nonexistent bill is rejected');

select pg_temp.pay_expect('expense', pg_temp.biz_a(), 'EXPENSE',
                          (select id from public.accounts where business_id = pg_temp.biz_a() and code = '5010'),
                          100, 'CASH', current_date - 1, '', null, 'k-expense');
select is((select sqlstate from failed where name = 'expense'), '22023'::text,
          'P13 an expense is not a bill: only SALE and PURCHASE can be settled');
reset role;

-- ---------------------------------------------------------------------------
-- Server-determined shape of a supplier payment
-- ---------------------------------------------------------------------------
insert into calls
select 'owner_topup', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-M1'), 500,
                                  'CASH', current_date - 1, '', 'second owner payment', 'k-owner2');

select is(
  (select p.payment_type || '|' || coalesce(p.linked_sale_id::text, 'NULL') || '|' ||
          coalesce(p.linked_purchase_id::text, 'NULL')
     from public.payments p where p.idempotency_key = 'k-owner'),
  'OUTGOING|NULL|' || pg_temp.purchase_id('PP-M1')::text,
  'P14 a purchase settlement is OUTGOING and linked to the purchase only'
);
select is(
  (select p.party_name from public.payments p where p.idempotency_key = 'k-owner'),
  'Cash supplier',
  'P15 the party snapshot comes from the persisted bill, never from the caller'
);
select is(
  (select p.status || '|' || p.doc_status || '|' || p.payment_method
     from public.payments p where p.idempotency_key = 'k-owner'),
  'COMPLETED|POSTED|CASH',
  'P16 status, doc_status and method are server-determined'
);
select is(
  (select p.created_by from public.payments p where p.idempotency_key = 'k-owner'),
  'a9111111-1111-4111-8111-1111111111a9'::uuid,
  'P17 created_by is the authenticated caller, never a parameter'
);
select is(
  (select p.date from public.payments p where p.idempotency_key = 'k-owner'),
  current_date - 1,
  'P18 the supplier payment keeps the date it was given'
);
select ok(
  (select p.reference like 'PAY-' || to_char(current_date - 1, 'YYYYMMDD') || '-%'
     from public.payments p where p.idempotency_key = 'k-owner'),
  'P19 money out is allocated a PAY-YYYYMMDD-NNN reference, not RCP-'
);
select is(
  (select p.amount from public.payments p where p.idempotency_key = 'k-owner2'),
  500.00::numeric, 'P19b the bill can be topped up to its exact outstanding balance'
);

-- ---------------------------------------------------------------------------
-- Exact journal accounting for money out
-- ---------------------------------------------------------------------------
select is(
  (select (l->>'account_name') || '|' || (l->>'account_type') || '|' || (l->>'debit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'owner' and l->>'line_no' = '1'),
  'Accounts payable|LIABILITY|400.00',
  'P20 line 1 debits Accounts payable (2010) for the full amount'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'debit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'owner' and l->>'line_no' = '1'),
  'Accounts payable|400.00',
  'P21 the payable snapshot is the real account name'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'account_type') || '|' || (l->>'credit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'owner' and l->>'line_no' = '2'),
  'Cash in hand|ASSET|400.00',
  'P22 line 2 credits the settlement account (CASH -> 1010)'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'credit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'owner' and l->>'line_no' = '2'),
  'Cash in hand|400.00',
  'P23 the cash snapshot is the real account name'
);
select is(
  (select jsonb_array_length(payload->'journal_lines') from calls where name = 'owner'),
  2, 'P24 a supplier payment entry has exactly two lines'
);
select is(
  (select sum((l->>'debit')::numeric) - sum((l->>'credit')::numeric)
     from calls, jsonb_array_elements(payload->'journal_lines') l where calls.name = 'owner'),
  0::numeric, 'P25 the supplier payment entry balances exactly'
);
select is(
  (select payload->'journal_entry'->>'description' from calls where name = 'owner'),
  'Settlement to Cash supplier',
  'P26 the description mirrors buildPaymentEntry: "Settlement to <party>"'
);
select is(
  (select (payload->'journal_entry'->>'source_type') || '|' ||
          (payload->'journal_entry'->>'source_id' = payload->'payment'->>'id') || '|' ||
          (payload->'journal_entry'->>'reference' = payload->'payment'->>'reference')
     from calls where name = 'owner'),
  'PAYMENT|true|true',
  'P27 the entry is a PAYMENT sourced to the payment, carrying its reference'
);
select is(
  (select payload->'payment'->>'journal_entry_id' = payload->'journal_entry'->>'id'
     from calls where name = 'owner'),
  true, 'P28 the payment points at the entry it produced'
);

-- ---------------------------------------------------------------------------
-- Settlement account mapping for money OUT, including the fallback
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
insert into calls
select 'bank', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-M2'), 500,
                           'BANK', current_date - 1, '', 'bank payment', 'k-bank');
insert into calls
select 'esewa', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-M3'), 500,
                            'ESEWA', current_date - 1, '', 'wallet payment', 'k-esewa');
insert into calls
select 'khalti', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-M4'), 500,
                             'KHALTI', current_date - 1, '', 'wallet payment', 'k-khalti');
insert into calls
select 'c_esewa', pg_temp.pay(pg_temp.biz_c(), 'PURCHASE', pg_temp.purchase_id('PP-C1'), 300,
                              'ESEWA', current_date - 1, '', 'fallback', 'k-c-esewa');
insert into calls
select 'c_khalti', pg_temp.pay(pg_temp.biz_c(), 'PURCHASE', pg_temp.purchase_id('PP-C2'), 200,
                               'KHALTI', current_date - 1, '', 'fallback', 'k-c-khalti');
reset role;

select is(
  (select (l->>'account_name') || '|' || (l->>'credit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'bank' and l->>'line_no' = '2'),
  'Bank account|500.00', 'P29 BANK credits the bank account 1020'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'credit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'esewa' and l->>'line_no' = '2'),
  'eSewa wallet|500.00', 'P30 ESEWA credits the wallet account 1040 when it is active'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'credit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'khalti' and l->>'line_no' = '2'),
  'Khalti wallet|500.00', 'P31 KHALTI credits the wallet account 1050 when it is active'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'credit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'c_esewa' and l->>'line_no' = '2'),
  'Bank account|300.00', 'P32 a business with no eSewa wallet falls back to the bank account'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'credit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'c_khalti' and l->>'line_no' = '2'),
  'Bank account|200.00', 'P33 a business with no Khalti wallet falls back to the bank account'
);
select is(
  (select count(*) from calls
    where calls.name in ('c_esewa', 'c_khalti')
      and (select coalesce(sum((l->>'debit')::numeric) - sum((l->>'credit')::numeric), 0)
             from jsonb_array_elements(calls.payload->'journal_lines') l) <> 0),
  0::bigint, 'P34 the fallback business''s entries still balance'
);

-- ---------------------------------------------------------------------------
-- Validation: amount, date, method, over-settlement
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
select pg_temp.pay_expect('zero', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-O1'), 0,
                          'CASH', current_date - 1, '', null, 'k-zero');
select pg_temp.pay_expect('negative', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-O1'), -100,
                          'CASH', current_date - 1, '', null, 'k-negative');
select pg_temp.pay_expect('decimals', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-O1'), 100.005,
                          'CASH', current_date - 1, '', null, 'k-decimals');
select pg_temp.pay_expect('future', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-O1'), 100,
                          'CASH', current_date + 1, '', null, 'k-future');
select pg_temp.pay_expect('method', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-O1'), 100,
                          'CHEQUE', current_date - 1, '', null, 'k-method');
select pg_temp.pay_expect('over', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-O1'), 1000.01,
                          'CASH', current_date - 1, '', null, 'k-over');
reset role;

select is((select sqlstate from failed where name = 'zero'), '22023'::text,
          'P35 a zero supplier payment is rejected');
select is((select sqlstate from failed where name = 'negative'), '22023'::text,
          'P36 a negative supplier payment is rejected');
select is((select sqlstate from failed where name = 'decimals'), '22023'::text,
          'P37 an amount numeric(14,2) cannot hold is rejected, never rounded');
select is((select sqlstate from failed where name = 'future'), '22023'::text,
          'P38 a future-dated supplier payment is rejected');
select is((select sqlstate from failed where name = 'method'), '22023'::text,
          'P39 an unknown payment method is rejected');
select is((select sqlstate from failed where name = 'over'), '22023'::text,
          'P40 over-settlement of a bill is rejected');
select ok(
  (select message from failed where name = 'over') like '%exceeds the outstanding balance of 1000.00%',
  'P41 the rejection names the recomputed outstanding balance'
);
select is(
  (select count(*) from public.payments where linked_purchase_id = pg_temp.purchase_id('PP-O1')),
  0::bigint, 'P42 every refused supplier payment wrote nothing at all'
);

-- ---------------------------------------------------------------------------
-- Partial, then the exact remainder: the outstanding is recomputed each time
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
insert into calls
select 'partial', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-O1'), 400,
                              'BANK', current_date - 1, '', 'first instalment', 'k-o1a');
reset role;

select is(
  (select payload->'payment'->>'amount' from calls where name = 'partial'),
  '400.00', 'P43 a partial supplier payment is accepted'
);
select is(
  (select round(x.total_amount - coalesce(sum(p.amount), 0), 2)
     from public.purchases x
     left join public.payments p on p.linked_purchase_id = x.id
      and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
    where x.id = pg_temp.purchase_id('PP-O1')
    group by x.id, x.total_amount),
  600::numeric, 'P44 the outstanding balance falls to 600 after the first instalment'
);

select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
select pg_temp.pay_expect('over_after_partial', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-O1'),
                          600.01, 'BANK', current_date - 1, '', null, 'k-o1b');
insert into calls
select 'final', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-O1'), 600,
                            'CASH', current_date - 1, '', 'final instalment', 'k-o1c');
reset role;

select is((select sqlstate from failed where name = 'over_after_partial'), '22023'::text,
          'P45 the recomputed balance is what refuses the next payment, not the total');
select is(
  (select count(*) from public.payments where linked_purchase_id = pg_temp.purchase_id('PP-O1')),
  2::bigint, 'P46 the bill now has exactly two settlement rows (the two instalments)'
);
select is(
  (select round(sum(p.amount), 2) from public.payments p
    where p.linked_purchase_id = pg_temp.purchase_id('PP-O1')),
  1000::numeric, 'P47 the two instalments add up to the bill''s total, once each'
);
select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
select pg_temp.pay_expect('settled', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-O1'), 0.01,
                          'CASH', current_date - 1, '', null, 'k-o1d');
reset role;
select is((select sqlstate from failed where name = 'settled'), '22023'::text,
          'P48 a fully paid bill refuses another supplier payment');
select ok(
  (select message from failed where name = 'settled') like '%no outstanding balance%',
  'P49 the refusal says the bill has nothing left to pay'
);
select is(
  (select round(sum(p.amount), 2) from public.payments p
    where p.linked_purchase_id = pg_temp.purchase_id('PP-O1')
      and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
  1000::numeric, 'P50 the derived paid amount for the bill is 1000'
);
select is(
  (select case when round(sum(p.amount), 2) >= x.total_amount - 0.005 then 'PAID' else 'PARTIALLY_PAID' end
     from public.purchases x
     join public.payments p on p.linked_purchase_id = x.id
      and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
    where x.id = pg_temp.purchase_id('PP-O1')
    group by x.id, x.total_amount),
  'PAID'::text, 'P51 reconcile()''s derivation over the persisted rows reports PAID'
);
select is(
  (select count(*) from public.payments p
     join public.journal_entries je on je.id = p.journal_entry_id
    where p.linked_purchase_id = pg_temp.purchase_id('PP-O1')
      and je.source_type = 'PAYMENT'),
  2::bigint, 'P52 each instalment owns exactly one PAYMENT journal entry'
);

-- ---------------------------------------------------------------------------
-- The embedded upfront row is settled money, counted exactly once
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
select pg_temp.pay_expect('e1_over', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-E1'), 601,
                          'CASH', current_date - 1, '', null, 'k-e1-over');
insert into calls
select 'e1_final', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-E1'), 600,
                               'CASH', current_date - 1, '', 'fills the bill', 'k-e1-final');
reset role;

select is((select sqlstate from failed where name = 'e1_over'), '22023'::text,
          'P53 601 is refused because the embedded 300 was already settled money');
select is(
  (select round(sum(p.amount), 2) from public.payments p
    where p.linked_purchase_id = pg_temp.purchase_id('PP-E1')),
  900::numeric, 'P54 the embedded upfront and the posted payment add up to the total, once each'
);
select is(
  (select count(*) from public.payments p
    where p.linked_purchase_id = pg_temp.purchase_id('PP-E1')),
  2::bigint, 'P55 no duplicate row was created for the embedded upfront settlement'
);
select is(
  (select count(*) from public.payments p join public.purchases x on x.id = p.linked_purchase_id
    where p.linked_purchase_id = pg_temp.purchase_id('PP-E1')
      and p.journal_entry_id = x.journal_entry_id),
  1::bigint, 'P56 the embedded row still shares the bill''s own journal entry, untouched'
);
select is(
  (select case when round(sum(p.amount), 2) >= x.total_amount - 0.005 then 'PAID' else 'PARTIALLY_PAID' end
     from public.purchases x
     join public.payments p on p.linked_purchase_id = x.id
      and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
    where x.id = pg_temp.purchase_id('PP-E1')
    group by x.id, x.total_amount),
  'PAID'::text, 'P57 the bill derives PAID: 300 embedded + 600 posted = 900'
);

-- ---------------------------------------------------------------------------
-- Idempotency: a retry replays, a changed request conflicts
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
insert into calls
select 'k1_first', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-K1'), 500,
                               'BANK', current_date - 1, '', 'first', 'k-ppk1');
insert into calls
select 'k1_retry', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-K1'), 500,
                               'BANK', current_date - 1, '', 'first', 'k-ppk1');
select pg_temp.pay_expect('k1_conflict', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-K1'), 600,
                          'BANK', current_date - 1, '', 'first', 'k-ppk1');
select pg_temp.pay_expect('k1_conflict_doc', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-U1'), 500,
                          'BANK', current_date - 1, '', 'first', 'k-ppk1');
reset role;

select is(
  (select (payload->'payment'->>'id') from calls where name = 'k1_retry'),
  (select (payload->'payment'->>'id') from calls where name = 'k1_first'),
  'P58 an identical retry replays the very same supplier payment row'
);
select is(
  (select (payload->'journal_entry'->>'id') from calls where name = 'k1_retry'),
  (select (payload->'journal_entry'->>'id') from calls where name = 'k1_first'),
  'P59 the retry returns the original entry, not a second one'
);
select is(
  (select (payload->'payment'->>'reference') from calls where name = 'k1_retry'),
  (select (payload->'payment'->>'reference') from calls where name = 'k1_first'),
  'P60 the replay reallocates no reference'
);
select is(
  (select count(*) from public.payments where idempotency_key = 'k-ppk1'),
  1::bigint, 'P61 one key, one supplier payment'
);
select is((select sqlstate from failed where name = 'k1_conflict'), '23505'::text,
          'P62 the same key with a different amount conflicts');
select is((select sqlstate from failed where name = 'k1_conflict_doc'), '23505'::text,
          'P63 the same key against a different bill conflicts too');
select is(
  (select count(*) from public.payments p where p.business_id = pg_temp.biz_a()
     and p.linked_purchase_id in (pg_temp.purchase_id('PP-K1'), pg_temp.purchase_id('PP-U1'))),
  1::bigint, 'P64 the conflicting reuse produced no extra settlement row'
);

-- ---------------------------------------------------------------------------
-- A voided bill cannot be paid
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
select public.void_document(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-V1'));
select pg_temp.pay_expect('voided_doc', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-V1'), 100,
                          'CASH', current_date - 1, '', null, 'k-v1');
reset role;

select is((select sqlstate from failed where name = 'voided_doc'), '22023'::text,
          'P65 a voided bill refuses a supplier payment');
select is(
  (select count(*) from public.payments where linked_purchase_id = pg_temp.purchase_id('PP-V1')),
  0::bigint, 'P66 the refusal against a voided bill wrote nothing'
);

-- ---------------------------------------------------------------------------
-- Voiding a supplier payment restores the bill's balance, and the bill stays
-- POSTED. The accounting detail of a void lives in 012; this pins the effect on
-- the money-out side and that the derivation sees it.
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
insert into calls
select 'u1_pay', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-U1'), 400,
                             'CASH', current_date - 1, '', 'to be undone', 'k-ppu1');
select public.void_payment(
  pg_temp.biz_a(), (select (payload->'payment'->>'id')::uuid from calls where name = 'u1_pay')
);
reset role;

select is(
  (select count(*) from public.payments p
    where p.linked_purchase_id = pg_temp.purchase_id('PP-U1') and p.doc_status = 'VOIDED'),
  1::bigint, 'P67 the supplier payment is VOIDED in the database'
);
select is(
  (select status from public.purchases where id = pg_temp.purchase_id('PP-U1')),
  'POSTED'::text, 'P68 the bill itself stays POSTED — only its settlement was undone'
);
select is(
  (select round(x.total_amount - coalesce(sum(p.amount), 0), 2)
     from public.purchases x
     left join public.payments p on p.linked_purchase_id = x.id
      and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
    where x.id = pg_temp.purchase_id('PP-U1')
    group by x.id, x.total_amount),
  800::numeric, 'P69 the bill owes its full 800 again after the void'
);
select is(
  (select count(*) from public.payments p
    where p.linked_purchase_id = pg_temp.purchase_id('PP-U1')),
  1::bigint, 'P70 the voided settlement is kept, never deleted'
);

-- ---------------------------------------------------------------------------
-- Sequence integrity across supplier payments made in one session
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from (
     select je.sequence from public.journal_entries je
      where je.business_id = pg_temp.biz_a()
      group by je.sequence having count(*) > 1) x),
  0::bigint, 'P71 no two journal entries in the business share a sequence number'
);
select is(
  (select count(*) from (
     select p.journal_entry_id, count(distinct je.sequence) as n
       from public.payments p join public.journal_entries je on je.id = p.journal_entry_id
      where p.business_id = pg_temp.biz_a() and p.linked_purchase_id is not null
      group by p.journal_entry_id having count(distinct je.sequence) <> 1) x),
  0::bigint, 'P72 every supplier payment points at exactly one sequenced entry'
);
select is(
  (select count(*) from (
     select je.id from public.journal_entries je
       join public.journal_lines l on l.journal_entry_id = je.id
      where je.business_id = pg_temp.biz_a()
        and je.source_type = 'PAYMENT'
      group by je.id
     having sum(l.debit) <> sum(l.credit)) x),
  0::bigint, 'P73 no settlement entry in the business is left unbalanced'
);

-- ---------------------------------------------------------------------------
-- Atomicity: a failure while the payment row is written aborts the whole thing
-- ---------------------------------------------------------------------------
create temp table snap_a as
select (select count(*) from public.payments p where p.business_id = pg_temp.biz_a()) as payments,
       (select count(*) from public.journal_entries e where e.business_id = pg_temp.biz_a()) as entries,
       (select count(*) from public.journal_lines l where l.business_id = pg_temp.biz_a()) as lines,
       (select coalesce(max(sequence), 0) from public.journal_entries e
         where e.business_id = pg_temp.biz_a()) as seq;

create function pg_temp.payments_inject() returns trigger
language plpgsql as $$
begin
  if new.notes = 'inject-failure' then
    raise exception 'injected failure: the supplier payment row could not be written'
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger payments_inject before insert on public.payments
  for each row execute function pg_temp.payments_inject();

select pg_temp.act_as('a9111111-1111-4111-8111-1111111111a9');
set local role authenticated;
select pg_temp.pay_expect('inject', pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PP-K1'), 50,
                          'CASH', current_date - 1, 'PP-INJECT', 'inject-failure', 'k-inject');
reset role;
drop trigger payments_inject on public.payments;

select is((select sqlstate from failed where name = 'inject'), '23514'::text,
          'P74 an injected failure after the journal entry was prepared aborts the supplier payment');
select is((select count(*) from public.payments p where p.business_id = pg_temp.biz_a()),
          (select payments from snap_a), 'P75 no payment row was committed');
select is((select count(*) from public.journal_entries e where e.business_id = pg_temp.biz_a()),
          (select entries from snap_a), 'P76 no journal entry was committed');
select is((select count(*) from public.journal_lines l where l.business_id = pg_temp.biz_a()),
          (select lines from snap_a), 'P77 no journal line was committed');
select is((select coalesce(max(sequence), 0) from public.journal_entries e
            where e.business_id = pg_temp.biz_a()),
          (select seq from snap_a), 'P78 the failed attempt consumed no journal sequence');

select * from finish();
rollback;
