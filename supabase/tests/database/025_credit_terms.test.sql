-- 025_credit_terms.test.sql
-- pgTAP suite: PAYMENT TERMS and the contractual DUE DATE they imply
-- (migration 015).
-- Run with: supabase test db   (LOCAL stack only)
--
-- Transactional (begin/rollback): every fixture below is rolled back, so a
-- rerun starts clean.
--
-- What it proves
--   1. The model has ONE authoritative due date. `payment_terms_days` is the
--      only writable input; `due_date` is held to `date + payment_terms_days`
--      by a CHECK constraint, so "the date says one thing, the terms another
--      and the due date a third" is not a state the table accepts (T11, T18).
--   2. Documents that already existed keep the meaning they had: 0 terms, due
--      on their own date, which is how the aging report treated them before
--      this migration. No historical terms are invented (T06-T08).
--   3. The terms reach the row through the posting RPC, computed inside the
--      same transaction, and the browser cannot supply a due date at all
--      (T09-T17, T19-T23).
--   4. Terms are metadata: the same request posted with 0, 7, 30 and 90 day
--      terms produces identical amounts, identical journal lines and identical
--      AR/AP control balances, differing only in the due date (T47-T54).
--   5. Settlements never move a due date — partial, void, re-settle, upfront
--      and full settlement all leave it exactly as recorded (T24-T46).
--   6. Voiding a posted document still works with the new columns in place,
--      which is why due_date is NOT a generated column: a stored generated
--      column reads as NULL in a BEFORE UPDATE trigger, and
--      guard_document_update (001) compares the whole row, so a generated
--      column would have made every void fail (T36-T42).
--   7. Due dates are tenant-scoped, like every other row (T55-T58).
--   8. The day counts the aging report buckets on come straight from
--      `due_date`, with the boundaries the report uses (T59-T63).

begin;
create extension if not exists pgtap with schema extensions;

select plan(63);

create function pg_temp.act_as(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_uid::text, 'role', 'authenticated')::text,
    true
  );
end $$;

/* -------------------------------------------------------------------------- */
/* Fixtures: two owners, two businesses (the second proves scoping)           */
/* -------------------------------------------------------------------------- */

insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'd1d1d1d1-1111-4111-8111-11111111d1d1',
   'authenticated', 'authenticated', 'terms-a@zeyks.test', '{"full_name":"Terms Owner A"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e2e2e2e2-2222-4222-8222-22222222e2e2',
   'authenticated', 'authenticated', 'terms-b@zeyks.test', '{"full_name":"Terms Owner B"}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('d1d1d1d1-1111-4111-8111-11111111d1d1');
