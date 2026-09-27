-- ============================================================================
-- 011_gateway_initiation.sql
-- Gateway transactions, part 1 of 2: server-authoritative initiation and the
-- shared settlement core that post_payment() and settle_gateway_txn() (012)
-- both use, so a settlement has exactly ONE accounting implementation.
--
-- Architecture boundary this file exists to enforce
--   * gateway_transactions = the provider interaction and its verification
--     state. A row becoming COMPLETED means the GATEWAY confirmed the money
--     moved; it does NOT mean anything was posted to the books.
--   * payments = the actual accounting settlement. Only settle_gateway_txn
--     (012) creates one, and only through post_settlement_core below.
--   * journal_entries/journal_lines = accounting truth.
--   * reconcile() in posting.ts stays the single derivation of paid/due/status:
--     the gateway layer stores no paid, due or status on the document.
--
-- Lifecycle (justified by the schema 001 already ships)
--   verification state — gateway_transactions.status, exactly the seven values
--   the provider adapters already map onto (INITIATED, PENDING, COMPLETED,
--   FAILED, EXPIRED, REFUNDED, CANCELED) plus:
--     verified_at              set once, only by a server-side verification
--     gateway_transaction_id   the provider's own transaction id, write-once
--   settlement state — DERIVED, never stored twice:
--     public.gateway_settlement_state(payment_id) is UNSETTLED (no payment),
--     SETTLED (payment present and POSTED) or VOIDED (payment voided). The
--     linkage columns 001 already provides are the truth: payments.
--     gateway_transaction_id (unique per business) and gateway_transactions.
--     payment_id (unique, one settlement per attempt).
--
-- Threat model (assumed hostile: the browser, the callback URL, its query
-- parameters and any client payload)
--   * No client role holds INSERT/UPDATE/DELETE on gateway_transactions or
--     payments (001/002). Both paths go through SECURITY DEFINER RPCs.
--   * initiate_gateway_txn takes a gateway reference from the caller, but never
--     treats it as proof of anything: it only records that a collection was
--     started. Settlement re-validates provider, reference, amount and currency
--     against the persisted row, so a fabricated reference is worthless.
--   * The lock + unique indexes make one collection yield at most one payment,
--     whatever the caller retries.
--
-- Rules every RPC in this project follows
--   * SECURITY DEFINER with search_path = '' and fully qualified names
--   * identity comes from auth.uid(); no user id or role is ever a parameter
--   * EXECUTE revoked from public, anon, then granted only to authenticated
--   * callers must be OWNER or ACCOUNTANT of the target business
--   * additive changes only; a breaking change ships as <name>_v2
--
-- Why post_payment is redefined here (012 header repeats this): it must accept
-- the gateway link at INSERT time — payments_guard_update (001) allows only
-- doc_status to change afterwards, so a payment can never be linked later. The
-- signature, the defaults, the grants, the validation, the idempotency replay
-- and the error messages are unchanged; only the write block moved into
-- post_settlement_core so there is one copy of the accounting instead of two.
-- supabase/tests/database/009_post_payment.test.sql and
-- 011_post_payment_concurrency.test.sql pin that behaviour and must keep
-- passing untouched.
-- ============================================================================

-- ============================================================================
-- Schema additions (additive only; every existing constraint is kept)
-- ============================================================================

-- Providers settle in NPR. Stored rather than assumed so settlement can
-- validate the currency the gateway answered with instead of trusting it.
alter table public.gateway_transactions add column currency text not null default 'NPR';
-- Set once, by a server-side verification that actually reached the provider.
alter table public.gateway_transactions add column verified_at timestamptz;
-- Who started the collection. auth.uid() at initiation, never a parameter.
alter table public.gateway_transactions add column initiated_by uuid
  references public.profiles (id) on delete restrict;

alter table public.gateway_transactions
  add constraint gateway_transactions_currency_shape
  check (currency = upper(currency) and length(currency) = 3);

-- One provider transaction id can only ever belong to one collection, globally:
-- the same answer cannot be recorded against two rows, in this business or any
-- other. payments_gateway_txn_uidx (001) is the same rule for the settled side.
create unique index gateway_transactions_provider_txn_uidx
  on public.gateway_transactions (provider, gateway_transaction_id)
  where gateway_transaction_id is not null;

create index gateway_transactions_sale_idx
  on public.gateway_transactions (business_id, linked_sale_id)
  where linked_sale_id is not null;

-- ============================================================================
-- Immutability: append-only financial history with a closed transition set
-- ============================================================================

