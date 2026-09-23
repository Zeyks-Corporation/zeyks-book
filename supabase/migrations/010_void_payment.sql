-- ============================================================================
-- 010_void_payment.sql
-- Server-authoritative voiding for a singly posted settlement: POSTED ->
-- VOIDED with exactly one mirror reversal journal entry. Nothing is deleted,
-- and no reversal is ever recomputed from amounts — the payment's own journal
-- lines are authoritative.
--
-- No schema change is needed. 001 already provides every invariant this RPC
-- depends on:
--   * payments.doc_status + payments_guard_update: only doc_status may change,
--     and only POSTED -> VOIDED;
--   * journal_entries_reverses_uidx, UNIQUE (business_id, reverses_entry_id):
--     at most one reversal entry per original, enforced by the database even if
--     this function were bypassed;
--   * journal_entries_reversed_by_uidx + guard_journal_entry_update:
--     reversed_by_entry_id may only go NULL -> value, only once, and only
--     towards an entry that actually reverses this one;
--   * assert_journal_entry_balanced: the mirror must balance at COMMIT.
--
-- Rules every RPC in this project follows
--   * SECURITY DEFINER with search_path = '' and fully qualified names
--   * identity comes from auth.uid(); no user id or role is ever a parameter
--   * EXECUTE revoked from public, anon, then granted only to authenticated
--   * callers must be OWNER or ACCOUNTANT of the target business
--   * additive changes only; a breaking change ships as <name>_v2
--
-- Reversal semantics mirror void_document (008) and, through it,
-- AccountingEngine.buildReversal (accountingEngine.ts):
--   source_type = 'REVERSAL'
--   reverses_entry_id = original.id, source_id = original.source_id
--   reference = 'REV-' || original.reference
--   transaction_date = today in the business timezone
--   lines = the original lines with debit and credit swapped, same account_id,
--           account_name and account_type snapshots, same line_no ordering
-- That is deliberate: this is the same reversal architecture, not a second one.
--
-- Which payments can be voided, OBSERVED in 005/006/009 (not inferred):
--   * post_sale / post_purchase write the upfront settlement with
--     journal_entry_id = the DOCUMENT's own journal entry. It is part of the
--     same accounting event, so it is not a separate event that can be
--     reversed on its own: reversing that entry would reverse the sale's
--     revenue, VAT, receivable and cost of goods in one stroke while leaving
--     the document POSTED. Such a settlement is REFUSED here and must be
--     reversed by voiding its document, which reverses the whole event once.
--   * post_payment writes a settlement with its OWN journal entry
--     (source_type = 'PAYMENT', source_id = payment.id). That is the only thing
--     this RPC voides.
--   The relationship is therefore validated from the persisted rows rather than
--   trusted, which is exactly what separates the two cases.
--
-- Why the document row needs no lock and no update:
--   * reconcile() derives paid/due/status from COMPLETED + POSTED settlement
--     rows, so flipping doc_status to VOIDED raises the document's outstanding
--     balance by itself. No stored paid/due field is introduced.
--   * post_payment() computes due as total - sum(settled) under the document
--     lock. Voiding a settlement can only ever DECREASE that sum, so an amount
--     accepted against the pre-void due is always <= the post-void due: a
--     concurrent post_payment and void_payment cannot over-settle the document,
--     in either commit order. That is why the payment row lock is sufficient.
--   * The parent document's status is never touched: voiding a settlement is
--     not voiding the sale or purchase.
--
-- Repeat calls: a payment that is already VOIDED with its reversal in place
-- returns the persisted result unchanged (deterministic replay, no writes, no
-- new sequence). Anything else inconsistent raises 23514 and mutates nothing.
-- ============================================================================

