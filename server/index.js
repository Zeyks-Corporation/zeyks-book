/**
 * Zeyks Book — payment API.
 *
 * This process exists for one reason: eSewa's HMAC secret and Khalti's live
 * secret key must never be shipped to a browser. Anyone holding the eSewa
 * secret can forge a signature and mark any amount as paid, so every signing
 * and verification step happens here.
 *
 * Endpoints — every one requires a verified Firebase session as of Stage 14
 * (`Authorization: Bearer <access token>`; see ./auth.js). There is no public
 * route on this server today. Provider webhooks will be a *separate* mount with
 * their own signature check, because eSewa and Khalti call those without a user
 * session — nothing below has to change for that.
 *
 *   GET  /api/payments/config              which providers are usable
 *   POST /api/payments/esewa/initiate      returns a signed form payload
 *   POST /api/payments/esewa/verify        verifies the callback, then asks eSewa
 *   POST /api/payments/khalti/initiate     server-to-server initiate, returns pidx
 *   POST /api/payments/khalti/lookup       authoritative status for a pidx
 *
 * The initiations and the lookups are the routes that spend a merchant secret,
 * so they also authorize: the invoice (or the collection behind the reference)
 * is read through the caller's own token, and the permission check is the
 * database's `can_write` rule. A caller cannot name another tenant's invoice,
 * another tenant's collection, an amount above the invoice, or the reference
 * that gets signed.
 *
 * The rule the client follows: a payment is only posted to the ledger after a
 * server-side verify/lookup returns COMPLETE. A browser redirect is a hint,
 * never proof.
 *
 * Both verify/lookup endpoints answer in ONE internal result shape, built by
 * ./verification.js:
 *   { provider, verified, status, gateway_transaction_id, amount, currency,
 *     reference, detail, raw }
 * The browser forwards that shape (minus `raw`) to public.settle_gateway_txn,
 * which re-validates every field against the persisted collection and refuses a
 * payload that contradicts it. This process holds the secrets; the database
 * holds the authority over money. Neither trusts the browser.
 */

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esewa } from './esewa.js';
import { khalti } from './khalti.js';
import { ProviderResponseError } from './verification.js';
import { redact, redactDetail } from './redact.js';
import { resendService, validateContactSubmission } from './resend.js';
import {
  authorizeInvoice, authorizeReferences, claimedRefs, requireCaller, warnIfUnconfigured,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 4000);
const MODE = process.env.PAYMENT_MODE === 'live' ? 'live' : 'sandbox';

app.use(express.json({ limit: '256kb' }));

// Ensure serverless rewrites without /api prefix reach the Express routes
app.use((req, _res, next) => {
  if (req.url && !req.url.startsWith('/api')) {
    if (
      req.url.startsWith('/auth/') ||
      req.url.startsWith('/payments/') ||
      req.url.startsWith('/contact') ||
      req.url.startsWith('/resend/') ||
      req.url.startsWith('/business/')
    ) {
      req.url = '/api' + req.url;
    }
  }
  next();
});

// Small in-memory guard so a scripted client cannot hammer a route.
//
// Every entry is a sliding window of timestamps, and the sweep below bounds
// the store: without it, a flood of distinct source addresses would grow the
// map without limit — the memory-exhaustion half of "rate-limit the endpoint".
const HIT_WINDOWS = new Map();
const HIT_SWEEP_MS = 5 * 60_000;
const HIT_MAX_KEYS = 5_000;

/** One limiter per route family, keyed by source address. */
function rateLimit({ name, windowMs, max }) {
  return (req, res, next) => {
    const key = `${name}:${req.ip ?? 'unknown'}`;
    const now = Date.now();
    const window = (HIT_WINDOWS.get(key) ?? []).filter((t) => now - t < windowMs);
    if (window.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
    }
    window.push(now);
    HIT_WINDOWS.set(key, window);
    return next();
  };
}

// Purge keys with no recent hits, then cap the map even under a flood of
// distinct addresses. `unref` keeps this timer from holding the process open.
setInterval(() => {
  const cutoff = Date.now() - HIT_SWEEP_MS;
  for (const [key, times] of HIT_WINDOWS) {
    if (!times.some((t) => t > cutoff)) HIT_WINDOWS.delete(key);
  }
  for (const key of HIT_WINDOWS.keys()) {
    if (HIT_WINDOWS.size <= HIT_MAX_KEYS) break;
    HIT_WINDOWS.delete(key);
  }
}, HIT_SWEEP_MS).unref?.();

