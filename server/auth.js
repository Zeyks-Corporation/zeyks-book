/** Neon Auth JWT verification and Neon Postgres payment authorization. */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { neonPool } from './neonDb.js';

let jwks;
let jwksEndpoint;

function getJwksUrl() {
  if (process.env.NEON_AUTH_JWKS_URL) return process.env.NEON_AUTH_JWKS_URL;
  const base = process.env.VITE_NEON_URL;
  if (!base) throw new Error('VITE_NEON_URL or NEON_AUTH_JWKS_URL is required to verify Neon Auth tokens.');
  const url = new URL(base.replace(/\/rest\/v1\/?$/, ''));
  const [first, ...rest] = url.hostname.split('.');
  url.hostname = `${first}.neonauth.${rest.join('.')}`;
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/auth/.well-known/jwks.json`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function remoteJwks() {
  const endpoint = getJwksUrl();
  if (!jwks || jwksEndpoint !== endpoint) {
    jwks = createRemoteJWKSet(new URL(endpoint));
    jwksEndpoint = endpoint;
  }
  return jwks;
}

export function authConfigured() {
  return Boolean(process.env.DATABASE_URL && (process.env.NEON_AUTH_JWKS_URL || process.env.VITE_NEON_URL));
}

export const AUTH_MESSAGES = {
  UNCONFIGURED: 'The payment API cannot verify Neon Auth sessions yet. Configure its Neon database connection.',
  MISSING: 'Sign in to use payments.',
  MALFORMED: 'Sign in to use payments.',
  INVALID: 'Your session has expired or is not valid for this request. Sign in again.',
};

const MAX_TOKEN_LENGTH = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const denied = (status, error) => ({ ok: false, status, error });

export function parseBearer(header) {
  if (typeof header !== 'string' || header.trim() === '') return { ok: false, reason: 'MISSING' };
  const match = /^Bearer[ \t]+([A-Za-z0-9\-._~+/]+=*)$/i.exec(header.trim());
  if (!match || match[1].length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'MALFORMED' };
  return { ok: true, token: match[1] };
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isMoney(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && value > 0 && value <= 100_000_000 && Number(value.toFixed(2)) === value;
}

export async function verifyCallerToken(token) {
  const { payload } = await jwtVerify(token, remoteJwks(), { algorithms: ['EdDSA'] });
  if (typeof payload.sub !== 'string' || !isUuid(payload.sub)) {
    throw new Error('Neon Auth token does not contain a valid user id.');
  }
  return { id: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
}

export function rejectUnauthenticated(res, reason) {
  return res.status(401).json({ error: AUTH_MESSAGES[reason] ?? AUTH_MESSAGES.INVALID });
}

export async function requireCaller(req, res, next) {
  if (!authConfigured()) return res.status(503).json({ error: AUTH_MESSAGES.UNCONFIGURED });
  const parsed = parseBearer(req.headers.authorization);
  if (!parsed.ok) return rejectUnauthenticated(res, parsed.reason);
  try {
    req.caller = { ...await verifyCallerToken(parsed.token), token: parsed.token };
    return next();
  } catch {
    return rejectUnauthenticated(res, 'INVALID');
  }
}

/** Query a single invoice, already constrained to this writer's membership. */
export async function findInvoice(caller, saleId) {
  try {
    const { rows } = await neonPool().query(
      `select s.id, s.business_id, s.status, s.total_amount, s.invoice_number, s.customer_name
       from public.sales s
       join public.business_memberships m on m.business_id = s.business_id
       join public.profiles p on p.id = m.user_id
       where s.id = $1::uuid and m.user_id = $2::uuid
         and m.role in ('OWNER', 'ACCOUNTANT') and p.role in ('plus', 'premium')
       limit 1`,
      [saleId, caller.id],
    );
    if (!rows[0]) return null;
    return { ...rows[0], total_amount: Number(rows[0].total_amount) };
  } catch (error) {
    throw new Error(`Invoice lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Query one gateway reference only within a business the caller may write. */
export async function findCollection(caller, provider, gatewayRef) {
  try {
    const { rows } = await neonPool().query(
      `select g.id, g.business_id, g.provider, g.gateway_ref, g.amount, g.status
       from public.gateway_transactions g
       join public.business_memberships m on m.business_id = g.business_id
       join public.profiles p on p.id = m.user_id
       where g.provider = $1 and g.gateway_ref = $2 and m.user_id = $3::uuid
         and m.role in ('OWNER', 'ACCOUNTANT') and p.role in ('plus', 'premium')
       limit 1`,
      [provider, gatewayRef, caller.id],
    );
    if (!rows[0]) return null;
    return { ...rows[0], amount: Number(rows[0].amount) };
  } catch (error) {
    throw new Error(`Collection lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function canWriteBusiness(caller, businessId) {
  if (!isUuid(businessId)) return false;
  try {
    const { rowCount } = await neonPool().query(
      `select 1 from public.business_memberships m
       join public.profiles p on p.id = m.user_id
       where m.business_id = $1::uuid and m.user_id = $2::uuid
         and m.role in ('OWNER', 'ACCOUNTANT') and p.role in ('plus', 'premium')
       limit 1`,
      [businessId, caller.id],
    );
    return rowCount === 1;
  } catch {
    return false;
  }
}

export function decideInvoiceAccess({ found, status, canWrite, signedTotal, invoiceTotal }) {
  if (!found) return denied(404, 'That invoice could not be found.');
  if (status !== 'POSTED') return denied(409, 'That invoice is void. Only a posted invoice can be collected against.');
  if (!canWrite) return denied(404, 'That invoice could not be found.');
  if (signedTotal > invoiceTotal + 0.005) {
    return denied(422, `That is more than the invoice is for (${invoiceTotal.toFixed(2)}).`);
  }
  return { ok: true };
}

export function decideCollectionAccess({ found, canWrite }) {
  if (!found || !canWrite) return denied(404, 'That payment reference could not be found.');
  return { ok: true };
}

const MAX_REF_LENGTH = 128;
function usableRef(value) {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  return ref && ref.length <= MAX_REF_LENGTH && !/[\u0000-\u001f\u007f]/.test(ref) ? ref : null;
}

export function claimedRefs({ data, transactionUuid } = {}) {
  const refs = [];
  const push = (value) => {
    const ref = usableRef(value);
    if (ref && !refs.includes(ref)) refs.push(ref);
  };
  if (data) {
    try { push(JSON.parse(Buffer.from(String(data), 'base64').toString('utf8'))?.transaction_uuid); }
    catch { /* Invalid provider return data is ignored. */ }
  }
  push(transactionUuid);
  return refs;
}

export async function authorizeInvoice(caller, { saleId, signedTotal }) {
  if (!isUuid(saleId)) return denied(400, 'An invoice is required to start a payment.');
  if (!isMoney(signedTotal)) return denied(400, 'Amount must be greater than zero.');
  const invoice = await findInvoice(caller, saleId);
  const decision = decideInvoiceAccess({
    found: Boolean(invoice), status: invoice?.status, canWrite: Boolean(invoice), signedTotal,
    invoiceTotal: Number(invoice?.total_amount ?? 0),
  });
  if (!decision.ok) return decision;
  return { ok: true, invoice };
}

export async function authorizeReference(caller, provider, gatewayRef) {
  const collection = await findCollection(caller, provider, gatewayRef);
  const decision = decideCollectionAccess({ found: Boolean(collection), canWrite: Boolean(collection) });
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
  if (!authConfigured()) console.warn('[payments] Neon Auth or DATABASE_URL is not configured.');
}
