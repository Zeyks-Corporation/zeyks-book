/**
 * Email verification codes (OTP): issue, verify, and exchange for a session.
 *
 * What this module replaced, and why, in one paragraph. The server used to keep
 * codes in a `Map` and accept `123456` for any address; the browser kept its own
 * copy of the code and fabricated a session object out of an email address. So
 * "signed in" meant: the client said so. Nothing had been verified, no Supabase
 * token existed, and every RLS-backed read failed for a person the UI had just
 * greeted by name.
 *
 * The properties this module holds now:
 *
 *   1. THE CODE IS GENERATED HERE, from `crypto.randomInt`, and is the only
 *      thing that can complete the challenge. There is no test code, no default
 *      code, and no branch that skips the comparison.
 *   2. IT IS STORED AS A KEYED HASH, with an expiry and an attempt budget, in a
 *      table no client role can see (migration 017). The plain code exists only
 *      in the email and, in development, on the server's own console.
 *   3. IT IS SINGLE-USE. Verifying it consumes the row; a second attempt with
 *      the same code finds nothing.
 *   4. IT CANNOT BECOME A SESSION BY ITSELF. A verified code is exchanged for a
 *      Supabase token hash (`admin.generateLink`), which the browser must
 *      present to Supabase Auth to obtain a real access token. This server
 *      never issues a session and never hands out an access token.
 *   5. IT FAILS CLOSED. With no Supabase configuration, no pepper, or (outside
 *      development) no mail provider, issuing a code is refused rather than
 *      simulated.
 *   6. IT IS RATE LIMITED on both axes — per email address and per network —
 *      using the same durable table, so a scripted client cannot use this
 *      endpoint as a mail relay, and the attempt budget bounds brute force.
 */

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { resendService } from './resend.js';

const TABLE = 'auth_otp_challenges';

/** How long a code is valid. Short enough to bound exposure, long enough to type. */
const CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses allowed against one code before it is burned. */
const MAX_ATTEMPTS = 5;
/** Sends allowed per email address inside the window. */
const EMAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_SENDS_PER_EMAIL = 5;
/** Sends allowed per network inside the window. */
const IP_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_IP = 20;
/** Rows older than this are deleted as the server works. */
const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

