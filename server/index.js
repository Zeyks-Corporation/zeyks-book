/**
 * Zeyks Book — payment API.
 *
 * This process exists for one reason: eSewa's HMAC secret and Khalti's live
 * secret key must never be shipped to a browser. Anyone holding the eSewa
 * secret can forge a signature and mark any amount as paid, so every signing
 * and verification step happens here.
 *
 * Endpoints — the five `/api/payments/*` routes require a verified Supabase
 * session as of Stage 14 (`Authorization: Bearer <access token>`; see
 * ./auth.js). Three routes are public, because they are how a session is
 * obtained or how a stranger can write in, and each is bounded on its own
 * terms:
 *
 *   POST /api/auth/send-otp                emails a single-use sign-in code for
 *                                          this address (crypto-random, stored
 *                                          hashed, rate-limited per address and
 *                                          per network; see ./otp.js)
 *   POST /api/auth/verify-otp              verifies that code and answers with a
 *                                          single-use Supabase token hash — the
 *                                          browser exchanges it for a session
 *   POST /api/contact                      the contact form (rate-limited)
 *
 * Provider webhooks will be a *separate* mount with their own signature check,
 * because eSewa and Khalti call those without a user session — nothing below has
 * to change for that.
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
import { isEmailAddress, resendService } from './resend.js';
import { issueOtp, otpConfigured, otpDeliveryIsConsoleOnly, verifyOtp } from './otp.js';
import {
  authorizeInvoice, authorizeReferences, claimedRefs, requireCaller, warnIfUnconfigured,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 4000);
const MODE = process.env.PAYMENT_MODE === 'live' ? 'live' : 'sandbox';

app.use(express.json({ limit: '256kb' }));

/**
 * A small in-memory limiter for the provider-backed and public routes.
 *
 * It is a *spam* guard, not a security boundary: the OTP endpoints carry their
 * own durable per-address and per-network limits in the database (see
 * ./otp.js), because a limit that forgets everything on a cold start is not a
 * limit. This one only stops a scripted client from hammering what it can
 * reach, and it prunes its own map so a long-running process cannot be made to
 * hold one entry per source address forever.
 */
function rateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 1000) {
      for (const [seenKey, stamps] of hits) {
        if (stamps[stamps.length - 1] <= now - windowMs) hits.delete(seenKey);
      }
    }
    const key = req.ip ?? 'unknown';
    const window = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (window.length >= max) {
      return res.status(429).json({ error: message });
    }
    window.push(now);
    hits.set(key, window);
    next();
  };
}

const paymentLimiter = rateLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'Too many payment requests. Wait a minute and try again.',
});
const contactLimiter = rateLimiter({
  windowMs: 60 * 60_000,
  max: 5,
  message: 'Too many messages from this device. Please try again later.',
});
const otpLimiter = rateLimiter({
  windowMs: 10 * 60_000,
  max: 10,
  message: 'Too many code requests. Please wait a few minutes and try again.',
});

app.use('/api/payments', paymentLimiter);
app.use('/api/contact', contactLimiter);
app.use('/api/auth/send-otp', otpLimiter);

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

/* --------------------------------- Resend --------------------------------- */

app.get('/api/resend/status', (_req, res) => {
  res.json({ configured: resendService.isConfigured() });
});

app.post('/api/contact', async (req, res) => {
  const payload = req.body ?? {};
  const name = payload.name;
  const email = payload.email;
  const message = payload.message;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return fail(res, 400, 'Your name is required.');
  }
  if (!isEmailAddress(email)) {
    return fail(res, 400, 'A valid email address is required.');
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return fail(res, 400, 'A message body is required.');
  }
  if (message.length > 5000) {
    return fail(res, 400, 'That message is too long. Please keep it under 5000 characters.');
  }

  try {
    // The mail template escapes every field and turns the submitter's address
    // into `replyTo` only after it passes the same shape check (see ./resend.js).
    const result = await resendService.sendContactEmail({
      name: name.trim(),
      email: email.trim(),
      message: message.trim(),
    });
    res.json(result);
  } catch (e) {
    if (e && e.status === 400) return fail(res, 400, e.message, e);
    return fail(res, 500, 'Failed to send message via Resend.', e);
  }
});

/* --------------------------- Sign-in verification -------------------------- */

