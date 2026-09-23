-- 002_integrity.test.sql
-- pgTAP. Run with:  supabase test db
--
-- Covers
--   4. system account protected fields cannot be changed (and archive rules)
--   5. journal lines cannot be deleted (or updated, or truncated)
--   6. a journal entry cannot be committed with unbalanced lines
-- plus journal line shape checks, entry immutability and the one-time reversal link.
--
-- Balance is checked by DEFERRED constraint triggers, i.e. at COMMIT. The whole
-- file runs inside a transaction that is rolled back, so the helper below forces
-- the check with SET CONSTRAINTS ALL IMMEDIATE, which fires the pending checks
-- exactly as COMMIT would. Test entries are fixtures created and discarded here;
-- nothing is left behind.

begin;
create extension if not exists pgtap with schema extensions;

select plan(28);

-- ---------------------------------------------------------------------------
-- Helpers (session-local)
-- ---------------------------------------------------------------------------
create function pg_temp.act_as(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_uid::text, 'role', 'authenticated')::text,
    true
  );
end $$;

-- Inserts an entry and its lines. p_lines: [{"code":"1010","debit":100,"credit":0}, ...]
-- Nothing is validated here beyond immediate constraints; the deferred balance
-- triggers are still pending when this returns.
create function pg_temp.mk_entry(
  p_id uuid, p_seq bigint, p_source text, p_reverses uuid, p_lines jsonb
) returns void
language plpgsql as $$
declare
  v_biz  uuid := current_setting('test.biz')::uuid;
  v_user uuid := current_setting('test.uid')::uuid;
  v_no   int  := 0;
  l      jsonb;
begin
  insert into public.journal_entries
    (id, business_id, transaction_date, sequence, description, reference, source_type, reverses_entry_id, created_by)
  values
    (p_id, v_biz, date '2026-04-01', p_seq, 'test entry', 'T-' || p_seq::text, p_source, p_reverses, v_user);

  for l in select * from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    insert into public.journal_lines
      (business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit)
    select v_biz, p_id, v_no, a.id, a.name, a.type, (l ->> 'debit')::numeric, (l ->> 'credit')::numeric
      from public.accounts a
     where a.business_id = v_biz and a.code = l ->> 'code';
  end loop;
end $$;

-- Same, then runs the pending balance checks now (as COMMIT would) and restores
-- the deferred default so later fixtures can still be inserted line by line.
create function pg_temp.mk_entry_checked(
  p_id uuid, p_seq bigint, p_source text, p_reverses uuid, p_lines jsonb
) returns void
language plpgsql as $$
begin
  perform pg_temp.mk_entry(p_id, p_seq, p_source, p_reverses, p_lines);
  set constraints all immediate;
  set constraints all deferred;
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures: one user, one business created through the real RPC
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'a1111111-1111-4111-8111-111111111111',
        'authenticated', 'authenticated', 'alice@zeyks.test', '{"full_name":"Alice"}'::jsonb, now(), now());

select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.create_business('Integrity Traders');
reset role;

select set_config('test.biz', (select id::text from public.businesses where business_name = 'Integrity Traders'), true);
select set_config('test.uid', 'a1111111-1111-4111-8111-111111111111', true);

-- ---------------------------------------------------------------------------
-- TEST 4: account protection
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;

-- 01-02 clients cannot even attempt to touch protected columns (column grants)
select throws_ok(
  $$update public.accounts set code = '9999'
     where business_id = current_setting('test.biz')::uuid and code = '5040'$$,
  '42501', NULL,
  'client cannot change an account code'
);
select throws_ok(
  $$update public.accounts set system_account = false
     where business_id = current_setting('test.biz')::uuid and code = '1010'$$,
  '42501', NULL,
  'client cannot clear the system_account flag'
);
-- 03 a system account cannot be archived, even by the OWNER
select throws_ok(
  $$update public.accounts set is_active = false
     where business_id = current_setting('test.biz')::uuid and code = '1010'$$,
  '23001', NULL,
  'a system account cannot be archived'
);
-- 04-05 ordinary accounts can be renamed and, with a zero balance, archived
select lives_ok(
  $$update public.accounts set name = 'Power and internet'
     where business_id = current_setting('test.biz')::uuid and code = '5030'$$,
  'owner can rename an ordinary account'
);
select lives_ok(
  $$update public.accounts set is_active = false
     where business_id = current_setting('test.biz')::uuid and code = '5080'$$,
  'an ordinary account with a zero balance can be archived'
);

