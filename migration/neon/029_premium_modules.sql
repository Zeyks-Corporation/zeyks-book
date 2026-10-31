-- Premium modules: budgets, bank reconciliation, recurring invoices,
-- attachments, and fixed assets. Additive only; all rows are retained.

create or replace function public.has_premium(p_business_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
      from public.business_memberships m
      join public.profiles p on p.id = m.user_id
     where m.business_id = p_business_id
       and m.user_id = (select auth.uid())
       and m.role in ('OWNER', 'ACCOUNTANT')
       and p.role = 'premium'
  );
$$;
revoke all on function public.has_premium(uuid) from public, anon, authenticated;
grant execute on function public.has_premium(uuid) to authenticated;

-- Budgets are non-posting forecasts, keyed to one account and date range.
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  name text not null check (btrim(name) <> ''),
  account_id uuid not null,
  period_start date not null,
  period_end date not null,
  budget_amount numeric(14,2) not null check (budget_amount >= 0),
  archived_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (business_id, id),
  foreign key (business_id, account_id) references public.accounts(business_id, id) on delete restrict
);
create index budgets_business_period_idx on public.budgets (business_id, period_start, period_end)
  where archived_at is null;

-- Bank statement rows are retained after matching and after a reconciliation
-- is completed. Matching links a statement line to the immutable ledger.
create table public.bank_reconciliations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  account_id uuid not null,
  period_start date not null,
  period_end date not null,
  opening_balance numeric(14,2) not null,
  closing_balance numeric(14,2) not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'RECONCILED')),
  reconciled_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  check ((status = 'OPEN' and reconciled_at is null) or (status = 'RECONCILED' and reconciled_at is not null)),
  unique (business_id, id),
  foreign key (business_id, account_id) references public.accounts(business_id, id) on delete restrict
);
create table public.bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  reconciliation_id uuid not null,
  transaction_date date not null,
  description text not null check (btrim(description) <> ''),
  reference text not null default '',
  amount numeric(14,2) not null check (amount <> 0),
  match_status text not null default 'UNMATCHED' check (match_status in ('UNMATCHED', 'MATCHED', 'IGNORED')),
  matched_journal_entry_id uuid,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check ((match_status = 'MATCHED') = (matched_journal_entry_id is not null)),
  unique (business_id, id),
  foreign key (business_id, reconciliation_id) references public.bank_reconciliations(business_id, id) on delete restrict,
  foreign key (business_id, matched_journal_entry_id) references public.journal_entries(business_id, id) on delete restrict
);
create unique index bank_statement_lines_one_match_per_entry_idx
  on public.bank_statement_lines (business_id, reconciliation_id, matched_journal_entry_id)
  where matched_journal_entry_id is not null;
create index bank_statement_lines_reconciliation_idx
  on public.bank_statement_lines (business_id, reconciliation_id, transaction_date, id);

create function public.validate_bank_statement_match() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_account uuid;
  v_start date;
  v_end date;
  v_entry_date date;
  v_movement numeric(14,2);
begin
  select r.account_id, r.period_start, r.period_end
    into v_account, v_start, v_end
    from public.bank_reconciliations r
   where r.business_id = new.business_id and r.id = new.reconciliation_id
   for update;
  if not found then raise exception 'Reconciliation not found'; end if;
  if exists (select 1 from public.bank_reconciliations r
              where r.id = new.reconciliation_id and r.business_id = new.business_id
                and r.status = 'RECONCILED') then
    raise exception 'A completed reconciliation and its matches are immutable';
  end if;
  if new.transaction_date < v_start or new.transaction_date > v_end then
    raise exception 'Statement line date is outside the reconciliation period';
  end if;
  if new.match_status = 'MATCHED' then
    select je.transaction_date, sum(jl.debit - jl.credit)
      into v_entry_date, v_movement
      from public.journal_entries je
      join public.journal_lines jl on jl.business_id = je.business_id and jl.journal_entry_id = je.id
     where je.business_id = new.business_id
       and je.id = new.matched_journal_entry_id
       and jl.account_id = v_account
     group by je.transaction_date;
    if not found or v_entry_date <> new.transaction_date or v_movement <> new.amount then
      raise exception 'Matched ledger entry must have the same account, date, and signed amount';
    end if;
  end if;
  if tg_op = 'UPDATE' and (
       new.business_id <> old.business_id
       or new.reconciliation_id <> old.reconciliation_id
       or new.transaction_date <> old.transaction_date
       or new.description <> old.description
       or new.reference <> old.reference
       or new.amount <> old.amount
     ) then
    raise exception 'Statement transaction details are immutable; only its match status can change';
  end if;
  return new;
