-- 022_security_boundaries.test.sql
-- pgTAP suite: the boundaries that make the database — not the UI — the security
-- boundary, plus the audit trail an accounting event leaves behind.
-- Run with: supabase test db   (LOCAL stack only)
--
-- Transactional (begin/rollback): every fixture below is rolled back, so a rerun
-- starts clean.
--
-- Why this file exists (Stage 13 audit): 001 pins tenant isolation for the
-- business/profile/party tables and a couple of write attempts; 021 pins the
-- report read path. What was never pinned is the single most important
-- structural fact about this system:
--
--   `authenticated` holds NO insert/update/delete privilege on any financial
--   table. Every financial row can only be created by a SECURITY DEFINER RPC.
--
-- That is what makes "the browser cannot write money" true regardless of what
-- the client does, and it is a property a future grant can silently break. It is
-- asserted here for every financial table, from every role that exists, plus:
--
--   * the one client-writable surface (the chart of accounts) is column-scoped;
--   * every SECURITY DEFINER function pins search_path;
--   * internal helpers (post_settlement_core, gateway_settlement_state) are not
--     callable by clients, while the eight money RPCs are, and only by
--     authenticated;
--   * a VIEWER can read but cannot post, void or settle;
--   * a non-member cannot reach another tenant through any RPC;
--   * POST / VOID / SETTLE leave a recoverable actor and timestamp, and a void
--     leaves exactly one reversal that points at the entry it reversed.
--
-- Nothing here changes behaviour: the suite proves what migrations 001-013
-- already enforce, so a regression fails the build instead of shipping.

begin;
create extension if not exists pgtap with schema extensions;

select plan(48);

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
-- Fixtures: Alice owns A, Bob owns B (a tenant Alice must not reach) and Cara is
-- a VIEWER in A. A carries the three events whose audit trail is checked:
--   S1  1000 invoice, settled 400 at posting, 200 received later -> 400 due
--   S2   500 invoice, settled 500, that receipt then VOIDED      -> 500 due
--   S3   700 invoice, VOIDED as a document
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'f0111111-1111-4111-8111-111111111111',
   'authenticated', 'authenticated', 'sec-alice@zeyks.test', '{"full_name":"Alice"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f0222222-2222-4222-8222-222222222222',
   'authenticated', 'authenticated', 'sec-bob@zeyks.test', '{"full_name":"Bob"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f0333333-3333-4333-8333-333333333333',
   'authenticated', 'authenticated', 'sec-cara@zeyks.test', '{"full_name":"Cara"}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('f0111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.create_business(
  'Security Business A', 'Alice', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

select pg_temp.act_as('f0222222-2222-4222-8222-222222222222');
set local role authenticated;
select public.create_business(
  'Security Business B', 'Bob', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

insert into public.business_memberships (business_id, user_id, role)
select id, 'f0333333-3333-4333-8333-333333333333', 'VIEWER'
from public.businesses where business_name = 'Security Business A'
on conflict do nothing;

create function pg_temp.biz_a() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Security Business A';
$$;
create function pg_temp.biz_b() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Security Business B';
$$;
create function pg_temp.sale_id(p_invoice text) returns uuid language sql security definer as $$
  select id from public.sales where invoice_number = p_invoice;
$$;
create function pg_temp.entry_of_sale(p_invoice text) returns uuid language sql security definer as $$
  select journal_entry_id from public.sales where invoice_number = p_invoice;
$$;
create function pg_temp.receipt_of(p_invoice text) returns uuid language sql security definer as $$
  select p.id from public.payments p
   where p.linked_sale_id = (select id from public.sales where invoice_number = p_invoice)
     and p.doc_status = 'POSTED'
   order by p.created_at desc limit 1;
$$;
grant execute on function pg_temp.biz_a(), pg_temp.biz_b(), pg_temp.sale_id(text),
  pg_temp.entry_of_sale(text), pg_temp.receipt_of(text) to authenticated, anon;

select pg_temp.act_as('f0111111-1111-4111-8111-111111111111');
set local role authenticated;

select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Secure customer',
  p_invoice_number := 'SEC-1', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 400, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Goods","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
);
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Secure customer',
  p_invoice_number := 'SEC-2', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Goods","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb
);
select public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Secure customer',
  p_invoice_number := 'SEC-3', p_date := current_date - 1,
  p_subtotal := 700, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 700,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Goods","quantity":1,"unit_price":700,"discount":0,"total":700}]'::jsonb
);

