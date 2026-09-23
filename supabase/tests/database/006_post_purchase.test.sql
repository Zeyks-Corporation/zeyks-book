-- 006_post_purchase.test.sql
-- pgTAP test suite for public.post_purchase() RPC (migration 006).
-- Run with: supabase test db
--
-- Covers the Stage 3 requirements:
--   A-W  security, validation, accounting semantics, settlement invariants,
--        atomicity, idempotency, server reference allocation and reload.
-- Comment labels name the cases; a case may make more than one assertion.

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
-- Fixtures: Alice (Owner A), Bob (Owner B), Carol (Viewer A), Dan (Accountant A)
-- Business A starts unregistered and without inventory tracking.
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

select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.create_business('Business A');
reset role;

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

  insert into public.business_memberships (business_id, user_id, role)
  values (v_biz_a, 'c3333333-3333-4333-8333-333333333333', 'VIEWER'),
         (v_biz_a, 'd4444444-4444-4444-8444-444444444444', 'ACCOUNTANT');

  insert into public.suppliers (business_id, name)
  values (v_biz_a, 'Supplier Alpha'),
         (v_biz_b, 'Supplier Beta');
end $$;

-- Look businesses up by immutable creator, not the renameable name.
create function pg_temp.biz_a() returns uuid language sql security definer as $$
  select id from public.businesses
   where created_by = 'a1111111-1111-4111-8111-111111111111' limit 1;
$$;
create function pg_temp.biz_b() returns uuid language sql security definer as $$
  select id from public.businesses
   where created_by = 'b2222222-2222-4222-8222-222222222222' limit 1;
$$;
create function pg_temp.sup_a() returns uuid language sql security definer as $$
  select id from public.suppliers where name = 'Supplier Alpha' limit 1;
$$;
create function pg_temp.sup_b() returns uuid language sql security definer as $$
  select id from public.suppliers where name = 'Supplier Beta' limit 1;
$$;
grant execute on function pg_temp.biz_a() to authenticated, anon;
grant execute on function pg_temp.biz_b() to authenticated, anon;
grant execute on function pg_temp.sup_a() to authenticated, anon;
grant execute on function pg_temp.sup_b() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------
-- 01 anon cannot execute at all
set local role anon;
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-ANON', '2026-01-01'::date,
    100, 0, 0, 100, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb,
    'k-anon', true
  )$$, pg_temp.biz_a()),
  '42501', NULL,
  'anon cannot call post_purchase'
);
reset role;

-- 02 a JWT without a subject
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(
  $$select public.post_purchase(
    '00000000-0000-0000-0000-000000000000'::uuid, null, 'Supplier Alpha', 'PO-NOSUB', '2026-01-01'::date,
    100, 0, 0, 100, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb,
    'k-nosub', true
  )$$,
  '28000', NULL,
  'a caller without auth.uid() is rejected'
);
reset role;

-- 03 non-member (Bob) is rejected
select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
set local role authenticated;
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-NONMEMBER', '2026-01-01'::date,
    100, 0, 0, 100, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb,
    'k-nonmember', true
  )$$, pg_temp.biz_a()),
  '42501', NULL,
  'a non-member cannot post a purchase to Business A'
);
reset role;

-- 04 VIEWER (Carol) is rejected
select pg_temp.act_as('c3333333-3333-4333-8333-333333333333');
set local role authenticated;
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-VIEWER', '2026-01-01'::date,
    100, 0, 0, 100, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb,
    'k-viewer', true
  )$$, pg_temp.biz_a()),
  '42501', NULL,
  'a VIEWER cannot post a purchase'
);
reset role;

-- 05 cross-tenant supplier is rejected
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, '%s'::uuid, 'Supplier Beta', 'PO-CROSSSUP', '2026-01-01'::date,
    100, 0, 0, 100, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb,
    'k-crosssup', true
  )$$, pg_temp.biz_a(), pg_temp.sup_b()),
  '22023', NULL,
  'a supplier belonging to another business is rejected'
);
reset role;

-- ---------------------------------------------------------------------------
-- Unpaid purchase (Business A: no VAT, no inventory tracking)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

-- 06 owner can create with a valid supplier id
select isnt(
  (select (public.post_purchase(
    pg_temp.biz_a(), pg_temp.sup_a(), 'Supplier Alpha', 'PO-UNPAID', '2026-01-01'::date,
    2000, 0, 0, 2000, 0, 'CASH', null,
    '[{"line_no":1,"description":"Bulk goods","quantity":2,"unit_price":1000,"discount":0,"total":2000}]'::jsonb,
    'k-unpaid', false
  )->'purchase'->>'id')),
  NULL,
  'owner can create a purchase with a valid supplier'
);

