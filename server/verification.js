/**
 * The provider adapter boundary.
 *
 * One job: turn whatever eSewa or Khalti answered into THE internal result shape
 * that `public.settle_gateway_txn` (migration 012) accepts, or refuse to produce
 * one. It is deliberately pure — no fetch, no secrets, no framework — so the
 * mapping rules can be tested directly (see tests/run.mjs) and so a provider's
 * quirks never leak past this file.
 *
 * The internal shape, field by field:
 *
 *   {
 *     provider:             "ESEWA" | "KHALTI",
 *     verified:             boolean,  the SERVER reached the gateway and it said so
 *     status:               "INITIATED" | "PENDING" | "COMPLETED" | "FAILED"
 *                         | "EXPIRED" | "REFUNDED" | "CANCELED",
 *     gatewayTransactionId: the provider's own transaction id,
 *     amount:               what the PROVIDER says it took (never the browser's number),
 *     currency:             "NPR",
 *     reference:            the gateway_ref the collection was started with,
 *     detail:               optional provider text, kept for last_error
 *   }
 *
 * It stays camelCase on the wire, like the rest of this API. The browser
 * forwards it to the RPC through toVerificationPayload (src/lib/gatewayState),
 * which is the single place the wire names are translated.
 *
 * Three rules this file exists to enforce:
 *   1. `verified` is only ever true when the provider's own status field says
 *      the money moved. A redirect, a query parameter or a client-supplied
 *      "success" cannot reach this function at all.
 *   2. The amount and the reference come from the provider's response, never
 *      from the request. A response that does not state them is a malformed
 *      provider response, not a payment.
 *   3. Anything unrecognised fails closed: an unknown status, an unparseable
 *      amount or a missing reference raises ProviderResponseError, which the
 *      endpoints surface as 502 and the database then records as NOT_VERIFIED.
 */

export class ProviderResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderResponseError';
  }
}

export const PROVIDERS = ['ESEWA', 'KHALTI'];

/** The seven statuses `gateway_transactions.status` allows (001). */
export const VERIFICATION_STATUSES = [
  'INITIATED', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED', 'CANCELED',
];

/** Both providers settle in NPR only; 001 pins every business to NPR as well. */
export const CURRENCY = 'NPR';

/**
 * eSewa ePay v2 status API: COMPLETE / PENDING / CANCELED / NOT_FOUND /
 * AMBIGUOUS. Only COMPLETE means the money moved; NOT_FOUND and AMBIGUOUS are
 * failures for our purposes (there is nothing to collect), not pendings.
 */
export function mapEsewaStatus(raw) {
  switch (String(raw ?? '').toUpperCase()) {
    case 'COMPLETE': return 'COMPLETED';
    case 'PENDING': return 'PENDING';
    case 'CANCELED': return 'CANCELED';
    case 'NOT_FOUND': return 'FAILED';
    case 'AMBIGUOUS': return 'FAILED';
    default: return null;
  }
}

/**
 * Khalti ePayment v2 (KPG-2) lookup statuses: Completed / Pending / Initiated /
 * Partially Refunded / Refunded / Expired / User canceled. Only Completed
 * releases goods — the same rule Khalti's own docs state.
 */
export function mapKhaltiStatus(raw) {
  switch (String(raw ?? '')) {
    case 'Completed': return 'COMPLETED';
    case 'Pending': return 'PENDING';
    case 'Initiated': return 'INITIATED';
    case 'Partially Refunded':
    case 'Refunded': return 'REFUNDED';
    case 'Expired': return 'EXPIRED';
    case 'User canceled': return 'CANCELED';
    default: return null;
  }
}

/**
 * A positive amount numeric(14,2) can hold, from a number or a provider string
 * (eSewa has been seen to send "1,000.00"). Anything else is a malformed
 * provider response rather than a payment.
 */
function money(value, label) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new ProviderResponseError(`The gateway did not report a usable ${label}.`);
  }
  if (n > 999999999999.99) {
    throw new ProviderResponseError(`The gateway reported a ${label} beyond what the books can hold.`);
  }
  const rounded = Math.round(n * 100) / 100;
  if (Math.abs(n - rounded) > 1e-9) {
    throw new ProviderResponseError(
      `The gateway reported a ${label} of ${n}, which is not a two decimal amount.`,
    );
  }
  return rounded;
}

/**
 * Build the internal result shape, or throw.
 *
 * `providerStatus` is the provider's raw status; `status` may be passed when a
 * caller has already mapped it (both then have to agree with the allowed set).
 */
export function normalizeVerification({
  provider, providerStatus, status, gatewayTransactionId, amount,
  reference, detail = '', currency = CURRENCY,
}) {
  const name = String(provider ?? '').toUpperCase();
  if (!PROVIDERS.includes(name)) {
    throw new ProviderResponseError(`Unsupported payment provider: ${provider}`);
  }

  const mapped = status ?? (name === 'ESEWA' ? mapEsewaStatus(providerStatus) : mapKhaltiStatus(providerStatus));
  if (!mapped) {
    throw new ProviderResponseError(
      `${name} answered with an unrecognised status (${JSON.stringify(providerStatus ?? null)}).`,
    );
  }
  if (!VERIFICATION_STATUSES.includes(mapped)) {
    throw new ProviderResponseError(`Unsupported verification status: ${mapped}`);
  }

  const ref = String(reference ?? '').trim();
  if (!ref) {
    // Without the reference the answer cannot be tied to a collection, and the
    // database refuses a payload that names the wrong one.
    throw new ProviderResponseError('The gateway answer did not name the transaction it belongs to.');
  }

  const total = money(amount, 'amount');

  // A verified result must also name the provider's own transaction id: that is
  // what `payments.gateway_transaction_id` stores, and what makes a re-check
  // idempotent instead of ambiguous.
  let txnId = gatewayTransactionId === null || gatewayTransactionId === undefined
    ? ''
    : String(gatewayTransactionId).trim();
  if (mapped === 'COMPLETED' && !txnId) {
    throw new ProviderResponseError('The gateway confirmed a payment without naming its transaction id.');
  }
  if (txnId.length > 200) {
    throw new ProviderResponseError('The gateway transaction id is longer than 200 characters.');
  }

  return {
    provider: name,
    verified: mapped === 'COMPLETED',
    status: mapped,
    gatewayTransactionId: txnId || null,
    amount: total,
    currency: String(currency ?? CURRENCY).toUpperCase(),
    reference: ref,
    detail: String(detail ?? '').slice(0, 500),
  };
}
