-- 011_post_payment_concurrency.test.sql
-- pgTAP suite: GENUINE concurrent settlements, in two real database sessions.
-- Run with: supabase test db
--
-- Why this file is not wrapped in begin;/rollback; like its siblings:
--   a genuine race needs a second session, and a second session can only see
--   COMMITTED rows. The fixtures below are therefore committed on purpose.
--   Financial rows are append-only (001 forbid_modification), so they cannot be
--   deleted afterwards: `supabase db reset --local` is the cleanup. Every run
--   posts fresh documents, and the fixture business is created only if missing.
--
-- Mechanism (established against this runner, not assumed):
--   * `supabase test db` executes each file with psql inside a transient
--     supabase/pg_prove container. `\!` shell escapes run there, that container
--     carries PG{HOST,USER,PASSWORD,DATABASE} for the local database and sits on
--     the supabase network, so it can open a genuinely separate psql session.
--   * the WINNER is spawned in the background and told to hold its transaction
--     open with pg_sleep AFTER post_payment(); it labels itself with
--     application_name in SQL (this psql build does not honour PGAPPNAME).
--   * the test session is the LOSER. It waits - polling from the shell with
--     fresh connections, because a spawned psql can take seconds to start on a
--     cold container - until the winner is visibly inside that sleep, so the
--     document row lock is held. Then it calls post_payment itself and blocks
--     on that lock. The measured wait is the proof that the overlap is real
--     rather than serialized.
--   * the loser's behaviour is therefore a first-class SQL value, captured in a
--     temp table by a DO block, so both the replay and the rejection are
--     asserted exactly.
--
-- What each race proves (the rule in 009 section 4):
--   RACE 1  identical requests (same idempotency key, same document, same
--           amount): exactly one settlement row exists afterwards and the loser
--           replays THE SAME persisted payment and journal entry.
--   RACE 2  different requests fighting over one outstanding balance: only one
--           may consume it; the loser waits, recomputes due from the committed
--           sub-ledger and is rejected as over-settlement. No negative balance.
--   RACE 3  the same replay guarantee for an OUTGOING supplier payment.
--
-- No credentials are invented here: the spawned session inherits the runner's
-- own PGHOST/PGUSER/PGPASSWORD/PGDATABASE.

select plan(33);

create extension if not exists pgtap with schema extensions;

\pset format unaligned
\pset tuples_only on

-- ---------------------------------------------------------------------------
-- Committed, idempotent fixtures: one VAT-registered owner who tracks inventory
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'ee555555-5555-4555-8555-555555555555',
        'authenticated', 'authenticated', 'pay-race-owner@zeyks.test',
        '{"full_name":"Pay Race Owner"}'::jsonb, now(), now())
on conflict (id) do nothing;

select jsonb_build_object('sub', 'ee555555-5555-4555-8555-555555555555', 'role', 'authenticated')::text as claims
\gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
select public.create_business(
  'Payment Race Business', 'Pay Race Owner', '', '', '', '', '', 'NPR', 4::smallint, true, 13::numeric, true
)
where not exists (select 1 from public.businesses where business_name = 'Payment Race Business');
reset role;

select id as biz_id from public.businesses where business_name = 'Payment Race Business' \gset

-- Fresh documents per run, so a rerun always has POSTED rows to race over.
select 'PAYRACE-A-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as sale_a_ref \gset
select 'PAYRACE-B-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as sale_b_ref \gset
select 'PAYRACE-P-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as po_ref \gset

-- Idempotency keys are per run as well: committed settlements survive a run,
-- so a fixed key would replay the previous run's payment instead of racing.
select 'k-race-1-'  || substr(gen_random_uuid()::text, 1, 8) as race1_key \gset
select 'k-race-2w-' || substr(gen_random_uuid()::text, 1, 8) as race2_key_winner \gset
select 'k-race-2l-' || substr(gen_random_uuid()::text, 1, 8) as race2_key_loser \gset
select 'k-race-3-'  || substr(gen_random_uuid()::text, 1, 8) as race3_key \gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Pay race customer',
  p_invoice_number := :'sale_a_ref', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as sale_a \gset

select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Pay race customer',
  p_invoice_number := :'sale_b_ref', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as sale_b \gset

select (public.post_purchase(
  p_business_id := :'biz_id', p_supplier_id := null, p_supplier_name := 'Pay race supplier',
  p_reference_number := :'po_ref', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Race stock","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb,
  p_idempotency_key := null, p_price_includes_vat := false
))->'purchase'->>'id' as po_id \gset

reset role;

