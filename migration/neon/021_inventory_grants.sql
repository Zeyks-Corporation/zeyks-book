-- 021_inventory_grants.sql
-- The 020_inventory.sql migration added RLS policies but did not grant SELECT
-- on the inventory tables to the `authenticated` role. PostgREST surfaces a
-- missing table-level grant as 401/403, which is what the UI was reporting.
-- This migration grants SELECT (and any client-writable columns) to match
-- the pattern in 002_security_helpers_and_rls.sql.
--
-- Writes still go exclusively through SECURITY DEFINER RPCs, so the
-- authenticated role needs no INSERT/UPDATE/DELETE on these tables.

grant select on
  public.inventory_items,
  public.inventory_movements,
  public.inventory_stock_value
to authenticated;

-- Safety net: fail the migration if anon gets anything, or if authenticated
-- gets a write privilege it should not have.
do $$
declare
  v_bad text;
begin
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'v')
     and c.relname in ('inventory_items', 'inventory_movements', 'inventory_stock_value')
     and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
  if v_bad is not null then
    raise exception 'Unexpected inventory privileges: %', v_bad;
  end if;
end $$;