/**
 * Voiding: cloud request shaping and the pure state transition.
 *
 * Kept free of React and of the client SDK so the wire contract with
 * void_document (migration 008) and the guarantee that a void never deletes a
 * row can be tested directly.
 */

import type { Expense, JournalEntry, Payment, Purchase, Sale } from '../types';
import type { VoidableDocumentKind, VoidDocumentResult } from './dbTypes';

/* -------------------------------------------------------------------------- */
/* Wire contract with public.void_document() (migration 008)                   */
/* -------------------------------------------------------------------------- */

export type CloudVoidDocumentType = 'SALE' | 'PURCHASE' | 'EXPENSE';

export interface CloudVoidRequest {
  businessId: string;
  documentType: CloudVoidDocumentType;
  documentId: string;
}

/**
 * Map an app-side void request to the RPC's arguments.
 *
 * Deliberately only three arguments. The reversal lines, the journal sequence,
 * the void date, the identity and the resulting statuses are all decided by the
 * database from the persisted rows, so a client cannot choose them.
 */
export function toVoidDocumentArgs(request: CloudVoidRequest): Record<string, unknown> {
  return {
    p_business_id: request.businessId,
    p_document_type: request.documentType,
    p_document_id: request.documentId,
  };
}

/* -------------------------------------------------------------------------- */
/* State transitions                                                          */
/* -------------------------------------------------------------------------- */

export interface VoidBookArrays {
  sales: Sale[];
  purchases: Purchase[];
  expenses: Expense[];
  journalEntries: JournalEntry[];
  payments: Payment[];
}

/**
 * Apply a committed void to the book arrays.
 *
 * Nothing is removed. The document flips to VOIDED, the original entry gains
 * its one-way reversal link, the reversal entry (with its mirror lines) is
 * prepended, and any embedded settlement is replaced by its persisted VOIDED
 * row. Line items, paidAmount and paymentStatus are carried over from the
 * document already in state, because the payload does not restate them and they
 * must not drift. Pure: the input arrays are never mutated.
 */
export function applyVoidedDocument(
  state: VoidBookArrays,
  kind: VoidableDocumentKind,
  result: VoidDocumentResult,
): VoidBookArrays {
  // A replay of an already-voided document returns the same persistence rows,
  // so the reversal is only added when it is not already in the ledger.
  const alreadyPresent = state.journalEntries.some((e) => e.id === result.reversalJournalEntry.id);
  const journalEntries = [
    ...(alreadyPresent ? [] : [result.reversalJournalEntry]),
    ...state.journalEntries.map((entry) =>
      entry.id === result.originalJournalEntry.id
        ? { ...entry, reversedByEntryId: result.originalJournalEntry.reversedByEntryId }
        : entry,
    ),
  ];

  const payments = result.affectedPayments.length === 0
    ? state.payments
    : state.payments.map((p) => result.affectedPayments.find((a) => a.id === p.id) ?? p);

  if (kind === 'sale') {
    const next = result.document as Sale;
    return {
      ...state,
      journalEntries,
      payments,
      sales: state.sales.map((s) => (s.id === next.id
        ? { ...next, items: s.items, paidAmount: s.paidAmount, paymentStatus: s.paymentStatus }
        : s)),
    };
  }

  if (kind === 'purchase') {
    const next = result.document as Purchase;
    return {
      ...state,
      journalEntries,
      payments,
      purchases: state.purchases.map((p) => (p.id === next.id
        ? { ...next, items: p.items, paidAmount: p.paidAmount, paymentStatus: p.paymentStatus }
        : p)),
    };
  }

  const next = result.document as Expense;
  return {
    ...state,
    journalEntries,
    payments,
    expenses: state.expenses.map((e) => (e.id === next.id ? next : e)),
  };
}
