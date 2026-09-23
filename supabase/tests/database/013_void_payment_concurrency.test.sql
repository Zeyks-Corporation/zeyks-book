-- 013_void_payment_concurrency.test.sql
-- pgTAP suite: GENUINE concurrent payment voids, in two real database sessions.
-- Run with: supabase test db
--
-- Why this file is not wrapped in begin;/rollback; like its siblings:
--   a genuine race needs a second session, and a second session can only see
--   COMMITTED rows. The fixtures below are therefore committed on purpose.
--   Financial rows are append-only (001 forbid_modification), so they cannot be
--   deleted afterwards: `supabase db reset --local` is the cleanup. Every run
--   posts fresh documents, and the fixture business is created only if missing.
--
-- Mechanism (established against this runner in 010/011, not assumed):
--   * `supabase test db` executes each file with psql inside a transient
--     supabase/pg_prove container. `\!` shell escapes run there, that container
--     carries PG{HOST,USER,PASSWORD,DATABASE} for the local database and sits on
--     the supabase network, so it can open a genuinely separate psql session.
--   * the WINNER is spawned in the background and told to hold its transaction
--     open with pg_sleep AFTER void_payment(); it labels itself with
--     application_name in SQL (this psql build does not honour PGAPPNAME).
--   * the test session is the LOSER. It waits - polling from the shell with
--     fresh connections, because a spawned psql can take seconds to start on a
--     cold container - until the winner is visibly inside that sleep, so the
--     payment row lock is held. Then it acts and blocks (or does not) on that
--     lock. The measured wait is the proof that the overlap is real rather than
--     serialized.
--
-- What each race proves (the rules in 010):
--   RACE 1  two concurrent voids of THE SAME payment: the payment row lock makes
--           the loser wait, re-read the committed row and replay the winner's
--           reversal. Exactly one reversal entry may ever exist, and no second
--           sequence number may be allocated.
--   RACE 2  a void in flight while another session settles the same document:
--           post_payment computes due from COMPLETED+POSTED rows, and a void can
--           only ever DECREASE that sum, so an amount accepted against the
--           pre-void due can never over-settle the document afterwards. The two
--           RPCs take different locks on purpose (payment vs document) and must
--           still leave a consistent ledger.
--
-- No credentials are invented here: the spawned session inherits the runner's
-- own PGHOST/PGUSER/PGPASSWORD/PGDATABASE.

create extension if not exists pgtap with schema extensions;

select plan(31);

\pset format unaligned
\pset tuples_only on

-- ---------------------------------------------------------------------------
-- Committed, idempotent fixtures: one owner who may write
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'ee666666-6666-4666-8666-666666666666',
        'authenticated', 'authenticated', 'void-race-owner@zeyks.test',
        '{"full_name":"Void Race Owner"}'::jsonb, now(), now())
on conflict (id) do nothing;

select jsonb_build_object('sub', 'ee666666-6666-4666-8666-666666666666', 'role', 'authenticated')::text as claims
\gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
select public.create_business(
  'Payment Void Race Business', 'Void Race Owner', '', '', '', '', '', 'NPR', 4::smallint, true, 13::numeric, true
)
where not exists (select 1 from public.businesses where business_name = 'Payment Void Race Business');
reset role;

select id as biz_id from public.businesses where business_name = 'Payment Void Race Business' \gset

-- Fresh documents per run, so a rerun always has POSTED rows to race over.
select 'VOIDRACE-1-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as s1_ref \gset
select 'VOIDRACE-2-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as s2_ref \gset
select 'k-voidrace-1-' || substr(gen_random_uuid()::text, 1, 8) as key1 \gset
select 'k-voidrace-2-' || substr(gen_random_uuid()::text, 1, 8) as key2 \gset
-- The settlement posted during race 2 needs its own key too: committed
-- settlements survive a run, so a fixed key would conflict with the last run.
select 'k-voidrace-3-' || substr(gen_random_uuid()::text, 1, 8) as key3 \gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

-- Race 1: 1000 sale settled 400, so the void has something to reverse.
select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Void race customer',
  p_invoice_number := :'s1_ref', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as sale_1 \gset