-- Column-level, like guard_document_update (001): every column except the six
-- that describe verification and settlement progress is frozen, and the
-- transitions those six may make are enumerated. Enforced for every role,
-- including service_role, so the rule does not depend on this RPC being used.
create or replace function public.guard_gateway_txn_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array[
    'status', 'gateway_transaction_id', 'payment_id', 'settled_at', 'last_error', 'verified_at'
  ];
begin
  if tg_op = 'INSERT' then
    -- A row is born INITIATED, unverified and unsettled. Nothing can be
    -- inserted already claiming that money arrived.
    if new.status <> 'INITIATED'
       or new.verified_at is not null
       or new.gateway_transaction_id is not null
       or new.payment_id is not null
       or new.settled_at is not null then
      raise exception 'A gateway transaction starts INITIATED, unverified and unsettled'
        using errcode = 'restrict_violation';
    end if;
    if new.initiated_by is null then
      raise exception 'A gateway transaction must record who initiated it'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  -- UPDATE: the immutable half of the row (business, provider, reference,
  -- amount, currency, linked sale, customer, initiated_at) never moves.
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'Gateway transactions are append-only except for verification and settlement state'
      using errcode = 'restrict_violation';
  end if;

  if old.gateway_transaction_id is not null
     and new.gateway_transaction_id is distinct from old.gateway_transaction_id then
    raise exception 'The provider transaction id of gateway transaction % is already recorded', old.id
      using errcode = 'restrict_violation';
  end if;

  if old.verified_at is not null and new.verified_at is distinct from old.verified_at then
    raise exception 'The verification of gateway transaction % is already recorded', old.id
      using errcode = 'restrict_violation';
  end if;

  if old.payment_id is not null and new.payment_id is distinct from old.payment_id then
    raise exception 'Gateway transaction % is already settled; its settlement cannot be moved', old.id
      using errcode = 'restrict_violation';
  end if;

  if old.status = 'REFUNDED' and new.status <> old.status then
    raise exception 'A refunded gateway transaction cannot change status'
      using errcode = 'restrict_violation';
  end if;

  if old.status = 'COMPLETED' and new.status <> 'COMPLETED' then
    raise exception 'A verified gateway transaction cannot be un-verified'
      using errcode = 'restrict_violation';
  end if;

  if new.status = 'COMPLETED'
     and (new.verified_at is null or new.gateway_transaction_id is null) then
    raise exception 'A gateway transaction can only be COMPLETED with a recorded server-side verification'
      using errcode = 'restrict_violation';
  end if;

  return new;
end $$;

create trigger gateway_transactions_guard_write
  before insert or update on public.gateway_transactions
  for each row execute function public.guard_gateway_txn_write();

revoke all on function public.guard_gateway_txn_write() from public, anon, authenticated;

-- ============================================================================
-- Derived settlement state — one definition, used by both RPCs
-- ============================================================================

