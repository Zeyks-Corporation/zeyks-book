-- ============================================================================
-- 009_post_payment.sql
-- Atomic manual settlement RPC: records one payments row and its own balanced
-- journal entry against a SALE (money in) or a PURCHASE (money out).
--
-- Rules every RPC in this project follows
--   * SECURITY DEFINER with search_path = '' and fully qualified names
--   * identity comes from auth.uid(); no user id or role is ever a parameter
--   * EXECUTE revoked from public, anon, then granted only to authenticated
--   * callers must be OWNER or ACCOUNTANT of the target business
--   * additive changes only; a breaking change ships as <name>_v2
--
-- Accounting semantics are copied from src/services/posting.ts
-- (buildPaymentEntry), the authoritative source:
--
--   INCOMING (against a sale):      OUTGOING (against a purchase):
--     Dr Cash/Bank/Wallet  amount     Dr Accounts payable (2010)  amount
--         Cr Receivable (1030)            Cr Cash/Bank/Wallet
--
-- Settlement mapping mirrors AccountLookup.settlement exactly:
--   CASH -> 1010, BANK -> 1020, ESEWA -> 1040 when that wallet account is
--   active else 1020, KHALTI -> 1050 when active else 1020.
--
-- The entry's description, reference and source_type match buildPaymentEntry:
--   description = 'Settlement from <party>' / 'Settlement to <party>'
--   reference   = the payment's own reference, source_type = 'PAYMENT',
--                 source_id = the payment row's id.
-- This entry is a SEPARATE accounting event from the document's own entry, so
-- after this migration it is what blocks void_document() (008 section 6), while
-- the embedded upfront settlement that shares the document's entry stays part
-- of the single mirror reversal.
--
-- Due calculation — the single source of truth is the payments sub-ledger:
--   due = document.total_amount
--         - sum(amount of this document's payments that are status COMPLETED
--               and doc_status POSTED)
-- The embedded upfront row written by post_sale/post_purchase (005/006) IS one
-- of those rows (it shares the document's journal entry but it is still a
-- payments row), so it is counted exactly once and never through the stored
-- upfront_paid column. That matches reconcile() in posting.ts, which derives
-- paid_amount the same way.
--
-- Concurrency. The linked document row is locked FOR UPDATE *before* the
-- idempotency lookup and before due is recomputed, so two concurrent requests
-- cannot both consume the same outstanding balance:
--   * identical requests (same idempotency key) — the loser waits, then finds
--     the winner's committed payment and replays it read-only;
--   * different requests — the loser waits, recomputes due against the
--     committed settlement and is rejected as over-settlement.
-- A unique_violation on (business_id, idempotency_key) is still caught as the
-- database backstop and resolved into the same replay-or-conflict decision.
-- The advisory lock is taken after the document lock (documents first, always),
-- so no lock order cycle exists with post_sale/post_purchase/post_expense.
--
-- Idempotency mirrors post_expense (Stage 4 convention):
--   * a blank or whitespace-only key means "no key";
--   * the fingerprint covers document, amount, method, date, notes and the
--     caller's requested reference — never the allocated reference, the
--     journal sequence or any generated id;
--   * the caller's requested reference is stored in `requested_reference` so a
--     retry that omitted the reference replays instead of looking changed.
--
-- Not implemented here (deliberately): gateway initiation/verification, eSewa
-- or Khalti API calls, refunds, payment voiding, and standalone payments that
-- are not attached to a document — expenses are settled when they are posted
-- and cannot be settled again.
-- ============================================================================

-- ============================================================================
-- Schema additions
-- ============================================================================

alter table public.payments add column idempotency_key text;
-- The reference the CALLER asked for (null when it asked the server to
-- allocate one), so the idempotency fingerprint describes the request rather
-- than the reference the server ended up issuing.
alter table public.payments add column requested_reference text;

alter table public.payments
  add constraint payments_idempotency_key_len
  check (idempotency_key is null or length(idempotency_key) <= 200);

alter table public.payments
  add constraint payments_requested_reference_len
  check (requested_reference is null or length(requested_reference) <= 100);

-- Same business + same key can exist at most once; legacy rows (null) are free.
create unique index payments_business_idempotency_uidx
  on public.payments (business_id, idempotency_key)
  where idempotency_key is not null;

-- ============================================================================
-- post_payment
-- ============================================================================

