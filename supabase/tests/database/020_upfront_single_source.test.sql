-- 020_upfront_single_source.test.sql
-- pgTAP suite: the settlement embedded at posting time has ONE representation,
-- and it is the `payments` row.
-- Run with: supabase test db
--
-- Transactional (begin/rollback): every fixture below is rolled back, so a rerun
-- starts clean.
--
-- Why this file exists (Stage 11 audit): a sale or purchase stores what was
-- settled at the counter in TWO places — the `upfront_paid` column, and a real
-- row in public.payments that shares the document's own journal entry. Only the
-- row is money:
--
--     Total − SUM(settlement rows that are COMPLETED and POSTED) = Outstanding
--
-- post_payment, post_settlement_core (011) and settle_gateway_txn (012) all
-- recompute from the rows and never read the column, so the two cannot drift
-- apart in a balance decision. What was never pinned is that the column cannot
-- be EDITED into disagreeing (it is a frozen posting-time snapshot: 001's
-- guard_document_update allows only `status` POSTED -> VOIDED to change), and
-- that the figure the server refuses an over-settlement against is the
-- row-derived one rather than the column. Both are asserted here, at three
-- privilege levels, because "append-only" is a claim that should be checked
-- from more than one angle.
--
-- The application-side half of the same rule — that the browser derives paid
-- amounts from rows only — is pinned in tests/run.mjs (Stage 11 block).

begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

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
-- Fixtures: one owner, one business with the seeded chart of accounts.
--   S1  1000 invoice settled 400 at the counter
--   S2   800 invoice, nothing settled at the counter
--   P1   500 bill settled 300 at the counter
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'd4444444-4444-4444-8444-444444444444',
   'authenticated', 'authenticated', 'upfront-owner@zeyks.test',
   '{"full_name":"Upfront Owner"}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('d4444444-4444-4444-8444-444444444444');
set local role authenticated;
select public.create_business(
  'Upfront Business', 'Upfront Owner', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

create function pg_temp.biz() returns uuid language sql security definer as $$
  select id from public.businesses where business_name = 'Upfront Business';
$$;
create function pg_temp.sale_id(p_invoice text) returns uuid language sql security definer as $$
  select id from public.sales where invoice_number = p_invoice;
$$;
create function pg_temp.bill_id(p_ref text) returns uuid language sql security definer as $$
  select id from public.purchases where reference_number = p_ref;
$$;
grant execute on function pg_temp.biz(), pg_temp.sale_id(text), pg_temp.bill_id(text) to authenticated, anon;

select pg_temp.act_as('d4444444-4444-4444-8444-444444444444');
set local role authenticated;

select public.post_sale(
  p_business_id := pg_temp.biz(), p_customer_id := null, p_customer_name := 'Upfront customer',
  p_invoice_number := 'UP-1', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 400, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Goods","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
);

select public.post_sale(
  p_business_id := pg_temp.biz(), p_customer_id := null, p_customer_name := 'Credit customer',
  p_invoice_number := 'UP-2', p_date := current_date - 1,
  p_subtotal := 800, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 800,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Goods","quantity":1,"unit_price":800,"discount":0,"total":800}]'::jsonb
);

select public.post_purchase(
  p_business_id := pg_temp.biz(), p_supplier_id := null, p_supplier_name := 'Upfront supplier',
  p_reference_number := 'UP-PO-1', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 300, p_payment_method := 'BANK', p_notes := null,
  p_items := '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb,
  p_idempotency_key := null, p_price_includes_vat := false
);

reset role;

-- ---------------------------------------------------------------------------
-- The header, the row, and the entry they share
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('UP-1')),
  1::bigint, 'U01 the settled 400 is exactly one settlement row'
);
select is(
  (select upfront_paid from public.sales where id = pg_temp.sale_id('UP-1')),
  400.00::numeric, 'U02 the column records the same 400 as a posting-time snapshot'
);
select is(
  (select p.amount || '|' || p.payment_type || '|' || p.party_name
     from public.payments p where p.linked_sale_id = pg_temp.sale_id('UP-1')),
  '400.00|INCOMING|Upfront customer',
  'U03 the row is the money: it carries the amount, the direction and the party'
);
select is(
  (select count(*) from public.payments p
     join public.sales s on s.id = p.linked_sale_id
    where s.id = pg_temp.sale_id('UP-1') and p.journal_entry_id = s.journal_entry_id),
  1::bigint, 'U04 the row shares the invoice''s own journal entry — it is part of that posting'
);

-- ---------------------------------------------------------------------------
-- The snapshot cannot be edited into disagreeing with the row
-- ---------------------------------------------------------------------------
create temp table attempts (who text primary key, sqlstate text, message text);
grant all on attempts to authenticated, service_role, anon;

