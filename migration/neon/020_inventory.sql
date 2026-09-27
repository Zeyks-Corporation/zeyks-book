-- 020_inventory.sql
-- Stage 21 — Inventory Management System.
--
-- Adds two new tables, an optional FK on existing document line tables, the
-- RPCs that the UI talks to, the view the reports read from, and RLS.
--
-- Design decisions worth flagging in this header:
--
--   * `sale_items.inventory_item_id` and `purchase_items.inventory_item_id`
--     are NULLABLE, so a sale/purchase line that does not draw from stock
--     (services, freight, sundry items) still posts normally. The line description
--     is what the user typed; the FK is metadata.
--
--   * `inventory_items` carries a `default_cost` (per-unit) for the *first*
--     intake. After that, the cost on hand is the weighted average from
--     `inventory_movements`, recomputed by the `inventory_stock_value` view on
--     every read. There is no `current_cost` column to drift out of sync.
--
--   * Every change in on-hand qty is a row in `inventory_movements` with a
--     reason (`PURCHASE`, `SALE`, `ADJUST_IN`, `ADJUST_OUT`, `SCRAP`,
--     `OPENING`, `VOID_REVERSAL`). The postings RPCs and the voiding RPCs write
--     movements in the same transaction as the journal, so the books and the
--     stock can never disagree.
--
--   * Averages are computed over receipts only (`direction = 'IN'` and reason
--     in {PURCHASE, OPENING, ADJUST_IN}) so a sale at zero cost does not pull
--     the average down. Movements with a NULL unit_cost are excluded from the
--     weighted-average computation, not from the on-hand total.
--
-- Rules every RPC in this project follows
--   * SECURITY DEFINER with search_path = '' and fully qualified names
--   * identity comes from auth.uid(); no user id is ever a parameter
--   * EXECUTE revoked from public, anon, then granted only to authenticated

-- ============================================================================
-- Tables
-- ============================================================================

create table public.inventory_items (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses (id) on delete restrict,
  sku            text not null check (btrim(sku) <> ''),
  name           text not null check (btrim(name) <> ''),
  description    text not null default '',
  unit           text not null default 'pcs' check (btrim(unit) <> ''),
  category       text not null default '' check (category = btrim(category)),
  default_cost   numeric(14,2) not null default 0 check (default_cost >= 0),
  reorder_point  numeric(14,2) not null default 0 check (reorder_point >= 0),
  reorder_qty    numeric(14,2) not null default 0 check (reorder_qty >= 0),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  created_by     uuid not null references public.profiles (id) on delete restrict,
  unique (business_id, id)
);
-- Unique SKU per business (case-insensitive). Cannot be an inline UNIQUE
-- constraint because Postgres only allows column references there.
create unique index inventory_items_business_sku_uidx
  on public.inventory_items (business_id, lower(sku));
create index inventory_items_business_name_idx on public.inventory_items (business_id, lower(name));
create index inventory_items_business_active_idx on public.inventory_items (business_id, is_active);

create table public.inventory_movements (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete restrict,
  item_id          uuid not null,
  movement_date    date not null,
  -- IN increases on-hand, OUT decreases it.
  direction        text not null check (direction in ('IN', 'OUT')),
  -- Why the stock moved. PURCHASE / SALE are written by the posting RPCs and
  -- automatically reversed by void_document. The ADJUST_*, SCRAP and OPENING
  -- reasons are written by record_inventory_adjustment.
  reason           text not null check (reason in
                     ('PURCHASE', 'SALE', 'ADJUST_IN', 'ADJUST_OUT', 'SCRAP', 'OPENING', 'VOID_REVERSAL')),
  quantity         numeric(14,2) not null check (quantity > 0),
  unit_cost        numeric(14,2) check (unit_cost is null or unit_cost >= 0),
  -- Which document triggered the movement, so a sale/purchase void can find
  -- the rows it needs to reverse. NULL for manual adjustments and opening.
  source_type      text check (source_type is null or source_type in ('SALE', 'PURCHASE', 'ADJUSTMENT', 'OPENING')),
  source_id        uuid,
  -- POSITIVE on IN, NEGATIVE on OUT — pre-computed so the on-hand query is
  -- a single SUM. Easier to read than multiplying by +1/-1 in every query.
  signed_quantity  numeric(14,2) generated always as
                     (case when direction = 'IN' then quantity else -quantity end) stored,
  notes            text not null default '',
  created_at       timestamptz not null default now(),
  created_by       uuid not null references public.profiles (id) on delete restrict,
  unique (business_id, id),
  foreign key (business_id, item_id)
    references public.inventory_items (business_id, id) on delete restrict
);
create index inventory_movements_business_item_idx on public.inventory_movements (business_id, item_id, movement_date desc);
create index inventory_movements_business_date_idx on public.inventory_movements (business_id, movement_date desc);
-- Enforces "one stock movement per (source_type, source_id, item_id)" for the
-- reason(s) the posting RPCs write — so a sale line can only produce one
-- SALE movement, and a void produces exactly one VOID_REVERSAL with the same
-- source_type/source_id (the original document). ADJUSTMENT rows are exempt
-- because a single item may legitimately have many manual adjustments.
create unique index inventory_movements_source_uidx
  on public.inventory_movements (business_id, source_type, source_id, item_id)
  where source_type is not null and source_id is not null
    and reason in ('SALE', 'PURCHASE', 'VOID_REVERSAL');

