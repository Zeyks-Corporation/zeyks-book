-- 023_settlement_workflow.test.sql
-- pgTAP suite: the SETTLEMENT WORKFLOW as one continuous story, in both
-- directions, with the ledger and the documents checked against each other at
-- every step.
-- Run with: supabase test db   (LOCAL stack only)
--
-- Transactional (begin/rollback): every fixture below is rolled back, so a rerun
-- starts clean. The genuine two-session races live in 011/013/017/019 (concurrent
-- settlement against one balance, settlement racing a document void, settlement
-- racing a settlement void) and are deliberately not repeated here.
--
-- Why this file exists (Stage 15 audit): the per-step mechanics were already
-- pinned — 009 the shared settlement rules, 012 voiding a receipt, 016/017 the
-- purchase side, 018/019 the receipt lifecycle, 020 the frozen snapshot. What no
-- suite asserted is the thing an accountant would actually check:
--
--   the ACCOUNTS RECEIVABLE control account (1030) equals the sum, over every
--   POSTED invoice, of (total − valid settlements) — and likewise 2010 for
--   purchases.
--
-- The application derives a customer's or supplier's balance from the documents,
-- while the dashboard shows receivable/payable from the LEDGER. Two
-- representations of one number: if a settlement is ever re-linked, mis-linked or
-- under-reversed, the two silently diverge and nothing notices. This suite walks a
-- credit sale and a credit purchase through partial, full, void and
-- re-settlement, and asserts after every single step that the two representations
-- still agree.
--
-- It also pins the states a person actually sees:
--   UNPAID -> PARTIALLY_PAID -> PAID -> (void) -> PARTIALLY_PAID -> PAID,
--   a voided document contributing nothing to either side,
--   the embedded upfront settlement counted exactly once,
--   over-settlement and voided-document settlement refused, with no state change.
--
-- Nothing here changes behaviour: it proves what migrations 001-013 already
-- enforce, so a regression fails the build instead of quietly producing books
-- that do not agree with themselves.

begin;
create extension if not exists pgtap with schema extensions;

select plan(64);

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
-- Fixtures: one owner, one business with the real seeded chart of accounts.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'f1f1f1f1-1111-4111-8111-11111111f1f1',
   'authenticated', 'authenticated', 'flow-owner@zeyks.test', '{"full_name":"Flow Owner"}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select public.create_business(
  'Workflow Business A', 'Flow Owner', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

/* -------------------------------------------------------------------------- */
/* Read models, expressed the way the application expresses them              */
/* -------------------------------------------------------------------------- */

create function pg_temp.biz() returns uuid
language sql security definer set search_path = '' as $$
  select id from public.businesses where business_name = 'Workflow Business A';
$$;

/** Ledger balance of one account code: the CONTROL ACCOUNT view. */
create function pg_temp.ledger(p_code text) returns numeric
language sql security definer set search_path = '' as $$
  select coalesce(sum(l.debit - l.credit), 0)::numeric(16,2)
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where a.business_id = pg_temp.biz()
     and a.code = p_code;
$$;

/** Valid settlement rows for one document: the same predicate the app sums. */
create function pg_temp.settled(p_doc uuid) returns numeric
language sql security definer set search_path = '' as $$
  select coalesce(sum(p.amount), 0)::numeric(16,2)
    from public.payments p
   where p.business_id = pg_temp.biz()
     and (p.linked_sale_id = p_doc or p.linked_purchase_id = p_doc)
     and p.status = 'COMPLETED'
     and p.doc_status = 'POSTED';
$$;

/** What every POSTED invoice still owes, summed: the DOCUMENT view. */
create function pg_temp.doc_receivable() returns numeric
language sql security definer set search_path = '' as $$
  select coalesce(sum(s.total_amount - pg_temp.settled(s.id)), 0)::numeric(16,2)
    from public.sales s
   where s.business_id = pg_temp.biz()
     and s.status = 'POSTED';
$$;

/**
 * The payable control account as an amount OWED: 2010 is a liability, so its
 * natural balance is a credit. `ledger()` reports debit − credit for every
 * code, which is why this is not simply ledger('2010').
 */
create function pg_temp.payable() returns numeric
language sql security definer set search_path = '' as $$
  select -pg_temp.ledger('2010');
