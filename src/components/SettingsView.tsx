import React, { useEffect, useState } from 'react';
import { Download, Plus, Upload } from 'lucide-react';
import { AccountType } from '../types';
import { Books } from '../state/useBooks';
import { Badge, Button, Callout, Field, inputClass, Modal, Money } from './ui';
import { downloadJson } from '../lib/csv';
import { BS_MONTHS, adToBs, formatAd, formatBs, fiscalYearOf, todayNpt } from '../lib/nepaliDate';
import { isSupported, unsupportedMessage } from '../lib/capabilities';
import { SIGN_OUT_HINTS, SIGN_OUT_LABELS } from '../lib/session';
import type { SignOutKind } from '../lib/session';
import type { CalendarPreference } from '../lib/preferences';

/**
 * Settings.
 *
 * Two things changed here in Stage 19, both about putting a control where the
 * person looks for it:
 *
 *  - Currency and date had been toggles in the top bar of every screen. They
 *    are configuration, so they now live together in one "Currency & date"
 *    section.
 *  - The payment-gateway panel was showing provider setup (merchant code, live
 *    vs sandbox, which secret was loaded) inside general business settings. The
 *    gateway is server configuration, not a book setting, and the browser has
 *    no business reading it — the panel is gone. The API and its authenticated
 *    routes are untouched; online collection is offered from the collection
 *    flow itself, and only where a payment server is actually deployed.
 */
