import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import { GatewayProvider, Sale } from '../types';
import { Books } from '../state/useBooks';
import {
  gateway, GatewayConfig, PendingCollection, rememberPending, submitEsewaForm, VerificationResult,
} from '../services/paymentGateway';
import { Button, Callout, Field, inputClass, Modal, Money } from './ui';
import { outstandingOn } from '../services/posting';
import { parseAmount, round2 } from '../lib/money';
import { collectionBlockedReason, collectionBusy } from '../lib/gatewayState';

/**
 * Collect an invoice online.
 *
 * The money is only written to the ledger once the *server* has verified the
 * payment with the gateway. A browser redirect saying "success" is treated as
 * a prompt to go and check, never as proof.
 *
 * Two server calls, in order: the API server signs/creates the payment with the
 * provider and returns the reference, then `initiate_gateway_txn` (migration
 * 011) records the collection against a POSTED invoice the caller may write to.
 * Only on the way back does `settle_gateway_txn` (012) decide whether anything
 * reaches the books. No accounting happens in this component.
 */
export const CollectOnlineModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  books: Books;
  config: GatewayConfig | null;
  preselectSaleId?: string;
  onDone: (message: string, ok: boolean) => void;
}> = ({ isOpen, onClose, books, config, preselectSaleId }) => {
  const { openInvoices, business } = books;
  const [saleId, setSaleId] = useState(preselectSaleId ?? '');
  const [amount, setAmount] = useState('');
  const [provider, setProvider] = useState<GatewayProvider>('ESEWA');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sale: Sale | undefined = useMemo(
    () => openInvoices.find((s) => s.id === saleId),
    [openInvoices, saleId],
  );
  // Total − every POSTED settlement row: the same formula the server uses to
  // decide whether a collection still fits.
  const due = sale ? outstandingOn(sale) : 0;

  /**
   * Whether this invoice already has a collection waiting for the gateway's
   * answer. Starting a second one would leave two live provider payments for the
   * same invoice, so the button stays disabled until the first is settled or
   * re-checked under Data health.
   */
  const awaiting = useMemo(
    () => books.gatewayTxns.some((t) => t.linkedSaleId === saleId
      && !t.paymentId && (t.status === 'INITIATED' || t.status === 'PENDING')),
    [books.gatewayTxns, saleId],
  );
  const startBusy = collectionBusy(busy, awaiting);

  useEffect(() => {
    if (!isOpen) return;
    setSaleId(preselectSaleId ?? '');
    setAmount(''); setError(null); setBusy(false);
    setProvider(config?.esewa.enabled ? 'ESEWA' : 'KHALTI');
  }, [isOpen, preselectSaleId, config]);

  useEffect(() => {
    if (sale) setAmount(String(outstandingOn(sale)));
  }, [sale]);

  const start = async () => {
    setError(null);
    const value = round2(parseAmount(amount));

    // The same rules the server enforces, checked here so the button is never
    // clickable into a failure the database would only reject later.
    const blocked = collectionBlockedReason({
      hasInvoice: Boolean(sale),
      invoiceNumber: sale?.invoiceNumber,
      amount: value,
      outstanding: due,
      provider,
    });
    if (blocked) { setError(blocked); return; }
    if (!sale) return;

    const customerName = sale.customerName || 'Customer';
    setBusy(true);

    try {
      // 1. Ask the provider, through our API, to start the payment. This is the
      //    ONE call that produces the reference: calling it twice would mint two
      //    different references and the collection would never match the form we
      //    submit. Nothing is written to the books here.
      //    The API authenticates us and reads the invoice itself, so we send the
      //    invoice id and the amount and nothing that could be mistaken for an
      //    authorization claim.
      const esewaPayload = provider === 'ESEWA'
        ? await gateway.initiateEsewa({ saleId: sale.id, amount: value, taxAmount: 0 })
        : null;
      const khaltiPayload = provider === 'KHALTI'
        ? await gateway.initiateKhalti({ saleId: sale.id, amount: value })
        : null;
      const gatewayRef = esewaPayload?.transactionUuid ?? khaltiPayload?.pidx;
      if (!gatewayRef) throw new Error('The gateway did not return a transaction reference.');

      // 2. Record the collection against the invoice. The database checks
      //    membership, the invoice and its outstanding balance under a lock, so
      //    a stale amount cannot be collected.
      const started = await books.startGatewayCollection({
        provider, gatewayRef, amount: value, linkedSaleId: sale.id, customerName,
      });
      if (!started.ok) { setBusy(false); setError(started.message); return; }

      rememberPending({
        txnId: started.gatewayTxnId, provider, gatewayRef,
        amount: value, saleId: sale.id, customerName,
      });

      // 3. Hand the customer to the gateway's own page. The redirect is a hint
      //    to come back and check, never proof of payment.
      if (esewaPayload) {
        submitEsewaForm(esewaPayload); // leaves the page
        return;
      }
      window.location.href = khaltiPayload!.paymentUrl;
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : 'The payment could not be started.');
    }
  };

  const esewaOn = config?.esewa.enabled ?? false;
  const khaltiOn = config?.khalti.enabled ?? false;
  const anyOn = esewaOn || khaltiOn;

  return (
    <Modal
      isOpen={isOpen} onClose={onClose} title="Collect online"
      description="The customer pays on the gateway's own page. Nothing reaches your books until the payment is verified."
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-zinc-500">
            {config?.mode === 'live' ? 'Live mode' : 'Sandbox — no real money moves'}
          </span>
          <div className="flex gap-2">
            <Button type="button" onClick={onClose}>Cancel</Button>
            {/* A second click while the first is in flight would start a second
                provider payment for the same invoice. */}
            <Button type="button" variant="primary" onClick={start} disabled={startBusy || !anyOn || !sale}>
              {busy ? <><RefreshCw size={13} className="animate-spin" aria-hidden="true" /> Starting</>
                : <><ExternalLink size={13} aria-hidden="true" /> Continue to {provider === 'ESEWA' ? 'eSewa' : 'Khalti'}</>}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="error">{error}</Callout>}

        {awaiting && (
          <Callout tone="warn">
            An earlier collection for this invoice is still waiting for the gateway's answer.
            Nothing has been posted for it: re-check it under Data health before starting another.
          </Callout>
        )}

        {!anyOn && (
          <Callout tone="warn">
            No gateway is configured. Start the API server and set <code className="font-mono">KHALTI_SECRET_KEY</code>{' '}
            (and your eSewa merchant code) in <code className="font-mono">.env</code>.
          </Callout>
        )}

        {/*
          An invoice is mandatory: online money is settled against a posted
          document, so a collection with nothing to settle against could never
          reach the books. The server refuses it too (initiate_gateway_txn).
        */}
        <Field
          label="Invoice"
          required
          hint={openInvoices.length === 0
            ? 'No invoices are outstanding, so there is nothing to collect against.'
            : undefined}
        >
          {(id) => (
            <select id={id} value={saleId} className={inputClass} onChange={(e) => setSaleId(e.target.value)}>
              <option value="">Choose an invoice…</option>
              {openInvoices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.invoiceNumber} — {s.customerName} — NPR {outstandingOn(s).toFixed(2)} due
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Amount" required hint={sale ? `NPR ${due.toFixed(2)} outstanding` : undefined}>
          {(id) => (
            <input id={id} type="number" min="0" step="any" inputMode="decimal" className={inputClass}
              value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          )}
        </Field>

        <fieldset>
          <legend className="text-xs font-medium text-zinc-700 mb-1.5">Gateway</legend>
          <div className="grid grid-cols-2 gap-2">
            {([
              { value: 'ESEWA' as const, label: 'eSewa', on: esewaOn },
              { value: 'KHALTI' as const, label: 'Khalti', on: khaltiOn },
            ]).map((p) => (
              <label key={p.value}
                className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer ${
                  provider === p.value ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-200'
                } ${!p.on ? 'opacity-40 cursor-not-allowed' : ''}`}>
                <input type="radio" name="gw" value={p.value} checked={provider === p.value} disabled={!p.on}
                  onChange={() => setProvider(p.value)} className="accent-zinc-900" />
                <span>{p.label}</span>
                {!p.on && <span className="text-[11px] text-zinc-400 ml-auto">not set up</span>}
              </label>
            ))}
          </div>
        </fieldset>

        <p className="flex gap-2 text-xs text-zinc-500">
          <ShieldCheck size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
          Your merchant secret stays on the API server. This page never sees it, and a payment is
          only recorded after the server confirms it with {provider === 'ESEWA' ? 'eSewa' : 'Khalti'} directly.
        </p>

        {sale && (
          <dl className="rounded-md border border-zinc-200 bg-zinc-50/60 px-3 py-2 text-xs space-y-1">
            <div className="flex justify-between"><dt className="text-zinc-500">Invoice total</dt>
              <dd><Money value={sale.totalAmount} symbol={business.currencySymbol} size="sm" /></dd></div>
            <div className="flex justify-between"><dt className="text-zinc-500">Already settled</dt>
              <dd><Money value={sale.paidAmount} symbol={business.currencySymbol} size="sm" /></dd></div>
            <div className="flex justify-between font-semibold border-t border-zinc-200 pt-1">
              <dt>Outstanding</dt><dd><Money value={due} symbol={business.currencySymbol} size="sm" /></dd></div>
          </dl>
        )}
      </div>
    </Modal>
  );
};

/**
 * Confirm a pending collection after the customer returns from the gateway.
 *
 * Step 1 is the API server asking the provider directly (eSewa's status API /
 * Khalti's lookup) and answering in the one normalized shape. Step 2 hands that
 * answer to settle_gateway_txn, which re-validates it against the persisted
 * collection and decides whether anything reaches the books. The browser never
 * decides, and never assembles the accounting: it forwards.
 */
export async function resolvePending(
  pending: PendingCollection,
  books: Books,
): Promise<{ ok: boolean; message: string }> {
  let verification: VerificationResult;
  try {
    verification = pending.provider === 'ESEWA'
      ? await gateway.verifyEsewa({
          transactionUuid: pending.gatewayRef,
          totalAmount: pending.amount,
          data: new URLSearchParams(window.location.search).get('data') ?? undefined,
        })
      : await gateway.lookupKhalti(pending.gatewayRef);
  } catch (e) {
    // The gateway could not be reached or answered unusably: record that the
    // collection is still unresolved and post nothing.
    const outcome = await books.settleGatewayTxn(pending.txnId, {
      provider: pending.provider,
      verified: false,
      status: 'PENDING',
      gatewayTransactionId: null,
      amount: pending.amount,
      currency: 'NPR',
      reference: pending.gatewayRef,
      detail: e instanceof Error ? e.message : 'Verification failed',
    });
    void outcome;
    return {
      ok: false,
      message: 'Could not confirm the payment with the gateway. It is listed under Data health — re-check it there.',
    };
  }

  const outcome = await books.settleGatewayTxn(pending.txnId, verification);
  return { ok: outcome.ok, message: outcome.message };
}

