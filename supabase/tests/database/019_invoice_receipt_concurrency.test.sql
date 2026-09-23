-- 019_invoice_receipt_concurrency.test.sql
-- pgTAP suite: GENUINE concurrent RECEIPTS (money in) on a SALE invoice, in two
-- real sessions.
-- Run with: supabase test db
--
-- Why this file is not wrapped in begin;/rollback; like its functional sibling:
--   a genuine race needs a second session, and a second session can only see
--   COMMITTED rows. The fixtures below are therefore committed on purpose.
--   Financial rows are append-only (001 forbid_modification), so they cannot be
--   deleted afterwards: `supabase db reset --local` is the cleanup. Every run
--   posts fresh invoices and keys.
--
-- Mechanism (the one 010/011/013/015/017 established against this runner,
-- reused rather than re-invented):
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
-- What each race proves, on the money-IN side:
--   RACE 1  two different receipts fighting over one outstanding balance.
--           post_payment locks the invoice FIRST, so the loser waits, recomputes
--           the balance from the committed sub-ledger and is refused as
--           over-settlement. Only one of them may consume the money.
--   RACE 2  a receipt racing the void of the invoice itself. Both take the
--           document lock, so the loser re-reads a VOIDED invoice and is
--           refused — no money is ever received against a voided invoice.
--   RACE 3  a receipt racing the void of an EARLIER receipt on the same invoice.
--           They take different ROW locks (the void locks the payment, the
--           receipt locks the document) and void_payment takes no advisory lock
--           at all, so the operations do serialise — but on journal_entries'
--           unique (business_id, sequence) index: the loser blocks on the
--           reversal's uncommitted sequence tuple, then recomputes and retries.
--           The proof is that measured wait plus a consistent ledger (one
--           reversal, the voided receipt stops counting, no negative balance,
--           no duplicate sequence).
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
values ('00000000-0000-0000-0000-000000000000', 'aa888888-8888-4888-8888-888888888888',
        'authenticated', 'authenticated', 'rcp-race-owner@zeyks.test',
        '{"full_name":"Receipt Race Owner"}'::jsonb, now(), now())
on conflict (id) do nothing;

select jsonb_build_object('sub', 'aa888888-8888-4888-8888-888888888888', 'role', 'authenticated')::text as claims
\gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
select public.create_business(
  'Receipt Race Business', 'Receipt Race Owner', '', '', '', '', '', 'NPR', 4::smallint, false, 0::numeric, false
)
where not exists (select 1 from public.businesses where business_name = 'Receipt Race Business');
reset role;

select id as biz_id from public.businesses where business_name = 'Receipt Race Business' \gset

-- Fresh invoices and keys per run: a rerun must race over new POSTED rows.
select 'RCRACE-1-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as inv1_ref \gset
select 'RCRACE-2-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as inv2_ref \gset
select 'RCRACE-3-' || to_char(clock_timestamp(), 'HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6) as inv3_ref \gset
select 'k-rc-1w-' || substr(gen_random_uuid()::text, 1, 8) as race1_key \gset
select 'k-rc-1l-' || substr(gen_random_uuid()::text, 1, 8) as race1_key_loser \gset
select 'k-rc-2-'  || substr(gen_random_uuid()::text, 1, 8) as race2_key \gset
select 'k-rc-3a-' || substr(gen_random_uuid()::text, 1, 8) as race3_key_a \gset
select 'k-rc-3b-' || substr(gen_random_uuid()::text, 1, 8) as race3_key_b \gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Race customer one',
  p_invoice_number := :'inv1_ref', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race goods","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as inv1 \gset

select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Race customer two',
  p_invoice_number := :'inv2_ref', p_date := current_date - 1,
  p_subtotal := 500, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 500,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race goods","quantity":1,"unit_price":500,"discount":0,"total":500}]'::jsonb
))->'sale'->>'id' as inv2 \gset

select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Race customer three',
  p_invoice_number := :'inv3_ref', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 0, p_total_amount := 1000,
  p_upfront_paid := 0, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race goods","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as inv3 \gset

-- The invoice race 3 works on starts with one committed receipt of 300.
select (public.post_payment(
  :'biz_id', 'SALE'::text, :'inv3'::uuid, 300::numeric, 'BANK'::text,
  (current_date - 1)::date, ''::text, 'pre-race receipt'::text, :'race3_key_a'::text
))->'payment'->>'id' as prior_payment \gset

