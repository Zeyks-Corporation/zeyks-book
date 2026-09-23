-- 012_void_payment.test.sql
-- pgTAP suite for public.void_payment() RPC (migration 010).
-- Run with: supabase test db
--
-- Transactional (begin/rollback): every fixture below is rolled back, so a
-- rerun starts clean. The genuine two-session void race lives in
-- 013_void_payment_concurrency.test.sql, which has to commit its fixtures.
--
-- Observed model this suite pins down (inspected in 001/005/006/008/009, not
-- inferred):
--   * an upfront settlement written by post_sale/post_purchase shares the
--     DOCUMENT's journal entry, so it is not a separate accounting event and
--     void_payment must refuse it — voiding the document reverses it once;
--   * a post_payment settlement has its OWN journal entry
--     (source_type = 'PAYMENT', source_id = payment.id), which is the only row
--     this RPC may reverse;
--   * payments doc_status is the only column a void may change, and only
--     POSTED -> VOIDED;
--   * reconcile() counts COMPLETED + POSTED settlements, so a void raises the
--     document's outstanding balance with no write to the document at all.
--
-- Comment labels name the cases; a case may make more than one assertion.

begin;
create extension if not exists pgtap with schema extensions;

select plan(108);

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
-- Fixtures: Alice (OWNER A), Bob (OWNER B), Carol (VIEWER A), Dan (ACCOUNTANT A)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'aa111111-1111-4111-8111-111111111111',
   'authenticated', 'authenticated', 'void-alice@zeyks.test', '{"full_name":"Alice"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'bb222222-2222-4222-8222-222222222222',
   'authenticated', 'authenticated', 'void-bob@zeyks.test', '{"full_name":"Bob"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'cc333333-3333-4333-8333-333333333333',
   'authenticated', 'authenticated', 'void-carol@zeyks.test', '{"full_name":"Carol"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'dd444444-4444-4444-8444-444444444444',
   'authenticated', 'authenticated', 'void-dan@zeyks.test', '{"full_name":"Dan"}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.create_business(
  'Void Payment Business A', 'Alice', '', '', '', '', '', 'NPR', 4::smallint, true, 13::numeric, true
);
reset role;

select pg_temp.act_as('bb222222-2222-4222-8222-222222222222');
set local role authenticated;
select public.create_business('Void Payment Business B');
reset role;

do $$
declare
  v_biz_a uuid;
begin
  select id into v_biz_a from public.businesses where business_name = 'Void Payment Business A';

  insert into public.business_memberships (business_id, user_id, role)
  values (v_biz_a, 'cc333333-3333-4333-8333-333333333333', 'VIEWER'),
         (v_biz_a, 'dd444444-4444-4444-8444-444444444444', 'ACCOUNTANT');
end $$;

create function pg_temp.biz_a() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Void Payment Business A';
$$;
create function pg_temp.biz_b() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Void Payment Business B';
$$;
create function pg_temp.sale_id(p_invoice text) returns uuid language sql security definer as $$
  select id from public.sales where invoice_number = p_invoice;
$$;
create function pg_temp.purchase_id(p_reference text) returns uuid language sql security definer as $$
  select id from public.purchases where reference_number = p_reference;
$$;
create function pg_temp.payment_id(p_reference text) returns uuid language sql security definer as $$
  select id from public.payments where reference = p_reference;
$$;
grant execute on function
  pg_temp.biz_a(), pg_temp.biz_b(), pg_temp.sale_id(text),
  pg_temp.purchase_id(text), pg_temp.payment_id(text)
  to authenticated, anon;

-- Forwarders: SECURITY INVOKER on purpose, so the RPC is still called by the
-- caller's own role and identity, exactly like a direct call from the browser.
create function pg_temp.settle(
  p_biz uuid, p_type text, p_doc uuid, p_amount numeric, p_method text, p_key text
) returns uuid language sql as $$
  select ((public.post_payment(p_biz, p_type, p_doc, p_amount, p_method,
                               current_date - 1, ''::text, null::text, p_key))->'payment'->>'id')::uuid;
$$;
grant execute on function pg_temp.settle(uuid, text, uuid, numeric, text, text)
  to authenticated, anon;

create function pg_temp.vp(p_biz uuid, p_payment uuid) returns jsonb language sql as $$
  select public.void_payment(p_biz, p_payment);
$$;
grant execute on function pg_temp.vp(uuid, uuid) to authenticated, anon;

-- Whole-row snapshots so "nothing else changed" is provable.
create function pg_temp.payment_snapshot(p_id uuid) returns text language sql security definer as $$
  select p.reference || '|' || p.date || '|' || p.amount || '|' || p.payment_method || '|' ||
         p.status || '|' || p.payment_type || '|' || coalesce(p.linked_sale_id::text, '-') || '|' ||
         coalesce(p.linked_purchase_id::text, '-') || '|' || p.party_name || '|' ||
         coalesce(p.notes, '-') || '|' || p.created_by
    from public.payments p where p.id = p_id;
$$;
create function pg_temp.entry_count(p_biz uuid) returns bigint language sql security definer as $$
  select count(*) from public.journal_entries where business_id = p_biz;
$$;
create function pg_temp.line_count(p_biz uuid) returns bigint language sql security definer as $$
  select count(*) from public.journal_lines where business_id = p_biz;
$$;
grant execute on function
  pg_temp.payment_snapshot(uuid), pg_temp.entry_count(uuid), pg_temp.line_count(uuid)
  to authenticated, anon;

create temp table calls (name text primary key, payload jsonb);
create temp table snap (name text primary key, entries bigint, lines bigint, payment text);
grant all on calls to authenticated;
grant all on snap to authenticated;

-- ---------------------------------------------------------------------------
-- Documents. VP-S1: 1000 credit then settled 400. VP-S2: 1000 with 200 embedded
-- up front then settled 300. VP-S3: 500 paid in full at posting (embedded).
-- VP-P1: 500 purchase settled 300. VP-P2: 400 purchase paid at posting.
-- ---------------------------------------------------------------------------
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;

