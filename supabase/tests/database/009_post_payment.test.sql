-- 009_post_payment.test.sql
-- pgTAP suite for public.post_payment() RPC (migration 009).
-- Run with: supabase test db
--
-- Transactional (begin/rollback): every fixture below is rolled back, so a
-- rerun starts clean. The genuine two-session over-settlement race lives in
-- 011_post_payment_concurrency.test.sql, which has to commit its fixtures.
--
-- Observed model this suite pins down (inspected in 005/006, not inferred):
--   * a sale's or purchase's upfront settlement IS a payments row linked to the
--     document, so `due = total - sum(COMPLETED, POSTED payments)` counts it
--     exactly once and never through the stored upfront_paid column;
--   * that embedded row shares the document's own journal entry (one accounting
--     event), while a post_payment row gets its OWN entry — which is what makes
--     void_document() refuse to void the document afterwards.
--
-- Comment labels name the cases; a case may make more than one assertion.

begin;
create extension if not exists pgtap with schema extensions;

select plan(96);

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
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'aa111111-1111-4111-8111-111111111111',
   'authenticated', 'authenticated', 'pay-alice@zeyks.test', '{"full_name":"Alice"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'bb222222-2222-4222-8222-222222222222',
   'authenticated', 'authenticated', 'pay-bob@zeyks.test', '{"full_name":"Bob"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'cc333333-3333-4333-8333-333333333333',
   'authenticated', 'authenticated', 'pay-carol@zeyks.test', '{"full_name":"Carol"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'dd444444-4444-4444-8444-444444444444',
   'authenticated', 'authenticated', 'pay-dan@zeyks.test', '{"full_name":"Dan"}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.create_business(
  'Payment Business A', 'Alice', '', '', '', '', '', 'NPR', 4::smallint, true, 13::numeric, true
);
reset role;

select pg_temp.act_as('bb222222-2222-4222-8222-222222222222');
set local role authenticated;
select public.create_business('Payment Business B');
reset role;

do $$
declare
  v_biz_a uuid;
begin
  select id into v_biz_a from public.businesses where business_name = 'Payment Business A';

  insert into public.business_memberships (business_id, user_id, role)
  values (v_biz_a, 'cc333333-3333-4333-8333-333333333333', 'VIEWER'),
         (v_biz_a, 'dd444444-4444-4444-8444-444444444444', 'ACCOUNTANT');
end $$;

-- Business C: a synthetic tenant WITHOUT the eSewa/Khalti wallet accounts, so
-- the wallet-fallback rule (ESEWA/KHALTI -> 1020) is reachable at all. The real
-- chart seeds 1040/1050 and accounts cannot be archived or deleted, so the only
-- honest way to test the fallback is a business that never had them.
insert into public.businesses (
  id, created_by, business_name, owner_name, currency_symbol,
  fiscal_year_start_month, vat_registered, vat_rate, track_inventory, timezone
) values (
  'cc000000-0000-4000-8000-0000000000c3', 'aa111111-1111-4111-8111-111111111111',
  'Payment Business C', 'Alice', 'NPR', 4, false, 0, false, 'Asia/Kathmandu'
);

insert into public.business_memberships (business_id, user_id, role)
values ('cc000000-0000-4000-8000-0000000000c3', 'aa111111-1111-4111-8111-111111111111', 'OWNER');

insert into public.accounts (business_id, code, name, type, description, system_account) values
  ('cc000000-0000-4000-8000-0000000000c3', '1010', 'Cash in hand',        'ASSET',     null, true),
  ('cc000000-0000-4000-8000-0000000000c3', '1020', 'Bank account',        'ASSET',     null, true),
  ('cc000000-0000-4000-8000-0000000000c3', '1030', 'Accounts receivable', 'ASSET',     null, true),
  ('cc000000-0000-4000-8000-0000000000c3', '2010', 'Accounts payable',    'LIABILITY', null, true),
  ('cc000000-0000-4000-8000-0000000000c3', '4010', 'Sales revenue',       'REVENUE',   null, true);

create function pg_temp.biz_a() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Payment Business A';
$$;
create function pg_temp.biz_b() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Payment Business B';
$$;
create function pg_temp.biz_c() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Payment Business C';
$$;
create function pg_temp.sale_id(p_invoice text) returns uuid language sql security definer as $$
  select id from public.sales where invoice_number = p_invoice;
$$;
create function pg_temp.purchase_id(p_reference text) returns uuid language sql security definer as $$
  select id from public.purchases where reference_number = p_reference;
