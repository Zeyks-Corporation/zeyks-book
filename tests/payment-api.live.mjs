#!/usr/bin/env node
/**
 * Live check of the payment API's authentication boundary — LOCAL STACK ONLY.
 *
 * The offline suite (npm test) pins the pure decisions, the failure shapes and
 * the structure of the boundary. This script proves the wiring against real
 * infrastructure: a real local Supabase session, real RLS-filtered reads, a real
 * membership row, and the real Express server.
 *
 *   node tests/payment-api.live.mjs
 *
 * What it deliberately does NOT do:
 *   * it never points at a remote Supabase project — a non-local URL aborts the
 *     run before anything is created;
 *   * it never sends a request that would reach eSewa or Khalti. eSewa's
 *     *initiate* signs locally (no network), so the allowed path is exercised
 *     there; the verify/lookup routes are only ever called in ways that are
 *     refused *before* the provider is contacted (401, 404, 403), and Khalti's
 *     initiate is never called by a permitted caller because that one would hit
 *     dev.khalti.com. Every route's authorization decision is still proved.
 *   * it uses placeholder signing values (the server only needs *a* secret to
 *     be configured; the signature is computed locally and never sent anywhere).
 *
 * Fixtures: two throwaway users with generated emails, one business and one
 * invoice each, both created through the normal RPCs. The only thing it does not
 * go through the API for is adding the second user as a VIEWER, because no
 * client-side path grants membership — that one row goes in through psql in the
 * local database container, exactly as the pgTAP suites do.
 */

import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PAYMENT_API_TEST_PORT ?? 4199);
const APP = `http://127.0.0.1:${PORT}`;
const PLACEHOLDER_SECRET = 'sandbox-placeholder-not-a-real-secret';

let passed = 0;
let failed = 0;
const lines = [];

const check = (label, expected, actual) => {
  const ok = expected === actual;
  if (ok) passed += 1;
  else failed += 1;
  lines.push(`${ok ? '  ok  ' : '  FAIL'} ${label} (expected ${expected}, got ${actual})`);
};
const checkOk = (label, condition, detail = '') => {
  if (condition) passed += 1;
  else failed += 1;
  lines.push(`${condition ? '  ok  ' : '  FAIL'} ${label}${condition ? '' : ` — ${detail}`}`);
};

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** Refuse anything that is not this machine. Runs before any write. */
function assertLocal(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    console.error(`The payment API test needs a URL, got ${JSON.stringify(url)}.`);
    process.exit(2);
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
    || /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (!isLocal) {
    console.error(`Refusing to run: ${host} is not a local host. This check is local-stack only.`);
    process.exit(2);
  }
}

