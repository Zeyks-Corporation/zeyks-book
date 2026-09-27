-- 000_prelude.sql — Neon adaptation prelude
-- Neon's Data API provisions `authenticated` and `anonymous` plus the auth
-- schema (auth.uid() -> uuid). Supabase's `anon` and `service_role` roles are
-- referenced by the upstream migrations (revokes, safety-net checks), so they
-- exist here as empty NOLOGIN roles to keep the SQL verbatim.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

grant usage on schema public to authenticated, anonymous;