app.use('/api/payments', rateLimit({ name: 'payments', windowMs: 60_000, max: 30 }));

/**
 * One failure path for the whole API.
 *
 * The message is masked before it is logged or returned, because a provider
 * error body is echoed to the client on purpose (a field-level rejection is
 * useful) and that echo is the only place a credential could travel. Business
 * errors keep their wording: over-settlement, unconfigured provider, bad amount.
 */
const fail = (res, status, message, detail) => {
  const safe = redact(message) || 'The payment request failed.';
  if (detail) console.error(`[payments] ${safe}`, redactDetail(detail));
  return res.status(status).json({ error: safe });
};

/**
 * Run a server-side step that only fails on a real fault — a lookup the
 * database refused to answer. The caller gets one generic sentence; the detail
 * goes to the log through `fail`, where redaction has already been applied.
 * Used for the authorization lookups, whose errors are ours and not the
 * browser's to interpret.
 */
const guard = async (res, message, work) => {
  try {
    return { ok: true, value: await work() };
  } catch (e) {
    fail(res, 500, message, e);
    return { ok: false };
  }
};

/**
 * The shared authorization for the two initiation routes.
 *
 * Returns the invoice on success, or `null` after answering the request. The
 * invoice comes from the caller's own RLS-filtered read, so its `business_id`,
 * amount and customer name are the database's, not the browser's.
 */
const authorizeInvoiceOrReply = async (req, res, { saleId, signedTotal }) => {
  const result = await guard(res, 'The invoice could not be authorized.',
    () => authorizeInvoice(req.caller, { saleId, signedTotal }));
  if (!result.ok) return null;
  if (!result.value.ok) {
    fail(res, result.value.status, result.value.error);
    return null;
  }
  return result.value.invoice;
};

app.get('/api/payments/config', requireCaller, (_req, res) => {
  res.json({
    mode: MODE,
    esewa: { enabled: esewa.isConfigured(), productCode: esewa.productCode() },
    khalti: { enabled: khalti.isConfigured() },
  });
});

/* --------------------------------- eSewa ---------------------------------- */

app.post('/api/payments/esewa/initiate', requireCaller, async (req, res) => {
  if (!esewa.isConfigured()) return fail(res, 503, 'eSewa is not configured on the server.');
  const { saleId, amount, taxAmount = 0 } = req.body ?? {};
  const value = Number(amount);
  const tax = Number(taxAmount) || 0;
  if (!Number.isFinite(value) || value <= 0) return fail(res, 400, 'Amount must be greater than zero.');

  try {
    // eSewa signs `amount + tax_amount`, so the bound is applied to the total
    // that would be signed — bounding `amount` alone would leave the tax field
    // as a way past it.
    const invoice = await authorizeInvoiceOrReply(req, res, { saleId, signedTotal: value + tax });
    if (!invoice) return;

    res.json(esewa.buildFormPayload({
      amount: value,
      taxAmount: tax,
      // The invoice's own number, not a string the browser chose: the signed
      // payload cannot name something other than the invoice it is bound to.
      reference: invoice.invoice_number,
      customerName: invoice.customer_name,
      appUrl: process.env.APP_URL ?? `http://localhost:3000`,
    }));
  } catch (e) {
    return fail(res, 500, 'Could not prepare the eSewa payment.', e);
  }
});

app.post('/api/payments/esewa/verify', requireCaller, async (req, res) => {
  if (!esewa.isConfigured()) return fail(res, 503, 'eSewa is not configured on the server.');
  const { data, transactionUuid, totalAmount } = req.body ?? {};

  // Every reference this request claims — the one the browser remembered and
  // the one inside the returned blob — must be a collection the caller may
  // write. Asking the status API about somebody else's transaction is not a
  // service this server offers.
  const refs = claimedRefs({ data, transactionUuid });
  if (refs.length === 0) return fail(res, 400, 'A transaction id is required to verify with eSewa.');
  const allowed = await guard(res, 'The payment could not be authorized.',
    () => authorizeReferences(req.caller, 'ESEWA', refs));
  if (!allowed.ok) return;
  if (!allowed.value.ok) return fail(res, allowed.value.status, allowed.value.error);

  try {
    const result = await esewa.verify({ data, transactionUuid, totalAmount });
    res.json(result);
  } catch (e) {
    // A malformed or contradicted provider answer is a failure the client must
    // record as NOT_VERIFIED — never something to read as success.
    if (e instanceof ProviderResponseError) {
      return fail(res, 502, e.message, e);
    }
    return fail(res, 502, e.message ?? 'eSewa verification failed.', e);
  }
});

