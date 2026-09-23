-- 024_control_account_integrity.test.sql
-- pgTAP suite: the CONTROL ACCOUNT vs DOCUMENT reconciliation as a database
-- diagnostic — public.control_account_integrity() (migration 014).
-- Run with: supabase test db   (LOCAL stack only)
--
-- Transactional (begin/rollback): every fixture below is rolled back, so a rerun
-- starts clean. The genuine two-session races live in 011/013/017/019 and are
-- deliberately not repeated here; this suite is about a READ-ONLY derivation.
--
-- What it proves
--   1. The diagnostic derives both sides independently in SQL: the 1030/2010
--      control accounts from journal lines, the document side from document
--      totals minus COMPLETED, non-voided settlements. Its numbers are checked--   against a SECOND, deliberately different SQL expression of the same rule
--      (D9, D20, D44), so a join or filter mistake cannot agree with itself.
--   2. It stays correct across the whole workflow: credit posting, partial,
--      repeated partial, full, over-settlement refusal, settlement void,
--      re-settlement, refused document void, and a document void — with the
--      embedded upfront settlement counted exactly once and the posting-time
--      snapshot never read.
--   3. It DETECTS a mismatch (D47-D56) in two directions, using test-only rows
--      inside savepoints: a ledger entry with no document, and a settlement the
--      ledger never received. Nothing is weakened to make this possible — no
--      constraint is dropped, no production rule is bypassed — and rolling the
--      savepoint back proves a valid state reports OK again.
--   4. It is tenant-safe by construction: no parameters, SECURITY INVOKER, so a
--      caller sees one row per business they belong to and NULL — not zeros —
--      for anything else (D57-D65).
--   5. It is read-only (D46, D50): calling it changes no row of any financial
--      table, whether it reports OK or ERROR.

begin;
create extension if not exists pgtap with schema extensions;

select plan(89);

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
/* Fixtures: two independent businesses and a VIEWER in the first             */
/* -------------------------------------------------------------------------- */

insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a1a1a1a1-1111-4111-8111-11111111a1a1',
   'authenticated', 'authenticated', 'integrity-a@zeyks.test', '{"full_name":"Owner A"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b2b2b2b2-2222-4222-8222-22222222b2b2',
   'authenticated', 'authenticated', 'integrity-b@zeyks.test', '{"full_name":"Owner B"}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c3c3c3c3-3333-4333-8333-33333333c3c3',
   'authenticated', 'authenticated', 'integrity-viewer@zeyks.test', '{"full_name":"Viewer A"}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select public.create_business(
  'Integrity Business A', 'Owner A', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

select pg_temp.act_as('b2b2b2b2-2222-4222-8222-22222222b2b2');
set local role authenticated;
select public.create_business(
  'Integrity Business B', 'Owner B', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
);
reset role;

-- A VIEWER of business A: read access, no write access (see 022).
insert into public.business_memberships (business_id, user_id, role)
select b.id, 'c3c3c3c3-3333-4333-8333-33333333c3c3', 'VIEWER'
  from public.businesses b where b.business_name = 'Integrity Business A';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

create function pg_temp.biz_a() returns uuid
language sql security definer set search_path = '' as $$
  select id from public.businesses where business_name = 'Integrity Business A';
$$;

create function pg_temp.biz_b() returns uuid
language sql security definer set search_path = '' as $$
  select id from public.businesses where business_name = 'Integrity Business B';
$$;

/**
 * The diagnostic, called as whoever the CURRENT ROLE is.
 *
 * Deliberately SECURITY INVOKER (no `security definer`): when the test sets the
 * role to authenticated, this helper calls control_account_integrity() with that
 * caller's identity, so RLS decides what comes back. A definer helper here would
 * quietly test nothing about isolation.
 */
create function pg_temp.diag(p_biz uuid) returns jsonb
language sql set search_path = '' as $$
  select to_jsonb(d) from public.control_account_integrity() d where d.business_id = p_biz;
$$;