$$;

/** What every POSTED bill still owes, summed. */
create function pg_temp.doc_payable() returns numeric
language sql security definer set search_path = '' as $$
  select coalesce(sum(p.total_amount - pg_temp.settled(p.id)), 0)::numeric(16,2)
    from public.purchases p
   where p.business_id = pg_temp.biz()
     and p.status = 'POSTED';
$$;

/**
 * The invariant this suite exists for: the control accounts and the documents
 * must agree. Reports the numbers when they do not, so a failure is diagnosable
 * from the test output alone.
 */
create function pg_temp.books_agree(p_step text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_ar numeric := pg_temp.ledger('1030');
  v_ap numeric := pg_temp.payable();
  v_dr numeric := pg_temp.doc_receivable();
  v_dp numeric := pg_temp.doc_payable();
begin
  raise notice '%: receivable ledger % = documents % | payable ledger % = documents %',
    p_step, v_ar, v_dr, v_ap, v_dp;
  return v_ar = v_dr and v_ap = v_dp;
end $$;

create function pg_temp.sale(p_invoice text) returns uuid
language sql security definer set search_path = '' as $$
  select id from public.sales where business_id = pg_temp.biz() and invoice_number = p_invoice;
$$;

create function pg_temp.bill(p_ref text) returns uuid
language sql security definer set search_path = '' as $$
  select id from public.purchases where business_id = pg_temp.biz() and reference_number = p_ref;
$$;

create function pg_temp.status_of(p_doc uuid) returns text
language sql security definer set search_path = '' as $$
  select case
    when x.total_amount - pg_temp.settled(x.id) <= 0.005 then 'PAID'
    when pg_temp.settled(x.id) <= 0.005 then 'UNPAID'
    else 'PARTIALLY_PAID'
  end
  from public.sales x where x.id = p_doc;
$$;

grant execute on function
  pg_temp.biz(), pg_temp.ledger(text), pg_temp.payable(), pg_temp.settled(uuid),
  pg_temp.doc_receivable(), pg_temp.doc_payable(), pg_temp.books_agree(text),
  pg_temp.sale(text), pg_temp.bill(text), pg_temp.status_of(uuid)
  to authenticated, anon;

create temp table calls (name text primary key, payload jsonb);
grant all on calls to authenticated;

create temp table attempts (name text primary key, sqlstate text, message text, payload jsonb);
grant all on attempts to authenticated;

/** Settle, recording either the payload or the refusal. Never aborts the suite. */
create function pg_temp.try_settle(
  p_name text, p_biz uuid, p_type text, p_doc uuid, p_amount numeric,
  p_method text default 'CASH', p_key text default null
) returns void language plpgsql as $$
declare
  v_payload jsonb;
begin
  begin
    v_payload := public.post_payment(
      p_biz, p_type, p_doc, p_amount, p_method, current_date, '', 'workflow check', p_key
    );
    insert into attempts values (p_name, 'none', 'no error was raised', v_payload);
    insert into calls values (p_name, v_payload) on conflict (name) do update set payload = excluded.payload;
  exception when others then
    insert into attempts values (p_name, sqlstate, sqlerrm, null);
  end;
end $$;

create function pg_temp.try_void_document(p_name text, p_biz uuid, p_type text, p_doc uuid)
returns void language plpgsql as $$
begin
  begin
    perform public.void_document(p_biz, p_type, p_doc);
    insert into attempts values (p_name, 'none', 'no error was raised', null);
  exception when others then
    insert into attempts values (p_name, sqlstate, sqlerrm, null);
  end;
end $$;

grant execute on function
  pg_temp.try_settle(text, uuid, text, uuid, numeric, text, text),
  pg_temp.try_void_document(text, uuid, text, uuid)
  to authenticated, anon;

/* -------------------------------------------------------------------------- */
/* CUSTOMER SIDE: a 1000 credit invoice, settled piece by piece               */
/* -------------------------------------------------------------------------- */

select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select public.post_sale(
  p_business_id := pg_temp.biz(), p_customer_id := null, p_customer_name := 'Workflow customer',
  p_invoice_number := 'W-1', p_date := current_date, p_subtotal := 1000, p_discount_total := 0,
  p_tax_amount := 0, p_total_amount := 1000, p_upfront_paid := 0, p_payment_method := 'CASH',
  p_cost_of_goods := null, p_notes := 'workflow',
  p_items := '[{"line_no":1,"description":"work","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
);
reset role;

select is(pg_temp.settled(pg_temp.sale('W-1')), 0::numeric,
  'W1 a credit invoice starts with nothing settled');

select is(pg_temp.ledger('1030'), 1000::numeric,
  'W2 the whole invoice sits in accounts receivable');

select ok(pg_temp.books_agree('after posting a credit invoice'),
  'W3 the receivable control account equals the documents');

select is(pg_temp.status_of(pg_temp.sale('W-1')), 'UNPAID'::text,
  'W4 and the invoice derives UNPAID');

/* --- first instalment --------------------------------------------------- */
select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select pg_temp.try_settle('p1', pg_temp.biz(), 'SALE', pg_temp.sale('W-1'), 400, 'CASH', 'k-flow-p1');
reset role;

select is(pg_temp.settled(pg_temp.sale('W-1')), 400::numeric, 'W5 the receipt settles 400');
select is(pg_temp.ledger('1030'), 600::numeric, 'W6 and takes 400 off the receivable control account');
select ok(pg_temp.books_agree('after the first instalment'),
  'W7 the two representations still agree');
select is(pg_temp.status_of(pg_temp.sale('W-1')), 'PARTIALLY_PAID'::text,
  'W8 and the invoice derives PARTIALLY_PAID');

/* --- second instalment, another method ---------------------------------- */
select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select pg_temp.try_settle('p2', pg_temp.biz(), 'SALE', pg_temp.sale('W-1'), 250, 'BANK', 'k-flow-p2');
reset role;

select is(pg_temp.settled(pg_temp.sale('W-1')), 650::numeric, 'W9 instalments accumulate');
select is(pg_temp.ledger('1030'), 350::numeric, 'W10 and so does the reduction of the control account');
select ok(pg_temp.books_agree('after the second instalment'),
  'W11 the two representations still agree');

/* --- over-settlement ---------------------------------------------------- */
select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select pg_temp.try_settle('over', pg_temp.biz(), 'SALE', pg_temp.sale('W-1'), 400, 'CASH', 'k-flow-over');
reset role;

select is((select sqlstate from attempts where name = 'over'), '22023'::text,
  'W12 collecting more than is outstanding is refused');
select ok((select message from attempts where name = 'over') like '%exceeds the outstanding balance%',
  'W13 and the refusal says what the balance is');
select is(pg_temp.settled(pg_temp.sale('W-1')), 650::numeric,
  'W14 the refused attempt settled nothing');
select is(pg_temp.ledger('1030'), 350::numeric,
  'W15 and moved no money in the ledger');
select ok(pg_temp.books_agree('after a refused over-settlement'),
  'W16 the two representations still agree');

/* --- final instalment, through a wallet --------------------------------- */
select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select pg_temp.try_settle('p3', pg_temp.biz(), 'SALE', pg_temp.sale('W-1'), 350, 'ESEWA', 'k-flow-p3');
reset role;

select is(pg_temp.settled(pg_temp.sale('W-1')), 1000::numeric, 'W17 the invoice is fully settled');
select is(pg_temp.ledger('1030'), 0::numeric, 'W18 and nothing is left in receivable');
select ok(pg_temp.books_agree('after the final instalment'),
  'W19 the two representations still agree');
select is(pg_temp.ledger('1040'), 350::numeric,
  'W20 an eSewa receipt debits the eSewa wallet, not cash');
select is(pg_temp.status_of(pg_temp.sale('W-1')), 'PAID'::text, 'W21 and the invoice derives PAID');

/* --- void the final settlement ------------------------------------------ */
select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select public.void_payment(
  pg_temp.biz(), (select (payload->'payment'->>'id')::uuid from calls where name = 'p3')
);
reset role;

select is(
  (select p.doc_status from public.payments p where p.idempotency_key = 'k-flow-p3'),
  'VOIDED'::text, 'W22 the voided receipt is kept and marked VOIDED');
select is(
  (select count(*) from public.payments where linked_sale_id = pg_temp.sale('W-1')),
  3::bigint, 'W23 no settlement row was deleted');
select is(pg_temp.settled(pg_temp.sale('W-1')), 650::numeric,
  'W24 the voided receipt stops counting towards what was received');
select is(pg_temp.ledger('1030'), 350::numeric,
  'W25 and its reversal puts the money back into receivable');
select ok(pg_temp.books_agree('after voiding a receipt'),
  'W26 the two representations still agree');
select is(
  (select status from public.sales where id = pg_temp.sale('W-1')),
  'POSTED'::text, 'W27 the invoice itself stays POSTED through the void');
select is(pg_temp.status_of(pg_temp.sale('W-1')), 'PARTIALLY_PAID'::text,
  'W28 so the invoice derives PARTIALLY_PAID again');

/* --- receive the money again ------------------------------------------- */
select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select pg_temp.try_settle('p4', pg_temp.biz(), 'SALE', pg_temp.sale('W-1'), 350, 'CASH', 'k-flow-p4');
reset role;

select is(pg_temp.settled(pg_temp.sale('W-1')), 1000::numeric,
  'W29 the money can be received again after the void');
select is(pg_temp.ledger('1030'), 0::numeric, 'W30 and the control account follows');
select isnt(
  (select (payload->'payment'->>'id')::uuid from calls where name = 'p4'),
  (select (payload->'payment'->>'id')::uuid from calls where name = 'p3'),
  'W31 as a new settlement row, not a revival of the voided one');
select is(pg_temp.status_of(pg_temp.sale('W-1')), 'PAID'::text, 'W32 deriving PAID again');
select ok(pg_temp.books_agree('after receiving the money again'),
  'W33 the two representations still agree');

/* --- settling a fully settled invoice ---------------------------------- */
select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select pg_temp.try_settle('again', pg_temp.biz(), 'SALE', pg_temp.sale('W-1'), 10, 'CASH', 'k-flow-again');
reset role;

select is((select sqlstate from attempts where name = 'again'), '22023'::text,
  'W34 a settled invoice cannot be settled again');
select is(
  (select count(*) from public.payments where linked_sale_id = pg_temp.sale('W-1')),
  4::bigint, 'W35 and the refusal created no row');
select ok(pg_temp.books_agree('after trying to settle a settled invoice'),
  'W36 the two representations still agree');

/* --- voiding a settled invoice ----------------------------------------- */
-- The order is not a preference, it is a rule: money must be reversed before
-- the document that received it, or the reversal would leave a settlement
-- pointing at a document that no longer owes anything.
select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select pg_temp.try_void_document('voidsale', pg_temp.biz(), 'SALE', pg_temp.sale('W-1'));
reset role;

select is((select sqlstate from attempts where name = 'voidsale'), '22023'::text,
  'W37 a settled invoice cannot be voided while its settlements stand');
select ok((select message from attempts where name = 'voidsale') like '%reverse those first%',
  'W38 and the refusal says to reverse the settlements first');
select is(
  (select status from public.sales where id = pg_temp.sale('W-1')),
  'POSTED'::text, 'W39 the refused void left the invoice POSTED');
select ok(pg_temp.books_agree('after a refused document void'),
  'W40 the two representations still agree');

/* --- reverse the receipts, then the invoice ---------------------------- */
select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select public.void_payment(pg_temp.biz(), (select (payload->'payment'->>'id')::uuid from calls where name = 'p1'));
select public.void_payment(pg_temp.biz(), (select (payload->'payment'->>'id')::uuid from calls where name = 'p2'));
select public.void_payment(pg_temp.biz(), (select (payload->'payment'->>'id')::uuid from calls where name = 'p4'));
reset role;

select is(pg_temp.settled(pg_temp.sale('W-1')), 0::numeric,
  'W41 every receipt has been reversed');
select is(pg_temp.ledger('1030'), 1000::numeric,
  'W42 so the whole invoice is receivable again');
select ok(pg_temp.books_agree('after reversing every receipt'),
  'W43 the two representations still agree');

select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select pg_temp.try_void_document('voidsale2', pg_temp.biz(), 'SALE', pg_temp.sale('W-1'));
reset role;

select is((select sqlstate from attempts where name = 'voidsale2'), 'none'::text,
  'W44 with nothing settled, the invoice can be voided');
select is(
  (select status from public.sales where id = pg_temp.sale('W-1')),
  'VOIDED'::text, 'W45 the invoice is VOIDED');
select is(pg_temp.ledger('1030'), 0::numeric,
  'W46 its reversal removes it from receivable');
select is(pg_temp.doc_receivable(), 0::numeric,
  'W47 and a voided invoice owes nothing to the document view either');
select ok(pg_temp.books_agree('after voiding the invoice'),
  'W48 the two representations still agree, the invoice contributing nothing');

/* --- settling a voided invoice ----------------------------------------- */
select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select pg_temp.try_settle('voided', pg_temp.biz(), 'SALE', pg_temp.sale('W-1'), 100, 'CASH', 'k-flow-voided');
reset role;

select is((select sqlstate from attempts where name = 'voided'), '22023'::text,
  'W49 a voided invoice cannot be settled');
select ok((select message from attempts where name = 'voided') like '%Document is voided%',
  'W50 and the refusal says the document is void');
select is(
  (select count(*) from public.payments where linked_sale_id = pg_temp.sale('W-1')),
  4::bigint, 'W51 and it created no settlement row');
select ok(pg_temp.books_agree('after trying to settle a voided invoice'),
  'W52 the two representations still agree');

/* -------------------------------------------------------------------------- */
/* SUPPLIER SIDE: an 800 bill paid 300 at posting, settled piece by piece      */
/* -------------------------------------------------------------------------- */

select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select public.post_purchase(
  p_business_id := pg_temp.biz(), p_supplier_id := null, p_supplier_name := 'Workflow supplier',
  p_reference_number := 'W-BILL-1', p_date := current_date, p_subtotal := 800, p_discount_total := 0,
  p_tax_amount := 0, p_total_amount := 800, p_upfront_paid := 300, p_payment_method := 'BANK',
  p_notes := 'workflow', p_idempotency_key := 'k-flow-bill-1',
  p_items := '[{"line_no":1,"description":"supplies","quantity":1,"unit_price":800,"discount":0,"total":800}]'::jsonb,
  p_price_includes_vat := false
);
reset role;

select is(
  (select count(*) from public.payments
    where linked_purchase_id = pg_temp.bill('W-BILL-1') and status = 'COMPLETED'),
  1::bigint, 'W45 the embedded upfront payment is exactly one settlement row');
select is(pg_temp.settled(pg_temp.bill('W-BILL-1')), 300::numeric,
  'W46 which settles the 300 paid at posting');
select is(pg_temp.payable(), 500::numeric,
  'W47 leaving 500 owed in accounts payable');
select ok(pg_temp.books_agree('after posting a bill with an upfront payment'),
  'W48 the payable control account equals the documents');

select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select pg_temp.try_settle('q1', pg_temp.biz(), 'PURCHASE', pg_temp.bill('W-BILL-1'), 200, 'BANK', 'k-flow-q1');
reset role;

select is(pg_temp.settled(pg_temp.bill('W-BILL-1')), 500::numeric, 'W49 a supplier payment adds to what is settled');
select is(pg_temp.payable(), 300::numeric, 'W50 and reduces payable by exactly that much');
select ok(pg_temp.books_agree('after a partial supplier payment'),
  'W51 the two representations still agree');

select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select pg_temp.try_settle('q2', pg_temp.biz(), 'PURCHASE', pg_temp.bill('W-BILL-1'), 300, 'CASH', 'k-flow-q2');
reset role;

select is(pg_temp.payable(), 0::numeric, 'W52 paying the balance clears payable');
select is(pg_temp.settled(pg_temp.bill('W-BILL-1')), 800::numeric,
  'W53 with the embedded 300 counted once, not twice');
select ok(pg_temp.books_agree('after paying the balance'),
  'W54 the two representations still agree');

select pg_temp.act_as('f1f1f1f1-1111-4111-8111-11111111f1f1');
set local role authenticated;
select public.void_payment(
  pg_temp.biz(), (select (payload->'payment'->>'id')::uuid from calls where name = 'q2')
);
reset role;

select is(pg_temp.payable(), 300::numeric,
  'W55 voiding the final payment puts the balance back into payable');
select ok(pg_temp.books_agree('after voiding a supplier payment'),
  'W56 and the payable control account still equals the documents');
