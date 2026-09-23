-- 014_gateway_settlement.test.sql
-- pgTAP suite for initiate_gateway_txn() (migration 011) and
-- settle_gateway_txn() (migration 012) — the server-authoritative gateway
-- foundation.
-- Run with: supabase test db
--
-- Transactional (begin/rollback): every fixture below is rolled back, so a
-- rerun starts clean. The genuine two-session settlement races live in
-- 015_gateway_concurrency.test.sql, which has to commit its fixtures.
--
-- The boundary this suite pins down:
--   * a gateway transaction is a PROVIDER interaction. It carries the
--     provider's reference, the amount that was asked for and the verification
--     state — never an accounting fact.
--   * money only reaches the books when settle_gateway_txn creates exactly one
--     payments row and exactly one PAYMENT journal entry through the same core
--     post_payment uses.
--   * the browser holds no write privilege on gateway_transactions, payments or
--     the journal: both paths are RPC-only, and the write guard refuses a row
--     that claims COMPLETED without a recorded server-side verification.
--
-- Comment labels name the cases; a case may make more than one assertion.

begin;
create extension if not exists pgtap with schema extensions;

select plan(156);

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
-- Business A is VAT registered and tracks inventory; Business B belongs to Bob.
-- Business C is a synthetic tenant with no eSewa/Khalti wallet accounts, so the
-- ESEWA/KHALTI -> 1020 fallback is reachable. Business D has no settlement
-- account at all, which is the injected-failure/rollback fixture.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'aa111111-1111-4111-8111-111111111111',
   'authenticated', 'authenticated', 'gw-alice@zeyks.test', '{"full_name":"Alice"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'bb222222-2222-4222-8222-222222222222',
   'authenticated', 'authenticated', 'gw-bob@zeyks.test', '{"full_name":"Bob"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'cc333333-3333-4333-8333-333333333333',
   'authenticated', 'authenticated', 'gw-carol@zeyks.test', '{"full_name":"Carol"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'dd444444-4444-4444-8444-444444444444',
   'authenticated', 'authenticated', 'gw-dan@zeyks.test', '{"full_name":"Dan"}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.create_business(
  'Gateway Business A', 'Alice', '', '', '', '', '', 'NPR', 4::smallint, true, 13::numeric, true
);
reset role;

select pg_temp.act_as('bb222222-2222-4222-8222-222222222222');
set local role authenticated;
select public.create_business('Gateway Business B');
reset role;

do $$
declare
  v_biz_a uuid;
begin
  select id into v_biz_a from public.businesses where business_name = 'Gateway Business A';

  insert into public.business_memberships (business_id, user_id, role)
  values (v_biz_a, 'cc333333-3333-4333-8333-333333333333', 'VIEWER'),
         (v_biz_a, 'dd444444-4444-4444-8444-444444444444', 'ACCOUNTANT');
end $$;

-- Business C: no 1040/1050 (the real chart seeds them and accounts can never be
-- deleted or archived once they exist, so a business that never had them is the
-- only honest way to reach the fallback).
insert into public.businesses (
  id, created_by, business_name, owner_name, currency_symbol,
  fiscal_year_start_month, vat_registered, vat_rate, track_inventory, timezone
) values (
  'cc000000-0000-4000-8000-0000000000c1', 'aa111111-1111-4111-8111-111111111111',
  'Gateway Business C', 'Alice', 'NPR', 4, false, 0, false, 'Asia/Kathmandu'
);

insert into public.business_memberships (business_id, user_id, role)
values ('cc000000-0000-4000-8000-0000000000c1', 'aa111111-1111-4111-8111-111111111111', 'OWNER');

insert into public.accounts (business_id, code, name, type, description, system_account) values
  ('cc000000-0000-4000-8000-0000000000c1', '1010', 'Cash in hand',        'ASSET',     null, true),
  ('cc000000-0000-4000-8000-0000000000c1', '1020', 'Bank account',        'ASSET',     null, true),
  ('cc000000-0000-4000-8000-0000000000c1', '1030', 'Accounts receivable', 'ASSET',     null, true),
  ('cc000000-0000-4000-8000-0000000000c1', '2010', 'Accounts payable',    'LIABILITY', null, true),
  ('cc000000-0000-4000-8000-0000000000c1', '4010', 'Sales revenue',       'REVENUE',   null, true);

-- Business D: 1030 + revenue only — no settlement account of any kind, so the
-- settlement blows up mid-transaction and the rollback is observable.
insert into public.businesses (
  id, created_by, business_name, owner_name, currency_symbol,
  fiscal_year_start_month, vat_registered, vat_rate, track_inventory, timezone
) values (
  'dd000000-0000-4000-8000-0000000000d1', 'aa111111-1111-4111-8111-111111111111',
  'Gateway Business D', 'Alice', 'NPR', 4, false, 0, false, 'Asia/Kathmandu'
);

insert into public.business_memberships (business_id, user_id, role)
values ('dd000000-0000-4000-8000-0000000000d1', 'aa111111-1111-4111-8111-111111111111', 'OWNER');

insert into public.accounts (business_id, code, name, type, description, system_account) values
  ('dd000000-0000-4000-8000-0000000000d1', '1010', 'Cash in hand',        'ASSET',   null, true),
  ('dd000000-0000-4000-8000-0000000000d1', '1030', 'Accounts receivable', 'ASSET',   null, true),
  ('dd000000-0000-4000-8000-0000000000d1', '4010', 'Sales revenue',       'REVENUE', null, true);

-- Business E displays its money as the Devanagari rupee glyph (U&'\0930\0942').
-- `currency` is pinned to 'NPR' by 001, but currency_symbol is only a glyph, so
-- collecting must still work: the rule compares the unit, never the symbol.
insert into public.businesses (
  id, created_by, business_name, owner_name, currency_symbol,
  fiscal_year_start_month, vat_registered, vat_rate, track_inventory, timezone
) values (
  'ee000000-0000-4000-8000-0000000000e1', 'aa111111-1111-4111-8111-111111111111',
  'Gateway Business E', 'Alice', U&'\0930\0942', 4, false, 0, false, 'Asia/Kathmandu'
);

insert into public.business_memberships (business_id, user_id, role)
values ('ee000000-0000-4000-8000-0000000000e1', 'aa111111-1111-4111-8111-111111111111', 'OWNER');

create function pg_temp.biz_a() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Gateway Business A';
$$;
create function pg_temp.biz_b() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Gateway Business B';
$$;
create function pg_temp.biz_c() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Gateway Business C';
$$;
create function pg_temp.biz_d() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Gateway Business D';
$$;
create function pg_temp.biz_e() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Gateway Business E';
$$;
create function pg_temp.sale_id(p_invoice text) returns uuid language sql security definer as $$
  select id from public.sales where invoice_number = p_invoice;
$$;
create function pg_temp.txn_id(p_ref text) returns uuid language sql security definer as $$
  select id from public.gateway_transactions where gateway_ref = p_ref;
$$;
grant execute on function
  pg_temp.biz_a(), pg_temp.biz_b(), pg_temp.biz_c(), pg_temp.biz_d(), pg_temp.biz_e(),
  pg_temp.sale_id(text), pg_temp.txn_id(text)
  to authenticated, anon;

-- Thin forwarders so the assertions stay readable. SECURITY INVOKER on purpose:
-- the RPC is still called by the caller's own role and identity, exactly like a
-- direct call from the browser.
create function pg_temp.ini(
  p_biz uuid, p_provider text, p_ref text, p_amount numeric, p_sale uuid,
  p_customer text default 'Gateway customer', p_currency text default 'NPR'
) returns jsonb language sql as $$
  select public.initiate_gateway_txn(p_biz, p_provider, p_ref, p_amount, p_sale, p_customer, p_currency);
$$;
grant execute on function pg_temp.ini(uuid, text, text, numeric, uuid, text, text) to authenticated, anon;

create function pg_temp.settle(
  p_biz uuid, p_txn uuid, p_verification jsonb,
  p_date date default null, p_notes text default null
) returns jsonb language sql as $$
  select public.settle_gateway_txn(p_biz, p_txn, p_verification, p_date, p_notes);
