-- 015_gateway_concurrency.test.sql
-- pgTAP suite: GENUINE concurrent gateway settlements, in two real database
-- sessions. Run with: supabase test db
--
-- Why this file is not wrapped in begin;/rollback; like its siblings:
--   a genuine race needs a second session, and a second session can only see
--   COMMITTED rows. The fixtures below are therefore committed on purpose.
--   Financial rows are append-only (001 forbid_modification), so they cannot be
--   deleted afterwards: `supabase db reset --local` is the cleanup. Every run
--   posts fresh documents, and the fixture business is created only if missing.
--
-- Mechanism (the one 010/011/013 established against this runner, not assumed):
--   * `supabase test db` executes each file with psql inside a transient
--     supabase/pg_prove container. `\!` shell escapes run there, that container
--     carries PG{HOST,USER,PASSWORD,DATABASE} for the local database and sits on
--     the supabase network, so it can open a genuinely separate psql session.
--   * the WINNER is spawned in the background and told to hold its transaction
--     open with pg_sleep AFTER the RPC call; it labels itself with
--     application_name in SQL (this psql build does not honour PGAPPNAME).
--   * the test session is the LOSER. It waits — polling from the shell with
--     fresh connections, because a spawned psql can take seconds to start on a
--     cold container — until the winner is visibly inside that sleep, so the row
--     lock it took is held. Then it calls the RPC itself and blocks on that
--     lock. The measured wait is the proof that the overlap is real rather than
--     serialized.
--   * the loser's behaviour is therefore a first-class SQL value, captured in a
--     temp table by a DO block, so the replay and the rejection are asserted
--     exactly.
--
-- What each race proves:
--   RACE 1  two identical settlement attempts on ONE collection: the loser
--           waits on the collection's row lock, then replays THE SAME persisted
--           payment and journal entry. Exactly one payment, one PAYMENT entry,
--           one linkage, no duplicate journal sequence.
--   RACE 2  a gateway settlement racing a MANUAL settlement of the same
--           invoice: only one may consume the balance. The loser blocks on the
--           document lock, recomputes due from the committed sub-ledger and is
--           refused as over-settlement — no double post, no negative balance.
--   RACE 3  a gateway settlement racing a document VOID: the loser blocks on
--           the document lock, then finds the invoice VOIDED and posts nothing.
--           The void's mirror reversal exists exactly once.
--   RACE 4  two initiations with the SAME provider reference: one row is
--           inserted, the loser replays it instead of creating a second
--           collection.
--   RACE 5  a settlement replayed WHILE its own payment is being voided: the
--           loser does not touch the payment row (there is nothing to write),
--           so it cannot block and cannot revive anything — it reports the
--           committed row, and after both commit exactly one void exists.
--
-- No credentials are invented here: the spawned session inherits the runner's
-- own PGHOST/PGUSER/PGPASSWORD/PGDATABASE.

select plan(61);

create extension if not exists pgtap with schema extensions;

\pset format unaligned
\pset tuples_only on

-- ---------------------------------------------------------------------------
-- Committed, idempotent fixtures: one owner who is allowed to write
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'ff666666-6666-4666-8666-666666666666',
        'authenticated', 'authenticated', 'gw-race-owner@zeyks.test',
        '{"full_name":"Gateway Race Owner"}'::jsonb, now(), now())
on conflict (id) do nothing;

select jsonb_build_object('sub', 'ff666666-6666-4666-8666-666666666666', 'role', 'authenticated')::text as claims
\gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
select public.create_business(
  'Gateway Race Business', 'Gateway Race Owner', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
)
where not exists (select 1 from public.businesses where business_name = 'Gateway Race Business');
reset role;

select id as biz_id from public.businesses where business_name = 'Gateway Race Business' \gset

