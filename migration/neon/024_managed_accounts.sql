-- ============================================================================
-- 024 — Managed accounts: the admin issues each user, with their plan, before
--       that person ever signs in.
--
-- Why this exists
-- ---------------
-- Sign-in moved from Google OAuth to admin-issued email + password (public
-- sign-up is disabled in `neon_auth.project_config.email_and_password`, so
-- `/sign-up/email` answers EMAIL_PASSWORD_SIGN_UP_DISABLED and only the
-- authenticated admin API can create accounts). Creating the login is Neon
-- Auth's job (`POST /admin/create-user`); the app-side record — the
-- `public.profiles` row that carries the plan — has to be written by us, and
-- an INSERT through the Data API is refused for anyone but an admin. This
-- function is that single, gated write.
--
-- The order matters and is the whole point:
--   * the auth user is created FIRST (outside SQL, over HTTP), so its id is
--     known and becomes profiles.id;
--   * the profile is inserted here with the chosen role, keyed on that id;
--   * on the first sign-in, claim_profile() (018, rewritten by 023) finds a row
--     for auth.uid() and returns immediately — it never reaches the relink
--     path, so the plan the admin chose cannot be reset to 'user'.
--
-- Guards: admin-only, a known role, a real email, an auth account that actually
-- exists, and no second profile for the same person (by id or by address). The
-- email check is what keeps `claim_profile()`'s email-keyed relink from ever
-- having two rows to choose between.
-- ============================================================================

-- ============================================================================
-- 1. create_managed_user — admin-only profile creation for an issued account.
-- ============================================================================
create function public.create_managed_user(
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

  if p_role is null or p_role not in ('user', 'plus', 'premium', 'admin') then
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
    values (p_auth_id, v_email, btrim(coalesce(p_full_name, '')), p_role);

  return p_auth_id;
end $$;

revoke all on function public.create_managed_user(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_managed_user(uuid, text, text, text)
  to authenticated;

-- ============================================================================
-- Safety net: function privileges
--
-- Same net as 003 / 005 / 020, with this migration's function added to the
-- known set: nothing may be executable by anon, and nothing executable by
-- authenticated beyond the RPCs the app actually calls.
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
           'set_business_track_inventory',
           'create_managed_user'
         )
       )
     );
  if v_bad is not null then
    raise exception 'Unexpected EXECUTE privilege on: %', v_bad;
  end if;
end $$;