-- 07 unpaid journal: Dr COGS 5010, Cr Accounts payable 2010
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.purchases where reference_number = 'PO-UNPAID')),
  '5010:2000:0, 2010:0:2000',
  'unpaid purchase debits COGS 5010 and credits Accounts payable 2010'
);

-- 08 upfront = 0 creates no settlement row
select is(
  (select count(*) from public.payments where linked_purchase_id = (select id from public.purchases where reference_number = 'PO-UNPAID'))::int,
  0,
  'an unpaid purchase creates zero payment rows'
);

-- 09 ACCOUNTANT (Dan) can create
select pg_temp.act_as('d4444444-4444-4444-8444-444444444444');
select isnt(
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', 'PO-ACCOUNTANT', '2026-01-02'::date,
    500, 0, 0, 500, 500, 'CASH', null,
    '[{"line_no":1,"description":"Ledger book","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb,
    'k-accountant', false
  )->'purchase'->>'id')),
  NULL,
  'an ACCOUNTANT can create a purchase'
);

-- ---------------------------------------------------------------------------
-- Fully paid and partially paid purchases
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
select isnt(
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', 'PO-FULL', '2026-01-03'::date,
    1000, 0, 0, 1000, 1000, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
    'k-full', false
  )->'purchase'->>'id')),
  NULL,
  'fully paid purchase created'
);

-- 10 fully paid journal: Dr COGS, Cr Cash
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.purchases where reference_number = 'PO-FULL')),
  '5010:1000:0, 1010:0:1000',
  'fully paid purchase debits COGS 5010 and credits Cash 1010'
);

-- 11 exactly one settlement row matching the upfront amount
select is(
  (select count(*) from public.payments where linked_purchase_id = (select id from public.purchases where reference_number = 'PO-FULL'))::int,
  1,
  'a fully paid purchase has exactly one payment row'
);
select is(
  (select amount from public.payments where linked_purchase_id = (select id from public.purchases where reference_number = 'PO-FULL'))::int,
  1000,
  'the settlement row amount equals the upfront amount'
);

select isnt(
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', 'PO-PART', '2026-01-04'::date,
    1000, 0, 0, 1000, 300, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
    'k-part', false
  )->'purchase'->>'id')),
  NULL,
  'partially paid purchase created'
);

-- 12 partial journal: Dr COGS, Cr Cash 300, Cr Payable 700
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.purchases where reference_number = 'PO-PART')),
  '5010:1000:0, 1010:0:300, 2010:0:700',
  'partial purchase splits the credit between Cash and Accounts payable'
);

-- 13 one settlement row for the partial amount
select is(
  (select amount from public.payments where linked_purchase_id = (select id from public.purchases where reference_number = 'PO-PART'))::int,
  300,
  'the partial settlement row records 300'
);

-- 14 inventory authority: a client field cannot force Inventory when the
--    business setting is false.
select isnt(
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', 'PO-NOINV', '2026-01-05'::date,
    400, 0, 0, 400, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":400,"discount":0,"total":400,"track_inventory":true}]'::jsonb,
    'k-noinv', false
  )->'purchase'->>'id')),
  NULL,
  'purchase with a client inventory hint is accepted'
);
select is(
  (select count(*)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.purchases where reference_number = 'PO-NOINV')
      and a.code = '1060')::int,
  0,
  'client state cannot override businesses.track_inventory (no Inventory 1060 line)'
);

-- ---------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------
-- 15 total must equal subtotal + tax
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-BADTOTAL', '2026-01-01'::date,
    1000, 0, 0, 999, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
    'k-badtotal', true
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'a total that does not equal subtotal plus tax is rejected'
);

-- 16 incorrect line total
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-BADLINE', '2026-01-01'::date,
    200, 10, 0, 200, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":2,"unit_price":100,"discount":10,"total":200}]'::jsonb,
    'k-badline', true
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'a line total not matching quantity * unit_price - discount is rejected'
);

-- 17 discount exceeding the line gross value
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-DISC-EXCEED', '2026-01-01'::date,
    100, 150, 0, 100, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":150,"total":0}]'::jsonb,
    'k-discexceed', true
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'a line discount exceeding the line gross value is rejected'
);

-- 18 future date
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-FUTURE', ((now() at time zone 'Asia/Kathmandu')::date + interval '1 day')::date,
    1000, 0, 0, 1000, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
    'k-future', true
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'a future purchase date is rejected'
);

-- 19 upfront exceeding total
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-OVERPAID', '2026-01-01'::date,
    1000, 0, 0, 1000, 1500, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
    'k-overpaid', true
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'upfront paid exceeding the total is rejected'
);

-- 20 duplicate client reference
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-UNPAID', '2026-01-06'::date,
    2000, 0, 0, 2000, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":2,"unit_price":1000,"discount":0,"total":2000}]'::jsonb,
    'k-dup', true
  )$$, pg_temp.biz_a()),
  '23505', NULL,
  'a duplicate purchase reference is rejected'
);

