-- 027_settlement_integrity_concurrency.test.sql
-- pgTAP suite: a GENUINE concurrent settlement race, with migration 016's
-- settlement <-> journal guard in the write path. Two real database sessions.
-- Run with: supabase test db
--
-- Why this file is not wrapped in begin;/rollback; like 026:
--   a real race needs a second session, and a second session can only see
--   COMMITTED rows, so the fixtures below are committed on purpose, exactly as
--   011/013/017/019 do. Financial rows are append-only (001 forbid_modification),
--   so `supabase db reset --local` is the cleanup. Every run posts a fresh
--   invoice and uses fresh idempotency keys, and the fixture business is created
--   only if missing.
--
-- What it proves
--   post_payment locks the document row FOR UPDATE and *then* recomputes the
--   outstanding balance from the persisted sub-ledger, and migration 016 adds a
--   BEFORE INSERT OR UPDATE guard on every settlement row. Those two things have
--   to coexist: the guard must not turn a losing concurrent attempt into a
--   partial write, and the lock must still be what decides the winner. So two
--   different requests fight over one NPR 1000 invoice — 700 and 500 — and the
--   loser must WAIT on the lock and then be rejected as over-settlement, leaving
--   exactly one settlement and a settled total that never exceeds the document.
--   The document, not the client, is the arbiter.
--
-- Mechanism (established against this runner, not assumed — same as 011):
--   * `supabase test db` executes each file with psql inside a transient
--     supabase/pg_prove container whose PG{HOST,USER,PASSWORD,DATABASE} point at
--     the local database, so `\!` can open a genuinely separate psql session.
--   * the WINNER is spawned in the background and told to hold its transaction
--     open with pg_sleep AFTER post_payment(); it labels itself with
--     application_name in SQL (this psql build does not honour PGAPPNAME).
--   * the test session is the LOSER: it waits until the winner is visibly inside
--     that sleep, then calls post_payment itself and blocks on the same lock. The
--     measured wait is the proof that the overlap is real.

select plan(10);

create extension if not exists pgtap with schema extensions;

-- Unaligned, header-free output: the generated winner script below is written
-- with \o, and it has to be executable SQL rather than a printed table.
-- (Same arrangement as 011, the sibling race suite.)
\pset format unaligned
\pset tuples_only on

/* ========================================================================== */
/* The race                                                                    */
/* ========================================================================== */
-- The document row lock post_payment takes BEFORE recomputing the outstanding
-- balance must still do its job with migration 016's guard in the write path.
-- Two different requests fight over one NPR 1000 invoice; the loser must wait
-- and then be rejected, so the persisted state can never exceed the document
-- total — no matter that the guard now runs on every settlement row.

create temp table loser (ok boolean, sqlstate text, message text, ms numeric);
grant all on loser to authenticated;

create function pg_temp.viol_total() returns bigint
language sql security definer set search_path = '' as $$
  select
    (select count(*) from public.payments p
      where (p.linked_sale_id is null) = (p.linked_purchase_id is null))
    + (select count(*) from public.payments p
         join public.journal_entries e
           on e.business_id = p.business_id and e.id = p.journal_entry_id
        where not (
          (e.source_type = 'PAYMENT' and e.source_id = p.id)
          or (e.source_type = 'SALE' and e.source_id = p.linked_sale_id)
          or (e.source_type = 'PURCHASE' and e.source_id = p.linked_purchase_id)
        ))
    + (select count(*) from public.payments p
         join public.journal_entries e
           on e.business_id = p.business_id and e.id = p.journal_entry_id
        where p.doc_status = 'VOIDED' and e.reversed_by_entry_id is null)
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

insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'dd888888-8888-4888-8888-888888888888',
        'authenticated', 'authenticated', 'si-race-owner@zeyks.test',
        '{"full_name":"Race Owner"}'::jsonb, now(), now())
on conflict (id) do nothing;