end $$;
create trigger bank_statement_lines_validate_match
  before insert or update on public.bank_statement_lines
  for each row execute function public.validate_bank_statement_match();

create function public.guard_premium_module_account_types() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_type text;
begin
  if tg_table_name = 'bank_reconciliations' then
    select a.type into v_type from public.accounts a
     where a.business_id = new.business_id and a.id = new.account_id;
    if v_type <> 'ASSET' then raise exception 'Reconciliation account must be an Asset account'; end if;
  elsif tg_table_name = 'fixed_assets' then
    if new.asset_account_id = new.accumulated_depreciation_account_id
       or new.asset_account_id = new.depreciation_expense_account_id
       or new.accumulated_depreciation_account_id = new.depreciation_expense_account_id then
      raise exception 'Fixed asset, accumulated depreciation, and expense accounts must be different';
    end if;
    if (select a.type from public.accounts a where a.business_id = new.business_id and a.id = new.asset_account_id) <> 'ASSET'
       or (select a.type from public.accounts a where a.business_id = new.business_id and a.id = new.accumulated_depreciation_account_id) <> 'ASSET'
       or (select a.type from public.accounts a where a.business_id = new.business_id and a.id = new.depreciation_expense_account_id) <> 'EXPENSE' then
      raise exception 'Fixed asset and contra accounts must be Assets; depreciation account must be Expense';
    end if;
  end if;
  return new;
end $$;
create trigger bank_reconciliations_validate_account
  before insert on public.bank_reconciliations for each row execute function public.guard_premium_module_account_types();

create function public.finalize_bank_reconciliation(p_reconciliation_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_r public.bank_reconciliations%rowtype;
  v_count integer;
  v_unresolved integer;
  v_total numeric(14,2);
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into v_r from public.bank_reconciliations r
   where r.id = p_reconciliation_id for update;
  if not found then raise exception 'Reconciliation not found'; end if;
  if not public.has_premium(v_r.business_id) or not public.can_write(v_r.business_id) then
    raise exception 'Premium owner or accountant access is required' using errcode = '42501';
  end if;
  if v_r.status = 'RECONCILED' then return; end if;
  select count(*), count(*) filter (where l.match_status = 'UNMATCHED'),
         coalesce(sum(l.amount), 0)
    into v_count, v_unresolved, v_total
    from public.bank_statement_lines l
   where l.business_id = v_r.business_id and l.reconciliation_id = v_r.id;
  if v_count = 0 or v_unresolved > 0 then
    raise exception 'Match or explicitly ignore every statement line before finishing';
  end if;
  if round(v_r.opening_balance + v_total, 2) <> round(v_r.closing_balance, 2) then
    raise exception 'Statement lines do not add up to the closing balance';
  end if;
  if round((
    select coalesce(sum(jl.debit - jl.credit), 0)
      from public.journal_entries je
      join public.journal_lines jl on jl.business_id = je.business_id and jl.journal_entry_id = je.id
     where je.business_id = v_r.business_id
       and je.transaction_date <= v_r.period_end
       and jl.account_id = v_r.account_id
  ), 2) <> round(v_r.closing_balance, 2) then
    raise exception 'The ledger account balance does not equal the statement closing balance';
  end if;
  update public.bank_reconciliations
     set status = 'RECONCILED', reconciled_at = now()
   where id = v_r.id;
end $$;
revoke all on function public.finalize_bank_reconciliation(uuid) from public, anon, authenticated;
grant execute on function public.finalize_bank_reconciliation(uuid) to authenticated;

-- Recurring invoices are templates. Generation runs through the existing
-- atomic sale-posting RPC, then advances the schedule in the same transaction.
create table public.recurring_invoice_templates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  customer_name text not null check (btrim(customer_name) <> ''),
  description text not null check (btrim(description) <> ''),
  quantity numeric(14,3) not null default 1 check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  discount numeric(14,2) not null default 0 check (discount >= 0),
  payment_terms_days integer not null default 0 check (payment_terms_days between 0 and 3650),
  cadence text not null check (cadence in ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY')),
  next_run_date date not null,
  anchor_day smallint not null check (anchor_day between 1 and 31),
  is_active boolean not null default true,
  archived_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (discount < quantity * unit_price),
  unique (business_id, id)
);
create index recurring_invoice_templates_due_idx
  on public.recurring_invoice_templates (business_id, next_run_date)
  where is_active and archived_at is null;
create table public.recurring_invoice_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  template_id uuid not null,
  scheduled_date date not null,
  sale_id uuid not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, template_id, scheduled_date),
  foreign key (business_id, template_id) references public.recurring_invoice_templates(business_id, id) on delete restrict,
  foreign key (business_id, sale_id) references public.sales(business_id, id) on delete restrict
);

