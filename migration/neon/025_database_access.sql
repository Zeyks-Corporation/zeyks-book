-- Apply after 024. Customer plans are stored in profiles.role; staff in is_staff.
alter table public.profiles add column if not exists is_staff boolean not null default false;
update public.profiles set is_staff = true, role = 'premium' where role = 'admin';
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('user', 'plus', 'premium'));
revoke update (role) on public.profiles from authenticated;
revoke execute on function public.set_user_role(uuid, text) from authenticated;
drop policy if exists profiles_update_admin on public.profiles;

create or replace function public.is_app_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((select p.is_staff from public.profiles p
                   where p.id = (select auth.uid())), false);
$$;
revoke all on function public.is_app_admin() from public, anon, authenticated;
grant execute on function public.is_app_admin() to authenticated;

create or replace function public.is_member(p_business_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.business_memberships m
    join public.profiles p on p.id = m.user_id
    where m.business_id = p_business_id and m.user_id = (select auth.uid())
      and p.role in ('plus', 'premium'));
$$;
create or replace function public.can_write(p_business_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.business_memberships m
    join public.profiles p on p.id = m.user_id
    where m.business_id = p_business_id and m.user_id = (select auth.uid())
      and m.role in ('OWNER', 'ACCOUNTANT') and p.role in ('plus', 'premium'));
$$;
create or replace function public.is_owner(p_business_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.business_memberships m
    join public.profiles p on p.id = m.user_id
    where m.business_id = p_business_id and m.user_id = (select auth.uid())
      and m.role = 'OWNER' and p.role in ('plus', 'premium'));
$$;

create or replace function public.claim_profile()
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid        uuid;
  v_email      text;
  v_name       text;
  v_role       text;
  v_old_role   text;
  v_old_name   text;
  v_old_staff  boolean := false;
  v_stale      uuid[];
  v_t          text;
  v_guarded    text[] := array['journal_entries', 'sales', 'purchases', 'expenses',
                               'payments', 'inventory_items', 'inventory_movements'];
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'Sign in before claiming a profile.';
  end if;

  if exists (select 1 from public.profiles p where p.id = v_uid) then
    return v_uid;
  end if;

  select u.email, u.name into v_email, v_name
    from neon_auth."user" u
   where u.id = v_uid;
  if v_email is null or btrim(v_email) = '' then
    raise exception 'The signed-in account has no email address to claim with.';
  end if;

  -- Rows written under an auth id that no longer exists. Highest plan wins if
  -- an email somehow has more than one, so a premium account cannot be
  -- downgraded by a duplicate shell row sorting first.
  select array_agg(p.id) into v_stale
    from public.profiles p
   where p.email = v_email and p.id <> v_uid;

  if v_stale is not null then
    select p.role, p.full_name, p.is_staff into v_old_role, v_old_name, v_old_staff
      from public.profiles p
     where p.id = any (v_stale)
     order by case p.role
                when 'premium' then 0
                when 'plus' then 2 else 3 end,
              p.created_at
     limit 1;
  end if;

  -- Bootstrap admins keep their privilege across an id change; everyone else
  -- inherits the plan they already paid for, and a genuinely new account
  -- starts free.
  v_role := case
    when v_old_role = 'admin' then 'premium'
    else coalesce(v_old_role, 'user')
  end;

  insert into public.profiles (id, email, full_name, role, is_staff)
  values (v_uid,
          v_email,
          coalesce(nullif(btrim(coalesce(v_name, '')), ''),
                   nullif(btrim(coalesce(v_old_name, '')), ''), ''),
          v_role, v_old_staff);

  if v_stale is not null then
    -- The document guards (001) reject any UPDATE that is not a POSTED ->
    -- VOIDED status change and the journal guard rejects every UPDATE, so
    -- moving created_by raised "Journal entries are immutable" / "Posted sales
    -- are immutable". Both protect the accounting content of a row, not which
    -- auth id is written in its author column. Disable them across exactly the
    -- statements that re-attribute authorship and re-enable them immediately
    -- after, the way erase_business_data() (022) does. DISABLE TRIGGER USER
    -- leaves the deferred balance constraint triggers alone, and a failure
    -- aborts the transaction, so the DDL never outlives the claim.
    foreach v_t in array v_guarded loop
      execute format('alter table public.%I disable trigger user', v_t);
    end loop;

    update public.business_memberships  m set user_id      = v_uid where m.user_id      = any (v_stale);
    update public.businesses            b set created_by   = v_uid where b.created_by   = any (v_stale);
    update public.journal_entries       j set created_by   = v_uid where j.created_by   = any (v_stale);
    update public.sales                 s set created_by   = v_uid where s.created_by   = any (v_stale);
    update public.purchases             q set created_by   = v_uid where q.created_by   = any (v_stale);
    update public.expenses              e set created_by   = v_uid where e.created_by   = any (v_stale);
    update public.payments              y set created_by   = v_uid where y.created_by   = any (v_stale);
    update public.gateway_transactions  g set initiated_by = v_uid where g.initiated_by = any (v_stale);
    update public.inventory_items       i set created_by   = v_uid where i.created_by   = any (v_stale);
    update public.inventory_movements   v set created_by   = v_uid where v.created_by   = any (v_stale);

    foreach v_t in array v_guarded loop
      execute format('alter table public.%I enable trigger user', v_t);
    end loop;

    delete from public.profiles where id = any (v_stale);
  end if;

  return v_uid;
end $$;


