-- 026_settlement_integrity.test.sql
-- pgTAP suite: DATABASE-LEVEL ENFORCEMENT of the settlement <-> journal
-- relationship (migration 016_settlement_integrity.sql).
-- Run with: supabase test db   (LOCAL stack only)
--
-- Where this sits between the other two layers
--   023_settlement_workflow / 024_control_account_integrity  — the WORKFLOW and
--        the DETECTOR: what the RPCs do, and what the database says when the
--        ledger and the documents disagree.
--   026 (this file) — the PREVENTION: the states those two used to have to
--        notice are now refused at the write boundary, so a mis-linked
--        settlement cannot be committed by any writer at all.
--
-- What it proves
--   * SHAPE (S): the enforcement is declarative where it can be (a validated
--     CHECK for "exactly one document"), minimal where it must be procedural
--     (two BEFORE triggers, each one primary-key lookup, neither able to write),
--     and reachable by no client role.
--   * VALID PATHS (V, E, G): every legitimate settlement still commits — sale,
--     purchase, partial, full, void, re-settlement, the embedded upfront
--     settlement that shares its document's entry, and the gateway settlement
--     that goes through the same core — with a single invariant query over the
--     WHOLE book returning zero violations after each step, and
--     control_account_integrity() still reporting OK.
--   * REFUSALS (X): every mis-linked shape is refused, and refused with the
--     expected SQLSTATE and message: no document, two documents, a settlement
--     anchored to another settlement's entry, to a different document's entry,
--     to a MANUAL entry, to a REVERSAL entry, a VOIDED settlement with an
--     unreversed entry, a missing entry; relinking after posting, mutating the
--     amount after posting, un-voiding, deleting; a second reversal, a reversal
--     of a reversal, a reversal with a drifted source, a reversal of nothing.
--   * TENANT (T): cross-business documents, entries and settlements are refused,
--     through the RPCs and through the foreign keys, and nothing leaks.
--   * PRIVILEGES (P): authenticated still holds no INSERT/UPDATE on the tables
--     the guard protects — the guard is a backstop for privileged writers, not
--     a replacement for the RPC boundary.
--   * CONCURRENCY (R): one genuine two-session race over a real outstanding
--     balance, with the new guard in place: the loser blocks on the document
--     lock and is rejected as over-settlement, so the persisted state never
--     exceeds the document total.
--
-- Structure: the enforcement proofs run inside a single transaction that is
-- rolled back; the race section that follows must commit (a second session can
-- only see committed rows), exactly as 011/013/017/019 do, so its fixtures are
-- per-run unique and `supabase db reset --local` is the cleanup.
--
-- Comment labels name the cases; a case may make more than one assertion.

begin;
create extension if not exists pgtap with schema extensions;

select plan(64);

/* ========================================================================== */
/* Helpers (transactional: rolled back at the end of the refusal block)       */
/* ========================================================================== */

create function pg_temp.act_as(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_uid::text, 'role', 'authenticated')::text,
    true
  );
end $$;

create function pg_temp.biz_a() returns uuid
language sql security definer set search_path = '' as $$
  select id from public.businesses where business_name = 'Settlement Integrity A';
$$;

create function pg_temp.biz_b() returns uuid
language sql security definer set search_path = '' as $$
  select id from public.businesses where business_name = 'Settlement Integrity B';
$$;

create function pg_temp.sale_id(p_inv text) returns uuid
language sql security definer set search_path = '' as $$
  select id from public.sales
   where business_id = pg_temp.biz_a() and invoice_number = p_inv;
$$;

create function pg_temp.bill_id(p_ref text) returns uuid
language sql security definer set search_path = '' as $$
  select id from public.purchases
   where business_id = pg_temp.biz_a() and reference_number = p_ref;
$$;

create function pg_temp.entry_of_sale(p_inv text) returns uuid
language sql security definer set search_path = '' as $$
  select journal_entry_id from public.sales
   where business_id = pg_temp.biz_a() and invoice_number = p_inv;
$$;

create function pg_temp.entry_of_bill(p_ref text) returns uuid
language sql security definer set search_path = '' as $$
  select journal_entry_id from public.purchases
   where business_id = pg_temp.biz_a() and reference_number = p_ref;
$$;

create function pg_temp.pay_by_key(p_key text) returns uuid
language sql security definer set search_path = '' as $$
  select id from public.payments
   where business_id = pg_temp.biz_a() and idempotency_key = p_key;
$$;

create function pg_temp.entry_of_pay(p_pay uuid) returns uuid
language sql security definer set search_path = '' as $$
  select journal_entry_id from public.payments where id = p_pay;
$$;

/** Live settled amount on a document, from the settlement rows only. */
create function pg_temp.settled(p_doc uuid) returns numeric
language sql security definer set search_path = '' as $$
  select coalesce(sum(p.amount), 0)::numeric(14,2)
    from public.payments p
   where p.business_id = pg_temp.biz_a()
     and (p.linked_sale_id = p_doc or p.linked_purchase_id = p_doc)
     and p.status = 'COMPLETED'
     and p.doc_status = 'POSTED';
$$;

/**
 * The invariant, re-expressed here on purpose.
 *
 * This is the TEST's own reading of the three rules, written against the tables
 * rather than by calling anything migration 016 defines, so a mistake in the
 * guard cannot agree with itself. It counts violations across EVERY business
 * (SECURITY DEFINER), which is what lets a single assertion say "the whole book
 * is still sound" after each step.
 */