$$;
grant execute on function pg_temp.settle(uuid, uuid, jsonb, date, text) to authenticated, anon;

/** The one internal result shape the server adapters produce. */
create function pg_temp.v(
  p_provider text, p_ref text, p_amount numeric, p_txn_ref text,
  p_verified boolean default true, p_status text default 'COMPLETED',
  p_currency text default 'NPR', p_detail text default null,
  p_provider_txn_id text default null
) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'provider', p_provider,
    'verified', p_verified,
    'status', p_status,
    'amount', p_amount,
    'currency', p_currency,
    'reference', p_ref,
    'detail', p_detail,
    'gateway_transaction_id',
      case when p_provider_txn_id is null and p_verified then 'PT-' || p_ref else p_provider_txn_id end
  ));
$$;
grant execute on function pg_temp.v(text, text, numeric, text, boolean, text, text, text, text)
  to authenticated, anon;

create temp table calls (name text primary key, payload jsonb);
grant all on calls to authenticated;

-- Business E needs a chart and an invoice of its own, so the currency rule is
-- asserted against a real document rather than a dangling id.
insert into public.accounts (business_id, code, name, type, description, system_account) values
  ('ee000000-0000-4000-8000-0000000000e1', '1010', 'Cash in hand',        'ASSET',   null, true),
  ('ee000000-0000-4000-8000-0000000000e1', '1030', 'Accounts receivable', 'ASSET',   null, true),
  ('ee000000-0000-4000-8000-0000000000e1', '4010', 'Sales revenue',       'REVENUE', null, true);

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;

do $$
declare
  v_biz uuid := pg_temp.biz_a();
  v_doc record;
begin
  for v_doc in
    select * from (values
      ('GW-S1',  1000::numeric,   0::numeric),
      ('GW-S2',  1000::numeric, 250::numeric),
      ('GW-S3',  5000::numeric,   0::numeric),
      ('GW-S4',   600::numeric,   0::numeric),
      ('GW-S5',   800::numeric,   0::numeric),
      ('GW-S6',   400::numeric,   0::numeric),
      ('GW-S7',   300::numeric,   0::numeric),
      ('GW-S8',  1000::numeric,   0::numeric),
      ('GW-S9',   200::numeric,   0::numeric),
      ('GW-S10',  700::numeric,   0::numeric),
      ('GW-S11',  900::numeric,   0::numeric)
    ) as t(invoice, total, upfront)
  loop
    perform public.post_sale(
      p_business_id := v_biz, p_customer_id := null, p_customer_name := 'Gateway customer',
      p_invoice_number := v_doc.invoice, p_date := current_date - 1,
      p_subtotal := v_doc.total, p_discount_total := 0, p_tax_amount := 0,
      p_total_amount := v_doc.total, p_upfront_paid := v_doc.upfront,
      p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
      p_items := format(
        '[{"line_no":1,"description":"Item","quantity":1,"unit_price":%s,"discount":0,"total":%s}]',
        v_doc.total, v_doc.total
      )::jsonb
    );
  end loop;
end $$;
reset role;

-- Bob's invoice in his own business, for the cross-tenant cases
select pg_temp.act_as('bb222222-2222-4222-8222-222222222222');
set local role authenticated;
select public.post_sale(
  p_business_id := pg_temp.biz_b(), p_customer_id := null, p_customer_name := 'B1 customer',
  p_invoice_number := 'GW-B1', p_date := current_date - 1,
  p_subtotal := 400, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 400,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":400,"discount":0,"total":400}]'::jsonb
);
reset role;

-- Wallet-less business C, settlement-account-less business D, USD business E
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.post_sale(
  p_business_id := pg_temp.biz_c(), p_customer_id := null, p_customer_name := 'C1 customer',
  p_invoice_number := 'GW-C1', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := null, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb
);
select public.post_sale(
  p_business_id := pg_temp.biz_d(), p_customer_id := null, p_customer_name := 'D1 customer',
  p_invoice_number := 'GW-D1', p_date := current_date - 1,
  p_subtotal := 100, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 100,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := null, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb
);
select public.post_sale(
  p_business_id := pg_temp.biz_e(), p_customer_id := null, p_customer_name := 'E1 customer',
  p_invoice_number := 'GW-E1', p_date := current_date - 1,
  p_subtotal := 100, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 100,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := null, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb
);
reset role;

select diag('fixtures: business A has ' ||
            (select count(*) from public.sales where business_id = pg_temp.biz_a()) ||
            ' invoices, business D has no settlement account');

-- ---------------------------------------------------------------------------
-- Access control and tenant isolation
-- ---------------------------------------------------------------------------
-- G01 a JWT without a subject
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', 'ANON-1', 100, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '28000', NULL,
  'G01 an unauthenticated caller cannot start a collection'
);
select throws_ok(
  format($$select public.settle_gateway_txn('%s'::uuid, gen_random_uuid(), '{}'::jsonb)$$,
         pg_temp.biz_a()),
  '28000', NULL,
  'G02 an unauthenticated caller cannot settle'
);
reset role;

-- G03 anon holds no EXECUTE privilege on either entry point
set local role anon;
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', 'ANON-2', 100, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '42501', NULL,
  'G03 anon cannot execute initiate_gateway_txn'
);
select throws_ok(
  format($$select public.settle_gateway_txn('%s'::uuid, gen_random_uuid(), '{}'::jsonb)$$,
         pg_temp.biz_a()),
  '42501', NULL,
  'G04 anon cannot execute settle_gateway_txn'
);
reset role;

-- G05 a non-member (Alice calling into Bob's business)
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', 'CROSS-1', 100, '%s'::uuid)$$,
         pg_temp.biz_b(), pg_temp.sale_id('GW-B1')),
  '42501', NULL,
  'G05 a non-member cannot start a collection in another business'
);
-- G06 a VIEWER cannot start a collection
select pg_temp.act_as('cc333333-3333-4333-8333-333333333333');
reset role;
set local role authenticated;
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', 'VIEW-1', 100, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '42501', NULL,
  'G06 a VIEWER cannot start a collection'
);
select throws_ok(
  format($$select public.settle_gateway_txn('%s'::uuid, gen_random_uuid(), '{}'::jsonb)$$,
         pg_temp.biz_a()),
  '42501', NULL,
  'G07 a VIEWER cannot settle'
);
reset role;

-- G08 an ACCOUNTANT can do both (they are a write role) — proven by the
-- settlement itself later; here only the permission gate is checked by making
-- the call reach validation.
select pg_temp.act_as('dd444444-4444-4444-8444-444444444444');
set local role authenticated;
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'STRIPE', 'ACC-1', 100, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '22023', NULL,
  'G08 an ACCOUNTANT passes the permission gate (reaches provider validation)'
);
reset role;

-- G09 another tenant's collection id is simply not found in this business
select pg_temp.act_as('bb222222-2222-4222-8222-222222222222');
set local role authenticated;
select (pg_temp.ini(pg_temp.biz_b(), 'ESEWA', 'GW-B-TXN', 400, pg_temp.sale_id('GW-B1')))->'gateway_transaction'->>'id' as bob_txn \gset
reset role;
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.settle_gateway_txn('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-B-TXN', 400, 'GW-B-TXN'))$$,
         pg_temp.biz_a(), :'bob_txn'),
  '22023', 'Gateway transaction not found in this business',
  'G09 another business''s collection is not visible, and the message says nothing about it'
);
-- G10 an unknown id is the same answer
select throws_ok(
  format($$select public.settle_gateway_txn('%s'::uuid, gen_random_uuid(), pg_temp.v('ESEWA', 'X', 1, 'X'))$$,
         pg_temp.biz_a()),
  '22023', 'Gateway transaction not found in this business',
  'G10 an unknown collection id is the same answer as another tenant''s'
);
-- G11 a null id is refused before any lookup
select throws_ok(
  format($$select public.settle_gateway_txn('%s'::uuid, null, pg_temp.v('ESEWA', 'X', 1, 'X'))$$,
         pg_temp.biz_a()),
  '22023', 'A gateway transaction id is required',
  'G11 a missing collection id is refused'
);