reset role;

-- 06-08 the trigger holds even for the table owner / service role
select throws_ok(
  $$update public.accounts set code = '9999'
     where business_id = current_setting('test.biz')::uuid and code = '1010'$$,
  '23001', NULL,
  'trigger blocks changing the code of a system account, for any role'
);
select throws_ok(
  $$update public.accounts set type = 'LIABILITY'
     where business_id = current_setting('test.biz')::uuid and code = '1010'$$,
  '23001', NULL,
  'trigger blocks changing an account type'
);
select throws_ok(
  $$update public.accounts set system_account = false
     where business_id = current_setting('test.biz')::uuid and code = '1010'$$,
  '23001', NULL,
  'trigger blocks clearing the system flag, for any role'
);
-- 09 accounts are never deleted
select throws_ok(
  $$delete from public.accounts
     where business_id = current_setting('test.biz')::uuid and code = '5040'$$,
  '23001', NULL,
  'accounts cannot be deleted'
);

-- ---------------------------------------------------------------------------
-- TEST 6: TOTAL DEBITS = TOTAL CREDITS, and line shape
-- ---------------------------------------------------------------------------
-- 10 positive control: a balanced two-line entry is accepted
select lives_ok(
  $$select pg_temp.mk_entry_checked(
      'e1111111-1111-4111-8111-111111111111', 1, 'MANUAL', null,
      '[{"code":"5020","debit":100,"credit":0},{"code":"1010","debit":0,"credit":100}]'::jsonb)$$,
  'a balanced entry is accepted at commit time'
);

-- 11 an account that carries a balance cannot be archived
select throws_matching(
  $$update public.accounts set is_active = false
     where business_id = current_setting('test.biz')::uuid and code = '5020'$$,
  'still has a balance',
  'an account with a non-zero balance cannot be archived'
);

-- 12 unbalanced
select throws_matching(
  $$select pg_temp.mk_entry_checked(
      'e2222222-2222-4222-8222-222222222222', 2, 'MANUAL', null,
      '[{"code":"5020","debit":100,"credit":0},{"code":"1010","debit":0,"credit":90}]'::jsonb)$$,
  'is unbalanced',
  'an entry with debits <> credits is rejected at commit time'
);
-- 13 single line
select throws_matching(
  $$select pg_temp.mk_entry_checked(
      'e2222222-2222-4222-8222-222222222222', 2, 'MANUAL', null,
      '[{"code":"5020","debit":100,"credit":0}]'::jsonb)$$,
  'needs at least two lines',
  'an entry with a single line is rejected at commit time'
);
-- 14 no lines
select throws_matching(
  $$select pg_temp.mk_entry_checked(
      'e2222222-2222-4222-8222-222222222222', 2, 'MANUAL', null, '[]'::jsonb)$$,
  'needs at least two lines',
  'an entry with no lines is rejected at commit time'
);
-- 15-17 line shape: never both sides, never neither, never negative
select throws_matching(
  $$select pg_temp.mk_entry(
      'e2222222-2222-4222-8222-222222222222', 2, 'MANUAL', null,
      '[{"code":"5020","debit":50,"credit":50},{"code":"1010","debit":0,"credit":0}]'::jsonb)$$,
  'journal_lines_one_side',
  'a line cannot carry both a debit and a credit'
);
select throws_matching(
  $$select pg_temp.mk_entry(
      'e2222222-2222-4222-8222-222222222222', 2, 'MANUAL', null,
      '[{"code":"5020","debit":0,"credit":0},{"code":"1010","debit":0,"credit":0}]'::jsonb)$$,
  'journal_lines_one_side',
  'a line cannot have neither a debit nor a credit'
);
select throws_matching(
  $$select pg_temp.mk_entry(
      'e2222222-2222-4222-8222-222222222222', 2, 'MANUAL', null,
      '[{"code":"5020","debit":-5,"credit":0},{"code":"1010","debit":0,"credit":5}]'::jsonb)$$,
  'journal_lines_(debit_check|one_side)',
  'a line cannot carry a negative amount'
);

