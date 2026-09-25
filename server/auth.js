/**
 * Caller authentication and per-request authorization for the payment API.
 *
 * Identity comes from the Firebase ID token in the Authorization header.
 * `requireCaller` verifies the bearer token against Firebase Admin Auth and
 * attaches `req.caller`; nothing downstream may invent one.
 */

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import { redact, redactDetail } from './redact.js';
import { getSupabaseAdmin } from './supabase.js';

let adminAuth;
let adminDb;
let isAdminConfigured = false;
try {
  if (getApps().length === 0) {
    const projectId = process.env.FIREBASE_PROJECT_ID
      || process.env.VITE_FIREBASE_PROJECT_ID;
    if (!projectId) throw new Error('FIREBASE_PROJECT_ID is required for the API.');
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const serviceAccount = serviceAccountJson ? JSON.parse(serviceAccountJson) : null;
    if (serviceAccount && serviceAccount.project_id !== projectId) {
      throw new Error('Firebase service account project does not match FIREBASE_PROJECT_ID.');
    }
    const credential = serviceAccount ? cert(serviceAccount) : undefined;
    initializeApp({ projectId, ...(credential ? { credential } : {}) });
  }
  adminAuth = getAuth();
  adminDb = getFirestore();
  isAdminConfigured = true;
} catch {
  adminAuth = { verifyIdToken: async () => { throw new Error('Auth not configured'); } };
  adminDb = { collection: () => { throw new Error('Firestore not configured'); } };
}

/**
 * Can this process authenticate a caller at all?
 */
export function authConfigured() {
  return isAdminConfigured;
}

/** A shared fixed-window limiter; unlike a process-local map this is consistent
 * across Vercel function instances. The stored key is a digest, not an IP or UID.
 */
export async function consumeRateLimit(name, identity, windowMs, max) {
  const id = createHash('sha256').update(`${name}:${identity}`).digest('hex');
  const ref = adminDb.collection('_apiRateLimits').doc(id);
  const now = Date.now();
  const start = Math.floor(now / windowMs) * windowMs;
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const previous = snap.data();
    const count = previous?.windowStart === start ? Number(previous.count) || 0 : 0;
    if (count >= max) return false;
    tx.set(ref, {
      windowStart: start,
      count: count + 1,
      expiresAt: new Date(now + 2 * windowMs),
    });
    return true;
  });
}

/**
 * The one sentence per failure.
 */
export const AUTH_MESSAGES = {
  UNCONFIGURED: 'The payment API cannot verify sessions yet. Configure Firebase environment variables.',
  MISSING: 'Sign in to use payments.',
  MALFORMED: 'Sign in to use payments.',
  INVALID: 'Your session has expired or is not valid for this request. Sign in again.',
};

/** Longest token we will look at. */
const MAX_TOKEN_LENGTH = 4096;

/**
 * Parse an `Authorization` header.
 */
export function parseBearer(header) {
  if (typeof header !== 'string' || header.trim() === '') return { ok: false, reason: 'MISSING' };
  const match = /^Bearer[ \t]+([A-Za-z0-9\-._~+/]+=*)$/i.exec(header.trim());
  if (!match || match[1].length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'MALFORMED' };
  return { ok: true, token: match[1] };
}

/** The 401 body. */
export function rejectUnauthenticated(res, reason) {
  return res.status(401).json({ error: AUTH_MESSAGES[reason] ?? AUTH_MESSAGES.INVALID });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export async function verifyCallerToken(token) {
  return adminAuth.verifyIdToken(token);
}

export function isMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (!(value > 0) || value > 100_000_000) return false;
  return Number(value.toFixed(2)) === value;
}

const denied = (status, error) => ({ ok: false, status, error });

export function decideInvoiceAccess({ found, status, canWrite, signedTotal, invoiceTotal }) {
  if (!found) return denied(404, 'That invoice could not be found.');
  if (status !== 'POSTED') {
    return denied(409, 'That invoice is void. Only a posted invoice can be collected against.');
  }
  if (!canWrite) {
    return denied(403, 'You do not have permission to collect payments for this invoice.');
  }
  if (signedTotal > invoiceTotal + 0.005) {
    return denied(422, `That is more than the invoice is for (${invoiceTotal.toFixed(2)}).`);
  }
  return { ok: true };
}

export function decideCollectionAccess({ found, canWrite }) {
  if (!found) return denied(404, 'That payment reference could not be found.');
  if (!canWrite) {
    return denied(403, 'You do not have permission to manage payments for this business.');
  }
  return { ok: true };
}

const MAX_REF_LENGTH = 128;

function usableRef(value) {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  if (!ref || ref.length > MAX_REF_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(ref)) return null;
  return ref;
}