-- Fresh documents per run: financial rows are append-only, so a rerun must
-- never reuse an invoice number, a provider reference or a document.
select 'GWRACE-1-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as ref_a \gset
select 'GWRACE-2-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as ref_b \gset
select 'GWRACE-3-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as ref_c \gset
select 'GWRACE-4-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as ref_d \gset
select 'GWRACE-5-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as ref_e \gset

select 'gw-race-1-' || substr(gen_random_uuid()::text, 1, 8) as gw1 \gset
select 'gw-race-2-' || substr(gen_random_uuid()::text, 1, 8) as gw2 \gset
select 'gw-race-3-' || substr(gen_random_uuid()::text, 1, 8) as gw3 \gset
select 'gw-race-4-' || substr(gen_random_uuid()::text, 1, 8) as gw4 \gset
select 'gw-race-5-' || substr(gen_random_uuid()::text, 1, 8) as gw5 \gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

-- RACE 1: 1000 on sale A, settled by both sessions.
select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Gateway race customer',
  p_invoice_number := :'ref_a', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as sale_a \gset

-- RACE 2: 1000 on sale B, contested by a gateway collection of 600 and a manual
-- settlement of 600.
select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Gateway race customer',
  p_invoice_number := :'ref_b', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as sale_b \gset

-- RACE 3: 1000 on sale C, settled by one session while another voids it.
select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Gateway race customer',
  p_invoice_number := :'ref_c', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as sale_c \gset

-- RACE 4: 1000 on sale D, two initiations with one reference.
select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Gateway race customer',
  p_invoice_number := :'ref_d', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as sale_d \gset

-- RACE 5: 1000 on sale E, settled first, then replayed while it is voided.
select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Gateway race customer',
  p_invoice_number := :'ref_e', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as sale_e \gset

-- The collections the races act on.
select (public.initiate_gateway_txn(:'biz_id', 'ESEWA', :'gw1', 1000, :'sale_a', 'Gateway race customer', 'NPR'))->'gateway_transaction'->>'id' as txn1 \gset
select (public.initiate_gateway_txn(:'biz_id', 'ESEWA', :'gw2', 600, :'sale_b', 'Gateway race customer', 'NPR'))->'gateway_transaction'->>'id' as txn2 \gset
select (public.initiate_gateway_txn(:'biz_id', 'ESEWA', :'gw3', 1000, :'sale_c', 'Gateway race customer', 'NPR'))->'gateway_transaction'->>'id' as txn3 \gset
select (public.initiate_gateway_txn(:'biz_id', 'ESEWA', :'gw5', 1000, :'sale_e', 'Gateway race customer', 'NPR'))->'gateway_transaction'->>'id' as txn5 \gset

-- RACE 5's settlement is committed up front (the race is the void vs the replay).
select (public.settle_gateway_txn(
  :'biz_id', :'txn5',
  jsonb_build_object('provider', 'ESEWA', 'verified', true, 'status', 'COMPLETED',
                     'amount', 1000, 'currency', 'NPR', 'reference', :'gw5',
                     'gateway_transaction_id', 'PT-' || :'gw5')
))->>'outcome' as race5_settled \gset

reset role;

select set_config('race.biz', :'biz_id', false);
select set_config('race.sale_a', :'sale_a', false);
select set_config('race.sale_b', :'sale_b', false);
select set_config('race.sale_c', :'sale_c', false);
select set_config('race.sale_d', :'sale_d', false);
select set_config('race.sale_e', :'sale_e', false);
select set_config('race.txn1', :'txn1', false);
select set_config('race.txn2', :'txn2', false);
select set_config('race.txn3', :'txn3', false);
select set_config('race.txn5', :'txn5', false);
select set_config('race.gw1', :'gw1', false);
select set_config('race.gw2', :'gw2', false);
select set_config('race.gw3', :'gw3', false);
select set_config('race.gw4', :'gw4', false);
select set_config('race.gw5', :'gw5', false);

create temp table loser (
  ok boolean, outcome text, settlement_state text, payment_id text, entry_id text,
  sqlstate text, message text, ms numeric
);
grant all on loser to authenticated;

