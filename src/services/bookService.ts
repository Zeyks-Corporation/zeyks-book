/**
 * Cloud read/write service — all book data from Firestore.
 *
 * Read paths query the business-scoped subcollections (the security rules gate
 * them on membership); write paths call the Cloud Functions, which are the only
 * writers of the ledger. The client can read what it may see and nothing else,
 * and can change the books only through the posting functions — the same
 * division of labour RLS and the Postgres RPCs provided, on Firebase.
 *
 * Documents keep the Postgres snake_case field names, so the row mappers in
 * `dbTypes.ts` read Firestore documents without translation.
 */

import { db, functions } from '../lib/firebase';
import { httpsCallable } from 'firebase/functions';
import {
  collection, getDocs, orderBy, query,
} from 'firebase/firestore';
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
  VoidDocumentResult, VoidedPaymentResult,
} from '../lib/dbTypes';
import type { CloudExpenseRequest } from '../lib/expenseState';
import type { CloudPaymentRequest, CloudVoidPaymentRequest } from '../lib/paymentState';
import type { CloudVoidRequest } from '../lib/voidState';
import type { CloudPurchaseRequest } from '../lib/purchaseState';
import type { VoidableDocumentKind } from '../lib/dbTypes';

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

async function fetchAll<T>(
  path: string,
  businessId: string,
  orderField: string,
  map: (row: Record<string, unknown>) => T,
): Promise<T[]> {
  const snap = await getDocs(query(
    collection(db, 'businesses', businessId, path),
    orderBy(orderField),
  ));
  return snap.docs.map((d) => map({ ...d.data(), id: d.id } as Record<string, unknown>));
}

export async function fetchAccounts(businessId: string): Promise<Account[]> {
  return fetchAll('accounts', businessId, 'code', toAccount);
}

export async function fetchCustomers(businessId: string): Promise<Customer[]> {
  return fetchAll('customers', businessId, 'name', toCustomer);
}

export async function fetchSuppliers(businessId: string): Promise<Supplier[]> {
  return fetchAll('suppliers', businessId, 'name', toSupplier);
}

/** Line items live nested under their sale. */
async function fetchNestedItems(
  businessId: string,
  parent: 'sales' | 'purchases',
  child: 'sale_items' | 'purchase_items',
  fk: 'sale_id' | 'purchase_id',
): Promise<Map<string, LineItem[]>> {
  const parents = await getDocs(collection(db, 'businesses', businessId, parent));
  const map = new Map<string, LineItem[]>();
  await Promise.all(parents.docs.map(async (p) => {
    const items = await getDocs(query(
      collection(db, 'businesses', businessId, parent, p.id, child),
      orderBy('line_no'),
    ));
    map.set(p.id, items.docs.map((d) => toLineItem({ ...d.data(), id: d.id })));
    void fk;
  }));
  return map;
}

export async function fetchSales(businessId: string): Promise<Sale[]> {
  const [salesSnap, itemsMap] = await Promise.all([
    getDocs(query(collection(db, 'businesses', businessId, 'sales'), orderBy('date', 'desc'))),
    fetchNestedItems(businessId, 'sales', 'sale_items', 'sale_id'),
  ]);
  return salesSnap.docs.map((d) => {
    const row = { ...d.data(), id: d.id } as Record<string, unknown>;
    return toSale(row, itemsMap.get(d.id) ?? []);
  });
}

export async function fetchPurchases(businessId: string): Promise<Purchase[]> {
  const [purchasesSnap, itemsMap] = await Promise.all([
    getDocs(query(collection(db, 'businesses', businessId, 'purchases'), orderBy('date', 'desc'))),
    fetchNestedItems(businessId, 'purchases', 'purchase_items', 'purchase_id'),
  ]);
  return purchasesSnap.docs.map((d) => {
    const row = { ...d.data(), id: d.id } as Record<string, unknown>;
    return toPurchase(row, itemsMap.get(d.id) ?? []);
  });
}

export async function fetchExpenses(businessId: string): Promise<Expense[]> {
  return fetchAll('expenses', businessId, 'date', toExpense);
}

export async function fetchPayments(businessId: string): Promise<Payment[]> {
  return fetchAll('payments', businessId, 'date', toPayment);
}

export async function fetchGatewayTransactions(businessId: string): Promise<GatewayTransaction[]> {
  return fetchAll('gateway_transactions', businessId, 'initiated_at', toGatewayTransaction);
}