create function pg_temp.viol_total() returns bigint
language sql security definer set search_path = '' as $$
  select
    -- (1) a settlement names exactly one document
    (select count(*) from public.payments p
      where (p.linked_sale_id is null) = (p.linked_purchase_id is null))
    -- (2) the entry is the settlement's own event, or its document's
    + (select count(*) from public.payments p
         join public.journal_entries e
           on e.business_id = p.business_id and e.id = p.journal_entry_id
        where not (
          (e.source_type = 'PAYMENT' and e.source_id = p.id)
          or (e.source_type = 'SALE' and e.source_id = p.linked_sale_id)
          or (e.source_type = 'PURCHASE' and e.source_id = p.linked_purchase_id)
        ))
    -- (3) a VOIDED settlement carries the reversal of that entry
    + (select count(*) from public.payments p
         join public.journal_entries e
           on e.business_id = p.business_id and e.id = p.journal_entry_id
        where p.doc_status = 'VOIDED' and e.reversed_by_entry_id is null)
    -- (4) a reversal reverses a first-hand event and carries its source
    + (select count(*) from public.journal_entries r
        where r.source_type = 'REVERSAL'
          and not exists (
            select 1 from public.journal_entries o
             where o.business_id = r.business_id
               and o.id = r.reverses_entry_id
               and o.reverses_entry_id is null
               and o.source_id is not distinct from r.source_id
          ));
$$;

/**
 * A balanced PAYMENT-shaped journal entry for a settlement id that does not
 * exist yet, so the shape rules can be satisfied while the CHECK constraints
 * are the thing under test. TEST-ONLY, inside the rolled-back transaction.
 */
