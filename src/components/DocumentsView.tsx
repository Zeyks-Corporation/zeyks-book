import React, { useMemo, useState } from 'react';
import { Ban, CreditCard, FileText, HandCoins, Plus, Zap } from 'lucide-react';
import { Expense, Payment, Purchase, Sale } from '../types';
import { Books } from '../state/useBooks';
import { Badge, Button, Callout, Column, DataTable, DualDate, EmptyState, Modal, Money } from './ui';
import { outstandingOn } from '../services/posting';
import { isSupported, isVoidable, unsupportedMessage } from '../lib/capabilities';
import { paymentVoidBlockedReason } from '../lib/paymentState';
import { DocumentPrintView } from './DocumentPrintView';
import type { PrintableDocumentKind } from './DocumentPrintView';

type Kind = 'sales' | 'purchases' | 'expenses' | 'payments';
type AnyDoc = Sale | Purchase | Expense | Payment;

/** Sales, purchases and expenses are cloud-backed; the rest are read-only until their RPCs exist. */
const CAPABILITY_FOR_KIND = {
  sales: 'sales', purchases: 'purchases', expenses: 'expenses', payments: 'payments',
} as const;

const isVoided = (d: AnyDoc): boolean => ('docStatus' in d ? d.docStatus : d.status) === 'VOIDED';

