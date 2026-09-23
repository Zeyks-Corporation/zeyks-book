-- 018_invoice_receipt.test.sql
-- pgTAP suite: the manual RECEIPT (money in) lifecycle on a SALE invoice.
-- Run with: supabase test db
--
-- Transactional (begin/rollback): every fixture below is rolled back, so a rerun
-- starts clean. The genuine two-session race for a receipt against an invoice
-- void lives in 019_invoice_receipt_concurrency.test.sql.
--
-- Why this file exists: 009 already pins the shared settlement mechanics for a
-- sale (direction, accounts, over-settlement, idempotency, rollback) and 012
-- pins voiding a receipt. What was NOT pinned is the receipt lifecycle OVER
-- TIME, which is exactly what the invoice row action exposes to a person:
--   * several instalments against one invoice, ending exactly on the total;
--   * the embedded upfront receipt written by post_sale counted exactly once;
--   * voiding a receipt and then receiving the money again — a new row, a new
--     reference, a new sequence, the voided row kept as history and excluded
--     from the derivation;
--   * the balance being recomputed AFTER the void rather than remembered;
--   * the counterpart account being receivable in every method, fallback
--     included.
-- The registration, tenant and role cases for a sale receipt stay in 009; this
-- suite does not repeat them.
--
-- Rule this suite protects: a receipt IS post_payment with document_type SALE.
-- There is no receipt-specific RPC, no second accounting implementation, and
-- nothing here is written by the browser.

begin;
create extension if not exists pgtap with schema extensions;

select plan(46);

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
-- Fixtures: Alice owns business A (real seeded chart, so 1040/1050 exist);
-- business C is a synthetic tenant that never had the wallets.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a1111111-1111-4111-8111-1111111111aa',
   'authenticated', 'authenticated', 'rcp-alice@zeyks.test', '{"full_name":"Alice"}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('a1111111-1111-4111-8111-1111111111aa');
set local role authenticated;
select public.create_business(
  'Receipt Business A', 'Alice', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

insert into public.businesses (
  id, created_by, business_name, owner_name, currency_symbol,
  fiscal_year_start_month, vat_registered, vat_rate, track_inventory, timezone
) values (
  'cc000000-0000-4000-8000-0000000000ca', 'a1111111-1111-4111-8111-1111111111aa',
  'Receipt Business C', 'Alice', 'NPR', 4, false, 0, false, 'Asia/Kathmandu'
);

insert into public.business_memberships (business_id, user_id, role)
values ('cc000000-0000-4000-8000-0000000000ca', 'a1111111-1111-4111-8111-1111111111aa', 'OWNER');

insert into public.accounts (business_id, code, name, type, description, system_account) values
  ('cc000000-0000-4000-8000-0000000000ca', '1010', 'Cash in hand',        'ASSET',   null, true),
  ('cc000000-0000-4000-8000-0000000000ca', '1020', 'Bank account',        'ASSET',   null, true),
  ('cc000000-0000-4000-8000-0000000000ca', '1030', 'Accounts receivable', 'ASSET',   null, true),
  ('cc000000-0000-4000-8000-0000000000ca', '4010', 'Sales revenue',       'REVENUE', null, true);

create function pg_temp.biz_a() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Receipt Business A';
$$;
create function pg_temp.biz_c() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Receipt Business C';
$$;
create function pg_temp.sale_id(p_invoice text) returns uuid language sql security definer as $$
  select id from public.sales where invoice_number = p_invoice;
$$;
grant execute on function pg_temp.biz_a(), pg_temp.biz_c(), pg_temp.sale_id(text) to authenticated, anon;

-- Thin forwarder: the RPC still runs under the caller's own role and identity.
create function pg_temp.receipt(
  p_biz uuid, p_sale uuid, p_amount numeric,
  p_method text default 'CASH', p_date date default null,
  p_ref text default '', p_notes text default null, p_key text default null
) returns jsonb language sql as $$
  select public.post_payment(p_biz, 'SALE', p_sale, p_amount, p_method, p_date, p_ref, p_notes, p_key);
$$;
grant execute on function pg_temp.receipt(uuid, uuid, numeric, text, date, text, text, text)
  to authenticated, anon;

create temp table calls (name text primary key, payload jsonb);
grant all on calls to authenticated;

create temp table failed (name text primary key, sqlstate text, message text);
grant all on failed to authenticated;

-- Records a refusal instead of aborting the transaction, so both the sqlstate
-- and the message a person would see are assertable.
create function pg_temp.receipt_expect(
  p_name text, p_biz uuid, p_sale uuid, p_amount numeric,
  p_method text default 'CASH', p_date date default null,
  p_ref text default '', p_notes text default null, p_key text default null
) returns void language plpgsql as $$
begin
  perform public.post_payment(p_biz, 'SALE', p_sale, p_amount, p_method, p_date, p_ref, p_notes, p_key);
  insert into failed values (p_name, 'none', 'no error was raised');
exception when others then
  insert into failed values (p_name, sqlstate, sqlerrm);
end $$;
grant execute on function
  pg_temp.receipt_expect(text, uuid, uuid, numeric, text, date, text, text, text)
  to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-1111111111aa');
set local role authenticated;

-- S1: 1000 credit invoice — the void-then-receive-again case
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'S1 customer',
  p_invoice_number := 'RCP-S1', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Goods","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
);