create or replace function public.post_payment(
  p_business_id     uuid,
  p_document_type   text,
  p_document_id     uuid,
  p_amount          numeric,
  p_payment_method  text    default 'CASH',
  p_date            date    default null,
  p_reference       text    default '',
  p_notes           text    default null,
  p_idempotency_key text    default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid            uuid := (select auth.uid());
  v_business       public.businesses%rowtype;
  v_type           text;
  v_doc_id         uuid;
  v_doc_status     text;
  v_doc_entry      uuid;
  v_doc_total      numeric(14,2);
  v_party          text;
  v_method         text;
  v_settle_code    text;
  v_acc_settle     public.accounts%rowtype;
  v_acc_counter    public.accounts%rowtype;
  v_counter_code   text;
  v_payment        public.payments%rowtype;
  v_existing       public.payments%rowtype;
  v_journal_entry  public.journal_entries%rowtype;
  v_reference      text;
  v_requested_ref  text;
  v_key            text;
  v_notes          text;
  v_amount         numeric(14,2);
  v_settled        numeric(14,2);
  v_due            numeric(14,2);
  v_today          date;
  v_date           date;
  v_sequence       bigint;
  v_journal_id     uuid;
  v_payment_id     uuid;
  v_line_idx       smallint := 1;
  v_attempt        int;
  v_check_label    text;
  v_check_value    numeric;
  v_incoming_fp    text;
  v_stored_fp      text;
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
  -- 2. Business profile (timezone for the settlement date)
  -- -------------------------------------------------------------------------
  select * into v_business from public.businesses where id = p_business_id;
  if not found then
    raise exception 'Business not found' using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Document type decides the payment direction
  --    SALE -> INCOMING, PURCHASE -> OUTGOING. An expense cannot be settled
  --    here: it is paid when it is posted, so it has no payable to draw down.
  -- -------------------------------------------------------------------------
  v_type := upper(btrim(coalesce(p_document_type, '')));
  if v_type not in ('SALE', 'PURCHASE') then
    raise exception 'Unsupported document type: only SALE and PURCHASE can be settled'
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Resolve and LOCK the document — before the idempotency lookup and
  --    before due is recomputed, so a concurrent settlement cannot slip past.
  --    A missing row covers all three of: unknown id, an id of another document
  --    type, and another tenant's document — one message, nothing leaks.
  -- -------------------------------------------------------------------------
  if v_type = 'SALE' then
    select s.id, s.status, s.journal_entry_id, s.total_amount, s.customer_name
      into v_doc_id, v_doc_status, v_doc_entry, v_doc_total, v_party
      from public.sales s
     where s.business_id = p_business_id and s.id = p_document_id
       for update;
  else
    select p.id, p.status, p.journal_entry_id, p.total_amount, p.supplier_name
      into v_doc_id, v_doc_status, v_doc_entry, v_doc_total, v_party
      from public.purchases p
     where p.business_id = p_business_id and p.id = p_document_id
       for update;
  end if;

  if v_doc_id is null then
    raise exception 'Document not found in this business' using errcode = '22023';
  end if;

  if v_doc_status = 'VOIDED' then
    raise exception 'Document is voided: settled money must be reversed before it can be settled again'
      using errcode = '22023';
  end if;

  if v_doc_entry is null then
    raise exception 'The journal entry for this document is missing' using errcode = '23514';
  end if;

  -- Fail closed on a hand-built inconsistent row rather than trusting the
  -- document's journal_entry_id blindly (same rule as void_document).
  if not exists (
    select 1 from public.journal_entries je
     where je.business_id = p_business_id
       and je.id = v_doc_entry
       and je.source_type = v_type
       and je.source_id = v_doc_id
  ) then
    raise exception 'The document''s journal entry does not belong to it (source mismatch)'
      using errcode = '23514';
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Payment method
  -- -------------------------------------------------------------------------
  v_method := upper(btrim(coalesce(p_payment_method, '')));
  if v_method not in ('CASH', 'BANK', 'ESEWA', 'KHALTI') then
    raise exception 'Invalid payment method: %', p_payment_method using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 6. Amount
  -- -------------------------------------------------------------------------
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero' using errcode = '22023';
  end if;

  -- Reject values numeric(14,2) cannot represent without silent rounding.
  for v_check_label, v_check_value in
    select t.label, t.val from (values ('Amount', p_amount)) as t(label, val)
  loop
    if v_check_value is not null
       and (v_check_value <> round(v_check_value, 2) or abs(v_check_value) > 999999999999.99) then
      raise exception '% must be a numeric(14,2) amount with at most 2 decimal places', v_check_label
        using errcode = '22023';
    end if;
  end loop;

  v_amount := round(p_amount, 2);

  -- -------------------------------------------------------------------------
  -- 7. Date (business timezone — never the caller's local date)
  -- -------------------------------------------------------------------------
  v_today := (now() at time zone coalesce(v_business.timezone, 'Asia/Kathmandu'))::date;
  v_date  := coalesce(p_date, v_today);
  if v_date > v_today then
    raise exception 'Settlement date % cannot be in the future (today in % is %)',
      v_date, coalesce(v_business.timezone, 'Asia/Kathmandu'), v_today
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 8. Reference and idempotency key, normalised once
  -- -------------------------------------------------------------------------
  v_requested_ref := btrim(coalesce(p_reference, ''));
  if length(v_requested_ref) > 100 then
    raise exception 'Reference is too long (max 100 characters)' using errcode = '22023';
  end if;

  v_notes := btrim(coalesce(p_notes, ''));

  -- Blank or whitespace-only means "no key" (post_expense convention).
  v_key := nullif(btrim(p_idempotency_key), '');
  if v_key is not null and length(v_key) > 200 then
    raise exception 'Idempotency key is too long (max 200 characters)' using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 9. Idempotency lookup — after the document lock, so a concurrent identical
  --    request always finds the winner's committed payment here.
  -- -------------------------------------------------------------------------
  if v_key is not null then
    select * into v_existing
      from public.payments
     where business_id = p_business_id and idempotency_key = v_key;
  end if;

  if v_existing.id is not null then
    -- Collision-safe serialisation: the document, the normalised request
    -- values and the caller's requested reference. The allocated reference,
    -- the journal sequence and every generated id are deliberately absent.
    v_incoming_fp := md5(concat_ws('|',
      v_type,
      v_doc_id::text,
      v_amount::numeric(14,2)::text,
      v_method,
      v_date::text,
      v_notes,
      v_requested_ref
    ));

    v_stored_fp := md5(concat_ws('|',
      case when v_existing.linked_sale_id is not null then 'SALE' else 'PURCHASE' end,
      coalesce(v_existing.linked_sale_id, v_existing.linked_purchase_id)::text,
      round(v_existing.amount, 2)::numeric(14,2)::text,
      v_existing.payment_method,
      v_existing.date::text,
      btrim(coalesce(v_existing.notes, '')),
      coalesce(v_existing.requested_reference, '')
    ));

    if v_incoming_fp is distinct from v_stored_fp then
      raise exception 'Idempotency key was already used with a different settlement request'
        using errcode = '23505';
    end if;

    -- Rebuilt read-only from the persisted rows: no incoming value is reused,
    -- nothing is written and no reference is reallocated.
    return jsonb_build_object(
      'payment', to_jsonb(v_existing),
      'document', case
        when v_existing.linked_sale_id is not null then (
          select to_jsonb(d) from public.sales d
           where d.business_id = p_business_id and d.id = v_existing.linked_sale_id
        )
        else (
          select to_jsonb(d) from public.purchases d
           where d.business_id = p_business_id and d.id = v_existing.linked_purchase_id
        )
      end,
      'journal_entry', (
        select to_jsonb(je) from public.journal_entries je where je.id = v_existing.journal_entry_id
      ),
      'journal_lines', (
        select jsonb_agg(to_jsonb(jl) order by jl.line_no)
          from public.journal_lines jl
         where jl.journal_entry_id = v_existing.journal_entry_id
      )
    );
  end if;

  -- -------------------------------------------------------------------------
  -- 10. Outstanding balance, recomputed from the persisted sub-ledger
  -- -------------------------------------------------------------------------
  if v_type = 'SALE' then
    select coalesce(sum(p.amount), 0) into v_settled
      from public.payments p
     where p.business_id = p_business_id
       and p.linked_sale_id = v_doc_id
       and p.status = 'COMPLETED'
       and p.doc_status = 'POSTED';
  else
    select coalesce(sum(p.amount), 0) into v_settled
      from public.payments p
     where p.business_id = p_business_id
       and p.linked_purchase_id = v_doc_id
       and p.status = 'COMPLETED'
       and p.doc_status = 'POSTED';
  end if;

  v_due := round(v_doc_total - v_settled, 2);

  if v_due <= 0.005 then
    raise exception 'Document has no outstanding balance (total %, already settled %)',
      v_doc_total, v_settled
      using errcode = '22023';
  end if;

  if v_amount > v_due + 0.005 then
    raise exception 'Amount % exceeds the outstanding balance of % on this document',
      v_amount, v_due
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 11. Creation (serialised per business) — reference, journal, payment
  -- -------------------------------------------------------------------------
  declare
    v_created boolean := false;
  begin
  begin
    -- One transaction-scoped lock per business serialises concurrent posts so
    -- the journal sequence and any server-side reference cannot collide.
    perform pg_advisory_xact_lock(hashtextextended(p_business_id::text, 0));

    -- Reference: keep the caller's number when supplied; otherwise allocate
    -- RCP-YYYYMMDD-NNN (money in) or PAY-YYYYMMDD-NNN (money out), the same
    -- formats referenceGenerator used, scoped to this business.
    v_reference := v_requested_ref;
    if v_reference = '' then
      declare
        v_kind   text := case when v_type = 'SALE' then 'RCP' else 'PAY' end;
        v_prefix text := v_kind || '-' || to_char(v_date, 'YYYYMMDD') || '-';
        v_next   int;
      begin
        select coalesce(max(substring(reference from length(v_prefix) + 1)::int), 0) + 1
          into v_next
          from public.payments
         where business_id = p_business_id
           and reference like v_prefix || '%'
           and substring(reference from length(v_prefix) + 1) ~ '^[0-9]+$';
        v_reference := v_prefix || lpad(v_next::text, 3, '0');
      end;
    else
      if exists (
        select 1 from public.payments
         where business_id = p_business_id and reference = v_reference
      ) then
        raise exception 'Payment reference % already exists in this business', v_reference
          using errcode = '23505';
      end if;
    end if;

    -- Settlement asset account (mirrors AccountLookup.settlement).
    if v_method = 'CASH' then
      v_settle_code := '1010';
    elsif v_method = 'BANK' then
      v_settle_code := '1020';
    elsif v_method = 'ESEWA' then
      v_settle_code := case when exists (
        select 1 from public.accounts where business_id = p_business_id and code = '1040' and is_active
      ) then '1040' else '1020' end;
    elsif v_method = 'KHALTI' then
      v_settle_code := case when exists (
        select 1 from public.accounts where business_id = p_business_id and code = '1050' and is_active
      ) then '1050' else '1020' end;
    end if;

    select * into v_acc_settle
      from public.accounts
     where business_id = p_business_id and code = v_settle_code;
    if not found then
      raise exception 'Settlement account % is missing from chart of accounts', v_settle_code
        using errcode = '22023';
    end if;

    -- Counterpart: receivable for money in, payable for money out.
    v_counter_code := case when v_type = 'SALE' then '1030' else '2010' end;
    select * into v_acc_counter
      from public.accounts
     where business_id = p_business_id and code = v_counter_code;
    if not found then
      raise exception 'Account % is missing from chart of accounts', v_counter_code
        using errcode = '22023';
    end if;

    v_journal_id := gen_random_uuid();
    v_payment_id := gen_random_uuid();

    -- The journal sequence is business-wide and post_sale/post_purchase do not
    -- take the same advisory lock, so a concurrent post can claim the same
    -- number; the unique constraint turns that into a unique_violation and the
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
          reference, source_type, source_id, created_by
        ) values (
          v_journal_id, p_business_id, v_date, v_sequence,
          case when v_type = 'SALE' then 'Settlement from ' else 'Settlement to ' end || v_party,
          v_reference, 'PAYMENT', v_payment_id, v_uid
        ) returning * into v_journal_entry;

        -- Lines in buildPaymentEntry order: money in debits the settlement
        -- account first, money out debits the payable first.
        if v_type = 'SALE' then
          insert into public.journal_lines (
            business_id, journal_entry_id, line_no,
            account_id, account_name, account_type, debit, credit
          ) values (
            p_business_id, v_journal_id, v_line_idx,
            v_acc_settle.id, v_acc_settle.name, v_acc_settle.type, v_amount, 0
          );
          v_line_idx := v_line_idx + 1;

          insert into public.journal_lines (
            business_id, journal_entry_id, line_no,
            account_id, account_name, account_type, debit, credit
          ) values (
            p_business_id, v_journal_id, v_line_idx,
            v_acc_counter.id, v_acc_counter.name, v_acc_counter.type, 0, v_amount
          );
          v_line_idx := v_line_idx + 1;
        else
          insert into public.journal_lines (
            business_id, journal_entry_id, line_no,
            account_id, account_name, account_type, debit, credit
          ) values (
            p_business_id, v_journal_id, v_line_idx,
            v_acc_counter.id, v_acc_counter.name, v_acc_counter.type, v_amount, 0
          );
          v_line_idx := v_line_idx + 1;

          insert into public.journal_lines (
            business_id, journal_entry_id, line_no,
            account_id, account_name, account_type, debit, credit
          ) values (
            p_business_id, v_journal_id, v_line_idx,
            v_acc_settle.id, v_acc_settle.name, v_acc_settle.type, 0, v_amount
          );
          v_line_idx := v_line_idx + 1;
        end if;

        exit;
      exception when unique_violation then
        if v_attempt >= 3 then
          raise;
        end if;
        v_line_idx := 1;
        v_journal_id := gen_random_uuid();
      end;
    end loop;

    insert into public.payments (
      id, business_id, reference, date, amount, payment_method, status,
      payment_type, linked_sale_id, linked_purchase_id, party_name,
      doc_status, notes, journal_entry_id, created_by,
      idempotency_key, requested_reference
    ) values (
      v_payment_id, p_business_id, v_reference, v_date, v_amount, v_method, 'COMPLETED',
      case when v_type = 'SALE' then 'INCOMING' else 'OUTGOING' end,
      case when v_type = 'SALE' then v_doc_id else null end,
      case when v_type = 'PURCHASE' then v_doc_id else null end,
      v_party,
      'POSTED', nullif(v_notes, ''), v_journal_id, v_uid,
      v_key, nullif(v_requested_ref, '')
    ) returning * into v_payment;

    v_created := true;
  exception when unique_violation then
    -- Can only be the idempotency index losing a race (the reference and the
    -- sequence are allocated under the advisory lock). Resolve it into the same
    -- deterministic replay-or-conflict decision as the lookup above.
    if v_key is not null then
      select * into v_existing
        from public.payments
       where business_id = p_business_id and idempotency_key = v_key;
    end if;

    if v_existing.id is null then
      raise;
    end if;
  end;

  if not v_created and v_existing.id is not null then
    v_incoming_fp := md5(concat_ws('|',
      v_type,
      v_doc_id::text,
      v_amount::numeric(14,2)::text,
      v_method,
      v_date::text,
      v_notes,
      v_requested_ref
    ));

    v_stored_fp := md5(concat_ws('|',
      case when v_existing.linked_sale_id is not null then 'SALE' else 'PURCHASE' end,
      coalesce(v_existing.linked_sale_id, v_existing.linked_purchase_id)::text,
      round(v_existing.amount, 2)::numeric(14,2)::text,
      v_existing.payment_method,
      v_existing.date::text,
      btrim(coalesce(v_existing.notes, '')),
      coalesce(v_existing.requested_reference, '')
    ));

    if v_incoming_fp is distinct from v_stored_fp then
      raise exception 'Idempotency key was already used with a different settlement request'
        using errcode = '23505';
    end if;

    return jsonb_build_object(
      'payment', to_jsonb(v_existing),
      'document', case
        when v_existing.linked_sale_id is not null then (
          select to_jsonb(d) from public.sales d
           where d.business_id = p_business_id and d.id = v_existing.linked_sale_id
        )
        else (
          select to_jsonb(d) from public.purchases d
           where d.business_id = p_business_id and d.id = v_existing.linked_purchase_id
        )
      end,
      'journal_entry', (
        select to_jsonb(je) from public.journal_entries je where je.id = v_existing.journal_entry_id
      ),
      'journal_lines', (
        select jsonb_agg(to_jsonb(jl) order by jl.line_no)
          from public.journal_lines jl
         where jl.journal_entry_id = v_existing.journal_entry_id
      )
    );
  end if;
  end;

  -- -------------------------------------------------------------------------
  -- 12. Return persisted rows, never incoming values
  -- -------------------------------------------------------------------------
  return jsonb_build_object(
    'payment', to_jsonb(v_payment),
    'document', case
      when v_type = 'SALE' then (
        select to_jsonb(d) from public.sales d
         where d.business_id = p_business_id and d.id = v_doc_id
      )
      else (
        select to_jsonb(d) from public.purchases d
         where d.business_id = p_business_id and d.id = v_doc_id
      )
    end,
    'journal_entry', to_jsonb(v_journal_entry),
    'journal_lines', (
      select jsonb_agg(to_jsonb(jl) order by jl.line_no)
        from public.journal_lines jl
       where jl.journal_entry_id = v_journal_id
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------------
revoke all on function public.post_payment(
  uuid, text, uuid, numeric, text, date, text, text, text
) from public, anon, authenticated;

grant execute on function public.post_payment(
  uuid, text, uuid, numeric, text, date, text, text, text
) to authenticated;

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
         and p.proname not in ('is_member', 'can_write', 'is_owner', 'create_business', 'post_sale', 'post_purchase', 'post_expense', 'void_document', 'post_payment')
       )
     );
  if v_bad is not null then
    raise exception 'Unexpected EXECUTE privilege on: %', v_bad;
  end if;
end $$;
