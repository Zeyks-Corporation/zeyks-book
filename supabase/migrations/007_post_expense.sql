-- ============================================================================
-- 007_post_expense.sql
-- Atomic expense posting RPC: creates the journal entry, its balanced lines and
-- the expenses row. An expense has no line items and no credit path.
--
-- Rules every RPC in this project follows
--   * SECURITY DEFINER with search_path = '' and fully qualified names
--   * identity comes from auth.uid(); no user id or role is ever a parameter
--   * EXECUTE revoked from public, anon, then granted only to authenticated
--   * callers must be OWNER or ACCOUNTANT of the target business
--   * additive changes only; a breaking change ships as <name>_v2
--
-- Expense accounting is copied from src/services/posting.ts (buildExpenseEntry),
-- the authoritative source:
--
--   Dr <category account>      amount      (net)
--   Dr VAT receivable (1070)   input tax   (only when tax_amount > 0)
--       Cr Cash/Bank/Wallet    total       (settled immediately)
--
-- There is no payable and therefore no settlement row: an expense is paid when
-- it is recorded. reconcile() (posting.ts) counts only `payments` rows linked to
-- a sale or a purchase, so an expense can never be double-counted.
--
-- The category account is an explicit input, but it is validated here: it must
-- belong to the business, be an active EXPENSE account, and must not be 5010
-- (Cost of goods sold), which purchases own. category_name is derived from the
-- account row and is never accepted from the client.
--
-- Idempotency mirrors post_purchase, with two documented differences:
--   * the `reference` is NOT part of the fingerprint. A retry that still sends a
--     blank reference must replay the original document rather than look like a
--     new request; uniqueness stays with expenses (business_id, reference).
--   * a blank or whitespace-only key means "no key", where post_purchase raises.
-- The business advisory lock is taken BEFORE the idempotency lookup, so two
-- concurrent identical requests cannot both reach creation.
--
-- KNOWN LIMITATION (pre-existing, not introduced here): post_sale does not take
-- this lock, so a concurrently posting sale can still collide on the business
-- journal sequence. The unique constraint turns that into an error rather than
-- a duplicate; the bounded retry below lets an expense post survive the race.
-- ============================================================================
-- Schema additions
-- ============================================================================

alter table public.expenses add column idempotency_key text;
-- The MODE that was actually used (inferred when the caller left it unset), so
-- the idempotency fingerprint describes the posted document rather than the
-- caller's omitted argument.
alter table public.expenses add column price_includes_vat boolean;

alter table public.expenses
  add constraint expenses_idempotency_key_len
  check (idempotency_key is null or length(idempotency_key) <= 200);

-- Same business + same key can exist at most once; legacy rows (null) are free.
create unique index expenses_business_idempotency_uidx
  on public.expenses (business_id, idempotency_key)
  where idempotency_key is not null;

-- ============================================================================
-- post_expense
-- ============================================================================