$$;
grant execute on function
  pg_temp.biz_a(), pg_temp.biz_b(), pg_temp.biz_c(), pg_temp.sale_id(text), pg_temp.purchase_id(text)
  to authenticated, anon;

-- Thin forwarder so the assertions stay readable. SECURITY INVOKER on purpose:
-- the RPC is still called by the caller's own role and identity, exactly like a
-- direct call from the browser.
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

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;

-- S1: plain credit sale, total 1000
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'S1 customer',
  p_invoice_number := 'PMT-S1', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
);

-- S2: sale whose only settlement so far is its embedded upfront row (250)
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'S2 customer',
  p_invoice_number := 'PMT-S2', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 250, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
);

-- S3: a large sale used for method/reference/key cases (room for many payments)
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'S3 customer',
  p_invoice_number := 'PMT-S3', p_date := current_date - 1,
  p_subtotal := 10000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 10000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":10000,"discount":0,"total":10000}]'::jsonb
);

-- S4: to be voided, after which it must refuse a settlement
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'S4 customer',
  p_invoice_number := 'PMT-S4', p_date := current_date - 1,
  p_subtotal := 600, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 600,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":600,"discount":0,"total":600}]'::jsonb
);

select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'P1 supplier',
  p_reference_number := 'PMT-P1', p_date := current_date - 1,
  p_subtotal := 600, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 600,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":600,"discount":0,"total":600}]'::jsonb,
  p_idempotency_key := 'k-pmt-p1', p_price_includes_vat := false
);

select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'P2 supplier',
  p_reference_number := 'PMT-P2', p_date := current_date - 1,
  p_subtotal := 900, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 900,
  p_upfront_paid := 300, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":900,"discount":0,"total":900}]'::jsonb,
  p_idempotency_key := 'k-pmt-p2', p_price_includes_vat := false
);

select public.post_expense(
  p_business_id := pg_temp.biz_a(),
  p_account_id := (select id from public.accounts where business_id = pg_temp.biz_a() and code = '5020'),
  p_reference := 'PMT-X1', p_date := current_date - 1,
  p_amount := 250, p_tax_amount := 0, p_total_amount := 250, p_payment_method := 'CASH',
  p_description := 'Stationery', p_notes := null, p_idempotency_key := 'k-pmt-x1',
  p_price_includes_vat := false
);

reset role;

-- Bob's document in his own business, for the cross-tenant cases
select pg_temp.act_as('bb222222-2222-4222-8222-222222222222');
set local role authenticated;
select public.post_sale(
  p_business_id := pg_temp.biz_b(), p_customer_id := null, p_customer_name := 'B1 customer',
  p_invoice_number := 'PMT-B1', p_date := current_date - 1,
  p_subtotal := 400, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 400,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":400,"discount":0,"total":400}]'::jsonb
);
reset role;

-- C1 in the synthetic wallet-less business
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.post_sale(
  p_business_id := pg_temp.biz_c(), p_customer_id := null, p_customer_name := 'C1 customer',
  p_invoice_number := 'PMT-C1', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := null, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb
);
reset role;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------
-- C01 a JWT without a subject
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  format($$select public.post_payment('%s'::uuid, 'SALE', '%s'::uuid, 1, 'CASH', current_date, '', null, 'k-noauth')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S1')),
  '28000', NULL,
  'C01 unauthenticated caller is rejected'
);

-- C02 anon cannot execute the RPC at all
set local role anon;
select throws_ok(
  format($$select public.post_payment('%s'::uuid, 'SALE', '%s'::uuid, 1, 'CASH', current_date, '', null, 'k-anon')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S1')),
  '42501', NULL,
  'C02 anon holds no EXECUTE privilege on post_payment'
);
reset role;

-- C03 non-member (Bob's business, Alice calling)
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.post_payment('%s'::uuid, 'SALE', '%s'::uuid, 1, 'CASH', current_date, '', null, 'k-nonmember')$$,
         pg_temp.biz_b(), pg_temp.sale_id('PMT-B1')),
  '42501', NULL,
  'C03 a non-member cannot settle another tenant''s document'
);
reset role;

-- C04 VIEWER (Carol)
select pg_temp.act_as('cc333333-3333-4333-8333-333333333333');
set local role authenticated;
select throws_ok(
  format($$select public.post_payment('%s'::uuid, 'SALE', '%s'::uuid, 1, 'CASH', current_date, '', null, 'k-viewer')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S1')),
  '42501', NULL,
  'C04 a VIEWER cannot post a settlement'
);
reset role;

-- C05 OWNER accepted
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
insert into calls (name, payload)
select 'owner', pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('PMT-S1'), 400,
                            'CASH', current_date - 1, '', 'owner partial', 'k-owner');
