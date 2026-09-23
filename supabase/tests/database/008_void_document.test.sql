-- 008_void_document.test.sql
-- pgTAP test suite for public.void_document() RPC (migration 008).
-- Run with: supabase test db
--
-- Observed model this suite pins down (inspected in 005/006, not inferred):
--   * a sale's or purchase's upfront settlement row shares the document's own
--     journal_entry_id, so one mirror reversal reverses both;
--   * there is no post_payment RPC yet, so the "separately posted completed
--     settlement blocks the void" rule is exercised with hand-built rows;
--   * document.journal_entry_id is NOT NULL + unique + FK and journal entries
--     can never be deleted, so a missing-entry state is unrepresentable; the
--     source relationship is instead validated against source_type/source_id.
--
-- Comment labels name the cases; a case may make more than one assertion.

begin;
create extension if not exists pgtap with schema extensions;

select plan(58);

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
-- Business A is VAT registered and tracks inventory.
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
select public.create_business(
  'Void Business A', '', '', '', '', '', '', 'NPR', 4::smallint, true, 13::numeric, true
);
reset role;

select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
set local role authenticated;
select public.create_business('Void Business B');
reset role;

do $$
declare
  v_biz_a uuid;
  v_biz_b uuid;
begin
  select id into v_biz_a from public.businesses where business_name = 'Void Business A';
  select id into v_biz_b from public.businesses where business_name = 'Void Business B';

  insert into public.business_memberships (business_id, user_id, role)
  values (v_biz_a, 'c3333333-3333-4333-8333-333333333333', 'VIEWER'),
         (v_biz_a, 'd4444444-4444-4444-8444-444444444444', 'ACCOUNTANT');
end $$;

create function pg_temp.biz_a() returns uuid language sql security definer as $$
  select id from public.businesses
   where created_by = 'a1111111-1111-4111-8111-111111111111' limit 1;
$$;
create function pg_temp.biz_b() returns uuid language sql security definer as $$
  select id from public.businesses
   where created_by = 'b2222222-2222-4222-8222-222222222222' limit 1;
$$;
create function pg_temp.sale_id(p_invoice text) returns uuid language sql security definer as $$
  select id from public.sales where invoice_number = p_invoice limit 1;
$$;
grant execute on function pg_temp.biz_a() to authenticated, anon;
grant execute on function pg_temp.biz_b() to authenticated, anon;
grant execute on function pg_temp.sale_id(text) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Documents to void, all posted by Alice
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

-- D1: VAT sale with an embedded upfront settlement (4 journal lines)
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Walk-in',
  p_invoice_number := 'INV-D1', p_date := '2026-01-05',
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 130, p_total_amount := 1130,
  p_upfront_paid := 400, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
)->'sale'->>'id';

-- D2: sale with NO upfront, to be given a separately posted settlement
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Walk-in',
  p_invoice_number := 'INV-D2', p_date := '2026-01-06',
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb
)->'sale'->>'id';

-- D3: VAT purchase with an embedded upfront settlement and inventory tracking
select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Vendor D3',
  p_reference_number := 'PO-D3', p_date := '2026-01-07',
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 130, p_total_amount := 1130,
  p_upfront_paid := 500, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
  p_idempotency_key := 'k-po-d3', p_price_includes_vat := false
)->'purchase'->>'id';

-- D4: purchase with NO upfront, to be given a separately posted settlement
select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Vendor D4',
  p_reference_number := 'PO-D4', p_date := '2026-01-08',
  p_subtotal := 300, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 300,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":300,"discount":0,"total":300}]'::jsonb,
  p_idempotency_key := 'k-po-d4', p_price_includes_vat := false
)->'purchase'->>'id';

-- D5: expense (two journal lines)
select public.post_expense(
  p_business_id := pg_temp.biz_a(),
  p_account_id := (select id from public.accounts where business_id = pg_temp.biz_a() and code = '5020'),
  p_reference := 'EXP-D5', p_date := '2026-01-09',
  p_amount := 250, p_tax_amount := 0, p_total_amount := 250, p_payment_method := 'CASH',
  p_description := 'Stationery', p_notes := null, p_idempotency_key := 'k-exp-d5',
  p_price_includes_vat := false
)->'expense'->>'id';