/** Local stack values, so the check needs no arguments when the stack is up. */
function localStackEnv() {
  try {
    const out = execFileSync('supabase', ['status', '-o', 'env'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const map = {};
    for (const raw of out.split('\n')) {
      const m = /^([A-Z_]+)="?(.*?)"?$/.exec(raw.trim());
      if (m) map[m[1]] = m[2];
    }
    return map;
  } catch {
    return null;
  }
}

const stack = localStackEnv();
const SUPABASE_URL = process.env.SUPABASE_URL ?? stack?.API_URL ?? 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? stack?.ANON_KEY ?? stack?.PUBLISHABLE_KEY ?? '';
if (!ANON) {
  console.error('Need the local publishable (anon) key: start the stack (`supabase start`) or set SUPABASE_PUBLISHABLE_KEY.');
  process.exit(2);
}
assertLocal(SUPABASE_URL);

/* -------------------------------------------------------------------------- */
/* Small HTTP client                                                          */
/* -------------------------------------------------------------------------- */

const rest = (p) => `${SUPABASE_URL}/rest/v1${p}`;
const auth = (p) => `${SUPABASE_URL}/auth/v1${p}`;

async function http(method, url, { token, body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const api = (p, { token, body } = {}) => http('POST', `${APP}${p}`, { token, body });

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

async function ensureUser(email, password) {
  const signup = await http('POST', auth('/signup'), { body: { email, password }, headers: { apikey: ANON } });
  if (signup.body?.access_token) return { token: signup.body.access_token, id: signup.body.user?.id };
  const signin = await http('POST', auth('/token?grant_type=password'), { body: { email, password }, headers: { apikey: ANON } });
  if (signin.body?.access_token) return { token: signin.body.access_token, id: signin.body.user?.id };
  throw new Error(`no session for ${email}: ${JSON.stringify(signup.body)}`);
}

async function createBusiness(token, name) {
  await http('POST', rest('/rpc/create_business'), {
    token, headers: { apikey: ANON }, body: { p_business_name: name, p_owner_name: name },
  });
  const res = await http('GET', rest('/businesses?select=id&order=created_at.desc&limit=1'), {
    token, headers: { apikey: ANON },
  });
  const id = res.body?.[0]?.id;
  if (!id) throw new Error(`could not read back the business: ${JSON.stringify(res.body)}`);
  return id;
}

async function createInvoice(token, businessId, amount, label) {
  const item = [{ line_no: 1, description: label, quantity: 1, unit_price: amount, discount: 0, total: amount }];
  const res = await http('POST', rest('/rpc/post_sale'), {
    token, headers: { apikey: ANON }, body: {
      p_business_id: businessId, p_customer_id: null, p_customer_name: 'Boundary Customer',
      p_invoice_number: '', p_date: new Date().toISOString().slice(0, 10),
      p_subtotal: amount, p_discount_total: 0,
      p_tax_amount: 0, p_total_amount: amount, p_upfront_paid: 0, p_payment_method: 'CASH',
      p_cost_of_goods: null, p_notes: 'payment-api boundary check', p_items: item,
    },
  });
  const sale = res.body?.sale ?? res.body?.data ?? null;
  if (!sale?.id) throw new Error(`post_sale failed: ${JSON.stringify(res.body)}`);
  return sale;
}

/** The one thing no client path may do: grant membership. Local psql only. */
function addViewerMembership(businessId, userId) {
  const containers = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' })
    .split('\n').map((n) => n.trim()).filter((n) => n.startsWith('supabase_db_'));
  if (containers.length === 0) return false;
  const sql = 'insert into public.business_memberships (business_id, user_id, role) '
    + `values ('${businessId}', '${userId}', 'VIEWER') `
    + 'on conflict (business_id, user_id) do update set role = \'VIEWER\';';
  execFileSync('docker', ['exec', '-i', containers[0], 'psql', '-U', 'postgres', '-d', 'postgres', '-c', sql],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  return true;
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PAYMENT_MODE: 'sandbox',
    APP_URL: 'http://127.0.0.1:3000',
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: ANON,
    ESEWA_PRODUCT_CODE: 'EPAYTEST',
    ESEWA_SECRET_KEY: PLACEHOLDER_SECRET,
    KHALTI_SECRET_KEY: PLACEHOLDER_SECRET,
    KHALTI_REFUND_SECRET_KEY: PLACEHOLDER_SECRET,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${APP}/api/payments/config`);
      if (res.status > 0) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

try {
  if (!(await waitForServer())) throw new Error('the API server did not start');
  console.log(`payment API on ${APP}, database ${SUPABASE_URL}\n`);

  const stamp = Date.now();
  const owner = await ensureUser(`payapi-owner-${stamp}@zeyks.test`, 'boundary-check-password');
  const other = await ensureUser(`payapi-other-${stamp}@zeyks.test`, 'boundary-check-password');
  const ownerBiz = await createBusiness(owner.token, `Boundary A ${stamp}`);
  const otherBiz = await createBusiness(other.token, `Boundary B ${stamp}`);
  const invoice = await createInvoice(owner.token, ownerBiz, 500, 'boundary check');

  // Asked before any membership exists: a stranger's invoice is a 404, so this
  // API never confirms that another tenant's document exists at all.
  const strangerCrossTenant = await api('/api/payments/esewa/initiate', {
    token: other.token, body: { saleId: invoice.id, amount: 100 },
  });
  check('a non-member cannot reach another tenant\u2019s invoice at all', 404, strangerCrossTenant.status);

  const viewerAdded = addViewerMembership(ownerBiz, other.id);

  const ROUTES = [
    ['GET', '/api/payments/config', undefined],
    ['POST', '/api/payments/esewa/initiate', { saleId: invoice.id, amount: 100, taxAmount: 0 }],
    ['POST', '/api/payments/esewa/verify', { transactionUuid: 'anything' }],
    ['POST', '/api/payments/khalti/initiate', { saleId: invoice.id, amount: 100 }],
    ['POST', '/api/payments/khalti/lookup', { pidx: 'anything' }],
  ];

  /* ---- anonymous ------------------------------------------------------- */
  for (const [method, route, body] of ROUTES) {
    const res = method === 'GET' ? await fetch(`${APP}${route}`) : await api(route, { body });
    check(`anonymous ${method} ${route}`, 401, res.status);
  }

  const malformed = await api('/api/payments/esewa/initiate', {
    token: 'not-a-bearer', body: { saleId: invoice.id, amount: 100 },
  });
  // 'not-a-bearer' is sent as a token, not as a scheme: no header at all here.
  check('anonymous with a made-up header', 401, malformed.status);

  const rejected = await api('/api/payments/esewa/initiate', {
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub2JvZHkifQ.c2lnbmF0dXJl',
    body: { saleId: invoice.id, amount: 100 },
  });
  check('a token that is not a session', 401, rejected.status);
  checkOk('and the rejection says nothing about the token',
    !JSON.stringify(rejected.body).includes('eyJ'), JSON.stringify(rejected.body));

  /* ---- authenticated, authorized --------------------------------------- */
  const config = await fetch(`${APP}/api/payments/config`, { headers: { Authorization: `Bearer ${owner.token}` } });
  check('owner GET /api/payments/config', 200, config.status);

  const noInvoice = await api('/api/payments/esewa/initiate', { token: owner.token, body: { amount: 100 } });
  check('owner initiate without an invoice', 400, noInvoice.status);

  const unknownInvoice = await api('/api/payments/esewa/initiate', {
    token: owner.token, body: { saleId: '00000000-0000-4000-8000-000000000000', amount: 100 },
  });
  check('owner initiate for an invoice that does not exist', 404, unknownInvoice.status);

  const overInvoice = await api('/api/payments/esewa/initiate', {
    token: owner.token, body: { saleId: invoice.id, amount: 600, taxAmount: 0 },
  });
  check('owner initiate above the invoice total', 422, overInvoice.status);

  const overViaTax = await api('/api/payments/esewa/initiate', {
    token: owner.token, body: { saleId: invoice.id, amount: 400, taxAmount: 200 },
  });
  check('owner initiate whose signed total exceeds the invoice', 422, overViaTax.status);

  const signed = await api('/api/payments/esewa/initiate', {
    token: owner.token, body: { saleId: invoice.id, amount: 400, taxAmount: 0 },
  });
  check('owner initiate against their own posted invoice', 200, signed.status);
  checkOk('the signed payload is a real eSewa form',
    signed.body?.method === 'FORM_POST' && /^https:\/\/rc-epay\.esewa\.com\.np\//.test(signed.body?.action ?? ''),
    JSON.stringify(signed.body).slice(0, 200));
  checkOk('and the reference it signs is the invoice number itself',
    String(signed.body?.fields?.transaction_uuid ?? '').startsWith(invoice.invoice_number),
    `${signed.body?.fields?.transaction_uuid} vs ${invoice.invoice_number}`);
  checkOk('with a bounded total', Number(signed.body?.fields?.total_amount) === 400,
    String(signed.body?.fields?.total_amount));
  checkOk('the response carries no merchant secret',
    !JSON.stringify(signed.body).includes(PLACEHOLDER_SECRET), 'the signing secret came back');

  /* ---- the same caller, a different business ---------------------------- */
  const ownInvoice = await createInvoice(other.token, otherBiz, 250, 'other boundary check');
  const otherOwn = await api('/api/payments/esewa/initiate', {
    token: other.token, body: { saleId: ownInvoice.id, amount: 250, taxAmount: 0 },
  });
  check('an owner of their own business is allowed there', 200, otherOwn.status);

  const crossTenant = await api('/api/payments/esewa/initiate', {
    token: other.token, body: { saleId: invoice.id, amount: 100 },
  });
  check('and a VIEWER of another tenant is refused on permission, on the same invoice', 403, crossTenant.status);

  /* ---- authenticated, not authorized ----------------------------------- */
  if (!viewerAdded) {
    console.log('  skip  VIEWER checks (docker/psql unavailable to grant membership)');
  } else {
    const viewerInitiate = await api('/api/payments/esewa/initiate', {
      token: other.token, body: { saleId: invoice.id, amount: 100 },
    });
    // A viewer sees the invoice (RLS allows reads) but may not collect on it —
    // except that this caller is a viewer of A and an owner of B: the decision
    // is per business, and 403 is the answer for A.
    check('a VIEWER of the business cannot collect on its invoice', 403, viewerInitiate.status);

    // A collection to point the reference routes at, created through the RPC
    // and then read back the way the API reads it.
    const ref = `LIVE-CHECK-${stamp}`;
    await http('POST', rest('/rpc/initiate_gateway_txn'), {
      token: owner.token, headers: { apikey: ANON }, body: {
        p_business_id: ownerBiz, p_provider: 'ESEWA', p_gateway_ref: ref,
        p_amount: 100, p_linked_sale_id: invoice.id, p_customer_name: 'Boundary Customer', p_currency: 'NPR',
      },
    });
    const found = await http('GET', rest(`/gateway_transactions?select=id,gateway_ref&gateway_ref=eq.${encodeURIComponent(ref)}`), {
      token: owner.token, headers: { apikey: ANON },
    });
    if (!found.body?.[0]?.id) {
      lines.push(`  skip  reference-route checks (no collection row: ${JSON.stringify(found.body).slice(0, 160)})`);
    } else {
      const viewerVerify = await api('/api/payments/esewa/verify', {
        token: other.token, body: { transactionUuid: ref },
      });
      check('a VIEWER cannot ask the provider about that collection', 403, viewerVerify.status);

      // `ref` is an eSewa collection, so the Khalti lookup must not resolve it
      // at all: a reference is scoped to its provider as well as to its tenant.
      const viewerLookup = await api('/api/payments/khalti/lookup', { token: other.token, body: { pidx: ref } });
      check('a reference is not looked up through the other provider', 404, viewerLookup.status);

      const khaltiRef = `KHALTI-LIVE-CHECK-${stamp}`;
      await http('POST', rest('/rpc/initiate_gateway_txn'), {
        token: owner.token, headers: { apikey: ANON }, body: {
          p_business_id: ownerBiz, p_provider: 'KHALTI', p_gateway_ref: khaltiRef,
          p_amount: 100, p_linked_sale_id: invoice.id, p_customer_name: 'Boundary Customer', p_currency: 'NPR',
        },
      });
      const khaltiFound = await http('GET', rest(`/gateway_transactions?select=id&gateway_ref=eq.${encodeURIComponent(khaltiRef)}`), {
        token: owner.token, headers: { apikey: ANON },
      });
      if (khaltiFound.body?.[0]?.id) {
        const viewerKhalti = await api('/api/payments/khalti/lookup', { token: other.token, body: { pidx: khaltiRef } });
        check('nor through the Khalti lookup on a Khalti collection', 403, viewerKhalti.status);
      } else {
        lines.push('  skip  the Khalti lookup viewer check (no Khalti collection fixture)');
      }

      const ownerWrongRef = await api('/api/payments/esewa/verify', {
        token: owner.token, body: { transactionUuid: `NOT-A-COLLECTION-${stamp}` },
      });
      check('and an unknown reference is not disclosed, even to the owner', 404, ownerWrongRef.status);

      const blobRef = Buffer.from(JSON.stringify({ transaction_uuid: ref })).toString('base64');
      const viewerBlob = await api('/api/payments/esewa/verify', {
        token: other.token, body: { data: blobRef },
      });
      check('a reference only inside the returned blob is authorized too', 403, viewerBlob.status);
    }

    const viewerCollection = await api('/api/payments/khalti/initiate', {
      token: other.token, body: { saleId: invoice.id, amount: 100 },
    });
    check('a VIEWER cannot start a Khalti payment either', 403, viewerCollection.status);
  }
} catch (e) {
  failed += 1;
  lines.push(`  FAIL ${e.message}`);
} finally {
  server.kill();
}

console.log(lines.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n--- API server log ---');
  console.log(serverLog.trim().slice(-2000));
}
process.exit(failed > 0 ? 1 : 0);