-- ---------------------------------------------------------------------------
-- TEST 5: journal lines are append-only
-- ---------------------------------------------------------------------------
-- 18 delete
select throws_ok(
  $$delete from public.journal_lines
     where journal_entry_id = 'e1111111-1111-4111-8111-111111111111'$$,
  '23001', NULL,
  'a journal line cannot be deleted'
);
-- 19 update
select throws_ok(
  $$update public.journal_lines set debit = 1
     where journal_entry_id = 'e1111111-1111-4111-8111-111111111111' and line_no = 1$$,
  '23001', NULL,
  'a journal line cannot be updated'
);
-- 20 truncate
select throws_ok(
  $$truncate public.journal_lines$$,
  '23001', NULL,
  'journal_lines cannot be truncated'
);
-- 21 entry delete
select throws_ok(
  $$delete from public.journal_entries where id = 'e1111111-1111-4111-8111-111111111111'$$,
  '23001', NULL,
  'a journal entry cannot be deleted'
);
-- 22 entry update
select throws_ok(
  $$update public.journal_entries set description = 'edited'
     where id = 'e1111111-1111-4111-8111-111111111111'$$,
  '23001', NULL,
  'a journal entry cannot be edited'
);
-- 23 clients have no DELETE privilege at all
select pg_temp.act_as('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select throws_ok(
  $$delete from public.journal_lines
     where journal_entry_id = 'e1111111-1111-4111-8111-111111111111'$$,
  '42501', NULL,
  'an authenticated client has no DELETE privilege on journal_lines'
);
reset role;

-- ---------------------------------------------------------------------------
-- The one approved change to a journal entry: the reversal link
-- ---------------------------------------------------------------------------
-- 24 reversal entry (exact mirror of e1111111...) is accepted
select lives_ok(
  $$select pg_temp.mk_entry_checked(
      'e3333333-3333-4333-8333-333333333333', 3, 'REVERSAL', 'e1111111-1111-4111-8111-111111111111',
      '[{"code":"1010","debit":100,"credit":0},{"code":"5020","debit":0,"credit":100}]'::jsonb)$$,
  'a reversal entry mirroring the original is accepted'
);
-- 25 the original may be linked to its reversal, once
select lives_ok(
  $$update public.journal_entries set reversed_by_entry_id = 'e3333333-3333-4333-8333-333333333333'
     where id = 'e1111111-1111-4111-8111-111111111111'$$,
  'the original entry can be linked to the entry that reverses it'
);
-- 26 and never changed again
select throws_matching(
  $$update public.journal_entries set reversed_by_entry_id = null
     where id = 'e1111111-1111-4111-8111-111111111111'$$,
  'has already been reversed',
  'a reversal link cannot be changed or removed once set'
);
-- 27 the link must point at an entry that actually reverses this one
select throws_matching(
  $$update public.journal_entries set reversed_by_entry_id = 'e1111111-1111-4111-8111-111111111111'
     where id = 'e3333333-3333-4333-8333-333333333333'$$,
  'must reference an entry that reverses this one',
  'a reversal link must point at a genuine reversal'
);
-- 28 with the balance back at zero, the account can now be archived
select lives_ok(
  $$update public.accounts set is_active = false
     where business_id = current_setting('test.biz')::uuid and code = '5020'$$,
  'an account whose balance is back to zero can be archived'
);

select * from finish();
rollback;