set local role authenticated;
select public.create_business(
  'Terms Business A', 'Terms Owner A', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

select pg_temp.act_as('e2e2e2e2-2222-4222-8222-22222222e2e2');
set local role authenticated;
select public.create_business(
  'Terms Business B', 'Terms Owner B', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

create function pg_temp.biz_a() returns uuid
language sql security definer set search_path = '' as $$
  select id from public.businesses where business_name = 'Terms Business A';
$$;

create function pg_temp.biz_b() returns uuid
language sql security definer set search_path = '' as $$
  select id from public.businesses where business_name = 'Terms Business B';
$$;

create function pg_temp.sale(p_ref text) returns uuid
language sql security definer set search_path = '' as $$
  select id from public.sales where business_id = pg_temp.biz_a() and invoice_number = p_ref;
$$;

create function pg_temp.bill(p_ref text) returns uuid
language sql security definer set search_path = '' as $$
  select id from public.purchases where business_id = pg_temp.biz_a() and reference_number = p_ref;
$$;

create function pg_temp.sale_terms(p_ref text) returns smallint
language sql security definer set search_path = '' as $$
  select payment_terms_days from public.sales where id = pg_temp.sale(p_ref);
$$;

create function pg_temp.sale_due(p_ref text) returns date
language sql security definer set search_path = '' as $$
  select due_date from public.sales where id = pg_temp.sale(p_ref);
$$;

create function pg_temp.bill_terms(p_ref text) returns smallint
language sql security definer set search_path = '' as $$
  select payment_terms_days from public.purchases where id = pg_temp.bill(p_ref);
$$;

create function pg_temp.bill_due(p_ref text) returns date
language sql security definer set search_path = '' as $$
  select due_date from public.purchases where id = pg_temp.bill(p_ref);
$$;

/** What is still owed on a document: total − COMPLETED, non-voided settlements. */
create function pg_temp.sale_outstanding(p_ref text) returns numeric
language sql security definer set search_path = '' as $$
  select s.total_amount - coalesce((
           select sum(p.amount) from public.payments p
            where p.linked_sale_id = s.id and p.status = 'COMPLETED' and p.doc_status <> 'VOIDED'
         ), 0)
    from public.sales s where s.id = pg_temp.sale(p_ref);
$$;

/** The same, a second and independently written way, for the cross-check. */
create function pg_temp.docs_alt(p_biz uuid) returns numeric
language sql security definer set search_path = '' as $$
  with live as (
    select p.linked_sale_id as doc_id, sum(p.amount) as amount
      from public.payments p
     where p.business_id = p_biz
       and p.linked_sale_id is not null
       and p.status = 'COMPLETED'
       and p.doc_status <> 'VOIDED'
     group by p.linked_sale_id
  )
  select coalesce(sum(s.total_amount - coalesce(l.amount, 0)), 0)::numeric(14,2)
    from public.sales s
    left join live l on l.doc_id = s.id
   where s.business_id = p_biz and s.status <> 'VOIDED';
$$;

/** The control-account reconciliation, called as the CURRENT ROLE (INVOKER). */
create function pg_temp.ar_docs(p_biz uuid) returns numeric
language sql set search_path = '' as $$
  select d.receivable_documents from public.control_account_integrity() d where d.business_id = p_biz;
$$;

create function pg_temp.ar_control(p_biz uuid) returns numeric
language sql set search_path = '' as $$
  select d.receivable_control from public.control_account_integrity() d where d.business_id = p_biz;
$$;

create function pg_temp.visible_businesses() returns uuid[]
language sql set search_path = '' as $$
  select coalesce(array_agg(d.business_id order by d.business_id), '{}'::uuid[])
    from public.control_account_integrity() d;
$$;

/* -------------------------------------------------------------------------- */
/* 1. What the migration left behind: the model, stated at the schema         */
/* -------------------------------------------------------------------------- */

select is(
  (select is_nullable || '/' || column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'sales' and column_name = 'payment_terms_days'),
  'NO/0',
  'T01 sales records its terms and always has a value (default 0)'
);
select is(
  (select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'sales' and column_name = 'due_date'),
  'NO',
  'T02 and a posted sale can never be without a due date'
);
select ok(
  exists (select 1 from pg_constraint
           where conrelid = 'public.sales'::regclass and conname = 'sales_due_date_matches_terms'),
  'T03 the due date is tied to date + terms by a constraint, not by convention'
);
select is(
  (select is_nullable || '/' || column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'purchases' and column_name = 'payment_terms_days'),
  'NO/0',
  'T04 purchases carry the same model'
);
select ok(
  exists (select 1 from pg_constraint
           where conrelid = 'public.purchases'::regclass and conname = 'purchases_due_date_matches_terms'),
  'T05 with the same constraint on the bill side'
);

/* -------------------------------------------------------------------------- */
/* 2. Documents that predate terms: 0 terms, due on their own date            */
/* -------------------------------------------------------------------------- */

select pg_temp.act_as('d1d1d1d1-1111-4111-8111-11111111d1d1');
set local role authenticated;
-- No p_payment_terms_days at all: the pre-015 caller's request, unchanged.
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Historical customer',
  p_invoice_number := 'TERMS-HIST', p_date := '2025-06-10', p_subtotal := 1000, p_discount_total := 0,
  p_tax_amount := 0, p_total_amount := 1000, p_upfront_paid := 0, p_payment_method := 'CASH',
  p_cost_of_goods := null, p_notes := 'no terms recorded',
  p_items := '[{"line_no":1,"description":"legacy","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
);
reset role;

select is(pg_temp.sale_terms('TERMS-HIST'), 0::smallint,
  'T06 a caller that says nothing about terms records none');
select is(pg_temp.sale_due('TERMS-HIST'), '2025-06-10'::date,
  'T07 and such a document is due on its document date — exactly how it was aged before');
select is(
  (select due_date = date from public.sales where id = pg_temp.sale('TERMS-HIST')),
  true,
  'T08 the historical policy is visible in the row itself');
select is(pg_temp.sale_outstanding('TERMS-HIST'), 1000::numeric,
  'T09 and the terms change nothing about what is owed');

/* -------------------------------------------------------------------------- */
/* 3. Terms arithmetic, computed by the server inside the posting transaction */
/* -------------------------------------------------------------------------- */

select pg_temp.act_as('d1d1d1d1-1111-4111-8111-11111111d1d1');
set local role authenticated;
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Net customer',
  p_invoice_number := 'TERMS-N7', p_date := '2025-01-10', p_subtotal := 1000, p_discount_total := 0,
  p_tax_amount := 0, p_total_amount := 1000, p_upfront_paid := 0, p_payment_method := 'CASH',
  p_cost_of_goods := null, p_notes := null,
  p_items := '[{"line_no":1,"description":"goods","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
  p_payment_terms_days := 7
);
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Net customer',
  p_invoice_number := 'TERMS-N30', p_date := '2025-01-10', p_subtotal := 1000, p_discount_total := 0,
  p_tax_amount := 0, p_total_amount := 1000, p_upfront_paid := 0, p_payment_method := 'CASH',
  p_cost_of_goods := null, p_notes := null,
  p_items := '[{"line_no":1,"description":"goods","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
  p_payment_terms_days := 30
);
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Net customer',
  p_invoice_number := 'TERMS-N90', p_date := '2025-01-10', p_subtotal := 1000, p_discount_total := 0,
  p_tax_amount := 0, p_total_amount := 1000, p_upfront_paid := 0, p_payment_method := 'CASH',
  p_cost_of_goods := null, p_notes := null,
  p_items := '[{"line_no":1,"description":"goods","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
  p_payment_terms_days := 90
);
-- A month boundary and a leap day: 2025-01-31 + 30 rolls into March, and
-- 2024-02-28 + 1 is a real 29th because 2024 is a leap year.
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Calendar customer',
  p_invoice_number := 'TERMS-MONTH', p_date := '2025-01-31', p_subtotal := 500, p_discount_total := 0,
  p_tax_amount := 0, p_total_amount := 500, p_upfront_paid := 0, p_payment_method := 'CASH',
  p_cost_of_goods := null, p_notes := null,
  p_items := '[{"line_no":1,"description":"goods","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb,
  p_payment_terms_days := 30
);
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Leap customer',
  p_invoice_number := 'TERMS-LEAP', p_date := '2024-02-28', p_subtotal := 500, p_discount_total := 0,
  p_tax_amount := 0, p_total_amount := 500, p_upfront_paid := 0, p_payment_method := 'CASH',
  p_cost_of_goods := null, p_notes := null,
  p_items := '[{"line_no":1,"description":"goods","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb,
  p_payment_terms_days := 1
);
-- The longest term the model allows, on the boundary.
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Long customer',
  p_invoice_number := 'TERMS-MAX', p_date := '2025-01-10', p_subtotal := 500, p_discount_total := 0,
  p_tax_amount := 0, p_total_amount := 500, p_upfront_paid := 0, p_payment_method := 'CASH',
  p_cost_of_goods := null, p_notes := null,
  p_items := '[{"line_no":1,"description":"goods","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb,
  p_payment_terms_days := 3650
);
-- And the purchase side of the same rule.
select public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Net supplier',
  p_reference_number := 'TERMS-BILL30', p_date := '2025-03-05', p_subtotal := 800, p_discount_total := 0,
  p_tax_amount := 0, p_total_amount := 800, p_upfront_paid := 0, p_payment_method := 'BANK',
  p_notes := null, p_idempotency_key := 'terms-bill-30',
  p_items := '[{"line_no":1,"description":"stock","quantity":1,"unit_price":800,"discount":0,"total":800}]'::jsonb,
  p_price_includes_vat := false, p_payment_terms_days := 30
);
reset role;