-- Race 2: 1000 sale settled 600, so 400 of due remains while the void is open.
select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Void race customer',
  p_invoice_number := :'s2_ref', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as sale_2 \gset

select ((public.post_payment(
  :'biz_id', 'SALE'::text, :'sale_1'::uuid, 400::numeric, 'CASH'::text,
  (current_date - 1)::date, ''::text, 'race 1 settlement'::text, :'key1'::text
))->'payment'->>'id')::uuid as pay_1 \gset

select ((public.post_payment(
  :'biz_id', 'SALE'::text, :'sale_2'::uuid, 600::numeric, 'CASH'::text,
  (current_date - 1)::date, ''::text, 'race 2 settlement'::text, :'key2'::text
))->'payment'->>'id')::uuid as pay_2 \gset

reset role;

-- The race DO blocks read these, because psql variables are not visible inside
-- plpgsql.
select set_config('race.biz', :'biz_id', false);
select set_config('race.sale_1', :'sale_1', false);
select set_config('race.sale_2', :'sale_2', false);
select set_config('race.pay_1', :'pay_1', false);
select set_config('race.pay_2', :'pay_2', false);
select set_config('race.key3', :'key3', false);

create temp table loser (
  ok boolean, reversal_id text, original_id text, sqlstate text, message text, ms numeric
);
grant all on loser to authenticated;

create temp table posted (
  ok boolean, payment_id text, entry_id text, sqlstate text, message text
);
grant all on posted to authenticated;

select is((select count(*) from public.businesses where business_name = 'Payment Void Race Business'),
          1::bigint, 'setup: reruns reuse the single fixture business (no duplicate business)');
select is((select count(*) from public.payments p
            where p.id = :'pay_1'::uuid and p.doc_status = 'POSTED'), 1::bigint,
          'setup: race 1 payment starts POSTED');
select is((select count(*) from public.payments p
            where p.id = :'pay_2'::uuid and p.doc_status = 'POSTED'), 1::bigint,
          'setup: race 2 payment starts POSTED');
select is((select count(*) from public.journal_entries r
            where r.business_id = :'biz_id'::uuid
              and r.reverses_entry_id = (select p.journal_entry_id from public.payments p where p.id = :'pay_1'::uuid)),
          0::bigint, 'setup: race 1 payment has no reversal yet');

-- ---------------------------------------------------------------------------
-- RACE 1 - two concurrent voids of the same payment: the loser must REPLAY
-- ---------------------------------------------------------------------------
\o /tmp/void_race_1.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.void_payment(%L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'void_race_winner_1',
  'request.jwt.claims', :'claims',
  :'biz_id', :'pay_1'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/void_race_1.sql > /tmp/void_race_1.out 2>/tmp/void_race_1.err; echo $? > /tmp/void_race_1.exit; } > /dev/null 2>&1 &

\set race1_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'void_race_winner_1' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set race1_werr `head -c 200 /tmp/void_race_1.err 2>/dev/null`
select diag('race 1 winner: visibility=' || :'race1_visible' ||
            ' stderr=' || coalesce(nullif(:'race1_werr', ''), '(empty)'));

select is(:'race1_visible'::text, 'visible'::text,
          'race 1: a real second session was observed holding its void open');

truncate loser;
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

do $race1$
declare
  v_t0 timestamptz;
  v_payload jsonb;
  v_state text;
  v_msg text;
begin
  v_t0 := clock_timestamp();
  begin
    select public.void_payment(current_setting('race.biz')::uuid, current_setting('race.pay_1')::uuid)
      into v_payload;
  exception when others then
    v_state := sqlstate; v_msg := sqlerrm;
  end;

  insert into loser (ok, reversal_id, original_id, sqlstate, message, ms)
  values (
    v_payload is not null,
    v_payload->'reversal_journal_entry'->>'id',
    v_payload->'original_journal_entry'->>'id',
    v_state, v_msg,
    extract(epoch from clock_timestamp() - v_t0) * 1000
  );
end $race1$;

reset role;