select is((select count(*) from public.businesses where business_name = 'Gateway Race Business'), 1::bigint,
          'setup: reruns reuse the single fixture business (no duplicate business)');
select is((select count(*) from public.payments where linked_sale_id = :'sale_a'), 0::bigint,
          'setup: race sale A starts with nothing settled');
select is((select count(*) from public.payments where linked_sale_id = :'sale_b'), 0::bigint,
          'setup: race sale B starts with nothing settled');
select is((select p.doc_status from public.payments p
            join public.gateway_transactions g on g.payment_id = p.id
           where g.id = :'txn5'), 'POSTED',
          'setup: race sale E carries one committed gateway settlement before its race starts');

-- ---------------------------------------------------------------------------
-- RACE 1 — two identical settlement attempts on ONE collection
-- ---------------------------------------------------------------------------
\o /tmp/gw_race1.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.settle_gateway_txn(%L, %L, %L::jsonb);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'gw_race_winner_1',
  'request.jwt.claims', :'claims',
  :'biz_id', :'txn1',
  (jsonb_build_object('provider', 'ESEWA', 'verified', true, 'status', 'COMPLETED',
                      'amount', 1000, 'currency', 'NPR', 'reference', :'gw1',
                      'gateway_transaction_id', 'PT-' || :'gw1'))::text
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/gw_race1.sql > /tmp/gw_race1.out 2>/tmp/gw_race1.err; echo $? > /tmp/gw_race1.exit; } > /dev/null 2>&1 &

\set race1_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'gw_race_winner_1' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set race1_wexit `cat /tmp/gw_race1.exit 2>/dev/null || echo '(still running)'`
\set race1_werr `head -c 200 /tmp/gw_race1.err 2>/dev/null`
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
  v_txn uuid;
  v_payload jsonb;
  v_state text;
  v_msg text;
begin
  select id into v_biz from public.businesses where business_name = 'Gateway Race Business';
  v_txn := current_setting('race.txn1')::uuid;

  v_t0 := clock_timestamp();
  begin
    select public.settle_gateway_txn(
      v_biz, v_txn,
      jsonb_build_object('provider', 'ESEWA', 'verified', true, 'status', 'COMPLETED',
                         'amount', 1000, 'currency', 'NPR',
                         'reference', current_setting('race.gw1'),
                         'gateway_transaction_id', 'PT-' || current_setting('race.gw1'))
    ) into v_payload;
  exception when others then
    v_state := sqlstate; v_msg := sqlerrm;
  end;

  insert into loser (ok, outcome, settlement_state, payment_id, entry_id, sqlstate, message, ms)
  values (
    v_payload is not null,
    v_payload->>'outcome',
    v_payload->>'settlement_state',
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
          'race 1: the second settlement blocked on the lock the winner holds over the collection''s invoice for ' ||
          round((select ms from loser)) || ' ms (real overlap, not serialization)');
select is((select outcome from loser), 'ALREADY_SETTLED',
          'race 1: the competing settlement replays, never posts again');
select is((select settlement_state from loser), 'SETTLED',
          'race 1: and it reports the derived state of the committed settlement');
select is((select payment_id from loser),
          (select p.id::text from public.payments p where p.gateway_transaction_id = 'PT-' || :'gw1'),
          'race 1: the loser receives the SAME persisted payment the winner committed');
select is((select entry_id from loser),
          (select p.journal_entry_id::text from public.payments p where p.gateway_transaction_id = 'PT-' || :'gw1'),
          'race 1: the loser receives the SAME journal entry, not a second one');
select is((select count(*) from public.payments where gateway_transaction_id = 'PT-' || :'gw1'), 1::bigint,
          'race 1: two concurrent settlements of one collection produced exactly ONE payment');
select is((select count(*)
             from public.journal_entries je
             join public.payments p on p.journal_entry_id = je.id
            where p.gateway_transaction_id = 'PT-' || :'gw1' and je.source_type = 'PAYMENT'),
          1::bigint,
          'race 1: exactly one PAYMENT journal entry was written');