-- ---------------------------------------------------------------------------
-- Provider, reference, amount and currency validation at initiation
-- ---------------------------------------------------------------------------
-- G12 an unknown provider
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'STRIPE', 'P-1', 100, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '22023', NULL,
  'G12 an unsupported provider is refused'
);
-- G13 a blank reference
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', '   ', 100, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '22023', 'A gateway reference is required',
  'G13 a blank gateway reference is refused'
);
-- G14 amount must be a positive numeric(14,2)
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', 'P-2', 0, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '22023', 'Amount must be greater than zero',
  'G14 a zero amount is refused'
);
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', 'P-3', -5, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '22023', NULL,
  'G15 a negative amount is refused'
);
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', 'P-4', 10.005, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '22023', NULL,
  'G16 an amount with more precision than a settlement can hold is refused'
);
-- G17 currency must be NPR, and must be the currency the books are kept in
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', 'P-5', 100, '%s'::uuid, 'X', 'USD')$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '22023', 'Gateway collections are only available in NPR (asked for USD)',
  'G17 a non-NPR collection is refused'
);
-- G18 a business that DISPLAYS its money as 'रू' is still collecting in NPR:
-- the rule compares the unit of the books, never the symbol.
select is(
  (pg_temp.ini(pg_temp.biz_e(), 'ESEWA', 'GW-REF-E1', 100, pg_temp.sale_id('GW-E1')))->'gateway_transaction'->>'currency',
  'NPR',
  'G18 a business whose symbol is रू collects in NPR and records NPR on the collection'
);
-- G19 the document is mandatory and must be this business's own POSTED sale
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', 'P-7', 100, null)$$,
         pg_temp.biz_a()),
  '22023', 'An online collection must be linked to an invoice, so it can be posted to the books',
  'G19 a collection with no invoice is refused (it could never be posted)'
);
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', 'P-8', 100, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-B1')),
  '22023', 'Sale not found in this business',
  'G20 another tenant''s invoice is not collectable, and the message says nothing about it'
);
-- G21 an amount above the outstanding balance
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', 'P-9', 1000.01, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '22023', NULL,
  'G21 an amount above the outstanding balance is refused at initiation'
);
-- G22 the success path
do $g22$
begin
  insert into calls (name, payload)
  values ('init-s1', pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-1', 1000, pg_temp.sale_id('GW-S1')));
end $g22$;

select is((select payload->>'replayed' from calls where name = 'init-s1'), 'false',
          'G23 a fresh initiation is not a replay');
select is((select payload->'gateway_transaction'->>'status' from calls where name = 'init-s1'),
          'INITIATED',
          'G24 a collection is born INITIATED');
select is((select (payload->'gateway_transaction'->>'verified_at') is null
             and (payload->'gateway_transaction'->>'payment_id') is null
             and (payload->'gateway_transaction'->>'gateway_transaction_id') is null
             and (payload->'gateway_transaction'->>'settled_at') is null
             from calls where name = 'init-s1'),
          true,
          'G25 a fresh collection is unverified and unsettled — nothing claims money arrived');
select is((select payload->>'settlement_state' from calls where name = 'init-s1'), 'UNSETTLED',
          'G26 the settlement state is derived, and starts UNSETTLED');
select is((select payload->'gateway_transaction'->>'initiated_by' from calls where name = 'init-s1'),
          'aa111111-1111-4111-8111-111111111111',
          'G27 the initiator is auth.uid(), never a parameter');
select is((select (payload->'gateway_transaction'->>'amount')::numeric
             || '|' || (payload->'gateway_transaction'->>'currency')
             || '|' || (payload->'gateway_transaction'->>'provider')
             || '|' || (payload->'gateway_transaction'->>'gateway_ref')
             || '|' || ((payload->'gateway_transaction'->>'linked_sale_id')::uuid = pg_temp.sale_id('GW-S1'))::text
             from calls where name = 'init-s1'),
          '1000.00|NPR|ESEWA|GW-REF-1|true',
          'G28 the persisted row carries the amount, currency, provider and invoice it was initiated with');
select is((select payload->'document'->>'invoice_number' from calls where name = 'init-s1'), 'GW-S1',
          'G29 the initiation returns the invoice it is linked to');
select is((select count(*) from public.gateway_transactions where gateway_ref = 'GW-REF-1'), 1::bigint,
          'G30 exactly one row exists for the reference');

-- G31 an identical retry replays the persisted row instead of inserting again
insert into calls (name, payload)
values ('init-s1-retry', pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-1', 1000, pg_temp.sale_id('GW-S1')));
select is((select payload->>'replayed' from calls where name = 'init-s1-retry'), 'true',
          'G31 an identical retry is a replay, not a second row');
select is((select payload->'gateway_transaction'->>'id' from calls where name = 'init-s1-retry'),
          (select payload->'gateway_transaction'->>'id' from calls where name = 'init-s1'),
          'G32 the replay returns the same persisted collection');
select is((select count(*) from public.gateway_transactions where gateway_ref = 'GW-REF-1'), 1::bigint,
          'G33 the replay wrote no second row');

-- G34 the same reference with a different amount is a conflict, not a replay
select throws_ok(
  format($$select pg_temp.ini('%s'::uuid, 'ESEWA', 'GW-REF-1', 999, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '23505', NULL,
  'G34 the same gateway reference with a different amount is refused'
);
-- G35 the same reference against a different invoice is a conflict too
select throws_ok(
  format($$select pg_temp.ini('%s'::uuid, 'ESEWA', 'GW-REF-1', 1000, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S3')),
  '23505', NULL,
  'G35 the same gateway reference against another invoice is refused'
);
select is((select count(*) from public.gateway_transactions where gateway_ref = 'GW-REF-1'), 1::bigint,
          'G36 neither conflict wrote a row');
reset role;

-- G37 a cross-business replay is refused without disclosing that the row exists
select pg_temp.act_as('bb222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok(
  format($$select pg_temp.ini('%s'::uuid, 'ESEWA', 'GW-REF-1', 1000, '%s'::uuid)$$,
         pg_temp.biz_b(), pg_temp.sale_id('GW-B1')),
  '23505', 'This gateway reference is already in use',
  'G37 another business''s reference is refused with a message that names nothing'
);
reset role;
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;

-- ---------------------------------------------------------------------------
-- The browser cannot write financial state directly
-- ---------------------------------------------------------------------------
-- G38..G44: no INSERT/UPDATE privilege for authenticated on any financial table
set local role authenticated;
select throws_ok(
  format($$insert into public.gateway_transactions (business_id, provider, gateway_ref, amount, linked_sale_id, initiated_by)
           values ('%s'::uuid, 'ESEWA', 'HACK-1', 1, '%s'::uuid, 'aa111111-1111-4111-8111-111111111111'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '42501', NULL,
  'G38 authenticated cannot INSERT a gateway transaction'
);
select throws_ok(
  format($$update public.gateway_transactions set status = 'COMPLETED', verified_at = now()
            where business_id = '%s'::uuid$$, pg_temp.biz_a()),
  '42501', NULL,
  'G39 authenticated cannot UPDATE a gateway transaction'
);
select throws_ok(
  format($$insert into public.payments (business_id, reference, date, amount, payment_method, payment_type, party_name, journal_entry_id, created_by, gateway_transaction_id)
           values ('%s'::uuid, 'HACK-2', current_date, 1, 'ESEWA', 'INCOMING', 'x', gen_random_uuid(), 'aa111111-1111-4111-8111-111111111111'::uuid, 'HACKTXN')$$,
         pg_temp.biz_a()),
  '42501', NULL,
  'G40 authenticated cannot INSERT a settlement'
);
select throws_ok(
  format($$update public.payments set gateway_transaction_id = 'X' where business_id = '%s'::uuid$$,
         pg_temp.biz_a()),
  '42501', NULL,
  'G41 authenticated cannot UPDATE a settlement'
);
select throws_ok($$
  insert into public.journal_entries (business_id, transaction_date, sequence, description, reference, source_type, created_by)
  values (gen_random_uuid(), current_date, 1, 'x', 'X', 'MANUAL', 'aa111111-1111-4111-8111-111111111111'::uuid)$$,
  '42501', NULL,
  'G42 authenticated cannot INSERT a journal entry'
);
select throws_ok($$
  insert into public.journal_lines (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
  values (gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(), 'x', 'ASSET', 1, 0)$$,
  '42501', NULL,
  'G43 authenticated cannot INSERT a journal line'
);
reset role;

-- G44..G45: RLS keeps another tenant's collections invisible to a member
select pg_temp.act_as('bb222222-2222-4222-8222-222222222222');
set local role authenticated;
select is((select count(*) from public.gateway_transactions where gateway_ref = 'GW-REF-1'), 0::bigint,
          'G44 a member of another business cannot read this collection');
reset role;
select pg_temp.act_as('cc333333-3333-4333-8333-333333333333');
set local role authenticated;
select is((select count(*) from public.gateway_transactions where business_id = pg_temp.biz_a()), 1::bigint,
          'G45 a VIEWER of this business can read its collection (reads are not gated)'
);
reset role;

-- ---------------------------------------------------------------------------
-- Append-only guard: the invariants hold even without this RPC
-- ---------------------------------------------------------------------------
select throws_ok(
  $$update public.gateway_transactions set amount = 999 where gateway_ref = 'GW-REF-1'$$,
  '23001', NULL,
  'G46 the amount on a collection is immutable'
);
select throws_ok(
  $$update public.gateway_transactions set status = 'COMPLETED' where gateway_ref = 'GW-REF-1'$$,
  '23001', NULL,
  'G47 a collection cannot be marked COMPLETED without a recorded verification'
);
select throws_ok(
  $$insert into public.gateway_transactions (business_id, provider, gateway_ref, amount, linked_sale_id, initiated_by, status, verified_at, gateway_transaction_id)
    values ('cc000000-0000-4000-8000-0000000000c1', 'ESEWA', 'HACK-3', 1, null,
            'aa111111-1111-4111-8111-111111111111', 'COMPLETED', now(), 'FORGED')$$,
  '23001', NULL,
  'G48 a row cannot be inserted already COMPLETED'
);
select throws_ok(
  $$insert into public.gateway_transactions (business_id, provider, gateway_ref, amount, linked_sale_id)
    values ('cc000000-0000-4000-8000-0000000000c1', 'ESEWA', 'HACK-4', 1, null)$$,
  '23001', NULL,
  'G49 a row cannot be inserted without recording who initiated it'
);
select throws_ok(
  $$insert into public.gateway_transactions (business_id, provider, gateway_ref, amount, linked_sale_id, initiated_by, payment_id, settled_at)
    values ('cc000000-0000-4000-8000-0000000000c1', 'ESEWA', 'HACK-5', 1, null,
            'aa111111-1111-4111-8111-111111111111', gen_random_uuid(), now())$$,
  '23001', NULL,
  'G50 a row cannot be inserted already settled'
);
-- A row of its own: GW-REF-1 is settled for real further down, and its
-- provider transaction id has to stay the one that settlement recorded.
insert into public.gateway_transactions (
  business_id, provider, gateway_ref, amount, currency, status, linked_sale_id, initiated_by
) values (
  'cc000000-0000-4000-8000-0000000000c1', 'ESEWA', 'GW-REF-WRITEONCE', 50, 'NPR', 'INITIATED', null,
  'aa111111-1111-4111-8111-111111111111'
);
update public.gateway_transactions set gateway_transaction_id = 'WRITE-ONCE'
 where gateway_ref = 'GW-REF-WRITEONCE';
select throws_ok(
  $$update public.gateway_transactions set gateway_transaction_id = 'SECOND'
     where gateway_ref = 'GW-REF-WRITEONCE'$$,
  '23001', NULL,
  'G51 the provider transaction id is write-once'
);

-- G52..G53 a recorded verification is write-once, and it cannot be walked back
insert into public.gateway_transactions (
  business_id, provider, gateway_ref, amount, currency, status, linked_sale_id, initiated_by
) values (
  'cc000000-0000-4000-8000-0000000000c1', 'ESEWA', 'GW-REF-VERIF', 50, 'NPR', 'INITIATED', null,
  'aa111111-1111-4111-8111-111111111111'
);
update public.gateway_transactions
   set status = 'COMPLETED', verified_at = now(), gateway_transaction_id = 'VERIF-1'
 where gateway_ref = 'GW-REF-VERIF';
select throws_ok(
  -- A visibly different timestamp: now() is the transaction timestamp, so it
  -- would be identical inside this suite's single transaction.
  $$update public.gateway_transactions set verified_at = now() - interval '1 day'
     where gateway_ref = 'GW-REF-VERIF'$$,
  '23001', NULL,
  'G52 a recorded verification timestamp cannot be rewritten'
);
select throws_ok(
  $$update public.gateway_transactions set status = 'FAILED' where gateway_ref = 'GW-REF-VERIF'$$,
  '23001', NULL,
  'G53 a verified collection cannot be un-verified'
);

-- G54..G56 a refund is terminal, and this stage refuses to settle one
insert into public.gateway_transactions (
  business_id, provider, gateway_ref, amount, currency, status, linked_sale_id, initiated_by
) values (
  pg_temp.biz_a(), 'ESEWA', 'GW-REF-REFUND', 100, 'NPR', 'INITIATED', pg_temp.sale_id('GW-S1'),
  'aa111111-1111-4111-8111-111111111111'
);
update public.gateway_transactions set status = 'REFUNDED' where gateway_ref = 'GW-REF-REFUND';
select throws_ok(
  $$update public.gateway_transactions set status = 'PENDING' where gateway_ref = 'GW-REF-REFUND'$$,
  '23001', NULL,
  'G54 a refunded collection cannot change status again'
);
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-REFUND', 100, 'GW-REF-REFUND'))$$,
         pg_temp.biz_a(), pg_temp.txn_id('GW-REF-REFUND')),
  '22023', NULL,
  'G55 a refunded collection cannot be settled (refund handling is deferred)'
);
reset role;
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_a() and p.gateway_transaction_id is not null), 0::bigint,
          'G56 a refused refund settlement posted nothing (this business has no gateway-linked settlement yet)');

-- G57 a provider transaction id cannot be recorded on two collections
-- (asserted as an UPDATE: an INSERT carrying one is refused earlier, by the
--  "a row is born unverified" rule, which is the point of G48)
insert into public.gateway_transactions (
  business_id, provider, gateway_ref, amount, currency, status, linked_sale_id, initiated_by
) values (
  'cc000000-0000-4000-8000-0000000000c1', 'ESEWA', 'GW-REF-SECOND', 50, 'NPR', 'INITIATED', null,
  'aa111111-1111-4111-8111-111111111111'
);
select throws_ok(
  $$update public.gateway_transactions set gateway_transaction_id = 'WRITE-ONCE'
     where gateway_ref = 'GW-REF-SECOND'$$,
  '23505', NULL,
  'G57 one provider transaction id can only ever belong to one collection'
);

-- ---------------------------------------------------------------------------
-- Verification lifecycle: what a provider answer may and may not do
-- ---------------------------------------------------------------------------
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;

-- GW-S10 gets a collection that will be verified repeatedly before it settles.
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-10', 700, pg_temp.sale_id('GW-S10')))->'gateway_transaction'->>'id' as t10 \gset

-- G58 a malformed payload is a caller bug, never a payment outcome
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, '[]'::jsonb)$$, pg_temp.biz_a(), :'t10'),
  '22023', 'Malformed gateway verification payload: expected an object',
  'G58 a non-object payload is refused'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, null)$$, pg_temp.biz_a(), :'t10'),
  '22023', NULL,
  'G59 a null payload is refused'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, '{"provider":"ESEWA","status":"COMPLETED","amount":700}'::jsonb)$$,
         pg_temp.biz_a(), :'t10'),
  '22023', 'Malformed gateway verification payload: verified must be a boolean',
  'G60 a COMPLETED payload with no verified flag is refused (the NULL-comparison trap)'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, '{"provider":"ESEWA","verified":"true","status":"COMPLETED","amount":700}'::jsonb)$$,
         pg_temp.biz_a(), :'t10'),
  '22023', NULL,
  'G61 a string where a boolean belongs is refused'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, '{"provider":"ESEWA","verified":true,"status":"PAID","amount":700}'::jsonb)$$,
         pg_temp.biz_a(), :'t10'),
  '22023', NULL,
  'G62 an invented status is refused'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-10', 700, 'GW-REF-10', true, 'FAILED'))$$,
         pg_temp.biz_a(), :'t10'),
  '22023', 'Malformed gateway verification payload: a verified result must be COMPLETED',
  'G63 verified=true with a non-COMPLETED status is a contradiction'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-10', 700, 'GW-REF-10', false, 'COMPLETED'))$$,
         pg_temp.biz_a(), :'t10'),
  '22023', 'Malformed gateway verification payload: a COMPLETED status must be verified',
  'G64 COMPLETED with verified=false is refused — success cannot be claimed'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, '{"provider":"ESEWA","verified":false,"status":"FAILED","amount":"abc"}'::jsonb)$$,
         pg_temp.biz_a(), :'t10'),
  '22023', NULL,
  'G65 a non-numeric amount is refused'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, '{"provider":"ESEWA","verified":false,"status":"FAILED"}'::jsonb)$$,
         pg_temp.biz_a(), :'t10'),
  '22023', NULL,
  'G66 a missing amount is refused'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-10', 0, 'GW-REF-10', false, 'FAILED'))$$,
         pg_temp.biz_a(), :'t10'),
  '22023', NULL,
  'G67 a zero amount is refused'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-10', 700.005, 'GW-REF-10', false, 'FAILED'))$$,
         pg_temp.biz_a(), :'t10'),
  '22023', NULL,
  'G68 an amount with more precision than a settlement can hold is refused'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-10', 700, 'GW-REF-10', true, 'COMPLETED', 'USD'))$$,
         pg_temp.biz_a(), :'t10'),
  '22023', NULL,
  'G69 a currency the books do not use is refused'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('KHALTI', 'GW-REF-10', 700, 'GW-REF-10'))$$,
         pg_temp.biz_a(), :'t10'),
  '22023', 'Verification is for provider KHALTI but this collection is ESEWA',
  'G70 a verification for another provider is refused'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'SOMEONE-ELSE', 700, 'SOMEONE-ELSE'))$$,
         pg_temp.biz_a(), :'t10'),
  '22023', NULL,
  'G71 a verification naming another reference is refused'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, '{"provider":"ESEWA","verified":true,"status":"COMPLETED","amount":700,"reference":"GW-REF-10"}'::jsonb)$$,
         pg_temp.biz_a(), :'t10'),
  '22023', NULL,
  'G72 a verified result without the provider transaction id is refused'
);
select is((select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('GW-S10')), 0::bigint,
          'G73 twelve refused payloads posted nothing at all');