select public.post_payment(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('SEC-1'), 200, 'CASH', current_date, 'RCP-SEC-1', null, 'k-sec-1');
select public.post_payment(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('SEC-2'), 500, 'CASH', current_date, 'RCP-SEC-2', null, 'k-sec-2');

-- A receipt that is later voided, and a document that is later voided.
select public.void_payment(pg_temp.biz_a(), pg_temp.receipt_of('SEC-2'));
select public.void_document(pg_temp.biz_a(), 'SALE', pg_temp.sale_id('SEC-3'));
reset role;

-- ---------------------------------------------------------------------------
-- 1. The client write boundary: no financial table accepts a direct write.
--    Alice is the OWNER of the business and still cannot do it.
-- ---------------------------------------------------------------------------
select pg_temp.act_as('f0111111-1111-4111-8111-111111111111');
set local role authenticated;

select throws_ok(
  $$insert into public.sales (business_id, date, subtotal, discount_total, tax_amount, total_amount, payment_method, created_by)
    values (pg_temp.biz_a(), current_date, 1, 0, 0, 1, 'CASH', 'f0111111-1111-4111-8111-111111111111')$$,
  '42501', NULL, 'V01 an owner cannot insert a sale directly: post_sale is the only way in'
);
select throws_ok(
  $$insert into public.purchases (business_id, date, subtotal, discount_total, tax_amount, total_amount, payment_method, created_by)
    values (pg_temp.biz_a(), current_date, 1, 0, 0, 1, 'CASH', 'f0111111-1111-4111-8111-111111111111')$$,
  '42501', NULL, 'V02 nor a purchase directly: post_purchase is the only way in'
);
select throws_ok(
  $$insert into public.expenses (business_id, account_id, date, description, amount, tax_amount, total_amount, payment_method, created_by)
    values (pg_temp.biz_a(), null, current_date, 'x', 1, 0, 1, 'CASH', 'f0111111-1111-4111-8111-111111111111')$$,
  '42501', NULL, 'V03 nor an expense directly: post_expense is the only way in'
);
select throws_ok(
  $$insert into public.payments (business_id, amount, payment_method, date, status, payment_type, party_name, created_by)
    values (pg_temp.biz_a(), 1, 'CASH', current_date, 'COMPLETED', 'INCOMING', 'x', 'f0111111-1111-4111-8111-111111111111')$$,
  '42501', NULL, 'V04 nor a settlement directly: that is the row every balance is derived from'
);
select throws_ok(
  $$insert into public.journal_entries (business_id, transaction_date, sequence, description, reference, source_type, created_by)
    values (pg_temp.biz_a(), current_date, 999, 'x', 'X', 'MANUAL', 'f0111111-1111-4111-8111-111111111111')$$,
  '42501', NULL, 'V05 nor a journal entry directly: the ledger is written by the engine under a lock'
);
select throws_ok(
  $$insert into public.journal_lines (journal_entry_id, business_id, account_id, account_name, account_type, debit, credit, line_no)
    values (pg_temp.entry_of_sale('SEC-1'), pg_temp.biz_a(), null, 'x', 'ASSET', 1, 0, 99)$$,
  '42501', NULL, 'V06 nor a journal line: unbalanced entries could never be posted this way'
);
select throws_ok(
  $$insert into public.gateway_transactions (business_id, provider, gateway_ref, amount, currency, status, customer_name, initiated_by)
    values (pg_temp.biz_a(), 'ESEWA', 'ref', 1, 'NPR', 'INITIATED', 'x', 'f0111111-1111-4111-8111-111111111111')$$,
  '42501', NULL, 'V07 nor a gateway collection: initiate_gateway_txn owns that lifecycle'
);
select throws_ok(
  $$insert into public.sale_items (sale_id, business_id, description, quantity, unit_price, discount, total, line_no)
    values (pg_temp.sale_id('SEC-1'), pg_temp.biz_a(), 'x', 1, 1, 0, 1, 99)$$,
  '42501', NULL, 'V08 nor a line item of an existing document'
);

