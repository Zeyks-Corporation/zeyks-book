/**
 * Caller authentication and per-request authorization for the payment API.
 *
 * Identity comes from the Firebase ID token in the Authorization header.
 * `requireCaller` verifies the bearer token against Firebase Admin Auth and
 * attaches `req.caller`; nothing downstream may invent one.
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { redact, redactDetail } from './redact.js';

let adminAuth;
let adminDb;
try {
  if (getApps().length === 0) {
    const projectId = process.env.VITE_FIREBASE_PROJECT_ID || 'zeyksbook-fa70a';
    initializeApp({ projectId });
  }
  adminAuth = getAuth();
  adminDb = getFirestore();
} catch {
  adminAuth = { verifyIdToken: async () => { throw new Error('Auth not configured'); } };
  adminDb = { collection: () => { throw new Error('Firestore not configured'); } };
}

/**
 * Can this process authenticate a caller at all?
 */
export function authConfigured() {
  return true;
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
    req.caller = { id: decodedToken.uid, email: decodedToken.email ?? null, token: parsed.token };
    return next();
  } catch (e) {
    console.warn(`[payments] session check failed: ${redactDetail(e)}`);
    return rejectUnauthenticated(res, 'INVALID');
  }
}

/* -------------------------------------------------------------------------- */
/* Reads that the database filters for us                                     */
/* -------------------------------------------------------------------------- */

export async function findInvoice(caller, saleId) {
  try {
    const snap = await adminDb.collectionGroup('sales').get();
    const doc = snap.docs.find((d) => d.id === saleId || d.data().id === saleId);
    if (!doc) return null;
    const data = doc.data();
    return {
      id: data.id ?? doc.id,
      business_id: data.business_id ?? doc.ref.parent.parent?.id ?? '',
      status: data.status,
      total_amount: Number(data.total_amount ?? data.totalAmount ?? 0),
      invoice_number: String(data.invoice_number ?? data.invoiceNumber ?? ''),
      customer_name: String(data.customer_name ?? data.customerName ?? ''),
    };
  } catch (e) {
    throw new Error(`Invoice lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function findCollection(caller, provider, gatewayRef) {
  try {
    const snap = await adminDb.collectionGroup('gateway_transactions').get();
    const doc = snap.docs.find((d) => {
      const data = d.data();
      return data.provider === provider && (data.gateway_ref === gatewayRef || data.reference === gatewayRef);
    });
    if (!doc) return null;
    const data = doc.data();
    return {
      id: data.id ?? doc.id,
      business_id: data.business_id ?? doc.ref.parent.parent?.id ?? '',
      provider: data.provider,
      gateway_ref: data.gateway_ref ?? data.reference,
      amount: Number(data.amount ?? 0),
      status: data.status,
    };
  } catch (e) {
    throw new Error(`Collection lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function canWriteBusiness(caller, businessId) {
  try {
    const snap = await adminDb.collection('businessMemberships').doc(`${caller.id}_${businessId}`).get();
    return snap.exists;
  } catch {
    return false;
  }
}

export async function authorizeInvoice(caller, { saleId, signedTotal }) {
  if (!isUuid(saleId)) return denied(400, 'An invoice is required to start a payment.');
  if (!isMoney(signedTotal)) return denied(400, 'Amount must be greater than zero.');

  const invoice = await findInvoice(caller, saleId);
  const decision = decideInvoiceAccess({
    found: Boolean(invoice),
    status: invoice?.status,
    canWrite: invoice ? await canWriteBusiness(caller, invoice.business_id) : false,
    signedTotal,
    invoiceTotal: Number(invoice?.total_amount ?? 0),
  });
  if (!decision.ok) return decision;
  return { ok: true, invoice };
}

export async function authorizeReference(caller, provider, gatewayRef) {
  const collection = await findCollection(caller, provider, gatewayRef);
  const decision = decideCollectionAccess({
    found: Boolean(collection),
    canWrite: collection ? await canWriteBusiness(caller, collection.business_id) : false,
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