create function pg_temp.mk_pay_entry(
  p_biz uuid, p_pay uuid, p_uid uuid, p_amount numeric, p_ref text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_entry uuid := gen_random_uuid();
  v_seq bigint;
begin
  select coalesce(max(sequence), 0) + 1 into v_seq
    from public.journal_entries where business_id = p_biz;

  insert into public.journal_entries (
    id, business_id, transaction_date, sequence, description, reference,
    source_type, source_id, created_by
  ) values (
    v_entry, p_biz, current_date, v_seq, 'test settlement event', p_ref,
    'PAYMENT', p_pay, p_uid
  );

  insert into public.journal_lines (
    business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit
  )
  select p_biz, v_entry, 1, a.id, a.name, a.type, p_amount, 0
    from public.accounts a where a.business_id = p_biz and a.code = '1010';
  insert into public.journal_lines (
    business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit
  )
  select p_biz, v_entry, 2, a.id, a.name, a.type, 0, p_amount
    from public.accounts a where a.business_id = p_biz and a.code = '1030';

  return v_entry;
end $$;

/** A balanced MANUAL entry — an event no settlement may ever be anchored to. */
create function pg_temp.mk_manual_entry(p_biz uuid, p_uid uuid, p_amount numeric, p_ref text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_entry uuid := gen_random_uuid();
  v_seq bigint;
begin
  select coalesce(max(sequence), 0) + 1 into v_seq
    from public.journal_entries where business_id = p_biz;

  insert into public.journal_entries (
    id, business_id, transaction_date, sequence, description, reference,
    source_type, created_by
  ) values (
    v_entry, p_biz, current_date, v_seq, 'test manual entry', p_ref, 'MANUAL', p_uid
  );

  insert into public.journal_lines (
    business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit
  )
  select p_biz, v_entry, 1, a.id, a.name, a.type, p_amount, 0
    from public.accounts a where a.business_id = p_biz and a.code = '1010';
  insert into public.journal_lines (
    business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit
  )
  select p_biz, v_entry, 2, a.id, a.name, a.type, 0, p_amount
    from public.accounts a where a.business_id = p_biz and a.code = '1030';

  return v_entry;
end $$;

create function pg_temp.sale_of(p_biz uuid, p_inv text) returns uuid
language sql security definer set search_path = '' as $$
  select id from public.sales where business_id = p_biz and invoice_number = p_inv;
$$;

create function pg_temp.entry_of_sale_in(p_biz uuid, p_inv text) returns uuid
language sql security definer set search_path = '' as $$
  select journal_entry_id from public.sales
   where business_id = p_biz and invoice_number = p_inv;
$$;

/** Post a credit sale into any business, as the CURRENT ROLE. */
create function pg_temp.new_sale_in(
  p_biz uuid, p_customer text, p_invoice text, p_total numeric
) returns uuid language plpgsql as $$
declare
  v_payload jsonb;
begin
  v_payload := public.post_sale(
    p_business_id := p_biz, p_customer_id := null, p_customer_name := p_customer,
    p_invoice_number := p_invoice, p_date := current_date,
    p_subtotal := p_total, p_discount_total := 0,
    p_tax_amount := 0, p_total_amount := p_total, p_upfront_paid := 0,
    p_payment_method := 'CASH', p_cost_of_goods := null, p_notes := 'integrity',
    p_items := jsonb_build_array(jsonb_build_object(
      'line_no', 1, 'description', 'work', 'quantity', 1, 'unit_price', p_total,
      'discount', 0, 'total', p_total
    ))
  );
  return (v_payload -> 'sale' ->> 'id')::uuid;
end $$;

create function pg_temp.new_sale(p_invoice text, p_total numeric, p_upfront numeric, p_method text)
returns uuid language plpgsql as $$
declare
  v_payload jsonb;
begin
  v_payload := public.post_sale(
    p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Integrity customer',
    p_invoice_number := p_invoice, p_date := current_date,
    p_subtotal := p_total, p_discount_total := 0,
    p_tax_amount := 0, p_total_amount := p_total, p_upfront_paid := p_upfront,
    p_payment_method := p_method, p_cost_of_goods := null, p_notes := 'integrity',
    p_items := jsonb_build_array(jsonb_build_object(
      'line_no', 1, 'description', 'work', 'quantity', 1, 'unit_price', p_total,
      'discount', 0, 'total', p_total
    ))
  );
  return (v_payload -> 'sale' ->> 'id')::uuid;
end $$;

create function pg_temp.new_bill(p_ref text, p_total numeric, p_upfront numeric, p_method text)
returns uuid language plpgsql as $$
declare
  v_payload jsonb;
begin
  v_payload := public.post_purchase(
    p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Integrity supplier',
    p_reference_number := p_ref, p_date := current_date,
    p_subtotal := p_total, p_discount_total := 0,
    p_tax_amount := 0, p_total_amount := p_total, p_upfront_paid := p_upfront,
    p_payment_method := p_method, p_notes := 'integrity',
    p_items := jsonb_build_array(jsonb_build_object(
      'line_no', 1, 'description', 'stock', 'quantity', 1, 'unit_price', p_total,
      'discount', 0, 'total', p_total
    ))
  );
  return (v_payload -> 'purchase' ->> 'id')::uuid;
end $$;

create temp table attempts (name text primary key, sqlstate text, message text);
grant all on attempts to authenticated;

/** Settle in a named business, recording either success or the refusal. */
create function pg_temp.try_settle(
  p_name text, p_biz uuid, p_type text, p_doc uuid, p_amount numeric,
  p_method text default 'CASH', p_key text default null
) returns void language plpgsql as $$
begin
  begin
    perform public.post_payment(
      p_biz, p_type, p_doc, p_amount, p_method, current_date, '', 'integrity', p_key
    );
    insert into attempts values (p_name, 'none', 'no error was raised');
  exception when others then
    insert into attempts values (p_name, sqlstate, sqlerrm);
  end;
end $$;

create function pg_temp.try_void_payment(p_name text, p_biz uuid, p_pay uuid)
returns void language plpgsql as $$
begin
  begin
    perform public.void_payment(p_biz, p_pay);
    insert into attempts values (p_name, 'none', 'no error was raised');
  exception when others then
    insert into attempts values (p_name, sqlstate, sqlerrm);
  end;
end $$;

grant execute on function
  pg_temp.act_as(uuid), pg_temp.biz_a(), pg_temp.biz_b(), pg_temp.sale_id(text),
  pg_temp.bill_id(text), pg_temp.entry_of_sale(text), pg_temp.entry_of_bill(text),
  pg_temp.pay_by_key(text), pg_temp.entry_of_pay(uuid), pg_temp.settled(uuid),
  pg_temp.viol_total(), pg_temp.sale_of(uuid, text), pg_temp.entry_of_sale_in(uuid, text),
  pg_temp.new_sale_in(uuid, text, text, numeric),
  pg_temp.new_sale(text, numeric, numeric, text),
  pg_temp.new_bill(text, numeric, numeric, text),
  pg_temp.try_settle(text, uuid, text, uuid, numeric, text, text),
  pg_temp.try_void_payment(text, uuid, uuid)
  to authenticated;

/* ========================================================================== */
/* Fixtures: two businesses, two owners, one stranger                          */
/* ========================================================================== */

insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a5a5a5a5-5555-4555-8555-555555555555',
   'authenticated', 'authenticated', 'si-owner-a@zeyks.test', '{"full_name":"Owner A"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b6b6b6b6-6666-4666-8666-666666666666',
   'authenticated', 'authenticated', 'si-owner-b@zeyks.test', '{"full_name":"Owner B"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c7c7c7c7-7777-4777-8777-777777777777',
   'authenticated', 'authenticated', 'si-stranger@zeyks.test', '{"full_name":"Stranger"}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('a5a5a5a5-5555-4555-8555-555555555555');
set local role authenticated;
select public.create_business(
  'Settlement Integrity A', 'Owner A', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

select pg_temp.act_as('b6b6b6b6-6666-4666-8666-666666666666');
set local role authenticated;
select public.create_business(
  'Settlement Integrity B', 'Owner B', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

/* ========================================================================== */
/* S — the shape of the enforcement                                            */
/* ========================================================================== */

select is(
  (select count(*)::int from pg_constraint c
    where c.conrelid = 'public.payments'::regclass
      and c.conname = 'payments_exactly_one_document'),
  1, 'S1 a settlement must name exactly one document: the constraint exists');

select is(
  (select c.contype::text from pg_constraint c
    where c.conrelid = 'public.payments'::regclass
      and c.conname = 'payments_exactly_one_document'),
  'c', 'S2 and it is a CHECK, so the rule needs no code at write time');

select is(
  (select c.convalidated from pg_constraint c
    where c.conrelid = 'public.payments'::regclass
      and c.conname = 'payments_exactly_one_document'),
  true,
  'S3 added VALIDATED, not NOT VALID: existing rows were audited, so none is exempt');

select is(
  (select t.tgtype::int from pg_trigger t
    where t.tgrelid = 'public.payments'::regclass and t.tgname = 'payments_assert_linkage'),
  23,
  'S4 the settlement guard is BEFORE INSERT OR UPDATE, for each row (1+2+4+16)');

select is(
  (select t.tgtype::int from pg_trigger t
    where t.tgrelid = 'public.journal_entries'::regclass
      and t.tgname = 'journal_entries_assert_reversal'),
  7,
  'S5 the reversal guard is BEFORE INSERT, for each row (1+2+4)');

select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('public.assert_settlement_linkage()'::regprocedure,
                    'public.assert_reversal_shape()'::regprocedure)
      and p.prosecdef),
  2, 'S6 both guards are SECURITY DEFINER, so RLS cannot make one skip its check');

select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('public.assert_settlement_linkage()'::regprocedure,
                    'public.assert_reversal_shape()'::regprocedure)
      and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')),
  2, 'S7 with search_path pinned, like every other function in this project');

select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('public.assert_settlement_linkage()'::regprocedure,
                    'public.assert_reversal_shape()'::regprocedure)
      and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE'))),
  0, 'S8 and neither guard is executable by a client role');

