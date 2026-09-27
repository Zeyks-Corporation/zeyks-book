/**
 * Stage 21 — Inventory service.
 *
 * Talks to the cloud RPCs and views in migration 020:
 *   - inventory_items            (table)
 *   - inventory_movements        (table)
 *   - inventory_stock_value      (view)
 *   - create_inventory_item, update_inventory_item, archive_inventory_item
 *   - record_inventory_adjustment
 *   - set_business_track_inventory
 *
 * Sale/purchase lines carry an `inventory_item_id`, but the movements
 * themselves are written by database triggers (020) so this service never has
 * to remember to keep the books and the stock in step.
 */
import type {
  InventoryItem, InventoryMovement, InventoryStockRow,
  InventoryMovementReason,
} from '../types';
import { supabase } from '../lib/supabase';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface RawItem {
  id: string;
  business_id: string;
  sku: string;
  name: string;
  description: string;
  unit: string;
  category: string;
  default_cost: string | number;
  reorder_point: string | number;
  reorder_qty: string | number;
  is_active: boolean;
  created_at: string;
  created_by: string;
}

interface RawStockRow extends RawItem {
  on_hand: string | number;
  avg_cost: string | number;
  stock_value: string | number;
}

interface RawMovement {
  id: string;
  business_id: string;
  item_id: string;
  movement_date: string;
  direction: 'IN' | 'OUT';
  reason: InventoryMovementReason;
  quantity: string | number;
  unit_cost: string | number | null;
  source_type: 'SALE' | 'PURCHASE' | 'ADJUSTMENT' | 'OPENING' | null;
  source_id: string | null;
  signed_quantity: string | number;
  notes: string;
  created_at: string;
  created_by: string;
}

function asNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function itemFromRow(r: RawItem): InventoryItem {
  return {
    id: r.id,
    businessId: r.business_id,
    sku: r.sku,
    name: r.name,
    description: r.description ?? '',
    unit: r.unit,
    category: r.category ?? '',
    defaultCost: asNumber(r.default_cost),
    reorderPoint: asNumber(r.reorder_point),
    reorderQty: asNumber(r.reorder_qty),
    isActive: !!r.is_active,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function stockRowFromRow(r: RawStockRow): InventoryStockRow {
  return {
    ...itemFromRow(r),
    onHand: asNumber(r.on_hand),
    avgCost: asNumber(r.avg_cost),
    stockValue: asNumber(r.stock_value),
  };
}

function movementFromRow(r: RawMovement): InventoryMovement {
  return {
    id: r.id,
    businessId: r.business_id,
    itemId: r.item_id,
    movementDate: r.movement_date,
    direction: r.direction,
    reason: r.reason,
    quantity: asNumber(r.quantity),
    unitCost: r.unit_cost === null ? null : asNumber(r.unit_cost),
    sourceType: r.source_type,
    sourceId: r.source_id,
    signedQuantity: asNumber(r.signed_quantity),
    notes: r.notes ?? '',
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

/* ------------------------- Reads ------------------------- */

export async function listInventoryItems(
  businessId: string, opts: { includeArchived?: boolean } = {},
): Promise<{ items: InventoryItem[]; error: string | null }> {
  let q = supabase.from('inventory_items').select('*')
    .eq('business_id', businessId)
    .order('name', { ascending: true });
  if (!opts.includeArchived) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) return { items: [], error: error.message };
  return { items: (data ?? []).map((r) => itemFromRow(r as RawItem)), error: null };
}

export async function listStockRows(
  businessId: string, opts: { includeArchived?: boolean } = {},
): Promise<{ rows: InventoryStockRow[]; error: string | null }> {
  let q = supabase.from('inventory_stock_value').select('*')
    .eq('business_id', businessId)
    .order('name', { ascending: true });
  if (!opts.includeArchived) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []).map((r) => stockRowFromRow(r as RawStockRow)), error: null };
}

export async function listMovements(
  businessId: string, opts: { itemId?: string; from?: string; to?: string; limit?: number } = {},
): Promise<{ movements: InventoryMovement[]; error: string | null }> {
  let q = supabase.from('inventory_movements').select('*')
    .eq('business_id', businessId)
    .order('movement_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (opts.itemId) q = q.eq('item_id', opts.itemId);
  if (opts.from) q = q.gte('movement_date', opts.from);
  if (opts.to) q = q.lte('movement_date', opts.to);
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) return { movements: [], error: error.message };
  return { movements: (data ?? []).map((r) => movementFromRow(r as RawMovement)), error: null };
}

/* ------------------------- Writes ------------------------- */

export interface ItemDraft {
  sku: string;
  name: string;
  description?: string;
  unit?: string;
  category?: string;
  defaultCost?: number;
  reorderPoint?: number;
  reorderQty?: number;
}

export async function createItem(
  businessId: string, draft: ItemDraft,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('create_inventory_item', {
    p_business_id: businessId,
    p_sku: draft.sku,
    p_name: draft.name,
    p_description: draft.description ?? '',
    p_unit: draft.unit ?? 'pcs',
    p_category: draft.category ?? '',
    p_default_cost: draft.defaultCost ?? 0,
    p_reorder_point: draft.reorderPoint ?? 0,
    p_reorder_qty: draft.reorderQty ?? 0,
  });
  if (error) return { id: null, error: error.message };
  return { id: data as string, error: null };
}

export async function updateItem(
  businessId: string, itemId: string, patch: Partial<ItemDraft> & { isActive?: boolean },
): Promise<{ error: string | null }> {
  const args: Record<string, unknown> = {
    p_business_id: businessId,
    p_item_id: itemId,
    p_name: patch.name ?? '',
    p_description: patch.description ?? null,
    p_unit: patch.unit ?? null,
    p_category: patch.category ?? null,
    p_default_cost: patch.defaultCost ?? null,
    p_reorder_point: patch.reorderPoint ?? null,
    p_reorder_qty: patch.reorderQty ?? null,
    p_is_active: patch.isActive ?? null,
  };
  const { error } = await supabase.rpc('update_inventory_item', args);
  if (error) return { error: error.message };
  return { error: null };
}

export async function archiveItem(
  businessId: string, itemId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('archive_inventory_item', {
    p_business_id: businessId, p_item_id: itemId,
  });
  if (error) return { error: error.message };
  return { error: null };
}

export interface AdjustmentDraft {
  itemId: string;
  date: string;
  direction: 'IN' | 'OUT';
  quantity: number;
  unitCost?: number;
  reason: InventoryMovementReason;
  notes?: string;
}

export async function recordAdjustment(
  businessId: string, draft: AdjustmentDraft,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('record_inventory_adjustment', {
    p_business_id: businessId,
    p_item_id: draft.itemId,
    p_date: draft.date,
    p_direction: draft.direction,
    p_quantity: draft.quantity,
    p_unit_cost: draft.unitCost ?? null,
    p_reason: draft.reason,
    p_notes: draft.notes ?? '',
  });
  if (error) return { id: null, error: error.message };
  return { id: data as string, error: null };
}

export async function setTrackInventory(
  businessId: string, track: boolean,
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('set_business_track_inventory', {
    p_business_id: businessId, p_track_inventory: track,
  });
  if (error) return { error: error.message };
  return { error: null };
}

/* ------------------------- Reports ------------------------- */

export interface StockSummary {
  totalItems: number;
  activeItems: number;
  totalOnHand: number;
  totalStockValue: number;
  lowStockCount: number;
  outOfStockCount: number;
}

/** Pure function exposed for tests. Aggregates stock rows into the dashboard summary. */
export function summariseStock(
  rows: InventoryStockRow[],
  opts: { activeOnly?: boolean } = {},
): StockSummary {
  const filtered = opts.activeOnly ? rows.filter((r) => r.isActive) : rows;
  let totalOnHand = 0;
  let totalStockValue = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;
  for (const r of filtered) {
    totalOnHand += r.onHand;
    totalStockValue += r.stockValue;
    if (r.onHand <= 0) {
      outOfStockCount += 1;
    } else if (r.reorderPoint > 0 && r.onHand <= r.reorderPoint) {
      lowStockCount += 1;
    }
  }
  return {
    totalItems: rows.length,
    activeItems: filtered.length,
    totalOnHand,
    totalStockValue,
    lowStockCount,
    outOfStockCount,
  };
}

/** Pure function exposed for tests. Fast-moving ranking by sold quantity. */
export function rankBySoldQuantity(
  movements: { itemId: string; direction: 'IN' | 'OUT'; signedQuantity: number; movementDate: string }[],
  opts: { since: string; limit?: number },
): Array<{ itemId: string; soldQty: number }> {
  const totals = new Map<string, number>();
  for (const m of movements) {
    if (m.direction !== 'OUT') continue;
    if (m.movementDate < opts.since) continue;
    totals.set(m.itemId, (totals.get(m.itemId) ?? 0) + m.signedQuantity);
  }
  const arr = Array.from(totals.entries())
    .map(([itemId, soldQty]) => ({ itemId, soldQty: -soldQty /* OUT is negative */ }))
    .sort((a, b) => b.soldQty - a.soldQty);
  return opts.limit ? arr.slice(0, opts.limit) : arr;
}

/** Pure function exposed for tests. Dead stock = active items with on-hand > 0 and zero OUT since `since`. */
export function deadStock(
  rows: InventoryStockRow[],
  movements: { itemId: string; direction: 'IN' | 'OUT'; movementDate: string }[],
  since: string,
): InventoryStockRow[] {
  const moved = new Set<string>();
  for (const m of movements) {
    if (m.direction === 'OUT' && m.movementDate >= since) moved.add(m.itemId);
  }
  return rows.filter((r) => r.isActive && r.onHand > 0 && !moved.has(r.id));
}