-- D6: sale with an embedded upfront settlement, used for the atomicity probe
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Walk-in',
  p_invoice_number := 'INV-D6', p_date := '2026-01-10',
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 300, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb
)->'sale'->>'id';
reset role;

-- A snapshot of D1's original entry, to prove nothing else about it changes.
create temp table d1_before as
  select (to_jsonb(je) - 'reversed_by_entry_id') as snapshot
    from public.journal_entries je
   where je.id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1');
grant select on d1_before to authenticated;

-- Separate, hand-built settlements: their own journal entry, so they are
-- distinct accounting events that must block the void.
do $$
declare
  v_biz   uuid := pg_temp.biz_a();
  v_alice uuid := 'a1111111-1111-4111-8111-111111111111';
  v_sale  uuid;
  v_pur   uuid;
  v_entry uuid;
  v_cash  uuid;
  v_recv  uuid;
  v_pay   uuid;
  v_payment_id uuid;
begin
  select id into v_cash from public.accounts where business_id = v_biz and code = '1010';
  select id into v_recv from public.accounts where business_id = v_biz and code = '1030';
  select id into v_pay  from public.accounts where business_id = v_biz and code = '2010';

  -- A completed settlement against sale D2.
  -- Stage 20 (016) makes the settlement <-> journal relationship unambiguous:
  -- a PAYMENT entry must name the settlement it belongs to, so the fixture
  -- generates the settlement id FIRST and writes it on the entry. The shape is
  -- now the shape post_payment itself writes; a mis-linked row would be refused
  -- by the database, which is what 026_settlement_integrity.test.sql proves.
  select id into v_sale from public.sales where invoice_number = 'INV-D2';
  v_entry := gen_random_uuid();
  v_payment_id := gen_random_uuid();
  insert into public.journal_entries (id, business_id, transaction_date, sequence, description, reference, source_type, source_id, created_by)
  values (v_entry, v_biz, '2026-02-01',
          (select coalesce(max(sequence), 0) + 1 from public.journal_entries where business_id = v_biz),
          'Separate settlement', 'PAY-D2', 'PAYMENT', v_payment_id, v_alice);
  insert into public.journal_lines (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
  values (v_biz, v_entry, 1, v_cash, 'Cash in hand', 'ASSET', 200, 0),
         (v_biz, v_entry, 2, v_recv, 'Accounts receivable', 'ASSET', 0, 200);
  insert into public.payments (id, business_id, reference, date, amount, payment_method, status, payment_type, linked_sale_id, party_name, doc_status, notes, journal_entry_id, created_by)
  values (v_payment_id, v_biz, 'PAY-D2', '2026-02-01', 200, 'CASH', 'COMPLETED', 'INCOMING', v_sale, 'Walk-in', 'POSTED', null, v_entry, v_alice);

  -- A completed settlement against purchase D4, the same valid shape.
  select id into v_pur from public.purchases where reference_number = 'PO-D4';
  v_entry := gen_random_uuid();
  v_payment_id := gen_random_uuid();
  insert into public.journal_entries (id, business_id, transaction_date, sequence, description, reference, source_type, source_id, created_by)
  values (v_entry, v_biz, '2026-02-02',
          (select coalesce(max(sequence), 0) + 1 from public.journal_entries where business_id = v_biz),
          'Separate settlement', 'PAY-D4', 'PAYMENT', v_payment_id, v_alice);
  insert into public.journal_lines (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
  values (v_biz, v_entry, 1, v_pay, 'Accounts payable', 'LIABILITY', 200, 0),
         (v_biz, v_entry, 2, v_cash, 'Cash in hand', 'ASSET', 0, 200);
  insert into public.payments (id, business_id, reference, date, amount, payment_method, status, payment_type, linked_purchase_id, party_name, doc_status, notes, journal_entry_id, created_by)
  values (v_payment_id, v_biz, 'PAY-D4', '2026-02-02', 200, 'CASH', 'COMPLETED', 'OUTGOING', v_pur, 'Vendor D4', 'POSTED', null, v_entry, v_alice);
end $$;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------
-- 01 anon cannot execute at all
set local role anon;
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'SALE', '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('INV-D1')),
  '42501', NULL,
  'anon cannot call void_document'
);
reset role;

-- 02 a JWT without a subject
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'SALE', '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('INV-D1')),
  '28000', NULL,
  'a caller without auth.uid() is rejected'
);
reset role;

