-- 010_void_concurrency.test.sql
-- pgTAP suite: GENUINE concurrent voiding, in two real database sessions.
-- Run with: supabase test db
--
-- Why this file is not wrapped in begin;/rollback; like its siblings:
--   a genuine race needs a second session, and a second session can only see
--   COMMITTED rows. The fixtures below are therefore committed on purpose.
--   Financial rows are append-only (001 forbid_modification), so they cannot be
--   deleted afterwards: `supabase db reset --local` is the cleanup. This file
--   sorts last, so the earlier suites are unaffected, every run posts fresh
--   documents, and the fixture business is created only if it is missing.
--
-- Mechanism (established against this runner, not assumed):
--   * `supabase test db` executes each file with psql inside a transient
--     supabase/pg_prove container. `\!` shell escapes run there, that container
--     carries PG{HOST,USER,PASSWORD,DATABASE} for the local database and sits on
--     the supabase network, so it can open a genuinely separate psql session.
--     (dblink is unusable here: local auth is trust and dblink_connect refuses
--     password-less connections for non-superusers, while dblink_connect_u
--     belongs to supabase_admin.)
--   * the WINNER is spawned in the background and told to hold its transaction
--     open with pg_sleep AFTER void_document(); it labels itself with
--     application_name in SQL (this psql build does not honour PGAPPNAME).
--   * the test session is the LOSER. It waits - by polling from the shell with
--     fresh connections, because a spawned psql can take seconds to start on a
--     cold container - until the winner is visibly inside that sleep, so the
--     document and entry locks are held. Then it calls void_document itself and
--     blocks on the document row lock. The measured wait is the proof that the
--     overlap is real rather than serialized.
--   * the loser's behaviour is therefore a first-class SQL value: 008 locks the
--     document with `for update` in the statement that reads its status and
--     re-reads the reversal state after locking, so the loser must observe
--     VOIDED and take the deterministic replay branch (008 section 5): never a
--     second reversal, never an error.
--
-- No credentials are invented here: the spawned session inherits the runner's
-- own PGHOST/PGUSER/PGPASSWORD/PGDATABASE.

select plan(39);

create extension if not exists pgtap with schema extensions;

\pset format unaligned
\pset tuples_only on

-- ---------------------------------------------------------------------------
-- Committed, idempotent fixtures: one VAT-registered owner who tracks
-- inventory, so sale, purchase and VAT posting rules all apply.
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'e5555555-5555-4555-8555-555555555555',
        'authenticated', 'authenticated', 'race-owner@zeyks.test',
        '{"full_name":"Race Owner"}'::jsonb, now(), now())
on conflict (id) do nothing;

select jsonb_build_object('sub', 'e5555555-5555-4555-8555-555555555555', 'role', 'authenticated')::text as claims
\gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
select public.create_business(
  'Void Race Business', 'Race Owner', '', '', '', '', '', 'NPR', 4::smallint, true, 13::numeric, true
)
where not exists (select 1 from public.businesses where business_name = 'Void Race Business');
reset role;

select id as biz_id from public.businesses where business_name = 'Void Race Business' \gset

-- Two fresh documents per run, so a rerun always has POSTED rows to race over.
select 'RACE-SALE-' || to_char(clock_timestamp(), 'HH24MISS') || '-'
       || substr(gen_random_uuid()::text, 1, 6) as sale_ref \gset

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;

select (public.post_sale(
  p_business_id := :'biz_id', p_customer_id := null, p_customer_name := 'Race walk-in',
  p_invoice_number := :'sale_ref', p_date := current_date - 1,
  p_subtotal := 1000, p_discount_total := 0, p_tax_amount := 130, p_total_amount := 1130,
  p_upfront_paid := 400, p_payment_method := 'CASH', p_cost_of_goods := 0, p_notes := null,
  p_items := '[{"line_no":1,"description":"Race item","quantity":1,"unit_price":1000,"discount":0,"total":1000}]'::jsonb
))->'sale'->>'id' as sale_doc \gset

select (public.post_purchase(
  p_business_id := :'biz_id', p_supplier_id := null, p_supplier_name := 'Race supplier',
  p_reference_number := null, p_date := current_date - 1,
  p_subtotal := 800, p_discount_total := 0, p_tax_amount := 104, p_total_amount := 904,
  p_upfront_paid := 300, p_payment_method := 'CASH', p_notes := null,
  p_items := '[{"line_no":1,"description":"Race stock","quantity":2,"unit_price":400,"discount":0,"total":800}]'::jsonb,
  p_idempotency_key := null, p_price_includes_vat := false
))->'purchase'->>'id' as purchase_doc \gset