create function public.generate_recurring_invoice(p_template_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_t public.recurring_invoice_templates%rowtype;
  v_business public.businesses%rowtype;
  v_date date;
  v_next date;
  v_subtotal numeric(14,2);
  v_tax numeric(14,2);
  v_total numeric(14,2);
  v_items jsonb;
  v_sale jsonb;
  v_sale_id uuid;
  v_month date;
  v_anchor integer;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into v_t from public.recurring_invoice_templates t
   where t.id = p_template_id for update;
  if not found or not v_t.is_active or v_t.archived_at is not null then
    raise exception 'Active recurring invoice template not found';
  end if;
  if not public.has_premium(v_t.business_id) or not public.can_write(v_t.business_id) then
    raise exception 'Premium owner or accountant access is required' using errcode = '42501';
  end if;
  select * into v_business from public.businesses b where b.id = v_t.business_id;
  v_date := v_t.next_run_date;
  if v_date > (now() at time zone v_business.timezone)::date then
    raise exception 'This invoice is not due until %', v_date;
  end if;
  if exists (select 1 from public.recurring_invoice_runs r
              where r.business_id = v_t.business_id and r.template_id = v_t.id and r.scheduled_date = v_date) then
    raise exception 'This scheduled invoice has already been generated';
  end if;

  v_subtotal := round(v_t.quantity * v_t.unit_price - v_t.discount, 2);
  if v_subtotal <= 0 then raise exception 'Recurring invoice total must be positive'; end if;
  v_tax := case when v_business.vat_registered then round(v_subtotal * v_business.vat_rate / 100, 2) else 0 end;
  v_total := v_subtotal + v_tax;
  v_items := jsonb_build_array(jsonb_build_object(
    'line_no', 1, 'description', v_t.description,
    'quantity', v_t.quantity, 'unit_price', v_t.unit_price,
    'discount', v_t.discount, 'total', v_subtotal
  ));
  v_sale := public.post_sale(
    p_business_id => v_t.business_id,
    p_customer_id => null,
    p_customer_name => v_t.customer_name,
    p_invoice_number => 'REC-' || upper(substr(replace(v_t.id::text, '-', ''), 1, 8)) || '-' || to_char(v_date, 'YYYYMMDD'),
    p_date => v_date,
    p_subtotal => v_subtotal,
    p_discount_total => v_t.discount,
    p_tax_amount => v_tax,
    p_total_amount => v_total,
    p_upfront_paid => 0,
    p_payment_method => 'CASH',
    p_cost_of_goods => null,
    p_notes => 'Generated from recurring invoice schedule ' || v_t.id::text,
    p_items => v_items,
    p_payment_terms_days => v_t.payment_terms_days
  );
  v_sale_id := (v_sale -> 'sale' ->> 'id')::uuid;
  if v_sale_id is null then raise exception 'Sale posting returned no invoice id'; end if;
  insert into public.recurring_invoice_runs (business_id, template_id, scheduled_date, sale_id, created_by)
  values (v_t.business_id, v_t.id, v_date, v_sale_id, auth.uid());

  if v_t.cadence = 'WEEKLY' then
    v_next := v_date + 7;
  elsif v_t.cadence = 'MONTHLY' then
    v_month := (date_trunc('month', v_date)::date + interval '1 month')::date;
    v_next := v_month + least(v_t.anchor_day, extract(day from (v_month + interval '1 month - 1 day'))::integer) - 1;
  elsif v_t.cadence = 'QUARTERLY' then
    v_month := (date_trunc('month', v_date)::date + interval '3 months')::date;
    v_next := v_month + least(v_t.anchor_day, extract(day from (v_month + interval '1 month - 1 day'))::integer) - 1;
  else
    v_month := (date_trunc('month', v_date)::date + interval '1 year')::date;
    v_next := v_month + least(v_t.anchor_day, extract(day from (v_month + interval '1 month - 1 day'))::integer) - 1;
  end if;
  update public.recurring_invoice_templates set next_run_date = v_next where id = v_t.id;
  return jsonb_build_object('sale_id', v_sale_id, 'scheduled_date', v_date, 'next_run_date', v_next);
end $$;
revoke all on function public.generate_recurring_invoice(uuid) from public, anon, authenticated;
grant execute on function public.generate_recurring_invoice(uuid) to authenticated;

-- Private, small-file document storage. Files stay with the business and are
-- never removed by the application; callers may soft-archive the row.
create table public.document_attachments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  record_type text not null check (record_type in ('BUSINESS', 'SALE', 'PURCHASE', 'EXPENSE', 'PAYMENT', 'FIXED_ASSET')),
  record_id uuid,
  file_name text not null check (btrim(file_name) <> ''),
  media_type text not null,
  content_base64 text not null,
  byte_size integer not null check (byte_size between 1 and 2097152),
  archived_at timestamptz,
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  uploaded_at timestamptz not null default now(),
  unique (business_id, id),
  check (octet_length(content_base64) <= 2800000)
);
create index document_attachments_business_idx on public.document_attachments(business_id, uploaded_at desc);

