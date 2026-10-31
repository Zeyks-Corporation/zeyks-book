import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Download, RefreshCw, Upload, Wrench } from 'lucide-react';
import type { Account, JournalEntry } from '../types';
import type { Books } from '../state/useBooks';
import { supabase } from '../lib/neon';
import { todayNpt } from '../lib/nepaliDate';
import { formatNpr } from '../lib/money';
import { Button, Callout, Field, inputClass } from './ui';

type TabId = 'budgets' | 'reconciliation' | 'recurring' | 'attachments' | 'assets';
type RawRow = Record<string, unknown>;
type Notice = { message: string; error?: boolean } | null;

interface BudgetRow extends RawRow {
  id: string; name: string; account_id: string; period_start: string; period_end: string;
  budget_amount: number | string; archived_at: string | null;
}
interface ReconciliationRow extends RawRow {
  id: string; account_id: string; period_start: string; period_end: string;
  opening_balance: number | string; closing_balance: number | string;
  status: 'OPEN' | 'RECONCILED'; reconciled_at: string | null;
}
interface StatementLineRow extends RawRow {
  id: string; reconciliation_id: string; transaction_date: string; description: string;
  reference: string; amount: number | string; match_status: 'UNMATCHED' | 'MATCHED' | 'IGNORED';
  matched_journal_entry_id: string | null;
}
interface RecurringRow extends RawRow {
  id: string; customer_name: string; description: string; quantity: number | string;
  unit_price: number | string; discount: number | string; cadence: string;
  next_run_date: string; payment_terms_days: number; is_active: boolean;
}
interface RunRow extends RawRow {
  id: string; template_id: string; scheduled_date: string; sale_id: string; created_at: string;
}
interface AttachmentRow extends RawRow {
  id: string; file_name: string; media_type: string; byte_size: number; uploaded_at: string;
}
interface AssetRow extends RawRow {
  id: string; name: string; purchase_date: string; cost: number | string;
  salvage_value: number | string; useful_life_months: number;
  depreciation_expense_account_id: string; accumulated_depreciation_account_id: string;
}
interface DepreciationRow extends RawRow {
  id: string; asset_id: string; period_end: string; amount: number | string; journal_entry_id: string;
}

const TABS: { id: TabId; label: string; summary: string }[] = [
  { id: 'budgets', label: 'Budgets', summary: 'Plan account totals and compare them with posted ledger activity.' },
  { id: 'reconciliation', label: 'Bank reconciliation', summary: 'Enter statement lines, match ledger movements, then finalize a statement period.' },
  { id: 'recurring', label: 'Recurring invoices', summary: 'Schedule repeat invoices and post each due invoice through the existing sale workflow.' },
  { id: 'attachments', label: 'Attachments', summary: 'Store small supporting files in this business database.' },
  { id: 'assets', label: 'Fixed assets', summary: 'Keep an asset register and post straight-line depreciation to the ledger.' },
];

function amount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

function lastDayOfMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, monthNumber!, 0)).toISOString().slice(0, 10);
}

function fieldAccountLabel(account: Account): string {
  return `${account.code} · ${account.name}`;
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return <div className="mb-5"><h2 className="text-[20px] font-semibold">{title}</h2><p className="mt-1 text-[13px] text-[var(--label-secondary)]">{detail}</p></div>;
}