-- G74..G78 a genuine provider answer that is not a success is recorded, not posted
select (pg_temp.settle(pg_temp.biz_a(), :'t10',
          pg_temp.v('ESEWA', 'GW-REF-10', 700, 'GW-REF-10', false, 'PENDING', 'NPR', 'Pending at gateway')))->>'outcome' as o1 \gset
select is(:'o1'::text, 'NOT_VERIFIED', 'G74 a pending answer is NOT_VERIFIED, never a settlement');
select is((select status || '|' || coalesce(last_error, '-') || '|' || (verified_at is null)::text
             from public.gateway_transactions where id = :'t10'),
          'PENDING|Pending at gateway|true',
          'G75 the provider answer and its detail are recorded on the collection, which stays unverified');
select (pg_temp.settle(pg_temp.biz_a(), :'t10',
          pg_temp.v('ESEWA', 'GW-REF-10', 700, 'GW-REF-10', false, 'FAILED', 'NPR', 'Declined')))->>'outcome' as o2 \gset
select is(:'o2'::text, 'NOT_VERIFIED', 'G76 a failed answer is NOT_VERIFIED');
select is((select status from public.gateway_transactions where id = :'t10'), 'FAILED',
          'G77 re-verification updates the recorded status');
select (pg_temp.settle(pg_temp.biz_a(), :'t10',
          pg_temp.v('ESEWA', 'GW-REF-10', 700, 'GW-REF-10', false, 'EXPIRED')))->>'outcome' as o3 \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t10',
          pg_temp.v('ESEWA', 'GW-REF-10', 700, 'GW-REF-10', false, 'CANCELED')))->>'outcome' as o4 \gset