select ok((select payload->'payment'->>'id' from calls where name = 'owner') is not null,
          'C05 an OWNER can post a settlement');

-- C06 ACCOUNTANT accepted
select pg_temp.act_as('dd444444-4444-4444-8444-444444444444');
set local role authenticated;
insert into calls (name, payload)
select 'acct', pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('PMT-S1'), 100,
                           'CASH', current_date - 1, '', 'accountant partial', 'k-acct');
select ok((select payload->'payment'->>'id' from calls where name = 'acct') is not null,
          'C06 an ACCOUNTANT can post a settlement');
reset role;

-- ---------------------------------------------------------------------------
-- The INCOMING payment row the server decided, not the client
-- ---------------------------------------------------------------------------
select is(
  (select (payload->'payment'->>'payment_type') || '|' ||
          (payload->'payment'->>'linked_sale_id') || '|' ||
          coalesce(payload->'payment'->>'linked_purchase_id', 'NULL')
     from calls where name = 'owner'),
  'INCOMING|' || pg_temp.sale_id('PMT-S1')::text || '|NULL',
  'C07 direction and link are derived from the document type (INCOMING, linked to the sale, never both)'
);
select is((select payload->'payment'->>'created_by' from calls where name = 'owner'),
          'aa111111-1111-4111-8111-111111111111',
          'C08 created_by is the authenticated caller, never a parameter');
select is((select (payload->'payment'->>'status') || '|' || (payload->'payment'->>'doc_status')
             from calls where name = 'owner'),
          'COMPLETED|POSTED',
          'C09 status and doc_status are server-determined');
select is((select payload->'payment'->>'party_name' from calls where name = 'owner'),
          'S1 customer',
          'C10 party_name comes from the persisted document snapshot');
select is((select payload->'document'->>'id' from calls where name = 'owner'),
          pg_temp.sale_id('PMT-S1')::text,
          'C11 the payload returns the linked document, re-read from the database');
select ok(
  (select payload ? 'payment' and payload ? 'document' and payload ? 'journal_entry' and payload ? 'journal_lines'
     from calls where name = 'owner'),
  'C12 the payload carries payment, document, journal_entry and journal_lines'
);
select is((select jsonb_array_length(payload->'journal_lines') from calls where name = 'owner'),
          2, 'C13 a settlement entry has exactly two lines');
select is(
  (select (l->>'account_id') = (select id::text from public.accounts
                                  where business_id = pg_temp.biz_a() and code = '1010')
          and (l->>'debit')::numeric = 400 and (l->>'credit')::numeric = 0
     from calls, jsonb_array_elements(payload->'journal_lines') l where calls.name = 'owner' and l->>'line_no' = '1'),
  true,
  'C14 INCOMING line 1 debits the settlement account (CASH -> 1010) for the full amount'
);
select is(
  (select l->>'account_name' from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'owner' and l->>'line_no' = '1'),
  'Cash in hand', 'C15 the line snapshot names the settlement account'
);
select is(
  (select (l->>'account_id') = (select id::text from public.accounts
                                  where business_id = pg_temp.biz_a() and code = '1030')
          and (l->>'debit')::numeric = 0 and (l->>'credit')::numeric = 400
     from calls, jsonb_array_elements(payload->'journal_lines') l where calls.name = 'owner' and l->>'line_no' = '2'),
  true,
  'C16 INCOMING line 2 credits Accounts receivable (1030)'
);
select is(
  (select l->>'account_name' from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'owner' and l->>'line_no' = '2'),
  'Accounts receivable', 'C17 the receivable line snapshot is the real account name'
);
select is(
  (select sum((l->>'debit')::numeric) - sum((l->>'credit')::numeric)
     from calls, jsonb_array_elements(payload->'journal_lines') l where calls.name = 'owner'),
  0::numeric, 'C18 the settlement entry balances exactly'
);
select is((select payload->'journal_entry'->>'description' from calls where name = 'owner'),
          'Settlement from S1 customer',
          'C19 the description matches buildPaymentEntry ("Settlement from <party>")');
select is((select payload->'journal_entry'->>'reference' from calls where name = 'owner'),
          (select payload->'payment'->>'reference' from calls where name = 'owner'),
          'C20 the entry reference is the payment reference');
