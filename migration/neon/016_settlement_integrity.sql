-- ============================================================================
-- 016_settlement_integrity.sql
-- Stage 20 — the settlement ↔ journal relationship, made IMPOSSIBLE to break
-- rather than merely detectable (014_control_account_integrity.sql).
--
-- What the schema could already say about a settlement (001, 009, 011)
--   * `payments_link_matches_direction` — money received cannot name a bill and
--     money paid cannot name an invoice;
--   * `foreign key (business_id, linked_sale_id)    -> sales (business_id, id)`
--   * `foreign key (business_id, linked_purchase_id) -> purchases (business_id, id)`
--   * `foreign key (business_id, journal_entry_id)  -> journal_entries (business_id, id)`
--     — so a settlement cannot reach across tenants, and cannot point at a row
--     that does not exist;
--   * `unique (journal_entry_id)` — one settlement per accounting entry;
--   * `payments_guard_update` — after posting, only `doc_status` may move, and
--     only POSTED -> VOIDED.
--
-- The three things none of those could express — and which this migration does
--   (1) A settlement names EXACTLY ONE document. Nullable-on-both-sides was
--       representable: a `payments` row that settles nothing at all.
--   (2) The settlement's journal entry must be ITS OWN event. The foreign key
--       proves the entry exists in the same business; it says nothing about
--       whether that entry belongs to this settlement. A row could legally
--       point at another settlement's entry, at an unrelated invoice's entry,
--       or at a MANUAL/REVERSAL entry, and every derived figure in the
--       application would then be reading a relationship that was never true.
--       There are exactly three legitimate shapes, and they are the shapes the
--       posting RPCs actually write:
--         * e.source_type = 'PAYMENT'  and e.source_id = payment.id
--           — post_payment / post_settlement_core (009/011): the settlement is
--             its own accounting event;
--         * e.source_type = 'SALE'     and e.source_id = payment.linked_sale_id
--           — the upfront settlement post_sale writes with the INVOICE's own
--             entry (005/013): one economic event, so one entry, counted once;
--         * e.source_type = 'PURCHASE' and e.source_id = payment.linked_purchase_id
--           — the same on the payable side (006).
--       A settlement anchored to anything else is a mis-link, and it is now
--       refused at INSERT/UPDATE time.
--   (3) A VOIDED settlement must carry the reversal of the entry it was posted
--       with. Both void paths already satisfy this by construction — they write
--       the mirror reversal and set `reversed_by_entry_id` BEFORE flipping
--       `doc_status` to VOIDED (008 section 8, 010 section 8) — but the schema
--       did not require it, so a "voided but never reversed" settlement was
--       representable: a payment that stops counting while the ledger still
--       shows the cash.
--
-- Why here, and not in the RPCs (Stage 20 section 3 and 10)
--   The RPCs remain the only write path a client has — `authenticated` holds no
--   INSERT/UPDATE privilege on `payments` or `journal_entries` at all (002), and
--   post_payment takes the document row `for update` before recomputing the
--   outstanding balance, which is what serialises concurrent settlements. What
--   the RPC boundary cannot do is make the INVALID STATE unrepresentable for
--   every OTHER writer that will ever exist: a future RPC, a data import, a
--   support script, a mistake in a repair. Relational shape is exactly what a
--   declarative constraint and two single-row-lookup triggers are good at, so
--   this migration adds that and nothing else:
--     * one CHECK for "exactly one document" (no code, no scan at write time);
--     * one BEFORE INSERT OR UPDATE trigger on `payments` for the entry shape
--       and the void/reversal pair — one indexed primary-key lookup per row,
--       no table scan, no side effects, and it never writes or repairs;
--     * one BEFORE INSERT trigger on `journal_entries` for the reversal shape
--       (a reversal must name the entry it reverses, must carry the same
--       source, and may not reverse a reversal) — again a single lookup, and
--       only for rows whose source_type is 'REVERSAL'.
--
-- What this deliberately does NOT do
--   * It does not re-check tenancy: the composite foreign keys already do that,
--     and a second implementation of the same rule is a second thing to drift.
--   * It does not check the document↔entry relationship of the DOCUMENT
--     (`sales.journal_entry_id` pointing at an entry that is not the sale's
--     own). post_payment and settle_gateway_txn already fail closed on that
--     (they compare source_type/source_id before settling), and 014 reports the
--     resulting ledger/document divergence. Constraining it here would mean a
--     third trigger family for a different invariant — and the document rows
--     are written before their entry in 005/006, so it could not be a plain
--     BEFORE trigger anyway.
--   * It does not retire `control_account_integrity()` (014). Detection and
--     prevention are different jobs: the detector still has to answer for
--     historical rows, hand-built rows, and anything a future migration has not
--     thought of yet.
--
-- Existing data: audited before the constraint was added. Every one of the 17
-- settlement rows and 10 reversal entries in the local book already satisfies
-- all three rules (0 violations on each), which is why the constraint is added
-- VALIDATED rather than NOT VALID: there is nothing to tolerate, so nothing is
-- silently exempted. The migration is forward-only and changes no financial
-- amount — it adds no column, drops no column and rewrites no row.
--
-- Rules every RPC in this project follows
--   * additive changes only; a breaking change ships as <name>_v2
--   * EXECUTE revoked from public, anon; a client role never calls a guard
-- ============================================================================

