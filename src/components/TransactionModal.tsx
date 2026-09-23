import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { LineItem, PaymentMethod } from '../types';
import { Books } from '../state/useBooks';
import { Button, Callout, DateField, Field, inputClass, Modal, Money } from './ui';
import { outstandingOn } from '../services/posting';
import { parseAmount, round2, splitVat } from '../lib/money';
import { newId } from '../lib/ids';
import { addDays, isIsoDate, todayNpt } from '../lib/nepaliDate';
import { isSupported, unsupportedMessage } from '../lib/capabilities';
import type { Capability } from '../lib/capabilities';

export type TxnKind = 'sale' | 'purchase' | 'expense' | 'payment';

const CAPABILITY_FOR_KIND: Record<TxnKind, Capability> = {
  sale: 'sales', purchase: 'purchases', expense: 'expenses', payment: 'payments',
};

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'CASH', label: 'Cash' },
  { value: 'BANK', label: 'Bank' },
  { value: 'ESEWA', label: 'eSewa' },
  { value: 'KHALTI', label: 'Khalti' },
];

const blankItem = (): LineItem => ({
  id: newId('li'), description: '', quantity: 1, unitPrice: 0, discount: 0, total: 0,
});

/**
 * The credit terms a document can be posted under, as whole days.
 *
 * Offered as one select rather than a free number field because these are the
 * terms a small business actually agrees, and a mistyped 300 instead of 30 is a
 * year of silent lateness. "Other" reveals the number field for anything the
 * list does not cover. 0 is cash terms — due immediately.
 */
const TERM_CHOICES = [
  { value: '0', label: 'Due immediately' },
  { value: '7', label: 'Net 7 days' },
  { value: '15', label: 'Net 15 days' },
  { value: '30', label: 'Net 30 days' },
  { value: '45', label: 'Net 45 days' },
  { value: '60', label: 'Net 60 days' },
  { value: '90', label: 'Net 90 days' },
] as const;
const TERMS_MAX_DAYS = 3650;