-- 03 non-member (Bob) is rejected
select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'SALE', '%s'::uuid)$$,
         pg_temp.biz_a(), pg_temp.sale_id('INV-D1')),
  '42501', NULL,
  'a non-member cannot void Business A documents'
);
reset role;

-- 04 VIEWER (Carol) is rejected, and D1 is left POSTED
select pg_temp.act_as('c3333333-3333-4333-8333-333333333333');
set local role authenticated;
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'SALE', '%s'::uuid)$$,
         pg_temp.biz_a(), (select id from public.sales where invoice_number = 'INV-D1')),
  '42501', NULL,
  'a VIEWER cannot void a document'
);

-- ---------------------------------------------------------------------------
-- Void the VAT sale with its embedded settlement (OWNER)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');

-- 05 OWNER can void, and the payload carries the persisted rows
select isnt(
  (select (public.void_document(
    pg_temp.biz_a(), 'SALE', (select id from public.sales where invoice_number = 'INV-D1')
  )->'reversal_journal_entry'->>'id')),
  NULL,
  'an OWNER can void a sale and gets the reversal entry back'
);

-- 06 the reversal is a REVERSAL entry pointing at the original
select is(
  (select je.source_type from public.journal_entries je
    where je.id = (select reversed_by_entry_id from public.journal_entries
                    where id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1'))),
  'REVERSAL',
  'the reversal entry has source_type REVERSAL'
);

-- 07 the original entry links back to the reversal
select is(
  (select (je.reversed_by_entry_id = r.id)
     from public.journal_entries je
     join public.journal_entries r on r.id = je.reversed_by_entry_id
    where je.id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1')),
  true,
  'the original journal entry points at the reversal that reverses it'
);

-- 08 the document is VOIDED, not deleted
select is(
  (select count(*) from public.sales where invoice_number = 'INV-D1' and status = 'VOIDED')::int,
  1,
  'the sale row is kept and marked VOIDED'
);

-- 09 the reversal reference is derived from the original
select is(
  (select r.reference
     from public.journal_entries r
     join public.journal_entries je on je.reversed_by_entry_id = r.id
    where je.id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1')),
  'REV-INV-D1',
  'the reversal reference is REV-<original reference>'
);

-- 10 the reversal keeps the document as its source
select is(
  (select r.source_id = s.id
     from public.journal_entries r
     join public.sales s on s.journal_entry_id = r.reverses_entry_id
    where s.invoice_number = 'INV-D1'),
  true,
  'the reversal carries the same source_id as the original'
);

-- 11 the reversal is attributable to the caller
select is(
  (select r.created_by
     from public.journal_entries r
     join public.journal_entries je on je.reversed_by_entry_id = r.id
    where je.id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1')),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'the reversal is created by the caller from auth.uid()'
);

-- 12 the reversal is dated today in the business timezone
select is(
  (select r.transaction_date
     from public.journal_entries r
     join public.journal_entries je on je.reversed_by_entry_id = r.id
    where je.id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1')),
  (now() at time zone 'Asia/Kathmandu')::date,
  'the reversal is dated today in the business timezone'
);

-- 13 the original entry is untouched apart from the one-way link
select is(
  (select (to_jsonb(je) - 'reversed_by_entry_id')
     from public.journal_entries je
    where je.id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1')),
  (select snapshot from d1_before),
  'the original entry is immutable apart from reversed_by_entry_id'
);

-- ---------------------------------------------------------------------------
-- Exact mirror accounting for the sale (VAT, receivable, embedded settlement)
-- ---------------------------------------------------------------------------
-- 14 original journal
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1')),
  '1010:400:0, 1030:730:0, 4010:0:1000, 2020:0:130',
  'the VAT sale posted cash, receivable, sales and VAT payable'
);

-- 15 the reversal is the exact mirror
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select reversed_by_entry_id from public.journal_entries
                                  where id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1'))),
  '1010:0:400, 1030:0:730, 4010:1000:0, 2020:130:0',
  'every original debit becomes a credit and vice versa'
);

-- 16 same number of lines
select is(
  (select count(*) from public.journal_lines
    where journal_entry_id = (select reversed_by_entry_id from public.journal_entries
                               where id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1')))::int,
  (select count(*) from public.journal_lines
    where journal_entry_id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1'))::int,
  'the reversal has exactly as many lines as the original'
);

-- 17 line numbers and ordering are preserved
select is(
  (select array_agg(line_no order by line_no) from public.journal_lines
    where journal_entry_id = (select reversed_by_entry_id from public.journal_entries
                               where id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1'))),
  '{1,2,3,4}'::smallint[],
  'line numbers are preserved in the mirror'
);

-- 18 account snapshots are preserved
select is(
  (select string_agg(jl.account_name || ':' || jl.account_type, ', ' order by jl.line_no)
     from public.journal_lines jl
    where jl.journal_entry_id = (select reversed_by_entry_id from public.journal_entries
                                  where id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1'))),
  (select string_agg(jl.account_name || ':' || jl.account_type, ', ' order by jl.line_no)
     from public.journal_lines jl
    where jl.journal_entry_id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1')),
  'account name and type snapshots are copied, not recomputed'
);

-- 19 the reversal balances
select is(
  (select (sum(jl.debit) = sum(jl.credit))::text || ':' || round(sum(jl.debit), 0)::text
     from public.journal_lines jl
    where jl.journal_entry_id = (select reversed_by_entry_id from public.journal_entries
                                  where id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1'))),
  'true:1130',
  'the reversal balances to the original total'
);

-- ---------------------------------------------------------------------------
-- Embedded settlement handling: one accounting event, reversed once
-- ---------------------------------------------------------------------------
-- 20 the embedded settlement row is voided, not deleted or re-posted
select is(
  (select p.doc_status from public.payments p
    join public.sales s on s.id = p.linked_sale_id
   where s.invoice_number = 'INV-D1'),
  'VOIDED',
  'the embedded upfront settlement is marked VOIDED'
);

-- 21 its amount is untouched
select is(
  (select p.amount::int from public.payments p
    join public.sales s on s.id = p.linked_sale_id
   where s.invoice_number = 'INV-D1'),
  400,
  'the embedded settlement amount is unchanged'
);

-- 22 no second settlement row was added
select is(
  (select count(*) from public.payments p
    join public.sales s on s.id = p.linked_sale_id
   where s.invoice_number = 'INV-D1')::int,
  1,
  'the void adds no second payment row'
);

-- 23 no second journal entry was created for the settlement
select is(
  (select count(*) from public.journal_entries je
    join public.sales s on s.id = je.source_id
   where s.invoice_number = 'INV-D1' and je.source_type <> 'REVERSAL')::int,
  1,
  'the document keeps exactly one non-reversal journal entry'
);

-- 24 no PAYMENT-source entry was invented for the sale
select is(
  (select count(*) from public.journal_entries je
    join public.sales s on s.id = je.source_id
   where s.invoice_number = 'INV-D1' and je.source_type = 'PAYMENT')::int,
  0,
  'voiding never posts a payment journal entry'
);

-- ---------------------------------------------------------------------------
-- Repeated void: deterministic replay, no second reversal
-- ---------------------------------------------------------------------------
-- 25 the replay returns the same reversal
select is(
  (select (public.void_document(
    pg_temp.biz_a(), 'SALE', (select id from public.sales where invoice_number = 'INV-D1')
  )->'reversal_journal_entry'->>'id')),
  (select reversed_by_entry_id::text from public.journal_entries
    where id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1')),
  'a repeat call returns the persisted reversal unchanged'
);

-- 26 exactly one reversal exists for the original
select is(
  (select count(*) from public.journal_entries r
    where r.reverses_entry_id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1'))::int,
  1,
  'the replay leaves exactly one reversal entry'
);

-- ---------------------------------------------------------------------------
-- Validation and fail-closed guards
-- ---------------------------------------------------------------------------
-- 27 unknown document type
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'INVOICE', '%s'::uuid)$$,
         pg_temp.biz_a(), (select id from public.sales where invoice_number = 'INV-D2')),
  '22023', NULL,
  'an unsupported document type is rejected'
);

-- 28 null document type
select throws_ok(
  format($$select public.void_document('%s'::uuid, null, '%s'::uuid)$$,
         pg_temp.biz_a(), (select id from public.sales where invoice_number = 'INV-D2')),
  '22023', NULL,
  'a null document type is rejected'
);

-- 29 unknown document id
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'SALE', gen_random_uuid())$$, pg_temp.biz_a()),
  '22023', NULL,
  'an unknown document id is rejected'
);

-- 30 another tenant's document: the real id is supplied, and still rejected
select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'SALE', '%s'::uuid)$$,
         pg_temp.biz_b(), pg_temp.sale_id('INV-D2')),
  '22023', NULL,
  'a document from another business is rejected without leaking it'
);

-- 31 the wrong document type for the id
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'PURCHASE', '%s'::uuid)$$,
         pg_temp.biz_a(), (select id from public.sales where invoice_number = 'INV-D2')),
  '22023', NULL,
  'a sale id presented as a purchase is rejected'
);

-- 32 a source relationship that does not point back at the document fails closed
--    (fixture insert runs as the table owner)
reset role;
do $$
declare
  v_biz     uuid := pg_temp.biz_a();
  v_alice   uuid := 'a1111111-1111-4111-8111-111111111111';
  v_entry   uuid := gen_random_uuid();
  v_cust    uuid := gen_random_uuid();
  v_cash    uuid;
  v_sales   uuid;
begin
  select id into v_cash from public.accounts where business_id = v_biz and code = '1010';
  select id into v_sales from public.accounts where business_id = v_biz and code = '4010';

  insert into public.customers (id, business_id, name) values (v_cust, v_biz, 'Mismatch Customer');

  insert into public.journal_entries (id, business_id, transaction_date, sequence, description, reference, source_type, source_id, created_by)
  values (v_entry, v_biz, '2026-01-11',
          (select coalesce(max(sequence), 0) + 1 from public.journal_entries where business_id = v_biz),
          'Synthetic mismatch', 'SYN-MISMATCH', 'SALE', gen_random_uuid(), v_alice);
  insert into public.journal_lines (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
  values (v_biz, v_entry, 1, v_cash, 'Cash in hand', 'ASSET', 100, 0),
         (v_biz, v_entry, 2, v_sales, 'Sales revenue', 'REVENUE', 0, 100);

  insert into public.sales (business_id, customer_id, customer_name, invoice_number, date, subtotal,
                            discount_total, tax_amount, total_amount, upfront_paid, payment_method,
                            cost_of_goods, status, journal_entry_id, created_by,
                            payment_terms_days, due_date)
  values (v_biz, v_cust, 'Mismatch Customer', 'INV-MISMATCH', '2026-01-11', 100, 0, 0, 100, 0, 'CASH', 0, 'POSTED', v_entry, v_alice,
          0, '2026-01-11');
end $$;

select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'SALE', '%s'::uuid)$$,
         pg_temp.biz_a(), (select id from public.sales where invoice_number = 'INV-MISMATCH')),
  '23514', NULL,
  'a journal entry whose source does not point back at the document is rejected'
);

-- 33 the rejected mismatch document is left untouched
select is(
  (select count(*) from public.sales where invoice_number = 'INV-MISMATCH' and status = 'POSTED')::int,
  1,
  'the rejected mismatch document is left untouched'
);

-- 34 a "reversal" that claims to be a sale entry is unrepresentable
reset role;
select throws_ok(
  format($$insert into public.journal_entries
    (business_id, transaction_date, sequence, description, reference, source_type, source_id, created_by, reverses_entry_id)
    values ('%s'::uuid, '2026-01-12',
            (select coalesce(max(sequence),0)+1 from public.journal_entries where business_id = '%s'::uuid),
            'fake', 'FAKE-REV', 'SALE', null, 'a1111111-1111-4111-8111-111111111111'::uuid,
            (select journal_entry_id from public.sales where invoice_number = 'INV-D2'))$$,
    pg_temp.biz_a(), pg_temp.biz_a()),
  '23514', NULL,
  'the reversal shape constraint blocks an entry that is both a sale and a reversal'
);
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

-- ---------------------------------------------------------------------------
-- Purchase mirror (VAT + inventory + embedded settlement)
-- ---------------------------------------------------------------------------
-- 35 an OWNER can void a purchase
select isnt(
  (select (public.void_document(
    pg_temp.biz_a(), 'PURCHASE', (select id from public.purchases where reference_number = 'PO-D3')
  )->'reversal_journal_entry'->>'id')),
  NULL,
  'an OWNER can void a purchase'
);

-- 36 the purchase is VOIDED
select is(
  (select count(*) from public.purchases where reference_number = 'PO-D3' and status = 'VOIDED')::int,
  1,
  'the purchase row is kept and marked VOIDED'
);

-- 37 original purchase journal (inventory + VAT + settlement + payable)
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.purchases where reference_number = 'PO-D3')),
  '1060:1000:0, 1070:130:0, 1010:0:500, 2010:0:630',
  'the purchase posted inventory, VAT receivable, cash and payable'
);

