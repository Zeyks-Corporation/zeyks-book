/**
 * eSewa ePay v2.
 *
 * Flow: the server signs the order, the browser POSTs a form to eSewa, eSewa
 * redirects back with a base64 `data` blob, and the server verifies it twice —
 * once by recomputing the HMAC over the signed fields, and again by asking
 * eSewa's status API directly. The second check matters because a redirect can
 * be replayed or hand-crafted; the status API cannot.
 *
 * What this file owns: the eSewa endpoints, the HMAC, and the exact field
 * names. What it must NOT own: the shape of the answer. Every status it sees is
 * mapped and validated by ../verification.js, which produces the one internal
 * result shape the database accepts — and refuses to produce one when eSewa
 * says something unusable. The amount reported here is always the one eSewa's
 * status API states, never the number the browser sent along.
 */

import crypto from 'node:crypto';
import { normalizeVerification, ProviderResponseError, CURRENCY } from './verification.js';

const SANDBOX = {
  form: 'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
  status: 'https://rc.esewa.com.np/api/epay/transaction/status/',
};
const LIVE = {
  form: 'https://epay.esewa.com.np/api/epay/main/v2/form',
  status: 'https://epay.esewa.com.np/api/epay/transaction/status/',
};

const isLive = () => process.env.PAYMENT_MODE === 'live';
const endpoints = () => (isLive() ? LIVE : SANDBOX);
const secret = () => process.env.ESEWA_SECRET_KEY ?? '';
const code = () => process.env.ESEWA_PRODUCT_CODE ?? '';

/** eSewa signs `total_amount,transaction_uuid,product_code` in exactly that order. */
function sign(totalAmount, transactionUuid, productCode) {
  const message = `total_amount=${totalAmount},transaction_uuid=${transactionUuid},product_code=${productCode}`;
  return crypto.createHmac('sha256', secret()).update(message).digest('base64');
}

/**
 * eSewa is strict about number formatting: the string that goes into the
 * signature must be byte-identical to the one in the form field, or the
 * gateway rejects the request with an unhelpful error.
 */
const money = (n) => Number(n).toFixed(2);

export const esewa = {
  isConfigured: () => Boolean(secret() && code()),
  productCode: () => code(),

  buildFormPayload({ amount, taxAmount, reference, customerName, appUrl }) {
    const transactionUuid = `${reference}-${Date.now()}`.replace(/[^A-Za-z0-9-]/g, '');
    const total = money(Number(amount) + Number(taxAmount || 0));
    const productCode = code();

    return {
      provider: 'ESEWA',
      method: 'FORM_POST',
      action: endpoints().form,
      transactionUuid,
      totalAmount: Number(total),
      customerName,
      fields: {
        amount: money(amount),
        tax_amount: money(taxAmount || 0),
        total_amount: total,
        transaction_uuid: transactionUuid,
        product_code: productCode,
        product_service_charge: '0',
        product_delivery_charge: '0',
        success_url: `${appUrl}/?esewa=success`,
        failure_url: `${appUrl}/?esewa=failure`,
        signed_field_names: 'total_amount,transaction_uuid,product_code',
        signature: sign(total, transactionUuid, productCode),
      },
    };
  },

  async verify({ data, transactionUuid, totalAmount }) {
    let decoded = null;

    // Step 1 — if eSewa handed back a signed blob, check the signature locally.
    // This is a cheap filter, not the authority: a hand-crafted redirect can
    // carry a perfectly valid signature over fields the attacker chose.
    if (data) {
      try {
        decoded = JSON.parse(Buffer.from(String(data), 'base64').toString('utf8'));
      } catch {
        throw new ProviderResponseError('The eSewa response could not be decoded.');
      }
      const fields = String(decoded.signed_field_names ?? '').split(',').filter(Boolean);
      const message = fields.map((f) => `${f}=${decoded[f]}`).join(',');
      const expected = crypto.createHmac('sha256', secret()).update(message).digest('base64');
      const a = Buffer.from(expected);
      const b = Buffer.from(String(decoded.signature ?? ''));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new ProviderResponseError('The eSewa response signature did not match. Payment not accepted.');
      }
    }

    // Step 2 — ask eSewa directly. This is the answer we actually trust, and it
    // is the only place the verified amount may come from.
    const uuid = decoded?.transaction_uuid ?? transactionUuid;
    if (!uuid) {
      throw new ProviderResponseError('A transaction id is required to verify with eSewa.');
    }

    const url = new URL(endpoints().status);
    url.searchParams.set('product_code', code());
    // Only used to address the query; the response's own amount decides.
    if (totalAmount !== undefined && totalAmount !== null && totalAmount !== '') {
      url.searchParams.set('total_amount', money(String(totalAmount).replace(/,/g, '')));
    }
    url.searchParams.set('transaction_uuid', uuid);

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`eSewa status check failed with HTTP ${res.status}.`);
    const body = await res.json();

    // Normalised by the adapter boundary: unknown statuses, missing amounts and
    // a confirmed payment without a reference all fail closed there.
    const result = normalizeVerification({
      provider: 'ESEWA',
      providerStatus: body.status,
      gatewayTransactionId: body.ref_id ?? decoded?.transaction_code ?? null,
      amount: body.total_amount,
      reference: body.transaction_uuid ?? uuid,
      detail: `eSewa status ${body.status ?? 'unknown'}`,
      currency: CURRENCY,
    });

    return { ...result, raw: body };
  },
};