-- ============================================================================
-- Optional FK from existing line tables to inventory_items
-- ============================================================================

alter table public.sale_items
  add column inventory_item_id uuid,
  add constraint sale_items_inventory_item_fk
    foreign key (business_id, inventory_item_id)
    references public.inventory_items (business_id, id)
    on delete set null;

alter table public.purchase_items
  add column inventory_item_id uuid,
  add constraint purchase_items_inventory_item_fk
    foreign key (business_id, inventory_item_id)
    references public.inventory_items (business_id, id)
    on delete set null;

create index sale_items_business_item_idx on public.sale_items (business_id, inventory_item_id);
create index purchase_items_business_item_idx on public.purchase_items (business_id, inventory_item_id);

-- ============================================================================
-- View: per-item on-hand, weighted-average cost and stock value
--
-- The weighted average is computed over receipts only (direction = 'IN').
-- Movements without a unit_cost are excluded from the average but still count
-- in the on-hand total, so an opening adjustment that does not carry a cost
-- adds to qty without dragging the average to NULL.
-- ============================================================================

create view public.inventory_stock_value as
select
  i.id,
  i.business_id,
  i.sku,
  i.name,
  i.description,
  i.unit,
  i.category,
  i.default_cost,
  i.reorder_point,
  i.reorder_qty,
  i.is_active,
  coalesce(sum(m.signed_quantity), 0)::numeric(14,2)                                  as on_hand,
  -- SUM(qty * cost) / SUM(qty) over receipts that DO have a cost.
  case
    when coalesce(sum(case when m.direction = 'IN' and m.unit_cost is not null
                           then m.quantity end), 0) = 0 then i.default_cost
    else round(
      sum(case when m.direction = 'IN' and m.unit_cost is not null
               then m.quantity * m.unit_cost end)
      / nullif(sum(case when m.direction = 'IN' and m.unit_cost is not null
                         then m.quantity end), 0),
      2)
  end                                                                                 as avg_cost,
  coalesce(sum(m.signed_quantity), 0) *
  case
    when coalesce(sum(case when m.direction = 'IN' and m.unit_cost is not null
                           then m.quantity end), 0) = 0 then i.default_cost
    else round(
      sum(case when m.direction = 'IN' and m.unit_cost is not null
               then m.quantity * m.unit_cost end)
      / nullif(sum(case when m.direction = 'IN' and m.unit_cost is not null
                         then m.quantity end), 0),
      2)
  end                                                                                 as stock_value
from public.inventory_items i
left join public.inventory_movements m
       on m.business_id = i.business_id and m.item_id = i.id
group by i.id;

-- ============================================================================
-- RPC: create_inventory_item
-- ============================================================================