/* --------------------------------- Khalti --------------------------------- */

app.post('/api/payments/khalti/initiate', requireCaller, async (req, res) => {
  if (!khalti.isConfigured()) {
    return fail(res, 503, 'Khalti is not configured. Add KHALTI_SECRET_KEY to your .env file.');
  }
  const { saleId, amount, customerEmail, customerPhone } = req.body ?? {};
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 10) {
    return fail(res, 400, 'Khalti requires an amount of at least NPR 10.');
  }

  const invoice = await authorizeInvoiceOrReply(req, res, { saleId, signedTotal: value });
  if (!invoice) return;

  try {
    const result = await khalti.initiate({
      amount: value,
      reference: invoice.invoice_number,
      purchaseName: invoice.invoice_number,
      customerName: invoice.customer_name,
      customerEmail: String(customerEmail ?? ''),
      customerPhone: String(customerPhone ?? ''),
      appUrl: process.env.APP_URL ?? 'http://localhost:3000',
    });
    res.json(result);
  } catch (e) {
    return fail(res, 502, e.message ?? 'Khalti could not start the payment.', e);
  }
});

app.post('/api/payments/khalti/lookup', requireCaller, async (req, res) => {
  if (!khalti.isConfigured()) return fail(res, 503, 'Khalti is not configured on the server.');
  const { pidx } = req.body ?? {};
  if (!pidx) return fail(res, 400, 'A pidx is required.');

  const refs = claimedRefs({ transactionUuid: pidx });
  const allowed = await guard(res, 'The payment could not be authorized.',
    () => authorizeReferences(req.caller, 'KHALTI', refs));
  if (!allowed.ok) return;
  if (!allowed.value.ok) return fail(res, allowed.value.status, allowed.value.error);

  try {
    res.json(await khalti.lookup(String(pidx)));
  } catch (e) {
    if (e instanceof ProviderResponseError) {
      return fail(res, 502, e.message, e);
    }
    return fail(res, 502, e.message ?? 'Khalti lookup failed.', e);
  }
});

/* --------------------------------- Contact -------------------------------- */
/*
 * The contact form is the ONE public, state-changing endpoint left on this
 * server, and it sends branded mail, so it is rate-limited, bounded and
 * validated here rather than in the browser.
 *
 * The auth-mail and OTP endpoints that used to live below this are gone. They
 * let an unauthenticated caller send branded email to any address with a
 * caller-supplied reset link, and the OTP pair authenticated anyone who typed
 * `123456`. Sign-in now happens entirely through Firebase Auth (see
 * src/services/authService.ts): Firebase generates, stores, expires and
 * verifies the code, and issues the real access token every Firestore-backed read
 * depends on. This server never sees an OTP again.
 */

app.get('/api/resend/status', (_req, res) => {
  res.json({ configured: resendService.isConfigured() });
});

app.post('/api/contact', rateLimit({ name: 'contact', windowMs: 60_000, max: 5 }), async (req, res) => {
  const checked = validateContactSubmission(req.body ?? {});
  if (!checked.ok) return fail(res, 400, checked.error);

  try {
    res.json(await resendService.sendContactEmail(checked.values));
  } catch (e) {
    return fail(res, 500, 'Failed to send message via Resend.', e);
  }
});

/* ------------------------------ Static build ------------------------------ */

const dist = path.resolve(__dirname, '../dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(dist, 'index.html'), (err) => { if (err) next(); });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Zeyks Book API on http://localhost:${PORT}  [${MODE}]`);
    console.log(`  eSewa   ${esewa.isConfigured() ? 'ready' : 'not configured'}`);
    console.log(`  Khalti  ${khalti.isConfigured() ? 'ready' : 'not configured — set KHALTI_SECRET_KEY'}`);
    console.log(`  Resend  ${resendService.isConfigured() ? 'ready' : 'configured for simulation — set RESEND_API_KEY'}`);

    if (MODE === 'live') {
      console.log('[payments] live mode: merchant credentials in use; every route requires a signed-in session.');
    }
    warnIfUnconfigured();
  });
}

export default app;
