/**
 * Caller authentication and per-request authorization for the payment API.
 *
 * Stage 13 found that every `/api/payments/*` route was reachable by anyone who
 * could reach the port, and one of them signs an eSewa payload with the
 * merchant's HMAC secret. The books were never at risk — only
 * `public.settle_gateway_txn` writes money, and it re-validates every field
 * against the persisted collection — but the server's merchant credentials
 * were not protected at all.
 *
 * This module is that boundary. Three rules it follows:
 *
 *   1. IDENTITY COMES FROM THE TOKEN, never from the request body. There is no
 *      user id, business id, role or email in any payload this server reads for
 *      authorization. `requireCaller` verifies the bearer token against Supabase
 *      Auth and attaches `req.caller`; nothing downstream may invent one.
 *
 *   2. AUTHORIZATION IS THE DATABASE'S OWN RULE. The role check is
 *      `public.can_write(business_id)` (migration 002) called *with the caller's
 *      token*, so the answer comes from `business_memberships` and `auth.uid()`.
 *      This file deliberately contains no role list: there is no second
 *      authorization model to drift from the first, and no client-supplied role
 *      in sight.
 *
 *   3. READ THE ROW THE CALLER CAN SEE. Ownership is proved by fetching the
 *      invoice or collection **through the caller's own client**, so RLS (not
 *      this file) decides whether the row is visible. A row in another tenant is
 *      indistinguishable from a row that does not exist: both are 404, so the
 *      API never confirms that someone else's invoice exists.
 *
 * What this boundary is NOT: the financial write path. It gates the use of
 * merchant credentials; `public.initiate_gateway_txn` and
 * `public.settle_gateway_txn` still re-derive membership, the invoice, the
 * outstanding balance and the provider identity from the database. Authentication
 * here narrows who can *ask*; it never decides what the ledger records.
 *
 * Deliberately deferred: provider webhooks. They are called by eSewa/Khalti
 * servers with no user session, so they will need a different mechanism (a
 * signature over the raw body) on a separate mount — see README, "Payment API
 * security model". Nothing here has to be undone for that.
 */

import { createClient } from '@supabase/supabase-js';
import { redact, redactDetail } from './redact.js';

const url = () => (process.env.SUPABASE_URL ?? '').trim();
const publishableKey = () => (process.env.SUPABASE_PUBLISHABLE_KEY ?? '').trim();

/**
 * Can this process authenticate a caller at all?
 *
 * The API fails **closed**: with no Supabase configuration it refuses every
 * request rather than serving one it cannot attribute to a person. The
 * configuration is the project URL plus the *publishable* (anon) key — the same
 * publicly-known key the browser uses. The service-role key is not needed here
 * and must never be, because every read goes through the caller's own token.
 */
export function authConfigured() {
  return Boolean(url() && publishableKey());
}

/**
 * The one sentence per failure. `MISSING` and `MALFORMED` are deliberately
 * identical: a prober learns nothing from the difference, and a real caller
 * gets the same instruction either way.
 */
export const AUTH_MESSAGES = {
  UNCONFIGURED:
    'The payment API cannot verify sessions yet, so it is refusing every request. '
    + 'Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY on the server.',
  MISSING: 'Sign in to use payments.',
  MALFORMED: 'Sign in to use payments.',
  INVALID: 'Your session has expired or is not valid for this request. Sign in again.',
};

/** Longest token we will even look at. Real access tokens are far shorter. */
const MAX_TOKEN_LENGTH = 4096;

/**
 * Parse an `Authorization` header. Pure, so every branch is testable without a
 * server: missing header, a non-Bearer scheme, a bearer with no token, and the
 * one shape that is accepted.
 */
export function parseBearer(header) {
  if (typeof header !== 'string' || header.trim() === '') return { ok: false, reason: 'MISSING' };
  // RFC 7235: the scheme name is case-insensitive, and the token is an
  // RFC 6750 b64token. Anything else is malformed rather than "empty".
  const match = /^Bearer[ \t]+([A-Za-z0-9\-._~+/]+=*)$/i.exec(header.trim());
  if (!match || match[1].length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'MALFORMED' };
  return { ok: true, token: match[1] };
}

/** The 401 body. The token never appears in it, and neither does any detail. */
export function rejectUnauthenticated(res, reason) {
  return res.status(401).json({ error: AUTH_MESSAGES[reason] ?? AUTH_MESSAGES.INVALID });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres would raise 22P02 on a non-uuid; refuse it before it gets there. */
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** A money amount the database would accept: positive, finite, at most 2dp. */
export function isMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (!(value > 0) || value > 100_000_000) return false;
  return Number(value.toFixed(2)) === value;
}

const denied = (status, error) => ({ ok: false, status, error });

/**
 * May this invoice be collected against, for this amount? Pure.
 *
 * 404 before anything else: an invoice in another tenant is invisible through
 * the caller's client, so "not found" is the honest answer and it discloses
 * nothing. Then the document state, then the caller's permission, then the
 * amount — the last one only as a signing bound (`settle_gateway_txn` and
 * `initiate_gateway_txn` recompute the real outstanding balance under a lock).
 */
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

/** May this caller manage the collection behind a provider reference? Pure. */
export function decideCollectionAccess({ found, canWrite }) {
  if (!found) return denied(404, 'That payment reference could not be found.');
  if (!canWrite) {
    return denied(403, 'You do not have permission to manage payments for this business.');
  }
  return { ok: true };
}

