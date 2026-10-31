-- Keep author/profile references consistent when a returning user receives a
-- new Neon Auth id. This only relinks profile foreign keys; no rows are deleted
-- and no accounting values or document identities are changed.

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

  select array_agg(p.id) into v_stale
    from public.profiles p
   where p.email = v_email and p.id <> v_uid;

  if v_stale is not null then
    select p.role, p.full_name, p.is_staff into v_old_role, v_old_name, v_old_staff
      from public.profiles p
     where p.id = any (v_stale)
     order by case p.role when 'premium' then 0 when 'plus' then 2 else 3 end,
              p.created_at
     limit 1;
  end if;

  v_role := case when v_old_role = 'admin' then 'premium'
                 else coalesce(v_old_role, 'user') end;

  insert into public.profiles (id, email, full_name, role, is_staff)
  values (v_uid, v_email,
          coalesce(nullif(btrim(coalesce(v_name, '')), ''),
                   nullif(btrim(coalesce(v_old_name, '')), ''), ''),
          v_role, v_old_staff);

  if v_stale is not null then
    foreach v_t in array v_guarded loop
      execute format('alter table public.%I disable trigger user', v_t);
    end loop;

    update public.business_memberships       m set user_id = v_uid where m.user_id = any (v_stale);
    update public.businesses                 b set created_by = v_uid where b.created_by = any (v_stale);
    update public.journal_entries            j set created_by = v_uid where j.created_by = any (v_stale);
    update public.sales                      s set created_by = v_uid where s.created_by = any (v_stale);
    update public.purchases                  q set created_by = v_uid where q.created_by = any (v_stale);
    update public.expenses                   e set created_by = v_uid where e.created_by = any (v_stale);
    update public.payments                   p set created_by = v_uid where p.created_by = any (v_stale);
    update public.gateway_transactions       g set initiated_by = v_uid where g.initiated_by = any (v_stale);
    update public.inventory_items            i set created_by = v_uid where i.created_by = any (v_stale);
    update public.inventory_movements        v set created_by = v_uid where v.created_by = any (v_stale);
    update public.budgets                    b set created_by = v_uid where b.created_by = any (v_stale);
    update public.bank_reconciliations       r set created_by = v_uid where r.created_by = any (v_stale);
    update public.bank_statement_lines       l set created_by = v_uid where l.created_by = any (v_stale);
    update public.recurring_invoice_templates t set created_by = v_uid where t.created_by = any (v_stale);
    update public.recurring_invoice_runs     r set created_by = v_uid where r.created_by = any (v_stale);
    update public.document_attachments       d set uploaded_by = v_uid where d.uploaded_by = any (v_stale);
    update public.fixed_assets               a set created_by = v_uid where a.created_by = any (v_stale);
    update public.fixed_asset_depreciations  d set created_by = v_uid where d.created_by = any (v_stale);

    foreach v_t in array v_guarded loop
      execute format('alter table public.%I enable trigger user', v_t);
    end loop;

    update public.profiles
       set archived_at = coalesce(archived_at, now())
     where id = any (v_stale);
  end if;

  return v_uid;
end $$;

revoke all on function public.claim_profile() from public, anon, authenticated;
grant execute on function public.claim_profile() to authenticated;
