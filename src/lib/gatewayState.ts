/**
 * Online collection: cloud request shaping and the pure state transitions.
 *
 * Kept free of React and of the client SDK so three things can be tested
 * directly, exactly like paymentState.ts and voidState.ts are:
 *
 *   1. the wire contract with `initiate_gateway_txn` (migration 011) and
 *      `settle_gateway_txn` (migration 012) — the arguments carry no amount, no
 *      document, no payment, no status and no identity that the database could
 *      not derive on its own;
 *   2. that the browser can only ever forward the provider's answer, never
 *      invent one: toVerificationPayload copies a fixed set of fields out of the
 *      server's result and coerces `verified` to a real boolean;
 *   3. that a settlement reaching state is the settlement the RPC returned —
 *      nothing is optimistically guessed, and a replay never lists a row twice.
 */

import type {
  GatewayProvider, GatewaySettlementState, GatewayStatus, GatewayTransaction,
  JournalEntry, Payment,
} from '../types';
import type { GatewaySettlementResult, InitiatedGatewayTransaction } from './dbTypes';
import { round2 } from './money';

/* -------------------------------------------------------------------------- */
/* The one internal verification shape (produced by server/verification.js)     */
/* -------------------------------------------------------------------------- */

/**
 * What the API server's verify/lookup returns. `verified` is the server's own
 * conclusion after asking the provider directly — a redirect, a query parameter
 * or a client-side "success" never reaches this type.
 */