/** The numeric a caller can read for one side, or NULL when no row is visible. */
create function pg_temp.diag_field(p_biz uuid, p_side text, p_field text) returns numeric
language sql set search_path = '' as $$
  select case
    when p_side = 'AR' and p_field = 'control'    then d.receivable_control
    when p_side = 'AR' and p_field = 'documents'  then d.receivable_documents
    when p_side = 'AR' and p_field = 'difference' then d.receivable_difference
    when p_side = 'AP' and p_field = 'control'    then d.payable_control
    when p_side = 'AP' and p_field = 'documents'  then d.payable_documents
    when p_side = 'AP' and p_field = 'difference' then d.payable_difference
  end
  from public.control_account_integrity() d
 where d.business_id = p_biz;
$$;

create function pg_temp.diag_status(p_biz uuid, p_side text) returns text
language sql set search_path = '' as $$
  select case when p_side = 'AR' then d.receivable_status else d.payable_status end
    from public.control_account_integrity() d
   where d.business_id = p_biz;
$$;

/** Every business id the current caller can see in the diagnostic. */
create function pg_temp.diag_visible() returns uuid[]
language sql set search_path = '' as $$
  select coalesce(array_agg(d.business_id order by d.business_id), '{}'::uuid[])
    from public.control_account_integrity() d;
$$;

/** A second, independently written expression of the document side. */
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

create function pg_temp.docs_alt_ap(p_biz uuid) returns numeric
language sql security definer set search_path = '' as $$
  with live as (
    select p.linked_purchase_id as doc_id, sum(p.amount) as amount
      from public.payments p
     where p.business_id = p_biz
       and p.linked_purchase_id is not null
       and p.status = 'COMPLETED'
       and p.doc_status <> 'VOIDED'
     group by p.linked_purchase_id
  )
  select coalesce(sum(p.total_amount - coalesce(l.amount, 0)), 0)::numeric(14,2)
    from public.purchases p
    left join live l on l.doc_id = p.id
   where p.business_id = p_biz and p.status <> 'VOIDED';
$$;

/**
 * Manufacture a ledger entry with no document behind it: a balanced MANUAL
 * receipt that credits receivable for nothing.
 *
 * TEST-ONLY, and deliberately the narrowest thing that can create this state:
 * it inserts one balanced entry as the superuser, inside a savepoint the suite
 * rolls back. No container constraint is dropped, no trigger is disabled and no
 * production rule is bypassed — the application cannot reach this state through
 * any RPC, which is exactly why the diagnostic exists to notice it.
 */
create function pg_temp.add_unbacked_receipt(p_biz uuid, p_uid uuid, p_amount numeric)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_entry uuid;
begin
  insert into public.journal_entries (
    business_id, transaction_date, sequence, description, reference, source_type, created_by
  ) values (
    p_biz, current_date,
    (select coalesce(max(e.sequence), 0) + 1 from public.journal_entries e where e.business_id = p_biz),
    'Test-only unbacked receipt', 'TEST-UNBACKED', 'MANUAL', p_uid
  ) returning id into v_entry;

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

/**
 * Manufacture a settlement the ledger never received: a COMPLETED payment row
 * linked to a document whose journal entry is the document's own, so it is a
 * mis-linked settlement rather than an unposted document.
 *
 * TEST-ONLY, same savepoint reasoning as above.
 */