create function public.create_inventory_item(
  p_business_id   uuid,
  p_sku           text,
  p_name          text,
  p_description   text     default '',
  p_unit          text     default 'pcs',
  p_category      text     default '',
  p_default_cost  numeric  default 0,
  p_reorder_point numeric  default 0,
  p_reorder_qty   numeric  default 0
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_member(p_business_id) then
    raise exception 'Not a member of this business' using errcode = '42501';
  end if;
  if not public.can_write(p_business_id) then
    raise exception 'Insufficient privileges: write access required' using errcode = '42501';
  end if;

  p_sku := btrim(coalesce(p_sku, ''));
  p_name := btrim(coalesce(p_name, ''));
  p_unit := btrim(coalesce(p_unit, ''));
  if p_sku = '' then
    raise exception 'SKU is required' using errcode = '22023';
  end if;
  if p_name = '' then
    raise exception 'Name is required' using errcode = '22023';
  end if;
  if p_unit = '' then
    p_unit := 'pcs';
  end if;
  if p_default_cost < 0 then
    raise exception 'Default cost cannot be negative' using errcode = '22023';
  end if;
  if p_reorder_point < 0 then
    raise exception 'Reorder point cannot be negative' using errcode = '22023';
  end if;
  if p_reorder_qty < 0 then
    raise exception 'Reorder quantity cannot be negative' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.inventory_items
     where business_id = p_business_id and lower(sku) = lower(p_sku)
  ) then
    raise exception 'SKU % already exists in this business', p_sku
      using errcode = '23505';
  end if;

  insert into public.inventory_items (
    business_id, sku, name, description, unit, category,
    default_cost, reorder_point, reorder_qty, created_by
  ) values (
    p_business_id, p_sku, p_name, coalesce(p_description, ''), p_unit, coalesce(p_category, ''),
    round(p_default_cost, 2), p_reorder_point, p_reorder_qty, v_uid
  ) returning id into v_id;

  return v_id;
end $$;

-- ============================================================================
-- RPC: update_inventory_item
-- ============================================================================

