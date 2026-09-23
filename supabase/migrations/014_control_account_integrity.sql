-- ============================================================================
-- 014_control_account_integrity.sql
-- The AR/AP control-account reconciliation, moved from the browser into SQL.
--
-- What this answers
--   Outstanding is answered twice in this application, and the two answers must
--   be equal:
--     * the LEDGER side  — the net balance of the receivable control account
--                          (1030) or the payable control account (2010), built
--                          from journal lines, which is what the dashboard, the
--                          balance sheet and every statement read;
--     * the DOCUMENT side — for every non-VOIDED sale or purchase,
--                          total_amount − SUM(COMPLETED, non-VOIDED settlements
--                          linked to it), which is what the invoice list, the
--                          registers and the printed document read.
--
-- Stage 15 compared those two in AccountingEngine.checkIntegrity. That worked
-- only because the browser loads the whole book; the moment the app loads part
-- of it (pagination, a period-scoped read, a business with more rows than one
-- page) the comparison would silently compare incomplete data and report
-- nothing. This function is that comparison, derived from the rows themselves
-- by the database, so it stays correct when the client stops seeing everything.
--
-- Design decisions, and why
--   * SECURITY INVOKER, not DEFINER. Every table it reads is already readable by
--     a member under RLS, so it needs no raised privilege, and running as the
--     caller means RLS is the thing enforcing the tenant boundary rather than a
--     hand-written check inside a privileged function.
--   * NO PARAMETERS. There is no business id to supply and therefore none to
--     forge: the outer query starts from public.businesses, which RLS already
--     restricts to the caller's memberships, so a caller can only ever read
--     their own businesses. A non-member gets zero rows — not zeros, which would
--     be indistinguishable from a business that is genuinely balanced — and anon
--     has no EXECUTE at all.
--   * READ-ONLY. It is a STABLE function that aggregates; it writes nothing,
--     fixes nothing and cannot be used to repair a mismatch. Detection is
--     deliberately separate from correction.
--   * The control side is signed by the account's OWN normal side (ASSET and
--     EXPENSE are debit-normal, everything else credit-normal), which is the
--     same rule the accounting engine applies, so a receivable reads positive
--     when customers owe money and a payable reads positive when the business
--     owes it.
--   * The document side mirrors linkedSettlementTotal()/outstandingOn() exactly:
--     voided documents are excluded, voided settlements are excluded, only
--     COMPLETED settlements count, and sales.upfront_paid / purchases.upfront_paid
--     are NEVER read — they are posting-time snapshots, and the settlement row
--     written at posting time is already counted below exactly once.
--   * Money is numeric(14,2): exact decimal, not binary float. The comparison is
--     therefore exact. The client's 0.01 tolerance existed only because
--     JavaScript numbers are floats; no epsilon is invented here.
--
-- Object read from: public.businesses (scope), public.accounts (the two control
-- accounts), public.journal_lines (control side), public.sales / public.purchases
-- (document side), public.payments (settlements). Every aggregate is an indexed
-- business_id lookup, so no new index is required.
--
-- Rules every RPC in this project follows
--   * identity comes from auth.uid(); no user id or role is ever a parameter
--   * EXECUTE revoked from public, anon, then granted only to authenticated
--   * additive changes only; a breaking change ships as <name>_v2
-- ============================================================================

create or replace function public.control_account_integrity()
returns table (
  business_id           uuid,
  receivable_control    numeric(14,2),
  receivable_documents  numeric(14,2),
  receivable_difference numeric(14,2),
  receivable_status     text,
  payable_control       numeric(14,2),
  payable_documents     numeric(14,2),
  payable_difference    numeric(14,2),
  payable_status        text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with ar_control as (
    -- The signed balance of 1030 from journal lines only.
    select a.business_id,
           coalesce(sum(
             case when a.type in ('ASSET', 'EXPENSE') then jl.debit - jl.credit
                  else jl.credit - jl.debit
             end
           ), 0)::numeric(14,2) as amount
      from public.accounts a
      left join public.journal_lines jl
        on jl.account_id = a.id
       and jl.business_id = a.business_id
     where a.code = '1030'
     group by a.business_id
  ),
  ap_control as (
    -- The signed balance of 2010, the same rule.
    select a.business_id,
           coalesce(sum(
             case when a.type in ('ASSET', 'EXPENSE') then jl.debit - jl.credit
                  else jl.credit - jl.debit
             end
           ), 0)::numeric(14,2) as amount
      from public.accounts a
      left join public.journal_lines jl
        on jl.account_id = a.id
       and jl.business_id = a.business_id
     where a.code = '2010'
     group by a.business_id
  ),
  receivable_documents as (
    select s.business_id,
           coalesce(sum(s.total_amount - coalesce(settled.amount, 0)), 0)::numeric(14,2) as amount
      from public.sales s
      left join lateral (
        select sum(p.amount) as amount
          from public.payments p
         where p.business_id = s.business_id
           and p.linked_sale_id = s.id
           and p.status = 'COMPLETED'
           and p.doc_status <> 'VOIDED'
      ) settled on true
     where s.status <> 'VOIDED'
     group by s.business_id
  ),
  payable_documents as (
    select pu.business_id,
           coalesce(sum(pu.total_amount - coalesce(settled.amount, 0)), 0)::numeric(14,2) as amount
      from public.purchases pu
      left join lateral (
        select sum(p.amount) as amount
          from public.payments p
         where p.business_id = pu.business_id
           and p.linked_purchase_id = pu.id
           and p.status = 'COMPLETED'
           and p.doc_status <> 'VOIDED'
      ) settled on true
     where pu.status <> 'VOIDED'
     group by pu.business_id
  ),
  compared as (
    select
      b.id                                       as business_id,
      coalesce(arc.amount, 0)::numeric(14,2)     as receivable_control,
      coalesce(ard.amount, 0)::numeric(14,2)     as receivable_documents,
      coalesce(apc.amount, 0)::numeric(14,2)     as payable_control,
      coalesce(apd.amount, 0)::numeric(14,2)     as payable_documents
    from public.businesses b
    left join ar_control          arc on arc.business_id = b.id
    left join ap_control          apc on apc.business_id = b.id
    left join receivable_documents ard on ard.business_id = b.id
    left join payable_documents    apd on apd.business_id = b.id
  )
  select
    c.business_id,
    c.receivable_control,
    c.receivable_documents,
    (c.receivable_control - c.receivable_documents)::numeric(14,2),
    case when c.receivable_control = c.receivable_documents then 'OK' else 'ERROR' end,
    c.payable_control,
    c.payable_documents,
    (c.payable_control - c.payable_documents)::numeric(14,2),
    case when c.payable_control = c.payable_documents then 'OK' else 'ERROR' end
  from compared c
  order by c.business_id;
$$;

comment on function public.control_account_integrity() is
  'Read-only diagnostic: per business the caller may read, the ledger control '
  'account (1030 receivable / 2010 payable) beside the document-side live '
  'outstanding (document total minus COMPLETED, non-voided settlements), with '
  'the difference and an OK/ERROR status per side. Voided documents and voided '
  'settlements are excluded; posting-time snapshots are never read. SECURITY '
  'INVOKER and parameterless, so RLS decides which businesses it can see.';

-- ---------------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------------
revoke all on function public.control_account_integrity()
  from public, anon, authenticated;

grant execute on function public.control_account_integrity()
  to authenticated;

-- ---------------------------------------------------------------------------
-- Safety net: function privileges (restated, with control_account_integrity added)
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
