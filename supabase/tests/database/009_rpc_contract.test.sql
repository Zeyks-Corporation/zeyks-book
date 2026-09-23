-- 009_rpc_contract.test.sql
-- Contract test for the public RPC surface.
--
-- Pins, for every cloud write path, the function NAME, the argument names in
-- order, the argument types, the return type, SECURITY DEFINER + empty
-- search_path, and the EXECUTE grants. It fails if a later migration renames or
-- reorders an argument, changes a type, silently adds an overload, drops the
-- security definer, or loosens a grant.
--
-- Nothing here modifies an RPC: if this test fails, the migration is wrong.

begin;
create extension if not exists pgtap with schema extensions;

select plan(88);

-- Resolve a public function by name. A missing or duplicated name makes the
-- per-function assertions fail rather than abort the file.
create function pg_temp.fn(p_name text) returns oid
language sql security definer set search_path = '' as $$
  select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = p_name
   order by p.oid
   limit 1;
$$;

create function pg_temp.fn_count(p_name text) returns int
language sql security definer set search_path = '' as $$
  select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = p_name;
$$;

/* -------------------------------------------------------------------------- */
/* create_business                                                            */
/* -------------------------------------------------------------------------- */
select is(pg_temp.fn_count('create_business'), 1, 'exactly one create_business exists (no overloads)');
select is(
  coalesce(pg_get_function_identity_arguments(pg_temp.fn('create_business')), '<missing>'),
  $s$p_business_name text, p_owner_name text, p_email text, p_phone text, p_pan_number text, p_address text, p_city text, p_currency_symbol text, p_fiscal_year_start_month smallint, p_vat_registered boolean, p_vat_rate numeric, p_track_inventory boolean$s$,
  'create_business keeps its argument types in order'
);
select is(
  coalesce(pg_get_function_arguments(pg_temp.fn('create_business')), '<missing>'),
  $s$p_business_name text, p_owner_name text DEFAULT ''::text, p_email text DEFAULT ''::text, p_phone text DEFAULT ''::text, p_pan_number text DEFAULT ''::text, p_address text DEFAULT ''::text, p_city text DEFAULT ''::text, p_currency_symbol text DEFAULT 'NPR'::text, p_fiscal_year_start_month smallint DEFAULT 4, p_vat_registered boolean DEFAULT false, p_vat_rate numeric DEFAULT 13, p_track_inventory boolean DEFAULT false$s$,
  'create_business keeps its argument names and defaults'
);
select is(
  (select p.prorettype::regtype::text from pg_proc p where p.oid = pg_temp.fn('create_business')),
  'businesses',
  'create_business returns the created business row'
);
select is(
  (select p.prosecdef from pg_proc p where p.oid = pg_temp.fn('create_business')),
  true,
  'create_business is SECURITY DEFINER'
);
select is(
  (select coalesce(array_to_string(p.proconfig, ';'), '') from pg_proc p where p.oid = pg_temp.fn('create_business')),
  $s$search_path=""$s$,
  'create_business pins an empty search_path'
);
select is(has_function_privilege('anon', pg_temp.fn('create_business'), 'EXECUTE'), false, 'anon cannot execute create_business');
select is(has_function_privilege('authenticated', pg_temp.fn('create_business'), 'EXECUTE'), true, 'authenticated can execute create_business');

