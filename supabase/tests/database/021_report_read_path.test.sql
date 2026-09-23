-- 021_report_read_path.test.sql
-- pgTAP suite: the data the A4 reports and the printable documents read.
-- Run with: supabase test db
--
-- Transactional (begin/rollback): every fixture below is rolled back, so a rerun
-- starts clean.
--
-- Why this file exists (Stage 12 audit): reports and printed documents are
-- presentation, and they compute nothing themselves — the statements come from
-- accountingEngine over the rows the loader fetched, and the document registers
-- sum settlement rows. That makes four database-side facts load-bearing, and
-- nothing pinned all four together:
--
--   1. the read path is tenant-scoped, so a report can only ever be built from
--      the member's own business rows (the browser is not the boundary: RLS is);
--   2. `Total − SUM(COMPLETED + POSTED settlement rows)` is the balance a
--      printed document shows, so a voided settlement stops counting and a
--      voided document stops being a row;
--   3. the statements' invariant holds — every posted entry balances, so the
--      trial balance and every derived figure tie out;
--   4. the posting-time snapshot (`sales.upfront_paid`) stays frozen while the
--      row-derived balance moves, which is exactly what lets a reprinted
--      document show the original figure *and* the current balance without
--      either of them being wrong. That is the Stage 11 invariant, re-checked
--      here from the reporting side rather than the posting side.
--
-- The application-side half of the same rules — the report builders, the
-- snapshot never entering a balance, the print CSS and the read-only document
-- viewer — is pinned in tests/run.mjs (Stage 12 block).

begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

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
-- Fixtures: Alice owns A, Bob owns B (a tenant Alice must never see), and Cara
-- is a VIEWER in A (reports must still render for her — read access, no writes).
--   A: INV-A-1 1000, settled 400 at posting + 200 later  -> outstanding 400
--      INV-A-2  500, settled 500 later, that receipt VOIDED -> outstanding 500
--      INV-A-3  700, VOIDED as a document                -> not a report row
--      PO-A-1   600, settled 100 at posting + 500 later   -> outstanding 0
--      EXP-A-1  250 recorded, EXP-A-2 recorded then VOIDED
--   B: INV-B-1 9000, nothing settled
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e0111111-1111-4111-8111-111111111111',
   'authenticated', 'authenticated', 'report-alice@zeyks.test', '{"full_name":"Alice"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e0222222-2222-4222-8222-222222222222',
   'authenticated', 'authenticated', 'report-bob@zeyks.test', '{"full_name":"Bob"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e0333333-3333-4333-8333-333333333333',
   'authenticated', 'authenticated', 'report-cara@zeyks.test', '{"full_name":"Cara"}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('e0111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.create_business(
  'Report Business A', 'Alice', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

select pg_temp.act_as('e0222222-2222-4222-8222-222222222222');
set local role authenticated;
select public.create_business(
  'Report Business B', 'Bob', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

-- Cara joins A as a viewer (written as the table owner; RLS is bypassed here
-- deliberately, because this fixture is not what is under test).
insert into public.business_memberships (business_id, user_id, role)
select id, 'e0333333-3333-4333-8333-333333333333', 'VIEWER'
from public.businesses where business_name = 'Report Business A'
on conflict do nothing;

create function pg_temp.biz_a() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Report Business A';
$$;
create function pg_temp.biz_b() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Report Business B';
$$;
create function pg_temp.sale_id(p_invoice text) returns uuid language sql security definer as $$
  select id from public.sales where invoice_number = p_invoice;
$$;
create function pg_temp.pay_ref(p_ref text) returns uuid language sql security definer as $$
  select id from public.payments where reference = p_ref;
$$;
create function pg_temp.acct(p_biz uuid, p_code text) returns uuid language sql security definer as $$
  select id from public.accounts where business_id = p_biz and code = p_code;
$$;
grant execute on function pg_temp.biz_a(), pg_temp.biz_b(), pg_temp.sale_id(text),
  pg_temp.pay_ref(text), pg_temp.acct(uuid, text) to authenticated, anon;

create function pg_temp.sale(p_biz uuid, p_invoice text, p_total numeric, p_upfront numeric)
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  select to_jsonb(x) into r from public.post_sale(
    p_biz, null, 'Report customer', p_invoice, current_date - 1,
    p_total, 0, 0, p_total, p_upfront, 'CASH', 0, null,
    format('[{"line_no":1,"description":"Goods","quantity":1,"unit_price":%s,"discount":0,"total":%s}]',
           p_total, p_total)::jsonb
  ) x;
  return r;
end $$;

create function pg_temp.pay(p_biz uuid, p_type text, p_doc uuid, p_amount numeric, p_ref text)
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  select to_jsonb(x) into r from public.post_payment(
    p_biz, p_type, p_doc, p_amount, 'CASH', current_date, p_ref, null, 'k-' || p_ref
  ) x;
  return r;
end $$;
grant execute on function pg_temp.sale(uuid, text, numeric, numeric), pg_temp.pay(uuid, text, uuid, numeric, text)
  to authenticated, anon;

select pg_temp.act_as('e0111111-1111-4111-8111-111111111111');
set local role authenticated;

select pg_temp.sale(pg_temp.biz_a(), 'INV-A-1', 1000, 400);
select pg_temp.sale(pg_temp.biz_a(), 'INV-A-2', 500, 0);
select pg_temp.sale(pg_temp.biz_a(), 'INV-A-3', 700, 0);
select pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('INV-A-1'), 200, 'RCP-A-1');
select pg_temp.pay(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('INV-A-2'), 500, 'RCP-A-2');

select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Report supplier',
  p_reference_number := 'PO-A-1', p_date := current_date - 1,
  p_subtotal := 600, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 600,
  p_upfront_paid := 100, p_payment_method := 'BANK', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":600,"discount":0,"total":600}]'::jsonb,
  p_idempotency_key := null, p_price_includes_vat := false
);
select pg_temp.pay(
  pg_temp.biz_a(), 'PURCHASE',
  (select id from public.purchases where reference_number = 'PO-A-1'), 500, 'PAY-A-1'
);

