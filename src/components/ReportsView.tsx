import React, { useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { DateRange, LedgerEntry } from '../types';
import { Books } from '../state/useBooks';
import { AccountingEngine, UNLINKED_ACCOUNT_CODE } from '../services/accountingEngine';
import { Button, Callout, DateField, inputClass } from './ui';
import { PeriodPicker } from './PeriodPicker';
import {
  ReportAmount, ReportEmpty, ReportFooter, ReportHeader, ReportNote, ReportRow, ReportSection,
  ReportSheet, ReportStatus, ReportTable, reportShortDate, reportMoney,
} from './ReportShell';
import type { ReportColumn, ReportMetaRow } from './ReportShell';
import {
  AGING_BUCKET_LABELS, AGING_BUCKETS, AGING_TERMS_NOTE, cashBankMovement, cashBankOpeningBalance,
  termsLabel,
  categoryFilterOptions, expenseReport, filterSummary, partyFilterOptions, payablesAging,
  paymentStatusLabel, paymentStatusTone, purchaseReport, receivablesAging, reportPeriodLabel,
  reportRangeMeta, salesReport,
} from '../services/reportData';
import type { AgingPartyRow, AgingRow, AgingSide, DocumentReportRow } from '../services/reportData';
import { csvRow, downloadCsv } from '../lib/csv';
import { fiscalYearOf, todayNpt } from '../lib/nepaliDate';
import { formatNpr } from '../lib/money';

/**
 * Statements and document registers, printed as A4 sheets.
 *
 * Every figure on this screen comes from `accountingEngine` (the statements) or
 * `reportData` (the document registers, which sums settlement rows through
 * `posting`). No report computes its own financial truth, and no report shows a
 * number it did not derive from persisted records: an empty period prints an
 * empty statement, never a sample.
 */

type ReportType =
  | 'pnl' | 'balance_sheet' | 'trial_balance' | 'vat' | 'ledger' | 'cashbank'
  | 'sales' | 'purchases' | 'expenses' | 'aging';

interface ReportDef {
  value: ReportType;
  label: string;
  /** The title printed on the sheet. */
  title: string;
  basis: 'period' | 'asOf';
  /** What the figures are read from, printed as the sheet's source line. */
  source: string;
  /** Which filter control this report offers, if any. */
  filter?: 'customer' | 'supplier' | 'category' | 'account';
}

const REPORTS: ReportDef[] = [
  { value: 'pnl', label: 'Profit & loss', title: 'Profit & Loss Statement', basis: 'period', source: 'Posted journal entries' },
  { value: 'balance_sheet', label: 'Balance sheet', title: 'Balance Sheet', basis: 'asOf', source: 'Posted journal entries' },
  { value: 'trial_balance', label: 'Trial balance', title: 'Trial Balance', basis: 'asOf', source: 'Posted journal entries' },
  { value: 'sales', label: 'Sales', title: 'Sales Report', basis: 'period', source: 'Posted invoices and their settlement records', filter: 'customer' },
  { value: 'purchases', label: 'Purchases', title: 'Purchase Report', basis: 'period', source: 'Posted bills and their settlement records', filter: 'supplier' },
  { value: 'expenses', label: 'Expenses', title: 'Expense Report', basis: 'period', source: 'Posted expense records', filter: 'category' },
  { value: 'ledger', label: 'General ledger', title: 'General Ledger', basis: 'period', source: 'Posted journal lines', filter: 'account' },
  { value: 'cashbank', label: 'Cash & bank', title: 'Cash & Bank Movement', basis: 'period', source: 'Posted journal lines on the money accounts' },
  { value: 'aging', label: 'Aged balances', title: 'Aged Receivables & Payables', basis: 'asOf', source: 'Posted invoices and bills, aged on their own settlement records' },
  { value: 'vat', label: 'VAT return', title: 'VAT Summary', basis: 'period', source: 'Posted journal entries' },
];

/**
 * How many ledger lines one printed sheet renders. Past this the sheet says so
 * and the CSV export carries the full set, rather than the browser laying out a
 * hundred pages nobody asked for.
 */
const REPORT_ROW_LIMIT = 400;

export const ReportsView: React.FC<{
  books: Books; range: DateRange; onRangeChange: (r: DateRange) => void; calendar: 'BS' | 'AD';
}> = ({ books, range, onRangeChange, calendar }) => {
  const {
    accounts, journalEntries, business, integrityIssues, sales, purchases, expenses, payments,
    customers, suppliers,
  } = books;
  const [report, setReport] = useState<ReportType>('pnl');
  const [filters, setFilters] = useState<{ partyId: string; categoryId: string; accountId: string }>({
    partyId: '', categoryId: '', accountId: '',
  });
  /**
   * The aging report's own controls. Its basis is a date rather than a range, so
   * it starts at the end of the selected period — like the balance sheet — and
   * can be moved without disturbing what the other reports read. Which side is
   * shown, and which party it is narrowed to, are display choices only: the
   * amounts come from the same settlement rows either way.
   */
  const [agingSide, setAgingSide] = useState<AgingSide>('RECEIVABLE');
  const [agingPartyId, setAgingPartyId] = useState('');
  const [agingAsOf, setAgingAsOf] = useState('');

  const fy = useMemo(
    () => fiscalYearOf(range.to, business.fiscalYearStartMonth),
    [range.to, business.fiscalYearStartMonth],
  );

  /* ----------------------------- statements ------------------------------ */

  const pnl = useMemo(
    () => AccountingEngine.calculateProfitAndLoss(accounts, journalEntries, range),
    [accounts, journalEntries, range],
  );
  const balanceSheet = useMemo(
    () => AccountingEngine.calculateBalanceSheet(accounts, journalEntries, range.to, fy.startAd),
    [accounts, journalEntries, range.to, fy.startAd],
  );
  const trialBalance = useMemo(
    () => AccountingEngine.calculateTrialBalance(accounts, journalEntries, range.to),
    [accounts, journalEntries, range.to],
  );
  const vat = useMemo(
    () => AccountingEngine.calculateVatReturn(accounts, journalEntries, range),
    [accounts, journalEntries, range],
  );
  const ledger = useMemo(
    () => AccountingEngine.calculateLedger(accounts, journalEntries, {
      range, accountId: filters.accountId || undefined,
    }),
    [accounts, journalEntries, range, filters.accountId],
  );
  const cashBank = useMemo(() => {
    const movements = AccountingEngine.getCashBankMovement(accounts, journalEntries, range).movements;
    const opening = cashBankOpeningBalance(accounts, journalEntries, range.from);
    return cashBankMovement(movements, opening);
  }, [accounts, journalEntries, range]);

  /* -------------------------- document registers -------------------------- */

  const salesRows = useMemo(
    () => salesReport(sales, payments, range, { partyId: filters.partyId || undefined }),
    [sales, payments, range, filters.partyId],
  );
  const purchaseRows = useMemo(
    () => purchaseReport(purchases, payments, range, { partyId: filters.partyId || undefined }),
    [purchases, payments, range, filters.partyId],
  );
  const expenseRows = useMemo(
    () => expenseReport(expenses, range, { categoryId: filters.categoryId || undefined }),
    [expenses, range, filters.categoryId],
  );

  const customerOptions = useMemo(() => partyFilterOptions(sales), [sales]);
  const supplierOptions = useMemo(() => partyFilterOptions(purchases), [purchases]);
  const categoryOptions = useMemo(() => categoryFilterOptions(expenses), [expenses]);

  /* ---------------------- aged receivables and payables ------------------- */

  /** The report's single as-of date: the period end unless it was moved. */
  const asOfDate = agingAsOf || range.to;

  const receivables = useMemo(
    () => receivablesAging(sales, payments, asOfDate, {
      partyId: agingSide === 'RECEIVABLE' ? agingPartyId || undefined : undefined,
      parties: customers,
    }),
    [sales, payments, asOfDate, agingSide, agingPartyId, customers],
  );
  const payables = useMemo(
    () => payablesAging(purchases, payments, asOfDate, {
      partyId: agingSide === 'PAYABLE' ? agingPartyId || undefined : undefined,
      parties: suppliers,
    }),
    [purchases, payments, asOfDate, agingSide, agingPartyId, suppliers],
  );
  const aging = agingSide === 'RECEIVABLE' ? receivables : payables;
  /**
   * What the sheet (and the export) shows: both sides at once, unless the read
   * has been narrowed to one party — then only the side that filter belongs to.
   */
  const agingViews = agingPartyId ? [aging] : [receivables, payables];

  const meta = REPORTS.find((r) => r.value === report)!;
  const errors = integrityIssues.filter((i) => i.severity === 'ERROR');

  const periodLabel = useMemo(
    () => (report === 'aging'
      ? reportPeriodLabel({ ...range, from: asOfDate, to: asOfDate }, calendar, 'asOf')
      : reportPeriodLabel(range, calendar, meta.basis)),
    [report, asOfDate, range, calendar, meta.basis],
  );

  const filterLabel = useMemo(() => filterSummary(
    { partyId: filters.partyId || undefined, categoryId: filters.categoryId || undefined, accountId: filters.accountId || undefined },
    { parties: [...customerOptions, ...supplierOptions], categories: categoryOptions, accounts },
  ), [filters, customerOptions, supplierOptions, categoryOptions, accounts]);

  /** The aging report's filter line: which side, and whose documents. */
  const agingFilterLabel = useMemo(() => {
    const side = agingSide === 'RECEIVABLE' ? 'Every customer' : 'Every supplier';
    if (!agingPartyId) return side;
    const options = agingSide === 'RECEIVABLE' ? customerOptions : supplierOptions;
    const name = options.find((o) => o.value === agingPartyId)?.label;
    return name ? `${agingSide === 'RECEIVABLE' ? 'Customer' : 'Supplier'}: ${name}` : side;
  }, [agingSide, agingPartyId, customerOptions, supplierOptions]);

  const activeFilterLabel = report === 'aging'
    ? agingFilterLabel
    : filterLabel ?? 'None — every record in the period';

  const headerMeta = useMemo<ReportMetaRow[]>(() => (report === 'aging'
    ? [
      { label: 'As of', value: reportShortDate(asOfDate, calendar) },
      { label: 'Source', value: meta.source },
      { label: 'Filter', value: agingFilterLabel },
      // The basis the buckets count from. It is the terms RECORDED with each
      // document (migration 015), so the sheet states where the dates come from
      // rather than claiming there are none.
      { label: 'Aged on', value: 'The due date recorded with each document (document date + agreed terms)' },
    ]
    : [
      ...reportRangeMeta(range, calendar),
      { label: 'Source', value: meta.source },
      { label: 'Filter', value: filterLabel ?? 'None — every record in the period' },
    ]), [report, asOfDate, agingFilterLabel, range, calendar, meta.source, filterLabel]);

  /* --------------------------------- CSV --------------------------------- */

  const exportCsv = () => {
    const header = csvRow(['Zeyks Book', business.businessName])
      + csvRow(['Report', meta.title])
      + csvRow([report === 'aging' ? 'As of' : 'Period', periodLabel])
      + csvRow(['Filter', activeFilterLabel])
      + '\n';
    let body = '';

    if (report === 'pnl') {
      body += csvRow(['Section', 'Code', 'Account', 'Amount']);
      for (const r of pnl.revenueBreakdown) body += csvRow(['Revenue', r.code, r.name, r.amount]);
      body += csvRow(['Revenue', '', 'Total revenue', pnl.totalRevenue]);
      for (const r of pnl.costBreakdown) body += csvRow(['Cost of sales', r.code, r.name, r.amount]);
      body += csvRow(['', '', 'Gross profit', pnl.grossProfit]);
      for (const r of pnl.expenseBreakdown) body += csvRow(['Operating expense', r.code, r.name, r.amount]);
      body += csvRow(['', '', 'Total operating expenses', pnl.operatingExpenses]);
      body += csvRow(['', '', 'Net profit', pnl.netProfit]);
    } else if (report === 'balance_sheet') {
      body += csvRow(['Section', 'Code', 'Account', 'Amount']);
      for (const a of balanceSheet.assetAccounts) body += csvRow(['Assets', a.account.code, a.account.name, a.balance]);
      body += csvRow(['Assets', '', 'Total assets', balanceSheet.totalAssets]);
      for (const l of balanceSheet.liabilityAccounts) body += csvRow(['Liabilities', l.account.code, l.account.name, l.balance]);
      body += csvRow(['Liabilities', '', 'Total liabilities', balanceSheet.totalLiabilities]);
      for (const e of balanceSheet.equityAccounts) body += csvRow(['Equity', e.account.code, e.account.name, e.balance]);
      body += csvRow(['Equity', '', 'Retained earnings brought forward', balanceSheet.retainedBroughtForward]);
      body += csvRow(['Equity', '', 'Profit for the current year', balanceSheet.currentPeriodProfit]);
      body += csvRow(['', '', 'Total equity and liabilities', balanceSheet.totalEquityAndLiabilities]);
    } else if (report === 'trial_balance') {
      body += csvRow(['Code', 'Account', 'Type', 'Debit', 'Credit']);
      for (const r of trialBalance.rows) body += csvRow([r.account.code, r.account.name, r.account.type, r.debit, r.credit]);
      body += csvRow(['', 'Totals', '', trialBalance.totalDebit, trialBalance.totalCredit]);
    } else if (report === 'vat') {
      body += csvRow(['Line', 'Amount']);
      body += csvRow(['Taxable sales (net)', vat.taxableSales]);
      body += csvRow(['Output VAT collected', vat.outputVat]);
      body += csvRow(['Taxable purchases (net)', vat.taxablePurchases]);
      body += csvRow(['Input VAT paid', vat.inputVat]);
      body += csvRow(['Net VAT payable', vat.netPayable]);
      body += csvRow(['Credit carried forward', vat.netCreditCarriedForward]);
    } else if (report === 'ledger') {
      body += csvRow(['Date', 'Ref', 'Account', 'Description', 'Debit', 'Credit', 'Running balance']);
      for (const l of ledger) body += csvRow([l.date, l.reference, l.accountName, l.description, l.debit, l.credit, l.runningBalance]);
    } else if (report === 'cashbank') {
      body += csvRow(['Date', 'Ref', 'Account', 'Description', 'Money in', 'Money out', 'Balance']);
      for (const m of cashBank.rows) {
        body += csvRow([
          m.date, m.reference, m.accountName, m.description,
          m.direction === 'INFLOW' ? m.amount : 0,
          m.direction === 'OUTFLOW' ? m.amount : 0,
          m.balance,
        ]);
      }
      body += csvRow(['', '', '', 'Opening', '', '', cashBank.opening]);
      body += csvRow(['', '', '', 'Closing', cashBank.totalIn, cashBank.totalOut, cashBank.closing]);
    } else if (report === 'sales') {
      body += csvRow(['Date', 'Invoice', 'Customer', 'Amount', 'Settled', 'Outstanding', 'Status']);
      for (const r of salesRows.rows) {
        body += csvRow([r.date, r.reference, r.party, r.total, r.settled, r.outstanding, r.status]);
      }
      body += csvRow(['', '', 'Totals', salesRows.total, salesRows.settled, salesRows.outstanding, '']);
    } else if (report === 'purchases') {
      body += csvRow(['Date', 'Reference', 'Supplier', 'Amount', 'Settled', 'Outstanding', 'Status']);
      for (const r of purchaseRows.rows) {
        body += csvRow([r.date, r.reference, r.party, r.total, r.settled, r.outstanding, r.status]);
      }
      body += csvRow(['', '', 'Totals', purchaseRows.total, purchaseRows.settled, purchaseRows.outstanding, '']);
    } else if (report === 'aging') {
      const bucketHeaders = AGING_BUCKETS.map((b) => AGING_BUCKET_LABELS[b].replace(' days', ''));
      for (const view of agingViews) {
        body += csvRow([]);
        body += csvRow([view.side === 'RECEIVABLE' ? 'Receivables' : 'Payables', ...bucketHeaders, 'Total']);
        body += csvRow([
          'All parties',
          ...AGING_BUCKETS.map((b) => view.summary.buckets[b]),
          view.summary.total,
        ]);
        body += csvRow([]);
        body += csvRow(['Party', ...bucketHeaders, 'Total', 'Documents']);
        for (const p of view.byParty) {
          body += csvRow([p.name, ...AGING_BUCKETS.map((b) => p.buckets[b]), p.total, p.documents]);
        }
        body += csvRow([]);
        body += csvRow([
          'Date', 'Due date', 'Terms', 'Reference', 'Party', 'Total', 'Settled',
          'Outstanding', 'Age (days)', 'Bucket', 'Payment status',
        ]);
        for (const r of view.rows) {
          body += csvRow([
            r.documentDate, r.dueDate, termsLabel(r.termsDays), r.reference, r.partyName,
            r.total, r.settled, r.outstanding,
            r.ageDays, AGING_BUCKET_LABELS[r.bucket], r.status,
          ]);
        }
      }
    } else {
      body += csvRow(['Date', 'Reference', 'Category', 'Description', 'Method', 'Amount']);
      for (const r of expenseRows.rows) {
        body += csvRow([r.date, r.reference, r.category, r.description, r.method, r.amount]);
      }
      body += csvRow(['', '', '', 'Totals', '', expenseRows.total]);
    }

    downloadCsv(`ZeyksBook_${report}_${range.from}_to_${range.to}.csv`, header + body);
  };

  /* -------------------------------- tables ------------------------------- */

  const dateCell = (iso: string): React.ReactNode => (
    <span className="whitespace-nowrap">{reportShortDate(iso, calendar)}</span>
  );

  const documentColumns = (referenceHeader: string, partyHeader: string): ReportColumn<DocumentReportRow>[] => [
    { key: 'date', header: 'Date', render: (r) => dateCell(r.date) },
    { key: 'reference', header: referenceHeader, render: (r) => <span className="font-medium">{r.reference}</span> },
    { key: 'party', header: partyHeader, render: (r) => r.party },
    { key: 'total', header: 'Amount', numeric: true, render: (r) => <ReportAmount value={r.total} dashOnZero={false} /> },
    { key: 'settled', header: 'Settled', numeric: true, render: (r) => <ReportAmount value={r.settled} /> },
    { key: 'outstanding', header: 'Outstanding', numeric: true, render: (r) => <ReportAmount value={r.outstanding} /> },
    { key: 'status', header: 'Payment status', render: (r) => <ReportStatus label={paymentStatusLabel(r.status)} tone={paymentStatusTone(r.status)} /> },
  ];

  const ledgerColumns: ReportColumn<LedgerEntry>[] = [
    { key: 'date', header: 'Date', render: (l) => dateCell(l.date) },
    { key: 'ref', header: 'Ref', quiet: true, render: (l) => <span className="whitespace-nowrap">{l.reference}</span> },
    { key: 'account', header: 'Account', render: (l) => <span className="whitespace-nowrap">{l.accountName}</span> },
    { key: 'description', header: 'Description', quiet: true, render: (l) => l.description },
    { key: 'debit', header: 'Debit', numeric: true, render: (l) => <ReportAmount value={l.debit} /> },
    { key: 'credit', header: 'Credit', numeric: true, render: (l) => <ReportAmount value={l.credit} /> },
    { key: 'balance', header: 'Balance', numeric: true, render: (l) => <ReportAmount value={l.runningBalance} dashOnZero={false} /> },
  ];

  /**
   * The bucket columns, shared by the party rollup and derived from the same
   * ordered list the calculation uses, so a new bucket cannot be added to the
   * arithmetic without appearing on the sheet.
   */
  const bucketColumns = <T extends { buckets: Record<string, number> }>(
    value: (row: T, bucket: typeof AGING_BUCKETS[number]) => number,
  ): ReportColumn<T>[] => AGING_BUCKETS.map((b) => ({
    key: b,
    header: AGING_BUCKET_LABELS[b].replace(' days', ''),
    numeric: true,
    render: (row: T) => <ReportAmount value={value(row, b)} />,
  }));

  const agingPartyColumns: ReportColumn<AgingPartyRow>[] = [
    { key: 'party', header: aging.side === 'RECEIVABLE' ? 'Customer' : 'Supplier', render: (p) => p.name },
    ...bucketColumns<AgingPartyRow>((p, b) => p.buckets[b]),
    { key: 'total', header: 'Total', numeric: true, render: (p) => <ReportAmount value={p.total} dashOnZero={false} /> },
  ];

  const agingRowColumns: ReportColumn<AgingRow>[] = [
    { key: 'date', header: 'Date', render: (r) => dateCell(r.documentDate) },
    // Date, due date and terms read together, so a reader can see why a row is
    // late without a second lookup: a Net 30 bill dated a month ago is not late.
    { key: 'due', header: 'Due', render: (r) => dateCell(r.dueDate) },
    { key: 'terms', header: 'Terms', render: (r) => <span className="report-quiet">{termsLabel(r.termsDays)}</span> },
    { key: 'reference', header: aging.side === 'RECEIVABLE' ? 'Invoice' : 'Reference', render: (r) => <span className="font-medium">{r.reference}</span> },
    { key: 'party', header: aging.side === 'RECEIVABLE' ? 'Customer' : 'Supplier', render: (r) => r.partyName },
    { key: 'total', header: 'Amount', numeric: true, render: (r) => <ReportAmount value={r.total} dashOnZero={false} /> },
    { key: 'settled', header: 'Settled', numeric: true, render: (r) => <ReportAmount value={r.settled} /> },
    { key: 'outstanding', header: 'Outstanding', numeric: true, render: (r) => <ReportAmount value={r.outstanding} dashOnZero={false} /> },
    { key: 'age', header: 'Days late', numeric: true, render: (r) => (r.ageDays === 0 ? <span className="report-quiet">—</span> : r.ageDays) },
    {
      key: 'bucket',
      header: 'Age',
      render: (r) => (
        <>
          <ReportStatus label={AGING_BUCKET_LABELS[r.bucket]} tone={r.bucket === 'NOT_DUE' ? 'neutral' : 'warn'} />
          {r.status === 'PARTIALLY_PAID' && <span className="report-quiet"> part paid</span>}
        </>
      ),
    },
  ];

  const hasData =
    report === 'pnl' ? pnl.totalRevenue !== 0 || pnl.totalExpenses !== 0
    : report === 'balance_sheet' ? balanceSheet.assetAccounts.length > 0 || balanceSheet.liabilityAccounts.length > 0
    : report === 'trial_balance' ? trialBalance.rows.length > 0
    : report === 'vat' ? vat.outputVat !== 0 || vat.inputVat !== 0 || vat.taxableSales !== 0 || vat.taxablePurchases !== 0
    : report === 'ledger' ? ledger.length > 0
    : report === 'cashbank' ? cashBank.rows.length > 0
    : report === 'sales' ? salesRows.rows.length > 0
    : report === 'purchases' ? purchaseRows.rows.length > 0
    : report === 'aging' ? agingViews.some((v) => v.summary.total !== 0)
    : expenseRows.rows.length > 0;

  const voidNote = (count: number): string | null => (
    count > 0
      ? `${count} voided ${count === 1 ? 'document is' : 'documents are'} excluded from this report. `
        + 'A void posts its own reversal, so it is still in the ledger.'
      : null
  );

  /* --------------------------------- body -------------------------------- */

  const body = !hasData ? (
    <ReportEmpty
      title={report === 'aging' ? 'Nothing is outstanding as at this date.' : undefined}
      detail={
        report === 'aging'
          ? (agingPartyId
            ? `No outstanding ${agingSide === 'RECEIVABLE' ? 'invoices' : 'bills'} for "${agingFilterLabel}" as at this date.`
            : 'Every posted invoice and bill is fully settled as at this date.')
          : filterLabel
            ? `No records match the filter "${filterLabel}" in this period.`
            : 'Nothing has been posted to these books in this period yet.'
      }
    />
  ) : report === 'pnl' ? (
    <>
      <ReportSection title="Revenue">
        {pnl.revenueBreakdown.map((r) => <ReportRow key={r.accountId} label={r.name} value={r.amount} indent />)}
        <ReportRow label="Total revenue" value={pnl.totalRevenue} tone="total" />
      </ReportSection>

      <ReportSection title="Cost of sales">
        {pnl.costBreakdown.length === 0
          ? <p className="report-note pl-4">None recorded</p>
          : pnl.costBreakdown.map((r) => <ReportRow key={r.accountId} label={r.name} value={r.amount} indent />)}
        <ReportRow label="Gross profit" value={pnl.grossProfit} tone="total" />
      </ReportSection>

      <ReportSection title="Operating expenses">
        {pnl.expenseBreakdown.length === 0
          ? <p className="report-note pl-4">None recorded</p>
          : pnl.expenseBreakdown.map((r) => <ReportRow key={r.accountId} label={r.name} value={r.amount} indent />)}
        <ReportRow label="Total operating expenses" value={pnl.operatingExpenses} tone="total" />
      </ReportSection>

      <div className="mt-6">
        <ReportRow
          label={`${pnl.netProfit >= 0 ? 'Net profit' : 'Net loss'} for the period`}
          value={pnl.netProfit}
          tone="grand"
        />
      </div>
    </>
  ) : report === 'balance_sheet' ? (
    <>
      <ReportSection title="Assets">
        {balanceSheet.assetAccounts.map((a) => (
          <ReportRow key={a.account.id} label={`${a.account.code}  ${a.account.name}`} value={a.balance} indent />
        ))}
        <ReportRow label="Total assets" value={balanceSheet.totalAssets} tone="total" />
      </ReportSection>

      <ReportSection title="Liabilities">
        {balanceSheet.liabilityAccounts.length === 0
          ? <p className="report-note pl-4">None</p>
          : balanceSheet.liabilityAccounts.map((l) => (
            <ReportRow key={l.account.id} label={`${l.account.code}  ${l.account.name}`} value={l.balance} indent />
          ))}
        <ReportRow label="Total liabilities" value={balanceSheet.totalLiabilities} tone="total" />
      </ReportSection>

      <ReportSection title="Equity">
        {balanceSheet.equityAccounts.map((e) => (
          <ReportRow key={e.account.id} label={`${e.account.code}  ${e.account.name}`} value={e.balance} indent />
        ))}
        <ReportRow label="Retained earnings brought forward" value={balanceSheet.retainedBroughtForward} indent />
        <ReportRow label={`Profit for FY ${fy.label}`} value={balanceSheet.currentPeriodProfit} indent />
        <ReportRow label="Total equity and liabilities" value={balanceSheet.totalEquityAndLiabilities} tone="total" />
      </ReportSection>

      <ReportNote>
        {balanceSheet.isBalanced
          ? 'Assets equal liabilities plus equity.'
          : `Out of balance by ${formatNpr(balanceSheet.totalAssets - balanceSheet.totalEquityAndLiabilities, 'NPR')}. See Data health.`}
      </ReportNote>
    </>
  ) : report === 'trial_balance' ? (
    <>
      <ReportTable
        label="Trial balance"
        columns={[
          { key: 'code', header: 'Code', quiet: true, render: (r: typeof trialBalance.rows[number]) => r.account.code },
          { key: 'account', header: 'Account', render: (r) => (r.account.code === UNLINKED_ACCOUNT_CODE ? (r.account.name.includes('unlinked') ? r.account.name : `${r.account.name} (unlinked)`) : r.account.name) },
          { key: 'type', header: 'Type', quiet: true, render: (r) => r.account.type.toLowerCase() },
          { key: 'debit', header: 'Debit', numeric: true, render: (r) => <ReportAmount value={r.debit} /> },
          { key: 'credit', header: 'Credit', numeric: true, render: (r) => <ReportAmount value={r.credit} /> },
        ]}
        rows={trialBalance.rows}
        totals={{
          code: '', account: '', type: '',
          debit: <ReportAmount value={trialBalance.totalDebit} dashOnZero={false} />,
          credit: <ReportAmount value={trialBalance.totalCredit} dashOnZero={false} />,
        }}
        totalsLabel="Totals"
      />
      {!trialBalance.isBalanced && (
        <ReportNote>
          Debits and credits differ by {reportMoney(trialBalance.totalDebit - trialBalance.totalCredit)}.
          Check Data health before sharing this.
        </ReportNote>
      )}
    </>
  ) : report === 'vat' ? (
    <>
      {!business.vatRegistered && (
        <ReportNote>
          This business is not marked VAT registered, so no tax has been split out of the transactions
          below. Turn it on in Settings if you are registered with the IRD.
        </ReportNote>
      )}
      <ReportSection title="Sales (output tax)">
        <ReportRow label="Taxable sales, net of VAT" value={vat.taxableSales} indent />
        <ReportRow label={`Output VAT collected at ${business.vatRate}%`} value={vat.outputVat} tone="total" />
      </ReportSection>
      <ReportSection title="Purchases (input tax)">
        <ReportRow label="Taxable purchases, net of VAT" value={vat.taxablePurchases} indent />
        <ReportRow label="Input VAT paid" value={vat.inputVat} tone="total" />
      </ReportSection>
      <div className="mt-6">
        <ReportRow
          label={vat.netPayable > 0 ? 'VAT payable to the IRD' : 'Credit carried forward'}
          value={vat.netPayable > 0 ? vat.netPayable : vat.netCreditCarriedForward}
          tone="grand"
        />
      </div>
      <ReportNote>
        Prepared from your own records. Check it against your purchase and sales registers before filing.
      </ReportNote>
    </>
  ) : report === 'ledger' ? (
    <>
      <ReportTable
        label="General ledger"
        columns={ledgerColumns}
        rows={ledger.slice(0, REPORT_ROW_LIMIT)}
      />
      {ledger.length > REPORT_ROW_LIMIT && (
        <ReportNote>
          Showing the first {REPORT_ROW_LIMIT} of {ledger.length} lines. Export the CSV for the full ledger.
        </ReportNote>
      )}
    </>
  ) : report === 'cashbank' ? (
    <>
      <ReportSection title="Movement for the period">
        <ReportRow label="Opening balance" value={cashBank.opening} />
        <ReportRow label="Money in" value={cashBank.totalIn} indent />
        <ReportRow label="Money out" value={-cashBank.totalOut} indent />
        <ReportRow label="Closing balance" value={cashBank.closing} tone="total" />
      </ReportSection>
      <ReportTable
        label="Cash and bank movement"
        columns={[
          { key: 'date', header: 'Date', render: (m: typeof cashBank.rows[number]) => dateCell(m.date) },
          { key: 'ref', header: 'Ref', quiet: true, render: (m) => <span className="whitespace-nowrap">{m.reference}</span> },
          { key: 'account', header: 'Account', render: (m) => <span className="whitespace-nowrap">{m.accountName}</span> },
          { key: 'description', header: 'Description', quiet: true, render: (m) => m.description },
          { key: 'in', header: 'Money in', numeric: true, render: (m) => <ReportAmount value={m.direction === 'INFLOW' ? m.amount : 0} /> },
          { key: 'out', header: 'Money out', numeric: true, render: (m) => <ReportAmount value={m.direction === 'OUTFLOW' ? m.amount : 0} /> },
          { key: 'balance', header: 'Balance', numeric: true, render: (m) => <ReportAmount value={m.balance} dashOnZero={false} /> },
        ]}
        rows={cashBank.rows.slice(0, REPORT_ROW_LIMIT)}
        totals={{
          date: '', ref: '', account: '', description: 'Totals',
          in: <ReportAmount value={cashBank.totalIn} dashOnZero={false} />,
          out: <ReportAmount value={cashBank.totalOut} dashOnZero={false} />,
          balance: <ReportAmount value={cashBank.closing} dashOnZero={false} />,
        }}
        totalsLabel=""
      />
      {cashBank.rows.length > REPORT_ROW_LIMIT && (
        <ReportNote>
          Showing the most recent {REPORT_ROW_LIMIT} of {cashBank.rows.length} movements. Export the CSV
          for the full statement.
        </ReportNote>
      )}
    </>
  ) : report === 'sales' ? (
    <>
      <ReportTable
        label="Sales report"
        columns={documentColumns('Invoice', 'Customer')}
        rows={salesRows.rows}
        totals={{
          date: '', reference: '', party: 'Totals',
          total: <ReportAmount value={salesRows.total} dashOnZero={false} />,
          settled: <ReportAmount value={salesRows.settled} dashOnZero={false} />,
          outstanding: <ReportAmount value={salesRows.outstanding} dashOnZero={false} />,
          status: '',
        }}
        totalsLabel=""
      />
      {voidNote(salesRows.excludedVoided) && <ReportNote>{voidNote(salesRows.excludedVoided)}</ReportNote>}
      <ReportNote>
        Outstanding is the invoice total less every completed, still-posted settlement recorded against it.
      </ReportNote>
    </>
  ) : report === 'aging' ? (
    <>
      {/* Both sides, always at the same date, so the sheet answers "how much is
          owed to me, how much do I owe, and how much of it is late" before the
          reader reaches a single row. */}
      {agingViews.map((view) => (
        <ReportSection
          key={view.side}
          title={view.side === 'RECEIVABLE' ? 'Receivables' : 'Payables'}
          note={`${view.summary.documents} open ${view.summary.documents === 1 ? 'document' : 'documents'} · ${reportMoney(view.summary.invoiced)} billed · ${reportMoney(view.summary.settled)} settled`}
        >
          {AGING_BUCKETS.map((b) => (
            <ReportRow key={b} label={AGING_BUCKET_LABELS[b]} value={view.summary.buckets[b]} indent />
          ))}
          <ReportRow label="Total outstanding" value={view.summary.total} tone="total" />
          <ReportRow label="Of which past due" value={view.summary.overdue} tone="quiet" indent />
        </ReportSection>
      ))}

      <ReportSection
        title={aging.side === 'RECEIVABLE'
          ? `Outstanding by customer — ${reportShortDate(asOfDate, calendar)}`
          : `Outstanding by supplier — ${reportShortDate(asOfDate, calendar)}`}
      >
        <ReportTable
          label="Aging by party"
          columns={agingPartyColumns}
          rows={aging.byParty}
          totals={{
            party: '',
            ...Object.fromEntries(AGING_BUCKETS.map((b) => [b, <ReportAmount key={b} value={aging.summary.buckets[b]} />])),
            total: <ReportAmount value={aging.summary.total} dashOnZero={false} />,
          }}
          totalsLabel="All parties"
        />
      </ReportSection>

      <ReportSection
        title={aging.side === 'RECEIVABLE' ? 'Outstanding invoices' : 'Outstanding bills'}
        note={aging.side === 'RECEIVABLE'
          ? 'Only the amount still outstanding on each invoice is aged, so a part-settled invoice appears once, for its balance.'
          : 'Only the amount still outstanding on each bill is aged, so a part-paid bill appears once, for its balance.'}
      >
        <ReportTable
          label="Aged documents"
          columns={agingRowColumns}
          rows={aging.rows.slice(0, REPORT_ROW_LIMIT)}
          totals={{
            date: '', due: '', terms: '', reference: '', party: '',
            total: <ReportAmount value={aging.summary.invoiced} dashOnZero={false} />,
            settled: <ReportAmount value={aging.summary.settled} dashOnZero={false} />,
            outstanding: <ReportAmount value={aging.summary.total} dashOnZero={false} />,
            age: '', bucket: '',
          }}
          totalsLabel="Totals"
        />
        {aging.rows.length > REPORT_ROW_LIMIT && (
          <ReportNote>
            Showing the oldest {REPORT_ROW_LIMIT} of {aging.rows.length} documents. The totals above, and the
            party rollup before them, cover every outstanding document; export the CSV for the full schedule.
          </ReportNote>
        )}
      </ReportSection>

      {voidNote(aging.excludedVoided) && <ReportNote>{voidNote(aging.excludedVoided)}</ReportNote>}
      {aging.settledCount > 0 && (
        <ReportNote>
          {aging.settledCount} fully settled {aging.side === 'RECEIVABLE' ? 'invoice' : 'bill'}
          {aging.settledCount === 1 ? ' is' : 's are'} not listed: nothing is outstanding on
          {aging.settledCount === 1 ? ' it' : ' them'}.
        </ReportNote>
      )}
      <ReportNote>
        Aging classifies the same live outstanding balance the rest of the app derives — the document
        total less every completed, still-posted settlement row. {AGING_TERMS_NOTE}
      </ReportNote>
    </>
  ) : report === 'purchases' ? (
    <>
      <ReportTable
        label="Purchase report"
        columns={documentColumns('Reference', 'Supplier')}
        rows={purchaseRows.rows}
        totals={{
          date: '', reference: '', party: 'Totals',
          total: <ReportAmount value={purchaseRows.total} dashOnZero={false} />,
          settled: <ReportAmount value={purchaseRows.settled} dashOnZero={false} />,
          outstanding: <ReportAmount value={purchaseRows.outstanding} dashOnZero={false} />,
          status: '',
        }}
        totalsLabel=""
      />
      {voidNote(purchaseRows.excludedVoided) && <ReportNote>{voidNote(purchaseRows.excludedVoided)}</ReportNote>}
      <ReportNote>
        Outstanding is the bill total less every completed, still-posted settlement recorded against it.
      </ReportNote>
    </>
  ) : (
    <>
      <ReportTable
        label="Expense report"
        columns={[
          { key: 'date', header: 'Date', render: (r: typeof expenseRows.rows[number]) => dateCell(r.date) },
          { key: 'reference', header: 'Reference', render: (r) => <span className="font-medium">{r.reference}</span> },
          { key: 'category', header: 'Category', render: (r) => r.category },
          { key: 'description', header: 'Description', quiet: true, render: (r) => r.description },
          { key: 'method', header: 'Payment method', quiet: true, render: (r) => r.method.toLowerCase() },
          { key: 'amount', header: 'Amount', numeric: true, render: (r) => <ReportAmount value={r.amount} dashOnZero={false} /> },
        ]}
        rows={expenseRows.rows}
        totals={{
          date: '', reference: '', category: '', description: 'Totals', method: '',
          amount: <ReportAmount value={expenseRows.total} dashOnZero={false} />,
        }}
        totalsLabel=""
      />
      {voidNote(expenseRows.excludedVoided) && <ReportNote>{voidNote(expenseRows.excludedVoided)}</ReportNote>}
      <ReportNote>
        An expense is settled when it is posted, so it carries no outstanding balance.
      </ReportNote>
    </>
  );

  return (
    <div className="py-6 space-y-5">
      <div className="no-print max-w-5xl mx-auto px-4 sm:px-6 space-y-4">
        <PeriodPicker value={range} onChange={onRangeChange}
          fiscalStartMonth={business.fiscalYearStartMonth} calendar={calendar} />

        <div className="flex flex-wrap items-end justify-between gap-3">
          {/*
           * On a phone this is one scrollable line rather than four wrapped
           * rows: choosing a report should not push the report four screens
           * down. From `sm` up it wraps as before, where there is room.
           */}
          <div
            className="-mx-4 flex w-[calc(100%+2rem)] gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:w-auto sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0"
            role="tablist" aria-label="Report"
          >
            {REPORTS.map((r) => (
              <button key={r.value} type="button" role="tab" aria-selected={report === r.value}
                onClick={() => setReport(r.value)}
                className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  report === r.value ? 'bg-[var(--accent)] text-white' : 'border border-[var(--separator)] bg-[var(--bg)] text-[var(--label-secondary)] hover:bg-[var(--fill-secondary)]'
                }`}>
                {r.label}
              </button>
            ))}
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button className="grow sm:grow-0" onClick={exportCsv}>
              <Download size={13} aria-hidden="true" /> Export CSV
            </Button>
            <Button className="grow sm:grow-0" onClick={() => window.print()}>
              <Printer size={13} aria-hidden="true" /> Print
            </Button>
          </div>
        </div>

        {/* The report's own filter, if it has one. It never changes a printed
            figure by itself: the sheet states which filter produced it. */}
        {meta.filter === 'customer' && (
          <select aria-label="Filter sales by customer" className={`${inputClass} max-w-xs`}
            value={filters.partyId} onChange={(e) => setFilters((f) => ({ ...f, partyId: e.target.value }))}>
            <option value="">Every customer</option>
            {customerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        {meta.filter === 'supplier' && (
          <select aria-label="Filter purchases by supplier" className={`${inputClass} max-w-xs`}
            value={filters.partyId} onChange={(e) => setFilters((f) => ({ ...f, partyId: e.target.value }))}>
            <option value="">Every supplier</option>
            {supplierOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        {meta.filter === 'category' && (
          <select aria-label="Filter expenses by category" className={`${inputClass} max-w-xs`}
            value={filters.categoryId} onChange={(e) => setFilters((f) => ({ ...f, categoryId: e.target.value }))}>
            <option value="">Every category</option>
            {categoryOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        {meta.filter === 'account' && (
          <select aria-label="Filter ledger by account" className={`${inputClass} max-w-xs`}
            value={filters.accountId} onChange={(e) => setFilters((f) => ({ ...f, accountId: e.target.value }))}>
            <option value="">Every account</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
          </select>
        )}

        {report === 'aging' && (
          <div className="flex flex-wrap items-end gap-3 [&>*]:min-w-0">
            <div className="flex gap-1.5" role="group" aria-label="Aged balances side">
              {([['RECEIVABLE', 'Receivables'], ['PAYABLE', 'Payables']] as const).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={agingSide === value}
                  onClick={() => { setAgingSide(value); setAgingPartyId(''); }}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    agingSide === value
                      ? 'bg-[var(--accent)] text-white'
                      : 'border border-[var(--separator)] bg-[var(--bg)] text-[var(--label-secondary)] hover:bg-[var(--fill-secondary)]'
                  }`}>
                  {label}
                </button>
              ))}
            </div>
            <select aria-label="Filter aged balances by party" className={`${inputClass} max-w-xs`}
              value={agingPartyId} onChange={(e) => setAgingPartyId(e.target.value)}>
              <option value="">{agingSide === 'RECEIVABLE' ? 'Every customer' : 'Every supplier'}</option>
              {(agingSide === 'RECEIVABLE' ? customerOptions : supplierOptions)
                .map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <DateField label="As of" value={asOfDate} onChange={setAgingAsOf} calendar={calendar} />
            {agingAsOf && (
              <Button onClick={() => setAgingAsOf('')}>Use period end</Button>
            )}
          </div>
        )}

        {errors.length > 0 && (
          <Callout tone="error">
            {errors.length} unresolved data problem{errors.length === 1 ? '' : 's'} may affect these figures.
            Check Data health before filing or sharing this.
          </Callout>
        )}
      </div>

      <ReportSheet id="report-document">
        <ReportHeader
          business={business}
          title={meta.title}
          subtitle={periodLabel}
          meta={headerMeta}
          calendar={calendar}
          fiscalYearLabel={fy.label}
        />
        <div className="mt-5">{body}</div>
        <ReportFooter
          generatedOn={todayNpt()}
          note={`${meta.source} · ${business.businessName || 'Zeyks Book'}`}
        />
      </ReportSheet>
    </div>
  );
};
