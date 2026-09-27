/**
 * Report and document data shaping.
 *
 * Pure functions only — no React, no auth SDK, no formatting of
 * currency symbols. The accounting *truth* stays where it already was:
 * `accountingEngine` computes every statement, `posting` owns the one
 * settlement sum, and `reconcile` already writes `paidAmount` from those rows.
 * What lives here is the presentation-side shaping that several places need at
 * once — report rows, filters, period labels, and the settlement summary a
 * printed document shows.
 *
 * Two rules this module exists to keep:
 *
 *  1. Outstanding is always `Total − SUM(COMPLETED + POSTED settlement rows)`.
 *     Every figure below comes from `linkedSettlementTotal` + `outstandingOn`;
 *     nothing derives money from `postingSnapshot`, which is the frozen
 *     posting-time record kept for historical document presentation only.
 *  2. No figure is invented. A period with no rows yields empty rows and zero
 *     totals — never a placeholder, an average or a sample.
 */

import {
  Account, DateRange, Expense, JournalEntry, LineItem, Payment, PaymentMethod,
  PaymentStatus, Purchase, Sale,
} from '../types';
import { round2 } from '../lib/money';
import { adToBs, assertIsoDate, formatAd, formatBs, isWithin } from '../lib/nepaliDate';
import { AccountingEngine, isLiquidAccount } from './accountingEngine';
import { linkedSettlementTotal, outstandingOn, statusFor } from './posting';

