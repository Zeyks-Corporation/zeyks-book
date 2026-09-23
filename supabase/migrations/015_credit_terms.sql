-- ============================================================================
-- 015_credit_terms.sql
--
-- Payment terms, and the contractual due date they imply.
--
-- Why this exists
--   Until now these books recorded no credit terms at all, so "when is this
--   document due?" had no answer and the aging report aged each document
--   from its own date. That is a statement about how OLD a document is, not
--   about how LATE payment is. This migration records the terms agreed when a
--   document is posted and derives the due date from them.
--
-- The model, and why this one
--   * `payment_terms_days` — whole days of credit, recorded at posting, 0 meaning
--     due immediately. It is the only thing a client supplies.
--   * `due_date` — the one authoritative contractual date, stored and held to
--     `date + payment_terms_days` by a CHECK constraint. It was written first as a
--     GENERATED column, which is the tidier way to make drift impossible, and
--     that broke voiding: guard_document_update (001) compares the whole row in a
--     BEFORE trigger, where PostgreSQL still shows a stored generated column as
--     NULL in NEW, so every void looked like an edit to a posted document. The
--     CHECK gives the same guarantee — "date says one thing, terms another, due
--     date a third" is refused at the table — without touching that guard.
--   * There is deliberately NO business-level default terms field and no
--     per-customer or per-supplier terms field: nothing in the product asked for
--     one yet, and a default that silently applied would be a policy the books
--     cannot show.
--   * NO INDEX. Aging runs in the reporting layer over the rows the loader has
--     already scoped to the member's business, exactly as the registers do, so
--     nothing queries by due_date today. sales_business_date_idx and
--     purchases_business_date_idx already cover the eventual SQL form.
--
-- What happens to documents that already exist
--   They receive 0 terms — the column default — so their due date is their
--   document date. That is exactly how they were aged before this migration, so
--   no figure moves, and no contractual terms are invented for a document that
--   was posted in a system that could not record them. A reprint of an old
--   invoice states "Due today (cash terms)" for the same reason.
--
-- What this does NOT touch
--   No journal line, no settlement row, no document total, no posting snapshot
--   and no control-account balance changes. Outstanding stays
--   total_amount − SUM(COMPLETED, still-posted settlements). A due date is
--   metadata about WHEN payment is expected; it is not an amount.
--
-- Recording the terms
--   post_sale / post_purchase gain p_payment_terms_days (default 0, so every
--   existing caller keeps working and keeps its old meaning), validated to
--   0..3650 days inside the same transaction that writes the document. The
--   browser never sends a due date, so there is no client-supplied date to
--   distrust and no way for the date shown before posting to differ from the
--   date the books hold. The old signatures are dropped rather than left as an
--   overload, so there is exactly one way in.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Payment terms and the due date they generate
-- ----------------------------------------------------------------------------

alter table public.sales
  add column if not exists payment_terms_days smallint not null default 0
  check (payment_terms_days between 0 and 3650);

-- The contractual due date. Deliberately a stored column rather than a
-- GENERATED one: guard_document_update (001) compares the WHOLE row in a BEFORE
-- trigger, and PostgreSQL leaves a stored generated column NULL in NEW at that
-- point, so a generated due_date would look like a change to the row and every
-- void would be refused with "Posted sales are immutable". The consistency a
-- generated column would have given is enforced by the CHECK below instead, and
-- the guard already forbids every column but status from changing after posting.
alter table public.sales
  add column if not exists due_date date;

-- Documents that already exist record no agreed terms, so they are due on their
-- document date — how they were aged before this migration. No historical terms
-- are invented.
--
-- `sales_guard_update` (001) makes a posted document immutable, and it compares
-- the whole row in a BEFORE UPDATE trigger, so filling in a newly added column is
-- refused for a document that is already posted — which is every document in a
-- database that has been used, and therefore the case this migration exists for.
-- (It is invisible on an empty database: `supabase db reset` has no posted rows
-- to backfill, so the failure only appears when the migration is applied to real
-- data.)
--
-- The guard is not weakened. It is disabled for exactly one deterministic
-- statement, inside this migration's own transaction, and enabled again
-- immediately after; DDL is transactional in PostgreSQL, so a failure anywhere in
-- this file rolls the trigger's state back with everything else. What the
-- statement writes is not an edit to a document either: `due_date` did not exist
-- when these rows were written, so no agreement is being changed, and no amount,
-- journal line, settlement, status or posting snapshot is touched.
alter table public.sales disable trigger sales_guard_update;
update public.sales set due_date = date where due_date is null;
alter table public.sales enable trigger sales_guard_update;

alter table public.sales alter column due_date set not null;

comment on column public.sales.payment_terms_days is
  'Whole days of credit agreed when this document was posted. 0 means due immediately '
  '(cash terms). Documents posted before 015 record 0, which is how they were already aged.';
comment on column public.sales.due_date is
  'The contractual due date: document date + payment_terms_days, enforced by constraint. Aging '
  'reads THIS column. It is metadata about when payment is expected and changes no amount, '
  'journal line or balance.';

-- "The due date agrees with the terms" is a rule of the model, not a convention:
-- a writer that sets one without the other is refused here.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.sales'::regclass and conname = 'sales_due_date_matches_terms'
  ) then
    alter table public.sales
      add constraint sales_due_date_matches_terms
      check (due_date = date + payment_terms_days);
  end if;
end $$;


alter table public.purchases
  add column if not exists payment_terms_days smallint not null default 0
  check (payment_terms_days between 0 and 3650);

-- The contractual due date. Deliberately a stored column rather than a
-- GENERATED one: guard_document_update (001) compares the WHOLE row in a BEFORE
-- trigger, and PostgreSQL leaves a stored generated column NULL in NEW at that
-- point, so a generated due_date would look like a change to the row and every
-- void would be refused with "Posted sales are immutable". The consistency a
-- generated column would have given is enforced by the CHECK below instead, and
-- the guard already forbids every column but status from changing after posting.
alter table public.purchases
  add column if not exists due_date date;

-- Same rule, same reason, on the payables side (purchases_guard_update).
alter table public.purchases disable trigger purchases_guard_update;
update public.purchases set due_date = date where due_date is null;
alter table public.purchases enable trigger purchases_guard_update;

alter table public.purchases alter column due_date set not null;

comment on column public.purchases.payment_terms_days is
  'Whole days of credit agreed when this document was posted. 0 means due immediately '
  '(cash terms). Documents posted before 015 record 0, which is how they were already aged.';
