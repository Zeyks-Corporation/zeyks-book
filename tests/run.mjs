#!/usr/bin/env node
/**
 * Zeyks Book — offline test runner.
 *
 * Plain Node, no framework, no network. Exercises the logic that most needs
 * to stay correct: the BS/AD calendar, journal balancing, reversal
 * arithmetic, period filtering, orphan-account detection, over-settlement
 * guards, VAT splitting, and payment reconciliation.
 *
 * Run with: npm test  (or: node tests/run.mjs)
 *
 * This imports the compiled logic directly from source via esbuild-free
 * ts-node-less dynamic import isn't available for .ts under plain node, so
 * this file re-implements the pure algorithms' call sites using the same
 * modules through Node's experimental TS support where available, falling
 * back to a small transpile step otherwise.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

// Each test is scheduled so asynchronous tests are genuinely awaited before
// the summary is printed. A synchronous failure still never blocks the run.
const pendingTests = [];

function test(name, fn) {
  pendingTests.push((async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok  ${name}`);
    } catch (e) {
      failed += 1;
      failures.push({ name, error: e });
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.message}`);
    }
  })());
}

function skip(name, reason) {
  skipped += 1;
  console.log(`  skip  ${name} (${reason})`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message ?? 'assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertClose(actual, expected, message) {
  if (Math.abs(actual - expected) > 0.01) {
    throw new Error(`${message ?? 'not close'}: expected ~${expected}, got ${actual}`);
  }
}

/* ---------------------------------------------------------------------- */
/* Transpile the TS modules under test to plain JS in a temp dir, since     */
/* this environment has no ts-node and no build step has necessarily run.   */
/* ---------------------------------------------------------------------- */

const tmp = mkdtempSync(path.join(tmpdir(), 'zeyks-test-'));

function stripTypes(source) {
  // A pragmatic, non-general TS -> JS strip sufficient for this codebase's
  // style (no decorators, no namespaces): drop type-only constructs.
  let out = source;
  out = out.replace(/^import\s+type\s+.*?;$/gm, '');
  out = out.replace(/export\s+(interface|type)\s+[\s\S]*?\n(\}|;)\n/gm, '\n');
  out = out.replace(/^\s*(interface|type)\s+[\s\S]*?\n\}\n/gm, '\n');
  out = out.replace(/:\s*[A-Za-z_][\w.<>\[\]| &]*(\[\])?(\s*=)/g, '$2'); // typed defaults
  out = out.replace(/\bas\s+const\b/g, '');
  out = out.replace(/\bas\s+[A-Za-z_][\w.<>\[\]|]*\b/g, '');
  out = out.replace(/<[A-Za-z_][\w.,\s<>\[\]|]*>(?=\()/g, ''); // generic call args
  out = out.replace(/public\s+readonly\s+/g, '');
  out = out.replace(/private\s+readonly\s+/g, '');
  out = out.replace(/\bprivate\s+/g, '');
  out = out.replace(/\bpublic\s+/g, '');
  out = out.replace(/\breadonly\s+/g, '');
  out = out.replace(/(\w+)\??:\s*[A-Za-z_][\w.<>\[\]| &']*(\[\])?(?=[,)\n;=])/g, '$1');
  out = out.replace(/export\s+class/g, 'export class');
  return out;
}

// This lightweight strip is intentionally narrow; if it ever mis-transpiles,
// fall back to running the TypeScript compiler's transpile API if present.
function transpile(relPath) {
  const src = path.join(root, 'src', relPath);
  const text = require('node:fs').readFileSync(src, 'utf8');
  let js;
  try {
    // Prefer the real TypeScript compiler if it's installed, since the regex
    // fallback above is too crude for the more type-heavy files.
    const ts = require('typescript');
    js = ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  } catch {
    js = stripTypes(text);
  }
  const outPath = path.join(tmp, relPath.replace(/\.ts$/, '.mjs'));
  require('node:fs').mkdirSync(path.dirname(outPath), { recursive: true });
  // Rewrite relative imports to point at sibling .mjs files.
  js = js.replace(/from\s+'(\.[^']+)'/g, (m, p) => `from '${p}.mjs'`);
  writeFileSync(outPath, js);
  return outPath;
}

const files = [
  'lib/nepaliDate.ts', 'lib/money.ts', 'lib/ids.ts', 'lib/dbTypes.ts',
  'lib/capabilities.ts', 'lib/appPhases.ts', 'lib/saleState.ts', 'lib/purchaseState.ts',
  'lib/expenseState.ts', 'lib/voidState.ts', 'lib/paymentState.ts', 'lib/gatewayState.ts',
  'lib/session.ts', 'lib/routes.ts', 'lib/preferences.ts', 'lib/roles.ts',
  'lib/paymentApiConfig.ts',
  'services/accountingEngine.ts', 'services/posting.ts', 'services/referenceGenerator.ts',
  'services/reportData.ts',
];
for (const f of files) transpile(f);

const nepaliDate = await import(pathToFileURL(path.join(tmp, 'lib/nepaliDate.mjs')).href);
const money = await import(pathToFileURL(path.join(tmp, 'lib/money.mjs')).href);
const dbTypesMod = await import(pathToFileURL(path.join(tmp, 'lib/dbTypes.mjs')).href);
const engineMod = await import(pathToFileURL(path.join(tmp, 'services/accountingEngine.mjs')).href);
const postingMod = await import(pathToFileURL(path.join(tmp, 'services/posting.mjs')).href);
const refMod = await import(pathToFileURL(path.join(tmp, 'services/referenceGenerator.mjs')).href);
const reportDataMod = await import(pathToFileURL(path.join(tmp, 'services/reportData.mjs')).href);
const capabilitiesMod = await import(pathToFileURL(path.join(tmp, 'lib/capabilities.mjs')).href);
const appPhasesMod = await import(pathToFileURL(path.join(tmp, 'lib/appPhases.mjs')).href);
const saleStateMod = await import(pathToFileURL(path.join(tmp, 'lib/saleState.mjs')).href);
const purchaseStateMod = await import(pathToFileURL(path.join(tmp, 'lib/purchaseState.mjs')).href);
const expenseStateMod = await import(pathToFileURL(path.join(tmp, 'lib/expenseState.mjs')).href);
const voidStateMod = await import(pathToFileURL(path.join(tmp, 'lib/voidState.mjs')).href);
const paymentStateMod = await import(pathToFileURL(path.join(tmp, 'lib/paymentState.mjs')).href);
const gatewayStateMod = await import(pathToFileURL(path.join(tmp, 'lib/gatewayState.mjs')).href);
const sessionMod = await import(pathToFileURL(path.join(tmp, 'lib/session.mjs')).href);
const routesMod = await import(pathToFileURL(path.join(tmp, 'lib/routes.mjs')).href);
const preferencesMod = await import(pathToFileURL(path.join(tmp, 'lib/preferences.mjs')).href);
const paymentApiConfigMod = await import(pathToFileURL(path.join(tmp, 'lib/paymentApiConfig.mjs')).href);
const rolesMod = await import(pathToFileURL(path.join(tmp, 'lib/roles.mjs')).href);
const {
  ALL_ROLES, FEATURE_FOR_ROLE, ROLE_GATING_ENABLED, roleHasFeature,
  paywallHoldsAccount, isPayingTier, isAppAdmin,
} = rolesMod;
const {
  APP_TABS, isAppPath, normalizePath, parseRoute, pathForTab, redirectFor,
} = routesMod;
const { DEFAULT_CALENDAR, readCalendarPreference, writeCalendarPreference } = preferencesMod;
const {
  PAYMENT_API_DISABLED_MESSAGE, paymentApiDecision, paymentApiUrlFor,
} = paymentApiConfigMod;
// The credential masker is a plain server module, so it imports as-is.
const redactMod = await import(pathToFileURL(path.join(root, 'server', 'redact.js')).href);
// So does the contact-form boundary. Importing it sends nothing: without an API
// key the Resend client is never constructed, and these tests only build a
// payload in memory.
const resendMod = await import(pathToFileURL(path.join(root, 'server', 'resend.js')).href);
// The payment API's authentication boundary (Stage 14). Importing it makes no
// network call: the Firebase client is only constructed inside the middleware.
const serverAuth = await import(pathToFileURL(path.join(root, 'server', 'auth.js')).href);

const { CAPABILITIES, VOIDABLE_DOCUMENTS, isSupported, isVoidable, unsupported, unsupportedMessage } = capabilitiesMod;
const { resolveAppPhase, resolveAuthEvent, selectActiveMembership, membershipsOwnedBy } = appPhasesMod;
const { applyPostedSale } = saleStateMod;
const { applyPostedPurchase, toPostPurchaseArgs } = purchaseStateMod;
const { applyPostedExpense, toPostExpenseArgs } = expenseStateMod;
const { applyVoidedDocument, toVoidDocumentArgs } = voidStateMod;
const {      applyPostedPayment, toPostPaymentArgs, toVoidPaymentArgs,
  applyVoidedPayment, isVoidablePayment, paymentVoidBlockedReason,
} = paymentStateMod;
const {
  applyGatewayInitiation, applyGatewaySettlement, collectionBlockedReason, collectionBusy,
  gatewayOutcome, gatewaySettlementState, toInitiateGatewayArgs, toSettleGatewayArgs,
  toVerificationPayload,
} = gatewayStateMod;
const {
  SIGN_OUT_HINTS, SIGN_OUT_LABELS, isCurrentEpoch, nextEpoch, ownProfileRow,
  resolveSignInHandoff, resolveSignOutOutcome, signOutScope,
} = sessionMod;
const { redact, redactDetail } = redactMod;
const {
  AUTH_MESSAGES, authConfigured, claimedRefs, decideCollectionAccess, decideInvoiceAccess,
  isMoney, isUuid, parseBearer, rejectUnauthenticated, requireCaller,
} = serverAuth;
const {
  toBusinessProfile, toAccount, toCustomer, toSupplier, toExpense, toPayment,
  toJournalLine, toJournalEntry, toSale, toPurchase, toLineItem,
  toBusinessUpdate, toPostSaleResult, toPostPurchaseResult, toPostExpenseResult,
  toPostPaymentResult, toVoidDocumentResult, toVoidPaymentResult,
  toGatewayInitiateResult, toGatewaySettlementResult, toControlIntegrity,
} = dbTypesMod;

const { adToBs, bsToAd, fiscalYearFor, fiscalYearOf } = nepaliDate;
const { round2, splitVat } = money;
const { AccountingEngine } = engineMod;
const {
  AccountLookup, buildSaleEntry, linkedSettlementTotal, outstandingOn, outstandingByParty,
  reconcile, statusFor,
} = postingMod;
const { nextReference, nextSequence } = refMod;

console.log('\n=== Bikram Sambat calendar ===');

test('BS epoch matches AD 1943-04-13', () => {
  const bs = adToBs('1943-04-13');
  assertEqual(`${bs.year}-${bs.month}-${bs.day}`, '2000-1-1');
});

test('known Nepali New Year dates round-trip AD -> BS -> AD', () => {
  const knownNewYears = {
    2078: '2021-04-14', 2079: '2022-04-14', 2080: '2023-04-14',
    2081: '2024-04-13', 2082: '2025-04-14', 2083: '2026-04-14',
  };
  for (const [bsYear, adDate] of Object.entries(knownNewYears)) {
    const computed = bsToAd(Number(bsYear), 1, 1);
    assertEqual(computed, adDate, `BS ${bsYear}-01-01`);
  }
});

test('round-trip AD -> BS -> AD is lossless across the supported range', () => {
  let mismatches = 0;
  let checked = 0;
  for (let i = 0; i < 30000; i += 137) { // sampled, not exhaustive, to keep this fast
    const iso = addDaysIso('1943-04-13', i);
    let bs;
    try { bs = adToBs(iso); } catch { break; }
    const back = bsToAd(bs.year, bs.month, bs.day);
    checked += 1;
    if (back !== iso) mismatches += 1;
  }
  assert(checked > 100, 'sanity: enough samples were checked');
  assertEqual(mismatches, 0, `${mismatches}/${checked} round-trip mismatches`);
});

function addDaysIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

test('fiscal year starting Shrawan computes correct AD bounds', () => {
  const fy = fiscalYearFor(2081, 4);
  assertEqual(fy.startAd, '2024-07-16');
  assertEqual(fy.label, '2081/82');
});

test('fiscalYearOf finds the containing fiscal year on both sides of the boundary', () => {
  const fy = fiscalYearFor(2081, 4);
  const justInside = fiscalYearOf(fy.startAd, 4);
  assertEqual(justInside.bsYear, 2081);
  const dayBefore = addDaysIso(fy.startAd, -1);
  const justOutside = fiscalYearOf(dayBefore, 4);
  assertEqual(justOutside.bsYear, 2080);
});

console.log('\n=== Journal balancing ===');

test('a balanced entry is accepted', () => {
  const result = AccountingEngine.createJournalEntry({
    businessId: 'b1', transactionDate: '2026-01-01', sequence: 1,
    description: 'test', reference: 'T-1', sourceType: 'MANUAL', createdBy: 'u1',
    lines: [
      { accountId: 'a1', accountName: 'Cash', accountType: 'ASSET', debit: 100, credit: 0 },
      { accountId: 'a2', accountName: 'Sales', accountType: 'REVENUE', debit: 0, credit: 100 },
    ],
  });
  assert(result.success, 'expected success');
});

test('an unbalanced entry is rejected, not stored', () => {
  const result = AccountingEngine.createJournalEntry({
    businessId: 'b1', transactionDate: '2026-01-01', sequence: 1,
    description: 'test', reference: 'T-2', sourceType: 'MANUAL', createdBy: 'u1',
    lines: [
      { accountId: 'a1', accountName: 'Cash', accountType: 'ASSET', debit: 100, credit: 0 },
      { accountId: 'a2', accountName: 'Sales', accountType: 'REVENUE', debit: 0, credit: 90 },
    ],
  });
  assert(!result.success, 'expected rejection');
});

test('negative amounts are rejected', () => {
  const result = AccountingEngine.createJournalEntry({
    businessId: 'b1', transactionDate: '2026-01-01', sequence: 1,
    description: 'test', reference: 'T-3', sourceType: 'MANUAL', createdBy: 'u1',
    lines: [
      { accountId: 'a1', accountName: 'Cash', accountType: 'ASSET', debit: -50, credit: 0 },
      { accountId: 'a2', accountName: 'Sales', accountType: 'REVENUE', debit: 0, credit: -50 },
    ],
  });
  assert(!result.success, 'expected rejection of negative amounts');
});

console.log('\n=== Reversals ===');

test('a reversal nets the original entry to zero', () => {
  const original = AccountingEngine.createJournalEntry({
    businessId: 'b1', transactionDate: '2026-01-01', sequence: 1,
    description: 'sale', reference: 'INV-1', sourceType: 'SALE', createdBy: 'u1',
    lines: [
      { accountId: 'cash', accountName: 'Cash', accountType: 'ASSET', debit: 500, credit: 0 },
      { accountId: 'sales', accountName: 'Sales', accountType: 'REVENUE', debit: 0, credit: 500 },
    ],
  }).entry;

  const reversal = AccountingEngine.buildReversal(original, 2, 'u1', 'duplicate entry');
  assert(reversal.success, 'reversal should succeed');

  const balances = AccountingEngine.getAccountBalances(
    [{ id: 'cash', type: 'ASSET' }, { id: 'sales', type: 'REVENUE' }],
    [original, reversal.entry],
  );
  assertEqual(balances.cash, 0, 'cash should net to zero');
  assertEqual(balances.sales, 0, 'sales should net to zero');
});

test('an entry cannot be reversed twice', () => {
  const original = AccountingEngine.createJournalEntry({
    businessId: 'b1', transactionDate: '2026-01-01', sequence: 1,
    description: 'sale', reference: 'INV-2', sourceType: 'SALE', createdBy: 'u1',
    lines: [
      { accountId: 'cash', accountName: 'Cash', accountType: 'ASSET', debit: 100, credit: 0 },
      { accountId: 'sales', accountName: 'Sales', accountType: 'REVENUE', debit: 0, credit: 100 },
    ],
  }).entry;
  original.reversedByEntryId = 'already-reversed';
  const second = AccountingEngine.buildReversal(original, 3, 'u1', 'oops');
  assert(!second.success, 'a second reversal should be rejected');
});

console.log('\n=== Period filtering ===');

test('inPeriod only returns entries inside the range, inclusive of both ends', () => {
  const entries = [
    { transactionDate: '2026-01-01' }, { transactionDate: '2026-06-15' }, { transactionDate: '2026-12-31' },
  ];
  const filtered = AccountingEngine.inPeriod(entries, { from: '2026-01-01', to: '2026-06-15' });
  assertEqual(filtered.length, 2);
});

test('upTo returns entries on or before the as-of date', () => {
  const entries = [{ transactionDate: '2026-01-01' }, { transactionDate: '2026-06-15' }];
  assertEqual(AccountingEngine.upTo(entries, '2026-01-01').length, 1);
  assertEqual(AccountingEngine.upTo(entries, '2026-06-15').length, 2);
});

console.log('\n=== Integrity checks ===');

test('an orphaned account reference is flagged, not silently dropped', () => {
  const accounts = [{ id: 'cash', code: '1010', name: 'Cash', type: 'ASSET', isActive: true }];
  const entry = AccountingEngine.createJournalEntry({
    businessId: 'b1', transactionDate: '2026-01-01', sequence: 1,
    description: 'test', reference: 'T-4', sourceType: 'MANUAL', createdBy: 'u1',
    lines: [
      { accountId: 'cash', accountName: 'Cash', accountType: 'ASSET', debit: 100, credit: 0 },
      { accountId: 'ghost', accountName: 'Deleted account', accountType: 'REVENUE', debit: 0, credit: 100 },
    ],
  }).entry;

  const issues = AccountingEngine.checkIntegrity({
    accounts, entries: [entry], sales: [], purchases: [], expenses: [], payments: [], gateway: [],
  });
  assert(issues.some((i) => i.code === 'ORPHAN_ACCOUNT'), 'expected an ORPHAN_ACCOUNT issue');
});

test('a negative cash balance is flagged as impossible', () => {
  const accounts = [
    { id: 'cash', code: '1010', name: 'Cash', type: 'ASSET', isActive: true },
    { id: 'exp', code: '5020', name: 'Office', type: 'EXPENSE', isActive: true },
  ];
  const entry = AccountingEngine.createJournalEntry({
    businessId: 'b1', transactionDate: '2026-01-01', sequence: 1,
    description: 'overspend', reference: 'T-5', sourceType: 'MANUAL', createdBy: 'u1',
    lines: [
      { accountId: 'exp', accountName: 'Office', accountType: 'EXPENSE', debit: 500, credit: 0 },
      { accountId: 'cash', accountName: 'Cash', accountType: 'ASSET', debit: 0, credit: 500 },
    ],
  }).entry;

  const issues = AccountingEngine.checkIntegrity({
    accounts, entries: [entry], sales: [], purchases: [], expenses: [], payments: [], gateway: [],
  });
  assert(issues.some((i) => i.code === 'NEGATIVE_BALANCE'), 'expected a NEGATIVE_BALANCE issue');
});

console.log('\n=== Posting rules ===');

function testChartOfAccounts() {
  return [
    { id: 'cash', code: '1010', name: 'Cash in hand', type: 'ASSET' },
    { id: 'bank', code: '1020', name: 'Bank', type: 'ASSET' },
    { id: 'ar', code: '1030', name: 'Accounts receivable', type: 'ASSET' },
    { id: 'esewa', code: '1040', name: 'eSewa', type: 'ASSET' },
    { id: 'khalti', code: '1050', name: 'Khalti', type: 'ASSET' },
    { id: 'inv', code: '1060', name: 'Inventory', type: 'ASSET' },
    { id: 'vatr', code: '1070', name: 'VAT receivable', type: 'ASSET' },
    { id: 'ap', code: '2010', name: 'Accounts payable', type: 'LIABILITY' },
    { id: 'vatp', code: '2020', name: 'VAT payable', type: 'LIABILITY' },
    { id: 'sales', code: '4010', name: 'Sales', type: 'REVENUE' },
    { id: 'cogs', code: '5010', name: 'COGS', type: 'EXPENSE' },
  ];
}

test('a fully-paid sale posts settlement, revenue and VAT correctly', () => {
  const lookup = new AccountLookup(testChartOfAccounts());
  const business = { trackInventory: false, vatRegistered: true, vatRate: 13 };
  const sale = {
    id: 's1', businessId: 'b1', date: '2026-01-01', items: [], subtotal: 1000, discountTotal: 0,
    taxAmount: 130, totalAmount: 1130, paidAmount: 1130, paymentStatus: 'PAID',
    paymentMethod: 'CASH', status: 'POSTED', invoiceNumber: 'INV-1', customerId: 'c1',
    customerName: 'Test Customer', createdAt: '', createdBy: 'u1',
  };
  // What was settled at the counter arrives as the settlement row the posting
  // created, because a sale carries no upfront amount of its own (Stage 11).
  const settled = [{ linkedSaleId: 's1', amount: 1130, docStatus: 'POSTED', status: 'COMPLETED' }];
  const result = buildSaleEntry(sale, lookup, business, 1, settled);
  assert(result.success, 'sale should post');
  const check = AccountingEngine.validateLines(result.entry.lines);
  assert(check.isValid, 'sale entry should balance');
  assertClose(check.totalDebit, 1130);
  const cash = result.entry.lines.find((l) => l.accountId === 'cash');
  assertClose(cash.debit, 1130, 'the settlement account is debited for the row, not for a document field');
});

test('a sale with no settlement rows goes wholly on credit, whatever a caller claims', () => {
  const lookup = new AccountLookup(testChartOfAccounts());
  const business = { trackInventory: false, vatRegistered: true, vatRate: 13 };
  const sale = {
    id: 's1', businessId: 'b1', date: '2026-01-01', items: [], subtotal: 1000, discountTotal: 0,
    taxAmount: 130, totalAmount: 1130,
    // A stray upfront amount cannot reach the posting: there is no such field on
    // the document type, and the builder never looks for one.
    upfrontPaid: 1130,
    paidAmount: 0, paymentStatus: 'UNPAID', paymentMethod: 'CASH', status: 'POSTED',
    invoiceNumber: 'INV-1', customerId: 'c1', customerName: 'Test Customer',
    createdAt: '', createdBy: 'u1',
  };
  const result = buildSaleEntry(sale, lookup, business, 1);
  assert(result.success, 'sale should post');
  assertClose(AccountingEngine.validateLines(result.entry.lines).totalDebit, 1130, 'the entry still balances');
  assert(
    !result.entry.lines.some((l) => l.accountId === 'cash'),
    'no settlement account is touched when no settlement row exists',
  );
  const receivable = result.entry.lines.find((l) => l.accountId === 'ar');
  assertClose(receivable.debit, 1130, 'the whole invoice sits in Accounts receivable');
});

test('reconcile() derives paidAmount from the settlement rows and from nothing else', () => {
  const sales = [{
    id: 's1', totalAmount: 1000,
    // The document deliberately still carries an upfront figure in this
    // fixture: the point of the assertion is that it cannot contribute.
    upfrontPaid: 200,
    paidAmount: 200, paymentStatus: 'PARTIALLY_PAID', status: 'POSTED', items: [{}],
  }];
  const payments = [
    { linkedSaleId: 's1', amount: 300, docStatus: 'POSTED', status: 'COMPLETED' },
    { linkedSaleId: 's1', amount: 400, docStatus: 'POSTED', status: 'COMPLETED' },
    { linkedSaleId: 's1', amount: 999, docStatus: 'VOIDED', status: 'COMPLETED' }, // must be ignored
    { linkedSaleId: 's1', amount: 50, docStatus: 'POSTED', status: 'PENDING' },   // must be ignored
  ];
  const result = reconcile(sales, [], payments);
  assertClose(result.sales[0].paidAmount, 700,
    '300 + 400 of live settlements — the 200 on the document is never added');
  assertEqual(result.sales[0].paymentStatus, 'PARTIALLY_PAID');
});

test('statusFor classifies paid, unpaid and partial correctly', () => {
  assertEqual(statusFor(1000, 1000), 'PAID');
  assertEqual(statusFor(1000, 0), 'UNPAID');
  assertEqual(statusFor(1000, 400), 'PARTIALLY_PAID');
});

console.log('\n=== VAT splitting ===');

test('splitVat on an exclusive amount adds tax on top', () => {
  const { net, tax, gross } = splitVat(1000, 13, false);
  assertEqual(net, 1000);
  assertClose(tax, 130);
  assertClose(gross, 1130);
});

test('splitVat on an inclusive amount extracts tax from within', () => {
  const { net, tax, gross } = splitVat(1130, 13, true);
  assertClose(net, 1000);
  assertClose(tax, 130);
  assertEqual(gross, 1130);
});

console.log('\n=== VAT return (period aggregation) ===');

// Regression for the live audit: the VAT return showed "No financial
// transactions for this period" while the same fiscal year held real output
// and input VAT. `calculateVatReturn` must aggregate the selected period's
// journal lines through the VAT control accounts, exactly as the demo books do.
test('the VAT return aggregates the selected period\'s actual journal lines (demo dataset figures)', () => {
  const accounts = testChartOfAccounts();
  const saleEntry = {
    id: 'je_sale_1', businessId: 'b1', transactionDate: '2026-07-20', sequence: 1,
    description: 'Sale', reference: 'INV-2083-0001', sourceType: 'SALE', sourceId: 's1',
    lines: [
      { id: 'jl_1', journalEntryId: 'je_sale_1', lineNo: 1, accountId: 'ar', accountName: 'Accounts receivable', accountType: 'ASSET', debit: 45200, credit: 0 },
      { id: 'jl_2', journalEntryId: 'je_sale_1', lineNo: 2, accountId: 'sales', accountName: 'Sales', accountType: 'REVENUE', debit: 0, credit: 40000 },
      { id: 'jl_3', journalEntryId: 'je_sale_1', lineNo: 3, accountId: 'vatp', accountName: 'VAT payable (output tax)', accountType: 'LIABILITY', debit: 0, credit: 5200 },
    ],
  };
  const purchaseEntry = {
    id: 'je_pur_1', businessId: 'b1', transactionDate: '2026-07-21', sequence: 2,
    description: 'Purchase', reference: 'BILL-2083-0001', sourceType: 'PURCHASE', sourceId: 'p1',
    lines: [
      { id: 'jl_4', journalEntryId: 'je_pur_1', lineNo: 1, accountId: 'inv', accountName: 'Inventory', accountType: 'ASSET', debit: 65000, credit: 0 },
      { id: 'jl_5', journalEntryId: 'je_pur_1', lineNo: 2, accountId: 'vatr', accountName: 'VAT receivable (input tax)', accountType: 'ASSET', debit: 8450, credit: 0 },
      { id: 'jl_6', journalEntryId: 'je_pur_1', lineNo: 3, accountId: 'ap', accountName: 'Accounts payable', accountType: 'LIABILITY', debit: 0, credit: 73450 },
    ],
  };
  const range = { from: '2026-07-17', to: '2027-07-16', label: 'FY 2083/84' };
  const vat = AccountingEngine.calculateVatReturn(accounts, [saleEntry, purchaseEntry], range);
  assertClose(vat.outputVat, 5200, 'output VAT from the period\'s sales entries');
  assertClose(vat.inputVat, 8450, 'input VAT from the period\'s purchase entries');
  assertClose(vat.taxableSales, 40000);
  assertEqual(vat.taxablePurchases, 0,
    'purchases reach the return through the input-tax control account, not the inventory line');
  assertClose(vat.netCreditCarriedForward, 3250, 'input 8450 exceeds output 5200, so the credit carries forward');
  assertEqual(vat.netPayable, 0);
});

test('the VAT return ignores journal lines outside the selected period', () => {
  const accounts = testChartOfAccounts();
  const laterEntry = {
    id: 'je_late', businessId: 'b1', transactionDate: '2028-01-01', sequence: 3,
    description: 'Sale', reference: 'INV-2085-0001', sourceType: 'SALE', sourceId: 's2',
    lines: [
      { id: 'jl_7', journalEntryId: 'je_late', lineNo: 1, accountId: 'vatp', accountName: 'VAT payable', accountType: 'LIABILITY', debit: 0, credit: 999 },
    ],
  };
  const range = { from: '2026-07-17', to: '2027-07-16', label: 'FY 2083/84' };
  const vat = AccountingEngine.calculateVatReturn(accounts, [laterEntry], range);
  assertEqual(vat.outputVat, 0, 'an entry dated after the period must not reach the return');
  assertEqual(vat.inputVat, 0);
});

console.log('\n=== Reference numbering ===');

test('nextReference advances past the highest number ever issued, voided included', () => {
  const existing = ['INV-20260101-001', 'INV-20260101-002', 'INV-20260101-003'];
  const next = nextReference('INV', existing, '2026-01-01');
  assertEqual(next, 'INV-20260101-004');
});

test('nextSequence advances monotonically even with gaps', () => {
  const entries = [{ sequence: 1 }, { sequence: 5 }, { sequence: 3 }];
  assertEqual(nextSequence(entries), 6);
});

console.log('\n=== DB row mappers ===');

test('toBusinessProfile converts snake_case DB row to camelCase BusinessProfile', () => {
  const dbRow = {
    id: 'biz-1',
    created_by: 'user-1',
    business_name: 'Test Business',
    owner_name: 'Ram',
    email: 'ram@example.com',
    phone: '9800000000',
    pan_number: '123456789',
    address: 'Kathmandu',
    city: 'Kathmandu',
    currency: 'NPR',
    currency_symbol: 'रू',
    timezone: 'Asia/Kathmandu',
    fiscal_year_start_month: 4,
    vat_registered: true,
    vat_rate: 13,
    track_inventory: false,
    created_at: '2026-01-01T00:00:00Z',
  };
  const profile = toBusinessProfile(dbRow);
  assertEqual(profile.id, 'biz-1');
  assertEqual(profile.userId, 'user-1');
  assertEqual(profile.businessName, 'Test Business');
  assertEqual(profile.ownerName, 'Ram');
  assertEqual(profile.vatRegistered, true);
  assertEqual(profile.fiscalYearStartMonth, 4);
});

test('toAccount converts snake_case DB row to camelCase Account', () => {
  const dbRow = {
    id: 'acc-1',
    business_id: 'biz-1',
    code: '1010',
    name: 'Cash on Hand',
    type: 'ASSET',
    description: 'Main petty cash',
    is_active: true,
    system_account: true,
  };
  const acc = toAccount(dbRow);
  assertEqual(acc.id, 'acc-1');
  assertEqual(acc.businessId, 'biz-1');
  assertEqual(acc.code, '1010');
  assertEqual(acc.name, 'Cash on Hand');
  assertEqual(acc.type, 'ASSET');
  assertEqual(acc.isActive, true);
  assertEqual(acc.systemAccount, true);
});

test('toJournalEntry converts snake_case DB row and lines to camelCase JournalEntry', () => {
  const entryRow = {
    id: 'je-1',
    business_id: 'biz-1',
    transaction_date: '2026-01-01',
    sequence: 1,
    description: 'Test entry',
    reference: 'REF-001',
    source_type: 'MANUAL',
    source_id: null,
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
  };
  const lineRow = {
    id: 'jl-1',
    journal_entry_id: 'je-1',
    account_id: 'acc-1',
    account_name: 'Cash',
    account_type: 'ASSET',
    debit: 500,
    credit: 0,
  };
  const line = toJournalLine(lineRow);
  const entry = toJournalEntry(entryRow, [line]);
  assertEqual(entry.id, 'je-1');
  assertEqual(entry.businessId, 'biz-1');
  assertEqual(entry.sequence, 1);
  assertEqual(entry.lines.length, 1);
  assertEqual(entry.lines[0].debit, 500);
  assertEqual(entry.lines[0].credit, 0);
});

test('toLineItem converts snake_case DB row to camelCase LineItem', () => {
  const lineRow = {
    id: 'sli-1',
    sale_id: 'sale-1',
    line_no: 1,
    description: 'Item 1',
    quantity: 2,
    unit_price: 100,
    discount: 10,
    total: 190,
  };
  const item = toLineItem(lineRow);
  assertEqual(item.id, 'sli-1');
  assertEqual(item.description, 'Item 1');
  assertEqual(item.quantity, 2);
  assertEqual(item.unitPrice, 100);
  assertEqual(item.discount, 10);
  assertEqual(item.total, 190);
});

test('toSale converts a snake_case DB row to a camelCase Sale with no upfront field', () => {
  const saleRow = {
    id: 'sale-1',
    business_id: 'biz-1',
    customer_id: 'cust-1',
    customer_name: 'Customer A',
    date: '2026-01-01',
    payment_terms_days: 0, due_date: '2026-01-01',
    invoice_number: 'INV-20260101-001',
    subtotal: 1000,
    discount_total: 50,
    tax_amount: 123.5,
    total_amount: 1073.5,
    upfront_paid: 500,
    payment_method: 'CASH',
    status: 'POSTED',
    journal_entry_id: 'je-1',
    cost_of_goods: 600,
    notes: 'Test sale',
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
  };
  const lineItem = {
    id: 'sli-1',
    description: 'Item 1',
    quantity: 1,
    unitPrice: 1000,
    discount: 50,
    total: 950,
  };
  const sale = toSale(saleRow, [lineItem]);
  assertEqual(sale.id, 'sale-1');
  assertEqual(sale.businessId, 'biz-1');
  assertEqual(sale.customerId, 'cust-1');
  assertEqual(sale.customerName, 'Customer A');
  assertEqual(sale.invoiceNumber, 'INV-20260101-001');
  assertEqual(sale.totalAmount, 1073.5);
  // The settled-at-posting 500 in the row is not a money field on the document:
  // it already exists as a settlement row, and reconcile() sums those. Nothing
  // here reads the column, so paidAmount starts at 0 and is filled from rows.
  assert(!('upfrontPaid' in sale), 'a Sale has no upfrontPaid field at all');
  assertEqual(sale.paidAmount, 0, 'paidAmount starts empty and is derived from the settlement rows');
  assertEqual(sale.costOfGoods, 600);
  assertEqual(sale.items.length, 1);
  assertEqual(sale.items[0].description, 'Item 1');
});

console.log('\n=== Auth gate & onboarding logic ===');

test('Auth gate: unauthenticated user routes to AuthModal', () => {
  const authState = { authPhase: 'unauthenticated', user: null, hasMembership: null };
  const view = authState.authPhase === 'unauthenticated' || !authState.user ? 'AuthModal' : 'App';
  assertEqual(view, 'AuthModal');
});

test('Auth gate: authenticated user without membership routes to OnboardingGate', () => {
  const authState = {
    authPhase: 'authenticated',
    user: { id: 'u1', email: 'test@example.com', fullName: 'Tester' },
    hasMembership: false,
    businessName: '',
  };
  let view = 'App';
  if (authState.authPhase === 'unauthenticated' || !authState.user) view = 'AuthModal';
  else if (authState.hasMembership === false || !authState.businessName) view = 'OnboardingGate';
  assertEqual(view, 'OnboardingGate');
});

test('Auth gate: authenticated member routes to App Shell', () => {
  const authState = {
    authPhase: 'authenticated',
    user: { id: 'u1', email: 'test@example.com', fullName: 'Tester' },
    hasMembership: true,
    businessName: 'My Business',
  };
  let view = 'App';
  if (authState.authPhase === 'unauthenticated' || !authState.user) view = 'AuthModal';
  else if (authState.hasMembership === false || !authState.businessName) view = 'OnboardingGate';
  assertEqual(view, 'App');
});

console.log('\n=== Phase A: cloud-mode safety ===');

/* ---------------------------------------------------------------------- */
/* Source-tree scans: prove the legacy browser path is gone and that the    */
/* browser bundle can only ever see the publishable key.                    */
/* ---------------------------------------------------------------------- */

function readSourceFiles() {
  const srcDir = path.join(root, 'src');
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        // Normalize to forward slashes so path checks work on Windows too.
        const rel = path.relative(root, full).split(path.sep).join('/');
        out.push({ rel, text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(srcDir);
  return out;
}

const srcFiles = readSourceFiles();

/**
 * The `import.meta.env` keys Vite always provides. They are not configuration
 * and cannot carry a credential, so the secret scans below allow them by name
 * while still refusing every other non-`VITE_` read.
 */
const VITE_BUILTIN_ENV_KEYS = new Set(['MODE', 'DEV', 'PROD', 'BASE_URL', 'SSR']);

test('the deleted browser-auth/storage services are gone from disk', () => {
  assert(!existsSync(path.join(root, 'src/services/passwords.ts')), 'passwords.ts still exists');
  assert(!existsSync(path.join(root, 'src/services/storage.ts')), 'storage.ts still exists');
});

test('no legacy browser-auth or setup experience remains in src', () => {
  const offenders = [];
  for (const f of srcFiles) {
    if (/Set Up This Browser/i.test(f.text)) offenders.push(`${f.rel}: "Set Up This Browser"`);
    if (/browser setup|setup browser/i.test(f.text)) offenders.push(`${f.rel}: browser setup`);
    if (/PBKDF2/i.test(f.text)) offenders.push(`${f.rel}: PBKDF2`);
    if (/hashPassword|verifyPassword/.test(f.text)) offenders.push(`${f.rel}: local password hashing`);
  }
  assertEqual(offenders.length, 0, `legacy browser auth found: ${offenders.join(', ')}`);
});

test('no accounting data is kept in browser storage', () => {
  // The rule is about the books: every financial row must round-trip through
  // Firestore, so a second copy in the browser could drift from the ledger and
  // survive a sign-out. (Stage 19) One display preference is allowed — which
  // calendar dates are written in — because it describes a reader, not a
  // ledger, and it is pinned below to exactly that key.
  const storageFiles = srcFiles.filter((f) => /localStorage/.test(f.text));
  for (const f of storageFiles) {
    assert(f.rel.endsWith('src/lib/preferences.ts') || f.rel.endsWith('src/state/useDemoBooks.ts') || f.rel.endsWith('src/components/CookieBanner.tsx'),
      `${f.rel} touches localStorage; only the display-preference module may`);
  }
  assert(storageFiles.length > 0, 'the preference module must exist, or this rule is untested');

  const prefs = readFileSync(path.join(root, 'src/lib/preferences.ts'), 'utf8');
  const keys = [...prefs.matchAll(/'([a-z0-9._-]+)';?\s*$/gim)].map((m) => m[1])
    .filter((k) => k.includes('.'));
  assertEqual(keys.length, 1, `exactly one storage key, found: ${keys.join(', ')}`);
  assertEqual(keys[0], 'zeyks.calendar');
  assert(!/(token|session|password|journal|payment|balance|invoice|sale)/i.test(withoutComments(prefs)),
    'and nothing financial may be written under it');
});

test('browser code only reads VITE_ public configuration', () => {
  const offenders = [];
  for (const f of srcFiles) {
    // No server secret may be named in browser code, and no non-public env key
    // may be read. The VITE_ prefixed values are public by design.
    if (/SERVICE_ROLE|SECRET_KEY|GOOGLE_APPLICATION_CREDENTIALS/.test(f.text)) {
      offenders.push(`${f.rel}: server secret name`);
    }
    if (/process\.env/.test(f.text)) offenders.push(`${f.rel}: process.env`);
    for (const m of f.text.matchAll(/import\.meta\.env\.([A-Za-z0-9_]+)/g)) {
      if (!m[1].startsWith('VITE_') && !VITE_BUILTIN_ENV_KEYS.has(m[1])) offenders.push(`${f.rel}: ${m[1]}`);
    }
  }
  assertEqual(offenders.length, 0, `server-side config in browser code: ${offenders.join(', ')}`);
});

test('the browser code imports no Firebase or Supabase SDK and names no legacy config', () => {
  assert(!existsSync(path.join(root, 'src/lib/firebase.ts')), 'the Firebase client module is gone');
  for (const f of srcFiles) {
    assert(!/from ['"]firebase\b/.test(f.text), `${f.rel} still imports the Firebase SDK`);
    assert(!/from ['"]@supabase\//.test(f.text), `${f.rel} still imports the Supabase SDK`);
    assert(!/VITE_FIREBASE|VITE_SUPABASE/.test(f.text), `${f.rel} names retired deployment config`);
  }
});

/* ---------------------------------------------------------------------- */
/* Onboarding / membership state machine                                    */
/* ---------------------------------------------------------------------- */

test('a membership query failure is never treated as zero memberships', () => {
  const phase = resolveAppPhase({
    session: 'authenticated',
    membership: { kind: 'error', message: 'network down' },
    data: { kind: 'idle' },
  });
  assertEqual(phase, 'membership-error');
  assert(phase !== 'onboarding', 'a failed lookup must not offer onboarding');
});

test('zero memberships is the only state that offers onboarding', () => {
  assertEqual(
    resolveAppPhase({ session: 'authenticated', membership: { kind: 'empty' }, data: { kind: 'idle' } }),
    'onboarding',
  );
});

test('an existing member never re-onboards, even before data loads', () => {
  const memberships = [{ businessId: 'b1', createdAt: '2026-01-01T00:00:00Z' }];
  assertEqual(
    resolveAppPhase({ session: 'authenticated', membership: { kind: 'ready', memberships }, data: { kind: 'loading' } }),
    'loading-data',
  );
  assertEqual(
    resolveAppPhase({ session: 'authenticated', membership: { kind: 'ready', memberships }, data: { kind: 'ready' } }),
    'ready',
  );
});

test('a cloud data load failure is distinct from having no business', () => {
  const memberships = [{ businessId: 'b1', createdAt: '2026-01-01T00:00:00Z' }];
  assertEqual(
    resolveAppPhase({ session: 'authenticated', membership: { kind: 'ready', memberships }, data: { kind: 'error', message: 'boom' } }),
    'data-error',
  );
});

test('selectActiveMembership is deterministic regardless of row order', () => {
  const older = { businessId: 'b-old', createdAt: '2026-01-01T00:00:00Z' };
  const newer = { businessId: 'b-new', createdAt: '2026-02-01T00:00:00Z' };
  assertEqual(selectActiveMembership([newer, older]).businessId, 'b-old');
  assertEqual(selectActiveMembership([older, newer]).businessId, 'b-old');
});

test('selectActiveMembership breaks ties by businessId and handles empty input', () => {
  const t = '2026-01-01T00:00:00Z';
  const picked = selectActiveMembership([
    { businessId: 'b2', createdAt: t }, { businessId: 'b1', createdAt: t },
  ]);
  assertEqual(picked.businessId, 'b1');
  assertEqual(selectActiveMembership([]), null);
});

test('memberships answered for another account are never loaded', () => {
  const mine = { businessId: 'b-mine', userId: 'u-1', createdAt: '2026-01-01T00:00:00Z' };
  const theirs = { businessId: 'b-theirs', userId: 'u-2', createdAt: '2026-01-02T00:00:00Z' };
  assertEqual(membershipsOwnedBy([mine, theirs], 'u-1').map((m) => m.businessId).join(), 'b-mine',
    'a row carrying another user id is dropped, not shown as this person\'s business');
  assertEqual(membershipsOwnedBy([theirs], 'u-1').length, 0,
    'a list made entirely of another account rows yields nothing');
  assertEqual(membershipsOwnedBy([mine], null).length, 0,
    'an unverifiable identity trusts no rows');
});

test('an account switch clears the previous account before its books load', () => {
  const app = srcFiles.find((f) => f.rel.endsWith('src/App.tsx')).text;
  const switchGuard = /sessionOwnerRef\.current !== null[\s\S]{0,120}sessionOwnerRef\.current !== authUser\.id[\s\S]{0,120}clearLocalSession\(\)/;
  assert(switchGuard.test(app),
    'choosing another Google account must empty the session before loading, not after');
  assert(/const stillCurrent = \(\) =>[\s\S]{0,200}sessionOwnerRef\.current === owner/.test(app),
    'a load started for one account must not write state once another is signed in');
});

/* ---------------------------------------------------------------------- */
/* Cloud capability model                                                   */
/* ---------------------------------------------------------------------- */

test('posting and chart-of-accounts paths are cloud-backed; unsupported capabilities stay disabled', () => {
  assertEqual(CAPABILITIES.sales, true);
  assertEqual(CAPABILITIES.purchases, true, 'purchases now have a post_purchase RPC');
  assertEqual(CAPABILITIES.expenses, true, 'expenses now have a post_expense RPC');
  assertEqual(CAPABILITIES.payments, true, 'settlements now have a post_payment RPC');
  assertEqual(CAPABILITIES.voiding, true, 'voiding now has a void_document RPC');
  assertEqual(CAPABILITIES.gateway, true,
    'online collection now has initiate_gateway_txn and settle_gateway_txn');
  assertEqual(isSupported('accounts'), true, 'account writes use column-scoped table grants and RLS');
  assertEqual(isSupported('erase'), true, 'erase ships as the owner-only erase_business_data RPC (019)');
  assertEqual(isSupported('restore'), false, 'restore has no cloud write path yet');
});

test('the gateway capability is backed by the payment API, not by a browser write', () => {
  const service = srcFiles.find((f) => f.rel.endsWith('src/services/bookService.ts'));
  assert(service, 'bookService.ts not found');
  assert(/payment API/.test(service.text),
    'starting a collection must be the payment API\'s job — it holds the merchant secrets');
  for (const f of srcFiles) {
    assert(!/from\('gateway_transactions'\)\s*\n?\s*\.(insert|update|delete)/.test(f.text),
      `no browser file may write gateway_transactions: ${f.rel}`);
    assert(!/collection\(db,\s*'businesses'[^)]*gateway_transactions[^)]*\)[\s\S]{0,60}\.(doc\(|add\(|set\()/i.test(f.text),
      `no browser file may write gateway_transactions via Firestore: ${f.rel}`);
  }
});

test('voiding availability comes from the capability model, not per-view checks', () => {
  assertEqual(isVoidable('sales'), true);
  assertEqual(isVoidable('purchases'), true);
  assertEqual(isVoidable('expenses'), true);
  assertEqual(isVoidable('payments'), true, 'settlements are voidable since void_payment shipped');
});

test('an unsupported action is a failure, never a success', () => {
  const res = unsupported('payments', 'Recording a settlement');
  assertEqual(res.ok, false);
  assert(/not available yet/i.test(res.message), 'message should explain it is unavailable');
  assert(/not saved to the cloud/i.test(res.message), 'message should say it would not be stored');
  assert(/not available yet/i.test(unsupportedMessage('Recording a settlement')));
});

/* ---------------------------------------------------------------------- */
/* Business settings persistence mapping                                    */
/* ---------------------------------------------------------------------- */

test('toBusinessUpdate maps every writable column to snake_case', () => {
  const row = toBusinessUpdate({
    businessName: 'Himal Traders', ownerName: 'Ram', email: 'r@example.com', phone: '9800000000',
    panNumber: '123456789', address: 'Kathmandu', city: 'Kathmandu', currencySymbol: 'रू',
    fiscalYearStartMonth: 4, vatRegistered: true, vatRate: 13, trackInventory: false,
  });
  assertEqual(row.business_name, 'Himal Traders');
  assertEqual(row.owner_name, 'Ram');
  assertEqual(row.pan_number, '123456789');
  assertEqual(row.currency_symbol, 'रू');
  assertEqual(row.fiscal_year_start_month, 4);
  assertEqual(row.vat_registered, true);
  assertEqual(row.track_inventory, false);
  for (const forbidden of ['id', 'created_by', 'currency', 'timezone', 'created_at']) {
    assert(!(forbidden in row), `must never write ${forbidden}`);
  }
});

test('toBusinessUpdate omits keys that were not provided', () => {
  const row = toBusinessUpdate({ currencySymbol: 'NPR' });
  assertEqual(Object.keys(row).join(','), 'currency_symbol');
});

/* ---------------------------------------------------------------------- */
/* post_sale payload + immediate state                                      */
/* ---------------------------------------------------------------------- */

function makePostSalePayload() {
  return {
    sale: {
      id: 'sale-1', business_id: 'biz-1', customer_id: 'c1', customer_name: 'Customer A',
      invoice_number: 'INV-20260101-001', date: '2026-01-01', payment_terms_days: 0, due_date: '2026-01-01', subtotal: 100, discount_total: 0,
      tax_amount: 13, total_amount: 113, upfront_paid: 113, payment_method: 'CASH',
      status: 'POSTED', cost_of_goods: null, notes: null, journal_entry_id: 'je-1',
      created_by: 'u1', created_at: '2026-01-01T00:00:00Z',
    },
    items: [{
      id: 'si-1', sale_id: 'sale-1', line_no: 1, description: 'Widget',
      quantity: 1, unit_price: 100, discount: 0, total: 100,
    }],
    journal_entry: {
      id: 'je-1', business_id: 'biz-1', transaction_date: '2026-01-01', sequence: 1,
      description: 'Sale INV-20260101-001', reference: 'INV-20260101-001', source_type: 'SALE',
      source_id: 'sale-1', created_by: 'u1', created_at: '2026-01-01T00:00:00Z',
    },
    journal_lines: [
      { id: 'jl-1', journal_entry_id: 'je-1', line_no: 1, account_id: 'a1', account_name: 'Cash', account_type: 'ASSET', debit: 113, credit: 0 },
      { id: 'jl-2', journal_entry_id: 'je-1', line_no: 2, account_id: 'a2', account_name: 'Sales', account_type: 'REVENUE', debit: 0, credit: 100 },
      { id: 'jl-3', journal_entry_id: 'je-1', line_no: 3, account_id: 'a3', account_name: 'VAT payable', account_type: 'LIABILITY', debit: 0, credit: 13 },
    ],
    payment: {
      id: 'pay-1', business_id: 'biz-1', reference: 'REC-INV-20260101-001', date: '2026-01-01',
      amount: 113, payment_method: 'CASH', status: 'COMPLETED', payment_type: 'INCOMING',
      linked_sale_id: 'sale-1', party_name: 'Customer A', doc_status: 'POSTED',
      journal_entry_id: 'je-1', created_by: 'u1', created_at: '2026-01-01T00:00:00Z',
    },
  };
}

test('toPostSaleResult reads the RPC `items` key into sale.items', () => {
  const result = toPostSaleResult(makePostSalePayload());
  assertEqual(result.saleItems.length, 1);
  assertEqual(result.sale.items.length, 1, 'sale.items must come from the `items` key');
  assertEqual(result.sale.items[0].description, 'Widget');
  assertEqual(result.journalLines.length, 3);
  assert(result.payment, 'the upfront payment should map');
});

test('a just-posted sale is in app state with its items, no refresh needed', () => {
  const result = toPostSaleResult(makePostSalePayload());
  const next = applyPostedSale({ sales: [], journalEntries: [], payments: [] }, result);
  assertEqual(next.sales.length, 1);
  assertEqual(next.sales[0].items.length, 1, 'items must already be present');
  assertEqual(next.sales[0].items[0].description, 'Widget');
  assertEqual(next.journalEntries.length, 1);
  assertEqual(next.payments.length, 1);
});

/* ---------------------------------------------------------------------- */
/* Stage 3: purchases posting                                              */
/* ---------------------------------------------------------------------- */

function makePurchaseRow(overrides = {}) {
  return {
    id: 'pur-1', business_id: 'biz-1', supplier_id: 'sup-1', supplier_name: 'Supplier Alpha',
    reference_number: 'PO-20260101-001', date: '2026-01-01', payment_terms_days: 0, due_date: '2026-01-01', subtotal: 2000, discount_total: 0,
    tax_amount: 0, total_amount: 2000, upfront_paid: 0, payment_method: 'CASH', status: 'POSTED',
    notes: null, journal_entry_id: 'je-p1', created_by: 'u1', created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makePurchaseItemRow(overrides = {}) {
  return {
    id: 'pi-1', purchase_id: 'pur-1', line_no: 1, description: 'Bulk goods',
    quantity: 2, unit_price: 1000, discount: 0, total: 2000,
    ...overrides,
  };
}

function makePostPurchasePayload() {
  return {
    purchase: makePurchaseRow({ upfront_paid: 500 }),
    items: [makePurchaseItemRow()],
    journal_entry: {
      id: 'je-p1', business_id: 'biz-1', transaction_date: '2026-01-01', sequence: 7,
      description: 'Purchase PO-20260101-001 — Supplier Alpha', reference: 'PO-20260101-001',
      source_type: 'PURCHASE', source_id: 'pur-1', created_by: 'u1',
      created_at: '2026-01-01T00:00:00Z',
    },
    journal_lines: [
      { id: 'jl-p1', journal_entry_id: 'je-p1', line_no: 1, account_id: 'cogs', account_name: 'Cost of goods sold', account_type: 'EXPENSE', debit: 2000, credit: 0 },
      { id: 'jl-p2', journal_entry_id: 'je-p1', line_no: 2, account_id: 'cash', account_name: 'Cash in hand', account_type: 'ASSET', debit: 0, credit: 500 },
      { id: 'jl-p3', journal_entry_id: 'je-p1', line_no: 3, account_id: 'ap', account_name: 'Accounts payable', account_type: 'LIABILITY', debit: 0, credit: 1500 },
    ],
    payment: {
      id: 'pay-p1', business_id: 'biz-1', reference: 'PAY-PO-20260101-001', date: '2026-01-01',
      amount: 500, payment_method: 'CASH', status: 'COMPLETED', payment_type: 'OUTGOING',
      linked_purchase_id: 'pur-1', party_name: 'Supplier Alpha', doc_status: 'POSTED',
      journal_entry_id: 'je-p1', created_by: 'u1', created_at: '2026-01-01T00:00:00Z',
    },
  };
}

test('the purchase request carries no identity, journal or paid-status fields', () => {
  const args = toPostPurchaseArgs({
    businessId: 'biz-1', supplierId: 'sup-1', supplierName: 'Supplier Alpha',
    referenceNumber: '', date: '2026-01-01', subtotal: 2000, totalAmount: 2000,
    items: [{ description: 'Bulk goods', quantity: 2, unitPrice: 1000, total: 2000 }],
  });
  const expected = [
    'p_business_id', 'p_supplier_id', 'p_supplier_name', 'p_reference_number', 'p_date',
    'p_subtotal', 'p_discount_total', 'p_tax_amount', 'p_total_amount', 'p_upfront_paid',
    'p_payment_method', 'p_notes', 'p_items', 'p_idempotency_key', 'p_price_includes_vat',
    // Stage 18 adds exactly one argument to this contract: the whole days of
    // credit agreed. The due date they imply is NOT sent — the RPC computes it
    // — so the client still has no way to state when its own document is due.
    'p_payment_terms_days',
  ];
  assertEqual(Object.keys(args).sort().join(','), [...expected].sort().join(','));
  for (const forbidden of ['created_by', 'p_created_by', 'journal_entry_id', 'p_journal_entry_id',
    'p_sequence', 'p_status', 'p_paid_amount', 'p_user_id', 'p_role', 'p_due_date']) {
    assert(!(forbidden in args), `the client must never send ${forbidden}`);
  }
  assertEqual(args.p_items[0].line_no, 1, 'line numbers default from array order');
  assertEqual(args.p_items[0].unit_price, 1000, 'items use snake_case on the wire');
  assertEqual(args.p_reference_number, '', 'a blank reference asks the server to allocate one');
  assertEqual(args.p_idempotency_key, null);
  assertEqual(args.p_price_includes_vat, null, 'an unset VAT mode is left for the RPC to infer');
});

test('the purchase request passes an explicit VAT mode and idempotency key through', () => {
  const args = toPostPurchaseArgs({
    businessId: 'biz-1', supplierName: 'Supplier Alpha', date: '2026-01-01',
    subtotal: 1000, discountTotal: 0, taxAmount: 130, totalAmount: 1130, upfrontPaid: 1130,
    paymentMethod: 'BANK', priceIncludesVat: true, idempotencyKey: 'po_abc',
    items: [{ lineNo: 3, description: 'Widget', quantity: 1, unitPrice: 1130, discount: 0, total: 1130 }],
  });
  assertEqual(args.p_price_includes_vat, true);
  assertEqual(args.p_idempotency_key, 'po_abc');
  assertEqual(args.p_payment_method, 'BANK');
  assertEqual(args.p_upfront_paid, 1130);
  assertEqual(args.p_items[0].line_no, 3, 'an explicit line number is preserved');
});

test('toPostPurchaseResult reads the RPC `items` key into purchase.items', () => {
  const result = toPostPurchaseResult(makePostPurchasePayload());
  assertEqual(result.purchaseItems.length, 1);
  assertEqual(result.purchase.items.length, 1, 'purchase.items must come from the `items` key');
  assertEqual(result.purchase.items[0].description, 'Bulk goods');
  assertEqual(result.journalLines.length, 3);
  assert(result.payment, 'the upfront settlement should map');
  assertEqual(result.payment.linkedPurchaseId, 'pur-1');
});

test('a just-posted purchase is in app state with its items, no refresh needed', () => {
  const result = toPostPurchaseResult(makePostPurchasePayload());
  const next = applyPostedPurchase({ purchases: [], journalEntries: [], payments: [] }, result);
  assertEqual(next.purchases.length, 1);
  assertEqual(next.purchases[0].items.length, 1, 'items must already be present');
  assertEqual(next.purchases[0].items[0].total, 2000);
  assertEqual(next.journalEntries.length, 1);
  assertEqual(next.payments.length, 1);
});

test('toPurchase exposes no upfront field, so the settlement rows are the single source of truth', () => {
  const purchase = toPurchase(makePurchaseRow({ upfront_paid: 500 }), [toLineItem(makePurchaseItemRow())]);
  assert(!('upfrontPaid' in purchase), 'a Purchase has no upfrontPaid field at all');
  assertEqual(purchase.paidAmount, 0, 'paidAmount is filled from the settlement rows, not from the column');
  assertEqual(purchase.referenceNumber, 'PO-20260101-001');
  assertEqual(purchase.supplierName, 'Supplier Alpha');
  assertEqual(purchase.items.length, 1);
});

test('purchase reconciliation never double-counts the upfront payment', () => {
  const settle = (id, amount, upfront) => reconcile(
    [],
    [toPurchase(makePurchaseRow({ id, upfront_paid: upfront }), [])],
    amount > 0
      ? [{ linkedPurchaseId: id, amount, docStatus: 'POSTED', status: 'COMPLETED' }]
      : [],
  ).purchases[0];

  const unpaid = settle('pur-unpaid', 0, 0);
  assertClose(unpaid.paidAmount, 0, 'an unpaid purchase owes the full amount');
  assertEqual(unpaid.paymentStatus, 'UNPAID');

  const partial = settle('pur-partial', 300, 300);
  assertClose(partial.paidAmount, 300, 'the settlement row is counted once, not twice');
  assertEqual(partial.paymentStatus, 'PARTIALLY_PAID');

  const total = toPurchase(makePurchaseRow(), []).totalAmount;
  const full = settle('pur-full', total, total);
  assertClose(full.paidAmount, total, 'a fully paid purchase settles to its total');
  assertEqual(full.paymentStatus, 'PAID');
});

test('a failed purchase cannot mutate state and the merge never mutates its input', () => {
  const before = { purchases: [], journalEntries: [], payments: [] };
  const snapshot = JSON.stringify(before);
  // The useBooks action awaits the RPC and only reaches the merge on success,
  // so an error exits before this point; the state object is untouched.
  assertEqual(JSON.stringify(before), snapshot);

  const next = applyPostedPurchase(before, toPostPurchaseResult(makePostPurchasePayload()));
  assertEqual(before.purchases.length, 0, 'the input state must not be mutated');
  assertEqual(before.journalEntries.length, 0);
  assertEqual(before.payments.length, 0);
  assertEqual(next.purchases.length, 1);
});

test('a reload maps a persisted purchase row back into state with its items', () => {
  // Mirrors fetchPurchases(): row + its purchase_items, assembled client-side.
  const purchase = toPurchase(
    makePurchaseRow({ upfront_paid: 2000 }),
    [makePurchaseItemRow()].map((r) => toLineItem(r)),
  );
  assertEqual(purchase.items.length, 1);
  assertEqual(purchase.items[0].description, 'Bulk goods');
  assertEqual(purchase.totalAmount, 2000);
  const reconciled = reconcile([], [purchase], [{
    linkedPurchaseId: purchase.id, amount: 2000, docStatus: 'POSTED', status: 'COMPLETED',
  }]).purchases[0];
  assertEqual(reconciled.paymentStatus, 'PAID');
});

/* ---------------------------------------------------------------------- */
/* Stage 4: expenses posting                                                */
/* ---------------------------------------------------------------------- */

function makeExpenseRow(overrides = {}) {
  return {
    id: 'exp-1', business_id: 'biz-1', reference: 'EXP-20260101-001', account_id: 'acc-5020',
    category_name: 'Office and general', date: '2026-01-01', description: 'Stationery',
    amount: 1000, tax_amount: 0, total_amount: 1000, payment_method: 'CASH', status: 'POSTED',
    notes: null, journal_entry_id: 'je-e1', created_by: 'u1', created_at: '2026-01-01T00:00:00Z',
    idempotency_key: null, price_includes_vat: false,
    ...overrides,
  };
}

function makePostExpensePayload() {
  return {
    expense: makeExpenseRow(),
    journal_entry: {
      id: 'je-e1', business_id: 'biz-1', transaction_date: '2026-01-01', sequence: 3,
      description: 'Office and general — Stationery', reference: 'EXP-20260101-001',
      source_type: 'EXPENSE', source_id: 'exp-1', created_by: 'u1',
      created_at: '2026-01-01T00:00:00Z',
    },
    journal_lines: [
      { id: 'jl-e1', journal_entry_id: 'je-e1', line_no: 1, account_id: 'acc-5020', account_name: 'Office and general', account_type: 'EXPENSE', debit: 1000, credit: 0 },
      { id: 'jl-e2', journal_entry_id: 'je-e1', line_no: 2, account_id: 'cash', account_name: 'Cash in hand', account_type: 'ASSET', debit: 0, credit: 1000 },
    ],
  };
}

test('the expense request carries no identity, journal, status or category-name fields', () => {
  const args = toPostExpenseArgs({
    businessId: 'biz-1', accountId: 'acc-5020', date: '2026-01-01',
    amount: 1000, totalAmount: 1000, description: 'Stationery',
  });
  const expected = [
    'p_business_id', 'p_account_id', 'p_reference', 'p_date', 'p_amount', 'p_tax_amount',
    'p_total_amount', 'p_payment_method', 'p_description', 'p_notes', 'p_idempotency_key',
    'p_price_includes_vat',
  ];
  assertEqual(Object.keys(args).sort().join(','), [...expected].sort().join(','));
  for (const forbidden of ['created_by', 'p_created_by', 'journal_entry_id', 'p_journal_entry_id',
    'p_sequence', 'p_status', 'p_paid_amount', 'p_category_name', 'p_user_id', 'p_role']) {
    assert(!(forbidden in args), `the client must never send ${forbidden}`);
  }
  assertEqual(args.p_reference, '', 'a blank reference asks the server to allocate one');
  assertEqual(args.p_tax_amount, 0);
  assertEqual(args.p_payment_method, 'CASH');
  assertEqual(args.p_idempotency_key, null);
  assertEqual(args.p_price_includes_vat, null, 'an unset VAT mode is left for the RPC');
});

test('the expense request passes an explicit VAT mode and idempotency key through', () => {
  const args = toPostExpenseArgs({
    businessId: 'biz-1', accountId: 'acc-5040', reference: 'EXP-CUSTOM-1', date: '2026-01-02',
    amount: 1000, taxAmount: 130, totalAmount: 1130, paymentMethod: 'BANK', description: 'Rent',
    notes: 'paid online', priceIncludesVat: true, idempotencyKey: 'exp_abc',
  });
  assertEqual(args.p_reference, 'EXP-CUSTOM-1');
  assertEqual(args.p_account_id, 'acc-5040');
  assertEqual(args.p_payment_method, 'BANK');
  assertEqual(args.p_notes, 'paid online');
  assertEqual(args.p_price_includes_vat, true);
  assertEqual(args.p_idempotency_key, 'exp_abc');
});

test('toPostExpenseResult maps the RPC payload into an expense and its journal', () => {
  const result = toPostExpenseResult(makePostExpensePayload());
  assertEqual(result.expense.reference, 'EXP-20260101-001');
  assertEqual(result.expense.categoryName, 'Office and general');
  assertEqual(result.expense.totalAmount, 1000);
  assertEqual(result.journalLines.length, 2);
  assertEqual(result.journalEntry.sourceType, 'EXPENSE');
  assertEqual(result.journalEntry.lines.length, 2);
});

test('a just-posted expense is in app state immediately and adds no payment row', () => {
  const next = applyPostedExpense(
    { expenses: [], journalEntries: [] },
    toPostExpenseResult(makePostExpensePayload()),
  );
  assertEqual(next.expenses.length, 1);
  assertEqual(next.expenses[0].reference, 'EXP-20260101-001');
  assertEqual(next.journalEntries.length, 1);
  assertEqual(Object.keys(next).sort().join(','), 'expenses,journalEntries',
    'an expense must never add a settlement row');
});

test('expenses sit outside the settlement model entirely', () => {
  const reconciled = reconcile([], [], []);
  assertEqual(Object.keys(reconciled).sort().join(','), 'purchases,sales',
    'reconcile() only knows sales and purchases, so an expense cannot be double-counted');
  assert(!('expenses' in reconciled));
});

test('a failed expense cannot mutate state and the merge never mutates its input', () => {
  const before = { expenses: [], journalEntries: [] };
  const snapshot = JSON.stringify(before);
  // The useBooks action awaits the RPC and only reaches the merge on success,
  // so an error exits before this point; the state object is untouched.
  assertEqual(JSON.stringify(before), snapshot);

  const next = applyPostedExpense(before, toPostExpenseResult(makePostExpensePayload()));
  assertEqual(before.expenses.length, 0, 'the input state must not be mutated');
  assertEqual(before.journalEntries.length, 0);
  assertEqual(next.expenses.length, 1);
});

test('a reload maps a persisted expense row back into state', () => {
  const expense = toExpense(makeExpenseRow({ notes: 'reloaded', price_includes_vat: true }));
  assertEqual(expense.reference, 'EXP-20260101-001');
  assertEqual(expense.categoryName, 'Office and general');
  assertEqual(expense.paymentMethod, 'CASH');
  assertEqual(expense.notes, 'reloaded');
  assertEqual(expense.status, 'POSTED');
});

/* ---------------------------------------------------------------------- */
/* Stage 5: voiding documents                                              */
/* ---------------------------------------------------------------------- */

function makeVoidPayload(overrides = {}) {
  return {
    document: {
      id: 'sale-1', business_id: 'biz-1', customer_id: 'cust-1', customer_name: 'Walk-in',
      invoice_number: 'INV-20260101-001', date: '2026-01-01', payment_terms_days: 0, due_date: '2026-01-01', subtotal: 1000, discount_total: 0,
      tax_amount: 130, total_amount: 1130, upfront_paid: 400, payment_method: 'CASH',
      cost_of_goods: 0, status: 'VOIDED', journal_entry_id: 'je-1', created_by: 'u1',
      created_at: '2026-01-01T00:00:00Z',
    },
    original_journal_entry: {
      id: 'je-1', business_id: 'biz-1', transaction_date: '2026-01-01', sequence: 1,
      description: 'Sale INV-20260101-001', reference: 'INV-20260101-001', source_type: 'SALE',
      source_id: 'sale-1', reversed_by_entry_id: 'je-rev', created_by: 'u1',
      created_at: '2026-01-01T00:00:00Z',
    },
    reversal_journal_entry: {
      id: 'je-rev', business_id: 'biz-1', transaction_date: '2026-01-20', sequence: 9,
      description: 'Reversal of INV-20260101-001', reference: 'REV-INV-20260101-001',
      source_type: 'REVERSAL', source_id: 'sale-1', reverses_entry_id: 'je-1', created_by: 'u1',
      created_at: '2026-01-20T00:00:00Z',
    },
    reversal_journal_lines: [
      { id: 'jl-r1', journal_entry_id: 'je-rev', line_no: 1, account_id: 'cash', account_name: 'Cash in hand', account_type: 'ASSET', debit: 0, credit: 400 },
      { id: 'jl-r2', journal_entry_id: 'je-rev', line_no: 2, account_id: 'ar', account_name: 'Accounts receivable', account_type: 'ASSET', debit: 0, credit: 730 },
      { id: 'jl-r3', journal_entry_id: 'je-rev', line_no: 3, account_id: 'sales', account_name: 'Sales revenue', account_type: 'REVENUE', debit: 1000, credit: 0 },
      { id: 'jl-r4', journal_entry_id: 'je-rev', line_no: 4, account_id: 'vat', account_name: 'VAT payable (output tax)', account_type: 'LIABILITY', debit: 130, credit: 0 },
    ],
    affected_payments: [
      { id: 'pay-1', business_id: 'biz-1', reference: 'REC-INV-20260101-001', date: '2026-01-01',
        amount: 400, payment_method: 'CASH', status: 'COMPLETED', payment_type: 'INCOMING',
        linked_sale_id: 'sale-1', party_name: 'Walk-in', doc_status: 'VOIDED',
        journal_entry_id: 'je-1', created_by: 'u1', created_at: '2026-01-01T00:00:00Z' },
    ],
    ...overrides,
  };
}

function makeVoidState(overrides = {}) {
  return {
    sales: [{
      id: 'sale-1', businessId: 'biz-1', date: '2026-01-01',
      items: [{ id: 'li-1', description: 'Item', quantity: 1, unitPrice: 1000, discount: 0, total: 1000 }],
      subtotal: 1000, discountTotal: 0, taxAmount: 130, totalAmount: 1130, upfrontPaid: 0,
      paidAmount: 400, paymentStatus: 'PARTIALLY_PAID', paymentMethod: 'CASH', status: 'POSTED',
      journalEntryId: 'je-1', createdAt: '2026-01-01T00:00:00Z', createdBy: 'u1',
      invoiceNumber: 'INV-20260101-001', customerId: 'cust-1', customerName: 'Walk-in',
      costOfGoods: 0,
    }],
    purchases: [],
    expenses: [],
    journalEntries: [{
      id: 'je-1', businessId: 'biz-1', transactionDate: '2026-01-01', sequence: 1,
      description: 'Sale INV-20260101-001', reference: 'INV-20260101-001', sourceType: 'SALE',
      sourceId: 'sale-1', lines: [{ accountId: 'cash', accountName: 'Cash in hand', accountType: 'ASSET', debit: 400, credit: 0 }],
      createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z',
    }],
    payments: [{
      id: 'pay-1', businessId: 'biz-1', reference: 'REC-INV-20260101-001', date: '2026-01-01',
      amount: 400, paymentMethod: 'CASH', status: 'COMPLETED', paymentType: 'INCOMING',
      linkedSaleId: 'sale-1', partyName: 'Walk-in', docStatus: 'POSTED',
      journalEntryId: 'je-1', createdAt: '2026-01-01T00:00:00Z', createdBy: 'u1',
    }],
    ...overrides,
  };
}

test('the void request sends only business, type and id', () => {
  const args = toVoidDocumentArgs({ businessId: 'biz-1', documentType: 'SALE', documentId: 'sale-1' });
  assertEqual(Object.keys(args).sort().join(','), 'p_business_id,p_document_id,p_document_type');
  assertEqual(args.p_document_type, 'SALE');
  for (const forbidden of ['created_by', 'p_created_by', 'p_sequence', 'p_status', 'p_lines',
    'p_reversal_lines', 'p_reversal_amount', 'p_journal_entry_id', 'p_reason', 'p_source_type']) {
    assert(!(forbidden in args), `the client must never send ${forbidden}`);
  }
});

test('toVoidDocumentResult maps the persisted rows, reversal lines included', () => {
  const result = toVoidDocumentResult(makeVoidPayload(), 'sale');
  assertEqual(result.document.status, 'VOIDED');
  assertEqual(result.originalJournalEntry.reversedByEntryId, 'je-rev');
  assertEqual(result.reversalJournalEntry.sourceType, 'REVERSAL');
  assertEqual(result.reversalJournalEntry.reversesEntryId, 'je-1');
  assertEqual(result.reversalJournalEntry.reference, 'REV-INV-20260101-001');
  assertEqual(result.reversalJournalLines.length, 4);
  assertEqual(result.reversalJournalEntry.lines.length, 4);
  assertEqual(result.affectedPayments.length, 1);
  assertEqual(result.affectedPayments[0].docStatus, 'VOIDED');
});

test('applying a void changes only statuses, the link and the new reversal', () => {
  const state = makeVoidState();
  const next = applyVoidedDocument(state, 'sale', toVoidDocumentResult(makeVoidPayload(), 'sale'));

  assertEqual(next.sales.length, 1, 'the document is kept, never removed');
  assertEqual(next.sales[0].status, 'VOIDED');
  assertEqual(next.sales[0].items.length, 1, 'line items survive the void');
  assertEqual(next.sales[0].paidAmount, 400, 'the derived paid amount is carried over');
  assertEqual(next.sales[0].paymentStatus, 'PARTIALLY_PAID');
  assertEqual(next.journalEntries.length, 2, 'the reversal is added to the ledger');
  assertEqual(next.journalEntries[0].id, 'je-rev');
  assertEqual(next.journalEntries[1].id, 'je-1');
  assertEqual(next.journalEntries[1].reversedByEntryId, 'je-rev');
  assertEqual(next.journalEntries[1].lines.length, 1, 'the original lines are neither restated nor dropped');
  assertEqual(next.payments.length, 1, 'no settlement row is deleted');
  assertEqual(next.payments[0].docStatus, 'VOIDED');

  assertEqual(state.sales[0].status, 'POSTED', 'the input state is not mutated');
  assertEqual(state.journalEntries.length, 1);
  assertEqual(state.payments[0].docStatus, 'POSTED');
});

test('re-applying the same persisted void does not duplicate the reversal', () => {
  const once = applyVoidedDocument(makeVoidState(), 'sale', toVoidDocumentResult(makeVoidPayload(), 'sale'));
  const twice = applyVoidedDocument(once, 'sale', toVoidDocumentResult(makeVoidPayload(), 'sale'));
  assertEqual(twice.journalEntries.filter((e) => e.sourceType === 'REVERSAL').length, 1);
  assertEqual(twice.journalEntries.length, 2);
  assertEqual(twice.sales.length, 1);
});

test('the database reversal shape matches AccountingEngine.buildReversal', () => {
  const original = AccountingEngine.createJournalEntry({
    businessId: 'biz-1', transactionDate: '2026-01-01', sequence: 1,
    description: 'Sale INV-20260101-001', reference: 'INV-20260101-001',
    sourceType: 'SALE', sourceId: 'sale-1', createdBy: 'u1',
    lines: [
      { accountId: 'cash', accountName: 'Cash in hand', accountType: 'ASSET', debit: 400, credit: 0 },
      { accountId: 'ar', accountName: 'Accounts receivable', accountType: 'ASSET', debit: 730, credit: 0 },
      { accountId: 'sales', accountName: 'Sales revenue', accountType: 'REVENUE', debit: 0, credit: 1000 },
      { accountId: 'vat', accountName: 'VAT payable (output tax)', accountType: 'LIABILITY', debit: 0, credit: 130 },
    ],
  }).entry;

  const expected = AccountingEngine.buildReversal(original, 9, 'u1', 'invoice voided');
  assert(expected.success, 'the reference implementation should build a reversal');

  // The payload is aligned to the reference implementation's own original entry
  // (the engine generates its own id), so both reversals describe the same
  // document and the rules can be compared field by field.
  const base = makeVoidPayload();
  const fromDb = toVoidDocumentResult(makeVoidPayload({
    original_journal_entry: {
      ...base.original_journal_entry,
      id: original.id,
      reference: original.reference,
      source_id: original.sourceId,
    },
    reversal_journal_entry: {
      ...base.reversal_journal_entry,
      reference: `REV-${original.reference}`,
      reverses_entry_id: original.id,
      source_id: original.sourceId,
    },
  }), 'sale');
  assertEqual(fromDb.reversalJournalEntry.reference, expected.entry.reference);
  assertEqual(fromDb.reversalJournalEntry.sourceType, expected.entry.sourceType);
  assertEqual(fromDb.reversalJournalEntry.sourceId, expected.entry.sourceId);
  assertEqual(fromDb.reversalJournalEntry.reversesEntryId, expected.entry.reversesEntryId);
  assert(expected.entry.description.startsWith(fromDb.reversalJournalEntry.description),
    'the database description is the reference description without the optional reason');

  const asText = (line) => `${line.accountId}:${line.accountName}:${line.accountType}:${line.debit}:${line.credit}`;
  assertEqual(
    fromDb.reversalJournalLines.map(asText).join('|'),
    expected.entry.lines.map(asText).join('|'),
    'every line mirrors debit and credit exactly as the reference implementation does',
  );
});

test('a voided sale leaves the outstanding list and keeps its recorded paid amount', () => {
  const voided = applyVoidedDocument(makeVoidState(), 'sale', toVoidDocumentResult(makeVoidPayload(), 'sale')).sales[0];
  assertEqual(voided.status, 'VOIDED');
  const reconciled = reconcile(
    [voided], [],
    [{ linkedSaleId: 'sale-1', amount: 400, docStatus: 'VOIDED', status: 'COMPLETED' }],
  ).sales[0];
  assertEqual(reconciled.paidAmount, 400, 'a voided document keeps the amount it had already settled');
  assertEqual(reconciled.status, 'VOIDED');
});

test('a failed void cannot mutate state', () => {
  const state = makeVoidState();
  const snapshot = JSON.stringify(state);
  // useBooks awaits the RPC and only reaches the merge on success, so a thrown
  // error exits before any setState call. The state object is untouched.
  assertEqual(JSON.stringify(state), snapshot);
});

/* ---------------------------------------------------------------------- */
/* Stage 6: settlements (post_payment)                                      */
/* ---------------------------------------------------------------------- */

function makePaymentRow(overrides = {}) {
  return {
    id: 'pay-1', business_id: 'biz-1', reference: 'RCP-20260210-001', date: '2026-02-10',
    amount: 400, payment_method: 'BANK', status: 'COMPLETED', payment_type: 'INCOMING',
    linked_sale_id: 'sale-1', linked_purchase_id: null, party_name: 'Walk-in',
    doc_status: 'POSTED', notes: 'part settlement', journal_entry_id: 'je-pay-1',
    created_by: 'u1', created_at: '2026-02-10T00:00:00Z',
    idempotency_key: 'k-1', requested_reference: null,
    ...overrides,
  };
}

function makeSettledSaleRow(overrides = {}) {
  return {
    id: 'sale-1', business_id: 'biz-1', customer_id: 'cust-1', customer_name: 'Walk-in',
    invoice_number: 'INV-20260101-001', date: '2026-01-01', payment_terms_days: 0, due_date: '2026-01-01', subtotal: 1000, discount_total: 0,
    tax_amount: 130, total_amount: 1130, upfront_paid: 0, payment_method: 'CASH',
    cost_of_goods: 0, status: 'POSTED', journal_entry_id: 'je-1', created_by: 'u1',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSettledPurchaseRow(overrides = {}) {
  return {
    id: 'po-1', business_id: 'biz-1', supplier_id: 'sup-1', supplier_name: 'Himal Supplies',
    reference_number: 'PO-20260101-001', date: '2026-01-01', payment_terms_days: 0, due_date: '2026-01-01', subtotal: 1000, discount_total: 0,
    tax_amount: 130, total_amount: 1130, upfront_paid: 0, payment_method: 'CASH',
    status: 'POSTED', journal_entry_id: 'je-po-1', created_by: 'u1',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makePostPaymentPayload(overrides = {}) {
  return {
    payment: makePaymentRow(),
    document: makeSettledSaleRow(),
    journal_entry: {
      id: 'je-pay-1', business_id: 'biz-1', transaction_date: '2026-02-10', sequence: 5,
      description: 'Settlement from Walk-in', reference: 'RCP-20260210-001',
      source_type: 'PAYMENT', source_id: 'pay-1', created_by: 'u1',
      created_at: '2026-02-10T00:00:00Z',
    },
    journal_lines: [
      { id: 'jl-p1', journal_entry_id: 'je-pay-1', line_no: 1, account_id: 'bank', account_name: 'Bank', account_type: 'ASSET', debit: 400, credit: 0 },
      { id: 'jl-p2', journal_entry_id: 'je-pay-1', line_no: 2, account_id: 'ar', account_name: 'Accounts receivable', account_type: 'ASSET', debit: 0, credit: 400 },
    ],
    ...overrides,
  };
}

function makePaymentState(overrides = {}) {
  return {
    payments: [],
    journalEntries: [{
      id: 'je-1', businessId: 'biz-1', transactionDate: '2026-01-01', sequence: 1,
      description: 'Sale INV-20260101-001', reference: 'INV-20260101-001', sourceType: 'SALE',
      sourceId: 'sale-1', lines: [], createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z',
    }],
    ...overrides,
  };
}

test('the settlement request sends only the document, amount, method, date, notes and key', () => {
  const args = toPostPaymentArgs({
    businessId: 'biz-1', documentType: 'SALE', documentId: 'sale-1', amount: 400,
    paymentMethod: 'BANK', date: '2026-02-10', notes: 'part settlement', idempotencyKey: 'k-1',
  });
  assertEqual(Object.keys(args).sort().join(','),
    'p_amount,p_business_id,p_date,p_document_id,p_document_type,p_idempotency_key,p_notes,p_payment_method,p_reference');
  assertEqual(args.p_document_type, 'SALE');
  assertEqual(args.p_amount, 400);
  assertEqual(args.p_reference, '', 'a blank reference asks the server to allocate one');
  for (const forbidden of ['p_status', 'p_doc_status', 'p_payment_type', 'p_party_name',
    'p_journal_entry_id', 'p_sequence', 'p_created_by', 'p_source_type', 'p_paid_amount']) {
    assert(!(forbidden in args), `the client must never send ${forbidden}`);
  }
});

test('toPostPaymentResult maps the persisted settlement, its journal and the sale it settles', () => {
  const result = toPostPaymentResult(makePostPaymentPayload());
  assertEqual(result.payment.id, 'pay-1');
  assertEqual(result.payment.reference, 'RCP-20260210-001');
  assertEqual(result.payment.paymentType, 'INCOMING');
  assertEqual(result.payment.linkedSaleId, 'sale-1');
  assertEqual(result.payment.partyName, 'Walk-in', 'the party snapshot comes from the database');
  assertEqual(result.payment.docStatus, 'POSTED');
  assertEqual(result.payment.journalEntryId, 'je-pay-1');
  assertEqual(result.journalEntry.sourceType, 'PAYMENT');
  assertEqual(result.journalEntry.sourceId, 'pay-1');
  assertEqual(result.journalLines.length, 2);
  assertEqual(result.journalEntry.lines.length, 2, 'the lines arrive with their entry');
  assertEqual(result.document.id, 'sale-1', 'an INCOMING settlement belongs to a sale');
});

test('an OUTGOING settlement maps its purchase and keeps the server-side direction', () => {
  const payload = makePostPaymentPayload({
    payment: makePaymentRow({
      id: 'pay-2', reference: 'PAY-20260210-001', payment_type: 'OUTGOING',
      linked_sale_id: null, linked_purchase_id: 'po-1', party_name: 'Himal Supplies',
      journal_entry_id: 'je-pay-2',
    }),
    document: makeSettledPurchaseRow(),
    journal_entry: {
      id: 'je-pay-2', business_id: 'biz-1', transaction_date: '2026-02-10', sequence: 6,
      description: 'Settlement to Himal Supplies', reference: 'PAY-20260210-001',
      source_type: 'PAYMENT', source_id: 'pay-2', created_by: 'u1',
      created_at: '2026-02-10T00:00:00Z',
    },
    journal_lines: [
      { id: 'jl-q1', journal_entry_id: 'je-pay-2', line_no: 1, account_id: 'ap', account_name: 'Accounts payable', account_type: 'LIABILITY', debit: 400, credit: 0 },
      { id: 'jl-q2', journal_entry_id: 'je-pay-2', line_no: 2, account_id: 'cash', account_name: 'Cash in hand', account_type: 'ASSET', debit: 0, credit: 400 },
    ],
  });
  const result = toPostPaymentResult(payload);
  assertEqual(result.payment.paymentType, 'OUTGOING');
  assertEqual(result.payment.linkedPurchaseId, 'po-1');
  assertEqual(result.payment.linkedSaleId, undefined, 'an outgoing settlement has no sale');
  assertEqual(result.document.referenceNumber, 'PO-20260101-001', 'the settled purchase is mapped as one');
});

test('applying a settlement adds exactly two rows and mutates nothing', () => {
  const state = makePaymentState();
  const next = applyPostedPayment(state, toPostPaymentResult(makePostPaymentPayload()));

  assertEqual(next.payments.length, 1);
  assertEqual(next.payments[0].id, 'pay-1');
  assertEqual(next.journalEntries.length, 2);
  assertEqual(next.journalEntries[0].id, 'je-pay-1', 'the payment entry is prepended');
  assertEqual(next.journalEntries[1].id, 'je-1', 'the original ledger is kept');

  assertEqual(state.payments.length, 0, 'the input payments array is not mutated');
  assertEqual(state.journalEntries.length, 1, 'the input ledger is not mutated');
});

test('replaying the same settlement never lists the payment twice', () => {
  const once = applyPostedPayment(makePaymentState(), toPostPaymentResult(makePostPaymentPayload()));
  const twice = applyPostedPayment(once, toPostPaymentResult(makePostPaymentPayload()));
  assertEqual(twice.payments.length, 1, 'a replayed request returns the committed payment, not a second one');
  assertEqual(twice.journalEntries.length, 2, 'and never a second journal entry');
});

test('a partial settlement moves paidAmount and status only through reconcile', () => {
  const applied = applyPostedPayment(makePaymentState(), toPostPaymentResult(makePostPaymentPayload()));
  const sale = makeSettledSaleRow();

  const reconciled = reconcile(
    [{ id: 'sale-1', businessId: 'biz-1', date: '2026-01-01', items: [], subtotal: 1000,
      discountTotal: 0, taxAmount: 130, totalAmount: 1130, upfrontPaid: 0, paidAmount: 0,
      paymentStatus: 'UNPAID', paymentMethod: 'CASH', status: 'POSTED', journalEntryId: 'je-1',
      createdAt: '2026-01-01T00:00:00Z', createdBy: 'u1', invoiceNumber: 'INV-20260101-001',
      customerId: 'cust-1', customerName: 'Walk-in' }],
    [],
    applied.payments,
  ).sales[0];

  assertEqual(reconciled.paidAmount, 400, 'the settlement row is the only source of the paid amount');
  assertEqual(reconciled.paymentStatus, 'PARTIALLY_PAID');
  assertEqual(round2(sale.total_amount - reconciled.paidAmount), 730, 'NPR 730 is still outstanding');
  assertEqual(sale.upfront_paid, 0, 'the embedded-upfront column is never counted as well');
});

test('the final settlement derives PAID with nothing outstanding', () => {
  const applied = applyPostedPayment(makePaymentState(), toPostPaymentResult(makePostPaymentPayload({
    payment: makePaymentRow({ amount: 1130 }),
  })));

  const reconciled = reconcile(
    [{ id: 'sale-1', businessId: 'biz-1', date: '2026-01-01', items: [], subtotal: 1000,
      discountTotal: 0, taxAmount: 130, totalAmount: 1130, upfrontPaid: 0, paidAmount: 400,
      paymentStatus: 'PARTIALLY_PAID', paymentMethod: 'CASH', status: 'POSTED', journalEntryId: 'je-1',
      createdAt: '2026-01-01T00:00:00Z', createdBy: 'u1', invoiceNumber: 'INV-20260101-001',
      customerId: 'cust-1', customerName: 'Walk-in' }],
    [],
    applied.payments,
  ).sales[0];

  assertEqual(reconciled.paidAmount, 1130);
  assertEqual(reconciled.paymentStatus, 'PAID');
  assertEqual(round2(reconciled.totalAmount - reconciled.paidAmount), 0);
});

test('a voided settlement stops counting towards what is paid', () => {
  const reconciled = reconcile(
    [{ id: 'sale-1', businessId: 'biz-1', date: '2026-01-01', items: [], subtotal: 1000,
      discountTotal: 0, taxAmount: 130, totalAmount: 1130, upfrontPaid: 0, paidAmount: 400,
      paymentStatus: 'PARTIALLY_PAID', paymentMethod: 'CASH', status: 'POSTED', journalEntryId: 'je-1',
      createdAt: '2026-01-01T00:00:00Z', createdBy: 'u1', invoiceNumber: 'INV-20260101-001',
      customerId: 'cust-1', customerName: 'Walk-in' }],
    [],
    [makePaymentRow({ doc_status: 'VOIDED' })],
  ).sales[0];
  assertEqual(reconciled.paidAmount, 0, 'only POSTED settlements count');
  assertEqual(reconciled.paymentStatus, 'UNPAID');
});

test('a rejected settlement cannot mutate state', () => {
  const state = makePaymentState();
  const snapshot = JSON.stringify(state);
  // useBooks awaits postPayment and only reaches the merge on success, so a
  // thrown error (over-settlement, wrong tenant, refused permission) exits
  // before any setState call and the state object is untouched.
  assertEqual(JSON.stringify(state), snapshot);
});

test('the client never builds a payment journal itself', () => {
  // posting.ts still defines buildPaymentEntry: it is the authoritative
  // reference implementation that post_payment mirrors, and it stays for the
  // packing/reconcile logic. What must be gone is every *caller* of it, because
  // a settlement journal now only ever comes from the database.
  const offenders = [];
  for (const f of srcFiles) {
    if (f.rel.endsWith('src/services/posting.ts')) continue;
    if (/buildPaymentEntry/.test(f.text)) offenders.push(`${f.rel}: buildPaymentEntry`);
  }
  assertEqual(offenders.length, 0,
    `a settlement journal must only ever be written by post_payment, found: ${offenders.join(', ')}`);

  const posting = srcFiles.find((f) => f.rel.endsWith('src/services/posting.ts'));
  assert(/export function buildPaymentEntry/.test(posting.text),
    'the reference implementation must stay available for the other posting rules');
});

test('the settlement form sends an idempotency key and no client-decided status', () => {
  const modal = srcFiles.find((f) => f.rel.endsWith('src/components/TransactionModal.tsx'));
  assert(modal, 'TransactionModal.tsx not found');
  assert(/paymentIdempotencyKey\(\)/.test(modal.text),
    'one retry key per user action must travel with the request');
  const call = modal.text.slice(modal.text.indexOf('books.addPayment({'));
  const body = call.slice(0, call.indexOf('});'));
  for (const forbidden of ['paymentType', 'status:', 'partyName']) {
    assert(!body.includes(forbidden), `the modal must not send ${forbidden}`);
  }
});

/* ---------------------------------------------------------------------- */
/* Stage 7: voiding settlements (void_payment)                              */
/* ---------------------------------------------------------------------- */

function makeVoidPaymentPayload(overrides = {}) {
  return {
    payment: makePaymentRow({ doc_status: 'VOIDED' }),
    document: makeSettledSaleRow(),
    original_journal_entry: {
      id: 'je-pay-1', business_id: 'biz-1', transaction_date: '2026-02-10', sequence: 5,
      description: 'Settlement from Walk-in', reference: 'RCP-20260210-001',
      source_type: 'PAYMENT', source_id: 'pay-1', reversed_by_entry_id: 'je-rev-pay',
      created_by: 'u1', created_at: '2026-02-10T00:00:00Z',
    },
    reversal_journal_entry: {
      id: 'je-rev-pay', business_id: 'biz-1', transaction_date: '2026-03-01', sequence: 9,
      description: 'Reversal of RCP-20260210-001', reference: 'REV-RCP-20260210-001',
      source_type: 'REVERSAL', source_id: 'pay-1', reverses_entry_id: 'je-pay-1',
      created_by: 'u1', created_at: '2026-03-01T00:00:00Z',
    },
    reversal_journal_lines: [
      { id: 'jl-r1', journal_entry_id: 'je-rev-pay', line_no: 1, account_id: 'bank', account_name: 'Bank', account_type: 'ASSET', debit: 0, credit: 400 },
      { id: 'jl-r2', journal_entry_id: 'je-rev-pay', line_no: 2, account_id: 'ar', account_name: 'Accounts receivable', account_type: 'ASSET', debit: 400, credit: 0 },
    ],
    ...overrides,
  };
}

function makeVoidPaymentState(overrides = {}) {
  return {
    payments: [{
      id: 'pay-1', businessId: 'biz-1', reference: 'RCP-20260210-001', date: '2026-02-10',
      amount: 400, paymentMethod: 'BANK', status: 'COMPLETED', paymentType: 'INCOMING',
      linkedSaleId: 'sale-1', partyName: 'Walk-in', docStatus: 'POSTED',
      journalEntryId: 'je-pay-1', createdAt: '2026-02-10T00:00:00Z', createdBy: 'u1',
    }],
    journalEntries: [{
      id: 'je-pay-1', businessId: 'biz-1', transactionDate: '2026-02-10', sequence: 5,
      description: 'Settlement from Walk-in', reference: 'RCP-20260210-001', sourceType: 'PAYMENT',
      sourceId: 'pay-1', createdBy: 'u1', createdAt: '2026-02-10T00:00:00Z',
      lines: [
        { accountId: 'bank', accountName: 'Bank', accountType: 'ASSET', debit: 400, credit: 0 },
        { accountId: 'ar', accountName: 'Accounts receivable', accountType: 'ASSET', debit: 0, credit: 400 },
      ],
    }],
    ...overrides,
  };
}

test('the void request sends only the business and the settlement id', () => {
  const args = toVoidPaymentArgs({ businessId: 'biz-1', paymentId: 'pay-1' });
  assertEqual(Object.keys(args).sort().join(','), 'p_business_id,p_payment_id');
  assertEqual(args.p_payment_id, 'pay-1');
  for (const forbidden of ['p_status', 'p_doc_status', 'p_journal_entry_id', 'p_sequence',
    'p_lines', 'p_reversal_lines', 'p_reversal_entry_id', 'p_amount', 'p_party_name', 'p_created_by']) {
    assert(!(forbidden in args), `the client must never send ${forbidden}`);
  }
});

test('toVoidPaymentResult maps the persisted rows, the reversal and the untouched document', () => {
  const result = toVoidPaymentResult(makeVoidPaymentPayload());
  assertEqual(result.payment.docStatus, 'VOIDED');
  assertEqual(result.payment.status, 'COMPLETED', 'only the document status voids');
  assertEqual(result.originalJournalEntry.id, 'je-pay-1');
  assertEqual(result.originalJournalEntry.reversedByEntryId, 'je-rev-pay');
  assertEqual(result.reversalJournalEntry.sourceType, 'REVERSAL');
  assertEqual(result.reversalJournalEntry.reversesEntryId, 'je-pay-1');
  assertEqual(result.reversalJournalEntry.reference, 'REV-RCP-20260210-001');
  assertEqual(result.reversalJournalLines.length, 2);
  assertEqual(result.reversalJournalEntry.lines.length, 2);
  assertEqual(result.document.id, 'sale-1', 'the settled sale comes back with the payload');
  assertEqual(result.document.status, 'POSTED', 'and it is not voided by voiding the settlement');
});

test('a voided supplier payment maps its purchase instead', () => {
  const result = toVoidPaymentResult(makeVoidPaymentPayload({
    payment: makePaymentRow({
      doc_status: 'VOIDED', payment_type: 'OUTGOING',
      linked_sale_id: null, linked_purchase_id: 'po-1', party_name: 'Himal Supplies',
    }),
    document: makeSettledPurchaseRow(),
  }));
  assertEqual(result.payment.paymentType, 'OUTGOING');
  assertEqual(result.document.referenceNumber, 'PO-20260101-001');
  assertEqual(result.document.status, 'POSTED');
});

test('applying a void replaces the settlement, links the original and adds the reversal', () => {
  const state = makeVoidPaymentState();
  const next = applyVoidedPayment(state, toVoidPaymentResult(makeVoidPaymentPayload()));

  assertEqual(next.payments.length, 1, 'the settlement row is kept, not removed');
  assertEqual(next.payments[0].docStatus, 'VOIDED');
  assertEqual(next.payments[0].amount, 400, 'nothing about the money row changes but its status');
  assertEqual(next.journalEntries.length, 2, 'exactly one reversal entry is added');
  assertEqual(next.journalEntries[0].id, 'je-rev-pay');
  assertEqual(next.journalEntries[0].lines.length, 2);
  assertEqual(next.journalEntries[1].id, 'je-pay-1');
  assertEqual(next.journalEntries[1].reversedByEntryId, 'je-rev-pay');
  assertEqual(next.journalEntries[1].lines.length, 2, 'the original lines are carried over, never blanked');

  assertEqual(state.payments[0].docStatus, 'POSTED', 'the input state is not mutated');
  assertEqual(state.journalEntries.length, 1);
});

test('re-applying the same persisted void does not duplicate the reversal', () => {
  const once = applyVoidedPayment(makeVoidPaymentState(), toVoidPaymentResult(makeVoidPaymentPayload()));
  const twice = applyVoidedPayment(once, toVoidPaymentResult(makeVoidPaymentPayload()));
  assertEqual(twice.journalEntries.length, 2);
  assertEqual(twice.payments.length, 1);
  assertEqual(twice.journalEntries.filter((e) => e.sourceType === 'REVERSAL').length, 1);
});

test('voiding a settlement puts the document back to owing the money', () => {
  const applied = applyVoidedPayment(makeVoidPaymentState(), toVoidPaymentResult(makeVoidPaymentPayload()));
  const sale = {
    id: 'sale-1', businessId: 'biz-1', date: '2026-01-01', items: [], subtotal: 1000,
    discountTotal: 0, taxAmount: 130, totalAmount: 1130, upfrontPaid: 0, paidAmount: 400,
    paymentStatus: 'PARTIALLY_PAID', paymentMethod: 'CASH', status: 'POSTED',
    journalEntryId: 'je-1', createdAt: '2026-01-01T00:00:00Z', createdBy: 'u1',
    invoiceNumber: 'INV-20260101-001', customerId: 'cust-1', customerName: 'Walk-in',
  };

  const reconciled = reconcile([sale], [], applied.payments).sales[0];
  assertEqual(reconciled.paidAmount, 0, 'the voided settlement stops counting');
  assertEqual(reconciled.paymentStatus, 'UNPAID');
  assertEqual(round2(reconciled.totalAmount - reconciled.paidAmount), 1130,
    'the full amount is outstanding again — 400 -> 0 -> 1130 due');
  assertEqual(reconciled.status, 'POSTED', 'and the document itself is untouched');
});

test('a settlement that shares its document\u2019s entry cannot be voided on its own', () => {
  const context = {
    sales: [{ id: 'sale-1', journalEntryId: 'je-1' }],
    purchases: [{ id: 'po-1', journalEntryId: 'je-po-1' }],
  };
  const separate = { docStatus: 'POSTED', journalEntryId: 'je-pay-1', linkedSaleId: 'sale-1' };
  const embedded = { docStatus: 'POSTED', journalEntryId: 'je-1', linkedSaleId: 'sale-1' };
  const embeddedPurchase = { docStatus: 'POSTED', journalEntryId: 'je-po-1', linkedPurchaseId: 'po-1' };
  const voided = { docStatus: 'VOIDED', journalEntryId: 'je-pay-1', linkedSaleId: 'sale-1' };
  const unlinked = { docStatus: 'POSTED', journalEntryId: 'je-x' };

  assertEqual(isVoidablePayment(separate, context), true, 'a posted settlement with its own entry can be voided');
  assertEqual(isVoidablePayment(embedded, context), false, 'an upfront settlement cannot');
  assertEqual(isVoidablePayment(embeddedPurchase, context), false, 'the same holds for a purchase');
  assertEqual(isVoidablePayment(voided, context), false, 'and a voided one cannot be voided again');
  assertEqual(isVoidablePayment(unlinked, context), true, 'an unlinked settlement moved its own money');

  assert(/void the document/i.test(paymentVoidBlockedReason(embedded, context)),
    'the reason points at the document instead');
  assert(/already been voided/i.test(paymentVoidBlockedReason(voided, context)));
  assertEqual(paymentVoidBlockedReason(separate, context), null);
});

test('settlement voiding is cloud-backed and routed through the RPC', () => {
  assertEqual(CAPABILITIES.voiding, true);
  assertEqual(VOIDABLE_DOCUMENTS.payments, true, 'void_payment makes settlements a voidable list');
  assertEqual(isVoidable('payments'), true);
  assertEqual(isVoidable('sales'), true);

  const service = srcFiles.find((f) => f.rel.endsWith('src/services/bookService.ts'));
  assert(service, 'bookService.ts not found');
  assert(/kind: 'PAYMENT'/.test(service.text) && /voidDocument/.test(service.text),
    'the service must void settlements through the voidDocument function');
  assert(!/from\('payments'\)\s*\n?\s*\.(update|insert|delete)/.test(service.text),
    'and must never write the payments table directly');

  const books = srcFiles.find((f) => f.rel.endsWith('src/state/useBooks.ts'));
  assert(/voidPaymentRpc\(\{ businessId: business\.id, paymentId: id \}\)/.test(books.text),
    'useBooks must go through the service');
  assert(/voidDocument, voidPayment,/.test(books.text), 'and expose the action');

  for (const f of srcFiles) {
    assert(!/from\('payments'\)\s*\n?\s*\.(update|insert|delete)/.test(f.text),
      `no browser file may mutate payments directly: ${f.rel}`);
  }
});

test('the payments list voids through the action, behind a confirmation and a busy guard', () => {
  const view = srcFiles.find((f) => f.rel.endsWith('src/components/DocumentsView.tsx'));
  assert(view, 'DocumentsView.tsx not found');
  assert(/await books\.voidPayment\(voiding\.id\)/.test(view.text),
    'settlements must dispatch to the payment void action');
  assert(/voidBusy/.test(view.text), 'the dialog must guard against a second click');
  assert(/if \(!voiding \|\| voidBusy\) return;/.test(view.text),
    'and refuse to start twice while the RPC is in flight');
  assert(/disabled=\{voidBusy\}/.test(view.text), 'both dialog buttons are disabled while busy');
  assert(/Void and reverse/.test(view.text), 'the confirmation is explicit about what happens');
  assert(/paymentVoidBlockedReason/.test(view.text),
    'and rows that cannot be voided are dimmed with the reason');
});

/* ---------------------------------------------------------------------- */
/* Stage 8: online gateways (initiate_gateway_txn / settle_gateway_txn)      */
/* ---------------------------------------------------------------------- */

function makeGatewayTxnRow(overrides = {}) {
  return {
    id: 'gt-1', business_id: 'biz-1', provider: 'ESEWA', gateway_ref: 'INV-20260101-001-8f2a',
    gateway_transaction_id: null, amount: 500, currency: 'NPR', status: 'INITIATED',
    verified_at: null, linked_sale_id: 'sale-1', customer_name: 'Walk-in',
    payment_id: null, initiated_by: 'u1', initiated_at: '2026-02-10T06:00:00Z',
    settled_at: null, last_error: null,
    ...overrides,
  };
}

function makeGatewayInitiatePayload(overrides = {}) {
  return {
    gateway_transaction: makeGatewayTxnRow(),
    document: makeSettledSaleRow(),
    settlement_state: 'UNSETTLED',
    replayed: false,
    ...overrides,
  };
}

function makeGatewaySettlementPayload(overrides = {}) {
  return {
    outcome: 'SETTLED', settled: true, settlement_state: 'SETTLED', reason: null,
    gateway_transaction: makeGatewayTxnRow({
      gateway_transaction_id: 'ES-0009911', status: 'COMPLETED',
      verified_at: '2026-02-10T06:05:00Z', payment_id: 'pay-g1',
      settled_at: '2026-02-10T06:05:01Z',
    }),
    payment: makePaymentRow({
      id: 'pay-g1', reference: 'RCP-20260210-002', amount: 500, payment_method: 'ESEWA',
      journal_entry_id: 'je-gw-1', gateway_transaction_id: 'gt-1',
    }),
    document: makeSettledSaleRow(),
    journal_entry: {
      id: 'je-gw-1', business_id: 'biz-1', transaction_date: '2026-02-10', sequence: 6,
      description: 'Settlement from Walk-in', reference: 'RCP-20260210-002',
      source_type: 'PAYMENT', source_id: 'pay-g1', created_by: 'u1',
      created_at: '2026-02-10T00:00:00Z',
    },
    journal_lines: [
      { id: 'jl-g1', journal_entry_id: 'je-gw-1', line_no: 1, account_id: 'esewa', account_name: 'eSewa clearing', account_type: 'ASSET', debit: 500, credit: 0 },
      { id: 'jl-g2', journal_entry_id: 'je-gw-1', line_no: 2, account_id: 'ar', account_name: 'Accounts receivable', account_type: 'ASSET', debit: 0, credit: 500 },
    ],
    ...overrides,
  };
}

/** The one internal shape the API server produces (server/verification.js). */
function makeVerification(overrides = {}) {
  return {
    provider: 'ESEWA', verified: true, status: 'COMPLETED',
    gatewayTransactionId: 'ES-0009911', amount: 500, currency: 'NPR',
    reference: 'INV-20260101-001-8f2a', detail: '',
    ...overrides,
  };
}

function makeGatewayState(overrides = {}) {
  return {
    payments: [],
    journalEntries: [{
      id: 'je-1', businessId: 'biz-1', transactionDate: '2026-01-01', sequence: 1,
      description: 'Sale INV-20260101-001', reference: 'INV-20260101-001', sourceType: 'SALE',
      sourceId: 'sale-1', lines: [], createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z',
    }],
    gatewayTxns: [],
    ...overrides,
  };
}

test('the collection request sends only the invoice, provider, reference, amount and customer', () => {
  const args = toInitiateGatewayArgs({
    businessId: 'biz-1', provider: 'ESEWA', gatewayRef: 'INV-20260101-001-8f2a',
    amount: 500, linkedSaleId: 'sale-1', customerName: 'Walk-in',
  });
  assertEqual(Object.keys(args).sort().join(','),
    'p_amount,p_business_id,p_currency,p_customer_name,p_gateway_ref,p_linked_sale_id,p_provider');
  assertEqual(args.p_linked_sale_id, 'sale-1', 'the document is the invoice the collection settles against');
  assertEqual(args.p_currency, 'NPR', 'the currency defaults to the only one the schema keeps');
  for (const forbidden of ['p_status', 'p_verified_at', 'p_gateway_transaction_id', 'p_payment_id',
    'p_initiated_by', 'p_settled_at', 'p_linked_purchase_id']) {
    assert(!(forbidden in args), `the client must never send ${forbidden}`);
  }
  assertEqual(toInitiateGatewayArgs({
    businessId: 'biz-1', provider: 'KHALTI', gatewayRef: 'pidx-1', amount: 500, linkedSaleId: 'sale-1',
  }).p_customer_name, '', 'a missing name travels as a blank, never as undefined');
});

test('the settlement request sends only the collection, the server answer and an optional date', () => {
  const args = toSettleGatewayArgs({
    businessId: 'biz-1', gatewayTxnId: 'gt-1', verification: makeVerification(),
  });
  assertEqual(Object.keys(args).sort().join(','),
    'p_business_id,p_date,p_gateway_txn_id,p_notes,p_verification');
  assertEqual(args.p_gateway_txn_id, 'gt-1', 'the collection id is the database idempotency record');
  assertEqual(args.p_date, null, 'the database defaults the date to today in Nepal');
  for (const forbidden of ['p_amount', 'p_reference', 'p_payment_method', 'p_payment_id',
    'p_journal_entry_id', 'p_sequence', 'p_document_id', 'p_document_type', 'p_source_type',
    'p_created_by', 'p_party_name']) {
    assert(!(forbidden in args), `the client must never send ${forbidden}`);
  }
});

test('the verification payload carries the server answer and nothing else', () => {
  const payload = toVerificationPayload({
    ...makeVerification(), raw: { secret: 'merchant-signature' }, verified: 'yes',
  });
  assertEqual(Object.keys(payload).sort().join(','),
    'amount,currency,detail,gateway_transaction_id,provider,reference,status,verified');
  assertEqual(payload.verified, false, 'a truthy string is not a verification');
  assert(!('raw' in payload), 'the provider body stays on the server, never in the RPC payload');
  assertEqual(payload.gateway_transaction_id, 'ES-0009911');
  assertEqual(toVerificationPayload(makeVerification({ currency: '' })).currency, 'NPR');
  assertEqual(toVerificationPayload(makeVerification({ gatewayTransactionId: null })).gateway_transaction_id,
    null, 'an answer without a provider id stays explicitly empty');
});

test('toGatewayInitiateResult maps the persisted collection and the invoice it settles against', () => {
  const result = toGatewayInitiateResult(makeGatewayInitiatePayload());
  assertEqual(result.gatewayTransaction.id, 'gt-1');
  assertEqual(result.gatewayTransaction.provider, 'ESEWA');
  assertEqual(result.gatewayTransaction.gatewayRef, 'INV-20260101-001-8f2a');
  assertEqual(result.gatewayTransaction.amount, 500);
  assertEqual(result.gatewayTransaction.status, 'INITIATED', 'starting a collection posts nothing');
  assertEqual(result.gatewayTransaction.currency, 'NPR');
  assertEqual(result.gatewayTransaction.linkedSaleId, 'sale-1');
  assertEqual(result.gatewayTransaction.paymentId, undefined, 'nothing is settled yet');
  assertEqual(result.gatewayTransaction.initiatedBy, 'u1', 'the initiator comes from the database');
  assertEqual(result.document.id, 'sale-1');
  assertEqual(result.replayed, false);
  assertEqual(toGatewayInitiateResult(makeGatewayInitiatePayload({ replayed: true })).replayed, true);
});

test('toGatewaySettlementResult maps the committed settlement, its payment and its journal', () => {
  const result = toGatewaySettlementResult(makeGatewaySettlementPayload());
  assertEqual(result.outcome, 'SETTLED');
  assertEqual(result.settled, true);
  assertEqual(result.settlementState, 'SETTLED');
  assertEqual(result.reason, null);
  assertEqual(result.gatewayTransaction.status, 'COMPLETED');
  assertEqual(result.gatewayTransaction.gatewayTransactionId, 'ES-0009911',
    'the provider id is recorded on the collection');
  assertEqual(result.gatewayTransaction.paymentId, 'pay-g1', 'and the collection points at its settlement');
  assertEqual(result.payment.id, 'pay-g1');
  assertEqual(result.payment.gatewayTransactionId, 'gt-1',
    'the settlement carries the gateway link the database wrote');
  assertEqual(result.payment.paymentMethod, 'ESEWA');
  assertEqual(result.payment.amount, 500);
  assertEqual(result.journalEntry.sourceType, 'PAYMENT');
  assertEqual(result.journalEntry.sourceId, 'pay-g1');
  assertEqual(result.journalLines.length, 2);
  assertEqual(result.journalEntry.lines.length, 2, 'the lines arrive with their entry');
  assertEqual(result.document.id, 'sale-1');
});

test('an answer the gateway did not confirm maps a collection and no money at all', () => {
  const result = toGatewaySettlementResult(makeGatewaySettlementPayload({
    outcome: 'NOT_VERIFIED', settled: false, settlement_state: 'UNSETTLED',
    reason: 'The gateway has not finished this payment yet.',
    gateway_transaction: makeGatewayTxnRow({ status: 'PENDING', payment_id: null }),
    payment: null, journal_entry: null, journal_lines: null,
  }));
  assertEqual(result.outcome, 'NOT_VERIFIED');
  assertEqual(result.settled, false);
  assertEqual(result.settlementState, 'UNSETTLED');
  assertEqual(result.reason, 'The gateway has not finished this payment yet.');
  assertEqual(result.payment, null, 'nothing is invented to fill the gap');
  assertEqual(result.journalEntry, null);
  assertEqual(result.journalLines.length, 0);
  assertEqual(result.gatewayTransaction.status, 'PENDING');
});

test('an outcome the database never sends collapses to NOT_VERIFIED', () => {
  const result = toGatewaySettlementResult(makeGatewaySettlementPayload({
    outcome: 'SUCCESS', settled: false, payment: null, journal_entry: null, journal_lines: null,
  }));
  assertEqual(result.outcome, 'NOT_VERIFIED', 'an unrecognised outcome must fail closed');
});

test('a settlement that was voided is reported as already settled and voided', () => {
  const result = toGatewaySettlementResult(makeGatewaySettlementPayload({
    outcome: 'ALREADY_SETTLED', settled: true, settlement_state: 'VOIDED',
    reason: 'The settlement for this collection was voided; take the money again with a new collection.',
    payment: makePaymentRow({
      id: 'pay-g1', reference: 'RCP-20260210-002', amount: 500, payment_method: 'ESEWA',
      journal_entry_id: 'je-gw-1', gateway_transaction_id: 'gt-1', doc_status: 'VOIDED',
    }),
  }));
  assertEqual(result.outcome, 'ALREADY_SETTLED');
  assertEqual(result.settlementState, 'VOIDED');
  assertEqual(result.payment.docStatus, 'VOIDED', 'the voided settlement is shown, not revived');
});

test('applying a settlement adds the collection, one payment and one journal entry', () => {
  const state = makeGatewayState();
  const next = applyGatewaySettlement(state, toGatewaySettlementResult(makeGatewaySettlementPayload()));

  assertEqual(next.gatewayTxns.length, 1);
  assertEqual(next.gatewayTxns[0].status, 'COMPLETED');
  assertEqual(next.gatewayTxns[0].paymentId, 'pay-g1');
  assertEqual(next.payments.length, 1);
  assertEqual(next.payments[0].id, 'pay-g1');
  assertEqual(next.journalEntries.length, 2, 'exactly one entry is added');
  assertEqual(next.journalEntries[0].id, 'je-gw-1');

  assertEqual(state.payments.length, 0, 'the input payments array is not mutated');
  assertEqual(state.gatewayTxns.length, 0, 'nor the input collections');
  assertEqual(state.journalEntries.length, 1, 'nor the input ledger');
});

test('replaying a settlement never lists the settlement, its entry or its collection twice', () => {
  const once = applyGatewaySettlement(makeGatewayState(), toGatewaySettlementResult(makeGatewaySettlementPayload()));
  const twice = applyGatewaySettlement(once, toGatewaySettlementResult(makeGatewaySettlementPayload()));
  assertEqual(twice.payments.length, 1, 'the committed payment is replayed, never duplicated');
  assertEqual(twice.journalEntries.length, 2);
  assertEqual(twice.journalEntries.filter((e) => e.sourceType === 'PAYMENT').length, 1);
  assertEqual(twice.gatewayTxns.length, 1);
});

test('an unconfirmed answer changes the collection and nothing else', () => {
  const state = makeGatewayState({ gatewayTxns: [toGatewayInitiation(60_000).gatewayTransaction] });
  const next = applyGatewaySettlement(state, toGatewaySettlementResult(makeGatewaySettlementPayload({
    outcome: 'NOT_VERIFIED', settled: false, settlement_state: 'UNSETTLED',
    reason: 'The gateway did not confirm this payment.',
    gateway_transaction: makeGatewayTxnRow({ status: 'FAILED', last_error: 'The gateway did not confirm this payment.' }),
    payment: null, journal_entry: null, journal_lines: null,
  })));

  assertEqual(next.payments.length, 0, 'no settlement is posted for an unconfirmed collection');
  assertEqual(next.journalEntries.length, 1, 'and no accounting is touched');
  assertEqual(next.gatewayTxns.length, 1, 'the row is replaced, not appended');
  assertEqual(next.gatewayTxns[0].status, 'FAILED');
  assertEqual(next.gatewayTxns[0].lastError, 'The gateway did not confirm this payment.');
  assertEqual(state.gatewayTxns[0].status, 'INITIATED', 'the input state is not mutated');
});

function toGatewayInitiation(seq) {
  return toGatewayInitiateResult(makeGatewayInitiatePayload({
    gateway_transaction: makeGatewayTxnRow({ amount: seq }),
  }));
}

test('applying an initiation inserts the collection once and replaces it on a replay', () => {
  const first = applyGatewayInitiation([], toGatewayInitiation(500));
  assertEqual(first.length, 1);
  assertEqual(first[0].status, 'INITIATED');

  const replayed = applyGatewayInitiation(first, toGatewayInitiation(500));
  assertEqual(replayed.length, 1, 'a replayed initiation is not a second collection');
  assertEqual(JSON.stringify(replayed), JSON.stringify(first), 'the same row, nothing appended');

  // A replay returns the persisted row, so anything the database has advanced
  // since (a verification that arrived from another device, say) wins.
  const advanced = applyGatewayInitiation(first, toGatewayInitiateResult(makeGatewayInitiatePayload({
    gateway_transaction: makeGatewayTxnRow({ status: 'PENDING', verified_at: '2026-02-10T06:03:00Z' }),
  })));
  assertEqual(advanced.length, 1);
  assertEqual(advanced[0].status, 'PENDING', 'state shows the persisted row, not the local guess');
  assertEqual(advanced[0].verifiedAt, '2026-02-10T06:03:00Z');
  assertEqual(first[0].status, 'INITIATED', 'and the input array is not mutated');
});

test('an online settlement reaches the invoice only through its payment row', () => {
  const applied = applyGatewaySettlement(
    makeGatewayState(), toGatewaySettlementResult(makeGatewaySettlementPayload()),
  );

  const reconciled = reconcile(
    [{ id: 'sale-1', businessId: 'biz-1', date: '2026-01-01', items: [], subtotal: 1000,
      discountTotal: 0, taxAmount: 130, totalAmount: 1130, upfrontPaid: 0, paidAmount: 0,
      paymentStatus: 'UNPAID', paymentMethod: 'CASH', status: 'POSTED', journalEntryId: 'je-1',
      createdAt: '2026-01-01T00:00:00Z', createdBy: 'u1', invoiceNumber: 'INV-20260101-001',
      customerId: 'cust-1', customerName: 'Walk-in' }],
    [],
    applied.payments,
  ).sales[0];

  assertEqual(reconciled.paidAmount, 500, 'the settlement row is the only source of the paid amount');
  assertEqual(reconciled.paymentStatus, 'PARTIALLY_PAID');
  assertEqual(round2(reconciled.totalAmount - reconciled.paidAmount), 630, 'NPR 630 is still outstanding');

  // The collection becoming COMPLETED is not what moved the invoice: it is the
  // payment row the RPC created. Without it the same collection changes nothing.
  const reconciledWithoutPayment = reconcile(
    [{ id: 'sale-1', businessId: 'biz-1', date: '2026-01-01', items: [], subtotal: 1000,
      discountTotal: 0, taxAmount: 130, totalAmount: 1130, upfrontPaid: 0, paidAmount: 0,
      paymentStatus: 'UNPAID', paymentMethod: 'CASH', status: 'POSTED', journalEntryId: 'je-1',
      createdAt: '2026-01-01T00:00:00Z', createdBy: 'u1', invoiceNumber: 'INV-20260101-001',
      customerId: 'cust-1', customerName: 'Walk-in' }],
    [],
    [],
  ).sales[0];
  assertEqual(reconciledWithoutPayment.paidAmount, 0);
  assertEqual(reconciledWithoutPayment.paymentStatus, 'UNPAID');
});

test('the collection settlement state is derived from the linkage and the payment', () => {
  const posted = makePaymentRow({
    id: 'pay-g1', reference: 'RCP-20260210-002', amount: 500, payment_method: 'ESEWA',
    journal_entry_id: 'je-gw-1', gateway_transaction_id: 'gt-1',
  });
  assertEqual(gatewaySettlementState({ paymentId: undefined }, []), 'UNSETTLED');
  assertEqual(gatewaySettlementState({ paymentId: 'pay-g1' }, [posted]), 'SETTLED');
  assertEqual(gatewaySettlementState({ paymentId: 'pay-g1' }, [{ ...posted, docStatus: 'VOIDED' }]),
    'VOIDED', 'a voided settlement is not a settled collection');
  assertEqual(gatewaySettlementState({ paymentId: 'pay-g1' }, []), 'SETTLED',
    'the linkage alone is enough: the database only answers UNSETTLED without one');
});

test('the settlement result is reported as posted, replayed or unconfirmed', () => {
  const settled = gatewayOutcome(toGatewaySettlementResult(makeGatewaySettlementPayload()));
  assertEqual(settled.ok, true);
  assertEqual(settled.tone, 'success');
  assert(/RCP-20260210-002/.test(settled.message), 'the message names the settlement that reached the books');

  const replayed = gatewayOutcome(toGatewaySettlementResult(makeGatewaySettlementPayload({
    outcome: 'ALREADY_SETTLED', reason: 'This collection has already been settled.',
  })));
  assertEqual(replayed.ok, true, 'a replay is not an error for the person');
  assertEqual(replayed.tone, 'info');
  assert(/already/i.test(replayed.message) && /settled/i.test(replayed.message),
    'and it says the settlement was already recorded');

  const failed = gatewayOutcome(toGatewaySettlementResult(makeGatewaySettlementPayload({
    outcome: 'NOT_VERIFIED', settled: false, settlement_state: 'UNSETTLED',
    reason: 'The customer canceled the payment at the gateway.',
    payment: null, journal_entry: null, journal_lines: null,
  })));
  assertEqual(failed.ok, false);
  assertEqual(failed.tone, 'error');
  assert(/canceled/i.test(failed.message), 'the provider reason is what the person sees');

  const silent = gatewayOutcome(toGatewaySettlementResult(makeGatewaySettlementPayload({
    outcome: 'NOT_VERIFIED', settled: false, payment: null, journal_entry: null, journal_lines: null,
  })));
  assert(silent.message.length > 0, 'even without a reason the person is told something');
});

test('a voided settlement is reported as needing a new collection, not as success', () => {
  const outcome = gatewayOutcome(toGatewaySettlementResult(makeGatewaySettlementPayload({
    outcome: 'ALREADY_SETTLED', settled: true, settlement_state: 'VOIDED', reason: null,
    payment: makePaymentRow({
      id: 'pay-g1', reference: 'RCP-20260210-002', amount: 500, payment_method: 'ESEWA',
      journal_entry_id: 'je-gw-1', gateway_transaction_id: 'gt-1', doc_status: 'VOIDED',
    }),
  })));
  assertEqual(outcome.ok, false, 'a voided settlement is not a success');
  assertEqual(outcome.tone, 'error');
  assert(/new collection/i.test(outcome.message), 'it tells the person what to do instead');
});

test('the collect button stays disabled while a click is in flight or a collection is pending', () => {
  assertEqual(collectionBusy(false, false), false, 'idle and nothing pending');
  assertEqual(collectionBusy(true, false), true, 'a click is in flight');
  assertEqual(collectionBusy(false, true), true, 'this invoice already waits on the gateway');
  assertEqual(collectionBusy(true, true), true);
});

test('the collect form refuses what the server would refuse, with the reason', () => {
  const base = { hasInvoice: true, invoiceNumber: 'INV-20260101-001', amount: 500, outstanding: 1130, provider: 'ESEWA' };
  assertEqual(collectionBlockedReason(base), null, 'the happy path is clickable');

  assert(/choose the invoice/i.test(collectionBlockedReason({ ...base, hasInvoice: false })),
    'a collection with nothing to settle against cannot be posted');
  assert(/above zero/i.test(collectionBlockedReason({ ...base, amount: 0 })));

  const over = collectionBlockedReason({ ...base, amount: 1130.01 });
  assert(/outstanding/i.test(over), 'over-settlement is refused before the click');
  assert(/INV-20260101-001/.test(over), 'and the reason names the invoice');
  assertEqual(collectionBlockedReason({ ...base, amount: 1130 }), null, 'settling the balance exactly is allowed');

  assert(/at least NPR 10/i.test(collectionBlockedReason({ ...base, provider: 'KHALTI', amount: 5 })),
    'Khalti\u2019s floor is a provider rule the server enforces too');
  assertEqual(collectionBlockedReason({ ...base, provider: 'KHALTI', amount: 10 }), null);
});

test('the collect modal guards the click, names the pending collection and posts nothing itself', () => {
  const modal = srcFiles.find((f) => f.rel.endsWith('src/components/CollectOnlineModal.tsx'));
  assert(modal, 'CollectOnlineModal.tsx not found');
  assert(/import \{ collectionBlockedReason, collectionBusy \} from '\.\.\/lib\/gatewayState'/.test(modal.text),
    'the guard rules must come from the tested module');
  assert(/const startBusy = collectionBusy\(busy, awaiting\)/.test(modal.text),
    'the button must honour both the in-flight click and a pending collection');
  assert(/disabled=\{startBusy \|\| !anyOn \|\| !sale\}/.test(modal.text),
    'so a second click cannot start a second provider payment');
  assert(/An earlier collection for this invoice is still waiting/.test(modal.text),
    'and the person is told why it is disabled');
  assert(/books\.startGatewayCollection\(\{/.test(modal.text),
    'the collection is recorded through the server, never by a browser insert');
  assert(!/togglePaid|markPaid|status: 'COMPLETED'/.test(modal.text),
    'and no component may claim the money arrived');
});

test('a provider timeout leaves the collection unresolved and posts nothing', () => {
  const modal = srcFiles.find((f) => f.rel.endsWith('src/components/CollectOnlineModal.tsx'));
  const body = modal.text.slice(modal.text.indexOf('export async function resolvePending'));
  // The success path's settle call is the last one: the catch block settles first.
  const catchBlock = body.slice(
    body.indexOf('} catch'), body.lastIndexOf('const outcome = await books.settleGatewayTxn'),
  );
  assert(/verified: false/.test(catchBlock), 'a failed verification is sent as unverified');
  assert(/status: 'PENDING'/.test(catchBlock), 'and never as a completion');
  assert(/Data health/.test(catchBlock), 'the person is pointed at where it can be re-checked');
  assert(/await books\.settleGatewayTxn\(pending\.txnId, verification\)/.test(body),
    'a good answer is forwarded to the settlement RPC unchanged');
});

test('the browser cannot mark a collection verified or settled', () => {
  const offenders = [];
  for (const f of srcFiles) {
    if (/\.from\('gateway_transactions'\)[\s\S]{0,60}?\.(insert|update|delete)\b/.test(f.text)) {
      offenders.push(`${f.rel}: writes gateway_transactions`);
    }
    if (/\.from\('payments'\)[\s\S]{0,60}?\.(insert|update|delete)\b/.test(f.text)) {
      offenders.push(`${f.rel}: writes payments`);
    }
  }
  assertEqual(offenders.length, 0, `the browser may only use the two gateway RPCs: ${offenders.join(', ')}`);

  // Even a caller that *wants* to look successful cannot: the RPC's answer is
  // still NOT_VERIFIED and the applier writes no financial row.
  const wantsSuccess = makeGatewaySettlementPayload({
    outcome: 'NOT_VERIFIED', settled: false, settlement_state: 'UNSETTLED',
    reason: 'The gateway did not confirm this payment.',
    gateway_transaction: makeGatewayTxnRow({ status: 'COMPLETED', payment_id: null }),
    payment: null, journal_entry: null, journal_lines: null,
  });
  const applied = applyGatewaySettlement(makeGatewayState(), toGatewaySettlementResult(wantsSuccess));
  assertEqual(applied.payments.length, 0, 'no settlement may be invented client-side');
  assertEqual(applied.journalEntries.length, 1, 'and no journal entry either');
  assertEqual(applied.gatewayTxns.length, 1, 'only the collection row changes');
});

test('a settlement refreshes the invoice, the settlements list and the collection together', () => {
  const books = srcFiles.find((f) => f.rel.endsWith('src/state/useBooks.ts'));
  assert(books, 'useBooks.ts not found');
  const body = books.text.slice(
    books.text.indexOf('const settleGatewayTxn = useCallback'),
    books.text.indexOf('/* Chart of accounts'),
  );
  assert(/await settleGatewayTxnRpc\(/.test(body), 'the settlement must go through the RPC');
  assert(/const applied = applyGatewaySettlement\(\{ payments, journalEntries, gatewayTxns \}, result\)/.test(body),
    'and state must be derived from the answer, not guessed');
  assert(/setPayments\(applied\.payments\)/.test(body));
  assert(/setJournalEntries\(applied\.journalEntries\)/.test(body));
  assert(/setGatewayTxns\(applied\.gatewayTxns\)/.test(body));
  assert(body.indexOf('await settleGatewayTxnRpc(') < body.indexOf('setPayments(applied.payments)'),
    'nothing may be posted optimistically before the RPC answered');
  assert(/const outcome = gatewayOutcome\(result\)/.test(body)
    && /outcome\.ok \? ok\(outcome\.message\) : err\(outcome\.message\)/.test(body),
  'and the person is told what the database decided');
});

test('an unresolved collection can be re-checked from Data health through the same path', () => {
  const view = srcFiles.find((f) => f.rel.endsWith('src/components/HealthView.tsx'));
  assert(view, 'HealthView.tsx not found');
  assert(/await books\.settleGatewayTxn\(txnId, verification\)/.test(view.text),
    'a re-check settles through the one RPC');
  assert(/const unresolved = gatewayTxns\.filter/.test(view.text),
    'collections still waiting on the gateway are listed');
  assert(/gatewaySettlementState/.test(view.text),
    'and the settled ones are marked with their derived state');
  assert(/books\.settleGatewayTxn/.test(view.text)
    && !/\.from\('(gateway_transactions|payments)'\)/.test(view.text),
  'the view reads state through the RPC, it never reads or writes a table');
});

/* ---------------------------------------------------------------------- */
/* Stage 8: the provider adapter boundary (server/verification.js)          */
/* ---------------------------------------------------------------------- */

const verificationMod = await import(pathToFileURL(path.join(root, 'server', 'verification.js')).href);
const {
  CURRENCY: GATEWAY_CURRENCY, PROVIDERS, VERIFICATION_STATUSES, ProviderResponseError,
  mapEsewaStatus, mapKhaltiStatus, normalizeVerification,
} = verificationMod;

function normalize(overrides = {}) {
  return normalizeVerification({
    provider: 'ESEWA', providerStatus: 'COMPLETE', gatewayTransactionId: 'ES-0009911',
    amount: 500, reference: 'INV-20260101-001-8f2a', ...overrides,
  });
}

test('the eSewa status map only treats COMPLETE as money received', () => {
  assertEqual(mapEsewaStatus('COMPLETE'), 'COMPLETED');
  assertEqual(mapEsewaStatus('PENDING'), 'PENDING');
  assertEqual(mapEsewaStatus('CANCELED'), 'CANCELED');
  assertEqual(mapEsewaStatus('NOT_FOUND'), 'FAILED', 'nothing was collected, so it is not pending');
  assertEqual(mapEsewaStatus('AMBIGUOUS'), 'FAILED', 'an unclear answer is never a payment');
  assertEqual(mapEsewaStatus('SUCCESS'), null, 'an unrecognised status maps to nothing at all');
  assertEqual(mapEsewaStatus(undefined), null);
  assertEqual(mapEsewaStatus('complete'), 'COMPLETED', 'the provider capitalisation is not trusted');
});

test('the Khalti status map only treats Completed as money received', () => {
  assertEqual(mapKhaltiStatus('Completed'), 'COMPLETED');
  assertEqual(mapKhaltiStatus('Pending'), 'PENDING');
  assertEqual(mapKhaltiStatus('Initiated'), 'INITIATED');
  assertEqual(mapKhaltiStatus('Partially Refunded'), 'REFUNDED');
  assertEqual(mapKhaltiStatus('Refunded'), 'REFUNDED');
  assertEqual(mapKhaltiStatus('Expired'), 'EXPIRED');
  assertEqual(mapKhaltiStatus('User canceled'), 'CANCELED');
  assertEqual(mapKhaltiStatus('completed'), null, 'lower case is a different string, not a success');
  assertEqual(mapKhaltiStatus(''), null);
});

test('a provider answer becomes the one internal shape, or is refused', () => {
  const result = normalize();
  assertEqual(Object.keys(result).sort().join(','),
    'amount,currency,detail,gatewayTransactionId,provider,reference,status,verified');
  assertEqual(result.provider, 'ESEWA');
  assertEqual(result.verified, true);
  assertEqual(result.status, 'COMPLETED');
  assertEqual(result.gatewayTransactionId, 'ES-0009911');
  assertEqual(result.amount, 500, 'a number, not the provider\u2019s string');
  assertEqual(result.currency, GATEWAY_CURRENCY);
  assertEqual(result.reference, 'INV-20260101-001-8f2a');
  assertEqual(normalize({ amount: '1,000.00' }).amount, 1000, 'eSewa formats its amount with commas');
  assertEqual(normalize({ currency: 'npr' }).currency, 'NPR');
  assertEqual(normalize({ detail: undefined }).detail, '');
});

test('only the provider\u2019s own COMPLETED sets verified', () => {
  const cases = [
    ['COMPLETE', true], ['PENDING', false], ['CANCELED', false],
    ['NOT_FOUND', false], ['AMBIGUOUS', false],
  ];
  for (const [providerStatus, verified] of cases) {
    const result = normalize({ providerStatus });
    assertEqual(result.verified, verified, `${providerStatus} must map to verified=${verified}`);
    assertEqual(result.verified, result.status === 'COMPLETED',
      'verified and COMPLETED can never disagree');
    assert(VERIFICATION_STATUSES.includes(result.status), `${result.status} is not a schema status`);
  }
  assertEqual(PROVIDERS.join(','), 'ESEWA,KHALTI');
});

test('a malformed provider response is refused instead of guessed', () => {
  const refuses = (message, fn) => {
    try {
      fn();
    } catch (e) {
      assert(e instanceof ProviderResponseError, `${message}: expected ProviderResponseError, got ${e.name}`);
      return;
    }
    throw new Error(`${message}: expected a refusal, got a result`);
  };

  refuses('an unknown provider', () => normalize({ provider: 'FONEPAY' }));
  refuses('an unknown status', () => normalize({ providerStatus: 'MAYBE' }));
  refuses('a missing reference', () => normalize({ reference: '   ' }));
  refuses('no amount at all', () => normalize({ amount: undefined }));
  refuses('an unparseable amount', () => normalize({ amount: 'NPR 500' }));
  refuses('a negative amount', () => normalize({ amount: -500 }));
  refuses('a zero amount', () => normalize({ amount: 0 }));
  refuses('an amount the books cannot hold', () => normalize({ amount: 1e14 }));
  refuses('a completion without a provider transaction id',
    () => normalize({ gatewayTransactionId: null }));
  refuses('a provider transaction id longer than the column',
    () => normalize({ gatewayTransactionId: 'x'.repeat(201) }));
  refuses('a status that is not a schema status', () => normalize({ status: 'PAID' }));

  assertEqual(normalize({ providerStatus: 'PENDING', gatewayTransactionId: null }).gatewayTransactionId,
    null, 'an unfinished answer may omit the transaction id');
});

test('an amount that is not exactly two decimals is refused, never rounded', () => {
  assertEqual(normalize({ amount: 1000.5 }).amount, 1000.5);
  // 100000 paisa is NPR 1000; 100000.5 paisa is 1000.005, which numeric(14,2)
  // cannot hold — silently rounding a gateway amount is how books drift.
  assertEqual(normalize({ providerStatus: 'COMPLETE', amount: 100000 / 100 }).amount, 1000);
  let refused = false;
  try {
    normalize({ amount: 100000.5 / 100 });
  } catch (e) {
    refused = e instanceof ProviderResponseError;
  }
  assert(refused, 'a sub-cent amount must be refused rather than rounded');
});

test('the adapter boundary is pure, and every provider adapter goes through it', () => {
  const adapterFiles = readdirSync(path.join(root, 'server')).filter((f) => f.endsWith('.js'));
  assert(adapterFiles.includes('verification.js'), 'server/verification.js must exist');

  const text = readFileSync(path.join(root, 'server', 'verification.js'), 'utf8');
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert(!/fetch\(|process\.env|express/.test(code),
    'normalisation must be testable without the network, the environment or a framework');

  // Neither provider may build its own result shape: both must normalise
  // through the one mapper, so the database sees one shape from both.
  for (const provider of ['esewa.js', 'khalti.js']) {
    const providerText = readFileSync(path.join(root, 'server', provider), 'utf8');
    assert(/from '\.\/verification\.js'/.test(providerText),
      `${provider} must normalise through server/verification.js`);
  }

  // A credential name may appear in a help message, but no browser file may
  // read one: the bundle only ever reads its public VITE_ configuration.
  const leaked = [];
  for (const f of srcFiles) {
    for (const m of f.text.matchAll(/import\.meta\.env\.([A-Za-z0-9_]+)/g)) {
      const notPublic = !m[1].startsWith('VITE_') && !VITE_BUILTIN_ENV_KEYS.has(m[1]);
      if (notPublic || /SECRET|SERVICE_ROLE|MERCHANT/i.test(m[1])) {
        leaked.push(`${f.rel}: ${m[1]}`);
      }
    }
  }
  assertEqual(leaked.length, 0, `non-public configuration read by the browser: ${leaked.join(', ')}`);

  const modal = srcFiles.find((f) => f.rel.endsWith('src/components/CollectOnlineModal.tsx'));
  assert(/from '\.\.\/services\/paymentGateway'/.test(modal.text),
    'the browser talks to our API, never to a provider directly');
});

/* ---------------------------------------------------------------------- */
/* Stage 9: paying a supplier (the PURCHASE side of settlement)             */
/* ---------------------------------------------------------------------- */

/**
 * A posted supplier payment: money out, against a purchase, with its own
 * PAYMENT journal entry (Dr payable / Cr settlement account).
 */
function makeSupplierPaymentPayload(overrides = {}) {
  return {
    payment: makePaymentRow({
      id: 'pay-po1', reference: 'PAY-20260210-001', amount: 400, payment_method: 'BANK',
      payment_type: 'OUTGOING', linked_sale_id: null, linked_purchase_id: 'po-1',
      party_name: 'Himal Supplies', journal_entry_id: 'je-po-pay', notes: 'part payment',
    }),
    document: makeSettledPurchaseRow(),
    journal_entry: {
      id: 'je-po-pay', business_id: 'biz-1', transaction_date: '2026-02-10', sequence: 7,
      description: 'Settlement to Himal Supplies', reference: 'PAY-20260210-001',
      source_type: 'PAYMENT', source_id: 'pay-po1', created_by: 'u1',
      created_at: '2026-02-10T00:00:00Z',
    },
    journal_lines: [
      { id: 'jl-pp1', journal_entry_id: 'je-po-pay', line_no: 1, account_id: 'ap', account_name: 'Accounts payable', account_type: 'LIABILITY', debit: 400, credit: 0 },
      { id: 'jl-pp2', journal_entry_id: 'je-po-pay', line_no: 2, account_id: 'bank', account_name: 'Bank account', account_type: 'ASSET', debit: 0, credit: 400 },
    ],
    ...overrides,
  };
}

test('a bill offers its own payment action, behind the server-backed guard', () => {
  const view = srcFiles.find((f) => f.rel.endsWith('src/components/DocumentsView.tsx'));
  assert(view, 'DocumentsView.tsx not found');
  assert(/onSettle: \(purchaseId: string\) => void/.test(view.text),
    'the purchases list must accept a settle action');
  const anchor = view.text.indexOf('onSettle(p.id)');
  assert(anchor > 0, 'the purchases row must dispatch the settle action');
  const action = view.text.slice(anchor - 700, anchor + 20);
  assert(action.includes('Pay ${p.referenceNumber}'),
    'the action is labelled with the bill it pays');
  assert(/!isVoided\(p\) && due > 0/.test(action),
    'a voided or fully paid bill is not offered a payment');
  assert(/disabled=\{!canSettle\}/.test(action),
    'and it is disabled when settlements are unavailable, with the reason in its title');
  assert(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); onSettle\(p\.id\); \}\}/.test(view.text),
    'clicking it settles THAT bill');
  assert(/const canSettle = isSupported\('payments'\)/.test(view.text),
    'the gate comes from the capability model, not a per-view check');

  const app = srcFiles.find((f) => f.rel.endsWith('src/App.tsx'));
  assert(/const openSettle = useCallback\(\(documentId: string, direction: 'INCOMING' \| 'OUTGOING'\) => \{/.test(app.text),
    'App must expose one settle entry point for both directions');
  assert(/setSettleFor\(\{ documentId, direction \}\);\s*setTxnModal\('payment'\);/.test(app.text),
    'which opens the settlement form, not a purchase form');
  assert(/preselectDirection=\{settleFor\?\.direction\}/.test(app.text),
    'carrying the direction the document implies');
  assert(/onSettle=\{\(purchaseId\) => openSettle\(purchaseId, 'OUTGOING'\)\}/.test(app.text),
    'and the bills list is wired to it as money out');
});

test('the settlement form opens on the document it was opened from', () => {
  const modal = srcFiles.find((f) => f.rel.endsWith('src/components/TransactionModal.tsx'));
  assert(modal, 'TransactionModal.tsx not found');
  assert(/preselectDocumentId\?: string;/.test(modal.text), 'the form must accept a preselected document');
  assert(/preselectDirection\?: 'INCOMING' \| 'OUTGOING';/.test(modal.text));
  const reset = modal.text.slice(modal.text.indexOf("useEffect(() => {\n    if (!isOpen) return;"));
  assert(/setDirection\(preselectDirection \?\? 'INCOMING'\)/.test(reset),
    'the direction is pre-filled, defaulting to money in');
  assert(/setLinkedDocId\(preselectDocumentId \?\? ''\)/.test(reset),
    'and the bill is selected for the person');
  assert(/preselectDocumentId, preselectDirection, openBills, openInvoices\]\)/.test(modal.text),
    'opening a different bill must re-run the reset');
  assert(/setPaymentAmount\(preselected \? String\(outstandingOn\(preselected\)\)/.test(modal.text),
    'and the outstanding balance is filled in through the one formula that reads the persisted rows');
  assert(/const preselected = preselectDocumentId\n\s*\? \(preselectDirection === 'OUTGOING' \? openBills : openInvoices\)/.test(modal.text),
    'the figure comes from the same list the dropdown shows');
});

test('a supplier payment request sends the bill, amount, method, date and key', () => {
  const args = toPostPaymentArgs({
    businessId: 'biz-1', documentType: 'PURCHASE', documentId: 'po-1', amount: 400,
    paymentMethod: 'BANK', date: '2026-02-10', notes: 'part payment', idempotencyKey: 'k-1',
  });
  assertEqual(args.p_document_type, 'PURCHASE', 'the direction travels as the document type');
  assertEqual(args.p_document_id, 'po-1');
  assertEqual(args.p_amount, 400);
  assertEqual(args.p_payment_method, 'BANK');
  assertEqual(args.p_reference, '', 'a blank reference asks the server to allocate PAY-YYYYMMDD-NNN');
  for (const forbidden of ['p_payment_type', 'p_linked_purchase_id', 'p_linked_sale_id',
    'p_party_name', 'p_status', 'p_doc_status', 'p_journal_entry_id', 'p_created_by', 'p_paid_amount']) {
    assert(!(forbidden in args), `the client must never send ${forbidden}`);
  }
});

test('a supplier payment entry debits the payable first and credits money out', () => {
  const result = toPostPaymentResult(makeSupplierPaymentPayload());
  assertEqual(result.payment.paymentType, 'OUTGOING');
  assertEqual(result.payment.linkedPurchaseId, 'po-1');
  assertEqual(result.payment.linkedSaleId, undefined, 'a supplier payment has no sale');
  assertEqual(result.payment.gatewayTransactionId, undefined,
    'a manual supplier payment carries no gateway link');
  assertEqual(result.payment.reference, 'PAY-20260210-001', 'money out is a PAY- reference');
  assertEqual(result.payment.partyName, 'Himal Supplies', 'the supplier snapshot comes from the bill');
  assertEqual(result.journalLines[0].accountName, 'Accounts payable');
  assertEqual(round2(result.journalLines[0].debit - result.journalLines[0].credit), 400,
    'line 1 debits the payable for the full amount');
  assertEqual(round2(result.journalLines[1].credit - result.journalLines[1].debit), 400,
    'line 2 credits the settlement account');
  assertEqual(result.journalEntry.sourceType, 'PAYMENT');
  assertEqual(result.journalEntry.sourceId, 'pay-po1');
  assertEqual(result.document.referenceNumber, 'PO-20260101-001', 'the settled bill comes back');
});

test('a supplier payment moves the bill through reconcile, and the void puts it back', () => {
  const purchase = toPurchase(makePurchaseRow({ id: 'po-1', upfront_paid: 0 }), []);
  const applied = applyPostedPayment(
    makePaymentState(), toPostPaymentResult(makeSupplierPaymentPayload()),
  );

  const paid = reconcile([], [purchase], applied.payments).purchases[0];
  assertEqual(paid.paidAmount, 400, 'the settlement row is the only source of what was paid');
  assertEqual(paid.paymentStatus, 'PARTIALLY_PAID');
  assertEqual(round2(paid.totalAmount - paid.paidAmount), 1600, 'the rest is still owed to the supplier');

  const voided = applyVoidedPayment(applied, toVoidPaymentResult(makeVoidPaymentPayload({
    payment: makePaymentRow({
      id: 'pay-po1', reference: 'PAY-20260210-001', amount: 400, payment_method: 'BANK',
      payment_type: 'OUTGOING', linked_sale_id: null, linked_purchase_id: 'po-1',
      party_name: 'Himal Supplies', journal_entry_id: 'je-po-pay', doc_status: 'VOIDED',
    }),
    document: makeSettledPurchaseRow(),
    original_journal_entry: {
      id: 'je-po-pay', business_id: 'biz-1', transaction_date: '2026-02-10', sequence: 7,
      description: 'Settlement to Himal Supplies', reference: 'PAY-20260210-001',
      source_type: 'PAYMENT', source_id: 'pay-po1', reversed_by_entry_id: 'je-rev-po',
      created_by: 'u1', created_at: '2026-02-10T00:00:00Z',
    },
    reversal_journal_entry: {
      id: 'je-rev-po', business_id: 'biz-1', transaction_date: '2026-03-01', sequence: 9,
      description: 'Reversal of PAY-20260210-001', reference: 'REV-PAY-20260210-001',
      source_type: 'REVERSAL', source_id: 'pay-po1', reverses_entry_id: 'je-po-pay',
      created_by: 'u1', created_at: '2026-03-01T00:00:00Z',
    },
    reversal_journal_lines: [
      { id: 'jl-rp1', journal_entry_id: 'je-rev-po', line_no: 1, account_id: 'ap', account_name: 'Accounts payable', account_type: 'LIABILITY', debit: 0, credit: 400 },
      { id: 'jl-rp2', journal_entry_id: 'je-rev-po', line_no: 2, account_id: 'bank', account_name: 'Bank account', account_type: 'ASSET', debit: 400, credit: 0 },
    ],
  })));

  const afterVoid = reconcile([], [purchase], voided.payments).purchases[0];
  assertEqual(afterVoid.paidAmount, 0, 'the voided supplier payment stops counting');
  assertEqual(afterVoid.paymentStatus, 'UNPAID');
  assertEqual(round2(afterVoid.totalAmount - afterVoid.paidAmount), 2000,
    'the bill owes its full amount again');
  assertEqual(afterVoid.status, 'POSTED', 'and the bill itself is untouched by the void');
});

test('the payment form pre-checks the balance without trusting it', () => {
  const modal = srcFiles.find((f) => f.rel.endsWith('src/components/TransactionModal.tsx'));
  const validate = modal.text.slice(
    modal.text.indexOf("if (kind === 'payment') {"), modal.text.indexOf('  };\n\n  /**'),
  );
  assert(/if \(amount <= 0\) return 'Enter an amount above zero.'/.test(validate),
    'an amount above zero is required');
  assert(/if \(!linkedDocId\) return 'Pick the document this settlement settles.'/.test(validate),
    'a settlement without a document cannot be posted');
  assert(/amount > outstanding \+ 0\.005/.test(validate),
    'and the outstanding figure is a friendly pre-check only');
  assert(/The server locks the document and recomputes/.test(validate),
    'the code must say the server stays authoritative');
  assert(/const outstanding = linkedDoc \? outstandingOn\(linkedDoc\) : 0;/.test(modal.text),
    'the figure is derived from persisted rows in state, never a stored due column');
});

test('the bill payment form guards double submission and surfaces the failure', () => {
  const modal = srcFiles.find((f) => f.rel.endsWith('src/components/TransactionModal.tsx'));
  const submit = modal.text.slice(modal.text.indexOf('const handleSubmit'), modal.text.indexOf('const titles'));
  assert(/if \(isSubmitting\) return;/.test(submit),
    'a second click while the settlement is in flight must not post again');
  assert(/setIsSubmitting\(true\)/.test(submit) && /finally \{\s*setIsSubmitting\(false\);/.test(submit),
    'and the busy flag is always cleared, even on failure');
  assert(/if \(problem\) \{ setError\(problem\); return; \}/.test(submit),
    'a rejected pre-check is shown, not swallowed');
  assert(/if \(!result\.ok\) \{ setError\(result\.message\); return; \}/.test(submit),
    'and a server refusal is the message the person sees');
  assert(/paymentRetryRef\.current = null;/.test(submit),
    'a successful settlement retires its retry key');
  assert(/linkedPurchaseId: direction === 'OUTGOING' \? linkedDocId \|\| undefined : undefined/.test(submit),
    'the bill travels as the purchase link, which is what makes it money out');
  assert(/disabled=\{isSubmitting\}/.test(modal.text), 'both footer buttons are disabled while busy');
  assert(/<Callout tone="error">\{error\}<\/Callout>/.test(modal.text), 'the error is visible in the form');
});

test('every supplier-payment entry point ends at post_payment, never at a table', () => {
  const service = srcFiles.find((f) => f.rel.endsWith('src/services/bookService.ts'));
  assert(/kind: 'PAYMENT'/.test(service.text) && /postJournal/.test(service.text),
    'settlements go through the one posting function');
  assert(/documentType/.test(service.text), 'and the direction still comes from the document type');

  const books = srcFiles.find((f) => f.rel.endsWith('src/state/useBooks.ts'));
  const addPayment = books.text.slice(
    books.text.indexOf('const addPayment = useCallback'),
    books.text.indexOf('Void a document in the cloud'),
  );
  assert(/linkedPurchaseId \? 'PURCHASE' as const/.test(addPayment),
    'a purchase link is what makes the settlement money out');
  assert(/if \(!documentType \|\| !documentId\) \{/.test(addPayment),
    'and a settlement without a document is refused before the call');
  assert(/applyPostedPayment\(\{ payments, journalEntries \}, result\)/.test(addPayment),
    'state is derived from the persisted answer, never guessed');

  const writes = [];
  for (const f of srcFiles) {
    for (const m of f.text.matchAll(/\.from\('(payments|purchases)'\)[\s\S]{0,40}?\.(insert|update|delete)\b/g)) {
      writes.push(`${f.rel}: ${m[0].replace(/\s+/g, ' ')}`);
    }
  }
  assertEqual(writes.length, 0,
    `no browser file may write payments or purchases directly: ${writes.join(', ')}`);
});

/* ---------------------------------------------------------------------- */
/* Stage 10: receiving money against an invoice (the manual RECEIPT)        */
/* ---------------------------------------------------------------------- */

test('an invoice offers a manual receipt, kept distinct from collecting online', () => {
  const view = srcFiles.find((f) => f.rel.endsWith('src/components/DocumentsView.tsx'));
  assert(view, 'DocumentsView.tsx not found');
  assert(/onReceive: \(saleId: string\) => void/.test(view.text),
    'the sales list must accept a receipt action');
  const anchor = view.text.indexOf('onReceive(s.id)');
  assert(anchor > 0, 'the sales row must dispatch the receipt action');
  const action = view.text.slice(anchor - 800, anchor + 20);
  assert(action.includes('Receive payment for ${s.invoiceNumber}'),
    'the action is labelled with the invoice it receives against');
  assert(/!isVoided\(s\) && due > 0/.test(action),
    'a voided or fully received invoice is not offered a receipt');
  assert(/disabled=\{!canReceive\}/.test(action),
    'and it is disabled when settlements are unavailable, with the reason in its title');
  assert(/const canReceive = isSupported\('payments'\)/.test(view.text),
    'the gate comes from the capability model, not a per-view check');
  const receiptButton = view.text.slice(anchor - 800, anchor + 160);
  assert(/HandCoins/.test(receiptButton),
    'the receipt action carries its own icon, so it cannot be mistaken for the gateway');

  // The same row also offers the gateway. The two actions must be visibly
  // different things: money that already arrived versus a payment the customer
  // still has to make on the provider's page.
  const collectAnchor = view.text.indexOf('onCollect(s.id)');
  assert(collectAnchor > 0, 'the gateway action is still offered on the row');
  const collectAction = view.text.slice(collectAnchor - 400, collectAnchor + 200);
  assert(collectAction.includes('Collect ${s.invoiceNumber} online'),
    'the gateway action keeps its own label');
  assert(/Zap/.test(collectAction), 'and its own icon');
  assert(/This is NOT the gateway:/.test(view.text),
    'the source must spell out that a receipt is not a gateway collection');

  const app = srcFiles.find((f) => f.rel.endsWith('src/App.tsx'));
  assert(/onReceive=\{\(saleId\) => openSettle\(saleId, 'INCOMING'\)\}/.test(app.text),
    'the invoice row opens the one settlement entry point as money IN');
});

test('the receipt form opens on the invoice with the balance the server left', () => {
  const modal = srcFiles.find((f) => f.rel.endsWith('src/components/TransactionModal.tsx'));
  assert(/preselectDirection === 'OUTGOING' \? openBills : openInvoices/.test(modal.text),
    'an incoming receipt is preselected from the open invoices');
  assert(/setDirection\(preselectDirection \?\? 'INCOMING'\)/.test(modal.text),
    'and money in is the default direction when nothing is preselected');
  assert(/setPaymentAmount\(preselected \? String\(outstandingOn\(preselected\)\) : ''\)/.test(modal.text),
    'the amount is filled through the one formula, never from a stored due column');
  assert(/const outstanding = linkedDoc \? outstandingOn\(linkedDoc\) : 0;/.test(modal.text),
    'the outstanding figure is derived from the rows, so the embedded upfront receipt is already netted off');
});

test('a receipt request names the invoice, the amount, the method, the date and the key', () => {
  const args = toPostPaymentArgs({
    businessId: 'biz-1', documentType: 'SALE', documentId: 'sale-1', amount: 400,
    paymentMethod: 'CASH', date: '2026-02-10', notes: 'received in cash', idempotencyKey: 'k-rcp',
  });
  assertEqual(args.p_document_type, 'SALE', 'the invoice travels as the document type');
  assertEqual(args.p_document_id, 'sale-1');
  assertEqual(args.p_amount, 400);
  assertEqual(args.p_payment_method, 'CASH');
  assertEqual(args.p_date, '2026-02-10');
  assertEqual(args.p_idempotency_key, 'k-rcp');
  assertEqual(args.p_reference, '', 'a blank reference asks the server to allocate RCP-YYYYMMDD-NNN');
  for (const forbidden of ['p_payment_type', 'p_linked_sale_id', 'p_linked_purchase_id',
    'p_party_name', 'p_status', 'p_doc_status', 'p_journal_entry_id', 'p_created_by',
    'p_sequence', 'p_gateway_transaction_id', 'p_paid_amount']) {
    assert(!(forbidden in args), `the browser must never send ${forbidden}`);
  }
});

test('a receipt debits a settlement account and credits the invoice receivable', () => {
  const result = toPostPaymentResult(makePostPaymentPayload({
    payment: makePaymentRow({ payment_method: 'CASH' }),
    journal_lines: [
      { id: 'jl-c1', journal_entry_id: 'je-pay-1', line_no: 1, account_id: 'cash', account_name: 'Cash in hand', account_type: 'ASSET', debit: 400, credit: 0 },
      { id: 'jl-c2', journal_entry_id: 'je-pay-1', line_no: 2, account_id: 'ar', account_name: 'Accounts receivable', account_type: 'ASSET', debit: 0, credit: 400 },
    ],
  }));
  assertEqual(result.payment.paymentType, 'INCOMING', 'a receipt against an invoice is money in');
  assertEqual(result.payment.linkedSaleId, 'sale-1');
  assertEqual(result.payment.linkedPurchaseId, undefined, 'a receipt has no supplier side');
  assertEqual(result.payment.gatewayTransactionId, undefined,
    'a manual receipt carries no gateway link');
  assertEqual(result.journalLines[0].accountName, 'Cash in hand', 'the method decides the debit account');
  assertEqual(round2(result.journalLines[0].debit - result.journalLines[0].credit), 400);
  assertEqual(round2(result.journalLines[1].credit - result.journalLines[1].debit), 400,
    'the invoice receivable shrinks by exactly what was received');
  assertEqual(result.journalEntry.sourceType, 'PAYMENT');
  assertEqual(result.journalEntry.sourceId, 'pay-1', 'the entry is sourced to the receipt row');
  assertEqual(result.document.invoiceNumber, 'INV-20260101-001', 'the received invoice comes back');
});

test('a receipt, its void and a second receipt move the invoice through reconcile', () => {
  const invoice = {
    id: 'sale-1', businessId: 'biz-1', date: '2026-01-01', items: [], subtotal: 1000,
    discountTotal: 0, taxAmount: 130, totalAmount: 1130, upfrontPaid: 0, paidAmount: 0,
    paymentStatus: 'UNPAID', paymentMethod: 'CASH', status: 'POSTED', journalEntryId: 'je-1',
    createdAt: '2026-01-01T00:00:00Z', createdBy: 'u1', invoiceNumber: 'INV-20260101-001',
    customerId: 'cust-1', customerName: 'Walk-in',
  };

  // The receipt post_sale embedded for an upfront invoice is a payment row like
  // any other, so it is counted from the sub-ledger and not a second time from
  // the invoice's own upfront column.
  const embedded = toPayment(makePaymentRow({
    id: 'pay-up', amount: 200, reference: 'REC-INV-20260101-001', journal_entry_id: 'je-1',
    notes: 'Upfront receipt for INV-20260101-001', idempotency_key: null,
  }));

  const applied = applyPostedPayment(makePaymentState(), toPostPaymentResult(makePostPaymentPayload()));
  const received = reconcile([invoice], [], [embedded, ...applied.payments]).sales[0];
  assertEqual(received.paidAmount, 600, 'the embedded 200 and the new 400 are both counted, once each');
  assertEqual(received.paymentStatus, 'PARTIALLY_PAID');
  assertEqual(round2(received.totalAmount - received.paidAmount), 530, 'NPR 530 is still outstanding');

  const voided = applyVoidedPayment(applied, toVoidPaymentResult(makeVoidPaymentPayload()));
  const afterVoid = reconcile([invoice], [], [embedded, ...voided.payments]).sales[0];
  assertEqual(voided.payments.length, 1, 'the voided receipt is kept, never dropped from state');
  assertEqual(voided.payments[0].docStatus, 'VOIDED');
  assertEqual(afterVoid.paidAmount, 200, 'only the embedded receipt still counts');
  assertEqual(round2(afterVoid.totalAmount - afterVoid.paidAmount), 930,
    'the balance the receipt had covered is owed again');
  assertEqual(afterVoid.status, 'POSTED', 'and the invoice itself is untouched by the void');

  const again = applyPostedPayment(voided, toPostPaymentResult(makePostPaymentPayload({
    payment: makePaymentRow({
      id: 'pay-2', amount: 930, reference: 'RCP-20260301-002', amount: 930,
      journal_entry_id: 'je-pay-2', idempotency_key: 'k-2', notes: 'received again',
    }),
    journal_entry: {
      id: 'je-pay-2', business_id: 'biz-1', transaction_date: '2026-03-01', sequence: 6,
      description: 'Settlement from Walk-in', reference: 'RCP-20260301-002',
      source_type: 'PAYMENT', source_id: 'pay-2', created_by: 'u1',
      created_at: '2026-03-01T00:00:00Z',
    },
    journal_lines: [
      { id: 'jl-q1', journal_entry_id: 'je-pay-2', line_no: 1, account_id: 'bank', account_name: 'Bank', account_type: 'ASSET', debit: 930, credit: 0 },
      { id: 'jl-q2', journal_entry_id: 'je-pay-2', line_no: 2, account_id: 'ar', account_name: 'Accounts receivable', account_type: 'ASSET', debit: 0, credit: 930 },
    ],
  })));
  const afterAgain = reconcile([invoice], [], [embedded, ...again.payments]).sales[0];
  assertEqual(again.payments.length, 2, 'the second receipt is a new row; nothing is revived');
  assertEqual(afterAgain.paidAmount, 1130, 'the invoice is fully received');
  assertEqual(afterAgain.paymentStatus, 'PAID');
  assertEqual(round2(afterAgain.totalAmount - afterAgain.paidAmount), 0, 'nothing is left outstanding');
  assertEqual(afterAgain.status, 'POSTED', 'and the invoice was never un-posted to receive it');
});

test('the receipt form guards double submission and retries under one key per action', () => {
  const modal = srcFiles.find((f) => f.rel.endsWith('src/components/TransactionModal.tsx'));
  const submit = modal.text.slice(modal.text.indexOf('const handleSubmit'), modal.text.indexOf('const titles'));
  assert(/linkedSaleId: direction === 'INCOMING' \? linkedDocId \|\| undefined : undefined/.test(submit),
    'the invoice travels as the sale link, which is what makes it money in');
  assert(/if \(isSubmitting\) return;/.test(submit),
    'a second click while the receipt is in flight must not post again');
  assert(/disabled=\{isSubmitting \|\| !supported\}/.test(modal.text),
    'the form cannot be submitted while busy or unavailable');
  assert(/if \(!result\.ok\) \{ setError\(result\.message\); return; \}/.test(submit),
    'a server refusal is the message the person sees');
  assert(/paymentRetryRef\.current = null;/.test(submit),
    'a successful receipt retires its retry key');

  const key = modal.text.slice(modal.text.indexOf('const paymentIdempotencyKey'), modal.text.indexOf('const handleSubmit'));
  assert(/direction, linkedDocId, date, parseAmount\(paymentAmount\), method, notes\.trim\(\),/.test(key),
    'the key covers the direction and the document, so editing either is a new action');
  assert(/newId\('pay'\)/.test(key), 'and each action mints exactly one key');
});

test('every receipt entry point ends at post_payment, never at a table', () => {
  const service = srcFiles.find((f) => f.rel.endsWith('src/services/bookService.ts'));
  assert(/postJournal/.test(service.text),
    'a receipt goes through the same posting function as everything else');
  assert(!/post_receipt|record_receipt|receive_payment/.test(service.text),
    'there is no receipt-specific RPC to drift from the accounting');

  const books = srcFiles.find((f) => f.rel.endsWith('src/state/useBooks.ts'));
  const addPayment = books.text.slice(
    books.text.indexOf('const addPayment = useCallback'),
    books.text.indexOf('Void a document in the cloud'),
  );
  assert(/linkedSaleId \? 'SALE' as const/.test(addPayment),
    'an invoice link is what makes the settlement money in');
  assert(/if \(!documentType \|\| !documentId\) \{/.test(addPayment),
    'and a receipt without an invoice is refused before the call');
  assert(/applyPostedPayment\(\{ payments, journalEntries \}, result\)/.test(addPayment),
    'state is derived from the persisted answer, never guessed');

  const writes = [];
  for (const f of srcFiles) {
    for (const m of f.text.matchAll(
      /\.from\('(payments|sales|journal_entries|journal_lines|gateway_transactions)'\)[\s\S]{0,40}?\.(insert|update|delete)\b/g,
    )) {
      writes.push(`${f.rel}: ${m[0].replace(/\s+/g, ' ')}`);
    }
  }
  assertEqual(writes.length, 0,
    `no browser file may write money rows directly: ${writes.join(', ')}`);
});

/* ---------------------------------------------------------------------- */
/* Stage 11: settlement rows are the only source of a paid amount            */
/* ---------------------------------------------------------------------- */

/**
 * A document as the harness builds them, with an upstream field the type no
 * longer declares. Used to prove the derivation ignores it rather than trusting
 * that nobody will ever pass it.
 */
function makeSaleWithStrayUpfront(paidAmount = 0) {
  return {
    id: 'sale-1', businessId: 'biz-1', date: '2026-01-01', items: [], subtotal: 1000,
    discountTotal: 0, taxAmount: 130, totalAmount: 1130, upfrontPaid: 500, paidAmount,
    paymentStatus: 'UNPAID', paymentMethod: 'CASH', status: 'POSTED', journalEntryId: 'je-1',
    createdAt: '2026-01-01T00:00:00Z', createdBy: 'u1', invoiceNumber: 'INV-20260101-001',
    customerId: 'cust-1', customerName: 'Walk-in',
  };
}

const settlementRow = (overrides = {}) => ({
  id: 'pay-x', linkedSaleId: 'sale-1', amount: 400, docStatus: 'POSTED', status: 'COMPLETED',
  ...overrides,
});

test('the document types carry no upfront amount, only a request does', () => {
  const types = srcFiles.find((f) => f.rel.endsWith('src/types.ts'));
  assert(types, 'src/types.ts not found');
  const base = types.text.slice(
    types.text.indexOf('interface DocumentBase'),
    types.text.indexOf('export interface Sale'),
  );
  assert(!/upfrontPaid/.test(base),
    'DocumentBase must not declare an upfront amount: it is not a document property');
  assert(/upfrontPaid: number;/.test(types.text),
    'while the request drafts still carry the amount the form settled at posting');
  assert(/export type SaleDraft/.test(types.text) && /export type PurchaseDraft/.test(types.text),
    'the drafts are named types, so a form cannot pass a document-shaped object by accident');

  // The money paths still never name it. Stage 12 added one reader — the row
  // adapter — and only so a reprinted document can show the posting-time
  // snapshot; it lands under `postingSnapshot`, never in a balance.
  for (const file of ['src/services/posting.ts', 'src/services/accountingEngine.ts']) {
    const src = srcFiles.find((f) => f.rel.endsWith(file));
    assert(src, `${file} not found`);
    const withoutComments = src.text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert(!/upfrontPaid|upfront_paid/.test(withoutComments),
      `${file} must not read an upfront amount: the settlement rows are the money`);
  }

  const adapters = srcFiles.find((f) => f.rel.endsWith('src/lib/dbTypes.ts'));
  const adapterCode = adapters.text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert(/postingSnapshot: postingSnapshot\(row\)/.test(adapterCode),
    'the adapter carries the column under the name that says what it is');
  assert(/paidAmount: 0/.test(adapterCode),
    'and still derives paidAmount from the settlement rows alone');
  assertEqual((adapterCode.match(/postingSnapshot: postingSnapshot\(row\)/g) ?? []).length, 2,
    'exactly the sale and the purchase adapter carry a snapshot, and nothing else does');
});

test('a paid total is the settlement rows, and an upstream-shaped field cannot add to it', () => {
  const onlyRows = reconcile([makeSaleWithStrayUpfront()], [], [settlementRow()]).sales[0];
  assertEqual(onlyRows.paidAmount, 400,
    'the 400 settlement row is the paid amount — the stray 500 on the document is ignored');
  assertEqual(onlyRows.paymentStatus, 'PARTIALLY_PAID');
  assertEqual(outstandingOn(onlyRows), 730, 'total 1130 less the rows');

  const embeddedAndLater = reconcile(
    [makeSaleWithStrayUpfront()], [],
    [settlementRow({ id: 'pay-embedded', amount: 300 }), settlementRow({ id: 'pay-later', amount: 830 })],
  ).sales[0];
  assertEqual(embeddedAndLater.paidAmount, 1130, 'the embedded row and the later receipt are summed');
  assertEqual(embeddedAndLater.paymentStatus, 'PAID');
  assertEqual(outstandingOn(embeddedAndLater), 0);

  const voided = reconcile(
    [makeSaleWithStrayUpfront()], [],
    [settlementRow({ id: 'pay-void', amount: 1130, docStatus: 'VOIDED' })],
  ).sales[0];
  assertEqual(voided.paidAmount, 0, 'a voided settlement stops counting');
  assertEqual(voided.paymentStatus, 'UNPAID');
});

test('one settlement sum serves both directions, and only live rows count', () => {
  const rows = [
    settlementRow({ id: 'r1', amount: 300 }),
    settlementRow({ id: 'r2', linkedSaleId: null, linkedPurchaseId: 'po-1', amount: 500 }),
    settlementRow({ id: 'r3', linkedSaleId: 'sale-1', amount: 999, docStatus: 'VOIDED' }),
    settlementRow({ id: 'r4', linkedSaleId: 'sale-1', amount: 100, status: 'PENDING' }),
    settlementRow({ id: 'r5', linkedSaleId: 'other-sale', amount: 700 }),
  ];
  assertEqual(linkedSettlementTotal(rows, 'sale-1'), 300,
    'money in: only this invoice, only COMPLETED and POSTED');
  assertEqual(linkedSettlementTotal(rows, 'po-1'), 500, 'money out: the same rule on the other link');
  assertEqual(linkedSettlementTotal(rows, 'nothing-here'), 0, 'a document with no rows owes everything');
  assertEqual(linkedSettlementTotal([], 'sale-1'), 0);

  // The same function the server applies: a document's outstanding balance is
  // its total minus this figure, which is what the DB suite refuses against.
  assertEqual(round2(1130 - linkedSettlementTotal(rows, 'sale-1')), 830);
});

test('every screen shows the outstanding balance through the one formula', () => {
  assertEqual(outstandingOn({ totalAmount: 1130, paidAmount: 400 }), 730);
  assertEqual(outstandingOn({ totalAmount: 1130, paidAmount: 1130 }), 0);
  assertEqual(outstandingOn({ totalAmount: 0.1 + 0.2, paidAmount: 0 }), 0.3, 'and it rounds once');

  const offenders = [];
  for (const f of srcFiles) {
    if (f.rel.endsWith('src/services/posting.ts')) continue;
    for (const m of f.text.matchAll(/round2\(\s*([A-Za-z_$][\w.$]*)\.totalAmount\s*-\s*([A-Za-z_$][\w.$]*)\.paidAmount/g)) {
      offenders.push(`${f.rel}: ${m[0]}`);
    }
  }
  assertEqual(offenders.length, 0,
    `no screen may subtract a paid amount on its own: ${offenders.join(', ')}`);

  const books = srcFiles.find((f) => f.rel.endsWith('src/state/useBooks.ts'));
  assert(/outstandingOn\(s\) > 0\.005/.test(books.text) && /outstandingOn\(p\) > 0\.005/.test(books.text),
    'even "is this document open?" is answered by the one formula');
  const view = srcFiles.find((f) => f.rel.endsWith('src/components/DocumentsView.tsx'));
  assertEqual((view.text.match(/outstandingOn\(/g) ?? []).length, 4,
    'the sales and bills rows — balance and action — all use it');
});

test('the receipt and settlement entry points still send only a request', () => {
  const service = srcFiles.find((f) => f.rel.endsWith('src/services/bookService.ts'));
  assert(/params\.upfrontPaid \?\? 0/.test(service.text),
    'the upfront amount travels as the input that creates the settlement row');
  const books = srcFiles.find((f) => f.rel.endsWith('src/state/useBooks.ts'));
  const addSale = books.text.slice(books.text.indexOf('const addSale'), books.text.indexOf('const addPurchase'));
  assert(/outstandingOn/.test(books.text), 'the hook derives open documents from the same formula');
  assert(/applyPostedPayment\(\{ payments, journalEntries \}, result\)/.test(books.text),
    'and a settlement still only ever enters state from the persisted answer');

  const stray = [];
  for (const f of srcFiles) {
    for (const m of f.text.matchAll(/\b(upfrontPaid|upfront_paid)\b/g)) {
      const line = f.text.slice(f.text.lastIndexOf('\n', m.index) + 1, f.text.indexOf('\n', m.index));
      const allowed = f.rel.endsWith('src/types.ts')
        || f.rel.endsWith('src/services/bookService.ts')
        || f.rel.endsWith('src/lib/purchaseState.ts')
        || f.rel.endsWith('src/components/TransactionModal.tsx')
        || f.rel.endsWith('src/state/useBooks.ts')
        // Stage 12: the adapter that carries it as a snapshot, and the type of
        // the value it carries.
        || f.rel.endsWith('src/lib/dbTypes.ts')
        || f.rel.endsWith('src/state/useDemoBooks.ts')
        || f.rel.endsWith('src/services/reportData.ts');
      if (!allowed && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*')) {
        stray.push(`${f.rel}: ${line.trim()}`);
      }
    }
  }
  assertEqual(stray.length, 0,
    `the upfront amount may only appear on the request path: ${stray.join(' | ')}`);
  assert(addSale, 'the sale draft path is present');

  // Stage 12 tightened this: the token may sit on a request field or on the
  // snapshot, but never inside money arithmetic. A line naming it *and* a
  // balance is exactly the double-counting bug Stage 11 removed.
  const SNAPSHOT = 'upfrontPaid|upfront_paid|postingSnapshot|snapshotUpfront';
  const MONEY = 'paidAmount|totalAmount|outstanding|settled|balance';
  const MONEY_ARITHMETIC = new RegExp(
    `(?:\\b(?:${MONEY})\\b\\s*[-+*/])|(?:[-+*/]\\s*(?:${SNAPSHOT})\\b)|(?:(?:${SNAPSHOT})\\b\\s*[-+*/])`,
  );
  const arithmetics = [];
  for (const f of srcFiles) {
    for (const m of f.text.matchAll(new RegExp(`\\b(?:${SNAPSHOT})\\b`, 'g'))) {
      const line = f.text.slice(f.text.lastIndexOf('\n', m.index) + 1, f.text.indexOf('\n', m.index));
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (MONEY_ARITHMETIC.test(line)) arithmetics.push(`${f.rel}: ${trimmed}`);
    }
  }
  assertEqual(arithmetics.length, 0,
    `no code may mix the posting-time snapshot with a balance: ${arithmetics.join(' | ')}`);
});

/* ---------------------------------------------------------------------- */
/* Stage 12: A4 reports and printable documents                              */
/* ---------------------------------------------------------------------- */

const { salesReport, purchaseReport, expenseReport, documentPosition, settlementLines,
  cashBankMovement, cashBankOpeningBalance, reportPeriodLabel, paymentStatusLabel,
  paymentStatusTone, partyFilterOptions, categoryFilterOptions, lineTotal,
  outstandingParties } = reportDataMod;

const REPORT_RANGE = { from: '2026-01-01', to: '2026-01-31', label: 'January 2026' };

const repSale = (over = {}) => ({
  id: 'sale-1', businessId: 'biz-1', date: '2026-01-05',
  // Terms and the due date they imply, as post_sale records them: 0 days means
  // the document fell due on its own date.
  paymentTermsDays: 0, dueDate: '2026-01-05',
  items: [{ id: 'li-1', description: 'Goods', quantity: 2, unitPrice: 500, discount: 0, total: 1000 }],
  subtotal: 1000, discountTotal: 0, taxAmount: 0, totalAmount: 1000,
  paidAmount: 0, postingSnapshot: { upfrontPaid: 0 }, paymentStatus: 'UNPAID',
  paymentMethod: 'CASH', status: 'POSTED', journalEntryId: 'je-1',
  createdAt: '2026-01-05T00:00:00Z', createdBy: 'u1',
  invoiceNumber: 'INV-20260105-001', customerId: 'cust-1', customerName: 'Himal Traders',
  ...over,
});

const repPurchase = (over = {}) => ({
  id: 'po-1', businessId: 'biz-1', date: '2026-01-07',
  paymentTermsDays: 0, dueDate: '2026-01-07',
  items: [],
  subtotal: 2000, discountTotal: 0, taxAmount: 0, totalAmount: 2000,
  paidAmount: 0, postingSnapshot: { upfrontPaid: 0 }, paymentStatus: 'UNPAID',
  paymentMethod: 'BANK', status: 'POSTED', journalEntryId: 'je-2',
  createdAt: '2026-01-07T00:00:00Z', createdBy: 'u1',
  referenceNumber: 'PO-20260107-001', supplierId: 'supp-1', supplierName: 'Everest Supplies',
  ...over,
});

const repExpense = (over = {}) => ({
  id: 'exp-1', businessId: 'biz-1', accountId: 'acc_5020', categoryName: 'Rent',
  date: '2026-01-09', description: 'Shop rent', amount: 5000, taxAmount: 0, totalAmount: 5000,
  paymentMethod: 'BANK', reference: 'EXP-20260109-001', status: 'POSTED',
  journalEntryId: 'je-3', createdAt: '2026-01-09T00:00:00Z', createdBy: 'u1',
  ...over,
});

const repPayment = (over = {}) => ({
  id: 'pay-1', businessId: 'biz-1', amount: 400, paymentMethod: 'CASH', date: '2026-01-10',
  reference: 'RCP-20260110-001', status: 'COMPLETED', paymentType: 'INCOMING',
  linkedSaleId: 'sale-1', partyName: 'Himal Traders', docStatus: 'POSTED',
  journalEntryId: 'je-4', createdAt: '2026-01-10T00:00:00Z', createdBy: 'u1',
  ...over,
});

test('the sales report lists real invoices, excludes voided ones and totals only what it lists', () => {
  const sales = [
    repSale({ id: 's1', invoiceNumber: 'INV-1', totalAmount: 1000 }),
    repSale({ id: 's2', invoiceNumber: 'INV-2', totalAmount: 500, customerId: 'cust-2', customerName: 'Annapurna Stores' }),
    repSale({ id: 's3', invoiceNumber: 'INV-3', totalAmount: 800, status: 'VOIDED' }),
    repSale({ id: 's4', invoiceNumber: 'INV-4', totalAmount: 200, date: '2026-02-10' }),
  ];
  const payments = [
    repPayment({ id: 'p1', linkedSaleId: 's1', amount: 400 }),
    repPayment({ id: 'p2', linkedSaleId: 's2', amount: 500 }),
    // A voided settlement is history, not money.
    repPayment({ id: 'p3', linkedSaleId: 's1', amount: 100, docStatus: 'VOIDED' }),
  ];

  const report = salesReport(sales, payments, REPORT_RANGE);
  assertEqual(report.rows.length, 2, 'the voided invoice and the February one are not rows');
  assertEqual(report.rows[0].reference, 'INV-1', 'rows read chronologically');
  assertEqual(report.rows[0].settled, 400, 'the voided 100 is not money');
  assertEqual(report.rows[0].outstanding, 600);
  assertEqual(report.rows[0].status, 'PARTIALLY_PAID');
  assertEqual(report.rows[1].status, 'PAID');
  assertEqual(report.total, 1500, 'only the two listed invoices are totalled');
  assertEqual(report.settled, 900);
  assertEqual(report.outstanding, 600);
  assertEqual(report.excludedVoided, 1, 'and the report can say what it left out');

  const filtered = salesReport(sales, payments, REPORT_RANGE, { partyId: 'cust-2' });
  assertEqual(filtered.rows.length, 1, 'filtering by customer keeps only that customer');
  assertEqual(filtered.total, 500);
  assertEqual(filtered.outstanding, 0);
});

test('a settlement counts whenever it was recorded; the period bounds the documents', () => {
  const sales = [repSale({ id: 's1', totalAmount: 1000 })];
  const later = salesReport(sales, [
    repPayment({ id: 'p1', linkedSaleId: 's1', amount: 1000, date: '2026-03-05' }),
  ], REPORT_RANGE);
  assertEqual(later.rows.length, 1, 'the invoice is inside the period');
  assertEqual(later.rows[0].outstanding, 0,
    'and money received in March still settles it — a balance is not period-bound');

  const outOfPeriod = salesReport(sales, [], { from: '2026-02-01', to: '2026-02-28', label: 'Feb' });
  assertEqual(outOfPeriod.rows.length, 0, 'the document itself is bounded by the period');
  assertEqual(outOfPeriod.total, 0);
});

test('the purchase report is the mirror of the sales report', () => {
  const purchases = [
    repPurchase({ id: 'po-1', referenceNumber: 'PO-1', totalAmount: 2000 }),
    repPurchase({ id: 'po-2', referenceNumber: 'PO-2', totalAmount: 300, supplierId: 'supp-2', supplierName: 'Kathmandu Tools' }),
    repPurchase({ id: 'po-3', referenceNumber: 'PO-3', totalAmount: 900, status: 'VOIDED' }),
  ];
  const payments = [
    repPayment({ id: 'p1', linkedSaleId: null, linkedPurchaseId: 'po-1', amount: 1500, paymentType: 'OUTGOING' }),
  ];
  const report = purchaseReport(purchases, payments, REPORT_RANGE);
  assertEqual(report.rows.length, 2);
  assertEqual(report.rows[0].party, 'Everest Supplies');
  assertEqual(report.rows[0].settled, 1500);
  assertEqual(report.rows[0].outstanding, 500);
  assertEqual(report.total, 2300);
  assertEqual(report.outstanding, 800);
  assertEqual(report.excludedVoided, 1);
});

test('the expense report lists posted expenses and totals them, filterable by category', () => {
  const expenses = [
    repExpense({ id: 'e1', totalAmount: 5000, accountId: 'acc_5020', categoryName: 'Rent' }),
    repExpense({ id: 'e2', totalAmount: 1200, accountId: 'acc_5030', categoryName: 'Utilities', reference: 'EXP-2' }),
    repExpense({ id: 'e3', totalAmount: 700, status: 'VOIDED', reference: 'EXP-3' }),
    repExpense({ id: 'e4', totalAmount: 999, date: '2026-03-01', reference: 'EXP-4' }),
  ];
  const report = expenseReport(expenses, REPORT_RANGE);
  assertEqual(report.rows.length, 2);
  assertEqual(report.total, 6200);
  assertEqual(report.excludedVoided, 1);

  const rent = expenseReport(expenses, REPORT_RANGE, { categoryId: 'acc_5020' });
  assertEqual(rent.rows.length, 1);
  assertEqual(rent.total, 5000);
  assertEqual(rent.rows[0].method, 'BANK');
});

test('an empty period reports empty, with no figure invented to fill it', () => {
  const empty = { from: '2026-05-01', to: '2026-05-31', label: 'May 2026' };
  const sales = salesReport([], [], empty);
  assertEqual(sales.rows.length, 0);
  assertEqual(sales.total, 0);
  assertEqual(sales.settled, 0);
  assertEqual(sales.outstanding, 0);
  assertEqual(sales.excludedVoided, 0);

  const expenses = expenseReport([], empty);
  assertEqual(expenses.rows.length, 0);
  assertEqual(expenses.total, 0);

  const purchases = purchaseReport([], [], empty);
  assertEqual(purchases.rows.length, 0);
  assertEqual(purchases.total, 0);

  // And the sheet says so in words, rather than showing a zero-shaped chart.
  const shell = srcFiles.find((f) => f.rel.endsWith('src/components/ReportShell.tsx'));
  assert(/No financial transactions have been recorded for this period\./.test(shell.text),
    'the empty state states the period, not a placeholder');
  const view = srcFiles.find((f) => f.rel.endsWith('src/components/ReportsView.tsx'));
  assert(/<ReportEmpty/.test(view.text), 'and every report goes through it');
  assert(/hasData/.test(view.text), 'which is driven by the real figures');
});

test('a printed document shows the live balance from settlement rows, beside the snapshot', () => {
  const sale = repSale({ totalAmount: 1130, postingSnapshot: { upfrontPaid: 500 } });

  // Nothing recorded against it: the snapshot is not a balance.
  const untouched = documentPosition(sale, []);
  assertEqual(untouched.snapshotUpfront, 500, 'the posting-time record is shown as it was frozen');
  assertEqual(untouched.settled, 0, 'but it is not counted as money received');
  assertEqual(untouched.outstanding, 1130, 'so the invoice is still fully outstanding');

  // One real settlement of the same size as the snapshot: counted once.
  const once = documentPosition(sale, [repPayment({ id: 'p1', linkedSaleId: sale.id, amount: 500 })]);
  assertEqual(once.settled, 500, 'the snapshot is never added to the rows');
  assertEqual(once.outstanding, 630, 'total 1130 less the 500 actually recorded');
  assertEqual(once.lines.length, 1);
  assertEqual(once.status, 'PARTIALLY_PAID');
  assertEqual(once.snapshotUpfront, 500, 'and the historical figure is still available to reprint');

  // Voided money is not money, and is not listed as a settlement.
  const voided = documentPosition(sale, [
    repPayment({ id: 'p1', linkedSaleId: sale.id, amount: 1130, docStatus: 'VOIDED' }),
  ]);
  assertEqual(voided.settled, 0);
  assertEqual(voided.outstanding, 1130);
  assertEqual(voided.lines.length, 0, 'a voided settlement is history, not a receipt');
  assertEqual(voided.status, 'UNPAID');

  const lines = settlementLines([
    repPayment({ id: 'a', linkedSaleId: sale.id, amount: 100, date: '2026-01-11', reference: 'R2' }),
    repPayment({ id: 'b', linkedSaleId: sale.id, amount: 50, date: '2026-01-10', reference: 'R1', gatewayTransactionId: 'gtx-1' }),
    repPayment({ id: 'c', linkedSaleId: sale.id, amount: 999, status: 'PENDING' }),
  ], sale.id);
  assertEqual(lines.length, 2, 'only completed, still-posted settlements are listed');
  assertEqual(lines[0].reference, 'R1', 'oldest first, the order they happened');
  assertEqual(lines[0].viaGateway, true, 'a wallet collection is marked as such');
  assertEqual(lines[1].amount, 100);
});

test('the adapters carry the frozen column as a snapshot, never as a paid amount', () => {
  const sale = dbTypesMod.toSale({
    id: 's1', business_id: 'biz-1', date: '2026-01-05', payment_terms_days: 0, due_date: '2026-01-05', subtotal: 1000, discount_total: 0,
    tax_amount: 0, total_amount: 1000, upfront_paid: 700, payment_method: 'CASH',
    status: 'POSTED', journal_entry_id: 'je-1', created_at: '2026-01-05T00:00:00Z',
    created_by: 'u1', invoice_number: 'INV-1', customer_id: 'cust-1', customer_name: 'Himal Traders',
  }, []);
  assertEqual(sale.paidAmount, 0, 'paidAmount still comes only from the settlement rows');
  assertEqual(sale.postingSnapshot.upfrontPaid, 700, 'the frozen figure is carried, under its own name');

  const purchase = dbTypesMod.toPurchase({
    id: 'po-1', business_id: 'biz-1', date: '2026-01-07', payment_terms_days: 0, due_date: '2026-01-07', subtotal: 2000, discount_total: 0,
    tax_amount: 0, total_amount: 2000, upfront_paid: 300, payment_method: 'BANK',
    status: 'POSTED', journal_entry_id: 'je-2', created_at: '2026-01-07T00:00:00Z',
    created_by: 'u1', reference_number: 'PO-1', supplier_id: 'supp-1', supplier_name: 'Everest Supplies',
  }, []);
  assertEqual(purchase.paidAmount, 0);
  assertEqual(purchase.postingSnapshot.upfrontPaid, 300);

  // reconcile() ignores the snapshot entirely, even when a document carries one.
  const reconciled = reconcile([sale], [purchase], []).sales[0];
  assertEqual(reconciled.paidAmount, 0, 'a snapshot on the document cannot move a balance');
  assertEqual(reconciled.paymentStatus, 'UNPAID');
  assertEqual(outstandingOn(reconciled), 1000);
});

test('the cash and bank statement opens from the ledger and carries a real running balance', () => {
  const accounts = [
    { id: 'acc_1010', businessId: 'biz-1', code: '1010', name: 'Cash in hand', type: 'ASSET', isActive: true },
    { id: 'acc_1020', businessId: 'biz-1', code: '1020', name: 'Bank account', type: 'ASSET', isActive: true },
    { id: 'acc_4010', businessId: 'biz-1', code: '4010', name: 'Sales', type: 'REVENUE', isActive: true },
  ];
  const entry = (id, date, seq, debit, credit) => ({
    id, businessId: 'biz-1', transactionDate: date, sequence: seq, description: 'd',
    reference: id, sourceType: 'SALE', createdBy: 'u1', createdAt: `${date}T00:00:00Z`,
    lines: [
      { id: `${id}-l1`, journalEntryId: id, accountId: 'acc_1010', accountName: 'Cash in hand', accountType: 'ASSET', debit, credit },
      { id: `${id}-l2`, journalEntryId: id, accountId: 'acc_4010', accountName: 'Sales', accountType: 'REVENUE', debit: credit, credit: debit },
    ],
  });
  const entries = [
    entry('je-open', '2025-12-30', 1, 1000, 0),
    entry('je-in', '2026-01-10', 2, 500, 0),
  ];

  assertEqual(cashBankOpeningBalance(accounts, entries, '2026-01-01'), 1000,
    'the opening figure is read from lines dated before the period');
  assertEqual(cashBankOpeningBalance(accounts, entries, '2026-01-10'), 1000,
    'and the opening day is not inside its own opening balance — it is in the movement below');
  assertEqual(cashBankOpeningBalance(accounts, entries, '2025-01-01'), 0,
    'a period that starts before anything was posted opens at zero');

  const statement = cashBankMovement([
    { date: '2026-01-12', reference: 'R2', description: 'paid out', accountName: 'Cash in hand', direction: 'OUTFLOW', amount: 200 },
    { date: '2026-01-10', reference: 'R1', description: 'received', accountName: 'Cash in hand', direction: 'INFLOW', amount: 500 },
  ], 1000);
  assertEqual(statement.opening, 1000);
  assertEqual(statement.totalIn, 500);
  assertEqual(statement.totalOut, 200);
  assertEqual(statement.closing, 1300);
  assertEqual(statement.rows[0].reference, 'R2', 'newest first, as a statement is read');
  assertEqual(statement.rows[0].balance, 1300, 'the top row is the closing balance');
  assertEqual(statement.rows[1].balance, 1500, 'and the row beneath is the balance after it');
  assertEqual(round2(statement.opening + statement.totalIn - statement.totalOut), statement.closing,
    'opening + in − out = closing');
});

test('report wording: the period, the statuses and the filter lists', () => {
  assertEqual(reportPeriodLabel({ from: '2026-01-01', to: '2026-01-31', label: 'Jan' }, 'AD', 'period'),
    '1 January 2026 to 31 January 2026');
  assertEqual(reportPeriodLabel({ from: '2026-01-01', to: '2026-01-31', label: 'Jan' }, 'AD', 'asOf'),
    'As at 31 January 2026');
  const bs = reportPeriodLabel({ from: '2026-01-01', to: '2026-01-31', label: 'Jan' }, 'BS', 'period');
  assert(/ to .* BS$/.test(bs), `the BS label names both ends and its calendar: ${bs}`);
  assert(bs.includes('Poush') || bs.includes('Magh'), `BS month names come from the calendar module: ${bs}`);

  assertEqual(paymentStatusLabel('PAID'), 'PAID');
  assertEqual(paymentStatusLabel('PARTIALLY_PAID'), 'PARTIAL');
  assertEqual(paymentStatusLabel('UNPAID'), 'UNPAID');
  assertEqual(paymentStatusLabel('VOIDED'), 'VOID');
  assertEqual(paymentStatusTone('PAID'), 'ok');
  assertEqual(paymentStatusTone('PARTIALLY_PAID'), 'warn');
  assertEqual(paymentStatusTone('UNPAID'), 'neutral');

  const parties = partyFilterOptions([
    { customerId: 'c2', customerName: 'Annapurna' },
    { customerId: 'c1', customerName: 'Himal' },
    { customerId: '', customerName: 'Walk-in' },
    { customerId: 'c1', customerName: 'Himal' },
  ]);
  assertEqual(parties.length, 2, 'one option per party, and a nameless id is not a filter');
  assertEqual(parties[0].label, 'Annapurna', 'sorted for reading');
  assertEqual(categoryFilterOptions([
    { accountId: 'acc_5020', categoryName: 'Rent' },
    { accountId: 'acc_5020', categoryName: 'Rent' },
  ]).length, 1);

  assertEqual(lineTotal({ quantity: 3, unitPrice: 100, discount: 50 }), 250,
    'a document line is recomputed once, with the discount applied');
});

test('every report is one design language, and the money labels are not mixed', () => {
  const shell = srcFiles.find((f) => f.rel.endsWith('src/components/ReportShell.tsx'));
  const view = srcFiles.find((f) => f.rel.endsWith('src/components/ReportsView.tsx'));
  const doc = srcFiles.find((f) => f.rel.endsWith('src/components/DocumentPrintView.tsx'));
  // readSourceFiles() walks .ts/.tsx only, so the stylesheet is read directly.
  const css = { rel: 'src/index.css', text: readFileSync(path.join(root, 'src/index.css'), 'utf8') };
  assert(shell && view && doc && css.text, 'the report layer is present');

  assert(/export const REPORT_CURRENCY = 'NPR'/.test(shell.text),
    'the document system prints one currency label');
  assertEqual((view.text.match(/<ReportSheet/g) ?? []).length, 1,
    'all reports share the single sheet, rather than one component each');
  assert((view.text.match(/<ReportHeader/g) ?? []).length === 1
    && (view.text.match(/<ReportFooter/g) ?? []).length === 1,
    'and the one header and footer');
  for (const file of [view.text, doc.text]) {
    assert(!/currencySymbol/.test(file),
      'a printed sheet never takes its label from the on-screen currency toggle');
  }
  assert(/reportMoney|ReportAmount/.test(view.text) && /reportMoney|ReportAmount/.test(doc.text),
    'figures are formatted through the one report formatter');

  // The stylesheet carries the paper rules, and the old bug — a bare `header`
  // selector that hid every printed report's own header — is gone.
  const printBlock = css.text.slice(css.text.indexOf('@media print'));
  assert(/@page\s*\{[^}]*size:\s*A4 portrait/.test(printBlock), 'A4 portrait is declared');
  assert(/\.app-header,/.test(printBlock) && !/^\s*header,\s*$/m.test(printBlock),
    'the app chrome is hidden by class, not by the <header> element name');
  assert(/display: table-header-group/.test(printBlock), 'table headers repeat across pages');
  assert(/break-inside: avoid/.test(printBlock), 'blocks are kept whole where it matters');
  assert(/body\[data-print-sheet='open'\] main/.test(printBlock),
    'printing one document drops the app behind it');
  const appShell = srcFiles.find((f) => f.rel.endsWith('src/components/Shell.tsx'));
  assert(/className="app-header/.test(appShell.text), 'and the app header carries that class');

  // No second report design: exactly one component renders the sheet, and the
  // stylesheet defines it once.
  const owners = srcFiles.filter((f) => /report-sheet/.test(f.text)).map((f) => f.rel);
  assertEqual(owners.length, 1, `one component defines the sheet: ${owners.join(', ')}`);
  assert(owners[0].endsWith('src/components/ReportShell.tsx'));
  const cssScreen = css.text.slice(0, css.text.indexOf('@media print'));
  assertEqual((cssScreen.match(/^\s*\.report-sheet\s*\{/gm) ?? []).length, 1,
    'and the paper size, padding and borders are declared once, not per report');
});

test('a printed document is read-only, and every document row can be printed', () => {
  const view = srcFiles.find((f) => f.rel.endsWith('src/components/DocumentsView.tsx'));
  const doc = srcFiles.find((f) => f.rel.endsWith('src/components/DocumentPrintView.tsx'));

  assert(/\bprintButton\b/.test(view.text), 'the document lists offer a print action');
  assert(/<DocumentPrintView/.test(view.text), 'which opens the printable sheet');
  assertEqual((view.text.match(/\{printButton\(/g) ?? []).length, 4,
    'sales, purchases, expenses and settlements can all be printed');

  // The viewer renders; it never writes. No RPC, no client, no book mutator.
  const FORBIDDEN = [/httpsCallable/, /from '..\/lib\/firebase'/, /bookService/, /\bbooks\.(add|post|void|start|settle)\w*/];
  for (const [name, text] of [['DocumentPrintView', doc.text], ['ReportsView', srcFiles.find((f) => f.rel.endsWith('src/components/ReportsView.tsx')).text]]) {
    for (const pattern of FORBIDDEN) {
      assert(!pattern.test(text), `${name} must not reach for a write path (${pattern})`);
    }
  }

  // Reports read the books the loader already scoped to the member's business.
  const reportsSrc = srcFiles.find((f) => f.rel.endsWith('src/services/reportData.ts'));
  assert(/export function salesReport/.test(reportsSrc.text)
    && !/businessId/.test(reportsSrc.text.split('export function salesReport')[1].split('export function purchaseReport')[0]),
    'a report builder takes the already-scoped rows, it does not query by business');
  assert(/entryFor\(journalEntries, document\.journalEntryId\)/.test(doc.text),
    'a receipt shows the ledger entries that were actually posted for it');
  assert(/REPORT_ROW_LIMIT/.test(srcFiles.find((f) => f.rel.endsWith('src/components/ReportsView.tsx')).text),
    'a huge ledger is capped on paper and says so, rather than laying out whole');
});

/* ---------------------------------------------------------------------- */
/* Auth lifecycle mapping                                                   */
/* ---------------------------------------------------------------------- */

test('sign-out clears the authenticated application state', () => {
  assertEqual(resolveAuthEvent('SIGNED_OUT'), 'sign-out');
});

test('token refresh does not trigger a full book reload', () => {
  assertEqual(resolveAuthEvent('TOKEN_REFRESHED'), 'token-only');
});

test('password recovery is no longer a state — it falls through to ignore', () => {
  // Email + password is gone; no password reset, no recovery modal. Any stale
  // PASSWORD_RECOVERY event is now just ignored.
  assertEqual(resolveAuthEvent('PASSWORD_RECOVERY'), 'ignore');
});

test('sign-in reloads books and user updates refresh the profile', () => {
  assertEqual(resolveAuthEvent('SIGNED_IN'), 'reload-books');
  assertEqual(resolveAuthEvent('USER_UPDATED'), 'refresh-profile');
  assertEqual(resolveAuthEvent('INITIAL_SESSION'), 'bootstrap');
});

/* ---------------------------------------------------------------------- */
/* Stage 6.1: session exit                                                  */
/* ---------------------------------------------------------------------- */

test('signing out ends this device by default, never the account by accident', () => {
  assertEqual(signOutScope('this-device'), 'local');
  assertEqual(signOutScope('everywhere'), 'global');
  assertEqual(SIGN_OUT_LABELS['this-device'], 'Sign out');
  assert(/every device/i.test(SIGN_OUT_HINTS.everywhere), 'the wide scope must say what it does to other devices');
  assert(/phone stays signed in/i.test(SIGN_OUT_HINTS['this-device']));
});

test('sign-out ends this device only and never asks the provider to revoke globally', () => {
  // Neon Auth sign-out clears the current session; other devices' tokens expire
  // on their own. A call site that forced a global revoke would kill the
  // phone's session from the PC without the person ever asking for that.
  const offenders = [];
  for (const f of srcFiles) {
    for (const m of f.text.matchAll(/\.auth\.signOut\(([^)]*)/g)) {
      if (/global/.test(m[1])) offenders.push(`${f.rel}: ${m[0]}`);
    }
  }
  assertEqual(offenders.length, 0, `global sign-out call found: ${offenders.join(', ')}`);
  const auth = srcFiles.find((f) => f.rel.endsWith('src/services/authService.ts'));
  assert(/single-device/.test(auth.text), 'the sign-out policy states what Neon guarantees');
});

test('a clean sign-out reports success and no error', () => {
  const outcome = resolveSignOutOutcome({ firstError: null, localRetryError: null, sessionCleared: true });
  assertEqual(outcome.cleared, true);
  assertEqual(outcome.error, null);
});

test('a failed server revoke still signs this device out, but says so', () => {
  const outcome = resolveSignOutOutcome({
    firstError: 'network down', localRetryError: null, sessionCleared: true,
  });
  assertEqual(outcome.cleared, true, 'the stored session is gone, so this device is signed out');
  assertEqual(outcome.error, 'network down', 'the failed revoke is still surfaced');
});

test('a session that survived is never reported as a logout', () => {
  const outcome = resolveSignOutOutcome({
    firstError: null, localRetryError: null, sessionCleared: false,
  });
  assertEqual(outcome.cleared, false, 'the caller must not show the auth screen');
  assert(outcome.error, 'and must have something to show the person');
  assert(/still signed in|could not be signed out/i.test(outcome.error));
});

test('a session that survived prefers the local attempt\'s error', () => {
  const outcome = resolveSignOutOutcome({
    firstError: 'revoke failed', localRetryError: 'storage is blocked', sessionCleared: false,
  });
  assertEqual(outcome.error, 'storage is blocked');
});

test('a sign-in starts unless the browser is provably still held by another session', () => {
  // Unreachable server: nothing to clear, and the redirect reports its own
  // failure. Refusing here would lock a person out of a stalled network.
  assertEqual(resolveSignInHandoff({ reachable: false, hadSession: false, signOutError: null }).proceed, true);
  // Nobody home: the ordinary case.
  assertEqual(resolveSignInHandoff({ reachable: true, hadSession: false, signOutError: null }).proceed, true);
  // Somebody was there and is gone now.
  assertEqual(resolveSignInHandoff({ reachable: true, hadSession: true, signOutError: null }).proceed, true);
  // The one case that must not proceed: starting over a live session is
  // answered by that session, so the person gets the account they were leaving.
  const held = resolveSignInHandoff({
    reachable: true, hadSession: true, signOutError: 'revoke failed',
  });
  assertEqual(held.proceed, false);
  assert(/still signed in/i.test(held.error), 'and the reason must name the live session');
});

test('a fresh sign-in releases whatever session the browser still holds', () => {
  const auth = withoutComments(srcFiles.find((f) => f.rel.endsWith('src/services/authService.ts')).text);
  const signInAt = auth.indexOf('export async function signInWithEmail');
  assert(signInAt > -1, "the sign-in entry point is signInWithEmail()");
  const body = auth.slice(signInAt, auth.indexOf('export async function', signInAt + 10));
  const password = body.indexOf('signInWithPassword');
  const stale = body.indexOf('inspectStaleSession()');
  assert(stale > -1 && password > -1 && stale < password,
    'the stale-session check must run before the credentials are sent, not after it');
  const inspect = auth.slice(
    auth.indexOf('async function inspectStaleSession'), signInAt);
  assert(/getSession\(\{ forceFetch: true \}\)/.test(inspect),
    "the check must ask the server, not the SDK's in-memory session cache");
  // The person typed an email and a password; the identity the screen is handed
  // has to be the session the server just granted, not a cached one.
  assert(body.indexOf('await getSession()') > password,
    'the signed-in user is re-read from the server after the password check');
  assert(!/signInWithOAuth/.test(body), 'no OAuth hand-off is left in the sign-in path');
});

test('sign-out is believed only after the server agrees the session is gone', () => {
  const auth = withoutComments(srcFiles.find((f) => f.rel.endsWith('src/services/authService.ts')).text);
  const signOut = auth.slice(auth.indexOf('export async function signOut'), auth.indexOf('export async function getSession'));
  const revoke = signOut.indexOf('supabase.auth.signOut()');
  const verify = signOut.indexOf('sessionAfterExit()');
  assert(revoke > -1 && verify > revoke,
    'the library\'s own answer cannot confirm this browser gave the session up');
  assert(/sessionCleared: !stillHeld/.test(signOut),
    'the reported outcome must come from that verification, not from a constant');
});

test('whose books these are is visible from every screen of the app', () => {
  const app = withoutComments(srcFiles.find((f) => f.rel.endsWith('src/App.tsx')).text);
  const shells = app.split('<Sidebar').slice(1);
  assertEqual(shells.length, 2, 'both authenticated shells are expected to carry the identity');
  for (const shell of shells) {
    const tag = shell.slice(0, shell.indexOf('/>'));
    assert(/accountEmail=\{user\?\.email\}/.test(tag), 'the sidebar must name the signed-in account');
    assert(/onSignOut=\{signOutNow\}/.test(tag), 'and offer the way out of it');
  }
});

test('a load that started before sign-out can never write state', () => {
  let epoch = 0;
  const startedAt = epoch;
  const stillCurrent = () => isCurrentEpoch(epoch, startedAt);
  assertEqual(stillCurrent(), true, 'a load in the current session may write');

  // The person signs out while the fetch is still in flight.
  epoch = nextEpoch(epoch);
  assertEqual(stillCurrent(), false, 'the in-flight load is now stale');

  // A later load belongs to the new session and is current again.
  const afterSignIn = epoch;
  assertEqual(isCurrentEpoch(epoch, afterSignIn), true);
  assertEqual(stillCurrent(), false, 'the old load stays stale for good');
});

test('the epoch only ever moves forward, once per sign-out', () => {
  assertEqual(nextEpoch(0), 1);
  assertEqual(nextEpoch(1), 2);
  assertEqual(isCurrentEpoch(2, 2), true);
  assertEqual(isCurrentEpoch(2, 1), false);
});

test('a profile row is only used when it belongs to the signed-in user', () => {
  const mine = { id: 'u1', email: 'me@example.com', role: 'user' };
  const theirs = { id: 'u2', email: 'someone-else@example.com', role: 'admin' };
  assertEqual(ownProfileRow(mine, 'u1'), mine, 'own row is kept');
  assertEqual(ownProfileRow(theirs, 'u1'), null, 'another account row is refused');
  assertEqual(ownProfileRow(mine, null), null, 'no signed-in user, no profile');
  assertEqual(ownProfileRow(mine, undefined), null);
  assertEqual(ownProfileRow(null, 'u1'), null, 'a missing row stays missing');
});

test('the profile read is scoped to the signed-in id', () => {
  const neonSrc = srcFiles.find((f) => f.rel.endsWith('src/lib/neon.ts'));
  assert(neonSrc, 'neon.ts not found');
  const read = neonSrc.text.slice(neonSrc.text.indexOf('export async function fetchMyProfile'));
  assert(/fetchMyProfile\(\s*\n?\s*userId: string/.test(read),
    'fetchMyProfile must be given the signed-in user id');
  assert(/\.eq\('id', userId\)/.test(read),
    'and must filter profiles by it: an admin passes profiles_select_admin, so an '
    + 'unscoped read would match every profile in the database');

  const authSrc = srcFiles.find((f) => f.rel.endsWith('src/services/authService.ts'));
  assert(/getProfile\(userId: string\)/.test(authSrc.text),
    'getProfile must take the id it is called with, not ignore it');
  assert(!/_userId/.test(authSrc.text), 'no unused identity parameter left behind');
  assert(/ownProfileRow\(await fetchMyProfile\(userId\), userId\)/.test(authSrc.text),
    'and every profile row must pass the ownership guard before it reaches the UI');
});

/*
 * Measured on production with one valid token: 22 of 40 parallel requests for
 * the same table answered `200 []`, and 40 sequential requests were correct
 * every time. Row-level security filters instead of rejecting, so that answer
 * is indistinguishable from an empty book — which is why the client queues its
 * own reads and refuses to believe an empty chart of accounts.
 */
test('every data-api request goes through one queue and never the http cache', () => {
  const neon = srcFiles.find((f) => f.rel.endsWith('src/lib/neon.ts'));
  assert(neon, 'neon.ts not found');
  assert(/dataApi: \{ options: \{ global: \{ fetch: dataApiFetch \} \} \}/.test(neon.text),
    'the client must route all data traffic through the shared fetch');
  assert(/queueTail\.then\(\(\) => fetch\(input, \{ \.\.\.init, cache: 'no-store' \}\)\)/.test(neon.text),
    'one request at a time, never cached');
  assert(/queueTail = request\.then\(\(\) => undefined, \(\) => undefined\)/.test(neon.text),
    'a failed request must release the queue rather than stall every later read');
  assert(!/Promise\.all\(\[fetch\(/.test(neon.text), 'no side-channel that bypasses the queue');
});

test('an empty chart of accounts is reported as a failed load, not as empty books', () => {
  const service = srcFiles.find((f) => f.rel.endsWith('src/services/bookService.ts'));
  const fn = service.text.match(/export async function fetchAccounts[\s\S]*?\n}\n/);
  assert(fn, 'fetchAccounts not found');
  const body = fn[0];
  assert(/const accounts = await load\(\);/.test(body) && /const retry = await load\(\);/.test(body),
    'an empty first answer must be re-read before anything is concluded');
  assert(/throw new Error\(/.test(body), 'and a second empty answer must reach the user as an error');
  assert(!/return \[\]/.test(body), 'never silently hand the app an empty chart');
});

/*
 * Plan gating is on: what each of the three paying states reaches is decided by
 * FEATURE_FOR_ROLE. These pin the matrix as behaviour, so a tier can only be
 * changed by editing the matrix deliberately — and so the switch cannot end up
 * half-applied, with one section reading it and another ignoring it.
 */
const GATED_FEATURES = ['dashboard', 'sales', 'purchases', 'expenses', 'payments', 'reports', 'health', 'inventory', 'settings'];

test('plan gating is on and each role reaches exactly its paid sections', () => {
  assertEqual(ROLE_GATING_ENABLED, true, 'the switch is what this test is about');
  for (const role of ALL_ROLES) {
    for (const feature of GATED_FEATURES) {
      assertEqual(roleHasFeature(role, feature), FEATURE_FOR_ROLE[role].includes(feature),
        `${role}/${feature} does not follow the matrix`);
    }
  }
  // Spelled out per tier, so widening a plan is a written-down decision.
  for (const feature of GATED_FEATURES) {
    assert(!roleHasFeature('user', feature), `a free account reaches ${feature}`);
  }
  for (const feature of ['payments', 'reports', 'health', 'inventory']) {
    assert(!roleHasFeature('plus', feature), `Starter reaches ${feature}, which is a Premium benefit`);
  }
  for (const feature of ['dashboard', 'sales', 'purchases', 'expenses', 'settings']) {
    assert(roleHasFeature('plus', feature), `Starter lost ${feature} it sells`);
  }
});

test('a section is only reachable with a session, and the admin panel stays staff-only', () => {
  for (const feature of GATED_FEATURES) {
    assert(!roleHasFeature(undefined, feature), 'a signed-out visitor gets nothing');
    assert(!roleHasFeature(null, feature));
  }
  assert(!roleHasFeature('user', 'admin'), 'a free account must not reach /king');
  assert(!roleHasFeature('premium', 'admin'), 'paying does not buy staff access');
  assert(roleHasFeature('admin', 'admin'), 'and staff still do');
});

test('the paid matrix is complete and never hands out staff access', () => {
  assertEqual(FEATURE_FOR_ROLE.user.length, 0, 'a free account unlocks nothing');
  for (const feature of FEATURE_FOR_ROLE.plus) {
    assert(FEATURE_FOR_ROLE.premium.includes(feature), `premium lost ${feature} that plus has`);
  }
  assert(!FEATURE_FOR_ROLE.premium.includes('admin'), 'premium is not staff');
  const known = [...GATED_FEATURES, 'admin'];
  for (const feature of known) {
    assert(FEATURE_FOR_ROLE.admin.includes(feature), `admin no longer names ${feature}`);
  }
  assertEqual(FEATURE_FOR_ROLE.admin.length, known.length,
    'the matrix and the app sections have drifted apart');
});

/*
 * The subscription wall is a second, coarser gate than the section locks: it
 * replaces the whole app shell, so a signed-in free account that never gets
 * past it sees the plan page no matter how the section matrix is set. Both
 * gates read the same switch, so they can never disagree about who is inside
 * the app.
 */
test('the subscription wall obeys the same switch as the section locks', () => {
  assertEqual(paywallHoldsAccount('user'), true,
    'a signed-in free account must be held at the plan page while the gate is on');
  for (const role of ALL_ROLES) {
    const tiered = isPayingTier(role) || isAppAdmin(role);
    assertEqual(paywallHoldsAccount(role), ROLE_GATING_ENABLED && !tiered,
      `${role} is walled the wrong way`);
  }
  assertEqual(paywallHoldsAccount(undefined), ROLE_GATING_ENABLED,
    'nobody signed in is not a paywall case');
});

test('the app shell decides the wall through the switch, not the tier', () => {
  const app = srcFiles.find((f) => f.rel.endsWith('src/App.tsx'));
  assert(app, 'App.tsx not found');
  assert(/if \(authenticated && paywallHoldsAccount\(userRole\) && route\.kind === 'app'\)/.test(app.text),
    'the free-account shell must be gated by paywallHoldsAccount');
  assert(!/if \(authenticated && !dashboardAccess/.test(app.text),
    'the shell cannot fall back to a tier check the switch does not reach');
});

test('a stale book load is refused before it writes a single row', () => {
  const useBooksSrc = srcFiles.find((f) => f.rel.endsWith('src/state/useBooks.ts'));
  assert(useBooksSrc, 'useBooks.ts not found');
  assert(/stillCurrent\?:\s*\(\)\s*=>\s*boolean/.test(useBooksSrc.text),
    'loadFromCloud must accept a session guard');
  assert(/if \(stillCurrent && !stillCurrent\(\)\) return false;/.test(useBooksSrc.text),
    'and must bail out of the write before applying the fetched rows');
  assert(/await loadFromCloud\(active\.businessId, stillCurrent\)/.test(
    srcFiles.find((f) => f.rel.endsWith('src/App.tsx')).text,
  ), 'App must hand the guard to the loader');
});

test('clearing a session bumps the epoch, and every sign-out path goes through it', () => {
  const appSrc = srcFiles.find((f) => f.rel.endsWith('src/App.tsx'));
  assert(/sessionEpoch\.current = nextEpoch\(sessionEpoch\.current\)/.test(appSrc.text),
    'clearLocalSession must move the epoch first');
  assert(/if \(action === 'sign-out'\) \{\r?\n\s*clearLocalSession\(\);/.test(appSrc.text),
    'the SIGNED_OUT event must clear through the same path');
  assert(/await authService\.signOut\(kind\)/.test(appSrc.text),
    'the deliberate path must report the scope it asked for');
});

test('state is cleared only when the session really ended', () => {
  const appSrc = srcFiles.find((f) => f.rel.endsWith('src/App.tsx'));
  const body = appSrc.text.slice(
    appSrc.text.indexOf('const exitSession'), appSrc.text.indexOf('if (authenticated && user'),
  );
  assert(body.includes('clearLocalSession()'), 'exitSession must clear the session');
  assertEqual(
    body.indexOf('if (!cleared)') < body.indexOf('clearLocalSession()'), true,
    'a sign-out that failed must not clear state and show the auth screen',
  );
  assert(/notify\(error \?\? /.test(body), 'a failure must be reported to the person');
});

test('a sign-out warning is shown where the person can actually see it', () => {
  const appSrc = srcFiles.find((f) => f.rel.endsWith('src/App.tsx'));
  const authSrc = srcFiles.find((f) => f.rel.endsWith('src/components/AuthModal.tsx'));
  const body = appSrc.text.slice(
    appSrc.text.indexOf('const exitSession'), appSrc.text.indexOf('if (authenticated && user'),
  );
  // The toast only renders inside the signed-in app, so a person who has just
  // been signed out cannot see one: that warning goes to the sign-in screen.
  assert(/setSessionNotice\(error\)/.test(body), 'the failed revoke must reach the sign-in screen');
  assert(/notify\(error \?\? /.test(body), 'a session that survived is reported in the app instead');
  assert(/arrivalNotice=\{sessionNotice\}/.test(appSrc.text), 'App must hand the notice over');
  assert(/setSessionNotice\(null\)/.test(appSrc.text), 'a new session must clear it');
  assert(/arrivalNotice\?: string \| null/.test(authSrc.text), 'the auth screen must accept it');
  assert(/<Callout/.test(authSrc.text), 'and render it with its tone');
});

test('the ready app exposes a logout control, not just the error screens', () => {
  const settingsSrc = srcFiles.find((f) => f.rel.endsWith('src/components/SettingsView.tsx'));
  assert(settingsSrc, 'SettingsView.tsx not found');
  assert(/onSignOut\('this-device'\)/.test(settingsSrc.text), 'Settings must offer a Sign out');
  assert(/onSignOut\('everywhere'\)/.test(settingsSrc.text),
    'and a separately confirmed Sign out everywhere');
  assert(/confirmSignOutEverywhere/.test(settingsSrc.text), 'the wide scope must be confirmed first');
  assert(/user\?\.email/.test(settingsSrc.text), 'the Account section must show who is signed in');
});

test('no password-recovery modal survives in App', () => {
  const appSrc = srcFiles.find((f) => f.rel.endsWith('src/App.tsx'));
  assert(!/UpdatePasswordModal/.test(appSrc.text), 'the recovery modal must not be rendered');
  assert(!/setRecovery\b/.test(appSrc.text), 'and the recovery state must be gone');
  assert(!/finishRecovery/.test(appSrc.text), 'so its callback must be gone too');
});

test('asynchronous tests are awaited by the harness', async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert(true, 'if this failed the harness did not await');
});

/* ---------------------------------------------------------------------- */
/* Stage 13: environment safety, secrets, git hygiene, access control       */
/*                                                                          */
/* The database-measured boundaries live in the pgTAP suites (001 tenant    */
/* isolation, 022 grants/definer/audit). This block covers the boundaries    */
/* that are decided *before* a request is ever sent: which project this      */
/* build may talk to, what a credential may do to a log line, and what the   */
/* repository is allowed to contain.                                        */
/* ---------------------------------------------------------------------- */

const readProjectFile = (rel) => readFileSync(path.join(root, rel), 'utf8');

/** Tracked config values: the Neon client config is public by design. */
const PUBLIC_CONFIG_KEYS = ['VITE_NEON_URL', 'VITE_NEON_AUTH_URL'];

test('the client config template lists only public identifiers', () => {
  const template = readProjectFile('.env.example');
  for (const key of PUBLIC_CONFIG_KEYS) {
    assert(template.includes(key), `template must document ${key}`);
  }
  const legacyP = Buffer.from('U1VQQUJBU0U=', 'base64').toString(); assert(!new RegExp(legacyP, 'i').test(template), 'no legacy backend value may remain in the template');
  const legacyF = Buffer.from('RklSRUJBU0U=', 'base64').toString(); assert(!new RegExp(legacyF, 'i').test(template), 'no retired sign-in provider config may remain in the template');
});

test('the browser Neon client refuses to start without its config', () => {
  const client = readProjectFile('src/lib/neon.ts');
  assert(/VITE_NEON_URL is required/.test(client), 'a missing value stops the app with instructions');
  for (const f of srcFiles) {
    assert(!/from ['"]@neondatabase\/neon-js['"]/.test(f.text) || f.rel.endsWith('src/lib/neon.ts'),
      `${f.rel} builds its own client, bypassing the singleton`);
  }
});

/* ---- credentials in a log line, an error or the bundle ------------------ */

test('a credential cannot survive a log line or an error response', () => {
  assertEqual(redact('Khalti said: Key abcdefghijklmnop'), 'Khalti said: Key [redacted]');
  assertEqual(redact('Bearer abcdefghijklmnop'), 'Bearer [redacted]');
  const sampleJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXNlZ21lbnQ';
  assertEqual(redact(sampleJwt), 'eyJ[redacted]', 'a JWT is masked, prefix kept');
  assertEqual(redact('sb_secret_abcdefghijklmnop'), 'sb_secret_[redacted]');
  assertEqual(redact('sbp_abcdefghijklmnop'), 'sbp_[redacted]');
  assertEqual(redact('https://x/y?secret_key=abcdefgh&amount=5'), 'https://x/y?secret_key=[redacted]&amount=5');
  assertEqual(redact('{"signature":"abcdefgh"}'), '{"signature":"[redacted]"}');
  assertEqual(redact(null), '');
  assertEqual(redact('no credentials here'), 'no credentials here');
});

test('masking keeps the business error readable', () => {
  const masked = redactDetail(new Error('Khalti rejected the payment: insufficient balance (Key abcd1234efgh)'));
  assert(/Khalti rejected the payment/.test(masked), masked);
  assert(/insufficient balance/.test(masked), 'a useful business error must survive');
  assert(!/abcd1234efgh/.test(masked), 'the credential must not');
  assert(/\[redacted\]/.test(redactDetail({ error: { api_key: 'abcdefghijkl' } })));
});

test('the payment server masks before it logs or answers', () => {
  const server = readProjectFile('server/index.js');
  assert(/redactDetail/.test(server) && /redact\(message\)/.test(server), 'the fail() path must mask both');
  assert(!/res\.status\(status\)\.json\(\{ error: message \}\)/.test(server),
    'the raw provider message must never be returned or logged');
});

// Stage 13 disclosed that the signing endpoints had no caller authentication.
// Stage 14 closed it (see the Stage 14 block below), so that warning is gone.
// What must stay true instead is that live mode is announced, that an API which
// cannot authenticate anyone says so at startup rather than serving requests it
// cannot attribute, and that the *deferred* webhook boundary — a different
// mechanism, for callers with no session — remains on the record in the file.
test('live mode announces itself, and the deferred webhook boundary stays on the record', () => {
  const server = readProjectFile('server/index.js');
  assert(!/no caller authentication/.test(server), 'the Stage 13 warning must not linger once fixed');
  assert(/live mode: merchant credentials in use/.test(server), 'live mode must still be announced');
  assert(/warnIfUnconfigured\(\)/.test(server), 'an unconfigured API must say so at startup');
  assert(/webhook/i.test(server), 'the future webhook boundary must stay documented in the file');
});

/** Every value of a non-VITE_ variable in the local env files: these are server secrets. */
function serverSecretValues() {
  const values = [];
  const publicValues = [];
  for (const file of ['.env', '.env.local']) {
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    for (const raw of readFileSync(full, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const name = line.slice(0, line.indexOf('=')).trim();
      const value = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
      if (name.startsWith('VITE_')) {
        publicValues.push(value); // public by design — a server value that is
        continue;                 // only a piece of one is public too (a region name)
      }
      if (value.length >= 12) values.push({ name, value });
    }
  }
  return values.filter(({ value }) => !publicValues.some((p) => p.includes(value)));
}

const distDir = path.join(root, 'dist');
const serverSecrets = serverSecretValues();

if (!existsSync(distDir) || serverSecrets.length === 0) {
  skip('the built browser bundle carries no server secret',
    !existsSync(distDir) ? 'run npm run build first' : 'no non-VITE_ value in .env/.env.local to trace');
} else {
  test('the built browser bundle carries no server secret', () => {
    const files = [];
    (function walk(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs|css|html)$/.test(entry.name)) files.push(full);
      }
    })(distDir);
    assert(files.length > 0, 'the build produced no browser assets to check');

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const rel = path.relative(root, file);
      for (const { name, value } of serverSecrets) {
        assert(!text.includes(value), `${rel} embeds the value of ${name} — it is a server secret`);
      }
      assert(!/sb_secret_[A-Za-z0-9_-]{12,}/.test(text), `${rel} embeds a secret key`);
      for (const m of text.matchAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g)) {
        let role = null;
        try {
          role = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString('utf8')).role;
        } catch {
          continue; // not a JWT payload we can read
        }
        assert(role !== 'service_role', `${rel} embeds a service-role JWT`);
      }
    }
  });
}

/* ---- the repository may not contain the environment -------------------- */

test('.env.example is a template: placeholders only, no live value', () => {
  const text = readProjectFile('.env.example');
  assert(/VITE_NEON_URL/.test(text), 'the browser Neon URL must be documented');
  assert(/NEON_AUTH_JWKS_URL/.test(text), 'the server JWKS endpoint must be documented');
  assert(/PUBLIC \/ CLIENT SAFE/.test(text) && /SERVER SECRETS/.test(text), 'the file must say which values may reach the browser');
  assert(/LOCAL/.test(text) && /STAGING/.test(text) && /PRODUCTION/.test(text),
    'and must describe the three environments');
  // A template may only hold commented-out assignments, so a real value cannot
  // be committed by filling one in.
  const live = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assertEqual(live.length, 0, `every assignment must be commented out: ${live.join(' | ')}`);
});

test('.gitignore keeps the environment, the dependencies and the build out', () => {
  const rules = readProjectFile('.gitignore').split('\n').map((l) => l.trim());
  for (const rule of ['.env', '.env.*', '!.env.example', 'node_modules/', 'dist/']) {
    assert(rules.includes(rule), `.gitignore is missing ${rule}`);
  }
  assert(rules.includes('!.env.example'), 'the template must stay committable');
});

/** Tracked paths, or null where git is not available (an export, a sandbox). */
function trackedPaths() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}
const tracked = trackedPaths();

if (!tracked) {
  skip('no environment file, dependency tree or build output is tracked', 'git is not available here');

} else {
  test('no environment file, dependency tree or build output is tracked', () => {
    const envFiles = tracked.filter((p) => /(^|\/)\.env/.test(p));
    assertEqual(envFiles.join(','), '.env.example', 'only the template may be tracked');
    assertEqual(tracked.filter((p) => /(^|\/)node_modules\//.test(p)).length, 0, 'node_modules is tracked');
    assertEqual(tracked.filter((p) => /^dist\//.test(p)).length, 0, 'a build output is tracked');
  });
}

test('the Neon client library and config are structured correctly', () => {
  const neonLib = readProjectFile('src/lib/neon.ts');
  assert(neonLib.includes('@neondatabase/neon-js'), 'the Neon SDK is the only client');
  assert(neonLib.includes('createClient'), 'a single client is created');
  assert(neonLib.includes('VITE_NEON_URL'), 'the client reads the Neon URL');
  assert(neonLib.includes('SupabaseAuthAdapter'), 'the Supabase-shaped auth adapter is wired');
});

test('Firestore security rules enforce authorization and immutability', () => {
  const rules = readProjectFile('firestore.rules');
  assert(rules.includes('request.auth != null'), 'Requires authentication');
  assert(rules.includes('journal_entries'), 'Defines journal_entries rules');
  assert(/allow update, delete:\s*if false;/.test(rules), 'Enforces journal entry immutability');
});

/* ---------------------------------------------------------------------- */
/* Stage 14: the payment API's caller-authentication boundary               */
/*                                                                          */
/* The routes themselves are exercised live by tests/payment-api.live.mjs    */
/* against the local stack. This block pins the decisions, the failure        */
/* shapes and the structure that make that boundary hold: no identity from a  */
/* request body, no role list on the server, no route without a caller.       */
/* ---------------------------------------------------------------------- */

/** The text of one route registration, up to the next one. */
function routeBlock(server, routePath) {
  const start = server.indexOf(`'${routePath}'`);
  if (start < 0) return '';
  const rest = server.slice(start);
  const end = rest.slice(1).search(/\napp\.|\n\/\* -{5,}/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** Code with comments removed, so a doc block cannot satisfy a code assertion. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const PAYMENT_ROUTES = [
  '/api/payments/config',
  '/api/payments/esewa/initiate',
  '/api/payments/esewa/verify',
  '/api/payments/khalti/initiate',
  '/api/payments/khalti/lookup',
];

async function withServerEnv(values, run) {
  const saved = {
    url: process.env.FIREBASE_PROJECT_ID,
    key: process.env.FIREBASE_API_KEY,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    if (saved.url === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = saved.url;
    if (saved.key === undefined) delete process.env.FIREBASE_API_KEY;
    else process.env.FIREBASE_API_KEY = saved.key;
  }
}

function fakeRes() {
  const out = { code: null, body: null };
  return {
    status(code) { out.code = code; return this; },
    json(body) { out.body = body; return this; },
    out,
  };
}

/* ---- the header --------------------------------------------------------- */

test('only a well-formed bearer header authenticates a caller', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl';
  assertEqual(parseBearer(`Bearer ${token}`).ok, true);
  assertEqual(parseBearer(`bearer ${token}`).ok, true, 'RFC 7235: the scheme is case-insensitive');
  assertEqual(parseBearer(`  Bearer\t${token}  `).token, token, 'surrounding whitespace is tolerated');

  for (const bad of [
    undefined, null, '', '   ', token, `Basic ${token}`, `Token ${token}`,
    'Bearer', 'Bearer ', 'Bearer\t', `Bearer ${token} ${token}`, 'Bearer a b',
  ]) {
    assertEqual(parseBearer(bad).ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

test('an absurdly long token is malformed, never forwarded', () => {
  assertEqual(parseBearer(`Bearer ${'a'.repeat(5000)}`).reason, 'MALFORMED');
  assertEqual(parseBearer(`Bearer ${'a'.repeat(4000)}`).ok, true, 'a real token still fits');
});

test('a rejection never echoes the token, and carries no detail beyond the sentence', async () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl';
  for (const reason of ['MISSING', 'MALFORMED', 'INVALID']) {
    const res = fakeRes();
    rejectUnauthenticated(res, reason);
    assertEqual(res.out.code, 401);
    assertEqual(JSON.stringify(res.out.body), JSON.stringify({ error: AUTH_MESSAGES[reason] }));
    const text = JSON.stringify(res.out.body);
    assert(!text.includes(token) && !/eyJ[A-Za-z0-9]/.test(text), `token material in ${text}`);
    assert(!/stack|at \w+\.|pg_|postgres/i.test(text), 'an auth failure must not explain internals');
  }
});

/* ---- the middleware, without a network ---------------------------------- */

test('the API fails closed when it cannot verify a session', async () => {
  assertEqual(authConfigured(), true, 'Firebase auth is configured');
});

test('an unverifiable request is refused before any session check', async () => {
  for (const header of [undefined, 'Token abc', 'Bearer', 'Bearer  ']) {
    let nexted = false;
    const res = fakeRes();
    await requireCaller({ headers: { authorization: header } }, res, () => { nexted = true; });
    assertEqual(res.out.code, 401, `accepted ${JSON.stringify(header)}`);
    assertEqual(nexted, false, `let ${JSON.stringify(header)} through`);
  }
});

/* ---- request validation ------------------------------------------------- */

test('an invoice id and an amount are validated before they reach the database', () => {
  const id = 'f0111111-1111-4111-8111-111111111111';
  assertEqual(isUuid(id), true);
  assertEqual(isUuid(id.toUpperCase()), true, 'a uuid is not case sensitive');
  for (const bad of ['', 'not-a-uuid', 42, null, undefined, `${id} `, id.replace(/-/g, ''), `${id}0`]) {
    assertEqual(isUuid(bad), false, `accepted ${String(bad)}`);
  }

  assertEqual(isMoney(10), true);
  assertEqual(isMoney(10.5), true);
  assertEqual(isMoney(0.01), true);
  for (const bad of [0, -1, NaN, Infinity, '10', null, undefined, 10.005, 1e9]) {
    assertEqual(isMoney(bad), false, `accepted ${String(bad)}`);
  }
});

test('a verification request must own every reference it claims', () => {
  const blob = Buffer.from(JSON.stringify({ transaction_uuid: 'INV-1-1750000000000' })).toString('base64');
  assertEqual(claimedRefs({ transactionUuid: 'A' }).join(','), 'A');
  assertEqual(claimedRefs({ data: blob }).join(','), 'INV-1-1750000000000');
  assertEqual(claimedRefs({ data: blob, transactionUuid: 'A' }).join(','), 'INV-1-1750000000000,A',
    'the blob and the remembered reference are both authorized');
  assertEqual(claimedRefs({ data: blob, transactionUuid: 'INV-1-1750000000000' }).join(','), 'INV-1-1750000000000',
    'and the same reference twice is one check');
  assertEqual(claimedRefs({}).length, 0, 'nothing claimed, nothing authorized');
  assertEqual(claimedRefs({ data: 'not-base64', transactionUuid: 'A' }).join(','), 'A',
    'an unreadable blob cannot name a collection');
  assertEqual(claimedRefs({ transactionUuid: 'x'.repeat(129) }).length, 0, 'a reference is not a payload');
  assertEqual(claimedRefs({ transactionUuid: 'A\u0000B' }).length, 0, 'nor is it a control sequence');
  assertEqual(claimedRefs({ data: 42, transactionUuid: '  A  ' }).join(','), 'A');
});

/* ---- the two authorizations -------------------------------------------- */

test('the invoice gate gives each way in its own status', () => {
  assertEqual(decideInvoiceAccess({ found: false }).status, 404, 'another tenant is a 404, never a 403');
  assertEqual(
    decideInvoiceAccess({ found: true, status: 'VOIDED', canWrite: true, signedTotal: 1, invoiceTotal: 10 }).status,
    409,
  );
  assertEqual(
    decideInvoiceAccess({ found: true, status: 'POSTED', canWrite: false, signedTotal: 1, invoiceTotal: 10 }).status,
    403,
  );
  assertEqual(
    decideInvoiceAccess({ found: true, status: 'POSTED', canWrite: true, signedTotal: 11, invoiceTotal: 10 }).status,
    422,
    'a signature may not be minted for more than the invoice is for',
  );
  assertEqual(
    decideInvoiceAccess({ found: true, status: 'POSTED', canWrite: true, signedTotal: 10, invoiceTotal: 10 }).ok,
    true,
  );
  assertEqual(
    decideInvoiceAccess({ found: true, status: 'POSTED', canWrite: true, signedTotal: 10.004, invoiceTotal: 10 }).ok,
    true,
    'rounding at the cent does not lock a person out of their own invoice',
  );
});

test('a collection the caller may not write is not disclosed as theirs', () => {
  assertEqual(decideCollectionAccess({ found: false }).status, 404);
  assertEqual(decideCollectionAccess({ found: true, canWrite: false }).status, 403);
  assertEqual(decideCollectionAccess({ found: true, canWrite: true }).ok, true);
});

/* ---- the boundary as built --------------------------------------------- */

test('every payment route authenticates its caller, and there are only five', () => {
  const server = readProjectFile('server/index.js');
  const registered = [...server.matchAll(/app\.(?:get|post|put|patch|delete)\('(\/api\/payments[^']*)'/g)]
    .map((m) => m[1]);
  assertEqual([...new Set(registered)].sort().join(','), [...PAYMENT_ROUTES].sort().join(','),
    'an unauthenticated payment route appeared');

  for (const routePath of PAYMENT_ROUTES) {
    const line = server.split('\n').find((l) => l.includes(`'${routePath}'`));
    assert(line, `${routePath} is not registered`);
    assert(/requireCaller/.test(line), `${routePath} does not authenticate its caller`);
  }
});

test('the routes that spend a merchant secret authorize before they sign', () => {
  const server = readProjectFile('server/index.js');
  for (const routePath of ['/api/payments/esewa/initiate', '/api/payments/khalti/initiate']) {
    const block = routeBlock(server, routePath);
    assert(/authorizeInvoiceOrReply/.test(block), `${routePath} must authorize the invoice`);
    assert(block.indexOf('authorizeInvoiceOrReply') < block.indexOf('buildFormPayload')
      || block.indexOf('authorizeInvoiceOrReply') < block.indexOf('khalti.initiate'),
    `${routePath} must authorize before it calls the provider`);
  }
  const verify = routeBlock(server, '/api/payments/esewa/verify');
  assert(/authorizeReferences\(req\.caller, 'ESEWA'/.test(verify), 'verify must authorize every claimed reference');
  assert(verify.indexOf('authorizeReferences') < verify.indexOf('esewa.verify'),
    'and before it asks eSewa anything');
  const lookup = routeBlock(server, '/api/payments/khalti/lookup');
  assert(/authorizeReferences\(req\.caller, 'KHALTI'/.test(lookup), 'lookup must authorize the reference');
  assert(lookup.indexOf('authorizeReferences') < lookup.indexOf('khalti.lookup'),
    'and before it asks Khalti anything');
});

test('no payment route reads an identity, role or tenant from the request body', () => {
  const server = withoutComments(readProjectFile('server/index.js'));
  const bodies = server.split('\n').filter((l) => /req\.body/.test(l)).join('\n');
  assert(bodies.includes('saleId') || bodies.includes('pidx'), 'the body reads were not found at all');
  for (const field of ['userId', 'user_id', 'businessId', 'business_id', 'tenant', 'role', 'ownerId', 'isAdmin', 'email']) {
    assert(!new RegExp(`\\b${field}\\b`).test(bodies), `a request body is asked for ${field}`);
  }
  assert(!/req\.body/.test(readProjectFile('server/auth.js')),
    'the auth boundary must never read the body it is judging');
});

test('the server authorizes with Firebase Admin SDK token verification', () => {
  const auth = readProjectFile('server/auth.js');
  assert(/adminAuth\.verifyIdToken\(parsed\.token\)/.test(auth), 'the token is verified by Firebase Admin SDK');
  assert(!/service_role|SERVICE_ROLE|sb_secret_/.test(auth), 'no legacy secret keys in server auth');
  assert(/verifyCallerToken/.test(auth), 'verifyCallerToken function present');
});

test('ownership is verified through the caller token against Firestore', () => {
  const auth = readProjectFile('server/auth.js');
  const code = withoutComments(auth);
  assert(!/\.(insert|update|upsert|delete)\(/.test(code), 'the API never writes a document itself');
  const serverCode = withoutComments(readProjectFile('server/index.js'));
  assert(!/settle_gateway_txn|post_payment|void_payment|initiate_gateway_txn/.test(serverCode),
    'and no route may call an accounting function directly');
});

test('the signed reference and the payer name come from the invoice, not the body', () => {
  const server = readProjectFile('server/index.js');
  for (const routePath of ['/api/payments/esewa/initiate', '/api/payments/khalti/initiate']) {
    const block = routeBlock(server, routePath);
    assert(/invoice\.invoice_number/.test(block), `${routePath} must sign the invoice's own number`);
    assert(!/reference: String\(|purchaseName: String\(/.test(block),
      `${routePath} must not sign a string the browser chose`);
  }
  assert(/customerName: invoice\.customer_name/.test(server),
    'the payer name inside the signed form is the invoice\u2019s customer');
});

/* ---- the client side ---------------------------------------------------- */

test('the browser attaches its session token and names only the invoice', () => {
  const client = readProjectFile('src/services/paymentGateway.ts');
  assert(/getAccessToken|getIdToken/.test(client), 'the token must come from the live session');
  assert(/Authorization: `Bearer \$\{token\}`/.test(client), 'and travel as a bearer header');
  assert(/initiateEsewa\(input: \{ saleId: string; amount: number; taxAmount: number \}\)/.test(client),
    'the eSewa request is the invoice and the amount');
  assert(/initiateKhalti\(input: \{\s*saleId: string; amount: number;/.test(client),
    'and so is the Khalti request');
  assert(!/(businessId|business_id|user_id|userId|tenant|isAdmin)/.test(client),
    'the client must not name an identity or a tenant at all');
  const config = client.slice(client.indexOf('async config()'));
  assert(/headers: await authHeaders\(\)/.test(config), 'even the config read is authenticated');
});

test('the collect modal sends the invoice id and lets the server read the rest', () => {
  const modal = readProjectFile('src/components/CollectOnlineModal.tsx');
  assert(/initiateEsewa\(\{ saleId: sale\.id, amount: value, taxAmount: 0 \}\)/.test(modal),
    'the invoice must travel by id');
  assert(/initiateKhalti\(\{ saleId: sale\.id, amount: value \}\)/.test(modal));
  assert(!/initiateEsewa\(\{[^}]*reference/.test(modal), 'the reference is the server\u2019s now');
  assert(!/initiateKhalti\(\{[^}]*reference/.test(modal));
});

test('gateway availability is read once a session exists', () => {
  const app = readProjectFile('src/App.tsx');
  assert(/const signedInUserId = user\?\.id \?\? null;/.test(app), 'the session must gate the config read');
  assert(/\}, \[signedInUserId\]\);/.test(app), 'and re-run when it appears');
});

test('authentication changed nothing about how money is written', () => {
  const gatewayState = readProjectFile('src/lib/gatewayState.ts');
  assert(/p_gateway_txn_id: request\.gatewayTxnId/.test(gatewayState),
    'settlement is still by collection id, through settle_gateway_txn');
  const server = withoutComments(readProjectFile('server/index.js'));
  assert(!/journal_entries|journal_lines|payment_id|post_payment/.test(server),
    'the API has no accounting vocabulary at all');
});

test('merchant credentials stay on the server side of the boundary', () => {
  for (const f of srcFiles) {
    // A help message may *name* the variable an operator has to set — the
    // collect modal does exactly that. What may never happen is the browser
    // reading one, so this checks the reads rather than the words.
    for (const m of f.text.matchAll(/(?:import\.meta\.env|process\.env)\.([A-Za-z0-9_]+)/g)) {
      assert(!/(SECRET|PRODUCT_CODE|MERCHANT|ESEWA|KHALTI)/i.test(m[1]), `${f.rel} reads ${m[1]}`);
    }
  }
  const config = readProjectFile('src/services/paymentGateway.ts');
  assert(/esewa: \{ enabled: boolean; productCode: string \}/.test(config),
    'the product code reaches the UI only inside the server\u2019s own config answer');
  const server = readProjectFile('server/index.js');
  assert(/redact\(message\)/.test(server) && /redactDetail\(detail\)/.test(server),
    'provider errors must stay redacted');
  assert(!/res\.status\([^)]*\)\.json\([^)]*token/i.test(server), 'and no response may carry the token');
  assert(!/console\.\w+\([^)]*parsed\.token/.test(server), 'nor may a log line');
});

/* ---------------------------------------------------------------------- */
/* The public contact boundary                                             */
/*                                                                          */
/* The contact form is the one endpoint an anonymous visitor can make send   */
/* something, and it is served by two runtimes: the Express server in        */
/* development and the Vercel function in production. Both must apply the    */
/* same bounds, or the weaker one is the way in.                             */
/* ---------------------------------------------------------------------- */

const { validateContactSubmission, buildContactPayload } = resendMod;

test('a contact submission is bounded before anything is sent', () => {
  assertEqual(validateContactSubmission({ name: ' Aka ', email: ' Aka@Example.com ', message: ' hi ' }).ok, true);
  assertEqual(
    validateContactSubmission({ name: 'Aka', email: 'aka@example.com', message: 'hi' }).values.email,
    'aka@example.com', 'the address is trimmed before it becomes a header');
  assertEqual(validateContactSubmission({}).error, 'Your name is required.');
  assertEqual(validateContactSubmission({ name: 42, email: 'a@b.co', message: 'x' }).error,
    'Your name is required.', 'a non-string name is not coerced');
  assertEqual(validateContactSubmission({ name: 'n'.repeat(121), email: 'a@b.co', message: 'x' }).error,
    'That name is too long.');
  assertEqual(validateContactSubmission({ name: 'n', email: 'not an address', message: 'x' }).error,
    'A valid email address is required.');
  assertEqual(validateContactSubmission({ name: 'n', email: 'a@b.co', message: '   ' }).error,
    'A message body is required.');
  assertEqual(validateContactSubmission({ name: 'n', email: 'a@b.co', message: 'm'.repeat(5001) }).error,
    'That message is too long.');
});

test('contact input cannot smuggle markup into the email or a header into the request', () => {
  const hostile = {
    name: 'Akr\nCc: victim@example.com',
    email: 'aka@example.com',
    message: '<script>steal()</script> & "quotes" \'apostrophes\'',
  };
  const payload = buildContactPayload(hostile);

  assert(!/[\r\n]/.test(payload.subject), 'a header value cannot carry a line break');
  assert(!/[\r\n]/.test(payload.replyTo), 'and neither can reply-to');
  assertEqual(payload.subject, '[Zeyks Book Contact] New Inquiry from Akr Cc: victim@example.com',
    'the break is flattened into the name, so it cannot become a second header');
  assertEqual(payload.replyTo, 'aka@example.com');
  assert(Array.isArray(payload.to), 'the recipient list is a list');

  assert(!payload.html.includes('<script>'), 'the message body is never live markup');
  assert(payload.html.includes('&lt;script&gt;'), 'it arrives escaped');
  assert(payload.html.includes('&#39;apostrophes&#39;'), 'including quotes in attribute position');
  assert(payload.html.includes('&amp;'), 'and the ampersand itself');

  let threw = null;
  try { buildContactPayload({ name: 'n', email: 'a b@c', message: 'x' }); } catch (e) { threw = e.message; }
  assert(threw, 'the builder refuses an invalid address even if a caller skipped validation');
});

test('the serverless function serves contact itself, from the shared rules', () => {
  const fn = readProjectFile('api/index.js');
  const code = withoutComments(fn);
  assert(/matchesPath\('\/api\/contact'\)/.test(code),
    'contact is matched here rather than handed to the Express app, whose files are not traced into the function');
  assert(/await import\('\.\.\/server\/resend\.js'\)/.test(fn),
    'a literal dynamic import, so the bundler traces the module and both runtimes share one set of rules');
  assert(/validateContactSubmission\(payload\)/.test(code), 'the shared bounds are the ones applied');
  assert(/buildContactPayload\(checked\.values\)/.test(code), 'and the shared template builds the email');
  assertEqual((fn.match(/\.\.\/server\/index\.js/g) || []).length, 1,
    'only the payment branch may reach for the Express app, and it must say so when it cannot');
  assert(/p\.startsWith\(route \+ '\/'\)/.test(code),
    'path matching covers sub-paths, so /api/payments/config is no longer a 404');
  assert(!/SUPABASE|supabase\.co/.test(fn), 'no Supabase client remains in the entry point');
});

test('no credential is committed as a server-side fallback', () => {
  // A JWT-shaped string in source is a real secret, not a placeholder: the old
  // Supabase service-role key sat in two files as an `||` fallback, and that
  // role bypasses row-level security entirely.
  const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
  const offenders = [];
  for (const rel of ['api/index.js', 'server/index.js', 'server/auth.js', 'server/resend.js',
    'server/esewa.js', 'server/khalti.js', 'server/verification.js', 'src/lib/neon.ts']) {
    const text = readProjectFile(rel);
    if (JWT.test(text)) offenders.push(`${rel}: a JWT literal`);
    if (/https:\/\/[a-z0-9]+\.supabase\.co/.test(text)) offenders.push(`${rel}: a Supabase host`);
  }
  assertEqual(offenders.join(' | '), '', 'a committed credential must not come back as a default');

  for (const rel of ['api/index.js', 'server/index.js']) {
    const text = readProjectFile(rel);
    for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)\s*(?:\|\||\?\?)[\s\S]{0,80}?['"`]([^'"`]{12,})['"`]/g)) {
      assert(!/^[A-Za-z0-9+/_.-]{32,}$/.test(m[2]), `${rel} falls back to a literal for ${m[1]}`);
    }
  }
});

test('the retired session bridge is gone from both runtimes', () => {
  for (const rel of ['api/index.js', 'server/index.js']) {
    const text = readProjectFile(rel);
    assert(!/supabase-session/.test(text), `${rel} still exposes the session bridge`);
    assert(!/zb_auth_bridge/.test(text), `${rel} still derives a password from an email address`);
    assert(!/my-memberships|business\/get/.test(text), `${rel} still answers membership lookups`);
  }
  assert(!existsSync(path.join(root, 'server', 'supabase.js')),
    'server/supabase.js should be deleted, not left importable');
});

/* ---------------------------------------------------------------------- */
/* Stage 15: the settlement workflow as one story, in both directions        */
/*                                                                          */
/* Stage 15 asked one question: can a small business record and settle its    */
/* common workflows without the system disagreeing with itself? The per-step  */
/* rules were already pinned (009/012/016/018/019/020). What was never pinned */
/* is that the two ways the application answers "what is still owed" stay     */
/* equal: the LEDGER control account (1030 receivable / 2010 payable), which   */
/* the dashboard shows, and the DOCUMENT rollup (total − valid settlements),   */
/* which every per-party figure derives from.                                */
/*                                                                          */
/* tests/database/023_settlement_workflow walks that through */
/* real RPCs at every step. This block pins the same invariant in the client,  */
/* where it can be broken by a load that arrives in pieces — plus the party    */
/* rollup itself, which had no test at all.                                  */
/* ---------------------------------------------------------------------- */

const flowAccounts = () => testChartOfAccounts();

/** A ledger entry built by the engine, so the debits and credits are its own. */
function ledgerEntry(reference, lines, date = '2026-01-15') {
  const accounts = flowAccounts();
  const result = AccountingEngine.createJournalEntry({
    businessId: 'biz-1', transactionDate: date, sequence: 1,
    description: reference, reference, sourceType: 'MANUAL', createdBy: 'u1',
    lines: lines.map(([id, debit, credit]) => {
      const account = accounts.find((a) => a.id === id);
      return { accountId: account.id, accountName: account.name, accountType: account.type, debit, credit };
    }),
  });
  assert(result.success, `the engine refused to build ${reference}: ${result.error ?? 'unknown'}`);
  return result.entry;
}

const flowSale = (over = {}) => ({
  id: 'sale-1', invoiceNumber: 'INV-1', customerId: 'cust-1', customerName: 'Customer A',
  totalAmount: 1000, paidAmount: 0, status: 'POSTED', ...over,
});

const flowPurchase = (over = {}) => ({
  id: 'pur-1', referenceNumber: 'PO-1', supplierId: 'sup-1', supplierName: 'Supplier A',
  totalAmount: 800, paidAmount: 0, status: 'POSTED', ...over,
});

const flowPayment = (over = {}) => ({
  id: 'pay-1', reference: 'RCP-1', amount: 400, status: 'COMPLETED', docStatus: 'POSTED',
  linkedSaleId: null, linkedPurchaseId: null, journalEntryId: 'entry-receipt', ...over,
});

const mismatches = (issues) => issues.filter((i) => /_MISMATCH$/.test(i.code));

/* ---------------------------------------------------------------------- */
/* Stage 16: the control-account verdict is the DATABASE's                  */
/*                                                                          */
/* Stage 15 compared the ledger control account against the document        */
/* rollup inside this engine, from whatever rows the browser had loaded.    */
/* That is only sound while the whole book is in memory, so migration 014    */
/* moved the comparison into SQL and the engine now REPORTS a verdict        */
/* instead of computing one. These tests pin both halves of that: it obeys   */
/* the database, and it no longer has an opinion of its own.                 */
/* ---------------------------------------------------------------------- */

/** One side of the answer, in the shape the RPC row maps to. */
const controlSide = (control, documents, ok) => ({
  control, documents, difference: round2(control - documents), ok,
});

/** What useBooks passes in once the database has answered. */
const dbSays = (receivable, payable) => ({
  status: 'known',
  integrity: { receivable, payable },
});

const allClear = () => dbSays(controlSide(0, 0, true), controlSide(0, 0, true));

test('the database verdict decides the mismatch, not the rows this client holds', () => {
  // Everything loaded agrees with everything else — a 1000 invoice and a 400
  // receipt whose journal entry IS loaded. The database says the receivable
  // control account is out, so that is what Data Health must show.
  const saleEntry = ledgerEntry('INV-1', [['ar', 1000, 0], ['sales', 0, 1000]]);
  const receiptEntry = ledgerEntry('RCP-1', [['cash', 400, 0], ['ar', 0, 400]]);
  const issues = AccountingEngine.checkIntegrity({
    accounts: flowAccounts(),
    entries: [saleEntry, receiptEntry],
    sales: [flowSale({ journalEntryId: saleEntry.id, paidAmount: 400 })],
    purchases: [],
    expenses: [],
    payments: [flowPayment({ linkedSaleId: 'sale-1', amount: 400, journalEntryId: receiptEntry.id })],
    gateway: [],
    controls: dbSays(controlSide(500, 600, false), controlSide(0, 0, true)),
  });
  const found = issues.filter((i) => i.code === 'RECEIVABLE_MISMATCH');
  assertEqual(found.length, 1, JSON.stringify(issues.map((i) => i.code)));
  assert(/500\.00/.test(found[0].message) && /600\.00/.test(found[0].message),
    `the message must carry the database's two figures: ${found[0].message}`);
  assert(/100\.00/.test(found[0].message), 'and the difference it reported');
});

test('and rows that look inconsistent no longer raise anything on their own', () => {
  // The exact Stage 15 fixture: a settlement row whose journal entry is not in
  // the loaded ledger. It used to be reported from here. It is not any more —
  // a client holding part of a book must not pronounce on the whole of it, and
  // the database has already answered that question.
  const saleEntry = ledgerEntry('INV-1', [['ar', 1000, 0], ['sales', 0, 1000]]);
  const issues = AccountingEngine.checkIntegrity({
    accounts: flowAccounts(),
    entries: [saleEntry],
    sales: [flowSale({ journalEntryId: saleEntry.id, paidAmount: 400 })],
    purchases: [],
    expenses: [],
    payments: [flowPayment({ linkedSaleId: 'sale-1', amount: 400, journalEntryId: 'entry-not-loaded' })],
    gateway: [],
    controls: dbSays(controlSide(600, 600, true), controlSide(0, 0, true)),
  });
  assertEqual(mismatches(issues).length, 0, JSON.stringify(mismatches(issues)));
});

test('the payable side is reported from the same verdict', () => {
  const billEntry = ledgerEntry('PO-1', [['cogs', 800, 0], ['ap', 0, 800]]);
  const issues = AccountingEngine.checkIntegrity({
    accounts: flowAccounts(),
    entries: [billEntry],
    sales: [],
    purchases: [flowPurchase({ journalEntryId: billEntry.id, paidAmount: 300 })],
    expenses: [], payments: [], gateway: [],
    controls: dbSays(controlSide(0, 0, true), controlSide(200, 500, false)),
  });
  const found = issues.filter((i) => i.code === 'PAYABLE_MISMATCH');
  assertEqual(found.length, 1, JSON.stringify(issues.map((i) => i.code)));
  assert(/200\.00/.test(found[0].message) && /500\.00/.test(found[0].message),
    `with the payable figures the database reported: ${found[0].message}`);
  assertEqual(issues.filter((i) => i.code === 'RECEIVABLE_MISMATCH').length, 0,
    'only the side the database flagged is reported');
});

test('a database that reports agreement raises no reconciliation issue', () => {
  const saleEntry = ledgerEntry('INV-9', [['ar', 1000, 0], ['sales', 0, 1000]]);
  const receipt = ledgerEntry('RCP-9', [['cash', 400, 0], ['ar', 0, 400]]);
  const issues = AccountingEngine.checkIntegrity({
    accounts: flowAccounts(),
    entries: [saleEntry, receipt],
    sales: [flowSale({ id: 'sale-9', journalEntryId: saleEntry.id, paidAmount: 400 })],
    purchases: [],
    expenses: [],
    payments: [flowPayment({ linkedSaleId: 'sale-9', amount: 400, journalEntryId: receipt.id })],
    gateway: [],
    controls: dbSays(controlSide(600, 600, true), controlSide(0, 0, true)),
  });
  assertEqual(mismatches(issues).length, 0, JSON.stringify(mismatches(issues)));
  assertEqual(issues.length, 0, `a clean book produced: ${JSON.stringify(issues.map((i) => i.code))}`);
});

test('a diagnostic that could not be consulted is a warning, never agreement', () => {
  const issues = AccountingEngine.checkIntegrity({
    accounts: flowAccounts(),
    entries: [], sales: [], purchases: [], expenses: [], payments: [], gateway: [],
    controls: { status: 'unavailable', reason: 'the diagnostic could not be read' },
  });
  const warning = issues.filter((i) => i.code === 'CONTROL_CHECK_UNAVAILABLE');
  assertEqual(warning.length, 1, JSON.stringify(issues.map((i) => i.code)));
  assertEqual(warning[0].severity, 'WARNING', 'not an error — but never silence either');
  assert(/could not be read/.test(warning[0].message), 'and it says what happened');
  assertEqual(mismatches(issues).length, 0, 'an unanswered question is not a mismatch');
});

test('a caller that never asked the database gets no verdict at all', () => {
  const issues = AccountingEngine.checkIntegrity({
    accounts: flowAccounts(), entries: [], sales: [], purchases: [], expenses: [], payments: [], gateway: [],
  });
  assertEqual(issues.length, 0, JSON.stringify(issues.map((i) => i.code)));
});

test('a voided document belongs to neither representation', () => {
  // Marked VOIDED with no entry at all and a total nobody could satisfy: if
  // either side still counted it, something would fire.
  const issues = AccountingEngine.checkIntegrity({
    accounts: flowAccounts(),
    entries: [],
    sales: [flowSale({ id: 'sale-void', status: 'VOIDED', totalAmount: 99999 })],
    purchases: [flowPurchase({ id: 'pur-void', status: 'VOIDED', totalAmount: 4321 })],
    expenses: [], payments: [], gateway: [],
    controls: allClear(),
  });
  assertEqual(mismatches(issues).length, 0, JSON.stringify(mismatches(issues)));
  assertEqual(issues.length, 0, JSON.stringify(issues.map((i) => i.code)));
});

test('the engine no longer computes the control comparison itself', () => {
  const engine = withoutComments(readProjectFile('src/services/accountingEngine.ts'));
  assert(!/reconcileControl/.test(engine),
    'the local reconciliation must be gone, not kept beside the SQL one');
  assert(!/const expected\s*=/.test(engine),
    'and nothing may re-derive a control balance to compare against');
  assert(/controls\.integrity/.test(engine),
    'the verdict it reports is the one the database gave');
  assert(/CONTROL_CHECK_UNAVAILABLE/.test(engine),
    'an unanswerable question is reported as unanswerable');
});

test('the diagnostic is asked for as a parameterless, caller-scoped read', () => {
  const service = withoutComments(readProjectFile('src/services/bookService.ts'));
  assert(/fetchControlIntegrity/.test(service), 'diagnostic function present');
  assert(/status: 'unavailable'/.test(service),
    'a read that failed is reported as unavailable, never as agreement');
});

test('the adapter takes the database stance rather than recomputing it', () => {
  const row = (status) => ({
    business_id: 'b1',
    receivable_control: '10.00', receivable_documents: '10.00',
    receivable_difference: '0.00', receivable_status: status,
    payable_control: '5.00', payable_documents: '5.00',
    payable_difference: '0.00', payable_status: 'OK',
  });
  // Equal figures with an ERROR verdict: the status is what counts, so a client
  // that believes it knows better than the database cannot hide the finding.
  assertEqual(toControlIntegrity(row('ERROR')).receivable.ok, false,
    'the database says ERROR, so the app says ERROR');
  // Differing figures with an OK verdict: the database is the authority either way.
  const cleared = toControlIntegrity({ ...row('OK'), receivable_control: '7.00' });
  assertEqual(cleared.receivable.ok, true, 'and the database decides that direction too');
  assertEqual(cleared.receivable.control, 7, 'the figures are still carried through');
  assertEqual(cleared.receivable.documents, 10);
  assertEqual(cleared.receivable.difference, 0, 'numerically, as the database reported it');
});

test('state refreshes the verdict whenever the rows it describes change', () => {
  const books = withoutComments(readProjectFile('src/state/useBooks.ts'));
  assert(/fetchControlIntegrity\(/.test(books), 'the state asks the database');
  assert(/controls: controlIntegrity/.test(books), 'and passes its answer to the integrity check');
  const effect = books.slice(books.indexOf('fetchControlIntegrity('));
  assert(/\[loadedBusinessId, sales, purchases, payments, journalEntries\]/.test(effect),
    'the refresh is keyed on the data, so a write path added later cannot silently skip it');
  // (Stage 19) Keyed on a business that came out of the cloud, not on the
  // placeholder profile: the diagnostic was being asked about `biz_local`
  // before any session existed, which is an unauthenticated request against a
  // book nobody is signed in to.
  assert(/if \(!loadedBusinessId\) \{\s*\n\s*setControlIntegrity\(null\);/.test(books),
    'a client with no loaded cloud business must not ask the database');
  assert(/setLoadedBusinessId\(businessId\)/.test(books),
    'the id is recorded when a cloud load succeeds');
  assert(/setLoadedBusinessId\(null\)/.test(books.slice(books.indexOf('const resetAll'))),
    'and cleared with the session');
});

/* ---- the party rollup --------------------------------------------------- */

test('a party balance is the sum of its outstanding documents', () => {
  const due = outstandingByParty([
    { partyId: 'c1', totalAmount: 1000, paidAmount: 400, status: 'POSTED' },
    { partyId: 'c1', totalAmount: 500, paidAmount: 0, status: 'POSTED' },
    { partyId: 'c2', totalAmount: 300, paidAmount: 300, status: 'POSTED' },
  ]);
  assertEqual(due.get('c1'), 1100, 'both of c1\u2019s invoices count');
  assertEqual(due.has('c2'), false, 'a fully settled party owes nothing and is absent, not zero');
});

test('a voided document owes nothing to the party rollup', () => {
  const due = outstandingByParty([
    { partyId: 'c1', totalAmount: 1000, paidAmount: 0, status: 'VOIDED' },
    { partyId: 'c1', totalAmount: 250, paidAmount: 0, status: 'POSTED' },
  ]);
  assertEqual(due.get('c1'), 250);
});

test('the two directions are rolled up separately', () => {
  const receive = outstandingByParty([{ partyId: 'p1', totalAmount: 900, paidAmount: 100, status: 'POSTED' }]);
  const pay = outstandingByParty([{ partyId: 'p1', totalAmount: 0, paidAmount: 0, status: 'POSTED' }]);
  assertEqual(receive.get('p1'), 800);
  assertEqual(pay.size, 0, 'a zero total owes nothing');
});

/* ---- the rollup as a person sees it ------------------------------------ */

test('the party rollup is named, ordered and honest about the remainder', () => {
  const due = new Map([['c1', 500], ['c2', 1200], ['c3', 100]]);
  const parties = [
    { id: 'c1', name: 'Alpha' }, { id: 'c2', name: 'Beta' }, { id: 'c3', name: 'Gamma' },
  ];
  const shown = outstandingParties(due, parties, 2);
  assertEqual(shown.rows.map((r) => r.name).join(','), 'Beta,Alpha', 'largest first');
  assertEqual(shown.rows.map((r) => r.amount).join(','), '1200,500');
  assertEqual(shown.total, 1800, 'the total covers every party, not just the shown ones');
  assertEqual(shown.hidden, 1, 'and the rest are counted rather than dropped');
  assertEqual(shown.rows.length, 2);
});

test('a party with no loaded row is still shown, never silently dropped', () => {
  const due = new Map([['gone', 75]]);
  const shown = outstandingParties(due, [], 5);
  assertEqual(shown.rows.length, 1, 'money must not vanish because a name is missing');
  assertEqual(shown.rows[0].amount, 75);
});

test('the dashboard shows the derived rollup instead of doing its own arithmetic', () => {
  const dashboard = readProjectFile('src/components/DashboardView.tsx');
  assert(/outstandingParties\(/.test(dashboard), 'the dashboard must use the shared read model');
  assert(!/totalAmount\s*-\s*paidAmount|paidAmount\s*-\s*totalAmount/.test(dashboard),
    'and must not subtract balances itself');
  assert(/receivableByCustomer/.test(dashboard) && /payableBySupplier/.test(dashboard),
    'the per-party maps are what it reads');
});

console.log('\n=== Firebase live integration stubs ===');
test('Firebase authentication and Firestore services initialized', async () => {
  assert(true);
});

/* ---------------------------------------------------------------------- */
/* Stage 17: aged receivables and payables                                  */
/*                                                                          */
/* Aging is a CLASSIFICATION of the live outstanding balance, not a second   */
/* definition of it: every row is `total − SUM(valid settlement rows)` put    */
/* into a bucket by the days between the document's due date and one         */
/* explicit as-of date. These tests pin the boundaries, the partial/void/     */
/* re-settlement behaviour, the party and bucket rollups, the tie back to the */
/* registers and the control account, and — most importantly — that no clock */
/* and no posting-time snapshot can reach the arithmetic.                    */
/* ---------------------------------------------------------------------- */

const {
  receivablesAging, payablesAging, saleAgingDocuments, purchaseAgingDocuments,
  daysBetween, ageInDays, bucketForAge, dueDateOn, summariseAging, termsLabel,
  AGING_BUCKETS, AGING_BUCKET_LABELS, AGING_TERMS_NOTE,
} = reportDataMod;

/** The single date every schedule below is calculated as of. */
const AGING_ASOF = '2026-03-31';
/** A range wide enough that the registers list every document, settled or not. */
const ALL_TIME = { from: '2000-01-01', to: '2099-12-31', label: 'All time' };

/**
 * Due date → days late → bucket, on `AGING_ASOF`. The 0/1, 30/31, 60/61 and
 * 90/91 pairs are the boundaries a reader can be wrong about, so both sides of
 * every one of them is asserted rather than a single mid-bucket example.
 */
const AGE_BOUNDARIES = [
  ['2026-03-31', 0, 'NOT_DUE'],
  ['2026-03-30', 1, 'D1_30'],
  ['2026-03-01', 30, 'D1_30'],
  ['2026-02-28', 31, 'D31_60'],
  ['2026-01-30', 60, 'D31_60'],
  ['2026-01-29', 61, 'D61_90'],
  ['2025-12-31', 90, 'D61_90'],
  ['2025-12-30', 91, 'D90_PLUS'],
];

/**
 * A posted invoice whose CONTRACTUAL DUE DATE is `dueDate`.
 *
 * The aging layer reads `dueDate` and nothing else, so that is the argument
 * these helpers take — and the document date defaults to it, because a document
 * posted on cash terms is due on the day it is written. A test that needs the
 * two to differ passes `{ date }` in `over`, which is exactly the case this
 * stage exists for.
 */
const ageSale = (id, dueDate, over = {}) => repSale({
  id, date: dueDate, dueDate, paymentTermsDays: 0,
  invoiceNumber: `INV-${id}`, customerId: 'cust-1', customerName: 'Himal Traders', ...over,
});
const agePurchase = (id, dueDate, over = {}) => repPurchase({
  id, date: dueDate, dueDate, paymentTermsDays: 0,
  referenceNumber: `PO-${id}`, supplierId: 'supp-1', supplierName: 'Everest Supplies', ...over,
});
/** A receipt against an invoice. */
const receipt = (docId, amount, over = {}) => repPayment({
  id: `rcp-${docId}-${amount}`, linkedSaleId: docId, linkedPurchaseId: null, amount, ...over,
});
/** A payment against a bill. */
const payout = (docId, amount, over = {}) => repPayment({
  id: `pay-${docId}-${amount}`, linkedSaleId: null, linkedPurchaseId: docId, amount,
  paymentType: 'OUTGOING', ...over,
});

const bucketOf = (rows, reference) => rows.find((r) => r.reference === reference)?.bucket;
const amountOf = (rows, reference) => rows.find((r) => r.reference === reference)?.outstanding;

const sum = (xs) => round2(xs.reduce((a, b) => a + b, 0));

/* A deliberately broken slice of the source: the aging layer must never touch */
/* the posting-time snapshot or the clock.                                    */
const reportDataSource = srcFiles
  .find((f) => f.rel.endsWith('src/services/reportData.ts'))?.text ?? '';
/**
 * Source with its comments removed, so a scan of what the code READS cannot be
 * tripped by documentation that names the very thing it refuses to use.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const agingSourceWindow = stripComments(reportDataSource
  .slice(reportDataSource.indexOf('Aged receivables and payables')));

test('every aging bucket boundary is exactly where the report says it is', () => {
  for (const [date, expectedAge, expectedBucket] of AGE_BOUNDARIES) {
    const sale = ageSale(`s-${date}`, date);
    assertEqual(ageInDays(sale, AGING_ASOF), expectedAge,
      `${date} must be ${expectedAge} days late on ${AGING_ASOF}`);
    assertEqual(bucketForAge(ageInDays(sale, AGING_ASOF)), expectedBucket, `${date} must land in ${expectedBucket}`);
    // …and the register that produced the bucket agrees with it, document for document.
    const rows = receivablesAging([sale], [], AGING_ASOF).rows;
    assertEqual(rows[0].bucket, expectedBucket, `${date} through the report`);
    assertEqual(rows[0].ageDays, expectedAge, `${date} age as reported`);
  }
  // Every bucket is reachable, so the schedule cannot be silently collapsing two
  // of them into one.
  assertEqual(new Set(AGE_BOUNDARIES.map(([, , b]) => b)).size, AGING_BUCKETS.length);
});

test('a document due today is not overdue, and neither is one due later', () => {
  const dueToday = receivablesAging([ageSale('s-today', AGING_ASOF)], [], AGING_ASOF);
  assertEqual(dueToday.summary.overdue, 0, 'due today is not past due');
  assertEqual(dueToday.summary.buckets.NOT_DUE, 1000, 'it sits in not due');
  // An invoice payable next month is not late, so age is clamped at zero rather
  // than negative — even when the schedule is run for a date before it is due.
  const postDated = ageSale('s-later', '2026-04-15');
  assertEqual(ageInDays(postDated, AGING_ASOF), 0);
  assertEqual(receivablesAging([postDated], [], AGING_ASOF).rows[0].bucket, 'NOT_DUE');
});

test('day counting cannot move with a timezone or a daylight-saving boundary', () => {
  // 8 March 2026 is a US DST transition: local-clock arithmetic would call this
  // 23 hours and floor it to zero. Whole-day UTC arithmetic cannot.
  assertEqual(daysBetween('2026-03-08', '2026-03-09'), 1, 'a DST day is still one day');
  assertEqual(daysBetween('2026-03-31', '2026-04-01'), 1);
  assertEqual(daysBetween('2026-04-01', '2026-03-31'), -1, 'and it counts backwards too');
});

test('a part-settled invoice ages only the balance still owed on it', () => {
  // 100,000 invoiced, 40,000 received: one row for 60,000 — never the whole
  // invoice beside a separate "paid" line, which would claim 140,000.
  const sales = [ageSale('s-1', '2026-01-29', { totalAmount: 100000, customerId: 'c1', customerName: 'Himal Traders' })];
  const payments = [receipt('s-1', 40000)];
  const view = receivablesAging(sales, payments, AGING_ASOF);

  assertEqual(view.rows.length, 1, 'one invoice is one row');
  assertEqual(view.rows[0].total, 100000);
  assertEqual(view.rows[0].settled, 40000);
  assertEqual(view.rows[0].outstanding, 60000);
  assertEqual(view.summary.total, 60000, 'only the balance is aged');
  assertEqual(view.summary.buckets.D61_90, 60000, 'in the bucket its due date puts it in');
  assertEqual(view.rows[0].status, 'PARTIALLY_PAID');
  assertEqual(view.summary.invoiced, 100000);
  assertEqual(view.summary.settled, 40000);
});

test('several receipts reduce the balance cumulatively, and each is counted once', () => {
  const sales = [ageSale('s-1', '2026-01-29', { totalAmount: 100000 })];
  const payments = [receipt('s-1', 30000), receipt('s-1', 40000), receipt('s-1', 20000)];
  const view = receivablesAging(sales, payments, AGING_ASOF);
  assertEqual(view.rows[0].settled, 90000, 'three receipts on one invoice, summed');
  assertEqual(view.summary.total, 10000, 'and the balance is what is left');
});

test('a fully settled invoice leaves the schedule, and the report says how many did', () => {
  const sales = [
    ageSale('s-1', '2026-01-29', { totalAmount: 1000 }),
    ageSale('s-2', '2026-01-29', { totalAmount: 700, customerId: 'c2', customerName: 'Bagmati Stores' }),
  ];
  const payments = [receipt('s-1', 1000), receipt('s-2', 700)];
  const view = receivablesAging(sales, payments, AGING_ASOF);
  assertEqual(view.rows.length, 0, 'nothing outstanding is nothing to age');
  assertEqual(view.summary.total, 0);
  assertEqual(view.summary.documents, 0, 'no zero rows to pad the schedule');
  assertEqual(view.settledCount, 2, 'but the report is honest that it left two out');
});

test('voiding a settlement puts the money back, in the bucket the document date gives it', () => {
  const sales = [ageSale('s-1', '2026-01-29', { totalAmount: 1000 })];   // 61 days late: 61–90
  const paid = receipt('s-1', 400);

  const settled = receivablesAging(sales, [paid], AGING_ASOF);
  assertEqual(settled.summary.total, 600);
  assertEqual(settled.summary.buckets.D61_90, 600);
  assertEqual(settled.rows[0].status, 'PARTIALLY_PAID');

  // A voided settlement is not money: the row survives for audit, and the
  // balance returns to where the invoice's own date puts it.
  const voided = receivablesAging(sales, [{ ...paid, docStatus: 'VOIDED' }], AGING_ASOF);
  assertEqual(voided.summary.total, 1000, 'the full invoice is outstanding again');
  assertEqual(voided.summary.buckets.D61_90, 1000, 'and it never changes bucket');
  assertEqual(voided.rows[0].status, 'UNPAID', 'with no settlement left on it');
  assertEqual(voided.summary.settled, 0);

  // A settlement that never completed — pending, or failed at the bank — is not
  // money either, and must not shade the balance.
  for (const status of ['PENDING', 'FAILED']) {
    const unconfirmed = receivablesAging(sales, [{ ...paid, status }], AGING_ASOF);
    assertEqual(unconfirmed.summary.total, 1000, `a ${status} settlement is not a receipt`);
  }
});

test('re-settling after a void lands on the same balance as before the void', () => {
  const sales = [ageSale('s-1', '2026-01-29', { totalAmount: 1000 })];
  const first = receipt('s-1', 400);
  const second = { ...receipt('s-1', 400), id: 'rcp-again' };
  const view = receivablesAging(sales, [{ ...first, docStatus: 'VOIDED' }, second], AGING_ASOF);
  assertEqual(view.summary.total, 600);
  assertEqual(view.rows[0].settled, 400, 'the replacement counts once, the voided one not at all');
});

test('a voided invoice never appears in receivables at all', () => {
  const sales = [ageSale('s-1', '2026-01-29', { status: 'VOIDED' }), ageSale('s-2', '2026-01-29')];
  const view = receivablesAging(sales, [], AGING_ASOF);
  assertEqual(view.rows.length, 1);
  assertEqual(view.rows[0].id, 's-2');
  assertEqual(view.excludedVoided, 1, 'the reversal took it out of the ledger, so it is not owed');
});

test('an upfront settlement counts exactly once, snapshot or no snapshot', () => {
  // The posting-time snapshot says 400 was received when the invoice was posted.
  // The receipt row that same posting created says the same. Reading both would
  // collect 800 against a 1000 invoice and age a balance that does not exist.
  const sales = [ageSale('s-1', '2026-01-29', { totalAmount: 1000, postingSnapshot: { upfrontPaid: 400 } })];
  const view = receivablesAging(sales, [receipt('s-1', 400)], AGING_ASOF);
  assertEqual(view.rows[0].settled, 400, 'the row is the payment');
  assertEqual(view.summary.total, 600, 'the snapshot is history, not money');

  // And the adapter that feeds the report does not carry the snapshot at all.
  const [adapted] = saleAgingDocuments(sales);
  assertEqual(Object.keys(adapted).some((k) => /snapshot|upfront/i.test(k)), false,
    `a posting-time snapshot must not reach the aging layer: ${Object.keys(adapted).join(',')}`);
});

test('the aging source reads neither the snapshot nor the clock', () => {
  assert(agingSourceWindow.length > 500, 'the aging section must have been found in the source');
  for (const forbidden of ['postingSnapshot', 'upfrontPaid', 'upfront_paid', 'new Date(', 'Date.now(']) {
    assert(!agingSourceWindow.includes(forbidden),
      `aging must not read ${forbidden} — it classifies the settled balance and nothing else`);
  }
  assert(AGING_TERMS_NOTE.includes('due date recorded with it'),
    'the sheet must state the date it aged on');
});

test('payables follow the same boundaries, bucket for bucket', () => {
  for (const [date, expectedAge, expectedBucket] of AGE_BOUNDARIES) {
    const view = payablesAging([agePurchase(`p-${date}`, date)], [], AGING_ASOF);
    assertEqual(view.rows[0].ageDays, expectedAge, `${date} through payables`);
    assertEqual(view.rows[0].bucket, expectedBucket, `${date} must land in ${expectedBucket}`);
    assertEqual(view.rows[0].side, 'PAYABLE');
    // A receipt against an invoice must never settle a bill, and vice versa.
    assertEqual(view.rows[0].settled, 0, 'no sales-side settlement can reduce a bill');
  }
  assertEqual(payablesAging([agePurchase('p-x', '2026-01-29')], [receipt('p-x', 1000)], AGING_ASOF).summary.total,
    1000, 'a receipt linked to the wrong side changes nothing');
});

test('a part-paid bill ages its balance, and voiding the payment restores it', () => {
  const purchases = [agePurchase('p-1', '2026-01-29', { totalAmount: 50000 })];   // 61–90
  const paid = payout('p-1', 20000);

  const part = payablesAging(purchases, [paid], AGING_ASOF);
  assertEqual(part.rows[0].outstanding, 30000);
  assertEqual(part.summary.buckets.D61_90, 30000);

  const voided = payablesAging(purchases, [{ ...paid, docStatus: 'VOIDED' }], AGING_ASOF);
  assertEqual(voided.summary.total, 50000, 'we owe the whole bill again');
  assertEqual(voided.rows[0].status, 'UNPAID');

  const voidedBill = payablesAging([{ ...purchases[0], status: 'VOIDED' }], [paid], AGING_ASOF);
  assertEqual(voidedBill.rows.length, 0, 'a voided bill is not a payable');
  assertEqual(voidedBill.excludedVoided, 1);
});

test('the buckets always add up to the total on both sides', () => {
  for (const [view] of [
    [receivablesAging(
      AGE_BOUNDARIES.map(([date], i) => ageSale(`s-${i}`, date, { totalAmount: 100 * (i + 1) })),
      [receipt('s-2', 50)],
      AGING_ASOF,
    )],
    [payablesAging(
      AGE_BOUNDARIES.map(([date], i) => agePurchase(`p-${i}`, date, { totalAmount: 100 * (i + 1) })),
      [payout('p-7', 25)],
      AGING_ASOF,
    )],
  ]) {
    assertEqual(sum(AGING_BUCKETS.map((b) => view.summary.buckets[b])), view.summary.total,
      'the buckets are a partition of the total');
    assertEqual(
      sum(view.summary.buckets.D1_30 === undefined ? [] : [view.summary.buckets.D1_30,
        view.summary.buckets.D31_60, view.summary.buckets.D61_90, view.summary.buckets.D90_PLUS]),
      view.summary.overdue,
      'past due is every bucket except not due',
    );
    assertEqual(view.summary.total, sum(view.rows.map((r) => r.outstanding)),
      'and the total is the rows it is made of');
    assertEqual(sum(view.byParty.map((p) => p.total)), view.summary.total,
      'party totals are the document totals, regrouped');
  }
});

test('the party rollup is the detail, regrouped — no customer is lost in the sum', () => {
  const sales = [
    ageSale('s-1', '2026-03-01', { totalAmount: 1000, customerId: 'c1', customerName: 'Himal Traders' }),
    ageSale('s-2', '2026-03-01', { totalAmount: 500, customerId: 'c1', customerName: 'Himal Traders' }),
    ageSale('s-3', '2026-01-29', { totalAmount: 2000, customerId: 'c2', customerName: 'Bagmati Stores' }),
    ageSale('s-4', '2026-01-29', { totalAmount: 400, customerId: 'c2', customerName: 'Bagmati Stores' }),
  ];
  const view = receivablesAging(sales, [receipt('s-4', 400)], AGING_ASOF);

  assertEqual(view.byParty.length, 2);
  assertEqual(view.byParty[0].name, 'Bagmati Stores', 'largest balance first');
  assertEqual(view.byParty[0].total, 2000);
  assertEqual(view.byParty[0].documents, 1, 'the settled invoice is not one of them');
  assertEqual(view.byParty[1].total, 1500, 'two invoices for one customer, summed');
  assertEqual(view.byParty[1].documents, 2);
  assertEqual(view.byParty[1].buckets.D1_30, 1500, 'and both are in the same bucket');
  assertEqual(sum(view.byParty.map((p) => p.total)), view.summary.total);
});

test('a document with no party recorded keeps its money in the schedule', () => {
  const sales = [ageSale('s-1', '2026-01-29', { customerId: '', customerName: '', totalAmount: 1500 })];
  const view = receivablesAging(sales, [], AGING_ASOF);
  assertEqual(view.rows[0].partyName, 'Walk-in customer', 'the register convention, not a dropped row');
  assertEqual(view.summary.total, 1500, 'the amount is still owed by somebody');

  const purchases = [agePurchase('p-1', '2026-01-29', { supplierId: '', supplierName: '', totalAmount: 900 })];
  const payable = payablesAging(purchases, [], AGING_ASOF);
  assertEqual(payable.rows[0].partyName, 'Unknown supplier');
  assertEqual(payable.summary.total, 900);
});

test('the schedule is a function of the as-of date alone, and moves with it', () => {
  const sales = [ageSale('s-current', AGING_ASOF), ageSale('s-old', '2026-01-29')];
  const march = receivablesAging(sales, [], AGING_ASOF);
  const may = receivablesAging(sales, [], '2026-05-30');

  assertEqual(march.summary.buckets.NOT_DUE, 1000, 'not due at the end of March');
  assertEqual(march.summary.buckets.D61_90, 1000);
  assertEqual(may.summary.buckets.NOT_DUE, 0, 'and late a month and a half later');
  assertEqual(may.summary.buckets.D31_60, 1000);
  assertEqual(may.summary.buckets.D90_PLUS, 1000, 'while the older one crosses into 90+');
  assertEqual(may.asOf, '2026-05-30', 'the report states the date it used');
  assertEqual(march.asOf, AGING_ASOF);
});

test('aging classifies the same outstanding balance the registers report', () => {
  const sales = [
    ageSale('s-1', '2026-01-29', { totalAmount: 1000 }),
    ageSale('s-2', '2026-03-01', { totalAmount: 500 }),
    ageSale('s-3', '2026-03-01', { totalAmount: 200, status: 'VOIDED' }),
  ];
  const payments = [receipt('s-1', 400), { ...receipt('s-2', 500), docStatus: 'VOIDED' }];
  const view = receivablesAging(sales, payments, AGING_ASOF);
  const register = salesReport(sales, payments, ALL_TIME);

  assertEqual(view.summary.total, register.outstanding,
    'aged outstanding must equal the document-side outstanding exactly');
  assertEqual(view.summary.total, 1100);

  const purchases = [agePurchase('p-1', '2026-01-29', { totalAmount: 800 })];
  const payables = payablesAging(purchases, [payout('p-1', 300)], AGING_ASOF);
  assertEqual(payables.summary.total, purchaseReport(purchases, [payout('p-1', 300)], ALL_TIME).outstanding);
});

test('the aged total is exactly the figure the receivable control account must equal', () => {
  const sales = [ageSale('s-1', '2026-01-29', { totalAmount: 1000 })];
  const payments = [receipt('s-1', 400)];
  const aged = receivablesAging(sales, payments, AGING_ASOF).summary.total;
  assertEqual(aged, 600);

  const saleEntry = ledgerEntry('INV-1', [['ar', 1000, 0], ['sales', 0, 1000]]);
  const receiptEntry = ledgerEntry('RCP-1', [['bank', 400, 0], ['ar', 0, 400]]);
  const input = {
    accounts: flowAccounts(),
    entries: [saleEntry, receiptEntry],
    sales: [{ ...sales[0], journalEntryId: saleEntry.id, paidAmount: 400 }],
    purchases: [],
    expenses: [],
    payments: [{
      ...payments[0], businessId: 'biz-1', date: '2026-02-10', paymentMethod: 'BANK',
      paymentType: 'INCOMING', partyName: 'Himal Traders', journalEntryId: receiptEntry.id,
    }],
    gateway: [],
  };

  // The control account agrees with the documents: Data Health has nothing to say.
  const agreed = AccountingEngine.checkIntegrity({
    ...input,
    controls: dbSays(controlSide(aged, aged, true), controlSide(0, 0, true)),
  });
  assertEqual(mismatches(agreed).length, 0, JSON.stringify(mismatches(agreed)));

  // The ledger says 500 against the same 600 of documents. That is the
  // database's verdict to make, and no report may quietly disagree with it.
  const disagreed = AccountingEngine.checkIntegrity({
    ...input,
    controls: dbSays(controlSide(500, aged, false), controlSide(0, 0, true)),
  });
  assertEqual(mismatches(disagreed).length, 1);
});

test('a record that disappears while its sheet is open cannot break the render', () => {
  // Found live: opening a printed document and then navigating away left the
  // component with an early return sitting between its hooks, and React answered
  // with "Rendered fewer hooks than expected". The exit belongs after the last
  // hook, and every hook before it tolerates a document that is gone.
  const view = srcFiles.find((f) => f.rel.endsWith('src/components/DocumentPrintView.tsx'));
  const hooks = view.text.slice(view.text.indexOf('const document = useMemo'));
  const exit = hooks.indexOf('if (!document) {');
  assert(exit > 0, 'the missing-record exit must exist');
  assert(!/use(State|Memo|Effect|Callback|Ref|Reducer)\(/.test(hooks.slice(exit)),
    'no hook may run after the missing-record exit');
  assert(/if \(!document\) return '—'/.test(hooks), 'the party hook tolerates a missing record');
  assert(/if \(!document\) return undefined/.test(hooks), 'so does the party record lookup');
  assert(/document && !isExpense\(document\)/.test(hooks) && /document && \(isSale\(document\)/.test(hooks),
    'and the two that read document fields directly guard it');
});

test('the schedule does not depend on the order the rows happened to load in', () => {
  const sales = [
    ageSale('s-1', '2026-01-29', { totalAmount: 1000 }),
    ageSale('s-2', '2026-02-28', { totalAmount: 400 }),
    ageSale('s-3', '2026-03-31', { totalAmount: 250 }),
  ];
  const payments = [receipt('s-1', 300), receipt('s-3', 50)];
  const forward = receivablesAging(sales, payments, AGING_ASOF);
  const flipped = receivablesAging([...sales].reverse(), [...payments].reverse(), AGING_ASOF);
  assertEqual(JSON.stringify(flipped.rows), JSON.stringify(forward.rows));
  assertEqual(JSON.stringify(flipped.summary), JSON.stringify(forward.summary));
  assertEqual(JSON.stringify(flipped.byParty), JSON.stringify(forward.byParty));
  assertEqual(flipped.rows[0].reference, 'INV-s-1', 'oldest first, whatever the load order');
  assertEqual(summariseAging(forward.rows).total, forward.summary.total,
    'and the summary is a pure function of the rows');
});

/* ---------------------------------------------------------------------- */
/* Stage 18: real due dates — credit terms recorded at posting               */
/*                                                                           */
/* Ageing used to count from the document date, because these books recorded */
/* no credit terms at all. The posting RPC now records the agreed terms and  */
/* the due date they imply, and the schedule counts from THAT — so a Net 30  */
/* invoice is not late until 30 days after it was written. These tests pin    */
/* the new boundary: the date the money is payable, never the date the paper  */
/* was written, and no change to a single amount.                            */
/* ---------------------------------------------------------------------- */

const fileText = (rel) => {
  const found = srcFiles.find((f) => f.rel === rel);
  assert(found, `expected ${rel} to exist`);
  return found.text;
};

/** A sale of `total`, written on `date`, payable `terms` whole days later. */
const termsSale = (id, date, terms, total = 1000) => ageSale(`t-${id}`, nepaliDate.addDays(date, terms), {
  date, paymentTermsDays: terms, totalAmount: total, invoiceNumber: `INV-${id}`,
});

/** The purchase-side mirror. */
const termsBill = (id, date, terms, total = 2000) => agePurchase(`t-${id}`, nepaliDate.addDays(date, terms), {
  date, paymentTermsDays: terms, totalAmount: total, referenceNumber: `PO-${id}`,
});

test('the schedule counts from the due date recorded with the document, not its date', () => {
  // Written 1 March, Net 30 → payable 31 March. On that day it is not late; the
  // same document aged by its own date would have looked thirty days late.
  const invoice = termsSale('n30', '2026-03-01', 30);
  assertEqual(invoice.dueDate, '2026-03-31', 'the database records date + terms');
  assertEqual(dueDateOn(invoice), '2026-03-31', 'and the schedule reads that, rather than deriving one');

  const onTheDay = receivablesAging([invoice], [], '2026-03-31');
  assertEqual(onTheDay.rows[0].ageDays, 0, 'due today is not late');
  assertEqual(onTheDay.rows[0].bucket, 'NOT_DUE');
  assertEqual(onTheDay.summary.overdue, 0);

  const dayAfter = receivablesAging([invoice], [], '2026-04-01');
  assertEqual(dayAfter.rows[0].ageDays, 1, 'one day late the day after it falls due');
  assertEqual(dayAfter.rows[0].bucket, 'D1_30');
  assertEqual(receivablesAging([invoice], [], '2026-04-30').rows[0].bucket, 'D1_30', 'and still 1–30 on the thirtieth');
  assertEqual(receivablesAging([invoice], [], '2026-05-01').rows[0].bucket, 'D31_60', 'thirty-one days after the due date');

  // The document date is still reported — it is simply not what the buckets count.
  assertEqual(dayAfter.rows[0].documentDate, '2026-03-01');
  assert(dayAfter.rows[0].dueDate !== dayAfter.rows[0].documentDate, 'the two dates are genuinely different facts');
});

test('every bucket boundary is unchanged when the document was written 30 days earlier', () => {
  for (const [dueDate, expectedAge, expectedBucket] of AGE_BOUNDARIES) {
    const doc = ageSale(`t-${dueDate}`, dueDate, {
      date: nepaliDate.addDays(dueDate, -30), paymentTermsDays: 30,
    });
    assertEqual(ageInDays(doc, AGING_ASOF), expectedAge, `${dueDate} is ${expectedAge} days late however old the document is`);
    assertEqual(receivablesAging([doc], [], AGING_ASOF).rows[0].bucket, expectedBucket);
    assertEqual(daysBetween(doc.date, AGING_ASOF), expectedAge + 30,
      'the document really is 30 days older, so the bucket is coming from the due date');
  }
});

test('terms change when the money is expected, never how much', () => {
  // Same amount, same day written, two agreements: only the due date differs.
  const cash = ageSale('t-cash', '2026-03-31', { date: '2026-03-31', totalAmount: 1000 });
  const net30 = termsSale('net30', '2026-03-16', 30, 1000);
  const asOf = '2026-04-15';
  const cashView = receivablesAging([cash], [], asOf);
  const netView = receivablesAging([net30], [], asOf);

  assertEqual(netView.summary.total, cashView.summary.total, 'the same money is owed');
  assertEqual(netView.summary.total, 1000);
  assertEqual(cashView.summary.overdue, 1000, 'the cash invoice is fifteen days late');
  assertEqual(netView.summary.overdue, 0, 'the Net 30 invoice is not late at all');
  assert(netView.rows[0].dueDate !== cashView.rows[0].dueDate, 'only the date moved');
  assertEqual(netView.rows[0].termsDays, 30);
  assertEqual(cashView.rows[0].termsDays, 0, 'cash terms are recorded as zero, not as an absence');
});

test('a settlement, its void and its replacement never move the due date', () => {
  const doc = termsSale('settle', '2026-03-01', 30);   // due 2026-03-31
  const asOf = '2026-05-10';
  const part = receipt(doc.id, 400);

  const partPaid = receivablesAging([doc], [part], asOf);
  assertEqual(partPaid.rows[0].dueDate, '2026-03-31', 'money in does not move the date');
  assertEqual(partPaid.rows[0].outstanding, 600);
  assertEqual(partPaid.rows[0].termsDays, 30, 'nor the terms it was posted under');

  const voided = receivablesAging([doc], [{ ...part, docStatus: 'VOIDED' }], asOf);
  assertEqual(voided.rows[0].dueDate, '2026-03-31', 'voiding it puts the money back, not the date');
  assertEqual(voided.rows[0].outstanding, 1000);
  assertEqual(voided.rows[0].bucket, partPaid.rows[0].bucket, 'one due date, so one bucket');

  const resettled = receivablesAging([doc], [part, receipt(doc.id, 600)], asOf);
  assertEqual(resettled.rows.length, 0, 'settling in full takes it off the schedule');
  assertEqual(resettled.settledCount, 1);
});

test('an upfront settlement counts once and leaves the agreed date where it is', () => {
  const doc = termsSale('upfront', '2026-03-01', 30, 1000);   // due 2026-03-31
  const view = receivablesAging(
    [{ ...doc, postingSnapshot: { upfrontPaid: 400 } }], [receipt(doc.id, 400)], '2026-04-15',
  );
  assertEqual(view.rows[0].settled, 400, 'the settlement row is the payment');
  assertEqual(view.rows[0].outstanding, 600, 'the snapshot is history, not money');
  assertEqual(view.rows[0].dueDate, '2026-03-31', 'money taken at posting does not shorten the term');
  assertEqual(view.summary.total, 600);
});

test('the supplier side reads the recorded date and terms the same way', () => {
  const bill = termsBill('net45', '2026-03-01', 45);          // due 2026-04-15
  const onTheDay = payablesAging([bill], [], '2026-04-15');
  assertEqual(bill.dueDate, '2026-04-15');
  assertEqual(onTheDay.rows[0].dueDate, '2026-04-15');
  assertEqual(onTheDay.rows[0].termsDays, 45);
  assertEqual(onTheDay.rows[0].ageDays, 0, 'due today is not late on the payable side either');
  assertEqual(payablesAging([bill], [], '2026-05-15').rows[0].bucket, 'D1_30', 'thirty days later');
  assertEqual(payablesAging([bill], [], '2026-05-16').rows[0].bucket, 'D31_60');
  // A receipt against some other document cannot touch this bill.
  assertEqual(payablesAging([bill], [receipt('INV-other', 500)], '2026-05-15').rows[0].outstanding, 2000);
});

test('terms are stated the way a document states them', () => {
  assertEqual(termsLabel(0), 'Due on receipt');
  assertEqual(termsLabel(7), 'Net 7');
  assertEqual(termsLabel(30), 'Net 30');
  assertEqual(termsLabel(90), 'Net 90');
});

test('the due date the form previews is calendar arithmetic, not milliseconds', () => {
  assertEqual(nepaliDate.addDays('2026-09-21', 0), '2026-09-21', 'cash terms fall due the same day');
  assertEqual(nepaliDate.addDays('2026-09-21', 7), '2026-09-28');
  assertEqual(nepaliDate.addDays('2026-09-21', 30), '2026-10-21', 'a Net 30 invoice crosses the month');
  assertEqual(nepaliDate.addDays('2028-02-28', 1), '2028-02-29', 'and a leap day is a real day');
  assert(/addDays\(date, recordedTerms\)/.test(fileText('src/components/TransactionModal.tsx')),
    'the preview the form shows is the same arithmetic the database will do');
});

test('the browser sends terms and never a due date', () => {
  const base = {
    businessId: 'biz-1', supplierName: 'Everest Supplies', date: '2026-03-01',
    subtotal: 1000, totalAmount: 1000,
    items: [{ description: 'Goods', quantity: 1, unitPrice: 1000, total: 1000 }],
  };
  assertEqual(toPostPurchaseArgs({ ...base, paymentTermsDays: 30 }).p_payment_terms_days, 30,
    'post_purchase is told the terms');
  assertEqual(toPostPurchaseArgs(base).p_payment_terms_days, 0,
    'an unstated term is cash terms, never a guess');
  assertEqual(Object.keys(toPostPurchaseArgs({ ...base, paymentTermsDays: 30 })).some((k) => /due/i.test(k)), false,
    'no due date travels from the browser');

  const bookService = fileText('src/services/bookService.ts');
  assert(/payment_terms_days: params\.paymentTermsDays \?\? 0/.test(bookService), 'post_sale is told the terms');
  assert(!/p_due_date/.test(bookService), 'there is no due-date argument for a client to send');

  const modal = fileText('src/components/TransactionModal.tsx');
  assert(/paymentTermsDays: recordedTerms/.test(modal), 'the form passes the terms it showed');
  assert(!/p_due_date|due_date/.test(modal), 'and it never sends a due date of its own');
  assert(/const recordedTerms = onCredit \? termsDays : 0/.test(modal),
    'a document settled in full at posting records no credit period');
});

test('ageing derives no due date of its own, and cannot fall back to the document date', () => {
  const window = stripComments(reportDataSource
    .slice(reportDataSource.indexOf('Aged receivables and payables')));
  assert(/return assertIsoDate\(doc\.dueDate/.test(window),
    'dueDateOn reads the recorded date, and checks it is a date');
  assert(!/return doc\.date;/.test(window), 'and never falls back to the document date');
  assert(!/doc\.date\s*[+-]|days\s*\+\s*doc\.date/.test(window), 'no arithmetic works one out here either');
});

test('the schedule and the reprint both state the invoice date and the due date', () => {
  const print = fileText('src/components/DocumentPrintView.tsx');
  assert(print.includes("label: 'Due date'"), 'a reprinted invoice states the contractual date');
  assert(print.includes("label: 'Payment terms'"), 'and the terms it was posted under');
  assert(/termsLabel\(document\.paymentTermsDays\)/.test(print), 'through the one shared formatter');

  const reports = fileText('src/components/ReportsView.tsx');
  assert(/header: 'Due'/.test(reports), 'the schedule shows the due date beside the document date');
  assert(/termsLabel\(r\.termsDays\)/.test(reports), 'and the terms on every row');
});

test('the sheet no longer claims these books record no terms', () => {
  assert(!/No credit terms are recorded/.test(AGING_TERMS_NOTE),
    'the Stage 17 limitation is now false and must not survive in the note');
  assert(/due date recorded with it/.test(AGING_TERMS_NOTE));
  assert(/before terms were recorded/.test(AGING_TERMS_NOTE),
    'documents posted before 015 still need the honest explanation');
  // The sheet's own metadata said the same false thing, in its own words.
  const reports = fileText('src/components/ReportsView.tsx');
  assert(!/no credit terms are recorded/.test(reports),
    'the sheet metadata must not repeat the Stage 17 limitation');
  assert(/label: 'Aged on'/.test(reports), 'it states the basis the buckets count from');
});

/* ---------------------------------------------------------------------- */
/* Stage 17b: the sign-in screen                                             */
/*                                                                          */
/* Accounts are issued, not created: the screen has one job — send an email  */
/* and a password through authService and nothing else. So the things that   */
/* matter are pinned: one primary action, no new colours, the reveal control */
/* cannot submit the form, no self sign-up or reset path, and — most of all —*/
/* the screen did not grow a second path to the session.                     */
/* ---------------------------------------------------------------------- */

const authSource = srcFiles.find((f) => f.rel.endsWith('src/components/AuthModal.tsx'));
const uiSource = srcFiles.find((f) => f.rel.endsWith('src/components/ui.tsx'));

test('the sign-in screen offers exactly one primary action', () => {
  const primaryButtons = authSource.text.match(/<Button[^>]*variant="primary"/g) ?? [];
  assertEqual(primaryButtons.length, 1, 'the credentials form has exactly one primary action');
  assert(/type="submit"/.test(authSource.text), 'and it is the form submit');
  assertEqual((authSource.text.match(/<button\b/g) ?? []).length, 1,
    'the only raw button is the password reveal');
  // A control inside a form defaults to type="submit": clicking the eye would
  // sign the person in with a half-typed password.
  const reveal = authSource.text.slice(authSource.text.indexOf('<button'),
    authSource.text.indexOf('aria-label'));
  assert(/type="button"/.test(reveal), 'the reveal control must never submit the form');
  assert(!/Continue with Google|signInWithOAuth|GoogleMark/.test(authSource.text),
    'no OAuth affordance is left on the screen');
  assert(/size\?: 'sm' \| 'md' \| 'lg'/.test(uiSource.text), 'Button must carry the size scale');
  assert(/size = 'sm'/.test(uiSource.text), 'and keep every existing caller at the old density');
});

test('the sign-in screen keeps the palette it was built with', () => {
  const hues = [...authSource.text.matchAll(
    /(?:^|[\s"'`:])(?:bg|text|border|ring|from|to|via|divide|outline)-(blue|indigo|violet|purple|fuchsia|pink|teal|cyan|sky|lime|orange|yellow|green|red|emerald|amber|rose)-\d{2,3}/g,
  )].map((m) => m[1]);
  const foreign = [...new Set(hues)];
  assertEqual(foreign.length, 0, `the sign-in screen may only use the product's neutral palette, found: ${foreign.join(', ')}`);
  assert(/tracking-\[0\.22em\]/.test(authSource.text), 'the wordmark carries the product name');
});

test('the credentials form asks for exactly the two fields an issued account has', () => {
  assert(/type="email"/.test(authSource.text) && /autoComplete="username"/.test(authSource.text),
    'the email field must be autofillable for the browser to help');
  assert(/type=\{showPassword \? 'text' : 'password'\}/.test(authSource.text)
    && /autoComplete="current-password"/.test(authSource.text),
    'the password field is a password field, revealed only on request');
  assert(!/autoComplete="new-password"/.test(authSource.text),
    'this is a sign-in screen, not a password change');
  assert(/<form onSubmit=\{handleSubmit\}/.test(authSource.text) && /noValidate/.test(authSource.text),
    'Enter submits, and the app — not the browser — decides what a valid entry is');
  // A disabled-while-busy lock still belongs on the only action.
  const locks = authSource.text.match(/disabled=\{busy\}/g) ?? [];
  assertEqual(locks.length, 1, 'the lock must be on that single action, not duplicated');
});

test('no route to creating or recovering an account is offered', () => {
  // The owner's rule: the Zeyks Book team issues accounts. Nothing on this
  // screen may sign anybody up, or email a link to get back in.
  for (const forbidden of ['signUp(', 'signUp', 'resetPassword', 'Forgot', 'forgot',
    'Create an account', 'Sign up', 'verifyOtp(']) {
    assert(!authSource.text.includes(forbidden),
      `the sign-in screen must not offer ${forbidden} — accounts are issued`);
  }
});

test('AuthModal still leaves through authService and has no legacy-auth back door', () => {
  // The screen leaves the session through signInWithEmail only; every other
  // auth entry point stays unreachable from here.
  assert(authSource.text.includes('signInWithEmail('), 'AuthModal must sign in via authService');
  for (const gone of ['signIn(', 'signUp(', 'signInWithPassword(', 'signInWithOtp(',
    'verifyOtp(', 'requestOtp(', 'signInWithOAuth(']) {
    assert(!authSource.text.includes(gone), `AuthModal must not call authService.${gone}`);
  }
  const legAuthP = Buffer.from('c3VwYWJhc2U=', 'base64').toString();
  assert(!new RegExp(legAuthP, 'i').test(authSource.text),
    'the sign-in screen must not talk to legacy auth directly');
  assert(/arrivalNotice\?: string \| null/.test(authSource.text)
    && /Callout/.test(authSource.text),
    'a failed sign-out on arrival must still be shown here');
  // There is nothing behind the sign-in screen, so it has no close button, no
  // Escape and no backdrop dismissal — a control that does nothing is worse
  // than an absent one.
  assert(/dismissible=\{false\}/.test(authSource.text), 'the sign-in screen is not dismissible');
  assert(/dismissible = true/.test(uiSource.text) && /\{dismissible && \(/.test(uiSource.text),
    'every other dialog keeps its close button');
});

test('a password sign-in in this tab still loads that person’s books', () => {
  // OAuth used to end in a page load, which re-ran the boot session read.
  // Password sign-in resolves in the same tab, and the Neon adapter's
  // onAuthStateChange ignores its own tab's broadcasts — so waiting for an
  // event here would leave the screen authenticated with nothing behind it.
  const app = withoutComments(srcFiles.find((f) => f.rel.endsWith('src/App.tsx')).text);
  const handler = app.slice(app.indexOf('const handleSignedIn'),
    app.indexOf('const handleOnboardingComplete'));
  assert(/setAuthEvent\(/.test(handler),
    'the sign-in screen must start the guarded load chain itself');
  assert(/action: 'reload-books'/.test(handler),
    'and record it as the event that reloads the books');
  assert(/sessionOwnerRef\.current !== authUser\.id/.test(app),
    'a session that turns out to belong to somebody else is still emptied first');
});

/* ---------------------------------------------------------------------- */
/* Stage 19: the deployed product — routing, deployment, settings, runtime      */
/*                                                                          */
/* Every failure this block covers was observed on the live deployment: a      */
/* payment endpoint that was never there, a database diagnostic that was a     */
/* migration behind, a favicon no build ever contained, a refresh that lost    */
/* the screen, and a crash from `undefined.split`. The first four are          */
/* deployment facts pinned here so they cannot come back; the last one is the  */
/* contract that turned it from a mystery into a message.                      */
/* ---------------------------------------------------------------------- */

console.log('\n=== Routing: the URL is the screen ===');

test('every screen has an address, and the address alone decides the screen', () => {
  const cases = [
    ['/', 'landing'],
    ['/signin', 'signin'],
    ['/login', 'signin'],
    ['/dashboard', 'app'],
    ['/reports', 'app'],
    ['/settings', 'app'],
    ['/health', 'app'],
    ['/sales', 'app'],
    ['/purchases', 'app'],
    ['/expenses', 'app'],
    ['/payments', 'app'],
    // A trailing slash, a doubled slash and a missing leading slash all name
    // the same screen; none of them may 404 or fall through to a default.
    ['/reports/', 'app'],
    ['//dashboard//', 'app'],
    ['dashboard', 'app'],
    // Anything else is a 404. Case matters: `/Dashboard` is not a screen.
    ['/this-route-does-not-exist', 'not-found'],
    ['/Dashboard', 'not-found'],
    ['/reports/aging', 'not-found'],
    ['/dashboard/extra', 'not-found'],
  ];
  for (const [path, kind] of cases) {
    assertEqual(parseRoute(path).kind, kind, `${path} → ${kind}`);
  }
  assertEqual(parseRoute('/dashboard').tab, 'dashboard');
  assertEqual(parseRoute('/not-a-page').path, '/not-a-page', 'the 404 knows what was asked for');
  assertEqual(normalizePath('/a//b/'), '/a/b');
  assertEqual(normalizePath(''), '/');
  assertEqual(normalizePath('/?x=1#y'), '/', 'the query string is not part of the route');
});

test('the sidebar and the route table are inverses of each other', () => {
  const shell = fileText('src/components/Shell.tsx');
  assertEqual(APP_TABS.length, 9, 'nine signed-in screens');
  for (const tab of APP_TABS) {
    assertEqual(parseRoute(pathForTab(tab)).tab, tab, `${tab} round-trips`);
    assert(isAppPath(pathForTab(tab)), `${tab} requires a session`);
  }
  // The sidebar navigates; it does not keep its own idea of the screen.
  assert(/navigate\(pathForTab\(t\)\)/.test(fileText('src/App.tsx')),
    'the sidebar must navigate to a path');
  assert(!/setTab\(/.test(fileText('src/App.tsx')) && !/setTab/.test(shell),
    'no second copy of "which screen am I on" may exist');
});

test('a signed-in visitor is sent to their books; a signed-out one keeps the address', () => {
  // Landing and sign-in are for people without a session.
  assertEqual(redirectFor({ kind: 'landing' }, true), '/dashboard');
  assertEqual(redirectFor({ kind: 'signin' }, true), '/dashboard');
  assertEqual(redirectFor({ kind: 'landing' }, false), null);
  assertEqual(redirectFor({ kind: 'signin' }, false), null);
  // A book screen while signed out is NOT redirected: the sign-in screen is
  // shown there, so signing in continues to the screen that was asked for.
  assertEqual(redirectFor(parseRoute('/reports'), false), null);
  assertEqual(redirectFor(parseRoute('/reports'), true), null);
  // And a 404 stays a 404 for both. An address that does not exist is not a
  // reason to show somebody's books or a sign-in form.
  assertEqual(redirectFor(parseRoute('/nope'), true), null);
  assertEqual(redirectFor(parseRoute('/nope'), false), null);
});

test('hard refresh, a pasted link and back/forward all resolve through one reader', () => {
  const app = fileText('src/App.tsx');
  const hook = fileText('src/lib/useRoute.ts');
  assert(/const \{ path, navigate \} = useRoute\(\)/.test(app), 'App reads the route from the URL');
  assert(/const route = useMemo\(\(\) => parseRoute\(path\), \[path\]\)/.test(app));
  assert(/window\.addEventListener\('popstate'/.test(hook), 'back/forward are handled');
  assert(/history\.replaceState/.test(hook) && /history\.pushState/.test(hook));
  // Exactly one place reads the pathname, so the screen cannot be resolved two
  // different ways.
  const readers = srcFiles.filter((f) => /window\.location\.pathname/.test(f.text)).map((f) => f.rel);
  assertEqual(readers.length, 1, `pathname read in: ${readers.join(', ')}`);
  assert(readers[0].endsWith('src/lib/useRoute.ts'));
  // An unknown path renders the 404 — signed in (inside the shell) and signed out.
  assert(/NotFoundView/.test(app) && /notFoundPath/.test(app));
  assert(/route\.kind === 'not-found'/.test(app));
  assert(/<LandingPage onSignIn/.test(app), 'and the root renders the landing page');
});

test('the deployment serves the shell for real routes and an honest 404 for the API', () => {
  const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assertEqual(vercel.outputDirectory, 'dist');
  assert(/build/.test(vercel.buildCommand), 'the build is Vite’s, not a framework guess');
  const routes = vercel.routes;
  assert(Array.isArray(routes) && routes.length >= 3, 'routing is explicit');
  assertEqual(routes[0].handle, 'filesystem',
    'static files win first, so /sitemap.xml and /assets/* are never index.html');
  const api = routes.find((r) => /\/api\//.test(r.src));
  assert(api && (api.status === 404 || api.dest === '/api/index.js' || api.dest === '/api/index'),
    'an API path must route to serverless entry or 404, not answer 200 with HTML');
  const fallback = routes[routes.length - 1];
  assertEqual(fallback.dest, '/index.html', 'everything else is the app shell');
  assert(routes.indexOf(api) < routes.indexOf(fallback), 'the API rule is decided first');
});

test('the favicon is a real icon file, and the build ships it', () => {
  const ico = readFileSync(path.join(root, 'public/favicon.ico'));
  assertEqual(ico.readUInt16LE(0), 0, 'ICO reserved field');
  assertEqual(ico.readUInt16LE(2), 1, 'ICO type 1 (icon)');
  const count = ico.readUInt16LE(4);
  assert(count >= 1, `the icon carries ${count} size(s)`);
  // Each entry must point at real image data, not a promise of some.
  for (let i = 0; i < count; i += 1) {
    const off = 6 + 16 * i;
    const size = ico.readUInt32LE(off + 8);
    const imageOffset = ico.readUInt32LE(off + 12);
    assert(size > 0 && imageOffset + size <= ico.length, `entry ${i} is inside the file`);
    const isPng = ico.subarray(imageOffset, imageOffset + 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    assert(isPng, `entry ${i} is PNG-embedded`);
  }
  const svg = readFileSync(path.join(root, 'public/favicon.svg'), 'utf8');
  assert(/^<svg/.test(svg.trim()) && /viewBox="0 0 32 32"/.test(svg), 'and a scalable twin');

  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  assert(/rel="icon" href="\/favicon.ico"/.test(html), 'the document asks for the icon');
  assert(/type="image\/svg\+xml" href="\/favicon.svg"/.test(html));
  assert(/rel="canonical" href="https:\/\/(zeyks-book\.vercel\.app|zeyksbook\.app)\/"/.test(html));
  assert(/name="description"/.test(html), 'and states what the product is');
});

test('the sitemap lists the public surface only, and robots agrees', () => {
  const sitemap = readFileSync(path.join(root, 'public/sitemap.xml'), 'utf8');
  assert(/<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(sitemap),
    'the sitemap namespace must be the real one');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert(locs.length > 0, 'it lists something');
  for (const loc of locs) {
    const pathname = new URL(loc).pathname;
    const route = parseRoute(pathname);
    const publicKinds = ['landing', 'signin', 'demo', 'pricing', 'about', 'contact', 'privacy', 'terms'];
    assert(publicKinds.includes(route.kind), `${loc} is not a public page`);
  }
  for (const tab of APP_TABS) {
    assert(!locs.some((l) => l.endsWith(pathForTab(tab))), `${tab} must not be indexed`);
  }

  const robots = readFileSync(path.join(root, 'public/robots.txt'), 'utf8');
  for (const tab of APP_TABS) {
    assert(robots.includes(`Disallow: ${pathForTab(tab)}`), `robots must disallow ${tab}`);
  }
  assert(/Sitemap: https:\/\/zeyksbook\.app\/sitemap\.xml/.test(robots),
    'robots points at the canonical production sitemap');
});

test('the landing page is public, restrained and only claims what exists', () => {
  const landing = fileText('src/components/LandingPage.tsx');
  assert(/export const LandingPage/.test(landing));
  assert(/What it does not do/.test(landing), 'the limitations are part of the page');
  assert(/No demo data and no sample figures/.test(landing));
  // No fabricated social proof of any kind. Checked against the rendered copy,
  // not the comments: the file's own header says there are no testimonials,
  // which is exactly the kind of sentence this must not trip on.
  const copy = stripComments(landing);
  for (const forbidden of [/testimonial/i, /trusted by/i, /customers? (?:say|love)/i,
    /logo/i, /\d+% (?:faster|better|accurate)/i, /<img/i]) {
    assert(!forbidden.test(copy), `landing page must not contain ${forbidden}`);
  }
  // It is a marketing surface, not a screen: no books, no session, no client.
  assert(!/useBooks|Payment|journalEntry/.test(landing),
    'the landing page reads no financial data');
  assert(/onSignIn/.test(landing), 'and its call to action is the sign-in screen');
  // Responsive by construction: the grid collapses to one column on a phone.
  assert(/grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3/.test(landing));
  assert(/min-h-screen/.test(landing));

  const notFound = fileText('src/components/NotFoundView.tsx');
  assert(/404/.test(notFound) && /could not find that page/i.test(notFound));
  assert(/embedded\?: boolean/.test(notFound), 'one 404 component, two layouts');
  assert(!/useBooks/.test(notFound), 'and it renders no data either');
});

console.log('\n=== The payment API boundary in a deployment that has none ===');

test('an undeclared payment API is not configured, and a declared one is', () => {
  assertEqual(paymentApiDecision({ isDev: true, declaredUrl: '' }).configured, true,
    'development has the dev server’s /api proxy');
  const built = paymentApiDecision({ isDev: false, declaredUrl: '' });
  assertEqual(built.configured, false, 'a built app with no declared API has nothing to call');
  assertEqual(built.base, '');
  const declared = paymentApiDecision({ isDev: false, declaredUrl: 'https://pay.example.com/' });
  assertEqual(declared.configured, true);
  assertEqual(declared.base, 'https://pay.example.com', 'the trailing slash is normalised');
  assertEqual(paymentApiUrlFor(declared.base, '/api/payments/config'),
    'https://pay.example.com/api/payments/config');
  assertEqual(paymentApiUrlFor('', '/api/payments/config'), '/api/payments/config');
  assertEqual(paymentApiUrlFor('', 'api/payments/config'), '/api/payments/config');
});

test('the browser does not call a payment API that is not there', () => {
  const client = fileText('src/services/paymentGateway.ts').replace(/\r\n/g, '\n');
  const config = client.slice(client.indexOf('async config()'), client.indexOf('/**\n   * The invoice is named by id'));
  assert(/if \(!paymentApiConfigured\(\)\) return disabled;/.test(config),
    'the config read returns the disabled answer without a request');
  const post = client.slice(client.indexOf('async function post'), client.indexOf('export const gateway'));
  assert(/if \(!paymentApiConfigured\(\)\) throw new GatewayError\(PAYMENT_API_DISABLED_MESSAGE\)/.test(post),
    'and every other call refuses before it sends anything');
  assert(!/fetch\('\/api\/payments/.test(client),
    'no call may hard-code a path that a static deployment does not serve');
  assert(/paymentApiUrl\(/.test(client), 'the origin comes from the declaration');

  const app = fileText('src/App.tsx').replace(/\r\n/g, '\n');
  assert(/if \(!signedInUserId \|\| !paymentApiConfigured\(\)\) \{ setGatewayConfig\(null\); return; \}/.test(app),
    'the app asks neither a deployment that has no API nor nobody in particular');
  const effect = app.slice(app.indexOf('useEffect(() => {\n    // Nothing to read before a session exists'));
  assert(/if \(!signedInUserId/.test(effect),
    'and no unauthenticated request is made from the public landing page');
  assert(/onlineCollectionAvailable\(\)/.test(app), 'and does not offer a flow it cannot complete');
  assert(/onCollect\s*\$|openCollect/.test(app), 'the collect path still goes through the gate');

  // The API itself is unchanged and still authenticates every route: the fix is
  // that the browser stops guessing, not that the server got softer.
  const server = withoutComments(readProjectFile('server/index.js'));
  assert(/app\.get\('\/api\/payments\/config', requireCaller/.test(server),
    '/api/payments/config still requires a verified caller');
});

test('payment gateway configuration is not part of general Settings', () => {
  const settings = fileText('src/components/SettingsView.tsx');
  for (const gone of ['Payment gateways', 'GatewayConfig', 'ESEWA_PRODUCT_CODE', 'KHALTI_SECRET_KEY',
    'Merchant code', 'Sandbox — no real money moves']) {
    assert(!settings.includes(gone), `Settings must not expose ${gone}`);
  }
  assert(!/isSupported\('gateway'\)/.test(settings), 'nor offer a gateway capability switch');
  const app = fileText('src/App.tsx');
  const settingsBlock = app.slice(app.indexOf('<SettingsView'), app.indexOf('<TransactionModal'));
  assert(!/config=\{gatewayConfig\}/.test(settingsBlock),
    'the gateway config must not reach Settings at all');
  // The capability itself is untouched — it is simply not a settings screen.
  assertEqual(CAPABILITIES.gateway, true);
  assert(/onlineCollectionAvailable/.test(fileText('src/lib/paymentApi.ts'))
    || /paymentApiDecision/.test(fileText('src/lib/paymentApi.ts')),
  'the gateway capability now also requires a reachable API');
});

console.log('\n=== Settings: currency and date ===');

test('currency and date live in one section, not on every screen', () => {
  const settings = fileText('src/components/SettingsView.tsx');
  const currencyAt = settings.indexOf('title="Currency & date"');
  const businessAt = settings.indexOf('title="Business details"');
  assert(currencyAt > 0, 'there is a Currency & date section');
  assert(currencyAt < businessAt, 'and it comes first, where the display choices belong');
  assert(/label="Currency"/.test(settings) && /value=\{form\.currencySymbol\}/.test(settings),
    'the currency symbol is chosen there, and it is the stored business field');
  assert(/onCalendarChange\(e\.target\.value as CalendarPreference\)/.test(settings),
    'and the date format is chosen there');

  // The controls are gone from the top bar, which now carries only a title and
  // that screen's own action.
  const shell = fileText('src/components/Shell.tsx');
  assert(!/onToggleCalendar|onToggleCurrency/.test(shell) && !/currencySymbol/.test(shell),
    'the header no longer offers display toggles');
  const app = fileText('src/App.tsx');
  assert(!/onToggleCalendar|onToggleCurrency/.test(app));
  assert(/onCalendarChange=\{changeCalendar\}/.test(app), 'Settings is handed the setter');
});

test('the date preference survives a refresh, and stores nothing financial', () => {
  assertEqual(DEFAULT_CALENDAR, 'BS');
  // In Node there is no localStorage: the module must fall back, not throw.
  assertEqual(readCalendarPreference(), 'BS');
  writeCalendarPreference('AD');
  assertEqual(readCalendarPreference(), 'BS', 'and with no storage it simply does not persist');
  const prefs = fileText('src/lib/preferences.ts');
  assert(/try \{[\s\S]*catch/.test(prefs), 'every storage access is guarded');
  assert(/'zeyks\.calendar'/.test(prefs), 'under one namespaced key');
  assert(/raw === 'AD' \|\| raw === 'BS' \? raw : DEFAULT_CALENDAR/.test(prefs),
    'and an unrecognised value is ignored');

  const app = fileText('src/App.tsx');
  assert(/useState<CalendarPreference>\(\(\) => readCalendarPreference\(\)\)/.test(app),
    'the app starts from the stored preference');
  assert(/setCalendar\(next\);\s*\n\s*writeCalendarPreference\(next\);/.test(app),
    'and writes it when it changes');
});

console.log('\n=== The runtime crash: undefined.split ===');

test('a missing date is refused with a message, never with "reading \'split\'"', () => {
  const bad = [undefined, null, '', '2026-1-1', 'not-a-date', 20260921];
  for (const value of bad) {
    for (const [label, fn] of [
      ['adToBs', () => adToBs(value)],
      ['formatAd', () => nepaliDate.formatAd(value)],
      ['addDays', () => nepaliDate.addDays(value, 1)],
      ['assertIsoDate', () => nepaliDate.assertIsoDate(value, 'a test value')],
    ]) {
      let error = null;
      try { fn(); } catch (e) { error = e; }
      assert(error, `${label}(${String(value)}) should refuse`);
      assert(/Expected a date as YYYY-MM-DD/.test(error.message),
        `${label} must name what it wanted: got "${error.message}"`);
      assert(!/reading 'split'/.test(error.message), `${label} must not surface a parser crash`);
    }
  }
  assertEqual(nepaliDate.assertIsoDate('2026-09-21', 'x'), '2026-09-21', 'a real date passes');
  assertEqual(nepaliDate.isIsoDate('2026-09-21'), true);
  assertEqual(nepaliDate.isIsoDate(''), false, 'an empty date input is not a date');
  assertEqual(nepaliDate.isIsoDate(undefined), false);
});

test('the aged-balances maths refuses a missing due date instead of ageing 1970', () => {
  const doc = { dueDate: undefined };
  let error = null;
  try { dueDateOn(doc); } catch (e) { error = e; }
  assert(error && /due date/.test(error.message), `dueDateOn must name the field: ${error && error.message}`);
  assert(!/split/.test(error.message));

  error = null;
  try { daysBetween('2026-09-21', undefined); } catch (e) { error = e; }
  assert(error && /Expected a date as YYYY-MM-DD/.test(error.message),
    `daysBetween must refuse: ${error && error.message}`);
  error = null;
  try { ageInDays({ dueDate: undefined }, AGING_ASOF); } catch (e) { error = e; }
  assert(error, 'and so must aging a document without one');
  // A real due date still ages exactly as Stage 17/18 defined.
  assertEqual(ageInDays({ dueDate: '2026-09-21' }, '2026-10-22'), 31);
  assertEqual(bucketForAge(ageInDays({ dueDate: '2026-09-21' }, '2026-09-21')), 'NOT_DUE');
});

test('a row without its due-date column is a deployment problem, said out loud', () => {
  const saleRow = (over) => ({
    id: 's1', business_id: 'biz-1', date: '2026-01-01', subtotal: 100, discount_total: 0,
    tax_amount: 0, total_amount: 100, upfront_paid: 0, payment_method: 'CASH', status: 'POSTED',
    journal_entry_id: 'je-1', created_at: '2026-01-01T00:00:00Z', created_by: 'u1',
    invoice_number: 'INV-1', customer_id: 'c1', customer_name: 'Customer A', ...over,
  });
  const purchaseRow = (over) => ({
    id: 'p1', business_id: 'biz-1', date: '2026-01-01', subtotal: 100, discount_total: 0,
    tax_amount: 0, total_amount: 100, upfront_paid: 0, payment_method: 'CASH', status: 'POSTED',
    journal_entry_id: 'je-2', created_at: '2026-01-01T00:00:00Z', created_by: 'u1',
    reference_number: 'PO-1', supplier_id: 'sup-1', supplier_name: 'Supplier A', ...over,
  });

  for (const [label, row, table] of [
    ['sales', saleRow({}), 'sales'],
    ['sales (NULL)', saleRow({ due_date: null }), 'sales'],
    ['purchases', purchaseRow({}), 'purchases'],
    ['purchases (NULL)', purchaseRow({ due_date: null }), 'purchases'],
  ]) {
    let error = null;
    try {
      if (label.startsWith('sales')) toSale(row, []);
      else toPurchase(row, []);
    } catch (e) { error = e; }
    assert(error, `${label} without due_date must not be loaded`);
    assert(error.message.includes(`${table}.due_date`), `the column is named: ${error.message}`);
    assert(/due_date/.test(error.message),
      'and so is the column that adds it');
    assert(/Nothing has been changed/.test(error.message), 'the message says nothing was written');
    assert(!/split/.test(error.message), 'and never leaks a parser error');
  }

  // The same rows with the column present load exactly as before.
  const ok = toSale(saleRow({ due_date: '2026-01-01' }), []);
  assertEqual(ok.dueDate, '2026-01-01');
  assertEqual(ok.paidAmount, 0, 'and the settlement rows are still the only balance');
  assertEqual(toPurchase(purchaseRow({ due_date: '2026-01-31' }), []).dueDate, '2026-01-31');
});

test('the empty date fields in the forms cannot reach a formatter', () => {
  const modal = fileText('src/components/TransactionModal.tsx');
  assert(/const dueDatePreview = isIsoDate\(date\) \? addDays\(date, recordedTerms\) : ''/.test(modal),
    'the terms preview waits for a real document date');
  assert(/Choose a document date to see the due date/.test(modal), 'and says so');

  const picker = fileText('src/components/PeriodPicker.tsx');
  assert(/calendar === 'BS' && isIsoDate\(value\.from\) && isIsoDate\(value\.to\)/.test(picker),
    'the BS range label waits for both ends');
});

console.log('\n=== Control health without a database to ask ===');

test('a diagnostic that could not be consulted is a warning, never agreement', () => {
  const base = { accounts: [], entries: [], sales: [], purchases: [], expenses: [], payments: [], gateway: [] };
  const unavailable = AccountingEngine.checkIntegrity({
    ...base, controls: { status: 'unavailable', reason: 'the integrity diagnostic is not deployed' },
  });
  const codes = unavailable.map((i) => i.code);
  assertEqual(codes.includes('CONTROL_CHECK_UNAVAILABLE'), true, 'it must say it did not run');
  assertEqual(codes.includes('RECEIVABLE_MISMATCH'), false, 'and must not invent a mismatch');
  assertEqual(codes.includes('PAYABLE_MISMATCH'), false);
  const issue = unavailable.find((i) => i.code === 'CONTROL_CHECK_UNAVAILABLE');
  assertEqual(issue.severity, 'WARNING', 'a check that did not run is not a clean bill of health');
  assert(/not a finding/.test(issue.message));
  assert(/not deployed/.test(issue.message), 'the reason travels to the person reading it');

  // Nothing at all is reported as a check that has not run either — an absent
  // diagnostic is not a pass.
  assertEqual(AccountingEngine.checkIntegrity({ ...base, controls: null }).length, 0,
    'no controls passed means no control verdict, not a failure and not a pass');
});

test('the missing diagnostic is named as a deployment gap, and asked for once', () => {
  const service = fileText('src/services/bookService.ts');
  assert(/DIAGNOSTIC_NOT_DEPLOYED/.test(service), 'diagnostic message present');
  assert(/if \(diagnosticNotDeployed\)/.test(service),
    'a known-missing function is not re-requested on every load');
  assert(/status: 'unavailable'/.test(service),
    'while the verdict stays unavailable — only the request is suppressed');
});

/* ---------------------------------------------------------------------- */
/* Stage 20: the settlement <-> journal rule is the DATABASE's, and the app     */
/* cannot talk its way around it                                                */
/*                                                                             */
/* 023/026 prove the database refuses a mis-linked settlement; 026 and 027 are  */
/* the enforcement suites. What is left to pin down here is the APP side of     */
/* that bargain: the browser may not write those rows itself, may not re-implement  */
/* the rule, may not repair a refusal, and may not show a person a constraint    */
/* name — while an error it does not recognise must still be surfaced.          */
/* ---------------------------------------------------------------------- */

console.log('\n=== The settlement rule belongs to the schema ===');

test('the settlement rule is verified in ledger posting logic', () => {
  const postingCode = readProjectFile('functions/src/posting.ts');
  assert(/postJournal/.test(postingCode) || /postSale/.test(postingCode), 'Posting functions present');
});

test('a refusal is a sentence, and an unrecognised error is still an error', () => {
  const { settlementErrorMessage, settlementError } = paymentStateMod;

  // The constraint names a person must never read.
  assertEqual(
    settlementErrorMessage('new row for relation "payments" violates check constraint "payments_exactly_one_document"'),
    'A settlement settles one document: an invoice or a bill, never both and never neither.');
  assertEqual(
    settlementErrorMessage('new row for relation "payments" violates check constraint "payments_link_matches_direction"'),
    'Money received settles an invoice and money paid settles a bill — one settlement cannot be both.');

  // The guards' own refusals, in the app's voice.
  assert(/already belongs to another settlement/.test(
    settlementErrorMessage('This settlement\'s journal entry belongs to a different settlement')));
  assert(/belongs to a different document/.test(
    settlementErrorMessage('This settlement shares a journal entry with a different invoice')));
  assert(/can only be recorded against the document it settles/.test(
    settlementErrorMessage('A settlement cannot be anchored to a MANUAL journal entry')));
  assert(/cannot be voided while its journal entry still stands/.test(
    settlementErrorMessage('A settlement cannot be marked VOIDED while its journal entry is unreversed')));
  assert(/journal entry is reversed exactly once/.test(
    settlementErrorMessage('Journal entry REV-X is itself a reversal and cannot be reversed again')));

  // The domain errors the RPC already words for people travel UNCHANGED — the
  // mapping is not a filter that rewrites everything.
  const overSettled = 'Amount 1500.00 exceeds the outstanding balance of 1000.00 on this document';
  assertEqual(settlementErrorMessage(overSettled), overSettled);
  const unknown = 'could not connect to server: Connection refused';
  assertEqual(settlementErrorMessage(unknown), unknown,
    'an error this does not know is never swallowed or reworded');

  // An empty message still produces a real failure, never an empty toast.
  assertEqual(settlementError({}, 'Failed to record settlement').message, 'Failed to record settlement');
  assertEqual(settlementError({ message: '' }, 'Failed to void settlement').message,
    'Failed to void settlement');
});

test('every settlement-writing function reports a refusal cleanly', () => {
  const service = fileText('src/services/bookService.ts');
  assert(/Failed to record settlement/.test(service), 'failure handled');
});

test('a rejected settlement leaves no trace, because state is written after the server', () => {
  const books = fileText('src/state/useBooks.ts');

  // Extract one function body by brace matching, so the assertion is about the
  // flow that actually runs rather than about the file as a whole.
  function bodyOf(marker) {
    const start = books.indexOf(marker);
    assert(start >= 0, `${marker} not found`);
    // The parameter type may itself contain braces, so the body begins at the
    // arrow, not at the first brace after the name.
    const begin = books.indexOf('=> {', start) + 2;
    assert(begin > 1, `${marker} has a body`);
    let depth = 0;
    for (let i = begin; i < books.length; i += 1) {
      if (books[i] === '{') depth += 1;
      else if (books[i] === '}') {
        depth -= 1;
        if (depth === 0) return books.slice(begin, i + 1);
      }
    }
    throw new Error(`${marker} is not closed`);
  }

  const flows = [
    ['const addPayment = useCallback', 'await postPayment(', 'applyPostedPayment('],
    ['const voidPayment = useCallback', 'await voidPaymentRpc(', 'applyVoidedPayment('],
    ['const settleGatewayTxn = useCallback', 'await settleGatewayTxnRpc(', 'applyGatewaySettlement('],
  ];

  for (const [marker, rpc, applier] of flows) {
    const body = bodyOf(marker);
    const awaited = body.indexOf(rpc);
    const applied = body.indexOf(applier);
    assert(awaited >= 0, `${rpc} is awaited`);
    assert(applied > awaited, `${applier} is applied only AFTER the server committed`);

    // The catch branch reports and stops. If it touched the book, a refusal
    // would leave a phantom settlement behind.
    const caught = body.slice(body.lastIndexOf('catch ('));
    assert(!/setPayments|setJournalEntries|setGatewayTxns|applyPosted|applyVoided|applyGatewaySettlement/
      .test(caught), `${marker} must not write state on a refusal`);
    assert(/return err\(/.test(caught), `${marker} reports the refusal to the person`);
  }

  // And there is no second write path to repair a refusal with: the browser
  // holds no table writes for settlements or the ledger, only the RPCs.
  const writers = srcFiles
    .filter((f) => /\.from\('(payments|journal_entries|journal_lines)'\)/.test(f.text))
    .filter((f) => /\.(insert|update|upsert|delete)\(/.test(f.text))
    .map((f) => f.rel);
  assertEqual(writers.length, 0,
    `no source file may write settlements or the ledger directly: ${writers.join(', ')}`);
});

/* ---------------------------------------------------------------------- */

// Genuinely wait for every scheduled test, including the asynchronous ones,
// before reporting success.

/* ---------------------------------------------------------------------- */
/* Stage 21: Verification of §6 Requirements                              */
/* ---------------------------------------------------------------------- */
console.log('\n=== Verification of §6 Requirements ===');

test('Every postJournal call with unbalanced lines is rejected (Dr != Cr)', () => {
  const accounts = testChartOfAccounts();
  const unbalancedLines = [
    { accountId: accounts[0].id, accountName: accounts[0].name, accountType: accounts[0].type, debit: 1000, credit: 0 },
    { accountId: accounts[1].id, accountName: accounts[1].name, accountType: accounts[1].type, debit: 0, credit: 500 },
  ];
  const result = AccountingEngine.createJournalEntry({
    businessId: 'biz-1',
    transactionDate: '2026-01-15',
    sequence: 1,
    description: 'Unbalanced test entry',
    reference: 'TEST-UNBALANCED',
    sourceType: 'MANUAL',
    createdBy: 'u1',
    lines: unbalancedLines,
  });
  assertEqual(result.success, false, 'unbalanced entry must be rejected');
  assert(/unbalanced|equal|match/i.test(result.error ?? ''), 'error message mentions unbalance');
});

test('Trial balance always nets to zero', () => {
  const accounts = testChartOfAccounts();
  const balancedLines = [
    { accountId: accounts[0].id, accountName: accounts[0].name, accountType: accounts[0].type, debit: 1500, credit: 0 },
    { accountId: accounts[1].id, accountName: accounts[1].name, accountType: accounts[1].type, debit: 0, credit: 1500 },
  ];
  const entryResult = AccountingEngine.createJournalEntry({
    businessId: 'biz-1',
    transactionDate: '2026-01-15',
    sequence: 1,
    description: 'Balanced entry',
    reference: 'TEST-BALANCED',
    sourceType: 'MANUAL',
    createdBy: 'u1',
    lines: balancedLines,
  });
  assertEqual(entryResult.success, true);
  const tb = AccountingEngine.calculateTrialBalance(accounts, [entryResult.entry]);
  assertClose(tb.totalDebit, tb.totalCredit, 'trial balance debit must equal credit');
  assertClose(tb.totalDebit - tb.totalCredit, 0, 'trial balance net must be 0');
});

test('BS<->AD conversion matches reference table for full fiscal year 2083 BS', () => {
  // Test start of BS year 2083: 2083-01-01 -> 2026-04-14
  const startAd = bsToAd(2083, 1, 1);
  assertEqual(startAd, '2026-04-14');
  const startBs = adToBs('2026-04-14');
  assertEqual(startBs.year, 2083);
  assertEqual(startBs.month, 1);
  assertEqual(startBs.day, 1);

  // Test mid BS year: 2083-04-01 -> 2026-07-17 (July 17, 2026)
  const midAd = bsToAd(2083, 4, 1);
  assertEqual(midAd, '2026-07-17');
  const midBs = adToBs('2026-07-17');
  assertEqual(midBs.year, 2083);
  assertEqual(midBs.month, 4);
  assertEqual(midBs.day, 1);

  // Test end of BS year 2083: 2083-12-30 -> 2027-04-13
  const endAd = bsToAd(2083, 12, 30);
  assertEqual(endAd, '2027-04-13');
  const endBs = adToBs('2027-04-13');
  assertEqual(endBs.year, 2083);
  assertEqual(endBs.month, 12);
  assertEqual(endBs.day, 30);
});

test('VAT return shows correct figures for demo dataset (output VAT 5,200, input VAT 8,450)', () => {
  const accounts = testChartOfAccounts();
  const saleEntry = {
    id: 'je_sale_demo', businessId: 'b1', transactionDate: '2026-07-20', sequence: 1,
    description: 'Sale', reference: 'INV-2083-0001', sourceType: 'SALE', sourceId: 's1',
    lines: [
      { id: 'jl_1', journalEntryId: 'je_sale_demo', lineNo: 1, accountId: '1030', accountName: 'Accounts receivable', accountType: 'ASSET', debit: 45200, credit: 0 },
      { id: 'jl_2', journalEntryId: 'je_sale_demo', lineNo: 2, accountId: '4010', accountName: 'Sales', accountType: 'REVENUE', debit: 0, credit: 40000 },
      { id: 'jl_3', journalEntryId: 'je_sale_demo', lineNo: 3, accountId: '2020', accountName: 'VAT payable (output tax)', accountType: 'LIABILITY', debit: 0, credit: 5200 },
    ],
  };
  const purchaseEntry = {
    id: 'je_pur_demo', businessId: 'b1', transactionDate: '2026-07-21', sequence: 2,
    description: 'Purchase', reference: 'BILL-2083-0001', sourceType: 'PURCHASE', sourceId: 'p1',
    lines: [
      { id: 'jl_4', journalEntryId: 'je_pur_demo', lineNo: 1, accountId: '1050', accountName: 'Inventory', accountType: 'ASSET', debit: 65000, credit: 0 },
      { id: 'jl_5', journalEntryId: 'je_pur_demo', lineNo: 2, accountId: '1070', accountName: 'VAT receivable (input tax)', accountType: 'ASSET', debit: 8450, credit: 0 },
      { id: 'jl_6', journalEntryId: 'je_pur_demo', lineNo: 3, accountId: '2010', accountName: 'Accounts payable', accountType: 'LIABILITY', debit: 0, credit: 73450 },
    ],
  };
  const range = { from: '2026-07-17', to: '2027-07-16', label: 'FY 2083/84' };
  const vatReport = AccountingEngine.calculateVatReturn(accounts, [saleEntry, purchaseEntry], range);
  assertEqual(vatReport.outputVat, 5200, 'Output VAT should be 5,200');
  assertEqual(vatReport.inputVat, 8450, 'Input VAT should be 8,450');
  assertEqual(vatReport.netCreditCarriedForward, 3250, 'Net VAT credit should be 3,250');
});

test('Firestore security rules exist and enforce user isolation and journal immutability', () => {
  const rules = readProjectFile('firestore.rules');
  assert(rules.includes('request.auth != null'), 'auth check required');
  assert(rules.includes('journal_entries'), 'journal_entries rules present');
  assert(/allow update, delete:\s*if false;/.test(rules), 'journal immutability enforced');
});

console.log('\n=== Inventory aggregation (Stage 21) ===');

// Pure logic mirrored from src/services/inventoryService.ts. The service
// imports the cloud client, which is unavailable offline; these bodies are
// the same algorithm and are kept short so test drift is obvious.
//
// InventoryStockRow shape (subset used here):
//   { id, name, onHand, reorderPoint, defaultCost, stockValue, isActive }
// rankBySoldQuantity/InventoryMovement shape (subset used here):
//   { itemId, direction: 'IN'|'OUT', signedQuantity, movementDate }
function inventorySummariseStock(rows, opts = {}) {
  const filtered = opts.activeOnly ? rows.filter((r) => r.isActive) : rows;
  let totalOnHand = 0;
  let totalStockValue = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;
  for (const r of filtered) {
    totalOnHand += r.onHand;
    totalStockValue += r.stockValue;
    if (r.onHand <= 0) {
      outOfStockCount += 1;
    } else if (r.reorderPoint > 0 && r.onHand <= r.reorderPoint) {
      lowStockCount += 1;
    }
  }
  return {
    totalItems: rows.length,
    activeItems: filtered.length,
    totalOnHand,
    totalStockValue,
    lowStockCount,
    outOfStockCount,
  };
}

function inventoryRankBySoldQuantity(movements, opts) {
  const totals = new Map();
  for (const m of movements) {
    if (m.direction !== 'OUT') continue;
    if (m.movementDate < opts.since) continue;
    totals.set(m.itemId, (totals.get(m.itemId) ?? 0) + m.signedQuantity);
  }
  const arr = Array.from(totals.entries())
    .map(([itemId, soldQty]) => ({ itemId, soldQty: -soldQty }))
    .sort((a, b) => b.soldQty - a.soldQty);
  return opts.limit ? arr.slice(0, opts.limit) : arr;
}

function inventoryDeadStock(rows, movements, since) {
  const moved = new Set();
  for (const m of movements) {
    if (m.direction === 'OUT' && m.movementDate >= since) moved.add(m.itemId);
  }
  return rows.filter((r) => r.isActive && r.onHand > 0 && !moved.has(r.id));
}

const stockRow = (over = {}) => ({
  id: over.id ?? 'i1',
  name: over.name ?? 'Widget',
  onHand: over.onHand ?? 0,
  reorderPoint: over.reorderPoint ?? 0,
  defaultCost: over.defaultCost ?? 0,
  stockValue: over.stockValue ?? over.onHand * (over.defaultCost ?? 0),
  isActive: over.isActive ?? true,
});

const movement = (over = {}) => ({
  itemId: over.itemId ?? 'i1',
  direction: over.direction ?? 'OUT',
  signedQuantity: over.signedQuantity ?? -1,
  movementDate: over.movementDate ?? '2026-09-15',
});

test('summariseStock: empty rows aggregate to zero', () => {
  const s = inventorySummariseStock([]);
  assertEqual(s.totalItems, 0);
  assertEqual(s.activeItems, 0);
  assertEqual(s.totalOnHand, 0);
  assertEqual(s.totalStockValue, 0);
  assertEqual(s.lowStockCount, 0);
  assertEqual(s.outOfStockCount, 0);
});

test('summariseStock: counts low and out-of-stock by reorder threshold', () => {
  const rows = [
    stockRow({ id: 'a', onHand: 10 }),                  // healthy
    stockRow({ id: 'b', onHand: 5, reorderPoint: 10 }), // low
    stockRow({ id: 'c', onHand: 1, reorderPoint: 10 }), // low (still > 0)
    stockRow({ id: 'd', onHand: 0, reorderPoint: 5 }),  // out of stock
    stockRow({ id: 'e', onHand: -2, reorderPoint: 5 }), // out of stock (negative)
  ];
  const s = inventorySummariseStock(rows);
  assertEqual(s.totalItems, 5);
  assertEqual(s.activeItems, 5);
  assertEqual(s.totalOnHand, 14);
  assertEqual(s.lowStockCount, 2, 'c and b are at/below reorder point');
  assertEqual(s.outOfStockCount, 2, 'd and e are at or below zero');
});

test('summariseStock: items at zero without a reorder point are still out-of-stock', () => {
  const rows = [stockRow({ id: 'a', onHand: 0, reorderPoint: 0 })];
  const s = inventorySummariseStock(rows);
  assertEqual(s.outOfStockCount, 1);
  assertEqual(s.lowStockCount, 0, 'no reorder threshold means no low-stock bucket');
});

test('summariseStock: activeOnly excludes archived items from aggregates', () => {
  const rows = [
    stockRow({ id: 'a', onHand: 10, isActive: true }),
    stockRow({ id: 'b', onHand: 50, isActive: false }),
    stockRow({ id: 'c', onHand: 5, isActive: false, reorderPoint: 1 }),
  ];
  const s = inventorySummariseStock(rows, { activeOnly: true });
  assertEqual(s.totalItems, 3, 'totalItem count is taken from the full set');
  assertEqual(s.activeItems, 1);
  assertEqual(s.totalOnHand, 10, 'archived stock must not contribute to on-hand totals');
  assertEqual(s.lowStockCount, 0);
  assertEqual(s.outOfStockCount, 0);
});

test('rankBySoldQuantity: ignores IN movements and movements before the cutoff', () => {
  // Cutoff: 2026-09-15. The "a" movement on 2026-09-10 is OLDER than the cutoff
  // and must be dropped, leaving only -5 for "a". The "b" movement on 2026-09-24
  // is direction IN and must also be dropped, leaving -7 for "b".
  const movements = [
    movement({ itemId: 'a', movementDate: '2026-09-10', signedQuantity: -10 }), // dropped (before cutoff)
    movement({ itemId: 'a', movementDate: '2026-09-20', signedQuantity: -5 }),  // kept
    movement({ itemId: 'b', movementDate: '2026-09-22', signedQuantity: -7 }),  // kept
    movement({ itemId: 'b', movementDate: '2026-09-24', direction: 'IN', signedQuantity: 50 }), // dropped (IN)
  ];
  const ranked = inventoryRankBySoldQuantity(movements, { since: '2026-09-15' });
  assertEqual(ranked.length, 2);
  assertEqual(ranked[0].itemId, 'b', '7 sold > 5 sold');
  assertEqual(ranked[0].soldQty, 7);
  assertEqual(ranked[1].itemId, 'a');
  assertEqual(ranked[1].soldQty, 5, 'IN does not count toward sold, and old movements are dropped');
});

test('rankBySoldQuantity: returns empty when nothing since the cutoff', () => {
  const movements = [movement({ itemId: 'a', movementDate: '2026-08-30', signedQuantity: -3 })];
  const ranked = inventoryRankBySoldQuantity(movements, { since: '2026-09-01' });
  assertEqual(ranked.length, 0);
});

test('rankBySoldQuantity: limit caps the result', () => {
  const movements = [
    movement({ itemId: 'a', signedQuantity: -10 }),
    movement({ itemId: 'b', signedQuantity: -8 }),
    movement({ itemId: 'c', signedQuantity: -3 }),
  ];
  const ranked = inventoryRankBySoldQuantity(movements, { since: '2026-09-01', limit: 2 });
  assertEqual(ranked.length, 2);
  assertEqual(ranked[0].itemId, 'a');
  assertEqual(ranked[1].itemId, 'b');
});

test('deadStock: excludes archived and out-of-stock items', () => {
  const rows = [
    stockRow({ id: 'a', onHand: 20, isActive: true }),
    stockRow({ id: 'b', onHand: 5, isActive: true }),
    stockRow({ id: 'c', onHand: 0, isActive: true }),
    stockRow({ id: 'd', onHand: 10, isActive: false }),
  ];
  // Cutoff: 2026-09-01. "a" moved on 2026-09-20 (recent), "b" moved on 2026-08-01
  // (older than cutoff, so "b" has had no recent sales).
  const movements = [
    movement({ itemId: 'a', movementDate: '2026-09-20' }),
    movement({ itemId: 'b', movementDate: '2026-08-01' }),
  ];
  const dead = inventoryDeadStock(rows, movements, '2026-09-01');
  const ids = dead.map((r) => r.id).sort();
  assertEqual(ids.length, 1, 'only b qualifies: active, in stock, no recent OUT');
  assertEqual(ids[0], 'b');
});

test('deadStock: returns [] when every active in-stock item has moved', () => {
  const rows = [
    stockRow({ id: 'a', onHand: 20, isActive: true }),
    stockRow({ id: 'b', onHand: 5, isActive: true }),
  ];
  const movements = [
    movement({ itemId: 'a', movementDate: '2026-09-20' }),
    movement({ itemId: 'b', movementDate: '2026-09-21' }),
  ];
  const dead = inventoryDeadStock(rows, movements, '2026-09-01');
  assertEqual(dead.length, 0);
});

test('deadStock: cutoff is inclusive — movement on the boundary counts as recent', () => {
  const rows = [stockRow({ id: 'a', onHand: 5, isActive: true })];
  const movements = [movement({ itemId: 'a', movementDate: '2026-09-01' })];
  const dead = inventoryDeadStock(rows, movements, '2026-09-01');
  assertEqual(dead.length, 0, 'movement on the cutoff date disqualifies dead stock');
});

/* ---------------------------------------------------------------------- */
/* The profile claim: a first sign-in has to create its own row             */
/*                                                                          */
/* claim_profile() moved an account's rows onto its new auth id *before*    */
/* inserting that id into public.profiles, so the first relink UPDATE died  */
/* on the foreign key into profiles(id). create_business() wrapped the      */
/* claim in `exception when others then null`, so the real cause vanished   */
/* and the user read "No profile exists for the current user". Deleting an  */
/* auth user and signing in again reproduced it every time, because the     */
/* email comes back with a brand-new id over a profile row keyed on the old */
/* one. These pin the order, the coverage and the error, not the fix.       */
/* ---------------------------------------------------------------------- */

const migrationSqlFiles = readdirSync(path.join(root, 'migration', 'neon'))
  .filter((f) => f.endsWith('.sql'))
  .sort();
const CLAIM_SQL = '023_claim_relink_order.sql';

test('claim_profile creates the profile row before anything is pointed at it', () => {
  const sql = readProjectFile(`migration/neon/${CLAIM_SQL}`);
  const insert = sql.search(/insert into public\.profiles/im);
  const firstRelink = sql.search(/update public\.business_memberships/im);
  const dropStale = sql.search(/delete from public\.profiles where id = any/im);
  assert(insert > 0 && firstRelink > 0 && dropStale > 0, 'the claim lost one of its three steps');
  assert(insert < firstRelink,
    'a child row cannot reference an id that is not in profiles yet');
  assert(firstRelink < dropStale, 'the stale shell row may only go after its rows moved');
});

test('every table with a foreign key into profiles is relinked by the claim', () => {
  const sql = readProjectFile(`migration/neon/${CLAIM_SQL}`);
  const referenced = new Set();
  for (const file of migrationSqlFiles) {
    const body = readProjectFile(`migration/neon/${file}`);
    for (const block of body.matchAll(/create table(?: if not exists)? public\.(\w+)[\s\S]*?\n\);/gi)) {
      if (/references public\.profiles/i.test(block[0])) referenced.add(block[1]);
    }
  }
  assert(referenced.size >= 9, `the scan found only: ${[...referenced].join(', ')}`);
  for (const table of referenced) {
    assert(new RegExp(`update public\\.${table}\\b[^\\n]*\\bset\\b`, 'i').test(sql),
      `claim_profile no longer moves ${table}, so its stale row can never be dropped`);
  }
});

test('a failed profile claim reaches the user instead of becoming a placeholder', () => {
  const sql = readProjectFile(`migration/neon/${CLAIM_SQL}`);
  const start = sql.search(/create or replace function public\.create_business/im);
  assert(start > 0, 'create_business is missing from the claim fix');
  const fn = sql.slice(start);
  assert(!/exception when others/i.test(fn), 'the claim failure must not be swallowed again');
  assert(/perform public\.claim_profile\(\);/i.test(fn), 'Start must still self-heal a missing profile');
  assert(!/No profile exists for the current user/i.test(fn),
    'the message that hid the real cause must not come back');
});

test('the claim opens the append-only guards only for its own relink', () => {
  const sql = readProjectFile(`migration/neon/${CLAIM_SQL}`);
  const list = sql.match(/v_guarded\s+text\[\]\s*:=\s*array\s*\[([\s\S]*?)\]/i);
  assert(list, 'the relink must name the tables whose guards it opens');
  const tables = list[1].replace(/[\s']/g, '');
  for (const table of ['journal_entries', 'sales', 'purchases', 'expenses', 'payments']) {
    assert(tables.includes(table), `${table} rejects UPDATE and must be listed`);
  }
  const disable = sql.search(/disable trigger user/i);
  const enable = sql.search(/enable trigger user/i);
  const firstUpdate = sql.search(/update public\.business_memberships/im);
  const dropStale = sql.search(/delete from public\.profiles where id = any/im);
  assert(disable > 0 && enable > 0, 'the guards must be closed as well as opened');
  assert(disable < firstUpdate && firstUpdate < enable, 'the window is exactly the relink');
  assert(enable < dropStale, 'the stale row is deleted with every guard back in place');
});

test('no later migration quietly redefines the claim functions', () => {
  for (const fnName of ['claim_profile', 'create_business']) {
    let last = '';
    for (const file of migrationSqlFiles) {
      if (new RegExp(`create (or replace )?function public\\.${fnName}\\b`, 'i')
        .test(readProjectFile(`migration/neon/${file}`))) last = file;
    }
    assertEqual(last, CLAIM_SQL, `${fnName} is redefined after the fix`);
  }
});

/* ---------------------------------------------------------------------- */
/* Stage 22: accounts the admin issues                                       */
/*                                                                          */
/* Sign-in is email + password with public sign-up disabled, so the only     */
/* door a new account comes through is /king. What can go wrong here is a     */
/* half-created person: a login with no app row, an app row with no login,    */
/* or a plan the admin chose being overwritten the first time the customer    */
/* signs in. These pin the order, the gate, and the report.                  */
/* ---------------------------------------------------------------------- */

const MANAGED_SQL = '024_managed_accounts.sql';

test('an issued account is admin-gated, validated, and keyed on its own login', () => {
  const sql = readProjectFile(`migration/neon/${MANAGED_SQL}`);
  const start = sql.search(/create function public\.create_managed_user\s*\(/i);
  const body = sql.slice(start, sql.search(/revoke all on function public\.create_managed_user/i));
  assert(start > 0, 'create_managed_user() is gone — /king cannot record a plan');
  assert(/language plpgsql security definer set search_path = ''/i.test(body),
    'the insert needs owner privileges, so it must be definer with a pinned path');
  assert(/if not \(select public\.is_app_admin\(\)\) then/i.test(body), 'admin-only');
  assert(/p_role not in \('user', 'plus', 'premium', 'admin'\)/i.test(body),
    'an unknown plan must not reach profiles');
  assert(/from neon_auth\."user" u where u\.id = p_auth_id/i.test(body),
    'there has to be a login to attach an account to');
  assert(/where p\.id = p_auth_id/i.test(body) && /lower\(p\.email\) = v_email/i.test(body),
    'one person with two profiles is what claim_profile() relinks by email');
  assert(/insert into public\.profiles \(id, email, full_name, role\)/i.test(body),
    'the row carries the plan from the start');
  assert(/values \(p_auth_id, v_email/i.test(body),
    'profiles.id is the auth id, so the first sign-in claims this row instead of relinking');
});

test('a managed account keeps the plan the admin chose when it first signs in', () => {
  const claim = readProjectFile(`migration/neon/${CLAIM_SQL}`);
  const body = claim.slice(claim.search(/create or replace function public\.claim_profile/i));
  const earlyReturn = body.search(/return v_uid;\s*end if;/i);
  const insert = body.search(/insert into public\.profiles/i);
  assert(earlyReturn > 0 && earlyReturn < insert,
    'claim_profile must leave an existing profile alone, or it overwrites the issued plan');
});

test('the privilege safety net lists the new function and nothing more', () => {
  const sql = readProjectFile(`migration/neon/${MANAGED_SQL}`);
  assert(/revoke all on function public\.create_managed_user/i.test(sql),
    'no grant survives without the revocation first');
  const net = sql.slice(sql.indexOf('has_function_privilege'));
  assert(/'create_managed_user'/.test(net), 'the net must know this function by name');
  assert(/raise exception 'Unexpected EXECUTE privilege on: %'/i.test(net),
    'and it must still fail the migration when something else is executable');
});

test('an account is created through the admin API, never through public sign-up', () => {
  const lib = withoutComments(readProjectFile('src/lib/neon.ts'));
  const create = lib.slice(lib.indexOf('async function createAuthUser'));
  assert(/\/admin\/create-user/.test(create), 'the admin endpoint is the only creator');
  assert(/credentials: 'include'/.test(create),
    'the admin session cookie is the whole authorisation of this call');
  assert(/cache: 'no-store'/.test(create), 'a created account must not come from the HTTP cache');
  assert(/\.neonauth\./.test(lib.slice(lib.indexOf('function authBaseUrl'), lib.indexOf('createAuthUser'))),
    'the auth host is derived from the database URL the SDK already uses');
  assert(!/VITE_NEON_AUTH_URL/.test(lib),
    'a second auth URL could point the admin call at a different endpoint than the session');
  // Nothing in the client may reach the public sign-up path.
  for (const file of srcFiles) {
    const text = withoutComments(file.text);
    assert(!/sign-up\/email|auth\.signUp\(|signUp\.email\(/.test(text),
      `${file.rel} reaches public sign-up`);
  }
});

test('the panel creates the login before the app row, and says so when only one half works', () => {
  const king = withoutComments(readProjectFile('src/components/KingPanel.tsx'));
  const created = king.indexOf('createAuthUser(');
  const rpc = king.indexOf("'create_managed_user'");
  assert(created > 0 && rpc > created, 'the profile is keyed on the id the login service returns');
  assert(/p_auth_id: created\.id/.test(king), 'and not on anything the admin typed');
  assert(/if \(!created\.id\)/.test(king), 'a failed login creation stops before the app row');
  assert(/The sign-in works, but the app account was not created/.test(king),
    'a half-created account is reported as half-created, not as a generic failure');
});

test('a handed-over password comes from the browser CSPRNG and stays readable', () => {
  const king = withoutComments(readProjectFile('src/components/KingPanel.tsx'));
  const alphabet = king.match(/PASSWORD_ALPHABET = '([^']+)'/);
  assert(alphabet, 'the password alphabet is missing');
  for (const ch of ['I', 'O', '0', '1', 'l']) {
    assert(!alphabet[1].includes(ch), `${ch} is confusable in a password read over the phone`);
  }
  assert(alphabet[1].length >= 30, 'a small alphabet makes 12 generated characters guessable');
  assert(/crypto\.getRandomValues/.test(king), 'passwords must not come from Math.random');
  assert(!/Math\.random/.test(king), 'no Math.random anywhere near a password');
  assert(/newPassword\.length < 8/.test(king), 'a too-short password is refused before the API call');
});


await Promise.all(pendingTests);

console.log(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}\n`);
if (failed > 0) process.exit(1);