create function pg_temp.add_unposted_settlement(
  p_biz uuid, p_doc uuid, p_entry uuid, p_uid uuid, p_amount numeric
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_payment uuid;
begin
  insert into public.payments (
    business_id, reference, date, amount, payment_method, status, payment_type,
    linked_sale_id, party_name, journal_entry_id, created_by
  ) values (
    p_biz, 'TEST-UNPOSTED', current_date, p_amount, 'CASH', 'COMPLETED', 'INCOMING',
    p_doc, 'Ledger customer', p_entry, p_uid
  ) returning id into v_payment;

  return v_payment;
end $$;

/** A fingerprint of every row the diagnostic reads — proves it writes nothing. */
create function pg_temp.fingerprint() returns text
language sql security definer set search_path = '' as $$
  select concat_ws('|',
    (select count(*) from public.journal_entries),
    (select coalesce(sum(debit + credit), 0) from public.journal_lines),
    (select count(*) from public.payments),
    (select coalesce(sum(amount), 0) from public.payments),
    (select count(*) from public.sales where status = 'VOIDED'),
    (select count(*) from public.purchases where status = 'VOIDED'),
    (select md5(string_agg(status, ',' order by id)) from public.payments)
  );
$$;

create function pg_temp.sale_id(p_invoice text) returns uuid
language sql security definer set search_path = '' as $$
  select id from public.sales
   where business_id = pg_temp.biz_a() and invoice_number = p_invoice;
$$;

create function pg_temp.bill_id(p_ref text) returns uuid
language sql security definer set search_path = '' as $$
  select id from public.purchases
   where business_id = pg_temp.biz_a() and reference_number = p_ref;
$$;

create function pg_temp.entry_of_sale(p_invoice text) returns uuid
language sql security definer set search_path = '' as $$
  select journal_entry_id from public.sales
   where business_id = pg_temp.biz_a() and invoice_number = p_invoice;
$$;

create function pg_temp.settled(p_doc uuid) returns numeric
language sql security definer set search_path = '' as $$
  select coalesce(sum(p.amount), 0)::numeric(14,2)
    from public.payments p
   where p.business_id = pg_temp.biz_a()
     and (p.linked_sale_id = p_doc or p.linked_purchase_id = p_doc)
     and p.status = 'COMPLETED'
     and p.doc_status = 'POSTED';
$$;

/** Post a credit sale in business A as the current role. */
create function pg_temp.new_sale(p_invoice text, p_total numeric, p_upfront numeric, p_method text)
returns uuid language plpgsql as $$
declare
  v_payload jsonb;
begin
  v_payload := public.post_sale(
    p_business_id := pg_temp.biz_a(), p_customer_id := null, p_customer_name := 'Ledger customer',
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

/** Post a bill in business A as the current role. */
create function pg_temp.new_bill(p_ref text, p_total numeric, p_upfront numeric, p_method text)
returns uuid language plpgsql as $$
declare
  v_payload jsonb;
begin
  v_payload := public.post_purchase(
    p_business_id := pg_temp.biz_a(), p_supplier_id := null, p_supplier_name := 'Ledger supplier',
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

/** Settle, recording either success or the refusal — never aborting the suite. */
create function pg_temp.try_settle(
  p_name text, p_type text, p_doc uuid, p_amount numeric,
  p_method text default 'CASH', p_key text default null
) returns void language plpgsql as $$
begin
  begin
    perform public.post_payment(
      pg_temp.biz_a(), p_type, p_doc, p_amount, p_method, current_date, '', 'integrity', p_key
    );
    insert into attempts values (p_name, 'none', 'no error was raised');
  exception when others then
    insert into attempts values (p_name, sqlstate, sqlerrm);
  end;
end $$;

create function pg_temp.try_void_payment(p_name text, p_payment uuid)
returns void language plpgsql as $$
begin
  begin
    perform public.void_payment(pg_temp.biz_a(), p_payment);
    insert into attempts values (p_name, 'none', 'no error was raised');
  exception when others then
    insert into attempts values (p_name, sqlstate, sqlerrm);
  end;
end $$;

create function pg_temp.try_void_document(p_name text, p_type text, p_doc uuid)
returns void language plpgsql as $$
begin
  begin
    perform public.void_document(pg_temp.biz_a(), p_type, p_doc);
    insert into attempts values (p_name, 'none', 'no error was raised');
  exception when others then
    insert into attempts values (p_name, sqlstate, sqlerrm);
  end;
end $$;

create function pg_temp.payment_id(p_key text) returns uuid
language sql security definer set search_path = '' as $$
  select id from public.payments
   where business_id = pg_temp.biz_a() and idempotency_key = p_key;
$$;

create temp table fp (label text primary key, value text);
grant all on fp to authenticated, anon;

create temp table visible (label text primary key, ids uuid[]);
grant all on visible to authenticated, anon;

grant execute on function
  pg_temp.biz_a(), pg_temp.biz_b(), pg_temp.diag(uuid), pg_temp.diag_field(uuid, text, text),
  pg_temp.diag_status(uuid, text), pg_temp.diag_visible(), pg_temp.sale_id(text),
  pg_temp.bill_id(text), pg_temp.new_sale(text, numeric, numeric, text),
  pg_temp.new_bill(text, numeric, numeric, text),
  pg_temp.try_settle(text, text, uuid, numeric, text, text),
  pg_temp.try_void_payment(text, uuid), pg_temp.try_void_document(text, text, uuid)
  to authenticated, anon;

/* -------------------------------------------------------------------------- */
/* The shape of the thing itself                                              */
/* -------------------------------------------------------------------------- */

select is(
  (select prosecdef from pg_proc where oid = 'public.control_account_integrity()'::regprocedure),
  false,
  'D1 the diagnostic runs as the caller, not as its owner'
);

select is(
  (select provolatile from pg_proc where oid = 'public.control_account_integrity()'::regprocedure),
  's',
  'D2 and is STABLE: it reads, it never writes'
);

select ok(
  (select exists (select 1 from unnest(proconfig) c where c like 'search_path=%')
     from pg_proc where oid = 'public.control_account_integrity()'::regprocedure),
  'D3 with search_path pinned'
);

select is(
  (select pg_get_function_arguments(p.oid) from pg_proc p
    where p.oid = 'public.control_account_integrity()'::regprocedure),
  ''::text,
  'D4 and takes no argument, so there is no business id to forge'
);

/* -------------------------------------------------------------------------- */
/* An empty business is balanced                                              */
/* -------------------------------------------------------------------------- */

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 0::numeric,
  'D5 a business with no documents has a zero control balance');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D6 which trivially agrees with nothing');
reset role;

/* -------------------------------------------------------------------------- */
/* CUSTOMER SIDE: a 1000 credit invoice                                       */
/* -------------------------------------------------------------------------- */

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.new_sale('I-1', 1000, 0, 'CASH');
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 1000::numeric,
  'D7 the control side reads the full invoice out of the ledger');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'documents'), 1000::numeric,
  'D8 the document side reads the same 1000');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'documents'), pg_temp.docs_alt(pg_temp.biz_a()),
  'D9 and it equals an independently written version of the same rule');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'difference'), 0::numeric,
  'D10 leaving a zero difference');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D11 which the diagnostic reports as OK');