-- 38 the purchase reversal is the exact mirror
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select reversed_by_entry_id from public.journal_entries
                                  where id = (select journal_entry_id from public.purchases where reference_number = 'PO-D3'))),
  '1060:0:1000, 1070:0:130, 1010:500:0, 2010:630:0',
  'the inventory and VAT lines are mirrored, not recomputed'
);

-- 39 the purchase reversal balances
select is(
  (select (sum(jl.debit) = sum(jl.credit))::text
     from public.journal_lines jl
    where jl.journal_entry_id = (select reversed_by_entry_id from public.journal_entries
                                  where id = (select journal_entry_id from public.purchases where reference_number = 'PO-D3'))),
  'true',
  'the purchase reversal balances'
);

-- 40 the embedded purchase settlement is voided and still exists
select is(
  (select p.doc_status || ':' || p.amount::text from public.payments p
    join public.purchases pu on pu.id = p.linked_purchase_id
   where pu.reference_number = 'PO-D3'),
  'VOIDED:500.00',
  'the embedded purchase settlement is retained and marked VOIDED'
);

-- ---------------------------------------------------------------------------
-- Expense mirror (via an ACCOUNTANT) and no settlement interaction
-- ---------------------------------------------------------------------------
-- 41 an ACCOUNTANT can void an expense
select pg_temp.act_as('d4444444-4444-4444-8444-444444444444');
select isnt(
  (select (public.void_document(
    pg_temp.biz_a(), 'EXPENSE', (select id from public.expenses where reference = 'EXP-D5')
  )->'reversal_journal_entry'->>'id')),
  NULL,
  'an ACCOUNTANT can void an expense'
);

