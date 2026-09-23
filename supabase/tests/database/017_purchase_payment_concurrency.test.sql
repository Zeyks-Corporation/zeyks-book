-- 017_purchase_payment_concurrency.test.sql
-- pgTAP suite: GENUINE concurrent SUPPLIER payments, in two real sessions.
-- Run with: supabase test db
--
-- Why this file is not wrapped in begin;/rollback; like its functional sibling:
--   a genuine race needs a second session, and a second session can only see
--   COMMITTED rows. The fixtures below are therefore committed on purpose.
--   Financial rows are append-only (001 forbid_modification), so they cannot be
--   deleted afterwards: `supabase db reset --local` is the cleanup. Every run
--   posts fresh documents and keys, and the fixture business is created once.
--
-- Mechanism (the one 010/011/013/015 established against this runner, reused
-- rather than re-invented):
--   * `supabase test db` executes each file with psql inside a transient
--     supabase/pg_prove container. `\!` shell escapes run there, that container
--     carries PG{HOST,USER,PASSWORD,DATABASE} and sits on the supabase network,
--     so it can open a genuinely separate psql session.
--   * the WINNER is spawned in the background and told to hold its transaction
--     open with pg_sleep AFTER its RPC; it labels itself with application_name
--     in SQL (this psql build does not honour PGAPPNAME).
--   * the test session is the LOSER. It polls from the shell, with fresh
--     connections, until the winner is visibly inside that sleep — so the row
--     lock it needs is demonstrably held — and then acts. The measured wait is
--     the proof that the overlap is real rather than serialized.
--
-- What each race proves, on the money-OUT side:
--   RACE 1  two different supplier payments fighting over one outstanding
--           balance. post_payment locks the bill FIRST, so the loser waits,
--           recomputes the balance from the committed sub-ledger and is refused
--           as over-settlement. Only one of them may consume the money.
--   RACE 2  a supplier payment racing the void of the bill itself. Both take the
--           document lock, so the loser re-reads a VOIDED bill and is refused —
--           no money is ever posted against a voided purchase.
--   RACE 3  a supplier payment racing the void of an EARLIER supplier payment on
--           the same bill. They take different ROW locks (the void locks the
--           payment, the settlement locks the document) and void_payment takes
--           no advisory lock at all, so the operations do serialise — but on
--           journal_entries' unique (business_id, sequence) index: the loser
--           blocks on the reversal's uncommitted sequence tuple, then recomputes
--           and retries. The proof is that measured wait plus a consistent
--           ledger (one reversal, the voided row stops counting, no negative
--           balance, no duplicate sequence).
--
-- No credentials are invented here: the spawned session inherits the runner's
-- own PGHOST/PGUSER/PGPASSWORD/PGDATABASE.

select plan(38);

create extension if not exists pgtap with schema extensions;

\pset format unaligned
\pset tuples_only on

-- ---------------------------------------------------------------------------
-- Committed, idempotent fixtures: one owner who may write
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'ee777777-7777-4777-8777-777777777777',
        'authenticated', 'authenticated', 'po-race-owner@zeyks.test',
        '{"full_name":"Purchase Race Owner"}'::jsonb, now(), now())
on conflict (id) do nothing;

select jsonb_build_object('sub', 'ee777777-7777-4777-8777-777777777777', 'role', 'authenticated')::text as claims
\gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
select public.create_business(
  'Purchase Race Business', 'Purchase Race Owner', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
)
where not exists (select 1 from public.businesses where business_name = 'Purchase Race Business');
reset role;

select id as biz_id from public.businesses where business_name = 'Purchase Race Business' \gset

-- Fresh documents and keys per run: a rerun must race over new POSTED rows.
select 'PORACE-1-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as po1_ref \gset
select 'PORACE-2-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as po2_ref \gset
select 'PORACE-3-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as po3_ref \gset
select 'k-po-1w-' || substr(gen_random_uuid()::text, 1, 8) as race1_key \gset
select 'k-po-1l-' || substr(gen_random_uuid()::text, 1, 8) as race1_key_loser \gset
select 'k-po-2-'  || substr(gen_random_uuid()::text, 1, 8) as race2_key \gset
select 'k-po-3a-' || substr(gen_random_uuid()::text, 1, 8) as race3_key_a \gset
select 'k-po-3b-' || substr(gen_random_uuid()::text, 1, 8) as race3_key_b \gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

select (public.post_purchase(
  p_business_id := :'biz_id', p_supplier_id := null, p_supplier_name := 'Race supplier one',
  p_reference_number := :'po1_ref', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Race stock","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
  p_idempotency_key := null, p_price_includes_vat := false
))->'purchase'->>'id' as po1 \gset