select is((select (payload->'journal_entry'->>'source_type') || '|' ||
                  (payload->'journal_entry'->>'source_id') || '|' ||
                  (payload->'journal_entry'->>'business_id')
             from calls where name = 'owner'),
          'PAYMENT|' || (select payload->'payment'->>'id' from calls where name = 'owner') || '|' ||
          pg_temp.biz_a()::text,
          'C21 the entry is sourced to the payment itself, in the caller''s business');
select is(
  (select count(*) from public.journal_entries je
    where je.source_type = 'PAYMENT'
      and je.source_id = (select (payload->'payment'->>'id')::uuid from calls where name = 'owner')),
  1::bigint, 'C22 exactly one journal entry is written per settlement'
);
select is((select payload->'payment'->>'date' from calls where name = 'owner'),
          (current_date - 1)::text,
          'C23 the payment keeps the date it was given');

-- ---------------------------------------------------------------------------
-- Idempotency: same key + same request replays, same key + changed request conflicts
-- ---------------------------------------------------------------------------
create temp table counts_a as
select (select count(*) from public.payments p where p.business_id = pg_temp.biz_a()) as payments,
       (select count(*) from public.journal_entries e where e.business_id = pg_temp.biz_a()) as entries;

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
insert into calls (name, payload)
select 'owner_replay', pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('PMT-S1'), 400,
                                   'CASH', current_date - 1, '', 'owner partial', 'k-owner');
reset role;

select is((select payload->'payment'->>'id' from calls where name = 'owner_replay'),
          (select payload->'payment'->>'id' from calls where name = 'owner'),
          'C24 an identical retry replays the original payment row');
select is((select payload->'journal_entry'->>'id' from calls where name = 'owner_replay'),
          (select payload->'journal_entry'->>'id' from calls where name = 'owner'),
          'C25 the replay returns the original journal entry, not a new one');
select is((select count(*) from public.payments p where p.business_id = pg_temp.biz_a()),
          (select payments from counts_a), 'C26 the replay wrote no payment row');
select is((select count(*) from public.journal_entries e where e.business_id = pg_temp.biz_a()),
          (select entries from counts_a), 'C27 the replay wrote no journal entry');
select is((select payload->'payment'->>'reference' from calls where name = 'owner_replay'),
          (select payload->'payment'->>'reference' from calls where name = 'owner'),
          'C28 the replay does not reallocate the reference');
select is((select count(*) from public.payments where business_id = pg_temp.biz_a()
             and idempotency_key = 'k-owner'),
          1::bigint, 'C29 the key exists exactly once, enforced by a partial unique index');

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 401, 'CASH', current_date - 1, '', 'owner partial', 'k-owner')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S1')),
  '23505', NULL, 'C30 the same key with a different AMOUNT conflicts');
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 400, 'BANK', current_date - 1, '', 'owner partial', 'k-owner')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S1')),
  '23505', NULL, 'C31 the same key with a different METHOD conflicts');
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 400, 'CASH', current_date - 2, '', 'owner partial', 'k-owner')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S1')),
  '23505', NULL, 'C32 the same key with a different DATE conflicts');
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 400, 'CASH', current_date - 1, '', 'different note', 'k-owner')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S1')),
  '23505', NULL, 'C33 the same key with different NOTES conflicts');
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 400, 'CASH', current_date - 1, 'PMT-OTHER', 'owner partial', 'k-owner')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S1')),
  '23505', NULL, 'C34 the same key with a different REQUESTED REFERENCE conflicts');
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 400, 'CASH', current_date - 1, '', 'owner partial', 'k-owner')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S3')),
  '23505', NULL, 'C35 the same key against a DIFFERENT DOCUMENT conflicts');
reset role;

select is(
  (select (p.idempotency_key) || '|' || coalesce(p.requested_reference, 'NULL')
     from public.payments p where p.business_id = pg_temp.biz_a() and p.idempotency_key = 'k-owner'),
  'k-owner|NULL',
  'C36 the stored key is exactly what was sent, and the requested reference records that none was asked for'
);

-- ---------------------------------------------------------------------------
-- The embedded upfront settlement is counted exactly once (sale)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 751, 'CASH', current_date - 1, '', null, 'k-s2-over')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S2')),
  '22023', NULL,
  'C37 751 is rejected: due is 750 because the 250 upfront row is already settled money'
);
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 750.005, 'CASH', current_date - 1, '', null, 'k-s2-dp')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S2')),
  '22023', NULL,
  'C38 the 0.005 tolerance cannot be crossed by a 3-decimal amount: numeric(14,2) is enforced first'
);
insert into calls (name, payload)
select 's2_full', pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('PMT-S2'), 750,
                              'CASH', current_date - 1, '', null, 'k-s2-full');
reset role;