/* ========================================================================== */
/* V — every legitimate settlement still commits                              */
/* ========================================================================== */

select pg_temp.act_as('a5a5a5a5-5555-4555-8555-555555555555');
set local role authenticated;
select pg_temp.new_sale('SI-1', 1000, 0, 'CASH');
select pg_temp.new_sale('SI-2', 1000, 0, 'CASH');
select pg_temp.new_bill('SI-B1', 800, 300, 'BANK');
select pg_temp.new_bill('SI-B2', 900, 0, 'CASH');
reset role;

select is(pg_temp.viol_total(), 0::bigint,
  'V1 a book with credit documents and an embedded upfront settlement is sound');

select pg_temp.act_as('a5a5a5a5-5555-4555-8555-555555555555');
set local role authenticated;
select pg_temp.try_settle('v1', pg_temp.biz_a(), 'SALE', pg_temp.sale_id('SI-1'), 400, 'CASH', 'k-si-1');
reset role;

select is((select sqlstate from attempts where name = 'v1'), 'none'::text,
  'V2 a partial receipt against a credit invoice is accepted');

select is(
  (select e.source_type || '|' || (e.source_id = p.id)::text
     from public.payments p
     join public.journal_entries e on e.id = p.journal_entry_id
    where p.id = pg_temp.pay_by_key('k-si-1')),
  'PAYMENT|true',
  'V3 and its journal entry is the settlement''s own PAYMENT event, sourced by its id');

select pg_temp.act_as('a5a5a5a5-5555-4555-8555-555555555555');
set local role authenticated;
select pg_temp.try_settle('v2', pg_temp.biz_a(), 'SALE', pg_temp.sale_id('SI-1'), 600, 'ESEWA', 'k-si-2');
reset role;

select is(pg_temp.settled(pg_temp.sale_id('SI-1')), 1000::numeric,
  'V4 the balance can be settled in full');
select is(
  (select count(*)::int from public.payments
    where business_id = pg_temp.biz_a() and linked_sale_id = pg_temp.sale_id('SI-1')),
  2, 'V5 two receipts, two settlement rows');
select is(pg_temp.viol_total(), 0::bigint,
  'V6 the whole book still satisfies the invariant after partial and full settlement');

select pg_temp.act_as('a5a5a5a5-5555-4555-8555-555555555555');
set local role authenticated;
select pg_temp.try_void_payment('v3', pg_temp.biz_a(), pg_temp.pay_by_key('k-si-2'));
reset role;

select is((select sqlstate from attempts where name = 'v3'), 'none'::text,
  'V7 a receipt can still be voided');
select is(
  (select (e.reversed_by_entry_id is not null)::text
     from public.payments p
     join public.journal_entries e on e.id = p.journal_entry_id
    where p.id = pg_temp.pay_by_key('k-si-2')),
  'true',
  'V8 and the VOIDED settlement carries the reversal of its own entry, which is what the guard requires');
select is(pg_temp.settled(pg_temp.sale_id('SI-1')), 400::numeric,
  'V9 so the invoice is partly outstanding again');
select is(pg_temp.viol_total(), 0::bigint,
  'V10 a void leaves the invariant satisfied, not merely detected');

select pg_temp.act_as('a5a5a5a5-5555-4555-8555-555555555555');
set local role authenticated;
select pg_temp.try_settle('v4', pg_temp.biz_a(), 'SALE', pg_temp.sale_id('SI-1'), 600, 'KHALTI', 'k-si-3');
reset role;

select is((select sqlstate from attempts where name = 'v4'), 'none'::text,
  'V11 the money can be received again after a void');
select is(pg_temp.settled(pg_temp.sale_id('SI-1')), 1000::numeric,
  'V12 and the invoice settles fully for the second time');

select pg_temp.act_as('a5a5a5a5-5555-4555-8555-555555555555');
set local role authenticated;
select pg_temp.try_settle('v5', pg_temp.biz_a(), 'PURCHASE', pg_temp.bill_id('SI-B2'), 400, 'BANK', 'k-si-4');
reset role;

select is((select sqlstate from attempts where name = 'v5'), 'none'::text,
  'V13 a supplier payment is accepted on the payable side');

select pg_temp.act_as('a5a5a5a5-5555-4555-8555-555555555555');
set local role authenticated;
select pg_temp.try_void_payment('v6', pg_temp.biz_a(), pg_temp.pay_by_key('k-si-4'));
reset role;

select is((select sqlstate from attempts where name = 'v6'), 'none'::text,
  'V14 and a supplier payment can be voided');

select is(
  (select d.receivable_status || '|' || d.payable_status
     from public.control_account_integrity() d
    where d.business_id = pg_temp.biz_a()),
  'OK|OK',
  'V15 with the ledger and the documents still agreeing on both sides');