select is(:'o3'::text || '|' || :'o4'::text, 'NOT_VERIFIED|NOT_VERIFIED',
          'G78 expired and canceled answers are both NOT_VERIFIED');
select is((select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('GW-S10')), 0::bigint,
          'G79 four provider answers later, the books are still untouched');

-- G80..G82 the same collection can still settle once the gateway confirms it
select (pg_temp.settle(pg_temp.biz_a(), :'t10',
          pg_temp.v('ESEWA', 'GW-REF-10', 700, 'GW-REF-10')))->>'outcome' as o5 \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t10',
          pg_temp.v('ESEWA', 'GW-REF-10', 700, 'GW-REF-10')))->>'outcome' as o6 \gset
select is(:'o5'::text || '|' || :'o6'::text, 'SETTLED|ALREADY_SETTLED',
          'G80 a collection that failed twice and expired once still settles when the gateway confirms it, and the retry replays');
select is((select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('GW-S10')), 1::bigint,
          'G81 the settled collection produced exactly one payment');
select is((select p.gateway_transaction_id from public.payments p where p.linked_sale_id = pg_temp.sale_id('GW-S10')),
          'PT-GW-REF-10',
          'G82 the payment carries the provider''s own transaction id');

-- ---------------------------------------------------------------------------
-- A successful settlement: exactly one payment, exactly one journal entry
-- ---------------------------------------------------------------------------
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-1', 1000, pg_temp.sale_id('GW-S1')))->'gateway_transaction'->>'id' as t1 \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t1', pg_temp.v('ESEWA', 'GW-REF-1', 1000, 'GW-REF-1')))->>'outcome' as s1 \gset
select pg_temp.txn_id('GW-REF-1') as t1b \gset
select (select payment_id from public.gateway_transactions where id = :'t1') as p1 \gset
select is(:'s1'::text, 'SETTLED', 'G83 a verified collection settles');
select is((select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('GW-S1')), 1::bigint,
          'G84 exactly one settlement row exists for the invoice');
select is((select p.amount || '|' || p.payment_method || '|' || p.payment_type || '|' || p.status
             || '|' || p.doc_status || '|' || p.gateway_transaction_id
             || '|' || p.party_name || '|' || p.idempotency_key
             || '|' || (p.reference like 'RCP-' || to_char(current_date, 'YYYYMMDD') || '-%')::text
             from public.payments p where p.linked_sale_id = pg_temp.sale_id('GW-S1')),
          '1000.00|ESEWA|INCOMING|COMPLETED|POSTED|PT-GW-REF-1|Gateway customer|gw:' || :'t1'::text || '|true',
          'G85 the payment is INCOMING ESEWA, POSTED, carries the provider transaction id and a server-allocated reference');
select is((select count(*)
             from public.journal_entries je
             join public.payments p on p.journal_entry_id = je.id
            where p.linked_sale_id = pg_temp.sale_id('GW-S1') and je.source_type = 'PAYMENT'),
          1::bigint,
          'G86 exactly one PAYMENT journal entry was written');
select is((select je.source_id = p.id and je.description = 'Settlement from Gateway customer'
              and je.reference = p.reference
             from public.journal_entries je join public.payments p on p.journal_entry_id = je.id
            where p.linked_sale_id = pg_temp.sale_id('GW-S1')),
          true,
          'G87 the entry belongs to the payment, with post_payment''s own description and reference');
