-- ============================================================================
-- 013_upfront_is_a_snapshot.sql
-- Money that was settled when a document was posted: one source of truth, and
-- it is the settlement rows.
--
-- This migration changes no behaviour. It writes down, at the place an
-- engineer would look, the rule the code already follows.
--
-- What already happens
--   * post_sale / post_purchase take p_upfront_paid as an INPUT, store it in
--     sales.upfront_paid / purchases.upfront_paid, and record the same amount
--     as a real row in public.payments — linked to the document, sharing the
--     document's own journal entry, INCOMING for a sale and OUTGOING for a
--     purchase.
--   * Every balance decision — post_payment, post_settlement_core (011),
--     settle_gateway_txn (012) — recomputes what is outstanding from the
--     persisted payments sub-ledger:
--
--         Total − SUM(settlement rows that are COMPLETED and POSTED)
--           = Outstanding
--
--     and never reads the column. There is therefore exactly one number in
--     play, and it comes from rows that carry their own journal entry.
--   * The column cannot drift away from that row either: guard_document_update
--     (001) makes every column of a posted document immutable except `status`,
--     which may only move POSTED -> VOIDED. No role, including service_role,
--     can edit the amount after the fact.
--
-- So the column is a posting-time snapshot of an input, kept because a document
-- is an accounting record of what was agreed on the day, not because anything
-- derives money from it. The row is the money. Deleting the column was
-- considered and rejected: migrations 001-012 are frozen, the RPC contract
-- (p_upfront_paid) is part of the public API, and the snapshot is what lets a
-- reprinted document show what the customer actually settled at the counter.
--
-- Read alongside 006_post_purchase.sql's header, which already stated the same
-- rule for purchases: "upfront_paid is a storage/input field only".
-- ============================================================================

comment on column public.sales.upfront_paid is
  'Posting-time snapshot of what was settled when the invoice was created. NOT a live balance: '
  'the settlement rows in public.payments (COMPLETED + POSTED, linked to this sale) are the single '
  'source of truth, and every balance check on the server recomputes from them. Immutable after '
  'posting — guard_document_update (001) allows only status POSTED -> VOIDED to change.';

comment on column public.purchases.upfront_paid is
  'Posting-time snapshot of what was paid when the bill was created. NOT a live balance: the '
  'settlement rows in public.payments (COMPLETED + POSTED, linked to this purchase) are the single '
  'source of truth, and every balance check on the server recomputes from them. Immutable after '
  'posting — guard_document_update (001) allows only status POSTED -> VOIDED to change.';

comment on table public.payments is
  'The single source of truth for money moved against a document. One row per settlement, including '
  'the settlement embedded in a sale or purchase at posting time. Every paid amount, outstanding '
  'balance and payment status is derived from these rows — never from sales.upfront_paid or '
  'purchases.upfront_paid, which are frozen posting-time snapshots.';