async function fetchJournalLines(
  businessId: string,
): Promise<Map<string, JournalLine[]>> {
  const entries = await getDocs(collection(db, 'businesses', businessId, 'journal_entries'));
  const map = new Map<string, JournalLine[]>();
  await Promise.all(entries.docs.map(async (e) => {
    const lines = await getDocs(query(
      collection(db, 'businesses', businessId, 'journal_entries', e.id, 'journal_lines'),
      orderBy('line_no'),
    ));
    map.set(e.id, lines.docs.map((d) => toJournalLine({ ...d.data(), id: d.id })));
  }));
  return map;
}

export async function fetchJournalEntries(businessId: string): Promise<JournalEntry[]> {
  const [entriesSnap, linesMap] = await Promise.all([
    getDocs(query(
      collection(db, 'businesses', businessId, 'journal_entries'),
      orderBy('transaction_date', 'desc'), orderBy('sequence', 'desc'),
    )),
    fetchJournalLines(businessId),
  ]);
  return entriesSnap.docs.map((d) => {
    const row = { ...d.data(), id: d.id } as Record<string, unknown>;
    return toJournalEntry(row, linesMap.get(d.id) ?? []);
  });
}

/* -------------------------------------------------------------------------- */
/* Data health                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The control-account diagnostic.
 *
 * On Postgres this asked a SQL function; on Firestore the equivalent evidence
 * is the control accounts' ledger balances against the documents' own
 * arithmetic, which the client derives in `checkIntegrity` from the same
 * journal entries Data Health already reads. The diagnostic is therefore
 * reported as derived rather than unavailable — but until the Firebase
 * health function is deployed this returns the honest "not checked" so a
 * deployment gap is never mistaken for a clean bill of health.
 */
const DIAGNOSTIC_NOT_DEPLOYED =
  'the integrity diagnostic is not deployed on this Firebase project yet — '
  + 'deploy the Cloud Functions (see FIREBASE_SETUP.md), then reload.';

let diagnosticNotDeployed = false;