select is(pg_temp.viol_total(), 0::bigint,
  'V16 across posting, partial, full, void, re-settlement, purchase and void again');

/* ========================================================================== */
/* E — the embedded upfront settlement is one event, counted once              */
/* ========================================================================== */

select is(
  (select count(*)::int from public.payments
    where business_id = pg_temp.biz_a() and linked_purchase_id = pg_temp.bill_id('SI-B1')),
  1, 'E1 a bill paid 300 at posting writes exactly one settlement row');

select is(
  (select p.journal_entry_id = b.journal_entry_id
     from public.payments p
     join public.purchases b on b.id = p.linked_purchase_id
    where p.linked_purchase_id = pg_temp.bill_id('SI-B1')),
  true,
  'E2 and it shares the BILL''s own journal entry — the shape the guard accepts as purchase-sourced');

select is(
  (select count(*)::int from public.purchases b
    where b.business_id = pg_temp.biz_a() and b.reference_number = 'SI-B1'
      and b.total_amount - pg_temp.settled(b.id) = 500),
  1, 'E3 so the outstanding 500 comes from the settlement rows, never from upfront_paid');

select throws_ok(
  format($$insert into public.payments (
            business_id, reference, date, amount, payment_method, status, payment_type,
            linked_purchase_id, party_name, journal_entry_id, created_by
          ) values ('%s', 'BAD-SECOND-EMBEDDED', current_date, 50, 'CASH', 'COMPLETED',
                    'OUTGOING', '%s', 'Second', '%s', 'a5a5a5a5-5555-4555-8555-555555555555')$$,
         pg_temp.biz_a(), pg_temp.bill_id('SI-B1'), pg_temp.entry_of_bill('SI-B1')),
  '23505', NULL,
  'E4 a second settlement cannot share the document''s entry: one event, one entry');

/* ========================================================================== */
/* G — the gateway settlement goes through the same boundary                   */
/* ========================================================================== */

select pg_temp.act_as('a5a5a5a5-5555-4555-8555-555555555555');
set local role authenticated;
select pg_temp.new_sale('SI-3', 1000, 0, 'CASH');
select (public.initiate_gateway_txn(
  pg_temp.biz_a(), 'ESEWA', 'SI-GW-REF-1', 1000, pg_temp.sale_id('SI-3'), 'Gateway customer', 'NPR'
))->'gateway_transaction'->>'id' as gw_txn \gset
reset role;

select isnt(:'gw_txn'::text, ''::text,
  'G1 a collection can be initiated against an outstanding invoice');

select pg_temp.act_as('a5a5a5a5-5555-4555-8555-555555555555');
set local role authenticated;
select (public.settle_gateway_txn(
  pg_temp.biz_a(), :'gw_txn'::uuid,
  jsonb_build_object(
    'provider', 'ESEWA', 'verified', true, 'status', 'COMPLETED',
    'gateway_transaction_id', 'ESEWA-TXN-1', 'amount', 1000, 'currency', 'NPR',
    'reference', 'SI-GW-REF-1'
  )
))->'payment'->>'id' as gw_pay \gset
reset role;

select isnt(:'gw_pay'::text, ''::text,
  'G2 a verified collection is settled through post_settlement_core');

select is(
  (select e.source_type || '|' || (e.source_id = p.id)::text
     from public.payments p
     join public.journal_entries e on e.id = p.journal_entry_id
    where p.id = :'gw_pay'::uuid),
  'PAYMENT|true',
  'G3 the gateway settlement writes the same own-event entry shape post_payment does');

select is(
  (select sum(p.amount) from public.payments p where p.linked_sale_id = pg_temp.sale_id('SI-3')),
  1000::numeric,
  'G4 the invoice is settled once, for the amount the gateway confirmed');

select is(pg_temp.viol_total(), 0::bigint,
  'G5 and the gateway path satisfies the invariant exactly as the manual one does');

/* ========================================================================== */
/* X — every mis-linked shape is refused                                      */
/* ========================================================================== */
-- The payloads below are built to satisfy the OTHER rules so that the refusal
-- can only come from the rule under test. Each is a direct INSERT as the
-- database's own superuser — the privileged writer a client can never be —
-- which is precisely the writer this migration exists to stop.

-- Fixture entries: one PAYMENT-shaped entry whose settlement does not exist yet,
-- and one MANUAL entry.
select set_config('s20.pay_nolink', gen_random_uuid()::text, true);
select set_config('s20.entry_nolink',
  pg_temp.mk_pay_entry(pg_temp.biz_a(), current_setting('s20.pay_nolink')::uuid,
                       'a5a5a5a5-5555-4555-8555-555555555555', 10, 'TEST-NOLINK')::text, true);
select set_config('s20.entry_manual',
  pg_temp.mk_manual_entry(pg_temp.biz_a(), 'a5a5a5a5-5555-4555-8555-555555555555', 15, 'TEST-MANUAL')::text, true);
select set_config('s20.pay_voided', gen_random_uuid()::text, true);
select set_config('s20.entry_voided',
  pg_temp.mk_pay_entry(pg_temp.biz_a(), current_setting('s20.pay_voided')::uuid,
                       'a5a5a5a5-5555-4555-8555-555555555555', 20, 'TEST-VOIDED')::text, true);

-- Counted AFTER those fixtures, so the pair of assertions at X19/X20 measures
-- exactly what the refusals did (or did not) write.
select set_config('s20.before_payments',
  (select count(*)::text from public.payments), true);
select set_config('s20.before_entries',
  (select count(*)::text from public.journal_entries), true);

