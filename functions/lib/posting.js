"use strict";
/**
 * Zeyks Book — posting engine on Cloud Functions / Firestore.
 *
 * The one rule this module exists to enforce: **every document writes balanced
 * journal lines, inside the same transaction that writes the document.** No
 * client path writes to `journals` — the Firestore rules forbid it — so the
 * only way a figure enters the ledger is through here, where:
 *
 *   * debits must equal credits to the paisa (round2, < 0.005 tolerance),
 *   * every line names an account in the business's chart of accounts,
 *   * the entry's date falls inside an OPEN fiscal year,
 *   * document numbers and the journal sequence are allocated atomically from
 *     `sequences/{name}` counters,
 *   * a void posts a mirror-image reversal entry instead of deleting anything.
 *
 * Field names mirror the Postgres snake_case the client's mappers already
 * speak, so the client cutover reuses them with minimal translation.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeFiscalYear = exports.seedChartIfEmpty = exports.voidDocument = exports.postJournal = exports.ACCOUNT_CODES = void 0;
exports.seedChartOfAccounts = seedChartOfAccounts;
const https_1 = require("firebase-functions/v2/https");
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const logger = __importStar(require("firebase-functions/logger"));
(0, app_1.initializeApp)();
const db = (0, firestore_1.getFirestore)();
/* -------------------------------------------------------------------------- */
/* Chart of accounts                                                          */
/* -------------------------------------------------------------------------- */
exports.ACCOUNT_CODES = {
    CASH: '1010', BANK: '1020', RECEIVABLE: '1030', ESEWA: '1040', KHALTI: '1050',
    INVENTORY: '1060', VAT_RECEIVABLE: '1070', PAYABLE: '2010', VAT_PAYABLE: '2020',
    CAPITAL: '3010', RETAINED: '3020', SALES: '4010', COGS: '5010',
};
/** The starter chart, identical to what the Postgres path seeded. */
const CHART = [
    { code: exports.ACCOUNT_CODES.CASH, name: 'Cash in hand', type: 'ASSET', system: true },
    { code: exports.ACCOUNT_CODES.BANK, name: 'Bank account', type: 'ASSET', system: true },
    { code: exports.ACCOUNT_CODES.RECEIVABLE, name: 'Accounts receivable', type: 'ASSET', system: true },
    { code: exports.ACCOUNT_CODES.ESEWA, name: 'eSewa wallet', type: 'ASSET', system: false },
    { code: exports.ACCOUNT_CODES.KHALTI, name: 'Khalti wallet', type: 'ASSET', system: false },
    { code: exports.ACCOUNT_CODES.INVENTORY, name: 'Inventory', type: 'ASSET', system: true },
    { code: exports.ACCOUNT_CODES.VAT_RECEIVABLE, name: 'VAT receivable (input tax)', type: 'ASSET', system: true },
    { code: exports.ACCOUNT_CODES.PAYABLE, name: 'Accounts payable', type: 'LIABILITY', system: true },
    { code: exports.ACCOUNT_CODES.VAT_PAYABLE, name: 'VAT payable (output tax)', type: 'LIABILITY', system: true },
    { code: exports.ACCOUNT_CODES.CAPITAL, name: 'Owner capital', type: 'EQUITY', system: true },
    { code: exports.ACCOUNT_CODES.RETAINED, name: 'Retained earnings', type: 'EQUITY', system: true },
    { code: exports.ACCOUNT_CODES.SALES, name: 'Sales revenue', type: 'REVENUE', system: true },
    { code: exports.ACCOUNT_CODES.COGS, name: 'Cost of goods sold', type: 'EXPENSE', system: true },
];
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Same rules as AccountingEngine.createJournalEntry: the balanced-entry gate. */
function validateBalanced(lines) {
    if (lines.length < 2)
        throw new https_1.HttpsError('invalid-argument', 'A journal entry needs at least two lines carrying a value.');
    for (const l of lines) {
        if (l.debit < 0 || l.credit < 0)
            throw new https_1.HttpsError('invalid-argument', 'Negative amounts are not allowed on a journal line. Post a reversing entry instead.');
        if (l.debit > 0 && l.credit > 0)
            throw new https_1.HttpsError('invalid-argument', `${l.account_name} carries both a debit and a credit. Split it into two lines.`);
    }
    const dr = round2(lines.reduce((s, l) => s + l.debit, 0));
    const cr = round2(lines.reduce((s, l) => s + l.credit, 0));
    if (Math.abs(dr - cr) >= 0.005) {
        throw new https_1.HttpsError('failed-precondition', `Entry rejected: debits of NPR ${dr.toFixed(2)} do not equal credits of NPR ${cr.toFixed(2)}. Out by NPR ${Math.abs(dr - cr).toFixed(2)}.`);
    }
}
/** The settlement account a payment method lands in. */
function settlementCode(method) {
    switch (method) {
        case 'CASH': return exports.ACCOUNT_CODES.CASH;
        case 'ESEWA': return exports.ACCOUNT_CODES.ESEWA;
        case 'KHALTI': return exports.ACCOUNT_CODES.KHALTI;
        case 'BANK':
        default: return exports.ACCOUNT_CODES.BANK;
    }
}
/**
 * Build the journal lines a source document implies. Pure: it touches no
 * database state, so the caller can validate before entering the transaction.
 */
