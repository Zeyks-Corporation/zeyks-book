-- 005_post_sale.sql
-- Atomic sales posting RPC: creates the journal entry, balanced lines,
-- sales row, sale items, and upfront payment settlement (if any).
--
-- Rules every RPC in this project follows
--   * SECURITY DEFINER with search_path = '' and fully qualified names
--   * identity comes from auth.uid(); no user id or role is ever a parameter
--   * EXECUTE revoked from public, anon, then granted only to authenticated
--   * callers must be OWNER or ACCOUNTANT of the target business

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
  p_items           jsonb    default '[]'::jsonb
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
    id, business_id, customer_id, customer_name, invoice_number, date,
    subtotal, discount_total, tax_amount, total_amount, upfront_paid,
    payment_method, cost_of_goods, status, notes, journal_entry_id,
    created_by
  ) values (
    v_sale_id, p_business_id, v_customer_id, v_customer_name, v_invoice_number, p_date,
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
  uuid, uuid, text, text, date, numeric, numeric, numeric, numeric, numeric, text, numeric, text, jsonb
) from public, anon, authenticated;

grant execute on function public.post_sale(
  uuid, uuid, text, text, date, numeric, numeric, numeric, numeric, numeric, text, numeric, text, jsonb
) to authenticated;

-- ---------------------------------------------------------------------------
-- Safety net: function privileges
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
         and p.proname not in ('is_member', 'can_write', 'is_owner', 'create_business', 'post_sale')
       )
     );
  if v_bad is not null then
    raise exception 'Unexpected EXECUTE privilege on: %', v_bad;
  end if;
end $$;
