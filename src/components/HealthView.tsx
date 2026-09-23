import React, { useState } from 'react';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { Books } from '../state/useBooks';
import { gateway } from '../services/paymentGateway';
import { Badge, Button, Money } from './ui';
import { onlineCollectionAvailable, PAYMENT_API_DISABLED_MESSAGE } from '../lib/paymentApi';

/** Why a re-check is not offered here, in one line. */
const PAYMENT_DISABLED_HINT = PAYMENT_API_DISABLED_MESSAGE;
import { gatewaySettlementState } from '../lib/gatewayState';

/**
 * Data health.
 *
 * The old build showed a "Balanced ✓" badge derived from the same journal
 * lines it was checking, so it could never report a problem. These checks can
 * actually fail, and each one names the document that caused it.
 */
export const HealthView: React.FC<{ books: Books; onDone: (m: string, ok: boolean) => void }> = ({ books, onDone }) => {
  const { integrityIssues, gatewayTxns, business, journalEntries, payments } = books;
  const [rechecking, setRechecking] = useState<string | null>(null);

  const errors = integrityIssues.filter((i) => i.severity === 'ERROR');
  const warnings = integrityIssues.filter((i) => i.severity === 'WARNING');

  const unresolved = gatewayTxns.filter((t) => t.status === 'INITIATED' || t.status === 'PENDING');

  /**
   * Collections that already have a settlement on the books.
   *
   * The state is derived — gateway_transactions.payment_id plus that payment's
   * doc_status — never stored a second time, so this list can never disagree
   * with the settlements it points at. A voided settlement is shown as voided
   * rather than as a success, because that is what the person has to act on.
   */
  const settled = gatewayTxns.filter((t) => t.paymentId);

  /**
   * Re-ask the gateway about one unresolved collection, then hand the answer to
   * the server's settlement RPC. The browser forwards the answer; it never
   * decides whether money was received.
   */
  const recheck = async (txnId: string) => {
    const txn = gatewayTxns.find((t) => t.id === txnId);
    if (!txn) return;
    setRechecking(txnId);
    try {
      const verification = txn.provider === 'ESEWA'
        ? await gateway.verifyEsewa({ transactionUuid: txn.gatewayRef, totalAmount: txn.amount })
        : await gateway.lookupKhalti(txn.gatewayRef);
      const outcome = await books.settleGatewayTxn(txnId, verification);
      onDone(outcome.message, outcome.ok);
    } catch (e) {
      onDone(e instanceof Error ? e.message : 'Could not reach the gateway.', false);
    } finally {
      setRechecking(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-6 px-4 sm:px-6 space-y-8">
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-900">Checks</h2>
          <p className="text-xs text-zinc-500">
            {journalEntries.length} journal {journalEntries.length === 1 ? 'entry' : 'entries'}
          </p>
        </div>

        {integrityIssues.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <CheckCircle2 size={16} aria-hidden="true" />
            Every check passed. No orphaned accounts, duplicate references, impossible balances or unposted documents.
          </div>
        ) : (
          <ul className="space-y-2">
            {[...errors, ...warnings].map((issue, i) => (
              <li key={`${issue.code}-${i}`}
                className={`rounded-lg border px-4 py-3 ${
                  issue.severity === 'ERROR' ? 'border-rose-200 bg-rose-50' : 'border-amber-200 bg-amber-50'
                }`}>
                <div className="flex items-start gap-2">
                  <Badge tone={issue.severity === 'ERROR' ? 'rose' : 'amber'}>
                    {issue.severity === 'ERROR' ? 'must fix' : 'check'}
                  </Badge>
                  <div className="grow min-w-0">
                    <p className={`text-xs ${issue.severity === 'ERROR' ? 'text-rose-900' : 'text-amber-900'}`}>
                      {issue.message}
                    </p>
                    {issue.subject && <p className="text-[11px] text-zinc-500 mt-0.5">{issue.subject}</p>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {unresolved.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-900 mb-1">Online payments awaiting confirmation</h2>
          <p className="text-xs text-zinc-500 mb-3">
            These have not been confirmed by the gateway, so nothing has been posted. Re-check to get the final answer.
          </p>
          <ul className="space-y-2">
            {unresolved.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3">
                <div className="grow min-w-0">
                  <p className="text-xs font-medium text-zinc-900">
                    {t.provider} · {t.customerName} · <Money value={t.amount} symbol={business.currencySymbol} size="sm" />
                  </p>
                  <p className="text-[11px] text-zinc-500 truncate">
                    {t.gatewayRef} · started {new Date(t.initiatedAt).toLocaleString()}
                    {t.lastError ? ` · ${t.lastError}` : ''}
                  </p>
                </div>
                <Button onClick={() => recheck(t.id)} disabled={rechecking === t.id || !onlineCollectionAvailable()}
                  title={onlineCollectionAvailable() ? undefined : PAYMENT_DISABLED_HINT}>
                  {rechecking === t.id
                    ? <><RefreshCw size={13} className="animate-spin" aria-hidden="true" /> Checking</>
                    : 'Re-check'}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {settled.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-900 mb-1">Online collections on the books</h2>
          <p className="text-xs text-zinc-500 mb-3">
            Each of these has a settlement recorded. Nothing here is reversed from this screen — a
            settlement is voided, and reversed, from the settlements list.
          </p>
          <ul className="space-y-2">
            {settled.map((t) => {
              const state = gatewaySettlementState(t, payments);
              return (
                <li key={t.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3">
                  <div className="grow min-w-0">
                    <p className="text-xs font-medium text-zinc-900">
                      {t.provider} · {t.customerName} · <Money value={t.amount} symbol={business.currencySymbol} size="sm" />
                    </p>
                    <p className="text-[11px] text-zinc-500 truncate">
                      {t.gatewayRef}
                      {t.gatewayTransactionId ? ` · ${t.gatewayTransactionId}` : ''}
                      {t.settledAt ? ` · settled ${new Date(t.settledAt).toLocaleString()}` : ''}
                    </p>
                  </div>
                  <Badge tone={state === 'VOIDED' ? 'rose' : 'green'}>
                    {state === 'VOIDED' ? 'settlement voided' : 'settled'}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
};