-- S2: 1000 credit invoice — three instalments
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'S2 customer',
  p_invoice_number := 'RCP-S2', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Goods","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
);

-- S3: 500 with an embedded upfront receipt of 200 (counted exactly once)
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'S3 customer',
  p_invoice_number := 'RCP-S3', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 200, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Goods","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb
);

-- S4: to be voided, after which a receipt must be refused
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'S4 customer',
  p_invoice_number := 'RCP-S4', p_date := current_date - 1,
  p_subtotal := 700, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 700,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Goods","quantity":1,"unit_price":700,"discount":0,"total":700}]'::jsonb
);

-- S5: 4000, room for one receipt per method
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'S5 customer',
  p_invoice_number := 'RCP-S5', p_date := current_date - 1,
  p_subtotal := 4000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 4000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Goods","quantity":1,"unit_price":4000,"discount":0,"total":4000}]'::jsonb
);

reset role;

-- The wallet-less business C: one invoice for the fallback rule
select pg_temp.act_as('a1111111-1111-4111-8111-1111111111aa');
set local role authenticated;
select public.post_sale(
  p_business_id := pg_temp.biz_c(), p_customer_id := null, p_customer_name := 'Fallback customer',
  p_invoice_number := 'RCP-C1', p_date := current_date - 1,
  p_subtotal := 300, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 300,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Goods","quantity":1,"unit_price":300,"discount":0,"total":300}]'::jsonb
);
reset role;

-- ---------------------------------------------------------------------------
-- Setup
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from public.accounts where business_id = pg_temp.biz_a() and code in ('1040', '1050')),
  2::bigint, 'P01 setup: business A carries both wallet accounts'
);
select is(
  (select count(*) from public.accounts where business_id = pg_temp.biz_c() and code in ('1040', '1050')),
  0::bigint, 'P02 setup: the fallback business has no wallet account'
);
select is(
  (select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('RCP-S1')),
  0::bigint, 'P03 setup: S1 starts with nothing received'
);
select is(
  (select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('RCP-S3')),
  1::bigint, 'P04 setup: S3 starts with only its embedded upfront receipt'
);

-- ---------------------------------------------------------------------------
-- The shape and the exact journal of a receipt
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-1111111111aa');
set local role authenticated;
insert into calls
select 'r1', pg_temp.receipt(pg_temp.biz_a(), pg_temp.sale_id('RCP-S1'), 400,
                             'CASH', current_date - 1, '', 'first receipt', 'k-rcp-s1a');