function EmptyRows({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-[var(--separator)] p-4 text-[13px] text-[var(--label-secondary)]">{children}</p>;
}

export const PremiumToolsView: React.FC<{
  businessId: string;
  books: Books;
  readOnly: boolean;
}> = ({ businessId, books, readOnly }) => {
  const [tab, setTab] = useState<TabId>('budgets');
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [reconciliations, setReconciliations] = useState<ReconciliationRow[]>([]);
  const [statementLines, setStatementLines] = useState<StatementLineRow[]>([]);
  const [recurring, setRecurring] = useState<RecurringRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [depreciations, setDepreciations] = useState<DepreciationRow[]>([]);
  const [selectedReconciliationId, setSelectedReconciliationId] = useState('');

  const activeAccounts = useMemo(() => books.accounts.filter((account) => account.isActive), [books.accounts]);
  const bankAccounts = useMemo(() => activeAccounts.filter((account) => account.type === 'ASSET'), [activeAccounts]);
  const budgetAccounts = useMemo(() => activeAccounts.filter((account) => account.type === 'REVENUE' || account.type === 'EXPENSE'), [activeAccounts]);

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const [budgetResult, reconResult, lineResult, recurringResult, runResult, attachmentResult, assetResult, depreciationResult] = await Promise.all([
        supabase.from('budgets').select('*').eq('business_id', businessId).is('archived_at', null).order('period_start', { ascending: false }),
        supabase.from('bank_reconciliations').select('*').eq('business_id', businessId).order('period_start', { ascending: false }),
        supabase.from('bank_statement_lines').select('*').eq('business_id', businessId).order('transaction_date', { ascending: false }),
        supabase.from('recurring_invoice_templates').select('*').eq('business_id', businessId).is('archived_at', null).order('next_run_date'),
        supabase.from('recurring_invoice_runs').select('*').eq('business_id', businessId).order('created_at', { ascending: false }).limit(100),
        supabase.from('document_attachments').select('id,file_name,media_type,byte_size,uploaded_at').eq('business_id', businessId).is('archived_at', null).order('uploaded_at', { ascending: false }),
        supabase.from('fixed_assets').select('*').eq('business_id', businessId).eq('is_active', true).order('purchase_date', { ascending: false }),
        supabase.from('fixed_asset_depreciations').select('*').eq('business_id', businessId).order('period_end', { ascending: false }),
      ]);
      const firstError = [budgetResult, reconResult, lineResult, recurringResult, runResult, attachmentResult, assetResult, depreciationResult]
        .find((result) => result.error)?.error;
      if (firstError) {
        const missingModuleSchema = /does not exist|could not find the table|schema cache/i.test(firstError.message);
        throw new Error(missingModuleSchema
          ? `Premium tools need database migration 029. ${firstError.message}`
          : firstError.message);
      }
      setBudgets((budgetResult.data ?? []) as unknown as BudgetRow[]);
      setReconciliations((reconResult.data ?? []) as unknown as ReconciliationRow[]);
      setStatementLines((lineResult.data ?? []) as unknown as StatementLineRow[]);
      setRecurring((recurringResult.data ?? []) as unknown as RecurringRow[]);
      setRuns((runResult.data ?? []) as unknown as RunRow[]);
      setAttachments((attachmentResult.data ?? []) as unknown as AttachmentRow[]);
      setAssets((assetResult.data ?? []) as unknown as AssetRow[]);
      setDepreciations((depreciationResult.data ?? []) as unknown as DepreciationRow[]);
      setSelectedReconciliationId((current) => current || (reconResult.data?.[0]?.id as string | undefined) || '');
    } catch (error) {
      setNotice({ message: errorMessage(error), error: true });
    } finally {
      setLoading(false);
    }
  }, [businessId, reloadKey]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="max-w-5xl mx-auto py-6 px-4 sm:px-6 space-y-5 text-[var(--label)]">
      <div className="flex items-start justify-between gap-4">
        <div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--accent)] flex items-center gap-1.5"><Wrench size={12} /> Premium workspace</p>
          <h1 className="mt-1 text-[26px] font-bold">Business tools</h1>
          <p className="mt-1 max-w-2xl text-[14px] text-[var(--label-secondary)]">Every tool is scoped to this business. New rows are stored in Neon, and posted ledger entries remain immutable.</p></div>
        <button type="button" onClick={() => setReloadKey((key) => key + 1)} disabled={loading} aria-label="Refresh premium tools"
          className="min-h-[44px] min-w-[44px] rounded-full border border-[var(--separator)] flex items-center justify-center disabled:opacity-50"><RefreshCw size={15} /></button>
      </div>
      {readOnly && <Callout tone="warn">This account is read-only. A Premium owner or accountant can manage these tools; existing entries remain visible.</Callout>}
      {notice && <Callout tone={notice.error ? 'error' : 'info'}>{notice.message}</Callout>}
      <div className="flex gap-2 overflow-x-auto border-b border-[var(--separator)] pb-2" role="tablist" aria-label="Premium modules">
        {TABS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}
          className={`shrink-0 rounded-full px-3 py-2 text-[13px] font-medium ${tab === item.id ? 'bg-[var(--accent)] text-white' : 'bg-[var(--fill-secondary)] text-[var(--label-secondary)]'}`}>{item.label}</button>)}
      </div>
      <p className="text-[13px] text-[var(--label-secondary)]">{TABS.find((item) => item.id === tab)?.summary}</p>
      {loading ? <EmptyRows>Loading saved records…</EmptyRows> : (
        <>
          {tab === 'budgets' && <BudgetsPanel businessId={businessId} userId={books.user?.id ?? ''} accounts={budgetAccounts} entries={books.journalEntries} rows={budgets} readOnly={readOnly} onSaved={() => setReloadKey((key) => key + 1)} onError={(message) => setNotice({ message, error: true })} />}
          {tab === 'reconciliation' && <ReconciliationPanel businessId={businessId} userId={books.user?.id ?? ''} accounts={bankAccounts} entries={books.journalEntries} reconciliations={reconciliations} lines={statementLines} selectedId={selectedReconciliationId} onSelect={setSelectedReconciliationId} readOnly={readOnly} onSaved={() => setReloadKey((key) => key + 1)} onMessage={setNotice} />}
          {tab === 'recurring' && <RecurringPanel businessId={businessId} userId={books.user?.id ?? ''} templates={recurring} runs={runs} readOnly={readOnly} onSaved={() => setReloadKey((key) => key + 1)} onMessage={setNotice} />}
          {tab === 'attachments' && <AttachmentsPanel businessId={businessId} userId={books.user?.id ?? ''} rows={attachments} readOnly={readOnly} onSaved={() => setReloadKey((key) => key + 1)} onMessage={setNotice} />}
          {tab === 'assets' && <FixedAssetsPanel businessId={businessId} userId={books.user?.id ?? ''} accounts={activeAccounts} assets={assets} depreciations={depreciations} readOnly={readOnly} onSaved={() => setReloadKey((key) => key + 1)} onMessage={setNotice} />}
        </>
      )}
    </div>
  );
};