/* -------------------------------------------------------------------------- */
/* post_sale                                                                  */
/* -------------------------------------------------------------------------- */
select is(pg_temp.fn_count('post_sale'), 1, 'exactly one post_sale exists (no overloads)');
select is(
  coalesce(pg_get_function_identity_arguments(pg_temp.fn('post_sale')), '<missing>'),
  $s$p_business_id uuid, p_customer_id uuid, p_customer_name text, p_invoice_number text, p_date date, p_subtotal numeric, p_discount_total numeric, p_tax_amount numeric, p_total_amount numeric, p_upfront_paid numeric, p_payment_method text, p_cost_of_goods numeric, p_notes text, p_items jsonb, p_payment_terms_days integer$s$,
  'post_sale keeps its argument types in order'
);
select is(
  coalesce(pg_get_function_arguments(pg_temp.fn('post_sale')), '<missing>'),
  $s$p_business_id uuid, p_customer_id uuid, p_customer_name text DEFAULT NULL::text, p_invoice_number text DEFAULT ''::text, p_date date DEFAULT NULL::date, p_subtotal numeric DEFAULT NULL::numeric, p_discount_total numeric DEFAULT 0, p_tax_amount numeric DEFAULT 0, p_total_amount numeric DEFAULT NULL::numeric, p_upfront_paid numeric DEFAULT 0, p_payment_method text DEFAULT 'CASH'::text, p_cost_of_goods numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text, p_items jsonb DEFAULT '[]'::jsonb, p_payment_terms_days integer DEFAULT 0$s$,
  'post_sale keeps its argument names and defaults'
);
select is(
  (select p.prorettype::regtype::text from pg_proc p where p.oid = pg_temp.fn('post_sale')),
  'jsonb',
  'post_sale returns jsonb'
);
select is(
  (select p.prosecdef from pg_proc p where p.oid = pg_temp.fn('post_sale')),
  true,
  'post_sale is SECURITY DEFINER'
);
select is(
  (select coalesce(array_to_string(p.proconfig, ';'), '') from pg_proc p where p.oid = pg_temp.fn('post_sale')),
  $s$search_path=""$s$,
  'post_sale pins an empty search_path'
);
select is(has_function_privilege('anon', pg_temp.fn('post_sale'), 'EXECUTE'), false, 'anon cannot execute post_sale');
select is(has_function_privilege('authenticated', pg_temp.fn('post_sale'), 'EXECUTE'), true, 'authenticated can execute post_sale');

/* -------------------------------------------------------------------------- */
/* post_purchase                                                              */
/* -------------------------------------------------------------------------- */
select is(pg_temp.fn_count('post_purchase'), 1, 'exactly one post_purchase exists (no overloads)');
select is(
  coalesce(pg_get_function_identity_arguments(pg_temp.fn('post_purchase')), '<missing>'),
  $s$p_business_id uuid, p_supplier_id uuid, p_supplier_name text, p_reference_number text, p_date date, p_subtotal numeric, p_discount_total numeric, p_tax_amount numeric, p_total_amount numeric, p_upfront_paid numeric, p_payment_method text, p_notes text, p_items jsonb, p_idempotency_key text, p_price_includes_vat boolean, p_payment_terms_days integer$s$,
  'post_purchase keeps its argument types in order'
);
select is(
  coalesce(pg_get_function_arguments(pg_temp.fn('post_purchase')), '<missing>'),
  $s$p_business_id uuid, p_supplier_id uuid, p_supplier_name text DEFAULT NULL::text, p_reference_number text DEFAULT ''::text, p_date date DEFAULT NULL::date, p_subtotal numeric DEFAULT NULL::numeric, p_discount_total numeric DEFAULT 0, p_tax_amount numeric DEFAULT 0, p_total_amount numeric DEFAULT NULL::numeric, p_upfront_paid numeric DEFAULT 0, p_payment_method text DEFAULT 'CASH'::text, p_notes text DEFAULT NULL::text, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text, p_price_includes_vat boolean DEFAULT NULL::boolean, p_payment_terms_days integer DEFAULT 0$s$,
  'post_purchase keeps its argument names and defaults'
);
select is(
  (select p.prorettype::regtype::text from pg_proc p where p.oid = pg_temp.fn('post_purchase')),
  'jsonb',
  'post_purchase returns jsonb'
);
select is(
  (select p.prosecdef from pg_proc p where p.oid = pg_temp.fn('post_purchase')),
  true,
  'post_purchase is SECURITY DEFINER'
);
select is(
  (select coalesce(array_to_string(p.proconfig, ';'), '') from pg_proc p where p.oid = pg_temp.fn('post_purchase')),
  $s$search_path=""$s$,
  'post_purchase pins an empty search_path'
);
select is(has_function_privilege('anon', pg_temp.fn('post_purchase'), 'EXECUTE'), false, 'anon cannot execute post_purchase');
select is(has_function_privilege('authenticated', pg_temp.fn('post_purchase'), 'EXECUTE'), true, 'authenticated can execute post_purchase');

