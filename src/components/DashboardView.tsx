import React, { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowRight, Package } from 'lucide-react';
import { DateRange } from '../types';
import { Books } from '../state/useBooks';
import { AccountingEngine } from '../services/accountingEngine';
import { Badge, Button, Callout, DualDate, EmptyState, Money } from './ui';
import { PeriodPicker } from './PeriodPicker';
import { formatCompactNpr, formatNpr, round2 } from '../lib/money';
import { addDays } from '../lib/nepaliDate';
import { outstandingParties, PartyBalanceList } from '../services/reportData';
import { listStockRows, summariseStock } from '../services/inventoryService';
import type { InventoryStockRow } from '../types';
import { planOfRole, ROLE_LABEL, type AppRole } from '../lib/roles';
import { UpgradePlansSection } from './UpgradeViews';

/**
 * One side of the party rollup: the biggest balances, the true total, and how
 * many are not shown. Every figure comes from `outstandingByParty`, which sums
 * each party's outstanding documents — no arithmetic happens here.
 */
const PartyBalances: React.FC<{
  title: string; list: PartyBalanceList; empty: string; symbol: string;
}> = ({ title, list, empty, symbol }) => (
  <div className="rounded-lg border border-[var(--separator)] bg-[var(--bg-tertiary)] px-3 py-2.5">
    <div className="flex items-baseline justify-between gap-3 mb-1.5">
      <p className="text-[11px] font-medium text-[var(--label-secondary)]">{title}</p>
      <Money value={list.total} symbol={symbol} size="sm" />
    </div>
    {list.rows.length === 0 ? (
      <p className="text-[11px] text-[var(--label-tertiary)]">{empty}</p>
    ) : (
      <ul className="space-y-1">
        {list.rows.map((row) => (
          <li key={row.id} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate text-[var(--label)]">{row.name}</span>
            <Money value={row.amount} symbol={symbol} size="sm" />
          </li>
        ))}
        {list.hidden > 0 && (
          <li className="text-[11px] text-[var(--label-tertiary)]">and {list.hidden} more</li>
        )}
      </ul>
    )}
  </div>
);