-- 21 atomicity: a failed post leaves nothing behind
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-ROLLBACK', '2026-01-01'::date,
    1000, 0, 0, 999, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
    'k-rollback', true
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'an invalid purchase is rejected'
);
select is(
  (select count(*) from public.purchases where reference_number = 'PO-ROLLBACK')::int
  + (select count(*) from public.journal_entries where reference = 'PO-ROLLBACK')::int,
  0,
  'a failed purchase leaves no purchase row or journal entry (atomic rollback)'
);

-- ---------------------------------------------------------------------------
-- VAT policy
-- ---------------------------------------------------------------------------
-- 22 not registered for VAT: any tax is rejected (Business B)
select pg_temp.act_as('b2222222-2222-4222-8222-222222222222');
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Beta', 'PO-B-VAT', '2026-01-01'::date,
    1000, 0, 130, 1130, 1130, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
    'k-b-vat', false
  )$$, pg_temp.biz_b()),
  '22023', NULL,
  'an unregistered business cannot post a taxed purchase'
);

-- Business A becomes VAT registered
reset role;
update public.businesses set vat_registered = true, vat_rate = 13 where id = pg_temp.biz_a();
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

-- 23 registered but the tax does not match the applicable rate
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-WRONGVAT', '2026-01-01'::date,
    1000, 0, 50, 1050, 1050, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
    'k-wrongvat', false
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'a tax amount inconsistent with the VAT rate is rejected'
);

-- 24 VAT-exclusive purchase accepted (subtotal 1000, tax 130)
select isnt(
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', 'PO-VAT-EXCL', '2026-01-07'::date,
    1000, 0, 130, 1130, 1130, 'BANK', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
    'k-vat-excl', false
  )->'purchase'->>'id')),
  NULL,
  'a VAT-exclusive purchase is accepted'
);

-- 25 VAT journal: Dr COGS 1000, Dr VAT receivable 130, Cr Bank 1130
select is(
  (select string_agg(a.code || ':' || round(jl.debit,0)::text || ':' || round(jl.credit,0)::text, ', ' order by jl.line_no)
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.purchases where reference_number = 'PO-VAT-EXCL')),
  '5010:1000:0, 1070:130:0, 1020:0:1130',
  'VAT purchase debits COGS and VAT receivable 1070, credits Bank 1020'
);

-- 26 VAT-inclusive accepted via the explicit mode flag (total 1130 = item total)
select isnt(
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', 'PO-VAT-INCL', '2026-01-08'::date,
    1000, 0, 130, 1130, 1130, 'CASH', null,
    '[{"line_no":1,"description":"Inclusive item","quantity":1,"unit_price":1130,"discount":0,"total":1130}]'::jsonb,
    'k-vat-incl', true
  )->'purchase'->>'id')),
  NULL,
  'a VAT-inclusive purchase is accepted when the mode flag says so'
);

-- VAT: an omitted mode is inferred from the domain rule and persisted
select isnt(
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', 'PO-VAT-INFER', '2026-01-08'::date,
    1000, 0, 130, 1130, 1130, 'CASH', null,
    '[{"line_no":1,"description":"Inclusive item","quantity":1,"unit_price":1130,"discount":0,"total":1130}]'::jsonb,
    'k-vat-infer', null
  )->'purchase'->>'id')),
  NULL,
  'a purchase with an omitted VAT mode is accepted'
);
select is(
  (select price_includes_vat from public.purchases where reference_number = 'PO-VAT-INFER'),
  true,
  'the inferred VAT mode is persisted, keeping the idempotency fingerprint stable'
);

-- ---------------------------------------------------------------------------
-- Inventory tracking
-- ---------------------------------------------------------------------------
reset role;
update public.businesses set track_inventory = true where id = pg_temp.biz_a();
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

select isnt(
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', 'PO-INV', '2026-01-09'::date,
    1000, 0, 0, 1000, 1000, 'CASH', null,
    '[{"line_no":1,"description":"Stock","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
    'k-inv', false
  )->'purchase'->>'id')),
  NULL,
  'inventory-tracked purchase created'
);

-- Inventory tracking: Dr Inventory 1060 when tracking is on
select is(
  (select coalesce(sum(jl.debit), 0)::int
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.purchases where reference_number = 'PO-INV')
      and a.code = '1060'),
  1000,
  'inventory tracking posts the purchase value to Inventory 1060'
);

-- Inventory tracking: ...and not to COGS
select is(
  (select count(*)::int
     from public.journal_lines jl
     join public.accounts a on a.id = jl.account_id
    where jl.journal_entry_id = (select journal_entry_id from public.purchases where reference_number = 'PO-INV')
      and a.code = '5010'),
  0,
  'inventory-tracked purchase does not debit COGS 5010'
);

