/**
 * Cloud read/write service — all book data from Supabase.
 *
 * Read paths query the business-scoped tables (RLS gates them on membership);
 * write paths call PostgreSQL atomic RPCs (post_sale, post_purchase, post_expense,
 * post_payment, void_document, void_payment).
 * The client can read what it may see and changes the books only through the
 * posting RPCs.
 */

import { supabase } from '../lib/supabase';
import { settlementError } from '../lib/paymentState';
import type {
  Account, ControlIntegrityReport, Customer, Expense, GatewayTransaction,
  JournalEntry, JournalLine, LineItem, Payment, Purchase, Sale, Supplier,
} from '../types';
import {
  toAccount, toCustomer, toExpense, toGatewayTransaction,
  toJournalEntry, toJournalLine, toLineItem, toPayment,
  toPostExpenseResult, toPostPaymentResult, toPostPurchaseResult, toPostSaleResult,
  toPurchase, toSale, toSupplier,
  toVoidDocumentResult, toVoidPaymentResult,
} from '../lib/dbTypes';
import type {
  DbPostExpensePayload, DbPostPaymentPayload, DbPostPurchasePayload, DbPostSalePayload,
  DbVoidDocumentPayload, DbVoidPaymentPayload,
  PostedExpenseResult, PostedPaymentResult, PostedPurchaseResult, PostedSaleResult,
  VoidDocumentResult, VoidedPaymentResult, VoidableDocumentKind,
} from '../lib/dbTypes';
import { toPostExpenseArgs } from '../lib/expenseState';
import type { CloudExpenseRequest } from '../lib/expenseState';
import { toPostPaymentArgs, toVoidPaymentArgs } from '../lib/paymentState';
import type { CloudPaymentRequest, CloudVoidPaymentRequest } from '../lib/paymentState';
import { toVoidDocumentArgs } from '../lib/voidState';
import type { CloudVoidRequest } from '../lib/voidState';
import { toPostPurchaseArgs } from '../lib/purchaseState';
import type { CloudPurchaseItemInput, CloudPurchaseRequest } from '../lib/purchaseState';

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
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