reset role;

/* --- partial settlement --------------------------------------------------- */

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.try_settle('s1', 'SALE', pg_temp.sale_id('I-1'), 400, 'CASH', 'k-i1');
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is((select sqlstate from attempts where name = 's1'), 'none'::text,
  'D12 a partial receipt is accepted');
select is(pg_temp.settled(pg_temp.sale_id('I-1')), 400::numeric,
  'D13 and settles 400');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 600::numeric,
  'D14 the control side drops to 600');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'documents'), 600::numeric,
  'D15 the document side drops to 600 as well');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D16 so they still agree');
reset role;

/* --- a second partial, then the balance ----------------------------------- */

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.try_settle('s2', 'SALE', pg_temp.sale_id('I-1'), 250, 'BANK', 'k-i2');
select pg_temp.try_settle('s3', 'SALE', pg_temp.sale_id('I-1'), 350, 'ESEWA', 'k-i3');
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is((select count(*)::int from public.payments
            where business_id = pg_temp.biz_a() and linked_sale_id = pg_temp.sale_id('I-1')), 3,
  'D17 three receipts add up to the invoice');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 0::numeric,
  'D18 a fully settled invoice leaves nothing in receivable');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'documents'), 0::numeric,
  'D19 and nothing outstanding on the document either');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'documents'), pg_temp.docs_alt(pg_temp.biz_a()),
  'D20 the two document-side expressions still agree');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D21 so the diagnostic is OK');
reset role;

/* --- over-settlement is refused and changes nothing ----------------------- */

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.try_settle('s4', 'SALE', pg_temp.sale_id('I-1'), 100, 'CASH', 'k-i4');
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select isnt((select sqlstate from attempts where name = 's4'), 'none'::text,
  'D22 settling more than is outstanding is refused');
select is((select count(*)::int from public.payments
            where business_id = pg_temp.biz_a() and linked_sale_id = pg_temp.sale_id('I-1')), 3,
  'D23 and the refusal created no fourth settlement row');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D24 the diagnostic is unmoved by a refused settlement');
reset role;

