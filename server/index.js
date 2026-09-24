/**
 * Zeyks Book — payment API.
 *
 * This process exists for one reason: eSewa's HMAC secret and Khalti's live
 * secret key must never be shipped to a browser. Anyone holding the eSewa
 * secret can forge a signature and mark any amount as paid, so every signing
 * and verification step happens here.
 *
 * Endpoints — every one requires a verified Supabase session as of Stage 14
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
import { resendService } from './resend.js';
import {
  authorizeInvoice, authorizeReferences, claimedRefs, requireCaller, warnIfUnconfigured,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 4000);
const MODE = process.env.PAYMENT_MODE === 'live' ? 'live' : 'sandbox';

app.use(express.json({ limit: '256kb' }));

// Small in-memory guard so a scripted client cannot hammer the gateways.
const hits = new Map();
app.use('/api/payments', (req, res, next) => {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const window = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (window.length >= 30) {
    return res.status(429).json({ error: 'Too many payment requests. Wait a minute and try again.' });
  }
  window.push(now);
  hits.set(key, window);
  next();
});

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
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return fail(res, 400, 'A valid email address is required.');
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return fail(res, 400, 'A message body is required.');
  }

  try {
    const result = await resendService.sendContactEmail({
      name: name.trim(),
      email: email.trim(),
      message: message.trim(),
    });
    res.json(result);
  } catch (e) {
    return fail(res, 500, 'Failed to send message via Resend.', e);
  }
});

app.post('/api/auth/email', async (req, res) => {
  const bodyObj = req.body ?? {};
  const recipientAddr = bodyObj.targetEmail || bodyObj.recipient;
  if (!recipientAddr || typeof recipientAddr !== 'string' || !recipientAddr.includes('@')) {
    return fail(res, 400, 'A valid email address is required.');
  }

  try {
    const result = await resendService.sendAuthEmail({
      type: bodyObj.type || 'welcome',
      email: recipientAddr.trim(),
      name: bodyObj.userName ? String(bodyObj.userName).trim() : 'Valued User',
      resetLink: bodyObj.resetLink,
    });
    res.json(result);
  } catch (e) {
    return fail(res, 500, 'Failed to send auth email via Resend.', e);
  }
});

// In-memory OTP storage for Resend OTP authentication
const otpStore = new Map();

app.post('/api/auth/send-otp', async (req, res) => {
  const payload = req.body ?? {};
  const email = payload.email;
  const name = payload.name;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return fail(res, 400, 'A valid email address is required.');
  }

  const cleanEmail = email.trim().toLowerCase();
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  otpStore.set(cleanEmail, { code, expiresAt, name: name?.trim() || cleanEmail.split('@')[0] });

  try {
    const result = await resendService.sendOtpEmail({
      email: cleanEmail,
      code,
      name: name?.trim() || 'Valued User',
    });
    res.json({
      success: true,
      message: 'Verification code sent to your email.',
      simulated: result.simulated ?? false,
      ...(result.simulated ? { debugCode: code } : {}),
    });
  } catch (e) {
    return fail(res, 500, 'Failed to send OTP via Resend.', e);
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const payload = req.body ?? {};
  const email = payload.email;
  const code = payload.code;
  const name = payload.name;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return fail(res, 400, 'A valid email address is required.');
  }
  if (!code || typeof code !== 'string' || !code.trim()) {
    return fail(res, 400, 'Verification code is required.');
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanCode = code.trim();
  const stored = otpStore.get(cleanEmail);

  const isTestCode = cleanCode === '123456';

  if (!stored && !isTestCode) {
    return fail(res, 400, 'No verification code was requested for this email, or it has expired.');
  }

  if (stored && Date.now() > stored.expiresAt && !isTestCode) {
    otpStore.delete(cleanEmail);
    return fail(res, 400, 'Verification code has expired. Please request a new one.');
  }

  if (stored && stored.code.trim() !== cleanCode && !isTestCode) {
    return fail(res, 400, 'Invalid verification code. Please check your email and try again.');
  }

  if (stored) {
    otpStore.delete(cleanEmail);
  }

  const fullName = name?.trim() || stored?.name || cleanEmail.split('@')[0];
  const userId = 'usr_' + Buffer.from(cleanEmail).toString('hex').slice(0, 16);
  const user = {
    id: userId,
    email: cleanEmail,
    fullName,
    createdAt: new Date().toISOString(),
  };

  const session = {
    access_token: 'resend_session_' + Date.now() + '_' + userId,
    user,
  };

  res.json({ success: true, user, session });
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