select is((select count(*) from public.gateway_transactions g where g.id = :'txn1' and g.payment_id is not null),
          1::bigint,
          'race 1: the collection carries exactly one settlement linkage');
select is((select g.status || '|' || (g.verified_at is not null)::text || '|' || (g.settled_at is not null)::text
             from public.gateway_transactions g where g.id = :'txn1'),
          'COMPLETED|true|true',
          'race 1: the collection is COMPLETED, verified and settled once');
select is((select sum(p.amount) from public.payments p where p.linked_sale_id = :'sale_a'),
          1000::numeric,
          'race 1: the invoice took exactly 1000 of money — the winner''s, once');
select is((select status from public.sales where id = :'sale_a'), 'POSTED',
          'race 1: the invoice is still POSTED');
select is((select count(*) from (
             select je.sequence from public.journal_entries je
              where je.business_id = :'biz_id'
              group by je.sequence having count(*) > 1) x),
          0::bigint, 'race 1: the race produced no duplicate journal sequence');
select is((select count(*) from public.journal_entries je
            where je.business_id = :'biz_id' and je.source_type = 'PAYMENT'
              and je.source_id in (select p.id from public.payments p where p.gateway_transaction_id = 'PT-' || :'gw1')),
          1::bigint, 'race 1: the settlement owns exactly one entry');

-- ---------------------------------------------------------------------------
-- RACE 2 — a gateway settlement against a MANUAL settlement of the same invoice
-- ---------------------------------------------------------------------------
select 'k-race2-' || substr(gen_random_uuid()::text, 1, 8) as k2 \gset

\o /tmp/gw_race2.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.post_payment(%L, %L, %L, %L::numeric, %L, %L::date, %L, %L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'gw_race_winner_2',
  'request.jwt.claims', :'claims',
  :'biz_id', 'SALE', :'sale_b', 600, 'CASH', (current_date - 1)::text, '', 'manual race winner', :'k2'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/gw_race2.sql > /tmp/gw_race2.out 2>/tmp/gw_race2.err; echo $? > /tmp/gw_race2.exit; } > /dev/null 2>&1 &

\set race2_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'gw_race_winner_2' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set race2_wexit `cat /tmp/gw_race2.exit 2>/dev/null || echo '(still running)'`
select diag('race 2 winner (manual settlement): visibility=' || :'race2_visible' || ' exit=' || :'race2_wexit');

select is(:'race2_visible'::text, 'visible'::text,
          'race 2: a real second session was observed holding the winning manual settlement open');

truncate loser;
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

do $race2$
declare
  v_t0 timestamptz;
  v_biz uuid;
  v_txn uuid;
  v_payload jsonb;
  v_state text;
  v_msg text;
begin
  select id into v_biz from public.businesses where business_name = 'Gateway Race Business';
  v_txn := current_setting('race.txn2')::uuid;

  v_t0 := clock_timestamp();
  begin
    select public.settle_gateway_txn(
      v_biz, v_txn,
      jsonb_build_object('provider', 'ESEWA', 'verified', true, 'status', 'COMPLETED',
                         'amount', 600, 'currency', 'NPR',
                         'reference', current_setting('race.gw2'),
                         'gateway_transaction_id', 'PT-' || current_setting('race.gw2'))
    ) into v_payload;
  exception when others then
    v_state := sqlstate; v_msg := sqlerrm;
  end;

  insert into loser (ok, outcome, settlement_state, payment_id, entry_id, sqlstate, message, ms)
  values (
    v_payload is not null, v_payload->>'outcome', v_payload->>'settlement_state',
    v_payload->'payment'->>'id', v_payload->'journal_entry'->>'id',
    v_state, v_msg, extract(epoch from clock_timestamp() - v_t0) * 1000
  );
end $race2$;