select ok((select payload->'payment'->>'id' from calls where name = 's2_full') is not null,
          'C39 the exact outstanding balance of 750 is accepted and fills the document');
select is((select count(*) from public.payments p where p.linked_sale_id = pg_temp.sale_id('PMT-S2')),
          2::bigint, 'C40 the sale now has exactly two settlement rows: the embedded upfront and this one');
select is((select sum(p.amount) from public.payments p where p.linked_sale_id = pg_temp.sale_id('PMT-S2')),
          1000::numeric, 'C41 the two settlements add up to the total: the upfront is counted exactly once');
select is(
  (select (p.amount) || '|' || (p.journal_entry_id = s.journal_entry_id)::text
     from public.payments p join public.sales s on s.id = p.linked_sale_id
    where s.invoice_number = 'PMT-S2' and p.reference = 'REC-PMT-S2'),
  '250.00|true',
  'C42 the embedded row is untouched and still shares the sale''s own journal entry (one accounting event)'
);

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 0.01, 'CASH', current_date - 1, '', null, 'k-s2-after')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S2')),
  '22023', NULL, 'C43 a fully settled document refuses another settlement'
);
reset role;

select is(
  (select case when sum(p.amount) >= 1000 - 0.005 then 'PAID' else 'PARTIALLY_PAID' end
     from public.payments p
    where p.linked_sale_id = pg_temp.sale_id('PMT-S2') and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
  'PAID',
  'C44 reconcile-style derivation from persisted settlements reports PAID'
);

-- ---------------------------------------------------------------------------
-- OUTGOING: money paid to a supplier against a purchase
-- ---------------------------------------------------------------------------
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
insert into calls (name, payload)
select 'p1_partial', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PMT-P1'), 200,
                                 'BANK', current_date - 1, '', 'supplier part payment', 'k-p1-1');
select ok((select payload->'payment'->>'id' from calls where name = 'p1_partial') is not null,
          'C45 a partial payment against a purchase is accepted');
reset role;

select is(
  (select (payload->'payment'->>'payment_type') || '|' ||
          coalesce(payload->'payment'->>'linked_sale_id', 'NULL') || '|' ||
          (payload->'payment'->>'linked_purchase_id')
     from calls where name = 'p1_partial'),
  'OUTGOING|NULL|' || pg_temp.purchase_id('PMT-P1')::text,
  'C46 a purchase settlement is OUTGOING and linked to the purchase only'
);
select is(
  (select (l->>'account_id') = (select id::text from public.accounts
                                  where business_id = pg_temp.biz_a() and code = '2010')
          and (l->>'debit')::numeric = 200 and (l->>'credit')::numeric = 0
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'p1_partial' and l->>'line_no' = '1'),
  true, 'C47 OUTGOING line 1 debits Accounts payable (2010)'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'debit')::numeric || '|' || (l->>'credit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'p1_partial' and l->>'line_no' = '2'),
  'Bank account|0.00|200.00',
  'C48 OUTGOING line 2 credits the settlement account (BANK -> 1020)'
);
select is(
  (select sum((l->>'debit')::numeric) - sum((l->>'credit')::numeric)
     from calls, jsonb_array_elements(payload->'journal_lines') l where calls.name = 'p1_partial'),
  0::numeric, 'C49 the purchase settlement entry balances'
);
select is((select payload->'journal_entry'->>'description' from calls where name = 'p1_partial'),
          'Settlement to P1 supplier',
          'C50 the OUTGOING description is "Settlement to <party>"');

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
insert into calls (name, payload)
select 'p1_final', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PMT-P1'), 400,
                               'BANK', current_date - 1, '', 'final payment', 'k-p1-2');
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'PURCHASE', '%s'::uuid, 0.01, 'BANK', current_date - 1, '', null, 'k-p1-after')$$,
         pg_temp.biz_a(), pg_temp.purchase_id('PMT-P1')),
  '22023', NULL, 'C51 a settled purchase refuses another settlement'
);
reset role;

select is((select sum(p.amount) from public.payments p where p.linked_purchase_id = pg_temp.purchase_id('PMT-P1')),
          600::numeric, 'C52 two instalments add up to the purchase total');
select is((select count(*) from public.payments p where p.linked_purchase_id = pg_temp.purchase_id('PMT-P1')),
          2::bigint, 'C53 no extra settlement row is created by the final payment');
select is(
  (select count(*)
     from public.journal_entries je
     join public.payments p on p.journal_entry_id = je.id
    where p.linked_purchase_id = pg_temp.purchase_id('PMT-P1') and je.source_type = 'PAYMENT'),
  2::bigint, 'C54 each purchase settlement owns exactly one PAYMENT journal entry'
);