-- ============================================================================
-- 1. A settlement names exactly one document
-- ============================================================================
-- Combined with `payments_link_matches_direction` (001) this also fixes the
-- direction declaratively: an INCOMING row may not name a purchase, so the one
-- document it must name is the invoice; an OUTGOING row's is the bill. A
-- settlement that settles nothing — the shape a standalone payment would need —
-- is not part of this product (settlements are always against a document), so
-- it is refused rather than left representable.

alter table public.payments
  add constraint payments_exactly_one_document
  check ((linked_sale_id is not null) <> (linked_purchase_id is not null));

comment on constraint payments_exactly_one_document on public.payments is
  'A settlement settles exactly one document: never both an invoice and a bill, '
  'never neither. With payments_link_matches_direction this also fixes which '
  'document the direction permits.';

-- ============================================================================
-- 2. The settlement''s journal entry must be its own event
-- ============================================================================

create function public.assert_settlement_linkage() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_entry public.journal_entries%rowtype;
begin
  -- The document link and the tenancy of the entry are the foreign keys' job:
  -- `(business_id, linked_sale_id)`, `(business_id, linked_purchase_id)` and
  -- `(business_id, journal_entry_id)` have already been proved by the time a
  -- BEFORE trigger sees the row, so nothing here re-checks them.
  select * into v_entry
    from public.journal_entries je
   where je.business_id = new.business_id
     and je.id = new.journal_entry_id;

  if v_entry.id is null then
    -- Unreachable through the (business_id, journal_entry_id) foreign key, and
    -- kept so this guard fails closed rather than opening on a missing row.
    raise exception 'This settlement''s journal entry is missing from the ledger'
      using errcode = '23514';
  end if;

  if v_entry.source_type = 'PAYMENT' then
    -- post_payment / post_settlement_core: the settlement is its own event.
    if v_entry.source_id is distinct from new.id then
      raise exception 'This settlement''s journal entry belongs to a different settlement'
        using errcode = '23514';
    end if;
  elsif v_entry.source_type = 'SALE' then
    -- post_sale's upfront settlement shares the INVOICE's entry.
    if v_entry.source_id is distinct from new.linked_sale_id then
      raise exception 'This settlement shares a journal entry with a different invoice'
        using errcode = '23514';
    end if;
  elsif v_entry.source_type = 'PURCHASE' then
    -- post_purchase's upfront settlement shares the BILL's entry.
    if v_entry.source_id is distinct from new.linked_purchase_id then
      raise exception 'This settlement shares a journal entry with a different bill'
        using errcode = '23514';
    end if;
  else
    -- EXPENSE / MANUAL / REVERSAL / CLOSING / OPENING: an event a settlement
    -- can never be anchored to.
    raise exception 'A settlement cannot be anchored to a % journal entry',
      v_entry.source_type
      using errcode = '23514';
  end if;

  -- A voided settlement whose entry is unreversed would leave the cash in the
  -- ledger while the settlement stopped counting: refused here. Both void paths
  -- write the reversal first, so a legitimate void passes.
  if new.doc_status = 'VOIDED' and v_entry.reversed_by_entry_id is null then
    raise exception 'A settlement cannot be marked VOIDED while its journal entry is unreversed'
      using errcode = '23514';
  end if;

  return new;