comment on column public.purchases.due_date is
  'The contractual due date: document date + payment_terms_days, enforced by constraint. Aging '
  'reads THIS column. It is metadata about when payment is expected and changes no amount, '
  'journal line or balance.';

-- "The due date agrees with the terms" is a rule of the model, not a convention:
-- a writer that sets one without the other is refused here.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.purchases'::regclass and conname = 'purchases_due_date_matches_terms'
  ) then
    alter table public.purchases
      add constraint purchases_due_date_matches_terms
      check (due_date = date + payment_terms_days);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. The posting functions record the agreed terms
-- ----------------------------------------------------------------------------
-- Dropped rather than overloaded: two post_sale signatures would make the
-- browser's named-argument call ambiguous, and one of them would not know about
-- terms at all.
drop function public.post_sale(uuid, uuid, text, text, date, numeric, numeric, numeric, numeric, numeric, text, numeric, text, jsonb);
drop function public.post_purchase(uuid, uuid, text, text, date, numeric, numeric, numeric, numeric, numeric, text, text, jsonb, text, boolean);

-- ---------------------------------------------------------------------------
-- post_sale (005, plus p_payment_terms_days)
-- ---------------------------------------------------------------------------
create or replace function public.post_sale(
  p_business_id     uuid,
  p_customer_id     uuid,
  p_customer_name   text     default null,
  p_invoice_number  text     default '',
  p_date            date     default null,
  p_subtotal        numeric  default null,
  p_discount_total  numeric  default 0,
  p_tax_amount      numeric  default 0,
  p_total_amount    numeric  default null,
  p_upfront_paid    numeric  default 0,
  p_payment_method  text     default 'CASH',
  p_cost_of_goods   numeric  default null,
  p_notes           text     default null,
  p_items           jsonb    default '[]'::jsonb,
  p_payment_terms_days integer default 0
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid            uuid := (select auth.uid());
  v_business       public.businesses%rowtype;
  v_customer       public.customers%rowtype;
  v_customer_id    uuid;
  v_customer_name  text;
  v_invoice_number text;
  v_sequence       bigint;
  v_settle_code    text;
  v_acc_settle     public.accounts%rowtype;
  v_acc_receivable public.accounts%rowtype;
  v_acc_sales      public.accounts%rowtype;
  v_acc_vat_pay    public.accounts%rowtype;
  v_acc_cogs       public.accounts%rowtype;
  v_acc_inventory  public.accounts%rowtype;
  v_settled_now    numeric(14,2);
  v_on_credit      numeric(14,2);
  v_net            numeric(14,2);
  v_journal_id          uuid;
  v_sale_id             uuid;
  v_payment_id          uuid;
  v_line_idx            smallint := 1;
  v_item                jsonb;
  v_line_no             smallint;
  v_qty                 numeric;
  v_unit_price          numeric;
  v_disc                numeric;
  v_line_total          numeric;
  v_expected_line_total numeric(14,2);
  v_calc_items_total    numeric(14,2) := 0;
  v_calc_discount_total numeric(14,2) := 0;
  v_today_npt           date;
  v_journal_entry       public.journal_entries%rowtype;
  v_sale                public.sales%rowtype;
  v_payment             public.payments%rowtype;
begin
  -- -------------------------------------------------------------------------
  -- 1. Identity & permissions check
  -- -------------------------------------------------------------------------
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not public.is_member(p_business_id) then
    raise exception 'Not a member of this business' using errcode = '42501';
  end if;

  if not public.can_write(p_business_id) then
    raise exception 'Insufficient privileges: write access required' using errcode = '42501';
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Business profile check
  -- -------------------------------------------------------------------------
  select * into v_business
    from public.businesses
   where id = p_business_id;

  if not found then
    raise exception 'Business not found' using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Customer validation / resolution
  -- -------------------------------------------------------------------------
  if p_customer_id is not null then
    select * into v_customer
      from public.customers
     where business_id = p_business_id
       and id = p_customer_id;

    if not found then
      raise exception 'Customer does not belong to this business or does not exist' using errcode = '22023';
    end if;

    v_customer_id := v_customer.id;
    v_customer_name := coalesce(nullif(btrim(p_customer_name), ''), v_customer.name);
  else
    v_customer_name := btrim(coalesce(p_customer_name, ''));
    if v_customer_name = '' then
      raise exception 'Customer is required' using errcode = '22023';
    end if;

    select id into v_customer_id
      from public.customers
     where business_id = p_business_id
       and lower(name) = lower(v_customer_name);

    if not found then
      insert into public.customers (business_id, name)
      values (p_business_id, v_customer_name)
      returning id into v_customer_id;
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Invoice number validation & uniqueness
  -- -------------------------------------------------------------------------
  v_invoice_number := btrim(coalesce(p_invoice_number, ''));
  if v_invoice_number = '' then
    declare
      v_prefix text := 'INV-' || to_char(p_date, 'YYYYMMDD') || '-';
      v_next_num int;
    begin
      select coalesce(max(substring(invoice_number from length(v_prefix) + 1)::int), 0) + 1
        into v_next_num
        from public.sales
       where business_id = p_business_id
         and invoice_number like v_prefix || '%'
         and substring(invoice_number from length(v_prefix) + 1) ~ '^[0-9]+$';
      v_invoice_number := v_prefix || lpad(v_next_num::text, 3, '0');
    end;
  else
    if exists (
      select 1 from public.sales
       where business_id = p_business_id
         and invoice_number = v_invoice_number
    ) then
      raise exception 'Invoice number % already exists in this business', v_invoice_number
        using errcode = '23505';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Date validation (Reject future dates using Asia/Kathmandu business date)
  -- -------------------------------------------------------------------------
  if p_date is null then
    raise exception 'Date is required' using errcode = '22023';
  end if;

  v_today_npt := (now() at time zone coalesce(v_business.timezone, 'Asia/Kathmandu'))::date;
  if p_date > v_today_npt then
    raise exception 'Sale date % cannot be in the future (today in % is %)',
      p_date, coalesce(v_business.timezone, 'Asia/Kathmandu'), v_today_npt
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 5b. Payment terms (whole days of credit, agreed when this is posted)
  -- -------------------------------------------------------------------------
  -- The due date itself is NOT a parameter and is never sent by the client: the
  -- table generates it from the document date plus these terms, so the date the
  -- browser showed and the date the books hold come from one rule. 0 means due
  -- immediately, which is what every document posted before this migration
  -- recorded — no historical terms are invented for them.
  if p_payment_terms_days is null or p_payment_terms_days < 0 or p_payment_terms_days > 3650 then
    raise exception 'Payment terms must be between 0 and 3650 days, got %', p_payment_terms_days
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 6. Amounts & payment method validation
  -- -------------------------------------------------------------------------
  if p_subtotal is null or p_subtotal < 0 then
    raise exception 'Subtotal cannot be negative' using errcode = '22023';
  end if;

  if coalesce(p_discount_total, 0) < 0 then
    raise exception 'Discount total cannot be negative' using errcode = '22023';
  end if;

  if coalesce(p_tax_amount, 0) < 0 then
    raise exception 'Tax amount cannot be negative' using errcode = '22023';
  end if;

  if p_total_amount is null or p_total_amount <= 0 then
    raise exception 'Total amount must be greater than zero' using errcode = '22023';
  end if;

  if coalesce(p_upfront_paid, 0) < 0 then
    raise exception 'Upfront paid cannot be negative' using errcode = '22023';
  end if;

  if coalesce(p_upfront_paid, 0) > p_total_amount then
    raise exception 'Upfront paid cannot exceed total amount' using errcode = '22023';
  end if;

  if p_total_amount <> (p_subtotal + coalesce(p_tax_amount, 0)) then
    raise exception 'Total amount must equal subtotal plus tax amount' using errcode = '22023';
  end if;

  if p_payment_method not in ('CASH', 'BANK', 'ESEWA', 'KHALTI') then
    raise exception 'Invalid payment method: %', p_payment_method using errcode = '22023';
  end if;

  if p_cost_of_goods is not null and p_cost_of_goods < 0 then
    raise exception 'Cost of goods cannot be negative' using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 7. Line items validation & mathematical verification
  -- -------------------------------------------------------------------------
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one line item is required' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_line_no    := (v_item->>'line_no')::smallint;
    v_qty        := (v_item->>'quantity')::numeric;
    v_unit_price := (v_item->>'unit_price')::numeric;
    v_disc       := coalesce((v_item->>'discount')::numeric, 0);
    v_line_total := (v_item->>'total')::numeric;

    if v_line_no is null or v_line_no <= 0 then
      raise exception 'Line number must be positive' using errcode = '22023';
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Quantity must be positive' using errcode = '22023';
    end if;
    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'Unit price cannot be negative' using errcode = '22023';
    end if;
    if v_disc < 0 then
      raise exception 'Discount cannot be negative' using errcode = '22023';
    end if;
    if v_disc > round(v_qty * v_unit_price, 2) then
      raise exception 'Discount cannot exceed line gross value on line %', v_line_no using errcode = '22023';
    end if;
    if v_line_total is null or v_line_total < 0 then
      raise exception 'Line total cannot be negative' using errcode = '22023';
    end if;

    -- Mathematical verification: total = quantity * unit_price - discount
    v_expected_line_total := round(v_qty * v_unit_price - v_disc, 2);
    if v_line_total <> v_expected_line_total then
      raise exception 'Line % total (%) does not equal quantity * unit_price - discount (%)',
        v_line_no, v_line_total, v_expected_line_total using errcode = '22023';
    end if;

    v_calc_items_total    := v_calc_items_total + v_line_total;
    v_calc_discount_total := v_calc_discount_total + v_disc;
  end loop;

  if (select count(distinct (elem->>'line_no')::int) from jsonb_array_elements(p_items) elem)
     <> jsonb_array_length(p_items) then
    raise exception 'Duplicate line numbers are not allowed' using errcode = '22023';
  end if;

  -- Verify sale-level discount total matches sum of line discounts
  if coalesce(p_discount_total, 0) <> v_calc_discount_total then
    raise exception 'Sale discount total (%) does not match sum of line discounts (%)',
      coalesce(p_discount_total, 0), v_calc_discount_total using errcode = '22023';
  end if;

  -- Verify sale-level amounts agree with line items according to domain model:
  -- In exclusive VAT (or tax = 0): subtotal = sum(item.total) and total_amount = subtotal + tax_amount
  -- In inclusive VAT: total_amount = sum(item.total) and subtotal = total_amount - tax_amount
  if p_subtotal <> v_calc_items_total and p_total_amount <> v_calc_items_total then
    raise exception 'Sale amounts do not agree with line items: subtotal (%) or total (%) must equal items total (%)',
      p_subtotal, p_total_amount, v_calc_items_total using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 8. Chart of accounts lookup
  -- -------------------------------------------------------------------------
  -- Settlement asset account:
  if p_payment_method = 'CASH' then
    v_settle_code := '1010';
  elsif p_payment_method = 'BANK' then
    v_settle_code := '1020';
  elsif p_payment_method = 'ESEWA' then
    if exists (select 1 from public.accounts where business_id = p_business_id and code = '1040' and is_active) then
      v_settle_code := '1040';
    else
      v_settle_code := '1020';
    end if;
  elsif p_payment_method = 'KHALTI' then
    if exists (select 1 from public.accounts where business_id = p_business_id and code = '1050' and is_active) then
      v_settle_code := '1050';
    else
      v_settle_code := '1020';
    end if;
  end if;

  select * into v_acc_settle
    from public.accounts
   where business_id = p_business_id and code = v_settle_code;
  if not found then
    raise exception 'Settlement account % is missing from chart of accounts', v_settle_code using errcode = '22023';
  end if;

  -- Accounts receivable:
  select * into v_acc_receivable
    from public.accounts
   where business_id = p_business_id and code = '1030';
  if not found then
    raise exception 'Accounts receivable (1030) is missing from chart of accounts' using errcode = '22023';
  end if;

  -- Sales revenue:
  select * into v_acc_sales
    from public.accounts
   where business_id = p_business_id and code = '4010';
  if not found then
    raise exception 'Sales revenue (4010) is missing from chart of accounts' using errcode = '22023';
  end if;

  -- VAT payable:
  if coalesce(p_tax_amount, 0) > 0 then
    select * into v_acc_vat_pay
      from public.accounts
     where business_id = p_business_id and code = '2020';
    if not found then
      raise exception 'VAT payable (2020) is missing from chart of accounts' using errcode = '22023';
    end if;
  end if;

  -- Cost of Goods Sold & Inventory:
  if v_business.track_inventory and coalesce(p_cost_of_goods, 0) > 0 then
    select * into v_acc_cogs
      from public.accounts
     where business_id = p_business_id and code = '5010';
    if not found then
      raise exception 'Cost of goods sold (5010) is missing from chart of accounts' using errcode = '22023';
    end if;

    select * into v_acc_inventory
      from public.accounts
     where business_id = p_business_id and code = '1060';
    if not found then
      raise exception 'Inventory (1060) is missing from chart of accounts' using errcode = '22023';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 9. Journal entry and lines calculation
  -- -------------------------------------------------------------------------
  v_settled_now := round(greatest(0, least(coalesce(p_upfront_paid, 0), p_total_amount)), 2);
  v_on_credit   := round(p_total_amount - v_settled_now, 2);
  v_net         := round(p_total_amount - coalesce(p_tax_amount, 0), 2);

  v_journal_id  := gen_random_uuid();
  v_sale_id     := gen_random_uuid();

  select coalesce(max(sequence), 0) + 1
    into v_sequence
    from public.journal_entries
   where business_id = p_business_id;

  insert into public.journal_entries (
    id, business_id, transaction_date, sequence, description,
    reference, source_type, source_id, created_by
  ) values (
    v_journal_id, p_business_id, p_date, v_sequence,
    'Sale ' || v_invoice_number || ' — ' || v_customer_name,
    v_invoice_number, 'SALE', v_sale_id, v_uid
  ) returning * into v_journal_entry;

  -- Line: Settlement account (Cash/Bank/Wallet)
  if v_settled_now > 0 then
    insert into public.journal_lines (
      business_id, journal_entry_id, line_no,
      account_id, account_name, account_type, debit, credit
    ) values (
      p_business_id, v_journal_id, v_line_idx,
      v_acc_settle.id, v_acc_settle.name, v_acc_settle.type, v_settled_now, 0
    );
    v_line_idx := v_line_idx + 1;
  end if;

  -- Line: Accounts receivable (on credit balance)
  if v_on_credit > 0 then
    insert into public.journal_lines (
      business_id, journal_entry_id, line_no,
      account_id, account_name, account_type, debit, credit
    ) values (
      p_business_id, v_journal_id, v_line_idx,
      v_acc_receivable.id, v_acc_receivable.name, v_acc_receivable.type, v_on_credit, 0
    );
    v_line_idx := v_line_idx + 1;
  end if;

  -- Line: Sales revenue (net of VAT)
  insert into public.journal_lines (
    business_id, journal_entry_id, line_no,
    account_id, account_name, account_type, debit, credit
  ) values (
    p_business_id, v_journal_id, v_line_idx,
    v_acc_sales.id, v_acc_sales.name, v_acc_sales.type, 0, v_net
  );
  v_line_idx := v_line_idx + 1;

  -- Line: VAT payable
  if coalesce(p_tax_amount, 0) > 0 then
    insert into public.journal_lines (
      business_id, journal_entry_id, line_no,
      account_id, account_name, account_type, debit, credit
    ) values (
      p_business_id, v_journal_id, v_line_idx,
      v_acc_vat_pay.id, v_acc_vat_pay.name, v_acc_vat_pay.type, 0, round(p_tax_amount, 2)
    );
    v_line_idx := v_line_idx + 1;
  end if;

  -- Lines: Inventory & Cost of Goods Sold
  if v_business.track_inventory and coalesce(p_cost_of_goods, 0) > 0 then
    insert into public.journal_lines (
      business_id, journal_entry_id, line_no,
      account_id, account_name, account_type, debit, credit
    ) values (
      p_business_id, v_journal_id, v_line_idx,
      v_acc_cogs.id, v_acc_cogs.name, v_acc_cogs.type, round(p_cost_of_goods, 2), 0
    );
    v_line_idx := v_line_idx + 1;

    insert into public.journal_lines (
      business_id, journal_entry_id, line_no,
      account_id, account_name, account_type, debit, credit
    ) values (
      p_business_id, v_journal_id, v_line_idx,
      v_acc_inventory.id, v_acc_inventory.name, v_acc_inventory.type, 0, round(p_cost_of_goods, 2)
    );
    v_line_idx := v_line_idx + 1;
  end if;

  -- -------------------------------------------------------------------------
  -- 10. Insert sale document and sale items
  -- -------------------------------------------------------------------------
  insert into public.sales (
    id, business_id, customer_id, customer_name, invoice_number, date, payment_terms_days, due_date,
    subtotal, discount_total, tax_amount, total_amount, upfront_paid,
    payment_method, cost_of_goods, status, notes, journal_entry_id,
    created_by
  ) values (
    v_sale_id, p_business_id, v_customer_id, v_customer_name, v_invoice_number, p_date,
    (p_payment_terms_days)::smallint,
    p_date + p_payment_terms_days,
    p_subtotal, coalesce(p_discount_total, 0), coalesce(p_tax_amount, 0), p_total_amount,
    coalesce(p_upfront_paid, 0), p_payment_method, p_cost_of_goods, 'POSTED', p_notes,
    v_journal_id, v_uid
  ) returning * into v_sale;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.sale_items (
      business_id, sale_id, line_no, description, quantity, unit_price, discount, total
    ) values (
      p_business_id,
      v_sale_id,
      (v_item->>'line_no')::smallint,
      coalesce(v_item->>'description', ''),
      (v_item->>'quantity')::numeric,
      (v_item->>'unit_price')::numeric,
      coalesce((v_item->>'discount')::numeric, 0),
      (v_item->>'total')::numeric
    );
  end loop;

  -- -------------------------------------------------------------------------
  -- 11. Create settlement/payment row if upfront payment was made
  -- -------------------------------------------------------------------------
  if coalesce(p_upfront_paid, 0) > 0 then
    v_payment_id := gen_random_uuid();
    insert into public.payments (
      id, business_id, reference, date, amount, payment_method, status,
      payment_type, linked_sale_id, party_name, doc_status, notes,
      journal_entry_id, created_by
    ) values (
      v_payment_id,
      p_business_id,
      'REC-' || v_invoice_number,
      p_date,
      round(p_upfront_paid, 2),
      p_payment_method,
      'COMPLETED',
      'INCOMING',
      v_sale_id,
      v_customer_name,
      'POSTED',
      coalesce(p_notes, 'Upfront payment for ' || v_invoice_number),
      v_journal_id,
      v_uid
    ) returning * into v_payment;
  end if;

  -- -------------------------------------------------------------------------
  -- 12. Return composite payload
  -- -------------------------------------------------------------------------
  return jsonb_build_object(
    'sale', to_jsonb(v_sale),
    'items', (
      select jsonb_agg(to_jsonb(si) order by si.line_no)
        from public.sale_items si
       where si.sale_id = v_sale_id
    ),
    'journal_entry', to_jsonb(v_journal_entry),
    'journal_lines', (
      select jsonb_agg(to_jsonb(jl) order by jl.line_no)
        from public.journal_lines jl
       where jl.journal_entry_id = v_journal_id
    ),
    'payment', case when v_payment_id is not null then to_jsonb(v_payment) else null end
  );
end $$;

-- ---------------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------------
revoke all on function public.post_sale(
  uuid, uuid, text, text, date, numeric, numeric, numeric, numeric, numeric, text, numeric, text, jsonb, integer
) from public, anon, authenticated;

grant execute on function public.post_sale(
  uuid, uuid, text, text, date, numeric, numeric, numeric, numeric, numeric, text, numeric, text, jsonb, integer
) to authenticated;

-- ---------------------------------------------------------------------------
-- post_purchase (006, plus p_payment_terms_days)
-- ---------------------------------------------------------------------------
create or replace function public.post_purchase(
  p_business_id       uuid,
  p_supplier_id       uuid,
  p_supplier_name     text    default null,
  p_reference_number  text    default '',
  p_date              date    default null,
  p_subtotal          numeric default null,
  p_discount_total    numeric default 0,
  p_tax_amount        numeric default 0,
  p_total_amount      numeric default null,
  p_upfront_paid      numeric default 0,
  p_payment_method    text    default 'CASH',
  p_notes             text    default null,
  p_items             jsonb   default '[]'::jsonb,
  p_idempotency_key   text    default null,
  p_price_includes_vat boolean default null,
  p_payment_terms_days integer default 0
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid                 uuid := (select auth.uid());
  v_business            public.businesses%rowtype;
  v_supplier            public.suppliers%rowtype;
  v_supplier_id         uuid;
  v_supplier_name       text;
  v_reference           text;
  v_sequence            bigint;
  v_settle_code         text;
  v_target_code         text;
  v_acc_settle          public.accounts%rowtype;
  v_acc_target          public.accounts%rowtype;
  v_acc_vat_rec         public.accounts%rowtype;
  v_acc_payable         public.accounts%rowtype;
  v_net                 numeric(14,2);
  v_settled_now         numeric(14,2);
  v_on_credit           numeric(14,2);
  v_journal_id          uuid;
  v_purchase_id         uuid;
  v_payment_id          uuid;
  v_line_idx            smallint := 1;
  v_item                jsonb;
  v_line_no             smallint;
  v_qty                 numeric;
  v_unit_price          numeric;
  v_disc                numeric;
  v_line_total          numeric;
  v_expected_line_total numeric(14,2);
  v_calc_items_total    numeric(14,2) := 0;
  v_calc_discount_total numeric(14,2) := 0;
  v_today_npt           date;
  v_existing            public.purchases%rowtype;
  v_incoming_fp         text;
  v_stored_fp           text;
  v_rate                numeric;
  v_expected_tax        numeric(14,2);
  v_inclusive           boolean;
  v_vat_mode            boolean;
  v_journal_entry       public.journal_entries%rowtype;
  v_purchase            public.purchases%rowtype;
  v_payment             public.payments%rowtype;
  v_check_label         text;
  v_check_value         numeric;
begin
  -- -------------------------------------------------------------------------
  -- 1. Identity & permissions
  -- -------------------------------------------------------------------------
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not public.is_member(p_business_id) then
    raise exception 'Not a member of this business' using errcode = '42501';
  end if;

  if not public.can_write(p_business_id) then
    raise exception 'Insufficient privileges: write access required' using errcode = '42501';
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Business profile
  -- -------------------------------------------------------------------------
  select * into v_business from public.businesses where id = p_business_id;
  if not found then
    raise exception 'Business not found' using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Date (business timezone)
  -- -------------------------------------------------------------------------
  if p_date is null then
    raise exception 'Date is required' using errcode = '22023';
  end if;

  v_today_npt := (now() at time zone coalesce(v_business.timezone, 'Asia/Kathmandu'))::date;
  if p_date > v_today_npt then
    raise exception 'Purchase date % cannot be in the future (today in % is %)',
      p_date, coalesce(v_business.timezone, 'Asia/Kathmandu'), v_today_npt
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Amounts & payment method
  -- -------------------------------------------------------------------------
  if p_subtotal is null or p_subtotal < 0 then
    raise exception 'Subtotal cannot be negative' using errcode = '22023';
  end if;
  if coalesce(p_discount_total, 0) < 0 then
    raise exception 'Discount total cannot be negative' using errcode = '22023';
  end if;
  if coalesce(p_tax_amount, 0) < 0 then
    raise exception 'Tax amount cannot be negative' using errcode = '22023';
  end if;
  if p_total_amount is null or p_total_amount <= 0 then
    raise exception 'Total amount must be greater than zero' using errcode = '22023';
  end if;
  if coalesce(p_upfront_paid, 0) < 0 then
    raise exception 'Upfront paid cannot be negative' using errcode = '22023';
  end if;
  if coalesce(p_upfront_paid, 0) > p_total_amount then
    raise exception 'Upfront paid cannot exceed total amount' using errcode = '22023';
  end if;
  if p_total_amount <> p_subtotal + coalesce(p_tax_amount, 0) then
    raise exception 'Total amount must equal subtotal plus tax amount' using errcode = '22023';
  end if;
  if p_payment_method not in ('CASH', 'BANK', 'ESEWA', 'KHALTI') then
    raise exception 'Invalid payment method: %', p_payment_method using errcode = '22023';
  end if;

  -- Reject values numeric(14,2) cannot represent without silent rounding.
  for v_check_label, v_check_value in
    select t.label, t.val from (values
      ('Subtotal', p_subtotal),
      ('Discount total', coalesce(p_discount_total, 0)),
      ('Tax amount', coalesce(p_tax_amount, 0)),
      ('Total amount', p_total_amount),
      ('Upfront paid', coalesce(p_upfront_paid, 0))
    ) as t(label, val)
  loop
    if v_check_value is not null
       and (v_check_value <> round(v_check_value, 2) or abs(v_check_value) > 999999999999.99) then
      raise exception '% must be a numeric(14,2) amount with at most 2 decimal places', v_check_label
        using errcode = '22023';
    end if;
  end loop;

  -- -------------------------------------------------------------------------
  -- 5. Line items validation & mathematical verification
  -- -------------------------------------------------------------------------
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one line item is required' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_line_no    := (v_item->>'line_no')::smallint;
    v_qty        := (v_item->>'quantity')::numeric;
    v_unit_price := (v_item->>'unit_price')::numeric;
    v_disc       := coalesce((v_item->>'discount')::numeric, 0);
    v_line_total := (v_item->>'total')::numeric;

    if v_line_no is null or v_line_no <= 0 then
      raise exception 'Line number must be positive' using errcode = '22023';
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Quantity must be positive' using errcode = '22023';
    end if;
    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'Unit price cannot be negative' using errcode = '22023';
    end if;
    if v_disc < 0 then
      raise exception 'Discount cannot be negative' using errcode = '22023';
    end if;
    if v_line_total is null or v_line_total < 0 then
      raise exception 'Line total cannot be negative' using errcode = '22023';
    end if;
    if v_disc > round(v_qty * v_unit_price, 2) then
      raise exception 'Discount cannot exceed line gross value on line %', v_line_no using errcode = '22023';
    end if;

    v_expected_line_total := round(v_qty * v_unit_price - v_disc, 2);
    if v_line_total <> v_expected_line_total then
      raise exception 'Line % total (%) does not equal quantity * unit_price - discount (%)',
        v_line_no, v_line_total, v_expected_line_total using errcode = '22023';
    end if;

    if v_qty <> round(v_qty, 2) or v_unit_price <> round(v_unit_price, 2)
       or v_disc <> round(v_disc, 2) or v_line_total <> round(v_line_total, 2)
       or abs(v_qty) > 999999999999.99 or abs(v_unit_price) > 999999999999.99
       or abs(v_disc) > 999999999999.99 or abs(v_line_total) > 999999999999.99 then
      raise exception 'Line % amounts must fit numeric(14,2) with at most 2 decimal places', v_line_no
        using errcode = '22023';
    end if;

    v_calc_items_total    := v_calc_items_total + v_line_total;
    v_calc_discount_total := v_calc_discount_total + v_disc;
  end loop;

  if (select count(distinct (elem->>'line_no')::int) from jsonb_array_elements(p_items) elem)
     <> jsonb_array_length(p_items) then
    raise exception 'Duplicate line numbers are not allowed' using errcode = '22023';
  end if;

  if coalesce(p_discount_total, 0) <> v_calc_discount_total then
    raise exception 'Purchase discount total (%) does not match sum of line discounts (%)',
      coalesce(p_discount_total, 0), v_calc_discount_total using errcode = '22023';
  end if;

  -- Exclusive VAT: subtotal = sum(items); inclusive VAT: total = sum(items).
  if p_subtotal <> v_calc_items_total and p_total_amount <> v_calc_items_total then
    raise exception 'Purchase amounts do not agree with line items: subtotal (%) or total (%) must equal items total (%)',
      p_subtotal, p_total_amount, v_calc_items_total using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 6. VAT policy (not merely arithmetic)
  -- -------------------------------------------------------------------------
  if not v_business.vat_registered and coalesce(p_tax_amount, 0) > 0 then
    raise exception 'This business is not registered for VAT; tax amount must be zero'
      using errcode = '22023';
  end if;

  if coalesce(p_tax_amount, 0) > 0 then
    v_rate := v_business.vat_rate;
    if v_rate <= 0 then
      raise exception 'A VAT rate is required to post a taxed purchase' using errcode = '22023';
    end if;

    -- The purchase form carries an explicit price-includes-VAT flag. When it is
    -- absent, fall back to the domain rule: if the item total equals the gross
    -- total the figure is VAT-inclusive, otherwise it is VAT-exclusive.
    if p_price_includes_vat is null then
      v_inclusive := (p_total_amount = v_calc_items_total);
    else
      v_inclusive := p_price_includes_vat;
    end if;

    if v_inclusive then
      v_expected_tax := round(p_total_amount - round(p_total_amount / (1 + v_rate / 100), 2), 2);
    else
      v_expected_tax := round(p_subtotal * v_rate / 100, 2);
    end if;

    if abs(coalesce(p_tax_amount, 0) - v_expected_tax) > 0.01 then
      raise exception 'Tax amount % does not match the applicable VAT of % at %%%',
        coalesce(p_tax_amount, 0), v_expected_tax, v_rate using errcode = '22023';
    end if;

    -- Persist the MODE that was actually used (inferred when the caller left
    -- it unset) so the idempotency fingerprint always describes the posted
    -- document rather than the caller's omitted argument.
    v_vat_mode := v_inclusive;
  end if;


  -- -------------------------------------------------------------------------
  -- 5b. Payment terms (whole days of credit, agreed when this is posted)
  -- -------------------------------------------------------------------------
  -- The due date itself is NOT a parameter and is never sent by the client: the
  -- table generates it from the document date plus these terms, so the date the
  -- browser showed and the date the books hold come from one rule. 0 means due
  -- immediately, which is what every document posted before this migration
  -- recorded — no historical terms are invented for them.
  if p_payment_terms_days is null or p_payment_terms_days < 0 or p_payment_terms_days > 3650 then
    raise exception 'Payment terms must be between 0 and 3650 days, got %', p_payment_terms_days
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 7. Supplier resolution (before the idempotency fingerprint)
  -- -------------------------------------------------------------------------
  if p_supplier_id is not null then
    select * into v_supplier
      from public.suppliers
     where business_id = p_business_id and id = p_supplier_id;
    if not found then
      raise exception 'Supplier does not belong to this business or does not exist' using errcode = '22023';
    end if;
    v_supplier_id   := v_supplier.id;
    v_supplier_name := coalesce(nullif(btrim(p_supplier_name), ''), v_supplier.name);
  else
    v_supplier_name := btrim(coalesce(p_supplier_name, ''));
    if v_supplier_name = '' then
      raise exception 'Supplier is required' using errcode = '22023';
    end if;

    -- Concurrent same-name creation must reuse the existing supplier rather
    -- than surface a raw unique-violation, matching the customers model.
    begin
      select id into v_supplier_id
        from public.suppliers
       where business_id = p_business_id and lower(name) = lower(v_supplier_name);
      if not found then
        insert into public.suppliers (business_id, name)
        values (p_business_id, v_supplier_name)
        returning id into v_supplier_id;
      end if;
    exception when unique_violation then
      select id into v_supplier_id
        from public.suppliers
       where business_id = p_business_id and lower(name) = lower(v_supplier_name);
      if v_supplier_id is null then raise; end if;
    end;
  end if;

  -- -------------------------------------------------------------------------
  -- 8. Idempotency pre-check
  -- -------------------------------------------------------------------------
  if p_idempotency_key is not null then
    if btrim(p_idempotency_key) = '' then
      raise exception 'Idempotency key cannot be blank' using errcode = '22023';
    end if;
    if length(p_idempotency_key) > 200 then
      raise exception 'Idempotency key is too long (max 200 characters)' using errcode = '22023';
    end if;

    select * into v_existing
      from public.purchases
     where business_id = p_business_id and idempotency_key = p_idempotency_key;
  end if;

  -- -------------------------------------------------------------------------
  -- 9. Creation (serialised per business) — skipped on an idempotent replay
  -- -------------------------------------------------------------------------
  if v_existing.id is null then
    -- One transaction-scoped lock per business serialises concurrent posts so
    -- the journal sequence and any server-side reference cannot collide.
    perform pg_advisory_xact_lock(hashtextextended(p_business_id::text, 0));

    -- Reference: keep the client's number when supplied; otherwise allocate
    -- PO-YYYYMMDD-NNN scoped to this business and date only.
    v_reference := btrim(coalesce(p_reference_number, ''));
    if v_reference = '' then
      declare
        v_prefix text := 'PO-' || to_char(p_date, 'YYYYMMDD') || '-';
        v_next   int;
      begin
        select coalesce(max(substring(reference_number from length(v_prefix) + 1)::int), 0) + 1
          into v_next
          from public.purchases
         where business_id = p_business_id
           and reference_number like v_prefix || '%'
           and substring(reference_number from length(v_prefix) + 1) ~ '^[0-9]+$';
        v_reference := v_prefix || lpad(v_next::text, 3, '0');
      end;
    else
      if exists (
        select 1 from public.purchases
         where business_id = p_business_id and reference_number = v_reference
      ) then
        raise exception 'Purchase reference % already exists in this business', v_reference
          using errcode = '23505';
      end if;
    end if;

    -- Journal sequence is business-wide and independent of the daily PO counter.
    select coalesce(max(sequence), 0) + 1
      into v_sequence
      from public.journal_entries
     where business_id = p_business_id;

    -- Settlement asset account (mirrors AccountLookup.settlement).
    if p_payment_method = 'CASH' then
      v_settle_code := '1010';
    elsif p_payment_method = 'BANK' then
      v_settle_code := '1020';
    elsif p_payment_method = 'ESEWA' then
      v_settle_code := case when exists (
        select 1 from public.accounts where business_id = p_business_id and code = '1040' and is_active
      ) then '1040' else '1020' end;
    elsif p_payment_method = 'KHALTI' then
      v_settle_code := case when exists (
        select 1 from public.accounts where business_id = p_business_id and code = '1050' and is_active
      ) then '1050' else '1020' end;
    end if;

    select * into v_acc_settle
      from public.accounts
     where business_id = p_business_id and code = v_settle_code;
    if not found then
      raise exception 'Settlement account % is missing from chart of accounts', v_settle_code
        using errcode = '22023';
    end if;

    -- Inventory authority: ONLY businesses.track_inventory decides this.
    v_target_code := case when v_business.track_inventory then '1060' else '5010' end;
    select * into v_acc_target
      from public.accounts
     where business_id = p_business_id and code = v_target_code;
    if not found then
      raise exception 'Account % is missing from chart of accounts', v_target_code using errcode = '22023';
    end if;

    if coalesce(p_tax_amount, 0) > 0 then
      select * into v_acc_vat_rec
        from public.accounts
       where business_id = p_business_id and code = '1070';
      if not found then
        raise exception 'VAT receivable (1070) is missing from chart of accounts' using errcode = '22023';
      end if;
    end if;

    v_settled_now := round(greatest(0, least(coalesce(p_upfront_paid, 0), p_total_amount)), 2);
    v_on_credit   := round(p_total_amount - v_settled_now, 2);
    v_net         := round(p_total_amount - coalesce(p_tax_amount, 0), 2);

    if v_on_credit > 0 then
      select * into v_acc_payable
        from public.accounts
       where business_id = p_business_id and code = '2010';
      if not found then
        raise exception 'Accounts payable (2010) is missing from chart of accounts' using errcode = '22023';
      end if;
    end if;

    v_journal_id  := gen_random_uuid();
    v_purchase_id := gen_random_uuid();

    -- A unique-violation here can only be the idempotency index losing a race;
    -- the sub-block rolls back cleanly and v_existing yields a replay below.
    begin
      insert into public.journal_entries (
        id, business_id, transaction_date, sequence, description,
        reference, source_type, source_id, created_by
      ) values (
        v_journal_id, p_business_id, p_date, v_sequence,
        'Purchase ' || v_reference || ' — ' || v_supplier_name,
        v_reference, 'PURCHASE', v_purchase_id, v_uid
      ) returning * into v_journal_entry;

      insert into public.journal_lines (
        business_id, journal_entry_id, line_no,
        account_id, account_name, account_type, debit, credit
      ) values (
        p_business_id, v_journal_id, v_line_idx,
        v_acc_target.id, v_acc_target.name, v_acc_target.type, v_net, 0
      );
      v_line_idx := v_line_idx + 1;

      if coalesce(p_tax_amount, 0) > 0 then
        insert into public.journal_lines (
          business_id, journal_entry_id, line_no,
          account_id, account_name, account_type, debit, credit
        ) values (
          p_business_id, v_journal_id, v_line_idx,
          v_acc_vat_rec.id, v_acc_vat_rec.name, v_acc_vat_rec.type, round(p_tax_amount, 2), 0
        );
        v_line_idx := v_line_idx + 1;
      end if;

      if v_settled_now > 0 then
        insert into public.journal_lines (
          business_id, journal_entry_id, line_no,
          account_id, account_name, account_type, debit, credit
        ) values (
          p_business_id, v_journal_id, v_line_idx,
          v_acc_settle.id, v_acc_settle.name, v_acc_settle.type, 0, v_settled_now
        );
        v_line_idx := v_line_idx + 1;
      end if;

      if v_on_credit > 0 then
        insert into public.journal_lines (
          business_id, journal_entry_id, line_no,
          account_id, account_name, account_type, debit, credit
        ) values (
          p_business_id, v_journal_id, v_line_idx,
          v_acc_payable.id, v_acc_payable.name, v_acc_payable.type, 0, v_on_credit
        );
        v_line_idx := v_line_idx + 1;
      end if;

      insert into public.purchases (
        id, business_id, supplier_id, supplier_name, reference_number, date,
        payment_terms_days, due_date,
        subtotal, discount_total, tax_amount, total_amount, upfront_paid,
        payment_method, status, notes, journal_entry_id, created_by,
        idempotency_key, price_includes_vat
      ) values (
        v_purchase_id, p_business_id, v_supplier_id, v_supplier_name, v_reference, p_date,
        (p_payment_terms_days)::smallint,
        p_date + p_payment_terms_days,
        p_subtotal, coalesce(p_discount_total, 0), coalesce(p_tax_amount, 0), p_total_amount,
        coalesce(p_upfront_paid, 0), p_payment_method, 'POSTED', p_notes, v_journal_id, v_uid,
        p_idempotency_key, v_vat_mode
      ) returning * into v_purchase;

      for v_item in select * from jsonb_array_elements(p_items) loop
        insert into public.purchase_items (
          business_id, purchase_id, line_no, description, quantity, unit_price, discount, total
        ) values (
          p_business_id,
          v_purchase_id,
          (v_item->>'line_no')::smallint,
          coalesce(v_item->>'description', ''),
          (v_item->>'quantity')::numeric,
          (v_item->>'unit_price')::numeric,
          coalesce((v_item->>'discount')::numeric, 0),
          (v_item->>'total')::numeric
        );
      end loop;

      if coalesce(p_upfront_paid, 0) > 0 then
        v_payment_id := gen_random_uuid();
        insert into public.payments (
          id, business_id, reference, date, amount, payment_method, status,
          payment_type, linked_purchase_id, party_name, doc_status, notes,
          journal_entry_id, created_by
        ) values (
          v_payment_id,
          p_business_id,
          'PAY-' || v_reference,
          p_date,
          round(p_upfront_paid, 2),
          p_payment_method,
          'COMPLETED',
          'OUTGOING',
          v_purchase_id,
          v_supplier_name,
          'POSTED',
          coalesce(p_notes, 'Upfront payment for ' || v_reference),
          v_journal_id,
          v_uid
        ) returning * into v_payment;
      end if;
    exception when unique_violation then
      if p_idempotency_key is not null then
        select * into v_existing
          from public.purchases
         where business_id = p_business_id and idempotency_key = p_idempotency_key;
      end if;
      if v_existing.id is null then
        raise;
      end if;
    end;
  end if;

  -- -------------------------------------------------------------------------
  -- 10. Idempotent replay: same key must be the same normalised request
  -- -------------------------------------------------------------------------
  if v_existing.id is not null then
    v_incoming_fp := md5(concat_ws('|',
      coalesce(v_supplier_id::text, ''),
      lower(btrim(v_supplier_name)),
      p_date::text,
      p_payment_terms_days::text,
      round(p_subtotal, 2)::text,
      round(coalesce(p_discount_total, 0), 2)::text,
      round(coalesce(p_tax_amount, 0), 2)::text,
      round(p_total_amount, 2)::text,
      round(coalesce(p_upfront_paid, 0), 2)::text,
      p_payment_method,
      btrim(coalesce(p_notes, '')),
      coalesce(v_vat_mode, false)::text,
      (select string_agg(
                (elem->>'line_no') || ':' || btrim(coalesce(elem->>'description', '')) || ':' ||
                round((elem->>'quantity')::numeric, 2)::text || ':' ||
                round((elem->>'unit_price')::numeric, 2)::text || ':' ||
                round(coalesce((elem->>'discount')::numeric, 0), 2)::text || ':' ||
                round((elem->>'total')::numeric, 2)::text,
                ',' order by (elem->>'line_no')::int)
         from jsonb_array_elements(p_items) elem)
    ));

    v_stored_fp := md5(concat_ws('|',
      coalesce(v_existing.supplier_id::text, ''),
      lower(btrim(v_existing.supplier_name)),
      v_existing.date::text,
      v_existing.payment_terms_days::text,
      round(v_existing.subtotal, 2)::text,
      round(v_existing.discount_total, 2)::text,
      round(v_existing.tax_amount, 2)::text,
      round(v_existing.total_amount, 2)::text,
      round(v_existing.upfront_paid, 2)::text,
      v_existing.payment_method,
      btrim(coalesce(v_existing.notes, '')),
      coalesce(v_existing.price_includes_vat, false)::text,
      (select string_agg(
                si.line_no::text || ':' || btrim(si.description) || ':' ||
                round(si.quantity, 2)::text || ':' ||
                round(si.unit_price, 2)::text || ':' ||
                round(si.discount, 2)::text || ':' ||
                round(si.total, 2)::text,
                ',' order by si.line_no)
         from public.purchase_items si
        where si.purchase_id = v_existing.id)
    ));

    if v_incoming_fp is distinct from v_stored_fp then
      raise exception 'Idempotency key was already used with a different purchase request'
        using errcode = '23505';
    end if;

    return jsonb_build_object(
      'purchase', to_jsonb(v_existing),
      'items', (
        select jsonb_agg(to_jsonb(si) order by si.line_no)
          from public.purchase_items si
         where si.purchase_id = v_existing.id
      ),
      'journal_entry', (
        select to_jsonb(je) from public.journal_entries je where je.id = v_existing.journal_entry_id
      ),
      'journal_lines', (
        select jsonb_agg(to_jsonb(jl) order by jl.line_no)
          from public.journal_lines jl
         where jl.journal_entry_id = v_existing.journal_entry_id
      ),
      'payment', (
        select to_jsonb(p)
          from public.payments p
         where p.linked_purchase_id = v_existing.id and p.payment_type = 'OUTGOING'
         order by p.created_at
         limit 1
      )
    );
  end if;

  -- -------------------------------------------------------------------------
  -- 11. Fresh result
  -- -------------------------------------------------------------------------
  return jsonb_build_object(
    'purchase', to_jsonb(v_purchase),
    'items', (
      select jsonb_agg(to_jsonb(si) order by si.line_no)
        from public.purchase_items si
       where si.purchase_id = v_purchase_id
    ),
    'journal_entry', to_jsonb(v_journal_entry),
    'journal_lines', (
      select jsonb_agg(to_jsonb(jl) order by jl.line_no)
        from public.journal_lines jl
       where jl.journal_entry_id = v_journal_id
    ),
    'payment', case when v_payment_id is not null then to_jsonb(v_payment) else null end
  );
end $$;

-- ---------------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------------
revoke all on function public.post_purchase(
  uuid, uuid, text, text, date, numeric, numeric, numeric, numeric, numeric, text, text, jsonb, text, boolean, integer
) from public, anon, authenticated;

grant execute on function public.post_purchase(
  uuid, uuid, text, text, date, numeric, numeric, numeric, numeric, numeric, text, text, jsonb, text, boolean, integer
) to authenticated;

-- Safety net: function privileges (restated after 015 replaced the posting RPCs)
-- ---------------------------------------------------------------------------
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
         and p.proname not in ('is_member', 'can_write', 'is_owner', 'create_business', 'post_sale', 'post_purchase', 'post_expense', 'void_document', 'post_payment', 'void_payment', 'initiate_gateway_txn', 'settle_gateway_txn', 'control_account_integrity')
       )
     );
  if v_bad is not null then
    raise exception 'Unexpected EXECUTE privilege on: %', v_bad;
  end if;
end $$;