reset role;

select is(
  (select p.payment_type || '|' || coalesce(p.linked_purchase_id::text, 'NULL') || '|' ||
          coalesce(p.linked_sale_id::text, 'NULL')
     from public.payments p where p.idempotency_key = 'k-rcp-s1a'),
  'INCOMING|NULL|' || pg_temp.sale_id('RCP-S1')::text,
  'P05 a receipt is INCOMING and linked to the invoice only'
);
select is(
  (select p.party_name from public.payments p where p.idempotency_key = 'k-rcp-s1a'),
  'S1 customer'::text, 'P06 the party snapshot comes from the persisted invoice'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'account_type') || '|' || (l->>'debit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'r1' and l->>'line_no' = '1'),
  'Cash in hand|ASSET|400.00',
  'P07 line 1 debits the settlement account (CASH -> 1010)'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'account_type') || '|' || (l->>'credit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'r1' and l->>'line_no' = '2'),
  'Accounts receivable|ASSET|400.00',
  'P08 line 2 credits Accounts receivable (1030) — the invoice is what shrinks'
);
select is(
  (select sum((l->>'debit')::numeric) - sum((l->>'credit')::numeric)
     from calls, jsonb_array_elements(payload->'journal_lines') l where calls.name = 'r1'),
  0::numeric, 'P09 the receipt entry balances exactly'
);
select is(
  (select payload->'payment'->>'reference' like 'RCP-' || to_char(current_date - 1, 'YYYYMMDD') || '-%'
     from calls where name = 'r1'),
  true, 'P10 money in is allocated an RCP-YYYYMMDD-NNN reference'
);
select is(
  (select (payload->'journal_entry'->>'source_type') || '|' ||
          (payload->'journal_entry'->>'source_id' = payload->'payment'->>'id')
     from calls where name = 'r1'),
  'PAYMENT|true', 'P11 the entry is a PAYMENT sourced to the receipt row'
);

-- ---------------------------------------------------------------------------
-- Every method debits a settlement account and credits the receivable
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-1111111111aa');
set local role authenticated;
insert into calls
select 'm_cash', pg_temp.receipt(pg_temp.biz_a(), pg_temp.sale_id('RCP-S5'), 1000,
                                 'CASH', current_date - 1, '', 'method case', 'k-m-cash');
insert into calls
select 'm_bank', pg_temp.receipt(pg_temp.biz_a(), pg_temp.sale_id('RCP-S5'), 1000,
                                 'BANK', current_date - 1, '', 'method case', 'k-m-bank');
insert into calls
select 'm_esewa', pg_temp.receipt(pg_temp.biz_a(), pg_temp.sale_id('RCP-S5'), 1000,
                                  'ESEWA', current_date - 1, '', 'method case', 'k-m-esewa');
insert into calls
select 'm_khalti', pg_temp.receipt(pg_temp.biz_a(), pg_temp.sale_id('RCP-S5'), 1000,
                                   'KHALTI', current_date - 1, '', 'method case', 'k-m-khalti');
insert into calls
select 'm_fallback', pg_temp.receipt(pg_temp.biz_c(), pg_temp.sale_id('RCP-C1'), 300,
                                     'ESEWA', current_date - 1, '', 'fallback', 'k-m-fallback');
reset role;