-- The race DO blocks below read these, because psql variables are not visible
-- inside plpgsql.
select set_config('race.sale_a', :'sale_a', false);
select set_config('race.sale_b', :'sale_b', false);
select set_config('race.po', :'po_id', false);
select set_config('race.key1', :'race1_key', false);
select set_config('race.key2l', :'race2_key_loser', false);
select set_config('race.key3', :'race3_key', false);

create temp table loser (
  ok boolean, payment_id text, entry_id text, sqlstate text, message text, ms numeric
);
grant all on loser to authenticated;

select is((select count(*) from public.businesses where business_name = 'Payment Race Business'), 1::bigint,
          'setup: reruns reuse the single fixture business (no duplicate business)');
select is((select count(*) from public.payments where linked_sale_id = :'sale_a'), 0::bigint,
          'setup: race sale A starts with nothing settled');
select is((select count(*) from public.payments where linked_purchase_id = :'po_id'), 0::bigint,
          'setup: race purchase starts with nothing settled (no embedded upfront)');

-- ---------------------------------------------------------------------------
-- RACE 1 - identical requests on sale A: the loser must REPLAY, not settle again
-- ---------------------------------------------------------------------------
\o /tmp/pay_race_sale_a.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.post_payment(%L, %L, %L, %L::numeric, %L, %L::date, %L, %L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'pay_race_winner_sale_a',
  'request.jwt.claims', :'claims',
  :'biz_id', 'SALE', :'sale_a', 400, 'CASH', (current_date - 1)::text, '', 'race 1 winner', :'race1_key'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/pay_race_sale_a.sql > /tmp/pay_race_sale_a.out 2>/tmp/pay_race_sale_a.err; echo $? > /tmp/pay_race_sale_a.exit; } > /dev/null 2>&1 &

\set race1_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'pay_race_winner_sale_a' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set race1_wexit `cat /tmp/pay_race_sale_a.exit 2>/dev/null || echo '(still running)'`
\set race1_werr `head -c 200 /tmp/pay_race_sale_a.err 2>/dev/null`
select diag('race 1 winner: visibility=' || :'race1_visible' || ' exit=' || :'race1_wexit' ||
            ' stderr=' || coalesce(nullif(:'race1_werr', ''), '(empty)'));

select is(:'race1_visible'::text, 'visible'::text,
          'race 1: a real second session was observed holding the winning settlement open');

truncate loser;
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

do $race1$
declare
  v_t0 timestamptz;
  v_biz uuid;
  v_doc uuid;
  v_payload jsonb;
  v_state text;
  v_msg text;
begin
  select id into v_biz from public.businesses where business_name = 'Payment Race Business';
  select id into v_doc from public.sales where id = current_setting('race.sale_a', true)::uuid;
  raise notice 'race 1 loser target: guc=%, biz=%, doc=%',
    current_setting('race.sale_a', true), v_biz, v_doc;

  v_t0 := clock_timestamp();
  begin
    select public.post_payment(
      v_biz, 'SALE'::text, v_doc,
      400::numeric, 'CASH'::text, (current_date - 1)::date, ''::text, 'race 1 winner'::text,
      current_setting('race.key1', true)
    ) into v_payload;
  exception when others then
    v_state := sqlstate; v_msg := sqlerrm;
  end;

  insert into loser (ok, payment_id, entry_id, sqlstate, message, ms)
  values (
    v_payload is not null,
    v_payload->'payment'->>'id',
    v_payload->'journal_entry'->>'id',
    v_state, v_msg,
    extract(epoch from clock_timestamp() - v_t0) * 1000
  );
end $race1$;

reset role;

select diag('race 1 loser wait: ' || round((select ms from loser)) || ' ms, sqlstate=' ||
            coalesce((select sqlstate from loser), '(none)'));

select ok((select ms from loser) >= 1000,
          'race 1: the second identical request blocked on the winner''s document lock for ' ||
          round((select ms from loser)) || ' ms (real overlap, not serialization)');
select is((select ok from loser), true,
          'race 1: the identical request is replayed, never an error');
select is((select payment_id from loser),
          (select p.id::text from public.payments p
            where p.business_id = :'biz_id' and p.idempotency_key = :'race1_key'),
          'race 1: the loser receives the SAME persisted payment the winner committed');
select is((select entry_id from loser),
          (select p.journal_entry_id::text from public.payments p
            where p.business_id = :'biz_id' and p.idempotency_key = :'race1_key'),
          'race 1: the loser receives the SAME journal entry, not a second one');
select is((select count(*) from public.payments p where p.business_id = :'biz_id' and p.idempotency_key = :'race1_key'),
          1::bigint,
          'race 1: two concurrent identical requests produced exactly ONE settlement row');