select (public.post_purchase(
  p_business_id := :'biz_id', p_supplier_id := null, p_supplier_name := 'Race supplier two',
  p_reference_number := :'po2_ref', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Race stock","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb,
  p_idempotency_key := null, p_price_includes_vat := false
))->'purchase'->>'id' as po2 \gset

select (public.post_purchase(
  p_business_id := :'biz_id', p_supplier_id := null, p_supplier_name := 'Race supplier three',
  p_reference_number := :'po3_ref', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Race stock","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb,
  p_idempotency_key := null, p_price_includes_vat := false
))->'purchase'->>'id' as po3 \gset

-- The bill race 3 works on starts with one committed supplier payment of 300.
select (public.post_payment(
  :'biz_id', 'PURCHASE'::text, :'po3'::uuid, 300::numeric, 'BANK'::text,
  (current_date - 1)::date, ''::text, 'pre-race supplier payment'::text, :'race3_key_a'::text
))->'payment'->>'id' as prior_payment \gset

reset role;

-- The race DO blocks read these, because psql variables are not visible inside
-- plpgsql.
select set_config('race.biz', :'biz_id', false);
select set_config('race.po1', :'po1', false);
select set_config('race.po2', :'po2', false);
select set_config('race.po3', :'po3', false);
select set_config('race.key1', :'race1_key', false);
-- The loser carries a DIFFERENT key on purpose: this race is about two
-- settlements fighting for one balance, not about a replay.
select set_config('race.key1l', :'race1_key_loser', false);
select set_config('race.key2', :'race2_key', false);
select set_config('race.key3', :'race3_key_b', false);

create temp table loser (
  ok boolean, payment_id text, entry_id text, sqlstate text, message text, ms numeric
);
grant all on loser to authenticated;

select is((select count(*) from public.businesses where business_name = 'Purchase Race Business'),
          1::bigint, 'setup: reruns reuse the single fixture business');
select is((select count(*) from public.payments where linked_purchase_id = :'po1'::uuid),
          0::bigint, 'setup: race bill 1 starts with nothing settled');
select is((select count(*) from public.payments where linked_purchase_id = :'po3'::uuid),
          1::bigint, 'setup: race bill 3 starts with exactly the one pre-race supplier payment');

-- ---------------------------------------------------------------------------
-- RACE 1 - two supplier payments fighting over one balance
-- ---------------------------------------------------------------------------
\o /tmp/po_race1.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.post_payment(%L, %L, %L, %L::numeric, %L, %L::date, %L, %L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'po_race1_winner',
  'request.jwt.claims', :'claims',
  :'biz_id', 'PURCHASE', :'po1', 600, 'BANK', (current_date - 1)::text, '', 'race 1 winner', :'race1_key'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/po_race1.sql > /tmp/po_race1.out 2>/tmp/po_race1.err; echo $? > /tmp/po_race1.exit; } > /dev/null 2>&1 &

\set race1_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'po_race1_winner' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

-- Read the winner's progress WITHOUT waiting: the race has to start while the
-- winner is still holding its transaction open. The final exit status is read
-- after the loser has acted, further down.
\set race1_wexit `cat /tmp/po_race1.exit 2>/dev/null || echo '(still running)'`
\set race1_werr `head -c 200 /tmp/po_race1.err 2>/dev/null`
select diag('race 1 winner: visibility=' || :'race1_visible' || ' exit=' || :'race1_wexit' ||
            ' stderr=' || coalesce(nullif(:'race1_werr', ''), '(empty)'));

select is(:'race1_visible'::text, 'visible'::text,
          'race 1: a real second session was observed holding the winning supplier payment open');

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
  select id into v_biz from public.businesses where business_name = 'Purchase Race Business';
  select id into v_doc from public.purchases where id = current_setting('race.po1', true)::uuid;
  raise notice 'race 1 loser target: biz=%, bill=%', v_biz, v_doc;

  v_t0 := clock_timestamp();
  begin
    select public.post_payment(
      v_biz, 'PURCHASE'::text, v_doc,
      600::numeric, 'BANK'::text, (current_date - 1)::date, ''::text,
      'race 1 loser'::text, current_setting('race.key1l', true)
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
            coalesce((select sqlstate from loser), '(none)') || ', message=' ||
            coalesce((select message from loser), '(none)'));

select ok((select ms from loser) > 1000,
          'race 1: the competing supplier payment blocked on the winner''s bill lock for ' ||
          round((select ms from loser))::text || ' ms');
select is((select sqlstate from loser), '22023'::text,
          'race 1: only one of the two may consume the balance, so the loser is refused');
select ok((select message from loser) like '%exceeds the outstanding balance of 400.00%',
          'race 1: the loser''s refusal names the balance recomputed after the winner committed');
select is((select count(*) from public.payments where linked_purchase_id = :'po1'::uuid),
          1::bigint, 'race 1: the contested bill has exactly one settlement row');