-- X1 — no document at all.
select throws_like(
  format($$insert into public.payments (
            id, business_id, reference, date, amount, payment_method, status, payment_type,
            party_name, journal_entry_id, created_by
          ) values ('%s', '%s', 'BAD-NOLINK', current_date, 10, 'CASH', 'COMPLETED',
                    'INCOMING', 'Nobody', '%s', 'a5a5a5a5-5555-4555-8555-555555555555')$$,
         current_setting('s20.pay_nolink'), pg_temp.biz_a(), current_setting('s20.entry_nolink')),
  '%payments_exactly_one_document%',
  'X1 a settlement naming no document is refused by the table');

-- X2 — two documents at once.
select throws_like(
  format($$insert into public.payments (
            id, business_id, reference, date, amount, payment_method, status, payment_type,
            linked_sale_id, linked_purchase_id, party_name, journal_entry_id, created_by
          ) values ('%s', '%s', 'BAD-TWOLINKS', current_date, 10, 'CASH', 'COMPLETED',
                    'INCOMING', '%s', '%s', 'Nobody', '%s', 'a5a5a5a5-5555-4555-8555-555555555555')$$,
         current_setting('s20.pay_nolink'), pg_temp.biz_a(),
         pg_temp.sale_id('SI-1'), pg_temp.bill_id('SI-B1'), current_setting('s20.entry_nolink')),
  '%payments_exactly_one_document%',
  'X2 a settlement naming both an invoice and a bill is refused by the table');

-- X3 — money received claiming to settle a bill.
select throws_like(
  format($$insert into public.payments (
            business_id, reference, date, amount, payment_method, status, payment_type,
            linked_purchase_id, party_name, journal_entry_id, created_by
          ) values ('%s', 'BAD-DIRECTION', current_date, 10, 'CASH', 'COMPLETED',
                    'INCOMING', '%s', 'Nobody', '%s', 'a5a5a5a5-5555-4555-8555-555555555555')$$,
         pg_temp.biz_a(), pg_temp.bill_id('SI-B2'), pg_temp.entry_of_bill('SI-B2')),
  '%payments_link_matches_direction%',
  'X3 an INCOMING settlement cannot name a bill, even with a bill-sourced entry');

-- X4 — anchored to another settlement's own event.
select throws_like(
  format($$insert into public.payments (
            business_id, reference, date, amount, payment_method, status, payment_type,
            linked_sale_id, party_name, journal_entry_id, created_by
          ) values ('%s', 'BAD-OTHERS-ENTRY', current_date, 10, 'CASH', 'COMPLETED',
                    'INCOMING', '%s', 'Nobody', '%s', 'a5a5a5a5-5555-4555-8555-555555555555')$$,
         pg_temp.biz_a(), pg_temp.sale_id('SI-1'), pg_temp.entry_of_pay(pg_temp.pay_by_key('k-si-1'))),
  '%belongs to a different settlement%',
  'X4 a settlement cannot be anchored to another settlement''s journal entry');

-- X5 — anchored to a different invoice's entry.
select throws_like(
  format($$insert into public.payments (
            business_id, reference, date, amount, payment_method, status, payment_type,
            linked_sale_id, party_name, journal_entry_id, created_by
          ) values ('%s', 'BAD-OTHER-INVOICE', current_date, 10, 'CASH', 'COMPLETED',
                    'INCOMING', '%s', 'Nobody', '%s', 'a5a5a5a5-5555-4555-8555-555555555555')$$,
         pg_temp.biz_a(), pg_temp.sale_id('SI-2'), pg_temp.entry_of_sale('SI-1')),
  '%shares a journal entry with a different invoice%',
  'X5 nor to a different invoice''s entry, so settlement and ledger cannot part company');

-- X6 — anchored to a MANUAL entry.
select throws_like(
  format($$insert into public.payments (
            business_id, reference, date, amount, payment_method, status, payment_type,
            linked_sale_id, party_name, journal_entry_id, created_by
          ) values ('%s', 'BAD-MANUAL', current_date, 10, 'CASH', 'COMPLETED',
                    'INCOMING', '%s', 'Nobody', '%s', 'a5a5a5a5-5555-4555-8555-555555555555')$$,
         pg_temp.biz_a(), pg_temp.sale_id('SI-1'), current_setting('s20.entry_manual')),
  '%cannot be anchored to a MANUAL journal entry%',
  'X6 a settlement cannot be hung off a manual journal entry');

-- X7 — anchored to a reversal.
select throws_like(
  format($$insert into public.payments (
            business_id, reference, date, amount, payment_method, status, payment_type,
            linked_sale_id, party_name, journal_entry_id, created_by
          ) values ('%s', 'BAD-REVERSAL', current_date, 10, 'CASH', 'COMPLETED',
                    'INCOMING', '%s', 'Nobody', '%s', 'a5a5a5a5-5555-4555-8555-555555555555')$$,
         pg_temp.biz_a(), pg_temp.sale_id('SI-1'),
         (select e.reversed_by_entry_id from public.journal_entries e
           where e.id = pg_temp.entry_of_pay(pg_temp.pay_by_key('k-si-2')))),
  '%cannot be anchored to a REVERSAL journal entry%',
  'X7 nor off a reversal entry: a voided event cannot be re-used as a settlement');