select is((select count(*) from public.journal_lines jl
            where jl.journal_entry_id = (select journal_entry_id from public.payments
                                          where linked_sale_id = pg_temp.sale_id('GW-S1'))),
          2::bigint,
          'G88 the settlement posts exactly two lines');
select is((select (select string_agg(jl.account_name || ':' || jl.debit || ':' || jl.credit, ',' order by jl.line_no)
                    from public.journal_lines jl where jl.journal_entry_id = p.journal_entry_id)
             from public.payments p where p.linked_sale_id = pg_temp.sale_id('GW-S1')),
          'eSewa wallet:1000.00:0.00,Accounts receivable:0.00:1000.00',
          'G89 a gateway settlement debits the eSewa wallet and credits receivable — post_payment semantics exactly');
select is((select (sum(jl.debit) = sum(jl.credit))::text from public.journal_lines jl
            where jl.journal_entry_id = (select journal_entry_id from public.payments
                                          where linked_sale_id = pg_temp.sale_id('GW-S1'))),
          'true', 'G90 the settlement balances at the database level');
select is((select g.status || '|' || (g.payment_id is not null)::text || '|' || (g.verified_at is not null)::text
             || '|' || (g.settled_at is not null)::text || '|' || g.gateway_transaction_id
             || '|' || coalesce(g.last_error, '-')
             from public.gateway_transactions g where g.id = :'t1'),
          'COMPLETED|true|true|true|PT-GW-REF-1|-',
          'G91 the collection is COMPLETED, verified, settled and linked — in one transaction');
select is((select g.payment_id::text from public.gateway_transactions g where g.id = :'t1'), :'p1',
          'G92 the collection points at the settlement it produced');
select is((select status from public.sales where id = pg_temp.sale_id('GW-S1')), 'POSTED',
          'G93 settling does not touch the invoice''s status');
select is((select round(s.total_amount - coalesce(sum(p.amount), 0), 2)
             from public.sales s
             left join public.payments p on p.linked_sale_id = s.id
                and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
            where s.id = pg_temp.sale_id('GW-S1')
            group by s.total_amount), 0.00,
          'G94 reconciliation: the invoice is fully paid, derived from the persisted settlement');
select is((select (select je.sequence from public.journal_entries je
                    where je.source_type = 'PAYMENT' and je.source_id = p.id)
                 > (select s.journal_entry_id is not null from public.sales s where s.id = p.linked_sale_id)::int
             from public.payments p where p.linked_sale_id = pg_temp.sale_id('GW-S1')),
          true, 'G95 the settlement entry has its own journal sequence');

-- G96..G100 a replay writes nothing, whatever it claims
select (pg_temp.settle(pg_temp.biz_a(), :'t1', pg_temp.v('ESEWA', 'GW-REF-1', 1000, 'GW-REF-1')))->>'outcome' as r1 \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t1', pg_temp.v('ESEWA', 'GW-REF-1', 1, 'GW-REF-1')))->>'outcome' as r2 \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t1', pg_temp.v('ESEWA', 'GW-REF-1', 1000, 'GW-REF-1', false, 'FAILED')))->>'outcome' as r3 \gset
select is(:'r1'::text, 'ALREADY_SETTLED', 'G96 an identical repeat is a replay');
select is(:'r2'::text, 'ALREADY_SETTLED', 'G97 a replay with a different amount cannot repost or alter anything');
select (select (pg_temp.settle(pg_temp.biz_a(), :'t1', pg_temp.v('ESEWA', 'GW-REF-1', 1000, 'GW-REF-1', false, 'FAILED')))->>'settlement_state') as r4 \gset
select is(:'r3'::text, 'ALREADY_SETTLED', 'G98 a replay claiming failure cannot unsettle a settled collection');
select is(:'r4'::text, 'SETTLED', 'G99 the reported settlement state stays SETTLED');
select is((select p.id::text from public.payments p where p.linked_sale_id = pg_temp.sale_id('GW-S1')), :'p1',
          'G100 the replay returns the same persisted payment');
select is((select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('GW-S1')), 1::bigint,
          'G101 three replays wrote no second settlement');
select is((select count(*) from public.journal_entries je
             join public.payments p on p.journal_entry_id = je.id
            where p.linked_sale_id = pg_temp.sale_id('GW-S1')), 1::bigint,
          'G102 and no second journal entry');

-- G103..G107 KHALTI: 250 was already taken by the invoice's embedded upfront row
select (pg_temp.ini(pg_temp.biz_a(), 'KHALTI', 'GW-REF-2', 750, pg_temp.sale_id('GW-S2'), 'S2 customer'))->'gateway_transaction'->>'id' as t2 \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t2', pg_temp.v('KHALTI', 'GW-REF-2', 750, 'GW-REF-2')))->>'outcome' as s2 \gset
select is(:'s2'::text, 'SETTLED', 'G103 the KHALTI collection settles');
select is((select p.amount || '|' || p.payment_method || '|' || p.gateway_transaction_id
             || '|' || (select string_agg(jl.account_name, ',' order by jl.line_no)
                          from public.journal_lines jl where jl.journal_entry_id = p.journal_entry_id)
             from public.payments p
            where p.linked_sale_id = pg_temp.sale_id('GW-S2')
              and p.gateway_transaction_id is not null),
          '750.00|KHALTI|PT-GW-REF-2|Khalti wallet,Accounts receivable',
          'G104 KHALTI settles into the Khalti wallet, and the embedded upfront was counted exactly once');
select is((select round(count(*), 2)::text from public.payments
            where linked_sale_id = pg_temp.sale_id('GW-S2')), '2.00',
          'G105 the invoice now carries its upfront row plus the gateway settlement');
select is((select round(s.total_amount - coalesce(sum(p.amount), 0), 2)
             from public.sales s
             left join public.payments p on p.linked_sale_id = s.id
                and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
            where s.id = pg_temp.sale_id('GW-S2')
            group by s.total_amount), 0.00,
          'G106 reconciliation: 1000 total = 250 upfront + 750 gateway, nothing double-counted');
select is((select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('GW-S2')), 2::bigint,
          'G107 the upfront row was not duplicated or rewritten');

-- G108..G109 a business without wallet accounts falls back to the bank account
select (pg_temp.ini(pg_temp.biz_c(), 'ESEWA', 'GW-REF-C1', 500, pg_temp.sale_id('GW-C1'), 'C1 customer'))->'gateway_transaction'->>'id' as t3 \gset
select (pg_temp.settle(pg_temp.biz_c(), :'t3', pg_temp.v('ESEWA', 'GW-REF-C1', 500, 'GW-REF-C1')))->>'outcome' as s3 \gset
select is(:'s3'::text, 'SETTLED', 'G108 a business with no eSewa wallet account can still collect');
select is((select (select jl.account_name || ':' || jl.debit from public.journal_lines jl
                    where jl.journal_entry_id = p.journal_entry_id and jl.line_no = 1)
             from public.payments p where p.linked_sale_id = pg_temp.sale_id('GW-C1')),
          'Bank account:500.00',
          'G109 ESEWA falls back to 1020 when the wallet account does not exist — AccountLookup.settlement exactly');

-- ---------------------------------------------------------------------------
-- Partial settlements, notes and dates
-- ---------------------------------------------------------------------------
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-5A', 300, pg_temp.sale_id('GW-S5')))->'gateway_transaction'->>'id' as t5a \gset
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-5B', 500, pg_temp.sale_id('GW-S5')))->'gateway_transaction'->>'id' as t5b \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t5a', pg_temp.v('ESEWA', 'GW-REF-5A', 300, 'GW-REF-5A')))->>'outcome' as s5a \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t5b', pg_temp.v('ESEWA', 'GW-REF-5B', 500, 'GW-REF-5B')))->>'outcome' as s5b \gset
select is(:'s5a'::text || '|' || :'s5b'::text, 'SETTLED|SETTLED',
          'G110 two collections can take the balance in two halves');