reset role;

select diag('race 2 loser wait: ' || round((select ms from loser)) || ' ms, sqlstate=' ||
            coalesce((select sqlstate from loser), '(none)') || ', message=' ||
            coalesce((select message from loser), '(none)'));

select ok((select ms from loser) >= 1000,
          'race 2: the gateway settlement blocked on the winner''s document lock for ' ||
          round((select ms from loser)) || ' ms');
select is((select sqlstate from loser), '22023',
          'race 2: only one of the two settlements may consume the balance, and the loser is refused');
select ok((select message from loser) like '%exceeds the outstanding balance%',
          'race 2: the rejection names the balance recomputed from the committed sub-ledger');
select is((select count(*) from public.payments where linked_sale_id = :'sale_b'), 1::bigint,
          'race 2: exactly one settlement exists on the contested invoice');
select is((select sum(p.amount) from public.payments p where p.linked_sale_id = :'sale_b'), 600::numeric,
          'race 2: the gateway loser added no money');
select is((select count(*) from public.payments where gateway_transaction_id = 'PT-' || :'gw2'), 0::bigint,
          'race 2: no gateway-linked settlement was created by the refusal');
select is((select g.status || '|' || (g.payment_id is null)::text || '|' || (g.verified_at is null)::text
             from public.gateway_transactions g where g.id = :'txn2'),
          'INITIATED|true|true',
          'race 2: the refused collection is still INITIATED, unverified and unsettled');
select ok((select coalesce(sum(p.amount), 0) <= 1000
             from public.payments p where p.linked_sale_id = :'sale_b'),
          'race 2: no negative balance is possible — settled money never exceeds the total');
select is((select status from public.sales where id = :'sale_b'), 'POSTED',
          'race 2: the rejected request left the invoice untouched');

-- ---------------------------------------------------------------------------
-- RACE 3 — a gateway settlement racing the VOID of its invoice
-- ---------------------------------------------------------------------------
\o /tmp/gw_race3.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.void_document(%L, %L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'gw_race_winner_3',
  'request.jwt.claims', :'claims',
  :'biz_id', 'SALE', :'sale_c'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/gw_race3.sql > /tmp/gw_race3.out 2>/tmp/gw_race3.err; echo $? > /tmp/gw_race3.exit; } > /dev/null 2>&1 &

\set race3_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'gw_race_winner_3' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set race3_wexit `cat /tmp/gw_race3.exit 2>/dev/null || echo '(still running)'`
select diag('race 3 winner (document void): visibility=' || :'race3_visible' || ' exit=' || :'race3_wexit');

select is(:'race3_visible'::text, 'visible'::text,
          'race 3: a real second session was observed holding the invoice void open');

truncate loser;
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

do $race3$
declare
  v_t0 timestamptz;
  v_biz uuid;
  v_txn uuid;
  v_payload jsonb;
  v_state text;
  v_msg text;
begin
  select id into v_biz from public.businesses where business_name = 'Gateway Race Business';
  v_txn := current_setting('race.txn3')::uuid;

  v_t0 := clock_timestamp();
  begin
    select public.settle_gateway_txn(
      v_biz, v_txn,
      jsonb_build_object('provider', 'ESEWA', 'verified', true, 'status', 'COMPLETED',
                         'amount', 1000, 'currency', 'NPR',
                         'reference', current_setting('race.gw3'),
                         'gateway_transaction_id', 'PT-' || current_setting('race.gw3'))
    ) into v_payload;
  exception when others then
    v_state := sqlstate; v_msg := sqlerrm;
  end;

  insert into loser (ok, outcome, settlement_state, payment_id, entry_id, sqlstate, message, ms)
  values (
    v_payload is not null, v_payload->>'outcome', v_payload->>'settlement_state',
    v_payload->'payment'->>'id', v_payload->'journal_entry'->>'id',
    v_state, v_msg, extract(epoch from clock_timestamp() - v_t0) * 1000
  );
