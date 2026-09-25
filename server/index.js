/**
 * Zeyks Book — payment API.
 *
 * This process exists for one reason: eSewa's HMAC secret and Khalti's live
 * secret key must never be shipped to a browser. Anyone holding the eSewa
 * secret can forge a signature and mark any amount as paid, so every signing
 * and verification step happens here.
 *
 * Payment routes and the Supabase session bridge require a verified Firebase
 * session (`Authorization: Bearer <ID token>`; see ./auth.js). Contact and
 * service-status routes are public and rate limited. Provider webhooks need
 * separate signature verification because providers call them without a user
 * session.
 *
 *   GET  /api/payments/config              which providers are usable
 *   POST /api/payments/esewa/initiate      returns a signed form payload
 *   POST /api/payments/esewa/verify        verifies the callback, then asks eSewa
 *   POST /api/payments/khalti/initiate     server-to-server initiate, returns pidx
 *   POST /api/payments/khalti/lookup       authoritative status for a pidx
 *
 * The initiations and the lookups are the routes that spend a merchant secret,
 * so they also authorize: the invoice (or the collection behind the reference)
 * is read from Supabase and checked against the verified caller's membership
 * and role. A caller cannot name another tenant's invoice,
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
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esewa } from './esewa.js';
import { khalti } from './khalti.js';
import { ProviderResponseError } from './verification.js';
import { redact, redactDetail } from './redact.js';
import { resendService, isValidEmail } from './resend.js';
import {
  authorizeInvoice, authorizeReferences, claimedRefs, consumeRateLimit, requireCaller, warnIfUnconfigured,
} from './auth.js';
import { getSupabaseAdmin, createAnonClient } from './supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Trust Vercel's one proxy hop. A directly exposed local API must not accept a
// caller-supplied X-Forwarded-For address for its IP rate limit.
app.set('trust proxy', process.env.VERCEL ? 1 : false);
const PORT = Number(process.env.PORT ?? 4000);
const MODE = process.env.PAYMENT_MODE === 'live' ? 'live' : 'sandbox';
const APP_URL = (() => {
  const raw = process.env.APP_URL || (process.env.VERCEL ? '' : 'http://localhost:3000');
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if ((process.env.VERCEL || MODE === 'live') && url.protocol !== 'https:') return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
})();

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

/** Shared limiter per route family; Firestore keeps limits consistent across
 * serverless instances. Fail closed if the limiter store is unavailable.
 */
function rateLimit({ name, windowMs, max }) {
  return async (req, res, next) => {
    try {
      const identity = req.caller?.id ?? req.ip ?? 'unknown';
      const allowed = await consumeRateLimit(name, identity, windowMs, max);
      if (!allowed) {
        res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
        return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
      }
      return next();
    } catch (error) {
      console.error(`[rate-limit] ${name} limiter unavailable:`, redactDetail(error));
      return res.status(503).json({ error: 'This service is temporarily unavailable. Please retry shortly.' });
    }
  };
}

app.use('/api/payments', rateLimit({ name: 'payments', windowMs: 60_000, max: 30 }));
app.use('/api/payments', requireCaller);
app.use('/api/payments', rateLimit({ name: 'payments-user', windowMs: 60_000, max: 20 }));
app.use('/api/payments', (_req, res, next) => {
  try {
    if (!getSupabaseAdmin()) return res.status(503).json({ error: 'The payment database is not configured.' });
    return next();
  } catch (error) {
    console.error('[payments] Supabase configuration failed:', redactDetail(error));
    return res.status(503).json({ error: 'The payment database is temporarily unavailable.' });
  }
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
 * invoice comes from the database after a verified identity and membership
 * check; its amount and customer name do not come from the browser.
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

app.get('/api/payments/config', (_req, res) => {
  res.json({
    mode: MODE,
    esewa: { enabled: Boolean(APP_URL) && esewa.isConfigured(), productCode: esewa.productCode() },
    khalti: { enabled: Boolean(APP_URL) && khalti.isConfigured() },
  });
});

/* --------------------------------- eSewa ---------------------------------- */

app.post('/api/payments/esewa/initiate', async (req, res) => {
  if (!esewa.isConfigured()) return fail(res, 503, 'eSewa is not configured on the server.');
  if (!APP_URL) return fail(res, 503, 'The payment return URL is not configured on the server.');
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
      appUrl: APP_URL,
    }));
  } catch (e) {
    return fail(res, 500, 'Could not prepare the eSewa payment.', e);
  }
});