select is(pg_temp.sale_terms('TERMS-N7'), 7::smallint, 'T10 Net 7 is recorded as 7 days');
select is(pg_temp.sale_due('TERMS-N7'), '2025-01-17'::date, 'T11 and is due seven days after the invoice date');
select is(pg_temp.sale_terms('TERMS-N30'), 30::smallint, 'T12 Net 30 is recorded as 30 days');
select is(pg_temp.sale_due('TERMS-N30'), '2025-02-09'::date, 'T13 due thirty days later');
select is(pg_temp.sale_due('TERMS-N90'), '2025-04-10'::date, 'T14 Net 90 lands ninety days later');
select is(pg_temp.sale_due('TERMS-MONTH'), '2025-03-02'::date,
  'T15 a month boundary rolls over the calendar correctly');
select is(pg_temp.sale_due('TERMS-LEAP'), '2024-02-29'::date,
  'T16 and a leap day is a real day, computed by PostgreSQL rather than by millisecond arithmetic');
select is(pg_temp.sale_due('TERMS-MAX'), '2035-01-08'::date, 'T17 the longest allowed term computes exactly');
select is(pg_temp.bill_due('TERMS-BILL30'), '2025-04-04'::date,
  'T18 a bill uses the same rule on its own date');
select is(pg_temp.bill_terms('TERMS-BILL30'), 30::smallint, 'T19 and records its own terms');
select is(
  (select count(*) from public.sales
    where business_id = pg_temp.biz_a() and due_date <> date + payment_terms_days),
  0::bigint,
  'T20 every posted sale satisfies the model, not just the ones this suite named'
);