end $race3$;

reset role;

select diag('race 3 loser wait: ' || round((select ms from loser)) || ' ms, sqlstate=' ||
            coalesce((select sqlstate from loser), '(none)') || ', message=' ||
            coalesce((select message from loser), '(none)'));

select ok((select ms from loser) >= 1000,
          'race 3: the settlement blocked on the winner''s document lock for ' ||
          round((select ms from loser)) || ' ms');
select is((select sqlstate from loser), '22023',
          'race 3: money cannot land on an invoice that was voided while the gateway was confirming it');
select ok((select message from loser) like '%is voided%',
          'race 3: and the refusal says the invoice is voided');
select is((select count(*) from public.payments where linked_sale_id = :'sale_c'), 0::bigint,
          'race 3: the invoice took no settlement at all');
select is((select count(*) from public.journal_entries je
            where je.business_id = :'biz_id' and je.source_type = 'REVERSAL'
              and je.source_id = :'sale_c'::uuid), 1::bigint,
          'race 3: the void wrote exactly one reversal for the invoice');
select is((select count(*) from public.payments where gateway_transaction_id = 'PT-' || :'gw3'), 0::bigint,
          'race 3: no gateway settlement was posted against the voided invoice');
select is((select g.status || '|' || (g.payment_id is null)::text
             from public.gateway_transactions g where g.id = :'txn3'),
          'INITIATED|true',
          'race 3: the collection is untouched by the refusal');
select is((select status from public.sales where id = :'sale_c'), 'VOIDED',
          'race 3: the invoice is VOIDED, exactly as the winner left it');

-- ---------------------------------------------------------------------------
-- RACE 4 — two initiations with the SAME provider reference
-- ---------------------------------------------------------------------------
\o /tmp/gw_race4.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.initiate_gateway_txn(%L, %L, %L, %L::numeric, %L, %L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'gw_race_winner_4',
  'request.jwt.claims', :'claims',
  :'biz_id', 'ESEWA', :'gw4', 1000, :'sale_d', 'Gateway race customer', 'NPR'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/gw_race4.sql > /tmp/gw_race4.out 2>/tmp/gw_race4.err; echo $? > /tmp/gw_race4.exit; } > /dev/null 2>&1 &

\set race4_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'gw_race_winner_4' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set race4_wexit `cat /tmp/gw_race4.exit 2>/dev/null || echo '(still running)'`
select diag('race 4 winner (initiation): visibility=' || :'race4_visible' || ' exit=' || :'race4_wexit');

select is(:'race4_visible'::text, 'visible'::text,
          'race 4: a real second session was observed holding the winning initiation open');

truncate loser;
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

do $race4$
declare
  v_t0 timestamptz;
  v_biz uuid;
  v_sale uuid;
  v_payload jsonb;
  v_state text;
  v_msg text;
begin
  select id into v_biz from public.businesses where business_name = 'Gateway Race Business';
  v_sale := current_setting('race.sale_d')::uuid;

  v_t0 := clock_timestamp();
  begin
    select public.initiate_gateway_txn(
      v_biz, 'ESEWA', current_setting('race.gw4'), 1000, v_sale,
      'Gateway race customer', 'NPR'
    ) into v_payload;
  exception when others then
    v_state := sqlstate; v_msg := sqlerrm;
  end;

  -- Race 4 stores the initiation result in the same generic columns: the
  -- collection's id where a settlement id would be, its status where the
  -- settlement state would be, its provider where a journal entry would be.
  insert into loser (ok, outcome, payment_id, settlement_state, entry_id, sqlstate, message, ms)
  values (
    v_payload is not null,
    v_payload->>'replayed',
    v_payload->'gateway_transaction'->>'id',
    v_payload->'gateway_transaction'->>'status',
    v_payload->'gateway_transaction'->>'provider',
    v_state, v_msg,
    extract(epoch from clock_timestamp() - v_t0) * 1000
  );
end $race4$;