select (public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Void customer',
  p_invoice_number := 'VP-S1', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as s1 \gset

select (public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Void customer',
  p_invoice_number := 'VP-S2', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 200, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as s2 \gset

select (public.post_sale(
  p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Void customer',
  p_invoice_number := 'VP-S3', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 500, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb
))->'sale'->>'id' as s3 \gset

select (public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Void supplier',
  p_reference_number := 'VP-P1', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb,
  p_idempotency_key := null, p_price_includes_vat := false
))->'purchase'->>'id' as p1 \gset

select (public.post_purchase(
  p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Void supplier',
  p_reference_number := 'VP-P2', p_date := current_date - 1,
  p_subtotal := 400, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 400,
  p_upfront_paid := 400, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":400,"discount":0,"total":400}]'::jsonb,
  p_idempotency_key := null, p_price_includes_vat := false
))->'purchase'->>'id' as p2 \gset

reset role;

select set_config('vp.s1', :'s1', false);
select set_config('vp.s2', :'s2', false);
select set_config('vp.s3', :'s3', false);
select set_config('vp.p1', :'p1', false);
select set_config('vp.p2', :'p2', false);

-- Business B gets one settled sale, as the cross-tenant target.
select pg_temp.act_as('bb222222-2222-4222-8222-222222222222');
set local role authenticated;
select (public.post_sale(
  p_business_id := pg_temp.biz_b(), p_customer_id := null, p_customer_name := 'Bob customer',
  p_invoice_number := 'VP-B1', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as sb \gset
select pg_temp.settle(pg_temp.biz_b(), 'SALE', :'sb'::uuid, 100, 'CASH', 'k-vp-b1') as pay_b \gset
reset role;
select set_config('vp.sb', :'sb', false);
select set_config('vp.pay_b', :'pay_b', false);

-- Settlements on business A: S1 400, S2 300, P1 300.
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select pg_temp.settle(pg_temp.biz_a(), 'SALE', current_setting('vp.s1')::uuid, 400, 'BANK', 'k-vp-s1') as pay_s1 \gset
select pg_temp.settle(pg_temp.biz_a(), 'SALE', current_setting('vp.s2')::uuid, 300, 'CASH', 'k-vp-s2') as pay_s2 \gset
select pg_temp.settle(pg_temp.biz_a(), 'PURCHASE', current_setting('vp.p1')::uuid, 300, 'BANK', 'k-vp-p1') as pay_p1 \gset
reset role;

select set_config('vp.pay_s1', :'pay_s1', false);
select set_config('vp.pay_s2', :'pay_s2', false);
select set_config('vp.pay_p1', :'pay_p1', false);

-- The embedded settlements are the ones sharing their document's entry.
do $$
begin
  perform set_config('vp.emb_s3', (
    select p.id::text from public.payments p join public.sales s on s.id = p.linked_sale_id
     where p.linked_sale_id = current_setting('vp.s3')::uuid and p.journal_entry_id = s.journal_entry_id
  ), false);
  perform set_config('vp.emb_p2', (
    select p.id::text from public.payments p join public.purchases d on d.id = p.linked_purchase_id
     where p.linked_purchase_id = current_setting('vp.p2')::uuid and p.journal_entry_id = d.journal_entry_id
  ), false);
end $$;

-- ===========================================================================
-- Setup
-- ===========================================================================
select is((select count(*) from public.business_memberships where business_id = pg_temp.biz_a()),
          3::bigint, 'S01 business A has three members (owner, viewer, accountant)');
select is((select sum(p.amount) from public.payments p
            where p.linked_sale_id = current_setting('vp.s1')::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          400::numeric, 'S02 sale S1 starts 400 of 1000 settled');
select is((select sum(p.amount) from public.payments p
            where p.linked_sale_id = current_setting('vp.s2')::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          500::numeric, 'S03 sale S2 starts 500 settled (200 embedded + 300 posted)');
select is((select sum(p.amount) from public.payments p
            where p.linked_purchase_id = current_setting('vp.p1')::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          300::numeric, 'S04 purchase P1 starts 300 of 500 settled');
select is((select count(*) from public.payments p
             join public.sales s on s.id = p.linked_sale_id
            where p.linked_sale_id = current_setting('vp.s3')::uuid
              and p.journal_entry_id = s.journal_entry_id),
          1::bigint, 'S05 the settlement S3 paid at posting shares the sale''s own journal entry');
select is((select count(*) from public.payments p
             join public.sales s on s.id = p.linked_sale_id
            where p.id = current_setting('vp.pay_s1')::uuid
              and p.journal_entry_id <> s.journal_entry_id),
          1::bigint, 'S06 a post_payment settlement has its own journal entry');
select is((select je.source_type from public.journal_entries je
            where je.id = (select p.journal_entry_id from public.payments p
                            where p.id = current_setting('vp.pay_s1')::uuid)),
          'PAYMENT', 'S07 that entry is a PAYMENT event, sourced from the payment row');

-- ===========================================================================
-- Access control
-- ===========================================================================
-- C01 a JWT without a subject
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$,
         pg_temp.biz_a(), current_setting('vp.pay_s1')),
  '28000', NULL,
  'C01 unauthenticated caller is rejected'
);

-- C02 anon cannot execute the RPC at all
set local role anon;
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$,
         pg_temp.biz_a(), current_setting('vp.pay_s1')),
  '42501', NULL,
  'C02 anon holds no EXECUTE privilege on void_payment'
);
reset role;

-- C03 non-member (Alice's business, Bob calling)
select pg_temp.act_as('bb222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$,
         pg_temp.biz_a(), current_setting('vp.pay_s1')),
  '42501', NULL,
  'C03 a non-member cannot void another tenant''s settlement'
);
reset role;

-- C04 VIEWER (Carol)
select pg_temp.act_as('cc333333-3333-4333-8333-333333333333');
set local role authenticated;
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$,
         pg_temp.biz_a(), current_setting('vp.pay_s1')),
  '42501', NULL,
  'C04 a VIEWER cannot void a settlement'
);
reset role;

-- C05 a cross-tenant payment id must never resolve
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$,
         pg_temp.biz_a(), current_setting('vp.pay_b')),
  '22023', NULL,
  'C05 another business''s settlement id does not resolve under this business'
);
reset role;