select public.post_expense(
  pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), 'EXP-A-1', current_date - 1,
  250, 0, 250, 'CASH', 'Report expense', null, 'k-exp-a1', false
);
select public.post_expense(
  pg_temp.biz_a(), pg_temp.acct(pg_temp.biz_a(), '5020'), 'EXP-A-2', current_date - 1,
  125, 0, 125, 'CASH', 'Expense to void', null, 'k-exp-a2', false
);

-- A receipt that is later voided, and a document that is later voided.
select public.void_payment(pg_temp.biz_a(), pg_temp.pay_ref('RCP-A-2'));
select public.void_document(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('INV-A-3'));
select public.void_document(pg_temp.biz_a(), 'EXPENSE',
  (select id from public.expenses where reference = 'EXP-A-2'));

reset role;

select pg_temp.act_as('e0222222-2222-4222-8222-222222222222');
set local role authenticated;

select pg_temp.sale(pg_temp.biz_b(), 'INV-B-1', 9000, 0);

reset role;

-- ---------------------------------------------------------------------------
-- 1. The read path is tenant-scoped: a report cannot be built from another
--    business's rows, because the rows never leave the database.
-- ---------------------------------------------------------------------------
select pg_temp.act_as('e0111111-1111-4111-8111-111111111111');
set local role authenticated;

select is(
  (select count(*) from public.sales where business_id = pg_temp.biz_a()),
  3::bigint, 'R01 Alice reads the three invoices of her own business'
);
select is(
  (select count(*) from public.sales where business_id = pg_temp.biz_b()),
  0::bigint, 'R02 and not one row of Bob''s business, so no report can show it'
);
select is(
  (select count(*) from public.sales where invoice_number = 'INV-B-1'),
  0::bigint, 'R03 Bob''s invoice is not visible even when it is named exactly'
);
select is(
  (select count(*) from public.purchases where business_id = pg_temp.biz_b()),
  0::bigint, 'R04 the purchase register is scoped the same way'
);
select is(
  (select count(*) from public.expenses where business_id = pg_temp.biz_b()),
  0::bigint, 'R05 so is the expense register'
);
select is(
  (select count(*) from public.payments where business_id = pg_temp.biz_b()),
  0::bigint, 'R06 and the settlements a document register sums'
);
select is(
  (select count(*) from public.journal_entries where business_id = pg_temp.biz_b()),
  0::bigint, 'R07 the statements read no line of another business''s ledger'
);
select is(
  (select count(*) from public.journal_lines jl
     join public.journal_entries je on je.id = jl.journal_entry_id
    where je.business_id = pg_temp.biz_b()),
  0::bigint, 'R08 the ledger lines behind them are scoped too'
);

reset role;

-- The mirror, from Bob's side.
select pg_temp.act_as('e0222222-2222-4222-8222-222222222222');
set local role authenticated;
select is(
  (select count(*) from public.sales where invoice_number = 'INV-A-1'),
  0::bigint, 'R09 and Bob cannot read Alice''s invoice either'
);
reset role;

-- Cara is a VIEWER: reports must render for her, so reads are allowed.
select pg_temp.act_as('e0333333-3333-4333-8333-333333333333');
set local role authenticated;
select is(
  (select count(*) from public.sales where business_id = pg_temp.biz_a()),
  3::bigint, 'R10 a VIEWER can read the books, which is what rendering a report needs'
);
select throws_ok(
  format($$select public.post_payment('%s'::uuid, 'SALE', '%s'::uuid, 1, 'CASH', current_date, 'R-X', null, 'k-viewer')$$,
         pg_temp.biz_a(), pg_temp.sale_id('INV-A-1')),
  '42501', NULL,
  'R11 but a VIEWER still cannot settle anything from a report screen'
);
reset role;

-- anon holds no read path into the books at all.
set local role anon;
select throws_ok(
  'select count(*) from public.sales',
  '42501', NULL,
  'R12 anon cannot read the sales register the report is built from'
);
select throws_ok(
  'select count(*) from public.payments',
  '42501', NULL,
  'R13 nor the settlements'
);
reset role;

