/**
 * Cloud read service — loads all book data from Supabase.
 *
 * Read-only for this stage. Every query filters by business_id, and RLS
 * is the real enforcement layer. Never uses the service-role key.
 *
 * Sales and purchases get their line items assembled client-side.
 * Journal entries get their journal lines assembled client-side.
 * paidAmount / paymentStatus are NOT stored — reconcile() derives them.
 */

import { supabase } from '../lib/supabase';
import { settlementError } from '../lib/paymentState';
import type {
  Account, ControlIntegrityReport, Customer, Expense, GatewayTransaction,
  JournalEntry, JournalLine, LineItem, Payment, Purchase, Sale, Supplier,
} from '../types';
import {
  DbGatewayInitiatePayload, DbGatewaySettlementPayload, InitiatedGatewayTransaction,
  GatewaySettlementResult, toAccount, toControlIntegrity, toCustomer, toExpense, toGatewayInitiateResult,
  toGatewaySettlementResult, toGatewayTransaction,
  toJournalEntry, toJournalLine, toLineItem, toPayment,
  toPostExpenseResult, toPostPaymentResult, toPostPurchaseResult, toPostSaleResult,
  toPurchase, toSale, toSupplier,
  toVoidDocumentResult, toVoidPaymentResult,
} from '../lib/dbTypes';
import type {
  DbControlIntegrityRow,
  DbPostExpensePayload, DbPostPaymentPayload, DbPostPurchasePayload, DbPostSalePayload,
  DbVoidDocumentPayload, DbVoidPaymentPayload,
  PostedExpenseResult, PostedPaymentResult, PostedPurchaseResult, PostedSaleResult,
  VoidableDocumentKind, VoidDocumentResult, VoidedPaymentResult,
} from '../lib/dbTypes';
import { toPostExpenseArgs } from '../lib/expenseState';
import type { CloudExpenseRequest } from '../lib/expenseState';
import { toPostPaymentArgs, toVoidPaymentArgs } from '../lib/paymentState';
import type { CloudPaymentRequest, CloudVoidPaymentRequest } from '../lib/paymentState';
import { toVoidDocumentArgs } from '../lib/voidState';
import type { CloudVoidRequest } from '../lib/voidState';
import { toPostPurchaseArgs } from '../lib/purchaseState';
import type { CloudPurchaseItemInput, CloudPurchaseRequest } from '../lib/purchaseState';
import { toInitiateGatewayArgs, toSettleGatewayArgs } from '../lib/gatewayState';
import type { CloudGatewayInitiateRequest, CloudGatewaySettleRequest } from '../lib/gatewayState';

/* -------------------------------------------------------------------------- */
/* Individual fetchers                                                         */
/* -------------------------------------------------------------------------- */

export async function fetchAccounts(businessId: string): Promise<Account[]> {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('business_id', businessId)
    .order('code');
  if (error) throw new Error(`Failed to load accounts: ${error.message}`);
  return (data ?? []).map((r) => toAccount(r as Record<string, unknown>));
}

export async function fetchCustomers(businessId: string): Promise<Customer[]> {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('business_id', businessId)
    .order('name');
  if (error) throw new Error(`Failed to load customers: ${error.message}`);
  return (data ?? []).map((r) => toCustomer(r as Record<string, unknown>));
}

export async function fetchSuppliers(businessId: string): Promise<Supplier[]> {
  const { data, error } = await supabase
    .from('suppliers')
    .select('*')
    .eq('business_id', businessId)
    .order('name');
  if (error) throw new Error(`Failed to load suppliers: ${error.message}`);
  return (data ?? []).map((r) => toSupplier(r as Record<string, unknown>));
}

async function fetchSaleItems(businessId: string): Promise<Map<string, LineItem[]>> {
  const { data, error } = await supabase
    .from('sale_items')
    .select('*')
    .eq('business_id', businessId)
    .order('line_no');
  if (error) throw new Error(`Failed to load sale items: ${error.message}`);
  const map = new Map<string, LineItem[]>();
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const saleId = r.sale_id as string;
    const items = map.get(saleId) ?? [];
    items.push(toLineItem(r));
    map.set(saleId, items);
  }
  return map;
}