/* --- void a receipt: the money is receivable again ------------------------ */

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.try_void_payment('v1', pg_temp.payment_id('k-i3'));
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is((select sqlstate from attempts where name = 'v1'), 'none'::text,
  'D25 the last receipt can be voided');
select is(pg_temp.settled(pg_temp.sale_id('I-1')), 650::numeric,
  'D26 the voided row stops counting as received');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 350::numeric,
  'D27 the control side goes back to 350');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'documents'), 350::numeric,
  'D28 and so does the document side');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D29 the two agree again across a settlement void');
reset role;

/* --- re-settlement after the void ---------------------------------------- */

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.try_settle('s5', 'SALE', pg_temp.sale_id('I-1'), 350, 'KHALTI', 'k-i5');
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 0::numeric,
  'D30 receiving the money again clears the control account');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'documents'), pg_temp.docs_alt(pg_temp.biz_a()),
  'D31 and matches the independent document-side expression');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D32 the diagnostic holds across void and re-settlement');
reset role;

/* --- a settled invoice cannot be voided; the boxes stay balanced ---------- */

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.try_void_document('vd1', 'SALE', pg_temp.sale_id('I-1'));
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is((select sqlstate from attempts where name = 'vd1'), '22023'::text,
  'D33 a document with a standing settlement is not voidable');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D34 and the refused void left both sides alone');
reset role;

/* --- reverse the standing settlements, then void the invoice -------------- */

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.try_void_payment('v2', pg_temp.payment_id('k-i5'));
select pg_temp.try_void_payment('v3', pg_temp.payment_id('k-i2'));
select pg_temp.try_void_payment('v4', pg_temp.payment_id('k-i1'));
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.settled(pg_temp.sale_id('I-1')), 0::numeric,
  'D35 every receipt has been reversed');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 1000::numeric,
  'D36 so the whole invoice is receivable again');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'documents'), 1000::numeric,
  'D37 on both sides');
select pg_temp.try_void_document('vd2', 'SALE', pg_temp.sale_id('I-1'));
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is((select sqlstate from attempts where name = 'vd2'), 'none'::text,
  'D38 with no settlement standing, the invoice can be voided');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 0::numeric,
  'D39 its reversal takes it out of the ledger');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'documents'), 0::numeric,
  'D40 and a voided document owes nothing to the document side');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D41 so a clean void leaves the diagnostic OK');
reset role;

/* -------------------------------------------------------------------------- */
/* SUPPLIER SIDE: a bill with 300 paid at posting                            */
/* -------------------------------------------------------------------------- */

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.new_bill('B-1', 800, 300, 'BANK');
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AP', 'control'), 500::numeric,
  'D42 the payable control account carries the unpaid 500');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AP', 'documents'), 500::numeric,
  'D43 and the document side matches it');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AP', 'documents'), pg_temp.docs_alt_ap(pg_temp.biz_a()),
  'D44 the payable document side equals an independently written expression');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AP'), 'OK'::text,
  'D45 with the upfront settlement counted exactly once, not twice');
reset role;

/* --- the read-only proof -------------------------------------------------- */

insert into fp values ('clean', pg_temp.fingerprint());

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.diag(pg_temp.biz_a());
select pg_temp.diag_visible();
reset role;
select pg_temp.act_as('b2b2b2b2-2222-4222-8222-22222222b2b2');
set local role authenticated;
select pg_temp.diag(pg_temp.biz_b());
reset role;

select is(pg_temp.fingerprint(), (select value from fp where label = 'clean'),
  'D46 calling the diagnostic from two different callers leaves every row untouched');

/* -------------------------------------------------------------------------- */
/* MISMATCH DETECTION (test-only rows, inside a savepoint)                    */
/* -------------------------------------------------------------------------- */

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.new_sale('I-2', 700, 0, 'CASH');
reset role;

savepoint before_bad_ledger;

-- A balanced MANUAL entry that credits receivable with no document behind it.
select pg_temp.add_unbacked_receipt(pg_temp.biz_a(), 'a1a1a1a1-1111-4111-8111-11111111a1a1', 250);
insert into fp values ('bad_ledger', pg_temp.fingerprint());

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'ERROR'::text,
  'D47 a ledger entry with no document behind it is detected');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'difference'), (-250)::numeric,
  'D48 and the difference names the amount it is out by');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 450::numeric,
  'D49 with the control side reported as it really is');