/* -------------------------------------------------------------------------- */
/* 4. Validation: the terms are checked inside the transaction                */
/* -------------------------------------------------------------------------- */

select pg_temp.act_as('d1d1d1d1-1111-4111-8111-11111111d1d1');
set local role authenticated;
select throws_ok(
  $$select public.post_sale(
      p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Bad terms',
      p_invoice_number := 'TERMS-NEG', p_date := '2025-01-10', p_subtotal := 100, p_discount_total := 0,
      p_tax_amount := 0, p_total_amount := 100, p_upfront_paid := 0, p_payment_method := 'CASH',
      p_cost_of_goods := null, p_notes := null,
      p_items := '[{"line_no":1,"description":"x","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb,
      p_payment_terms_days := -1)$$,
  '22023', NULL, 'T21 negative terms are refused'
);
select throws_ok(
  $$select public.post_sale(
      p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Bad terms',
      p_invoice_number := 'TERMS-OVER', p_date := '2025-01-10', p_subtotal := 100, p_discount_total := 0,
      p_tax_amount := 0, p_total_amount := 100, p_upfront_paid := 0, p_payment_method := 'CASH',
      p_cost_of_goods := null, p_notes := null,
      p_items := '[{"line_no":1,"description":"x","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb,
      p_payment_terms_days := 3651)$$,
  '22023', NULL, 'T22 and a term beyond the model’s horizon is refused'
);
select throws_ok(
  $$select public.post_purchase(
      p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Bad terms',
      p_reference_number := 'TERMS-BADNULL', p_date := '2025-01-10', p_subtotal := 100, p_discount_total := 0,
      p_tax_amount := 0, p_total_amount := 100, p_upfront_paid := 0, p_payment_method := 'CASH',
      p_notes := null, p_idempotency_key := 'terms-bad-null',
      p_items := '[{"line_no":1,"description":"x","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb,
      p_price_includes_vat := false, p_payment_terms_days := null)$$,
  '22023', NULL, 'T23 an explicitly empty term is refused rather than guessed at'
);
reset role;