do $u05$
declare v uuid;
begin
  v := (select id from public.sales where invoice_number = 'UP-1');
  perform set_config('role', 'postgres', true);
  begin
    update public.sales set upfront_paid = 999 where id = v;
    insert into attempts values ('superuser', 'none', 'the update was allowed');
  exception when others then
    insert into attempts values ('superuser', sqlstate, sqlerrm);
  end;
end $u05$;

do $u06$
declare v uuid;
begin
  v := (select id from public.sales where invoice_number = 'UP-1');
  perform set_config('role', 'service_role', true);
  begin
    update public.sales set upfront_paid = 999 where id = v;
    insert into attempts values ('service_role', 'none', 'the update was allowed');
  exception when others then
    insert into attempts values ('service_role', sqlstate, sqlerrm);
  end;
  perform set_config('role', 'postgres', true);
end $u06$;

do $u07$
declare v uuid;
begin
  v := (select id from public.sales where invoice_number = 'UP-1');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', 'd4444444-4444-4444-8444-444444444444', 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    update public.sales set upfront_paid = 999 where id = v;
    insert into attempts values ('authenticated', 'none', 'the update was allowed');
  exception when others then
    insert into attempts values ('authenticated', sqlstate, sqlerrm);
  end;
  perform set_config('role', 'postgres', true);
end $u07$;

select is((select sqlstate from attempts where who = 'superuser'), '23001'::text,
          'U05 even a superuser cannot edit the settled amount after posting');
select is((select sqlstate from attempts where who = 'service_role'), '23001'::text,
          'U06 nor can service_role: the immutability guard applies to every role');
select ok((select message from attempts where who = 'service_role') like '%immutable%',
          'U07 and it says why: posted documents are immutable');
select is((select sqlstate from attempts where who = 'authenticated'), '42501'::text,
          'U08 the browser is stopped earlier still — it holds no UPDATE grant on sales');
select is(
  (select upfront_paid from public.sales where id = pg_temp.sale_id('UP-1')),
  400.00::numeric, 'U09 the snapshot still reads 400 after three attempts to change it'
);

-- ---------------------------------------------------------------------------
-- The rows are what the server computes a balance from
-- ---------------------------------------------------------------------------
create temp table refusals (label text primary key, sqlstate text, message text);
grant all on refusals to authenticated, anon;

select pg_temp.act_as('d4444444-4444-4444-8444-444444444444');
set local role authenticated;

do $u10$
begin
  begin
    perform public.post_payment(pg_temp.biz(), 'SALE'::text, pg_temp.sale_id('UP-1'),
      601::numeric, 'CASH'::text, (current_date - 1)::date, ''::text, null::text, 'k-up-1a'::text);
    insert into refusals values ('s1_over', 'none', 'accepted');
  exception when others then
    insert into refusals values ('s1_over', sqlstate, sqlerrm);
  end;
end $u10$;

reset role;

select is((select sqlstate from refusals where label = 's1_over'), '22023'::text,
          'U10 one rupee over the outstanding amount is refused');
select ok((select message from refusals where label = 's1_over') like '%outstanding balance of 600.00%',
          'U11 the refusal names 600 — total less the settlement ROW, not total less nothing');

select pg_temp.act_as('d4444444-4444-4444-8444-444444444444');
set local role authenticated;
select public.post_payment(pg_temp.biz(), 'SALE'::text, pg_temp.sale_id('UP-1'),
  600::numeric, 'BANK'::text, (current_date - 1)::date, ''::text, 'the rest'::text, 'k-up-1b'::text);
reset role;

select is((select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('UP-1')),
          2::bigint, 'U12 the receipt for the remainder lands beside the embedded one');
select is(
  (select sum(amount) from public.payments where linked_sale_id = pg_temp.sale_id('UP-1')),
  1000.00::numeric, 'U13 the settlement rows now sum to the invoice total'
);
select is(
  (select upfront_paid from public.sales where id = pg_temp.sale_id('UP-1')),
  400.00::numeric,
  'U14 the column still says 400 while the rows say 1000 — and the rows are what counted'
);

select pg_temp.act_as('d4444444-4444-4444-8444-444444444444');
set local role authenticated;
do $u15$
begin
  begin
    perform public.post_payment(pg_temp.biz(), 'SALE'::text, pg_temp.sale_id('UP-1'),
      0.01::numeric, 'CASH'::text, (current_date - 1)::date, ''::text, null::text, 'k-up-1c'::text);
    insert into refusals values ('s1_closed', 'none', 'accepted');
  exception when others then
    insert into refusals values ('s1_closed', sqlstate, sqlerrm);
  end;
end $u15$;
reset role;

select is((select sqlstate from refusals where label = 's1_closed'), '22023'::text,
          'U15 a fully settled invoice takes nothing more');
select ok((select message from refusals where label = 's1_closed')
            like '%total 1000.00, already settled 1000.00%',
          'U16 the refusal reports the settled figure as 1000 — the rows, not the 400 in the snapshot');

