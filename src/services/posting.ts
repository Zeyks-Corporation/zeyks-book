import {
  Account, BusinessProfile, Expense, JournalEntry, Payment, PaymentMethod,
  PaymentStatus, Purchase, Sale,
} from '../types';
import { ACCOUNT_CODES, AccountingEngine, EntryResult, JournalLineInput } from './accountingEngine';
import { round2 } from '../lib/money';

/**
 * Turns a business document into balanced journal lines.
 *
 * Kept separate from the engine so the posting *policy* (which accounts a sale
 * touches, whether VAT is split out, whether stock is capitalised) can change
 * without touching the double-entry mechanics.
 */

export class MissingAccountError extends Error {
  constructor(public readonly code: string) {
    super(`Account ${code} is missing from your chart of accounts. Restore it in Settings before posting.`);
    this.name = 'MissingAccountError';
  }
}

export class AccountLookup {
  private readonly byCode: Map<string, Account>;
  private readonly byId: Map<string, Account>;

  constructor(accounts: Account[]) {
    this.byCode = new Map(accounts.map((a) => [a.code, a]));
    this.byId = new Map(accounts.map((a) => [a.id, a]));
  }

  /**
   * Strict lookup. The old code fell back to `accounts[5]` when a code was
   * missing, which silently posted revenue to whatever account happened to sit
   * at that index. Failing loudly is the only safe option here.
   */
  require(code: string): Account {
    const acc = this.byCode.get(code);
    if (!acc) throw new MissingAccountError(code);
    return acc;
  }

  optional(code: string): Account | undefined {
    return this.byCode.get(code);
  }

  requireId(id: string): Account {
    const acc = this.byId.get(id);
    if (!acc) throw new MissingAccountError(id);
    return acc;
  }

  /** Which asset account a payment method settles into. */
  settlement(method: PaymentMethod): Account {
    switch (method) {
      case 'CASH': return this.require(ACCOUNT_CODES.CASH);
      case 'ESEWA': return this.optional(ACCOUNT_CODES.ESEWA) ?? this.require(ACCOUNT_CODES.BANK);
      case 'KHALTI': return this.optional(ACCOUNT_CODES.KHALTI) ?? this.require(ACCOUNT_CODES.BANK);
      case 'BANK':
      default: return this.require(ACCOUNT_CODES.BANK);
    }
  }
}

const line = (account: Account, debit: number, credit: number): JournalLineInput => ({
  accountId: account.id,
  accountName: account.name,
  accountType: account.type,
  debit: round2(debit),
  credit: round2(credit),
});

export function statusFor(total: number, paid: number): PaymentStatus {
  if (paid <= 0.005) return 'UNPAID';
  if (paid >= total - 0.005) return 'PAID';
  return 'PARTIALLY_PAID';
}

/* -------------------------------------------------------------------------- */
/* Sales                                                                       */
/* -------------------------------------------------------------------------- */

/**
 *   Dr Cash/Bank/Wallet      amount settled at point of sale
 *   Dr Accounts Receivable   balance left on credit
 *       Cr Sales Revenue         net of VAT
 *       Cr VAT Payable           output tax, when registered
 *
 * Plus, when inventory is tracked:
 *   Dr Cost of Goods Sold    cost of the stock that left
 *       Cr Inventory
 *
 * How much was settled at the counter is not read from the document — a sale
 * carries no such field — it is summed from the settlement rows the posting
 * will create, which is the same rule `post_sale` and `reconcile()` follow.
 * Pass the rows the server recorded (`[]` for a fully credit sale).
 */
export function buildSaleEntry(
  sale: Sale,
  lookup: AccountLookup,
  business: BusinessProfile,
  sequence: number,
  settlements: Payment[] = [],
): EntryResult {
  const lines: JournalLineInput[] = [];
  const settledNow = Math.min(linkedSettlementTotal(settlements, sale.id), sale.totalAmount);
  const onCredit = round2(sale.totalAmount - settledNow);

  if (settledNow > 0) lines.push(line(lookup.settlement(sale.paymentMethod), settledNow, 0));
  if (onCredit > 0) lines.push(line(lookup.require(ACCOUNT_CODES.RECEIVABLE), onCredit, 0));

  const net = round2(sale.totalAmount - sale.taxAmount);
  lines.push(line(lookup.require(ACCOUNT_CODES.SALES), 0, net));
  if (sale.taxAmount > 0) {
    lines.push(line(lookup.require(ACCOUNT_CODES.VAT_PAYABLE), 0, sale.taxAmount));
  }

  if (business.trackInventory && sale.costOfGoods && sale.costOfGoods > 0) {
    lines.push(line(lookup.require(ACCOUNT_CODES.COGS), sale.costOfGoods, 0));
    lines.push(line(lookup.require(ACCOUNT_CODES.INVENTORY), 0, sale.costOfGoods));
  }

  return AccountingEngine.createJournalEntry({
    businessId: sale.businessId,
    transactionDate: sale.date,
    sequence,
    description: `Sale ${sale.invoiceNumber} — ${sale.customerName}`,
    reference: sale.invoiceNumber,
    sourceType: 'SALE',
    sourceId: sale.id,
    createdBy: sale.createdBy,
    lines,
  });
}