select is(
  (select count(*) from public.sales where business_id = pg_temp.biz_a() and invoice_number like 'TERMS-NEG%'),
  0::bigint, 'T24 T24 a refused posting wrote no document'
);
-- The constraint, not the RPC, is the last line of defence: a hand-written row
-- whose due date disagrees with its terms is refused by the table. A throwaway
-- journal entry is provided so the only thing that can reject this insert is the
-- due-date constraint itself.
insert into public.customers (business_id, name)
values (pg_temp.biz_a(), 'Terms check customer');
insert into public.journal_entries (
  id, business_id, transaction_date, sequence, description, reference, source_type, created_by
) values (
  'de000000-0000-4000-8000-0000000000de', pg_temp.biz_a(), '2025-01-10',
  (select coalesce(max(sequence), 0) + 1 from public.journal_entries where business_id = pg_temp.biz_a()),
  'Throwaway', 'TERMS-CHECK-ENTRY', 'MANUAL', 'd1d1d1d1-1111-4111-8111-11111111d1d1'
);
select throws_ok(
  $$insert into public.sales (
      business_id, customer_id, customer_name, invoice_number, date,
      subtotal, discount_total, tax_amount, total_amount, upfront_paid, payment_method,
      cost_of_goods, status, journal_entry_id, created_by, payment_terms_days, due_date
    ) values (
      pg_temp.biz_a(),
      (select id from public.customers where business_id = pg_temp.biz_a() and name = 'Terms check customer'),
      'Hand written', 'TERMS-CHECK', '2025-01-10',
      100, 0, 0, 100, 0, 'CASH', 0, 'POSTED',
      'de000000-0000-4000-8000-0000000000de', 'd1d1d1d1-1111-4111-8111-11111111d1d1',
      30, '2025-01-11')$$,
  '23514', NULL, 'T25 a due date that does not match its terms cannot be written at all'
);

/* -------------------------------------------------------------------------- */
/* 5. Settlements never move a due date                                       */
/* -------------------------------------------------------------------------- */

select pg_temp.act_as('d1d1d1d1-1111-4111-8111-11111111d1d1');
set local role authenticated;
select public.post_payment(
  pg_temp.biz_a(), 'SALE', pg_temp.sale('TERMS-N30'), 400, 'BANK', '2025-01-20', '', 'part', 'terms-part-1'
);
reset role;

select is(pg_temp.sale_outstanding('TERMS-N30'), 600::numeric,
  'T26 a partial receipt reduces what is owed');
select is(pg_temp.sale_due('TERMS-N30'), '2025-02-09'::date,
  'T27 and does not move the day it was agreed to be paid');
select is(pg_temp.sale_terms('TERMS-N30'), 30::smallint, 'T28 the terms are untouched too');

select pg_temp.act_as('d1d1d1d1-1111-4111-8111-11111111d1d1');
set local role authenticated;
select public.void_payment(
  pg_temp.biz_a(),
  (select id from public.payments where linked_sale_id = pg_temp.sale('TERMS-N30') and status = 'COMPLETED')
);
reset role;

select is(pg_temp.sale_outstanding('TERMS-N30'), 1000::numeric,
  'T29 voiding that receipt puts the money back');
select is(pg_temp.sale_due('TERMS-N30'), '2025-02-09'::date,
  'T30 and the due date is exactly where it was');
select is(
  (select count(*) from public.payments
    where linked_sale_id = pg_temp.sale('TERMS-N30') and doc_status = 'VOIDED'),
  1::bigint, 'T31 the voided settlement remains as history'
);

select pg_temp.act_as('d1d1d1d1-1111-4111-8111-11111111d1d1');
set local role authenticated;
select public.post_payment(
  pg_temp.biz_a(), 'SALE', pg_temp.sale('TERMS-N30'), 1000, 'CASH', '2025-02-01', '', 'full', 'terms-part-2'
);
reset role;

select is(pg_temp.sale_outstanding('TERMS-N30'), 0::numeric,
  'T32 re-settling in full clears the balance');
select is(pg_temp.sale_due('TERMS-N30'), '2025-02-09'::date,
  'T33 and the replacement settlement does not reset the agreed date either');