-- ---------------------------------------------------------------------------
-- Return payload
-- ---------------------------------------------------------------------------
-- Payload: the returned payload contains its items
select is(
  jsonb_array_length(
    (select public.post_purchase(
      pg_temp.biz_a(), null, 'Supplier Alpha', 'PO-PAYLOAD', '2026-01-10'::date,
      250, 0, 0, 250, 0, 'CASH', null,
      '[{"line_no":1,"description":"Item","quantity":1,"unit_price":250,"discount":0,"total":250}]'::jsonb,
      'k-payload', false
    )->'items')
  ),
  1,
  'the returned payload contains the purchase items'
);

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------
-- Idempotency: replaying the same key and request returns the original purchase id
select is(
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', 'PO-IDEM', '2026-01-11'::date,
    600, 0, 0, 600, 200, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":600,"discount":0,"total":600}]'::jsonb,
    'k-idem', false
  )->'purchase'->>'id')),
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', 'PO-IDEM', '2026-01-11'::date,
    600, 0, 0, 600, 200, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":600,"discount":0,"total":600}]'::jsonb,
    'k-idem', false
  )->'purchase'->>'id')),
  'an idempotent replay returns the original purchase, not a new one'
);

-- Idempotency: the replay did not create a second document or settlement
select is(
  (select count(*) from public.purchases where reference_number = 'PO-IDEM')::int,
  1,
  'the idempotent replay leaves exactly one purchase row'
);
select is(
  (select count(*) from public.payments where linked_purchase_id = (select id from public.purchases where reference_number = 'PO-IDEM'))::int,
  1,
  'the idempotent replay leaves exactly one payment row'
);

-- Idempotency: same key with a different amount is a conflict
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-IDEM', '2026-01-11'::date,
    999, 0, 0, 999, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":999,"discount":0,"total":999}]'::jsonb,
    'k-idem', false
  )$$, pg_temp.biz_a()),
  '23505', NULL,
  'reusing an idempotency key for a different amount is rejected'
);

-- Idempotency: same key with a different VAT mode is a conflict
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-VAT-EXCL', '2026-01-07'::date,
    1000, 0, 130, 1130, 1130, 'BANK', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
    'k-vat-excl', true
  )$$, pg_temp.biz_a()),
  '23505', NULL,
  'reusing an idempotency key with a different VAT mode is rejected'
);

-- Idempotency: an oversized key is rejected
select throws_ok(
  format($$select public.post_purchase(
    '%s'::uuid, null, 'Supplier Alpha', 'PO-LONGKEY', '2026-01-12'::date,
    100, 0, 0, 100, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb,
    repeat('x', 201), false
  )$$, pg_temp.biz_a()),
  '22023', NULL,
  'an idempotency key longer than 200 characters is rejected'
);

-- ---------------------------------------------------------------------------
-- Server reference allocation
-- ---------------------------------------------------------------------------
-- Reference allocation: blank references get distinct PO-YYYYMMDD-NNN numbers
select is(
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', '', '2026-02-01'::date,
    100, 0, 0, 100, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb,
    'k-auto-1', false
  )->'purchase'->>'reference_number')),
  'PO-20260201-001',
  'a blank reference is allocated PO-YYYYMMDD-001'
);
select is(
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', '', '2026-02-01'::date,
    100, 0, 0, 100, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb,
    'k-auto-2', false
  )->'purchase'->>'reference_number')),
  'PO-20260201-002',
  'the next blank reference on the same date increments independently'
);

-- Reference allocation: a different date starts its own sequence
select is(
  (select (public.post_purchase(
    pg_temp.biz_a(), null, 'Supplier Alpha', '', '2026-02-02'::date,
    100, 0, 0, 100, 0, 'CASH', null,
    '[{"line_no":1,"description":"Item","quantity":1,"unit_price":100,"discount":0,"total":100}]'::jsonb,
    'k-auto-3', false
  )->'purchase'->>'reference_number')),
  'PO-20260202-001',
  'the PO counter is scoped per business and date'
);

-- ---------------------------------------------------------------------------
-- Persisted reload
-- ---------------------------------------------------------------------------
-- Reload: re-reading purchases + purchase_items returns the persisted items
select is(
  (select count(*) from public.purchase_items
    where purchase_id = (select id from public.purchases where reference_number = 'PO-UNPAID'))::int,
  1,
  'purchase items survive a reload'
);

-- Every purchase journal written above is balanced
select is(
  (select count(*) from (
     select je.id
       from public.journal_entries je
       join public.journal_lines jl on jl.journal_entry_id = je.id
      where je.business_id = pg_temp.biz_a()
        and je.source_type = 'PURCHASE'
      group by je.id
     having sum(jl.debit) <> sum(jl.credit)
   ) unbalanced)::int,
  0,
  'every purchase journal entry balances (debits = credits)'
);

select * from finish();
rollback;
