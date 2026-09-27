-- 001_core_tables.sql
-- Zeyks Book cloud foundation: tables, constraints, indexes, integrity triggers.
-- RLS is ENABLED here (deny-all until 002 adds policies). No data is inserted.
--
-- Conventions
--   * money            numeric(14,2)
--   * business dates   date            (round-trips as 'YYYY-MM-DD', matching the engine)
--   * timestamps       timestamptz
--   * every tenant table carries business_id; children reference parents through
--     composite (business_id, id) foreign keys, so cross-tenant links are impossible
--   * nothing is ever deleted: all FKs are RESTRICT, delete/truncate triggers below

-- ============================================================================
-- Identity and tenancy
-- ============================================================================

create table public.profiles (
  id          uuid primary key,
  email       text not null default '',
  full_name   text not null default '',
  created_at  timestamptz not null default now()
);

create table public.businesses (
  id                      uuid primary key default gen_random_uuid(),
  created_by              uuid not null references public.profiles (id) on delete restrict,
  business_name           text not null check (btrim(business_name) <> ''),
  owner_name              text not null default '',
  email                   text not null default '',
  phone                   text not null default '',
  pan_number              text not null default '' check (pan_number = '' or pan_number ~ '^[0-9]{9}$'),
  address                 text not null default '',
  city                    text not null default '',
  currency                text not null default 'NPR' check (currency = 'NPR'),
  currency_symbol         text not null default 'NPR' check (currency_symbol in ('NPR', 'रू')),
  timezone                text not null default 'Asia/Kathmandu' check (timezone = 'Asia/Kathmandu'),
  fiscal_year_start_month smallint not null default 4 check (fiscal_year_start_month between 1 and 12),
  vat_registered          boolean not null default false,
  vat_rate                numeric(5,2) not null default 13 check (vat_rate between 0 and 100),
  track_inventory         boolean not null default false,
  created_at              timestamptz not null default now()
);

create table public.business_memberships (
  business_id uuid not null references public.businesses (id) on delete restrict,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        text not null check (role in ('OWNER', 'ACCOUNTANT', 'VIEWER')),
  created_at  timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index business_memberships_user_idx on public.business_memberships (user_id);

-- ============================================================================
-- Parties
-- ============================================================================

create table public.customers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  name        text not null check (name <> '' and name = btrim(name)),
  phone       text,
  email       text,
  pan_number  text,
  address     text,
  created_at  timestamptz not null default now(),
  unique (business_id, id)
);
create unique index customers_business_name_uidx on public.customers (business_id, lower(name));

create table public.suppliers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  name        text not null check (name <> '' and name = btrim(name)),
  phone       text,
  email       text,
  pan_number  text,
  address     text,
  created_at  timestamptz not null default now(),
  unique (business_id, id)
);
create unique index suppliers_business_name_uidx on public.suppliers (business_id, lower(name));

-- ============================================================================
-- Chart of accounts
-- ============================================================================

create table public.accounts (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses (id) on delete restrict,
  code           text not null check (code ~ '^[0-9]{4}$'),
  name           text not null check (btrim(name) <> ''),
  type           text not null check (type in ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  description    text,
  is_active      boolean not null default true,
  system_account boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (business_id, code),
  unique (business_id, id),
  unique (business_id, id, type)   -- lets journal_lines pin its account_type snapshot to the real type
);
create index accounts_business_type_idx on public.accounts (business_id, type);

-- ============================================================================
-- Journal (created before documents, which point at their entry)
-- ============================================================================

create table public.journal_entries (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null references public.businesses (id) on delete restrict,
  transaction_date     date not null,
  sequence             bigint not null check (sequence > 0),
  description          text not null,
  reference            text not null check (btrim(reference) <> ''),
  source_type          text not null check (source_type in
                         ('SALE', 'PURCHASE', 'EXPENSE', 'PAYMENT', 'MANUAL', 'REVERSAL', 'CLOSING', 'OPENING')),
  source_id            uuid,   -- polymorphic (sale/purchase/expense/payment id); validated by the posting RPCs
  reverses_entry_id    uuid,
  reversed_by_entry_id uuid,
  created_by           uuid not null references public.profiles (id) on delete restrict,
  created_at           timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, sequence),
  constraint journal_entries_reverses_fk
    foreign key (business_id, reverses_entry_id)
    references public.journal_entries (business_id, id) on delete restrict,
  constraint journal_entries_reversed_by_fk
    foreign key (business_id, reversed_by_entry_id)
    references public.journal_entries (business_id, id) on delete restrict,
  constraint journal_entries_no_self_link
    check (reverses_entry_id is distinct from id and reversed_by_entry_id is distinct from id),
  constraint journal_entries_reversal_shape
    check ((source_type = 'REVERSAL') = (reverses_entry_id is not null))
);
-- An entry can be reversed at most once, and a reversal points at exactly one entry.
create unique index journal_entries_reverses_uidx
  on public.journal_entries (business_id, reverses_entry_id) where reverses_entry_id is not null;