reset role;

-- The race DO blocks read these, because psql variables are not visible inside
-- plpgsql.
select set_config('race.biz', :'biz_id', false);
select set_config('race.inv1', :'inv1', false);
select set_config('race.inv2', :'inv2', false);
select set_config('race.inv3', :'inv3', false);
select set_config('race.key1', :'race1_key', false);
-- The loser carries a DIFFERENT key on purpose: this race is about two receipts
-- fighting for one balance, not about a replay.
select set_config('race.key1l', :'race1_key_loser', false);
select set_config('race.key2', :'race2_key', false);
select set_config('race.key3', :'race3_key_b', false);

create temp table loser (
  ok boolean, payment_id text, entry_id text, sqlstate text, message text, ms numeric
);
grant all on loser to authenticated;

select is((select count(*) from public.businesses where business_name = 'Receipt Race Business'),
          1::bigint, 'setup: reruns reuse the single fixture business');
select is((select count(*) from public.payments where linked_sale_id = :'inv1'::uuid),
          0::bigint, 'setup: race invoice 1 starts with nothing received');
select is((select count(*) from public.payments where linked_sale_id = :'inv3'::uuid),
          1::bigint, 'setup: race invoice 3 starts with exactly the one pre-race receipt');

-- ---------------------------------------------------------------------------
-- RACE 1 - two receipts fighting over one balance
-- ---------------------------------------------------------------------------
\o /tmp/rc_race1.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.post_payment(%L, %L, %L, %L::numeric, %L, %L::date, %L, %L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'rc_race1_winner',
  'request.jwt.claims', :'claims',
  :'biz_id', 'SALE', :'inv1', 600, 'BANK', (current_date - 1)::text, '', 'race 1 winner', :'race1_key'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/rc_race1.sql > /tmp/rc_race1.out 2>/tmp/rc_race1.err; echo $? > /tmp/rc_race1.exit; } > /dev/null 2>&1 &

\set race1_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'rc_race1_winner' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

-- Read the winner's progress WITHOUT waiting: the race has to start while the
-- winner is still holding its transaction open. The final exit status is read
-- after the loser has acted, further down.
\set race1_wexit `cat /tmp/rc_race1.exit 2>/dev/null || echo '(still running)'`
\set race1_werr `head -c 200 /tmp/rc_race1.err 2>/dev/null`
select diag('race 1 winner: visibility=' || :'race1_visible' || ' exit=' || :'race1_wexit' ||
            ' stderr=' || coalesce(nullif(:'race1_werr', ''), '(empty)'));

select is(:'race1_visible'::text, 'visible'::text,
          'race 1: a real second session was observed holding the winning receipt open');

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
  select id into v_biz from public.businesses where business_name = 'Receipt Race Business';
  select id into v_doc from public.sales where id = current_setting('race.inv1', true)::uuid;
  raise notice 'race 1 loser target: biz=%, invoice=%', v_biz, v_doc;

  v_t0 := clock_timestamp();
  begin
    select public.post_payment(
      v_biz, 'SALE'::text, v_doc,
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
          'race 1: the competing receipt blocked on the winner''s invoice lock for ' ||
          round((select ms from loser))::text || ' ms');
select is((select sqlstate from loser), '22023'::text,
          'race 1: only one of the two may consume the balance, so the loser is refused');
select ok((select message from loser) like '%exceeds the outstanding balance of 400.00%',
          'race 1: the loser''s refusal names the balance recomputed after the winner committed');
select is((select count(*) from public.payments where linked_sale_id = :'inv1'::uuid),
          1::bigint, 'race 1: the contested invoice has exactly one receipt row');
select is((select coalesce(sum(amount), 0) from public.payments
            where linked_sale_id = :'inv1'::uuid),
          600::numeric, 'race 1: the invoice took exactly 600 — the loser added no money');
select is((select x.total_amount - coalesce(sum(p.amount), 0)
             from public.sales x
             left join public.payments p on p.linked_sale_id = x.id
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
            where x.id = :'inv1'::uuid
            group by x.id, x.total_amount),
          400::numeric, 'race 1: the invoice still has 400 outstanding — never a negative balance');
select is((select status from public.sales where id = :'inv1'::uuid),
          'POSTED'::text, 'race 1: the invoice is still POSTED after the race');
