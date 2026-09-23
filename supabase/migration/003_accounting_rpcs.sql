-- 003_accounting_rpcs.sql
-- Foundation RPCs: default chart of accounts and create_business().
--
-- Deliberately NOT here (next stage): post_sale, post_purchase, post_expense,
-- post_payment, void_document, settle_gateway_txn, import_snapshot.
--
-- Rules every RPC in this project follows
--   * SECURITY DEFINER with search_path = '' and fully qualified names
--   * identity comes from auth.uid(); no user id or role is ever a parameter
--   * EXECUTE revoked from public, anon and authenticated, then granted back
--     only to the roles that should call it
--   * additive changes only; a breaking change ships as <name>_v2

-- ============================================================================
-- Default chart of accounts (internal; not callable by clients)
-- ============================================================================
-- 21 accounts: 13 system accounts referenced by posting.ts / accountingEngine.ts
-- through ACCOUNT_CODES, plus 8 ordinary accounts a user may archive or rename.
-- Mirrors src/data/initialData.ts (defaultAccounts); supabase/tests/chart_parity.mjs
-- fails if the two ever drift apart.

create function public.seed_default_chart_of_accounts(p_business_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.accounts (business_id, code, name, type, description, system_account)
  select p_business_id, v.code, v.name, v.type, v.description, v.system_account
    from (values
      -- Assets
      ('1010', 'Cash in hand',                'ASSET',     'Notes and coins on the premises',              true),
      ('1020', 'Bank account',                'ASSET',     'Current or operating bank account',            true),
      ('1030', 'Accounts receivable',         'ASSET',     'Money customers still owe you',                true),
      ('1040', 'eSewa wallet',                'ASSET',     'eSewa settlement balance',                     true),
      ('1050', 'Khalti wallet',               'ASSET',     'Khalti settlement balance',                    true),
      ('1060', 'Inventory',                   'ASSET',     'Stock bought but not yet sold',                true),
      ('1070', 'VAT receivable (input tax)',  'ASSET',     'VAT paid on purchases, reclaimable',           true),
      -- Liabilities
      ('2010', 'Accounts payable',            'LIABILITY', 'Money you owe suppliers',                      true),
      ('2020', 'VAT payable (output tax)',    'LIABILITY', 'VAT collected on sales, owed to the IRD',      true),
      -- Equity
      ('3010', 'Owner''s capital',            'EQUITY',    'Money the owner put into the business',        true),
      ('3020', 'Retained earnings',           'EQUITY',    'Profit carried forward from earlier years',    true),
      -- Revenue
      ('4010', 'Sales revenue',               'REVENUE',   'Income from goods and services, net of VAT',   true),
      ('4020', 'Other income',                'REVENUE',   'Interest, rebates and one-off receipts',       false),
      -- Cost of sales
      ('5010', 'Cost of goods sold',          'EXPENSE',   'What the goods you sold cost you',             true),
      -- Operating expenses
      ('5020', 'Office and general',          'EXPENSE',   'Stationery, tea, printing, sundries',          false),
      ('5030', 'Utilities and internet',      'EXPENSE',   'Electricity, water, broadband',                false),
      ('5040', 'Rent',                        'EXPENSE',   'Shop, office or warehouse rent',               false),
      ('5050', 'Transport and freight',       'EXPENSE',   'Delivery, courier and vehicle costs',          false),
      ('5060', 'Salaries and wages',          'EXPENSE',   'Staff pay and allowances',                     false),
      ('5070', 'Bank and gateway charges',    'EXPENSE',   'Bank fees, eSewa and Khalti commission',       false),
      ('5080', 'Other expenses',              'EXPENSE',   'Anything that does not fit elsewhere',         false)
    ) as v (code, name, type, description, system_account);

  get diagnostics v_count = row_count;
  if v_count <> 21 then
    raise exception 'Default chart of accounts must contain 21 accounts, inserted %', v_count;
  end if;
  return v_count;
end $$;

revoke all on function public.seed_default_chart_of_accounts(uuid) from public, anon, authenticated;

-- ============================================================================
-- create_business
-- ============================================================================
-- One transaction (a function body is atomic): business row, OWNER membership
-- for the caller, default chart of accounts. Returns the created business.
-- Creates no customers, suppliers, documents, payments or journal entries.

create function public.create_business(
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
    raise exception 'No profile exists for the current user' using errcode = '23503';
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

revoke all on function public.create_business(
  text, text, text, text, text, text, text, text, smallint, boolean, numeric, boolean
) from public, anon, authenticated;

grant execute on function public.create_business(
  text, text, text, text, text, text, text, text, smallint, boolean, numeric, boolean
) to authenticated;

-- ============================================================================
-- Safety net: function privileges
-- ============================================================================
-- Fail the migration if any function in public (other than extension members)
-- can be executed by anon or PUBLIC, or by authenticated outside the allowlist.

do $$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and (
       has_function_privilege('anon', p.oid, 'EXECUTE')
       or (
         has_function_privilege('authenticated', p.oid, 'EXECUTE')
         and p.proname not in ('is_member', 'can_write', 'is_owner', 'create_business')
       )
     );
  if v_bad is not null then
    raise exception 'Unexpected EXECUTE privilege on: %', v_bad;
  end if;
end $$;