reset role;

select is(pg_temp.fingerprint(), (select value from fp where label = 'bad_ledger'),
  'D50 reporting ERROR still changes nothing: it detects, it never repairs');

rollback to savepoint before_bad_ledger;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D51 and the same book reports OK once the bad row is gone');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 700::numeric,
  'D52 with the ledger back to just the real invoice');
reset role;

savepoint before_bad_settlement;

-- A settlement the ledger never received: a COMPLETED payment row linked to the
-- invoice whose journal entry is the invoice's own, so it is a mis-linked
-- settlement rather than an unposted document.
select pg_temp.add_unposted_settlement(
  pg_temp.biz_a(), pg_temp.sale_id('I-2'), pg_temp.entry_of_sale('I-2'),
  'a1a1a1a1-1111-4111-8111-11111111a1a1', 100
);

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'ERROR'::text,
  'D53 a settlement the ledger never received is detected');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'difference'), 100::numeric,
  'D54 with the difference on the other side this time');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'documents'), 600::numeric,
  'D55 and the document side is where the 100 went');
reset role;

rollback to savepoint before_bad_settlement;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D56 and it recovers to OK when the mis-linked row is gone');
reset role;

/* -------------------------------------------------------------------------- */
/* TENANT ISOLATION                                                           */
/* -------------------------------------------------------------------------- */

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_visible(), array[pg_temp.biz_a()],
  'D57 a member of A sees exactly their own business');
select is(pg_temp.diag(pg_temp.biz_b()), null,
  'D58 and no row at all for B — not zeros, which would look balanced');
reset role;

select pg_temp.act_as('b2b2b2b2-2222-4222-8222-22222222b2b2');
set local role authenticated;
select is(pg_temp.diag_visible(), array[pg_temp.biz_b()],
  'D59 a member of B sees exactly their own business');
select is(pg_temp.diag(pg_temp.biz_a()), null,
  'D60 and none of A');
reset role;

select pg_temp.act_as('c3c3c3c3-3333-4333-8333-33333333c3c3');
set local role authenticated;
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D61 a VIEWER of A may read the diagnostic');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AP', 'control'), 500::numeric,
  'D62 and sees the same payable figure an owner would');
reset role;

-- A mismatch in B must not colour A's answer.
savepoint before_b_mismatch;
select pg_temp.add_unbacked_receipt(pg_temp.biz_b(), 'b2b2b2b2-2222-4222-8222-22222222b2b2', 400);

select pg_temp.act_as('b2b2b2b2-2222-4222-8222-22222222b2b2');
set local role authenticated;
select is(pg_temp.diag_status(pg_temp.biz_b(), 'AR'), 'ERROR'::text,
  'D63 B sees its own mismatch');
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D64 while A is unaffected by anything in B');
select is(pg_temp.diag_visible(), array[pg_temp.biz_a()],
  'D65 and A still sees only itself');
reset role;
rollback to savepoint before_b_mismatch;

/* -------------------------------------------------------------------------- */
/* PRIVILEGES                                                                 */
/* -------------------------------------------------------------------------- */

select is(
  (select count(*)::int from pg_proc p
    where p.oid = 'public.control_account_integrity()'::regprocedure
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  1,
  'D66 authenticated may execute the diagnostic'
);

select is(
  (select count(*)::int from pg_proc p
    where p.oid = 'public.control_account_integrity()'::regprocedure
      and has_function_privilege('anon', p.oid, 'EXECUTE')),
  0,
  'D67 anon may not'
);

set local role anon;
select throws_ok(
  'select * from public.control_account_integrity()',
  '42501',
  null,
  'D68 and an anonymous caller is refused outright'
);
reset role;

-- A member of nothing: authenticated, but in no business at all.
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'd4d4d4d4-4444-4444-8444-44444444d4d4',
   'authenticated', 'authenticated', 'integrity-outsider@zeyks.test', '{}'::jsonb, now(), now())
on conflict (id) do nothing;