reset role;

create temp table sale_pre as
select s.journal_entry_id as entry_id,
       s.status            as doc_status,
       je.reversed_by_entry_id as attached_reversal,
       (select count(*) from public.journal_entries e where e.business_id = s.business_id) as entries_before,
       (select to_jsonb(p) from public.payments p where p.linked_sale_id = s.id) as payment_before
  from public.sales s
  join public.journal_entries je on je.id = s.journal_entry_id
 where s.id = :'sale_doc';

create temp table purchase_pre as
select p.journal_entry_id as entry_id,
       p.status            as doc_status,
       (select count(*) from public.journal_entries e where e.business_id = p.business_id) as entries_before,
       (select to_jsonb(x) from public.payments x where x.linked_purchase_id = p.id) as payment_before
  from public.purchases p
 where p.id = :'purchase_doc';

select is((select count(*) from public.businesses where business_name = 'Void Race Business'), 1::bigint,
          'setup: reruns reuse the single fixture business (no duplicate business)');
select is((select doc_status from sale_pre), 'POSTED', 'setup: the sale fixture is POSTED');
select is((select attached_reversal from sale_pre), null::uuid, 'setup: the sale fixture has no reversal yet');
select is((select count(*) from public.payments where linked_sale_id = :'sale_doc'), 1::bigint,
          'setup: the sale fixture has exactly one embedded upfront settlement');

-- ---------------------------------------------------------------------------
-- RACE 1 - SALE
-- ---------------------------------------------------------------------------
\o /tmp/void_race_sale.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.void_document(%L, %L, %L);\n'
  'select pg_sleep(6);\n'
  'commit;',
  'void_race_winner_sale',
  'request.jwt.claims', :'claims',
  :'biz_id', 'SALE', :'sale_doc'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/void_race_sale.sql > /tmp/void_race_sale.out 2>/tmp/void_race_sale.err; echo $? > /tmp/void_race_sale.exit; } > /dev/null 2>&1 &

-- Wait (up to 30 s) until the winner is visibly holding its transaction open.
\set sale_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'void_race_winner_sale' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set sale_wexit `cat /tmp/void_race_sale.exit 2>/dev/null || echo '(still running)'`
\set sale_werr `head -c 200 /tmp/void_race_sale.err 2>/dev/null`
select diag('sale winner: visibility=' || :'sale_visible' || ' exit=' || :'sale_wexit' ||
            ' stderr=' || coalesce(nullif(:'sale_werr', ''), '(empty)'));

select is(:'sale_visible'::text, 'visible'::text,
          'race 1: a real second session was observed holding the winning void open');

create temp table sale_t0 as select clock_timestamp() as t;

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
create temp table sale_loser as select public.void_document(:'biz_id', 'SALE', :'sale_doc') as payload;
reset role;

create temp table sale_elapsed as
select extract(epoch from clock_timestamp() - (select t from sale_t0)) * 1000 as ms;

select diag('race 1 loser wait: ' || round((select ms from sale_elapsed)) || ' ms');

select ok((select ms from sale_elapsed) >= 1000,
          'race 1: the losing call blocked on the winner''s row lock for ' ||
          round((select ms from sale_elapsed)) || ' ms (real overlap, not serialization)');

select is((select payload->'document'->>'status' from sale_loser), 'VOIDED',
          'loser: the document comes back VOIDED');
select is((select payload->'reversal_journal_entry'->>'id' from sale_loser),
          (select r.id::text from public.journal_entries r where r.reverses_entry_id = (select entry_id from sale_pre)),
          'loser: returns the SAME reversal the winner committed (deterministic replay, no second reversal)');
select is((select payload->'reversal_journal_entry'->>'reverses_entry_id' from sale_loser),
          (select entry_id::text from sale_pre),
          'loser: the reversal points back at the original journal entry');
select is((select source_type from public.journal_entries r where r.reverses_entry_id = (select entry_id from sale_pre)),
          'REVERSAL', 'the reversal row is typed REVERSAL');
select is((select created_by from public.journal_entries r where r.reverses_entry_id = (select entry_id from sale_pre)),
          'e5555555-5555-4555-8555-555555555555'::uuid,
          'the winning void was authorized as the authenticated owner in that second session');
select is((select payload->'affected_payments'->0->>'doc_status' from sale_loser), 'VOIDED',
          'loser: the embedded upfront settlement is reported VOIDED');

select is((select count(*) from public.journal_entries r where r.reverses_entry_id = (select entry_id from sale_pre)),
          1::bigint, 'two concurrent void attempts produced exactly ONE reversal entry');