-- C06 the reverse direction: a member of B naming A's payment gets "not found"
select pg_temp.act_as('bb222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$,
         pg_temp.biz_b(), current_setting('vp.pay_s1')),
  '22023', NULL,
  'C06 the reverse cross-tenant attempt does not resolve either'
);
reset role;

-- C07 a nonexistent id
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$,
         pg_temp.biz_a(), gen_random_uuid()),
  '22023', NULL,
  'C07 a nonexistent settlement id is rejected'
);

-- ===========================================================================
-- The INCOMING void (OWNER)
-- ===========================================================================
insert into snap (name, entries, lines, payment)
select 'a_before', pg_temp.entry_count(pg_temp.biz_a()), pg_temp.line_count(pg_temp.biz_a()),
       pg_temp.payment_snapshot(current_setting('vp.pay_s1')::uuid);

insert into calls (name, payload)
select 'void_in', pg_temp.vp(pg_temp.biz_a(), current_setting('vp.pay_s1')::uuid);

select is((select payload->'payment'->>'doc_status' from calls where name = 'void_in'),
          'VOIDED', 'C08 an OWNER can void a posted receipt and gets the persisted row back');
select is((select p.doc_status from public.payments p where p.id = current_setting('vp.pay_s1')::uuid),
          'VOIDED', 'C09 the payment row is VOIDED in the database');
select is((select p.status from public.payments p where p.id = current_setting('vp.pay_s1')::uuid),
          'COMPLETED', 'C10 the money movement stays COMPLETED; only the document status voids');
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_a() and p.id = current_setting('vp.pay_s1')::uuid),
          1::bigint, 'C11 the payment row is kept, never deleted');
select is((select p.amount || '|' || p.reference || '|' || p.payment_type || '|' || p.party_name
             from public.payments p where p.id = current_setting('vp.pay_s1')::uuid),
          '400.00|RCP-' || to_char(current_date - 1, 'YYYYMMDD') || '-001|INCOMING|Void customer',
          'C12 amount, reference, direction and party snapshot are untouched');
select is((select s.status from public.sales s where s.id = current_setting('vp.s1')::uuid),
          'POSTED', 'C13 the parent sale is still POSTED');

select is((select je.reversed_by_entry_id::text from public.journal_entries je
            where je.id = (select p.journal_entry_id from public.payments p
                            where p.id = current_setting('vp.pay_s1')::uuid)),
          (select payload->'reversal_journal_entry'->>'id' from calls where name = 'void_in'),
          'C14 the original entry is linked to the reversal that the response returned');
select is((select payload->'reversal_journal_entry'->>'source_type' from calls where name = 'void_in'),
          'REVERSAL', 'C15 the reversal is a REVERSAL entry');
select is((select payload->'reversal_journal_entry'->>'source_id' from calls where name = 'void_in'),
          current_setting('vp.pay_s1'),
          'C16 the reversal is sourced from the payment row');
select is((select payload->'reversal_journal_entry'->>'reverses_entry_id' from calls where name = 'void_in'),
          (select p.journal_entry_id::text from public.payments p where p.id = current_setting('vp.pay_s1')::uuid),
          'C17 the reversal points back at the settlement''s own entry');
select is((select payload->'reversal_journal_entry'->>'reference' from calls where name = 'void_in'),
          'REV-RCP-' || to_char(current_date - 1, 'YYYYMMDD') || '-001',
          'C18 the reversal carries the REV- reference');
select is((select payload->'reversal_journal_entry'->>'description' from calls where name = 'void_in'),
          'Reversal of RCP-' || to_char(current_date - 1, 'YYYYMMDD') || '-001',
          'C19 and describes what it reverses');
select is((select payload->'reversal_journal_entry'->>'transaction_date' from calls where name = 'void_in'),
          (current_date)::text, 'C20 the reversal is dated today');
select is((select payload->'reversal_journal_entry'->>'created_by' from calls where name = 'void_in'),
          'aa111111-1111-4111-8111-111111111111', 'C21 the reversal records the authenticated caller');
select is((select payload->'original_journal_entry'->>'id' from calls where name = 'void_in'),
          (select p.journal_entry_id::text from public.payments p where p.id = current_setting('vp.pay_s1')::uuid),
          'C22 the response names the original entry it reversed');

-- Exact mirror: every line the same, with debit and credit swapped.
select is(
  (select string_agg(l.line_no || ':' || l.account_id || ':' || l.account_name || ':' ||
                     l.account_type || ':' || l.debit || ':' || l.credit, ' | ' order by l.line_no)
     from public.journal_lines l
    where l.journal_entry_id = (select r.id from public.journal_entries r
                                 where r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                                               where p.id = current_setting('vp.pay_s1')::uuid))),
  (select string_agg(o.line_no || ':' || o.account_id || ':' || o.account_name || ':' ||
                     o.account_type || ':' || o.credit || ':' || o.debit, ' | ' order by o.line_no)
     from public.journal_lines o
    where o.journal_entry_id = (select p.journal_entry_id from public.payments p
                                 where p.id = current_setting('vp.pay_s1')::uuid)),
  'C23 the reversal mirrors every line — same number, account snapshot and line_no, debit/credit swapped'
);
select is(
  (select count(*) from public.journal_lines l
    where l.journal_entry_id = (select r.id from public.journal_entries r
                                 where r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                                               where p.id = current_setting('vp.pay_s1')::uuid))),
  (select count(*) from public.journal_lines o
    where o.journal_entry_id = (select p.journal_entry_id from public.payments p
                                 where p.id = current_setting('vp.pay_s1')::uuid)),
  'C24 no line is added or dropped by the mirror'
);
select is(
  (select sum(l.debit) from public.journal_lines l
    where l.journal_entry_id = (select r.id from public.journal_entries r
                                 where r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                                               where p.id = current_setting('vp.pay_s1')::uuid))),
  (select sum(o.credit) from public.journal_lines o
    where o.journal_entry_id = (select p.journal_entry_id from public.payments p
                                 where p.id = current_setting('vp.pay_s1')::uuid)),
  'C25 the reversal''s debits equal the original''s credits'
);
select is(
  (select abs(sum(l.debit) - sum(l.credit)) from public.journal_lines l
    where l.journal_entry_id = (select r.id from public.journal_entries r
                                 where r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                                               where p.id = current_setting('vp.pay_s1')::uuid))),
  0::numeric, 'C26 the reversal entry balances');
