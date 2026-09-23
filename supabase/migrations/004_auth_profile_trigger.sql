-- 004_auth_profile_trigger.sql
-- Every auth.users row gets a public.profiles row. Profiles carry no business
-- data; they exist so that businesses.created_by, journal_entries.created_by and
-- business_memberships.user_id have something to reference.
--
-- Email confirmation is a Supabase Auth setting, not a database one. With
-- confirmation enabled the auth.users row (and therefore this profile) exists
-- as soon as the user signs up, but no JWT is issued until the address is
-- confirmed, so auth.uid() is null and create_business() is unreachable.

-- ============================================================================
-- New user -> profile
-- ============================================================================
-- Must never raise: a failure here would block sign-up. It only inserts, and it
-- ignores an existing row.

create function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  )
  on conflict (id) do nothing;
  return new;
end $$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- Email change -> profile
-- ============================================================================
-- Supabase updates auth.users.email only after the new address is confirmed.
-- Keep the profile copy in step. Clients cannot write profiles.email themselves
-- (002 grants UPDATE on full_name only).

create function public.handle_user_email_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.profiles
     set email = coalesce(new.email, '')
   where id = new.id;
  return new;
end $$;

revoke all on function public.handle_user_email_change() from public, anon, authenticated;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.handle_user_email_change();

-- ============================================================================
-- Backfill: users that signed up before this migration existed
-- ============================================================================
-- Identity rows only. Idempotent. Creates no business or financial data.

insert into public.profiles (id, email, full_name)
select u.id,
       coalesce(u.email, ''),
       btrim(coalesce(u.raw_user_meta_data ->> 'full_name', ''))
  from auth.users u
on conflict (id) do nothing;

-- ============================================================================
-- Safety net: the trigger functions are not callable by clients
-- ============================================================================

do $$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('handle_new_user', 'handle_user_email_change')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'Trigger functions must not be executable by client roles: %', v_bad;
  end if;
end $$;