-- 42 the expense is VOIDED
select is(
  (select count(*) from public.expenses where reference = 'EXP-D5' and status = 'VOIDED')::int,
  1,
  'the expense row is kept and marked VOIDED'
);

-- 43 original expense journal
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.expenses where reference = 'EXP-D5')),
  '5020:250:0, 1010:0:250',
  'the expense debited its category and credited cash'
);

-- 44 the expense reversal is the exact mirror
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select reversed_by_entry_id from public.journal_entries
                                  where id = (select journal_entry_id from public.expenses where reference = 'EXP-D5'))),
  '5020:0:250, 1010:250:0',
  'the expense reversal mirrors the category and cash lines'
);

-- 45 voiding an expense creates no payment rows: three embedded upfront
--    settlements and the two separately posted ones are all that exist
select is(
  (select count(*) from public.payments where business_id = pg_temp.biz_a())::int,
  5,
  'voiding an expense creates no settlement row'
);

-- ---------------------------------------------------------------------------
-- Separately posted settlements block the void
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');

-- 46 a sale with its own completed settlement cannot be voided
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'SALE', '%s'::uuid)$$,
         pg_temp.biz_a(), (select id from public.sales where invoice_number = 'INV-D2')),
  '22023', NULL,
  'a sale with a separately posted settlement is blocked'
);