export function claimedRefs({ data, transactionUuid } = {}) {
  const refs = [];
  const push = (value) => {
    const ref = usableRef(value);
    if (ref && !refs.includes(ref)) refs.push(ref);
  };

  if (data) {
    try {
      const decoded = JSON.parse(Buffer.from(String(data), 'base64').toString('utf8'));
      push(decoded?.transaction_uuid);
    } catch {
      // Ignored decoding failure
    }
  }
  push(transactionUuid);
  return refs;
}

/* -------------------------------------------------------------------------- */
/* The middleware                                                             */
/* -------------------------------------------------------------------------- */

export async function requireCaller(req, res, next) {
  if (!authConfigured()) {
    return res.status(503).json({ error: AUTH_MESSAGES.UNCONFIGURED });
  }

  const parsed = parseBearer(req.headers.authorization);
  if (!parsed.ok) return rejectUnauthenticated(res, parsed.reason);

  try {
    const decodedToken = await adminAuth.verifyIdToken(parsed.token);
    if (decodedToken.email_verified !== true || !decodedToken.email) {
      return res.status(403).json({ error: 'Verify your email before opening your books.' });
    }
    req.caller = {
      id: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: true,
      token: parsed.token,
    };
    return next();
  } catch (e) {
    console.warn(`[payments] session check failed: ${redactDetail(e)}`);
    return rejectUnauthenticated(res, 'INVALID');
  }
}

/* -------------------------------------------------------------------------- */
/* Server-side reads with an explicit membership check                        */
/* -------------------------------------------------------------------------- */

function supabaseAdminOrThrow() {
  const client = getSupabaseAdmin();
  if (!client) throw new Error('Supabase payment authorization is not configured.');
  return client;
}

export async function findInvoice(caller, saleId) {
  try {
    const { data, error } = await supabaseAdminOrThrow()
      .from('sales')
      .select('id,business_id,status,total_amount,invoice_number,customer_name')
      .eq('id', saleId)
      .maybeSingle();
    if (error) throw error;
    return data ? { ...data, total_amount: Number(data.total_amount) } : null;
  } catch (e) {
    throw new Error(`Invoice lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function findCollection(caller, provider, gatewayRef) {
  try {
    const { data, error } = await supabaseAdminOrThrow()
      .from('gateway_transactions')
      .select('id,business_id,provider,gateway_ref,amount,status')
      .eq('provider', provider)
      .eq('gateway_ref', gatewayRef)
      .maybeSingle();
    if (error) throw error;
    return data ? { ...data, amount: Number(data.amount) } : null;
  } catch (e) {
    throw new Error(`Collection lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function businessAccess(caller, businessId) {
  if (!caller.emailVerified || !caller.email) return 'none';
  const admin = supabaseAdminOrThrow();
  const email = caller.email.trim().toLowerCase();
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) return 'none';

  // A profile's editable email alone must never link a Firebase identity to a
  // different Supabase Auth user. Confirm the Auth record owns the same email.
  const { data: authData, error: authError } = await admin.auth.admin.getUserById(profile.id);
  if (authError) throw authError;
  if (authData.user?.email?.trim().toLowerCase() !== email) return 'none';

  const { data: membership, error: membershipError } = await admin
    .from('business_memberships')
    .select('role')
    .eq('business_id', businessId)
    .eq('user_id', profile.id)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) return 'none';
  return membership.role === 'OWNER' || membership.role === 'ACCOUNTANT' ? 'write' : 'view';
}

export async function canWriteBusiness(caller, businessId) {
  return (await businessAccess(caller, businessId)) === 'write';
}

export async function authorizeInvoice(caller, { saleId, signedTotal }) {
  if (!isUuid(saleId)) return denied(400, 'An invoice is required to start a payment.');
  if (!isMoney(signedTotal)) return denied(400, 'Amount must be greater than zero.');

  const invoice = await findInvoice(caller, saleId);
  const access = invoice ? await businessAccess(caller, invoice.business_id) : 'none';
  if (access === 'none') return denied(404, 'That invoice could not be found.');
  const decision = decideInvoiceAccess({
    found: Boolean(invoice),
    status: invoice?.status,
    canWrite: access === 'write',
    signedTotal,
    invoiceTotal: Number(invoice?.total_amount ?? 0),
  });
  if (!decision.ok) return decision;
  return { ok: true, invoice };
}

export async function authorizeReference(caller, provider, gatewayRef) {
  const collection = await findCollection(caller, provider, gatewayRef);
  const access = collection ? await businessAccess(caller, collection.business_id) : 'none';
  if (access === 'none') return denied(404, 'That payment reference could not be found.');
  const decision = decideCollectionAccess({
    found: Boolean(collection),
    canWrite: access === 'write',
  });
  if (!decision.ok) return decision;
  return { ok: true, collection };
}

export async function authorizeReferences(caller, provider, refs) {
  for (const ref of refs) {
    const decision = await authorizeReference(caller, provider, ref);
    if (!decision.ok) return decision;
  }
  return { ok: true };
}

export function warnIfUnconfigured() {
  console.log('[payments] Firebase session verification active.');
}