-- ---------------------------------------------------------------------------
-- 2. The balance a printed document shows: total less the live settlement rows.
-- ---------------------------------------------------------------------------
create function pg_temp.outstanding(p_invoice text) returns numeric
language sql security definer as $$
  select s.total_amount - coalesce((
    select sum(p.amount) from public.payments p
     where p.linked_sale_id = s.id and p.doc_status = 'POSTED' and p.status = 'COMPLETED'
  ), 0)
  from public.sales s where s.invoice_number = p_invoice;
$$;
grant execute on function pg_temp.outstanding(text) to authenticated, anon;

select is(
  pg_temp.outstanding('INV-A-1'),
  400.00::numeric,
  'R14 the embedded 400 and the later 200 both count: 1000 − 600 = 400'
);
select is(
  pg_temp.outstanding('INV-A-2'),
  500.00::numeric,
  'R15 a VOIDED settlement stops counting, so the invoice is outstanding again'
);
select is(
  (select count(*) from public.payments
    where linked_sale_id = pg_temp.sale_id('INV-A-2') and doc_status = 'POSTED'),
  0::bigint, 'R16 and it is kept as history rather than deleted'
);
select is(
  (select count(*) from public.payments
    where linked_sale_id = pg_temp.sale_id('INV-A-2') and doc_status = 'VOIDED'),
  1::bigint, 'R17 while the voided row is still on the record'
);

-- The snapshot and the row sum disagree on purpose: the report must use the rows.
select is(
  (select upfront_paid from public.sales where invoice_number = 'INV-A-1'),
  400.00::numeric, 'R18 the posting-time snapshot still says what was settled on the day'
);
select is(
  (select sum(p.amount) from public.payments p
    where p.linked_sale_id = pg_temp.sale_id('INV-A-1')
      and p.doc_status = 'POSTED' and p.status = 'COMPLETED'),
  600.00::numeric, 'R19 while the live settlement rows add up to more'
);
select isnt(
  (select upfront_paid from public.sales where invoice_number = 'INV-A-1'),
  (select sum(p.amount) from public.payments p
    where p.linked_sale_id = pg_temp.sale_id('INV-A-1')
      and p.doc_status = 'POSTED' and p.status = 'COMPLETED'),
  'R20 the two figures genuinely differ, so a document showing the wrong one would be visibly wrong'
);

-- A voided document is not a report row.
select is(
  (select status from public.sales where invoice_number = 'INV-A-3'),
  'VOIDED', 'R21 a voided invoice is flagged, which is what the register filters on'
);
select is(
  (select count(*) from public.sales
    where business_id = pg_temp.biz_a() and status = 'POSTED'),
  2::bigint, 'R22 leaving the two live invoices as the rows a sales report lists'
);
select is(
  (select count(*) from public.expenses
    where business_id = pg_temp.biz_a() and status = 'POSTED'),
  1::bigint, 'R23 the expense register filters the same way'
);
select is(
  (select status from public.purchases where reference_number = 'PO-A-1'),
  'POSTED', 'R24 and a live bill stays a row'
);
select is(
  (select s.total_amount - coalesce((
     select sum(p.amount) from public.payments p
      where p.linked_purchase_id = s.id and p.doc_status = 'POSTED' and p.status = 'COMPLETED'
   ), 0) from public.purchases s where s.reference_number = 'PO-A-1'),
  0.00::numeric, 'R25 the bill is fully settled: 600 − (100 + 500) = 0'
);

-- ---------------------------------------------------------------------------
-- 3. The statements' invariant: every posted entry balances, so the figures a
--    report derives from the ledger tie out.
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from (
     select je.id from public.journal_entries je
       join public.journal_lines jl on jl.journal_entry_id = je.id
      where je.business_id = pg_temp.biz_a()
      group by je.id
     having sum(jl.debit) <> sum(jl.credit)
   ) unbalanced),
  0::bigint, 'R26 no entry in the business is out of balance'
);
select is(
  (select sum(jl.debit) = sum(jl.credit) from public.journal_lines jl
     join public.journal_entries je on je.id = jl.journal_entry_id
    where je.business_id = pg_temp.biz_a()),
  true, 'R27 so the trial balance totals match, which is the figure the report prints'
);
select is(
  (select count(distinct je.sequence) = count(*) from public.journal_entries je
    where je.business_id = pg_temp.biz_a()),
  true, 'R28 and entry sequences stay unique, which is what orders the printed ledger'
);
select is(
  (select count(*) from public.journal_entries
    where business_id = pg_temp.biz_a() and source_type = 'REVERSAL'),
  3::bigint,
  'R29 each void left one reversal behind — the receipt, the invoice and the expense voucher'
);

-- ---------------------------------------------------------------------------
-- 4. What a reprinted document relies on: nothing was mutated or deleted to make
--    the void happen, and the original entry is still there to reprint from.
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from public.sales where invoice_number = 'INV-A-3'),
  1::bigint, 'R30 a voided document is kept, not removed: the reprint has something to show'
);

select * from finish();
rollback;