function BudgetsPanel({ businessId, userId, accounts, entries, rows, readOnly, onSaved, onError }: {
  businessId: string; userId: string; accounts: Account[]; entries: JournalEntry[];
  rows: BudgetRow[]; readOnly: boolean; onSaved: () => void; onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState({ name: '', accountId: accounts[0]?.id ?? '', from: todayNpt().slice(0, 7) + '-01', to: todayNpt(), amount: '' });
  const [busy, setBusy] = useState(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!userId || !draft.accountId || Number(draft.amount) < 0 || !Number.isFinite(Number(draft.amount))) return;
    setBusy(true);
    const { error } = await supabase.from('budgets').insert({
      business_id: businessId, name: draft.name.trim(), account_id: draft.accountId,
      period_start: draft.from, period_end: draft.to, budget_amount: Number(draft.amount), created_by: userId,
    });
    setBusy(false);
    if (error) { onError(error.message); return; }
    setDraft((old) => ({ ...old, name: '', amount: '' })); onSaved();
  };
  const actual = (account: Account, from: string, to: string) => entries
    .filter((entry) => entry.transactionDate >= from && entry.transactionDate <= to)
    .flatMap((entry) => entry.lines)
    .filter((line) => line.accountId === account.id)
    .reduce((sum, line) => sum + (account.type === 'REVENUE' ? line.credit - line.debit : line.debit - line.credit), 0);
  return <section className="space-y-4"><SectionHeading title="Budgets" detail="Budgets are forecasts. They never create or change ledger entries." />
    {!readOnly && <form onSubmit={(event) => void save(event)} className="grid gap-3 rounded-xl border border-[var(--separator)] bg-[var(--bg)] p-4 sm:grid-cols-2">
      <Field label="Budget name" required>{(id) => <input id={id} className={inputClass} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />}</Field>
      <Field label="Revenue or expense account" required>{(id) => <select id={id} className={inputClass} value={draft.accountId} onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}>{accounts.map((account) => <option key={account.id} value={account.id}>{fieldAccountLabel(account)}</option>)}</select>}</Field>
      <Field label="Period starts" required>{(id) => <input id={id} type="date" className={inputClass} value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} required />}</Field>
      <Field label="Period ends" required>{(id) => <input id={id} type="date" className={inputClass} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} min={draft.from} required />}</Field>
      <Field label="Planned amount (NPR)" required>{(id) => <input id={id} type="number" min="0" step="0.01" className={inputClass} value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} required />}</Field>
      <div className="flex items-end"><Button variant="primary" disabled={busy || !draft.name.trim() || !draft.accountId}>{busy ? 'Saving…' : 'Save budget'}</Button></div>
    </form>}
    {rows.length === 0 ? <EmptyRows>No budgets saved for this business yet.</EmptyRows> : <div className="space-y-2">{rows.map((row) => {
      const account = accounts.find((item) => item.id === row.account_id);
      const spent = account ? actual(account, row.period_start, row.period_end) : 0;
      const planned = amount(row.budget_amount); const pct = planned > 0 ? Math.min(100, Math.max(0, spent / planned * 100)) : 0;
      return <article key={row.id} className="rounded-xl border border-[var(--separator)] bg-[var(--bg)] p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><div><h3 className="font-semibold">{row.name}</h3><p className="text-[12px] text-[var(--label-secondary)]">{account?.name ?? 'Account'} · {row.period_start} – {row.period_end}</p></div><p className="text-[13px]">Actual <strong>{formatNpr(spent, 'NPR')}</strong> / {formatNpr(planned, 'NPR')}</p></div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--fill-secondary)]"><div className={`h-full ${spent > planned ? 'bg-[var(--destructive)]' : 'bg-[var(--accent)]'}`} style={{ width: `${pct}%` }} /></div>
      </article>;
    })}</div>}
  </section>;
}