/* -------------------------------------------------------------------------- */
/* post_expense                                                               */
/* -------------------------------------------------------------------------- */
select is(pg_temp.fn_count('post_expense'), 1, 'exactly one post_expense exists (no overloads)');
select is(
  coalesce(pg_get_function_identity_arguments(pg_temp.fn('post_expense')), '<missing>'),
  $s$p_business_id uuid, p_account_id uuid, p_reference text, p_date date, p_amount numeric, p_tax_amount numeric, p_total_amount numeric, p_payment_method text, p_description text, p_notes text, p_idempotency_key text, p_price_includes_vat boolean$s$,
  'post_expense keeps its argument types in order'
);
select is(
  coalesce(pg_get_function_arguments(pg_temp.fn('post_expense')), '<missing>'),
  $s$p_business_id uuid, p_account_id uuid, p_reference text DEFAULT ''::text, p_date date DEFAULT NULL::date, p_amount numeric DEFAULT NULL::numeric, p_tax_amount numeric DEFAULT 0, p_total_amount numeric DEFAULT NULL::numeric, p_payment_method text DEFAULT 'CASH'::text, p_description text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_price_includes_vat boolean DEFAULT NULL::boolean$s$,
  'post_expense keeps its argument names and defaults'
);
select is(
  (select p.prorettype::regtype::text from pg_proc p where p.oid = pg_temp.fn('post_expense')),
  'jsonb',
  'post_expense returns jsonb'
);
select is(
  (select p.prosecdef from pg_proc p where p.oid = pg_temp.fn('post_expense')),
  true,
  'post_expense is SECURITY DEFINER'
);
select is(
  (select coalesce(array_to_string(p.proconfig, ';'), '') from pg_proc p where p.oid = pg_temp.fn('post_expense')),
  $s$search_path=""$s$,
  'post_expense pins an empty search_path'
);
select is(has_function_privilege('anon', pg_temp.fn('post_expense'), 'EXECUTE'), false, 'anon cannot execute post_expense');
select is(has_function_privilege('authenticated', pg_temp.fn('post_expense'), 'EXECUTE'), true, 'authenticated can execute post_expense');

/* -------------------------------------------------------------------------- */
/* void_document                                                              */
/* -------------------------------------------------------------------------- */
select is(pg_temp.fn_count('void_document'), 1, 'exactly one void_document exists (no overloads)');
select is(
  coalesce(pg_get_function_identity_arguments(pg_temp.fn('void_document')), '<missing>'),
  $s$p_business_id uuid, p_document_type text, p_document_id uuid$s$,
  'void_document takes only business, type and id — no journal id, lines, amounts or identity'
);
select is(
  coalesce(pg_get_function_arguments(pg_temp.fn('void_document')), '<missing>'),
  $s$p_business_id uuid, p_document_type text, p_document_id uuid$s$,
  'void_document keeps its argument names in order'
);
select is(
  (select p.prorettype::regtype::text from pg_proc p where p.oid = pg_temp.fn('void_document')),
  'jsonb',
  'void_document returns jsonb'
);
select is(
  (select p.prosecdef from pg_proc p where p.oid = pg_temp.fn('void_document')),
  true,
  'void_document is SECURITY DEFINER'
);
select is(
  (select coalesce(array_to_string(p.proconfig, ';'), '') from pg_proc p where p.oid = pg_temp.fn('void_document')),
  $s$search_path=""$s$,
  'void_document pins an empty search_path'
);
select is(has_function_privilege('anon', pg_temp.fn('void_document'), 'EXECUTE'), false, 'anon cannot execute void_document');
select is(has_function_privilege('authenticated', pg_temp.fn('void_document'), 'EXECUTE'), true, 'authenticated can execute void_document');