export const DocumentsView: React.FC<{
  kind: Kind; books: Books; calendar: 'BS' | 'AD';
  readOnly?: boolean;
  onNew: () => void; onCollect: (saleId: string) => void;
  onReceive: (saleId: string) => void;
  onSettle: (purchaseId: string) => void;
  onDone: (message: string, ok: boolean) => void;
}> = ({ kind, books, calendar, readOnly = false, onNew, onCollect, onReceive, onSettle, onDone }) => {
  const { business, sales, purchases, expenses, payments } = books;
  const symbol = business.currencySymbol;
  const [voiding, setVoiding] = useState<{ id: string; label: string } | null>(null);
  const [voidError, setVoidError] = useState<string | null>(null);
  // One void at a time: a second click while the RPC is in flight must not post
  // a second reversal.
  const [voidBusy, setVoidBusy] = useState(false);
  // Which record is open as a printable document. Read-only: the printed sheet
  // shows persisted state and cannot change any of it.
  const [printing, setPrinting] = useState<string | null>(null);

  const PRINT_KIND: Record<Kind, PrintableDocumentKind> = {
    sales: 'sale', purchases: 'purchase', payments: 'payment', expenses: 'expense',
  };

  const printButton = (d: AnyDoc, label: string) => (
    <Button variant="ghost" aria-label={`Print ${label}`}
      title={`View ${label} as a printable document`}
      onClick={(e) => { e.stopPropagation(); setPrinting(d.id); }}>
      <FileText size={13} aria-hidden="true" />
    </Button>
  );

  const canCreate = !readOnly && isSupported(CAPABILITY_FOR_KIND[kind]);
  const canVoid = !readOnly && isVoidable(kind);
  const canCollect = !readOnly && isSupported('gateway');
  const canSettle = !readOnly && isSupported('payments');
  const canReceive = !readOnly && isSupported('payments');

  const rows = useMemo<AnyDoc[]>(() => {
    const list = { sales, purchases, expenses, payments }[kind] as AnyDoc[];
    return [...list].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  }, [kind, sales, purchases, expenses, payments]);

  const singular = { sales: 'sale', purchases: 'purchase', expenses: 'expense', payments: 'payment' }[kind] as
    'sale' | 'purchase' | 'expense' | 'payment';

  // A settlement is voided through its own RPC (void_payment); documents go
  // through void_document. Both are server-authoritative.
  const confirmVoid = async () => {
    if (readOnly || !voiding || voidBusy) return;
    setVoidBusy(true);
    try {
      const result = singular === 'payment'
        ? await books.voidPayment(voiding.id)
        : await books.voidDocument(singular, voiding.id);
      if (!result.ok) { setVoidError(result.message); return; }
      onDone(result.message, true);
      setVoiding(null); setVoidError(null);
    } finally {
      setVoidBusy(false);
    }
  };

  const statusBadge = (d: AnyDoc) => {
    if (isVoided(d)) return <Badge tone="neutral">voided</Badge>;
    if ('paymentStatus' in d) {
      const tone = d.paymentStatus === 'PAID' ? 'green' : d.paymentStatus === 'UNPAID' ? 'rose' : 'amber';
      return <Badge tone={tone}>{d.paymentStatus.replace('_', ' ').toLowerCase()}</Badge>;
    }
    if ('status' in d && typeof d.status === 'string' && d.status !== 'POSTED') {
      return <Badge tone="neutral">{d.status.toLowerCase()}</Badge>;
    }
    return <Badge tone="green">posted</Badge>;
  };

  const voidButton = (d: AnyDoc, label: string) => {
    // A settlement recorded as part of its document cannot be reversed on its
    // own, so its button is dimmed with the reason rather than failing later.
    const blocked = singular === 'payment'
      ? paymentVoidBlockedReason(d as Payment, { sales, purchases })
      : null;
    const title = !canVoid
      ? unsupportedMessage(singular === 'payment' ? 'Voiding a settlement' : 'Voiding this document')
      : blocked ?? undefined;

    return (
      <Button variant="ghost" disabled={isVoided(d) || !canVoid || blocked !== null}
        aria-label={`Void ${label}`} title={title}
        onClick={(e) => { e.stopPropagation(); setVoiding({ id: d.id, label }); setVoidError(null); }}>
        <Ban size={13} aria-hidden="true" />
      </Button>
    );
  };

  const columns: Record<Kind, Column<AnyDoc>[]> = {
    sales: [
      { key: 'date', header: 'Date', render: (d) => <DualDate iso={d.date} calendar={calendar} /> },
      { key: 'ref', header: 'Invoice', render: (d) => <span className="font-medium">{(d as Sale).invoiceNumber}</span> },
      { key: 'party', header: 'Customer', render: (d) => (d as Sale).customerName },
      { key: 'status', header: 'Status', render: statusBadge },
      { key: 'due', header: 'Outstanding', align: 'right',
        render: (d) => { const s = d as Sale; const due = outstandingOn(s);
          return isVoided(s) || due <= 0 ? <span className="text-zinc-300">—</span> : <Money value={due} symbol={symbol} size="sm" />; } },
      { key: 'total', header: 'Total', align: 'right', render: (d) => <Money value={(d as Sale).totalAmount} symbol={symbol} size="sm" /> },
      { key: 'actions', header: '', align: 'right', width: '8rem',
        render: (d) => { const s = d as Sale; const due = outstandingOn(s);
          return (
            <div className="flex justify-end gap-0.5">
              {/* Record money that already arrived (hand, bank or a wallet the
                  customer already transferred to). This is NOT the gateway:
                  collecting online creates a real provider payment the
                  customer completes on eSewa's or Khalti's own page, and it
                  only reaches the books once the SERVER has verified it. The
                  two actions are deliberately different icons and labels. */}
              {!isVoided(s) && due > 0 && (
                <Button variant="ghost" disabled={!canReceive}
                  aria-label={`Receive payment for ${s.invoiceNumber}`}
                  title={canReceive
                    ? `Record a manual receipt against ${s.invoiceNumber}`
                    : unsupportedMessage('Recording a settlement')}
                  onClick={(e) => { e.stopPropagation(); onReceive(s.id); }}>
                  <HandCoins size={13} aria-hidden="true" />
                </Button>
              )}
              {!isVoided(s) && due > 0 && (
                <Button variant="ghost" disabled={!canCollect}
                  aria-label={`Collect ${s.invoiceNumber} online`}
                  title={canCollect ? undefined : unsupportedMessage('Collecting online')}
                  onClick={(e) => { e.stopPropagation(); onCollect(s.id); }}>
                  <Zap size={13} aria-hidden="true" />
                </Button>
              )}
              {printButton(s, s.invoiceNumber)}
              {voidButton(s, s.invoiceNumber)}
            </div>
          ); } },
    ],
    purchases: [
      { key: 'date', header: 'Date', render: (d) => <DualDate iso={d.date} calendar={calendar} /> },
      { key: 'ref', header: 'Reference', render: (d) => <span className="font-medium">{(d as Purchase).referenceNumber}</span> },
      { key: 'party', header: 'Supplier', render: (d) => (d as Purchase).supplierName },
      { key: 'status', header: 'Status', render: statusBadge },
      { key: 'due', header: 'Outstanding', align: 'right',
        render: (d) => { const p = d as Purchase; const due = outstandingOn(p);
          return isVoided(p) || due <= 0 ? <span className="text-zinc-300">—</span> : <Money value={due} symbol={symbol} size="sm" />; } },
      { key: 'total', header: 'Total', align: 'right', render: (d) => <Money value={(d as Purchase).totalAmount} symbol={symbol} size="sm" /> },
      { key: 'actions', header: '', align: 'right', width: '6rem',
        render: (d) => { const p = d as Purchase; const due = outstandingOn(p);
          return (
            <div className="flex justify-end gap-0.5">
              {/* Paying a bill is the mirror of collecting an invoice: the row
                  opens the settlement form on this document. The amount is
                  still derived from the server's own recomputed balance. */}
              {!isVoided(p) && due > 0 && (
                <Button variant="ghost" disabled={!canSettle}
                  aria-label={`Pay ${p.referenceNumber}`}
                  title={canSettle ? `Record a payment against ${p.referenceNumber}` : unsupportedMessage('Recording a settlement')}
                  onClick={(e) => { e.stopPropagation(); onSettle(p.id); }}>
                  <CreditCard size={13} aria-hidden="true" />
                </Button>
              )}
              {printButton(p, p.referenceNumber)}
              {voidButton(p, p.referenceNumber)}
            </div>
          ); } },
    ],
    expenses: [
      { key: 'date', header: 'Date', render: (d) => <DualDate iso={d.date} calendar={calendar} /> },
      { key: 'ref', header: 'Reference', render: (d) => <span className="font-medium">{(d as Expense).reference}</span> },
      { key: 'cat', header: 'Category', render: (d) => (d as Expense).categoryName },
      { key: 'desc', header: 'Detail', render: (d) => <span className="text-zinc-600">{(d as Expense).description}</span> },
      { key: 'status', header: 'Status', render: statusBadge },
      { key: 'total', header: 'Amount', align: 'right', render: (d) => <Money value={(d as Expense).totalAmount} symbol={symbol} size="sm" /> },
      { key: 'actions', header: '', align: 'right', width: '6rem',
        render: (d) => <div className="flex justify-end">{printButton(d, (d as Expense).reference)}{voidButton(d, (d as Expense).reference)}</div> },
    ],
    payments: [
      { key: 'date', header: 'Date', render: (d) => <DualDate iso={d.date} calendar={calendar} /> },
      { key: 'ref', header: 'Reference', render: (d) => <span className="font-medium">{(d as Payment).reference}</span> },
      { key: 'dir', header: 'Direction',
        render: (d) => <Badge tone={(d as Payment).paymentType === 'INCOMING' ? 'green' : 'blue'}>
          {(d as Payment).paymentType === 'INCOMING' ? 'received' : 'paid out'}</Badge> },
      { key: 'party', header: 'Party', render: (d) => (d as Payment).partyName },
      { key: 'method', header: 'Method', render: (d) => <span className="text-zinc-600">{(d as Payment).paymentMethod.toLowerCase()}</span> },
      { key: 'status', header: 'Status', render: statusBadge },
      { key: 'amount', header: 'Amount', align: 'right', render: (d) => <Money value={(d as Payment).amount} symbol={symbol} size="sm" /> },
      { key: 'actions', header: '', align: 'right', width: '6rem',
        render: (d) => <div className="flex justify-end">{printButton(d, (d as Payment).reference)}{voidButton(d, (d as Payment).reference)}</div> },
    ],
  };

  const searchKeys = (d: AnyDoc): string => [
    d.date,
    'invoiceNumber' in d ? d.invoiceNumber : '',
    'referenceNumber' in d ? d.referenceNumber : '',
    'reference' in d ? d.reference : '',
    'customerName' in d ? d.customerName : '',
    'supplierName' in d ? d.supplierName : '',
    'partyName' in d ? d.partyName : '',
    'categoryName' in d ? d.categoryName : '',
    'description' in d ? d.description : '',
  ].join(' ');

  const labels = {
    sales: { title: 'sales', cta: 'Record a sale' },
    purchases: { title: 'purchases', cta: 'Record a purchase' },
    expenses: { title: 'expenses', cta: 'Record an expense' },
    payments: { title: 'payments', cta: 'Record a settlement' },
  }[kind];

  return (
    <div className="max-w-5xl mx-auto py-6 px-4 sm:px-6 space-y-4">
      {readOnly && <Callout tone="warn">Starter access is read-only. Existing records remain available to view and print.</Callout>}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          {rows.length} {rows.length === 1 ? labels.title.replace(/s$/, '') : labels.title}
        </p>
        {!readOnly && <Button variant="primary" onClick={onNew} disabled={!canCreate}
          title={canCreate ? undefined : unsupportedMessage(labels.cta)}>
          <Plus size={13} aria-hidden="true" /> {labels.cta}
        </Button>}
      </div>

      {!canCreate && <Callout tone="warn">{unsupportedMessage(labels.cta)}</Callout>}

      <DataTable
        rows={rows}
        columns={columns[kind]}
        searchKeys={searchKeys}
        searchPlaceholder={`Search ${labels.title}`}
        empty={<EmptyState title={`No ${labels.title} recorded yet.`}
          action={!readOnly && <Button variant="primary" onClick={onNew} disabled={!canCreate}
            title={canCreate ? undefined : unsupportedMessage(labels.cta)}>{labels.cta}</Button>} />}
      />

      <Modal
        isOpen={voiding !== null} onClose={() => setVoiding(null)} title={`Void ${voiding?.label ?? ''}`} size="sm"
        description="Nothing is deleted. A reversing entry is posted so the audit trail stays complete."
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setVoiding(null)} disabled={voidBusy}>Keep it</Button>
            <Button type="button" variant="danger" disabled={voidBusy} onClick={() => { void confirmVoid(); }}>
              {voidBusy ? 'Voiding…' : 'Void and reverse'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          {voidError && <Callout tone="error">{voidError}</Callout>}
          <p className="text-xs text-zinc-500">
            A mirror reversal is posted as <span className="font-medium">REV-{voiding?.label}</span> and
            dated today, so the original entry and its reversal both stay in the ledger.
          </p>
          {singular === 'payment' && (
            <p className="text-xs text-zinc-500">
              The invoice or bill it settled stays posted and simply shows that money as outstanding again.
              The settlement itself is kept in the list, marked voided.
            </p>
          )}
        </div>
      </Modal>

      {printing && (
        <DocumentPrintView
          kind={PRINT_KIND[kind]}
          documentId={printing}
          books={books}
          calendar={calendar}
          onClose={() => setPrinting(null)}
        />
      )}
    </div>
  );
};
