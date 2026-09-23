/**
 * Khalti ePayment v2 (KPG-2).
 *
 * Khalti is API-first: the server initiates and receives a `pidx`, the browser
 * is redirected to Khalti's hosted page, and on return the server calls lookup.
 * Khalti's own docs are explicit that acting on the redirect without a lookup
 * is the merchant's own risk, so the client here refuses to post to the ledger
 * on anything but a lookup result of Completed.
 *
 * Amounts go over the wire in paisa.
 *
 * What this file owns: the Khalti endpoints and their field names (including
 * the literal `Key` auth scheme and the paisa conversion). The shape of the
 * answer is ../verification.js's job, so a Khalti status this build does not
 * understand is refused instead of being guessed into a settlement.
 */

import { normalizeVerification, CURRENCY } from './verification.js';

const SANDBOX = 'https://dev.khalti.com';
const LIVE = 'https://khalti.com';

const isLive = () => process.env.PAYMENT_MODE === 'live';
const base = () => (isLive() ? LIVE : SANDBOX);
const secret = () => process.env.KHALTI_SECRET_KEY ?? '';

async function call(pathname, payload) {
  const res = await fetch(`${base()}${pathname}`, {
    method: 'POST',
    headers: {
      // Khalti expects the literal word "Key", not "Bearer".
      Authorization: `Key ${secret()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { detail: text }; }

  if (!res.ok) {
    const detail = body?.detail
      ?? Object.entries(body ?? {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; ');
    throw new Error(detail || `Khalti returned HTTP ${res.status}.`);
  }
  return body;
}

export const khalti = {
  isConfigured: () => Boolean(secret()),

  async initiate({ amount, reference, purchaseName, customerName, customerEmail, customerPhone, appUrl }) {
    const body = await call('/api/v2/epayment/initiate/', {
      return_url: `${appUrl}/?khalti=return`,
      website_url: appUrl,
      amount: Math.round(Number(amount) * 100), // paisa
      purchase_order_id: reference,
      purchase_order_name: purchaseName,
      customer_info: {
        name: customerName || 'Customer',
        email: customerEmail || undefined,
        phone: customerPhone || undefined,
      },
    });

    return {
      provider: 'KHALTI',
      method: 'REDIRECT',
      pidx: body.pidx,
      paymentUrl: body.payment_url,
      expiresAt: body.expires_at ?? null,
      amount: Number(amount),
    };
  },

  async lookup(pidx) {
    const body = await call('/api/v2/epayment/lookup/', { pidx });

    // total_amount arrives in paisa; the adapter boundary takes rupees and
    // validates that they are a real two decimal amount before anything is
    // allowed near the ledger.
    const result = normalizeVerification({
      provider: 'KHALTI',
      providerStatus: body.status,
      gatewayTransactionId: body.transaction_id ?? null,
      amount: Number(body.total_amount) / 100,
      reference: body.pidx ?? pidx,
      detail: `Khalti status ${body.status ?? 'unknown'}`,
      currency: CURRENCY,
    });

    return {
      ...result,
      pidx: body.pidx ?? pidx,
      fee: Number(body.fee ?? 0) / 100,
      refunded: Boolean(body.refunded),
      raw: body,
    };
  },
};