export const TransactionModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  kind: TxnKind;
  books: Books;
  calendar: 'BS' | 'AD';
  /**
   * Opened from a document's own row ("Pay" on a bill, "Record a payment" on an
   * invoice): the settlement is for THAT document, so the direction and the
   * document are filled in for the person rather than left to be re-chosen.
   */
  preselectDocumentId?: string;
  preselectDirection?: 'INCOMING' | 'OUTGOING';
  onDone: (message: string, ok: boolean) => void;
}> = ({ isOpen, onClose, kind, books, calendar, preselectDocumentId, preselectDirection, onDone }) => {
  const { business, accounts, customers, suppliers, openInvoices, openBills } = books;
  const today = todayNpt();

  const [date, setDate] = useState(today);
  const [items, setItems] = useState<LineItem[]>([blankItem()]);
  const [partyName, setPartyName] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [settlement, setSettlement] = useState<'PAID' | 'CREDIT' | 'PARTIAL'>('PAID');
  const [partial, setPartial] = useState('');
  const [notes, setNotes] = useState('');
  const [taxable, setTaxable] = useState(business.vatRegistered);
  const [priceIncludesVat, setPriceIncludesVat] = useState(false);
  const [costOfGoods, setCostOfGoods] = useState('');

  // Credit terms. The ONLY due-date input the browser has: the days travel to
  // post_sale/post_purchase, which computes `date + terms` inside the posting
  // transaction. There is deliberately no due-date field here, so what this form
  // previews and what the books record cannot disagree.
  const [terms, setTerms] = useState('0');
  const [otherTerms, setOtherTerms] = useState('');

  // Expense-only
  const [expenseAccountId, setExpenseAccountId] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [description, setDescription] = useState('');

  // Payment-only
  const [direction, setDirection] = useState<'INCOMING' | 'OUTGOING'>('INCOMING');
  const [linkedDocId, setLinkedDocId] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // One retry key per user action: a network error must not mint a new key, or
  // the retry could record a second expense. It is replaced only when the
  // request itself changes, and cleared once the post succeeds.
  const expenseRetryRef = useRef<{ key: string; signature: string } | null>(null);
  // The same rule for a settlement: post_payment replays the original payment
  // for a repeated key, so the retry after a dropped connection must reuse it.
  const paymentRetryRef = useRef<{ key: string; signature: string } | null>(null);

  // Defensive: an unsupported kind must never claim to have recorded anything
  // (the buttons are already disabled, but the submit path guards too).
  const supported = isSupported(CAPABILITY_FOR_KIND[kind]);

  useEffect(() => {
    if (!isOpen) return;
    setDate(today); setItems([blankItem()]); setPartyName(''); setMethod('CASH');
    setSettlement('PAID'); setPartial(''); setNotes(''); setError(null);
    setTaxable(business.vatRegistered); setPriceIncludesVat(false); setCostOfGoods('');
    setTerms('0'); setOtherTerms('');
    // A settlement opened from a document row starts on that document, with the
    // direction its own row implied and its outstanding balance filled in — the
    // same figure and the same source (the persisted rows) the document dropdown
    // uses when the person picks one by hand. Nothing here is authority: the
    // server locks the document, recomputes the balance and re-validates the
    // date, the method, the amount and the document's status.
    const preselected = preselectDocumentId
      ? (preselectDirection === 'OUTGOING' ? openBills : openInvoices)
          .find((d) => d.id === preselectDocumentId)
      : undefined;
    setExpenseAmount(''); setDescription('');
    setDirection(preselectDirection ?? 'INCOMING');
    setLinkedDocId(preselectDocumentId ?? '');
    setPaymentAmount(preselected ? String(outstandingOn(preselected)) : '');
    setIsSubmitting(false);
    expenseRetryRef.current = null;
    paymentRetryRef.current = null;
    setExpenseAccountId(accounts.find((a) => a.type === 'EXPENSE' && a.code !== '5010' && a.isActive)?.id ?? '');
  }, [isOpen, kind, business.vatRegistered, accounts, today, preselectDocumentId, preselectDirection, openBills, openInvoices]);

  /* ----------------------------- derived totals ---------------------------- */

  const priced = useMemo(
    () => items.map((i) => ({ ...i, total: round2(Math.max(0, i.quantity * i.unitPrice - i.discount)) })),
    [items],
  );

  const totals = useMemo(() => {
    const gross = round2(priced.reduce((s, i) => s + i.total, 0));
    const discountTotal = round2(items.reduce((s, i) => s + (i.discount || 0), 0));
    const rate = taxable && business.vatRegistered ? business.vatRate : 0;
    const { net, tax, gross: total } = splitVat(gross, rate, priceIncludesVat);
    return { subtotal: net, discountTotal, taxAmount: tax, totalAmount: total };
  }, [priced, items, taxable, business.vatRegistered, business.vatRate, priceIncludesVat]);

  const expenseTotals = useMemo(() => {
    const entered = parseAmount(expenseAmount);
    const rate = taxable && business.vatRegistered ? business.vatRate : 0;
    const { net, tax, gross } = splitVat(entered, rate, priceIncludesVat);
    return { amount: net, taxAmount: tax, totalAmount: gross };
  }, [expenseAmount, taxable, business.vatRegistered, business.vatRate, priceIncludesVat]);

  const docTotal = kind === 'expense' ? expenseTotals.totalAmount : totals.totalAmount;

  const upfront = useMemo(() => {
    if (settlement === 'CREDIT') return 0;
    if (settlement === 'PARTIAL') return round2(Math.max(0, Math.min(parseAmount(partial), docTotal)));
    return docTotal;
  }, [settlement, partial, docTotal]);

  /**
   * The terms this document will be posted under, and the due date the server
   * will record from them.
   *
   * `dueDatePreview` is shown to the person before they save, but it is only a
   * preview: the date that counts is written inside post_sale/post_purchase from
   * the same two inputs (the document date and these whole days), which is why
   * the form never sends a date.
   */
  const termsDays = useMemo(() => {
    const raw = terms === 'other' ? otherTerms : terms;
    const days = Math.floor(Number(raw));
    if (!Number.isFinite(days) || days <= 0) return 0;
    return Math.min(days, TERMS_MAX_DAYS);
  }, [terms, otherTerms]);

  /** A document settled in full at posting has no credit period to record. */
  const onCredit = (kind === 'sale' || kind === 'purchase') && settlement !== 'PAID';
  const recordedTerms = onCredit ? termsDays : 0;
  /**
   * Only while the document date is a real date. A native date input empties to
   * `''` when the person clears it, and there is no due date to preview from an
   * empty document date — the form simply says nothing until one is chosen.
   * The date that counts is written server-side from the same two inputs.
   */
  const dueDatePreview = isIsoDate(date) ? addDays(date, recordedTerms) : '';

  const linkedDoc = useMemo(() => {
    if (!linkedDocId) return null;
    return direction === 'INCOMING'
      ? openInvoices.find((s) => s.id === linkedDocId) ?? null
      : openBills.find((p) => p.id === linkedDocId) ?? null;
  }, [linkedDocId, direction, openInvoices, openBills]);

  // Derived from the settlement rows, so the embedded upfront receipt is
  // already netted off. A friendly pre-check only — the server recomputes this
  // under a lock and stays authoritative.
  const outstanding = linkedDoc ? outstandingOn(linkedDoc) : 0;

  /* --------------------------------- items -------------------------------- */

  const updateItem = (id: string, patch: Partial<LineItem>) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const addItem = () => setItems((prev) => [...prev, blankItem()]);
  const removeItem = (id: string) =>
    setItems((prev) => (prev.length === 1 ? prev : prev.filter((i) => i.id !== id)));

  /* -------------------------------- submit -------------------------------- */

  const validate = (): string | null => {
    if (!date) return 'Pick a date.';
    if (date > today) return 'A transaction cannot be dated in the future.';

    if (kind === 'sale' || kind === 'purchase') {
      if (docTotal <= 0) return 'Add at least one line with a value above zero.';
      if (priced.some((i) => i.quantity <= 0)) return 'Quantity must be above zero on every line.';
      if (priced.some((i) => i.unitPrice < 0 || i.discount < 0)) return 'Prices and discounts cannot be negative.';
      if (priced.some((i) => i.discount > i.quantity * i.unitPrice)) return 'A discount cannot exceed the line value.';
      if (settlement === 'PARTIAL' && upfront <= 0) return 'Enter how much was settled, or choose Credit.';
      if (terms === 'other') {
        if (otherTerms.trim() === '') return 'Enter the days of credit, or choose terms from the list.';
        if (termsDays > TERMS_MAX_DAYS) return `Terms cannot exceed ${TERMS_MAX_DAYS} days.`;
      }
      if (kind === 'sale' && business.trackInventory) {
        const cost = parseAmount(costOfGoods);
        if (cost < 0) return 'Cost of goods cannot be negative.';
      }
    }
    if (kind === 'expense') {
      if (!expenseAccountId) return 'Choose an expense category.';
      if (expenseTotals.totalAmount <= 0) return 'Enter an amount above zero.';
      if (!description.trim()) return 'Describe what this expense was for.';
    }
    if (kind === 'payment') {
      const amount = parseAmount(paymentAmount);
      if (amount <= 0) return 'Enter an amount above zero.';
      // A settlement is always against a persisted document: post_payment is
      // handed the document id and derives everything else from it.
      if (!linkedDocId) return 'Pick the document this settlement settles.';
      // A friendly pre-check only. The server locks the document and recomputes
      // the real outstanding balance, so it stays authoritative either way.
      if (linkedDoc && amount > outstanding + 0.005) {
        return `Only NPR ${outstanding.toFixed(2)} is outstanding on that document.`;
      }
    }
    return null;
  };

  /**
   * Keep exactly one idempotency key per user action.
   *
   * A retry after a network error must reuse the key so the server can replay
   * the original document instead of creating a second expense. Editing the
   * request mints a new key, because a changed payload is a different document
   * rather than a retry of the first one.
   */
  const expenseIdempotencyKey = (): string => {
    const signature = JSON.stringify([
      expenseAccountId, date, expenseTotals.amount, expenseTotals.taxAmount,
      expenseTotals.totalAmount, method, description.trim(), notes.trim(),
      business.vatRegistered && taxable ? priceIncludesVat : false,
    ]);
    if (!expenseRetryRef.current || expenseRetryRef.current.signature !== signature) {
      expenseRetryRef.current = { key: newId('exp'), signature };
    }
    return expenseRetryRef.current.key;
  };

  /**
   * The settlement equivalent: one key per user action, reused by every retry of
   * the same request so the server replays instead of settling twice.
   */
  const paymentIdempotencyKey = (): string => {
    const signature = JSON.stringify([
      direction, linkedDocId, date, parseAmount(paymentAmount), method, notes.trim(),
    ]);
    if (!paymentRetryRef.current || paymentRetryRef.current.signature !== signature) {
      paymentRetryRef.current = { key: newId('pay'), signature };
    }
    return paymentRetryRef.current.key;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!supported) { setError(unsupportedMessage(titles[kind])); return; }
    const problem = validate();
    if (problem) { setError(problem); return; }
    setError(null);
    setIsSubmitting(true);
    try {
      let result;
      if (kind === 'sale') {
        result = await books.addSale({
          customerName: partyName.trim() || 'Walk-in customer',
          date, items: priced, ...totals, upfrontPaid: upfront, paymentMethod: method,
          // Whole days of credit only — never the due date they imply.
          paymentTermsDays: recordedTerms,
          costOfGoods: business.trackInventory ? parseAmount(costOfGoods) : undefined,
          notes: notes.trim() || undefined,
        });
      } else if (kind === 'purchase') {
        result = await books.addPurchase({
          supplierName: partyName.trim() || 'General vendor',
          date, items: priced, ...totals, upfrontPaid: upfront, paymentMethod: method,
          // Same rule on the supplier side: terms travel, the due date does not.
          paymentTermsDays: recordedTerms,
          // The RPC validates the tax against this mode, so it must travel with
          // the amounts rather than be re-inferred server-side.
          priceIncludesVat: business.vatRegistered && taxable ? priceIncludesVat : false,
          notes: notes.trim() || undefined,
        });
      } else if (kind === 'expense') {
        // The category name and the reference are the server's to decide, so
        // neither is sent from here.
        result = await books.addExpense({
          accountId: expenseAccountId,
          date, description: description.trim(),
          amount: expenseTotals.amount, taxAmount: expenseTotals.taxAmount,
          totalAmount: expenseTotals.totalAmount,
          paymentMethod: method,
          // The RPC validates the tax against this mode, so it must travel with
          // the amounts rather than be re-inferred server-side.
          priceIncludesVat: business.vatRegistered && taxable ? priceIncludesVat : false,
          notes: notes.trim() || undefined,
          idempotencyKey: expenseIdempotencyKey(),
        });
      } else {
        // The reference, the party snapshot, the direction, the payment status
        // and the journal entry are all the server's to decide, so only the
        // document, the amount, the method and the date travel from here.
        result = await books.addPayment({
          amount: parseAmount(paymentAmount),
          paymentMethod: method,
          date,
          linkedSaleId: direction === 'INCOMING' ? linkedDocId || undefined : undefined,
          linkedPurchaseId: direction === 'OUTGOING' ? linkedDocId || undefined : undefined,
          notes: notes.trim() || undefined,
          idempotencyKey: paymentIdempotencyKey(),
        });
      }

      if (!result.ok) { setError(result.message); return; }
      expenseRetryRef.current = null;
      paymentRetryRef.current = null;
      onDone(result.message, true);
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  const titles: Record<TxnKind, string> = {
    sale: 'New sale', purchase: 'New purchase', expense: 'New expense', payment: 'Record a settlement',
  };
  const isDoc = kind === 'sale' || kind === 'purchase';
  const openDocs = direction === 'INCOMING' ? openInvoices : openBills;

  return (
    <Modal
      isOpen={isOpen} onClose={onClose} title={titles[kind]} size={isDoc ? 'lg' : 'md'}
      description={isDoc ? 'Each line is priced separately. Totals update as you type.' : undefined}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-zinc-500">
            {kind === 'payment' ? 'Settling' : 'Total'}{' '}
            <Money value={kind === 'payment' ? parseAmount(paymentAmount) : docTotal} symbol={business.currencySymbol} />
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" form="txn-form" variant="primary" disabled={isSubmitting || !supported}
              title={supported ? undefined : unsupportedMessage(titles[kind])}>
              {isSubmitting ? 'Saving...' : `Save ${kind}`}
            </Button>
          </div>
        </div>
      }
    >
      <form id="txn-form" onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error && <Callout tone="error">{error}</Callout>}
        {!supported && <Callout tone="warn">{unsupportedMessage(titles[kind])}</Callout>}

        <div className="grid sm:grid-cols-2 gap-3">
          <DateField label="Date" value={date} onChange={setDate} calendar={calendar} max={today} required />

          {kind === 'payment' ? (
            <Field label="Direction">
              {(id) => (
                <select id={id} value={direction} className={inputClass}
                  onChange={(e) => { setDirection(e.target.value as 'INCOMING' | 'OUTGOING'); setLinkedDocId(''); }}>
                  <option value="INCOMING">Money received from a customer</option>
                  <option value="OUTGOING">Money paid to a supplier</option>
                </select>
              )}
            </Field>
          ) : kind === 'expense' ? (
            <Field label="Category" required>
              {(id) => (
                <select id={id} value={expenseAccountId} className={inputClass}
                  onChange={(e) => setExpenseAccountId(e.target.value)}>
                  <option value="">Choose a category</option>
                  {accounts.filter((a) => a.type === 'EXPENSE' && a.code !== '5010' && a.isActive)
                    .map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                </select>
              )}
            </Field>
          ) : (
            <Field label={kind === 'sale' ? 'Customer' : 'Supplier'}
              hint={kind === 'sale' ? 'Leave blank for a walk-in customer' : undefined}>
              {(id) => (
                <>
                  <input id={id} list="party-options" value={partyName} className={inputClass}
                    placeholder={kind === 'sale' ? 'Walk-in customer' : 'General vendor'}
                    onChange={(e) => setPartyName(e.target.value)} />
                  <datalist id="party-options">
                    {(kind === 'sale' ? customers : suppliers).map((p) => <option key={p.id} value={p.name} />)}
                  </datalist>
                </>
              )}
            </Field>
          )}
        </div>

        {/* ------------------------------ line items --------------------------- */}
        {isDoc && (
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-zinc-700 mb-1">Items</legend>
            <div className="hidden sm:grid grid-cols-12 gap-1.5 text-[11px] text-zinc-400 px-1">
              <span className="col-span-5">Description</span>
              <span className="col-span-2 text-right">Qty</span>
              <span className="col-span-2 text-right">Rate</span>
              <span className="col-span-2 text-right">Discount</span>
              <span className="col-span-1" />
            </div>
            {priced.map((item, idx) => (
              <div key={item.id} className="grid grid-cols-12 gap-1.5 items-center">
                <input
                  aria-label={`Item ${idx + 1} description`} className={`${inputClass} col-span-12 sm:col-span-5`}
                  placeholder={kind === 'sale' ? 'Goods sold' : 'Goods purchased'}
                  value={item.description} onChange={(e) => updateItem(item.id, { description: e.target.value })}
                />
                <input aria-label={`Item ${idx + 1} quantity`} type="number" min="0" step="any" inputMode="decimal"
                  className={`${inputClass} col-span-4 sm:col-span-2 text-right`} value={item.quantity || ''}
                  onChange={(e) => updateItem(item.id, { quantity: parseAmount(e.target.value) })} />
                <input aria-label={`Item ${idx + 1} unit price`} type="number" min="0" step="any" inputMode="decimal"
                  className={`${inputClass} col-span-4 sm:col-span-2 text-right`} value={item.unitPrice || ''}
                  onChange={(e) => updateItem(item.id, { unitPrice: parseAmount(e.target.value) })} />
                <input aria-label={`Item ${idx + 1} discount`} type="number" min="0" step="any" inputMode="decimal"
                  className={`${inputClass} col-span-3 sm:col-span-2 text-right`} value={item.discount || ''}
                  onChange={(e) => updateItem(item.id, { discount: parseAmount(e.target.value) })} />
                <button type="button" onClick={() => removeItem(item.id)} disabled={items.length === 1}
                  aria-label={`Remove item ${idx + 1}`}
                  className="col-span-1 flex justify-center text-zinc-400 hover:text-rose-600 disabled:text-zinc-200 rounded p-1">
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
            <Button type="button" onClick={addItem}><Plus size={13} aria-hidden="true" /> Add line</Button>
          </fieldset>
        )}

        {kind === 'expense' && (
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Amount" required>
              {(id) => (
                <input id={id} type="number" min="0" step="any" inputMode="decimal" className={inputClass}
                  value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} placeholder="0.00" />
              )}
            </Field>
            <Field label="What was it for" required>
              {(id) => (
                <input id={id} className={inputClass} value={description} placeholder="e.g. October electricity"
                  onChange={(e) => setDescription(e.target.value)} />
              )}
            </Field>
          </div>
        )}

        {kind === 'payment' && (
          <div className="space-y-3">
            <Field label={direction === 'INCOMING' ? 'Invoice being settled' : 'Purchase being settled'}
              hint={openDocs.length === 0 ? 'Nothing is outstanding right now.' : 'Linking keeps the document status accurate.'}>
              {(id) => (
                <select id={id} value={linkedDocId} className={inputClass}
                  onChange={(e) => {
                    setLinkedDocId(e.target.value);
                    const doc = openDocs.find((d) => d.id === e.target.value);
                    if (doc) setPaymentAmount(String(outstandingOn(doc)));
                  }}>
                  <option value="">Choose a document</option>
                  {openDocs.map((d) => {
                    const ref = 'invoiceNumber' in d ? d.invoiceNumber : d.referenceNumber;
                    const who = 'customerName' in d ? d.customerName : d.supplierName;
                    return (
                      <option key={d.id} value={d.id}>
                        {ref} — {who} — NPR {outstandingOn(d).toFixed(2)} due
                      </option>
                    );
                  })}
                </select>
              )}
            </Field>

            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Amount" required
                hint={linkedDoc ? `NPR ${outstanding.toFixed(2)} outstanding` : undefined}>
                {(id) => (
                  <input id={id} type="number" min="0" step="any" inputMode="decimal" className={inputClass}
                    value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} placeholder="0.00" />
                )}
              </Field>
            </div>
          </div>
        )}

        {/* --------------------------------- VAT ------------------------------- */}
        {business.vatRegistered && kind !== 'payment' && (
          <div className="flex flex-wrap items-center gap-4 rounded-md bg-[var(--fill-secondary)] border border-[var(--separator)] px-3 py-2">
            <label className="flex items-center gap-2 text-xs text-[var(--label)]">
              <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)}
                className="rounded border-[var(--separator)]" />
              VAT at {business.vatRate}%
            </label>
            {taxable && (
              <label className="flex items-center gap-2 text-xs text-[var(--label)]">
                <input type="checkbox" checked={priceIncludesVat} onChange={(e) => setPriceIncludesVat(e.target.checked)}
                  className="rounded border-[var(--separator)]" />
                Amounts already include VAT
              </label>
            )}
          </div>
        )}

        {business.trackInventory && kind === 'sale' && (
          <Field label="Cost of the goods sold"
            hint="What this stock cost you. Moves that value out of Inventory and into cost of sales.">
            {(id) => (
              <input id={id} type="number" min="0" step="any" inputMode="decimal" className={inputClass}
                value={costOfGoods} onChange={(e) => setCostOfGoods(e.target.value)} placeholder="0.00" />
            )}
          </Field>
        )}

        {/* ------------------------------ settlement --------------------------- */}
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Paid by">
            {(id) => (
              <select id={id} value={method} className={inputClass}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            )}
          </Field>

          {isDoc && (
            <Field label="Settlement">
              {(id) => (
                <select id={id} value={settlement} className={inputClass}
                  onChange={(e) => setSettlement(e.target.value as typeof settlement)}>
                  <option value="PAID">Settled in full</option>
                  <option value="CREDIT">On credit</option>
                  <option value="PARTIAL">Part settled</option>
                </select>
              )}
            </Field>
          )}
        </div>

        {/* ------------------------------ credit terms ------------------------ */}
        {/* A document settled in full at posting has no credit period, so the
            control appears only when something is left owing. The hint states
            the date the server will record before the person saves. */}
        {isDoc && settlement !== 'PAID' && (
          <div className="grid sm:grid-cols-2 gap-3">
            <Field
              label="Payment terms"
              hint={!dueDatePreview
                ? 'Choose a document date to see the due date.'
                : termsDays > 0
                  ? `Net ${termsDays} · due ${dueDatePreview}`
                  : `Due ${dueDatePreview} · cash terms`}
            >
              {(id) => (
                <select id={id} value={terms} className={inputClass}
                  onChange={(e) => setTerms(e.target.value)}>
                  {TERM_CHOICES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  <option value="other">Other…</option>
                </select>
              )}
            </Field>

            {terms === 'other' && (
              <Field label="Days of credit" required hint="Whole days; 0 means due immediately.">
                {(id) => (
                  <input id={id} type="number" min="0" max={TERMS_MAX_DAYS} step="1" inputMode="numeric"
                    className={inputClass} value={otherTerms}
                    onChange={(e) => setOtherTerms(e.target.value)} placeholder="e.g. 120" />
                )}
              </Field>
            )}
          </div>
        )}

        {isDoc && settlement === 'PARTIAL' && (
          <Field label="Amount settled now" required hint={`Balance of NPR ${round2(docTotal - upfront).toFixed(2)} goes on credit`}>
            {(id) => (
              <input id={id} type="number" min="0" step="any" inputMode="decimal" className={inputClass}
                value={partial} onChange={(e) => setPartial(e.target.value)} placeholder="0.00" />
            )}
          </Field>
        )}

        <Field label="Notes">
          {(id) => (
            <input id={id} className={inputClass} value={notes} placeholder="Optional"
              onChange={(e) => setNotes(e.target.value)} />
          )}
        </Field>

        {isDoc && (
          <dl className="rounded-md border border-[var(--separator)] bg-[var(--fill-secondary)] px-3 py-2 text-xs space-y-1">
            <div className="flex justify-between"><dt className="text-[var(--label-secondary)]">Subtotal</dt>
              <dd><Money value={totals.subtotal} symbol={business.currencySymbol} size="sm" /></dd></div>
            {totals.discountTotal > 0 && (
              <div className="flex justify-between"><dt className="text-[var(--label-secondary)]">Discount</dt>
                <dd><Money value={-totals.discountTotal} symbol={business.currencySymbol} size="sm" /></dd></div>
            )}
            {totals.taxAmount > 0 && (
              <div className="flex justify-between"><dt className="text-[var(--label-secondary)]">VAT {business.vatRate}%</dt>
                <dd><Money value={totals.taxAmount} symbol={business.currencySymbol} size="sm" /></dd></div>
            )}
            <div className="flex justify-between border-t border-[var(--separator)] pt-1 font-semibold text-[var(--label)]">
              <dt>Total</dt><dd><Money value={totals.totalAmount} symbol={business.currencySymbol} size="sm" /></dd></div>
          </dl>
        )}
      </form>
    </Modal>
  );
};