export interface ProviderVerification {
  provider: GatewayProvider;
  verified: boolean;
  status: GatewayStatus;
  gatewayTransactionId: string | null;
  amount: number;
  currency: string;
  reference: string;
  detail?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Wire contract with the two gateway RPCs                                     */
/* -------------------------------------------------------------------------- */

export interface CloudGatewayInitiateRequest {
  businessId: string;
  provider: GatewayProvider;
  /** eSewa transaction_uuid / Khalti pidx — an identifier, never proof. */
  gatewayRef: string;
  amount: number;
  /** Mandatory: a collection with nothing to settle against could never post. */
  linkedSaleId: string;
  customerName?: string;
  currency?: string;
}

/**
 * Map an initiation to the RPC's arguments.
 *
 * Deliberately absent: the status, the initiator, the settlement linkage, the
 * payment id and the currency's business context — all of them are decided by
 * the database from auth.uid(), the locked invoice and its persisted
 * settlements.
 */
export function toInitiateGatewayArgs(request: CloudGatewayInitiateRequest): Record<string, unknown> {
  return {
    p_business_id: request.businessId,
    p_provider: request.provider,
    p_gateway_ref: request.gatewayRef,
    p_amount: request.amount,
    p_linked_sale_id: request.linkedSaleId,
    p_customer_name: request.customerName ?? '',
    p_currency: request.currency ?? 'NPR',
  };
}

export interface CloudGatewaySettleRequest {
  businessId: string;
  /** The collection's own id — the database's idempotency record. */
  gatewayTxnId: string;
  /** The server's normalized answer for that collection. */
  verification: ProviderVerification;
  date?: string | null;
  notes?: string | null;
}

/**
 * Translate the server's answer into the RPC's payload.
 *
 * This is the only place the wire names are translated, and every field is
 * copied explicitly: `raw` and anything else the API returned cannot ride along.
 * `verified` is coerced with `=== true` so a truthy string can never travel as a
 * JSON boolean — the database rejects a payload whose verified flag is not a
 * boolean at all.
 */
export function toVerificationPayload(verification: ProviderVerification): Record<string, unknown> {
  return {
    provider: verification.provider,
    verified: verification.verified === true,
    status: verification.status,
    gateway_transaction_id: verification.gatewayTransactionId ?? null,
    amount: verification.amount,
    currency: verification.currency || 'NPR',
    reference: verification.reference,
    detail: verification.detail ?? null,
  };
}

export function toSettleGatewayArgs(request: CloudGatewaySettleRequest): Record<string, unknown> {
  return {
    p_business_id: request.businessId,
    p_gateway_txn_id: request.gatewayTxnId,
    p_verification: toVerificationPayload(request.verification),
    p_date: request.date ?? null,
    p_notes: request.notes ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* State transitions                                                          */
/* -------------------------------------------------------------------------- */

export interface GatewayBookArrays {
  payments: Payment[];
  journalEntries: JournalEntry[];
  gatewayTxns: GatewayTransaction[];
}

/**
 * The derived settlement state of a collection.
 *
 * Mirrors public.gateway_settlement_state (migration 011) exactly: the linkage
 * column and the linked payment's doc_status are the truth, so nothing here is
 * stored twice. A paymentId whose row is not loaded is still SETTLED — the
 * database only ever answers UNSETTLED when there is no linkage at all.
 */
export function gatewaySettlementState(
  txn: Pick<GatewayTransaction, 'paymentId'>,
  payments: Pick<Payment, 'id' | 'docStatus'>[],
): GatewaySettlementState {
  if (!txn.paymentId) return 'UNSETTLED';
  const payment = payments.find((p) => p.id === txn.paymentId);
  return payment && payment.docStatus === 'VOIDED' ? 'VOIDED' : 'SETTLED';
}

/**
 * Apply a committed settlement (or a replay of one) to the book arrays.
 *
 * The collection row is replaced by its persisted version, and only when the
 * database actually reported a payment do the payment and its journal entry
 * follow — an unverified answer changes the collection's status and nothing
 * else. Rows that are already in state are replaced in place, so replaying the
 * same settlement can never list it twice. Pure: the inputs are never mutated.
 */
export function applyGatewaySettlement(
  state: GatewayBookArrays,
  result: GatewaySettlementResult,
): GatewayBookArrays {
  const txnKnown = state.gatewayTxns.some((t) => t.id === result.gatewayTransaction.id);
  const gatewayTxns = txnKnown
    ? state.gatewayTxns.map((t) => (t.id === result.gatewayTransaction.id ? result.gatewayTransaction : t))
    : [result.gatewayTransaction, ...state.gatewayTxns];

  if (!result.payment || !result.journalEntry) {
    return { ...state, gatewayTxns };
  }

  const payment = result.payment;
  const entry = result.journalEntry;

  return {
    gatewayTxns,
    payments: state.payments.some((p) => p.id === payment.id)
      ? state.payments.map((p) => (p.id === payment.id ? payment : p))
      : [payment, ...state.payments],
    journalEntries: state.journalEntries.some((e) => e.id === entry.id)
      ? state.journalEntries.map((e) => (e.id === entry.id ? entry : e))
      : [entry, ...state.journalEntries],
  };
}

/**
 * Apply a fresh or replayed initiation: the persisted row replaces any local
 * copy, and nothing is posted to the books.
 */
export function applyGatewayInitiation(
  gatewayTxns: GatewayTransaction[],
  result: InitiatedGatewayTransaction,
): GatewayTransaction[] {
  const txn = result.gatewayTransaction;
  return gatewayTxns.some((t) => t.id === txn.id)
    ? gatewayTxns.map((t) => (t.id === txn.id ? txn : t))
    : [txn, ...gatewayTxns];
}

/* -------------------------------------------------------------------------- */
/* UI states: what to show, and when a button must stay disabled               */
/* -------------------------------------------------------------------------- */

export type GatewayTone = 'success' | 'info' | 'error';

export interface GatewayOutcome {
  ok: boolean;
  tone: GatewayTone;
  message: string;
}

/**
 * The user-facing result of a settlement attempt.
 *
 * Three outcomes, three honest messages: money posted, already posted, or not
 * confirmed. A voided settlement is reported as needing a new collection rather
 * than as a success, because that is what the person has to do next.
 */
export function gatewayOutcome(result: GatewaySettlementResult): GatewayOutcome {
  if (result.outcome === 'SETTLED') {
    const reference = result.payment?.reference ?? 'the settlement';
    return {
      ok: true,
      tone: 'success',
      message: `${reference} recorded — the money is on the books.`,
    };
  }

  if (result.outcome === 'ALREADY_SETTLED') {
    if (result.settlementState === 'VOIDED') {
      return {
        ok: false,
        tone: 'error',
        message: result.reason
          ?? 'The settlement for this collection was voided; take the money again with a new collection.',
      };
    }
    return {
      ok: true,
      tone: 'info',
      message: result.reason ?? 'This collection was already settled. Nothing was posted twice.',
    };
  }

  return {
    ok: false,
    tone: 'error',
    message: result.reason ?? 'The gateway did not confirm this payment, so nothing was posted.',
  };
}

/** The busy flag the collect button must honour while an initiation is in flight. */
export function collectionBusy(busy: boolean, hasPending: boolean): boolean {
  return busy || hasPending;
}

/**
 * Why a collection cannot be started, or null when it can.
 *
 * Mirrors the server's own rules (initiate_gateway_txn) so the button is
 * disabled with the reason instead of failing after a click: an invoice is
 * mandatory, the amount must be positive and within the balance the server
 * would recompute, and Khalti's floor is a provider rule the server enforces.
 */
export function collectionBlockedReason(input: {
  hasInvoice: boolean;
  invoiceNumber?: string;
  amount: number;
  outstanding: number;
  provider: GatewayProvider;
}): string | null {
  if (!input.hasInvoice) {
    return 'Choose the invoice this money is for — a collection with nothing to settle against cannot be posted.';
  }
  if (!(input.amount > 0)) return 'Enter an amount above zero.';

  const outstanding = round2(input.outstanding);
  if (input.amount > outstanding + 0.005) {
    return `Only NPR ${outstanding.toFixed(2)} is outstanding on ${input.invoiceNumber ?? 'this invoice'}.`;
  }
  if (input.provider === 'KHALTI' && input.amount < 10) {
    return 'Khalti requires at least NPR 10.';
  }
  return null;
}
