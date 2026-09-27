/**
 * Purchases: cloud request shaping and pure state transitions.
 *
 * Kept free of React and of the client SDK so both the wire contract with
 * post_purchase and the guarantee that a just-posted purchase's line items are
 * in state immediately can be tested directly.
 */

import type { JournalEntry, Payment, Purchase } from '../types';
import type { PostedPurchaseResult } from './dbTypes';

/* -------------------------------------------------------------------------- */
/* Wire contract with public.post_purchase() (migration 006)                   */
/* -------------------------------------------------------------------------- */

export interface CloudPurchaseItemInput {
  lineNo?: number;
  description: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  total: number;
}

export interface CloudPurchaseRequest {
  businessId: string;
  supplierId?: string | null;
  supplierName: string;
  /**
   * Blank means "let the server allocate". The RPC issues PO-YYYYMMDD-NNN
   * under a per-business advisory lock, the same format referenceGenerator
   * used, but it cannot collide between two devices posting at once.
   */
  referenceNumber?: string | null;
  date: string;
  subtotal: number;
  discountTotal?: number;
  taxAmount?: number;
  totalAmount: number;
  upfrontPaid?: number;
  paymentMethod?: 'CASH' | 'BANK' | 'ESEWA' | 'KHALTI';
  /**
   * Whole days of credit agreed with the supplier; 0 means due immediately.
   * The due date is NOT sent: the RPC computes it as `date + terms` in the same
   * transaction, so the browser has no date to disagree with the books.
   */
  paymentTermsDays?: number;
  notes?: string | null;
  items: CloudPurchaseItemInput[];
  /** Explicit VAT mode; omit to let the RPC infer it from the amounts. */
  priceIncludesVat?: boolean | null;
  /** Retry-safe key. Reusing it with a different request is rejected. */
  idempotencyKey?: string | null;
}

/**
 * Map an app-side purchase request to the RPC's snake_case arguments.
 *
 * Deliberately contains no identity, journal-entry, sequence, status, paid
 * amount or `created_by` argument: those are the database's to decide from
 * auth.uid(), so a client cannot choose its own identity or post as paid.
 */
export function toPostPurchaseArgs(request: CloudPurchaseRequest): Record<string, unknown> {
  return {
    p_business_id: request.businessId,
    p_supplier_id: request.supplierId ?? null,
    p_supplier_name: request.supplierName,
    p_reference_number: request.referenceNumber ?? '',
    p_date: request.date,
    p_subtotal: request.subtotal,
    p_discount_total: request.discountTotal ?? 0,
    p_tax_amount: request.taxAmount ?? 0,
    p_total_amount: request.totalAmount,
    p_upfront_paid: request.upfrontPaid ?? 0,
    p_payment_method: request.paymentMethod ?? 'CASH',
    p_notes: request.notes ?? null,
    p_items: request.items.map((item, idx) => ({
      line_no: item.lineNo ?? idx + 1,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      discount: item.discount ?? 0,
      total: item.total,
    })),
    p_payment_terms_days: request.paymentTermsDays ?? 0,
    p_idempotency_key: request.idempotencyKey ?? null,
    p_price_includes_vat: request.priceIncludesVat ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* State transitions                                                          */
/* -------------------------------------------------------------------------- */

export interface PurchaseBookArrays {
  purchases: Purchase[];
  journalEntries: JournalEntry[];
  payments: Payment[];
}

/**
 * Prepend a posted purchase, its journal entry and its settlement (if any).
 *
 * The settlement row (not purchase.upfrontPaid) is what reconcile() counts, so
 * inserting it here keeps paidAmount correct the moment the document appears.
 * Pure: the input arrays are never mutated, and this only ever runs after the
 * RPC has committed.
 */
export function applyPostedPurchase(
  state: PurchaseBookArrays,
  result: PostedPurchaseResult,
): PurchaseBookArrays {
  return {
    purchases: [result.purchase, ...state.purchases],
    journalEntries: [result.journalEntry, ...state.journalEntries],
    payments: result.payment ? [result.payment, ...state.payments] : state.payments,
  };
}
