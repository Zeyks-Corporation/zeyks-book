import React, { useEffect, useMemo, useRef } from 'react';
import { Printer, X } from 'lucide-react';
import { Expense, LineItem, Payment, Purchase, Sale } from '../types';
import { Books } from '../state/useBooks';
import { Button } from './ui';
import { useDialogFocus } from '../lib/dialogFocus';
import {
  ReportAmount, ReportBlock, ReportFooter, ReportHeader, ReportNote, ReportRow, ReportSection,
  ReportSheet, ReportStatus, ReportTable, reportDate, reportMoney, reportStamp,
} from './ReportShell';
import {
  documentPosition, lineTotal, orderedItems, paymentStatusLabel, paymentStatusTone, termsLabel,
} from '../services/reportData';
import { entryFor } from '../services/posting';
import { todayNpt } from '../lib/nepaliDate';

/**
 * One business record, laid out as a document you can hand to somebody.
 *
 * A report summarises a period; this represents a single invoice, bill, receipt
 * or expense voucher, reprinted in the same visual language as the statements
 * so a file of both looks like one set of papers.
 *
 * Balance rule, unchanged from the ledger: the outstanding figure is
 * `Total − SUM(COMPLETED + POSTED settlement rows)`. The posting-time
 * `postingSnapshot` is printed too, clearly labelled as the historical record,
 * because reproducing what the original document said is the whole reason it is
 * kept — it is never added to or subtracted from the balance.
 */

export type PrintableDocumentKind = 'sale' | 'purchase' | 'payment' | 'expense';

const TITLE: Record<PrintableDocumentKind, string> = {
  sale: 'Sales Invoice',
  purchase: 'Purchase Bill',
  payment: 'Payment Receipt',
  expense: 'Expense Voucher',
};

type PrintableDocument = Sale | Purchase | Payment | Expense;

const isSale = (d: PrintableDocument): d is Sale => 'invoiceNumber' in d;
const isPurchase = (d: PrintableDocument): d is Purchase => 'referenceNumber' in d;
const isPayment = (d: PrintableDocument): d is Payment => 'paymentType' in d;
const isExpense = (d: PrintableDocument): d is Expense => 'categoryName' in d;

function documentNumberOf(doc: PrintableDocument): string {
  if (isSale(doc)) return doc.invoiceNumber;
  if (isPurchase(doc)) return doc.referenceNumber;
  if (isExpense(doc)) return doc.reference;
  return (doc as Payment).reference;
}

function docStatus(doc: PrintableDocument): 'POSTED' | 'VOIDED' {
  if (isPayment(doc)) return doc.docStatus;
  return doc.status;
}

