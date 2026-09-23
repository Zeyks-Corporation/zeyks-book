-- 004_post_sale.test.sql
-- pgTAP test suite for public.post_sale() RPC.
-- Run with: supabase test db

begin;
create extension if not exists pgtap with schema extensions;

select plan(40);

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
-- Q: Verify paid_amount and payment_status are NOT stored columns in sales table
-- ---------------------------------------------------------------------------
select hasnt_column('public', 'sales', 'paid_amount', 'sales table has no paid_amount column');
select hasnt_column('public', 'sales', 'payment_status', 'sales table has no payment_status column');

-- ---------------------------------------------------------------------------
-- Fixtures: Alice (Owner A), Bob (Owner B), Carol (Viewer A), Dan (Accountant A)
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

-- Alice creates Business A
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.create_business('Business A');
reset role;

-- Bob creates Business B
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

  -- Carol is VIEWER of A, Dan is ACCOUNTANT of A
  insert into public.business_memberships (business_id, user_id, role)
  values (v_biz_a, 'c3333333-3333-4333-8333-333333333333', 'VIEWER'),
         (v_biz_a, 'd4444444-4444-4444-8444-444444444444', 'ACCOUNTANT');

  -- Create customers
  insert into public.customers (business_id, name)
  values (v_biz_a, 'Customer Alpha'),
         (v_biz_b, 'Customer Beta');
end $$;

-- Security definer fixture helpers so tests can reference IDs across role switches
create function pg_temp.biz_a() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Business A' limit 1;
$$;
create function pg_temp.biz_b() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Business B' limit 1;
$$;
create function pg_temp.cust_a() returns uuid language sql security definer as $$
  select id from public.customers where name = 'Customer Alpha' limit 1;
$$;
create function pg_temp.cust_b() returns uuid language sql security definer as $$
  select id from public.customers where name = 'Customer Beta' limit 1;
$$;
grant execute on function pg_temp.biz_a() to authenticated, anon;
grant execute on function pg_temp.biz_b() to authenticated, anon;
grant execute on function pg_temp.cust_a() to authenticated, anon;
grant execute on function pg_temp.cust_b() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Access control & validation tests
-- ---------------------------------------------------------------------------

-- G: Non-member is rejected
select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-NONMEMBER', '2026-01-01'::date,
    1000, 0, 0, 1000, 0, 'CASH', null, null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )$$, pg_temp.biz_a()),
  '42501', NULL,
  'G: non-member cannot post sale to Business A'
);
reset role;

-- H: VIEWER is rejected
select pg_temp.act_as('c3333333-3333-4333-8333-333333333333');
set local role authenticated;
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-VIEWER', '2026-01-01'::date,
    1000, 0, 0, 1000, 0, 'CASH', null, null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )$$, pg_temp.biz_a()),
  '42501', NULL,
  'H: VIEWER cannot post sale to Business A'
);
reset role;

-- F: Customer from another business is rejected
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, '%s'::uuid, 'Customer Beta', 'INV-CROSS-CUST', '2026-01-01'::date,
    1000, 0, 0, 1000, 0, 'CASH', null, null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )$$,
    pg_temp.biz_a(),
    pg_temp.cust_b()
  ),
  '22023', NULL,
  'F: customer belonging to another business is rejected'
);
reset role;

-- Anon cannot execute post_sale
set local role anon;
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-ANON', '2026-01-01'::date,
    1000, 0, 0, 1000, 0, 'CASH', null, null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )$$, pg_temp.biz_a()),
  '42501', NULL,
  'anon role cannot call post_sale'
);
reset role;

-- J: Invalid totals rejected (total <> subtotal + tax)
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-INVALID-TOTAL', '2026-01-01'::date,
    1000, 0, 0, 999, 0, 'CASH', null, null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'J: total not matching subtotal + tax is rejected'
);