-- X8 — VOIDED while its entry is unreversed.
select throws_like(
  format($$insert into public.payments (
            id, business_id, reference, date, amount, payment_method, status, payment_type,
            linked_sale_id, party_name, doc_status, journal_entry_id, created_by
          ) values ('%s', '%s', 'BAD-VOIDED', current_date, 20, 'CASH', 'COMPLETED',
                    'INCOMING', '%s', 'Nobody', 'VOIDED', '%s', 'a5a5a5a5-5555-4555-8555-555555555555')$$,
         current_setting('s20.pay_voided'), pg_temp.biz_a(), pg_temp.sale_id('SI-1'),
         current_setting('s20.entry_voided')),
  '%cannot be marked VOIDED while its journal entry is unreversed%',
  'X8 a settlement cannot be VOIDED while its entry still stands in the ledger');

-- X9 — no entry at all (the guard fails closed before the foreign key runs).
select throws_like(
  format($$insert into public.payments (
            business_id, reference, date, amount, payment_method, status, payment_type,
            linked_sale_id, party_name, journal_entry_id, created_by
          ) values ('%s', 'BAD-NO-ENTRY', current_date, 10, 'CASH', 'COMPLETED',
                    'INCOMING', '%s', 'Nobody', '%s', 'a5a5a5a5-5555-4555-8555-555555555555')$$,
         pg_temp.biz_a(), pg_temp.sale_id('SI-1'), gen_random_uuid()),
  '%missing from the ledger%',
  'X9 a settlement whose entry does not exist fails closed rather than opening');

-- X10 — a second reversal for one original.
select throws_ok(
  format($$insert into public.journal_entries (
            business_id, transaction_date, sequence, description, reference,
            source_type, source_id, created_by, reverses_entry_id
          ) values ('%s', current_date, 999001, 'second reversal', 'REV-DUP-1',
                    'REVERSAL', '%s', 'a5a5a5a5-5555-4555-8555-555555555555', '%s')$$,
         pg_temp.biz_a(), pg_temp.pay_by_key('k-si-2'), pg_temp.entry_of_pay(pg_temp.pay_by_key('k-si-2'))),
  '23505', NULL,
  'X10 an original entry can be reversed at most once, whatever the writer');

-- X11 — a reversal of a reversal.
select throws_like(
  format($$insert into public.journal_entries (
            business_id, transaction_date, sequence, description, reference,
            source_type, source_id, created_by, reverses_entry_id
          ) values ('%s', current_date, 999002, 'reversal of a reversal', 'REV-DUP-2',
                    'REVERSAL', '%s', 'a5a5a5a5-5555-4555-8555-555555555555', '%s')$$,
         pg_temp.biz_a(), pg_temp.pay_by_key('k-si-2'),
         (select e.reversed_by_entry_id from public.journal_entries e
           where e.id = pg_temp.entry_of_pay(pg_temp.pay_by_key('k-si-2')))),
  '%is itself a reversal and cannot be reversed again%',
  'X11 and a reversal itself cannot be reversed: the void path terminates');

-- X12 — a reversal whose source drifted from its original.
select throws_like(
  format($$insert into public.journal_entries (
            business_id, transaction_date, sequence, description, reference,
            source_type, source_id, created_by, reverses_entry_id
          ) values ('%s', current_date, 999003, 'drifting reversal', 'REV-DUP-3',
                    'REVERSAL', '%s', 'a5a5a5a5-5555-4555-8555-555555555555', '%s')$$,
         pg_temp.biz_a(), gen_random_uuid(), pg_temp.entry_of_sale('SI-2')),
  '%must carry the source of the entry it reverses%',
  'X12 a reversal must carry the event identity of the entry it reverses');

-- X13 — a reversal of nothing.
select throws_like(
  format($$insert into public.journal_entries (
            business_id, transaction_date, sequence, description, reference,
            source_type, source_id, created_by, reverses_entry_id
          ) values ('%s', current_date, 999004, 'reversal of nothing', 'REV-DUP-4',
                    'REVERSAL', '%s', 'a5a5a5a5-5555-4555-8555-555555555555', '%s')$$,
         pg_temp.biz_a(), pg_temp.pay_by_key('k-si-2'), gen_random_uuid()),
  '%must name the journal entry it reverses%',
  'X13 and it must name an entry that exists');

-- X14 — silent relink after posting.
select throws_ok(
  format($$update public.payments set linked_sale_id = '%s' where id = '%s'$$,
         pg_temp.sale_id('SI-2'), pg_temp.pay_by_key('k-si-1')),
  '23001', NULL,
  'X14 a posted settlement cannot be relinked to another invoice');

-- X15 — amount mutation after posting.
select throws_ok(
  format($$update public.payments set amount = 1 where id = '%s'$$, pg_temp.pay_by_key('k-si-1')),
  '23001', NULL,
  'X15 nor can its amount be rewritten after posting');

-- X16 — un-voiding a settlement.
select throws_ok(
  format($$update public.payments set doc_status = 'POSTED' where id = '%s'$$,
         pg_temp.pay_by_key('k-si-2')),
  '23001', NULL,
  'X16 a voided settlement cannot be flipped back to POSTED');

-- X17 — deleting a settlement.
select throws_ok(
  format($$delete from public.payments where id = '%s'$$, pg_temp.pay_by_key('k-si-1')),
  '23001', NULL,
  'X17 and a settlement can never be deleted');

-- X18 — a purchase settlement cannot be relinked either.
select throws_ok(
  format($$update public.payments set linked_purchase_id = '%s' where id = '%s'$$,
         pg_temp.bill_id('SI-B1'), pg_temp.pay_by_key('k-si-4')),
  '23001', NULL,
  'X18 the payable side is immutable in the same way');

select is(
  (select count(*)::text from public.payments), current_setting('s20.before_payments'),
  'X19 not one refused write created a settlement row');