export const DashboardView: React.FC<{
  books: Books; range: DateRange; onRangeChange: (r: DateRange) => void;
  calendar: 'BS' | 'AD'; onQuickAction: (k: 'sale' | 'purchase' | 'expense' | 'payment') => void;
  canWrite?: boolean;
  onGoToHealth: () => void;
  onGoToInventory?: () => void;
  onGoToTools?: () => void;
  hideHealthBanner?: boolean;
  /** Signed-in role — drives the "your plan / upgrade" card. */
  role?: AppRole;
  onPickPlan?: (plan: 'plus' | 'premium') => void;
}> = ({ books, range, onRangeChange, calendar, onQuickAction, canWrite = true, onGoToHealth, onGoToInventory, onGoToTools, hideHealthBanner = false, role, onPickPlan }) => {
  const {
    accounts, journalEntries, sales, purchases, expenses, payments, business, integrityIssues,
    customers, suppliers, receivableByCustomer, payableBySupplier,
  } = books;
  const symbol = business.currencySymbol;

  const metrics = useMemo(
    () => AccountingEngine.getDashboardMetrics(accounts, journalEntries, { sales, purchases, expenses, payments }, range),
    [accounts, journalEntries, sales, purchases, expenses, payments, range],
  );

  const errors = integrityIssues.filter((i) => i.severity === 'ERROR');

  const owedByCustomers = useMemo(
    () => outstandingParties(receivableByCustomer, customers),
    [receivableByCustomer, customers],
  );
  const owedBySuppliers = useMemo(
    () => outstandingParties(payableBySupplier, suppliers),
    [payableBySupplier, suppliers],
  );

  /**
   * The trend is built from journal entries, so the line and the headline
   * figures come from the same source.
   */
  const [granularity] = useState<'day'>('day');
  void granularity;

  const trend = useMemo(() => {
    const inRange = AccountingEngine.inPeriod(journalEntries, range);
    if (inRange.length === 0) return [];

    const revenueIds = new Set(accounts.filter((a) => a.type === 'REVENUE').map((a) => a.id));
    const expenseIds = new Set(accounts.filter((a) => a.type === 'EXPENSE').map((a) => a.id));
    const byDate = new Map<string, { revenue: number; expenses: number }>();

    for (const entry of inRange) {
      const bucket = byDate.get(entry.transactionDate) ?? { revenue: 0, expenses: 0 };
      for (const line of entry.lines) {
        if (revenueIds.has(line.accountId)) bucket.revenue += line.credit - line.debit;
        if (expenseIds.has(line.accountId)) bucket.expenses += line.debit - line.credit;
      }
      byDate.set(entry.transactionDate, bucket);
    }

    const out: { date: string; Revenue: number; Expenses: number; Profit: number }[] = [];
    const span = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000);
    const step = span > 180 ? 7 : 1;
    for (let d = range.from; d <= range.to; d = addDays(d, step)) {
      let revenue = 0; let expense = 0;
      for (let k = 0; k < step; k += 1) {
        const bucket = byDate.get(addDays(d, k));
        if (bucket) { revenue += bucket.revenue; expense += bucket.expenses; }
      }
      out.push({
        date: d, Revenue: round2(revenue), Expenses: round2(expense), Profit: round2(revenue - expense),
      });
    }
    return out;
  }, [journalEntries, accounts, range]);

  const hasActivity = metrics.revenue !== 0 || metrics.netProfit !== 0 || metrics.recentTransactions.length > 0;

  const kpis = [
    { label: 'Revenue', value: metrics.revenue, hint: 'Net of VAT' },
    { label: 'Gross profit', value: metrics.grossProfit, hint: 'Revenue less cost of sales' },
    { label: 'Operating expenses', value: metrics.operatingExpenses, hint: 'Excludes cost of sales' },
    { label: 'Net profit', value: metrics.netProfit, hint: 'For the selected period' },
  ];

  const positions = [
    { label: 'Cash in hand', value: metrics.cashBalance },
    { label: 'Bank', value: metrics.bankBalance },
    { label: 'eSewa + Khalti', value: metrics.walletBalance },
    { label: 'Receivable', value: metrics.accountsReceivable },
    { label: 'Payable', value: metrics.accountsPayable },
    { label: 'VAT due', value: metrics.vatPayable },
  ];

  return (
    <div className="max-w-5xl mx-auto py-6 px-4 sm:px-6 space-y-8 text-[var(--label)]">
      {errors.length > 0 && !hideHealthBanner && (
        <Callout tone="error">
          <div className="flex items-center justify-between gap-3">
            <span>
              {errors.length === 1 ? 'One problem needs attention' : `${errors.length} problems need attention`} before
              these figures can be relied on.
            </span>
            <Button variant="danger" onClick={onGoToHealth}>Review</Button>
          </div>
        </Callout>
      )}

      <PeriodPicker value={range} onChange={onRangeChange} fiscalStartMonth={business.fiscalYearStartMonth} calendar={calendar} />

      <section aria-label="Performance">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 border-b border-[var(--separator)] pb-6">
          {kpis.map((k) => (
            <div key={k.label}>
              <p className="text-xs font-medium text-[var(--label-secondary)] mb-1">{k.label}</p>
              <Money value={k.value} symbol={symbol} size="xl" />
              <p className="text-[11px] text-[var(--label-tertiary)] mt-1">{k.hint}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-label="Position">
        <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--label-secondary)] mb-3">Where you stand today</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          {positions.map((p) => (
            <div key={p.label} className="rounded-lg border border-[var(--separator)] bg-[var(--bg-tertiary)] px-3 py-2.5">
              <p className="text-[11px] font-medium text-[var(--label-secondary)] mb-0.5">{p.label}</p>
              <Money value={p.value} symbol={symbol} />
            </div>
          ))}
        </div>
        <p className="text-[11px] text-[var(--label-tertiary)] mt-2">
          Liquid total <Money value={metrics.liquidTotal} symbol={symbol} size="sm" />
          {business.trackInventory && <> · Inventory <Money value={metrics.inventoryValue} symbol={symbol} size="sm" /></>}
        </p>
      </section>

      <section aria-label="Outstanding by party">
        <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--label-secondary)] mb-3">Who owes you, and whom you owe</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <PartyBalances title="Owed to you" list={owedByCustomers} symbol={symbol}
            empty="No customer owes anything right now." />
          <PartyBalances title="You owe" list={owedBySuppliers} symbol={symbol}
            empty="No supplier is waiting to be paid." />
        </div>
        <p className="text-[11px] text-[var(--label-tertiary)] mt-2">
          Each party's balance is the sum of their unsettled invoices or bills, so it comes from the same
          settlements the ledger does — a disagreement between the two is reported under Data health.
        </p>
      </section>

      {business.trackInventory && onGoToInventory && (
        <InventorySummarySection businessId={business.id} symbol={symbol} onGoToInventory={onGoToInventory} />
      )}

      {role === 'premium' && onGoToTools && (
        <section aria-label="Premium tools">
          <div className="flex items-end justify-between gap-4 mb-3">
            <div>
              <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--label-secondary)]">Premium tools</h2>
              <p className="mt-1 text-[13px] text-[var(--label-tertiary)]">Plan and review your books without changing posted records.</p>
            </div>
            <Button variant="secondary" onClick={onGoToTools}>Open tools <ArrowRight size={13} aria-hidden="true" /></Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ['Budgets', 'Compare account plans with posted activity.'],
              ['Bank reconciliation', 'Match statement lines to ledger entries.'],
              ['Recurring invoices', 'Schedule repeat sales and post each due invoice.'],
              ['Attachments', 'Keep small supporting files with your business.'],
              ['Fixed assets', 'Track assets and post straight-line depreciation.'],
            ].map(([title, detail]) => (
              <button key={title} type="button" onClick={onGoToTools}
                className="rounded-lg border border-[var(--separator)] bg-[var(--bg-tertiary)] p-3 text-left hover:border-[var(--accent)]">
                <span className="block text-[14px] font-semibold text-[var(--label)]">{title}</span>
                <span className="mt-1 block text-[12px] text-[var(--label-secondary)]">{detail}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Trend">
        <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--label-secondary)] mb-3">Revenue and expenses over the period</h2>
        {trend.length > 1 ? (
          <div className="h-64 rounded-lg border border-[var(--separator)] bg-[var(--bg-tertiary)] p-3">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="var(--separator)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--label-secondary)' }} tickLine={false} axisLine={false}
                  minTickGap={28} tickFormatter={(d: string) => d.slice(5)} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--label-secondary)' }} tickLine={false} axisLine={false} width={48}
                  tickFormatter={formatCompactNpr} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid var(--separator)', backgroundColor: 'var(--bg-tertiary)', color: 'var(--label)' }}
                  formatter={(value) => formatNpr(Number(value ?? 0), symbol)} />
                <Legend wrapperStyle={{ fontSize: 11, color: 'var(--label)' }} />
                <Line type="monotone" dataKey="Revenue" stroke="var(--accent)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Expenses" stroke="#f43f5e" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Profit" stroke="#10b981" strokeWidth={2} dot={false} strokeDasharray="3 3" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyState title="Nothing recorded in this period yet."
            action={canWrite && <Button variant="primary" onClick={() => onQuickAction('sale')}>Record a sale</Button>} />
        )}
      </section>

      <section aria-label="Recent activity">
        <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--label-secondary)] mb-3">Recent activity</h2>
        {hasActivity && metrics.recentTransactions.length > 0 ? (
          <div className="overflow-x-auto border border-[var(--separator)] rounded-lg bg-[var(--bg-tertiary)]">
            <table className="w-full text-xs">
              <thead className="bg-[var(--fill-secondary)] text-[var(--label-secondary)] border-b border-[var(--separator)]">
                <tr>
                  <th scope="col" className="py-2.5 px-3 text-left font-semibold">Date</th>
                  <th scope="col" className="py-2.5 px-3 text-left font-semibold">Type</th>
                  <th scope="col" className="py-2.5 px-3 text-left font-semibold">Detail</th>
                  <th scope="col" className="py-2.5 px-3 text-left font-semibold">Status</th>
                  <th scope="col" className="py-2.5 px-3 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--separator)]">
                {metrics.recentTransactions.map((t) => (
                  <tr key={t.id} className={t.voided ? 'text-[var(--label-tertiary)] line-through' : 'text-[var(--label)]'}>
                    <td className="py-2.5 px-3"><DualDate iso={t.date} calendar={calendar} /></td>
                    <td className="py-2.5 px-3 font-medium">{t.type}</td>
                    <td className="py-2.5 px-3 text-[var(--label-secondary)]">{t.description}</td>
                    <td className="py-2.5 px-3">
                      <Badge tone={t.voided ? 'neutral' : t.status === 'PAID' || t.status === 'COMPLETED' ? 'green'
                        : t.status === 'UNPAID' ? 'rose' : 'amber'}>
                        {t.status.replace('_', ' ').toLowerCase()}
                      </Badge>
                    </td>
                    <td className="py-2.5 px-3 text-right"><Money value={t.amount} symbol={symbol} size="sm" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No activity in this period." />
        )}
      </section>

      {planOfRole(role) && (
        <section aria-label="Your plan">
          <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--label-secondary)] mb-3">
            Your plan — {ROLE_LABEL[role as 'plus' | 'premium']}
          </h2>
          <UpgradePlansSection role={role} onPickPlan={onPickPlan} />
        </section>
      )}
    </div>
  );
};