const url = () => (process.env.SUPABASE_URL ?? '').trim();
const secretKey = () =>
  (process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
/**
 * The key the code hash is derived with. `OTP_PEPPER` is the documented name;
 * falling back to the Supabase secret keeps a single-secret deployment working,
 * and the fallback is what makes the pepper mandatory in practice — there is no
 * code path where neither is set, because the admin API needs the same secret.
 */
const pepper = () => (process.env.OTP_PEPPER ?? secretKey()).trim();

const NOT_CONFIGURED =
  'Sign-in codes are not available right now: this server is missing its Supabase '
  + 'credentials (SUPABASE_URL and SUPABASE_SECRET_KEY). Set them and try again.';

let client = null;
let clientFor = '';

/** The service-role client, or null when this deployment has no credentials. */
function admin() {
  const projectUrl = url();
  const key = secretKey();
  if (!projectUrl || !key) return null;
  const fingerprint = `${projectUrl}|${key}`;
  if (!client || clientFor !== fingerprint) {
    client = createClient(projectUrl, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    clientFor = fingerprint;
  }
  return client;
}

/** Is development allowed to work without a mail provider (console code)? */
function isDevelopment() {
  return process.env.NODE_ENV !== 'production' && process.env.VERCEL !== '1';
}

/** Can this process issue a code at all? Used by the startup banner. */
export function otpConfigured() {
  return Boolean(admin() && pepper());
}

/** True when a code would only be printed to the server console. */
export function otpDeliveryIsConsoleOnly() {
  return !resendService.isConfigured();
}

/* -------------------------------------------------------------------------- */
/* Codes and hashes                                                           */
/* -------------------------------------------------------------------------- */

/** A cryptographically random six-digit code. */
function generateCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hashCode(code, key) {
  return crypto.createHmac('sha256', key).update(String(code)).digest('hex');
}

/** Constant-time comparison of two hex digests. */
function hashCodeMatches(code, storedHash, key) {
  const candidate = Buffer.from(hashCode(code, key), 'hex');
  const stored = Buffer.from(String(storedHash), 'hex');
  if (candidate.length === 0 || candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

/** A salted digest of the request IP — enough to rate limit, not an address. */
function hashIp(ip, key) {
  return crypto.createHmac('sha256', key).update(`ip:${ip}`).digest('hex');
}

function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/* -------------------------------------------------------------------------- */
/* Storage helpers                                                            */
/* -------------------------------------------------------------------------- */

/** How many rows match a column value since a moment — the rate limit counter. */
async function countSince(db, column, value, sinceIso) {
  const { count, error } = await db
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq(column, value)
    .gte('created_at', sinceIso);
  if (error) throw new Error(`OTP rate limit lookup failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Delete rows that expired long enough ago that nothing can need them.
 *
 * Called on the way into both endpoints, so the table stays bounded by its own
 * traffic instead of depending on a scheduled job a deployment may not have. A
 * failure here is logged and ignored: purging is housekeeping, and it must
 * never be the reason someone cannot sign in.
 */
async function purgeExpired(db) {
  const cutoff = new Date(Date.now() - PURGE_AFTER_MS).toISOString();
  const { error } = await db.from(TABLE).delete().lt('expires_at', cutoff);
  if (error) console.warn(`[otp] expired-row purge failed: ${error.message}`);
}

/** Mark a challenge used so it can never be verified again. */
async function consume(db, id, reason) {
  const { error } = await db
    .from(TABLE)
    .update({ consumed_at: new Date().toISOString(), consumed_reason: reason })
    .eq('id', id);
  if (error) console.warn(`[otp] could not mark a challenge consumed: ${error.message}`);
}

/* -------------------------------------------------------------------------- */
/* Issue                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Generate, store and email a code.
 *
 * Returns `{ ok: true, message }` or `{ ok: false, status, error }`; the route
 * turns the latter into a response. Never returns the code itself.
 */
export async function issueOtp({ email, name, ip }) {
  const db = admin();
  const key = pepper();
  if (!db || !key) return { ok: false, status: 503, error: NOT_CONFIGURED };

  const address = String(email ?? '').trim().toLowerCase();
  if (!isEmail(address)) {
    return { ok: false, status: 400, error: 'A valid email address is required.' };
  }
  const fullName = typeof name === 'string' ? name.trim().slice(0, 120) : '';

  await purgeExpired(db);

  // Rate limits, counted from the durable table rather than from process
  // memory: a deployment runs several instances, and a limit that resets with
  // every cold start is not a limit.
  const emailSince = new Date(Date.now() - EMAIL_WINDOW_MS).toISOString();
  if ((await countSince(db, 'email', address, emailSince)) >= MAX_SENDS_PER_EMAIL) {
    return {
      ok: false,
      status: 429,
      error: 'A code was sent to this address a moment ago. Wait a few minutes before requesting another.',
    };
  }

  const ipHash = ip ? hashIp(ip, key) : null;
  if (ipHash) {
    const ipSince = new Date(Date.now() - IP_WINDOW_MS).toISOString();
    if ((await countSince(db, 'request_ip_hash', ipHash, ipSince)) >= MAX_SENDS_PER_IP) {
      return {
        ok: false,
        status: 429,
        error: 'Too many code requests from this network. Please try again later.',
      };
    }
  }

  // Only the newest code is usable: requesting a second one retires the first,
  // so a stolen older email cannot be replayed later.
  const { error: invalidateError } = await db
    .from(TABLE)
    .update({ consumed_at: new Date().toISOString(), consumed_reason: 'superseded' })
    .eq('email', address)
    .is('consumed_at', null);
  if (invalidateError) throw new Error(`OTP invalidation failed: ${invalidateError.message}`);

  const code = generateCode();
  const { data: inserted, error: insertError } = await db
    .from(TABLE)
    .insert({
      email: address,
      code_hash: hashCode(code, key),
      full_name: fullName || null,
      request_ip_hash: ipHash,
      max_attempts: MAX_ATTEMPTS,
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    })
    .select('id')
    .single();
  if (insertError) throw new Error(`OTP storage failed: ${insertError.message}`);

  /** An undelivered code must not stay behind as a usable challenge. */
  const discard = async (why) => {
    if (inserted?.id) {
      const { error } = await db.from(TABLE).delete().eq('id', inserted.id);
      if (error) console.warn(`[otp] could not discard an undelivered code: ${error.message}`);
    }
    console.warn(`[otp] no code was delivered to ${address} (${why}).`);
  };

  if (resendService.isConfigured()) {
    try {
      await resendService.sendOtpEmail({ email: address, code, name: fullName });
    } catch {
      await discard('mail provider error');
      return {
        ok: false,
        status: 502,
        error: 'We could not send the verification email. Please try again in a moment.',
      };
    }
  } else if (isDevelopment()) {
    // Development only, and never through the API: the code goes to this
    // process's own console, which the developer already holds. It is not in
    // the response body, so it cannot reach a browser that did not get the
    // email. A production deployment without a provider refuses below instead.
    console.log(`[otp] development code for ${address}: ${code}`);
  } else {
    await discard('no mail provider configured');
    return {
      ok: false,
      status: 503,
      error: 'Email delivery is not configured on this server, so sign-in codes cannot be sent.',
    };
  }

  return { ok: true, message: `Verification code sent to ${address}. Check your inbox!` };
}

/* -------------------------------------------------------------------------- */
/* Verify                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Check a submitted code and, only when it is the issued one, mint a Supabase
 * token hash for the browser to exchange for a session.
 *
 * The failure messages are deliberately uniform: they never say whether an
 * address has an account, only whether a code is waiting for it.
 */
export async function verifyOtp({ email, code }) {
  const db = admin();
  const key = pepper();
  if (!db || !key) return { ok: false, status: 503, error: NOT_CONFIGURED };

  const address = String(email ?? '').trim().toLowerCase();
  if (!isEmail(address)) {
    return { ok: false, status: 400, error: 'A valid email address is required.' };
  }
  const submitted = String(code ?? '').trim();
  if (!/^\d{6}$/.test(submitted)) {
    return { ok: false, status: 400, error: 'Enter the 6-digit verification code sent to your email.' };
  }

  await purgeExpired(db);

  const { data: rows, error } = await db
    .from(TABLE)
    .select('id, code_hash, attempts, max_attempts, full_name, expires_at')
    .eq('email', address)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`OTP lookup failed: ${error.message}`);

  const challenge = rows?.[0];
  if (!challenge) {
    return {
      ok: false,
      status: 400,
      error: 'No verification code is waiting for this email address, or it has expired. Request a new one.',
    };
  }

  if (Date.parse(challenge.expires_at) <= Date.now()) {
    await consume(db, challenge.id, 'expired');
    return { ok: false, status: 400, error: 'That verification code has expired. Request a new one.' };
  }

  const budget = Number.isInteger(challenge.max_attempts) ? challenge.max_attempts : MAX_ATTEMPTS;
  if (challenge.attempts >= budget) {
    await consume(db, challenge.id, 'attempts-exhausted');
    return {
      ok: false,
      status: 429,
      error: 'Too many incorrect attempts for that code. Request a new one.',
    };
  }

  if (!hashCodeMatches(submitted, challenge.code_hash, key)) {
    const attempts = challenge.attempts + 1;
    const { error: bumpError } = await db.from(TABLE).update({ attempts }).eq('id', challenge.id);
    if (bumpError) console.warn(`[otp] could not record a failed attempt: ${bumpError.message}`);
    const left = budget - attempts;
    if (left <= 0) {
      await consume(db, challenge.id, 'attempts-exhausted');
      return {
        ok: false,
        status: 429,
        error: 'Too many incorrect attempts for that code. Request a new one.',
      };
    }
    return {
      ok: false,
      status: 400,
      error: `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`,
    };
  }

  // Correct. Burn it before anything else, so it cannot be replayed even if a
  // later step fails or the response never arrives.
  await consume(db, challenge.id, 'verified');

  return await mintSessionToken(db, address, challenge.full_name);
}

/* -------------------------------------------------------------------------- */
/* Verified code -> Supabase token                                            */
/* -------------------------------------------------------------------------- */

/**
 * Turn a verified address into a one-time Supabase token hash.
 *
 * The account is created here if this is a first sign-in (the address has just
 * been proved to belong to whoever asked), and the token is minted with the
 * admin API. No session and no access token is created or returned by this
 * server: the browser must present the hash to Supabase Auth itself, which is
 * the only place an access token is issued.
 */
async function mintSessionToken(db, email, fullName = '') {
  const name = typeof fullName === 'string' ? fullName.trim() : '';

  const { error: createError } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    ...(name ? { user_metadata: { full_name: name } } : {}),
  });
  const created = !createError;
  if (createError && !isAlreadyRegistered(createError)) {
    throw new Error(`Account lookup failed: ${createError.message}`);
  }

  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`Could not mint a session token: ${error.message}`);

  const tokenHash = data?.properties?.hashed_token;
  if (typeof tokenHash !== 'string' || !tokenHash.trim()) {
    throw new Error('Could not mint a session token: the auth service returned no token hash.');
  }

  if (created) {
    // Best effort, and only for an address this request just proved it controls.
    resendService.sendWelcomeEmail({ email, name: name || email.split('@')[0] }).catch(() => {});
  }

  return { ok: true, email, tokenHash: tokenHash.trim(), created };
}

/** Supabase reports an existing account a few different ways across versions. */
function isAlreadyRegistered(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  return code === 'email_exists'
    || code === 'user_already_exists'
    || /already\s+(?:been\s+)?(?:registered|exists)/i.test(message);
}