reset role;

select diag('race 4 loser wait: ' || round((select ms from loser)) || ' ms, outcome=' ||
            coalesce((select outcome from loser), '(none)') || ', sqlstate=' ||
            coalesce((select sqlstate from loser), '(none)'));

select ok((select ms from loser) >= 1000,
          'race 4: the competing initiation blocked on the winner''s invoice lock for ' ||
          round((select ms from loser)) || ' ms');
select is((select ok from loser), true,
          'race 4: the identical initiation replays instead of failing');
select is((select outcome from loser), 'true',
          'race 4: and it reports itself as a replay');
select is((select payment_id from loser),
          (select id::text from public.gateway_transactions where gateway_ref = :'gw4'),
          'race 4: the loser receives the SAME persisted collection the winner inserted');
select is((select settlement_state from loser), 'INITIATED',
          'race 4: the replayed collection is still INITIATED (nothing was settled)');
select is((select entry_id from loser), 'ESEWA',
          'race 4: and it is still the provider''s collection');
select is((select count(*) from public.gateway_transactions where gateway_ref = :'gw4'), 1::bigint,
          'race 4: two concurrent identical initiations produced exactly ONE collection');
select is((select count(*) from public.payments where linked_sale_id = :'sale_d'), 0::bigint,
          'race 4: an initiation never posts money');
select is((select g.initiated_by::text from public.gateway_transactions g where g.id = :'txn1'),
          'ff666666-6666-4666-8666-666666666666',
          'race 4: every collection records the authenticated initiator');

-- ---------------------------------------------------------------------------
-- RACE 5 — a settlement replayed WHILE its own payment is being voided
-- ---------------------------------------------------------------------------
select p5 from (select payment_id as p5 from public.gateway_transactions where id = :'txn5') x \gset

\o /tmp/gw_race5.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.void_payment(%L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'gw_race_winner_5',
  'request.jwt.claims', :'claims',
  :'biz_id', :'p5'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/gw_race5.sql > /tmp/gw_race5.out 2>/tmp/gw_race5.err; echo $? > /tmp/gw_race5.exit; } > /dev/null 2>&1 &

\set race5_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'gw_race_winner_5' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set race5_wexit `cat /tmp/gw_race5.exit 2>/dev/null || echo '(still running)'`
select diag('race 5 winner (settlement void): visibility=' || :'race5_visible' || ' exit=' || :'race5_wexit');

select is(:'race5_visible'::text, 'visible'::text,
          'race 5: a real second session was observed holding the settlement void open');

truncate loser;
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

do $race5$
declare
  v_t0 timestamptz;
  v_biz uuid;
  v_txn uuid;
  v_payload jsonb;
  v_state text;
  v_msg text;
begin
  select id into v_biz from public.businesses where business_name = 'Gateway Race Business';
  v_txn := current_setting('race.txn5')::uuid;

  v_t0 := clock_timestamp();
  begin
    select public.settle_gateway_txn(
      v_biz, v_txn,
      jsonb_build_object('provider', 'ESEWA', 'verified', true, 'status', 'COMPLETED',
                         'amount', 1000, 'currency', 'NPR',
                         'reference', current_setting('race.gw5'),
                         'gateway_transaction_id', 'PT-' || current_setting('race.gw5'))
    ) into v_payload;
  exception when others then
    v_state := sqlstate; v_msg := sqlerrm;
  end;

  insert into loser (ok, outcome, settlement_state, payment_id, entry_id, sqlstate, message, ms)
  values (
    v_payload is not null, v_payload->>'outcome', v_payload->>'settlement_state',
    v_payload->'payment'->>'id', v_payload->'payment'->>'doc_status',
    v_state, v_msg, extract(epoch from clock_timestamp() - v_t0) * 1000
  );
end $race5$;

reset role;

select diag('race 5 loser wait: ' || round((select ms from loser)) || ' ms, outcome=' ||
            coalesce((select outcome from loser), '(none)') || ', payment doc_status=' ||
            coalesce((select entry_id from loser), '(none)'));