select is((select count(*) from public.journal_entries e where e.business_id = :'biz_id'),
          (select entries_before + 1 from sale_pre),
          'exactly one extra journal entry was written (no second, payment-side entry)');
select is((select reversed_by_entry_id from public.journal_entries e where e.id = (select entry_id from sale_pre)),
          (select r.id from public.journal_entries r where r.reverses_entry_id = (select entry_id from sale_pre)),
          'the original entry is linked to that single reversal');
select is((select status from public.sales where id = :'sale_doc'), 'VOIDED', 'the sale row is VOIDED');
select is((select doc_status from public.payments where linked_sale_id = :'sale_doc'), 'VOIDED',
          'the embedded upfront payment row is VOIDED, not deleted');
select is(((select to_jsonb(p) from public.payments p where p.linked_sale_id = :'sale_doc') - 'doc_status'),
          ((select payment_before from sale_pre) - 'doc_status'),
          'the payment row is otherwise untouched: same amount, no new settlement');
select is((select count(*) from public.payments where linked_sale_id = :'sale_doc'), 1::bigint,
          'no second payment row');

select is((select count(*) from public.journal_lines l where l.journal_entry_id = (select reversed_by_entry_id from public.journal_entries e where e.id = (select entry_id from sale_pre))),
          (select count(*) from public.journal_lines l where l.journal_entry_id = (select entry_id from sale_pre)),
          'the reversal has the same number of lines as the original entry');
select is((select count(*)
             from public.journal_lines o
             join public.journal_lines r
               on r.journal_entry_id = (select reversed_by_entry_id from public.journal_entries e where e.id = (select entry_id from sale_pre))
              and r.account_id = o.account_id
              and r.account_name = o.account_name
              and r.account_type = o.account_type
              and r.debit = o.credit
              and r.credit = o.debit
            where o.journal_entry_id = (select entry_id from sale_pre)),
          (select count(*) from public.journal_lines l where l.journal_entry_id = (select entry_id from sale_pre)),
          'every line is mirrored exactly: same accounts, same snapshots, debit and credit swapped');
select is((select coalesce(sum(debit), 0) from public.journal_lines l where l.journal_entry_id = (select reversed_by_entry_id from public.journal_entries e where e.id = (select entry_id from sale_pre))),
          (select coalesce(sum(credit), 0) from public.journal_lines l where l.journal_entry_id = (select reversed_by_entry_id from public.journal_entries e where e.id = (select entry_id from sale_pre))),
          'the reversal balances');
select is((select count(distinct sequence) from public.journal_entries e where e.business_id = :'biz_id'),
          (select count(*) from public.journal_entries e where e.business_id = :'biz_id'),
          'the race produced no duplicate journal sequence');

select throws_ok(
  format(
    'insert into public.journal_entries (business_id, transaction_date, sequence, description, reference, source_type, source_id, created_by, reverses_entry_id) '
    'values (%L, current_date, (select max(sequence) + 1 from public.journal_entries where business_id = %L), %L, %L, %L, %L, %L, %L)',
    :'biz_id', :'biz_id', 'second reversal attempt', 'REV-DUP-' || substr(gen_random_uuid()::text, 1, 6),
    'REVERSAL', :'sale_doc', 'e5555555-5555-4555-8555-555555555555', (select entry_id from sale_pre)
  ),
  '23505', NULL,
  'the unique reversal index remains the final backstop: a second reversal cannot be inserted even directly'
);

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
create temp table sale_replay as select public.void_document(:'biz_id', 'SALE', :'sale_doc') as payload;
reset role;

select is((select payload->'reversal_journal_entry'->>'id' from sale_replay),
          (select payload->'reversal_journal_entry'->>'id' from sale_loser),
          'a further sequential call replays the same reversal');
select is((select count(*) from public.journal_entries e where e.business_id = :'biz_id'),
          (select entries_before + 1 from sale_pre),
          'the replay wrote nothing');

-- ---------------------------------------------------------------------------
-- RACE 2 - PURCHASE (its own embedded upfront settlement)
-- ---------------------------------------------------------------------------
\o /tmp/void_race_purchase.sql
select format(
  E'set application_name = %L;\n'
  'set role authenticated;\n'
  'select set_config(%L, %L, false);\n'
  'begin;\n'
  'select public.void_document(%L, %L, %L);\n'
  'select pg_sleep(6);\n'
  'commit;',
  'void_race_winner_purchase',
  'request.jwt.claims', :'claims',
  :'biz_id', 'PURCHASE', :'purchase_doc'
);
\o