/* -------------------------------------------------------------------------- */
/* Purchases                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * With inventory tracking the goods are capitalised as an asset and only hit
 * the P&L when sold. Without it they are expensed on purchase, which is the
 * simpler cash-style treatment the old build used for everything.
 *
 *   Dr Inventory (or Cost of Goods)   net of VAT
 *   Dr VAT Receivable                 input tax, when registered
 *       Cr Cash/Bank/Wallet               settled now
 *       Cr Accounts Payable               balance on credit
 */
export function buildPurchaseEntry(
  purchase: Purchase,
  lookup: AccountLookup,
  business: BusinessProfile,
  sequence: number,
  settlements: Payment[] = [],
): EntryResult {
  const lines: JournalLineInput[] = [];
  const net = round2(purchase.totalAmount - purchase.taxAmount);
  const target = business.trackInventory
    ? lookup.require(ACCOUNT_CODES.INVENTORY)
    : lookup.require(ACCOUNT_CODES.COGS);

  lines.push(line(target, net, 0));
  if (purchase.taxAmount > 0) {
    lines.push(line(lookup.require(ACCOUNT_CODES.VAT_RECEIVABLE), purchase.taxAmount, 0));
  }

  const settledNow = Math.min(linkedSettlementTotal(settlements, purchase.id), purchase.totalAmount);
  const onCredit = round2(purchase.totalAmount - settledNow);
  if (settledNow > 0) lines.push(line(lookup.settlement(purchase.paymentMethod), 0, settledNow));
  if (onCredit > 0) lines.push(line(lookup.require(ACCOUNT_CODES.PAYABLE), 0, onCredit));

  return AccountingEngine.createJournalEntry({
    businessId: purchase.businessId,
    transactionDate: purchase.date,
    sequence,
    description: `Purchase ${purchase.referenceNumber} — ${purchase.supplierName}`,
    reference: purchase.referenceNumber,
    sourceType: 'PURCHASE',
    sourceId: purchase.id,
    createdBy: purchase.createdBy,
    lines,
  });
}

/* -------------------------------------------------------------------------- */
/* Expenses                                                                    */
/* -------------------------------------------------------------------------- */

export function buildExpenseEntry(
  expense: Expense,
  lookup: AccountLookup,
  sequence: number,
): EntryResult {
  const expenseAcc = lookup.requireId(expense.accountId);
  const lines: JournalLineInput[] = [line(expenseAcc, expense.amount, 0)];
  if (expense.taxAmount > 0) {
    lines.push(line(lookup.require(ACCOUNT_CODES.VAT_RECEIVABLE), expense.taxAmount, 0));
  }
  lines.push(line(lookup.settlement(expense.paymentMethod), 0, expense.totalAmount));

  return AccountingEngine.createJournalEntry({
    businessId: expense.businessId,
    transactionDate: expense.date,
    sequence,
    description: `${expense.categoryName} — ${expense.description}`,
    reference: expense.reference,
    sourceType: 'EXPENSE',
    sourceId: expense.id,
    createdBy: expense.createdBy,
    lines,
  });
}

/* -------------------------------------------------------------------------- */
/* Settlements                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Incoming:  Dr Cash/Bank/Wallet   Cr Accounts Receivable
 * Outgoing:  Dr Accounts Payable   Cr Cash/Bank/Wallet
 */