-- ---------------------------------------------------------------------------
-- The embedded upfront settlement is counted exactly once (purchase)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'PURCHASE', '%s'::uuid, 601, 'CASH', current_date - 1, '', null, 'k-p2-over')$$,
         pg_temp.biz_a(), pg_temp.purchase_id('PMT-P2')),
  '22023', NULL,
  'C55 601 is rejected: due is 600 because the 300 upfront row is already settled money'
);
insert into calls (name, payload)
select 'p2_full', pg_temp.pay(pg_temp.biz_a(), 'PURCHASE', pg_temp.purchase_id('PMT-P2'), 600,
                              'CASH', current_date - 1, '', null, 'k-p2-full');
reset role;

select is((select sum(p.amount) from public.payments p where p.linked_purchase_id = pg_temp.purchase_id('PMT-P2')),
          900::numeric, 'C56 the purchase''s upfront and the posted payment add up to the total, once each');
select is(
  (select (p.amount) || '|' || (p.journal_entry_id = x.journal_entry_id)::text
     from public.payments p join public.purchases x on x.id = p.linked_purchase_id
    where x.reference_number = 'PMT-P2' and p.reference = 'PAY-PMT-P2'),
  '300.00|true',
  'C57 the embedded purchase settlement still shares the purchase''s own journal entry'
);
select is((select count(*) from public.payments p where p.linked_purchase_id = pg_temp.purchase_id('PMT-P2')),
          2::bigint, 'C58 no duplicate settlement row was created for the embedded upfront'
);

-- ---------------------------------------------------------------------------
-- Settlement mapping, including the wallet fallback
-- ---------------------------------------------------------------------------
select is((select count(*) from public.accounts
            where business_id = pg_temp.biz_c() and code in ('1040', '1050')),
          0::bigint,
          'C59 setup: the synthetic business really has no eSewa/Khalti accounts, so the fallback is reachable');

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
insert into calls (name, payload)
select 's3_esewa', pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('PMT-S3'), 100,
                               'ESEWA', current_date - 1, '', 'esewa wallet', 'k-s3-1');
insert into calls (name, payload)
select 's3_khalti', pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('PMT-S3'), 50,
                                'KHALTI', current_date - 1, '', 'khalti wallet', 'k-s3-2');
insert into calls (name, payload)
select 'c_esewa', pg_temp.pay(pg_temp.biz_c(), 'SALE', pg_temp.sale_id('PMT-C1'), 100,
                              'ESEWA', current_date - 1, '', 'esewa fallback', 'k-c-1');
insert into calls (name, payload)
select 'c_khalti', pg_temp.pay(pg_temp.biz_c(), 'SALE', pg_temp.sale_id('PMT-C1'), 50,
                               'KHALTI', current_date - 1, '', 'khalti fallback', 'k-c-2');
reset role;

select is(
  (select (l->>'account_name') || '|' || (l->>'debit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 's3_esewa' and l->>'line_no' = '1'),
  'eSewa wallet|100.00', 'C60 ESEWA uses the wallet account 1040 when it is active'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'debit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 's3_khalti' and l->>'line_no' = '1'),
  'Khalti wallet|50.00', 'C61 KHALTI uses the wallet account 1050 when it is active'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'debit')::numeric || '|' ||
          (select count(*) from public.accounts where business_id = (l->>'business_id')::uuid and code = '1040')
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'c_esewa' and l->>'line_no' = '1'),
  'Bank account|100.00|0',
  'C62 ESEWA falls back to the bank account when the business has no eSewa wallet'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'debit')::numeric || '|' ||
          (select count(*) from public.accounts where business_id = (l->>'business_id')::uuid and code = '1050')
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'c_khalti' and l->>'line_no' = '1'),
  'Bank account|50.00|0',
  'C63 KHALTI falls back to the bank account when the business has no Khalti wallet'
);

-- ---------------------------------------------------------------------------
-- References: the caller's number is kept, blank means server allocation
-- ---------------------------------------------------------------------------
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
insert into calls (name, payload)
select 's3_ref', pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('PMT-S3'), 200,
                             'CASH', current_date - 1, 'PMT-REF-1', 'explicit reference', 'k-s3-3');
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 10, 'CASH', current_date - 1, 'PMT-REF-1', null, 'k-s3-dup')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S3')),
  '23505', NULL, 'C64 a duplicate explicit reference is rejected by the database contract'
);
insert into calls (name, payload)
select 's3_blank', pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('PMT-S3'), 300,
                               'CASH', current_date - 1, '', 'allocated reference', 'k-s3-5');
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 10, 'CASH', current_date - 1, %L, null, 'k-s3-long')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S3'), repeat('R', 101)),
  '22023', NULL, 'C65 an over-long reference is rejected'
);
reset role;