/* -------------------------------------------------------------------------- */
/* post_payment                                                              */
/* -------------------------------------------------------------------------- */
select is(pg_temp.fn_count('post_payment'), 1, 'exactly one post_payment exists (no overloads)');
select is(
  coalesce(pg_get_function_identity_arguments(pg_temp.fn('post_payment')), '<missing>'),
  $s$p_business_id uuid, p_document_type text, p_document_id uuid, p_amount numeric, p_payment_method text, p_date date, p_reference text, p_notes text, p_idempotency_key text$s$,
  'post_payment takes a document and an amount — no payment type, party snapshot, status, journal id or sequence'
);
select is(
  coalesce(pg_get_function_arguments(pg_temp.fn('post_payment')), '<missing>'),
  $s$p_business_id uuid, p_document_type text, p_document_id uuid, p_amount numeric, p_payment_method text DEFAULT 'CASH'::text, p_date date DEFAULT NULL::date, p_reference text DEFAULT ''::text, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text$s$,
  'post_payment keeps its argument names, order and defaults'
);
select is(
  (select p.prorettype::regtype::text from pg_proc p where p.oid = pg_temp.fn('post_payment')),
  'jsonb',
  'post_payment returns jsonb'
);
select is(
  (select p.prosecdef from pg_proc p where p.oid = pg_temp.fn('post_payment')),
  true,
  'post_payment is SECURITY DEFINER'
);
select is(
  (select coalesce(array_to_string(p.proconfig, ';'), '') from pg_proc p where p.oid = pg_temp.fn('post_payment')),
  $s$search_path=""$s$,
  'post_payment pins an empty search_path'
);
select is(has_function_privilege('anon', pg_temp.fn('post_payment'), 'EXECUTE'), false, 'anon cannot execute post_payment');
select is(has_function_privilege('authenticated', pg_temp.fn('post_payment'), 'EXECUTE'), true, 'authenticated can execute post_payment');

/* -------------------------------------------------------------------------- */
/* void_payment                                                               */
/* -------------------------------------------------------------------------- */
select is(pg_temp.fn_count('void_payment'), 1, 'exactly one void_payment exists (no overloads)');
select is(
  coalesce(pg_get_function_identity_arguments(pg_temp.fn('void_payment')), '<missing>'),
  $s$p_business_id uuid, p_payment_id uuid$s$,
  'void_payment takes a business and a settlement id — no journal id, status, reversal lines or reason'
);
select is(
  coalesce(pg_get_function_arguments(pg_temp.fn('void_payment')), '<missing>'),
  $s$p_business_id uuid, p_payment_id uuid$s$,
  'void_payment keeps its argument names and order'
);
select is(
  (select p.prorettype::regtype::text from pg_proc p where p.oid = pg_temp.fn('void_payment')),
  'jsonb',
  'void_payment returns jsonb'
);
select is(
  (select p.prosecdef from pg_proc p where p.oid = pg_temp.fn('void_payment')),
  true,
  'void_payment is SECURITY DEFINER'
);
select is(
  (select coalesce(array_to_string(p.proconfig, ';'), '') from pg_proc p where p.oid = pg_temp.fn('void_payment')),
  $s$search_path=""$s$,
  'void_payment pins an empty search_path'
);
select is(has_function_privilege('anon', pg_temp.fn('void_payment'), 'EXECUTE'), false, 'anon cannot execute void_payment');
select is(has_function_privilege('authenticated', pg_temp.fn('void_payment'), 'EXECUTE'), true, 'authenticated can execute void_payment');

/* -------------------------------------------------------------------------- */
/* initiate_gateway_txn                                                       */
/* -------------------------------------------------------------------------- */
select is(pg_temp.fn_count('initiate_gateway_txn'), 1, 'exactly one initiate_gateway_txn exists (no overloads)');
select is(
  coalesce(pg_get_function_identity_arguments(pg_temp.fn('initiate_gateway_txn')), '<missing>'),
  $s$p_business_id uuid, p_provider text, p_gateway_ref text, p_amount numeric, p_linked_sale_id uuid, p_customer_name text, p_currency text$s$,
  'initiate_gateway_txn takes a provider, a reference, an amount and an invoice — no status, identity or currency guess'
);
select is(
  coalesce(pg_get_function_arguments(pg_temp.fn('initiate_gateway_txn')), '<missing>'),
  $s$p_business_id uuid, p_provider text, p_gateway_ref text, p_amount numeric, p_linked_sale_id uuid, p_customer_name text DEFAULT ''::text, p_currency text DEFAULT 'NPR'::text$s$,
  'initiate_gateway_txn keeps its argument names, order and defaults'
);
select is(
  (select p.prorettype::regtype::text from pg_proc p where p.oid = pg_temp.fn('initiate_gateway_txn')),
  'jsonb',
  'initiate_gateway_txn returns jsonb'
);
select is(
  (select p.prosecdef from pg_proc p where p.oid = pg_temp.fn('initiate_gateway_txn')),
  true,
  'initiate_gateway_txn is SECURITY DEFINER'
);
select is(
  (select coalesce(array_to_string(p.proconfig, ';'), '') from pg_proc p where p.oid = pg_temp.fn('initiate_gateway_txn')),
  $s$search_path=""$s$,
  'initiate_gateway_txn pins an empty search_path'
);
select is(has_function_privilege('anon', pg_temp.fn('initiate_gateway_txn'), 'EXECUTE'), false, 'anon cannot execute initiate_gateway_txn');
select is(has_function_privilege('authenticated', pg_temp.fn('initiate_gateway_txn'), 'EXECUTE'), true, 'authenticated can execute initiate_gateway_txn');