-- The replay had nothing to write, so it could not wait on the void. The
-- committed state is therefore only asserted after the winner really finished —
-- the same wait 013 uses for its own post-commit assertions.
\set race5_wait `i=0; while [ $i -lt 400 ]; do if [ -f /tmp/gw_race5.exit ]; then echo committed; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`
select diag('race 5 winner finished: ' || :'race5_wait');

select is((select outcome from loser), 'ALREADY_SETTLED',
          'race 5: a replayed settlement reports the committed settlement, never a new one');
select is((select payment_id from loser),
          (select payment_id::text from public.gateway_transactions where id = :'txn5'),
          'race 5: the replay returns the same payment the void is acting on');
select ok((select ms from loser) < 4000,
          'race 5: a settled collection has nothing left to write, so the replay does not wait on the void (' ||
          round((select ms from loser)) || ' ms vs the winner''s 5 s sleep)');
select is((select count(*) from public.payments p
            join public.gateway_transactions g on g.payment_id = p.id
           where g.id = :'txn5'), 1::bigint,
          'race 5: the concurrent void created no second settlement');
select is((select p.doc_status from public.payments p where p.id = :'p5'), 'VOIDED',
          'race 5: the void committed exactly once');
select is((select count(*) from public.journal_entries je
            where je.business_id = :'biz_id' and je.reverses_entry_id = (select journal_entry_id from public.payments where id = :'p5')),
          1::bigint,
          'race 5: and wrote exactly one mirror reversal');
select is((select count(*) from public.gateway_transactions g where g.id = :'txn5' and g.payment_id = :'p5'),
          1::bigint,
          'race 5: the collection still points at its one settlement');
select is((select count(*) from public.payments where gateway_transaction_id = 'PT-' || :'gw5'), 1::bigint,
          'race 5: the provider transaction is still posted exactly once');
select is((select count(*) from (
             select je.sequence from public.journal_entries je
              where je.business_id = :'biz_id'
              group by je.sequence having count(*) > 1) x),
          0::bigint,
          'race 5: the race produced no duplicate journal sequence');

-- A replay after everything committed still returns the voided settlement and
-- revives nothing.
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
truncate loser;
do $race5b$
declare
  v_biz uuid;
  v_txn uuid;
  v_payload jsonb;
begin
  select id into v_biz from public.businesses where business_name = 'Gateway Race Business';
  v_txn := current_setting('race.txn5')::uuid;
  select public.settle_gateway_txn(
    v_biz, v_txn,
    jsonb_build_object('provider', 'ESEWA', 'verified', true, 'status', 'COMPLETED',
                       'amount', 1000, 'currency', 'NPR',
                       'reference', current_setting('race.gw5'),
                       'gateway_transaction_id', 'PT-' || current_setting('race.gw5'))
  ) into v_payload;
  insert into loser (ok, outcome, settlement_state, payment_id, entry_id, sqlstate, message, ms)
  values (true, v_payload->>'outcome', v_payload->>'settlement_state',
          v_payload->'payment'->>'id', v_payload->>'reason', null, null, null);
end $race5b$;
reset role;

select is((select outcome from loser), 'ALREADY_SETTLED',
          'race 5: a later replay is still a replay');
select is((select settlement_state from loser), 'VOIDED',
          'race 5: and it reports the settlement as VOIDED rather than pretending money is in');
select ok((select entry_id from loser) like '%voided%',
          'race 5: the reason tells the person the money must be collected again');
select is((select count(*) from public.payments where gateway_transaction_id = 'PT-' || :'gw5'), 1::bigint,
          'race 5: the voided settlement was never revived or reposted');

select diag('this suite commits its fixtures, collections and settlements on purpose (a real second session only sees committed rows). '
            'Financial rows are append-only, so clean up with: supabase db reset --local');

select * from finish();