select is((select payload->'payment'->>'reference' from calls where name = 's3_ref'),
          'PMT-REF-1', 'C66 the caller''s reference is kept as sent');
select is((select payload->'payment'->>'requested_reference' from calls where name = 's3_ref'),
          'PMT-REF-1', 'C67 the requested reference is stored for the fingerprint');
select ok(
  (select payload->'payment'->>'reference' ~ ('^RCP-' || to_char(current_date - 1, 'YYYYMMDD') || '-[0-9]{3}$')
     from calls where name = 's3_blank'),
  'C68 a blank reference is allocated server-side as RCP-YYYYMMDD-NNN, the referenceGenerator format'
);
select is((select payload->'payment'->>'requested_reference' from calls where name = 's3_blank'),
          NULL, 'C69 a blank reference is stored as "no requested reference", not as the allocated one'
);

-- ---------------------------------------------------------------------------
-- Idempotency key conventions
-- ---------------------------------------------------------------------------
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
insert into calls (name, payload)
select 's3_nokey_1', pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('PMT-S3'), 300,
                                 'CASH', current_date - 1, '', 'no key', null);
insert into calls (name, payload)
select 's3_nokey_2', pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('PMT-S3'), 300,
                                 'CASH', current_date - 1, '', 'no key', null);
insert into calls (name, payload)
select 's3_ws', pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('PMT-S3'), 25,
                            'CASH', current_date - 1, '', 'whitespace key', '   ');
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 10, 'CASH', current_date - 1, '', null, %L)$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S3'), repeat('K', 201)),
  '22023', NULL, 'C70 an over-long idempotency key is rejected'
);
reset role;

select is((select count(*) from public.payments
            where business_id = pg_temp.biz_a() and notes = 'no key'),
          2::bigint,
          'C71 a blank key means "no key": two identical posts are two settlements, not a replay'
);
select is((select p.idempotency_key is null from public.payments p
            where p.business_id = pg_temp.biz_a() and p.notes = 'whitespace key'),
          true, 'C72 a whitespace-only key is normalised to no key at all'
);

-- ---------------------------------------------------------------------------
-- Input validation
-- ---------------------------------------------------------------------------
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 0, 'CASH', current_date - 1, '', null, 'k-m')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S3')),
  '22023', NULL, 'C73 a zero amount is rejected'
);
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, -5, 'CASH', current_date - 1, '', null, 'k-m')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S3')),
  '22023', NULL, 'C74 a negative amount is rejected'
);
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 5, 'PAYPAL', current_date - 1, '', null, 'k-m')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S3')),
  '22023', NULL, 'C75 an unknown payment method is rejected'
);
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 5, 'CASH', current_date + 5, '', null, 'k-m')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S3')),
  '22023', NULL, 'C76 a future settlement date is rejected against the business timezone'
);
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 10000000000000, 'CASH', current_date - 1, '', null, 'k-m')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S3')),
  '22023', NULL, 'C77 an amount numeric(14,2) cannot hold is rejected rather than truncated'
);
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'EXPENSE', '%s'::uuid, 5, 'CASH', current_date - 1, '', null, 'k-m')$$,
         pg_temp.biz_a(), (select id from public.expenses where reference = 'PMT-X1')),
  '22023', NULL, 'C78 expenses cannot be settled: they are paid when they are posted'
);
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '00000000-0000-4000-8000-000000000000'::uuid, 5, 'CASH', current_date - 1, '', null, 'k-m')$$,
         pg_temp.biz_a()),
  '22023', NULL, 'C79 a document that does not exist is rejected'
);
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 5, 'CASH', current_date - 1, '', null, 'k-m')$$,
         pg_temp.biz_a(), pg_temp.purchase_id('PMT-P1')),
  '22023', NULL, 'C80 the wrong document type for an id is rejected (a purchase id is not a sale)'
);
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 5, 'CASH', current_date - 1, '', null, 'k-m')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-B1')),
  '22023', NULL, 'C81 another tenant''s document never resolves, whatever its type'
);
reset role;