select is(
  (select count(*) from public.journal_entries r
    where r.business_id = pg_temp.biz_a()
      and r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                  where p.id = current_setting('vp.pay_s1')::uuid)),
  1::bigint, 'C27 exactly one reversal entry exists for that settlement entry');
select is(
  (select count(*) from public.journal_entries je
    where je.business_id = pg_temp.biz_a()
      and je.source_type = 'PAYMENT'
      and je.source_id = current_setting('vp.pay_s1')::uuid),
  1::bigint, 'C28 the payment still has exactly one journal entry of its own');
select is(
  (select count(*) from (
     select l.account_id from public.journal_lines l
      where l.journal_entry_id in (
        select p.journal_entry_id from public.payments p where p.id = current_setting('vp.pay_s1')::uuid
        union all
        select r.id from public.journal_entries r
         where r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                       where p.id = current_setting('vp.pay_s1')::uuid))
      group by l.account_id, l.account_name, l.account_type
     having sum(l.debit) <> sum(l.credit)) x),
  0::bigint, 'C29 the pair nets to zero on every account it touched');
select is((select count(*) from public.journal_entries je
            where je.business_id = pg_temp.biz_a()) - (select entries from snap where name = 'a_before'),
          1::bigint, 'C30 the void added exactly one entry to the ledger');
select is((select count(*) from public.journal_lines l
            where l.business_id = pg_temp.biz_a()) - (select lines from snap where name = 'a_before'),
          (select count(*) from public.journal_lines o
            where o.journal_entry_id = (select p.journal_entry_id from public.payments p
                                         where p.id = current_setting('vp.pay_s1')::uuid)),
          'C31 and exactly the original line count, no more');
select is((select coalesce(sum(p.amount), 0) from public.payments p
            where p.linked_sale_id = current_setting('vp.s1')::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          0::numeric, 'C32 reconcile() no longer counts the voided settlement');
select is((select s.total_amount - coalesce((
             select sum(p.amount) from public.payments p
              where p.linked_sale_id = s.id and p.status = 'COMPLETED' and p.doc_status = 'POSTED'), 0)
             from public.sales s where s.id = current_setting('vp.s1')::uuid),
          1000::numeric, 'C33 sale S1''s outstanding balance is back to the full 1000 (600 -> 1000)');
select is((select sum(p.amount) from public.payments p
            where p.linked_sale_id = current_setting('vp.s2')::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          500::numeric, 'C34 the void left the other sale''s settlements alone');
select is((select p.payment_snapshot from (select pg_temp.payment_snapshot(
             current_setting('vp.pay_s1')::uuid) as payment_snapshot) p),
          (select payment from snap where name = 'a_before'),
          'C35 every other column of the payment row is unchanged');
reset role;

-- ===========================================================================
-- The OUTGOING void (ACCOUNTANT)
-- ===========================================================================
select pg_temp.act_as('dd444444-4444-4444-8444-444444444444');
set local role authenticated;
insert into calls (name, payload)
select 'void_out', pg_temp.vp(pg_temp.biz_a(), current_setting('vp.pay_p1')::uuid);
reset role;

select is((select payload->'payment'->>'doc_status' from calls where name = 'void_out'),
          'VOIDED', 'C36 an ACCOUNTANT can void a supplier payment');
select is((select p.doc_status from public.payments p where p.id = current_setting('vp.pay_p1')::uuid),
          'VOIDED', 'C37 the supplier payment row is VOIDED');
select is((select d.status from public.purchases d where d.id = current_setting('vp.p1')::uuid),
          'POSTED', 'C38 the parent purchase is still POSTED');
select is((select p.payment_type || '|' || coalesce(p.linked_purchase_id::text, '-')
             from public.payments p where p.id = current_setting('vp.pay_p1')::uuid),
          'OUTGOING|' || current_setting('vp.p1'),
          'C39 the OUTGOING direction and its purchase link are untouched');
select is(
  (select string_agg(l.line_no || ':' || l.account_name || ':' || l.debit || ':' || l.credit, ' | ' order by l.line_no)
     from public.journal_lines l
    where l.journal_entry_id = (select r.id from public.journal_entries r
                                 where r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                                               where p.id = current_setting('vp.pay_p1')::uuid))),
  (select string_agg(o.line_no || ':' || o.account_name || ':' || o.credit || ':' || o.debit, ' | ' order by o.line_no)
     from public.journal_lines o
    where o.journal_entry_id = (select p.journal_entry_id from public.payments p
                                 where p.id = current_setting('vp.pay_p1')::uuid)),
  'C40 the outgoing reversal is an exact mirror too'
);
select is((select coalesce(sum(p.amount), 0) from public.payments p
            where p.linked_purchase_id = current_setting('vp.p1')::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          0::numeric, 'C41 the voided supplier payment leaves the due calculation');
select is((select d.total_amount - coalesce((
             select sum(p.amount) from public.payments p
              where p.linked_purchase_id = d.id and p.status = 'COMPLETED' and p.doc_status = 'POSTED'), 0)
             from public.purchases d where d.id = current_setting('vp.p1')::uuid),
          500::numeric, 'C42 purchase P1 is back to owing the full 500 (200 -> 500)');

-- ===========================================================================
-- Repeated requests: deterministic replay
-- ===========================================================================
insert into snap (name, entries, lines, payment)
select 'a_after_voids', pg_temp.entry_count(pg_temp.biz_a()), pg_temp.line_count(pg_temp.biz_a()),
       (select max(sequence)::text from public.journal_entries where business_id = pg_temp.biz_a());

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
insert into calls (name, payload)
select 'void_in_again', pg_temp.vp(pg_temp.biz_a(), current_setting('vp.pay_s1')::uuid);
reset role;

select is((select payload->'reversal_journal_entry'->>'id' from calls where name = 'void_in_again'),
          (select payload->'reversal_journal_entry'->>'id' from calls where name = 'void_in'),
          'C43 a repeated void returns the very same reversal');
select is((select payload->'payment'->>'doc_status' from calls where name = 'void_in_again'),
          'VOIDED', 'C44 and the same persisted VOIDED payment');
select is((select count(*) from public.journal_entries je
            where je.business_id = pg_temp.biz_a()) - (select entries from snap where name = 'a_after_voids'),
          0::bigint, 'C45 the replay wrote no journal entry');
select is((select count(*) from public.journal_lines l
            where l.business_id = pg_temp.biz_a()) - (select lines from snap where name = 'a_after_voids'),
          0::bigint, 'C46 the replay wrote no journal line');
select is((select max(sequence)::text from public.journal_entries where business_id = pg_temp.biz_a()),
          (select payment from snap where name = 'a_after_voids'),
          'C47 the replay allocated no new sequence number');
select is((select count(*) from public.journal_entries r
            where r.business_id = pg_temp.biz_a()
              and r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                          where p.id = current_setting('vp.pay_s1')::uuid)),
          1::bigint, 'C48 after three calls there is still exactly one reversal');
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_a() and p.id = current_setting('vp.pay_s1')::uuid),
          1::bigint, 'C49 and still exactly one payment row');