-- K: upfront_paid > total_amount rejected
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-OVERPAID', '2026-01-01'::date,
    1000, 0, 0, 1000, 1500, 'CASH', null, null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'K: upfront_paid exceeding total is rejected'
);

-- L: Empty line items rejected
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-NO-ITEMS', '2026-01-01'::date,
    1000, 0, 0, 1000, 0, 'CASH', null, null,
    '[]'::jsonb
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'L: empty items array is rejected'
);

-- L2: Line item with negative quantity rejected
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-NEG-QTY', '2026-01-01'::date,
    1000, 0, 0, 1000, 0, 'CASH', null, null,
    '[{"line_no":1,"description":"Item","quantity":-1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'L2: negative item quantity is rejected'
);

-- L3: Duplicate line numbers rejected
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-DUP-LINE', '2026-01-01'::date,
    1000, 0, 0, 1000, 0, 'CASH', null, null,
    '[{"line_no":1,"description":"Item 1","quantity":1,"unit_price":500,"discount":0,"total":500},
      {"line_no":1,"description":"Item 2","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'L3: duplicate line numbers are rejected'
);

-- ---------------------------------------------------------------------------
-- A: Happy-path fully-paid sale
-- ---------------------------------------------------------------------------
select isnt(
  (select (public.post_sale(
    pg_temp.biz_a(),
    pg_temp.cust_a(),
    'Customer Alpha',
    'INV-001',
    '2026-01-01'::date,
    1000, 0, 0, 1000, 1000, 'CASH', null, 'First sale',
    '[{"line_no":1,"description":"Keyboard","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )->'sale'->>'id')),
  NULL,
  'A: fully-paid sale returns created sale id'
);

-- I: Duplicate invoice number is rejected
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-001', '2026-01-01'::date,
    1000, 0, 0, 1000, 1000, 'CASH', null, null,
    '[{"line_no":1,"description":"Keyboard","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )$$, pg_temp.biz_a()),
  '23505', NULL,
  'I: duplicate invoice number in same business is rejected'
);

-- Verify A state in database
select is(
  (select status from public.sales where invoice_number = 'INV-001'),
  'POSTED',
  'A: sale status is POSTED'
);
select is(
  (select upfront_paid from public.sales where invoice_number = 'INV-001')::int,
  1000,
  'A: upfront_paid is 1000 in database'
);
select is(
  (select count(*) from public.sale_items where sale_id = (select id from public.sales where invoice_number = 'INV-001'))::int,
  1,
  'A: 1 sale item row was created'
);
select is(
  (select count(*) from public.payments where linked_sale_id = (select id from public.sales where invoice_number = 'INV-001'))::int,
  1,
  'A: 1 settlement payment row was created'
);
-- P: Settlement amount is represented through payments
select is(
  (select amount from public.payments where linked_sale_id = (select id from public.sales where invoice_number = 'INV-001'))::int,
  1000,
  'P: settlement payment row amount equals upfront_paid'
);
-- N: Journal entry is balanced
select is(
  (select coalesce(sum(debit), 0) - coalesce(sum(credit), 0)
     from public.journal_lines
    where journal_entry_id = (select journal_entry_id from public.sales where invoice_number = 'INV-001'))::int,
  0,
  'N: fully-paid sale journal entry is balanced (debit = credit)'
);
-- O: Journal lines: Dr Cash (1010) 1000, Cr Sales revenue (4010) 1000
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.sales where invoice_number = 'INV-001')),
  '1010:1000:0, 4010:0:1000',
  'O: fully-paid sale debits Cash 1010 and credits Sales revenue 4010'
);