function buildLines(kind, doc, business, accountsByCode) {
    const requireAcc = (code) => {
        const acc = accountsByCode.get(code);
        if (!acc)
            throw new https_1.HttpsError('failed-precondition', `Account ${code} is missing from your chart of accounts.`);
        return acc;
    };
    const line = (code, debit, credit) => {
        const acc = requireAcc(code);
        return { account_id: acc.id, account_name: acc.name, account_type: acc.type, debit: round2(debit), credit: round2(credit) };
    };
    const vatRegistered = Boolean(business.vat_registered);
    const lines = [];
    if (kind === 'SALE') {
        const total = round2(Number(doc.total_amount));
        const tax = vatRegistered ? round2(Number(doc.tax_amount)) : 0;
        const settledNow = round2(Number(doc.settled_now ?? 0));
        const onCredit = round2(total - settledNow);
        const net = round2(total - tax);
        if (settledNow > 0)
            lines.push(line(settlementCode(String(doc.payment_method ?? 'CASH')), settledNow, 0));
        if (onCredit > 0)
            lines.push(line(exports.ACCOUNT_CODES.RECEIVABLE, onCredit, 0));
        lines.push(line(exports.ACCOUNT_CODES.SALES, 0, net));
        if (tax > 0)
            lines.push(line(exports.ACCOUNT_CODES.VAT_PAYABLE, 0, tax));
        if (business.track_inventory && Number(doc.cost_of_goods) > 0) {
            lines.push(line(exports.ACCOUNT_CODES.COGS, Number(doc.cost_of_goods), 0));
            lines.push(line(exports.ACCOUNT_CODES.INVENTORY, 0, Number(doc.cost_of_goods)));
        }
    }
    else if (kind === 'PURCHASE') {
        const total = round2(Number(doc.total_amount));
        const tax = vatRegistered ? round2(Number(doc.tax_amount)) : 0;
        const settledNow = round2(Number(doc.settled_now ?? 0));
        const onCredit = round2(total - settledNow);
        const net = round2(total - tax);
        const assetCode = business.track_inventory ? exports.ACCOUNT_CODES.INVENTORY : exports.ACCOUNT_CODES.COGS;
        lines.push(line(assetCode, net, 0));
        if (tax > 0)
            lines.push(line(exports.ACCOUNT_CODES.VAT_RECEIVABLE, tax, 0));
        if (settledNow > 0)
            lines.push(line(settlementCode(String(doc.payment_method ?? 'BANK')), 0, settledNow));
        if (onCredit > 0)
            lines.push(line(exports.ACCOUNT_CODES.PAYABLE, 0, onCredit));
    }
    else if (kind === 'EXPENSE') {
        const total = round2(Number(doc.amount));
        const tax = vatRegistered ? round2(Number(doc.tax_amount)) : 0;
        lines.push(line(String(doc.category_account_code ?? exports.ACCOUNT_CODES.COGS), round2(total - tax), 0));
        if (tax > 0)
            lines.push(line(exports.ACCOUNT_CODES.VAT_RECEIVABLE, tax, 0));
        lines.push(line(settlementCode(String(doc.payment_method ?? 'CASH')), 0, total));
    }
    else { // PAYMENT — a settlement against an invoice or bill
        const amount = round2(Number(doc.amount));
        const direction = String(doc.direction); // 'INCOMING' settles a receivable, 'OUTGOING' a payable
        if (direction === 'INCOMING') {
            lines.push(line(settlementCode(String(doc.payment_method ?? 'CASH')), amount, 0));
            lines.push(line(exports.ACCOUNT_CODES.RECEIVABLE, 0, amount));
        }
        else {
            lines.push(line(exports.ACCOUNT_CODES.PAYABLE, amount, 0));
            lines.push(line(settlementCode(String(doc.payment_method ?? 'BANK')), 0, amount));
        }
    }
    return lines;
}
/** Inside a transaction: allocate the next integer from a named counter. */
async function nextCounter(tx, businessId, name) {
    const ref = db.collection('businesses').doc(businessId).collection('sequences').doc(name);
    const snap = await tx.get(ref);
    const next = Number(snap.data()?.value ?? 0) + 1;
    tx.set(ref, { value: next }, { merge: true });
    return next;
}
/** Document-number format: INV-20260101-0142 (kind prefix, ISO date, counter) —
 *  the same shape the app's reference generator has always issued. */