-- ===========================================================================
-- A partial settlement leaves the rest of the money in place
-- ===========================================================================
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
insert into calls (name, payload)
select 'void_s2', pg_temp.vp(pg_temp.biz_a(), current_setting('vp.pay_s2')::uuid);
reset role;

select is((select sum(p.amount) from public.payments p
            where p.linked_sale_id = current_setting('vp.s2')::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          200::numeric, 'C50 voiding the posted 300 leaves S2''s 200 embedded settlement counted');
select is((select s.total_amount - coalesce((
             select sum(p.amount) from public.payments p
              where p.linked_sale_id = s.id and p.status = 'COMPLETED' and p.doc_status = 'POSTED'), 0)
             from public.sales s where s.id = current_setting('vp.s2')::uuid),
          800::numeric, 'C51 so S2 owes 800 again (500 -> 800)');
select is((select s.status from public.sales s where s.id = current_setting('vp.s2')::uuid),
          'POSTED', 'C52 and S2 is still POSTED');
select is((select count(*) from public.payments p where p.linked_sale_id = current_setting('vp.s2')::uuid),
          2::bigint, 'C53 S2 keeps both settlement rows, one of them voided');

-- ===========================================================================
-- Embedded upfront settlements cannot be voided on their own
-- ===========================================================================
select isnt((select current_setting('vp.emb_s3')), '', 'C54 S3''s embedded settlement was found');
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$,
         pg_temp.biz_a(), current_setting('vp.emb_s3')),
  '23514', NULL,
  'C55 a settlement that shares its document''s journal entry is refused'
);
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$,
         pg_temp.biz_a(), current_setting('vp.emb_p2')),
  '23514', NULL,
  'C56 the same rule holds for a purchase paid at posting'
);
select is((select s.status from public.sales s where s.id = current_setting('vp.s3')::uuid),
          'POSTED', 'C57 the refused sale stays POSTED');
select is((select d.status from public.purchases d where d.id = current_setting('vp.p2')::uuid),
          'POSTED', 'C58 the refused purchase stays POSTED');
select is((select p.doc_status from public.payments p where p.id = current_setting('vp.emb_s3')::uuid),
          'POSTED', 'C59 the refused embedded settlement stays POSTED');
select is((select count(*) from public.journal_entries r
            where r.business_id = pg_temp.biz_a()
              and r.reverses_entry_id = (select s.journal_entry_id from public.sales s
                                          where s.id = current_setting('vp.s3')::uuid)),
          0::bigint, 'C60 and no reversal of the sale''s entry was written');