select diag('race 1 loser wait: ' || round((select ms from loser)) || ' ms, sqlstate=' ||
            coalesce((select sqlstate from loser), '(none)'));

select ok((select ms from loser) >= 1000,
          'race 1: the second void blocked on the winner''s payment lock for ' ||
          round((select ms from loser)) || ' ms (real overlap, not serialization)');
select is((select ok from loser), true,
          'race 1: the concurrent void replays, never an error');
select is((select reversal_id from loser),
          (select r.id::text from public.journal_entries r
            where r.reverses_entry_id = (select p.journal_entry_id from public.payments p where p.id = :'pay_1'::uuid)),
          'race 1: the loser receives the SAME persisted reversal the winner committed');
select is((select count(*) from public.journal_entries r
            where r.business_id = :'biz_id'::uuid
              and r.reverses_entry_id = (select p.journal_entry_id from public.payments p where p.id = :'pay_1'::uuid)),
          1::bigint, 'race 1: two concurrent voids produced exactly ONE reversal entry');
select is((select count(*) from public.journal_lines l
            where l.journal_entry_id = (select r.id from public.journal_entries r
                                         where r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                                                       where p.id = :'pay_1'::uuid))),
          (select count(*) from public.journal_lines o
            where o.journal_entry_id = (select p.journal_entry_id from public.payments p where p.id = :'pay_1'::uuid)),
          'race 1: and exactly one set of mirrored lines');
select is((select p.doc_status from public.payments p where p.id = :'pay_1'::uuid),
          'VOIDED', 'race 1: the payment ends VOIDED');
select is((select count(*) from public.payments p where p.id = :'pay_1'::uuid),
          1::bigint, 'race 1: the settlement row is still there, voided once');
select is((select count(*) from (
             select je.sequence from public.journal_entries je
              where je.business_id = :'biz_id'::uuid
              group by je.sequence having count(*) > 1) x),
          0::bigint, 'race 1: the race produced no duplicate journal sequence');
select is((select s.status from public.sales s where s.id = :'sale_1'::uuid),
          'POSTED', 'race 1: the sale is still POSTED');