select jsonb_build_object('sub', 'dd888888-8888-4888-8888-888888888888', 'role', 'authenticated')::text as claims \gset
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
select public.create_business(
  'Settlement Integrity Race', 'Race Owner', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
)
where not exists (select 1 from public.businesses where business_name = 'Settlement Integrity Race');
reset role;

select id as race_biz from public.businesses where business_name = 'Settlement Integrity Race' \gset
select 'SIR-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as inv \gset
select 'k-sir-w-' || substr(gen_random_uuid()::text, 1, 8) as kwin \gset
select 'k-sir-l-' || substr(gen_random_uuid()::text, 1, 8) as klose \gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
select (public.post_sale(
  p_business_id := :'race_biz', p_customer_id := null, p_customer_name := 'Race customer',
  p_invoice_number := :'inv', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as race_sale \gset
reset role;

select set_config('race.biz', :'race_biz', false);
select set_config('race.sale', :'race_sale', false);
select set_config('race.kwin', :'kwin', false);
select set_config('race.klose', :'klose', false);

select is((select count(*) from public.payments where linked_sale_id = :'race_sale'), 0::bigint,
  'R1 setup: the race invoice starts with nothing settled');

\o /tmp/si_race_winner.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.post_payment(%L, %L, %L, %L::numeric, %L, %L::date, %L, %L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'si_race_winner',
  'request.jwt.claims', :'claims',
  :'race_biz', 'SALE', :'race_sale', 700, 'CASH', (current_date - 1)::text, '', 'race winner', :'kwin'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/si_race_winner.sql > /tmp/si_race_winner.out 2>/tmp/si_race_winner.err; echo $? > /tmp/si_race_winner.exit; } > /dev/null 2>&1 &

\set winner_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'si_race_winner' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

select is(:'winner_visible'::text, 'visible'::text,
  'R2 a real second session was observed holding the winning settlement open');

truncate loser;
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

do $race$
declare
  v_t0      timestamptz;
  v_payload jsonb;
  v_state   text;
  v_msg     text;
begin
  v_t0 := clock_timestamp();
  begin
    select public.post_payment(
      current_setting('race.biz')::uuid, 'SALE'::text, current_setting('race.sale')::uuid,
      500::numeric, 'CASH'::text, (current_date - 1)::date, ''::text, 'race loser'::text,
      current_setting('race.klose')
    ) into v_payload;
  exception when others then
    v_state := sqlstate;
    v_msg := sqlerrm;
  end;

  insert into loser (ok, sqlstate, message, ms)
  values (v_payload is not null, v_state, v_msg,
          extract(epoch from clock_timestamp() - v_t0) * 1000);
end $race$;

reset role;

select ok((select ms from loser) >= 1000,
  'R3 the competing settlement blocked on the document lock for ' ||
  round((select ms from loser)) || ' ms — a real overlap, not serialization');

select is((select sqlstate from loser), '22023'::text,
  'R4 then it was rejected as over-settlement');

select ok((select message from loser) like '%exceeds the outstanding balance%',
  'R5 with the outstanding balance named, not a raw database error');

select is((select count(*)::int from public.payments where linked_sale_id = :'race_sale'), 1,
  'R6 exactly one settlement exists afterwards: the winner''s');

select is((select sum(p.amount) from public.payments p where p.linked_sale_id = :'race_sale'),
          700::numeric,
  'R7 for 700, so the settled total never exceeded the 1000 the invoice was for');

select is(
  (select count(*)::int from public.payments
    where business_id = :'race_biz' and idempotency_key = current_setting('race.klose')),
  0, 'R8 and the refused request left no row of its own behind');

select is((select d.receivable_status from public.control_account_integrity() d
            where d.business_id = :'race_biz'),
          'OK'::text,
  'R9 the race left the ledger agreeing with the documents');

select is(pg_temp.viol_total(), 0::bigint,
  'R10 and every settlement, however it was raced, satisfies the invariant');

select * from finish();