-- An upfront settlement, recorded as part of posting, is no different.
select pg_temp.act_as('d1d1d1d1-1111-4111-8111-11111111d1d1');
set local role authenticated;
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Upfront customer',
  p_invoice_number := 'TERMS-UPFRONT', p_date := '2025-05-05', p_subtotal := 1000, p_discount_total := 0,
  p_tax_amount := 0, p_total_amount := 1000, p_upfront_paid := 400, p_payment_method := 'ESEWA',
  p_cost_of_goods := null, p_notes := null,
  p_items := '[{"line_no":1,"description":"goods","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
  p_payment_terms_days := 45
);
reset role;

select is(pg_temp.sale_due('TERMS-UPFRONT'), '2025-06-19'::date,
  'T34 money taken at posting does not shorten the agreed term');
select is(pg_temp.sale_outstanding('TERMS-UPFRONT'), 600::numeric,
  'T35 though it does settle part of the document');
select is(
  (select upfront_paid from public.sales where id = pg_temp.sale('TERMS-UPFRONT')),
  400::numeric,
  'T36 and the posting-time snapshot is still just a snapshot'
);

/* -------------------------------------------------------------------------- */
/* 6. Voiding a document still works, and keeps the recorded due date         */
/* -------------------------------------------------------------------------- */

-- The regression this suite exists for: a stored generated due_date would have
-- made guard_document_update see an edit to the row and refuse every void.
select pg_temp.act_as('d1d1d1d1-1111-4111-8111-11111111d1d1');
set local role authenticated;
select lives_ok(
  $$select public.void_document(pg_temp.biz_a(), 'SALE', pg_temp.sale('TERMS-N7'))$$,
  'T37 a sale posted with terms can still be voided'
);
reset role;

select is(
  (select status from public.sales where id = pg_temp.sale('TERMS-N7')),
  'VOIDED', 'T38 the document is voided'
);
select is(pg_temp.sale_terms('TERMS-N7'), 7::smallint,
  'T39 its terms survive the void as history');
select is(pg_temp.sale_due('TERMS-N7'), '2025-01-17'::date,
  'T40 and so does the date it was due');
select is(
  (select count(*) from public.journal_entries
    where business_id = pg_temp.biz_a()
      and reference = 'REV-TERMS-N7'
      and source_type = 'REVERSAL'),
  1::bigint, 'T41 exactly one reversal was posted for it'
);

select pg_temp.act_as('d1d1d1d1-1111-4111-8111-11111111d1d1');
set local role authenticated;
select is(
  pg_temp.ar_control(pg_temp.biz_a()),
  pg_temp.ar_docs(pg_temp.biz_a()),
  'T42 and the control account still agrees with the documents after a void'
);

/* -------------------------------------------------------------------------- */
/* 7. Terms change no amount                                                  */
/* -------------------------------------------------------------------------- */

-- Seven invoices with seven different terms, four of them written above with
-- 1000 each, and the control account is the sum of what is actually owed.
select is(
  pg_temp.ar_docs(pg_temp.biz_a()),
  pg_temp.docs_alt(pg_temp.biz_a()),
  'T43 the document side is the same figure however the terms differ'
);
select is(
  (select sum(total_amount) from public.sales
    where business_id = pg_temp.biz_a() and invoice_number in ('TERMS-HIST', 'TERMS-N30', 'TERMS-N90', 'TERMS-MONTH', 'TERMS-LEAP') and status <> 'VOIDED'),
  4000::numeric,
  'T44 the amounts are the amounts, terms or not'
);
select is(
  (select count(*) from public.journal_entries je
    join public.sales s on s.journal_entry_id = je.id
   where s.business_id = pg_temp.biz_a() and s.status <> 'VOIDED'),
  7::bigint,
  'T45 one journal entry per posted document, never one per term'
);
select is(
  (select count(*) from public.sales s
    join public.journal_lines jl on jl.journal_entry_id = s.journal_entry_id
   where s.business_id = pg_temp.biz_a() and s.invoice_number = 'TERMS-N90'),
  2::bigint, 'T46 a credit sale still posts its two lines (receivable and revenue)'
);
select is(
  (select sum(jl.debit) - sum(jl.credit) from public.journal_lines jl
    join public.sales s on s.journal_entry_id = jl.journal_entry_id
   where s.business_id = pg_temp.biz_a()),
  0::numeric, 'T47 and every entry stays balanced'
);
select is(
  (select sum(jl.debit) - sum(jl.credit) from public.journal_lines jl
    join public.purchases pu on pu.journal_entry_id = jl.journal_entry_id
   where pu.business_id = pg_temp.biz_a()),
  0::numeric, 'T48 on the purchase side too'
);
reset role;