/** A key/value line the sheet header prints (period bounds, filters applied). */
export interface ReportMetaRow {
  label: string;
  value: string;
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                     */
/* -------------------------------------------------------------------------- */

export interface ReportFilters {
  /** Customer for the sales report, supplier for the purchase report. */
  partyId?: string;
  /** Expense category account for the expense report. */
  categoryId?: string;
  /** Single account for the general ledger. */
  accountId?: string;
}

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * The filter lists a report offers.
 *
 * Built from the persisted documents, not from the chart of accounts: offering
 * a customer with no transactions would invite someone to filter a report down
 * to nothing and wonder whether the filter was broken.
 */
export function partyFilterOptions(
  docs: (Pick<Sale, 'customerId' | 'customerName'> | Pick<Purchase, 'supplierId' | 'supplierName'>)[],
): FilterOption[] {
  const seen = new Map<string, string>();
  for (const doc of docs) {
    const id = 'customerId' in doc ? doc.customerId : doc.supplierId;
    const name = 'customerName' in doc ? doc.customerName : doc.supplierName;
    if (!id) continue;
    if (!seen.has(id)) seen.set(id, name || id);
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export interface PartyBalanceRow {
  id: string;
  name: string;
  amount: number;
}

export interface PartyBalanceList {
  /** The largest balances, at most `limit` of them. */
  rows: PartyBalanceRow[];
  /** The total across **every** party with a balance, not just the shown ones. */
  total: number;
  /** How many parties the list is not showing. */
  hidden: number;
}

/**
 * Shape the derived party rollup for a person to read.
 *
 * `outstandingByParty` answers the accounting question (who is owed, and how
 * much); this decides what fits on a screen without losing anything: the rows
 * are ordered by size, the total counts parties that are not shown, and the
 * count of those is carried rather than silently dropping them. A party whose
 * row has not loaded is still shown under a placeholder name — money must never
 * disappear because a name is missing.
 */
export function outstandingParties(
  due: Map<string, number>,
  parties: { id: string; name: string }[],
  limit = 5,
): PartyBalanceList {
  const names = new Map(parties.map((p) => [p.id, p.name]));
  const rows = [...due.entries()]
    .map(([id, amount]) => ({ id, name: names.get(id) ?? 'Unknown party', amount: round2(amount) }))
    .filter((r) => r.amount > 0.005)
    .sort((a, b) => (b.amount - a.amount) || a.name.localeCompare(b.name));
  const total = round2(rows.reduce((sum, r) => sum + r.amount, 0));
  return { rows: rows.slice(0, limit), total, hidden: Math.max(0, rows.length - limit) };
}

export function categoryFilterOptions(expenses: Expense[]): FilterOption[] {
  const seen = new Map<string, string>();
  for (const e of expenses) {
    if (!e.accountId || seen.has(e.accountId)) continue;
    seen.set(e.accountId, e.categoryName || e.accountId);
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** A human label for the filter a report is currently showing, or null. */
export function filterSummary(
  filters: ReportFilters,
  options: { parties?: FilterOption[]; categories?: FilterOption[]; accounts?: Account[] },
): string | null {
  if (filters.partyId) {
    const found = options.parties?.find((o) => o.value === filters.partyId);
    return found ? found.label : filters.partyId;
  }
  if (filters.categoryId) {
    const found = options.categories?.find((o) => o.value === filters.categoryId);
    return found ? found.label : filters.categoryId;
  }
  if (filters.accountId) {
    const acc = options.accounts?.find((a) => a.id === filters.accountId);
    return acc ? `${acc.code} — ${acc.name}` : filters.accountId;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Period labelling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What the sheet says it covers.
 *
 * A statement never claims a period it did not actually filter on: an as-at
 * report says "As at", a ranged one names both ends, and the wording follows
 * the calendar the person is reading in.
 */
export function reportPeriodLabel(
  range: DateRange,
  calendar: 'BS' | 'AD',
  basis: 'period' | 'asOf',
): string {
  if (basis === 'asOf') {
    return calendar === 'BS'
      ? `As at ${formatBs(adToBs(range.to), 'long')} BS (${formatAd(range.to, 'long')})`
      : `As at ${formatAd(range.to, 'long')}`;
  }
  return calendar === 'BS'
    ? `${formatBs(adToBs(range.from), 'long')} to ${formatBs(adToBs(range.to), 'long')} BS`
    : `${formatAd(range.from, 'long')} to ${formatAd(range.to, 'long')}`;
}

/** The From/To lines under a header, in the calendar being read. */
export function reportRangeMeta(range: DateRange, calendar: 'BS' | 'AD'): ReportMetaRow[] {
  const one = (iso: string): string => (calendar === 'BS'
    ? `${formatBs(adToBs(iso))} BS`
    : formatAd(iso));
  return [
    { label: 'From', value: one(range.from) },
    { label: 'To', value: one(range.to) },
  ];
}

/* -------------------------------------------------------------------------- */
/* Document reports: sales, purchases, expenses                                */
/* -------------------------------------------------------------------------- */

/**
 * One line of a document report.
 *
 * `settled` and `outstanding` are derived from the settlement rows on every
 * build — never from a cached figure on the document and never from the
 * posting-time snapshot, which is a historical record, not a balance.
 */
export interface DocumentReportRow {
  id: string;
  date: string;
  reference: string;
  party: string;
  total: number;
  settled: number;
  outstanding: number;
  status: PaymentStatus;
  detail?: string;
  method?: PaymentMethod;
}

export interface DocumentReportSummary {
  rows: DocumentReportRow[];
  total: number;
  settled: number;
  outstanding: number;
  /** How many documents were left out because they are voided. */
  excludedVoided: number;
}

const byDateThenReference = (a: { date: string; reference: string }, b: { date: string; reference: string }): number =>
  a.date === b.date ? a.reference.localeCompare(b.reference) : a.date < b.date ? -1 : 1;

function summarise(rows: DocumentReportRow[], excludedVoided: number): DocumentReportSummary {
  let total = 0;
  let settled = 0;
  let outstanding = 0;
  for (const r of rows) {
    total += r.total;
    settled += r.settled;
    outstanding += r.outstanding;
  }
  return {
    rows,
    total: round2(total),
    settled: round2(settled),
    outstanding: round2(outstanding),
    excludedVoided,
  };
}

/** One row per POSTED sale in the period, chronologically. */
export function salesReport(
  sales: Sale[],
  payments: Payment[],
  range: DateRange,
  filters: ReportFilters = {},
): DocumentReportSummary {
  const rows: DocumentReportRow[] = [];
  let excludedVoided = 0;

  for (const sale of sales) {
    if (!isWithin(sale.date, range.from, range.to)) continue;
    if (filters.partyId && sale.customerId !== filters.partyId) continue;
    if (sale.status === 'VOIDED') { excludedVoided += 1; continue; }
    const settled = linkedSettlementTotal(payments, sale.id);
    rows.push({
      id: sale.id,
      date: sale.date,
      reference: sale.invoiceNumber,
      party: sale.customerName || 'Walk-in customer',
      total: sale.totalAmount,
      settled,
      outstanding: outstandingOn({ totalAmount: sale.totalAmount, paidAmount: settled }),
      status: statusFor(sale.totalAmount, settled),
      method: sale.paymentMethod,
    });
  }

  rows.sort(byDateThenReference);
  return summarise(rows, excludedVoided);
}

/** The purchase-side mirror of `salesReport`. */
export function purchaseReport(
  purchases: Purchase[],
  payments: Payment[],
  range: DateRange,
  filters: ReportFilters = {},
): DocumentReportSummary {
  const rows: DocumentReportRow[] = [];
  let excludedVoided = 0;

  for (const purchase of purchases) {
    if (!isWithin(purchase.date, range.from, range.to)) continue;
    if (filters.partyId && purchase.supplierId !== filters.partyId) continue;
    if (purchase.status === 'VOIDED') { excludedVoided += 1; continue; }
    const settled = linkedSettlementTotal(payments, purchase.id);
    rows.push({
      id: purchase.id,
      date: purchase.date,
      reference: purchase.referenceNumber,
      party: purchase.supplierName || 'Unknown supplier',
      total: purchase.totalAmount,
      settled,
      outstanding: outstandingOn({ totalAmount: purchase.totalAmount, paidAmount: settled }),
      status: statusFor(purchase.totalAmount, settled),
      method: purchase.paymentMethod,
    });
  }

  rows.sort(byDateThenReference);
  return summarise(rows, excludedVoided);
}

/**
 * Expenses have no payable: an expense is settled at the moment it is posted,
 * so there is no outstanding column and nothing to derive from settlements.
 */
export interface ExpenseReportRow {
  id: string;
  date: string;
  reference: string;
  category: string;
  description: string;
  method: PaymentMethod;
  amount: number;
}

export interface ExpenseReportSummary {
  rows: ExpenseReportRow[];
  total: number;
  excludedVoided: number;
}

export function expenseReport(
  expenses: Expense[],
  range: DateRange,
  filters: ReportFilters = {},
): ExpenseReportSummary {
  const rows: ExpenseReportRow[] = [];
  let excludedVoided = 0;

  for (const expense of expenses) {
    if (!isWithin(expense.date, range.from, range.to)) continue;
    if (filters.categoryId && expense.accountId !== filters.categoryId) continue;
    if (expense.status === 'VOIDED') { excludedVoided += 1; continue; }
    rows.push({
      id: expense.id,
      date: expense.date,
      reference: expense.reference,
      category: expense.categoryName,
      description: expense.description,
      method: expense.paymentMethod,
      amount: expense.totalAmount,
    });
  }

  rows.sort((a, b) => (a.date === b.date ? a.reference.localeCompare(b.reference) : a.date < b.date ? -1 : 1));
  return {
    rows,
    total: round2(rows.reduce((sum, r) => sum + r.amount, 0)),
    excludedVoided,
  };
}

/* -------------------------------------------------------------------------- */
/* Cash & bank movement, with a real running balance                           */
/* -------------------------------------------------------------------------- */

export interface CashBankMovementRow {
  date: string;
  reference: string;
  description: string;
  accountName: string;
  direction: 'INFLOW' | 'OUTFLOW';
  amount: number;
  balance: number;
}

/**
 * What the money accounts already held before the period opened.
 *
 * Read from posted journal lines dated before `from` — the same balances the
 * balance sheet would show — so the opening figure on a movement statement ties
 * back to the ledger instead of starting from a guess.
 */
export function cashBankOpeningBalance(
  accounts: Account[],
  entries: JournalEntry[],
  from: string,
): number {
  const before = entries.filter((e) => e.transactionDate < from);
  const balances = AccountingEngine.getAccountBalances(accounts, before);
  let total = 0;
  for (const account of accounts) {
    if (!isLiquidAccount(account.code)) continue;
    total += balances[account.id] ?? 0;
  }
  return round2(total);
}

/**
 * Turn the engine's movements (newest first) into a statement with a running
 * balance per row. The balance is accumulated oldest-to-newest — the only
 * direction that adds up — and the rows are handed back newest-first, which is
 * how a movement statement is read.
 */
export function cashBankMovement(
  movements: { date: string; reference: string; description: string; accountName: string; direction: 'INFLOW' | 'OUTFLOW'; amount: number }[],
  openingBalance: number,
): { rows: CashBankMovementRow[]; opening: number; closing: number; totalIn: number; totalOut: number } {
  const oldestFirst = [...movements].reverse();
  let running = round2(openingBalance);
  let totalIn = 0;
  let totalOut = 0;

  const rows: CashBankMovementRow[] = oldestFirst.map((m) => {
    if (m.direction === 'INFLOW') { running = round2(running + m.amount); totalIn += m.amount; }
    else { running = round2(running - m.amount); totalOut += m.amount; }
    return { ...m, balance: running };
  });

  return {
    rows: rows.reverse(),
    opening: round2(openingBalance),
    closing: running,
    totalIn: round2(totalIn),
    totalOut: round2(totalOut),
  };
}

/* -------------------------------------------------------------------------- */
/* One document: its settlements and its posting-time snapshot                 */
/* -------------------------------------------------------------------------- */

/** A settlement as a printed document lists it. */
export interface SettlementLine {
  id: string;
  date: string;
  reference: string;
  method: PaymentMethod;
  amount: number;
  /** True when the money came through eSewa or Khalti rather than by hand. */
  viaGateway: boolean;
}

/**
 * Every settlement that counts against one document, oldest first.
 *
 * The same predicate `linkedSettlementTotal` sums: COMPLETED and POSTED. A
 * voided settlement stays in the database as history but is not money, so it is
 * not listed as a settlement and it does not reduce the balance.
 */
export function settlementLines(payments: Payment[], documentId: string): SettlementLine[] {
  return payments
    .filter((p) => p.docStatus === 'POSTED' && p.status === 'COMPLETED')
    .filter((p) => p.linkedSaleId === documentId || p.linkedPurchaseId === documentId)
    .map((p) => ({
      id: p.id,
      date: p.date,
      reference: p.reference,
      method: p.paymentMethod,
      amount: p.amount,
      viaGateway: Boolean(p.gatewayTransactionId),
    }))
    .sort((a, b) => (a.date === b.date ? a.reference.localeCompare(b.reference) : a.date < b.date ? -1 : 1));
}

export interface DocumentPosition {
  total: number;
  /** Money that has actually moved, from the settlement rows. */
  settled: number;
  /** Total − settled. The current, live balance. */
  outstanding: number;
  /**
   * What was recorded as settled *when the document was posted*, exactly as the
   * database froze it. Historical presentation only: it is shown on a reprinted
   * document to reproduce the original, and is never added to or subtracted
   * from `settled`/`outstanding`.
   */
  snapshotUpfront: number;
  status: PaymentStatus | 'VOIDED';
  lines: SettlementLine[];
}

/**
 * A document's live position plus its historical snapshot, side by side but
 * never mixed: the balance comes from the rows, the snapshot only reproduces
 * what the document said on the day it was posted.
 */
export function documentPosition(
  doc: { id: string; totalAmount: number; status: string; postingSnapshot?: { upfrontPaid: number } },
  payments: Payment[],
): DocumentPosition {
  const settled = linkedSettlementTotal(payments, doc.id);
  return {
    total: doc.totalAmount,
    settled,
    outstanding: outstandingOn({ totalAmount: doc.totalAmount, paidAmount: settled }),
    snapshotUpfront: round2(doc.postingSnapshot?.upfrontPaid ?? 0),
    status: doc.status === 'VOIDED' ? 'VOIDED' : statusFor(doc.totalAmount, settled),
    lines: settlementLines(payments, doc.id),
  };
}

/* -------------------------------------------------------------------------- */
/* Status wording                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How a document's payment state is worded on paper. Derived state only: the
 * value comes from `reconcile`'s settlement-row sum, never from a stored flag.
 */
export function paymentStatusLabel(status: PaymentStatus | 'VOIDED'): string {
  switch (status) {
    case 'PAID': return 'PAID';
    case 'PARTIALLY_PAID': return 'PARTIAL';
    case 'UNPAID': return 'UNPAID';
    case 'VOIDED': return 'VOID';
    default: return String(status);
  }
}

export function paymentStatusTone(status: PaymentStatus | 'VOIDED'): 'ok' | 'warn' | 'neutral' {
  if (status === 'PAID') return 'ok';
  if (status === 'PARTIALLY_PAID') return 'warn';
  return 'neutral';
}

/** The lines of a document, always in the order they were entered. */
export function orderedItems(items: LineItem[]): LineItem[] {
  return [...items];
}

/** Line total recomputed for display, so a stored rounding slip cannot drift. */
export function lineTotal(item: LineItem): number {
  return round2(Math.max(0, item.quantity * item.unitPrice - (item.discount ?? 0)));
}

/* -------------------------------------------------------------------------- */
/* Aged receivables and payables                                              */
/* -------------------------------------------------------------------------- */

/**
 * The age buckets, in order.
 *
 * Boundaries are inclusive at both ends: `D1_30` holds ages 1 to 30, so the
 * 30th day late is still 1–30 and the 31st is the first day of `D31_60`. Age 0
 * — due today — is `NOT_DUE`, because a document is not overdue until the day
 * after it falls due.
 */
export const AGING_BUCKETS = ['NOT_DUE', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'] as const;
export type AgingBucket = typeof AGING_BUCKETS[number];

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  NOT_DUE: 'Not due',
  D1_30: '1–30 days',
  D31_60: '31–60 days',
  D61_90: '61–90 days',
  D90_PLUS: '90+ days',
};

/**
 * Whole days between two `YYYY-MM-DD` dates, in the Gregorian calendar.
 *
 * Arithmetic on the date parts through `Date.UTC` — never `new Date()` — so the
 * count cannot move with a timezone, a DST boundary or the machine clock. Aging
 * is a number of days, which is calendar-agnostic: the BS/AD toggle changes how
 * a date is written, not how many days have passed.
 */
export function daysBetween(from: string, to: string): number {
  return (isoDayNumber(to) - isoDayNumber(from)) / 86_400_000;
}

/** A `YYYY-MM-DD` date as a whole-day number.
 *
 * The date is *checked*, not defaulted. It used to carry defaults so a malformed
 * value could not produce `NaN` money — which quietly aged a document from
 * 1970-01-01 instead of saying anything. A date that is not a date is now
 * refused by `assertIsoDate` with the value named: a report that cannot state
 * its as-at date must not print a figure derived from a guess. */
function isoDayNumber(value: string): number {
  const iso = assertIsoDate(value, 'a date in an aged-balances calculation');
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

/**
 * The date a document falls due.
 *
 * THE PERSISTED CONTRACTUAL DATE — `sales.due_date` / `purchases.due_date`,
 * written by the posting RPC as the document date plus the terms agreed at
 * posting (migration 015) and held to that by a table constraint. Aging must be
 * a statement about how LATE payment is, so it counts from the date the money
 * was agreed to be paid, not from the day the paper was written.
 *
 * There is deliberately no fallback to the document date: a document that
 * arrives without one is a document the loader did not read, and quietly aging
 * it from its own date is exactly the confusion this column exists to end.
 * Documents posted before terms existed were migrated to 0 terms with
 * `due_date = date`, so a legacy row still reads correctly through this function
 * without any special case here.
 */
export function dueDateOn(doc: { dueDate: string }): string {
  // Read, not derived — and checked, because a document without its contractual
  // date cannot be aged. The message names the field rather than throwing from
  // inside a date parser. See the contract in lib/dbTypes.ts, which is what
  // keeps a due-date-less row from ever reaching this function.
  return assertIsoDate(doc.dueDate, 'a document’s due date');
}

/** Days past due on `asOf`. Never negative: a document due later is not due. */
export function ageInDays(doc: { dueDate: string }, asOf: string): number {
  return Math.max(0, daysBetween(dueDateOn(doc), asOf));
}

/**
 * Terms as a document states them: 0 is cash terms, anything else is Net N.
 *
 * The wording a reader expects on an invoice, in one place so the printed
 * document and the aging schedule cannot describe the same terms differently.
 */
export function termsLabel(days: number): string {
  return days > 0 ? `Net ${days}` : 'Due on receipt';
}

/** Which bucket an age falls in. The buckets are contiguous, so this is total. */
export function bucketForAge(age: number): AgingBucket {
  if (age <= 0) return 'NOT_DUE';
  if (age <= 30) return 'D1_30';
  if (age <= 60) return 'D31_60';
  if (age <= 90) return 'D61_90';
  return 'D90_PLUS';
}

export type AgingSide = 'RECEIVABLE' | 'PAYABLE';

/** One outstanding document, aged. */
export interface AgingRow {
  id: string;
  side: AgingSide;
  /** Invoice number or purchase reference. */
  reference: string;
  partyId: string;
  partyName: string;
  documentDate: string;
  /** The contractual due date; `ageDays` counts from here. */
  dueDate: string;
  /** Whole days of credit recorded at posting; 0 means due on receipt. */
  termsDays: number;
  total: number;
  settled: number;
  /** The only amount this row ages: total less every valid settlement. */
  outstanding: number;
  ageDays: number;
  bucket: AgingBucket;
  /** Derived payment state: UNPAID or PARTIALLY_PAID (paid rows are excluded). */
  status: PaymentStatus;
}

/**
 * The minimum a document must carry to be aged. `Sale` and `Purchase` satisfy
 * this, and so does a test fixture, which is what keeps the reporting layer
 * testable without a database.
 */
export interface AgingDocument {
  id: string;
  /** POSTED or VOIDED — the only two the database allows. */
  status: string;
  /** Invoice number or purchase reference. */
  reference: string;
  partyId: string;
  partyName: string;
  /** When the document was written; shown beside the due date, never aged on. */
  date: string;
  /** The contractual due date — what the buckets count from. */
  dueDate: string;
  /** Whole days of credit recorded at posting; 0 means due on receipt. */
  paymentTermsDays: number;
  totalAmount: number;
}

/**
 * A posted sale as the aging layer sees it.
 *
 * The register reports (`salesReport`, `purchaseReport`) and the aging report
 * therefore name the same document the same way, so a figure read off one sheet
 * can be found on the other. `upfront_paid` is not carried here at all: the
 * embedded settlement is already a linked payment row, and reading the snapshot
 * as well would count it twice.
 */
export function saleAgingDocuments(sales: Sale[]): AgingDocument[] {
  return sales.map((s) => ({
    id: s.id,
    status: s.status,
    reference: s.invoiceNumber,
    partyId: s.customerId,
    partyName: s.customerName || 'Walk-in customer',
    date: s.date,
    dueDate: s.dueDate,
    paymentTermsDays: s.paymentTermsDays,
    totalAmount: s.totalAmount,
  }));
}

/** The purchase side of `saleAgingDocuments`. */
export function purchaseAgingDocuments(purchases: Purchase[]): AgingDocument[] {
  return purchases.map((p) => ({
    id: p.id,
    status: p.status,
    reference: p.referenceNumber,
    partyId: p.supplierId,
    partyName: p.supplierName || 'Unknown supplier',
    date: p.date,
    dueDate: p.dueDate,
    paymentTermsDays: p.paymentTermsDays,
    totalAmount: p.totalAmount,
  }));
}

export interface AgingSummary {
  /** Total still outstanding across every bucket. */
  total: number;
  buckets: Record<AgingBucket, number>;
  /** The part of `total` that is past due — everything outside NOT_DUE. */
  overdue: number;
  /** How many documents the total is made of. */
  documents: number;
  /** What those documents were for, and what has already been settled against them. */
  invoiced: number;
  settled: number;
}

export interface AgingPartyRow {
  id: string;
  name: string;
  total: number;
  buckets: Record<AgingBucket, number>;
  documents: number;
}

export interface AgingView {
  side: AgingSide;
  asOf: string;
  rows: AgingRow[];
  summary: AgingSummary;
  byParty: AgingPartyRow[];
  /** The same rows the summary counted, before any display limit. */
  partyCount: number;
  /** Documents left out because nothing is outstanding on them any more. */
  settledCount: number;
  /** Voided documents left out entirely. */
  excludedVoided: number;
}

const emptyBuckets = (): Record<AgingBucket, number> => ({
  NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, D90_PLUS: 0,
});

/** Bucket totals for a set of rows: the one place those sums are taken. */
export function summariseAging(rows: AgingRow[]): AgingSummary {
  const buckets = emptyBuckets();
  let total = 0;
  let invoiced = 0;
  let settled = 0;
  for (const row of rows) {
    buckets[row.bucket] = round2(buckets[row.bucket] + row.outstanding);
    total = round2(total + row.outstanding);
    invoiced = round2(invoiced + row.total);
    settled = round2(settled + row.settled);
  }
  return {
    total,
    buckets,
    overdue: round2(AGING_BUCKETS
      .filter((b) => b !== 'NOT_DUE')
      .reduce((sum, b) => sum + buckets[b], 0)),
    documents: rows.length,
    invoiced,
    settled,
  };
}

/**
 * Age every outstanding document on one side, as of an explicit date.
 *
 * A document contributes exactly one row, for what is still outstanding on it: a
 * 100,000 invoice with 40,000 received ages 60,000, never the whole invoice
 * beside a separate "paid" line. Documents settled to zero are dropped rather
 * than shown as zero rows, and voided documents never appear — their reversal
 * has already taken them out of the ledger.
 *
 * `asOf` is a parameter, never a clock reading, so the same books always produce
 * the same report and a test can move the date instead of freezing time.
 */
export function agingView(
  docs: AgingDocument[],
  payments: Payment[],
  side: AgingSide,
  asOf: string,
  options: { partyId?: string; parties?: { id: string; name: string }[] } = {},
): AgingView {
  const rows: AgingRow[] = [];
  let settledCount = 0;
  let excludedVoided = 0;

  for (const doc of docs) {
    if (doc.status === 'VOIDED') { excludedVoided += 1; continue; }
    if (options.partyId && doc.partyId !== options.partyId) continue;

    const settled = linkedSettlementTotal(payments, doc.id);
    const outstanding = outstandingOn({ totalAmount: doc.totalAmount, paidAmount: settled });
    if (outstanding <= 0.005) { settledCount += 1; continue; }

    const age = ageInDays(doc, asOf);
    rows.push({
      id: doc.id,
      side,
      reference: doc.reference,
      partyId: doc.partyId,
      partyName: doc.partyName,
      documentDate: doc.date,
      dueDate: dueDateOn(doc),
      termsDays: doc.paymentTermsDays,
      total: doc.totalAmount,
      settled,
      outstanding,
      ageDays: age,
      bucket: bucketForAge(age),
      status: settled <= 0.005 ? 'UNPAID' : 'PARTIALLY_PAID',
    });
  }

  // Oldest first, then largest: the order someone chasing a balance works in.
  rows.sort((a, b) => (b.ageDays - a.ageDays) || (b.outstanding - a.outstanding));

  const byParty = agingByParty(rows, options.parties ?? []);

  return {
    side,
    asOf,
    rows,
    summary: summariseAging(rows),
    byParty,
    partyCount: byParty.length,
    settledCount,
    excludedVoided,
  };
}

/** Aged receivables: every posted invoice as of an explicit date. */
export function receivablesAging(
  sales: Sale[],
  payments: Payment[],
  asOf: string,
  options: { partyId?: string; parties?: { id: string; name: string }[] } = {},
): AgingView {
  return agingView(saleAgingDocuments(sales), payments, 'RECEIVABLE', asOf, options);
}

/** Aged payables: the purchase-side mirror of `receivablesAging`. */
export function payablesAging(
  purchases: Purchase[],
  payments: Payment[],
  asOf: string,
  options: { partyId?: string; parties?: { id: string; name: string }[] } = {},
): AgingView {
  return agingView(purchaseAgingDocuments(purchases), payments, 'PAYABLE', asOf, options);
}

/**
 * Roll the aged rows up by party, largest balance first.
 *
 * The name is the one recorded ON THE DOCUMENT (the customer or supplier
 * snapshot taken when it was posted), because this is a statement about past
 * transactions and a party renamed since should not rewrite history. The loaded
 * customer or supplier row is the fallback, and a document with neither is shown
 * as "Unknown party" rather than dropped — the same convention the dashboard's
 * rollup uses, so money never disappears because a name is missing.
 */
export function agingByParty(
  rows: AgingRow[],
  parties: { id: string; name: string }[],
): AgingPartyRow[] {
  const names = new Map(parties.map((p) => [p.id, p.name]));
  const byParty = new Map<string, AgingPartyRow>();

  for (const row of rows) {
    const found = byParty.get(row.partyId) ?? {
      id: row.partyId,
      name: row.partyName || names.get(row.partyId) || 'Unknown party',
      total: 0,
      buckets: emptyBuckets(),
      documents: 0,
    };
    found.buckets[row.bucket] = round2(found.buckets[row.bucket] + row.outstanding);
    found.total = round2(found.total + row.outstanding);
    found.documents += 1;
    byParty.set(row.partyId, found);
  }

  return [...byParty.values()].sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
}

/**
 * The one-line statement of what the aging report is allowed to assume.
 *
 * Printed on the sheet, because a reader comparing it with a contract needs to
 * know what the buckets count from: the due date recorded with each document
 * (its own date plus the terms agreed when it was posted), and that documents
 * written before terms existed still fall due on their own date.
 */
export const AGING_TERMS_NOTE =
  'Each document is aged against the due date recorded with it — its document date plus the '
  + 'payment terms agreed at posting — so a Net 30 invoice is not late until 30 days after it was '
  + 'written. Documents posted before terms were recorded carry no agreed terms and fall due on '
  + 'their own date, as they always did. Aging counts whole days past the due date, and a '
  + 'document due today is not yet overdue.';