select is((select sum(p.amount) from public.payments p
            where p.linked_sale_id = current_setting('vp.s3')::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          500::numeric, 'C61 the refusal left the settlement amount alone');

do $$
declare
  v_msg text;
begin
  begin
    perform public.void_payment(pg_temp.biz_a(), current_setting('vp.emb_s3')::uuid);
    v_msg := '(no error)';
  exception when others then
    v_msg := sqlerrm;
  end;
  perform set_config('vp.emb_msg', v_msg, false);
end $$;

select ok((select current_setting('vp.emb_msg')) like '%void the document instead%',
          'C62 the refusal tells the caller to void the document instead');
select ok((select current_setting('vp.emb_msg')) like '%' || (select invoice_number from public.sales
            where id = current_setting('vp.s3')::uuid) || '%',
          'C63 and still names no more than the settlement''s own reference');

-- The document void remains the one way to reverse an embedded settlement: it
-- reverses the whole sale event exactly once and flips the embedded row.
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
insert into calls (name, payload)
select 'void_doc_s3', public.void_document(pg_temp.biz_a(), 'SALE', current_setting('vp.s3')::uuid);
reset role;

select is((select payload->'document'->>'status' from calls where name = 'void_doc_s3'),
          'VOIDED', 'C64 the document void still works for a document settled at posting');
select is((select count(*) from public.journal_entries r
            where r.business_id = pg_temp.biz_a()
              and r.reverses_entry_id = (select s.journal_entry_id from public.sales s
                                          where s.id = current_setting('vp.s3')::uuid)),
          1::bigint, 'C65 and creates exactly one reversal of the sale''s entry');
select is((select p.doc_status from public.payments p where p.id = current_setting('vp.emb_s3')::uuid),
          'VOIDED', 'C66 which is what flips the embedded settlement to VOIDED');
select is((select count(*) from public.payments p where p.linked_sale_id = current_setting('vp.s3')::uuid),
          1::bigint, 'C67 with no second, hidden settlement event created');

-- ===========================================================================
-- Malformed and inconsistent relationships fail closed
-- ===========================================================================
-- C68 the relationship is not merely assumed: the schema forbids a payment
-- without an entry, which is why "missing journal entry" is unrepresentable.
select is((select is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = 'payments' and column_name = 'journal_entry_id'),
          'NO', 'C68 payments.journal_entry_id is NOT NULL, so a missing entry cannot exist');

-- A hand-built payment whose entry belongs to a different source.
--
-- Stage 20 (016) makes this row impossible to create through any normal write
-- path: assert_settlement_linkage refuses it, and 026_settlement_integrity.test.sql
-- proves that refusal case by case. Here the row is built by DISABLING that one
-- trigger for the single INSERT — the documented privileged-bypass way of
-- standing in for a HISTORICAL or hand-corrupted row — so the RPC's own
-- fail-closed branch keeps being exercised against rows that predate the guard.
-- This file runs inside begin;/rollback;, so the DDL is transactional, and the
-- trigger is re-enabled immediately: nothing else in this suite runs unguarded.
do $$
declare
  v_biz uuid := pg_temp.biz_a();
  v_uid uuid := 'aa111111-1111-4111-8111-111111111111';
  v_entry uuid := gen_random_uuid();
  v_pay uuid := gen_random_uuid();
  v_seq bigint;
begin
  select coalesce(max(sequence), 0) + 1 into v_seq from public.journal_entries where business_id = v_biz;

  insert into public.journal_entries (
    id, business_id, transaction_date, sequence, description, reference,
    source_type, source_id, created_by
  ) values (
    v_entry, v_biz, current_date, v_seq, 'orphan payment event', 'ORPHAN-1',
    'PAYMENT', gen_random_uuid(), v_uid
  );
  insert into public.journal_lines (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
  select v_biz, v_entry, 1, a.id, a.name, a.type, 100, 0 from public.accounts a
   where a.business_id = v_biz and a.code = '1010';
  insert into public.journal_lines (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
  select v_biz, v_entry, 2, a.id, a.name, a.type, 0, 100 from public.accounts a
   where a.business_id = v_biz and a.code = '1030';

  execute 'alter table public.payments disable trigger payments_assert_linkage';
  insert into public.payments (
    id, business_id, reference, date, amount, payment_method, status, payment_type,
    linked_sale_id, party_name, doc_status, journal_entry_id, created_by
  ) values (
    v_pay, v_biz, 'ORPHAN-PAY', current_date - 1, 100, 'CASH', 'COMPLETED', 'INCOMING',
    current_setting('vp.s1')::uuid, 'Orphan', 'POSTED', v_entry, v_uid
  );
  execute 'alter table public.payments enable trigger payments_assert_linkage';

  perform set_config('vp.orphan', v_pay::text, false);
end $$;

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$, pg_temp.biz_a(), current_setting('vp.orphan')),
  '23514', NULL,
  'C69 a payment whose entry is sourced from something else is refused'
);
reset role;
select is((select p.doc_status from public.payments p where p.id = current_setting('vp.orphan')::uuid),
          'POSTED', 'C70 and that hand-built row is left exactly as it was');

-- A payment pointing at an entry that is itself a reversal (same one-statement
-- bypass, same historical-row reasoning as above).
do $$
declare
  v_biz uuid := pg_temp.biz_a();
  v_uid uuid := 'aa111111-1111-4111-8111-111111111111';
  v_reversal uuid;
  v_pay uuid := gen_random_uuid();
begin
  select r.id into v_reversal from public.journal_entries r
   where r.business_id = v_biz and r.source_type = 'REVERSAL'
     and r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                 where p.id = current_setting('vp.pay_s1')::uuid);

  execute 'alter table public.payments disable trigger payments_assert_linkage';
  insert into public.payments (
    id, business_id, reference, date, amount, payment_method, status, payment_type,
    linked_sale_id, party_name, doc_status, journal_entry_id, created_by
  ) values (
    v_pay, v_biz, 'REVERSAL-PAY', current_date - 1, 50, 'CASH', 'COMPLETED', 'INCOMING',
    current_setting('vp.s1')::uuid, 'Reversal target', 'POSTED', v_reversal, v_uid
  );
  execute 'alter table public.payments enable trigger payments_assert_linkage';

  perform set_config('vp.rev_pay', v_pay::text, false);
end $$;

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$, pg_temp.biz_a(), current_setting('vp.rev_pay')),
  '23514', NULL,
  'C71 a payment wired to a reversal entry is refused rather than reversed again'
);
reset role;

-- VOIDED with no reversal: inconsistent, so it cannot be silently accepted.
-- (The one trigger is disabled for the fixture INSERT, as above.)
do $$
declare
  v_biz uuid := pg_temp.biz_a();
  v_uid uuid := 'aa111111-1111-4111-8111-111111111111';
  v_entry uuid := gen_random_uuid();
  v_pay uuid := gen_random_uuid();
  v_seq bigint;
begin
  select coalesce(max(sequence), 0) + 1 into v_seq from public.journal_entries where business_id = v_biz;

  insert into public.journal_entries (
    id, business_id, transaction_date, sequence, description, reference,
    source_type, source_id, created_by
  ) values (
    v_entry, v_biz, current_date, v_seq, 'voided without reversal', 'BROKEN-VOID',
    'PAYMENT', v_pay, v_uid
  );
  insert into public.journal_lines (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
  select v_biz, v_entry, 1, a.id, a.name, a.type, 25, 0 from public.accounts a
   where a.business_id = v_biz and a.code = '1010';
  insert into public.journal_lines (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
  select v_biz, v_entry, 2, a.id, a.name, a.type, 0, 25 from public.accounts a
   where a.business_id = v_biz and a.code = '1030';

  execute 'alter table public.payments disable trigger payments_assert_linkage';
  insert into public.payments (
    id, business_id, reference, date, amount, payment_method, status, payment_type,
    linked_sale_id, party_name, doc_status, journal_entry_id, created_by
  ) values (
    v_pay, v_biz, 'BROKEN-VOID-PAY', current_date - 1, 25, 'CASH', 'COMPLETED', 'INCOMING',
    current_setting('vp.s1')::uuid, 'Broken', 'VOIDED', v_entry, v_uid
  );
  execute 'alter table public.payments enable trigger payments_assert_linkage';

  perform set_config('vp.broken', v_pay::text, false);
end $$;

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$, pg_temp.biz_a(), current_setting('vp.broken')),
  '23514', NULL,
  'C72 VOIDED without a reversal fails closed instead of reporting success'
);
reset role;

-- POSTED while its entry is already reversed: the other inconsistent direction.
do $$
declare
  v_biz uuid := pg_temp.biz_a();
  v_uid uuid := 'aa111111-1111-4111-8111-111111111111';
  v_pay uuid := gen_random_uuid();
  v_entry uuid := gen_random_uuid();
  v_rev uuid := gen_random_uuid();
  v_seq bigint;