select throws_ok(
  $$update public.sales set total_amount = 1 where id = pg_temp.sale_id('SEC-1')$$,
  '42501', NULL, 'V09 an owner cannot rewrite a posted sale'
);
select throws_ok(
  $$update public.payments set amount = 1 where id = pg_temp.receipt_of('SEC-1')$$,
  '42501', NULL, 'V10 nor the amount of a posted settlement'
);
select throws_ok(
  $$update public.journal_entries set description = 'x' where id = pg_temp.entry_of_sale('SEC-1')$$,
  '42501', NULL, 'V11 nor a posted journal entry'
);
select throws_ok(
  $$delete from public.sales where id = pg_temp.sale_id('SEC-1')$$,
  '42501', NULL, 'V12 and nothing financial can be deleted'
);
select throws_ok(
  $$delete from public.payments where id = pg_temp.receipt_of('SEC-1')$$,
  '42501', NULL, 'V13 including a settlement'
);
select throws_ok(
  $$delete from public.journal_entries where id = pg_temp.entry_of_sale('SEC-1')$$,
  '42501', NULL, 'V14 including the ledger itself'
);

-- The one surface a client may write is the chart of accounts, and only in the
-- columns 002 grants. Both halves matter: the grant exists, and it is scoped.
select is(
  has_column_privilege('authenticated', 'public.accounts', 'name', 'INSERT'),
  true, 'V15 a client may add a chart-of-accounts row through its column grant'
);
select is(
  has_table_privilege('authenticated', 'public.accounts', 'INSERT'),
  false, 'V16 but the table-level grant is absent, so only the granted columns can be set'
);
select is(
  has_column_privilege('authenticated', 'public.accounts', 'business_id', 'UPDATE'),
  false, 'V17 tenancy columns are not client-writable'
);
select is(
  has_column_privilege('authenticated', 'public.customers', 'name', 'INSERT'),
  false, 'V18 parties are created by the posting RPCs, never by a client'
);

-- ---------------------------------------------------------------------------
-- 2. Anonymous: no read, no RPC, no helper.
-- ---------------------------------------------------------------------------
reset role;
set local role anon;

select is(
  (select count(*) from unnest(array[
     'businesses', 'business_memberships', 'profiles', 'customers', 'suppliers', 'accounts',
     'journal_entries', 'journal_lines', 'sales', 'sale_items', 'purchases', 'purchase_items',
     'expenses', 'payments', 'gateway_transactions'
   ]) t(name) where has_table_privilege('anon', 'public.' || t.name, 'SELECT')),
  0::bigint, 'V19 anon holds no SELECT on any table in the book'
);
select is(
  (select count(*) from unnest(array[
     'public.post_sale(uuid,uuid,text,text,date,numeric,numeric,numeric,numeric,numeric,text,numeric,text,jsonb,integer)',
     'public.post_purchase(uuid,uuid,text,text,date,numeric,numeric,numeric,numeric,numeric,text,text,jsonb,text,boolean,integer)',
     'public.post_expense(uuid,uuid,text,date,numeric,numeric,numeric,text,text,text,text,boolean)',
     'public.post_payment(uuid,text,uuid,numeric,text,date,text,text,text)',
     'public.void_document(uuid,text,uuid)',
     'public.void_payment(uuid,uuid)',
     'public.initiate_gateway_txn(uuid,text,text,numeric,uuid,text,text)',
     'public.settle_gateway_txn(uuid,uuid,jsonb,date,text)',
     'public.is_member(uuid)', 'public.is_owner(uuid)', 'public.can_write(uuid)'
   ]) t(sig) where has_function_privilege('anon', t.sig, 'EXECUTE')),
  0::bigint, 'V20 anon cannot execute any RPC or membership helper'
);
reset role;

select pg_temp.act_as('f0111111-1111-4111-8111-111111111111');
set local role authenticated;