function ReconciliationPanel({ businessId, userId, accounts, entries, reconciliations, lines, selectedId, onSelect, readOnly, onSaved, onMessage }: {
  businessId: string; userId: string; accounts: Account[]; entries: JournalEntry[];
  reconciliations: ReconciliationRow[]; lines: StatementLineRow[]; selectedId: string; onSelect: (id: string) => void;
  readOnly: boolean; onSaved: () => void; onMessage: (notice: Notice) => void;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [from, setFrom] = useState(todayNpt().slice(0, 7) + '-01');
  const [to, setTo] = useState(todayNpt());
  const [opening, setOpening] = useState('0'); const [closing, setClosing] = useState('0');
  const [lineDraft, setLineDraft] = useState({ date: todayNpt(), description: '', reference: '', amount: '' });
  const [busy, setBusy] = useState(false);
  const selected = reconciliations.find((row) => row.id === selectedId);
  const visibleLines = lines.filter((line) => line.reconciliation_id === selectedId);
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); if (!userId || !accountId) return; setBusy(true);
    const { data, error } = await supabase.from('bank_reconciliations').insert({
      business_id: businessId, account_id: accountId, period_start: from, period_end: to,
      opening_balance: Number(opening), closing_balance: Number(closing), created_by: userId, status: 'OPEN',
    }).select('id').single();
    setBusy(false);
    if (error) { onMessage({ message: error.message, error: true }); return; }
    onSelect((data as { id: string }).id); onSaved();
  };
  const addLine = async (event: React.FormEvent) => {
    event.preventDefault(); if (!selected || !userId) return; setBusy(true);
    const { error } = await supabase.from('bank_statement_lines').insert({
      business_id: businessId, reconciliation_id: selected.id, transaction_date: lineDraft.date,
      description: lineDraft.description.trim(), reference: lineDraft.reference.trim(), amount: Number(lineDraft.amount),
      created_by: userId,
    });
    setBusy(false);
    if (error) { onMessage({ message: error.message, error: true }); return; }
    setLineDraft({ date: todayNpt(), description: '', reference: '', amount: '' }); onSaved();
  };
  const candidates = (line: StatementLineRow) => entries.filter((entry) => {
    if (lines.some((other) => other.id !== line.id && other.reconciliation_id === line.reconciliation_id
      && other.match_status === 'MATCHED' && other.matched_journal_entry_id === entry.id)) return false;
    if (entry.transactionDate !== line.transaction_date) return false;
    return Math.abs(entry.lines.filter((item) => item.accountId === selected?.account_id)
      .reduce((sum, item) => sum + item.debit - item.credit, 0) - amount(line.amount)) < 0.005;
  });
  const updateMatch = async (line: StatementLineRow, status: 'MATCHED' | 'IGNORED', journalEntryId: string | null) => {
    setBusy(true);
    const { error } = await supabase.from('bank_statement_lines').update({ match_status: status, matched_journal_entry_id: journalEntryId })
      .eq('business_id', businessId).eq('id', line.id);
    setBusy(false);
    if (error) onMessage({ message: error.message, error: true }); else onSaved();
  };
  const finalize = async () => {
    if (!selected) return; setBusy(true);
    const { error } = await supabase.rpc('finalize_bank_reconciliation', { p_reconciliation_id: selected.id });
    setBusy(false);
    if (error) onMessage({ message: error.message, error: true }); else { onMessage({ message: 'Reconciliation completed and locked.', error: false }); onSaved(); }
  };
  return <section className="space-y-4"><SectionHeading title="Bank reconciliation" detail="Statement lines are kept. Matches point to existing posted ledger entries; completing a reconciliation freezes the statement." />
    {!readOnly && <form onSubmit={(event) => void create(event)} className="grid gap-3 rounded-xl border border-[var(--separator)] bg-[var(--bg)] p-4 sm:grid-cols-2">
      <Field label="Cash or bank account">{(id) => <select id={id} className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{fieldAccountLabel(account)}</option>)}</select>}</Field>
      <Field label="Period begins">{(id) => <input id={id} type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} required />}</Field>
      <Field label="Period ends">{(id) => <input id={id} type="date" className={inputClass} min={from} value={to} onChange={(e) => setTo(e.target.value)} required />}</Field>
      <Field label="Opening balance (NPR)">{(id) => <input id={id} type="number" step="0.01" className={inputClass} value={opening} onChange={(e) => setOpening(e.target.value)} required />}</Field>
      <Field label="Statement closing balance (NPR)">{(id) => <input id={id} type="number" step="0.01" className={inputClass} value={closing} onChange={(e) => setClosing(e.target.value)} required />}</Field>
      <div className="flex items-end"><Button variant="primary" disabled={busy || !accountId}>Start reconciliation</Button></div>
    </form>}
    {reconciliations.length > 0 && <Field label="Open a saved reconciliation">{(id) => <select id={id} className={inputClass} value={selectedId} onChange={(e) => onSelect(e.target.value)}>{reconciliations.map((row) => <option key={row.id} value={row.id}>{row.period_start} – {row.period_end} · {row.status}</option>)}</select>}</Field>}
    {!selected ? <EmptyRows>No statement period created yet.</EmptyRows> : <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--fill-secondary)] p-3 text-[13px]"><span>{selected.period_start} – {selected.period_end} · {selected.status} · Opening {formatNpr(amount(selected.opening_balance), 'NPR')} · Closing {formatNpr(amount(selected.closing_balance), 'NPR')}</span>{selected.status === 'OPEN' && !readOnly && <Button variant="secondary" onClick={() => void finalize()} disabled={busy}>Finish and lock</Button>}</div>
      {selected.status === 'OPEN' && !readOnly && <form onSubmit={(event) => void addLine(event)} className="grid gap-3 rounded-xl border border-[var(--separator)] bg-[var(--bg)] p-4 sm:grid-cols-2">
        <Field label="Statement date">{(id) => <input id={id} type="date" className={inputClass} min={selected.period_start} max={selected.period_end} value={lineDraft.date} onChange={(e) => setLineDraft({ ...lineDraft, date: e.target.value })} required />}</Field>
        <Field label="Description">{(id) => <input id={id} className={inputClass} value={lineDraft.description} onChange={(e) => setLineDraft({ ...lineDraft, description: e.target.value })} required />}</Field>
        <Field label="Reference (optional)">{(id) => <input id={id} className={inputClass} value={lineDraft.reference} onChange={(e) => setLineDraft({ ...lineDraft, reference: e.target.value })} />}</Field>
        <Field label="Signed amount (deposit +, withdrawal −)">{(id) => <input id={id} type="number" step="0.01" className={inputClass} value={lineDraft.amount} onChange={(e) => setLineDraft({ ...lineDraft, amount: e.target.value })} required />}</Field>
        <div className="sm:col-span-2"><Button variant="primary" disabled={busy}>Add statement line</Button></div>
      </form>}
      {visibleLines.length === 0 ? <EmptyRows>Add statement lines, then match each to a ledger entry or mark it ignored.</EmptyRows> : <div className="space-y-2">{visibleLines.map((line) => {
        const matches = candidates(line);
        return <article key={line.id} className="grid gap-2 rounded-lg border border-[var(--separator)] bg-[var(--bg)] p-3 sm:grid-cols-[1fr_auto] sm:items-center">
          <div><p className="text-[13px] font-semibold">{line.description}</p><p className="text-[12px] text-[var(--label-secondary)]">{line.transaction_date} · {formatNpr(amount(line.amount), 'NPR')} · {line.match_status}</p></div>
          {selected.status === 'OPEN' && !readOnly && line.match_status !== 'MATCHED' && <div className="flex flex-wrap gap-2">
            {matches.map((entry) => <Button key={entry.id} variant="secondary" onClick={() => void updateMatch(line, 'MATCHED', entry.id)} disabled={busy}>
              <Check size={13} /> Match {entry.reference || entry.description} · #{entry.sequence}
            </Button>)}
            {line.match_status !== 'IGNORED' && <Button variant="secondary" onClick={() => void updateMatch(line, 'IGNORED', null)} disabled={busy}>Mark ignored</Button>}
          </div>}
        </article>;
      })}</div>}
    </div>}
  </section>;
}