app.post('/api/payments/esewa/verify', async (req, res) => {
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

app.post('/api/payments/khalti/initiate', async (req, res) => {
  if (!khalti.isConfigured()) {
    return fail(res, 503, 'Khalti is not configured. Add KHALTI_SECRET_KEY to your .env file.');
  }
  if (!APP_URL) return fail(res, 503, 'The payment return URL is not configured on the server.');
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
      appUrl: APP_URL,
    });
    res.json(result);
  } catch (e) {
    return fail(res, 502, e.message ?? 'Khalti could not start the payment.', e);
  }
});

app.post('/api/payments/khalti/lookup', async (req, res) => {
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
 * src/services/authService.ts and functions/src/auth.ts): the Firebase callable
 * generates, stores, expires and verifies the code, then Firebase Auth issues
 * the access token. This server never sees an OTP again.
 */

/* ------------------------- Supabase Session Bridge ------------------------ */

app.post('/api/auth/supabase-session', rateLimit({ name: 'supabase-session-ip', windowMs: 60_000, max: 30 }), requireCaller, rateLimit({ name: 'supabase-session', windowMs: 60_000, max: 12 }), async (req, res) => {
  const email = req.caller.email?.trim().toLowerCase();
  if (!req.caller.emailVerified || !email) {
    return fail(res, 403, 'Verify your email before opening your books.');
  }
  const requestedName = req.body?.name;
  const name = typeof requestedName === 'string' ? requestedName.trim().slice(0, 120) : '';

  try {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) return fail(res, 503, 'The account sync service is not configured.');
    // The Firebase ID token is the authority for identity. Never accept an
    // email or user ID supplied only in the request body.
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id,email,full_name')
      .eq('email', email)
      .maybeSingle();
    if (profileError) throw profileError;

    let userId = profile?.id;
    let fullName = profile?.full_name || '';
    if (userId) {
      const { data: authUser, error: authUserError } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (authUserError) throw authUserError;
      if (authUser.user?.email?.trim().toLowerCase() !== email) {
        throw new Error('The profile email does not match the Supabase Auth user.');
      }
    }
    if (!userId) {
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { full_name: name },
      });
      if (error) throw error;
      userId = data.user.id;
      fullName = name;
      const { error: upsertError } = await supabaseAdmin.from('profiles').upsert({
        id: userId,
        email,
        full_name: fullName || email.split('@')[0],
      }, { onConflict: 'id' });
      if (upsertError) throw upsertError;
    }

    // Earlier bridge versions assigned a password derived from the email.
    // Replace it before issuing any new session to this verified Firebase user.
    const { error: passwordError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: randomBytes(48).toString('base64url'),
    });
    if (passwordError) throw passwordError;

    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    if (linkError) throw linkError;

    const verifyClient = createAnonClient();
    const { data: sessionData, error: verifyError } = await verifyClient.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: linkData.properties.verification_type,
    });
    if (verifyError || !sessionData.session) throw verifyError ?? new Error('No session returned.');

    return res.json({
      access_token: sessionData.session.access_token,
      refresh_token: sessionData.session.refresh_token,
    });
  } catch (e) {
    console.error('[Supabase Auth] Session sync failed:', redactDetail(e));
    return fail(res, 503, 'Could not synchronize your account. Please retry.');
  }
});

app.get('/api/resend/status', rateLimit({ name: 'resend-status', windowMs: 60_000, max: 30 }), (_req, res) => {
  res.json({ configured: resendService.isConfigured() });
});

app.post('/api/contact', rateLimit({ name: 'contact', windowMs: 60_000, max: 5 }), async (req, res) => {
  const payload = req.body ?? {};
  const name = payload.name;
  const email = payload.email;
  const message = payload.message;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return fail(res, 400, 'Your name is required.');
  }
  if (name.trim().length > 120) {
    return fail(res, 400, 'That name is too long.');
  }
  if (!email || typeof email !== 'string' || email.trim().length > 254 || !isValidEmail(email)) {
    return fail(res, 400, 'A valid email address is required.');
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return fail(res, 400, 'A message body is required.');
  }
  if (message.trim().length > 5_000) {
    return fail(res, 400, 'That message is too long.');
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
