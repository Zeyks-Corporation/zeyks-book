/**
 * Snake_case ↔ camelCase mappers for Postgres database rows.
 *
 * The database uses snake_case column names. The app uses camelCase.
 * These pure functions convert between the two representations.
 */

import type {
  Account, BusinessProfile, ControlIntegrity, Customer, Expense, GatewayTransaction,
  JournalEntry, JournalLine, LineItem, Payment, Purchase, Sale, Supplier,
} from '../types';
import { assertIsoDate } from './nepaliDate';

/* -------------------------------------------------------------------------- */
/* The schema contract                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A persisted date column that the application cannot work without.
 *
 * Why this throws instead of defaulting: the deployed application once ran
 * against a database that was a migration behind, so `sales` and `purchases`
 * had no `due_date`. The loader reads rows with `select('*')`, which does not
 * complain about a column the database does not have — the key is simply not
 * there — so every document arrived with `dueDate: undefined`. That value then
 * reached a date parser during the *reports* render and the app died with
 * `Cannot read properties of undefined (reading 'split')`, pointing at a
 * formatter rather than at the real problem: application and schema were on
 * different versions.
 *
 * A row that cannot be interpreted is a deployment problem, and it is reported
 * as one: the whole load fails, the person sees which column is missing and
 * which migration adds it, and no screen renders a figure derived from a
 * half-read document. Nothing is written, and no client-side guess is invented
 * to paper over the gap.
 */