function RecurringPanel({ businessId, userId, templates, runs, readOnly, onSaved, onMessage }: {
  businessId: string; userId: string; templates: RecurringRow[]; runs: RunRow[]; readOnly: boolean;
  onSaved: () => void; onMessage: (notice: Notice) => void;
}) {
  const [draft, setDraft] = useState({ customer: '', description: '', quantity: '1', price: '', discount: '0', cadence: 'MONTHLY', next: todayNpt(), terms: '0' });
  const [busyId, setBusyId] = useState('');
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); if (!userId) return; setBusyId('create');
    const date = new Date(`${draft.next}T00:00:00Z`);
    const { error } = await supabase.from('recurring_invoice_templates').insert({
      business_id: businessId, customer_name: draft.customer.trim(), description: draft.description.trim(),
      quantity: Number(draft.quantity), unit_price: Number(draft.price), discount: Number(draft.discount),
      cadence: draft.cadence, next_run_date: draft.next, anchor_day: date.getUTCDate(),
      payment_terms_days: Number(draft.terms), created_by: userId,
    });
    setBusyId('');
    if (error) { onMessage({ message: error.message, error: true }); return; }
    setDraft({ customer: '', description: '', quantity: '1', price: '', discount: '0', cadence: 'MONTHLY', next: todayNpt(), terms: '0' }); onSaved();
  };
  const generate = async (row: RecurringRow) => {
    setBusyId(row.id);
    const { data, error } = await supabase.rpc('generate_recurring_invoice', { p_template_id: row.id });
    setBusyId('');
    if (error) { onMessage({ message: error.message, error: true }); return; }
    const result = data as { sale_id?: string; next_run_date?: string };
    onMessage({ message: `Invoice posted. Next scheduled date: ${result.next_run_date ?? 'updated'}.`, error: false }); onSaved();
  };
  const pause = async (row: RecurringRow) => {
    setBusyId(row.id);
    const { error } = await supabase.from('recurring_invoice_templates').update({ is_active: false }).eq('business_id', businessId).eq('id', row.id);
    setBusyId('');
    if (error) onMessage({ message: error.message, error: true }); else onSaved();
  };
  return <section className="space-y-4"><SectionHeading title="Recurring invoices" detail="Templates do not post automatically. Generate a due invoice when you review it; posting uses the same balanced sale RPC as a regular invoice." />
    {!readOnly && <form onSubmit={(event) => void create(event)} className="grid gap-3 rounded-xl border border-[var(--separator)] bg-[var(--bg)] p-4 sm:grid-cols-2">
      <Field label="Customer" required>{(id) => <input id={id} className={inputClass} value={draft.customer} onChange={(e) => setDraft({ ...draft, customer: e.target.value })} required />}</Field>
      <Field label="Invoice line description" required>{(id) => <input id={id} className={inputClass} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} required />}</Field>
      <Field label="Quantity">{(id) => <input id={id} type="number" min="0.001" step="0.001" className={inputClass} value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} required />}</Field>
      <Field label="Unit price (NPR)">{(id) => <input id={id} type="number" min="0.01" step="0.01" className={inputClass} value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} required />}</Field>
      <Field label="Discount (NPR)">{(id) => <input id={id} type="number" min="0" step="0.01" className={inputClass} value={draft.discount} onChange={(e) => setDraft({ ...draft, discount: e.target.value })} required />}</Field>
      <Field label="Frequency">{(id) => <select id={id} className={inputClass} value={draft.cadence} onChange={(e) => setDraft({ ...draft, cadence: e.target.value })}><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly</option><option value="YEARLY">Yearly</option></select>}</Field>
      <Field label="Next invoice date">{(id) => <input id={id} type="date" className={inputClass} value={draft.next} onChange={(e) => setDraft({ ...draft, next: e.target.value })} required />}</Field>
      <Field label="Payment terms (days)">{(id) => <input id={id} type="number" min="0" max="3650" className={inputClass} value={draft.terms} onChange={(e) => setDraft({ ...draft, terms: e.target.value })} required />}</Field>
      <div className="flex items-end"><Button variant="primary" disabled={busyId === 'create'}>{busyId === 'create' ? 'Saving…' : 'Save schedule'}</Button></div>
    </form>}
    {templates.length === 0 ? <EmptyRows>No recurring invoice schedules saved.</EmptyRows> : <div className="space-y-2">{templates.map((row) => <article key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--separator)] bg-[var(--bg)] p-4">
      <div><h3 className="font-semibold">{row.customer_name} · {formatNpr(amount(row.quantity) * amount(row.unit_price) - amount(row.discount), 'NPR')}</h3><p className="text-[12px] text-[var(--label-secondary)]">{row.description} · {row.cadence.toLowerCase()} · next {row.next_run_date} · {row.is_active ? 'active' : 'paused'}</p></div>
      {!readOnly && row.is_active && <div className="flex gap-2"><Button variant="primary" onClick={() => void generate(row)} disabled={busyId === row.id}>{busyId === row.id ? 'Posting…' : 'Generate due invoice'}</Button><Button variant="secondary" onClick={() => void pause(row)} disabled={busyId === row.id}>Pause</Button></div>}
    </article>)}</div>}
    {runs.length > 0 && <div><h3 className="mb-2 text-[13px] font-semibold">Generated invoices</h3><ul className="space-y-1 text-[12px] text-[var(--label-secondary)]">{runs.slice(0, 20).map((run) => <li key={run.id}>{run.scheduled_date} · invoice id {run.sale_id}</li>)}</ul></div>}
  </section>;
}