export async function fetchControlIntegrity(_businessId: string): Promise<ControlIntegrityReport> {
  if (diagnosticNotDeployed) {
    return { status: 'unavailable', reason: DIAGNOSTIC_NOT_DEPLOYED };
  }
  // TODO(functions): port control_account_integrity to a callable. Until then
  // Data Health shows "not checked" for this diagnostic instead of guessing.
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
/* Posting — via Cloud Functions                                               */
/* -------------------------------------------------------------------------- */

async function callPost<TPayload extends Record<string, unknown>, TResult>(
  fn: string,
  args: Record<string, unknown>,
  map: (payload: TPayload) => TResult,
  failure: string,
): Promise<TResult> {
  try {
    const call = httpsCallable<Record<string, unknown>, TPayload>(functions, fn);
    const res = await call(args);
    return map(res.data);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    const message = (e as { message?: string }).message ?? '';
    const detail = code.startsWith('functions/') && message
      ? message.replace(/^functions\w*\s*/i, '').replace(/\(.*\)\s*$/, '').trim()
      : '';
    throw new Error(detail || failure);
  }
}

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
 * Post a sale through the `postJournal` function: the document, its line items,
 * a balanced journal entry and any upfront settlement are written in one
 * transaction, and the created rows come back mapped.
 */
export async function postSale(params: PostSaleParams): Promise<PostSaleResult> {
  const result = await callPost<{ document: Record<string, unknown>; entry: Record<string, unknown> }, PostSaleResult>(
    'postJournal',
    {
      business_id: params.businessId,
      kind: 'SALE',
      document: {
        date: params.date,
        customer_id: params.customerId ?? '',
        customer_name: params.customerName,
        invoice_number_requested: params.invoiceNumber ?? null,
        subtotal: params.subtotal,
        discount_total: params.discountTotal ?? 0,
        tax_amount: params.taxAmount ?? 0,
        total_amount: params.totalAmount,
        payment_method: params.paymentMethod ?? 'CASH',
        payment_terms_days: params.paymentTermsDays ?? 0,
        cost_of_goods: params.costOfGoods ?? null,
        notes: params.notes ?? null,
        settled_now: params.upfrontPaid ?? 0,
        items: params.items.map((item, idx) => ({
          line_no: item.lineNo ?? idx + 1,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          discount: item.discount ?? 0,
          total: item.total,
        })),
      },
    },
    ({ document, entry }) => toPostSaleResult({
      sale: document,
      items: (document.items as Array<Record<string, unknown>> | undefined) ?? null,
      journal_entry: entry,
      journal_lines: (entry.lines as Array<Record<string, unknown>> | undefined) ?? null,
      payment: (document.settlement_payment as Record<string, unknown> | null | undefined) ?? null,
    } satisfies DbPostSalePayload),
    'Failed to post sale invoice',
  );
  return result;
}

export type PostPurchaseItemInput = import('../lib/purchaseState').CloudPurchaseItemInput;
export type PostPurchaseParams = CloudPurchaseRequest;
export type PostPurchaseResult = PostedPurchaseResult;

/** Post a purchase through the `postJournal` function. */
export async function postPurchase(params: CloudPurchaseRequest): Promise<PostPurchaseResult> {
  return callPost<{ document: Record<string, unknown>; entry: Record<string, unknown> }, PostPurchaseResult>(
    'postJournal',
    {
      business_id: (params as unknown as { businessId: string }).businessId,
      kind: 'PURCHASE',
      document: {
        date: (params as unknown as { date: string }).date,
        supplier_id: (params as unknown as { supplierId?: string | null }).supplierId ?? '',
        supplier_name: (params as unknown as { supplierName: string }).supplierName,
        subtotal: (params as unknown as { subtotal: number }).subtotal,
        discount_total: (params as unknown as { discountTotal?: number }).discountTotal ?? 0,
        tax_amount: (params as unknown as { taxAmount?: number }).taxAmount ?? 0,
        total_amount: (params as unknown as { totalAmount: number }).totalAmount,
        payment_method: (params as unknown as { paymentMethod?: string }).paymentMethod ?? 'BANK',
        payment_terms_days: (params as unknown as { paymentTermsDays?: number }).paymentTermsDays ?? 0,
        notes: (params as unknown as { notes?: string | null }).notes ?? null,
        settled_now: (params as unknown as { upfrontPaid?: number }).upfrontPaid ?? 0,
        items: (params as unknown as { items: PostSaleItemInput[] }).items,
      },
    },
    ({ document, entry }) => toPostPurchaseResult({
      purchase: document,
      items: (document.items as Array<Record<string, unknown>> | undefined) ?? null,
      journal_entry: entry,
      journal_lines: (entry.lines as Array<Record<string, unknown>> | undefined) ?? null,
      payment: (document.settlement_payment as Record<string, unknown> | null | undefined) ?? null,
    } satisfies DbPostPurchasePayload),
    'Failed to post purchase',
  );
}

/** Post an expense through the `postJournal` function. */
export async function postExpense(params: CloudExpenseRequest): Promise<PostedExpenseResult> {
  return callPost<{ document: Record<string, unknown>; entry: Record<string, unknown> }, PostedExpenseResult>(
    'postJournal',
    {
      business_id: (params as unknown as { businessId: string }).businessId,
      kind: 'EXPENSE',
      document: {
        date: (params as unknown as { date: string }).date,
        category_name: (params as unknown as { categoryName?: string }).categoryName ?? 'Expense',
        category_account_code: (params as unknown as { categoryAccountCode?: string }).categoryAccountCode ?? '5010',
        description: (params as unknown as { description?: string }).description ?? '',
        amount: (params as unknown as { amount: number }).amount,
        tax_amount: (params as unknown as { taxAmount?: number }).taxAmount ?? 0,
        total_amount: (params as unknown as { totalAmount: number }).totalAmount,
        payment_method: (params as unknown as { paymentMethod?: string }).paymentMethod ?? 'CASH',
        reference_requested: null,
        notes: (params as unknown as { notes?: string | null }).notes ?? null,
      },
    },
    ({ document, entry }) => toPostExpenseResult({
      expense: document,
      journal_entry: entry,
      journal_lines: (entry.lines as Array<Record<string, unknown>> | undefined) ?? null,
    } satisfies DbPostExpensePayload),
    'Failed to post expense',
  );
}

/** Record a settlement through the `postJournal` function. */
export async function postPayment(params: CloudPaymentRequest): Promise<PostedPaymentResult> {
  return callPost<{ document: Record<string, unknown>; entry: Record<string, unknown> }, PostedPaymentResult>(
    'postJournal',
    {
      business_id: (params as unknown as { businessId: string }).businessId,
      kind: 'PAYMENT',
      document: {
        date: (params as unknown as { date: string }).date,
        amount: (params as unknown as { amount: number }).amount,
        direction: (params as unknown as { paymentType: string }).paymentType,
        payment_method: (params as unknown as { paymentMethod?: string }).paymentMethod ?? 'CASH',
        linked_sale_id: (params as unknown as { linkedSaleId?: string }).linkedSaleId ?? null,
        linked_purchase_id: (params as unknown as { linkedPurchaseId?: string }).linkedPurchaseId ?? null,
        party_id: (params as unknown as { partyId?: string }).partyId ?? '',
        party_name: (params as unknown as { partyName?: string }).partyName ?? '',
        bank_name: (params as unknown as { bankName?: string }).bankName ?? null,
        notes: (params as unknown as { notes?: string | null }).notes ?? null,
      },
    },
    ({ document, entry }) => toPostPaymentResult({
      payment: document,
      document: null,
      journal_entry: entry,
      journal_lines: (entry.lines as Array<Record<string, unknown>> | undefined) ?? null,
    } satisfies DbPostPaymentPayload),
    'Failed to record settlement',
  );
}

/** Void a settlement (voidDocument with kind PAYMENT). */
export async function voidPayment(params: CloudVoidPaymentRequest): Promise<VoidedPaymentResult> {
  const p = params as unknown as { businessId: string; paymentId: string; reason?: string };
  return callPost<{ reversal: Record<string, unknown>; original: Record<string, unknown>; payment: Record<string, unknown>; document: Record<string, unknown> | null }, VoidedPaymentResult>(
    'voidDocument',
    { business_id: p.businessId, kind: 'PAYMENT', document_id: p.paymentId, reason: p.reason ?? '' },
    ({ reversal, original, payment, document }) => toVoidPaymentResult({
      payment,
      document,
      original_journal_entry: original,
      reversal_journal_entry: reversal,
      reversal_journal_lines: (reversal.lines as Array<Record<string, unknown>> | undefined) ?? null,
    } satisfies DbVoidPaymentPayload),
    'Failed to void settlement',
  );
}

/** Void a document (sale, purchase or expense) through the `voidDocument` function. */
export async function voidDocument(params: CloudVoidRequest): Promise<VoidDocumentResult> {
  const p = params as unknown as { businessId: string; documentType: string; documentId: string; reason?: string };
  const kindMap: Record<string, 'SALE' | 'PURCHASE' | 'EXPENSE'> = {
    SALE: 'SALE', PURCHASE: 'PURCHASE', EXPENSE: 'EXPENSE',
  };
  return callPost<{ reversal: Record<string, unknown>; original: Record<string, unknown>; document: Record<string, unknown>; payment: Record<string, unknown> | null }, VoidDocumentResult>(
    'voidDocument',
    {
      business_id: p.businessId,
      kind: kindMap[p.documentType.toUpperCase()] ?? 'SALE',
      document_id: p.documentId,
      reason: p.reason ?? '',
    },
    ({ reversal, original, document, payment }) => toVoidDocumentResult(
      {
        document,
        original_journal_entry: original,
        reversal_journal_entry: reversal,
        reversal_journal_lines: (reversal.lines as Array<Record<string, unknown>> | undefined) ?? null,
        affected_payments: payment ? [payment] : null,
      } as unknown as DbVoidDocumentPayload,
      p.documentType.toLowerCase() as VoidableDocumentKind,
    ),
    'Failed to void document',
  );
}

/* -------------------------------------------------------------------------- */
/* Gateway transactions (server-to-server via the payment API)                  */
/* -------------------------------------------------------------------------- */

/**
 * Start an online collection.
 *
 * The payment API (Express server, port 4000) keeps this role: it signs the
 * provider payload with merchant secrets that must never ship to a browser.
 * It now verifies the caller's Firebase ID token and writes the gateway
 * document into Firestore through the Admin SDK.
 */
export async function initiateGatewayTxn(
  _params: import('../lib/gatewayState').CloudGatewayInitiateRequest,
): Promise<import('../lib/dbTypes').InitiatedGatewayTransaction> {
  throw new Error(
    'Online collections are served by the payment API. Deploy it with Firebase '
    + 'credentials (see FIREBASE_SETUP.md) and configure the payment API URL.',
  );
}

/** Settle a verified collection — served by the payment API, as above. */
export async function settleGatewayTxn(
  _params: import('../lib/gatewayState').CloudGatewaySettleRequest,
): Promise<import('../lib/dbTypes').GatewaySettlementResult> {
  throw new Error(
    'Online collections are served by the payment API. Deploy it with Firebase '
    + 'credentials (see FIREBASE_SETUP.md) and configure the payment API URL.',
  );
}