create unique index journal_entries_reversed_by_uidx
  on public.journal_entries (business_id, reversed_by_entry_id) where reversed_by_entry_id is not null;
create index journal_entries_period_idx
  on public.journal_entries (business_id, transaction_date, sequence);

create table public.journal_lines (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null,
  journal_entry_id uuid not null,
  line_no          smallint not null check (line_no > 0),
  account_id       uuid not null,
  account_name     text not null,
  account_type     text not null,
  debit            numeric(14,2) not null default 0 check (debit >= 0),
  credit           numeric(14,2) not null default 0 check (credit >= 0),
  -- exactly one side carries value: never both positive, never both zero
  constraint journal_lines_one_side
    check ((debit > 0 and credit = 0) or (debit = 0 and credit > 0)),
  unique (journal_entry_id, line_no),
  constraint journal_lines_entry_fk
    foreign key (business_id, journal_entry_id)
    references public.journal_entries (business_id, id) on delete restrict,
  constraint journal_lines_account_fk
    foreign key (business_id, account_id, account_type)
    references public.accounts (business_id, id, type) on delete restrict
);
create index journal_lines_account_idx on public.journal_lines (business_id, account_id);

-- ============================================================================
-- Sales
-- ============================================================================

create table public.sales (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete restrict,
  customer_id      uuid not null,
  customer_name    text not null check (btrim(customer_name) <> ''),
  invoice_number   text not null check (btrim(invoice_number) <> ''),
  date             date not null,
  subtotal         numeric(14,2) not null check (subtotal >= 0),
  discount_total   numeric(14,2) not null default 0 check (discount_total >= 0),
  tax_amount       numeric(14,2) not null default 0 check (tax_amount >= 0),
  total_amount     numeric(14,2) not null check (total_amount > 0),
  upfront_paid     numeric(14,2) not null default 0 check (upfront_paid >= 0),
  payment_method   text not null check (payment_method in ('CASH', 'BANK', 'ESEWA', 'KHALTI')),
  cost_of_goods    numeric(14,2) check (cost_of_goods >= 0),
  status           text not null default 'POSTED' check (status in ('POSTED', 'VOIDED')),
  notes            text,
  journal_entry_id uuid not null,
  created_at       timestamptz not null default now(),
  created_by       uuid not null references public.profiles (id) on delete restrict,
  -- paid_amount / payment_status are NOT stored: reconcile() derives them from settlements
  constraint sales_total_matches check (total_amount = subtotal + tax_amount),
  constraint sales_upfront_within_total check (upfront_paid <= total_amount),
  unique (business_id, id),
  unique (business_id, invoice_number),
  unique (journal_entry_id),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete restrict,
  foreign key (business_id, journal_entry_id) references public.journal_entries (business_id, id) on delete restrict
);
create index sales_business_date_idx on public.sales (business_id, date desc);
create index sales_business_customer_idx on public.sales (business_id, customer_id);

create table public.sale_items (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  sale_id     uuid not null,
  line_no     smallint not null check (line_no > 0),
  description text not null default '',
  quantity    numeric(14,2) not null check (quantity > 0),
  unit_price  numeric(14,2) not null check (unit_price >= 0),
  discount    numeric(14,2) not null default 0 check (discount >= 0),
  total       numeric(14,2) not null check (total >= 0),
  unique (sale_id, line_no),
  foreign key (business_id, sale_id) references public.sales (business_id, id) on delete restrict
);

-- ============================================================================
-- Purchases
-- ============================================================================