export const DocumentPrintView: React.FC<{
  kind: PrintableDocumentKind;
  documentId: string;
  books: Books;
  calendar: 'BS' | 'AD';
  onClose: () => void;
}> = ({ kind, documentId, books, calendar, onClose }) => {
  const { business, sales, purchases, payments, expenses, customers, suppliers, journalEntries } = books;

  const document = useMemo<PrintableDocument | undefined>(() => {
    if (kind === 'sale') return sales.find((s) => s.id === documentId);
    if (kind === 'purchase') return purchases.find((p) => p.id === documentId);
    if (kind === 'payment') return payments.find((p) => p.id === documentId);
    return expenses.find((e) => e.id === documentId);
  }, [kind, documentId, sales, purchases, payments, expenses]);

  const panelRef = useRef<HTMLDivElement>(null);

  // While a sheet is on screen the print job is that sheet and nothing else.
  // A CSS selector can express this, but a data attribute on <body> is explicit
  // and works the same in every browser we care about.
  useEffect(() => {
    window.document.body.dataset.printSheet = 'open';
    return () => {
      delete window.document.body.dataset.printSheet;
    };
  }, []);

  /**
   * `aria-modal="true"` on these overlays used to be a promise with nothing
   * behind it: focus stayed where it was (often on the button behind the sheet),
   * Tab walked the app underneath, and closing left the keyboard at the top of
   * the document. The shared hook places focus inside the sheet, keeps it there,
   * and hands it back to the control that opened it.
   *
   * Called unconditionally, before the missing-record exit below, so both
   * overlays — the document and the "no longer in your books" notice — behave
   * the same way.
   */
  useDialogFocus({ isOpen: true, panel: panelRef, onEscape: onClose });

  /* ------------------------- document-specific parts ---------------------- */

  /*
   * Every hook below runs BEFORE the "no longer in your books" exit further
   * down, and each one tolerates a document that went away. A record can vanish
   * while the sheet is open — it is voided in another tab, or the books reload
   * underneath it — and an early return sitting between hooks would make that
   * render produce fewer hooks than the previous one, which React reports as a
   * crash rather than as the missing record it is.
   */
  const party = useMemo(() => {
    if (!document) return '—';
    if (isSale(document)) return document.customerName;
    if (isPurchase(document)) return document.supplierName;
    if (isPayment(document)) return document.partyName || '—';
    return document.categoryName;
  }, [document]);

  // The counterparty's own record, when it exists. Only stored fields print.
  const partyRecord = useMemo(() => {
    if (!document) return undefined;
    if (isSale(document)) return customers.find((c) => c.id === document.customerId);
    if (isPurchase(document)) return suppliers.find((s) => s.id === document.supplierId);
    if (isPayment(document) && document.partyId) {
      return customers.find((c) => c.id === document.partyId) ?? suppliers.find((s) => s.id === document.partyId);
    }
    return undefined;
  }, [document, customers, suppliers]);

  const position = useMemo(
    () => (document && !isExpense(document)
      ? documentPosition(
        { id: document.id, totalAmount: (document as Sale | Purchase).totalAmount, status: docStatus(document), postingSnapshot: 'postingSnapshot' in document ? document.postingSnapshot : undefined },
        payments,
      )
      : null),
    [document, payments],
  );

  const linkedDocumentNumber = useMemo(() => {
    if (!document || !isPayment(document)) return null;
    if (document.linkedSaleId) return sales.find((s) => s.id === document.linkedSaleId)?.invoiceNumber ?? null;
    if (document.linkedPurchaseId) return purchases.find((p) => p.id === document.linkedPurchaseId)?.referenceNumber ?? null;
    return null;
  }, [document, sales, purchases]);

  const entry = useMemo(
    () => (document ? entryFor(journalEntries, document.journalEntryId) : undefined),
    [journalEntries, document],
  );

  const items: LineItem[] = useMemo(
    () => (document && (isSale(document) || isPurchase(document)) ? orderedItems(document.items) : []),
    [document],
  );

  // The exit lives here, after the last hook, on purpose — see the note above.
  if (!document) {
    return (
      <div
        ref={panelRef}
        className="print-overlay fixed inset-0 z-50 bg-zinc-100 overflow-auto p-6"
        role="dialog"
        aria-modal="true"
        aria-label="That record is no longer in your books"
        tabIndex={-1}
      >
        <div className="max-w-md mx-auto bg-white border border-zinc-200 rounded-lg p-6 space-y-3">
          <p className="text-sm text-zinc-700">That record is no longer in your books.</p>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }

  const number = documentNumberOf(document);
  const status = docStatus(document);
  const sheetTitle = `${TITLE[kind]} ${number}`;
  const paymentState = position ? paymentStatusLabel(position.status) : null;

  return (
    <div
      ref={panelRef}
      className="print-overlay fixed inset-0 z-50 bg-zinc-100 overflow-auto"
      role="dialog"
      aria-modal="true"
      aria-label={sheetTitle}
      tabIndex={-1}
    >
      <div className="no-print sticky top-0 z-10 border-b border-zinc-200 bg-white/95 backdrop-blur px-4 py-2.5 flex items-center gap-3">
        <p className="text-xs font-medium text-zinc-900 grow truncate">{sheetTitle}</p>
        <p className="text-[11px] text-zinc-500 hidden sm:block">
          Print, or save as PDF, from the browser dialog.
        </p>
        <Button variant="primary" onClick={() => window.print()}>
          <Printer size={13} aria-hidden="true" /> Print
        </Button>
        <Button onClick={onClose} aria-label="Close document">
          <X size={13} aria-hidden="true" /> Close
        </Button>
      </div>

      <div className="py-6">
        <ReportSheet id="printed-document">
          <ReportHeader
            business={business}
            title={TITLE[kind]}
            subtitle={`${number} · ${reportDate(document.date, calendar)}`}
            meta={[]}
            calendar={calendar}
          />

          {/* Which record this is, and where it stands. */}
          <div className="report-rule mt-4 flex flex-wrap items-center gap-3 pt-3">
            <ReportStatus label={status === 'VOIDED' ? 'VOID' : 'POSTED'} tone={status === 'VOIDED' ? 'neutral' : 'ok'} />
            {paymentState && <ReportStatus label={paymentState} tone={paymentStatusTone(position!.status)} />}
            <span className="report-identity">
              Recorded {reportStamp(document.createdAt.slice(0, 10))}
            </span>
          </div>

          {/* ------------------------------ invoice / bill ----------------------- */}
          {(isSale(document) || isPurchase(document)) && position && (
            <>
              <ReportBlock
                title={isSale(document) ? 'Billed to' : 'Supplier'}
                rows={[
                  { label: isSale(document) ? 'Customer' : 'Supplier', value: party || (isSale(document) ? 'Walk-in customer' : 'Unknown supplier') },
                  ...(partyRecord?.phone ? [{ label: 'Phone', value: partyRecord.phone }] : []),
                  ...(partyRecord?.email ? [{ label: 'Email', value: partyRecord.email }] : []),
                  ...(partyRecord?.panNumber ? [{ label: 'PAN', value: partyRecord.panNumber }] : []),
                  ...(partyRecord?.address ? [{ label: 'Address', value: partyRecord.address }] : []),
                ]}
              />

              {items.length > 0 ? (
                <ReportSection title="Items">
                  <ReportTable
                    label="Document items"
                    columns={[
                      { key: 'description', header: 'Description', render: (i: LineItem) => i.description || '—' },
                      { key: 'qty', header: 'Qty', numeric: true, render: (i) => String(i.quantity) },
                      { key: 'unit', header: 'Unit price', numeric: true, render: (i) => reportMoney(i.unitPrice) },
                      { key: 'discount', header: 'Discount', numeric: true, render: (i) => <ReportAmount value={i.discount} /> },
                      { key: 'total', header: 'Amount', numeric: true, render: (i) => <ReportAmount value={lineTotal(i)} dashOnZero={false} /> },
                    ]}
                    rows={items}
                    totalsLabel=""
                  />
                </ReportSection>
              ) : (
                <ReportSection title="Items">
                  <p className="report-note">No line items are recorded on this document.</p>
                </ReportSection>
              )}

              <ReportSection title="Totals">
                <ReportRow label="Subtotal" value={document.subtotal} indent />
                <ReportRow label="Discount" value={-document.discountTotal} indent />
                <ReportRow label="VAT" value={document.taxAmount} indent />
                <ReportRow label="Total" value={document.totalAmount} tone="total" />
              </ReportSection>

              {/* --------------------- the settlement position -------------------- */}
              <ReportSection title="Settlement">
                {position.lines.length === 0 ? (
                  <p className="report-note">No settlement has been recorded against this document.</p>
                ) : (
                  <ReportTable
                    label="Settlements recorded against this document"
                    columns={[
                      { key: 'date', header: 'Date', render: (l) => reportDate(l.date, calendar) },
                      { key: 'reference', header: 'Reference', render: (l) => <span className="whitespace-nowrap">{l.reference}</span> },
                      { key: 'method', header: 'Method', quiet: true, render: (l) => (l.viaGateway ? `${l.method.toLowerCase()} (online)` : l.method.toLowerCase()) },
                      { key: 'amount', header: 'Amount', numeric: true, render: (l) => <ReportAmount value={l.amount} dashOnZero={false} /> },
                    ]}
                    rows={position.lines}
                    totals={{
                      date: '', reference: '', method: 'Settled to date',
                      amount: <ReportAmount value={position.settled} dashOnZero={false} />,
                    }}
                    totalsLabel=""
                  />
                )}

                <div className="mt-3">
                  <ReportRow label="Settled to date (from settlement records)" value={position.settled} />
                  <ReportRow label="Outstanding" value={position.outstanding} tone="total" />
                </div>

                {/* The frozen posting-time record, shown as what it is. */}
                <div className="report-rule mt-3 pt-3">
                  <ReportRow
                    label="Settled when this document was posted (historical record)"
                    value={position.snapshotUpfront}
                    tone="quiet"
                  />
                  <ReportNote>
                    {position.snapshotUpfront > 0
                      ? 'This is the figure recorded at posting time, reproduced so a reprint matches the original. '
                        + 'It is a historical record, not the current balance — the balance above is what the settlement '
                        + 'records add up to today.'
                      : 'Nothing was recorded as settled when this document was posted. The balance above is what the '
                        + 'settlement records add up to today.'}
                  </ReportNote>
                </div>
              </ReportSection>

              {/*
                The invoice date and the due date are stated separately because
                they are different facts: one is when the paper was written, the
                other when the money is expected. The due date is the one the
                posting RPC recorded from the agreed terms, and the same column
                the aging schedule reads, so a reprint and the statement cannot
                disagree about when this document was payable.
              */}
              <ReportBlock
                title="Dates and terms"
                rows={[
                  { label: isSale(document) ? 'Invoice date' : 'Bill date', value: reportDate(document.date, calendar) },
                  { label: 'Due date', value: reportDate(document.dueDate, calendar) },
                  { label: 'Payment terms', value: termsLabel(document.paymentTermsDays) },
                  { label: 'Method on the document', value: document.paymentMethod.toLowerCase() },
                  ...(document.notes ? [{ label: 'Notes', value: document.notes }] : []),
                ]}
              />
            </>
          )}

          {/* -------------------------------- receipt --------------------------- */}
          {isPayment(document) && (
            <>
              <ReportBlock
                title={document.paymentType === 'INCOMING' ? 'Received from' : 'Paid to'}
                rows={[
                  { label: 'Party', value: party },
                  ...(partyRecord?.phone ? [{ label: 'Phone', value: partyRecord.phone }] : []),
                  ...(partyRecord?.email ? [{ label: 'Email', value: partyRecord.email }] : []),
                  { label: 'Direction', value: document.paymentType === 'INCOMING' ? 'Money received' : 'Money paid out' },
                  { label: 'Method', value: document.paymentMethod.toLowerCase() + (document.gatewayTransactionId ? ' (online collection)' : '') },
                  { label: 'Date', value: reportDate(document.date, calendar) },
                  { label: 'Reference', value: document.reference },
                  ...(linkedDocumentNumber ? [{ label: 'Against document', value: linkedDocumentNumber }] : []),
                  ...(document.bankName ? [{ label: 'Bank', value: document.bankName }] : []),
                  ...(document.notes ? [{ label: 'Notes', value: document.notes }] : []),
                ]}
              />

              <ReportSection title="Amount">
                <ReportRow label="Amount settled" value={document.amount} tone="grand" />
              </ReportSection>

              {entry && (
                <ReportSection
                  title="Ledger entries"
                  note={`Journal entry ${entry.reference} · sequence ${entry.sequence}`}
                >
                  <ReportTable
                    label="Journal lines"
                    columns={[
                      { key: 'account', header: 'Account', render: (l) => l.accountName },
                      { key: 'debit', header: 'Debit', numeric: true, render: (l) => <ReportAmount value={l.debit} /> },
                      { key: 'credit', header: 'Credit', numeric: true, render: (l) => <ReportAmount value={l.credit} /> },
                    ]}
                    rows={entry.lines}
                    totals={{
                      account: 'Totals',
                      debit: <ReportAmount value={entry.lines.reduce((s, l) => s + l.debit, 0)} dashOnZero={false} />,
                      credit: <ReportAmount value={entry.lines.reduce((s, l) => s + l.credit, 0)} dashOnZero={false} />,
                    }}
                    totalsLabel=""
                  />
                </ReportSection>
              )}
            </>
          )}

          {/* ----------------------------- expense voucher ---------------------- */}
          {isExpense(document) && (
            <>
              <ReportBlock
                title="Paid to"
                rows={[
                  { label: 'Category', value: document.categoryName },
                  { label: 'Method', value: document.paymentMethod.toLowerCase() },
                  { label: 'Date', value: reportDate(document.date, calendar) },
                  { label: 'Reference', value: document.reference },
                  ...(document.notes ? [{ label: 'Notes', value: document.notes }] : []),
                ]}
              />
              <ReportSection title="Detail">
                <p className="report-identity">{document.description}</p>
                <div className="mt-3">
                  <ReportRow label="Net amount" value={document.amount} indent />
                  <ReportRow label="VAT" value={document.taxAmount} indent />
                  <ReportRow label="Total paid" value={document.totalAmount} tone="grand" />
                </div>
                <ReportNote>
                  An expense is settled when it is posted, so there is no outstanding balance to carry.
                </ReportNote>
              </ReportSection>

              {entry && (
                <ReportSection title="Ledger entries" note={`Journal entry ${entry.reference} · sequence ${entry.sequence}`}>
                  <ReportTable
                    label="Journal lines"
                    columns={[
                      { key: 'account', header: 'Account', render: (l) => l.accountName },
                      { key: 'debit', header: 'Debit', numeric: true, render: (l) => <ReportAmount value={l.debit} /> },
                      { key: 'credit', header: 'Credit', numeric: true, render: (l) => <ReportAmount value={l.credit} /> },
                    ]}
                    rows={entry.lines}
                    totals={{
                      account: 'Totals',
                      debit: <ReportAmount value={entry.lines.reduce((s, l) => s + l.debit, 0)} dashOnZero={false} />,
                      credit: <ReportAmount value={entry.lines.reduce((s, l) => s + l.credit, 0)} dashOnZero={false} />,
                    }}
                    totalsLabel=""
                  />
                </ReportSection>
              )}
            </>
          )}

          <ReportFooter
            generatedOn={todayNpt()}
            note={status === 'VOIDED'
              ? 'This document was voided. A reversing entry is in the ledger; the original is kept for the audit trail.'
              : `${business.businessName || 'Zeyks Book'} — printed from posted records`}
            right={status === 'VOIDED' ? 'Voided document reprint' : reportMoney(documentAmountOf(document))}
          />
        </ReportSheet>
      </div>
    </div>
  );
};

/** The headline amount of any printable record. */
function documentAmountOf(doc: PrintableDocument): number {
  if (isPayment(doc)) return doc.amount;
  if (isExpense(doc)) return doc.totalAmount;
  return doc.totalAmount;
}

/** Exposed for the test runner, which has no renderer. */
export const _documentPrintForTest = { TITLE, documentNumberOf, docStatus, documentAmountOf };
