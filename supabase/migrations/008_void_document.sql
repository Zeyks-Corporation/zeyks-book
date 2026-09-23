-- ============================================================================
-- 008_void_document.sql
-- Server-authoritative voiding for sales, purchases and expenses: POSTED ->
-- VOIDED with exactly one mirror reversal journal entry. Nothing is deleted,
-- and no reversal is ever recomputed from document totals — the original
-- journal lines are authoritative.
--
-- Rules every RPC in this project follows
--   * SECURITY DEFINER with search_path = '' and fully qualified names
--   * identity comes from auth.uid(); no user id or role is ever a parameter
--   * EXECUTE revoked from public, anon, then granted only to authenticated
--   * callers must be OWNER or ACCOUNTANT of the target business
--   * additive changes only; a breaking change ships as <name>_v2
--
-- Settlement model, OBSERVED in 005/006 (not inferred from the schema):
--   * post_sale writes its upfront settlement with journal_entry_id = the
--     sale's own journal entry; post_purchase does exactly the same for the
--     purchase. That settlement is part of the SAME accounting event, so the
--     single mirror reversal already reverses it. Only its doc_status is
--     flipped to VOIDED here — never a second payment journal entry, never a
--     changed amount, never a delete.
--   * There is no post_payment RPC yet, so no separately posted settlement
--     journal entry can exist today. The "a separately posted completed
--     settlement blocks the void" rule is enforced anyway, so it keeps holding
--     once that RPC ships.
--   * document.journal_entry_id is NOT NULL, unique and FK-protected, and
--     journal entries can never be deleted, so a document whose journal entry
--     is missing is unrepresentable. The relationship is still validated
--     against source_type/source_id so a hand-built inconsistent row fails
--     closed instead of being trusted.
--
-- Reversal semantics mirror AccountingEngine.buildReversal (accountingEngine.ts),
-- the reference implementation:
--   source_type = 'REVERSAL'
--   reverses_entry_id = original.id, source_id = original.source_id
--   reference = 'REV-' || original.reference
--   transaction_date = today in the business timezone (buildReversal's default)
--   lines = the original lines with debit and credit swapped, same account_id,
--           account_name and account_type snapshots, same line_no ordering
-- One documented adaptation: the contract accepts only business, type and id,
-- so there is no reason argument and the description is 'Reversal of <reference>'
-- — buildReversal's description with its optional reason removed.
--
-- Repeat calls: a document that is already VOIDED with its reversal in place
-- returns the persisted result unchanged (deterministic replay, no writes).
-- Anything else inconsistent raises 23514 and mutates nothing.
-- ============================================================================

create or replace function public.void_document(
  p_business_id   uuid,
  p_document_type text,
  p_document_id   uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid            uuid := (select auth.uid());
  v_business       public.businesses%rowtype;
  v_type           text;
  v_document       jsonb;
  v_doc_id         uuid;
  v_doc_status     text;
  v_journal_id     uuid;
  v_original       public.journal_entries%rowtype;
  v_reversal       public.journal_entries%rowtype;
  v_reversal_id    uuid;
  v_sequence       bigint;
  v_attempt        int;
  v_line           public.journal_lines%rowtype;
  v_today          date;
  v_blocking       int;
  v_embedded_ids   uuid[];
begin
  -- -------------------------------------------------------------------------
  -- 1. Identity & permissions
  -- -------------------------------------------------------------------------
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not public.is_member(p_business_id) then
    raise exception 'Not a member of this business' using errcode = '42501';
  end if;

  if not public.can_write(p_business_id) then
    raise exception 'Insufficient privileges: write access required' using errcode = '42501';
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Business profile (timezone for the void date)
  -- -------------------------------------------------------------------------
  select * into v_business from public.businesses where id = p_business_id;
  if not found then
    raise exception 'Business not found' using errcode = '22023';
  end if;

  v_type := upper(btrim(coalesce(p_document_type, '')));
  if v_type not in ('SALE', 'PURCHASE', 'EXPENSE') then
    raise exception 'Unsupported document type: %', coalesce(p_document_type, 'null')
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Resolve and LOCK the document
  --    A missing row covers all three of: unknown id, an id belonging to
  --    another document type, and another tenant's document — one message, so
  --    nothing about another business leaks.
  -- -------------------------------------------------------------------------
  if v_type = 'SALE' then
    select to_jsonb(s), s.id, s.status, s.journal_entry_id
      into v_document, v_doc_id, v_doc_status, v_journal_id
      from public.sales s
     where s.business_id = p_business_id and s.id = p_document_id
       for update;
  elsif v_type = 'PURCHASE' then
    select to_jsonb(p), p.id, p.status, p.journal_entry_id
      into v_document, v_doc_id, v_doc_status, v_journal_id
      from public.purchases p
     where p.business_id = p_business_id and p.id = p_document_id
       for update;
  else
    select to_jsonb(e), e.id, e.status, e.journal_entry_id
      into v_document, v_doc_id, v_doc_status, v_journal_id
      from public.expenses e
     where e.business_id = p_business_id and e.id = p_document_id
       for update;
  end if;

  if v_doc_id is null then
    raise exception 'Document not found in this business' using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Lock the original journal entry and re-read its reversal state
  -- -------------------------------------------------------------------------
  select * into v_original
    from public.journal_entries
   where business_id = p_business_id and id = v_journal_id
     for update;

  if not found then
    raise exception 'The journal entry for this document is missing' using errcode = '23514';
  end if;

  -- The persisted relationship is validated, never trusted.
  if v_original.source_type <> v_type or v_original.source_id is distinct from v_doc_id then
    raise exception 'Journal entry % does not belong to this % (source mismatch)',
      v_original.reference, lower(v_type)
      using errcode = '23514';
  end if;

  if v_original.reverses_entry_id is not null then
    raise exception 'Journal entry % is itself a reversal and cannot be voided', v_original.reference
      using errcode = '23514';
  end if;

  -- Payments that share this journal entry are the embedded upfront
  -- settlements: one accounting event, reversed once by the mirror below.
  select coalesce(array_agg(p.id), '{}'::uuid[]) into v_embedded_ids
    from public.payments p
   where p.business_id = p_business_id
     and p.journal_entry_id = v_original.id
     and (
       (v_type = 'SALE' and p.linked_sale_id = v_doc_id)
       or (v_type = 'PURCHASE' and p.linked_purchase_id = v_doc_id)
     );

  -- -------------------------------------------------------------------------
  -- 5. Deterministic replay: already voided with its reversal in place
  -- -------------------------------------------------------------------------
  if v_doc_status = 'VOIDED' then
    if v_original.reversed_by_entry_id is null then
      raise exception 'Document is marked VOIDED but journal entry % has no reversal',
        v_original.reference
        using errcode = '23514';
    end if;

    return jsonb_build_object(
      'document', v_document,
      'original_journal_entry', (select to_jsonb(je) from public.journal_entries je where je.id = v_original.id),
      'reversal_journal_entry', (
        select to_jsonb(je) from public.journal_entries je where je.id = v_original.reversed_by_entry_id
      ),
      'reversal_journal_lines', (
        select jsonb_agg(to_jsonb(jl) order by jl.line_no)
          from public.journal_lines jl
         where jl.journal_entry_id = v_original.reversed_by_entry_id
      ),
      'affected_payments', (
        select coalesce(jsonb_agg(to_jsonb(p) order by p.reference), '[]'::jsonb)
          from public.payments p
         where p.business_id = p_business_id and p.id = any(v_embedded_ids)
      )
    );
  end if;

  -- -------------------------------------------------------------------------
  -- 6. Inconsistent state fails closed
  -- -------------------------------------------------------------------------
  if v_original.reversed_by_entry_id is not null then
    raise exception 'Journal entry % has already been reversed while the document is still POSTED',
      v_original.reference
      using errcode = '23514';
  end if;

  -- A completed settlement with its OWN journal entry is a separate accounting
  -- event: reversing only the document would strand the cash.
  select count(*) into v_blocking
    from public.payments p
   where p.business_id = p_business_id
     and p.doc_status = 'POSTED'
     and p.status = 'COMPLETED'
     and p.journal_entry_id <> v_original.id
     and (
       (v_type = 'SALE' and p.linked_sale_id = v_doc_id)
       or (v_type = 'PURCHASE' and p.linked_purchase_id = v_doc_id)
     );

  if v_blocking > 0 then
    raise exception 'Document has % separately posted settlement(s); reverse those first', v_blocking
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 7. Create exactly one mirror reversal
  -- -------------------------------------------------------------------------
  v_today := (now() at time zone coalesce(v_business.timezone, 'Asia/Kathmandu'))::date;
  v_reversal_id := gen_random_uuid();

  -- The journal sequence is business-wide and post_sale/post_purchase do not
  -- take a shared advisory lock, so a concurrent post can claim the same
  -- number. The unique constraint turns that into a unique_violation and the
  -- handler's savepoint rollback lets us recompute and retry.
  v_attempt := 0;
  loop
    v_attempt := v_attempt + 1;
    begin
      select coalesce(max(sequence), 0) + 1
        into v_sequence
        from public.journal_entries
       where business_id = p_business_id;

      insert into public.journal_entries (
        id, business_id, transaction_date, sequence, description,
        reference, source_type, source_id, created_by, reverses_entry_id
      ) values (
        v_reversal_id, p_business_id, v_today, v_sequence,
        'Reversal of ' || v_original.reference,
        'REV-' || v_original.reference,
        'REVERSAL', v_original.source_id, v_uid, v_original.id
      ) returning * into v_reversal;

      -- Exact mirror: same accounts, same snapshots, same line numbers, with
      -- debit and credit swapped. No recomputation from document totals.
      for v_line in
        select * from public.journal_lines
         where journal_entry_id = v_original.id
         order by line_no
      loop
        insert into public.journal_lines (
          business_id, journal_entry_id, line_no,
          account_id, account_name, account_type, debit, credit
        ) values (
          p_business_id, v_reversal.id, v_line.line_no,
          v_line.account_id, v_line.account_name, v_line.account_type,
          v_line.credit, v_line.debit
        );
      end loop;

      exit;
    exception when unique_violation then
      if v_attempt >= 3 then
        raise;
      end if;
      v_reversal_id := gen_random_uuid();
    end;
  end loop;

  -- -------------------------------------------------------------------------
  -- 8. Link, mark and settle the embedded rows — all in the same transaction
  -- -------------------------------------------------------------------------
  update public.journal_entries
     set reversed_by_entry_id = v_reversal.id
   where business_id = p_business_id and id = v_original.id;

  if v_type = 'SALE' then
    update public.sales set status = 'VOIDED'
     where business_id = p_business_id and id = v_doc_id;
  elsif v_type = 'PURCHASE' then
    update public.purchases set status = 'VOIDED'
     where business_id = p_business_id and id = v_doc_id;
  else
    update public.expenses set status = 'VOIDED'
     where business_id = p_business_id and id = v_doc_id;
  end if;

  if array_length(v_embedded_ids, 1) is not null then
    update public.payments set doc_status = 'VOIDED'
     where business_id = p_business_id and id = any(v_embedded_ids);
  end if;

  -- -------------------------------------------------------------------------
  -- 9. Return persisted rows, never incoming values
  -- -------------------------------------------------------------------------
  return jsonb_build_object(
    'document', case v_type
      when 'SALE' then (
        select to_jsonb(d) from public.sales d
         where d.business_id = p_business_id and d.id = v_doc_id
      )
      when 'PURCHASE' then (
        select to_jsonb(d) from public.purchases d
         where d.business_id = p_business_id and d.id = v_doc_id
      )
      else (
        select to_jsonb(d) from public.expenses d
         where d.business_id = p_business_id and d.id = v_doc_id
      )
    end,
    'original_journal_entry', (
      select to_jsonb(je) from public.journal_entries je where je.id = v_original.id
    ),
    'reversal_journal_entry', (
      select to_jsonb(je) from public.journal_entries je where je.id = v_reversal.id
    ),
    'reversal_journal_lines', (
      select jsonb_agg(to_jsonb(jl) order by jl.line_no)
        from public.journal_lines jl
       where jl.journal_entry_id = v_reversal.id
    ),
    'affected_payments', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.reference), '[]'::jsonb)
        from public.payments p
       where p.business_id = p_business_id and p.id = any(v_embedded_ids)
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------------
revoke all on function public.void_document(uuid, text, uuid)
  from public, anon, authenticated;

grant execute on function public.void_document(uuid, text, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Safety net: function privileges
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and not exists (select 1 from pg_event_trigger et where et.evtfoid = p.oid)
     and (
       has_function_privilege('anon', p.oid, 'EXECUTE')
       or (
         has_function_privilege('authenticated', p.oid, 'EXECUTE')
         and p.proname not in ('is_member', 'can_write', 'is_owner', 'create_business', 'post_sale', 'post_purchase', 'post_expense', 'void_document')
       )
     );
  if v_bad is not null then
    raise exception 'Unexpected EXECUTE privilege on: %', v_bad;
  end if;
end $$;