-- 47 ...and is left POSTED
select is(
  (select status from public.sales where invoice_number = 'INV-D2'),
  'POSTED',
  'the blocked sale is unchanged'
);

-- 48 a purchase with its own completed settlement cannot be voided
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'PURCHASE', '%s'::uuid)$$,
         pg_temp.biz_a(), (select id from public.purchases where reference_number = 'PO-D4')),
  '22023', NULL,
  'a purchase with a separately posted settlement is blocked'
);

-- 49 ...and is left POSTED
select is(
  (select status from public.purchases where reference_number = 'PO-D4'),
  'POSTED',
  'the blocked purchase is unchanged'
);

-- ---------------------------------------------------------------------------
-- Database backstops
-- ---------------------------------------------------------------------------
-- 50 the one-reversal-per-entry unique index is the final backstop
reset role;
select throws_ok(
  format($$insert into public.journal_entries
    (business_id, transaction_date, sequence, description, reference, source_type, source_id, created_by, reverses_entry_id)
    values ('%s'::uuid, '2026-03-01',
            (select coalesce(max(sequence),0)+1 from public.journal_entries where business_id = '%s'::uuid),
            'second reversal', 'REV-SECOND', 'REVERSAL',
            -- the same source as the entry being reversed, so the SHAPE rules of
            -- 016 are satisfied and the unique index is the only thing left to
            -- refuse this row
            (select source_id from public.journal_entries
              where id = (select journal_entry_id from public.sales where invoice_number = 'INV-D1')),
            'a1111111-1111-4111-8111-111111111111'::uuid,
            (select journal_entry_id from public.sales where invoice_number = 'INV-D1'))$$,
    pg_temp.biz_a(), pg_temp.biz_a()),
  '23505', NULL,
  'a second reversal for the same entry is refused by the unique index'
);