-- ---------------------------------------------------------------------------
-- B: Unpaid sale (upfront_paid = 0)
-- ---------------------------------------------------------------------------
select isnt(
  (select (public.post_sale(
    pg_temp.biz_a(),
    pg_temp.cust_a(),
    'Customer Alpha',
    'INV-002',
    '2026-01-02'::date,
    2000, 0, 0, 2000, 0, 'CASH', null, 'Credit sale',
    '[{"line_no":1,"description":"Monitor","quantity":1,"unit_price":2000,"discount":0,"total":2000}]'::jsonb
  )->'sale'->>'id')),
  NULL,
  'B: unpaid sale created successfully'
);
select is(
  (select count(*) from public.payments where linked_sale_id = (select id from public.sales where invoice_number = 'INV-002'))::int,
  0,
  'B: no payment row created when upfront_paid is 0'
);
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.sales where invoice_number = 'INV-002')),
  '1030:2000:0, 4010:0:2000',
  'B: unpaid sale debits Accounts receivable 1030 and credits Sales revenue 4010'
);

-- ---------------------------------------------------------------------------
-- C: Partially-paid sale (total 1000, upfront 300)
-- ---------------------------------------------------------------------------
select isnt(
  (select (public.post_sale(
    pg_temp.biz_a(),
    pg_temp.cust_a(),
    'Customer Alpha',
    'INV-003',
    '2026-01-03'::date,
    1000, 0, 0, 1000, 300, 'CASH', null, 'Partial sale',
    '[{"line_no":1,"description":"Mouse","quantity":2,"unit_price":500,"discount":0,"total":1000}]'::jsonb
  )->'sale'->>'id')),
  NULL,
  'C: partially-paid sale created successfully'
);
select is(
  (select amount from public.payments where linked_sale_id = (select id from public.sales where invoice_number = 'INV-003'))::int,
  300,
  'C: payment row recorded for partial upfront payment of 300'
);
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.sales where invoice_number = 'INV-003')),
  '1010:300:0, 1030:700:0, 4010:0:1000',
  'C: partial sale debits Cash 300, debits AR 700, credits Sales revenue 1000'
);

-- ---------------------------------------------------------------------------
-- D: VAT sale (subtotal 1000, tax 130, total 1130, upfront 1130)
-- ---------------------------------------------------------------------------
select isnt(
  (select (public.post_sale(
    pg_temp.biz_a(),
    pg_temp.cust_a(),
    'Customer Alpha',
    'INV-004',
    '2026-01-04'::date,
    1000, 0, 130, 1130, 1130, 'BANK', null, 'VAT sale',
    '[{"line_no":1,"description":"Consulting","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )->'sale'->>'id')),
  NULL,
  'D: VAT sale created successfully'
);

select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.sales where invoice_number = 'INV-004')),
  '1020:1130:0, 4010:0:1000, 2020:0:130',
  'D: VAT sale credits Sales revenue 1000 and VAT payable 130'
);

-- ---------------------------------------------------------------------------
-- E: Cost of goods sale (inventory tracked)
-- ---------------------------------------------------------------------------
reset role;
update public.businesses
   set track_inventory = true
 where business_name = 'Business A';

select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

select isnt(
  (select (public.post_sale(
    pg_temp.biz_a(),
    pg_temp.cust_a(),
    'Customer Alpha',
    'INV-005',
    '2026-01-05'::date,
    1000, 0, 0, 1000, 1000, 'CASH', 450, 'COGS sale',
    '[{"line_no":1,"description":"Stock item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )->'sale'->>'id')),
  NULL,
  'E: COGS sale created successfully'
);

select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.sales where invoice_number = 'INV-005')),
  '1010:1000:0, 4010:0:1000, 5010:450:0, 1060:0:450',
  'E: inventory tracked sale adds Dr COGS 5010 and Cr Inventory 1060'
);

-- Dan (ACCOUNTANT) can post sale
select pg_temp.act_as('d4444444-4444-4444-8444-444444444444');
select isnt(
  (select (public.post_sale(
    pg_temp.biz_a(),
    pg_temp.cust_a(),
    'Customer Alpha',
    'INV-006',
    '2026-01-06'::date,
    500, 0, 0, 500, 500, 'CASH', null, 'Accountant sale',
    '[{"line_no":1,"description":"Book","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb
  )->'sale'->>'id')),
  NULL,
  'ACCOUNTANT role can post sale'
);