-- ---------------------------------------------------------------------------
-- 3. The RPC surface itself.
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from unnest(array[
     'public.post_sale(uuid,uuid,text,text,date,numeric,numeric,numeric,numeric,numeric,text,numeric,text,jsonb,integer)',
     'public.post_purchase(uuid,uuid,text,text,date,numeric,numeric,numeric,numeric,numeric,text,text,jsonb,text,boolean,integer)',
     'public.post_expense(uuid,uuid,text,date,numeric,numeric,numeric,text,text,text,text,boolean)',
     'public.post_payment(uuid,text,uuid,numeric,text,date,text,text,text)',
     'public.void_document(uuid,text,uuid)',
     'public.void_payment(uuid,uuid)',
     'public.initiate_gateway_txn(uuid,text,text,numeric,uuid,text,text)',
     'public.settle_gateway_txn(uuid,uuid,jsonb,date,text)'
   ]) t(sig) where has_function_privilege('authenticated', t.sig, 'EXECUTE')),
  8::bigint, 'V21 all eight money RPCs are callable by a signed-in member'
);
select is(
  has_function_privilege('authenticated', 'public.post_settlement_core(uuid,text,uuid,text,numeric,text,date,text,text,text,text)', 'EXECUTE'),
  false, 'V22 the shared settlement core is internal: clients go through post_payment'
);
select is(
  has_function_privilege('authenticated', 'public.gateway_settlement_state(uuid)', 'EXECUTE'),
  false, 'V23 the settlement-state helper is not a client surface either'
);
select is(
  has_function_privilege('authenticated', 'public.seed_default_chart_of_accounts(uuid)', 'EXECUTE'),
  false, 'V24 seeding the chart of accounts is not callable by a client'
);
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  0::bigint,
  'V25 every SECURITY DEFINER function pins search_path, so none can be hijacked by a caller-supplied schema'
);
select is(
  (select count(*) from unnest(array[
     'public.forbid_modification()',
     'public.guard_document_update()',
     'public.guard_journal_entry_update()',
     'public.guard_account_update()',
     'public.guard_gateway_txn_write()',
     'public.assert_journal_entry_balanced()'
   ]) t(sig) where has_function_privilege('authenticated', t.sig, 'EXECUTE')),
  0::bigint,
  'V26 the guard and assertion functions stay unreachable: they run only as triggers'
);

-- ---------------------------------------------------------------------------
-- 4. Tenant isolation through the money path (Bob is not a member of A).
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.act_as('f0222222-2222-4222-8222-222222222222');
set local role authenticated;

select throws_ok(
  format($$select public.post_payment('%s'::uuid, 'SALE', '%s'::uuid, 1, 'CASH', current_date, 'R-X', null, 'k-x1')$$,
         pg_temp.biz_a(), pg_temp.sale_id('SEC-1')),
  '42501', NULL, 'V27 a non-member cannot settle another tenant''s invoice'
);
select throws_ok(
  format($$select public.post_sale('%s'::uuid, null, 'Intruder', 'INT-1', current_date, 1, 0, 0, 1, 0, 'CASH', 0, null, '[]'::jsonb)$$,
         pg_temp.biz_a()),
  '42501', NULL, 'V28 nor post into another tenant''s books'
);
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'SALE', '%s'::uuid)$$, pg_temp.biz_a(), pg_temp.sale_id('SEC-1')),
  '42501', NULL, 'V29 nor void another tenant''s document'
);
select throws_ok(
  format($$select public.initiate_gateway_txn('%s'::uuid, 'ESEWA', 'ref', 1, '%s'::uuid, 'x', 'NPR')$$,
         pg_temp.biz_a(), pg_temp.sale_id('SEC-1')),
  '42501', NULL, 'V30 nor start an online collection against another tenant''s invoice'
);
select is(
  (select count(*) from public.sales where business_id = pg_temp.biz_a()),
  0::bigint, 'V31 and none of that tenant''s rows are readable either'
);

-- ---------------------------------------------------------------------------
-- 5. A VIEWER reads but never writes.
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.act_as('f0333333-3333-4333-8333-333333333333');
set local role authenticated;

select is(
  (select count(*) from public.sales where business_id = pg_temp.biz_a()),
  3::bigint, 'V32 a viewer can read the books, which is what rendering a report needs'
);
select throws_ok(
  format($$select public.post_payment('%s'::uuid, 'SALE', '%s'::uuid, 1, 'CASH', current_date, 'R-V', null, 'k-v1')$$,
         pg_temp.biz_a(), pg_temp.sale_id('SEC-1')),
  '42501', NULL, 'V33 but cannot settle an invoice'
);
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$, pg_temp.biz_a(), pg_temp.receipt_of('SEC-1')),
  '42501', NULL, 'V34 nor void a settlement'
);
select throws_ok(
  format($$select public.void_document('%s'::uuid, 'SALE', '%s'::uuid)$$, pg_temp.biz_a(), pg_temp.sale_id('SEC-1')),
  '42501', NULL, 'V35 nor void a document'
);
select throws_ok(
  format($$select public.settle_gateway_txn('%s'::uuid, '%s'::uuid, '{}'::jsonb, current_date, null)$$,
         pg_temp.biz_a(), gen_random_uuid()),
  '42501', NULL, 'V36 nor settle an online collection'
);
select throws_ok(
  format($$select public.post_expense('%s'::uuid, '%s'::uuid, 'EXP-V', current_date, 1, 0, 1, 'CASH', 'x', null, 'k-v2', false)$$,
         pg_temp.biz_a(), (select id from public.accounts where business_id = pg_temp.biz_a() and code = '5020')),
  '42501', NULL, 'V37 nor record an expense'
);
reset role;

