import React, { useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, BarChart3, Boxes, Coins, PackageX, Timer } from 'lucide-react';
import { Badge, Callout, DataTable, EmptyState, Money } from './ui';
import type { Column } from './ui';
import type { InventoryItem, InventoryMovement, InventoryStockRow } from '../types';
import { adToBs, formatBs, formatAd } from '../lib/nepaliDate';
import { rankBySoldQuantity, deadStock, summariseStock } from '../services/inventoryService';

interface InventoryReportsProps {
  businessId: string;
  calendar: 'AD' | 'BS';
  rows: InventoryStockRow[];
  movements: InventoryMovement[];
  items: InventoryItem[];
  notify: (m: string, ok: boolean) => void;
}

type ReportKey = 'summary' | 'ledger' | 'valuation' | 'low' | 'fast' | 'dead';

const REPORT_DEFS: { key: ReportKey; label: string; icon: React.ElementType; hint: string }[] = [
  { key: 'summary', label: 'Stock summary', icon: Boxes, hint: 'Every item, its on-hand qty, weighted-average cost and stock value.' },
  { key: 'ledger', label: 'Stock ledger', icon: Timer, hint: 'Every movement, newest first.' },
  { key: 'valuation', label: 'Valuation', icon: Coins, hint: 'Stock value grouped by category.' },
  { key: 'low', label: 'Low stock', icon: ArrowDownToLine, hint: 'Items at or below their reorder point.' },
  { key: 'fast', label: 'Fast moving', icon: BarChart3, hint: 'Top sellers in the last 30 days.' },
  { key: 'dead', label: 'Dead stock', icon: PackageX, hint: 'Active items with on-hand qty that have not sold in 90 days.' },
];