create table public.purchases (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete restrict,
  supplier_id      uuid not null,
  supplier_name    text not null check (btrim(supplier_name) <> ''),
  reference_number text not null check (btrim(reference_number) <> ''),
  date             date not null,
  subtotal         numeric(14,2) not null check (subtotal >= 0),
  discount_total   numeric(14,2) not null default 0 check (discount_total >= 0),
  tax_amount       numeric(14,2) not null default 0 check (tax_amount >= 0),
  total_amount     numeric(14,2) not null check (total_amount > 0),
  upfront_paid     numeric(14,2) not null default 0 check (upfront_paid >= 0),
  payment_method   text not null check (payment_method in ('CASH', 'BANK', 'ESEWA', 'KHALTI')),
  status           text not null default 'POSTED' check (status in ('POSTED', 'VOIDED')),
  notes            text,
  journal_entry_id uuid not null,
  created_at       timestamptz not null default now(),
  created_by       uuid not null references public.profiles (id) on delete restrict,
  constraint purchases_total_matches check (total_amount = subtotal + tax_amount),
  constraint purchases_upfront_within_total check (upfront_paid <= total_amount),
  unique (business_id, id),
  unique (business_id, reference_number),
  unique (journal_entry_id),
  foreign key (business_id, supplier_id) references public.suppliers (business_id, id) on delete restrict,
  foreign key (business_id, journal_entry_id) references public.journal_entries (business_id, id) on delete restrict
);
create index purchases_business_date_idx on public.purchases (business_id, date desc);
create index purchases_business_supplier_idx on public.purchases (business_id, supplier_id);

create table public.purchase_items (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  purchase_id uuid not null,
  line_no     smallint not null check (line_no > 0),
  description text not null default '',
  quantity    numeric(14,2) not null check (quantity > 0),
  unit_price  numeric(14,2) not null check (unit_price >= 0),
  discount    numeric(14,2) not null default 0 check (discount >= 0),
  total       numeric(14,2) not null check (total >= 0),
  unique (purchase_id, line_no),
  foreign key (business_id, purchase_id) references public.purchases (business_id, id) on delete restrict
);

-- ============================================================================
-- Expenses
-- ============================================================================

create table public.expenses (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete restrict,
  reference        text not null check (btrim(reference) <> ''),
  account_id       uuid not null,
  category_name    text not null check (btrim(category_name) <> ''),
  date             date not null,
  description      text not null check (btrim(description) <> ''),
  amount           numeric(14,2) not null check (amount > 0),
  tax_amount       numeric(14,2) not null default 0 check (tax_amount >= 0),
  total_amount     numeric(14,2) not null,
  payment_method   text not null check (payment_method in ('CASH', 'BANK', 'ESEWA', 'KHALTI')),
  status           text not null default 'POSTED' check (status in ('POSTED', 'VOIDED')),
  notes            text,
  journal_entry_id uuid not null,
  created_at       timestamptz not null default now(),
  created_by       uuid not null references public.profiles (id) on delete restrict,
  constraint expenses_total_matches check (total_amount = amount + tax_amount),
  unique (business_id, id),
  unique (business_id, reference),
  unique (journal_entry_id),
  foreign key (business_id, account_id) references public.accounts (business_id, id) on delete restrict,
  foreign key (business_id, journal_entry_id) references public.journal_entries (business_id, id) on delete restrict
);
create index expenses_business_date_idx on public.expenses (business_id, date desc);
create index expenses_business_account_idx on public.expenses (business_id, account_id);

-- ============================================================================
-- Payments (settlements)
-- ============================================================================

create table public.payments (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete restrict,
  reference              text not null check (btrim(reference) <> ''),
  date                   date not null,
  amount                 numeric(14,2) not null check (amount > 0),
  payment_method         text not null check (payment_method in ('CASH', 'BANK', 'ESEWA', 'KHALTI')),
  status                 text not null default 'COMPLETED' check (status in ('COMPLETED', 'PENDING', 'FAILED')),
  payment_type           text not null check (payment_type in ('INCOMING', 'OUTGOING')),
  linked_sale_id         uuid,
  linked_purchase_id     uuid,
  party_name             text not null check (btrim(party_name) <> ''),
  gateway_transaction_id text,
  doc_status             text not null default 'POSTED' check (doc_status in ('POSTED', 'VOIDED')),
  notes                  text,
  journal_entry_id       uuid not null,
  created_at             timestamptz not null default now(),
  created_by             uuid not null references public.profiles (id) on delete restrict,
  -- money received settles invoices; money paid settles purchases; never both
  constraint payments_link_matches_direction check (
    (payment_type = 'INCOMING' or linked_sale_id is null) and
    (payment_type = 'OUTGOING' or linked_purchase_id is null)
  ),
  unique (business_id, id),
  unique (business_id, reference),
  unique (journal_entry_id),
  foreign key (business_id, linked_sale_id) references public.sales (business_id, id) on delete restrict,
  foreign key (business_id, linked_purchase_id) references public.purchases (business_id, id) on delete restrict,
  foreign key (business_id, journal_entry_id) references public.journal_entries (business_id, id) on delete restrict
);
create unique index payments_gateway_txn_uidx
  on public.payments (business_id, gateway_transaction_id) where gateway_transaction_id is not null;
