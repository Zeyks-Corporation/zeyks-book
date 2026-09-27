-- 018_neon_finish.sql — Neon adaptation, applied after every upstream migration.
--
-- (1) claim_profile() replaces Supabase's auth.users insert trigger (004):
--     Neon Auth (Managed Better Auth) owns its user table, so profile creation
--     happens at first sign-in instead. The client calls claim_profile() once
--     after signing in. If a legacy profile already exists with the same email
--     (pre-migration data), its rows are relinked to the new auth id and the
--     shell row is removed, so memberships, businesses and financial history
--     follow the person across the auth cutover. The two bootstrap admin
--     emails are granted the admin role on first claim.
--
-- (2) Role system: profiles.role drives app-wide gating (user / plus /
--     premium / admin). The two bootstrap emails receive role='admin' on
--     first claim; everyone else gets 'user'. /king promotes others.
--
-- This file runs last because migrations 003-016 each end with an
-- EXECUTE-privilege safety net whose allowlist predates these functions. Any
-- future upstream-style migration must add these functions to its allowlist
-- or run before this grant.

-- ============================================================================
-- 1. Role column on profiles
-- ============================================================================
alter table public.profiles
  add column if not exists role text not null default 'user'
    check (role in ('user', 'plus', 'premium', 'admin'));

-- ============================================================================
-- 2. claim_profile() — create (or relink) the profiles row on first sign-in.
-- ============================================================================
create or replace function public.claim_profile()
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid   uuid;
  v_email text;
  v_name  text;
  v_old   uuid;
  v_role  text;
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

  select p.id into v_old from public.profiles p where p.email = v_email;
  if v_old is not null then
    update public.business_memberships m set user_id = v_uid where m.user_id = v_old;
    update public.businesses            b set created_by = v_uid where b.created_by = v_old;
    update public.journal_entries       j set created_by = v_uid where j.created_by = v_old;
    update public.sales                 s set created_by = v_uid where s.created_by = v_old;
    update public.purchases             p set created_by = v_uid where p.created_by = v_old;
    update public.expenses              e set created_by = v_uid where e.created_by = v_old;
    update public.payments              p set created_by = v_uid where p.created_by = v_old;
    update public.gateway_transactions  g set initiated_by = v_uid where g.initiated_by = v_old;
    delete from public.profiles where id = v_old;
  end if;

  -- Bootstrap admins: anyone with one of these emails starts as admin.
  v_role := case
    when lower(v_email) in ('littlefault1@gmail.com', 'zeyksbook@gmail.com') then 'admin'
    else 'user'
  end;

  insert into public.profiles (id, email, full_name, role)
  values (v_uid, v_email, coalesce(v_name, ''), v_role);

  return v_uid;
end $$;

-- ============================================================================
-- 3. is_app_admin() — true for admins and bootstrap emails.
-- ============================================================================
create function public.is_app_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select p.role = 'admin' from public.profiles p where p.id = (select auth.uid())),
    false
  )
  or lower((select email from neon_auth."user" where id = (select auth.uid())))
     in ('littlefault1@gmail.com', 'zeyksbook@gmail.com');
$$;

revoke all on function public.is_app_admin() from public, anon, authenticated;
grant execute on function public.is_app_admin() to authenticated;

-- ============================================================================
-- 4. set_user_role(target_user_id, new_role) — admin-only role change.
-- ============================================================================
create function public.set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select public.is_app_admin()) then
    raise exception 'Only an admin can change a role.';
  end if;
  if p_role not in ('user', 'plus', 'premium', 'admin') then
    raise exception 'Unknown role: %', p_role;
  end if;
  update public.profiles set role = p_role where id = p_user_id;
  if not found then
    raise exception 'No profile with that id.';
  end if;
end $$;

revoke all on function public.set_user_role(uuid, text) from public, anon, authenticated;
grant execute on function public.set_user_role(uuid, text) to authenticated;

-- ============================================================================
-- 5. Admin SELECT and UPDATE policies on profiles.
-- ============================================================================
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.is_app_admin());

create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (public.is_app_admin())
  with check (public.is_app_admin());

-- Allow admins to update the role column on any row; non-admins can still
-- update their own full_name (per 002's existing grant).
grant update (role) on public.profiles to authenticated;

-- ============================================================================
-- Grants
-- ============================================================================
revoke all on function public.claim_profile() from public, anon, authenticated;
grant execute on function public.claim_profile() to authenticated;