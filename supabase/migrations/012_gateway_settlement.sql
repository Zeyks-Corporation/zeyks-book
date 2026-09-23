-- ============================================================================
-- 012_gateway_settlement.sql
-- Gateway transactions, part 2 of 2: settle_gateway_txn — the ONLY way a
-- collection becomes money on the books.
--
-- Architecture boundary (same as 011): a gateway transaction that says the
-- vendor paid is a provider fact, not an accounting fact. This RPC is the
-- bridge, and it is the only thing that may cross it. It creates exactly one
-- payments row and exactly one PAYMENT journal entry through
-- post_settlement_core (011) — the same code path post_payment uses — or it
-- writes no financial row at all.
--
-- The one internal result shape (produced by the provider adapters in
-- server/*.js, never assembled by React):
--   {
--     "provider":               "ESEWA" | "KHALTI",
--     "verified":               boolean,   -- the SERVER reached the gateway
--     "status":                 "PENDING" | "COMPLETED" | "FAILED" | "EXPIRED"
--                             | "CANCELED" | "REFUNDED" | "INITIATED",
--     "gateway_transaction_id": "…",       -- provider's own transaction id
--     "amount":                 1000.00,   -- what the provider says it took
--     "currency":               "NPR",
--     "reference":              "…",       -- the gateway_ref this collection was started with
--     "detail":                 "…"        -- optional provider text for last_error
--   }
-- Every field is re-validated here against the persisted gateway_transactions
-- row: the payload is data, not authority. A payload that contradicts the row
-- (other provider, other reference, other amount, other currency) is refused
-- and nothing is written. A payload that is structurally malformed is refused as
-- 22023 — it is a bug in the caller, not a payment outcome.
--
-- What the browser cannot do
--   * mark a row COMPLETED/SETTLED by writing it: authenticated holds no
--     INSERT/UPDATE on gateway_transactions or payments (001/002; asserted again
--     at the end of 011), and the write guard (011) refuses an update that
--     claims COMPLETED without a recorded verification.
--   * settle more than the invoice owes, or settle a VOIDED invoice, or settle
--     the same collection twice: the balance is recomputed here from the
--     persisted payments sub-ledger, and the linkage columns are unique.
--   * settle against a document of its choosing: the document is the one the
--     collection was initiated against, read from the row — not a parameter.
--
-- Outcome contract (jsonb, never an exception, for provider outcomes)
--   outcome = 'SETTLED'        this call created the payment (payment, document,
--                              journal_entry, journal_lines are persisted rows)
--   outcome = 'ALREADY_SETTLED' a settlement already exists for this collection
--                              (including one that was later voided: nothing is
--                              revived and nothing is reposted)
--   outcome = 'NOT_VERIFIED'   the gateway did not confirm the payment; the
--                              provider's answer is recorded on the row and no
--                              financial row is written
-- Errors (exceptions) are reserved for requests that are themselves invalid or
-- for states that must never be silently accepted.
--
-- Accounting semantics — identical to post_payment by construction, because it
-- is literally the same function:
--   Dr settlement account (1010/1020/1040/1050 by provider)   amount
--       Cr Accounts receivable (1030)                          amount
--   description 'Settlement from <customer>', source_type PAYMENT,
--   source_id = the new payment's id, reference RCP-YYYYMMDD-NNN.
--
-- Concurrency (proved in 015_gateway_concurrency.test.sql with a second real
-- session, the method 010/011/013 established)
--   * the collection row is locked FOR UPDATE, so two settlement attempts on one
--     collection serialise: the loser finds payment_id set and replays;
--   * the document lock is taken BEFORE the collection lock, the same order
--     initiate_gateway_txn takes (documents first, always), so no cycle exists
--     with post_payment, void_document or void_payment;
--   * racing a manual settlement or a void on the same invoice is safe: the
--     loser recomputes the outstanding balance under the document lock and is
--     rejected as over-settlement, or replays if it is the same collection.
--
-- Not here (deliberately deferred): refunds and refund state transitions,
-- chargebacks, payout reconciliation, gateway webhooks, and any provider call —
-- this RPC never talks to a gateway, it only decides what a verified answer may
-- post to the books.
-- ============================================================================

-- ============================================================================
-- settle_gateway_txn
-- ============================================================================

create or replace function public.settle_gateway_txn(
  p_business_id    uuid,
  p_gateway_txn_id uuid,
  p_verification   jsonb,
  p_date           date default null,
  p_notes          text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid          uuid := (select auth.uid());
  v_business     public.businesses%rowtype;
  v_txn          public.gateway_transactions%rowtype;
  v_sale         public.sales%rowtype;
  v_provider     text;
  v_status       text;
  v_verified     boolean;
  v_raw_amount   text;
  v_amount       numeric(14,2);
  v_currency     text;
  v_ref          text;
  v_provider_ref text;
  v_payment      public.payments%rowtype;
  v_journal      public.journal_entries%rowtype;
  v_notes        text;
  v_today        date;
  v_date         date;
  v_settled      numeric(14,2);
  v_due          numeric(14,2);
  v_payload      jsonb;
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
  -- 3. Which collection — and which document it belongs to.
  --    Read unlocked first, only to learn the sale to lock: the authoritative
  --    read is the FOR UPDATE below, after the document lock, so the lock order
  --    stays documents-first and the row cannot change underneath us (every
  --    column that identifies it is frozen by 011's write guard).
  -- -------------------------------------------------------------------------
  if p_gateway_txn_id is null then
    raise exception 'A gateway transaction id is required' using errcode = '22023';
  end if;

  select * into v_txn
    from public.gateway_transactions g
   where g.business_id = p_business_id and g.id = p_gateway_txn_id;

  if v_txn.id is null then
    -- Covers: unknown id, malformed id and another tenant's row. One message,
    -- nothing leaks.
    raise exception 'Gateway transaction not found in this business' using errcode = '22023';
  end if;

  if v_txn.linked_sale_id is not null then
    select * into v_sale
      from public.sales s
     where s.business_id = p_business_id and s.id = v_txn.linked_sale_id
       for update;
  end if;

  select * into v_txn
    from public.gateway_transactions g
   where g.business_id = p_business_id and g.id = p_gateway_txn_id
     for update;

  if v_txn.linked_sale_id is not null and v_sale.id is null then
    raise exception 'The invoice this collection belongs to is missing' using errcode = '23514';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Validate the verification payload — structure first, so a malformed
  --    response is a caller bug (22023) and never a silent no-op.
  -- -------------------------------------------------------------------------
  -- `is distinct from`, not `<>`: a MISSING key yields SQL NULL, and a NULL
  -- comparison would be NULL rather than true, silently skipping the guard.
  if jsonb_typeof(p_verification) is distinct from 'object' then
    raise exception 'Malformed gateway verification payload: expected an object'
      using errcode = '22023';
  end if;

  v_provider := upper(btrim(coalesce(p_verification->>'provider', '')));
  if v_provider not in ('ESEWA', 'KHALTI') then
    raise exception 'Malformed gateway verification payload: unknown provider %',
      coalesce(p_verification->>'provider', '<missing>')
      using errcode = '22023';
  end if;

  if v_provider <> v_txn.provider then
    raise exception 'Verification is for provider % but this collection is %', v_provider, v_txn.provider
      using errcode = '22023';
  end if;

  v_status := upper(btrim(coalesce(p_verification->>'status', '')));
  if v_status not in ('INITIATED', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED', 'CANCELED') then
    raise exception 'Malformed gateway verification payload: unknown status %',
      coalesce(p_verification->>'status', '<missing>')
      using errcode = '22023';
  end if;

  -- Strict boolean: a JSON string "true"/"false" is accepted, anything else
  -- is malformed rather than silently read as a verdict.
  if jsonb_typeof(p_verification->'verified') is distinct from 'boolean' then
    raise exception 'Malformed gateway verification payload: verified must be a boolean'
      using errcode = '22023';
  end if;
  v_verified := (p_verification->>'verified')::boolean;

  -- A COMPLETED verification must be a verified one, and vice versa. This is
  -- what stops a payload from claiming success without saying it verified.
  if v_status = 'COMPLETED' and not v_verified then
    raise exception 'Malformed gateway verification payload: a COMPLETED status must be verified'
      using errcode = '22023';
  end if;
  if v_verified and v_status <> 'COMPLETED' then
    raise exception 'Malformed gateway verification payload: a verified result must be COMPLETED'
      using errcode = '22023';
  end if;

  v_raw_amount := btrim(coalesce(p_verification->>'amount', ''));
  if v_raw_amount = '' or v_raw_amount !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'Malformed gateway verification payload: amount must be a positive number'
      using errcode = '22023';
  end if;

  v_amount := round(v_raw_amount::numeric, 2);
  if v_amount <= 0 or v_amount > 999999999999.99 then
    raise exception 'Malformed gateway verification payload: amount % is out of range', v_raw_amount
      using errcode = '22023';
  end if;
  if v_amount <> v_raw_amount::numeric then
    raise exception 'Verified amount % has more precision than a settlement can hold', v_raw_amount
      using errcode = '22023';
  end if;

  v_currency := upper(btrim(coalesce(p_verification->>'currency', '')));
  if v_currency = '' then
    -- The adapters always send it; the row's own currency is the fallback.
    v_currency := v_txn.currency;
  end if;
  if v_currency <> v_txn.currency then
    raise exception 'The gateway confirmed % but this collection is recorded in %',
      v_currency, v_txn.currency
      using errcode = '22023';
  end if;
  if v_currency <> 'NPR' then
    raise exception 'Gateway collections are only available in NPR (gateway answered %)', v_currency
      using errcode = '22023';
  end if;

  -- Identity: a payload that names a different reference than the one this
  -- collection was started with is refused, whatever its other fields say.
  v_ref := btrim(coalesce(p_verification->>'reference', ''));
  if v_ref <> '' and v_ref <> v_txn.gateway_ref then
    raise exception 'Verification is for gateway reference % but this collection is %',
      v_ref, v_txn.gateway_ref
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Already settled? Deterministic replay — checked before anything can be
  --    written, and even a NOT_VERIFIED payload cannot unsettle it.
  -- -------------------------------------------------------------------------
  if v_txn.payment_id is not null then
    select * into v_payment
      from public.payments p
     where p.business_id = p_business_id and p.id = v_txn.payment_id;

    return jsonb_build_object(
      'outcome', 'ALREADY_SETTLED',
      'settled', true,
      'settlement_state', public.gateway_settlement_state(v_txn.payment_id),
      'reason', case
        when v_payment.doc_status = 'VOIDED'
          then 'The settlement for this collection was voided; take the money again with a new collection.'
        else 'This collection has already been settled.'
      end,
      'gateway_transaction', (select to_jsonb(g) from public.gateway_transactions g where g.id = v_txn.id),
      'payment', to_jsonb(v_payment),
      'document', (
        select to_jsonb(s) from public.sales s
         where s.business_id = p_business_id and s.id = v_txn.linked_sale_id
      ),
      'journal_entry', (
        select to_jsonb(je) from public.journal_entries je
         where je.business_id = p_business_id and je.id = v_payment.journal_entry_id
      ),
      'journal_lines', (
        select jsonb_agg(to_jsonb(jl) order by jl.line_no)
          from public.journal_lines jl
         where jl.journal_entry_id = v_payment.journal_entry_id
      )
    );
  end if;

  -- -------------------------------------------------------------------------
  -- 6. States that must never be silently accepted
  -- -------------------------------------------------------------------------
  if v_txn.status = 'COMPLETED' then
    -- Only reachable from a hand-built row: this RPC writes COMPLETED and the
    -- settlement in one transaction. Fail closed instead of posting again.
    raise exception 'Gateway transaction % is marked COMPLETED but has no settlement', v_txn.id
      using errcode = '23514';
  end if;

  if v_txn.status = 'REFUNDED' then
    raise exception 'Gateway transaction % was refunded and cannot be settled', v_txn.id
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 7. Not verified: record what the gateway said. No financial row.
  -- -------------------------------------------------------------------------
  if not v_verified then
    update public.gateway_transactions
       set status = v_status,
           last_error = nullif(left(btrim(coalesce(
             p_verification->>'detail', p_verification->>'raw_status', ''
           )), 500), '')
     where business_id = p_business_id and id = v_txn.id;

    return jsonb_build_object(
      'outcome', 'NOT_VERIFIED',
      'settled', false,
      'settlement_state', 'UNSETTLED',
      'reason', case v_status
        when 'PENDING' then 'The gateway has not finished this payment yet.'
        when 'CANCELED' then 'The customer canceled the payment at the gateway.'
        when 'EXPIRED' then 'The gateway expired this payment before it completed.'
        when 'REFUNDED' then 'The gateway reports this payment as refunded.'
        else 'The gateway did not confirm this payment.'
      end,
      'gateway_transaction', (select to_jsonb(g) from public.gateway_transactions g where g.id = v_txn.id),
      'payment', null,
      'document', (
        select to_jsonb(s) from public.sales s
         where s.business_id = p_business_id and s.id = v_txn.linked_sale_id
      ),
      'journal_entry', null,
      'journal_lines', null
    );
  end if;

  -- -------------------------------------------------------------------------
  -- 8. Verified. The provider's own transaction id is required and is
  --    write-once: a second, different id for the same collection is refused.
  -- -------------------------------------------------------------------------
  v_provider_ref := btrim(coalesce(p_verification->>'gateway_transaction_id', ''));
  if v_provider_ref = '' then
    raise exception 'Malformed gateway verification payload: a verified result must name the provider transaction id'
      using errcode = '22023';
  end if;
  if length(v_provider_ref) > 200 then
    raise exception 'Provider transaction id is too long (max 200 characters)' using errcode = '22023';
  end if;

  if v_txn.gateway_transaction_id is not null
     and v_txn.gateway_transaction_id <> v_provider_ref then
    raise exception 'Provider transaction id % does not match % already recorded for this collection',
      v_provider_ref, v_txn.gateway_transaction_id
      using errcode = '22023';
  end if;

  -- The amount the gateway confirmed must be the amount this collection was
  -- initiated for. Never the amount the caller asked for, and never a partial.
  if v_amount <> round(v_txn.amount, 2) then
    raise exception 'The gateway confirmed % but this collection was initiated for %',
      v_amount, round(v_txn.amount, 2)
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 9. Document rules — POSTED, own journal entry, recomputed balance
  -- -------------------------------------------------------------------------
  if v_txn.linked_sale_id is null then
    raise exception 'This collection is not linked to an invoice, so it has nothing to settle against'
      using errcode = '22023';
  end if;

  if v_sale.id is null then
    raise exception 'The invoice this collection belongs to is missing' using errcode = '23514';
  end if;

  if v_sale.status = 'VOIDED' then
    raise exception 'Invoice % is voided: the money must be collected against a new invoice',
      v_sale.invoice_number
      using errcode = '22023';
  end if;

  if v_sale.journal_entry_id is null then
    raise exception 'The journal entry for this invoice is missing' using errcode = '23514';
  end if;

  -- Fail closed on a hand-built inconsistent row (same rule as post_payment).
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

  -- Outstanding balance, recomputed from the persisted sub-ledger under the
  -- document lock: a client-supplied balance is never trusted, and a concurrent
  -- manual settlement or a void is already visible here.
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
    raise exception 'The confirmed amount % exceeds the outstanding balance of % on invoice %',
      v_amount, v_due, v_sale.invoice_number
      using errcode = '22023';
  end if;

  -- The provider transaction id is globally unique (011), and the settled side
  -- is unique per business (001): this is the backstop that turns any residual
  -- double-post into a deterministic refusal.
  if exists (
    select 1 from public.payments p
     where p.business_id = p_business_id and p.gateway_transaction_id = v_provider_ref
  ) then
    raise exception 'Provider transaction % has already been posted to a settlement in this business',
      v_provider_ref
      using errcode = '23505';
  end if;

  -- -------------------------------------------------------------------------
  -- 10. Date and notes — decided here, never by the caller's browser
  -- -------------------------------------------------------------------------
  v_today := (now() at time zone coalesce(v_business.timezone, 'Asia/Kathmandu'))::date;
  v_date  := coalesce(p_date, v_today);
  if v_date > v_today then
    raise exception 'Settlement date % cannot be in the future (today in % is %)',
      v_date, coalesce(v_business.timezone, 'Asia/Kathmandu'), v_today
      using errcode = '22023';
  end if;

  v_notes := btrim(coalesce(p_notes, ''));
  if v_notes = '' then
    v_notes := v_txn.provider || ' ref ' || v_provider_ref;
  end if;
  if length(v_notes) > 500 then
    raise exception 'Notes are too long (max 500 characters)' using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 11. Exactly one settlement, through the shared accounting core.
  --     The deterministic idempotency key makes the payments row itself a
  --     second guard: one collection can never produce two of them.
  -- -------------------------------------------------------------------------
  begin
    v_payload := public.post_settlement_core(
      p_business_id,
      'SALE',
      v_sale.id,
      v_sale.customer_name,
      v_amount,
      v_txn.provider,          -- ESEWA/KHALTI: the method is the provider
      v_date,
      v_notes,
      '',                      -- the server allocates RCP-YYYYMMDD-NNN
      'gw:' || v_txn.id::text,
      v_provider_ref
    );
  exception when unique_violation then
    if sqlerrm like '%payments_gateway_txn_uidx%'
       or sqlerrm like '%payments_business_idempotency_uidx%'
       or sqlerrm like '%gateway_transactions%' then
      raise exception 'Provider transaction % has already been posted to a settlement in this business',
        v_provider_ref
        using errcode = '23505';
    end if;
    -- Anything else is a transient journal-sequence clash: let the caller retry.
    raise;
  end;

  select * into v_payment
    from public.payments p where p.id = (v_payload->'payment'->>'id')::uuid;
  select * into v_journal
    from public.journal_entries je where je.id = v_payment.journal_entry_id;

  -- -------------------------------------------------------------------------
  -- 12. Link and mark — one transaction. The row is already locked, so this
  --     cannot race with a second settlement of the same collection.
  -- -------------------------------------------------------------------------
  update public.gateway_transactions
     set status = 'COMPLETED',
         gateway_transaction_id = v_provider_ref,
         payment_id = v_payment.id,
         settled_at = now(),
         verified_at = now(),
         last_error = null
   where business_id = p_business_id and id = v_txn.id;

  -- -------------------------------------------------------------------------
  -- 13. Return persisted rows
  -- -------------------------------------------------------------------------
  return jsonb_build_object(
    'outcome', 'SETTLED',
    'settled', true,
    'settlement_state', 'SETTLED',
    'reason', null,
    'gateway_transaction', (select to_jsonb(g) from public.gateway_transactions g where g.id = v_txn.id),
    'payment', to_jsonb(v_payment),
    'document', (
      select to_jsonb(s) from public.sales s
       where s.business_id = p_business_id and s.id = v_sale.id
    ),
    'journal_entry', to_jsonb(v_journal),
    'journal_lines', (
      select jsonb_agg(to_jsonb(jl) order by jl.line_no)
        from public.journal_lines jl
       where jl.journal_entry_id = v_journal.id
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------------
revoke all on function public.settle_gateway_txn(uuid, uuid, jsonb, date, text)
  from public, anon, authenticated;

grant execute on function public.settle_gateway_txn(uuid, uuid, jsonb, date, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Safety net: function privileges (restated, with settle_gateway_txn added)
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