export async function fetchSales(businessId: string): Promise<Sale[]> {
  const [salesResult, itemsMap] = await Promise.all([
    supabase
      .from('sales')
      .select('*')
      .eq('business_id', businessId)
      .order('date', { ascending: false }),
    fetchSaleItems(businessId),
  ]);
  if (salesResult.error) throw new Error(`Failed to load sales: ${salesResult.error.message}`);
  return (salesResult.data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return toSale(row, itemsMap.get(row.id as string) ?? []);
  });
}

async function fetchPurchaseItems(businessId: string): Promise<Map<string, LineItem[]>> {
  const { data, error } = await supabase
    .from('purchase_items')
    .select('*')
    .eq('business_id', businessId)
    .order('line_no');
  if (error) throw new Error(`Failed to load purchase items: ${error.message}`);
  const map = new Map<string, LineItem[]>();
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const purchaseId = r.purchase_id as string;
    const items = map.get(purchaseId) ?? [];
    items.push(toLineItem(r));
    map.set(purchaseId, items);
  }
  return map;
}

export async function fetchPurchases(businessId: string): Promise<Purchase[]> {
  const [purchasesResult, itemsMap] = await Promise.all([
    supabase
      .from('purchases')
      .select('*')
      .eq('business_id', businessId)
      .order('date', { ascending: false }),
    fetchPurchaseItems(businessId),
  ]);
  if (purchasesResult.error) throw new Error(`Failed to load purchases: ${purchasesResult.error.message}`);
  return (purchasesResult.data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return toPurchase(row, itemsMap.get(row.id as string) ?? []);
  });
}

export async function fetchExpenses(businessId: string): Promise<Expense[]> {
  const { data, error } = await supabase
    .from('expenses')
    .select('*')
    .eq('business_id', businessId)
    .order('date', { ascending: false });
  if (error) throw new Error(`Failed to load expenses: ${error.message}`);
  return (data ?? []).map((r) => toExpense(r as Record<string, unknown>));
}

export async function fetchPayments(businessId: string): Promise<Payment[]> {
  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('business_id', businessId)
    .order('date', { ascending: false });
  if (error) throw new Error(`Failed to load payments: ${error.message}`);
  return (data ?? []).map((r) => toPayment(r as Record<string, unknown>));
}

export async function fetchGatewayTransactions(
  businessId: string,
): Promise<GatewayTransaction[]> {
  const { data, error } = await supabase
    .from('gateway_transactions')
    .select('*')
    .eq('business_id', businessId)
    .order('initiated_at', { ascending: false });
  if (error) throw new Error(`Failed to load gateway transactions: ${error.message}`);
  return (data ?? []).map((r) => toGatewayTransaction(r as Record<string, unknown>));
}

/**
 * The diagnostic's own absence, said plainly.
 *
 * "Could not find the function public.control_account_integrity … in the schema
 * cache" is accurate and useless to the person reading Data Health. What it
 * actually means is that this Supabase project is behind the repository, so the
 * message names the migration that fixes it.
 */
const DIAGNOSTIC_NOT_DEPLOYED =
  'the integrity diagnostic is not deployed on this project — its schema is behind the '
  + 'application, and migration 014 (014_control_account_integrity.sql) has not been applied. '
  + 'Apply the repository migrations to this project, then reload.';

/**
 * Is this PostgREST telling us the function does not exist?
 *
 * PGRST202 is "no such function in the schema cache"; a 404 has the same
 * meaning through a proxy. A permission error is deliberately NOT treated as
 * this: a caller who may not run the diagnostic is a different problem, and
 * reporting it as "not deployed" would send someone to the wrong fix.
 */
function isMissingFunction(error: { code?: string; message?: string }): boolean {
  if (error.code === 'PGRST202') return true;
  return /could not find the function|does not exist in the schema cache/i.test(error.message ?? '');
}

/** Cleared by a page load, which is exactly when a new deployment may exist. */
let diagnosticNotDeployed = false;