/**
 * The two public auth routes, and the one that is no longer here.
 *
 * `POST /api/auth/email` used to exist: an unauthenticated endpoint that would
 * mail a branded message, of a caller-chosen type, with a caller-chosen reset
 * link, to any recipient in the world. It is removed rather than guarded,
 * because nothing needs it — the browser never sends auth mail, and the two
 * routes below cover the flows that do. Auth mail is now server-initiated, for
 * a flow this server authorized: a code it generated for a rate-limited
 * request, and a welcome note for an address whose code was just verified.
 *
 * Neither route can issue a session. `verify-otp` answers with a one-time
 * Supabase token hash, which the browser must exchange with Supabase Auth
 * itself — that exchange is the only place a session is created.
 */

app.post('/api/auth/send-otp', async (req, res) => {
  const payload = req.body ?? {};
  const address = payload.email;
  const name = payload.name;
  if (!isEmailAddress(address)) {
    return fail(res, 400, 'A valid email address is required.');
  }

  try {
    const result = await issueOtp({ email: address, name, ip: req.ip });
    if (!result.ok) return fail(res, result.status, result.error);
    // Never the code, and never a session: the response says a code was sent,
    // and the only copy of that code is in the recipient's inbox (plus, in
    // development, this process's own console — see ./otp.js).
    return res.json({ success: true, message: result.message });
  } catch (e) {
    return fail(res, 500, 'Could not send a verification code.', e);
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const payload = req.body ?? {};
  const address = payload.email;
  const code = payload.code;
  if (!isEmailAddress(address)) {
    return fail(res, 400, 'A valid email address is required.');
  }
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
    return fail(res, 400, 'Enter the 6-digit verification code sent to your email.');
  }

  try {
    const result = await verifyOtp({ email: address, code });
    if (!result.ok) return fail(res, result.status, result.error);

    // A single-use token hash — not an access token, and not a session. It is
    // useless until the browser presents it to Supabase Auth, which is the only
    // issuer of a session in this product (see src/services/authService.ts).
    const answer = { success: true, email: result.email, tokenHash: result.tokenHash };
    return res.json(answer);
  } catch (e) {
    return fail(res, 500, 'Could not verify that code.', e);
  }
});

/* ------------------------------ Static build ------------------------------ */

const dist = path.resolve(__dirname, '../dist');

/**
 * The public pages that ship a document of their own.
 *
 * `scripts/prerender.mjs` writes one per route at build time
 * (`dist/pricing.html` and so on), so the canonical URL, title and description
 * in the HTML a crawler receives belong to the page it asked for instead of all
 * being the landing page's. The landing page is `dist/index.html`.
 */
const PRERENDERED_PAGES = ['signin', 'demo', 'pricing', 'about', 'contact', 'privacy', 'terms'];

app.use(express.static(dist));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();

  // `/pricing` has no file of that name, but `/pricing.html` does. Anything
  // that is not a prerendered public page gets the app shell, which is what
  // makes a hard refresh on a signed-in screen work.
  const slug = req.path.replace(/\/+$/, '').replace(/^\/+/, '').toLowerCase();
  const page = PRERENDERED_PAGES.find((name) => name === slug);
  const file = page ? `${page}.html` : 'index.html';
  res.sendFile(path.join(dist, file), (err) => { if (err) next(); });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Zeyks Book API on http://localhost:${PORT}  [${MODE}]`);
    console.log(`  eSewa   ${esewa.isConfigured() ? 'ready' : 'not configured'}`);
    console.log(`  Khalti  ${khalti.isConfigured() ? 'ready' : 'not configured — set KHALTI_SECRET_KEY'}`);
    console.log(`  Resend  ${resendService.isConfigured() ? 'ready' : 'not configured — set RESEND_API_KEY'}`);
    console.log(
      `  Sign-in ${otpConfigured()
        ? (otpDeliveryIsConsoleOnly()
          ? 'codes print to this console (development only)'
          : 'single-use codes emailed via Resend')
        : 'not configured — set SUPABASE_URL and SUPABASE_SECRET_KEY (see .env.example)'}`,
    );

    if (MODE === 'live') {
      console.log('[payments] live mode: merchant credentials in use; every route requires a signed-in session.');
    }
    warnIfUnconfigured();
  });
}

export default app;