/* -------------------------------------------------------------------------- */
/* settle_gateway_txn                                                        */
/* -------------------------------------------------------------------------- */
select is(pg_temp.fn_count('settle_gateway_txn'), 1, 'exactly one settle_gateway_txn exists (no overloads)');
select is(
  coalesce(pg_get_function_identity_arguments(pg_temp.fn('settle_gateway_txn')), '<missing>'),
  $s$p_business_id uuid, p_gateway_txn_id uuid, p_verification jsonb, p_date date, p_notes text$s$,
  'settle_gateway_txn takes the collection and the gateway''s answer — no amount, document, payment, status or journal'
);
select is(
  coalesce(pg_get_function_arguments(pg_temp.fn('settle_gateway_txn')), '<missing>'),
  $s$p_business_id uuid, p_gateway_txn_id uuid, p_verification jsonb, p_date date DEFAULT NULL::date, p_notes text DEFAULT NULL::text$s$,
  'settle_gateway_txn keeps its argument names, order and defaults'
);
select is(
  (select p.prorettype::regtype::text from pg_proc p where p.oid = pg_temp.fn('settle_gateway_txn')),
  'jsonb',
  'settle_gateway_txn returns jsonb'
);
select is(
  (select p.prosecdef from pg_proc p where p.oid = pg_temp.fn('settle_gateway_txn')),
  true,
  'settle_gateway_txn is SECURITY DEFINER'
);
select is(
  (select coalesce(array_to_string(p.proconfig, ';'), '') from pg_proc p where p.oid = pg_temp.fn('settle_gateway_txn')),
  $s$search_path=""$s$,
  'settle_gateway_txn pins an empty search_path'
);
select is(has_function_privilege('anon', pg_temp.fn('settle_gateway_txn'), 'EXECUTE'), false, 'anon cannot execute settle_gateway_txn');
select is(has_function_privilege('authenticated', pg_temp.fn('settle_gateway_txn'), 'EXECUTE'), true, 'authenticated can execute settle_gateway_txn');

/* -------------------------------------------------------------------------- */
/* The internal settlement core is not a client entry point                   */
/* -------------------------------------------------------------------------- */
select is(pg_temp.fn_count('post_settlement_core'), 1, 'exactly one post_settlement_core exists');
select is(has_function_privilege('authenticated', pg_temp.fn('post_settlement_core'), 'EXECUTE'), false,
          'authenticated cannot execute post_settlement_core directly');

/* -------------------------------------------------------------------------- */
/* Stage 9 rule: one settlement entry point serves BOTH directions            */
/* -------------------------------------------------------------------------- */
-- A supplier payment IS post_payment with document_type PURCHASE (proved by
-- 016_purchase_payment.test.sql). A purchase-specific entry point would be a
-- second accounting implementation, so its absence is part of the contract.
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like '%purchase%payment%'
        or p.proname like '%payment%purchase%'
        or p.proname like '%pay_purchase%'
        or p.proname like '%supplier_payment%'
        or p.proname like '%purchase%settle%'
        or p.proname like '%settle%purchase%')),
  0,
  'no purchase-specific settlement RPC exists: post_payment settles both directions'
);
select is(
  (select (p.prosrc like '%''PURCHASE''%' and p.prosrc like '%''SALE''%')::int
     from pg_proc p where p.oid = pg_temp.fn('post_payment')),
  1,
  'post_payment itself names both SALE and PURCHASE — one implementation, two directions'
);
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '%void%payment%'),
  1,
  'void_payment remains the only way a settlement is reversed, in either direction'
);