select is(
  (select (l->>'account_name') || '|' || (l->>'debit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'm_bank' and l->>'line_no' = '1'),
  'Bank account|1000.00', 'P12 BANK debits the bank account 1020'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'debit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'm_esewa' and l->>'line_no' = '1'),
  'eSewa wallet|1000.00', 'P13 ESEWA debits the wallet account 1040'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'debit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'm_khalti' and l->>'line_no' = '1'),
  'Khalti wallet|1000.00', 'P14 KHALTI debits the wallet account 1050'
);
select is(
  (select (l->>'account_name') || '|' || (l->>'debit')::numeric
     from calls, jsonb_array_elements(payload->'journal_lines') l
    where calls.name = 'm_fallback' and l->>'line_no' = '1'),
  'Bank account|300.00', 'P15 a business with no eSewa wallet falls back to the bank account'
);
select is(
  (select count(*) from calls
    where calls.name in ('m_cash', 'm_bank', 'm_esewa', 'm_khalti', 'm_fallback')
      and (select coalesce(max((l->>'debit')::numeric), 0)
             from jsonb_array_elements(calls.payload->'journal_lines') l
            where l->>'line_no' = '1')
        <> (select coalesce(max((l->>'credit')::numeric), 0)
              from jsonb_array_elements(calls.payload->'journal_lines') l
             where l->>'line_no' = '2')),
  0::bigint, 'P16 whichever method was used, the settlement debit equals the receivable credit'
);
select is(
  (select count(*) from calls
    where calls.name in ('m_cash', 'm_bank', 'm_esewa', 'm_khalti', 'm_fallback')
      and (select count(*) from jsonb_array_elements(calls.payload->'journal_lines') l
            where l->>'line_no' = '2' and (l->>'credit')::numeric > 0
              and l->>'account_name' = 'Accounts receivable') <> 1),
  0::bigint, 'P17 every receipt credits Accounts receivable on its second line'
);

-- ---------------------------------------------------------------------------
-- Instalments: three receipts that end exactly on the total
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-1111111111aa');
set local role authenticated;
insert into calls
select 's2_a', pg_temp.receipt(pg_temp.biz_a(), pg_temp.sale_id('RCP-S2'), 400,
                               'CASH', current_date - 1, '', 'first', 'k-s2-a');
reset role;

select is(
  (select round(x.total_amount - coalesce(sum(p.amount), 0), 2)
     from public.sales x
     left join public.payments p on p.linked_sale_id = x.id
      and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
    where x.id = pg_temp.sale_id('RCP-S2')
    group by x.id, x.total_amount),
  600::numeric, 'P18 the first instalment leaves 600 outstanding'
);

select pg_temp.act_as('a1111111-1111-4111-8111-1111111111aa');
set local role authenticated;
insert into calls
select 's2_b', pg_temp.receipt(pg_temp.biz_a(), pg_temp.sale_id('RCP-S2'), 300,
                               'BANK', current_date - 1, '', 'second', 'k-s2-b');
insert into calls
select 's2_c', pg_temp.receipt(pg_temp.biz_a(), pg_temp.sale_id('RCP-S2'), 300,
                               'CASH', current_date - 1, '', 'third', 'k-s2-c');
select pg_temp.receipt_expect('s2_over', pg_temp.biz_a(), pg_temp.sale_id('RCP-S2'), 0.01,
                              'CASH', current_date - 1, '', null, 'k-s2-d');
reset role;

select is((select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('RCP-S2')),
          3::bigint, 'P19 the invoice has exactly three receipt rows — the refused one wrote nothing');
select is(
  (select round(sum(amount), 2) from public.payments where linked_sale_id = pg_temp.sale_id('RCP-S2')),
  1000::numeric, 'P20 the three instalments add up to the invoice total'
);
select is(
  (select case when round(sum(p.amount), 2) >= x.total_amount - 0.005 then 'PAID' else 'PARTIALLY_PAID' end
     from public.sales x
     join public.payments p on p.linked_sale_id = x.id
      and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
    where x.id = pg_temp.sale_id('RCP-S2')
    group by x.id, x.total_amount),
  'PAID'::text, 'P21 the derivation reports PAID once the invoice is fully received'
);
select is(
  (select count(*) from public.payments p
     join public.journal_entries je on je.id = p.journal_entry_id
    where p.linked_sale_id = pg_temp.sale_id('RCP-S2') and je.source_type = 'PAYMENT'),
  3::bigint, 'P22 each receipt owns exactly one PAYMENT journal entry'
);
select is(
  (select count(*) from (
     select je.sequence from public.journal_entries je
      where je.business_id = pg_temp.biz_a()
      group by je.sequence having count(*) > 1) x),
  0::bigint, 'P23 three receipts in one session allocated three distinct sequences'
);
select is((select sqlstate from failed where name = 's2_over'), '22023'::text,
          'P24 a fully received invoice refuses one more receipt');

-- ---------------------------------------------------------------------------
-- The embedded upfront receipt is counted exactly once
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-1111111111aa');
set local role authenticated;
select pg_temp.receipt_expect('s3_over', pg_temp.biz_a(), pg_temp.sale_id('RCP-S3'), 301,
                              'CASH', current_date - 1, '', null, 'k-s3-over');
reset role;

select is((select sqlstate from failed where name = 's3_over'), '22023'::text,
          'P25 301 is refused: the embedded 200 was already received money');
select is(
  (select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('RCP-S3')),
  1::bigint, 'P26 the refusal wrote nothing'
);
select is(
  (select count(*) from public.payments p
     join public.sales x on x.id = p.linked_sale_id
    where p.linked_sale_id = pg_temp.sale_id('RCP-S3')
      and p.journal_entry_id = x.journal_entry_id),
  1::bigint, 'P27 exactly one row still shares the invoice''s own journal entry'
);

select pg_temp.act_as('a1111111-1111-4111-8111-1111111111aa');
set local role authenticated;
insert into calls
select 's3_final', pg_temp.receipt(pg_temp.biz_a(), pg_temp.sale_id('RCP-S3'), 300,
                                   'CASH', current_date - 1, '', 'fills the invoice', 'k-s3-final');
reset role;

select is(
  (select round(sum(amount), 2) from public.payments where linked_sale_id = pg_temp.sale_id('RCP-S3')),
  500::numeric, 'P28 the embedded 200 and the posted 300 add up to the invoice total, once each'
);
select is(
  (select case when round(sum(p.amount), 2) >= x.total_amount - 0.005 then 'PAID' else 'PARTIALLY_PAID' end
     from public.sales x
     join public.payments p on p.linked_sale_id = x.id
      and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
    where x.id = pg_temp.sale_id('RCP-S3')
    group by x.id, x.total_amount),
  'PAID'::text, 'P29 the invoice derives PAID: 200 embedded + 300 received'
);

-- ---------------------------------------------------------------------------
-- Void a receipt, then receive the money again
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-1111111111aa');
set local role authenticated;
select public.void_payment(
  pg_temp.biz_a(), (select (payload->'payment'->>'id')::uuid from calls where name = 'r1')
);
reset role;

select is(
  (select p.doc_status from public.payments p where p.idempotency_key = 'k-rcp-s1a'),
  'VOIDED'::text, 'P30 the receipt is VOIDED'
);
select is(
  (select status from public.sales where id = pg_temp.sale_id('RCP-S1')),
  'POSTED'::text, 'P31 the invoice itself stays POSTED through the void'
);
select is(
  (select round(x.total_amount - coalesce(sum(p.amount), 0), 2)
     from public.sales x
     left join public.payments p on p.linked_sale_id = x.id
      and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
    where x.id = pg_temp.sale_id('RCP-S1')
    group by x.id, x.total_amount),
  1000::numeric, 'P32 the whole invoice is outstanding again after the void'
);
select is(
  (select case when coalesce(sum(p.amount), 0) >= x.total_amount - 0.005 then 'PAID' else 'UNPAID' end
     from public.sales x
     left join public.payments p on p.linked_sale_id = x.id
      and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
    where x.id = pg_temp.sale_id('RCP-S1')
    group by x.id, x.total_amount),
  'UNPAID'::text, 'P33 the voided receipt stops counting towards what was received'
);
select is(
  (select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('RCP-S1')),
  1::bigint, 'P34 the voided receipt is kept as history, never deleted'
);

select pg_temp.act_as('a1111111-1111-4111-8111-1111111111aa');
set local role authenticated;
select pg_temp.receipt_expect('s1_over', pg_temp.biz_a(), pg_temp.sale_id('RCP-S1'), 1000.01,
                              'CASH', current_date - 1, '', null, 'k-s1-over');
insert into calls
select 's1_again', pg_temp.receipt(pg_temp.biz_a(), pg_temp.sale_id('RCP-S1'), 1000,
                                   'BANK', current_date - 1, '', 'received again', 'k-s1-again');
reset role;

select is((select sqlstate from failed where name = 's1_over'), '22023'::text,
          'P35 the balance is recomputed after the void: 1000.01 is still over-settlement');
select is(
  (select count(*) from public.payments p
    where p.linked_sale_id = pg_temp.sale_id('RCP-S1') and p.doc_status = 'POSTED'),
  1::bigint, 'P36 the exact 1000 is accepted as a fresh receipt'
);
select is(
  (select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('RCP-S1')),
  2::bigint, 'P37 the invoice now has two rows: the voided receipt and the new one'
);
select is(
  (select (payload->'payment'->>'id') from calls where name = 's1_again')
    <> (select p.id::text from public.payments p where p.idempotency_key = 'k-rcp-s1a'),
  true, 'P38 receiving again is a NEW receipt, not the voided row revived'
);
select ok(
  (select (payload->'payment'->>'reference') <> (select p.reference from public.payments p
                                                   where p.idempotency_key = 'k-rcp-s1a')
     from calls where name = 's1_again'),
  'P39 it also gets a reference of its own'
);
select is(
  (select status from public.sales where id = pg_temp.sale_id('RCP-S1')),
  'POSTED'::text, 'P40 the invoice is still POSTED after the void and the re-receipt'
);
select is(
  (select case when round(sum(p.amount), 2) >= x.total_amount - 0.005 then 'PAID' else 'PARTIALLY_PAID' end
     from public.sales x
     join public.payments p on p.linked_sale_id = x.id
      and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
    where x.id = pg_temp.sale_id('RCP-S1')
    group by x.id, x.total_amount),
  'PAID'::text, 'P41 only the live receipt counts, and the invoice derives PAID'
);
select is(
  (select count(*) from (
     select je.sequence from public.journal_entries je
      where je.business_id = pg_temp.biz_a()
      group by je.sequence having count(*) > 1) x),
  0::bigint, 'P42 the void and the re-receipt left no duplicate sequence behind'
);

-- ---------------------------------------------------------------------------
-- A voided invoice cannot receive money
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-1111111111aa');
set local role authenticated;
select public.void_document(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('RCP-S4'));
select pg_temp.receipt_expect('s4_voided', pg_temp.biz_a(), pg_temp.sale_id('RCP-S4'), 100,
                              'CASH', current_date - 1, '', null, 'k-s4-receipt');
reset role;

select is((select sqlstate from failed where name = 's4_voided'), '22023'::text,
          'P43 a voided invoice refuses a receipt');
select is(
  (select count(*) from public.payments
    where linked_sale_id = pg_temp.sale_id('RCP-S4') and doc_status = 'POSTED'),
  0::bigint, 'P44 the refusal against a voided invoice wrote nothing'
);
select is(
  (select count(*) from public.payments p
    where p.linked_sale_id is not null
      and not exists (select 1 from public.sales s where s.id = p.linked_sale_id)),
  0::bigint, 'P45 every receipt points at an invoice that exists'
);
select is(
  (select count(*) from public.payments p
    where p.business_id = pg_temp.biz_a()
      and not exists (select 1 from public.journal_entries je where je.id = p.journal_entry_id)),
  0::bigint, 'P46 every receipt points at a journal entry that exists'
);

select * from finish();
rollback;