/* -------------------------------------------------------------------------- */
/* 8. Tenant scoping                                                          */
/* -------------------------------------------------------------------------- */

select pg_temp.act_as('e2e2e2e2-2222-4222-8222-22222222e2e2');
set local role authenticated;
select is(
  (select count(*) from public.sales where business_id = pg_temp.biz_a()),
  0::bigint, 'T49 another business cannot read these due dates'
);
select is(cardinality(pg_temp.visible_businesses()), 1,
  'T50 and its own reconciliation covers exactly one business');
select is(pg_temp.ar_docs(pg_temp.biz_b()), 0::numeric,
  'T51 with nothing from the other business in it'
);

select pg_temp.act_as('d1d1d1d1-1111-4111-8111-11111111d1d1');
set local role authenticated;
select is(cardinality(pg_temp.visible_businesses()), 1,
  'T52 and the owner of the terms business sees only their own');
reset role;

select is(
  (select count(*) from public.sales where business_id = pg_temp.biz_b()),
  0::bigint, 'T53 no row leaked into the second business'
);

/* -------------------------------------------------------------------------- */
/* 9. The day counts the aging report buckets come from due_date              */
/* -------------------------------------------------------------------------- */

-- Same day counts the report's buckets are built on: due today is not late,
-- one day past due is, and the 30/31 boundary is where 1–30 becomes 31–60.
select is(
  (select '2025-02-09'::date - due_date from public.sales where id = pg_temp.sale('TERMS-N30')),
  0, 'T54 on the due date, a document is zero days late'
);
select is(
  (select '2025-02-10'::date - due_date from public.sales where id = pg_temp.sale('TERMS-N30')),
  1, 'T55 the next day it is one day late, which is the 1–30 bucket'
);
select is(
  (select '2025-03-11'::date - due_date from public.sales where id = pg_temp.sale('TERMS-N30')),
  30, 'T56 thirty days late is still 1–30'
);
select is(
  (select '2025-03-12'::date - due_date from public.sales where id = pg_temp.sale('TERMS-N30')),
  31, 'T57 and thirty-one starts 31–60'
);
select is(
  (select '2025-06-10'::date - due_date from public.sales where id = pg_temp.sale('TERMS-N90')),
  61, 'T58 Net 90 sits in 61–90 on this report date, not in 90+'
);
select is(
  (select '2026-06-10'::date - due_date from public.sales where id = pg_temp.sale('TERMS-HIST')),
  365, 'T59 a document with no terms ages from its own date, in 90+ a year later'
);
select is(
  (select due_date - date from public.sales where id = pg_temp.sale('TERMS-UPFRONT')),
  45, 'T60 the days between the two dates are the terms, for a reprint to state'
);

/* A document dated after the report date is not late, whatever its terms. */
select ok(
  (select '2025-01-01'::date - due_date < 0 from public.sales where id = pg_temp.sale('TERMS-N90')),
  'T61 a report date before the due date gives a negative age the layer clamps to not-due'
);
select is(
  (select greatest(0, '2025-01-01'::date - due_date) from public.sales where id = pg_temp.sale('TERMS-N90')),
  0, 'T62 which is what clamping does'
);

/* The reconciliation is unchanged by any of this. */
select pg_temp.act_as('d1d1d1d1-1111-4111-8111-11111111d1d1');
set local role authenticated;
select is(
  pg_temp.ar_control(pg_temp.biz_a()),
  pg_temp.ar_docs(pg_temp.biz_a()),
  'T63 the control account equals the documents with seven different sets of terms recorded'
);
reset role;

select * from finish();
rollback;