-- Fixed assets and posted straight-line depreciation. The asset register is
-- separate from the ledger; each booked period creates a balanced MANUAL entry.
create table public.fixed_assets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  name text not null check (btrim(name) <> ''),
  purchase_date date not null,
  cost numeric(14,2) not null check (cost > 0),
  salvage_value numeric(14,2) not null default 0 check (salvage_value >= 0),
  useful_life_months smallint not null check (useful_life_months between 1 and 1200),
  asset_account_id uuid not null,
  depreciation_expense_account_id uuid not null,
  accumulated_depreciation_account_id uuid not null,
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (salvage_value < cost),
  unique (business_id, id),
  foreign key (business_id, asset_account_id) references public.accounts(business_id, id) on delete restrict,
  foreign key (business_id, depreciation_expense_account_id) references public.accounts(business_id, id) on delete restrict,
  foreign key (business_id, accumulated_depreciation_account_id) references public.accounts(business_id, id) on delete restrict
);
create trigger fixed_assets_validate_accounts
  before insert on public.fixed_assets for each row execute function public.guard_premium_module_account_types();
create table public.fixed_asset_depreciations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  asset_id uuid not null,
  period_end date not null,
  amount numeric(14,2) not null check (amount > 0),
  journal_entry_id uuid not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, asset_id, period_end),
  unique (business_id, journal_entry_id),
  foreign key (business_id, asset_id) references public.fixed_assets(business_id, id) on delete restrict,
  foreign key (business_id, journal_entry_id) references public.journal_entries(business_id, id) on delete restrict
);
create index fixed_assets_business_idx on public.fixed_assets(business_id, purchase_date)
  where is_active;