create function public.update_inventory_item(
  p_business_id   uuid,
  p_item_id       uuid,
  p_name          text,
  p_description   text     default null,
  p_unit          text     default null,
  p_category      text     default null,
  p_default_cost  numeric  default null,
  p_reorder_point numeric  default null,
  p_reorder_qty   numeric  default null,
  p_is_active     boolean  default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_old public.inventory_items%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_member(p_business_id) then
    raise exception 'Not a member of this business' using errcode = '42501';
  end if;
  if not public.can_write(p_business_id) then
    raise exception 'Insufficient privileges: write access required' using errcode = '42501';
  end if;

  select * into v_old from public.inventory_items
   where business_id = p_business_id and id = p_item_id;
  if not found then
    raise exception 'Item not found' using errcode = '22023';
  end if;

  -- SKU is the lookup key for receipts of new stock; rename with care.
  p_name := btrim(coalesce(p_name, v_old.name));
  if p_name = '' then
    raise exception 'Name is required' using errcode = '22023';
  end if;

  if p_default_cost is not null and p_default_cost < 0 then
    raise exception 'Default cost cannot be negative' using errcode = '22023';
  end if;
  if p_reorder_point is not null and p_reorder_point < 0 then
    raise exception 'Reorder point cannot be negative' using errcode = '22023';
  end if;
  if p_reorder_qty is not null and p_reorder_qty < 0 then
    raise exception 'Reorder quantity cannot be negative' using errcode = '22023';
  end if;

  update public.inventory_items
     set name          = p_name,
         description   = coalesce(p_description,   v_old.description),
         unit          = coalesce(nullif(btrim(p_unit),     ''), v_old.unit),
         category      = coalesce(p_category,      v_old.category),
         default_cost  = coalesce(p_default_cost,  v_old.default_cost),
         reorder_point = coalesce(p_reorder_point, v_old.reorder_point),
         reorder_qty   = coalesce(p_reorder_qty,   v_old.reorder_qty),
         is_active     = coalesce(p_is_active,     v_old.is_active)
   where business_id = p_business_id and id = p_item_id;
end $$;

-- ============================================================================
-- RPC: archive_inventory_item
-- Soft delete: archived items stay referenced by past movements (the FK is
-- on delete restrict) but no new line can pick them.
-- ============================================================================

create function public.archive_inventory_item(
  p_business_id uuid,
  p_item_id     uuid
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_member(p_business_id) then
    raise exception 'Not a member of this business' using errcode = '42501';
  end if;
  if not public.can_write(p_business_id) then
    raise exception 'Insufficient privileges: write access required' using errcode = '42501';
  end if;

  update public.inventory_items
     set is_active = false
   where business_id = p_business_id and id = p_item_id and is_active;
  if not found then
    raise exception 'Item not found or already archived' using errcode = '22023';
  end if;
end $$;

-- ============================================================================
-- RPC: record_inventory_adjustment
-- A manual stock movement outside a sale/purchase: opening balances, scrap,
-- cycle-count corrections, etc.
-- ============================================================================

create function public.record_inventory_adjustment(
  p_business_id   uuid,
  p_item_id       uuid,
  p_date          date,
  p_direction     text,
  p_quantity      numeric,
  p_unit_cost     numeric  default null,
  p_reason        text     default 'ADJUST_IN',
  p_notes         text     default ''
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id  uuid;
  v_reason text;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_member(p_business_id) then
    raise exception 'Not a member of this business' using errcode = '42501';
  end if;
  if not public.can_write(p_business_id) then
    raise exception 'Insufficient privileges: write access required' using errcode = '42501';
  end if;

  if p_direction not in ('IN', 'OUT') then
    raise exception 'Direction must be IN or OUT' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be positive' using errcode = '22023';
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'Unit cost cannot be negative' using errcode = '22023';
  end if;

  v_reason := coalesce(nullif(btrim(p_reason), ''), case when p_direction = 'IN' then 'ADJUST_IN' else 'ADJUST_OUT' end);
  if v_reason not in ('ADJUST_IN', 'ADJUST_OUT', 'SCRAP', 'OPENING') then
    raise exception 'Adjustment reason must be ADJUST_IN, ADJUST_OUT, SCRAP or OPENING' using errcode = '22023';
  end if;
  -- SCRAP and ADJUST_OUT can only be OUT; OPENING and ADJUST_IN only IN.
  if v_reason in ('SCRAP', 'ADJUST_OUT') and p_direction <> 'OUT' then
    raise exception 'Reason % requires direction OUT', v_reason using errcode = '22023';
  end if;
  if v_reason in ('OPENING', 'ADJUST_IN') and p_direction <> 'IN' then
    raise exception 'Reason % requires direction IN', v_reason using errcode = '22023';
  end if;

  -- Item must exist and be active for this business.
  if not exists (
    select 1 from public.inventory_items
     where business_id = p_business_id and id = p_item_id and is_active
  ) then
    raise exception 'Item is missing or archived' using errcode = '22023';
  end if;

  insert into public.inventory_movements (
    business_id, item_id, movement_date, direction, reason, quantity, unit_cost,
    source_type, source_id, notes, created_by
  ) values (
    p_business_id, p_item_id, p_date, p_direction, v_reason, p_quantity,
    case when p_unit_cost is null then null else round(p_unit_cost, 2) end,
    'ADJUSTMENT', null, coalesce(p_notes, ''), v_uid
  ) returning id into v_id;

  return v_id;
end $$;

-- ============================================================================
-- RPC: set_business_track_inventory
-- ============================================================================

create function public.set_business_track_inventory(
  p_business_id     uuid,
  p_track_inventory boolean
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_owner(p_business_id) then
    raise exception 'Only the owner can change inventory settings' using errcode = '42501';
  end if;

  update public.businesses
     set track_inventory = coalesce(p_track_inventory, false)
   where id = p_business_id;
end $$;

-- ============================================================================
-- Trigger: every sale_items row with an inventory_item_id becomes an OUT
-- movement when the business has inventory tracking on. Item-level default
-- cost is used as the unit_cost; the weighted-average view recomputes the
-- on-hand cost on every read.
-- ============================================================================

create function public.record_sale_line_inventory_movement() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_track     boolean;
  v_unit_cost numeric(14,2);
begin
  if new.inventory_item_id is null then
    return new;
  end if;

  select b.track_inventory into v_track
    from public.businesses b
   where b.id = new.business_id;

  if v_track is distinct from true then
    return new;
  end if;

  select default_cost into v_unit_cost
    from public.inventory_items
   where business_id = new.business_id and id = new.inventory_item_id;

  insert into public.inventory_movements (
    business_id, item_id, movement_date, direction, reason,
    quantity, unit_cost, source_type, source_id, notes, created_by
  ) values (
    new.business_id, new.inventory_item_id, current_date, 'OUT', 'SALE',
    new.quantity, v_unit_cost, 'SALE', new.sale_id, '', auth.uid()
  );

  return new;
end $$;

create trigger sale_items_inventory_movement
  after insert on public.sale_items
  for each row execute function public.record_sale_line_inventory_movement();

create function public.record_purchase_line_inventory_movement() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_track     boolean;
  v_unit_cost numeric(14,2);
begin
  if new.inventory_item_id is null then
    return new;
  end if;

  select b.track_inventory into v_track
    from public.businesses b
   where b.id = new.business_id;

  if v_track is distinct from true then
    return new;
  end if;

  select default_cost into v_unit_cost
    from public.inventory_items
   where business_id = new.business_id and id = new.inventory_item_id;

  insert into public.inventory_movements (
    business_id, item_id, movement_date, direction, reason,
    quantity, unit_cost, source_type, source_id, notes, created_by
  ) values (
    new.business_id, new.inventory_item_id, current_date, 'IN', 'PURCHASE',
    new.quantity, v_unit_cost, 'PURCHASE', new.purchase_id, '', auth.uid()
  );

  return new;
end $$;

create trigger purchase_items_inventory_movement
  after insert on public.purchase_items
  for each row execute function public.record_purchase_line_inventory_movement();

-- ============================================================================
-- Trigger: void_document flips sales/purchases.status to 'VOIDED'. When that
-- happens we write a mirror IN (for a voided sale) or OUT (for a voided
-- purchase) movement per inventory-bearing line, so stock returns to where
-- it would have been without the original document.
-- ============================================================================

create function public.record_inventory_void_reversal() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_track boolean;
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if new.status is distinct from 'VOIDED' or old.status is not distinct from 'VOIDED' then
    return new;
  end if;

  select track_inventory into v_track
    from public.businesses where id = new.business_id;
  if v_track is distinct from true then
    return new;
  end if;

  if tg_table_name = 'sales' then
    insert into public.inventory_movements (
      business_id, item_id, movement_date, direction, reason,
      quantity, unit_cost, source_type, source_id, notes, created_by
    )
    select new.business_id, si.inventory_item_id, current_date, 'IN', 'VOID_REVERSAL',
           si.quantity, null, 'SALE', new.id, 'Voided sale', auth.uid()
      from public.sale_items si
     where si.business_id = new.business_id
       and si.sale_id = new.id
       and si.inventory_item_id is not null;

  elsif tg_table_name = 'purchases' then
    insert into public.inventory_movements (
      business_id, item_id, movement_date, direction, reason,
      quantity, unit_cost, source_type, source_id, notes, created_by
    )
    select new.business_id, pi.inventory_item_id, current_date, 'OUT', 'VOID_REVERSAL',
           pi.quantity, null, 'PURCHASE', new.id, 'Voided purchase', auth.uid()
      from public.purchase_items pi
     where pi.business_id = new.business_id
       and pi.purchase_id = new.id
       and pi.inventory_item_id is not null;
  end if;

  return new;
end $$;

create trigger sales_void_inventory_reversal
  after update of status on public.sales
  for each row execute function public.record_inventory_void_reversal();

create trigger purchases_void_inventory_reversal
  after update of status on public.purchases
  for each row execute function public.record_inventory_void_reversal();

-- Trigger functions are never called directly.
revoke all on function
  public.record_sale_line_inventory_movement(),
  public.record_purchase_line_inventory_movement(),
  public.record_inventory_void_reversal()
  from public, anon, authenticated;

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.inventory_items      enable row level security;
alter table public.inventory_movements  enable row level security;

-- inventory_items: read for members, write for members who can write.
create policy inventory_items_read on public.inventory_items
  for select to authenticated
  using (public.is_member(business_id));

create policy inventory_items_write on public.inventory_items
  for all to authenticated
  using (public.can_write(business_id))
  with check (public.can_write(business_id));

-- inventory_movements: same.
create policy inventory_movements_read on public.inventory_movements
  for select to authenticated
  using (public.is_member(business_id));

create policy inventory_movements_write on public.inventory_movements
  for all to authenticated
  using (public.can_write(business_id))
  with check (public.can_write(business_id));

-- ============================================================================
-- Function permissions
-- ============================================================================

revoke all on function public.create_inventory_item(
  uuid, text, text, text, text, text, numeric, numeric, numeric
) from public, anon, authenticated;
grant execute on function public.create_inventory_item(
  uuid, text, text, text, text, text, numeric, numeric, numeric
) to authenticated;

revoke all on function public.update_inventory_item(
  uuid, uuid, text, text, text, text, numeric, numeric, numeric, boolean
) from public, anon, authenticated;
grant execute on function public.update_inventory_item(
  uuid, uuid, text, text, text, text, numeric, numeric, numeric, boolean
) to authenticated;

revoke all on function public.archive_inventory_item(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.archive_inventory_item(uuid, uuid)
  to authenticated;

revoke all on function public.record_inventory_adjustment(
  uuid, uuid, date, text, numeric, numeric, text, text
) from public, anon, authenticated;
grant execute on function public.record_inventory_adjustment(
  uuid, uuid, date, text, numeric, numeric, text, text
) to authenticated;

revoke all on function public.set_business_track_inventory(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_business_track_inventory(uuid, boolean)
  to authenticated;

-- ============================================================================
-- Erase: include inventory tables in the wipe.
-- (019_erase_business_data.sql was applied before these tables existed.)
-- ============================================================================

create or replace function public.erase_business_data(p_business_id uuid)
returns table (table_name text, deleted bigint)
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_biz public.businesses%rowtype;
  v_n   bigint;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.is_owner(p_business_id) then
    raise exception 'Only the owner can erase business data' using errcode = '42501';
  end if;

  -- Clear the optional FK references first so the CASCADE/RESTRICT mix does
  -- not surprise anyone, then drop the leaf rows, then the parents.
  update public.sale_items     set inventory_item_id = null
    where business_id = p_business_id and inventory_item_id is not null;
  get diagnostics v_n = row_count; table_name := 'sale_items'; deleted := v_n; return next;

  update public.purchase_items set inventory_item_id = null
    where business_id = p_business_id and inventory_item_id is not null;
  get diagnostics v_n = row_count; table_name := 'purchase_items'; deleted := v_n; return next;

  delete from public.inventory_movements where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'inventory_movements'; deleted := v_n; return next;

  delete from public.inventory_items where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'inventory_items'; deleted := v_n; return next;

  -- Documents and settlements first (children), then accounts, then business.
  delete from public.payments               where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'payments'; deleted := v_n; return next;

  delete from public.purchase_items         where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'purchase_items'; deleted := v_n; return next;
  delete from public.purchases              where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'purchases'; deleted := v_n; return next;

  delete from public.expense_items          where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'expense_items'; deleted := v_n; return next;
  delete from public.expenses               where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'expenses'; deleted := v_n; return next;

  delete from public.sale_items             where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'sale_items'; deleted := v_n; return next;
  delete from public.sales                  where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'sales'; deleted := v_n; return next;

  delete from public.journal_lines          where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'journal_lines'; deleted := v_n; return next;
  delete from public.journal_entries        where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'journal_entries'; deleted := v_n; return next;

  delete from public.customers              where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'customers'; deleted := v_n; return next;
  delete from public.suppliers              where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'suppliers'; deleted := v_n; return next;

  delete from public.accounts               where business_id = p_business_id;
  get diagnostics v_n = row_count; table_name := 'accounts'; deleted := v_n; return next;

  -- Reseed the default chart of accounts.
  perform public.seed_default_chart_of_accounts(p_business_id);

  return;
end $$;

revoke all on function public.erase_business_data(uuid) from public, anon, authenticated;
grant execute on function public.erase_business_data(uuid) to authenticated;

-- ============================================================================
-- Safety net: function privileges
-- ============================================================================

do $$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and not exists (select 1 from pg_event_trigger et where et.evtfoid = p.oid)
     and (
       has_function_privilege('anon', p.oid, 'EXECUTE')
       or (
         has_function_privilege('authenticated', p.oid, 'EXECUTE')
         and p.proname not in (
           'is_member', 'can_write', 'is_owner', 'is_app_admin',
           'create_business', 'post_sale', 'post_purchase', 'post_expense',
           'post_payment', 'void_document', 'void_payment',
           'initiate_gateway_txn', 'settle_gateway_txn',
           'control_account_integrity',
           'claim_profile', 'set_user_role', 'erase_business_data',
           'create_inventory_item', 'update_inventory_item',
           'archive_inventory_item', 'record_inventory_adjustment',
           'set_business_track_inventory'
         )
       )
     );
  if v_bad is not null then
    raise exception 'Unexpected EXECUTE privilege on: %', v_bad;
  end if;
end $$;