/** An eSewa reference must survive a round trip through a database filter. */
const MAX_REF_LENGTH = 128;

function usableRef(value) {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  if (!ref || ref.length > MAX_REF_LENGTH) return null;
  // No control characters: a reference is an identifier, not a payload.
  if (/[\u0000-\u001f\u007f]/.test(ref)) return null;
  return ref;
}

/**
 * Which collection references is this request claiming?
 *
 * eSewa's return carries a base64 `data` blob *and* the browser's remembered
 * `transaction_uuid`; if the two disagree, authorizing only the one the client
 * named would let a caller ask the status API about a transaction it does not
 * own. So both are collected here (unverified — the signature check happens in
 * esewa.js) and every one of them must resolve to a collection the caller may
 * write, or the request is refused. The blob is only read to *name* a
 * collection; it is never trusted as a result.
 */
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
      // An undecodable blob cannot name a collection. It is not an error yet:
      // the direct reference still has to authorize, and esewa.js will refuse
      // the blob itself when it tries to verify it.
    }
  }
  push(transactionUuid);
  return refs;
}

/* -------------------------------------------------------------------------- */
/* The middleware                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Verify the bearer token and attach the caller.
 *
 * `req.caller.supabase` is a client bound to *that* token, so every read the
 * route performs is filtered by RLS as the signed-in user. Nothing here logs or
 * echoes the token: a rejected session is logged through `redact`, which keeps
 * the shape of the failure and discards credential material.
 */
export async function requireCaller(req, res, next) {
  if (!authConfigured()) {
    return res.status(503).json({ error: AUTH_MESSAGES.UNCONFIGURED });
  }

  const parsed = parseBearer(req.headers.authorization);
  if (!parsed.ok) return rejectUnauthenticated(res, parsed.reason);

  const supabase = createClient(url(), publishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${parsed.token}` } },
  });

  let user = null;
  try {
    // `getUser(jwt)` asks Supabase Auth to validate the token. That is the
    // official path and it handles both signing-key schemes, so this process
    // never parses or verifies a JWT itself.
    const { data, error } = await supabase.auth.getUser(parsed.token);
    if (error) console.warn(`[payments] rejected a session: ${redact(error.message)}`);
    user = data?.user ?? null;
  } catch (e) {
    console.warn(`[payments] session check failed: ${redactDetail(e)}`);
  }

  if (!user) return rejectUnauthenticated(res, 'INVALID');

  req.caller = { id: user.id, email: user.email ?? null, supabase, token: parsed.token };
  return next();
}

/* -------------------------------------------------------------------------- */
/* Reads that the database filters for us                                     */
/* -------------------------------------------------------------------------- */

/** The invoice, as visible to the caller's own token (RLS decides). */
export async function findInvoice(caller, saleId) {
  const { data, error } = await caller.supabase
    .from('sales')
    .select('id, business_id, status, total_amount, invoice_number, customer_name')
    .eq('id', saleId)
    .maybeSingle();
  if (error) throw new Error(`Invoice lookup failed: ${error.message}`);
  return data ?? null;
}

/** The collection behind a provider reference, as visible to the caller. */
export async function findCollection(caller, provider, gatewayRef) {
  const { data, error } = await caller.supabase
    .from('gateway_transactions')
    .select('id, business_id, provider, gateway_ref, amount, status')
    .eq('provider', provider)
    .eq('gateway_ref', gatewayRef)
    .maybeSingle();
  if (error) throw new Error(`Collection lookup failed: ${error.message}`);
  return data ?? null;
}

/** `public.can_write(business_id)` — the database's OWNER/ACCOUNTANT rule. */
export async function canWriteBusiness(caller, businessId) {
  const { data, error } = await caller.supabase.rpc('can_write', { p_business_id: businessId });
  if (error) throw new Error(`Permission check failed: ${error.message}`);
  return data === true;
}

/* -------------------------------------------------------------------------- */
/* The two authorizations the routes need                                     */
/* -------------------------------------------------------------------------- */

/**
 * Authorize collecting against an invoice. Returns `{ ok, invoice }` or a
 * denial the route can hand straight to `fail()`.
 *
 * `signedTotal` is the amount that will end up *inside the provider's signed
 * payload* (eSewa signs `amount + tax_amount`), so it is the number bounded
 * against the invoice total — bounding only `amount` would leave the tax field
 * as a way around the bound.
 */
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

/** Authorize managing the collection behind one provider reference. */
export async function authorizeReference(caller, provider, gatewayRef) {
  const collection = await findCollection(caller, provider, gatewayRef);
  const decision = decideCollectionAccess({
    found: Boolean(collection),
    canWrite: collection ? await canWriteBusiness(caller, collection.business_id) : false,
  });
  if (!decision.ok) return decision;
  return { ok: true, collection };
}

/** Authorize every reference a request claims, or deny the whole request. */
export async function authorizeReferences(caller, provider, refs) {
  for (const ref of refs) {
    const decision = await authorizeReference(caller, provider, ref);
    if (!decision.ok) return decision;
  }
  return { ok: true };
}

/** One startup line, so a missing boundary is never discovered in production. */
export function warnIfUnconfigured() {
  if (authConfigured()) return;
  console.warn(
    '[payments] SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set, so every\n'
    + '  /api/payments/* request will be refused with 503. See .env.example.',
  );
}