function documentNumber(prefix, dateIso, n) {
    return `${prefix}-${dateIso.replace(/-/g, '')}-${String(n).padStart(3, '0')}`;
}
/** Refuse to post into a closed fiscal year when the business declares them. */
async function assertFiscalYearOpen(tx, businessId, dateIso) {
    const snap = await tx.get(db.collection('businesses').doc(businessId).collection('fiscalYears')
        .where('status', '==', 'CLOSED').where('start_ad', '<=', dateIso).where('end_ad', '>=', dateIso));
    if (!snap.empty) {
        const fy = snap.docs[0].id;
        throw new https_1.HttpsError('failed-precondition', `Fiscal year ${fy} is closed; ${dateIso} can no longer be posted into it.`);
    }
}
/** The settlement a caller claims for this document, clamped to a sane number. */
function settledNowOf(document) {
    const raw = Number(document.settled_now ?? document.upfront_paid ?? 0);
    return Number.isFinite(raw) && raw > 0 ? round2(raw) : 0;
}
async function accountsByCode(businessId) {
    const snap = await db.collection('businesses').doc(businessId).collection('accounts').get();
    const map = new Map();
    for (const d of snap.docs) {
        const a = d.data();
        map.set(a.code, { id: d.id, name: a.name, type: a.type });
    }
    return map;
}
async function businessDoc(businessId) {
    const snap = await db.collection('businesses').doc(businessId).get();
    if (!snap.exists)
        throw new https_1.HttpsError('not-found', 'That business does not exist.');
    return snap.data();
}
exports.postJournal = (0, https_1.onCall)(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new https_1.HttpsError('unauthenticated', 'Sign in to record transactions.');
    const { business_id: businessId, kind, document } = request.data ?? {};
    if (!businessId || !kind || typeof document !== 'object') {
        throw new https_1.HttpsError('invalid-argument', 'A business, a document kind and the document itself are required.');
    }
    const membership = await db.collection('businessMemberships').doc(`${uid}_${businessId}`).get();
    if (!membership.exists)
        throw new https_1.HttpsError('permission-denied', 'You are not a member of this business.');
    const business = await businessDoc(businessId);
    const accounts = await accountsByCode(businessId);
    const dateIso = String(document.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
        throw new https_1.HttpsError('invalid-argument', 'The document date must be an ISO YYYY-MM-DD date.');
    }
    validateBalanced(buildLines(kind, document, business, accounts));
    const prefixes = { SALE: 'INV', PURCHASE: 'BILL', EXPENSE: 'VCH', PAYMENT: 'RCT' };
    const collections = { SALE: 'sales', PURCHASE: 'purchases', EXPENSE: 'expenses', PAYMENT: 'payments' };
    return db.runTransaction(async (tx) => {
        await assertFiscalYearOpen(tx, businessId, dateIso);
        const counter = await nextCounter(tx, businessId, `${prefixes[kind]}_${dateIso}`);
        const number = documentNumber(prefixes[kind], dateIso, counter);
        const docRef = db.collection('businesses').doc(businessId).collection(collections[kind]).doc();
        const entryId = `je_${docRef.id}`;
        const lines = buildLines(kind, document, business, accounts)
            .map((l, i) => ({ ...l, id: `${entryId}_L${i + 1}`, journal_entry_id: entryId, line_no: i + 1 }));
        const seq = await nextCounter(tx, businessId, 'journal_sequence');
        // Credit terms derive the due date inside the posting transaction, exactly
        // as post_sale/post_purchase did: the client sends terms, never a date.
        const termsDays = Math.max(0, Math.round(Number(document.payment_terms_days ?? 0)));
        const [y, m, d] = dateIso.split('-').map(Number);
        const dueDate = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
        dueDate.setUTCDate(dueDate.getUTCDate() + termsDays);
        const dueDateIso = dueDate.toISOString().slice(0, 10);
        const documentRow = {
            ...document,
            id: docRef.id,
            business_id: businessId,
            [kind === 'SALE' ? 'invoice_number' : kind === 'PURCHASE' ? 'reference_number' : 'reference']: number,
            status: 'POSTED',
            journal_entry_id: entryId,
            payment_terms_days: termsDays,
            due_date: dueDateIso,
            upfront_paid: settledNowOf(document),
            created_by: uid,
            created_at: new Date().toISOString(),
        };
        // Expense documents carry the resolved account, which the client's mapper
        // and reports read from `account_id`.
        if (kind === 'EXPENSE') {
            const categoryAcc = accounts.get(String(document.category_account_code ?? exports.ACCOUNT_CODES.COGS));
            documentRow.account_id = categoryAcc?.id ?? '';
            documentRow.category_name = String(document.category_name ?? 'Expense');
        }
        // Payment documents speak the client's vocabulary: payment_type.
        if (kind === 'PAYMENT') {
            documentRow.payment_type = String(document.direction ?? 'INCOMING');
            documentRow.doc_status = 'POSTED';
        }
        // A settlement made at posting time is a payments row, never a field on the
        // document — the same single-source-of-truth rule the Postgres path
        // enforced. reconcile() sums these rows; nothing else. The settlement gets
        // its own balanced journal entry, written in the same transaction.
        let settlementPayment = null;
        const settledNow = settledNowOf(document);
        if ((kind === 'SALE' || kind === 'PURCHASE') && settledNow > 0) {
            const rctCounter = await nextCounter(tx, businessId, `RCT_${dateIso}`);
            const rctRef = db.collection('businesses').doc(businessId).collection('payments').doc();
            const settlementEntryId = `je_${rctRef.id}`;
            const settlementLines = buildLines('PAYMENT', {
                amount: settledNow,
                direction: kind === 'SALE' ? 'INCOMING' : 'OUTGOING',
                payment_method: String(document.payment_method ?? (kind === 'SALE' ? 'CASH' : 'BANK')),
            }, business, accounts).map((l, i) => ({
                ...l, id: `${settlementEntryId}_L${i + 1}`, journal_entry_id: settlementEntryId, line_no: i + 1,
            }));
            const settlementSeq = await nextCounter(tx, businessId, 'journal_sequence');
            tx.set(db.collection('businesses').doc(businessId).collection('journal_entries').doc(settlementEntryId), {
                id: settlementEntryId,
                business_id: businessId,
                transaction_date: dateIso,
                sequence: settlementSeq,
                description: `Settlement ${documentNumber('RCT', dateIso, rctCounter)}`,
                reference: documentNumber('RCT', dateIso, rctCounter),
                source_type: 'PAYMENT',
                source_id: rctRef.id,
                lines: settlementLines,
                created_by: uid,
                created_at: firestore_1.FieldValue.serverTimestamp(),
            });
            const settleLinesCol = db.collection('businesses').doc(businessId)
                .collection('journal_entries').doc(settlementEntryId).collection('journal_lines');
            for (const l of settlementLines)
                tx.set(settleLinesCol.doc(String(l.id)), l);
            settlementPayment = {
                id: rctRef.id,
                business_id: businessId,
                amount: settledNow,
                payment_method: String(document.payment_method ?? (kind === 'SALE' ? 'CASH' : 'BANK')),
                date: dateIso,
                reference: documentNumber('RCT', dateIso, rctCounter),
                status: 'COMPLETED',
                payment_type: kind === 'SALE' ? 'INCOMING' : 'OUTGOING',
                [kind === 'SALE' ? 'linked_sale_id' : 'linked_purchase_id']: docRef.id,
                party_id: String(document.customer_id ?? document.supplier_id ?? ''),
                party_name: String(document.customer_name ?? document.supplier_name ?? ''),
                doc_status: 'POSTED',
                journal_entry_id: settlementEntryId,
                created_by: uid,
                created_at: new Date().toISOString(),
            };
            tx.set(rctRef, { ...settlementPayment, created_at: firestore_1.FieldValue.serverTimestamp() });
        }
        tx.set(docRef, {
            ...documentRow,
            created_at: firestore_1.FieldValue.serverTimestamp(),
        });
        const journalRef = db.collection('businesses').doc(businessId).collection('journal_entries').doc(entryId);
        const entryRow = {
            id: entryId,
            business_id: businessId,
            transaction_date: dateIso,
            sequence: seq,
            description: `${kind} ${number}`,
            reference: number,
            source_type: kind,
            source_id: docRef.id,
            lines,
            created_by: uid,
            created_at: new Date().toISOString(),
        };
        tx.set(journalRef, { ...entryRow, created_at: firestore_1.FieldValue.serverTimestamp() });
        // The lines also land as individual documents: the client's reader assembles
        // journal entries from a `journal_lines` collection, exactly as Postgres
        // exposed them as a table. Same ids, same fields, two projections of one
        // immutable write.
        const linesCol = journalRef.collection('journal_lines');
        for (const l of lines)
            tx.set(linesCol.doc(String(l.id)), l);
        // Line items for sales and purchases, nested under the document.
        const items = Array.isArray(document.items) ? document.items : [];
        if (kind === 'SALE' || kind === 'PURCHASE') {
            const itemsCol = docRef.collection(kind === 'SALE' ? 'sale_items' : 'purchase_items');
            items.forEach((it, i) => {
                const itemId = `${docRef.id}_it${i + 1}`;
                tx.set(itemsCol.doc(itemId), {
                    id: itemId,
                    [kind === 'SALE' ? 'sale_id' : 'purchase_id']: docRef.id,
                    business_id: businessId,
                    line_no: i + 1,
                    description: String(it.description ?? ''),
                    quantity: Number(it.quantity ?? 0),
                    unit_price: Number(it.unit_price ?? it.unitPrice ?? 0),
                    discount: Number(it.discount ?? 0),
                    total: Number(it.total ?? 0),
                });
            });
        }
        // The full rows come back so the client can apply exactly what was posted,
        // the same contract the Postgres RPCs had.
        return { document: documentRow, entry: entryRow, number, sequence: seq };
    });
});
/* -------------------------------------------------------------------------- */
/* voidDocument / voidPayment — reversals, never deletions                    */
/* -------------------------------------------------------------------------- */
exports.voidDocument = (0, https_1.onCall)(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new https_1.HttpsError('unauthenticated', 'Sign in to void records.');
    const { business_id: businessId, kind, document_id: documentId, reason } = request.data ?? {};
    const collections = { SALE: 'sales', PURCHASE: 'purchases', EXPENSE: 'expenses', PAYMENT: 'payments' };
    return db.runTransaction(async (tx) => {
        const docRef = db.collection('businesses').doc(businessId).collection(collections[kind]).doc(documentId);
        const docSnap = await tx.get(docRef);
        if (!docSnap.exists)
            throw new https_1.HttpsError('not-found', 'That record could not be found.');
        const doc = docSnap.data();
        if (doc.status === 'VOIDED')
            throw new https_1.HttpsError('failed-precondition', 'That record is already void.');
        const entryId = String(doc.journal_entry_id);
        const journalRef = db.collection('businesses').doc(businessId).collection('journal_entries').doc(entryId);
        const journalSnap = await tx.get(journalRef);
        if (!journalSnap.exists)
            throw new https_1.HttpsError('failed-precondition', 'The ledger entry behind this record is missing. Run Data health.');
        const original = journalSnap.data();
        if (original.reversed_by)
            throw new https_1.HttpsError('failed-precondition', `${original.reference} has already been reversed.`);
        const seq = await nextCounter(tx, businessId, 'journal_sequence');
        const revId = `je_rev_${docRef.id}`;
        const revRef = db.collection('businesses').doc(businessId).collection('journal_entries').doc(revId);
        const reversalLines = original.lines.map((l, i) => ({
            ...l, id: `${revId}_L${i + 1}`, journal_entry_id: revId, line_no: i + 1,
            debit: l.credit, credit: l.debit,
        }));
        const todayIso = new Date().toISOString().slice(0, 10);
        const reversalRow = {
            id: revId,
            business_id: businessId,
            transaction_date: todayIso,
            sequence: seq,
            description: `Reversal of ${original.reference} — ${reason || 'voided'}`,
            reference: `REV-${original.reference}`,
            source_type: 'REVERSAL',
            source_id: original.source_id ?? documentId,
            reverses_entry_id: entryId,
            lines: reversalLines,
            created_by: uid,
            created_at: new Date().toISOString(),
        };
        tx.set(revRef, { ...reversalRow, created_at: firestore_1.FieldValue.serverTimestamp() });
        const revLinesCol = revRef.collection('journal_lines');
        for (const l of reversalLines)
            tx.set(revLinesCol.doc(String(l.id)), l);
        // The original carries the link; it is never edited in any other way.
        tx.update(journalRef, { reversed_by_entry_id: revId });
        const voidedRow = {
            ...doc,
            status: 'VOIDED',
            voided_reason: reason ?? '',
            voided_by: uid,
            voided_at: new Date().toISOString(),
        };
        tx.set(docRef, voidedRow, { merge: true });
        // A voided invoice or bill also voids the settlement recorded as part of
        // its posting (the embedded upfront payment), flipping it to VOIDED too.
        // Standalone settlements are untouched — that is void_payment's job.
        let voidedSettlement = null;
        if (kind !== 'PAYMENT' && doc.journal_entry_id) {
            const settleSnap = await tx.get(db.collection('businesses').doc(businessId).collection('payments')
                .where(kind === 'SALE' ? 'linked_sale_id' : 'linked_purchase_id', '==', docRef.id)
                .where('doc_status', '==', 'POSTED').limit(5));
            for (const ps of settleSnap.docs) {
                const pay = ps.data();
                if (pay.date !== doc.date)
                    continue; // only the posting-time settlement shares the document's date
                const payVoid = { ...pay, doc_status: 'VOIDED', status: 'VOIDED' };
                tx.set(ps.ref, { doc_status: 'VOIDED', status: 'VOIDED' }, { merge: true });
                voidedSettlement = payVoid;
            }
        }
        // The full rows come back so the client can apply exactly what changed,
        // the same contract the Postgres RPCs had.
        return {
            document: voidedRow,
            original: { ...journalSnap.data(), id: entryId },
            reversal: reversalRow,
            payment: voidedSettlement,
            reversal_entry_id: revId,
        };
    });
});
/** Seed the starter chart. Idempotent; shared by the callable and createBusiness. */
async function seedChartOfAccounts(businessId) {
    const col = db.collection('businesses').doc(businessId).collection('accounts');
    const existing = await col.limit(1).get();
    if (!existing.empty)
        return false;
    const batch = db.batch();
    for (const a of CHART) {
        batch.set(col.doc(a.code), {
            id: a.code,
            code: a.code, name: a.name, type: a.type,
            system_account: a.system, is_active: true,
            business_id: businessId,
            created_at: new Date().toISOString(),
        });
    }
    await batch.commit();
    logger.info(`seeded chart of accounts for ${businessId}`);
    return true;
}
exports.seedChartIfEmpty = (0, https_1.onCall)(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new https_1.HttpsError('unauthenticated', 'Sign in first.');
    const { business_id: businessId } = request.data ?? {};
    const membership = await db.collection('businessMemberships').doc(`${uid}_${businessId}`).get();
    if (!membership.exists)
        throw new https_1.HttpsError('permission-denied', 'You are not a member of this business.');
    return { seeded: await seedChartOfAccounts(businessId) };
});
exports.closeFiscalYear = (0, https_1.onCall)(async (request) => {
    const uid = request.auth?.uid;
    if (!uid)
        throw new https_1.HttpsError('unauthenticated', 'Sign in to close a fiscal year.');
    const { business_id: businessId, fy_id: fyId } = request.data ?? {};
    if (!businessId || !fyId) {
        throw new https_1.HttpsError('invalid-argument', 'Business ID and Fiscal Year ID are required.');
    }
    const membership = await db.collection('businessMemberships').doc(`${uid}_${businessId}`).get();
    if (!membership.exists || membership.data().role !== 'OWNER') {
        throw new https_1.HttpsError('permission-denied', 'Only the owner of this business can close fiscal years.');
    }
    const fyRef = db.collection('businesses').doc(businessId).collection('fiscalYears').doc(fyId);
    const fySnap = await fyRef.get();
    if (!fySnap.exists) {
        throw new https_1.HttpsError('not-found', 'Fiscal year not found.');
    }
    const fyData = fySnap.data();
    if (fyData.status === 'CLOSED') {
        throw new https_1.HttpsError('failed-precondition', 'Fiscal year is already closed.');
    }
    await fyRef.update({
        status: 'CLOSED',
        closed_at: firestore_1.FieldValue.serverTimestamp(),
        closed_by: uid,
    });
    return { success: true, message: `Fiscal year ${fyData.label || fyId} closed successfully.` };
});
//# sourceMappingURL=posting.js.map