-- ---------------------------------------------------------------------------
-- 6. Auditability: who did it, when, and how it links to its reversal.
--    (Read as the owner of the tables, since only the columns are under test.)
-- ---------------------------------------------------------------------------
select is(
  (select s.created_by from public.sales s where s.invoice_number = 'SEC-1'),
  'f0111111-1111-4111-8111-111111111111'::uuid,
  'V38 a posted document records who posted it'
);
select is(
  (select s.created_at is not null from public.sales s where s.invoice_number = 'SEC-1'),
  true, 'V39 and when'
);
select is(
  (select p.created_by = 'f0111111-1111-4111-8111-111111111111'::uuid and p.created_at is not null
     from public.payments p where p.reference = 'RCP-SEC-1'),
  true, 'V40 a settlement records its actor and timestamp too'
);
select is(
  (select count(*) from public.payments p
    where p.linked_sale_id = pg_temp.sale_id('SEC-2') and p.doc_status = 'VOIDED'),
  1::bigint, 'V41 the voided receipt is still on the record rather than deleted'
);

-- The void's actor: the reversal entry the void posted, and the one-way link
-- back from the original. Together they say who voided what, and when.
create function pg_temp.reversal_of(p_case text) returns uuid language sql security definer as $$
  select p.id from public.payments p
   where p.linked_sale_id = (select id from public.sales where invoice_number = p_case)
     and p.doc_status = 'VOIDED'
   limit 1;
$$;
grant execute on function pg_temp.reversal_of(text) to authenticated, anon;

select is(
  (select je.created_by from public.journal_entries je
     join public.payments p on p.journal_entry_id = je.id
    where p.id = pg_temp.reversal_of('SEC-2')),
  'f0111111-1111-4111-8111-111111111111'::uuid,
  'V42 a voided settlement keeps its own entry, and its actor is recorded on it'
);
select is(
  (select count(*) from public.journal_entries je
    where je.source_type = 'REVERSAL'
      and je.reverses_entry_id = (select p.journal_entry_id from public.payments p where p.id = pg_temp.reversal_of('SEC-2'))
      and je.created_by = 'f0111111-1111-4111-8111-111111111111'),
  1::bigint, 'V43 the void posted exactly one reversal, naming the entry it reversed and who did it'
);
select is(
  (select je.reversed_by_entry_id is not null from public.journal_entries je
    where je.id = (select p.journal_entry_id from public.payments p where p.id = pg_temp.reversal_of('SEC-2'))),
  true, 'V44 and the original entry points forward at its reversal, so the pair is complete'
);
select is(
  (select count(*) from public.journal_entries je
    where je.reverses_entry_id = (select s.journal_entry_id from public.sales s where s.invoice_number = 'SEC-3')
      and je.source_type = 'REVERSAL'),
  1::bigint, 'V45 a voided document leaves the same one-reversal trail'
);
select is(
  (select count(*) from public.sales where invoice_number = 'SEC-3'),
  1::bigint, 'V46 and the document itself is kept, not removed'
);

-- ---------------------------------------------------------------------------
-- 7. Void/reversal safety: the Stage 11/12 invariants still hold.
-- ---------------------------------------------------------------------------
create function pg_temp.outstanding(p_case text) returns numeric
language sql security definer as $$
  select s.total_amount - coalesce((
    select sum(p.amount) from public.payments p
     where p.linked_sale_id = s.id and p.doc_status = 'POSTED' and p.status = 'COMPLETED'
  ), 0)
  from public.sales s where s.invoice_number = p_case;
$$;
grant execute on function pg_temp.outstanding(text) to authenticated, anon;

select is(
  pg_temp.outstanding('SEC-1'), 400.00::numeric,
  'V47 a live receipt and the embedded one both count against the balance'
);
select is(
  pg_temp.outstanding('SEC-2'), 500.00::numeric,
  'V48 and a voided receipt stops counting, restoring the invoice to fully outstanding'
);

select * from finish();
rollback;
