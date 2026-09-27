/**
 * Payments (settlements): cloud request shaping and pure state transitions.
 *
 * Kept free of React and of the client SDK so both the wire contract with
 * post_payment (migration 009) and the guarantee that a settlement never moves
 * money in local state before the server has committed it can be tested
 * directly.
 */

import type { JournalEntry, Payment, PaymentMethod, Purchase, Sale } from '../types';
import type { PostedPaymentResult, VoidedPaymentResult } from './dbTypes';

/* -------------------------------------------------------------------------- */
/* A database refusal, said in the app's own words                             */
/* -------------------------------------------------------------------------- */

/**
 * The settlement ↔ journal rules the DATABASE now enforces itself
 * (public.assert_settlement_linkage / assert_reversal_shape, migration 016),
 * with the sentence the person reading the screen should get instead of the
 * constraint name.
 *
 * Why this exists at all: the RPCs already refuse everything the app can ask
 * for, so a person should never see these. They arrive only when the database
 * refuses a write the application believed was valid — a stale screen, a
 * hand-run script, a replayed request — and the honest answer to "what
 * happened?" is the rule, not `new row for relation "payments" violates check
 * constraint "payments_exactly_one_document"`.
 */
const SETTLEMENT_REFUSALS: { pattern: RegExp; message: string }[] = [
  {
    pattern: /payments_exactly_one_document/,
    message: 'A settlement settles one document: an invoice or a bill, never both and never neither.',
  },
  {
    pattern: /payments_link_matches_direction/,
    message: 'Money received settles an invoice and money paid settles a bill — one settlement cannot be both.',
  },
  {
    pattern: /belongs to a different settlement/,
    message: 'The database refused this settlement: its journal entry already belongs to another settlement.',
  },
  {
    pattern: /shares a journal entry with a different (invoice|bill)/,
    message: 'The database refused this settlement: its journal entry belongs to a different document.',
  },
  {
    pattern: /cannot be anchored to a [A-Z]+ journal entry/,
    message: 'The database refused this settlement: it can only be recorded against the document it settles.',
  },
  {
    pattern: /cannot be marked VOIDED while its journal entry is unreversed/,
    message: 'The database refused this void: a settlement cannot be voided while its journal entry still stands in the ledger.',
  },
  {
    pattern: /missing from the ledger/,
    message: 'The database refused this write: the journal entry behind this settlement is missing.',
  },
  {
    pattern: /is itself a reversal and cannot be reversed again|must carry the source of the entry it reverses|must name the journal entry it reverses/,
    message: 'The database refused this reversal: a journal entry is reversed exactly once, by its own mirror.',
  },
];

/**
 * Translate a known database refusal into a sentence; return anything else
 * UNCHANGED.
 *
 * That last clause is the important one: an error this does not recognise is
 * still shown to the person and still reported as a failure. Mapping known
 * rules is the whole job here — swallowing the unknown ones would turn a real
 * problem into silence.
 */
export function settlementErrorMessage(message: string): string {
  for (const { pattern, message: friendly } of SETTLEMENT_REFUSALS) {
    if (pattern.test(message)) return friendly;
  }
  return message;
}

export function settlementError(error: { message?: string }, fallback: string): Error {
  return new Error(settlementErrorMessage(error.message ?? '') || fallback);
}

/* -------------------------------------------------------------------------- */
/* Wire contract with public.post_payment() (migration 009)                    */
/* -------------------------------------------------------------------------- */

/**
 * A settlement is always against a persisted document. An expense cannot be
 * settled here: it is paid when it is posted, so it has no payable to draw down.
 */
export type CloudSettlementDocumentType = 'SALE' | 'PURCHASE';

export interface CloudPaymentRequest {
  businessId: string;
  /** SALE → INCOMING customer receipt, PURCHASE → OUTGOING supplier payment. */
  documentType: CloudSettlementDocumentType;
  documentId: string;
  amount: number;
  paymentMethod?: PaymentMethod;
  date: string;
  /** Blank means "let the server allocate" RCP-/PAY-YYYYMMDD-NNN. */
  reference?: string | null;
  notes?: string | null;
  /** Retry-safe key. Reusing it with a different request is rejected. */
  idempotencyKey?: string | null;
}

/**
 * Map an app-side settlement to the RPC's snake_case arguments.
 *
 * Deliberately contains no identity, party name, payment type, status,
 * journal-entry or sequence argument: post_payment derives the direction from
 * the document, the party from the persisted document snapshot, and everything
 * else from auth.uid(), so a client cannot choose its own identity or label its
 * own direction.
 */