export const SettingsView: React.FC<{
  books: Books; onDone: (m: string, ok: boolean) => void;
  /** Which calendar dates are written in, and where to change it. */
  calendar: CalendarPreference; onCalendarChange: (next: CalendarPreference) => void;
  /** Ends the session. 'this-device' leaves other devices signed in. */
  onSignOut: (kind: SignOutKind) => Promise<void>;
  signingOut: boolean;
}> = ({ books, onDone, calendar, onCalendarChange, onSignOut, signingOut }) => {
  const { business, accounts, balances, user } = books;
  const [form, setForm] = useState(business);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ code: '', name: '', type: 'EXPENSE' as AccountType, description: '' });
  const [accountError, setAccountError] = useState<string | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);
  const [archivingAccountId, setArchivingAccountId] = useState<string | null>(null);
  const [confirmSignOutEverywhere, setConfirmSignOutEverywhere] = useState(false);

  // Re-seed the form if a different business is loaded.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setForm(business); }, [business.id]);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setSaveError(null);
    if (!form.businessName.trim()) { setSaveError('Business name is required.'); return; }
    if (form.panNumber && !/^\d{9}$/.test(form.panNumber)) {
      setSaveError('A Nepali PAN is nine digits.'); return;
    }
    setSaving(true);
    const result = await books.saveBusinessSettings(form);
    setSaving(false);
    if (!result.ok) { setSaveError(result.message); return; }
    onDone(result.message, true);
  };

  const fy = fiscalYearOf(todayNpt(), form.fiscalYearStartMonth);

  const exportBackup = () => {
    downloadJson(`ZeyksBook_backup_${todayNpt()}.json`, books.snapshot());
    onDone('Backup downloaded. Keep it somewhere safe.', true);
  };

  const saveAccount = async () => {
    if (savingAccount) return;
    setSavingAccount(true);
    setAccountError(null);
    const result = editingAccountId
      ? await books.updateAccount(editingAccountId, draft)
      : await books.addAccount(draft);
    setSavingAccount(false);
    if (!result.ok) { setAccountError(result.message); return; }
    setShowNewAccount(false);
    setEditingAccountId(null);
    setDraft({ code: '', name: '', type: 'EXPENSE', description: '' });
    setAccountError(null);
    onDone(result.message, true);
  };

  const Section: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({ title, hint, children }) => (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-[var(--label)]">{title}</h2>
        {hint && <p className="text-xs text-[var(--label-secondary)] mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
  );

  return (
    <div className="max-w-3xl mx-auto py-6 px-4 sm:px-6 space-y-10">
      {/* Currency and date, together and in one place. The symbol is a fact
          about the business (it is stored on the business record and prints on
          statements); the calendar is how this device writes dates. */}
      <Section
        title="Currency & date"
        hint="How amounts and dates are written in the app. Reports always print the ISO code NPR."
      >
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Currency" hint="Nepalese rupees. Used on every screen amount.">
            {(id) => (
              <select id={id} className={inputClass} value={form.currencySymbol}
                onChange={(e) => set('currencySymbol', e.target.value as typeof form.currencySymbol)}>
                <option value="NPR">NPR — Rs 1,20,000</option>
                <option value="रू">रू — रू 1,20,000</option>
              </select>
            )}
          </Field>
          <Field
            label="Date format"
            hint={`Today is ${formatAd(todayNpt())} AD, or ${formatBs(adToBs(todayNpt()))} BS.`}
          >
            {(id) => (
              <select id={id} className={inputClass} value={calendar}
                onChange={(e) => onCalendarChange(e.target.value as CalendarPreference)}>
                <option value="BS">Bikram Sambat (BS), with the AD date beside it</option>
                <option value="AD">Gregorian (AD), with the BS date beside it</option>
              </select>
            )}
          </Field>
        </div>
        <p className="text-[11px] text-zinc-500">
          The date format is kept on this device, and applies as soon as you choose it. It changes
          how dates are written, never what is stored: the ledger records one date per entry either
          way, and a printed statement always shows both calendars.
        </p>
        {saveError && <Callout tone="error">{saveError}</Callout>}
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </Section>

      <Section title="Business details" hint="These appear on every report and invoice you print.">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Business name" required>
            {(id) => <input id={id} className={inputClass} value={form.businessName}
              onChange={(e) => set('businessName', e.target.value)} />}
          </Field>
          <Field label="Owner">
            {(id) => <input id={id} className={inputClass} value={form.ownerName}
              onChange={(e) => set('ownerName', e.target.value)} />}
          </Field>
          <Field label="PAN / VAT number" hint="Nine digits"
            error={form.panNumber && !/^\d{9}$/.test(form.panNumber) ? 'A Nepali PAN is nine digits.' : undefined}>
            {(id) => <input id={id} className={inputClass} value={form.panNumber} inputMode="numeric" maxLength={9}
              onChange={(e) => set('panNumber', e.target.value.replace(/\D/g, ''))} />}
          </Field>
          <Field label="Phone">
            {(id) => <input id={id} className={inputClass} value={form.phone} onChange={(e) => set('phone', e.target.value)} />}
          </Field>
          <Field label="Email">
            {(id) => <input id={id} type="email" className={inputClass} value={form.email}
              onChange={(e) => set('email', e.target.value)} />}
          </Field>
          <Field label="City">
            {(id) => <input id={id} className={inputClass} value={form.city} onChange={(e) => set('city', e.target.value)} />}
          </Field>
          <div className="sm:col-span-2">
            <Field label="Address">
              {(id) => <input id={id} className={inputClass} value={form.address} onChange={(e) => set('address', e.target.value)} />}
            </Field>
          </div>
        </div>
      </Section>

      <Section title="Fiscal year" hint={`Currently FY ${fy.label} — ${fy.startAd} to ${fy.endAd}.`}>
        <Field label="Year starts in" hint="Nepal's statutory fiscal year opens on Shrawan 1.">
          {(id) => (
            <select id={id} className={`${inputClass} max-w-xs`} value={form.fiscalYearStartMonth}
              onChange={(e) => set('fiscalYearStartMonth', Number(e.target.value))}>
              {BS_MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}{i === 3 ? ' (standard)' : ''}</option>
              ))}
            </select>
          )}
        </Field>
      </Section>

      <Section title="Tax and stock">
        <label className="flex items-start gap-2.5 rounded-md border border-[var(--separator)] bg-[var(--fill-secondary)] px-3 py-2.5">
          <input type="checkbox" checked={form.vatRegistered} className="mt-0.5 rounded border-[var(--separator)]"
            onChange={(e) => set('vatRegistered', e.target.checked)} />
          <span className="text-xs">
            <span className="font-medium text-[var(--label)]">Registered for VAT</span>
            <span className="block text-[var(--label-secondary)] mt-0.5">
              Splits output tax into VAT payable and input tax into VAT receivable, and turns on the VAT return report.
            </span>
          </span>
        </label>
        {form.vatRegistered && (
          <Field label="VAT rate" hint="Nepal's standard rate is 13%.">
            {(id) => <input id={id} type="number" min="0" max="100" step="0.5" className={`${inputClass} max-w-[8rem]`}
              value={form.vatRate} onChange={(e) => set('vatRate', Number(e.target.value))} />}
          </Field>
        )}
        <label className="flex items-start gap-2.5 rounded-md border border-[var(--separator)] bg-[var(--fill-secondary)] px-3 py-2.5">
          <input type="checkbox" checked={form.trackInventory} className="mt-0.5 rounded border-[var(--separator)]"
            onChange={(e) => set('trackInventory', e.target.checked)} />
          <span className="text-xs">
            <span className="font-medium text-[var(--label)]">Track inventory</span>
            <span className="block text-[var(--label-secondary)] mt-0.5">
              Purchases become an asset and only hit the profit and loss when the goods are sold. Leave this off
              to expense stock on the day you buy it.
            </span>
          </span>
        </label>
        {saveError && <Callout tone="error">{saveError}</Callout>}
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </Section>

      <Section title="Chart of accounts" hint="Codes drive the posting rules. System accounts cannot be removed.">
        <div className="flex justify-end">
          <Button
            onClick={() => setShowNewAccount(true)}
            disabled={!isSupported('accounts')}
            title={isSupported('accounts') ? undefined : unsupportedMessage('Adding an account')}
          >
            <Plus size={13} aria-hidden="true" /> Add account
          </Button>
        </div>
        {!isSupported('accounts') && (
          <Callout tone="warn">{unsupportedMessage('Editing the chart of accounts')}</Callout>
        )}
        <div className="overflow-x-auto border border-[var(--separator)] rounded-lg bg-[var(--bg)]">
          <table className="w-full text-xs">
            <thead className="bg-[var(--fill-secondary)] text-[var(--label-secondary)] border-b border-[var(--separator)]">
              <tr>
                <th scope="col" className="py-2 px-3 text-left font-medium">Code</th>
                <th scope="col" className="py-2 px-3 text-left font-medium">Name</th>
                <th scope="col" className="py-2 px-3 text-left font-medium">Type</th>
                <th scope="col" className="py-2 px-3 text-right font-medium">Balance</th>
                <th scope="col" className="py-2 px-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--separator)]">
              {accounts.filter((a) => a.isActive).map((a) => (
                <tr key={a.id}>
                  <td className="py-2 px-3 tabular-nums text-[var(--label-secondary)]">{a.code}</td>
                  <td className="py-2 px-3">
                    {a.name} {a.systemAccount && <Badge>system</Badge>}
                  </td>
                  <td className="py-2 px-3 text-[var(--label-secondary)]">{a.type.toLowerCase()}</td>
                  <td className="py-2 px-3 text-right">
                    <Money value={balances[a.id] ?? 0} symbol={business.currencySymbol} size="sm" muted />
                  </td>
                  <td className="py-2 px-3 text-right">
                    <div className="flex justify-end gap-1">
                      {!a.systemAccount && (
                        <Button variant="ghost" disabled={!isSupported('accounts') || savingAccount || archivingAccountId !== null}
                          onClick={() => {
                            setEditingAccountId(a.id);
                            setDraft({ code: a.code, name: a.name, type: a.type, description: a.description ?? '' });
                            setAccountError(null);
                            setShowNewAccount(true);
                          }}>
                          Edit
                        </Button>
                      )}
                      <Button variant="ghost"
                        disabled={!isSupported('accounts') || a.systemAccount || archivingAccountId !== null || savingAccount}
                        onClick={async () => {
                          setArchivingAccountId(a.id);
                          const result = await books.archiveAccount(a.id);
                          setArchivingAccountId(null);
                          onDone(result.message, result.ok);
                        }}>
                        {archivingAccountId === a.id ? 'Archiving…' : 'Archive'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Backup" hint="Your books live in the cloud. Export downloads a copy.">
        <Callout tone="info">
          A backup is a snapshot of your cloud books. Restoring from a file is not available yet — it needs a
          cloud import path so it cannot overwrite or duplicate your real data.
        </Callout>
        <div className="flex flex-wrap gap-2">
          <Button onClick={exportBackup}><Download size={13} aria-hidden="true" /> Export backup</Button>
          <Button
            disabled={!isSupported('restore')}
            title={isSupported('restore') ? undefined : unsupportedMessage('Restoring a backup')}
          >
            <Upload size={13} aria-hidden="true" /> Restore from backup
          </Button>
        </div>
      </Section>

      <Section
        title="Account"
        hint="Your books are stored against this sign-in. Signing out here does not delete anything."
      >
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--separator)] bg-[var(--fill-secondary)] px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs text-[var(--label-secondary)]">Signed in as</p>
            <p className="text-xs font-medium text-[var(--label)] truncate">
              {user?.email || user?.fullName || 'your account'}
            </p>
            <p className="text-xs text-[var(--label-secondary)] mt-1">{SIGN_OUT_HINTS['this-device']}</p>
          </div>
          <Button
            variant="secondary"
            disabled={signingOut}
            onClick={() => { void onSignOut('this-device'); }}
          >
            {signingOut ? 'Signing out…' : SIGN_OUT_LABELS['this-device']}
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--destructive-bg)] bg-[var(--destructive-bg)]/40 px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--label)]">{SIGN_OUT_LABELS.everywhere}</p>
            <p className="text-xs text-[var(--label-secondary)] mt-1">{SIGN_OUT_HINTS.everywhere}</p>
          </div>
          <Button
            variant="danger"
            disabled={signingOut}
            onClick={() => setConfirmSignOutEverywhere(true)}
          >
            {SIGN_OUT_LABELS.everywhere}
          </Button>
        </div>
      </Section>

      <Section title="Danger zone" hint="Destructive actions are disabled while your books are cloud-backed.">
        <Callout tone="warn">
          {unsupportedMessage('Erasing everything')} Your financial data lives in a private cloud database, and nothing in the
          app can delete it.
        </Callout>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            disabled={!isSupported('erase')}
            title={isSupported('erase') ? undefined : unsupportedMessage('Erasing everything')}
          >
            Erase everything
          </Button>
        </div>
      </Section>

      <Modal
        isOpen={confirmSignOutEverywhere}
        onClose={() => setConfirmSignOutEverywhere(false)}
        title={SIGN_OUT_LABELS.everywhere}
        size="sm"
        description={SIGN_OUT_HINTS.everywhere}
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmSignOutEverywhere(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={signingOut}
              onClick={() => {
                setConfirmSignOutEverywhere(false);
                void onSignOut('everywhere');
              }}
            >
              {signingOut ? 'Signing out…' : 'Sign out on every device'}
            </Button>
          </div>
        }
      >
        <p className="text-xs text-zinc-600">
          Every device signed in to this account — including your phone — will be signed out and will need the
          password again. Nothing in your books is changed.
        </p>
      </Modal>

      <Modal isOpen={showNewAccount} onClose={() => setShowNewAccount(false)} title={editingAccountId ? 'Edit account' : 'Add an account'} size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setShowNewAccount(false)} disabled={savingAccount}>Cancel</Button>
            <Button variant="primary" onClick={() => void saveAccount()} disabled={savingAccount}>
              {savingAccount ? 'Saving…' : editingAccountId ? 'Save changes' : 'Add account'}
            </Button>
          </div>
        }>
        <div className="space-y-3">
          {accountError && <Callout tone="error">{accountError}</Callout>}
          <Field label="Code" required hint={editingAccountId ? 'Account codes cannot be changed after creation.' : 'Four digits. 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx expenses.'}>
            {(id) => <input id={id} className={inputClass} value={draft.code} inputMode="numeric" maxLength={4} disabled={Boolean(editingAccountId) || savingAccount}
              onChange={(e) => setDraft({ ...draft, code: e.target.value.replace(/\D/g, '') })} />}
          </Field>
          <Field label="Name" required>
            {(id) => <input id={id} className={inputClass} value={draft.name} disabled={savingAccount}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}
          </Field>
          <Field label="Type" required>
            {(id) => (
              <select id={id} className={inputClass} value={draft.type} disabled={Boolean(editingAccountId) || savingAccount}
                onChange={(e) => setDraft({ ...draft, type: e.target.value as AccountType })}>
                {(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as AccountType[]).map((t) => (
                  <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Description">
            {(id) => <input id={id} className={inputClass} value={draft.description} disabled={savingAccount}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}
          </Field>
        </div>
      </Modal>
    </div>
  );
};