select is((select coalesce(sum(p.amount), 0) from public.payments p
            where p.linked_sale_id = :'sale_1'::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          0::numeric, 'race 1: the voided settlement no longer counts towards what is settled');
select is((select s.total_amount - coalesce((
             select sum(p.amount) from public.payments p
              where p.linked_sale_id = s.id and p.status = 'COMPLETED' and p.doc_status = 'POSTED'), 0)
             from public.sales s where s.id = :'sale_1'::uuid),
          1000::numeric, 'race 1: the sale owes the full 1000 again');
select is((select abs(sum(l.debit) - sum(l.credit)) from public.journal_lines l
            where l.journal_entry_id = (select r.id from public.journal_entries r
                                         where r.reverses_entry_id = (select p.journal_entry_id from public.payments p
                                                                       where p.id = :'pay_1'::uuid))),
          0::numeric, 'race 1: the one reversal entry balances');

-- ---------------------------------------------------------------------------
-- RACE 2 - a void in flight while another session settles the same document
-- ---------------------------------------------------------------------------
\o /tmp/void_race_2.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.void_payment(%L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'void_race_winner_2',
  'request.jwt.claims', :'claims',
  :'biz_id', :'pay_2'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/void_race_2.sql > /tmp/void_race_2.out 2>/tmp/void_race_2.err; echo $? > /tmp/void_race_2.exit; } > /dev/null 2>&1 &

\set race2_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'void_race_winner_2' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set race2_werr `head -c 200 /tmp/void_race_2.err 2>/dev/null`
select diag('race 2 winner: visibility=' || :'race2_visible' ||
            ' stderr=' || coalesce(nullif(:'race2_werr', ''), '(empty)'));

select is(:'race2_visible'::text, 'visible'::text,
          'race 2: a real second session was observed holding its void open');

truncate posted;
select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

-- The 400 still shown as outstanding is settled while the void is uncommitted.
do $race2$
declare
  v_payload jsonb;
  v_state text;
  v_msg text;
begin
  begin
    select public.post_payment(
      current_setting('race.biz')::uuid, 'SALE'::text, current_setting('race.sale_2')::uuid,
      400::numeric, 'BANK'::text, (current_date - 1)::date, ''::text,
      'race 2 concurrent settlement'::text, current_setting('race.key3')
    ) into v_payload;
  exception when others then
    v_state := sqlstate; v_msg := sqlerrm;
  end;

  insert into posted (ok, payment_id, entry_id, sqlstate, message)
  values (
    v_payload is not null,
    v_payload->'payment'->>'id',
    v_payload->'journal_entry'->>'id',
    v_state, v_msg
  );
end $race2$;

reset role;

select diag('race 2 concurrent settlement: sqlstate=' || coalesce((select sqlstate from posted), '(none)') ||
            ' message=' || coalesce((select message from posted), '(none)'));

-- The loser does not share a lock with the winner, so it must not wait for it:
-- wait for the winner to commit before judging the state both left behind.
\set race2_wait `i=0; while [ $i -lt 400 ]; do if [ -f /tmp/void_race_2.exit ]; then echo committed; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`
select diag('race 2 winner finished: ' || :'race2_wait');
select is(:'race2_wait'::text, 'committed'::text,
          'race 2: the winning session committed its void');

select is((select ok from posted), true,
          'race 2: settling the document while its earlier payment is being voided succeeds');
select is((select count(*) from public.journal_entries r
            where r.business_id = :'biz_id'::uuid
              and r.reverses_entry_id = (select p.journal_entry_id from public.payments p where p.id = :'pay_2'::uuid)),
          1::bigint, 'race 2: the concurrent void still produced exactly one reversal');
select is((select p.doc_status from public.payments p where p.id = :'pay_2'::uuid),
          'VOIDED', 'race 2: the earlier payment ends VOIDED');
select is((select coalesce(sum(p.amount), 0) from public.payments p
            where p.linked_sale_id = :'sale_2'::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          400::numeric, 'race 2: only the settlement made during the race is still counted');
select is((select s.total_amount - coalesce((
             select sum(p.amount) from public.payments p
              where p.linked_sale_id = s.id and p.status = 'COMPLETED' and p.doc_status = 'POSTED'), 0)
             from public.sales s where s.id = :'sale_2'::uuid),
          600::numeric, 'race 2: the document owes 600 — never a negative balance');
select is((select s.status from public.sales s where s.id = :'sale_2'::uuid),
          'POSTED', 'race 2: the sale is still POSTED after both operations');
select ok((select coalesce(sum(p.amount), 0) from public.payments p
            where p.linked_sale_id = :'sale_2'::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED') <=
          (select s.total_amount from public.sales s where s.id = :'sale_2'::uuid),
          'race 2: settled money never exceeds the document total');
select is((select count(*) from public.journal_entries je
            where je.business_id = :'biz_id'::uuid
              and je.source_type = 'PAYMENT'
              and je.id = (select p.journal_entry_id from public.payments p
                            where p.business_id = :'biz_id'::uuid
                              and p.idempotency_key = :'key3')),
          1::bigint, 'race 2: the concurrent settlement has exactly one journal entry');
select is((select abs(sum(l.debit) - sum(l.credit)) from public.journal_lines l
            where l.journal_entry_id = (select p.journal_entry_id from public.payments p
                                         where p.business_id = :'biz_id'::uuid
                                           and p.idempotency_key = :'key3')),
          0::numeric, 'race 2: and it balances');
select is((select count(*) from (
             select je.sequence from public.journal_entries je
              where je.business_id = :'biz_id'::uuid
              group by je.sequence having count(*) > 1) x),
          0::bigint, 'race 2: still no duplicate journal sequence');

-- Both winner sessions exited cleanly.
\set race1_exit `cat /tmp/void_race_1.exit 2>/dev/null || echo '(still running)'`
\set race2_exit `cat /tmp/void_race_2.exit 2>/dev/null || echo '(still running)'`
select is(:'race1_exit'::text, '0'::text, 'race 1: the winning session committed cleanly');
select is(:'race2_exit'::text, '0'::text, 'race 2: the winning session committed cleanly');

select * from finish();
