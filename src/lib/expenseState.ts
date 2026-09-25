/**
 * Expenses: cloud request shaping and pure state transitions.
 *
 * Kept free of React and of the Firebase SDK so both the wire contract with
 * post_expense (migration 007) and the guarantee that a just-posted expense is
 * in state immediately can be tested directly.
 */

import type { Expense, JournalEntry, PaymentMethod } from '../types';
import type { PostedExpenseResult } from './dbTypes';

/* -------------------------------------------------------------------------- */
/* Wire contract with public.post_expense() (migration 007)                    */
/* -------------------------------------------------------------------------- */

export interface CloudExpenseRequest {
  businessId: string;
  /** The category account; the server derives category_name from it. */
  accountId: string;
  /**
   * Blank means "let the server allocate". The RPC issues EXP-YYYYMMDD-NNN
   * under a per-business advisory lock, the same format referenceGenerator
   * used, but it cannot collide between two devices posting at once.
   */
  reference?: string | null;
  date: string;
  /** Net amount. */
  amount: number;
  taxAmount?: number;
  /** Gross amount; the database requires total = amount + tax. */
  totalAmount: number;
  paymentMethod?: PaymentMethod;
  description: string;
  notes?: string | null;
  /** Explicit VAT mode; omit to let the RPC derive and normalise it. */
  priceIncludesVat?: boolean | null;
  /** Retry-safe key. One key per user action, reused by every retry. */
  idempotencyKey?: string | null;
}

/**
 * Map an app-side expense request to the RPC's snake_case arguments.
 *
 * Deliberately contains no identity, journal-entry, sequence, status,
 * `created_by` or `category_name` argument: the database decides those from
 * auth.uid() and from the resolved account, so a client cannot choose its own
 * identity or label its own category.
 */
export function toPostExpenseArgs(request: CloudExpenseRequest): Record<string, unknown> {
  return {
    p_business_id: request.businessId,
    p_account_id: request.accountId,
    p_reference: request.reference ?? '',
    p_date: request.date,
    p_amount: request.amount,
    p_tax_amount: request.taxAmount ?? 0,
    p_total_amount: request.totalAmount,
    p_payment_method: request.paymentMethod ?? 'CASH',
    p_description: request.description,
    p_notes: request.notes ?? null,
    p_idempotency_key: request.idempotencyKey ?? null,
    p_price_includes_vat: request.priceIncludesVat ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* State transitions                                                          */
/* -------------------------------------------------------------------------- */

export interface ExpenseBookArrays {
  expenses: Expense[];
  journalEntries: JournalEntry[];
}

/**
 * Prepend a posted expense and its journal entry.
 *
 * There is no payments array: an expense is settled at posting time, so it
 * never produces a settlement row and never enters reconcile(). Pure: the
 * input arrays are never mutated, and this only runs after the RPC commits.
 */
export function applyPostedExpense(
  state: ExpenseBookArrays,
  result: PostedExpenseResult,
): ExpenseBookArrays {
  return {
    expenses: [result.expense, ...state.expenses],
    journalEntries: [result.journalEntry, ...state.journalEntries],
  };
}