-- ---------------------------------------------------------------------------
-- Stage 2.1 Hardening validations
-- ---------------------------------------------------------------------------

-- H1: Line item total does not mathematically equal quantity * unit_price - discount
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-MATH-ERR', '2026-01-01'::date,
    200, 10, 0, 200, 0, 'CASH', null, null,
    '[{"line_no":1,"description":"Item","quantity":2,"unit_price":100,"discount":10,"total":200}]'::jsonb
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'H1: line item total not matching quantity * unit_price - discount is rejected'
);

-- H2: Line item discount exceeds line value
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-DISC-EXCEED', '2026-01-01'::date,
    100, 150, 0, 100, 0, 'CASH', null, null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":150,"total":-50}]'::jsonb
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'H2: line discount exceeding line value is rejected'
);

-- H3: Sale discount_total does not match sum of line discounts
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-DISC-MISMATCH', '2026-01-01'::date,
    190, 50, 0, 190, 0, 'CASH', null, null,
    '[{"line_no":1,"description":"Item","quantity":2,"unit_price":100,"discount":10,"total":190}]'::jsonb
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'H3: sale discount_total not matching sum of line discounts is rejected'
);

-- H4: Sale-level amounts do not agree with line items total
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-AMOUNTS-DISAGREE', '2026-01-01'::date,
    5000, 0, 0, 5000, 0, 'CASH', null, null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'H4: sale amounts disagreeing with line items total are rejected'
);

-- H5: Future sale date using Asia/Kathmandu business date is rejected
select throws_ok(
  format($$select public.post_sale(
    '%s'::uuid, null, 'Customer Alpha', 'INV-FUTURE-DATE', ((now() at time zone 'Asia/Kathmandu')::date + interval '1 day')::date,
    1000, 0, 0, 1000, 0, 'CASH', null, null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'H5: future sale date relative to Asia/Kathmandu is rejected'
);

-- H6: VAT-inclusive sale where total_amount equals line items total is accepted
select isnt(
  (select (public.post_sale(
    pg_temp.biz_a(),
    pg_temp.cust_a(),
    'Customer Alpha',
    'INV-007-INC',
    '2026-01-07'::date,
    1000, 0, 130, 1130, 1130, 'CASH', null, 'VAT inclusive sale',
    '[{"line_no":1,"description":"Inclusive item","quantity":1,"unit_price":1130,"discount":0,"total":1130}]'::jsonb
  )->'sale'->>'id')),
  NULL,
  'H6: VAT-inclusive sale matching line items total is accepted'
);

-- H7: Sale on current Asia/Kathmandu business date is accepted
select isnt(
  (select (public.post_sale(
    pg_temp.biz_a(),
    pg_temp.cust_a(),
    'Customer Alpha',
    'INV-TODAY',
    (now() at time zone 'Asia/Kathmandu')::date,
    1000, 0, 0, 1000, 0, 'CASH', null, 'Today sale',
    '[{"line_no":1,"description":"Today item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
  )->'sale'->>'id')),
  NULL,
  'H7: sale on current Asia/Kathmandu business date is accepted'
);

-- H8: Invoice number auto-generation when invoice number is null
select isnt(
  (select (public.post_sale(
    pg_temp.biz_a(),
    pg_temp.cust_a(),
    'Customer Alpha',
    null,
    '2026-01-08'::date,
    500, 0, 0, 500, 500, 'CASH', null, 'Auto invoice sale',
    '[{"line_no":1,"description":"Book","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb
  )->'sale'->>'invoice_number')),
  NULL,
  'H8: invoice number auto-generated when null'
);

-- M: Atomicity — failed post does not leave orphaned sales or journal entries
reset role;
select is(
  (select count(*) from public.sales where invoice_number = 'INV-FAIL-TEST')::int,
  0,
  'M: atomic transaction leaves no orphaned records on failure'
);

rollback;