select is((select count(*) from public.payments p
            where p.linked_sale_id is null and p.linked_purchase_id is null
              and p.business_id = pg_temp.biz_a()),
          0::bigint, 'C82 no settlement row exists without a document link (not even for the expense)'
);
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_b() and p.linked_sale_id = pg_temp.sale_id('PMT-B1')),
          0::bigint,
          'C83 the cross-tenant attempt wrote nothing at all'
);

-- ---------------------------------------------------------------------------
-- A voided document cannot be settled
-- ---------------------------------------------------------------------------
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.void_document(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('PMT-S4'));
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 100, 'CASH', current_date - 1, '', null, 'k-s4')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S4')),
  '22023', NULL, 'C84 a voided document refuses a settlement'
);
reset role;

select is((select count(*) from public.payments p where p.linked_sale_id = pg_temp.sale_id('PMT-S4')),
          0::bigint, 'C85 the refused settlement wrote nothing');

-- ---------------------------------------------------------------------------
-- Atomicity: a failure while the payment row is written rolls back everything
-- ---------------------------------------------------------------------------
create temp table snap_a as
select (select count(*) from public.payments p where p.business_id = pg_temp.biz_a()) as payments,
       (select count(*) from public.journal_entries e where e.business_id = pg_temp.biz_a()) as entries,
       (select count(*) from public.journal_lines l where l.business_id = pg_temp.biz_a()) as lines;

create function pg_temp.payments_inject() returns trigger
language plpgsql as $$
begin
  if new.notes = 'inject-failure' then
    raise exception 'injected failure: the settlement row could not be written' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger payments_inject before insert on public.payments
  for each row execute function pg_temp.payments_inject();

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select pg_temp.pay('%s'::uuid, 'SALE', '%s'::uuid, 50, 'CASH', current_date - 1, 'PMT-INJECT', 'inject-failure', 'k-inject')$$,
         pg_temp.biz_a(), pg_temp.sale_id('PMT-S3')),
  '23514', NULL,
  'C86 an injected failure after the journal entry was written aborts the whole settlement'
);
reset role;
drop trigger payments_inject on public.payments;

select is((select count(*) from public.payments p where p.business_id = pg_temp.biz_a()),
          (select payments from snap_a), 'C87 no payment row was committed');
select is((select count(*) from public.journal_entries e where e.business_id = pg_temp.biz_a()),
          (select entries from snap_a), 'C88 no settlement journal entry was committed');
select is((select count(*) from public.journal_lines l where l.business_id = pg_temp.biz_a()),
          (select lines from snap_a), 'C89 no journal line was committed');
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_a() and p.reference = 'PMT-INJECT'),
          0::bigint, 'C90 the failed attempt left no trace of its reference either');

-- ---------------------------------------------------------------------------
-- Reload: the persisted rows are what the browser will read back
-- ---------------------------------------------------------------------------
select is(
  (select p.amount || '|' || p.payment_method || '|' || p.date || '|' || p.notes || '|' ||
          p.status || '|' || p.doc_status
     from public.payments p where p.business_id = pg_temp.biz_a() and p.idempotency_key = 'k-owner'),
  '400.00|CASH|' || (current_date - 1)::text || '|owner partial|COMPLETED|POSTED',
  'C91 the persisted payment round-trips exactly as posted'
);
select is(
  (select sum(p.amount) || '|' ||
          case when sum(p.amount) >= 1000 - 0.005 then 'PAID' else 'PARTIALLY_PAID' end
     from public.payments p
    where p.linked_sale_id = pg_temp.sale_id('PMT-S1')
      and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
  '500.00|PARTIALLY_PAID',
  'C92 reconcile()''s derivation over the reloaded rows gives 500 of 1000, PARTIALLY_PAID'
);
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_a()
              and not exists (select 1 from public.journal_entries je where je.id = p.journal_entry_id)),
          0::bigint, 'C93 every settlement points at a journal entry that exists');
select is(
  (select count(*) from (
     select je.id from public.journal_entries je
       join public.journal_lines l on l.journal_entry_id = je.id
      where je.business_id = pg_temp.biz_a()
      group by je.id
     having sum(l.debit) <> sum(l.credit)) x),
  0::bigint, 'C94 no entry in the business is left unbalanced by these settlements'
);
select is(
  (select count(*) from (
     select je.sequence from public.journal_entries je
      where je.business_id = pg_temp.biz_a()
      group by je.sequence having count(*) > 1) x),
  0::bigint, 'C95 the settlement entries did not collide on a journal sequence'
);
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_a()
              and (p.status <> 'COMPLETED' or p.doc_status <> 'POSTED')),
          0::bigint, 'C96 every settlement the RPC wrote is COMPLETED and POSTED');
select * from finish();
rollback;