create or replace function public.post_expense(
  p_business_id        uuid,
  p_account_id         uuid,
  p_reference          text    default '',
  p_date               date    default null,
  p_amount             numeric default null,
  p_tax_amount         numeric default 0,
  p_total_amount       numeric default null,
  p_payment_method     text    default 'CASH',
  p_description        text    default null,
  p_notes              text    default null,
  p_idempotency_key    text    default null,
  p_price_includes_vat boolean default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid            uuid := (select auth.uid());
  v_business       public.businesses%rowtype;
  v_account        public.accounts%rowtype;
  v_acc_settle     public.accounts%rowtype;
  v_acc_vat_rec    public.accounts%rowtype;
  v_expense        public.expenses%rowtype;
  v_existing       public.expenses%rowtype;
  v_journal_entry  public.journal_entries%rowtype;
  v_description    text;
  v_notes          text;
  v_method         text;
  v_reference      text;
  v_key            text;
  v_settle_code    text;
  v_amount         numeric(14,2);
  v_tax            numeric(14,2);
  v_total          numeric(14,2);
  v_rate           numeric;
  v_exp_excl       numeric(14,2);
  v_exp_incl       numeric(14,2);
  v_vat_mode       boolean;
  v_today          date;
  v_sequence       bigint;
  v_journal_id     uuid;
  v_expense_id     uuid;
  v_line_idx       smallint := 1;
  v_attempt        int;
  v_check_label    text;
  v_check_value    numeric;
  v_incoming_fp    text;
  v_stored_fp      text;
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
  -- 3. Date (business timezone — never the caller's local date)
  -- -------------------------------------------------------------------------
  if p_date is null then
    raise exception 'Date is required' using errcode = '22023';
  end if;

  v_today := (now() at time zone coalesce(v_business.timezone, 'Asia/Kathmandu'))::date;
  if p_date > v_today then
    raise exception 'Expense date % cannot be in the future (today in % is %)',
      p_date, coalesce(v_business.timezone, 'Asia/Kathmandu'), v_today
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Amounts, method, description
  -- -------------------------------------------------------------------------
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero' using errcode = '22023';
  end if;
  if coalesce(p_tax_amount, 0) < 0 then
    raise exception 'Tax amount cannot be negative' using errcode = '22023';
  end if;
  if p_total_amount is null or p_total_amount <= 0 then
    raise exception 'Total amount must be greater than zero' using errcode = '22023';
  end if;
  if p_total_amount <> round(p_amount + coalesce(p_tax_amount, 0), 2) then
    raise exception 'Total amount must equal amount plus tax amount' using errcode = '22023';
  end if;

  v_method := upper(btrim(coalesce(p_payment_method, '')));
  if v_method not in ('CASH', 'BANK', 'ESEWA', 'KHALTI') then
    raise exception 'Invalid payment method: %', p_payment_method using errcode = '22023';
  end if;

  -- Reject values numeric(14,2) cannot represent without silent rounding.
  for v_check_label, v_check_value in
    select t.label, t.val from (values
      ('Amount', p_amount),
      ('Tax amount', coalesce(p_tax_amount, 0)),
      ('Total amount', p_total_amount)
    ) as t(label, val)
  loop
    if v_check_value is not null
       and (v_check_value <> round(v_check_value, 2) or abs(v_check_value) > 999999999999.99) then
      raise exception '% must be a numeric(14,2) amount with at most 2 decimal places', v_check_label
        using errcode = '22023';
    end if;
  end loop;

  v_amount := round(p_amount, 2);
  v_tax    := round(coalesce(p_tax_amount, 0), 2);
  v_total  := round(p_total_amount, 2);

  v_description := btrim(coalesce(p_description, ''));
  if v_description = '' then
    raise exception 'Description is required' using errcode = '22023';
  end if;
  v_notes := btrim(coalesce(p_notes, ''));

  v_key := nullif(btrim(p_idempotency_key), '');
  if v_key is not null and length(v_key) > 200 then
    raise exception 'Idempotency key is too long (max 200 characters)' using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Category account (resolved before the fingerprint)
  -- -------------------------------------------------------------------------
  select * into v_account
    from public.accounts
   where business_id = p_business_id and id = p_account_id;
  if not found then
    raise exception 'Expense account does not belong to this business or does not exist'
      using errcode = '22023';
  end if;
  if v_account.type <> 'EXPENSE' then
    raise exception 'Expense account must be an EXPENSE account, not %', v_account.type
      using errcode = '22023';
  end if;
  if not v_account.is_active then
    raise exception 'Expense account % is archived', v_account.code using errcode = '22023';
  end if;
  if v_account.code = '5010' then
    raise exception 'Cost of goods sold (5010) is reserved for purchases; choose an operating expense account'
      using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- 6. Serialise per business, then the idempotency lookup
  -- -------------------------------------------------------------------------
  -- One transaction-scoped lock per business serialises concurrent posts so the
  -- journal sequence and any server-side reference cannot collide. It is taken
  -- BEFORE the lookup so two identical concurrent requests cannot both create.
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text, 0));

  if v_key is not null then
    select * into v_existing
      from public.expenses
     where business_id = p_business_id and idempotency_key = v_key;
  end if;

  -- The effective VAT mode, normalised exactly once. Without tax the flag cannot
  -- affect acceptance or the posting, so it collapses to false and cannot cause
  -- a spurious conflict. On a replay the stored mode is authoritative when the
  -- caller omitted the argument; a fresh taxed post infers it in step 7.
  if v_tax = 0 then
    v_vat_mode := false;
  elsif p_price_includes_vat is not null then
    v_vat_mode := p_price_includes_vat;
  elsif v_existing.id is not null then
    v_vat_mode := coalesce(v_existing.price_includes_vat, false);
  else
    v_vat_mode := null;
  end if;

  -- -------------------------------------------------------------------------
  -- 7. Idempotent replay: same key must be the same normalised request
  -- -------------------------------------------------------------------------
  if v_existing.id is not null then
    -- Collision-safe serialisation: jsonb quotes and escapes every value and
    -- emits keys in a stable order, and numerics are pinned to numeric(14,2).
    -- The generated reference and the journal sequence are deliberately absent.
    v_incoming_fp := md5(jsonb_build_object(
      'account_id', v_account.id,
      'date', p_date,
      'amount', v_amount::numeric(14,2)::text,
      'tax_amount', v_tax::numeric(14,2)::text,
      'total_amount', v_total::numeric(14,2)::text,
      'payment_method', v_method,
      'description', v_description,
      'notes', v_notes,
      'vat_mode', coalesce(v_vat_mode, false)
    )::text);

    v_stored_fp := md5(jsonb_build_object(
      'account_id', v_existing.account_id,
      'date', v_existing.date,
      'amount', round(v_existing.amount, 2)::numeric(14,2)::text,
      'tax_amount', round(v_existing.tax_amount, 2)::numeric(14,2)::text,
      'total_amount', round(v_existing.total_amount, 2)::numeric(14,2)::text,
      'payment_method', v_existing.payment_method,
      'description', btrim(v_existing.description),
      'notes', btrim(coalesce(v_existing.notes, '')),
      'vat_mode', coalesce(v_existing.price_includes_vat, false)
    )::text);

    if v_incoming_fp is distinct from v_stored_fp then
      raise exception 'Idempotency key was already used with a different expense request'
        using errcode = '23505';
    end if;

    -- Rebuilt read-only from the persisted rows. No incoming value is reused,
    -- nothing is written and no reference is reallocated.
    return jsonb_build_object(
      'expense', to_jsonb(v_existing),
      'journal_entry', (
        select to_jsonb(je) from public.journal_entries je where je.id = v_existing.journal_entry_id
      ),
      'journal_lines', (
        select jsonb_agg(to_jsonb(jl) order by jl.line_no)
          from public.journal_lines jl
         where jl.journal_entry_id = v_existing.journal_entry_id
      )
    );
  end if;

  -- -------------------------------------------------------------------------
  -- 8. VAT policy (creation only — a replay never re-validates against
  --    settings that may have changed since the document was posted)
  -- -------------------------------------------------------------------------
  if v_tax > 0 then
    if not v_business.vat_registered then
      raise exception 'This business is not registered for VAT; tax amount must be zero'
        using errcode = '22023';
    end if;

    v_rate := v_business.vat_rate;
    if v_rate <= 0 then
      raise exception 'A VAT rate is required to post a taxed expense' using errcode = '22023';
    end if;

    -- For an expense the amounts already carry the split, so the mode is the
    -- only unknown: it is inferred from whichever formula reproduces the tax.
    v_exp_excl := round(v_amount * v_rate / 100, 2);
    v_exp_incl := round(v_total - round(v_total / (1 + v_rate / 100), 2), 2);

    if v_vat_mode is null then
      if abs(v_tax - v_exp_incl) <= 0.01 and abs(v_tax - v_exp_excl) > 0.01 then
        v_vat_mode := true;
      elsif abs(v_tax - v_exp_excl) <= 0.01 then
        v_vat_mode := false;
      else
        raise exception 'Tax amount % does not match the applicable VAT of % at %%%',
          v_tax, v_exp_excl, v_rate using errcode = '22023';
      end if;
    elsif v_vat_mode then
      if abs(v_tax - v_exp_incl) > 0.01 then
        raise exception 'Tax amount % does not match the inclusive VAT of % at %%%',
          v_tax, v_exp_incl, v_rate using errcode = '22023';
      end if;
    else
      if abs(v_tax - v_exp_excl) > 0.01 then
        raise exception 'Tax amount % does not match the VAT of % at %%%',
          v_tax, v_exp_excl, v_rate using errcode = '22023';
      end if;
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 9. Reference: keep the client's number when supplied; otherwise allocate
  --    EXP-YYYYMMDD-NNN scoped to this business and date only.
  -- -------------------------------------------------------------------------
  v_reference := btrim(coalesce(p_reference, ''));
  if v_reference = '' then
    declare
      v_prefix text := 'EXP-' || to_char(p_date, 'YYYYMMDD') || '-';
      v_next   int;
    begin
      select coalesce(max(substring(reference from length(v_prefix) + 1)::int), 0) + 1
        into v_next
        from public.expenses
       where business_id = p_business_id
         and reference like v_prefix || '%'
         and substring(reference from length(v_prefix) + 1) ~ '^[0-9]+$';
      v_reference := v_prefix || lpad(v_next::text, 3, '0');
    end;
  else
    if exists (
      select 1 from public.expenses
       where business_id = p_business_id and reference = v_reference
    ) then
      raise exception 'Expense reference % already exists in this business', v_reference
        using errcode = '23505';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 10. Creation
  -- -------------------------------------------------------------------------
  -- Settlement asset account (mirrors AccountLookup.settlement).
  if v_method = 'CASH' then
    v_settle_code := '1010';
  elsif v_method = 'BANK' then
    v_settle_code := '1020';
  elsif v_method = 'ESEWA' then
    v_settle_code := case when exists (
      select 1 from public.accounts where business_id = p_business_id and code = '1040' and is_active
    ) then '1040' else '1020' end;
  elsif v_method = 'KHALTI' then
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

  if v_tax > 0 then
    select * into v_acc_vat_rec
      from public.accounts
     where business_id = p_business_id and code = '1070';
    if not found then
      raise exception 'VAT receivable (1070) is missing from chart of accounts' using errcode = '22023';
    end if;
  end if;

  v_journal_id := gen_random_uuid();
  v_expense_id := gen_random_uuid();

  -- The journal sequence is business-wide. post_sale does not take the advisory
  -- lock above, so a concurrently posting sale can still claim the same number;
  -- the unique constraint makes that a unique_violation, and the handler's
  -- savepoint rollback lets us recompute and retry instead of failing the post.
  v_attempt := 0;
  loop
    v_attempt := v_attempt + 1;
    begin
      select coalesce(max(sequence), 0) + 1
        into v_sequence
        from public.journal_entries
       where business_id = p_business_id;

      insert into public.journal_entries (
        id, business_id, transaction_date, sequence, description,
        reference, source_type, source_id, created_by
      ) values (
        v_journal_id, p_business_id, p_date, v_sequence,
        v_account.name || ' — ' || v_description,
        v_reference, 'EXPENSE', v_expense_id, v_uid
      ) returning * into v_journal_entry;

      -- Debits: the category account, then input VAT when there is any.
      insert into public.journal_lines (
        business_id, journal_entry_id, line_no,
        account_id, account_name, account_type, debit, credit
      ) values (
        p_business_id, v_journal_id, v_line_idx,
        v_account.id, v_account.name, v_account.type, v_amount, 0
      );
      v_line_idx := v_line_idx + 1;

      if v_tax > 0 then
        insert into public.journal_lines (
          business_id, journal_entry_id, line_no,
          account_id, account_name, account_type, debit, credit
        ) values (
          p_business_id, v_journal_id, v_line_idx,
          v_acc_vat_rec.id, v_acc_vat_rec.name, v_acc_vat_rec.type, v_tax, 0
        );
        v_line_idx := v_line_idx + 1;
      end if;

      -- Credit: the expense is settled in full at posting time.
      insert into public.journal_lines (
        business_id, journal_entry_id, line_no,
        account_id, account_name, account_type, debit, credit
      ) values (
        p_business_id, v_journal_id, v_line_idx,
        v_acc_settle.id, v_acc_settle.name, v_acc_settle.type, 0, v_total
      );
      v_line_idx := v_line_idx + 1;

      exit;
    exception when unique_violation then
      if v_attempt >= 3 then
        raise;
      end if;
      v_line_idx := 1;
      v_journal_id := gen_random_uuid();
    end;
  end loop;

  insert into public.expenses (
    id, business_id, reference, account_id, category_name, date, description,
    amount, tax_amount, total_amount, payment_method, status, notes,
    journal_entry_id, created_by, idempotency_key, price_includes_vat
  ) values (
    v_expense_id, p_business_id, v_reference, v_account.id, v_account.name, p_date, v_description,
    v_amount, v_tax, v_total, v_method, 'POSTED', nullif(v_notes, ''),
    v_journal_id, v_uid, v_key, v_vat_mode
  ) returning * into v_expense;

  return jsonb_build_object(
    'expense', to_jsonb(v_expense),
    'journal_entry', to_jsonb(v_journal_entry),
    'journal_lines', (
      select jsonb_agg(to_jsonb(jl) order by jl.line_no)
        from public.journal_lines jl
       where jl.journal_entry_id = v_journal_id
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------------
revoke all on function public.post_expense(
  uuid, uuid, text, date, numeric, numeric, numeric, text, text, text, text, boolean
) from public, anon, authenticated;

grant execute on function public.post_expense(
  uuid, uuid, text, date, numeric, numeric, numeric, text, text, text, text, boolean
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
         and p.proname not in ('is_member', 'can_write', 'is_owner', 'create_business', 'post_sale', 'post_purchase', 'post_expense')
       )
     );
  if v_bad is not null then
    raise exception 'Unexpected EXECUTE privilege on: %', v_bad;
  end if;
end $$;
