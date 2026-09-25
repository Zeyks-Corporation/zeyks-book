import {
  Account, AccountType, ControlIntegrityReport, DashboardMetrics, DateRange, Expense,
  GatewayTransaction, IntegrityIssue, JournalEntry, JournalLine, LedgerEntry, Payment,
  Purchase, RecentTransaction, Sale,
} from '../types';
import { round2 } from '../lib/money';
import { newId } from '../lib/ids';
import { isWithin, todayNpt } from '../lib/nepaliDate';

/**
 * ZEYKS BOOK — double-entry core.
 *
 * USER ACTION -> BUSINESS TRANSACTION -> JOURNAL ENTRY -> LEDGER -> REPORT
 *
 * Rules this engine enforces:
 *  1. Every journal entry balances. Unbalanced entries are rejected, not stored.
 *  2. Nothing is ever deleted. Corrections are posted as reversing entries, so
 *     the audit trail stays intact.
 *  3. Every report takes an explicit period. A statement never claims a period
 *     it did not actually filter on.
 *  4. Reports iterate over the *accounts referenced by the entries*, not just
 *     the chart of accounts, so a line pointing at a missing account can never
 *     silently vanish from the P&L.
 */

export const ACCOUNT_CODES = {
  CASH: '1010',
  BANK: '1020',
  RECEIVABLE: '1030',
  ESEWA: '1040',
  KHALTI: '1050',
  INVENTORY: '1060',
  VAT_RECEIVABLE: '1070',
  PAYABLE: '2010',
  VAT_PAYABLE: '2020',
  CAPITAL: '3010',
  RETAINED: '3020',
  SALES: '4010',
  COGS: '5010',
} as const;

/**
 * Placeholder code for an account a journal line names but the chart of
 * accounts does not contain. Deliberately printable — an em dash reads as
 * "no code" on an A4 sheet, where the old four-question-mark sentinel
 * rendered as literal "???? Inventory" and looked like a broken font.
 */
export const UNLINKED_ACCOUNT_CODE = '—';

/**
 * The accounts a statement treats as money: cash in hand, the bank account and
 * the two wallets. Named once so the cash & bank report, the printed movement
 * statement and any opening-balance figure cannot disagree about what counts.
 */
export const LIQUID_ACCOUNT_CODES: readonly string[] = [
  ACCOUNT_CODES.CASH, ACCOUNT_CODES.BANK, ACCOUNT_CODES.ESEWA, ACCOUNT_CODES.KHALTI,
];

export function isLiquidAccount(code: string): boolean {
  return LIQUID_ACCOUNT_CODES.includes(code);
}

export interface JournalLineInput {
  accountId: string;
  accountName: string;
  accountType: AccountType;
  debit: number;
  credit: number;
}

export interface CreateEntryArgs {
  businessId: string;
  transactionDate: string;
  sequence: number;
  description: string;
  reference: string;
  sourceType: JournalEntry['sourceType'];
  lines: JournalLineInput[];
  createdBy: string;
  sourceId?: string;
  reversesEntryId?: string;
}

export type EntryResult =
  | { success: true; entry: JournalEntry }
  | { success: false; error: string };

const isDebitNormal = (type: AccountType): boolean => type === 'ASSET' || type === 'EXPENSE';

export class AccountingEngine {
  /* ---------------------------------------------------------------------- */
  /* Posting                                                                 */
  /* ---------------------------------------------------------------------- */