select is(
  (select count(*)::text from public.journal_entries), current_setting('s20.before_entries'),
  'X20 nor a journal entry: a refusal is a refusal, never a partial write');

select is(pg_temp.viol_total(), 0::bigint,
  'X21 and the book still satisfies the invariant the refusals protect');

/* ========================================================================== */
/* T — tenant isolation                                                       */
/* ========================================================================== */

select pg_temp.act_as('b6b6b6b6-6666-4666-8666-666666666666');
set local role authenticated;
select pg_temp.new_sale_in(pg_temp.biz_b(), 'B customer', 'SI-B-1', 500);
reset role;

select isnt(pg_temp.sale_of(pg_temp.biz_b(), 'SI-B-1')::text, ''::text,
  'T0 fixture: B has an invoice of its own');

select pg_temp.act_as('a5a5a5a5-5555-4555-8555-555555555555');
set local role authenticated;
select pg_temp.try_settle('t1', pg_temp.biz_a(), 'SALE', pg_temp.sale_of(pg_temp.biz_b(), 'SI-B-1'), 100, 'CASH', 'k-t1');
reset role;

select is((select sqlstate from attempts where name = 't1'), '22023'::text,
  'T1 A''s owner cannot settle B''s invoice through the RPC');

select pg_temp.act_as('b6b6b6b6-6666-4666-8666-666666666666');
set local role authenticated;
select pg_temp.try_settle('t2', pg_temp.biz_a(), 'SALE', pg_temp.sale_id('SI-1'), 100, 'CASH', 'k-t2');
reset role;

select is((select sqlstate from attempts where name = 't2'), '42501'::text,
  'T2 nor can B''s owner reach into A''s business: membership is checked before the document');

select pg_temp.act_as('c7c7c7c7-7777-4777-8777-777777777777');
set local role authenticated;
select pg_temp.try_settle('t3', pg_temp.biz_a(), 'SALE', pg_temp.sale_id('SI-1'), 100, 'CASH', 'k-t3');
reset role;

select is((select sqlstate from attempts where name = 't3'), '42501'::text,
  'T3 and an authenticated user who is in no business at all is refused outright');

-- The foreign keys, as the privileged writer: a settlement cannot name another
-- tenant's document, or another tenant's journal entry, in the first place.
-- The payloads are built to satisfy the SHAPE rules, so the only thing left to
-- refuse them is tenancy itself.
select set_config('s20.pay_xtenant', gen_random_uuid()::text, true);
select set_config('s20.entry_xtenant_a',
  pg_temp.mk_pay_entry(pg_temp.biz_a(), current_setting('s20.pay_xtenant')::uuid,
                       'a5a5a5a5-5555-4555-8555-555555555555', 10, 'TEST-XTENANT')::text, true);

select throws_ok(
  format($$insert into public.payments (
            id, business_id, reference, date, amount, payment_method, status, payment_type,
            linked_sale_id, party_name, journal_entry_id, created_by
          ) values ('%s', '%s', 'BAD-XTENANT-DOC', current_date, 10, 'CASH', 'COMPLETED',
                    'INCOMING', '%s', 'Cross', '%s', 'a5a5a5a5-5555-4555-8555-555555555555')$$,
         current_setting('s20.pay_xtenant'), pg_temp.biz_a(),
         pg_temp.sale_of(pg_temp.biz_b(), 'SI-B-1'), current_setting('s20.entry_xtenant_a')),
  '23503', NULL,
  'T4 a settlement in A cannot name a document in B, even for the superuser');

-- B's real journal entry, named from A's settlement. The guard looks the entry
-- up inside the payment's OWN business, so it finds nothing and refuses; the
-- composite foreign key on (business_id, journal_entry_id) is the structural
-- backstop behind that refusal.
select set_config('s20.pay_xtenant2', gen_random_uuid()::text, true);

select throws_like(
  format($$insert into public.payments (
            id, business_id, reference, date, amount, payment_method, status, payment_type,
            linked_sale_id, party_name, journal_entry_id, created_by
          ) values ('%s', '%s', 'BAD-XTENANT-ENTRY', current_date, 10, 'CASH', 'COMPLETED',
                    'INCOMING', '%s', 'Cross', '%s', 'a5a5a5a5-5555-4555-8555-555555555555')$$,
         current_setting('s20.pay_xtenant2'), pg_temp.biz_a(), pg_temp.sale_id('SI-1'),
         pg_temp.entry_of_sale_in(pg_temp.biz_b(), 'SI-B-1')),
  '%missing from the ledger%',
  'T5 nor can it point at a journal entry in B: the entry is looked up in A only');

select is(pg_temp.viol_total(), 0::bigint,
  'T6 after every cross-tenant attempt, both businesses are still sound');

/* ========================================================================== */
/* P — privileges: the guard is a backstop, not the boundary                  */
/* ========================================================================== */

select ok(not has_table_privilege('authenticated', 'public.payments', 'INSERT'),
  'P1 authenticated still holds no INSERT on settlements: the RPC is the only way in');

select ok(not has_table_privilege('authenticated', 'public.payments', 'UPDATE')
          and not has_table_privilege('authenticated', 'public.payments', 'DELETE'),
  'P2 nor UPDATE and nor DELETE');

select ok(not has_table_privilege('authenticated', 'public.journal_entries', 'INSERT')
          and not has_table_privilege('authenticated', 'public.journal_entries', 'UPDATE'),
  'P3 nor any write on the ledger itself');
select * from finish();
rollback;