\! { psql -q -AtX -v ON_ERROR_STOP=1 -f /tmp/void_race_purchase.sql > /tmp/void_race_purchase.out 2>/tmp/void_race_purchase.err; echo $? > /tmp/void_race_purchase.exit; } > /dev/null 2>&1 &

\set purchase_visible `i=0; while [ $i -lt 600 ]; do if [ "$(psql -q -AtX -c "select count(*) from pg_stat_activity where application_name = 'void_race_winner_purchase' and state = 'active' and query like '%pg_sleep%'")" = "1" ]; then echo visible; exit 0; fi; i=$((i + 1)); sleep 0.05; done; echo timeout`

\set purchase_wexit `cat /tmp/void_race_purchase.exit 2>/dev/null || echo '(still running)'`
\set purchase_werr `head -c 200 /tmp/void_race_purchase.err 2>/dev/null`
select diag('purchase winner: visibility=' || :'purchase_visible' || ' exit=' || :'purchase_wexit' ||
            ' stderr=' || coalesce(nullif(:'purchase_werr', ''), '(empty)'));

select is(:'purchase_visible'::text, 'visible'::text,
          'race 2: a real second session was observed holding the winning purchase void open');

create temp table purchase_t0 as select clock_timestamp() as t;

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
create temp table purchase_loser as select public.void_document(:'biz_id', 'PURCHASE', :'purchase_doc') as payload;
reset role;

create temp table purchase_elapsed as
select extract(epoch from clock_timestamp() - (select t from purchase_t0)) * 1000 as ms;

select diag('race 2 loser wait: ' || round((select ms from purchase_elapsed)) || ' ms');

select ok((select ms from purchase_elapsed) >= 1000,
          'race 2: the losing purchase void blocked for ' ||
          round((select ms from purchase_elapsed)) || ' ms');

select is((select payload->'document'->>'status' from purchase_loser), 'VOIDED',
          'loser: the purchase comes back VOIDED');
select is((select payload->'reversal_journal_entry'->>'id' from purchase_loser),
          (select r.id::text from public.journal_entries r where r.reverses_entry_id = (select entry_id from purchase_pre)),
          'loser: returns the SAME purchase reversal the winner committed');
select is((select payload->'affected_payments'->0->>'doc_status' from purchase_loser), 'VOIDED',
          'loser: the purchase''s embedded upfront settlement is reported VOIDED');
select is((select count(*) from public.journal_entries r where r.reverses_entry_id = (select entry_id from purchase_pre)),
          1::bigint, 'the purchase race produced exactly ONE reversal entry');
select is((select count(*) from public.journal_entries e where e.business_id = :'biz_id'),
          (select entries_before + 2 from purchase_pre),
          'the purchase race added exactly one entry on top of the sale race (no payment-side entry)');
select is((select status from public.purchases where id = :'purchase_doc'), 'VOIDED', 'the purchase row is VOIDED');
select is((select doc_status from public.payments where linked_purchase_id = :'purchase_doc'), 'VOIDED',
          'the purchase''s embedded upfront payment row is VOIDED, not deleted');
select is((select count(*) from public.payments where linked_purchase_id = :'purchase_doc'), 1::bigint,
          'no second purchase settlement row was created');
select is((select count(*) from public.journal_lines l where l.journal_entry_id = (select reversed_by_entry_id from public.journal_entries e where e.id = (select entry_id from purchase_pre))),
          (select count(*) from public.journal_lines l where l.journal_entry_id = (select entry_id from purchase_pre)),
          'the purchase reversal mirrors the original line count');
select is((select coalesce(sum(debit), 0) from public.journal_lines l where l.journal_entry_id = (select reversed_by_entry_id from public.journal_entries e where e.id = (select entry_id from purchase_pre))),
          (select coalesce(sum(credit), 0) from public.journal_lines l where l.journal_entry_id = (select reversed_by_entry_id from public.journal_entries e where e.id = (select entry_id from purchase_pre))),
          'the purchase reversal balances');

select set_config('request.jwt.claims', :'claims', false);
set role authenticated;
create temp table purchase_replay as select public.void_document(:'biz_id', 'PURCHASE', :'purchase_doc') as payload;
reset role;

select is((select payload->'reversal_journal_entry'->>'id' from purchase_replay),
          (select payload->'reversal_journal_entry'->>'id' from purchase_loser),
          'a further purchase call replays the same reversal and writes nothing');

select diag('NOTE: this suite commits its fixtures and documents on purpose (a real second session only sees committed rows). '
            'Financial rows are append-only, so clean up with: supabase db reset --local');

select * from finish();