create function public.post_fixed_asset_depreciation(p_asset_id uuid, p_period_end date)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_a public.fixed_assets%rowtype;
  v_uid uuid := (select auth.uid());
  v_depreciated numeric(14,2);
  v_amount numeric(14,2);
  v_sequence bigint;
  v_entry uuid;
  v_today date;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into v_a from public.fixed_assets a where a.id = p_asset_id for update;
  if not found or not v_a.is_active then raise exception 'Active fixed asset not found'; end if;
  if not public.has_premium(v_a.business_id) or not public.can_write(v_a.business_id) then
    raise exception 'Premium owner or accountant access is required' using errcode = '42501';
  end if;
  select (now() at time zone b.timezone)::date into v_today
    from public.businesses b where b.id = v_a.business_id;
  if p_period_end > v_today or p_period_end < v_a.purchase_date then
    raise exception 'Depreciation period must be between the purchase date and today';
  end if;
  if extract(day from p_period_end) <> extract(day from (date_trunc('month', p_period_end) + interval '1 month - 1 day')) then
    raise exception 'Use the final day of the depreciation month';
  end if;
  if exists (select 1 from public.fixed_asset_depreciations d
              where d.business_id = v_a.business_id and d.asset_id = v_a.id and d.period_end = p_period_end) then
    raise exception 'Depreciation is already posted for this period';
  end if;
  select coalesce(sum(d.amount), 0) into v_depreciated
    from public.fixed_asset_depreciations d
   where d.business_id = v_a.business_id and d.asset_id = v_a.id;
  v_amount := least(
    round((v_a.cost - v_a.salvage_value) / v_a.useful_life_months, 2),
    round(v_a.cost - v_a.salvage_value - v_depreciated, 2)
  );
  if v_amount <= 0 then raise exception 'The asset is fully depreciated'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_a.business_id::text, 0));
  select coalesce(max(j.sequence), 0) + 1 into v_sequence
    from public.journal_entries j where j.business_id = v_a.business_id;
  insert into public.journal_entries (
    business_id, transaction_date, sequence, description, reference,
    source_type, source_id, created_by
  ) values (
    v_a.business_id, p_period_end, v_sequence,
    'Depreciation — ' || v_a.name,
    'DEP-' || upper(substr(replace(v_a.id::text, '-', ''), 1, 8)) || '-' || to_char(p_period_end, 'YYYYMM'),
    'MANUAL', v_a.id, v_uid
  ) returning id into v_entry;

  insert into public.journal_lines (
    business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit
  )
  select v_a.business_id, v_entry, 1, a.id, a.name, a.type, v_amount, 0
    from public.accounts a where a.business_id = v_a.business_id and a.id = v_a.depreciation_expense_account_id and a.type = 'EXPENSE';
  if not found then raise exception 'Depreciation expense account must be an Expense account'; end if;
  insert into public.journal_lines (
    business_id, journal_entry_id, line_no, account_id, account_name, account_type, debit, credit
  )
  select v_a.business_id, v_entry, 2, a.id, a.name, a.type, 0, v_amount
    from public.accounts a where a.business_id = v_a.business_id and a.id = v_a.accumulated_depreciation_account_id and a.type = 'ASSET';
  if not found then raise exception 'Accumulated depreciation account must be an Asset account'; end if;
  insert into public.fixed_asset_depreciations (
    business_id, asset_id, period_end, amount, journal_entry_id, created_by
  ) values (v_a.business_id, v_a.id, p_period_end, v_amount, v_entry, v_uid);
  return v_entry;
end $$;
revoke all on function public.post_fixed_asset_depreciation(uuid, date) from public, anon, authenticated;
grant execute on function public.post_fixed_asset_depreciation(uuid, date) to authenticated;

