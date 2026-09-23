/**
 * Pure state transitions for cloud-posted documents.
 *
 * Kept free of React so the important guarantee — a just-posted sale's line
 * items are in state immediately, with no refetch — can be tested directly.
 */

import type { JournalEntry, Payment, Sale } from '../types';
import type { PostedSaleResult } from './dbTypes';

export interface BookArrays {
  sales: Sale[];
  journalEntries: JournalEntry[];
  payments: Payment[];
}

/** Prepend a posted sale, its journal entry and its settlement (if any). */
export function applyPostedSale(state: BookArrays, result: PostedSaleResult): BookArrays {
  return {
    sales: [result.sale, ...state.sales],
    journalEntries: [result.journalEntry, ...state.journalEntries],
    payments: result.payment ? [result.payment, ...state.payments] : state.payments,
  };
}