select is((select count(*)
             from public.journal_entries je
             join public.payments p on p.journal_entry_id = je.id
            where p.business_id = :'biz_id' and p.idempotency_key = :'race1_key' and je.source_type = 'PAYMENT'),
          1::bigint,
          'race 1: exactly one PAYMENT journal entry was written');
select is((select sum(p.amount) from public.payments p where p.linked_sale_id = :'sale_a'),
          400::numeric,
          'race 1: the sale took exactly 400 of money — the winner''s, once');
select is((select status from public.sales where id = :'sale_a'), 'POSTED',
          'race 1: the sale is still POSTED');
select is((select p.status || '|' || p.doc_status from public.payments p
            where p.business_id = :'biz_id' and p.idempotency_key = :'race1_key'),
          'COMPLETED|POSTED', 'race 1: the committed settlement is COMPLETED and POSTED');
select is((select count(*) from (
             select je.sequence from public.journal_entries je
              where je.business_id = :'biz_id'
              group by je.sequence having count(*) > 1) x),
          0::bigint, 'race 1: the race produced no duplicate journal sequence');

-- A further sequential identical request still replays read-only.
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
select (public.post_payment(:'biz_id', 'SALE'::text, :'sale_a'::uuid, 400::numeric, 'CASH'::text, (current_date - 1)::date, ''::text, 'race 1 winner'::text, current_setting('race.key1', true)))->'payment'->>'id' as race1_replay \gset
reset role;

select is(:'race1_replay'::text,
          (select p.id::text from public.payments p
            where p.business_id = :'biz_id' and p.idempotency_key = :'race1_key'),
          'race 1: a later retry still replays the same settlement');
select is((select count(*) from public.payments p where p.business_id = :'biz_id' and p.idempotency_key = :'race1_key'),
          1::bigint, 'race 1: the replay wrote nothing');

-- ---------------------------------------------------------------------------
-- RACE 2 - different requests fighting over sale B's outstanding balance
-- ---------------------------------------------------------------------------
\o /tmp/pay_race_sale_b.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.post_payment(%L, %L, %L, %L::numeric, %L, %L::date, %L, %L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'pay_race_winner_sale_b',
  'request.jwt.claims', :'claims',
  :'biz_id', 'SALE', :'sale_b', 600, 'CASH', (current_date - 1)::text, '', 'race 2 winner', :'race2_key_winner'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/pay_race_sale_b.sql > /tmp/pay_race_sale_b.out 2>/tmp/pay_race_sale_b.err; echo $? > /tmp/pay_race_sale_b.exit; } > /dev/null 2>&1 &

\set race2_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'pay_race_winner_sale_b' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

select is(:'race2_visible'::text, 'visible'::text,
          'race 2: a real second session was observed holding the winning settlement open');

truncate loser;
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

do $race2$
declare
  v_t0 timestamptz;
  v_biz uuid;
  v_doc uuid;
  v_payload jsonb;
  v_state text;
  v_msg text;
begin
  select id into v_biz from public.businesses where business_name = 'Payment Race Business';
  select id into v_doc from public.sales where id = current_setting('race.sale_b', true)::uuid;
  raise notice 'race 2 loser target: guc=%, biz=%, doc=%',
    current_setting('race.sale_b', true), v_biz, v_doc;

  v_t0 := clock_timestamp();
  begin
    select public.post_payment(
      v_biz, 'SALE'::text, v_doc,
      600::numeric, 'CASH'::text, (current_date - 1)::date, ''::text, 'race 2 loser'::text,
      current_setting('race.key2l', true)
    ) into v_payload;
  exception when others then
    v_state := sqlstate; v_msg := sqlerrm;
  end;

  insert into loser (ok, payment_id, entry_id, sqlstate, message, ms)
  values (
    v_payload is not null,
    v_payload->'payment'->>'id',
    v_payload->'journal_entry'->>'id',
    v_state, v_msg,
    extract(epoch from clock_timestamp() - v_t0) * 1000
  );
end $race2$;

reset role;

select diag('race 2 loser wait: ' || round((select ms from loser)) || ' ms, sqlstate=' ||
            coalesce((select sqlstate from loser), '(none)') || ', message=' ||
            coalesce((select message from loser), '(none)'));

select ok((select ms from loser) >= 1000,
          'race 2: the competing request blocked on the winner''s document lock for ' ||
          round((select ms from loser)) || ' ms');
select is((select ok from loser), false,
          'race 2: only one of the two requests may consume the outstanding balance');