  static validateLines(lines: Pick<JournalLine, 'debit' | 'credit'>[]): {
    isValid: boolean; totalDebit: number; totalCredit: number; difference: number;
  } {
    const totalDebit = round2(lines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0));
    const totalCredit = round2(lines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0));
    const difference = round2(Math.abs(totalDebit - totalCredit));
    return { isValid: difference < 0.005 && lines.length >= 2, totalDebit, totalCredit, difference };
  }

  static createJournalEntry(args: CreateEntryArgs): EntryResult {
    const clean = args.lines
      .map((l) => ({ ...l, debit: round2(Number(l.debit) || 0), credit: round2(Number(l.credit) || 0) }))
      .filter((l) => l.debit !== 0 || l.credit !== 0);

    if (clean.length < 2) {
      return { success: false, error: 'A journal entry needs at least two lines carrying a value.' };
    }
    const offending = clean.find((l) => l.debit < 0 || l.credit < 0);
    if (offending) {
      return { success: false, error: `Negative amounts are not allowed on a journal line (${offending.accountName}). Post a reversing entry instead.` };
    }
    const bothSides = clean.find((l) => l.debit > 0 && l.credit > 0);
    if (bothSides) {
      return { success: false, error: `${bothSides.accountName} carries both a debit and a credit. Split it into two lines.` };
    }

    const check = this.validateLines(clean);
    if (!check.isValid) {
      return {
        success: false,
        error: `Entry rejected: debits of NPR ${check.totalDebit.toFixed(2)} do not equal credits of NPR ${check.totalCredit.toFixed(2)}. Out by NPR ${check.difference.toFixed(2)}.`,
      };
    }

    const id = newId('je');
    const entry: JournalEntry = {
      id,
      businessId: args.businessId,
      transactionDate: args.transactionDate,
      sequence: args.sequence,
      description: args.description,
      reference: args.reference,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      reversesEntryId: args.reversesEntryId,
      lines: clean.map((line, idx) => ({ ...line, id: `${id}_L${idx + 1}`, journalEntryId: id })),
      createdBy: args.createdBy,
      createdAt: new Date().toISOString(),
    };
    return { success: true, entry };
  }

  /**
   * Build the mirror image of an entry. Debits become credits and vice versa,
   * so the pair nets to zero and both remain visible in the ledger.
   */
  static buildReversal(
    original: JournalEntry,
    sequence: number,
    createdBy: string,
    reason: string,
    onDate = todayNpt(),
  ): EntryResult {
    if (original.reversedByEntryId) {
      return { success: false, error: `${original.reference} has already been reversed.` };
    }
    return this.createJournalEntry({
      businessId: original.businessId,
      transactionDate: onDate,
      sequence,
      description: `Reversal of ${original.reference} — ${reason}`,
      reference: `REV-${original.reference}`,
      sourceType: 'REVERSAL',
      sourceId: original.sourceId,
      createdBy,
      reversesEntryId: original.id,
      lines: original.lines.map((l) => ({
        accountId: l.accountId,
        accountName: l.accountName,
        accountType: l.accountType,
        debit: l.credit,
        credit: l.debit,
      })),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Period filtering                                                        */
  /* ---------------------------------------------------------------------- */

  /** Entries dated inside the period. Everything downstream flows from this. */
  static inPeriod(entries: JournalEntry[], range?: Partial<DateRange>): JournalEntry[] {
    if (!range?.from && !range?.to) return entries;
    return entries.filter((e) => isWithin(e.transactionDate, range.from, range.to));
  }

  /** Entries dated on or before `asOf` — the correct basis for a balance sheet. */
  static upTo(entries: JournalEntry[], asOf?: string): JournalEntry[] {
    if (!asOf) return entries;
    return entries.filter((e) => e.transactionDate <= asOf);
  }

  static sortForLedger(entries: JournalEntry[]): JournalEntry[] {
    return [...entries].sort((a, b) =>
      a.transactionDate === b.transactionDate
        ? a.sequence - b.sequence
        : a.transactionDate < b.transactionDate ? -1 : 1,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Balances                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Signed balance per account, in that account's normal direction.
   * Accounts referenced only by journal lines still get a balance, so an
   * orphaned reference surfaces as a reportable issue rather than vanishing.
   */
  static getAccountBalances(accounts: Account[], entries: JournalEntry[]): Record<string, number> {
    const typeOf = new Map(accounts.map((a) => [a.id, a.type]));
    const balances: Record<string, number> = {};
    for (const acc of accounts) balances[acc.id] = 0;

    for (const entry of entries) {
      for (const line of entry.lines) {
        const type = typeOf.get(line.accountId) ?? line.accountType;
        const prev = balances[line.accountId] ?? 0;
        balances[line.accountId] = round2(
          isDebitNormal(type) ? prev + line.debit - line.credit : prev + line.credit - line.debit,
        );
      }
    }
    return balances;
  }

  /**
   * Every account id touched by either the chart of accounts or the entries.
   * Reports iterate this, not `accounts`, which is what stops an unknown
   * account id from quietly dropping value out of the statements.
   */
  private static resolveAccounts(accounts: Account[], entries: JournalEntry[]): Account[] {
    const known = new Map(accounts.map((a) => [a.id, a]));
    const resolved: Account[] = [...accounts];
    const seen = new Set(known.keys());

    for (const entry of entries) {
      for (const line of entry.lines) {
        if (seen.has(line.accountId)) continue;
        seen.add(line.accountId);
        resolved.push({
          id: line.accountId,
          businessId: entry.businessId,
          code: UNLINKED_ACCOUNT_CODE,
          name: `${line.accountName} (unlinked)`,
          type: line.accountType,
          isActive: false,
        });
      }
    }
    return resolved;
  }

  static calculateLedger(
    accounts: Account[],
    entries: JournalEntry[],
    opts: { accountId?: string; range?: Partial<DateRange> } = {},
  ): LedgerEntry[] {
    const accountMap = new Map(accounts.map((a) => [a.id, a]));
    const ordered = this.sortForLedger(entries);
    const running: Record<string, number> = {};
    const ledger: LedgerEntry[] = [];

    for (const entry of ordered) {
      for (const line of entry.lines) {
        const account = accountMap.get(line.accountId);
        const type = account?.type ?? line.accountType;
        const prev = running[line.accountId] ?? 0;
        const balance = round2(
          isDebitNormal(type) ? prev + line.debit - line.credit : prev + line.credit - line.debit,
        );
        running[line.accountId] = balance;

        // Opening balances must accumulate from the first entry, so rows are
        // filtered out *after* the running balance has been advanced.
        if (opts.accountId && line.accountId !== opts.accountId) continue;
        if (opts.range && !isWithin(entry.transactionDate, opts.range.from, opts.range.to)) continue;

        ledger.push({
          date: entry.transactionDate,
          sequence: entry.sequence,
          journalEntryId: entry.id,
          reference: entry.reference,
          description: entry.description,
          accountId: line.accountId,
          accountName: account?.name ?? line.accountName,
          accountType: type,
          debit: line.debit,
          credit: line.credit,
          runningBalance: balance,
        });
      }
    }
    return ledger;
  }

  /* ---------------------------------------------------------------------- */
  /* Statements                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Profit & Loss for an explicit period. Cost of sales is reported apart from
   * operating expenses so gross profit is a real figure.
   */
  static calculateProfitAndLoss(accounts: Account[], allEntries: JournalEntry[], range: DateRange) {
    const entries = this.inPeriod(allEntries, range);
    const resolved = this.resolveAccounts(accounts, entries);
    const balances = this.getAccountBalances(resolved, entries);

    let revenue = 0;
    let costOfSales = 0;
    let operatingExpenses = 0;
    const revenueBreakdown: { accountId: string; code: string; name: string; amount: number }[] = [];
    const costBreakdown: { accountId: string; code: string; name: string; amount: number }[] = [];
    const expenseBreakdown: { accountId: string; code: string; name: string; amount: number }[] = [];

    for (const acc of resolved) {
      const amount = balances[acc.id] ?? 0;
      if (amount === 0) continue;
      const row = { accountId: acc.id, code: acc.code, name: acc.name, amount };
      if (acc.type === 'REVENUE') {
        revenue += amount;
        revenueBreakdown.push(row);
      } else if (acc.type === 'EXPENSE') {
        if (acc.code === ACCOUNT_CODES.COGS) {
          costOfSales += amount;
          costBreakdown.push(row);
        } else {
          operatingExpenses += amount;
          expenseBreakdown.push(row);
        }
      }
    }

    const grossProfit = round2(revenue - costOfSales);
    return {
      range,
      totalRevenue: round2(revenue),
      costOfSales: round2(costOfSales),
      grossProfit,
      operatingExpenses: round2(operatingExpenses),
      totalExpenses: round2(costOfSales + operatingExpenses),
      netProfit: round2(grossProfit - operatingExpenses),
      revenueBreakdown,
      costBreakdown,
      expenseBreakdown,
    };
  }

  /** Trial balance as at a date. */
  static calculateTrialBalance(accounts: Account[], allEntries: JournalEntry[], asOf: string) {
    const entries = this.upTo(allEntries, asOf);
    const resolved = this.resolveAccounts(accounts, entries);
    const balances = this.getAccountBalances(resolved, entries);

    const rows: { account: Account; debit: number; credit: number }[] = [];
    let totalDebit = 0;
    let totalCredit = 0;

    for (const acc of resolved) {
      const balance = balances[acc.id] ?? 0;
      if (balance === 0) continue;
      const normalDebit = isDebitNormal(acc.type);
      const debit = normalDebit === balance >= 0 ? Math.abs(balance) : 0;
      const credit = normalDebit === balance >= 0 ? 0 : Math.abs(balance);
      totalDebit += debit;
      totalCredit += credit;
      rows.push({ account: acc, debit, credit });
    }

    rows.sort((a, b) => a.account.code.localeCompare(b.account.code));
    return {
      asOf,
      rows,
      totalDebit: round2(totalDebit),
      totalCredit: round2(totalCredit),
      isBalanced: Math.abs(round2(totalDebit - totalCredit)) < 0.01,
    };
  }

  /**
   * Balance sheet as at a date.
   *
   * Retained earnings splits in two: profit accumulated before the current
   * fiscal year, and profit earned inside it. Without that split, year two of
   * trading double-counts year one.
   */
  static calculateBalanceSheet(
    accounts: Account[],
    allEntries: JournalEntry[],
    asOf: string,
    fiscalYearStart: string,
  ) {
    const entries = this.upTo(allEntries, asOf);
    const resolved = this.resolveAccounts(accounts, entries);
    const balances = this.getAccountBalances(resolved, entries);

    const assetAccounts: { account: Account; balance: number }[] = [];
    const liabilityAccounts: { account: Account; balance: number }[] = [];
    const equityAccounts: { account: Account; balance: number }[] = [];
    let totalAssets = 0;
    let totalLiabilities = 0;
    let totalEquity = 0;

    for (const acc of resolved) {
      const balance = balances[acc.id] ?? 0;
      if (acc.type === 'ASSET') { assetAccounts.push({ account: acc, balance }); totalAssets += balance; }
      else if (acc.type === 'LIABILITY') { liabilityAccounts.push({ account: acc, balance }); totalLiabilities += balance; }
      else if (acc.type === 'EQUITY') { equityAccounts.push({ account: acc, balance }); totalEquity += balance; }
    }

    const currentYear = this.calculateProfitAndLoss(accounts, allEntries, {
      from: fiscalYearStart, to: asOf, label: 'current',
    });
    const priorYears = this.calculateProfitAndLoss(accounts, allEntries, {
      from: '0000-01-01', to: fiscalYearStart, label: 'prior',
    });
    // `to` is inclusive, so the fiscal-year-start day would be counted twice.
    const openingEntries = allEntries.filter((e) => e.transactionDate < fiscalYearStart);
    const openingPnl = this.calculateProfitAndLoss(accounts, openingEntries, {
      from: '0000-01-01', to: '9999-12-31', label: 'opening',
    });
    void priorYears;

    const retainedBroughtForward = round2(openingPnl.netProfit);
    const currentPeriodProfit = round2(currentYear.netProfit);
    const totalEquityAndLiabilities = round2(
      totalLiabilities + totalEquity + retainedBroughtForward + currentPeriodProfit,
    );

    const sortByCode = (a: { account: Account }, b: { account: Account }) =>
      a.account.code.localeCompare(b.account.code);

    return {
      asOf,
      assetAccounts: assetAccounts.filter((a) => a.balance !== 0).sort(sortByCode),
      liabilityAccounts: liabilityAccounts.filter((a) => a.balance !== 0).sort(sortByCode),
      equityAccounts: equityAccounts.filter((a) => a.balance !== 0).sort(sortByCode),
      totalAssets: round2(totalAssets),
      totalLiabilities: round2(totalLiabilities),
      totalEquity: round2(totalEquity),
      retainedBroughtForward,
      currentPeriodProfit,
      totalEquityAndLiabilities,
      isBalanced: Math.abs(round2(totalAssets - totalEquityAndLiabilities)) < 0.01,
    };
  }

  /** VAT summary for a period — the figures an IRD return asks for. */
  static calculateVatReturn(accounts: Account[], allEntries: JournalEntry[], range: DateRange) {
    const entries = this.inPeriod(allEntries, range);
    const outputAcc = accounts.find((a) => a.code === ACCOUNT_CODES.VAT_PAYABLE);
    const inputAcc = accounts.find((a) => a.code === ACCOUNT_CODES.VAT_RECEIVABLE);
    const salesAcc = accounts.find((a) => a.code === ACCOUNT_CODES.SALES);
    const purchaseAcc = accounts.find((a) => a.code === ACCOUNT_CODES.COGS);

    const matchesAcc = (acc: Account | undefined, lineAccountId: string, code: string) => {
      if (lineAccountId === code) return true;
      if (acc && (lineAccountId === acc.id || lineAccountId === acc.code)) return true;
      return false;
    };

    let outputVat = 0;
    let inputVat = 0;
    let taxableSales = 0;
    let taxablePurchases = 0;

    for (const entry of entries) {
      for (const line of entry.lines) {
        if (matchesAcc(outputAcc, line.accountId, ACCOUNT_CODES.VAT_PAYABLE)) {
          outputVat += line.credit - line.debit;
        }
        if (matchesAcc(inputAcc, line.accountId, ACCOUNT_CODES.VAT_RECEIVABLE)) {
          inputVat += line.debit - line.credit;
        }
        if (matchesAcc(salesAcc, line.accountId, ACCOUNT_CODES.SALES)) {
          taxableSales += line.credit - line.debit;
        }
        if (matchesAcc(purchaseAcc, line.accountId, ACCOUNT_CODES.COGS)) {
          taxablePurchases += line.debit - line.credit;
        }
      }
    }

    const net = round2(outputVat - inputVat);
    return {
      range,
      taxableSales: round2(taxableSales),
      taxablePurchases: round2(taxablePurchases),
      outputVat: round2(outputVat),
      inputVat: round2(inputVat),
      netPayable: net > 0 ? net : 0,
      netCreditCarriedForward: net < 0 ? round2(-net) : 0,
    };
  }

  static getCashBankMovement(
    accounts: Account[],
    allEntries: JournalEntry[],
    range: DateRange,
  ) {
    const liquid = new Map(
      accounts.filter((a) => isLiquidAccount(a.code)).map((a) => [a.id, a]),
    );
    const entries = this.sortForLedger(this.inPeriod(allEntries, range));
    const movements: {
      date: string; reference: string; description: string; accountName: string;
      direction: 'INFLOW' | 'OUTFLOW'; amount: number;
    }[] = [];

    for (const entry of entries) {
      for (const line of entry.lines) {
        const account = liquid.get(line.accountId);
        if (!account) continue;
        const inflow = line.debit > 0;
        const amount = inflow ? line.debit : line.credit;
        if (amount <= 0) continue;
        movements.push({
          date: entry.transactionDate,
          reference: entry.reference,
          description: entry.description,
          accountName: account.name,
          direction: inflow ? 'INFLOW' : 'OUTFLOW',
          amount,
        });
      }
    }

    const inflow = round2(movements.filter((m) => m.direction === 'INFLOW').reduce((s, m) => s + m.amount, 0));
    const outflow = round2(movements.filter((m) => m.direction === 'OUTFLOW').reduce((s, m) => s + m.amount, 0));
    return { movements: movements.reverse(), totalInflow: inflow, totalOutflow: outflow, net: round2(inflow - outflow) };
  }

  /* ---------------------------------------------------------------------- */
  /* Dashboard                                                               */
  /* ---------------------------------------------------------------------- */

  static getDashboardMetrics(
    accounts: Account[],
    entries: JournalEntry[],
    docs: { sales: Sale[]; purchases: Purchase[]; expenses: Expense[]; payments: Payment[] },
    range: DateRange,
  ): DashboardMetrics {
    const asOf = range.to;
    const balances = this.getAccountBalances(accounts, this.upTo(entries, asOf));
    const byCode = (code: string): number => {
      const acc = accounts.find((a) => a.code === code);
      return acc ? balances[acc.id] ?? 0 : 0;
    };

    const pnl = this.calculateProfitAndLoss(accounts, entries, range);
    const cash = byCode(ACCOUNT_CODES.CASH);
    const bank = byCode(ACCOUNT_CODES.BANK);
    // The old dashboard matched account names for "cash" and "bank" and so
    // left the eSewa and Khalti balances out of the liquid position entirely.
    const wallet = round2(byCode(ACCOUNT_CODES.ESEWA) + byCode(ACCOUNT_CODES.KHALTI));

    const recent: RecentTransaction[] = [];
    const push = (t: RecentTransaction) => { if (isWithin(t.date, range.from, range.to)) recent.push(t); };

    for (const s of docs.sales) {
      push({
        id: s.id, date: s.date, type: 'Sale',
        description: `${s.invoiceNumber} — ${s.customerName}`,
        amount: s.totalAmount, status: s.status === 'VOIDED' ? 'VOIDED' : s.paymentStatus,
        paymentMethod: s.paymentMethod, voided: s.status === 'VOIDED',
      });
    }
    for (const p of docs.purchases) {
      push({
        id: p.id, date: p.date, type: 'Purchase',
        description: `${p.referenceNumber} — ${p.supplierName}`,
        amount: p.totalAmount, status: p.status === 'VOIDED' ? 'VOIDED' : p.paymentStatus,
        paymentMethod: p.paymentMethod, voided: p.status === 'VOIDED',
      });
    }
    for (const e of docs.expenses) {
      push({
        id: e.id, date: e.date, type: 'Expense',
        description: `${e.categoryName} — ${e.description}`,
        amount: e.totalAmount, status: e.status === 'VOIDED' ? 'VOIDED' : 'PAID',
        paymentMethod: e.paymentMethod, voided: e.status === 'VOIDED',
      });
    }
    for (const p of docs.payments) {
      push({
        id: p.id, date: p.date, type: 'Payment',
        description: `${p.paymentType === 'INCOMING' ? 'From' : 'To'} ${p.partyName} (${p.reference})`,
        amount: p.amount, status: p.docStatus === 'VOIDED' ? 'VOIDED' : p.status,
        paymentMethod: p.paymentMethod, voided: p.docStatus === 'VOIDED',
      });
    }

    recent.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));

    return {
      revenue: pnl.totalRevenue,
      costOfSales: pnl.costOfSales,
      grossProfit: pnl.grossProfit,
      operatingExpenses: pnl.operatingExpenses,
      netProfit: pnl.netProfit,
      cashBalance: cash,
      bankBalance: bank,
      walletBalance: wallet,
      liquidTotal: round2(cash + bank + wallet),
      accountsReceivable: byCode(ACCOUNT_CODES.RECEIVABLE),
      accountsPayable: byCode(ACCOUNT_CODES.PAYABLE),
      vatPayable: round2(byCode(ACCOUNT_CODES.VAT_PAYABLE) - byCode(ACCOUNT_CODES.VAT_RECEIVABLE)),
      inventoryValue: byCode(ACCOUNT_CODES.INVENTORY),
      recentTransactions: recent.slice(0, 12),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Integrity                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Real checks, as opposed to re-deriving debits from credits and announcing
   * that they match. Everything here can genuinely fail and points at the
   * document that caused it.
   */
  static checkIntegrity(input: {
    accounts: Account[];
    entries: JournalEntry[];
    sales: Sale[];
    purchases: Purchase[];
    expenses: Expense[];
    payments: Payment[];
    gateway: GatewayTransaction[];
    /**
     * The AR/AP reconciliation as the DATABASE answered it (migration 014).
     *
     * Optional because not every caller has a database behind it — the checks
     * below are all local by nature, and a caller that passes nothing simply gets
     * no control-account verdict rather than an invented one. A caller that has
     * asked the database passes `known` or `unavailable`; the latter is reported
     * as a warning, never as agreement.
     */
    controls?: ControlIntegrityReport | null;
  }): IntegrityIssue[] {
    const { accounts, entries, sales, purchases, expenses, payments, gateway, controls } = input;
    const issues: IntegrityIssue[] = [];
    const accountIds = new Set(accounts.map((a) => a.id));
    const today = todayNpt();

    for (const entry of entries) {
      const check = this.validateLines(entry.lines);
      if (!check.isValid) {
        issues.push({
          severity: 'ERROR', code: 'UNBALANCED_ENTRY', subject: entry.reference,
          message: `Entry ${entry.reference} is out of balance by NPR ${check.difference.toFixed(2)}.`,
        });
      }
      for (const line of entry.lines) {
        if (!accountIds.has(line.accountId)) {
          issues.push({
            severity: 'ERROR', code: 'ORPHAN_ACCOUNT', subject: entry.reference,
            message: `Entry ${entry.reference} posts to "${line.accountName}", which is not in your chart of accounts. Recreate the account or reverse the entry.`,
          });
        }
      }
      if (entry.transactionDate > today) {
        issues.push({
          severity: 'WARNING', code: 'FUTURE_DATED', subject: entry.reference,
          message: `Entry ${entry.reference} is dated ${entry.transactionDate}, which is in the future.`,
        });
      }
    }

    // Duplicate references across documents of the same kind.
    const flagDuplicates = (refs: string[], kind: string) => {
      const seen = new Map<string, number>();
      for (const ref of refs) seen.set(ref, (seen.get(ref) ?? 0) + 1);
      for (const [ref, count] of seen) {
        if (count > 1) {
          issues.push({
            severity: 'ERROR', code: 'DUPLICATE_REFERENCE', subject: ref,
            message: `${kind} number ${ref} has been issued ${count} times.`,
          });
        }
      }
    };
    flagDuplicates(sales.filter((s) => s.status === 'POSTED').map((s) => s.invoiceNumber), 'Invoice');
    flagDuplicates(purchases.filter((p) => p.status === 'POSTED').map((p) => p.referenceNumber), 'Purchase');
    flagDuplicates(payments.filter((p) => p.docStatus === 'POSTED').map((p) => p.reference), 'Payment');

    // Negative balances that cannot physically happen.
    const balances = this.getAccountBalances(accounts, entries);
    const cannotGoNegative: { code: string; label: string }[] = [
      { code: ACCOUNT_CODES.CASH, label: 'Cash in hand' },
      { code: ACCOUNT_CODES.ESEWA, label: 'eSewa wallet' },
      { code: ACCOUNT_CODES.KHALTI, label: 'Khalti wallet' },
      { code: ACCOUNT_CODES.INVENTORY, label: 'Inventory' },
    ];
    for (const { code, label } of cannotGoNegative) {
      const acc = accounts.find((a) => a.code === code);
      if (!acc) continue;
      const balance = balances[acc.id] ?? 0;
      if (balance < -0.01) {
        issues.push({
          severity: 'ERROR', code: 'NEGATIVE_BALANCE', subject: acc.name,
          message: `${label} shows NPR ${balance.toFixed(2)}. You have recorded more going out than ever came in.`,
        });
      }
    }
    const bankAcc = accounts.find((a) => a.code === ACCOUNT_CODES.BANK);
    if (bankAcc && (balances[bankAcc.id] ?? 0) < -0.01) {
      issues.push({
        severity: 'WARNING', code: 'BANK_OVERDRAWN', subject: bankAcc.name,
        message: `${bankAcc.name} is overdrawn by NPR ${Math.abs(balances[bankAcc.id] ?? 0).toFixed(2)}. Correct if unintended.`,
      });
    }

    // Over-settlement: more collected against a document than it was worth.
    for (const sale of sales) {
      if (sale.status === 'VOIDED') continue;
      if (sale.paidAmount - sale.totalAmount > 0.01) {
        issues.push({
          severity: 'ERROR', code: 'OVER_SETTLED', subject: sale.invoiceNumber,
          message: `Invoice ${sale.invoiceNumber} is for NPR ${sale.totalAmount.toFixed(2)} but NPR ${sale.paidAmount.toFixed(2)} has been received against it.`,
        });
      }
    }
    for (const purchase of purchases) {
      if (purchase.status === 'VOIDED') continue;
      if (purchase.paidAmount - purchase.totalAmount > 0.01) {
        issues.push({
          severity: 'ERROR', code: 'OVER_SETTLED', subject: purchase.referenceNumber,
          message: `Purchase ${purchase.referenceNumber} is for NPR ${purchase.totalAmount.toFixed(2)} but NPR ${purchase.paidAmount.toFixed(2)} has been paid against it.`,
        });
      }
    }

    // The control accounts and the documents must agree.
    //
    // The application answers "what is still owed" twice: per party from the
    // documents (total − valid settlements), and in aggregate from the ledger
    // control accounts, which is what the dashboard and the balance sheet show.
    // Two representations of one number, so a settlement that was re-linked, or
    // a journal entry that arrived without its document, has to be *seen* to
    // diverge instead of quietly disagreeing.
    //
    // (Stage 16) That comparison is no longer computed here. It used to be, from
    // whatever rows this client had loaded — sound only while the whole book is
    // in memory, and silently wrong the moment a read is scoped or paginated,
    // because then the two sides would come from different subsets. The database
    // derives both sides from the tables instead
    // (public.control_account_integrity(), migration 014) and this engine only
    // reports its verdict: one authoritative implementation, not two. Nothing
    // here may re-derive the difference — see the Stage 16 test that fails if a
    // control-account subtraction appears in this file.
    if (controls?.status === 'unavailable') {
      issues.push({
        severity: 'WARNING',
        code: 'CONTROL_CHECK_UNAVAILABLE',
        subject: 'Accounts receivable / payable',
        message: `The ledger control accounts could not be checked against the documents (${controls.reason}). This is not a finding — it means the check has not run.`,
      });
    } else if (controls?.status === 'known') {
      const reportSide = (side: 'receivable' | 'payable', code: string, label: string, kind: string) => {
        const figure = controls.integrity[side];
        if (figure.ok) return;
        issues.push({
          severity: 'ERROR',
          code,
          subject: label,
          message: `${label} shows NPR ${figure.control.toFixed(2)} in the ledger but your ${kind} still add up to NPR ${figure.documents.toFixed(2)} — out by NPR ${figure.difference.toFixed(2)}. The database compared both sides; check the settlements on those documents before filing anything.`,
        });
      };
      reportSide('receivable', 'RECEIVABLE_MISMATCH', 'Accounts receivable', 'unpaid invoices');
      reportSide('payable', 'PAYABLE_MISMATCH', 'Accounts payable', 'unpaid bills');
    }

    // Documents with no journal entry, and entries whose document is gone.
    const entryIds = new Set(entries.map((e) => e.id));
    const checkPosted = (docs: { journalEntryId?: string; status: string; ref: string; kind: string }[]) => {
      for (const doc of docs) {
        if (doc.status === 'VOIDED') continue;
        if (!doc.journalEntryId || !entryIds.has(doc.journalEntryId)) {
          issues.push({
            severity: 'ERROR', code: 'UNPOSTED_DOCUMENT', subject: doc.ref,
            message: `${doc.kind} ${doc.ref} has no journal entry behind it, so it is missing from every report.`,
          });
        }
      }
    };
    checkPosted([
      ...sales.map((s) => ({ journalEntryId: s.journalEntryId, status: s.status, ref: s.invoiceNumber, kind: 'Invoice' })),
      ...purchases.map((p) => ({ journalEntryId: p.journalEntryId, status: p.status, ref: p.referenceNumber, kind: 'Purchase' })),
      ...expenses.map((e) => ({ journalEntryId: e.journalEntryId, status: e.status, ref: e.reference, kind: 'Expense' })),
      ...payments.map((p) => ({ journalEntryId: p.journalEntryId, status: p.docStatus, ref: p.reference, kind: 'Payment' })),
    ]);

    // Gateway collections that were taken but never made it to the ledger.
    for (const txn of gateway) {
      if (txn.status === 'COMPLETED' && !txn.paymentId) {
        issues.push({
          severity: 'ERROR', code: 'UNRECORDED_COLLECTION', subject: txn.gatewayRef,
          message: `A completed ${txn.provider} payment of NPR ${txn.amount.toFixed(2)} from ${txn.customerName} has not been posted to the ledger.`,
        });
      }
      if (txn.status === 'PENDING' || txn.status === 'INITIATED') {
        const ageHours = (Date.now() - new Date(txn.initiatedAt).getTime()) / 3_600_000;
        if (ageHours > 2) {
          issues.push({
            severity: 'WARNING', code: 'STALE_GATEWAY_TXN', subject: txn.gatewayRef,
            message: `${txn.provider} payment from ${txn.customerName} has been unresolved for ${Math.round(ageHours)} hours. Re-check its status.`,
          });
        }
      }
    }

    // A reversal pair must actually net to zero.
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const entry of entries) {
      if (!entry.reversesEntryId) continue;
      const original = byId.get(entry.reversesEntryId);
      if (!original) {
        issues.push({
          severity: 'ERROR', code: 'DANGLING_REVERSAL', subject: entry.reference,
          message: `${entry.reference} reverses an entry that is no longer present.`,
        });
        continue;
      }
      const netDebit = round2(
        original.lines.reduce((s, l) => s + l.debit, 0) - entry.lines.reduce((s, l) => s + l.debit, 0),
      );
      const originalCredit = round2(original.lines.reduce((s, l) => s + l.credit, 0));
      if (Math.abs(netDebit - 0) > 0.01 && Math.abs(netDebit) !== originalCredit) {
        issues.push({
          severity: 'WARNING', code: 'PARTIAL_REVERSAL', subject: entry.reference,
          message: `${entry.reference} does not fully offset ${original.reference}.`,
        });
      }
    }

    return issues;
  }
}
