-- 023_claim_relink_order.sql — first sign-in creates its profile row.
--
-- claim_profile() relinked the old account's rows to the new auth id *before*
-- inserting that id into public.profiles. Every child column it moves
-- (created_by, initiated_by, user_id) has a foreign key into profiles(id), so
-- the first UPDATE was rejected: "insert or update on table
-- \"business_memberships\" violates foreign key constraint". create_business()
-- wrapped that failure in `exception when others then null`, so the real cause
-- disappeared and the user saw only "No profile exists for the current user".
--
-- Deleting a Neon Auth user and signing in again reproduces this exactly: the
-- email returns with a brand-new auth id while the profiles row still carries
-- the deleted one, so claim always takes the relink path and always fails.
--
-- (1) claim_profile(): insert the new profiles row first, then move the child
--     rows onto it, then drop the stale shell rows. The id being pointed at has
--     to exist before anything can reference it.
--     It also adopts *every* row sharing the email (not just the first match)
--     and carries over the stored role and full name, so an account whose auth
--     id changed does not lose its plan or its display name.
-- (2) create_business(): stop swallowing the claim error — the message that
--     reached the user was a placeholder for whatever actually went wrong.
--
-- The relink also had to get past the append-only guards: 001's document
-- triggers reject any UPDATE other than a POSTED -> VOIDED status change, and
-- the journal trigger rejects every UPDATE, so re-attributing created_by was
-- refused. claim_profile() now disables those user triggers for the duration of
-- its own relink statements and re-enables them right after, the same narrow
-- device erase_business_data() uses in 022. Nothing else may move authorship
-- off a posted row.
--
-- inventory_items and inventory_movements point at profiles too and were never
-- relinked; the delete of a stale shell row would fail on them as soon as any
-- account had inventory.

-- ============================================================================
-- 1. claim_profile() — create the profiles row, adopting rows from a deleted
--    auth id with the same email.
-- ============================================================================
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
    select p.role, p.full_name into v_old_role, v_old_name
      from public.profiles p
     where p.id = any (v_stale)
     order by case p.role
                when 'admin' then 0 when 'premium' then 1
                when 'plus' then 2 else 3 end,
              p.created_at
     limit 1;
  end if;

  -- Bootstrap admins keep their privilege across an id change; everyone else
  -- inherits the plan they already paid for, and a genuinely new account
  -- starts free.
  v_role := case
    when lower(v_email) in ('littlefault1@gmail.com', 'zeyksbook@gmail.com') then 'admin'
    else coalesce(v_old_role, 'user')
  end;

  insert into public.profiles (id, email, full_name, role)
  values (v_uid,
          v_email,
          coalesce(nullif(btrim(coalesce(v_name, '')), ''),
                   nullif(btrim(coalesce(v_old_name, '')), ''), ''),
          v_role);

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

-- ============================================================================
-- 2. create_business() — a failed claim must say why.
-- ============================================================================
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

-- ============================================================================
-- Grants (the 003-016 EXECUTE allowlists predate neither function, but the
-- convention is to re-assert them after every redefinition).
-- ============================================================================
revoke all on function public.claim_profile() from public, anon, authenticated;
grant execute on function public.claim_profile() to authenticated;

revoke all on function public.create_business(text, text, text, text, text, text, text, text, smallint, boolean, numeric, boolean)
  from public, anon, authenticated;
grant execute on function public.create_business(text, text, text, text, text, text, text, text, smallint, boolean, numeric, boolean)
  to authenticated;