/* -------------------------------------------------------------------------- */
/* Stage 10 rule: a receipt IS post_payment with document_type SALE            */
/* -------------------------------------------------------------------------- */
-- The invoice "Receive payment" action added no server surface of its own: the
-- money-in lifecycle in 018_invoice_receipt.test.sql runs entirely through this
-- one RPC. A receipt-specific function would be a second accounting
-- implementation, so its absence is a contract, not an accident.
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname ~ '(receipt|receive|money_in|incoming)'
           or p.proname in ('post_receipt', 'record_receipt', 'settle_invoice'))),
  0,
  'no receipt-specific RPC exists: an invoice receipt uses post_payment itself'
);
select is(
  (select pg_get_function_arguments(p.oid)
     from pg_proc p where p.oid = pg_temp.fn('post_payment')),
  'p_business_id uuid, p_document_type text, p_document_id uuid, p_amount numeric, '
  || 'p_payment_method text DEFAULT ''CASH''::text, p_date date DEFAULT NULL::date, '
  || 'p_reference text DEFAULT ''''::text, p_notes text DEFAULT NULL::text, '
  || 'p_idempotency_key text DEFAULT NULL::text',
  'post_payment keeps one signature: nothing direction- or receipt-specific was appended'
);

/* -------------------------------------------------------------------------- */
/* control_account_integrity (Stage 16)                                       */
/* -------------------------------------------------------------------------- */
-- The AR/AP reconciliation moved out of the browser and into SQL. It is the
-- opposite kind of function to the write RPCs above: no argument to forge, no
-- SECURITY DEFINER, no volatility — a caller-scoped read whose tenant boundary
-- is RLS itself. Pinned here so a later migration cannot quietly turn it into a
-- privileged function or give it a business-id parameter.
select is(pg_temp.fn_count('control_account_integrity'), 1,
  'exactly one control_account_integrity exists (no overloads)');
select is(
  coalesce(pg_get_function_identity_arguments(pg_temp.fn('control_account_integrity')), '<missing>'),
  ''::text,
  'the diagnostic takes no argument, so there is no business id to forge'
);
select is(
  (select p.prosecdef from pg_proc p where p.oid = pg_temp.fn('control_account_integrity')),
  false,
  'control_account_integrity is SECURITY INVOKER, so RLS decides what it sees'
);
select is(
  (select p.provolatile from pg_proc p where p.oid = pg_temp.fn('control_account_integrity')),
  's',
  'control_account_integrity is STABLE: it reads and never writes'
);
select is(
  (select coalesce(array_to_string(p.proconfig, ';'), '') from pg_proc p
    where p.oid = pg_temp.fn('control_account_integrity')),
  $s$search_path=""$s$,
  'control_account_integrity pins an empty search_path'
);
select is(has_function_privilege('anon', pg_temp.fn('control_account_integrity'), 'EXECUTE'), false,
  'anon cannot execute control_account_integrity');
select is(has_function_privilege('authenticated', pg_temp.fn('control_account_integrity'), 'EXECUTE'), true,
  'authenticated can execute control_account_integrity');

/* -------------------------------------------------------------------------- */
/* Whole-surface grants                                                       */
/* -------------------------------------------------------------------------- */
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and has_function_privilege('anon', p.oid, 'EXECUTE')),
  0,
  'anon holds no EXECUTE privilege anywhere in public'
);

select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and p.proname not in ('is_member', 'can_write', 'is_owner', 'create_business', 'post_sale', 'post_purchase', 'post_expense', 'void_document', 'post_payment', 'void_payment', 'initiate_gateway_txn', 'settle_gateway_txn', 'control_account_integrity')),
  0,
  'no unexpected public function is executable by authenticated'
);

select * from finish();
rollback;