/**
 * Ask the database to reconcile the control accounts against the documents
 * (control_account_integrity, migration 014).
 *
 * Read-only, caller-scoped and parameterless: the function returns one row per
 * business the caller may read and RLS decides which those are, so there is no
 * business id to forge and nothing about another tenant to leak. The browser
 * cannot make this answer up — it holds no INSERT/UPDATE anywhere near these
 * tables — which is what makes it evidence rather than a client opinion.
 *
 * Never throws. A diagnostic that could not be consulted is reported as
 * unavailable, so Data Health can say "not checked" instead of showing a clean
 * bill of health nobody verified.
 */
export async function fetchControlIntegrity(businessId: string): Promise<ControlIntegrityReport> {
  // Asked once per session, not once per load. A missing function cannot appear
  // between two loads, and re-asking would produce the same 404 in the console
  // every time the book refreshes. The verdict below stays `unavailable` — this
  // suppresses a repeated request, never a finding.
  if (diagnosticNotDeployed) {
    return { status: 'unavailable', reason: DIAGNOSTIC_NOT_DEPLOYED };
  }
  try {
    const { data, error } = await supabase.rpc('control_account_integrity');
    if (error) {
      if (isMissingFunction(error)) {
        diagnosticNotDeployed = true;
        return { status: 'unavailable', reason: DIAGNOSTIC_NOT_DEPLOYED };
      }
      return { status: 'unavailable', reason: error.message || 'the diagnostic could not be read' };
    }
    const rows = (data ?? []) as DbControlIntegrityRow[];
    const row = rows.find((r) => r.business_id === businessId);
    if (!row) {
      return { status: 'unavailable', reason: 'the diagnostic returned no row for this business' };
    }
    return { status: 'known', integrity: toControlIntegrity(row) };
  } catch (e) {
    return {
      status: 'unavailable',
      reason: e instanceof Error ? e.message : 'the diagnostic could not be read',
    };
  }
}

/**
 * Start an online collection (initiate_gateway_txn, migration 011).
 *
 * The browser cannot insert a gateway row at all: authenticated holds no
 * INSERT on gateway_transactions, so this RPC is the only way one exists. What
 * it records is a provider interaction against a POSTED invoice — the status,
 * the initiator and the amount's relation to the outstanding balance are all
 * decided by the database, and a repeated reference replays instead of
 * inserting a second row.
 */
export async function initiateGatewayTxn(
  params: CloudGatewayInitiateRequest,
): Promise<InitiatedGatewayTransaction> {
  const { data, error } = await supabase.rpc('initiate_gateway_txn', toInitiateGatewayArgs(params));

  if (error) {
    throw new Error(error.message || 'Failed to start the online collection');
  }

  return toGatewayInitiateResult(data as DbGatewayInitiatePayload);
}

/**
 * Settle a verified collection (settle_gateway_txn, migration 012).
 *
 * This is the only path that turns a gateway answer into money on the books: it
 * locks the collection and its invoice, re-validates provider, reference, amount
 * and currency against the persisted row, recomputes the outstanding balance and
 * then posts exactly one settlement through the same accounting core
 * post_payment uses. A replay returns the settlement that is already committed.
 */
export async function settleGatewayTxn(
  params: CloudGatewaySettleRequest,
): Promise<GatewaySettlementResult> {
  const { data, error } = await supabase.rpc('settle_gateway_txn', toSettleGatewayArgs(params));

  if (error) {
    throw settlementError(error, 'Failed to settle the online collection');
  }

  return toGatewaySettlementResult(data as DbGatewaySettlementPayload);
}

async function fetchJournalLines(
  businessId: string,
): Promise<Map<string, JournalLine[]>> {
  const { data, error } = await supabase
    .from('journal_lines')
    .select('*')
    .eq('business_id', businessId)
    .order('line_no');
  if (error) throw new Error(`Failed to load journal lines: ${error.message}`);
  const map = new Map<string, JournalLine[]>();
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const entryId = r.journal_entry_id as string;
    const lines = map.get(entryId) ?? [];
    lines.push(toJournalLine(r));
    map.set(entryId, lines);
  }
  return map;
}