end $$;

comment on function public.assert_settlement_linkage() is
  'BEFORE INSERT OR UPDATE guard on public.payments: the referenced journal '
  'entry must be the settlement''s own PAYMENT entry, or the linked invoice''s '
  'SALE entry, or the linked bill''s PURCHASE entry — and a VOIDED settlement '
  'must carry the reversal of that entry. One primary-key lookup; never writes.';

create trigger payments_assert_linkage
  before insert or update on public.payments
  for each row execute function public.assert_settlement_linkage();

-- ============================================================================
-- 3. A reversal must be a reversal of a real, first-hand event
-- ============================================================================
-- 001 already enforces: at most one reversal per original
-- (journal_entries_reverses_uidx), at most one entry may claim to be an
-- original's reversal (journal_entries_reversed_by_uidx, and
-- guard_journal_entry_update refuses NULL -> value twice or towards an entry
-- that does not reverse it), the reversal shape
-- ((source_type = 'REVERSAL') = (reverses_entry_id is not null)), no self-link,
-- and a balanced mirror at COMMIT. What was still representable: reversing a
-- reversal, and a reversal whose source identity drifts from the entry it
-- claims to reverse.

create function public.assert_reversal_shape() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_original public.journal_entries%rowtype;
begin
  if new.source_type <> 'REVERSAL' then
    return new;  -- nothing to say about a first-hand event
  end if;

  select * into v_original
    from public.journal_entries je
   where je.business_id = new.business_id
     and je.id = new.reverses_entry_id;

  if v_original.id is null then
    -- Also unreachable: the (business_id, reverses_entry_id) foreign key has
    -- already proved the original exists in this business.
    raise exception 'A reversal must name the journal entry it reverses'
      using errcode = '23514';
  end if;

  if v_original.reverses_entry_id is not null then
    raise exception 'Journal entry % is itself a reversal and cannot be reversed again',
      v_original.reference
      using errcode = '23514';
  end if;

  -- A reversal reverses one economic event, so it carries that event's source.
  -- void_document (008) and void_payment (010) both copy source_id from the
  -- original; a reversal that names a different source is a different event
  -- wearing the same reversal id.
  if new.source_id is distinct from v_original.source_id then
    raise exception 'A reversal must carry the source of the entry it reverses'
      using errcode = '23514';
  end if;

  return new;
end $$;

comment on function public.assert_reversal_shape() is
  'BEFORE INSERT guard on public.journal_entries, for source_type = REVERSAL: '
  'the entry it reverses must exist in the same business, must not itself be a '
  'reversal, and the reversal must carry the same source identity. Refuses '
  'reversal-of-reversal and source drift; never writes.';

create trigger journal_entries_assert_reversal
  before insert on public.journal_entries
  for each row execute function public.assert_reversal_shape();

-- Trigger functions are never called directly.
revoke all on function
  public.assert_settlement_linkage(), public.assert_reversal_shape()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Safety net: function privileges (restated, unchanged by this migration)
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
         and p.proname not in ('is_member', 'can_write', 'is_owner', 'create_business', 'post_sale', 'post_purchase', 'post_expense', 'void_document', 'post_payment', 'void_payment', 'initiate_gateway_txn', 'settle_gateway_txn', 'control_account_integrity')
       )
     );
  if v_bad is not null then
    raise exception 'Unexpected EXECUTE privilege on: %', v_bad;
  end if;
end $$;