-- ---------------------------------------------------------------------------
-- Purchases follow the same rule
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from public.payments p
     join public.purchases b on b.id = p.linked_purchase_id
    where b.id = pg_temp.bill_id('UP-PO-1') and p.journal_entry_id = b.journal_entry_id
      and p.amount = 300 and p.payment_type = 'OUTGOING'),
  1::bigint, 'U17 the bill''s settled 300 is one OUTGOING row sharing the bill''s entry'
);

select pg_temp.act_as('d4444444-4444-4444-8444-444444444444');
set local role authenticated;
do $u18$
begin
  begin
    perform public.post_payment(pg_temp.biz(), 'PURCHASE'::text, pg_temp.bill_id('UP-PO-1'),
      201::numeric, 'BANK'::text, (current_date - 1)::date, ''::text, null::text, 'k-up-po-a'::text);
    insert into refusals values ('p1_over', 'none', 'accepted');
  exception when others then
    insert into refusals values ('p1_over', sqlstate, sqlerrm);
  end;
end $u18$;
select public.post_payment(pg_temp.biz(), 'PURCHASE'::text, pg_temp.bill_id('UP-PO-1'),
  200::numeric, 'BANK'::text, (current_date - 1)::date, ''::text, 'the rest'::text, 'k-up-po-b'::text);
reset role;

select ok((select message from refusals where label = 'p1_over') like '%outstanding balance of 200.00%',
          'U18 the bill refuses 201 against a row-derived 200');
select is(
  (select sum(amount) from public.payments where linked_purchase_id = pg_temp.bill_id('UP-PO-1')),
  500.00::numeric, 'U19 the bill''s rows sum to its total, the embedded 300 counted once'
);
select is(
  (select upfront_paid from public.purchases where id = pg_temp.bill_id('UP-PO-1')),
  300.00::numeric, 'U20 and its snapshot still reads 300, independent of the live balance'
);

-- ---------------------------------------------------------------------------
-- A document with nothing settled at the counter, and the whole-business view
-- ---------------------------------------------------------------------------
select is(
  (select count(*) from public.payments where linked_sale_id = pg_temp.sale_id('UP-2')),
  0::bigint, 'U21 an invoice settled entirely on credit has no embedded row'
);

select pg_temp.act_as('d4444444-4444-4444-8444-444444444444');
set local role authenticated;
do $u22$
begin
  begin
    perform public.post_payment(pg_temp.biz(), 'SALE'::text, pg_temp.sale_id('UP-2'),
      800.01::numeric, 'CASH'::text, (current_date - 1)::date, ''::text, null::text, 'k-up-2a'::text);
    insert into refusals values ('s2_over', 'none', 'accepted');
  exception when others then
    insert into refusals values ('s2_over', sqlstate, sqlerrm);
  end;
end $u22$;
reset role;

select ok((select message from refusals where label = 's2_over') like '%outstanding balance of 800.00%',
          'U22 with nothing settled at the counter the whole 800 is outstanding');
select is(
  (select count(*) from public.sales s
    where s.business_id = pg_temp.biz() and s.status = 'POSTED'
      and s.upfront_paid > (select coalesce(sum(p.amount), 0) from public.payments p
                             where p.journal_entry_id = s.journal_entry_id
                               and p.linked_sale_id = s.id)),
  0::bigint, 'U23 no invoice claims to have settled more at the counter than its rows show'
);
select is(
  (select count(*) from public.purchases b
    where b.business_id = pg_temp.biz() and b.status = 'POSTED'
      and b.upfront_paid > (select coalesce(sum(p.amount), 0) from public.payments p
                             where p.journal_entry_id = b.journal_entry_id
                               and p.linked_purchase_id = b.id)),
  0::bigint, 'U24 no bill claims to have settled more at the counter than its rows show'
);
select is(
  (select count(*) from public.sales s
    where s.business_id = pg_temp.biz() and s.upfront_paid > 0
      and (select count(*) from public.payments p
            where p.journal_entry_id = s.journal_entry_id and p.linked_sale_id = s.id) <> 1),
  0::bigint, 'U25 a settled-at-posting amount is exactly one row per document, never zero and never two'
);
select is(
  (select count(*) from (
     select col_description('public.sales'::regclass, attnum) as documented
       from pg_attribute
      where attrelid = 'public.sales'::regclass and attname = 'upfront_paid'
     union all
     select col_description('public.purchases'::regclass, attnum)
       from pg_attribute
      where attrelid = 'public.purchases'::regclass and attname = 'upfront_paid'
   ) x where x.documented like '%NOT a live balance%'),
  2::bigint,
  'U26 both snapshot columns carry the comment saying they are not a live balance'
);
select ok(
  (select obj_description(c.oid) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'payments') like '%single source of truth%',
  'U27 public.payments carries the comment naming it the source of truth'
);

select * from finish();
rollback;