create or replace function public.void_payment(
  p_business_id uuid,
  p_payment_id  uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid           uuid := (select auth.uid());
  v_business      public.businesses%rowtype;
  v_payment       public.payments%rowtype;
  v_original      public.journal_entries%rowtype;
  v_reversal      public.journal_entries%rowtype;
  v_reversal_id   uuid;
  v_sequence      bigint;
  v_attempt       int;
  v_line          public.journal_lines%rowtype;
  v_today         date;
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
  -- 2. Business profile (timezone for the reversal date)
  -- -------------------------------------------------------------------------
  select * into v_business from public.businesses where id = p_business_id;
  if not found then
    raise exception 'Business not found' using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Resolve and LOCK the payment
  --    One message covers all three of: unknown id, a malformed id and another
  --    tenant's payment, so nothing about another business leaks. The lock is
  --    what makes two concurrent voids of the same payment converge: the loser
  --    waits, re-reads the committed row and takes the replay path below.
  -- -------------------------------------------------------------------------
  select * into v_payment
    from public.payments
   where business_id = p_business_id and id = p_payment_id
     for update;

  if v_payment.id is null then
    raise exception 'Payment not found in this business' using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Lock the journal entry that belongs to this payment
  -- -------------------------------------------------------------------------
  if v_payment.journal_entry_id is null then
    raise exception 'Payment % has no journal entry to reverse', v_payment.reference
      using errcode = '23514';
  end if;

  select * into v_original
    from public.journal_entries
   where business_id = p_business_id and id = v_payment.journal_entry_id
     for update;

  if not found then
    raise exception 'The journal entry for payment % is missing', v_payment.reference
      using errcode = '23514';
  end if;

  -- The persisted relationship is validated, never trusted. This is also the
  -- rule that refuses an embedded upfront settlement, whose entry belongs to
  -- the sale or purchase itself.
  if v_original.source_type <> 'PAYMENT' or v_original.source_id is distinct from v_payment.id then
    if v_original.source_type in ('SALE', 'PURCHASE', 'EXPENSE') then
      raise exception
        'Settlement % is part of its document''s journal entry (%); void the document instead',
        v_payment.reference, v_original.source_type
        using errcode = '23514';
    end if;

    raise exception 'Journal entry % does not belong to payment % (source mismatch)',
      v_original.reference, v_payment.reference
      using errcode = '23514';
  end if;

  if v_original.reverses_entry_id is not null then
    raise exception 'Journal entry % is itself a reversal and cannot be voided', v_original.reference
      using errcode = '23514';
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Deterministic replay: already voided with its reversal in place
  -- -------------------------------------------------------------------------
  if v_payment.doc_status = 'VOIDED' then
    if v_original.reversed_by_entry_id is null then
      raise exception 'Payment % is marked VOIDED but journal entry % has no reversal',
        v_payment.reference, v_original.reference
        using errcode = '23514';
    end if;

    return jsonb_build_object(
      'payment', to_jsonb(v_payment),
      'document', case
        when v_payment.linked_sale_id is not null then (
          select to_jsonb(d) from public.sales d
           where d.business_id = p_business_id and d.id = v_payment.linked_sale_id
        )
        when v_payment.linked_purchase_id is not null then (
          select to_jsonb(d) from public.purchases d
           where d.business_id = p_business_id and d.id = v_payment.linked_purchase_id
        )
        else null
      end,
      'original_journal_entry', (
        select to_jsonb(je) from public.journal_entries je where je.id = v_original.id
      ),
      'reversal_journal_entry', (
        select to_jsonb(je) from public.journal_entries je where je.id = v_original.reversed_by_entry_id
      ),
      'reversal_journal_lines', (
        select jsonb_agg(to_jsonb(jl) order by jl.line_no)
          from public.journal_lines jl
         where jl.journal_entry_id = v_original.reversed_by_entry_id
      )
    );
  end if;

  -- -------------------------------------------------------------------------
  -- 6. Inconsistent state fails closed
  -- -------------------------------------------------------------------------
  if v_original.reversed_by_entry_id is not null then
    raise exception 'Journal entry % has already been reversed while payment % is still POSTED',
      v_original.reference, v_payment.reference
      using errcode = '23514';
  end if;

  -- -------------------------------------------------------------------------
  -- 7. Create exactly one mirror reversal
  -- -------------------------------------------------------------------------
  v_today := (now() at time zone coalesce(v_business.timezone, 'Asia/Kathmandu'))::date;
  v_reversal_id := gen_random_uuid();

  -- The journal sequence is business-wide, so a concurrent post can claim the
  -- same number: the unique constraint turns that into a unique_violation and
  -- the handler's savepoint rollback lets us recompute and retry. Same bounded
  -- approach as void_document.
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
      -- debit and credit swapped. Never recomputed from the payment amount.
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
  -- 8. Link and mark — one transaction. The payment row stays, the document is
  --    not touched, and doc_status is the only column that changes.
  -- -------------------------------------------------------------------------
  update public.journal_entries
     set reversed_by_entry_id = v_reversal.id
   where business_id = p_business_id and id = v_original.id;

  update public.payments
     set doc_status = 'VOIDED'
   where business_id = p_business_id and id = v_payment.id;

  -- -------------------------------------------------------------------------
  -- 9. Return persisted rows, never incoming values
  -- -------------------------------------------------------------------------
  return jsonb_build_object(
    'payment', (
      select to_jsonb(p) from public.payments p
       where p.business_id = p_business_id and p.id = v_payment.id
    ),
    'document', case
      when v_payment.linked_sale_id is not null then (
        select to_jsonb(d) from public.sales d
         where d.business_id = p_business_id and d.id = v_payment.linked_sale_id
      )
      when v_payment.linked_purchase_id is not null then (
        select to_jsonb(d) from public.purchases d
         where d.business_id = p_business_id and d.id = v_payment.linked_purchase_id
      )
      else null
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
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------------
revoke all on function public.void_payment(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.void_payment(uuid, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Safety net: function privileges (restated, with void_payment added)
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
         and p.proname not in ('is_member', 'can_write', 'is_owner', 'create_business', 'post_sale', 'post_purchase', 'post_expense', 'void_document', 'post_payment', 'void_payment')
       )
     );
  if v_bad is not null then
    raise exception 'Unexpected EXECUTE privilege on: %', v_bad;
  end if;
end $$;