select is((select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('GW-S5')), 2::bigint,
          'G111 the invoice shows two separate settlements');
select is((select round(s.total_amount - coalesce(sum(p.amount), 0), 2)
             from public.sales s
             left join public.payments p on p.linked_sale_id = s.id
                and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
            where s.id = pg_temp.sale_id('GW-S5')
            group by s.total_amount), 0.00,
          'G112 reconciliation: nothing outstanding after both halves');
select is((select count(*) from (select je.sequence from public.journal_entries je
                                  where je.business_id = pg_temp.biz_a()
                                  group by je.sequence having count(*) > 1) x), 0::bigint,
          'G113 no duplicate journal sequence was minted');

-- G114..G115 a provider transaction id cannot be posted to two settlements
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-3A', 1000, pg_temp.sale_id('GW-S3')))->'gateway_transaction'->>'id' as t6a \gset
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-3B', 1000, pg_temp.sale_id('GW-S3')))->'gateway_transaction'->>'id' as t6b \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t6a', pg_temp.v('ESEWA', 'GW-REF-3A', 1000, 'GW-REF-3A')))->>'outcome' as s6a \gset
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-3B', 1000, 'GW-REF-3B', true, 'COMPLETED', 'NPR', null, 'PT-GW-REF-3A'))$$,
         pg_temp.biz_a(), :'t6b'),
  '23505', NULL,
  'G114 a second settlement cannot claim a provider transaction id that is already posted'
);
select is((select count(*) from public.payments where gateway_transaction_id = 'PT-GW-REF-3A'), 1::bigint,
          'G115 the refused settlement posted nothing');

-- G116..G119 notes and date are decided by the server
select (pg_temp.settle(pg_temp.biz_a(), :'t6b', pg_temp.v('ESEWA', 'GW-REF-3B', 1000, 'GW-REF-3B', true, 'COMPLETED', 'NPR', null, null),
                       (current_date - 3)::date, 'Collected at the counter'))->>'outcome' as s6b \gset
select is(:'s6b'::text, 'SETTLED', 'G116 the same collection settles when the provider id matches the row');
select is((select p.notes || '|' || p.date::text from public.payments p
            where p.linked_sale_id = pg_temp.sale_id('GW-S3') and p.gateway_transaction_id = 'PT-GW-REF-3B'),
          'Collected at the counter|' || (current_date - 3)::text,
          'G117 explicit notes and a past date are honoured');
-- G118..G120 the default note names the provider, and the date rules hold
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-3C', 500, pg_temp.sale_id('GW-S3')))->'gateway_transaction'->>'id' as t6c \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t6c', pg_temp.v('ESEWA', 'GW-REF-3C', 500, 'GW-REF-3C')))->>'outcome' as s6c \gset
select is((select p.notes from public.payments p where p.gateway_transaction_id = 'PT-GW-REF-3C'),
          'ESEWA ref PT-GW-REF-3C',
          'G118 with no note from the caller the server records the provider and its transaction id');
-- A collection of its own: a request for an already settled one replays
-- before the date is ever looked at, which is the point of G96..G99.
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-3D', 200, pg_temp.sale_id('GW-S3')))->'gateway_transaction'->>'id' as t6d \gset
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-3D', 200, 'GW-REF-3D'), current_date + 1)$$,
         pg_temp.biz_a(), :'t6d'),
  '22023', NULL,
  'G119 a future settlement date is refused'
);
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-3D', 200, 'GW-REF-3D'), null, repeat('x', 501))$$,
         pg_temp.biz_a(), :'t6d'),
  '22023', NULL,
  'G120 an absurd note is refused'
);
select (pg_temp.settle(pg_temp.biz_a(), :'t6d', pg_temp.v('ESEWA', 'GW-REF-3D', 200, 'GW-REF-3D')))->>'outcome' as s6d \gset
select is(:'s6d'::text, 'SETTLED', 'G120b the refused requests left the collection settleable');

-- ---------------------------------------------------------------------------
-- Document rules: VOIDED invoices, over-settlement, voids and races in sequence
-- ---------------------------------------------------------------------------
-- G121..G123 a collection against an invoice that is voided afterwards
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-4', 600, pg_temp.sale_id('GW-S4')))->'gateway_transaction'->>'id' as t7 \gset
select public.void_document(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('GW-S4'));
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-4', 600, 'GW-REF-4'))$$,
         pg_temp.biz_a(), :'t7'),
  '22023', NULL,
  'G121 a voided invoice cannot receive money, however the gateway answered'
);
select is((select count(*) from public.payments where gateway_transaction_id = 'PT-GW-REF-4'), 0::bigint,
          'G122 the refused settlement posted nothing');
select is((select g.status from public.gateway_transactions g where g.id = :'t7'), 'INITIATED',
          'G123 the collection itself is untouched by the refusal');

-- G124..G125 over-settlement: two collections initiated, only one may take the balance
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-9A', 150, pg_temp.sale_id('GW-S9')))->'gateway_transaction'->>'id' as t9a \gset
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-9B', 150, pg_temp.sale_id('GW-S9')))->'gateway_transaction'->>'id' as t9b \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t9a', pg_temp.v('ESEWA', 'GW-REF-9A', 150, 'GW-REF-9A')))->>'outcome' as s9a \gset
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-9B', 150, 'GW-REF-9B'))$$,
         pg_temp.biz_a(), :'t9b'),
  '22023', NULL,
  'G124 the second collection of an over-sold balance is refused'
);
select is((select round(s.total_amount - coalesce(sum(p.amount), 0), 2)
             from public.sales s
             left join public.payments p on p.linked_sale_id = s.id
                and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
            where s.id = pg_temp.sale_id('GW-S9')
            group by s.total_amount), 50.00,
          'G125 no negative balance: 50 is still outstanding, exactly what reconciliation says');
-- G126 a collection with nothing left to take cannot be initiated again
select throws_ok(
  format($$select pg_temp.ini('%s'::uuid, 'ESEWA', 'GW-REF-9C', 10, '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S1')),
  '22023', NULL,
  'G126 an invoice with nothing outstanding refuses a new collection'
);

-- G127..G130 the gateway path and the manual path coexist on one invoice
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-7', 100, pg_temp.sale_id('GW-S7')))->'gateway_transaction'->>'id' as t11 \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t11', pg_temp.v('ESEWA', 'GW-REF-7', 100, 'GW-REF-7')))->>'outcome' as s11 \gset
select is(:'s11'::text, 'SETTLED', 'G127 a partial gateway settlement posts');
select (select jsonb_build_object(
          'id', (public.post_payment(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('GW-S7'), 200, 'BANK', null, '', 'the rest', 'k-gw-mix'))->'payment'->>'id')
        )->>'id' as manual_p \gset
select is((select p.payment_method || '|' || (p.gateway_transaction_id is null)::text
             from public.payments p where p.id = :'manual_p'),
          'BANK|true',
          'G128 a manual settlement on the same invoice carries no provider transaction id');
select is((select count(*) from public.payments p where p.linked_sale_id = pg_temp.sale_id('GW-S7')), 2::bigint,
          'G129 both settlements exist side by side');
select is((select round(s.total_amount - coalesce(sum(p.amount), 0), 2)
             from public.sales s
             left join public.payments p on p.linked_sale_id = s.id
                and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
            where s.id = pg_temp.sale_id('GW-S7')
            group by s.total_amount), 0.00,
          'G130 reconciliation counts both paths exactly once');

-- G131..G139 a gateway settlement blocks the invoice void until it is voided itself
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-8', 1000, pg_temp.sale_id('GW-S8')))->'gateway_transaction'->>'id' as t12 \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t12', pg_temp.v('ESEWA', 'GW-REF-8', 1000, 'GW-REF-8')))->>'outcome' as s12 \gset
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'SALE', '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('GW-S8')),
  '22023', NULL,
  'G131 the invoice cannot be voided while a gateway settlement is posted against it'
);
select public.void_payment(pg_temp.biz_a(), (select id from public.payments where gateway_transaction_id = 'PT-GW-REF-8'));
select ok(
  (select payment_id is not null from public.gateway_transactions where id = :'t12'),
  'G132 the collection still points at its settlement after the settlement was voided'
);
select is((select p.doc_status from public.payments p where p.gateway_transaction_id = 'PT-GW-REF-8'),
          'VOIDED', 'G133 the settlement is voided, not deleted');