export const InventoryReports: React.FC<InventoryReportsProps> = ({ calendar, rows, movements, items }) => {
  const [current, setCurrent] = useState<ReportKey>('summary');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {REPORT_DEFS.map(({ key, label, icon: Icon, hint }) => {
          const active = current === key;
          return (
            <button key={key} type="button" role="tab" aria-selected={active} title={hint}
              onClick={() => setCurrent(key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium rounded-[8px] border transition-colors ${active
                ? 'bg-[var(--accent)] text-white border-transparent'
                : 'bg-[var(--bg)] text-[var(--label-secondary)] border-[var(--separator)] hover:text-[var(--label)]'}`}>
              <Icon size={13} aria-hidden="true" /> {label}
            </button>
          );
        })}
      </div>
      <p className="text-[12px] text-[var(--label-tertiary)]">
        {REPORT_DEFS.find((r) => r.key === current)?.hint}
      </p>

      {current === 'summary' && <StockSummaryReport rows={rows} />}
      {current === 'ledger' && <StockLedgerReport movements={movements} items={items} calendar={calendar} />}
      {current === 'valuation' && <ValuationReport rows={rows} />}
      {current === 'low' && <LowStockReport rows={rows} />}
      {current === 'fast' && <FastMovingReport movements={movements} items={items} />}
      {current === 'dead' && <DeadStockReport rows={rows} movements={movements} />}
    </div>
  );
};

/* -------------------------------------------------------------------------- */

const StockSummaryReport: React.FC<{ rows: InventoryStockRow[] }> = ({ rows }) => {
  const summary = summariseStock(rows, { activeOnly: true });
  if (rows.length === 0) return <EmptyState title="No data yet" />;
  const columns: Column<InventoryStockRow>[] = [
    { key: 'sku', header: 'SKU', width: 'w-24', render: (r) => <span className="font-mono text-[12px]">{r.sku}</span> },
    { key: 'name', header: 'Item', render: (r) => r.name },
    { key: 'category', header: 'Category', render: (r) => r.category || '—' },
    { key: 'unit', header: 'Unit', render: (r) => r.unit },
    { key: 'onHand', header: 'On hand', align: 'right', render: (r) => <span className="tabular-nums">{r.onHand.toLocaleString('en-NP', { maximumFractionDigits: 2 })}</span> },
    { key: 'avgCost', header: 'Avg cost', align: 'right', render: (r) => <Money value={r.avgCost} size="sm" muted /> },
    { key: 'stockValue', header: 'Stock value', align: 'right', render: (r) => <Money value={r.stockValue} size="sm" /> },
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Items" value={summary.activeItems.toString()} />
        <Tile label="Total on hand" value={summary.totalOnHand.toLocaleString('en-NP', { maximumFractionDigits: 2 })} />
        <Tile label="Stock value" value={<Money value={summary.totalStockValue} />} />
        <Tile label="Low stock" value={`${summary.lowStockCount} item${summary.lowStockCount === 1 ? '' : 's'}`} />
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        searchKeys={(r) => `${r.sku} ${r.name} ${r.category}`}
        empty={<EmptyState title="No data yet" />}
      />
    </div>
  );
};

const StockLedgerReport: React.FC<{
  movements: InventoryMovement[]; items: InventoryItem[]; calendar: 'AD' | 'BS';
}> = ({ movements, items, calendar }) => {
  const itemName = useMemo(() => {
    const m = new Map(items.map((i) => [i.id, i]));
    return (id: string) => {
      const it = m.get(id);
      return it ? `${it.sku} — ${it.name}` : id;
    };
  }, [items]);
  if (movements.length === 0) return <EmptyState title="No movements yet" />;
  const columns: Column<InventoryMovement>[] = [
    { key: 'movementDate', header: 'Date', width: 'w-24', render: (r) => calendar === 'BS' ? formatBs(adToBs(r.movementDate)) : formatAd(r.movementDate) },
    { key: 'direction', header: '', width: 'w-20', render: (r) => (
      <Badge tone={r.direction === 'IN' ? 'green' : 'rose'}>
        {r.direction === 'IN' ? <ArrowDownToLine size={11} className="mr-1" /> : <ArrowUpFromLine size={11} className="mr-1" />}
        {r.direction}
      </Badge>
    ) },
    { key: 'item', header: 'Item', render: (r) => itemName(r.itemId) },
    { key: 'reason', header: 'Reason', width: 'w-32', render: (r) => <Badge tone="blue">{r.reason}</Badge> },
    { key: 'quantity', header: 'Qty', align: 'right', width: 'w-20', render: (r) => <span className="tabular-nums">{r.quantity.toLocaleString('en-NP', { maximumFractionDigits: 2 })}</span> },
    { key: 'unitCost', header: 'Unit cost', align: 'right', width: 'w-28', render: (r) => r.unitCost !== null ? <Money value={r.unitCost} size="sm" muted /> : '—' },
    { key: 'notes', header: 'Notes', render: (r) => r.notes || '—' },
  ];
  return <DataTable
    columns={columns}
    rows={movements}
    searchKeys={(r) => `${itemName(r.itemId)} ${r.reason} ${r.notes}`}
    empty={<EmptyState title="No movements yet" />}
  />;
};

const ValuationReport: React.FC<{ rows: InventoryStockRow[] }> = ({ rows }) => {
  const grouped = useMemo(() => {
    const m = new Map<string, { id: string; category: string; count: number; qty: number; value: number }>();
    for (const r of rows) {
      const key = r.category || '(no category)';
      const cur = m.get(key) ?? { id: key, category: key, count: 0, qty: 0, value: 0 };
      cur.count += 1;
      cur.qty += r.onHand;
      cur.value += r.stockValue;
      m.set(key, cur);
    }
    return Array.from(m.values()).sort((a, b) => b.value - a.value);
  }, [rows]);

  if (grouped.length === 0) return <EmptyState title="No data yet" />;
  const total = grouped.reduce((sum, g) => sum + g.value, 0);
  const columns: Column<typeof grouped[number]>[] = [
    { key: 'category', header: 'Category', render: (r) => r.category },
    { key: 'count', header: 'Items', align: 'right', width: 'w-20', render: (r) => r.count.toString() },
    { key: 'qty', header: 'Total qty', align: 'right', width: 'w-28', render: (r) => <span className="tabular-nums">{r.qty.toLocaleString('en-NP', { maximumFractionDigits: 2 })}</span> },
    { key: 'value', header: 'Stock value', align: 'right', width: 'w-32', render: (r) => <Money value={r.value} size="sm" /> },
    { key: 'pct', header: 'Share', align: 'right', width: 'w-20', render: (r) => total > 0 ? `${((r.value / total) * 100).toFixed(1)}%` : '—' },
  ];
  return (
    <div className="space-y-3">
      <Callout tone="info">
        Total stock value: <strong><Money value={total} /></strong> across {grouped.length} categor{grouped.length === 1 ? 'y' : 'ies'}.
      </Callout>
      <DataTable
        columns={columns}
        rows={grouped}
        searchKeys={(r) => r.category}
        empty={<EmptyState title="No data yet" />}
      />
    </div>
  );
};

const LowStockReport: React.FC<{ rows: InventoryStockRow[] }> = ({ rows }) => {
  const low = useMemo(() => rows
    .filter((r) => r.isActive && r.onHand <= r.reorderPoint && r.reorderPoint > 0)
    .sort((a, b) => (a.onHand / Math.max(a.reorderPoint, 1)) - (b.onHand / Math.max(b.reorderPoint, 1))), [rows]);
  if (low.length === 0) return <EmptyState title="Nothing is below its reorder point" />;
  const columns: Column<InventoryStockRow>[] = [
    { key: 'sku', header: 'SKU', width: 'w-24', render: (r) => <span className="font-mono text-[12px]">{r.sku}</span> },
    { key: 'name', header: 'Item', render: (r) => r.name },
    { key: 'onHand', header: 'On hand', align: 'right', render: (r) => <span className="tabular-nums">{r.onHand.toLocaleString('en-NP', { maximumFractionDigits: 2 })}</span> },
    { key: 'reorder', header: 'Reorder at', align: 'right', render: (r) => r.reorderPoint.toLocaleString('en-NP') },
    { key: 'gap', header: 'To reorder', align: 'right', width: 'w-28', render: (r) => {
      const gap = Math.max(r.reorderQty, r.reorderPoint - r.onHand);
      return gap > 0 ? <Badge tone="amber">{gap.toLocaleString('en-NP', { maximumFractionDigits: 2 })}</Badge> : '—';
    } },
  ];
  return <DataTable
    columns={columns}
    rows={low}
    searchKeys={(r) => `${r.sku} ${r.name}`}
    empty={<EmptyState title="Nothing is below its reorder point" />}
  />;
};

const FastMovingReport: React.FC<{ movements: InventoryMovement[]; items: InventoryItem[] }> = ({ movements, items }) => {
  const since = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  }, []);
  const ranked = useMemo(() => rankBySoldQuantity(movements, { since }), [movements, since]);
  if (ranked.length === 0) return <EmptyState title="No sales in the last 30 days" />;
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const enriched = ranked.map((r, idx) => ({ ...r, id: r.itemId, item: itemMap.get(r.itemId), rank: idx + 1 }));
  const columns: Column<typeof enriched[number]>[] = [
    { key: 'rank', header: '#', width: 'w-12', render: (r) => <Badge tone="blue">{r.rank}</Badge> },
    { key: 'name', header: 'Item', render: (r) => r.item ? `${r.item.sku} — ${r.item.name}` : r.itemId },
    { key: 'soldQty', header: 'Sold (30d)', align: 'right', render: (r) => <span className="tabular-nums">{r.soldQty.toLocaleString('en-NP', { maximumFractionDigits: 2 })}</span> },
  ];
  return (
    <div className="space-y-3">
      <Callout tone="info">Sales counted from {since} onward.</Callout>
      <DataTable
        columns={columns}
        rows={enriched}
        searchKeys={(r) => r.item ? `${r.item.sku} ${r.item.name}` : r.itemId}
        empty={<EmptyState title="No sales in the last 30 days" />}
      />
    </div>
  );
};

const DeadStockReport: React.FC<{ rows: InventoryStockRow[]; movements: InventoryMovement[] }> = ({ rows, movements }) => {
  const since = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  }, []);
  const dead = useMemo(() => deadStock(rows, movements, since), [rows, movements, since]);
  if (dead.length === 0) return <EmptyState title="No dead stock — every active item has sold in the last 90 days" />;
  const columns: Column<InventoryStockRow>[] = [
    { key: 'sku', header: 'SKU', width: 'w-24', render: (r) => <span className="font-mono text-[12px]">{r.sku}</span> },
    { key: 'name', header: 'Item', render: (r) => r.name },
    { key: 'category', header: 'Category', render: (r) => r.category || '—' },
    { key: 'onHand', header: 'On hand', align: 'right', render: (r) => <span className="tabular-nums">{r.onHand.toLocaleString('en-NP', { maximumFractionDigits: 2 })}</span> },
    { key: 'avgCost', header: 'Avg cost', align: 'right', render: (r) => <Money value={r.avgCost} size="sm" muted /> },
    { key: 'stockValue', header: 'Tied-up capital', align: 'right', render: (r) => <Money value={r.stockValue} size="sm" /> },
  ];
  return (
    <div className="space-y-3">
      <Callout tone="warn">
        Items with stock on hand that have not sold since {since}. Consider discounting or bundling.
      </Callout>
      <DataTable
        columns={columns}
        rows={dead}
        searchKeys={(r) => `${r.sku} ${r.name} ${r.category}`}
        empty={<EmptyState title="No dead stock — every active item has sold in the last 90 days" />}
      />
    </div>
  );
};

const Tile: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="rounded-[12px] bg-[var(--bg)] border border-[var(--separator)] p-3">
    <p className="text-[12px] leading-[16px] text-[var(--label-secondary)]">{label}</p>
    <p className="mt-1 text-[18px] leading-[24px] font-semibold text-[var(--label)]">{value}</p>
  </div>
);