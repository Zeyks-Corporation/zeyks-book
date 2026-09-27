import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive, ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronUp, Edit3,
  FileBarChart, Package, Plus, RefreshCw, Search,
} from 'lucide-react';
import {
  Badge, Button, Callout, DataTable, EmptyState, Field, inputClass, Modal, Money,
} from './ui';
import type { Column } from './ui';
import type {
  InventoryItem, InventoryMovement, InventoryStockRow,
} from '../types';
import { adToBs, formatBs, formatAd, todayNpt } from '../lib/nepaliDate';
import { formatNpr } from '../lib/money';
import {
  AdjustmentDraft, archiveItem, createItem, ItemDraft,
  listInventoryItems, listMovements, listStockRows, recordAdjustment,
  setTrackInventory, summariseStock, updateItem,
} from '../services/inventoryService';

const InventoryReports = lazy(() => import('./InventoryReports').then((m) => ({ default: m.InventoryReports })));

type SubTab = 'items' | 'adjustments' | 'reports';

const InventoryLoader: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex items-center justify-center py-12">
    <div className="flex flex-col items-center gap-2">
      <div className="w-6 h-6 border-2 border-[var(--separator-opaque)] border-t-[var(--accent)] rounded-full animate-spin" />
      <p className="text-[13px] text-[var(--label-secondary)]">{message}</p>
    </div>
  </div>
);

interface InventoryViewProps {
  businessId: string;
  trackInventory: boolean;
  onTrackChanged: (next: boolean) => void;
  calendar: 'AD' | 'BS';
  notify: (message: string, ok: boolean) => void;
}