function persistedDate(value: unknown, table: string, column: string): string {
  try {
    return assertIsoDate(value, `${table}.${column}`);
  } catch {
    throw new Error(
      `The database returned ${table}.${column} as `
      + `${value === undefined ? 'no value at all' : value === null ? 'NULL' : JSON.stringify(value)}. `
      + `Zeyks Book cannot compute a document's due date or age what it outstanding without it, `
      + `so the book was not opened. This means this project's schema is behind the deployed `
      + `application: update the backend to the repository's current release `
      + `adds ${table}.${column}). Nothing has been changed.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Control-account integrity (migration 014)                                   */
/* -------------------------------------------------------------------------- */

/** One row of public.control_account_integrity(). */
export interface DbControlIntegrityRow {
  business_id: string;
  receivable_control: number | string;
  receivable_documents: number | string;
  receivable_difference: number | string;
  receivable_status: string;
  payable_control: number | string;
  payable_documents: number | string;
  payable_difference: number | string;
  payable_status: string;
}

function numeric(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map one diagnostic row onto the app's shape.
 *
 * `ok` is taken from the database's status column rather than recomputed from
 * the two figures: migration 014 exists so the database decides, and the client
 * reports. Re-deriving it here would put the comparison back in the browser,
 * which is the thing Stage 16 moved out.
 */
export function toControlIntegrity(row: DbControlIntegrityRow): ControlIntegrity {
  return {
    receivable: {
      control: numeric(row.receivable_control),
      documents: numeric(row.receivable_documents),
      difference: numeric(row.receivable_difference),
      ok: row.receivable_status === 'OK',
    },
    payable: {
      control: numeric(row.payable_control),
      documents: numeric(row.payable_documents),
      difference: numeric(row.payable_difference),
      ok: row.payable_status === 'OK',
    },
  };
}

/**
 * Read the frozen `upfront_paid` column.
 *
 * The value is carried as a *snapshot* — the historical record of what the
 * document said it had received when it was posted — and is deliberately kept
 * out of `paidAmount`, which `reconcile()` derives from the settlement rows.
 * Naming it `postingSnapshot` is what stops a future reader treating it as a
 * balance: no arithmetic that produces money reads this field.
 */
function postingSnapshot(row: Record<string, unknown>): { upfrontPaid: number } {
  const raw = row.upfront_paid ?? row.upfrontPaid;
  const value = Number(raw ?? 0);
  return { upfrontPaid: Number.isFinite(value) ? value : 0 };
}

/* -------------------------------------------------------------------------- */
/* Generic helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Convert a snake_case string to camelCase. */
function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Convert all keys of a flat object from snake_case to camelCase. */
function camelKeys<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[toCamel(k)] = v;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Business                                                                    */
/* -------------------------------------------------------------------------- */

export interface DbBusiness {
  id: string;
  created_by: string;
  business_name: string;
  owner_name: string;
  email: string;
  phone: string;
  pan_number: string;
  address: string;
  city: string;
  currency: 'NPR';
  currency_symbol: 'NPR' | 'रू';
  timezone: 'Asia/Kathmandu';
  fiscal_year_start_month: number;
  vat_registered: boolean;
  vat_rate: number;
  track_inventory: boolean;
  created_at: string;
}

export function toBusinessProfile(row: DbBusiness): BusinessProfile {
  return {
    id: row.id,
    userId: row.created_by,
    businessName: row.business_name,
    ownerName: row.owner_name,
    email: row.email,
    phone: row.phone,
    panNumber: row.pan_number,
    address: row.address,
    city: row.city,
    currency: row.currency,
    currencySymbol: row.currency_symbol,
    timezone: row.timezone,
    fiscalYearStartMonth: row.fiscal_year_start_month,
    vatRegistered: row.vat_registered,
    vatRate: row.vat_rate ?? 13,
    trackInventory: row.track_inventory,
    createdAt: row.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Account                                                                     */
/* -------------------------------------------------------------------------- */

export function toAccount(row: Record<string, unknown>): Account {
  const c = camelKeys(row);
  return {
    id: c.id as string,
    businessId: c.businessId as string,
    code: c.code as string,
    name: c.name as string,
    type: c.type as Account['type'],
    description: (c.description as string) ?? undefined,
    isActive: c.isActive as boolean,
    systemAccount: (c.systemAccount as boolean) ?? false,
  };
}

/* -------------------------------------------------------------------------- */
/* Parties                                                                     */
/* -------------------------------------------------------------------------- */

export function toCustomer(row: Record<string, unknown>): Customer {
  const c = camelKeys(row);
  return {
    id: c.id as string,
    businessId: c.businessId as string,
    name: c.name as string,
    email: (c.email as string) ?? undefined,
    phone: (c.phone as string) ?? undefined,
    panNumber: (c.panNumber as string) ?? undefined,
    address: (c.address as string) ?? undefined,
    createdAt: c.createdAt as string,
  };
}

export function toSupplier(row: Record<string, unknown>): Supplier {
  // Same shape as Customer.
  return toCustomer(row) as Supplier;
}

/* -------------------------------------------------------------------------- */
/* Line items (sale_items / purchase_items)                                     */
/* -------------------------------------------------------------------------- */

export function toLineItem(row: Record<string, unknown>): LineItem {
  const c = camelKeys(row);
  return {
    id: c.id as string,
    description: (c.description as string) ?? '',
    quantity: Number(c.quantity),
    unitPrice: Number(c.unitPrice),
    discount: Number(c.discount ?? 0),
    total: Number(c.total),
  };
}

/* -------------------------------------------------------------------------- */
/* Sale                                                                        */
/* -------------------------------------------------------------------------- */

export function toSale(row: Record<string, unknown>, items: LineItem[]): Sale {
  const c = camelKeys(row);
  return {
    id: c.id as string,
    businessId: c.businessId as string,
    date: c.date as string,
    // The agreed terms and the contractual due date they imply, both recorded by
    // post_sale inside the posting transaction. The due date is READ, never
    // computed here: one rule in one place is what keeps a reprinted invoice and
    // the aging report saying the same thing.
    paymentTermsDays: Number(c.paymentTermsDays ?? 0),
    dueDate: persistedDate(c.dueDate, 'sales', 'due_date'),
    items,
    subtotal: Number(c.subtotal),
    discountTotal: Number(c.discountTotal ?? 0),
    taxAmount: Number(c.taxAmount ?? 0),
    totalAmount: Number(c.totalAmount),
    // `upfront_paid` is deliberately NOT read into a balance. The settlement
    // made at posting time is a row in `payments` (post_sale writes it), so
    // reconcile() sums the rows and paidAmount stays 0 until it has. Reading
    // the column as well would be the second source of truth this build has
    // none of. It is carried separately, as the snapshot it is, for the
    // reprinted document view.
    paidAmount: 0,
    postingSnapshot: postingSnapshot(row),
    paymentStatus: 'UNPAID',
    paymentMethod: c.paymentMethod as Sale['paymentMethod'],
    status: c.status as Sale['status'],
    notes: (c.notes as string) ?? undefined,
    journalEntryId: c.journalEntryId as string,
    createdAt: c.createdAt as string,
    createdBy: c.createdBy as string,
    invoiceNumber: c.invoiceNumber as string,
    customerId: c.customerId as string,
    customerName: c.customerName as string,
    costOfGoods: c.costOfGoods != null ? Number(c.costOfGoods) : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Purchase                                                                    */
/* -------------------------------------------------------------------------- */

export function toPurchase(row: Record<string, unknown>, items: LineItem[]): Purchase {
  const c = camelKeys(row);
  return {
    id: c.id as string,
    businessId: c.businessId as string,
    date: c.date as string,
    // Same rule as sales: the terms and the due date come from post_purchase and
    // the reporting layer reads the date rather than working one out.
    paymentTermsDays: Number(c.paymentTermsDays ?? 0),
    dueDate: persistedDate(c.dueDate, 'purchases', 'due_date'),
    items,
    subtotal: Number(c.subtotal),
    discountTotal: Number(c.discountTotal ?? 0),
    taxAmount: Number(c.taxAmount ?? 0),
    totalAmount: Number(c.totalAmount),
    // Same rule as sales: the supplier settlement made at posting time is a
    // `payments` row, so the frozen `upfront_paid` column is not read into a
    // balance — it is carried as the historical snapshot, and paidAmount is 0
    // until reconcile() has summed the rows.
    paidAmount: 0,
    postingSnapshot: postingSnapshot(row),
    paymentStatus: 'UNPAID',
    paymentMethod: c.paymentMethod as Purchase['paymentMethod'],
    status: c.status as Purchase['status'],
    notes: (c.notes as string) ?? undefined,
    journalEntryId: c.journalEntryId as string,
    createdAt: c.createdAt as string,
    createdBy: c.createdBy as string,
    referenceNumber: c.referenceNumber as string,
    supplierId: c.supplierId as string,
    supplierName: c.supplierName as string,
  };
}

/* -------------------------------------------------------------------------- */
/* Expense                                                                     */
/* -------------------------------------------------------------------------- */

export function toExpense(row: Record<string, unknown>): Expense {
  const c = camelKeys(row);
  return {
    id: c.id as string,
    businessId: c.businessId as string,
    accountId: c.accountId as string,
    categoryName: c.categoryName as string,
    date: c.date as string,
    description: c.description as string,
    amount: Number(c.amount),
    taxAmount: Number(c.taxAmount ?? 0),
    totalAmount: Number(c.totalAmount),
    paymentMethod: c.paymentMethod as Expense['paymentMethod'],
    reference: c.reference as string,
    status: c.status as Expense['status'],
    notes: (c.notes as string) ?? undefined,
    journalEntryId: c.journalEntryId as string,
    createdAt: c.createdAt as string,
    createdBy: c.createdBy as string,
  };
}

/* -------------------------------------------------------------------------- */
/* Payment                                                                     */
/* -------------------------------------------------------------------------- */

export function toPayment(row: Record<string, unknown>): Payment {
  const c = camelKeys(row);
  return {
    id: c.id as string,
    businessId: c.businessId as string,
    amount: Number(c.amount),
    paymentMethod: c.paymentMethod as Payment['paymentMethod'],
    date: c.date as string,
    reference: c.reference as string,
    bankName: (c.bankName as string) ?? undefined,
    status: c.status as Payment['status'],
    paymentType: c.paymentType as Payment['paymentType'],
    linkedSaleId: (c.linkedSaleId as string) ?? undefined,
    linkedPurchaseId: (c.linkedPurchaseId as string) ?? undefined,
    partyId: (c.partyId as string) ?? undefined,
    partyName: c.partyName as string,
    gatewayTransactionId: (c.gatewayTransactionId as string) ?? undefined,
    docStatus: c.docStatus as Payment['docStatus'],
    notes: (c.notes as string) ?? undefined,
    journalEntryId: c.journalEntryId as string,
    createdAt: c.createdAt as string,
    createdBy: c.createdBy as string,
  };
}

/* -------------------------------------------------------------------------- */
/* Gateway transaction                                                         */
/* -------------------------------------------------------------------------- */

export function toGatewayTransaction(row: Record<string, unknown>): GatewayTransaction {
  const c = camelKeys(row);
  return {
    id: c.id as string,
    businessId: c.businessId as string,
    provider: c.provider as GatewayTransaction['provider'],
    gatewayRef: c.gatewayRef as string,
    gatewayTransactionId: (c.gatewayTransactionId as string) ?? undefined,
    amount: Number(c.amount),
    currency: (c.currency as string) ?? 'NPR',
    status: c.status as GatewayTransaction['status'],
    verifiedAt: (c.verifiedAt as string) ?? undefined,
    linkedSaleId: (c.linkedSaleId as string) ?? undefined,
    customerName: (c.customerName as string) ?? '',
    paymentId: (c.paymentId as string) ?? undefined,
    initiatedBy: (c.initiatedBy as string) ?? undefined,
    initiatedAt: c.initiatedAt as string,
    settledAt: (c.settledAt as string) ?? undefined,
    lastError: (c.lastError as string) ?? undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Gateway RPC payloads (migrations 011 and 012)                               */
/* -------------------------------------------------------------------------- */

/** Shape returned by public.initiate_gateway_txn() (migration 011). */
export interface DbGatewayInitiatePayload {
  gateway_transaction: Record<string, unknown>;
  /** The invoice the collection is linked to (it is mandatory). */
  document?: Record<string, unknown> | null;
  settlement_state?: string | null;
  /** True when the identical reference was already recorded. */
  replayed?: boolean;
}

export interface InitiatedGatewayTransaction {
  gatewayTransaction: GatewayTransaction;
  document: Sale | null;
  replayed: boolean;
}

/**
 * Map the initiate RPC payload to app types.
 *
 * The returned row is the persisted one, so nothing is echoed from the request:
 * the collection id, its status and its initiator all come from the database.
 */
export function toGatewayInitiateResult(payload: DbGatewayInitiatePayload): InitiatedGatewayTransaction {
  const doc = payload.document ?? null;
  return {
    gatewayTransaction: toGatewayTransaction(payload.gateway_transaction),
    document: doc === null ? null : toSale(doc, []),
    replayed: payload.replayed === true,
  };
}

/** Shape returned by public.settle_gateway_txn() (migration 012). */
export interface DbGatewaySettlementPayload {
  /** SETTLED | ALREADY_SETTLED | NOT_VERIFIED. */
  outcome: string;
  settled: boolean;
  settlement_state?: string | null;
  reason?: string | null;
  gateway_transaction: Record<string, unknown>;
  payment?: Record<string, unknown> | null;
  document?: Record<string, unknown> | null;
  journal_entry?: Record<string, unknown> | null;
  journal_lines?: Array<Record<string, unknown>> | null;
}

export interface GatewaySettlementResult {
  outcome: 'SETTLED' | 'ALREADY_SETTLED' | 'NOT_VERIFIED';
  settled: boolean;
  settlementState: 'UNSETTLED' | 'SETTLED' | 'VOIDED';
  reason: string | null;
  gatewayTransaction: GatewayTransaction;
  /** Present when the collection is settled (this call or an earlier one). */
  payment: Payment | null;
  document: Sale | null;
  journalEntry: JournalEntry | null;
  journalLines: JournalLine[];
}

/**
 * Map the settle RPC payload to app types.
 *
 * Nothing is guessed: when the database reports NOT_VERIFIED there is no
 * payment, no document and no journal, and this mapping keeps them null rather
 * than inventing placeholders the UI could render as money.
 */
export function toGatewaySettlementResult(payload: DbGatewaySettlementPayload): GatewaySettlementResult {
  const outcome = payload.outcome === 'SETTLED' || payload.outcome === 'ALREADY_SETTLED'
    ? payload.outcome
    : 'NOT_VERIFIED';
  const state = payload.settlement_state === 'SETTLED' || payload.settlement_state === 'VOIDED'
    ? payload.settlement_state
    : 'UNSETTLED';

  const journalLines = (payload.journal_lines ?? []).map((r) => toJournalLine(r));
  const payment = payload.payment ? toPayment(payload.payment) : null;
  const doc = payload.document ?? null;

  return {
    outcome,
    settled: payload.settled === true,
    settlementState: state,
    reason: (payload.reason as string) ?? null,
    gatewayTransaction: toGatewayTransaction(payload.gateway_transaction),
    payment,
    document: doc === null ? null : toSale(doc, []),
    journalEntry: payload.journal_entry
      ? toJournalEntry(payload.journal_entry, journalLines)
      : null,
    journalLines,
  };
}

/* -------------------------------------------------------------------------- */
/* Journal                                                                     */
/* -------------------------------------------------------------------------- */

export function toJournalLine(row: Record<string, unknown>): JournalLine {
  const c = camelKeys(row);
  return {
    id: c.id as string,
    journalEntryId: c.journalEntryId as string,
    accountId: c.accountId as string,
    accountName: c.accountName as string,
    accountType: c.accountType as JournalLine['accountType'],
    debit: Number(c.debit ?? 0),
    credit: Number(c.credit ?? 0),
  };
}

export function toJournalEntry(
  row: Record<string, unknown>,
  lines: JournalLine[],
): JournalEntry {
  const c = camelKeys(row);
  return {
    id: c.id as string,
    businessId: c.businessId as string,
    transactionDate: c.transactionDate as string,
    sequence: Number(c.sequence),
    description: c.description as string,
    reference: c.reference as string,
    sourceType: c.sourceType as JournalEntry['sourceType'],
    sourceId: (c.sourceId as string) ?? undefined,
    lines,
    reversesEntryId: (c.reversesEntryId as string) ?? undefined,
    reversedByEntryId: (c.reversedByEntryId as string) ?? undefined,
    createdBy: c.createdBy as string,
    createdAt: c.createdAt as string,
  };
}

/* -------------------------------------------------------------------------- */
/* Business settings write patch                                               */
/* -------------------------------------------------------------------------- */

/**
 * The subset of a business the client is allowed to change. These are exactly
 * the columns 002 grants UPDATE on; the OWNER RLS policy is the real gate.
 */
export interface BusinessSettingsPatch {
  businessName?: string;
  ownerName?: string;
  email?: string;
  phone?: string;
  panNumber?: string;
  address?: string;
  city?: string;
  currencySymbol?: 'NPR' | 'रू';
  fiscalYearStartMonth?: number;
  vatRegistered?: boolean;
  vatRate?: number;
  trackInventory?: boolean;
}

/**
 * Map a camelCase settings patch to snake_case, dropping every key the client
 * may not write. Anything absent from the update stays as-is in the database.
 */
export function toBusinessUpdate(patch: BusinessSettingsPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.businessName !== undefined) out.business_name = patch.businessName;
  if (patch.ownerName !== undefined) out.owner_name = patch.ownerName;
  if (patch.email !== undefined) out.email = patch.email;
  if (patch.phone !== undefined) out.phone = patch.phone;
  if (patch.panNumber !== undefined) out.pan_number = patch.panNumber;
  if (patch.address !== undefined) out.address = patch.address;
  if (patch.city !== undefined) out.city = patch.city;
  if (patch.currencySymbol !== undefined) out.currency_symbol = patch.currencySymbol;
  if (patch.fiscalYearStartMonth !== undefined) out.fiscal_year_start_month = patch.fiscalYearStartMonth;
  if (patch.vatRegistered !== undefined) out.vat_registered = patch.vatRegistered;
  if (patch.vatRate !== undefined) out.vat_rate = patch.vatRate;
  if (patch.trackInventory !== undefined) out.track_inventory = patch.trackInventory;
  return out;
}

/* -------------------------------------------------------------------------- */
/* post_sale RPC payload                                                       */
/* -------------------------------------------------------------------------- */

/** Shape returned by public.post_sale() (migration 005). */
export interface DbPostSalePayload {
  sale: Record<string, unknown>;
  /** NOTE: the RPC key is `items`, not `sale_items`. */
  items?: Array<Record<string, unknown>> | null;
  journal_entry: Record<string, unknown>;
  journal_lines?: Array<Record<string, unknown>> | null;
  payment?: Record<string, unknown> | null;
}

export interface PostedSaleResult {
  sale: Sale;
  saleItems: LineItem[];
  journalEntry: JournalEntry;
  journalLines: JournalLine[];
  payment?: Payment;
}

/**
 * Map the post_sale RPC payload to app types.
 *
 * Reads the `items` key the RPC actually returns so a newly posted invoice's
 * line items are present immediately, without waiting for a refresh.
 */
export function toPostSaleResult(payload: DbPostSalePayload): PostedSaleResult {
  const saleItems = (payload.items ?? []).map((r) => toLineItem(r));
  const sale = toSale(payload.sale, saleItems);
  const journalLines = (payload.journal_lines ?? []).map((r) => toJournalLine(r));
  const journalEntry = toJournalEntry(payload.journal_entry, journalLines);
  const payment = payload.payment ? toPayment(payload.payment) : undefined;
  return { sale, saleItems, journalEntry, journalLines, payment };
}

/* -------------------------------------------------------------------------- */
/* post_purchase RPC payload                                                   */
/* -------------------------------------------------------------------------- */

/** Shape returned by public.post_purchase() (migration 006). */
export interface DbPostPurchasePayload {
  purchase: Record<string, unknown>;
  /** NOTE: the RPC key is `items`, matching post_sale. */
  items?: Array<Record<string, unknown>> | null;
  journal_entry: Record<string, unknown>;
  journal_lines?: Array<Record<string, unknown>> | null;
  payment?: Record<string, unknown> | null;
}

export interface PostedPurchaseResult {
  purchase: Purchase;
  purchaseItems: LineItem[];
  journalEntry: JournalEntry;
  journalLines: JournalLine[];
  payment?: Payment;
}

/** Map the post_purchase RPC payload to app types, items included. */
export function toPostPurchaseResult(payload: DbPostPurchasePayload): PostedPurchaseResult {
  const purchaseItems = (payload.items ?? []).map((r) => toLineItem(r));
  const purchase = toPurchase(payload.purchase, purchaseItems);
  const journalLines = (payload.journal_lines ?? []).map((r) => toJournalLine(r));
  const journalEntry = toJournalEntry(payload.journal_entry, journalLines);
  const payment = payload.payment ? toPayment(payload.payment) : undefined;
  return { purchase, purchaseItems, journalEntry, journalLines, payment };
}

/* -------------------------------------------------------------------------- */
/* post_expense RPC payload                                                    */
/* -------------------------------------------------------------------------- */

/** Shape returned by public.post_expense() (migration 007). */
export interface DbPostExpensePayload {
  expense: Record<string, unknown>;
  journal_entry: Record<string, unknown>;
  journal_lines?: Array<Record<string, unknown>> | null;
}

export interface PostedExpenseResult {
  expense: Expense;
  journalEntry: JournalEntry;
  journalLines: JournalLine[];
}

/**
 * Map the post_expense RPC payload to app types.
 *
 * An expense has no line items and no settlement row, so unlike sales and
 * purchases there is nothing to assemble beyond the document and its journal.
 */
export function toPostExpenseResult(payload: DbPostExpensePayload): PostedExpenseResult {
  const journalLines = (payload.journal_lines ?? []).map((r) => toJournalLine(r));
  const journalEntry = toJournalEntry(payload.journal_entry, journalLines);
  return { expense: toExpense(payload.expense), journalEntry, journalLines };
}

/* -------------------------------------------------------------------------- */
/* post_payment RPC payload                                                    */
/* -------------------------------------------------------------------------- */

/** Shape returned by public.post_payment() (migration 009). */
export interface DbPostPaymentPayload {
  payment: Record<string, unknown>;
  /**
   * The settled sale or purchase row. Returned for cross-checking only: it is
   * not restated with its line items, so it never replaces the document already
   * in state.
   */
  document?: Record<string, unknown> | null;
  journal_entry: Record<string, unknown>;
  journal_lines?: Array<Record<string, unknown>> | null;
}

export interface PostedPaymentResult {
  payment: Payment;
  /** The settled document, without line items restated. */
  document: Sale | Purchase | null;
  journalEntry: JournalEntry;
  journalLines: JournalLine[];
}

/**
 * Map the post_payment RPC payload to app types.
 *
 * The direction of the persisted payment decides how the settled document is
 * mapped: an INCOMING settlement belongs to a sale, an OUTGOING one to a
 * purchase. It is mapped without line items because the payload does not carry
 * them, and `applyPostedPayment` never uses it to replace state.
 */
export function toPostPaymentResult(payload: DbPostPaymentPayload): PostedPaymentResult {
  const journalLines = (payload.journal_lines ?? []).map((r) => toJournalLine(r));
  const payment = toPayment(payload.payment);
  const doc = payload.document ?? null;
  const document = doc === null
    ? null
    : payment.paymentType === 'INCOMING'
      ? toSale(doc, [])
      : toPurchase(doc, []);
  return {
    payment,
    document,
    journalEntry: toJournalEntry(payload.journal_entry, journalLines),
    journalLines,
  };
}

/* -------------------------------------------------------------------------- */
/* void_payment RPC payload                                                    */
/* -------------------------------------------------------------------------- */

/** Shape returned by public.void_payment() (migration 010). */
export interface DbVoidPaymentPayload {
  /** The same settlement row, now VOIDED. */
  payment: Record<string, unknown>;
  /** The sale or purchase it settled, returned unchanged and still POSTED. */
  document?: Record<string, unknown> | null;
  original_journal_entry: Record<string, unknown>;
  reversal_journal_entry: Record<string, unknown>;
  reversal_journal_lines?: Array<Record<string, unknown>> | null;
}

export interface VoidedPaymentResult {
  payment: Payment;
  document: Sale | Purchase | null;
  /** Carries reversedByEntryId; its own lines never change, so they are not resent. */
  originalJournalEntry: JournalEntry;
  reversalJournalEntry: JournalEntry;
  reversalJournalLines: JournalLine[];
}

/**
 * Map the void_payment RPC payload to app types.
 *
 * The original entry is mapped without its lines because the payload does not
 * restate them: they are immutable and already in state, so
 * `applyVoidedPayment` carries over the reversal link rather than blanking them.
 */
export function toVoidPaymentResult(payload: DbVoidPaymentPayload): VoidedPaymentResult {
  const reversalJournalLines = (payload.reversal_journal_lines ?? []).map((r) => toJournalLine(r));
  const payment = toPayment(payload.payment);
  const doc = payload.document ?? null;
  const document = doc === null
    ? null
    : payment.paymentType === 'INCOMING'
      ? toSale(doc, [])
      : toPurchase(doc, []);
  return {
    payment,
    document,
    originalJournalEntry: toJournalEntry(payload.original_journal_entry, []),
    reversalJournalEntry: toJournalEntry(payload.reversal_journal_entry, reversalJournalLines),
    reversalJournalLines,
  };
}

/* -------------------------------------------------------------------------- */
/* void_document RPC payload                                                   */
/* -------------------------------------------------------------------------- */

/** Shape returned by public.void_document() (migration 008). */
export interface DbVoidDocumentPayload {
  document: Record<string, unknown>;
  original_journal_entry: Record<string, unknown>;
  reversal_journal_entry: Record<string, unknown>;
  reversal_journal_lines?: Array<Record<string, unknown>> | null;
  affected_payments?: Array<Record<string, unknown>> | null;
}

export type VoidableDocumentKind = 'sale' | 'purchase' | 'expense';

export interface VoidDocumentResult {
  /** The same document, now VOIDED. Its line items are not restated. */
  document: Sale | Purchase | Expense;
  /** Carries reversedByEntryId; its lines never change, so they are not resent. */
  originalJournalEntry: JournalEntry;
  reversalJournalEntry: JournalEntry;
  reversalJournalLines: JournalLine[];
  affectedPayments: Payment[];
}

/**
 * Map the void_document RPC payload to app types.
 *
 * The document is mapped without line items because the payload does not carry
 * them: they never change on a void, and `applyVoidedDocument` keeps the ones
 * already in state rather than blanking them.
 */
export function toVoidDocumentResult(
  payload: DbVoidDocumentPayload,
  kind: VoidableDocumentKind,
): VoidDocumentResult {
  const reversalJournalLines = (payload.reversal_journal_lines ?? []).map((r) => toJournalLine(r));
  const document = kind === 'sale'
    ? toSale(payload.document, [])
    : kind === 'purchase'
      ? toPurchase(payload.document, [])
      : toExpense(payload.document);
  return {
    document,
    originalJournalEntry: toJournalEntry(payload.original_journal_entry, []),
    reversalJournalEntry: toJournalEntry(payload.reversal_journal_entry, reversalJournalLines),
    reversalJournalLines,
    affectedPayments: (payload.affected_payments ?? []).map((r) => toPayment(r)),
  };
}