create or replace function public.create_managed_user(
  p_auth_id uuid,
  p_email text,
  p_full_name text,
  p_role text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text;
begin
  if not (select public.is_app_admin()) then
    raise exception 'Only an admin can create an account.';
  end if;

  if p_role is distinct from 'user' then
    raise exception 'Unknown role: %', p_role;
  end if;

  v_email := lower(btrim(coalesce(p_email, '')));
  if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'A real email address is required.';
  end if;

  -- The login has to exist before the books can be attached to it.
  if not exists (select 1 from neon_auth."user" u where u.id = p_auth_id) then
    raise exception 'That sign-in account does not exist. Create it first.';
  end if;

  -- Two profiles for one person is how an account ends up showing somebody
  -- else's books: claim_profile() relinks by email.
  if exists (select 1 from public.profiles p where p.id = p_auth_id) then
    raise exception 'That account already has a profile.';
  end if;
  if exists (select 1 from public.profiles p where lower(p.email) = v_email) then
    raise exception 'An account already exists for that email address.';
  end if;

  insert into public.profiles (id, email, full_name, role)
    values (p_auth_id, v_email, btrim(coalesce(p_full_name, '')), 'user');

  return p_auth_id;
end $$;


create or replace function public.create_business(
  p_business_name           text,
  p_owner_name              text     default '',
  p_email                   text     default '',
  p_phone                   text     default '',
  p_pan_number              text     default '',
  p_address                 text     default '',
  p_city                    text     default '',
  p_currency_symbol         text     default 'NPR',
  p_fiscal_year_start_month smallint default 4,
  p_vat_registered          boolean  default false,
  p_vat_rate                numeric  default 13,
  p_track_inventory         boolean  default false
)
returns public.businesses
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_name     text := btrim(coalesce(p_business_name, ''));
  v_business public.businesses;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not exists (select 1 from public.profiles p where p.id = v_uid) then
    perform public.claim_profile();
    if not exists (select 1 from public.profiles p where p.id = v_uid) then
      raise exception 'The profile for the signed-in account could not be created.' using errcode = '23503';
    end if;
  end if;

  if not exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('plus', 'premium')) then
    raise exception 'Assign Starter or Premium before creating a business' using errcode = '42501';
  end if;

  if v_name = '' then
    raise exception 'Business name is required' using errcode = '22023';
  end if;

  -- Column CHECK constraints on public.businesses validate the remaining
  -- inputs (PAN format, currency symbol, fiscal month, VAT rate).
  insert into public.businesses (
    created_by, business_name, owner_name, email, phone, pan_number, address, city,
    currency_symbol, fiscal_year_start_month, vat_registered, vat_rate, track_inventory
  ) values (
    v_uid, v_name,
    btrim(coalesce(p_owner_name, '')),
    btrim(coalesce(p_email, '')),
    btrim(coalesce(p_phone, '')),
    btrim(coalesce(p_pan_number, '')),
    btrim(coalesce(p_address, '')),
    btrim(coalesce(p_city, '')),
    coalesce(p_currency_symbol, 'NPR'),
    coalesce(p_fiscal_year_start_month, 4),
    coalesce(p_vat_registered, false),
    coalesce(p_vat_rate, 13),
    coalesce(p_track_inventory, false)
  )
  returning * into v_business;

  insert into public.business_memberships (business_id, user_id, role)
  values (v_business.id, v_uid, 'OWNER');

  perform public.seed_default_chart_of_accounts(v_business.id);

  return v_business;
end $$;


create or replace function public.create_inventory_item(
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
  if not exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'premium') then
    raise exception 'Premium is required' using errcode = '42501';
  end if;
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

create or replace function public.update_inventory_item(
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
  if not exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'premium') then
    raise exception 'Premium is required' using errcode = '42501';
  end if;
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

create or replace function public.archive_inventory_item(
  p_business_id uuid,
  p_item_id     uuid
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'premium') then
    raise exception 'Premium is required' using errcode = '42501';
  end if;
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

create or replace function public.record_inventory_adjustment(
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
  if not exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'premium') then
    raise exception 'Premium is required' using errcode = '42501';
  end if;
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

create or replace function public.set_business_track_inventory(
  p_business_id     uuid,
  p_track_inventory boolean
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'premium') then
    raise exception 'Premium is required' using errcode = '42501';
  end if;
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

create or replace function public.has_premium() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'premium');
$$;
revoke all on function public.has_premium() from public, anon, authenticated;
grant execute on function public.has_premium() to authenticated;
drop policy if exists inventory_items_read on public.inventory_items;
create policy inventory_items_read on public.inventory_items for select to authenticated
  using (public.is_member(business_id) and public.has_premium());
drop policy if exists inventory_movements_read on public.inventory_movements;
create policy inventory_movements_read on public.inventory_movements for select to authenticated
  using (public.is_member(business_id) and public.has_premium());
-- Replace broad FOR ALL inventory policies; those also granted SELECT.
drop policy if exists inventory_items_write on public.inventory_items;
create policy inventory_items_insert on public.inventory_items for insert to authenticated
  with check (public.can_write(business_id) and public.has_premium());
create policy inventory_items_update on public.inventory_items for update to authenticated
  using (public.can_write(business_id) and public.has_premium())
  with check (public.can_write(business_id) and public.has_premium());
drop policy if exists inventory_movements_write on public.inventory_movements;
create policy inventory_movements_insert on public.inventory_movements for insert to authenticated
  with check (public.can_write(business_id) and public.has_premium());