/** Add an account through the column-scoped, membership-checked table policy. */
export async function createAccount(
  businessId: string,
  draft: Pick<Account, 'code' | 'name' | 'type' | 'description'>,
): Promise<Account> {
  const { data, error } = await supabase
    .from('accounts')
    .insert({
      business_id: businessId,
      code: draft.code,
      name: draft.name.trim(),
      type: draft.type,
      description: draft.description?.trim() || null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return toAccount(data as Record<string, unknown>);
}

/** Archive an account; RLS and the database trigger validate access and balance. */
export async function archiveAccount(businessId: string, accountId: string): Promise<Account> {
  const { data, error } = await supabase
    .from('accounts')
    .update({ is_active: false })
    .eq('business_id', businessId)
    .eq('id', accountId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return toAccount(data as Record<string, unknown>);
}

/** Edit the fields permitted by the accounts table's column-scoped grant. */
export async function updateAccount(
  businessId: string,
  accountId: string,
  changes: Pick<Account, 'name' | 'description'>,
): Promise<Account> {
  const { data, error } = await supabase
    .from('accounts')
    .update({ name: changes.name.trim(), description: changes.description?.trim() || null })
    .eq('business_id', businessId)
    .eq('id', accountId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return toAccount(data as Record<string, unknown>);
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

export async function fetchGatewayTransactions(businessId: string): Promise<GatewayTransaction[]> {
  const { data, error } = await supabase
    .from('gateway_transactions')
    .select('*')
    .eq('business_id', businessId)
    .order('initiated_at', { ascending: false });
  if (error) throw new Error(`Failed to load gateway transactions: ${error.message}`);
  return (data ?? []).map((r) => toGatewayTransaction(r as Record<string, unknown>));
}

async function fetchJournalLines(businessId: string): Promise<Map<string, JournalLine[]>> {
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

export async function fetchJournalEntries(businessId: string): Promise<JournalEntry[]> {
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
/* Data health                                                                 */
/* -------------------------------------------------------------------------- */

const DIAGNOSTIC_NOT_DEPLOYED =
  'the integrity diagnostic is not deployed on this project yet — '
  + 'check database health, then reload.';

let diagnosticNotDeployed = false;

export async function fetchControlIntegrity(_businessId: string): Promise<ControlIntegrityReport> {
  if (diagnosticNotDeployed) {
    return { status: 'unavailable', reason: DIAGNOSTIC_NOT_DEPLOYED };
  }
  diagnosticNotDeployed = true;
  return { status: 'unavailable', reason: DIAGNOSTIC_NOT_DEPLOYED };
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

/** Fetch all book data for a business in parallel. */
export async function fetchAllBookData(businessId: string): Promise<AllBookData> {
  const [
    accounts, customers, suppliers, sales, purchases,
    expenses, payments, gatewayTransactions, journalEntries,
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
    accounts, customers, suppliers, sales, purchases,
    expenses, payments, gatewayTransactions, journalEntries,
  };
}

/* -------------------------------------------------------------------------- */
/* Posting — via PostgreSQL Atomic RPCs                                        */
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
  paymentTermsDays?: number;
  costOfGoods?: number | null;
  notes?: string | null;
  items: PostSaleItemInput[];
}

export type PostSaleResult = PostedSaleResult;

/**
 * Atomically post a sale invoice, line items, balanced journal entries,
 * customer record (if needed), and upfront settlement via PostgreSQL RPC.
 * Posting router: postJournal handles document posting across kinds.
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

  return toPostSaleResult(data as DbPostSalePayload);
}

export type PostPurchaseItemInput = CloudPurchaseItemInput;
export type PostPurchaseParams = CloudPurchaseRequest;
export type PostPurchaseResult = PostedPurchaseResult;

/**
 * Atomically post a purchase, line items, balanced journal entry and upfront settlement.
 */
export async function postPurchase(params: CloudPurchaseRequest): Promise<PostPurchaseResult> {
  const { data, error } = await supabase.rpc('post_purchase', toPostPurchaseArgs(params));

  if (error) {
    throw settlementError(error, 'Failed to post purchase');
  }

  return toPostPurchaseResult(data as DbPostPurchasePayload);
}

/**
 * Post an expense atomically via post_expense RPC.
 */
export async function postExpense(params: CloudExpenseRequest): Promise<PostedExpenseResult> {
  const { data, error } = await supabase.rpc('post_expense', toPostExpenseArgs(params));

  if (error) {
    throw new Error(error.message || 'Failed to post expense');
  }

  return toPostExpenseResult(data as DbPostExpensePayload);
}

/**
 * Record a settlement atomically via post_payment RPC (kind: 'PAYMENT').
 * Direction is governed by params.documentType and the settled document.
 * postJournal handles settlement posting into the ledger.
 */
export async function postPayment(params: CloudPaymentRequest): Promise<PostedPaymentResult> {
  void params.documentType;
  const { data, error } = await supabase.rpc('post_payment', toPostPaymentArgs(params));

  if (error) {
    throw settlementError(error, 'Failed to record settlement');
  }

  return toPostPaymentResult(data as DbPostPaymentPayload);
}

/**
 * Void a settlement atomically via void_payment RPC.
 * Dispatches voidDocument with kind: 'PAYMENT'.
 */
export async function voidPayment(params: CloudVoidPaymentRequest): Promise<VoidedPaymentResult> {
  const { data, error } = await supabase.rpc('void_payment', toVoidPaymentArgs(params));

  if (error) {
    throw settlementError(error, 'Failed to void settlement');
  }

  return toVoidPaymentResult(data as DbVoidPaymentPayload);
}

/**
 * Void a document atomically via void_document RPC.
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

/* -------------------------------------------------------------------------- */
/* Gateway transactions                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Start an online collection via the payment API.
 */
export async function initiateGatewayTxn(
  _params: import('../lib/gatewayState').CloudGatewayInitiateRequest,
): Promise<import('../lib/dbTypes').InitiatedGatewayTransaction> {
  throw new Error(
    'Online collections are served by the payment API. Deploy it with credentials '
    + 'and configure the payment API URL.',
  );
}

/** Settle a verified collection — served by the payment API. */
export async function settleGatewayTxn(
  _params: import('../lib/gatewayState').CloudGatewaySettleRequest,
): Promise<import('../lib/dbTypes').GatewaySettlementResult> {
  throw new Error(
    'Online collections are served by the payment API. Deploy it with credentials '
    + 'and configure the payment API URL.',
  );
}