create index payments_business_date_idx on public.payments (business_id, date desc);
create index payments_sale_idx on public.payments (business_id, linked_sale_id) where linked_sale_id is not null;
create index payments_purchase_idx on public.payments (business_id, linked_purchase_id) where linked_purchase_id is not null;

-- ============================================================================
-- Gateway transactions (written by the server only; see 002 grants)
-- ============================================================================

create table public.gateway_transactions (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete restrict,
  provider               text not null check (provider in ('ESEWA', 'KHALTI')),
  gateway_ref            text not null check (btrim(gateway_ref) <> ''),
  gateway_transaction_id text,
  amount                 numeric(14,2) not null check (amount > 0),
  status                 text not null default 'INITIATED' check (status in
                           ('INITIATED', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED', 'CANCELED')),
  linked_sale_id         uuid,
  customer_name          text not null default '',
  payment_id             uuid,
  initiated_at           timestamptz not null default now(),
  settled_at             timestamptz,
  last_error             text,
  unique (business_id, id),
  unique (provider, gateway_ref),   -- return URLs carry no business context, so this is global
  unique (payment_id),              -- one gateway transaction can never yield two payments
  foreign key (business_id, linked_sale_id) references public.sales (business_id, id) on delete restrict,
  foreign key (business_id, payment_id) references public.payments (business_id, id) on delete restrict
);
create index gateway_transactions_open_idx
  on public.gateway_transactions (business_id, status) where status in ('INITIATED', 'PENDING');

-- ============================================================================
-- Integrity triggers
-- ============================================================================

-- Append-only: rows are never deleted, tables never truncated, and (for line
-- tables) never updated. Triggers apply to every role, including service_role.
-- business_memberships and profiles are deliberately not listed: access can be
-- revoked, and profiles follow auth.users.
create function public.forbid_modification() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% on public.% is not allowed: financial records are append-only', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'businesses', 'customers', 'suppliers', 'accounts', 'sales', 'sale_items', 'purchases', 'purchase_items',
    'expenses', 'payments', 'gateway_transactions', 'journal_entries', 'journal_lines'
  ] loop
    execute format('create trigger %I before delete on public.%I for each row execute function public.forbid_modification()',
                   t || '_no_delete', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.forbid_modification()',
                   t || '_no_truncate', t);
  end loop;
  foreach t in array array['journal_lines', 'sale_items', 'purchase_items'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.forbid_modification()',
                   t || '_no_update', t);
  end loop;
end $$;

-- Documents: only the status column may change, and only POSTED -> VOIDED.
create function public.guard_document_update() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_col text := tg_argv[0];
  v_old text := to_jsonb(old) ->> tg_argv[0];
  v_new text := to_jsonb(new) ->> tg_argv[0];
begin
  if (to_jsonb(new) - v_col) is distinct from (to_jsonb(old) - v_col) then
    raise exception 'Posted % are immutable; only % may change', tg_table_name, v_col
      using errcode = 'restrict_violation';
  end if;
  if v_new is distinct from v_old and not (v_old = 'POSTED' and v_new = 'VOIDED') then
    raise exception '% can only move from POSTED to VOIDED', v_col
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create trigger sales_guard_update     before update on public.sales     for each row execute function public.guard_document_update('status');
create trigger purchases_guard_update before update on public.purchases for each row execute function public.guard_document_update('status');
create trigger expenses_guard_update  before update on public.expenses  for each row execute function public.guard_document_update('status');
create trigger payments_guard_update  before update on public.payments  for each row execute function public.guard_document_update('doc_status');

-- Journal entries: immutable, except reversed_by_entry_id may go NULL -> value
-- once, and only towards an entry that actually reverses this one.
create function public.guard_journal_entry_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (to_jsonb(new) - 'reversed_by_entry_id') is distinct from (to_jsonb(old) - 'reversed_by_entry_id') then
    raise exception 'Journal entries are immutable' using errcode = 'restrict_violation';
  end if;
  if new.reversed_by_entry_id is not distinct from old.reversed_by_entry_id then
    return new;
  end if;
  if old.reversed_by_entry_id is not null then
    raise exception 'Journal entry % has already been reversed', old.id using errcode = 'restrict_violation';
  end if;
  if not exists (
    select 1 from public.journal_entries r
    where r.business_id = new.business_id
      and r.id = new.reversed_by_entry_id
      and r.reverses_entry_id = new.id
  ) then
    raise exception 'reversed_by_entry_id must reference an entry that reverses this one'
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create trigger journal_entries_guard_update
  before update on public.journal_entries
  for each row execute function public.guard_journal_entry_update();

-- TOTAL DEBITS = TOTAL CREDITS, checked at COMMIT (deferred) so all lines of an
-- entry can be inserted first. Fires for both tables so an entry with no lines,
-- or with a single line, is also rejected.
create function public.assert_journal_entry_balanced() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_entry_id uuid;
  v_debit    numeric;
  v_credit   numeric;
  v_count    integer;
begin
  if tg_table_name = 'journal_lines' then
    v_entry_id := new.journal_entry_id;
  else
    v_entry_id := new.id;
  end if;

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    into v_debit, v_credit, v_count
    from public.journal_lines
   where journal_entry_id = v_entry_id;

  if v_count < 2 then
    raise exception 'Journal entry % needs at least two lines (found %)', v_entry_id, v_count
      using errcode = 'check_violation';
  end if;
  if v_debit <> v_credit then
    raise exception 'Journal entry % is unbalanced: debits % <> credits %', v_entry_id, v_debit, v_credit
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger journal_lines_balanced
  after insert on public.journal_lines
  deferrable initially deferred
  for each row execute function public.assert_journal_entry_balanced();

create constraint trigger journal_entries_balanced
  after insert on public.journal_entries
  deferrable initially deferred
  for each row execute function public.assert_journal_entry_balanced();

-- Accounts: id, business, code, type and system flag are frozen; system
-- accounts cannot be archived; accounts with a balance cannot be archived.
create function public.guard_account_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_balance numeric;
begin
  if new.id <> old.id or new.business_id <> old.business_id or new.code <> old.code
     or new.type <> old.type or new.system_account <> old.system_account then
    raise exception 'Account id, business, code, type and system flag cannot be changed'
      using errcode = 'restrict_violation';
  end if;

  if old.is_active and not new.is_active then
    if old.system_account then
      raise exception '% is used by the posting rules and cannot be archived', old.name
        using errcode = 'restrict_violation';
    end if;
    select coalesce(sum(debit), 0) - coalesce(sum(credit), 0) into v_balance
      from public.journal_lines
     where business_id = old.business_id and account_id = old.id;
    if v_balance <> 0 then
      raise exception '% still has a balance of %; clear it before archiving', old.name, v_balance
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;

create trigger accounts_guard_update
  before update on public.accounts
  for each row execute function public.guard_account_update();

-- Trigger functions are never called directly.
revoke all on function
  public.forbid_modification(), public.guard_document_update(), public.guard_journal_entry_update(),
  public.assert_journal_entry_balanced(), public.guard_account_update()
  from public, anon, authenticated;

-- ============================================================================
-- Row level security: ENABLED on every table now; policies come in 002.
-- With RLS on and no policy, the default is deny.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'businesses', 'business_memberships', 'customers', 'suppliers', 'accounts',
    'journal_entries', 'journal_lines', 'sales', 'sale_items', 'purchases', 'purchase_items',
    'expenses', 'payments', 'gateway_transactions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Supabase grants new tables to anon/authenticated by default. Start from zero;
-- 002 grants exactly what each role needs.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- Safety net: fail the migration if any public table is left without RLS.
do $$
declare v_missing text;
begin
  select string_agg(c.relname, ', ') into v_missing
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if v_missing is not null then
    raise exception 'RLS is not enabled on: %', v_missing;
  end if;
end $$;