select is((select coalesce(sum(p.amount), 0) from public.payments p
            where p.linked_purchase_id = :'po1'::uuid),
          600::numeric, 'race 1: the bill took exactly 600 — the loser added no money');
select is((select x.total_amount - coalesce(sum(p.amount), 0)
             from public.purchases x
             left join public.payments p on p.linked_purchase_id = x.id
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
            where x.id = :'po1'::uuid
            group by x.id, x.total_amount),
          400::numeric, 'race 1: the bill still owes 400 — never a negative balance');
select is((select status from public.purchases where id = :'po1'::uuid),
          'POSTED'::text, 'race 1: the bill is still POSTED after the race');
select is((select count(*) from public.payments p
            where p.linked_purchase_id = :'po1'::uuid and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          1::bigint, 'race 1: the committed supplier payment is COMPLETED and POSTED');
select is((select count(*) from public.payments p
             join public.journal_entries je on je.id = p.journal_entry_id
            where p.linked_purchase_id = :'po1'::uuid and je.source_type = 'PAYMENT'),
          1::bigint, 'race 1: the winner wrote exactly one PAYMENT journal entry');
select is((select count(*) from (
             select je.sequence from public.journal_entries je
              where je.business_id = :'biz_id'::uuid
              group by je.sequence having count(*) > 1) x),
          0::bigint, 'race 1: the race produced no duplicate journal sequence');
\set race1_done `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s /tmp/po_race1.exit ] && break; sleep 0.25; done; cat /tmp/po_race1.exit 2>/dev/null || echo '(still running)'`
select is(:'race1_done'::text, '0'::text, 'race 1: the winning session committed cleanly');

-- ---------------------------------------------------------------------------
-- RACE 2 - a supplier payment racing the void of the bill itself
-- ---------------------------------------------------------------------------
\o /tmp/po_race2.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.void_document(%L, %L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'po_race2_winner',
  'request.jwt.claims', :'claims',
  :'biz_id', 'PURCHASE', :'po2'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/po_race2.sql > /tmp/po_race2.out 2>/tmp/po_race2.err; echo $? > /tmp/po_race2.exit; } > /dev/null 2>&1 &

\set race2_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'po_race2_winner' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set race2_wexit `cat /tmp/po_race2.exit 2>/dev/null || echo '(still running)'`
\set race2_werr `head -c 200 /tmp/po_race2.err 2>/dev/null`
select diag('race 2 winner: visibility=' || :'race2_visible' || ' exit=' || :'race2_wexit' ||
            ' stderr=' || coalesce(nullif(:'race2_werr', ''), '(empty)'));

select is(:'race2_visible'::text, 'visible'::text,
          'race 2: a real second session was observed holding the bill void open');

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
  select id into v_biz from public.businesses where business_name = 'Purchase Race Business';
  select id into v_doc from public.purchases where id = current_setting('race.po2', true)::uuid;

  v_t0 := clock_timestamp();
  begin
    select public.post_payment(
      v_biz, 'PURCHASE'::text, v_doc,
      200::numeric, 'CASH'::text, (current_date - 1)::date, ''::text,
      'race 2 concurrent supplier payment'::text, current_setting('race.key2', true)
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

select ok((select ms from loser) > 1000,
          'race 2: the concurrent supplier payment blocked on the bill the void had locked');
select is((select sqlstate from loser), '22023'::text,
          'race 2: a bill voided during the race refuses the supplier payment');
select is((select count(*) from public.payments where linked_purchase_id = :'po2'::uuid),
          0::bigint, 'race 2: nothing was posted against the voided bill');
select is((select status from public.purchases where id = :'po2'::uuid),
          'VOIDED'::text, 'race 2: the bill itself is VOIDED');
select is((select count(*) from public.journal_entries je
            where je.business_id = :'biz_id'::uuid and je.source_type = 'REVERSAL'
              and je.source_id = :'po2'::uuid),
          1::bigint, 'race 2: the void wrote exactly one reversal entry for the bill');
select is((select count(*) from (
             select je.id from public.journal_entries je
               join public.journal_lines l on l.journal_entry_id = je.id
              where je.id = (select id from public.journal_entries
                              where business_id = :'biz_id'::uuid and source_type = 'REVERSAL'
                                and source_id = :'po2'::uuid)
              group by je.id having sum(l.debit) <> sum(l.credit)) x),
          0::bigint, 'race 2: the reversal balances');
select is((select je.reversed_by_entry_id is not null from public.journal_entries je
            where je.id = (select journal_entry_id from public.purchases where id = :'po2'::uuid)),
          true, 'race 2: the bill''s own posting entry is linked to its reversal');
\set race2_done `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s /tmp/po_race2.exit ] && break; sleep 0.25; done; cat /tmp/po_race2.exit 2>/dev/null || echo '(still running)'`
select is(:'race2_done'::text, '0'::text, 'race 2: the winning session committed cleanly');

-- ---------------------------------------------------------------------------
-- RACE 3 - a supplier payment racing the void of an earlier supplier payment
-- ---------------------------------------------------------------------------
\o /tmp/po_race3.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.void_payment(%L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'po_race3_winner',
  'request.jwt.claims', :'claims',
  :'biz_id', :'prior_payment'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/po_race3.sql > /tmp/po_race3.out 2>/tmp/po_race3.err; echo $? > /tmp/po_race3.exit; } > /dev/null 2>&1 &

\set race3_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'po_race3_winner' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set race3_wexit `cat /tmp/po_race3.exit 2>/dev/null || echo '(still running)'`
\set race3_werr `head -c 200 /tmp/po_race3.err 2>/dev/null`
select diag('race 3 winner: visibility=' || :'race3_visible' || ' exit=' || :'race3_wexit' ||
            ' stderr=' || coalesce(nullif(:'race3_werr', ''), '(empty)'));

select is(:'race3_visible'::text, 'visible'::text,
          'race 3: a real second session was observed holding the supplier-payment void open');

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
  select id into v_biz from public.businesses where business_name = 'Purchase Race Business';
  select id into v_doc from public.purchases where id = current_setting('race.po3', true)::uuid;

  v_t0 := clock_timestamp();
  begin
    select public.post_payment(
      v_biz, 'PURCHASE'::text, v_doc,
      300::numeric, 'BANK'::text, (current_date - 1)::date, ''::text,
      'race 3 concurrent supplier payment'::text, current_setting('race.key3', true)
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

select diag('race 3 concurrent settlement: ms=' || round((select ms from loser)) ||
            ', sqlstate=' || coalesce((select sqlstate from loser), '(none)'));

select ok((select ms from loser) > 1000,
          'race 3: the concurrent settlement waited ' || round((select ms from loser))::text ||
          ' ms on the void''s uncommitted journal sequence');
select is((select sqlstate from loser), NULL::text,
          'race 3: the concurrent supplier payment was accepted');
select is((select count(*) from public.payments p
            where p.linked_purchase_id = :'po3'::uuid and p.doc_status = 'POSTED'),
          1::bigint, 'race 3: only the settlement made during the race is still POSTED');
select is((select count(*) from public.payments p
            where p.linked_purchase_id = :'po3'::uuid and p.doc_status = 'VOIDED'),
          1::bigint, 'race 3: the voided settlement is kept as VOIDED, never deleted');
select is((select count(*) from public.journal_entries je
            where je.business_id = :'biz_id'::uuid and je.source_type = 'REVERSAL'
              and je.source_id = :'prior_payment'::uuid),
          1::bigint, 'race 3: exactly one reversal exists for the voided supplier payment');
select is((select coalesce(sum(p.amount), 0) from public.payments p
            where p.linked_purchase_id = :'po3'::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          300::numeric, 'race 3: only the live settlement counts towards the bill');
select is((select x.total_amount - coalesce(sum(p.amount), 0)
             from public.purchases x
             left join public.payments p on p.linked_purchase_id = x.id
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
            where x.id = :'po3'::uuid
            group by x.id, x.total_amount),
          700::numeric, 'race 3: the bill owes 700 — never a negative balance');
select ok((select coalesce(sum(p.amount), 0) <= x.total_amount
             from public.purchases x
             left join public.payments p on p.linked_purchase_id = x.id
            where x.id = :'po3'::uuid
            group by x.id, x.total_amount),
          'race 3: settled money never exceeds the bill total');
select is((select status from public.purchases where id = :'po3'::uuid),
          'POSTED'::text, 'race 3: the bill is still POSTED after both operations');
select is((select count(*) from public.payments p
             join public.journal_entries je on je.id = p.journal_entry_id
            where p.id = (select payment_id from loser)::uuid),
          1::bigint, 'race 3: the concurrent settlement owns exactly one journal entry');
select is((select count(*) from (
             select je.id from public.journal_entries je
               join public.journal_lines l on l.journal_entry_id = je.id
              where je.business_id = :'biz_id'::uuid
              group by je.id having sum(l.debit) <> sum(l.credit)) x),
          0::bigint, 'race 3: every entry in the business balances after the races');
select is((select count(*) from (
             select je.sequence from public.journal_entries je
              where je.business_id = :'biz_id'::uuid
              group by je.sequence having count(*) > 1) x),
          0::bigint, 'race 3: still no duplicate journal sequence in the business');
\set race3_done `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s /tmp/po_race3.exit ] && break; sleep 0.25; done; cat /tmp/po_race3.exit 2>/dev/null || echo '(still running)'`
select is(:'race3_done'::text, '0'::text, 'race 3: the winning session committed cleanly');

select * from finish();