-- 51 the original link is write-once
select throws_ok(
  format($$update public.journal_entries set reversed_by_entry_id = null where id = '%s'::uuid$$,
         (select journal_entry_id from public.sales where invoice_number = 'INV-D1')),
  '23001', NULL,
  'an existing reversal link cannot be cleared or rewritten'
);
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

-- 52 one reversal per voided document
select is(
  (select count(*) from public.sales s
    join public.journal_entries r on r.reverses_entry_id = s.journal_entry_id
   where s.invoice_number = 'INV-D1')::int,
  1,
  'the voided sale has exactly one reversal'
);

-- 53 the business has one reversal per voided document, and no more
select is(
  (select count(*) from public.journal_entries je
    where je.business_id = pg_temp.biz_a() and je.source_type = 'REVERSAL')::int,
  (select (select count(*) from public.sales where business_id = pg_temp.biz_a() and status = 'VOIDED')
        + (select count(*) from public.purchases where business_id = pg_temp.biz_a() and status = 'VOIDED')
        + (select count(*) from public.expenses where business_id = pg_temp.biz_a() and status = 'VOIDED'))::int,
  'there is exactly one reversal per voided document'
);

-- ---------------------------------------------------------------------------
-- Atomicity: a failure after the reversal is written changes nothing
-- ---------------------------------------------------------------------------
reset role;
create function pg_temp.fail_payments() returns trigger
language plpgsql as $$
begin
  raise exception 'injected failure before the settlement could be marked void' using errcode = 'P0001';
end $$;
create trigger zz_fail_payments before update on public.payments
  for each row execute function pg_temp.fail_payments();

select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

-- 54 the injected failure surfaces
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'SALE', '%s'::uuid)$$,
         pg_temp.biz_a(), (select id from public.sales where invoice_number = 'INV-D6')),
  'P0001', NULL,
  'a failure while marking the settlement surfaces as an error'
);

reset role;
drop trigger zz_fail_payments on public.payments;

-- 55 the document is still POSTED
select is(
  (select status from public.sales where invoice_number = 'INV-D6'),
  'POSTED',
  'the failed void leaves the document POSTED'
);

-- 56 its settlement is untouched
select is(
  (select p.doc_status from public.payments p
    join public.sales s on s.id = p.linked_sale_id
   where s.invoice_number = 'INV-D6'),
  'POSTED',
  'the failed void leaves the settlement POSTED'
);

-- 57 no reversal was committed
select is(
  (select count(*) from public.journal_entries r
    where r.reverses_entry_id = (select journal_entry_id from public.sales where invoice_number = 'INV-D6'))::int,
  0,
  'the failed void commits no reversal entry'
);

-- 58 and the original entry was never linked
select is(
  (select reversed_by_entry_id from public.journal_entries
    where id = (select journal_entry_id from public.sales where invoice_number = 'INV-D6')),
  NULL,
  'the failed void leaves the original entry unlinked'
);

select * from finish();
rollback;