create or replace function public.gateway_settlement_state(p_payment_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when p_payment_id is null then 'UNSETTLED'
    when exists (
      select 1 from public.payments p
       where p.id = p_payment_id and p.doc_status = 'VOIDED'
    ) then 'VOIDED'
    else 'SETTLED'
  end;
$$;

revoke all on function public.gateway_settlement_state(uuid) from public, anon, authenticated;

-- ============================================================================
-- post_settlement_core — the single settlement write path
-- ============================================================================
-- Internal: never granted to a client role. Called by post_payment (below) and
-- by settle_gateway_txn (012) inside their own SECURITY DEFINER context, after
-- they have validated the request, locked the document and recomputed the
-- outstanding balance from the persisted sub-ledger.
--
-- It owns everything that makes a settlement a settlement, unchanged from 009:
--   * one transaction-scoped advisory lock per business, so reference
--     allocation and the journal sequence cannot collide;
--   * the reference (the caller's own, or RCP-/PAY-YYYYMMDD-NNN);
--   * the settlement asset account (mirrors AccountLookup.settlement);
--   * exactly one PAYMENT journal entry with exactly two balanced lines, in
--     buildPaymentEntry order, retrying under a savepoint on a sequence clash;
--   * exactly one payments row, which now may carry the provider's own
--     transaction id (001's payments.gateway_transaction_id).
--
-- p_gateway_transaction_id is the ONLY behavioural difference between a manual
-- and a gateway settlement: it is written on the row at insert time because
-- payments_guard_update (001) freezes every other column afterwards. Accounting
-- direction, accounts, description, reference, source_type and source_id are
-- all derived here, so a gateway settlement cannot be posted with different
-- semantics from a manual one.
create or replace function public.post_settlement_core(
  p_business_id            uuid,
  p_document_type          text,    -- 'SALE' (money in) or 'PURCHASE' (money out)
  p_document_id            uuid,
  p_party                  text,    -- snapshot read from the LOCKED document
  p_amount                 numeric,
  p_payment_method         text,
  p_date                   date,
  p_notes                  text,
  p_requested_reference    text,
  p_idempotency_key        text,
  p_gateway_transaction_id text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid          uuid := (select auth.uid());
  v_type         text := upper(btrim(coalesce(p_document_type, '')));
  v_method       text := upper(btrim(coalesce(p_payment_method, '')));
  v_settle_code  text;
  v_acc_settle   public.accounts%rowtype;
  v_acc_counter  public.accounts%rowtype;
  v_counter_code text;
  v_payment      public.payments%rowtype;
  v_journal      public.journal_entries%rowtype;
  v_reference    text;
  v_sequence     bigint;
  v_journal_id   uuid;
  v_payment_id   uuid;
  v_line_idx     smallint := 1;
  v_attempt      int;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_business_id is null or p_document_id is null then
    raise exception 'A settlement needs a business and a document' using errcode = '22023';
  end if;

  if v_type not in ('SALE', 'PURCHASE') then
    raise exception 'post_settlement_core only settles SALE and PURCHASE documents'
      using errcode = '22023';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero' using errcode = '22023';
  end if;

  -- One transaction-scoped lock per business serialises concurrent posts so the
  -- journal sequence and any server-side reference cannot collide. Taken after
  -- the caller's document lock (documents first, always), so no lock order
  -- cycle exists with post_sale/post_purchase/post_expense/void_payment.
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text, 0));

  -- Reference: keep the caller's number when supplied; otherwise allocate
  -- RCP-YYYYMMDD-NNN (money in) or PAY-YYYYMMDD-NNN (money out), the same
  -- formats referenceGenerator used, scoped to this business.
  v_reference := btrim(coalesce(p_requested_reference, ''));
  if v_reference = '' then
    declare
      v_kind   text := case when v_type = 'SALE' then 'RCP' else 'PAY' end;
      v_prefix text := v_kind || '-' || to_char(p_date, 'YYYYMMDD') || '-';
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
  else
    raise exception 'Invalid payment method: %', p_payment_method using errcode = '22023';
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
        v_journal_id, p_business_id, p_date, v_sequence,
        case when v_type = 'SALE' then 'Settlement from ' else 'Settlement to ' end || p_party,
        v_reference, 'PAYMENT', v_payment_id, v_uid
      ) returning * into v_journal;

      -- Lines in buildPaymentEntry order: money in debits the settlement
      -- account first, money out debits the payable first.
      if v_type = 'SALE' then
        insert into public.journal_lines (
          business_id, journal_entry_id, line_no,
          account_id, account_name, account_type, debit, credit
        ) values (
          p_business_id, v_journal_id, v_line_idx,
          v_acc_settle.id, v_acc_settle.name, v_acc_settle.type, p_amount, 0
        );
        v_line_idx := v_line_idx + 1;

        insert into public.journal_lines (
          business_id, journal_entry_id, line_no,
          account_id, account_name, account_type, debit, credit
        ) values (
          p_business_id, v_journal_id, v_line_idx,
          v_acc_counter.id, v_acc_counter.name, v_acc_counter.type, 0, p_amount
        );
        v_line_idx := v_line_idx + 1;
      else
        insert into public.journal_lines (
          business_id, journal_entry_id, line_no,
          account_id, account_name, account_type, debit, credit
        ) values (
          p_business_id, v_journal_id, v_line_idx,
          v_acc_counter.id, v_acc_counter.name, v_acc_counter.type, p_amount, 0
        );
        v_line_idx := v_line_idx + 1;

        insert into public.journal_lines (
          business_id, journal_entry_id, line_no,
          account_id, account_name, account_type, debit, credit
        ) values (
          p_business_id, v_journal_id, v_line_idx,
          v_acc_settle.id, v_acc_settle.name, v_acc_settle.type, 0, p_amount
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
    gateway_transaction_id,
    doc_status, notes, journal_entry_id, created_by,
    idempotency_key, requested_reference
  ) values (
    v_payment_id, p_business_id, v_reference, p_date, p_amount, v_method, 'COMPLETED',
    case when v_type = 'SALE' then 'INCOMING' else 'OUTGOING' end,
    case when v_type = 'SALE' then p_document_id else null end,
    case when v_type = 'PURCHASE' then p_document_id else null end,
    p_party,
    p_gateway_transaction_id,
    'POSTED', nullif(p_notes, ''), v_journal_id, v_uid,
    p_idempotency_key, nullif(btrim(coalesce(p_requested_reference, '')), '')
  ) returning * into v_payment;

  
  return jsonb_build_object(
    'payment', to_jsonb(v_payment),
    'journal_entry', to_jsonb(v_journal),
    'journal_lines', (
      select jsonb_agg(to_jsonb(jl) order by jl.line_no)
        from public.journal_lines jl
       where jl.journal_entry_id = v_journal_id
    )
  );
end $$;

revoke all on function public.post_settlement_core(
  uuid, text, uuid, text, numeric, text, date, text, text, text, text
) from public, anon, authenticated;

-- ============================================================================
-- post_payment — redefined to delegate its write block to the core
-- ============================================================================
-- Byte-for-byte the same contract as 009: same signature, same defaults, same
-- validation, same idempotency fingerprint, same error messages, same returned
-- rows. Only section 11 changed — it now calls post_settlement_core instead of
-- repeating the write block, so the manual and gateway paths cannot drift.
-- The gateway link is passed as NULL here: a manual settlement never claims a
-- provider transaction.
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
  v_payment        public.payments%rowtype;
  v_existing       public.payments%rowtype;
  v_journal_entry  public.journal_entries%rowtype;
  v_requested_ref  text;
  v_key            text;
  v_notes          text;
  v_amount         numeric(14,2);
  v_settled        numeric(14,2);
  v_due            numeric(14,2);
  v_today          date;
  v_date           date;
  v_journal_id     uuid;
  v_payment_id     uuid;
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
  -- 11. Creation (serialised per business) — the one settlement write path
  -- -------------------------------------------------------------------------
  declare
    v_created boolean := false;
    v_created_payload jsonb;
  begin
  begin
    v_created_payload := public.post_settlement_core(
      p_business_id, v_type, v_doc_id, v_party, v_amount, v_method, v_date,
      v_notes, v_requested_ref, v_key, null
    );

    -- Read the persisted rows back rather than echoing the payload.
    v_payment_id := (v_created_payload->'payment'->>'id')::uuid;
    select * into v_payment
      from public.payments p where p.id = v_payment_id;
    select * into v_journal_entry
      from public.journal_entries je where je.id = v_payment.journal_entry_id;
    v_journal_id := v_journal_entry.id;

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

-- ============================================================================
-- initiate_gateway_txn — start a collection, server-side
-- ============================================================================
-- The browser never writes a gateway row itself: authenticated holds no INSERT
-- on gateway_transactions (001/002), so this RPC is the only way one exists.
--
-- What it is NOT: proof that anyone paid. It records that a collection was
-- started against a POSTED sale the caller is allowed to write to, with an
-- amount that invoice can still take. The reference is whatever the provider
-- handed the server, and it is treated as an identifier, never as evidence.
--
-- Why the document is mandatory: post_payment (and therefore 012) can only post
-- money against a document, so a collection with nothing to settle against
-- could never reach the books. Refusing it here is the honest answer, and it
-- also means the amount is validated against the invoice's real outstanding
-- balance at the moment the person clicks "collect", not later.
--
-- Why open collections are NOT reserved against the balance: two INITIATED
-- collections on one invoice can coexist, and only a settlement consumes the
-- balance. The second settlement is rejected as over-settlement by 012 —
-- deterministic, and it needs no reservation table to stay safe.
--
-- Idempotency: (provider, gateway_ref) is globally unique (001) and is now also
-- unique for provider transaction ids. A retry with the identical request
-- replays the persisted row read-only; the same reference with a different
-- amount, sale or currency in the same business is refused (23505); a reference
-- that belongs to somebody else is refused with a message that names nothing.
create or replace function public.initiate_gateway_txn(
  p_business_id    uuid,
  p_provider       text,
  p_gateway_ref    text,
  p_amount         numeric,
  p_linked_sale_id uuid,
  p_customer_name  text default '',
  p_currency       text default 'NPR'
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid          uuid := (select auth.uid());
  v_business     public.businesses%rowtype;
  v_provider     text;
  v_ref          text;
  v_currency     text;
  v_amount       numeric(14,2);
  v_sale         public.sales%rowtype;
  v_settled      numeric(14,2);
  v_due          numeric(14,2);
  v_customer     text;
  v_txn          public.gateway_transactions%rowtype;
  v_existing     public.gateway_transactions%rowtype;
  v_check_label  text;
  v_check_value  numeric;
  v_attempt      int;
  v_replayed     boolean := false;
  v_sale_locked  boolean := false;
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
  -- 2. Business profile (its currency decides what may be collected)
  -- -------------------------------------------------------------------------
  select * into v_business from public.businesses where id = p_business_id;
  if not found then
    raise exception 'Business not found' using errcode = '22023';
  end if;

  v_currency := upper(btrim(coalesce(p_currency, '')));
  if v_currency = '' then
    v_currency := 'NPR';
  end if;

  -- eSewa and Khalti both settle in NPR only, and the books have to agree.
  if v_currency <> 'NPR' then
    raise exception 'Gateway collections are only available in NPR (asked for %)', v_currency
      using errcode = '22023';
  end if;

  -- Compared against the currency itself, NOT currency_symbol: the symbol is a
  -- display choice ('NPR' or 'रू', both constrained in 001) while `currency` is
  -- the unit the books are kept in.
  if upper(btrim(coalesce(v_business.currency, 'NPR'))) <> 'NPR' then
    raise exception 'This business keeps its books in %, so it cannot collect in NPR',
      v_business.currency
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Provider
  -- -------------------------------------------------------------------------
  v_provider := upper(btrim(coalesce(p_provider, '')));
  if v_provider not in ('ESEWA', 'KHALTI') then
    raise exception 'Unsupported payment provider: %', p_provider using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Gateway reference (the provider's identifier for this attempt)
  -- -------------------------------------------------------------------------
  v_ref := btrim(coalesce(p_gateway_ref, ''));
  if v_ref = '' then
    raise exception 'A gateway reference is required' using errcode = '22023';
  end if;
  if length(v_ref) > 200 then
    raise exception 'Gateway reference is too long (max 200 characters)' using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Amount
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
  -- 6. Identity before money. A reference this provider already handed out IS
  --    this collection, so the lookup comes first and a retry replays it
  --    read-only — before any financial check runs. That ordering matters: by
  --    the time a person reloads and retries, the collection may already have
  --    settled its invoice, and "amount exceeds the outstanding balance" would
  --    be a confusing answer to a request that never intended a new charge.
  --    Only a reference nobody has seen reaches the document rules below.
  --    The lock order is documents-first (the sale is locked here, then the row
  --    is inserted), matching post_payment and settle_gateway_txn.
  -- -------------------------------------------------------------------------
  v_attempt := 0;
  loop
    v_attempt := v_attempt + 1;

    select * into v_existing
      from public.gateway_transactions g
     where g.provider = v_provider and g.gateway_ref = v_ref;

    if v_existing.id is not null then
      if v_existing.business_id = p_business_id
         and round(v_existing.amount, 2) = v_amount
         and v_existing.currency = v_currency
         and v_existing.linked_sale_id = p_linked_sale_id then
        -- The identical request, already recorded: replay it read-only.
        v_txn := v_existing;
        v_replayed := true;
        exit;
      elsif v_existing.business_id = p_business_id then
        raise exception 'Gateway reference % is already used by a different collection in this business',
          v_ref
          using errcode = '23505';
      else
        -- Names nothing about the other business: existence is not disclosed.
        raise exception 'This gateway reference is already in use' using errcode = '23505';
      end if;
    end if;

    if not v_sale_locked then
      -- Resolve and LOCK the sale. A missing row covers: unknown id, another
      -- tenant's id and a malformed id — one message, nothing leaks.
      if p_linked_sale_id is null then
        raise exception 'An online collection must be linked to an invoice, so it can be posted to the books'
          using errcode = '22023';
      end if;

      select * into v_sale
        from public.sales s
       where s.business_id = p_business_id and s.id = p_linked_sale_id
         for update;

      if v_sale.id is null then
        raise exception 'Sale not found in this business' using errcode = '22023';
      end if;

      if v_sale.status = 'VOIDED' then
        raise exception 'Invoice % is voided and cannot be collected against', v_sale.invoice_number
          using errcode = '22023';
      end if;

      if v_sale.journal_entry_id is null then
        raise exception 'The journal entry for this invoice is missing' using errcode = '23514';
      end if;

      if not exists (
        select 1 from public.journal_entries je
         where je.business_id = p_business_id
           and je.id = v_sale.journal_entry_id
           and je.source_type = 'SALE'
           and je.source_id = v_sale.id
      ) then
        raise exception 'The invoice''s journal entry does not belong to it (source mismatch)'
          using errcode = '23514';
      end if;

      -- The outstanding balance, recomputed from the persisted sub-ledger under
      -- the document lock. Never a client-supplied figure.
      select coalesce(sum(p.amount), 0) into v_settled
        from public.payments p
       where p.business_id = p_business_id
         and p.linked_sale_id = v_sale.id
         and p.status = 'COMPLETED'
         and p.doc_status = 'POSTED';

      v_due := round(v_sale.total_amount - v_settled, 2);

      if v_due <= 0.005 then
        raise exception 'Invoice % has no outstanding balance (total %, already settled %)',
          v_sale.invoice_number, v_sale.total_amount, v_settled
          using errcode = '22023';
      end if;

      if v_amount > v_due + 0.005 then
        raise exception 'Amount % exceeds the outstanding balance of % on invoice %',
          v_amount, v_due, v_sale.invoice_number
          using errcode = '22023';
      end if;

      v_customer := coalesce(nullif(btrim(coalesce(p_customer_name, '')), ''), v_sale.customer_name, '');
      v_sale_locked := true;
    end if;

    -- 7. Insert. The unique index on (provider, gateway_ref) is the decider, so
    --    the loser of a concurrent double-initiation re-reads and replays
    --    instead of inserting a second row.
    begin
      insert into public.gateway_transactions (
        business_id, provider, gateway_ref, amount, currency,
        status, linked_sale_id, customer_name, initiated_by
      ) values (
        p_business_id, v_provider, v_ref, v_amount, v_currency,
        'INITIATED', v_sale.id, v_customer, v_uid
      ) returning * into v_txn;

      exit;
    exception when unique_violation then
      if v_attempt >= 3 then
        raise;
      end if;
    end;
  end loop;

  -- -------------------------------------------------------------------------
  -- 8. Return the persisted row, never an echo of the request
  -- -------------------------------------------------------------------------
  return jsonb_build_object(
    'gateway_transaction', to_jsonb(v_txn),
    'document', (
      select to_jsonb(s) from public.sales s
       where s.business_id = p_business_id and s.id = v_txn.linked_sale_id
    ),
    'settlement_state', public.gateway_settlement_state(v_txn.payment_id),
    'replayed', v_replayed
  );
end $$;

-- ---------------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------------
revoke all on function public.initiate_gateway_txn(
  uuid, text, text, numeric, uuid, text, text
) from public, anon, authenticated;

grant execute on function public.initiate_gateway_txn(
  uuid, text, text, numeric, uuid, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Safety net: function privileges (restated, with the two new entry points)
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
         and p.proname not in ('is_member', 'can_write', 'is_owner', 'create_business', 'post_sale', 'post_purchase', 'post_expense', 'void_document', 'post_payment', 'void_payment', 'initiate_gateway_txn', 'settle_gateway_txn')
       )
     );
  if v_bad is not null then
    raise exception 'Unexpected EXECUTE privilege on: %', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Safety net: the browser can never write a financial row directly
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(x.tbl || ' (' || x.priv || ')', ', ') into v_bad
    from (values
      ('payments', 'INSERT'), ('payments', 'UPDATE'), ('payments', 'DELETE'),
      ('gateway_transactions', 'INSERT'), ('gateway_transactions', 'UPDATE'),
      ('gateway_transactions', 'DELETE'),
      ('journal_entries', 'INSERT'), ('journal_entries', 'UPDATE'),
      ('journal_lines', 'INSERT'), ('journal_lines', 'UPDATE')
    ) as x(tbl, priv)
   where has_table_privilege('authenticated', ('public.' || x.tbl)::regclass, x.priv);
  if v_bad is not null then
    raise exception 'authenticated holds a direct write privilege on: %', v_bad;
  end if;

  select string_agg(c.relname, ', ') into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'anon holds a table privilege on: %', v_bad;
  end if;

  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.gateway_transactions'::regclass
       and t.tgname = 'gateway_transactions_guard_write'
  ) then
    raise exception 'The gateway transaction write guard is missing';
  end if;

  if not exists (
    select 1 from pg_indexes i
     where i.schemaname = 'public'
       and i.indexname = 'gateway_transactions_provider_txn_uidx'
  ) then
    raise exception 'The provider transaction id uniqueness index is missing';
  end if;
end $$;