select is((select count(*) from public.payments p
            where p.linked_sale_id = :'inv1'::uuid and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          1::bigint, 'race 1: the committed receipt is COMPLETED and POSTED');
select is((select count(*) from public.payments p
             join public.journal_entries je on je.id = p.journal_entry_id
            where p.linked_sale_id = :'inv1'::uuid and je.source_type = 'PAYMENT'),
          1::bigint, 'race 1: the winner wrote exactly one PAYMENT journal entry');
select is((select count(*) from (
             select je.sequence from public.journal_entries je
              where je.business_id = :'biz_id'::uuid
              group by je.sequence having count(*) > 1) x),
          0::bigint, 'race 1: the race produced no duplicate journal sequence');
\set race1_done `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s /tmp/rc_race1.exit ] && break; sleep 0.25; done; cat /tmp/rc_race1.exit 2>/dev/null || echo '(still running)'`
select is(:'race1_done'::text, '0'::text, 'race 1: the winning session committed cleanly');

-- ---------------------------------------------------------------------------
-- RACE 2 - a receipt racing the void of the invoice itself
-- ---------------------------------------------------------------------------
\o /tmp/rc_race2.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.void_document(%L, %L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'rc_race2_winner',
  'request.jwt.claims', :'claims',
  :'biz_id', 'SALE', :'inv2'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/rc_race2.sql > /tmp/rc_race2.out 2>/tmp/rc_race2.err; echo $? > /tmp/rc_race2.exit; } > /dev/null 2>&1 &

\set race2_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'rc_race2_winner' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set race2_wexit `cat /tmp/rc_race2.exit 2>/dev/null || echo '(still running)'`
\set race2_werr `head -c 200 /tmp/rc_race2.err 2>/dev/null`
select diag('race 2 winner: visibility=' || :'race2_visible' || ' exit=' || :'race2_wexit' ||
            ' stderr=' || coalesce(nullif(:'race2_werr', ''), '(empty)'));

select is(:'race2_visible'::text, 'visible'::text,
          'race 2: a real second session was observed holding the invoice void open');

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
  select id into v_biz from public.businesses where business_name = 'Receipt Race Business';
  select id into v_doc from public.sales where id = current_setting('race.inv2', true)::uuid;

  v_t0 := clock_timestamp();
  begin
    select public.post_payment(
      v_biz, 'SALE'::text, v_doc,
      200::numeric, 'CASH'::text, (current_date - 1)::date, ''::text,
      'race 2 concurrent receipt'::text, current_setting('race.key2', true)
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
          'race 2: the concurrent receipt blocked on the invoice the void had locked');
select is((select sqlstate from loser), '22023'::text,
          'race 2: an invoice voided during the race refuses the receipt');
select is((select count(*) from public.payments where linked_sale_id = :'inv2'::uuid),
          0::bigint, 'race 2: nothing was received against the voided invoice');
select is((select status from public.sales where id = :'inv2'::uuid),
          'VOIDED'::text, 'race 2: the invoice itself is VOIDED');
select is((select count(*) from public.journal_entries je
            where je.business_id = :'biz_id'::uuid and je.source_type = 'REVERSAL'
              and je.source_id = :'inv2'::uuid),
          1::bigint, 'race 2: the void wrote exactly one reversal entry for the invoice');
select is((select count(*) from (
             select je.id from public.journal_entries je
               join public.journal_lines l on l.journal_entry_id = je.id
              where je.id = (select id from public.journal_entries
                              where business_id = :'biz_id'::uuid and source_type = 'REVERSAL'
                                and source_id = :'inv2'::uuid)
              group by je.id having sum(l.debit) <> sum(l.credit)) x),
          0::bigint, 'race 2: the reversal balances');
select is((select je.reversed_by_entry_id is not null from public.journal_entries je
            where je.id = (select journal_entry_id from public.sales where id = :'inv2'::uuid)),
          true, 'race 2: the invoice''s own posting entry is linked to its reversal');
\set race2_done `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s /tmp/rc_race2.exit ] && break; sleep 0.25; done; cat /tmp/rc_race2.exit 2>/dev/null || echo '(still running)'`
select is(:'race2_done'::text, '0'::text, 'race 2: the winning session committed cleanly');

-- ---------------------------------------------------------------------------
-- RACE 3 - a receipt racing the void of an earlier receipt
-- ---------------------------------------------------------------------------
\o /tmp/rc_race3.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.void_payment(%L, %L);\n'
  'select pg_sleep(5);\n'
  'commit;',
  'rc_race3_winner',
  'request.jwt.claims', :'claims',
  :'biz_id', :'prior_payment'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/rc_race3.sql > /tmp/rc_race3.out 2>/tmp/rc_race3.err; echo $? > /tmp/rc_race3.exit; } > /dev/null 2>&1 &