export const InventoryView: React.FC<InventoryViewProps> = ({
  businessId, trackInventory, onTrackChanged, calendar, notify,
}) => {
  const [subTab, setSubTab] = useState<SubTab>('items');
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [rows, setRows] = useState<InventoryStockRow[]>([]);
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Modal state — kept at the top level so they render inside React's tree.
  const [editing, setEditing] = useState<InventoryItem | 'new' | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [a, b, c] = await Promise.all([
      listInventoryItems(businessId, { includeArchived: showArchived }),
      listStockRows(businessId, { includeArchived: showArchived }),
      listMovements(businessId, { limit: 500 }),
    ]);
    if (a.error) setError(a.error);
    else if (b.error) setError(b.error);
    else if (c.error) setError(c.error);
    setItems(a.items);
    setRows(b.rows);
    setMovements(c.movements);
    setLoading(false);
  }, [businessId, showArchived]);

  useEffect(() => { void refresh(); }, [refresh]);

  const summary = useMemo(() => summariseStock(rows, { activeOnly: true }), [rows]);
  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) =>
      r.name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q) || r.category.toLowerCase().includes(q));
  }, [rows, search]);

  return (
    <div className="space-y-4">
      {!trackInventory && (
        <Callout tone="warn">
          <strong>Inventory tracking is off.</strong> Sales and purchases will not change stock on hand,
          and the inventory reports will read zero. Turn it on to start tracking.
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <SubTabBar current={subTab} onChange={setSubTab} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {subTab === 'items' && (
            <>
              <label className="inline-flex items-center gap-2 text-[13px] text-[var(--label-secondary)]">
                <input type="checkbox" checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                  className="h-4 w-4 rounded border-[var(--separator-opaque)]" />
                Show archived
              </label>
              <div className="relative">
                <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--label-tertiary)]" aria-hidden="true" />
                <input
                  type="search" placeholder="Search items"
                  value={search} onChange={(e) => setSearch(e.target.value)}
                  className="pl-7 pr-3 py-1.5 rounded-[8px] border border-[var(--separator)] bg-[var(--bg)] text-[13px] w-44"
                />
              </div>
              <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
                <RefreshCw size={13} className="mr-1" aria-hidden="true" /> Refresh
              </Button>
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus size={13} className="mr-1" aria-hidden="true" /> New item
              </Button>
            </>
          )}
          {subTab === 'adjustments' && (
            <Button variant="primary" onClick={() => setAdjusting('')} disabled={items.filter((i) => i.isActive).length === 0}>
              <Plus size={13} className="mr-1" aria-hidden="true" /> New adjustment
            </Button>
          )}
        </div>
      </div>

      <StockSummaryCard summary={summary} />

      {error && <Callout tone="error">{error}</Callout>}

      {subTab === 'items' && (
        loading
          ? <InventoryLoader message="Loading inventory…" />
          : <ItemsTable items={filteredRows}
              onEdit={(it) => setEditing(it)}
              onArchive={(it) => archivePrompt(it, businessId, refresh, notify)}
              onAdjust={(it) => setAdjusting(it.id)} />
      )}

      {subTab === 'adjustments' && (
        loading
          ? <InventoryLoader message="Loading movements…" />
          : <MovementsTable movements={movements} items={items} calendar={calendar} />
      )}

      {subTab === 'reports' && (
        <Suspense fallback={<InventoryLoader message="Loading reports…" />}>
          <InventoryReports businessId={businessId} calendar={calendar}
            rows={rows} movements={movements} items={items} notify={notify} />
        </Suspense>
      )}

      <TrackInventoryToggle businessId={businessId} current={trackInventory} onChanged={onTrackChanged} notify={notify} />

      {editing !== null && (
        <ItemEditorModal
          businessId={businessId}
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
            notify(editing === 'new' ? 'Item added.' : 'Item updated.', true);
          }}
        />
      )}

      {adjusting !== null && (
        <AdjustmentModal
          businessId={businessId}
          items={items}
          presetItemId={adjusting || undefined}
          onClose={() => setAdjusting(null)}
          onSaved={async () => {
            setAdjusting(null);
            await refresh();
            notify('Stock movement recorded.', true);
          }}
        />
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */

const SubTabBar: React.FC<{ current: SubTab; onChange: (t: SubTab) => void }> = ({ current, onChange }) => {
  const tabs: { key: SubTab; label: string; icon: React.ElementType }[] = [
    { key: 'items', label: 'Items', icon: Package },
    { key: 'adjustments', label: 'Stock movements', icon: ArrowDownToLine },
    { key: 'reports', label: 'Reports', icon: FileBarChart },
  ];
  return (
    <div role="tablist" aria-label="Inventory sections" className="inline-flex rounded-[10px] bg-[var(--fill-secondary)] p-0.5">
      {tabs.map(({ key, label, icon: Icon }) => {
        const active = current === key;
        return (
          <button key={key} role="tab" type="button" aria-selected={active}
            onClick={() => onChange(key)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium rounded-[8px] transition-colors ${active ? 'bg-[var(--bg)] text-[var(--label)] shadow-sm' : 'text-[var(--label-secondary)] hover:text-[var(--label)]'}`}>
            <Icon size={13} aria-hidden="true" /> {label}
          </button>
        );
      })}
    </div>
  );
};

const StockSummaryCard: React.FC<{ summary: ReturnType<typeof summariseStock> }> = ({ summary }) => (
  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
    <SummaryTile label="Total items" value={summary.activeItems.toString()} />
    <SummaryTile label="On hand" value={summary.totalOnHand.toLocaleString('en-NP', { maximumFractionDigits: 2 })} />
    <SummaryTile label="Stock value" value={formatNpr(summary.totalStockValue)} />
    <SummaryTile label="Low / out of stock"
      value={`${summary.lowStockCount} / ${summary.outOfStockCount}`}
      tone={summary.outOfStockCount > 0 ? 'rose' : summary.lowStockCount > 0 ? 'amber' : 'neutral'}
    />
  </div>
);

const SummaryTile: React.FC<{ label: string; value: string; tone?: 'neutral' | 'amber' | 'rose' }> = ({ label, value, tone = 'neutral' }) => {
  const toneClass = tone === 'rose' ? 'text-[var(--destructive)]'
    : tone === 'amber' ? 'text-[var(--accent)]'
    : 'text-[var(--label)]';
  return (
    <div className="rounded-[12px] bg-[var(--bg)] border border-[var(--separator)] p-3">
      <p className="text-[12px] leading-[16px] text-[var(--label-secondary)]">{label}</p>
      <p className={`mt-1 text-[18px] leading-[24px] font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
};

/* -------------------------------------------------------------------------- */

const ItemsTable: React.FC<{
  items: InventoryStockRow[];
  onEdit: (it: InventoryStockRow) => void;
  onArchive: (it: InventoryStockRow) => void;
  onAdjust: (it: InventoryStockRow) => void;
}> = ({ items, onEdit, onArchive, onAdjust }) => {
  const [sortBy, setSortBy] = useState<'name' | 'onHand' | 'stockValue'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name) * dir;
      return (a[sortBy] - b[sortBy]) * dir;
    });
  }, [items, sortBy, sortDir]);

  if (items.length === 0) {
    return <EmptyState title="No inventory items yet" action={<Button variant="primary" onClick={() => onEdit({} as InventoryStockRow)}><Plus size={13} className="mr-1" /> New item</Button>} />;
  }

  const SortHead: React.FC<{ id: 'name' | 'onHand' | 'stockValue'; children: React.ReactNode }> = ({ id, children }) => (
    <button type="button" onClick={() => {
      if (sortBy === id) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
      else { setSortBy(id); setSortDir('asc'); }
    }} className="inline-flex items-center gap-1 hover:text-[var(--label)]">
      {children}
      {sortBy === id && (sortDir === 'asc' ? <ChevronUp size={11} aria-hidden="true" /> : <ChevronDown size={11} aria-hidden="true" />)}
    </button>
  );

  const columns: Column<InventoryStockRow>[] = [
    { key: 'sku', header: 'SKU', width: 'w-24', render: (r) => <span className="font-mono text-[12px]">{r.sku}</span> },
    { key: 'name', header: <SortHead id="name">Name</SortHead>, render: (r) => (
      <div>
        <p className="font-medium">{r.name}{!r.isActive && <span className="ml-2"><Badge tone="neutral">archived</Badge></span>}</p>
        {r.description && <p className="text-[12px] text-[var(--label-secondary)] line-clamp-1">{r.description}</p>}
      </div>
    ) },
    { key: 'category', header: 'Category', render: (r) => r.category || <span className="text-[var(--label-tertiary)]">—</span> },
    { key: 'onHand', header: <SortHead id="onHand">On hand</SortHead>, align: 'right', width: 'w-24', render: (r) => (
      <span className={`tabular-nums ${r.onHand <= 0 ? 'text-[var(--destructive)] font-semibold' : ''}`}>
        {r.onHand.toLocaleString('en-NP', { maximumFractionDigits: 2 })}
      </span>
    ) },
    { key: 'reorder', header: 'Reorder at', align: 'right', width: 'w-24', render: (r) => (
      <span className="tabular-nums">
        {r.reorderPoint > 0
          ? <span className={r.onHand <= r.reorderPoint && r.onHand > 0 ? 'text-[var(--accent)] font-semibold' : ''}>
              {r.reorderPoint.toLocaleString('en-NP')}
            </span>
          : <span className="text-[var(--label-tertiary)]">—</span>}
      </span>
    ) },
    { key: 'avgCost', header: 'Avg cost', align: 'right', width: 'w-28', render: (r) => <Money value={r.avgCost} size="sm" muted /> },
    { key: 'stockValue', header: <SortHead id="stockValue">Stock value</SortHead>, align: 'right', width: 'w-32', render: (r) => <Money value={r.stockValue} size="sm" /> },
    { key: 'actions', header: '', width: 'w-32', render: (r) => (
      <div className="flex items-center justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={() => onAdjust(r)} title="Record stock movement" disabled={!r.isActive}>
          <ArrowUpFromLine size={13} aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onEdit(r)} title="Edit">
          <Edit3 size={13} aria-hidden="true" />
        </Button>
        {r.isActive && (
          <Button variant="ghost" size="sm" onClick={() => onArchive(r)} title="Archive">
            <Archive size={13} aria-hidden="true" />
          </Button>
        )}
      </div>
    ) },
  ];

  return <DataTable
    columns={columns}
    rows={sorted}
    searchKeys={(r) => `${r.sku} ${r.name} ${r.category}`}
    empty={<></>}
  />;
};

const MovementsTable: React.FC<{
  movements: InventoryMovement[]; items: InventoryItem[]; calendar: 'AD' | 'BS';
}> = ({ movements, items, calendar }) => {
  const itemName = useMemo(() => {
    const m = new Map(items.map((i) => [i.id, i]));
    return (id: string) => {
      const it = m.get(id);
      return it ? `${it.sku} — ${it.name}` : id;
    };
  }, [items]);
  if (movements.length === 0) {
    return <EmptyState title="No stock movements yet" />;
  }
  const columns: Column<InventoryMovement>[] = [
    { key: 'movementDate', header: 'Date', width: 'w-24', render: (r) => calendar === 'BS' ? formatBs(adToBs(r.movementDate)) : formatAd(r.movementDate) },
    { key: 'direction', header: '', width: 'w-20', render: (r) => (
      <Badge tone={r.direction === 'IN' ? 'green' : 'rose'}>
        {r.direction === 'IN' ? <ArrowDownToLine size={11} className="mr-1" aria-hidden="true" /> : <ArrowUpFromLine size={11} className="mr-1" aria-hidden="true" />}
        {r.direction}
      </Badge>
    ) },
    { key: 'item', header: 'Item', render: (r) => itemName(r.itemId) },
    { key: 'reason', header: 'Reason', width: 'w-32', render: (r) => <Badge tone="blue">{r.reason}</Badge> },
    { key: 'quantity', header: 'Qty', align: 'right', width: 'w-20', render: (r) => <span className="tabular-nums">{r.quantity.toLocaleString('en-NP', { maximumFractionDigits: 2 })}</span> },
    { key: 'unitCost', header: 'Unit cost', align: 'right', width: 'w-28', render: (r) => r.unitCost !== null ? <Money value={r.unitCost} size="sm" muted /> : <span className="text-[var(--label-tertiary)]">—</span> },
    { key: 'notes', header: 'Notes', render: (r) => r.notes || <span className="text-[var(--label-tertiary)]">—</span> },
  ];
  return <DataTable
    columns={columns}
    rows={movements}
    searchKeys={(r) => `${itemName(r.itemId)} ${r.reason} ${r.notes}`}
    empty={<></>}
  />;
};

/* -------------------------------------------------------------------------- */

function archivePrompt(
  item: InventoryStockRow, businessId: string, refresh: () => Promise<void>, notify: (m: string, ok: boolean) => void,
): void {
  const ok = window.confirm(`Archive "${item.name}"? It cannot be picked on new sales or purchases, but past movements are preserved.`);
  if (!ok) return;
  void archiveItem(businessId, item.id).then(async ({ error }) => {
    if (error) { notify(error, false); return; }
    notify('Item archived.', true);
    await refresh();
  });
}

/* -------------------------------------------------------------------------- */

const ItemEditorModal: React.FC<{
  businessId: string;
  item: InventoryItem | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ businessId, item, onClose, onSaved }) => {
  const isNew = item === null;
  const [sku, setSku] = useState(item?.sku ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [unit, setUnit] = useState(item?.unit ?? 'pcs');
  const [category, setCategory] = useState(item?.category ?? '');
  const [defaultCost, setDefaultCost] = useState(String(item?.defaultCost ?? 0));
  const [reorderPoint, setReorderPoint] = useState(String(item?.reorderPoint ?? 0));
  const [reorderQty, setReorderQty] = useState(String(item?.reorderQty ?? 0));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!sku.trim() || !name.trim()) { setError('SKU and name are required.'); return; }
    setSaving(true); setError(null);
    const payload: ItemDraft = {
      sku: sku.trim(),
      name: name.trim(),
      description: description.trim(),
      unit: unit.trim() || 'pcs',
      category: category.trim(),
      defaultCost: Number(defaultCost) || 0,
      reorderPoint: Number(reorderPoint) || 0,
      reorderQty: Number(reorderQty) || 0,
    };
    const res = isNew
      ? await createItem(businessId, payload)
      : await updateItem(businessId, item!.id, payload);
    if (res.error) { setError(res.error); setSaving(false); return; }
    setSaving(false); onSaved();
  };

  return (
    <Modal isOpen onClose={onClose} title={isNew ? 'New inventory item' : 'Edit inventory item'} size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Add item' : 'Save changes'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {error && <Callout tone="error">{error}</Callout>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="SKU" required hint="A short code you can scan or type.">
            {(id) => <input id={id} className={inputClass} value={sku} disabled={saving || !isNew} onChange={(e) => setSku(e.target.value)} />}
          </Field>
          <Field label="Unit" hint="pcs, kg, ltr, box…">
            {(id) => <input id={id} className={inputClass} value={unit} disabled={saving} onChange={(e) => setUnit(e.target.value)} />}
          </Field>
        </div>
        <Field label="Name" required>
          {(id) => <input id={id} className={inputClass} value={name} disabled={saving} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Description">
          {(id) => <input id={id} className={inputClass} value={description} disabled={saving} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label="Category">
          {(id) => <input id={id} className={inputClass} value={category} disabled={saving} onChange={(e) => setCategory(e.target.value)} />}
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Default cost" hint="Per unit, in NPR">
            {(id) => <input id={id} className={inputClass} inputMode="decimal" value={defaultCost} disabled={saving} onChange={(e) => setDefaultCost(e.target.value.replace(/[^0-9.]/g, ''))} />}
          </Field>
          <Field label="Reorder at">
            {(id) => <input id={id} className={inputClass} inputMode="decimal" value={reorderPoint} disabled={saving} onChange={(e) => setReorderPoint(e.target.value.replace(/[^0-9.]/g, ''))} />}
          </Field>
          <Field label="Reorder qty">
            {(id) => <input id={id} className={inputClass} inputMode="decimal" value={reorderQty} disabled={saving} onChange={(e) => setReorderQty(e.target.value.replace(/[^0-9.]/g, ''))} />}
          </Field>
        </div>
      </div>
    </Modal>
  );
};

const AdjustmentModal: React.FC<{
  businessId: string;
  items: InventoryItem[];
  presetItemId?: string;
  onClose: () => void;
  onSaved: () => void;
}> = ({ businessId, items, presetItemId, onClose, onSaved }) => {
  const activeItems = useMemo(() => items.filter((i) => i.isActive), [items]);
  const [itemId, setItemId] = useState(presetItemId ?? activeItems[0]?.id ?? '');
  const [direction, setDirection] = useState<'IN' | 'OUT'>('IN');
  const [reason, setReason] = useState<AdjustmentDraft['reason']>('ADJUST_IN');
  const [date, setDate] = useState(todayNpt());
  const [quantity, setQuantity] = useState('1');
  const [unitCost, setUnitCost] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep reason consistent with direction.
  useEffect(() => {
    if (direction === 'IN' && (reason === 'ADJUST_OUT' || reason === 'SCRAP')) setReason('ADJUST_IN');
    if (direction === 'OUT' && (reason === 'ADJUST_IN' || reason === 'OPENING')) setReason('ADJUST_OUT');
  }, [direction, reason]);

  const save = async () => {
    if (!itemId) { setError('Pick an item first.'); return; }
    const q = Number(quantity);
    if (!q || q <= 0) { setError('Quantity must be positive.'); return; }
    setSaving(true); setError(null);
    const draft: AdjustmentDraft = {
      itemId, date, direction, quantity: q,
      unitCost: unitCost ? Number(unitCost) : undefined,
      reason, notes,
    };
    const res = await recordAdjustment(businessId, draft);
    if (res.error) { setError(res.error); setSaving(false); return; }
    setSaving(false); onSaved();
  };

  return (
    <Modal isOpen onClose={onClose} title="Record stock movement" size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || activeItems.length === 0}>
            {saving ? 'Saving…' : 'Record'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {error && <Callout tone="error">{error}</Callout>}
        {activeItems.length === 0 && <Callout tone="warn">No active inventory items yet — add one first.</Callout>}
        <Field label="Item" required>
          {(id) => (
            <select id={id} className={inputClass} value={itemId} disabled={saving || activeItems.length === 0}
              onChange={(e) => setItemId(e.target.value)}>
              {activeItems.map((it) => (
                <option key={it.id} value={it.id}>{it.sku} — {it.name}</option>
              ))}
            </select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Direction" required>
            {(id) => (
              <select id={id} className={inputClass} value={direction} disabled={saving}
                onChange={(e) => setDirection(e.target.value as 'IN' | 'OUT')}>
                <option value="IN">Stock IN (received / found)</option>
                <option value="OUT">Stock OUT (used / lost)</option>
              </select>
            )}
          </Field>
          <Field label="Reason" required>
            {(id) => (
              <select id={id} className={inputClass} value={reason} disabled={saving}
                onChange={(e) => setReason(e.target.value as AdjustmentDraft['reason'])}>
                {direction === 'IN'
                  ? <>
                      <option value="ADJUST_IN">Adjustment IN</option>
                      <option value="OPENING">Opening balance</option>
                    </>
                  : <>
                      <option value="ADJUST_OUT">Adjustment OUT</option>
                      <option value="SCRAP">Scrap / damage</option>
                    </>}
              </select>
            )}
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Date" required>
            {(id) => <input id={id} type="date" className={inputClass} value={date} disabled={saving} onChange={(e) => setDate(e.target.value)} />}
          </Field>
          <Field label="Quantity" required>
            {(id) => <input id={id} className={inputClass} inputMode="decimal" value={quantity} disabled={saving} onChange={(e) => setQuantity(e.target.value.replace(/[^0-9.]/g, ''))} />}
          </Field>
          <Field label="Unit cost" hint="Optional — feeds the weighted average">
            {(id) => <input id={id} className={inputClass} inputMode="decimal" value={unitCost} disabled={saving} onChange={(e) => setUnitCost(e.target.value.replace(/[^0-9.]/g, ''))} />}
          </Field>
        </div>
        <Field label="Notes">
          {(id) => <input id={id} className={inputClass} value={notes} disabled={saving} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
};

/* -------------------------------------------------------------------------- */

const TrackInventoryToggle: React.FC<{
  businessId: string; current: boolean;
  onChanged: (next: boolean) => void; notify: (m: string, ok: boolean) => void;
}> = ({ businessId, current, onChanged, notify }) => {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    const next = !current;
    const { error } = await setTrackInventory(businessId, next);
    if (error) { notify(error, false); setBusy(false); return; }
    notify(next ? 'Inventory tracking enabled.' : 'Inventory tracking disabled.', true);
    onChanged(next);
    setBusy(false);
  };
  return (
    <div className="rounded-[12px] bg-[var(--bg)] border border-[var(--separator)] p-4 flex items-center justify-between gap-3">
      <div>
        <p className="text-[15px] font-medium text-[var(--label)]">Inventory tracking</p>
        <p className="text-[13px] text-[var(--label-secondary)] mt-0.5">
          When on, sales reduce on-hand stock and purchases add to it. The default chart of
          accounts already has an Inventory (1060) account.
        </p>
      </div>
      <Button variant={current ? 'danger' : 'primary'} onClick={() => void toggle()} disabled={busy}>
        {busy ? 'Saving…' : current ? 'Turn off' : 'Turn on'}
      </Button>
    </div>
  );
};

/* -------------------------------------------------------------------------- */

export const _test = { summariseStock };