select (pg_temp.settle(pg_temp.biz_a(), :'t12', pg_temp.v('ESEWA', 'GW-REF-8', 1000, 'GW-REF-8')))->>'settlement_state' as s12b \gset
select is(:'s12b'::text, 'VOIDED',
          'G134 re-settling the same collection reports VOIDED and posts nothing — no revival');
select is((select count(*) from public.payments where gateway_transaction_id = 'PT-GW-REF-8'), 1::bigint,
          'G135 the voided settlement was not replaced by a new one');
select public.void_document(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('GW-S8'));
select is((select status from public.sales where id = pg_temp.sale_id('GW-S8')), 'VOIDED',
          'G136 once the settlement is voided the invoice can be voided too');
select is((select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('GW-S8') and doc_status = 'POSTED'),
          0::bigint, 'G137 nothing settled counts towards a voided invoice');

-- G138..G142 taking the money again needs a NEW collection, and it works
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-6', 400, pg_temp.sale_id('GW-S6')))->'gateway_transaction'->>'id' as t13 \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t13', pg_temp.v('ESEWA', 'GW-REF-6', 400, 'GW-REF-6')))->>'outcome' as s13 \gset
select public.void_payment(pg_temp.biz_a(), (select id from public.payments where gateway_transaction_id = 'PT-GW-REF-6'));
select is((select round(s.total_amount - coalesce(sum(p.amount), 0), 2)
             from public.sales s
             left join public.payments p on p.linked_sale_id = s.id
                and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
            where s.id = pg_temp.sale_id('GW-S6')
            group by s.total_amount), 400.00,
          'G138 voiding a gateway settlement puts the money back as outstanding');
select (pg_temp.ini(pg_temp.biz_a(), 'ESEWA', 'GW-REF-6B', 400, pg_temp.sale_id('GW-S6')))->'gateway_transaction'->>'id' as t13b \gset
select (pg_temp.settle(pg_temp.biz_a(), :'t13b', pg_temp.v('ESEWA', 'GW-REF-6B', 400, 'GW-REF-6B')))->>'outcome' as s13b \gset
select is(:'s13b'::text, 'SETTLED', 'G139 a fresh collection can take the money again');
select is((select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('GW-S6')), 2::bigint,
          'G140 the voided settlement is kept beside the new one — history is preserved');
select is((select round(s.total_amount - coalesce(sum(p.amount), 0), 2)
             from public.sales s
             left join public.payments p on p.linked_sale_id = s.id
                and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
            where s.id = pg_temp.sale_id('GW-S6')
            group by s.total_amount), 0.00,
          'G141 only the live settlement counts');
select is((select count(*) from public.gateway_transactions where linked_sale_id = pg_temp.sale_id('GW-S6')), 2::bigint,
          'G142 two collections are tracked for that invoice, one voided settlement each way');

-- G143..G144 a collection that is not linked to an invoice can never settle
-- (inserted as the database owner: no client role may write this table at all,
--  which G38 already proves)
reset role;
insert into public.gateway_transactions (
  business_id, provider, gateway_ref, amount, currency, status, linked_sale_id, initiated_by
) values (
  pg_temp.biz_a(), 'ESEWA', 'GW-REF-LEGACY', 100, 'NPR', 'INITIATED', null,
  'aa111111-1111-4111-8111-111111111111'
);
set local role authenticated;
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-LEGACY', 100, 'GW-REF-LEGACY'))$$,
         pg_temp.biz_a(), pg_temp.txn_id('GW-REF-LEGACY')),
  '22023', 'This collection is not linked to an invoice, so it has nothing to settle against',
  'G143 a collection with no invoice is refused rather than posted as a loose payment'
);
select is((select count(*) from public.payments where business_id = pg_temp.biz_a() and linked_sale_id is null),
          0::bigint, 'G144 no settlement of this business exists without a document');

-- ---------------------------------------------------------------------------
-- Injected failure: the rollback must leave nothing behind
-- ---------------------------------------------------------------------------
-- G145..G149 business D has no settlement account at all
select (pg_temp.ini(pg_temp.biz_d(), 'ESEWA', 'GW-REF-D1', 100, pg_temp.sale_id('GW-D1'), 'D1 customer'))->'gateway_transaction'->>'id' as t14 \gset
select throws_ok(
  format($$select pg_temp.settle('%s'::uuid, '%s'::uuid, pg_temp.v('ESEWA', 'GW-REF-D1', 100, 'GW-REF-D1'))$$,
         pg_temp.biz_d(), :'t14'),
  '22023', 'Settlement account 1020 is missing from chart of accounts',
  'G145 a settlement that cannot resolve its account fails loudly'
);
select is((select count(*) from public.payments where business_id = pg_temp.biz_d()), 0::bigint,
          'G146 the failed settlement left no payment row behind');
select is((select count(*) from public.journal_entries where business_id = pg_temp.biz_d() and source_type = 'PAYMENT'),
          0::bigint, 'G147 and no journal entry');
select is((select g.status || '|' || (g.payment_id is null)::text || '|' || (g.verified_at is null)::text
             from public.gateway_transactions g where g.id = :'t14'),
          'INITIATED|true|true',
          'G148 and the collection is exactly as it was: unverified, unsettled, INITIATED');
select is((select count(*) from public.journal_lines jl where jl.business_id = pg_temp.biz_d()),
          (select count(*) from public.journal_entries je where je.business_id = pg_temp.biz_d()) * 2,
          'G149 the failed attempt left no orphan journal lines');

-- ---------------------------------------------------------------------------
-- Journal integrity across the whole business
-- ---------------------------------------------------------------------------
-- G150..G153 the business-wide sequence is still a gapless 1..N, every PAYMENT
-- entry belongs to a settlement and balances on its own
select is((select max(je.sequence)::int from public.journal_entries je where je.business_id = pg_temp.biz_a()),
          (select count(*)::int from public.journal_entries je where je.business_id = pg_temp.biz_a()),
          'G150 the journal sequence is still a gapless 1..N for the business');
select is((select count(*) from (
             select je.sequence from public.journal_entries je
              where je.business_id = pg_temp.biz_a()
              group by je.sequence having count(*) > 1) x),
          0::bigint, 'G151 no duplicate sequence exists');
select is((select count(*) from public.journal_entries je
            where je.business_id = pg_temp.biz_a() and je.source_type = 'PAYMENT'
              and not exists (select 1 from public.payments p where p.id = je.source_id and p.journal_entry_id = je.id)),
          0::bigint, 'G152 every PAYMENT entry belongs to the settlement that owns it');
select is((select count(*) from public.journal_entries je
            where je.business_id = pg_temp.biz_a() and je.source_type = 'PAYMENT'
              and (select sum(jl.debit) from public.journal_lines jl where jl.journal_entry_id = je.id)
                  is distinct from
                  (select sum(jl.credit) from public.journal_lines jl where jl.journal_entry_id = je.id)),
          0::bigint, 'G153 every PAYMENT entry balances');
select is((select count(*) from public.payments p where p.business_id = pg_temp.biz_a()
             and p.gateway_transaction_id is not null and p.payment_method not in ('ESEWA', 'KHALTI')),
          0::bigint, 'G154 a gateway-linked settlement always settles through its provider');
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_a()
              and p.gateway_transaction_id is not null
              and (p.idempotency_key is null or p.idempotency_key not like 'gw:%')),
          0::bigint,
          'G155 every gateway-linked settlement carries the deterministic gw:<collection> idempotency key');
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_a()
              and p.idempotency_key like 'gw:%'
              and p.gateway_transaction_id is null),
          0::bigint,
          'G156 and no settlement invents a gw: key without a provider transaction behind it');

reset role;
select * from finish();
rollback;