export async function fetchJournalEntries(
  businessId: string,
): Promise<JournalEntry[]> {
  const [entriesResult, linesMap] = await Promise.all([
    supabase
      .from('journal_entries')
      .select('*')
      .eq('business_id', businessId)
      .order('transaction_date', { ascending: false })
      .order('sequence', { ascending: false }),
    fetchJournalLines(businessId),
  ]);
  if (entriesResult.error) throw new Error(`Failed to load journal entries: ${entriesResult.error.message}`);
  return (entriesResult.data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return toJournalEntry(row, linesMap.get(row.id as string) ?? []);
  });
}

/* -------------------------------------------------------------------------- */
/* Bulk loader                                                                 */
/* -------------------------------------------------------------------------- */

export interface AllBookData {
  accounts: Account[];
  customers: Customer[];
  suppliers: Supplier[];
  sales: Sale[];
  purchases: Purchase[];
  expenses: Expense[];
  payments: Payment[];
  gatewayTransactions: GatewayTransaction[];
  journalEntries: JournalEntry[];
}

/**
 * Fetch all book data for a business in parallel.
 * Returns everything needed to hydrate useBooks state.
 */
export async function fetchAllBookData(
  businessId: string,
): Promise<AllBookData> {
  const [
    accounts,
    customers,
    suppliers,
    sales,
    purchases,
    expenses,
    payments,
    gatewayTransactions,
    journalEntries,
  ] = await Promise.all([
    fetchAccounts(businessId),
    fetchCustomers(businessId),
    fetchSuppliers(businessId),
    fetchSales(businessId),
    fetchPurchases(businessId),
    fetchExpenses(businessId),
    fetchPayments(businessId),
    fetchGatewayTransactions(businessId),
    fetchJournalEntries(businessId),
  ]);

  return {
    accounts,
    customers,
    suppliers,
    sales,
    purchases,
    expenses,
    payments,
    gatewayTransactions,
    journalEntries,
  };
}

/* -------------------------------------------------------------------------- */
/* Sales Posting (Atomic RPC)                                                 */
/* -------------------------------------------------------------------------- */

export interface PostSaleItemInput {
  lineNo?: number;
  description: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  total: number;
}

export interface PostSaleParams {
  businessId: string;
  customerId?: string | null;
  customerName: string;
  invoiceNumber?: string | null;
  date: string;
  subtotal: number;
  discountTotal?: number;
  taxAmount?: number;
  totalAmount: number;
  upfrontPaid?: number;
  paymentMethod?: 'CASH' | 'BANK' | 'ESEWA' | 'KHALTI';
  /**
   * Whole days of credit agreed with the customer; 0 means due immediately.
   * Only the terms are sent — never a due date. post_sale derives the date from
   * the document date plus these terms inside the posting transaction, so the
   * date the form previewed and the date the books hold come from one rule.
   */
  paymentTermsDays?: number;
  costOfGoods?: number | null;
  notes?: string | null;
  items: PostSaleItemInput[];
}

export type PostSaleResult = PostedSaleResult;

/**
 * Atomically post a sale invoice, line items, balanced journal entries,
 * customer record (if needed), and upfront settlement via PostgreSQL RPC.
 */
export async function postSale(params: PostSaleParams): Promise<PostSaleResult> {
  const itemsJson = params.items.map((item, idx) => ({
    line_no: item.lineNo ?? idx + 1,
    description: item.description,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    discount: item.discount ?? 0,
    total: item.total,
  }));

  const { data, error } = await supabase.rpc('post_sale', {
    p_business_id: params.businessId,
    p_customer_id: params.customerId ?? null,
    p_customer_name: params.customerName,
    p_invoice_number: params.invoiceNumber ?? null,
    p_date: params.date,
    p_subtotal: params.subtotal,
    p_discount_total: params.discountTotal ?? 0,
    p_tax_amount: params.taxAmount ?? 0,
    p_total_amount: params.totalAmount,
    p_upfront_paid: params.upfrontPaid ?? 0,
    p_payment_method: params.paymentMethod ?? 'CASH',
    p_cost_of_goods: params.costOfGoods ?? null,
    p_notes: params.notes ?? null,
    p_items: itemsJson,
    p_payment_terms_days: params.paymentTermsDays ?? 0,
  });

  if (error) {
    throw settlementError(error, 'Failed to post sale invoice');
  }

  // The RPC returns line items under the key `items` (see 005_post_sale.sql).
  // Reading `sale_items` here used to leave every freshly posted invoice
  // looking empty until the next full reload.
  return toPostSaleResult(data as DbPostSalePayload);
}