-- Keep customer records even if a privileged SQL user makes a mistake.
do $$
declare t text;
begin
  foreach t in array array['budgets','bank_reconciliations','bank_statement_lines',
                           'recurring_invoice_templates','recurring_invoice_runs',
                           'document_attachments','fixed_assets','fixed_asset_depreciations'] loop
    execute format('create trigger %I before delete on public.%I for each row execute function public.forbid_modification()', t || '_no_delete', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.forbid_modification()', t || '_no_truncate', t);
  end loop;
end $$;

alter table public.budgets enable row level security;
alter table public.bank_reconciliations enable row level security;
alter table public.bank_statement_lines enable row level security;
alter table public.recurring_invoice_templates enable row level security;
alter table public.recurring_invoice_runs enable row level security;
alter table public.document_attachments enable row level security;
alter table public.fixed_assets enable row level security;
alter table public.fixed_asset_depreciations enable row level security;

grant select, insert on public.budgets to authenticated;
grant select, insert on public.bank_reconciliations to authenticated;
grant select, insert on public.bank_statement_lines to authenticated;
grant update (match_status, matched_journal_entry_id) on public.bank_statement_lines to authenticated;
grant select, insert on public.recurring_invoice_templates to authenticated;
grant update (customer_name, description, quantity, unit_price, discount,
  payment_terms_days, cadence, next_run_date, is_active, archived_at)
  on public.recurring_invoice_templates to authenticated;
grant select, insert on public.document_attachments, public.fixed_assets to authenticated;
grant select on public.recurring_invoice_runs, public.fixed_asset_depreciations to authenticated;

create policy budgets_select_member on public.budgets for select to authenticated
  using (public.is_member(business_id) and public.has_premium(business_id));
create policy budgets_insert_premium on public.budgets for insert to authenticated
  with check (public.has_premium(business_id) and public.can_write(business_id) and created_by = (select auth.uid()));
create policy bank_reconciliations_select_member on public.bank_reconciliations for select to authenticated
  using (public.is_member(business_id) and public.has_premium(business_id));
create policy bank_reconciliations_insert_premium on public.bank_reconciliations for insert to authenticated
  with check (public.has_premium(business_id) and public.can_write(business_id) and created_by = (select auth.uid()) and status = 'OPEN');
create policy bank_statement_lines_select_member on public.bank_statement_lines for select to authenticated
  using (public.is_member(business_id) and public.has_premium(business_id));
create policy bank_statement_lines_insert_premium on public.bank_statement_lines for insert to authenticated
  with check (public.has_premium(business_id) and public.can_write(business_id) and created_by = (select auth.uid()));
create policy bank_statement_lines_update_premium on public.bank_statement_lines for update to authenticated
  using (public.has_premium(business_id) and public.can_write(business_id))
  with check (public.has_premium(business_id) and public.can_write(business_id));

create policy recurring_templates_select_member on public.recurring_invoice_templates for select to authenticated
  using (public.is_member(business_id) and public.has_premium(business_id));
create policy recurring_templates_insert_premium on public.recurring_invoice_templates for insert to authenticated
  with check (public.has_premium(business_id) and public.can_write(business_id) and created_by = (select auth.uid()));
create policy recurring_templates_update_premium on public.recurring_invoice_templates for update to authenticated
  using (public.has_premium(business_id) and public.can_write(business_id))
  with check (public.has_premium(business_id) and public.can_write(business_id));
create policy recurring_runs_select_member on public.recurring_invoice_runs for select to authenticated
  using (public.is_member(business_id) and public.has_premium(business_id));

create policy attachments_select_member on public.document_attachments for select to authenticated
  using (public.is_member(business_id) and public.has_premium(business_id));
create policy attachments_insert_premium on public.document_attachments for insert to authenticated
  with check (public.has_premium(business_id) and public.can_write(business_id) and uploaded_by = (select auth.uid()));
create policy fixed_assets_select_member on public.fixed_assets for select to authenticated
  using (public.is_member(business_id) and public.has_premium(business_id));
create policy fixed_assets_insert_premium on public.fixed_assets for insert to authenticated
  with check (public.has_premium(business_id) and public.can_write(business_id) and created_by = (select auth.uid()));
create policy asset_depreciations_select_member on public.fixed_asset_depreciations for select to authenticated
  using (public.is_member(business_id) and public.has_premium(business_id));

do $$
begin
  if has_table_privilege('anon', 'public.budgets', 'INSERT,UPDATE,DELETE,TRUNCATE')
     or has_table_privilege('authenticated', 'public.budgets', 'DELETE,TRUNCATE')
     or has_table_privilege('anon', 'public.bank_statement_lines', 'INSERT,UPDATE,DELETE,TRUNCATE')
     or has_table_privilege('authenticated', 'public.bank_statement_lines', 'DELETE,TRUNCATE') then
    raise exception 'Premium module privileges permit an unsafe data operation';
  end if;
end $$;