export function buildPaymentEntry(
  payment: Payment,
  lookup: AccountLookup,
  sequence: number,
): EntryResult {
  const settlement = lookup.settlement(payment.paymentMethod);
  const incoming = payment.paymentType === 'INCOMING';
  const counterpart = incoming
    ? lookup.require(ACCOUNT_CODES.RECEIVABLE)
    : lookup.require(ACCOUNT_CODES.PAYABLE);

  const lines: JournalLineInput[] = incoming
    ? [line(settlement, payment.amount, 0), line(counterpart, 0, payment.amount)]
    : [line(counterpart, payment.amount, 0), line(settlement, 0, payment.amount)];

  return AccountingEngine.createJournalEntry({
    businessId: payment.businessId,
    transactionDate: payment.date,
    sequence,
    description: `Settlement ${incoming ? 'from' : 'to'} ${payment.partyName}`,
    reference: payment.reference,
    sourceType: 'PAYMENT',
    sourceId: payment.id,
    createdBy: payment.createdBy,
    lines,
  });
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The one settlement sum in the app: every COMPLETED, non-voided settlement row
 * linked to one document.
 *
 * This is the single source of truth for money that has moved against a
 * document, and the only place a paid total is computed. It counts the
 * settlement `post_sale`/`post_purchase` made at posting time (the embedded
 * upfront receipt is a row here like any other) and every later receipt or
 * supplier payment, and it excludes a row that was voided. The document's own
 * `upfront_paid` column is deliberately not consulted: it is a frozen record of
 * what was settled when the document was created, not a live balance.
 *
 * The server applies exactly this rule when it recomputes an outstanding
 * balance under a lock, so the browser and the database cannot disagree.
 */
export function linkedSettlementTotal(payments: Payment[], documentId: string): number {
  let total = 0;
  for (const p of payments) {
    if (p.docStatus === 'VOIDED' || p.status !== 'COMPLETED') continue;
    if (p.linkedSaleId !== documentId && p.linkedPurchaseId !== documentId) continue;
    total += p.amount;
  }
  return round2(total);
}

/**
 * Outstanding on a document: what it was for, minus what has been settled.
 *
 * Total − SUM(COMPLETED + POSTED linked settlements) = Outstanding. This is the
 * only place that arithmetic happens; every screen that shows a balance or an
 * "open" document goes through it, so no view can invent a different rule.
 */
export function outstandingOn(doc: { totalAmount: number; paidAmount: number }): number {
  return round2(doc.totalAmount - doc.paidAmount);
}

/**
 * Recomputes `paidAmount` and `paymentStatus` on every open document from the
 * settlements actually recorded against it.
 *
 * The old build declared `linkedSaleId` in its types and never once read it,
 * so an invoice showed UNPAID forever no matter how much was collected. This
 * is the fix, and it runs after every mutation so the two can never drift.
 */
export function reconcile(
  sales: Sale[],
  purchases: Purchase[],
  payments: Payment[],
): { sales: Sale[]; purchases: Purchase[] } {
  const saleSettled = new Map<string, number>();
  const purchaseSettled = new Map<string, number>();

  for (const p of payments) {
    if (p.docStatus === 'VOIDED' || p.status !== 'COMPLETED') continue;
    if (p.linkedSaleId) {
      saleSettled.set(p.linkedSaleId, round2((saleSettled.get(p.linkedSaleId) ?? 0) + p.amount));
    }
    if (p.linkedPurchaseId) {
      purchaseSettled.set(p.linkedPurchaseId, round2((purchaseSettled.get(p.linkedPurchaseId) ?? 0) + p.amount));
    }
  }

  const applySale = (sale: Sale): Sale => {
    if (sale.status === 'VOIDED') return sale;
    const paid = round2(saleSettled.get(sale.id) ?? 0);
    return { ...sale, paidAmount: paid, paymentStatus: statusFor(sale.totalAmount, paid) };
  };

  const applyPurchase = (purchase: Purchase): Purchase => {
    if (purchase.status === 'VOIDED') return purchase;
    const paid = round2(purchaseSettled.get(purchase.id) ?? 0);
    return { ...purchase, paidAmount: paid, paymentStatus: statusFor(purchase.totalAmount, paid) };
  };

  return { sales: sales.map(applySale), purchases: purchases.map(applyPurchase) };
}

/** Outstanding balance per party, derived from documents rather than stored. */
export function outstandingByParty(
  docs: { partyId: string; totalAmount: number; paidAmount: number; status: string }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of docs) {
    if (d.status === 'VOIDED') continue;
    const due = outstandingOn(d);
    if (due === 0) continue;
    out.set(d.partyId, round2((out.get(d.partyId) ?? 0) + due));
  }
  return out;
}

export function entryFor(entries: JournalEntry[], id?: string): JournalEntry | undefined {
  return id ? entries.find((e) => e.id === id) : undefined;
}