select is((select sqlstate from loser), '22023',
          'race 2: the loser is rejected deterministically as over-settlement');
select ok((select message from loser) like '%exceeds the outstanding balance%',
          'race 2: the rejection names the recomputed outstanding balance (600 of 1000 was taken)');
select is((select count(*) from public.payments p where p.linked_sale_id = :'sale_b'), 1::bigint,
          'race 2: exactly one settlement row exists on the contested document');
select is((select sum(p.amount) from public.payments p where p.linked_sale_id = :'sale_b'), 600::numeric,
          'race 2: the loser added no money');
select ok((select coalesce(sum(p.amount), 0) <= 1000
             from public.payments p where p.linked_sale_id = :'sale_b'),
          'race 2: no negative balance is possible — settled money never exceeds the total');
select is((select status from public.sales where id = :'sale_b'), 'POSTED',
          'race 2: the rejected request left the document untouched');

-- ---------------------------------------------------------------------------
-- RACE 3 - identical requests on the purchase (OUTGOING)
-- ---------------------------------------------------------------------------
\o /tmp/pay_race_po.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.post_payment(%L, %L, %L, %L::numeric, %L, %L::date, %L, %L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'pay_race_winner_po',
  'request.jwt.claims', :'claims',
  :'biz_id', 'PURCHASE', :'po_id', 300, 'BANK', (current_date - 1)::text, '', 'race 3 winner', :'race3_key'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/pay_race_po.sql > /tmp/pay_race_po.out 2>/tmp/pay_race_po.err; echo $? > /tmp/pay_race_po.exit; } > /dev/null 2>&1 &

\set race3_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'pay_race_winner_po' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

select is(:'race3_visible'::text, 'visible'::text,
          'race 3: a real second session was observed holding the winning supplier payment open');

truncate loser;
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

do $race3$
declare
  v_t0 timestamptz;
  v_biz uuid;
  v_doc uuid;
  v_payload jsonb;
  v_state text;
  v_msg text;
begin
  select id into v_biz from public.businesses where business_name = 'Payment Race Business';
  select id into v_doc from public.purchases where id = current_setting('race.po', true)::uuid;
  raise notice 'race 3 loser target: guc=%, biz=%, doc=%',
    current_setting('race.po', true), v_biz, v_doc;

  v_t0 := clock_timestamp();
  begin
    select public.post_payment(
      v_biz, 'PURCHASE'::text, v_doc,
      300::numeric, 'BANK'::text, (current_date - 1)::date, ''::text, 'race 3 winner'::text,
      current_setting('race.key3', true)
    ) into v_payload;
  exception when others then
    v_state := sqlstate; v_msg := sqlerrm;
  end;

  insert into loser (ok, payment_id, entry_id, sqlstate, message, ms)
  values (
    v_payload is not null,
    v_payload->'payment'->>'id',
    v_payload->'journal_entry'->>'id',
    v_state, v_msg,
    extract(epoch from clock_timestamp() - v_t0) * 1000
  );
end $race3$;

reset role;

select diag('race 3 loser wait: ' || round((select ms from loser)) || ' ms, sqlstate=' ||
            coalesce((select sqlstate from loser), '(none)'));

select ok((select ms from loser) >= 1000,
          'race 3: the second supplier payment blocked on the winner''s purchase lock for ' ||
          round((select ms from loser)) || ' ms');
select is((select ok from loser), true, 'race 3: the identical supplier payment is replayed');
select is((select payment_id from loser),
          (select p.id::text from public.payments p
            where p.business_id = :'biz_id' and p.idempotency_key = :'race3_key'),
          'race 3: the loser receives the same OUTGOING settlement row');
select is((select count(*) from public.payments p where p.business_id = :'biz_id' and p.idempotency_key = :'race3_key'),
          1::bigint, 'race 3: exactly one supplier payment exists');
select is((select p.payment_type || '|' || (p.linked_purchase_id = :'po_id'::uuid)::text
             from public.payments p where p.business_id = :'biz_id' and p.idempotency_key = :'race3_key'),
          'OUTGOING|true', 'race 3: the settlement is OUTGOING and linked to the purchase');
select is((select sum(p.amount) from public.payments p where p.linked_purchase_id = :'po_id'), 300::numeric,
          'race 3: the purchase paid exactly 300, once');
select is((select status from public.purchases where id = :'po_id'), 'POSTED',
          'race 3: the purchase is still POSTED after the race');

select diag('this suite commits its fixtures and settlements on purpose (a real second session only sees committed rows). '
            'Financial rows are append-only, so clean up with: supabase db reset --local');

select * from finish();