select pg_temp.act_as('d4d4d4d4-4444-4444-8444-44444444d4d4');
set local role authenticated;
select is(pg_temp.diag_visible(), '{}'::uuid[],
  'D69 an authenticated user who belongs to no business sees nothing at all');
reset role;

/* -------------------------------------------------------------------------- */
/* VOID AND REVERSE, when the document's own entry carries the settlement     */
/* -------------------------------------------------------------------------- */
-- A document posted with money already settled at the counter writes its
-- settlement with the DOCUMENT's journal entry: one accounting event, not two.
-- Voiding it therefore has to reverse that entry once and flip the embedded row
-- to VOIDED — and if the ledger side were reversed twice, or the document side
-- stopped counting it twice, the two representations would part company here.
-- This is the reverse of D38-D41 (which voided a document whose settlements were
-- separately posted) and the nearest thing to a stress test the void path has.

-- Clear the board first: the invoice and bill from the earlier blocks are still
-- open, and this block asserts absolute figures.
select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.try_void_document('vd-clear-1', 'SALE', pg_temp.sale_id('I-2'));
select pg_temp.try_void_document('vd-clear-2', 'PURCHASE', pg_temp.bill_id('B-1'));
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 0::numeric,
  'D70 the board is clear: nothing left in receivable');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AP', 'control'), 0::numeric,
  'D71 and nothing left in payable');
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.new_sale('I-3', 500, 150, 'CASH');
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.settled(pg_temp.sale_id('I-3')), 150::numeric,
  'D72 the 150 settled at the counter is one settlement row');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 350::numeric,
  'D73 so the receivable control account carries the other 350');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'documents'), 350::numeric,
  'D74 and the document side agrees, counting it exactly once');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D75 with no mismatch to report');
select pg_temp.try_void_document('vd3', 'SALE', pg_temp.sale_id('I-3'));
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is((select sqlstate from attempts where name = 'vd3'), 'none'::text,
  'D76 a document with only its embedded settlement can be voided');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'control'), 0::numeric,
  'D77 one reversal clears the whole event from the ledger');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AR', 'documents'), 0::numeric,
  'D78 and the voided document owes nothing to the document side');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AR'), 'OK'::text,
  'D79 the two still agree — the reversal was not counted twice');
select is((select count(*)::int from public.payments
            where business_id = pg_temp.biz_a()
              and linked_sale_id = pg_temp.sale_id('I-3')
              and doc_status = 'VOIDED'), 1,
  'D80 and the embedded settlement is kept as history, marked VOIDED');
reset role;

-- The same on the payable side, this time with a separately posted payment
-- voided first — the full unwind in the order an accountant would do it.
select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select pg_temp.new_bill('B-2', 900, 400, 'BANK');
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AP', 'control'), 500::numeric,
  'D81 a bill with 400 paid at posting leaves 500 in payable');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AP', 'documents'), 500::numeric,
  'D82 which the document side agrees with');
select pg_temp.try_settle('p-b2', 'PURCHASE', pg_temp.bill_id('B-2'), 200, 'CASH', 'k-b2');
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AP', 'control'), 300::numeric,
  'D83 a supplier payment of 200 takes payable down to 300');
select pg_temp.try_void_payment('v-b2', pg_temp.payment_id('k-b2'));
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is((select sqlstate from attempts where name = 'v-b2'), 'none'::text,
  'D84 the separately posted payment is voidable');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AP', 'control'), 500::numeric,
  'D85 and its reversal puts payable back to 500');
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AP', 'documents'), 500::numeric,
  'D86 on both sides');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AP'), 'OK'::text,
  'D87 with the reversed payment counted as nothing');
select pg_temp.try_void_document('vd4', 'PURCHASE', pg_temp.bill_id('B-2'));
reset role;

select pg_temp.act_as('a1a1a1a1-1111-4111-8111-11111111a1a1');
set local role authenticated;
select is(pg_temp.diag_field(pg_temp.biz_a(), 'AP', 'control'), 0::numeric,
  'D88 voiding the bill reverses the rest once');
select is(pg_temp.diag_status(pg_temp.biz_a(), 'AP'), 'OK'::text,
  'D89 and the payable side still agrees with itself');
reset role;

/* -------------------------------------------------------------------------- */

select * from finish();
rollback;