\set race3_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'rc_race3_winner' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set race3_wexit `cat /tmp/rc_race3.exit 2>/dev/null || echo '(still running)'`
\set race3_werr `head -c 200 /tmp/rc_race3.err 2>/dev/null`
select diag('race 3 winner: visibility=' || :'race3_visible' || ' exit=' || :'race3_wexit' ||
            ' stderr=' || coalesce(nullif(:'race3_werr', ''), '(empty)'));

select is(:'race3_visible'::text, 'visible'::text,
          'race 3: a real second session was observed holding the receipt void open');

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
  select id into v_biz from public.businesses where business_name = 'Receipt Race Business';
  select id into v_doc from public.sales where id = current_setting('race.inv3', true)::uuid;

  v_t0 := clock_timestamp();
  begin
    select public.post_payment(
      v_biz, 'SALE'::text, v_doc,
      300::numeric, 'BANK'::text, (current_date - 1)::date, ''::text,
      'race 3 concurrent receipt'::text, current_setting('race.key3', true)
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

select diag('race 3 concurrent receipt: ms=' || round((select ms from loser)) ||
            ', sqlstate=' || coalesce((select sqlstate from loser), '(none)'));

select ok((select ms from loser) > 1000,
          'race 3: the concurrent receipt waited ' || round((select ms from loser))::text ||
          ' ms on the void''s uncommitted journal sequence');
select is((select sqlstate from loser), NULL::text,
          'race 3: the concurrent receipt was accepted');
select is((select count(*) from public.payments p
            where p.linked_sale_id = :'inv3'::uuid and p.doc_status = 'POSTED'),
          1::bigint, 'race 3: only the receipt made during the race is still POSTED');
select is((select count(*) from public.payments p
            where p.linked_sale_id = :'inv3'::uuid and p.doc_status = 'VOIDED'),
          1::bigint, 'race 3: the voided receipt is kept as VOIDED, never deleted');
select is((select count(*) from public.journal_entries je
            where je.business_id = :'biz_id'::uuid and je.source_type = 'REVERSAL'
              and je.source_id = :'prior_payment'::uuid),
          1::bigint, 'race 3: exactly one reversal exists for the voided receipt');
select is((select coalesce(sum(p.amount), 0) from public.payments p
            where p.linked_sale_id = :'inv3'::uuid
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'),
          300::numeric, 'race 3: only the live receipt counts towards the invoice');
select is((select x.total_amount - coalesce(sum(p.amount), 0)
             from public.sales x
             left join public.payments p on p.linked_sale_id = x.id
              and p.status = 'COMPLETED' and p.doc_status = 'POSTED'
            where x.id = :'inv3'::uuid
            group by x.id, x.total_amount),
          700::numeric, 'race 3: the invoice has 700 outstanding — never a negative balance');
select ok((select coalesce(sum(p.amount), 0) <= x.total_amount
             from public.sales x
             left join public.payments p on p.linked_sale_id = x.id
            where x.id = :'inv3'::uuid
            group by x.id, x.total_amount),
          'race 3: received money never exceeds the invoice total');
select is((select status from public.sales where id = :'inv3'::uuid),
          'POSTED'::text, 'race 3: the invoice is still POSTED after both operations');
select is((select count(*) from public.payments p
             join public.journal_entries je on je.id = p.journal_entry_id
            where p.id = (select payment_id from loser)::uuid),
          1::bigint, 'race 3: the concurrent receipt owns exactly one journal entry');
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
\set race3_done `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s /tmp/rc_race3.exit ] && break; sleep 0.25; done; cat /tmp/rc_race3.exit 2>/dev/null || echo '(still running)'`
select is(:'race3_done'::text, '0'::text, 'race 3: the winning session committed cleanly');

select * from finish();