/* -------------------------------------------------------------------------- */
/* Purchases Posting (Atomic RPC)                                             */
/* -------------------------------------------------------------------------- */

export type PostPurchaseItemInput = CloudPurchaseItemInput;
export type PostPurchaseParams = CloudPurchaseRequest;
export type PostPurchaseResult = PostedPurchaseResult;

/**
 * Atomically post a purchase, its line items, a balanced journal entry and any
 * upfront settlement via PostgreSQL RPC. Nothing is written to React state
 * unless this resolves.
 */
export async function postPurchase(params: CloudPurchaseRequest): Promise<PostPurchaseResult> {
  const { data, error } = await supabase.rpc('post_purchase', toPostPurchaseArgs(params));

  if (error) {
    throw settlementError(error, 'Failed to post purchase');
  }

  // The RPC returns line items under the key `items` (see 006_post_purchase.sql).
  return toPostPurchaseResult(data as DbPostPurchasePayload);
}

/**
 * Post an expense atomically (post_expense, migration 007).
 *
 * An expense has no line items and no credit path: the RPC writes the document,
 * its journal entry and its balanced lines in one transaction and returns them
 * under the keys `expense`, `journal_entry` and `journal_lines`.
 */
export async function postExpense(params: CloudExpenseRequest): Promise<PostedExpenseResult> {
  const { data, error } = await supabase.rpc('post_expense', toPostExpenseArgs(params));

  if (error) {
    throw new Error(error.message || 'Failed to post expense');
  }

  return toPostExpenseResult(data as DbPostExpensePayload);
}

/**
 * Record a settlement atomically (post_payment, migration 009).
 *
 * The RPC locks the settled document, recomputes the outstanding balance from
 * the persisted sub-ledger, writes one payments row and one balanced payment
 * journal entry, and returns them under the keys `payment`, `document`,
 * `journal_entry` and `journal_lines`. It allocates the reference itself, so two
 * devices settling the same chain cannot mint the same number.
 */
export async function postPayment(params: CloudPaymentRequest): Promise<PostedPaymentResult> {
  const { data, error } = await supabase.rpc('post_payment', toPostPaymentArgs(params));

  if (error) {
    throw settlementError(error, 'Failed to record settlement');
  }

  return toPostPaymentResult(data as DbPostPaymentPayload);
}

/**
 * Void a settlement atomically (void_payment, migration 010).
 *
 * The RPC locks the settlement, validates that its journal entry is really its
 * own, writes exactly one mirror reversal, links it from the original and flips
 * the row to VOIDED — without touching the sale or purchase it settled. A
 * settlement recorded as part of its document (an upfront payment) is refused
 * by the same check, because its entry belongs to the document.
 */
export async function voidPayment(params: CloudVoidPaymentRequest): Promise<VoidedPaymentResult> {
  const { data, error } = await supabase.rpc('void_payment', toVoidPaymentArgs(params));

  if (error) {
    throw settlementError(error, 'Failed to void settlement');
  }

  return toVoidPaymentResult(data as DbVoidPaymentPayload);
}

/**
 * Void a document atomically (void_document, migration 008).
 *
 * The RPC writes exactly one mirror reversal entry, links it from the original,
 * marks the document VOIDED and voids any embedded settlement — nothing is
 * deleted. Every returned row is the persisted row, not an echo of the request.
 */
export async function voidDocument(params: CloudVoidRequest): Promise<VoidDocumentResult> {
  const { data, error } = await supabase.rpc('void_document', toVoidDocumentArgs(params));

  if (error) {
    throw settlementError(error, 'Failed to void document');
  }

  return toVoidDocumentResult(
    data as DbVoidDocumentPayload,
    params.documentType.toLowerCase() as VoidableDocumentKind,
  );
}