export function toPostPaymentArgs(request: CloudPaymentRequest): Record<string, unknown> {
  return {
    p_business_id: request.businessId,
    p_document_type: request.documentType,
    p_document_id: request.documentId,
    p_amount: request.amount,
    p_payment_method: request.paymentMethod ?? 'CASH',
    p_date: request.date,
    p_reference: request.reference ?? '',
    p_notes: request.notes ?? null,
    p_idempotency_key: request.idempotencyKey ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* State transitions                                                          */
/* -------------------------------------------------------------------------- */

export interface PaymentBookArrays {
  payments: Payment[];
  journalEntries: JournalEntry[];
}

/* -------------------------------------------------------------------------- */
/* Wire contract with public.void_payment() (migration 010)                    */
/* -------------------------------------------------------------------------- */

export interface CloudVoidPaymentRequest {
  businessId: string;
  paymentId: string;
}

/**
 * Map an app-side payment void to the RPC's arguments.
 *
 * Deliberately only two: the reversal entry, its lines, the journal sequence,
 * the void date and the resulting status are all decided by the database from
 * the persisted payment and its own journal entry. A client cannot supply a
 * reversal, choose a sequence or name a status.
 */
export function toVoidPaymentArgs(request: CloudVoidPaymentRequest): Record<string, unknown> {
  return {
    p_business_id: request.businessId,
    p_payment_id: request.paymentId,
  };
}

/* -------------------------------------------------------------------------- */
/* Which settlements may be voided                                             */
/* -------------------------------------------------------------------------- */

/** The document fields the rule needs: which entry belongs to whom. */
export interface VoidablePaymentContext {
  sales: Pick<Sale, 'id' | 'journalEntryId'>[];
  purchases: Pick<Purchase, 'id' | 'journalEntryId'>[];
}

/**
 * Why a settlement cannot be voided, or null when it can.
 *
 * An upfront settlement written by post_sale/post_purchase shares its
 * DOCUMENT's journal entry — it is not a separate accounting event, and
 * reversing that entry would reverse the whole sale or purchase. The server
 * refuses it too (23514); this mirrors the rule so the button is disabled with
 * the reason instead of failing after a click.
 */
export function paymentVoidBlockedReason(
  payment: Pick<Payment, 'docStatus' | 'journalEntryId' | 'linkedSaleId' | 'linkedPurchaseId'>,
  context: VoidablePaymentContext,
): string | null {
  if (payment.docStatus !== 'POSTED') return 'This settlement has already been voided.';

  const document = payment.linkedSaleId
    ? context.sales.find((s) => s.id === payment.linkedSaleId)
    : payment.linkedPurchaseId
      ? context.purchases.find((p) => p.id === payment.linkedPurchaseId)
      : null;

  // An unlinked settlement moved its own money, so its own entry is the event.
  if (!document) return null;

  return payment.journalEntryId === document.journalEntryId
    ? 'This settlement was recorded as part of its document. Void the document to reverse it.'
    : null;
}

/** True when the void action should be available for this row. */
export function isVoidablePayment(
  payment: Pick<Payment, 'docStatus' | 'journalEntryId' | 'linkedSaleId' | 'linkedPurchaseId'>,
  context: VoidablePaymentContext,
): boolean {
  return paymentVoidBlockedReason(payment, context) === null;
}

/**
 * Apply a committed void to the book arrays.
 *
 * Nothing is removed: the settlement is replaced by its persisted VOIDED row,
 * the original entry gains its one-way reversal link, and the reversal entry
 * (with its mirror lines) is prepended. The linked sale or purchase is not
 * touched — reconcile() derives paidAmount and the outstanding balance from the
 * settlement rows, so replacing this one is what moves them. Pure: the input
 * arrays are never mutated.
 */
export function applyVoidedPayment(
  state: PaymentBookArrays,
  result: VoidedPaymentResult,
): PaymentBookArrays {
  // A replay returns the reversal that is already committed, so it is only
  // added when it is not in the ledger yet.
  const alreadyPresent = state.journalEntries.some((e) => e.id === result.reversalJournalEntry.id);
  const journalEntries = [
    ...(alreadyPresent ? [] : [result.reversalJournalEntry]),
    ...state.journalEntries.map((entry) =>
      entry.id === result.originalJournalEntry.id
        ? { ...entry, reversedByEntryId: result.originalJournalEntry.reversedByEntryId }
        : entry,
    ),
  ];

  const known = state.payments.some((p) => p.id === result.payment.id);
  const payments = known
    ? state.payments.map((p) => (p.id === result.payment.id ? result.payment : p))
    : [result.payment, ...state.payments];

  return { payments, journalEntries };
}

/**
 * Apply a committed settlement to the book arrays.
 *
 * Only the settlement row and its journal entry are written: the settled sale or
 * purchase is left exactly as it is, because paidAmount and paymentStatus are
 * not stored — reconcile() derives both from the `payments` rows, so inserting
 * the settlement is what moves them. Nothing is removed and nothing is
 * optimistically guessed: this only ever runs with the rows the RPC returned.
 *
 * A replayed request (same idempotency key) returns the payment that is already
 * committed, so an id that is already in state is replaced in place instead of
 * being listed twice. Pure: the input arrays are never mutated.
 */
export function applyPostedPayment(
  state: PaymentBookArrays,
  result: PostedPaymentResult,
): PaymentBookArrays {
  const paymentKnown = state.payments.some((p) => p.id === result.payment.id);
  const entryKnown = state.journalEntries.some((e) => e.id === result.journalEntry.id);

  return {
    payments: paymentKnown
      ? state.payments.map((p) => (p.id === result.payment.id ? result.payment : p))
      : [result.payment, ...state.payments],
    journalEntries: entryKnown
      ? state.journalEntries.map((e) =>
        e.id === result.journalEntry.id ? result.journalEntry : e,
      )
      : [result.journalEntry, ...state.journalEntries],
  };
}
