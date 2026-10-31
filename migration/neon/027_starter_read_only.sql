-- Starter users may read records for businesses where they already have a
-- membership. Existing write authorization stays unchanged: can_write() still
-- requires a Plus/Premium plan and an OWNER/ACCOUNTANT membership.
-- This migration changes policies/helpers only; it does not alter user or
-- accounting rows and is safe to apply to populated databases.

create or replace function public.is_member(p_business_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
      from public.business_memberships m
     where m.business_id = p_business_id
       and m.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_member(uuid) from public, anon, authenticated;
grant execute on function public.is_member(uuid) to authenticated;

-- Plan limits are also checked when a business is created, so an extra direct
-- RPC call cannot let a Plus account exceed its one-business allowance. This
-- is INSERT-only and does not inspect or modify existing business rows.
create or replace function public.enforce_business_plan_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_role text;
begin
  select p.role into v_role
    from public.profiles p
   where p.id = new.created_by
   for update;

  if v_role is null or v_role not in ('plus', 'premium') then
    raise exception 'Plus or Premium is required to create a business.' using errcode = '42501';
  end if;

  if v_role = 'plus' and (
    exists (select 1 from public.businesses b where b.created_by = new.created_by)
    or exists (select 1 from public.business_memberships m
               where m.user_id = new.created_by and m.role = 'OWNER')
  ) then
    raise exception 'Plus includes one business. Premium is required for another.' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_business_plan_limit() from public, anon, authenticated;
drop trigger if exists enforce_business_plan_limit on public.businesses;
create trigger enforce_business_plan_limit
  before insert on public.businesses
  for each row execute function public.enforce_business_plan_limit();

-- Inventory rows become visible to all existing business members, including
-- Starter, for read-only review. The existing insert/update RPCs and write
-- policies still enforce Premium eligibility and membership permissions.
drop policy if exists inventory_items_read on public.inventory_items;
create policy inventory_items_read on public.inventory_items for select to authenticated
  using (public.is_member(business_id));

drop policy if exists inventory_movements_read on public.inventory_movements;
create policy inventory_movements_read on public.inventory_movements for select to authenticated
  using (public.is_member(business_id));