function AttachmentsPanel({ businessId, userId, rows, readOnly, onSaved, onMessage }: {
  businessId: string; userId: string; rows: AttachmentRow[]; readOnly: boolean; onSaved: () => void;
  onMessage: (notice: Notice) => void;
}) {
  const [busy, setBusy] = useState(false);
  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file || !userId) return;
    if (file.size > 2 * 1024 * 1024) { onMessage({ message: 'Choose a file no larger than 2 MB.', error: true }); event.target.value = ''; return; }
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error('File could not be read.'));
        reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file);
      });
      const content = dataUrl.split(',')[1]; if (!content) throw new Error('File encoding failed.');
      const { error } = await supabase.from('document_attachments').insert({
        business_id: businessId, record_type: 'BUSINESS', record_id: null,
        file_name: file.name, media_type: file.type || 'application/octet-stream',
        content_base64: content, byte_size: file.size, uploaded_by: userId,
      });
      if (error) throw new Error(error.message);
      onMessage({ message: 'Attachment stored with this business.', error: false }); onSaved();
    } catch (error) { onMessage({ message: errorMessage(error), error: true }); }
    finally { setBusy(false); event.target.value = ''; }
  };
  const download = async (row: AttachmentRow) => {
    const { data, error } = await supabase.from('document_attachments').select('content_base64,media_type').eq('business_id', businessId).eq('id', row.id).single();
    if (error || !data) { onMessage({ message: error?.message ?? 'Attachment could not be loaded.', error: true }); return; }
    const payload = data as { content_base64: string; media_type: string };
    const bytes = Uint8Array.from(atob(payload.content_base64), (ch) => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: payload.media_type }));
    const link = document.createElement('a'); link.href = url; link.download = row.file_name; link.click(); URL.revokeObjectURL(url);
  };
  return <section className="space-y-4"><SectionHeading title="Supporting files" detail="Files up to 2 MB are stored in the business database with the same business-level access controls. Uploads are retained; there is no delete action." />
    {!readOnly && <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--separator)] bg-[var(--bg)] p-5 text-center text-[13px] text-[var(--label-secondary)]"><Upload size={18} /><span>{busy ? 'Saving file…' : 'Choose a supporting document (2 MB maximum)'}</span><input type="file" className="sr-only" onChange={(event) => void upload(event)} disabled={busy} /></label>}
    {rows.length === 0 ? <EmptyRows>No attachments saved.</EmptyRows> : <ul className="space-y-2">{rows.map((row) => <li key={row.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--separator)] bg-[var(--bg)] p-3"><div className="min-w-0"><p className="truncate text-[13px] font-semibold">{row.file_name}</p><p className="text-[12px] text-[var(--label-secondary)]">{Math.ceil(row.byte_size / 1024)} KB · {new Date(row.uploaded_at).toLocaleDateString()}</p></div><Button variant="secondary" onClick={() => void download(row)} aria-label={`Download ${row.file_name}`}><Download size={14} /></Button></li>)}</ul>}
  </section>;
}

function FixedAssetsPanel({ businessId, userId, accounts, assets, depreciations, readOnly, onSaved, onMessage }: {
  businessId: string; userId: string; accounts: Account[]; assets: AssetRow[]; depreciations: DepreciationRow[];
  readOnly: boolean; onSaved: () => void; onMessage: (notice: Notice) => void;
}) {
  const assetAccounts = accounts.filter((account) => account.type === 'ASSET');
  const expenseAccounts = accounts.filter((account) => account.type === 'EXPENSE');
  const [draft, setDraft] = useState({ name: '', date: todayNpt(), cost: '', salvage: '0', life: '60', assetAccount: assetAccounts[0]?.id ?? '', expenseAccount: expenseAccounts[0]?.id ?? '', accumAccount: assetAccounts.find((account) => /accumulated depreciation/i.test(account.name))?.id ?? '' });
  const [month, setMonth] = useState(todayNpt().slice(0, 7)); const [busyId, setBusyId] = useState('');
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); if (!userId) return; setBusyId('create');
    const { error } = await supabase.from('fixed_assets').insert({
      business_id: businessId, name: draft.name.trim(), purchase_date: draft.date, cost: Number(draft.cost),
      salvage_value: Number(draft.salvage), useful_life_months: Number(draft.life), asset_account_id: draft.assetAccount,
      depreciation_expense_account_id: draft.expenseAccount, accumulated_depreciation_account_id: draft.accumAccount,
      created_by: userId,
    });
    setBusyId(''); if (error) onMessage({ message: error.message, error: true }); else { onMessage({ message: 'Fixed asset saved. No acquisition journal entry was created.', error: false }); onSaved(); }
  };
  const postDepreciation = async (asset: AssetRow) => {
    setBusyId(asset.id);
    const { data, error } = await supabase.rpc('post_fixed_asset_depreciation', { p_asset_id: asset.id, p_period_end: lastDayOfMonth(month) });
    setBusyId('');
    if (error) onMessage({ message: error.message, error: true }); else { onMessage({ message: `Depreciation posted to the ledger (journal ${String(data).slice(0, 8)}).`, error: false }); onSaved(); }
  };
  return <section className="space-y-4"><SectionHeading title="Fixed assets" detail="Asset acquisition stays in the existing purchase or journal workflow. This register posts monthly straight-line depreciation as a balanced journal entry." />
    {!readOnly && <form onSubmit={(event) => void create(event)} className="grid gap-3 rounded-xl border border-[var(--separator)] bg-[var(--bg)] p-4 sm:grid-cols-2">
      <Field label="Asset name">{(id) => <input id={id} className={inputClass} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />}</Field>
      <Field label="Purchase date">{(id) => <input id={id} type="date" className={inputClass} value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} required />}</Field>
      <Field label="Cost (NPR)">{(id) => <input id={id} type="number" min="0.01" step="0.01" className={inputClass} value={draft.cost} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} required />}</Field>
      <Field label="Salvage value (NPR)">{(id) => <input id={id} type="number" min="0" step="0.01" className={inputClass} value={draft.salvage} onChange={(e) => setDraft({ ...draft, salvage: e.target.value })} required />}</Field>
      <Field label="Useful life (months)">{(id) => <input id={id} type="number" min="1" max="1200" step="1" className={inputClass} value={draft.life} onChange={(e) => setDraft({ ...draft, life: e.target.value })} required />}</Field>
      <Field label="Asset account">{(id) => <select id={id} className={inputClass} value={draft.assetAccount} onChange={(e) => setDraft({ ...draft, assetAccount: e.target.value })}>{assetAccounts.map((account) => <option key={account.id} value={account.id}>{fieldAccountLabel(account)}</option>)}</select>}</Field>
      <Field label="Depreciation expense account">{(id) => <select id={id} className={inputClass} value={draft.expenseAccount} onChange={(e) => setDraft({ ...draft, expenseAccount: e.target.value })}>{expenseAccounts.map((account) => <option key={account.id} value={account.id}>{fieldAccountLabel(account)}</option>)}</select>}</Field>
      <Field label="Accumulated depreciation account (Asset)">{(id) => <select id={id} className={inputClass} value={draft.accumAccount} onChange={(e) => setDraft({ ...draft, accumAccount: e.target.value })}><option value="">Choose contra-asset account</option>{assetAccounts.map((account) => <option key={account.id} value={account.id}>{fieldAccountLabel(account)}</option>)}</select>}</Field>
      <div className="flex items-end"><Button variant="primary" disabled={busyId === 'create' || !draft.assetAccount || !draft.expenseAccount || !draft.accumAccount}>{busyId === 'create' ? 'Saving…' : 'Save fixed asset'}</Button></div>
    </form>}
    {assets.length === 0 ? <EmptyRows>No fixed assets saved.</EmptyRows> : <div className="space-y-3">{assets.map((asset) => {
      const rows = depreciations.filter((entry) => entry.asset_id === asset.id);
      const accumulated = rows.reduce((sum, entry) => sum + amount(entry.amount), 0);
      const depreciable = Math.max(0, amount(asset.cost) - amount(asset.salvage_value));
      const monthly = Math.min(Math.round(depreciable / asset.useful_life_months * 100) / 100, depreciable - accumulated);
      return <article key={asset.id} className="rounded-xl border border-[var(--separator)] bg-[var(--bg)] p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{asset.name}</h3><p className="text-[12px] text-[var(--label-secondary)]">Purchased {asset.purchase_date} · Cost {formatNpr(amount(asset.cost), 'NPR')} · Life {asset.useful_life_months} months</p><p className="mt-1 text-[12px]">Posted depreciation {formatNpr(accumulated, 'NPR')} · Remaining depreciable amount {formatNpr(Math.max(0, depreciable - accumulated), 'NPR')}</p></div><div className="flex flex-wrap items-end gap-2">{!readOnly && <><input aria-label={`Depreciation month for ${asset.name}`} type="month" className={`${inputClass} w-auto`} value={month} onChange={(e) => setMonth(e.target.value)} /><Button variant="secondary" disabled={busyId === asset.id || monthly <= 0} onClick={() => void postDepreciation(asset)}>{busyId === asset.id ? 'Posting…' : `Post ${formatNpr(monthly, 'NPR')}`}</Button></>}</div></div>{rows.length > 0 && <ul className="mt-3 space-y-1 border-t border-[var(--separator)] pt-3 text-[12px] text-[var(--label-secondary)]">{rows.map((row) => <li key={row.id}>{row.period_end} · {formatNpr(amount(row.amount), 'NPR')} · journal {row.journal_entry_id.slice(0, 8)}</li>)}</ul>}</article>;
    })}</div>}
  </section>;
}