begin
  select coalesce(max(sequence), 0) + 1 into v_seq from public.journal_entries where business_id = v_biz;
  insert into public.journal_entries (
    id, business_id, transaction_date, sequence, description, reference,
    source_type, source_id, created_by
  ) values (
    v_entry, v_biz, current_date, v_seq, 'posted payment with reversal', 'HALF-VOID',
    'PAYMENT', v_pay, v_uid
  );
  insert into public.journal_lines (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
  select v_biz, v_entry, 1, a.id, a.name, a.type, 60, 0 from public.accounts a
   where a.business_id = v_biz and a.code = '1010';
  insert into public.journal_lines (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
  select v_biz, v_entry, 2, a.id, a.name, a.type, 0, 60 from public.accounts a
   where a.business_id = v_biz and a.code = '1030';

  select coalesce(max(sequence), 0) + 1 into v_seq from public.journal_entries where business_id = v_biz;
  insert into public.journal_entries (
    id, business_id, transaction_date, sequence, description, reference,
    source_type, source_id, created_by, reverses_entry_id
  ) values (
    v_rev, v_biz, current_date, v_seq, 'Reversal from elsewhere', 'REV-HALF-VOID',
    'REVERSAL', v_pay, v_uid, v_entry
  );
  insert into public.journal_lines (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
  select v_biz, v_rev, 1, a.id, a.name, a.type, 0, 60 from public.accounts a
   where a.business_id = v_biz and a.code = '1010';
  insert into public.journal_lines (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
  select v_biz, v_rev, 2, a.id, a.name, a.type, 60, 0 from public.accounts a
   where a.business_id = v_biz and a.code = '1030';

  insert into public.payments (
    id, business_id, reference, date, amount, payment_method, status, payment_type,
    linked_sale_id, party_name, doc_status, journal_entry_id, created_by
  ) values (
    v_pay, v_biz, 'HALF-VOID-PAY', current_date - 1, 60, 'CASH', 'COMPLETED', 'INCOMING',
    current_setting('vp.s1')::uuid, 'Half voided', 'POSTED', v_entry, v_uid
  );

  update public.journal_entries set reversed_by_entry_id = v_rev where id = v_entry;
  perform set_config('vp.half', v_pay::text, false);
end $$;

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$, pg_temp.biz_a(), current_setting('vp.half')),
  '23514', NULL,
  'C73 a POSTED payment whose entry is already reversed is refused'
);
reset role;
select is((select p.doc_status from public.payments p where p.id = current_setting('vp.half')::uuid),
          'POSTED', 'C74 and is not silently flipped to VOIDED');

-- The three fixtures above borrowed the table for one statement each. Prove the
-- guard is back in place before the rest of the suite relies on it.
select is((select t.tgenabled::text from pg_trigger t
            where t.tgrelid = 'public.payments'::regclass
              and t.tgname = 'payments_assert_linkage'),
          'O', 'C74a the settlement guard is enabled again after the fixtures');

-- ===========================================================================
-- Constraint backstops: the database, not the RPC, is the last line
-- ===========================================================================
select is((select count(*) from pg_indexes
            where schemaname = 'public' and indexname = 'journal_entries_reverses_uidx'),
          1::bigint, 'C75 the one-reversal-per-entry unique index exists');

do $$
declare
  v_orig uuid;
  v_seq bigint;
  v_state text;
begin
  select p.journal_entry_id into v_orig from public.payments p
   where p.id = current_setting('vp.pay_s1')::uuid;
  select coalesce(max(sequence), 0) + 1 into v_seq from public.journal_entries
   where business_id = pg_temp.biz_a();

  begin
    insert into public.journal_entries (
      business_id, transaction_date, sequence, description, reference,
      source_type, source_id, created_by, reverses_entry_id
    ) values (
      pg_temp.biz_a(), current_date, v_seq, 'second reversal', 'REV-DUP',
      'REVERSAL', current_setting('vp.pay_s1')::uuid, 'aa111111-1111-4111-8111-111111111111', v_orig
    );
    v_state := '(none)';
  exception when others then
    v_state := sqlstate;
  end;
  perform set_config('vp.dup_state', v_state, false);
end $$;

select is((select current_setting('vp.dup_state')), '23505',
          'C76 a second reversal for the same entry is impossible by constraint even for a direct insert');

do $$
declare
  v_state text;
begin
  begin
    update public.payments set amount = 1 where id = current_setting('vp.pay_s1')::uuid;
    v_state := '(none)';
  exception when others then
    v_state := sqlstate;
  end;
  perform set_config('vp.amount_state', v_state, false);

  begin
    update public.payments set doc_status = 'POSTED' where id = current_setting('vp.pay_s1')::uuid;
    v_state := '(none)';
  exception when others then
    v_state := sqlstate;
  end;
  perform set_config('vp.unvoid_state', v_state, false);

  begin
    delete from public.payments where id = current_setting('vp.pay_s1')::uuid;
    v_state := '(none)';
  exception when others then
    v_state := sqlstate;
  end;
  perform set_config('vp.delete_state', v_state, false);
end $$;

select is((select current_setting('vp.amount_state')), '23001',
          'C77 a voided payment''s amount can never be edited');
select is((select current_setting('vp.unvoid_state')), '23001',
          'C78 a void is one-way: POSTED can only go to VOIDED');
select is((select current_setting('vp.delete_state')), '23001',
          'C79 a payment row can never be deleted');
select is((select count(*) from public.journal_lines l
            where l.journal_entry_id = (select p.journal_entry_id from public.payments p
                                         where p.id = current_setting('vp.pay_s1')::uuid)),
          2::bigint, 'C80 the original settlement''s lines are still intact and append-only');

-- ===========================================================================
-- Atomicity: a failure during the void must leave nothing behind
-- ===========================================================================
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select pg_temp.settle(pg_temp.biz_a(), 'SALE', current_setting('vp.s1')::uuid, 150, 'CASH', 'k-atomic') as new_pay \gset
reset role;
select set_config('vp.new_payment', :'new_pay', false);

insert into snap (name, entries, lines, payment)
select 'atomic_before', pg_temp.entry_count(pg_temp.biz_a()), pg_temp.line_count(pg_temp.biz_a()), null;

create function pg_temp.block_void() returns trigger language plpgsql as $$
begin
  if new.doc_status = 'VOIDED' and new.reference = current_setting('vp.block_ref', true) then
    raise exception 'injected failure after the reversal' using errcode = '55000';
  end if;
  return new;
end $$;

select set_config('vp.block_ref', (select p.reference from public.payments p
                                    where p.id = current_setting('vp.new_payment')::uuid), false);

create trigger payments_block_void before update on public.payments
  for each row execute function pg_temp.block_void();

select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.void_payment('%s'::uuid, '%s'::uuid)$$,
         pg_temp.biz_a(), current_setting('vp.new_payment')),
  '55000', NULL,
  'C81 the void fails when the update is blocked partway'
);
reset role;