/**
 * Inventory summary cards on the dashboard. Loads stock rows once per
 * business and renders the four most useful totals: stock value, active
 * items, on-hand quantity, and low-stock count. Gated on trackInventory
 * by the parent, so this only renders for businesses that have opted in.
 */
const InventorySummarySection: React.FC<{
  businessId: string; symbol: string; onGoToInventory: () => void;
}> = ({ businessId, symbol, onGoToInventory }) => {
  const [rows, setRows] = useState<InventoryStockRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listStockRows(businessId, { includeArchived: false }).then(({ rows: r, error }) => {
      if (cancelled) return;
      if (!error) setRows(r);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [businessId]);

  const summary = useMemo(() => summariseStock(rows, { activeOnly: true }), [rows]);

  return (
    <section aria-label="Inventory">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--label-secondary)]">
          <Package size={13} className="inline mr-1.5 -mt-0.5" aria-hidden="true" /> Inventory snapshot
        </h2>
        <button
          type="button" onClick={onGoToInventory}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--accent)] hover:underline">
          View inventory <ArrowRight size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-lg border border-[var(--separator)] bg-[var(--bg-tertiary)] px-3 py-2.5">
          <p className="text-[11px] font-medium text-[var(--label-secondary)] mb-0.5">Stock value</p>
          {loading
            ? <p className="text-[13px] text-[var(--label-tertiary)]">…</p>
            : <Money value={summary.totalStockValue} symbol={symbol} />}
        </div>
        <div className="rounded-lg border border-[var(--separator)] bg-[var(--bg-tertiary)] px-3 py-2.5">
          <p className="text-[11px] font-medium text-[var(--label-secondary)] mb-0.5">Active items</p>
          <p className="text-[15px] font-medium tabular-nums">{summary.activeItems}</p>
        </div>
        <div className="rounded-lg border border-[var(--separator)] bg-[var(--bg-tertiary)] px-3 py-2.5">
          <p className="text-[11px] font-medium text-[var(--label-secondary)] mb-0.5">On hand</p>
          <p className="text-[15px] font-medium tabular-nums">{summary.totalOnHand.toLocaleString('en-NP', { maximumFractionDigits: 2 })}</p>
        </div>
        <div className="rounded-lg border border-[var(--separator)] bg-[var(--bg-tertiary)] px-3 py-2.5">
          <p className="text-[11px] font-medium text-[var(--label-secondary)] mb-0.5">Low / out of stock</p>
          <p className={`text-[15px] font-medium tabular-nums ${summary.outOfStockCount > 0 ? 'text-[var(--destructive)]' : summary.lowStockCount > 0 ? 'text-[var(--accent)]' : ''}`}>
            {summary.lowStockCount} / {summary.outOfStockCount}
          </p>
        </div>
      </div>
    </section>
  );
};