drop trigger payments_block_void on public.payments;

select is((select count(*) from public.journal_entries je
            where je.business_id = pg_temp.biz_a()) - (select entries from snap where name = 'atomic_before'),
          0::bigint, 'C82 no reversal entry survived the failed void');
select is((select count(*) from public.journal_lines l
            where l.business_id = pg_temp.biz_a()) - (select lines from snap where name = 'atomic_before'),
          0::bigint, 'C83 no reversal line survived it either');
select is((select p.doc_status from public.payments p
            where p.id = current_setting('vp.new_payment')::uuid),
          'POSTED', 'C84 the payment was not left half-voided');
select is((select count(*) from public.journal_entries r
            where r.business_id = pg_temp.biz_a()
              and r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                          where p.id = current_setting('vp.new_payment')::uuid)),
          0::bigint, 'C85 and it wrote no reversal to be found later');

-- The same void then succeeds, so the failed attempt left nothing stuck.
select pg_temp.act_as('aa111111-1111-4111-8111-111111111111');
set local role authenticated;
insert into calls (name, payload)
select 'void_atomic_retry', pg_temp.vp(pg_temp.biz_a(), current_setting('vp.new_payment')::uuid);
reset role;

select is((select payload->'payment'->>'doc_status' from calls where name = 'void_atomic_retry'),
          'VOIDED', 'C86 the retry after the failure succeeds cleanly');
select is((select count(*) from public.journal_entries r
            where r.business_id = pg_temp.biz_a()
              and r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                          where p.id = current_setting('vp.new_payment')::uuid)),
          1::bigint, 'C87 with exactly one reversal, not two');

-- ===========================================================================
-- Sequence integrity across every void in this suite
-- ===========================================================================
select is((select count(*) from (
             select je.sequence from public.journal_entries je
              where je.business_id = pg_temp.biz_a()
              group by je.sequence having count(*) > 1) x),
          0::bigint, 'C88 no two entries in the business share a sequence number');
select is((select min(sequence) from public.journal_entries where business_id = pg_temp.biz_a()),
          1::bigint, 'C89 the business''s sequence still starts at 1');
select is((select count(*) from public.journal_entries r
            where r.business_id = pg_temp.biz_a() and r.source_type = 'REVERSAL'
              and r.reverses_entry_id is null),
          0::bigint, 'C90 every reversal names the entry it reverses');

-- ===========================================================================
-- Reload: what the browser reads back
-- ===========================================================================
select is(
  (select array_agg(k order by k) from (
     select jsonb_object_keys(payload) as k from calls where name = 'void_in') x),
  array['document', 'original_journal_entry', 'payment', 'reversal_journal_entry', 'reversal_journal_lines'],
  'C91 the payload carries exactly the documented keys'
);
select is((select payload->'original_journal_entry'->>'reversed_by_entry_id' from calls where name = 'void_in'),
          (select payload->'reversal_journal_entry'->>'id' from calls where name = 'void_in'),
          'C92 the reloaded original already shows its reversal link');
select is((select p.doc_status || '|' || p.status || '|' || p.amount
             from public.payments p where p.id = current_setting('vp.pay_s1')::uuid),
          'VOIDED|COMPLETED|400.00', 'C93 the persisted settlement round-trips as VOIDED');
-- The hand-built rows of the malformed-state cases are excluded by reference,
-- so these counts describe only what this RPC did.
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_a() and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
              and p.linked_sale_id = current_setting('vp.s1')::uuid
              and p.reference not in ('ORPHAN-PAY', 'REVERSAL-PAY', 'HALF-VOID-PAY')),
          0::bigint, 'C94 no live settlement is left on S1 once every void is done');
select is((select s.total_amount - coalesce((
             select sum(p.amount) from public.payments p
              where p.linked_sale_id = s.id and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
                and p.reference not in ('ORPHAN-PAY', 'REVERSAL-PAY', 'HALF-VOID-PAY')), 0)
             from public.sales s where s.id = current_setting('vp.s1')::uuid),
          1000::numeric, 'C95 reconcile derives the full 1000 outstanding again after all the voids');

-- The voided rows are still in the ledger for the audit trail.
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_a() and p.doc_status = 'VOIDED'
              and p.reference <> 'BROKEN-VOID-PAY'),
          5::bigint, 'C96 every voided settlement remains in the history');
select is((select count(*) from public.journal_entries r
            where r.business_id = pg_temp.biz_a() and r.source_type = 'REVERSAL'
              and r.reference <> 'REV-HALF-VOID'),
          5::bigint, 'C97 each void left exactly one reversal entry behind');
select is((select count(*) from (
             select je.id from public.journal_entries je
               join public.journal_lines l on l.journal_entry_id = je.id
              where je.business_id = pg_temp.biz_a()
              group by je.id having sum(l.debit) <> sum(l.credit)) x),
          0::bigint, 'C98 every entry in the business still balances');
select is((select count(*) from public.payments p
            where p.business_id = pg_temp.biz_a()
              and not exists (select 1 from public.journal_entries je where je.id = p.journal_entry_id)),
          0::bigint, 'C99 every settlement still points at an entry that exists');
select is((select count(*) from public.sales s
            where s.business_id = pg_temp.biz_a() and s.status = 'VOIDED'),
          1::bigint, 'C100 only the document that was voided on purpose is VOIDED');

select * from finish();
rollback;
