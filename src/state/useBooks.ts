import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Account, BooksSnapshot, BusinessProfile, ControlIntegrityReport, Customer, DateRange, Expense,
  GatewayProvider, GatewayTransaction, JournalEntry, Payment, Purchase, PurchaseDraft,
  Sale, SaleDraft, Supplier, UserProfile,
} from '../types';
import { emptyBusiness } from '../data/initialData';
import { ACCOUNT_CODES, AccountingEngine } from '../services/accountingEngine';
import { AccountLookup, outstandingByParty, outstandingOn, reconcile } from '../services/posting';
import { nextReference, RefKind } from '../services/referenceGenerator';
import { BACKUP_SCHEMA_VERSION } from '../lib/backupVersion';
import {
  archiveAccount as archiveAccountInCloud,
  createAccount as createAccountInCloud,
  updateAccount as updateAccountInCloud,
  fetchAllBookData, fetchControlIntegrity, fetchCustomers, fetchSuppliers,
  initiateGatewayTxn as initiateGatewayTxnRpc,
  postExpense, postPayment, postPurchase, postSale, settleGatewayTxn as settleGatewayTxnRpc,
  voidDocument as voidDocumentRpc, voidPayment as voidPaymentRpc,
} from '../services/bookService';
import { updateBusiness } from '../services/businessService';
import { isSupported, isVoidable, unsupported } from '../lib/capabilities';
import { applyPostedExpense } from '../lib/expenseState';
import { applyPostedPayment, applyVoidedPayment } from '../lib/paymentState';
import {
  applyGatewayInitiation, applyGatewaySettlement, gatewayOutcome,
} from '../lib/gatewayState';
import type { ProviderVerification } from '../lib/gatewayState';
import { applyPostedPurchase } from '../lib/purchaseState';
import { applyVoidedDocument } from '../lib/voidState';
import type { VoidableDocumentKind } from '../lib/dbTypes';
import { applyPostedSale } from '../lib/saleState';
import type { BusinessSettingsPatch } from '../lib/dbTypes';
import { fiscalYearOf, todayNpt } from '../lib/nepaliDate';
import { newId } from '../lib/ids';

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Result of starting a collection: a successful start carries the collection id
 * the browser must remember across the gateway redirect, and whether the server
 * recognised the request as a replay of one it already tracks.
 */
export type GatewayStartResult =
  | { ok: true; message: string; gatewayTxnId: string; replayed: boolean }
  | { ok: false; message: string };

// Precise return types, not the union: an action whose success carries more than
// a message (starting a collection, for instance) needs the false branch to be
// assignable on its own.
const ok = (message: string): { ok: true; message: string } => ({ ok: true, message });
const err = (message: string): { ok: false; message: string } => ({ ok: false, message });

export function useBooks() {
  const [storageError] = useState<string | null>(null);
  const [isLoadingCloud, setIsLoadingCloud] = useState<boolean>(false);
  const [cloudError, setCloudError] = useState<string | null>(null);

  const [user, setUser] = useState<UserProfile | null>(null);
  const [business, setBusiness] = useState<BusinessProfile>(emptyBusiness);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [rawSales, setSales] = useState<Sale[]>([]);
  const [rawPurchases, setPurchases] = useState<Purchase[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [gatewayTxns, setGatewayTxns] = useState<GatewayTransaction[]>([]);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  /**
   * The AR/AP control-account verdict, as the DATABASE reports it (migration
   * 014). Null until there is a business to ask about; `unavailable` when the
   * question could not be put, which Data Health reports as "not checked"
   * rather than as agreement.
   */
  const [controlIntegrity, setControlIntegrity] = useState<ControlIntegrityReport | null>(null);

  /**
   * The business whose rows are actually loaded, or null.
   *
   * Distinct from `business`, which starts as the placeholder profile
   * (`emptyBusiness`, id `biz_local`) before any session exists. Asking the
   * database about that placeholder meant an unauthenticated request — and a
   * 401 in the console — on the public landing page, on every load. Only a
   * business that came out of the cloud may be diagnosed.
   */
  const [loadedBusinessId, setLoadedBusinessId] = useState<string | null>(null);

  /**
   * Load every book row for a business.
   *
   * `stillCurrent` is the caller's session guard. A fetch that was already in
   * flight when the person signed out must never write a row: without this, a
   * slow response could repopulate the previous account's books after the state
   * had been cleared, and those rows would still be in memory behind the auth
   * screen. Returns whether the data was applied.
   */
  const loadFromCloud = useCallback(async (
    businessId: string,
    stillCurrent?: () => boolean,
  ): Promise<boolean> => {
    setIsLoadingCloud(true);
    setCloudError(null);
    try {
      const data = await fetchAllBookData(businessId);
      // Checked after the await, immediately before the first setter.
      if (stillCurrent && !stillCurrent()) return false;
      setAccounts(data.accounts);
      setCustomers(data.customers);
      setSuppliers(data.suppliers);
      setSales(data.sales);
      setPurchases(data.purchases);
      setExpenses(data.expenses);
      setPayments(data.payments);
      setGatewayTxns(data.gatewayTransactions);
      setJournalEntries(data.journalEntries);
      setLoadedBusinessId(businessId);
      return true;
    } catch (e) {
      // A failure of a load that no longer belongs to the current session is
      // not the signed-in person's problem, so it does not raise a cloud error.
      if (stillCurrent && !stillCurrent()) return false;
      const msg = e instanceof Error ? e.message : 'Failed to load book data from cloud.';
      setCloudError(msg);
      throw e;
    } finally {
      setIsLoadingCloud(false);
    }
  }, []);


  /* ---------------------------------------------------------------------- */
  /* Derived state — memoized, so this no longer recomputes on every render   */
  /* ---------------------------------------------------------------------- */

  const { sales, purchases } = useMemo(
    () => reconcile(rawSales, rawPurchases, payments),
    [rawSales, rawPurchases, payments],
  );

  const lookup = useMemo(() => new AccountLookup(accounts), [accounts]);

  const currentFy = useMemo(
    () => fiscalYearOf(todayNpt(), business.fiscalYearStartMonth),
    [business.fiscalYearStartMonth],
  );

  const defaultRange = useMemo<DateRange>(
    () => ({ from: currentFy.startAd, to: todayNpt(), label: `FY ${currentFy.label} to date` }),
    [currentFy],
  );

  const balances = useMemo(
    () => AccountingEngine.getAccountBalances(accounts, journalEntries),
    [accounts, journalEntries],
  );

  const receivableByCustomer = useMemo(
    () => outstandingByParty(sales.map((s) => ({
      partyId: s.customerId, totalAmount: s.totalAmount, paidAmount: s.paidAmount, status: s.status,
    }))),
    [sales],
  );

  const payableBySupplier = useMemo(
    () => outstandingByParty(purchases.map((p) => ({
      partyId: p.supplierId, totalAmount: p.totalAmount, paidAmount: p.paidAmount, status: p.status,
    }))),
    [purchases],
  );

  /**
   * Ask the database for the control-account reconciliation whenever the rows it
   * describes change.
   *
   * Keyed on the data rather than called from each action on purpose: there are
   * six write paths that can move a balance, and a seventh added later would
   * silently stop refreshing the check. A stale verdict is the one failure mode
   * that matters here — Data Health would show a clean bill of health the
   * database no longer agrees with — so the refresh follows the data.
   *
   * The diagnostic reads only; if it cannot be reached the report says so and
   * no financial state is touched.
   */
  useEffect(() => {
    if (!loadedBusinessId) {
      setControlIntegrity(null);
      return;
    }
    let cancelled = false;
    void fetchControlIntegrity(loadedBusinessId).then((report) => {
      if (!cancelled) setControlIntegrity(report);
    });
    return () => { cancelled = true; };
  }, [loadedBusinessId, sales, purchases, payments, journalEntries]);

  const integrityIssues = useMemo(
    () => AccountingEngine.checkIntegrity({
      accounts, entries: journalEntries, sales, purchases, expenses, payments,
      gateway: gatewayTxns, controls: controlIntegrity,
    }),
    [accounts, journalEntries, sales, purchases, expenses, payments, gatewayTxns, controlIntegrity],
  );

  // "Open" means POSTED with something still outstanding, and the outstanding
  // figure comes from the one settlement formula so a lock-free screen and the
  // locked server check cannot disagree.
  const openInvoices = useMemo(
    () => sales.filter((s) => s.status === 'POSTED' && outstandingOn(s) > 0.005),
    [sales],
  );

  const openBills = useMemo(
    () => purchases.filter((p) => p.status === 'POSTED' && outstandingOn(p) > 0.005),
    [purchases],
  );

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */

  const refFor = useCallback((kind: RefKind, onDate: string): string => {
    const pools: Record<RefKind, string[]> = {
      INV: rawSales.map((s) => s.invoiceNumber),
      PO: rawPurchases.map((p) => p.referenceNumber),
      EXP: expenses.map((e) => e.reference),
      PAY: payments.map((p) => p.reference),
      RCP: payments.map((p) => p.reference),
    };
    return nextReference(kind, pools[kind], onDate);
  }, [rawSales, rawPurchases, expenses, payments]);

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                 */
  /* ---------------------------------------------------------------------- */

  const addSale = useCallback(async (draft: SaleDraft): Promise<ActionResult> => {
    if (!business.id) {
      return err('No active business selected.');
    }

    try {
      const result = await postSale({
        businessId: business.id,
        customerId: draft.customerId ?? null,
        customerName: draft.customerName,
        invoiceNumber: refFor('INV', draft.date),
        date: draft.date,
        // The agreed terms travel; the due date they imply is post_sale's to
        // compute, so this form can show a date but can never choose one.
        paymentTermsDays: draft.paymentTermsDays,
        subtotal: draft.subtotal,
        discountTotal: draft.discountTotal,
        taxAmount: draft.taxAmount,
        totalAmount: draft.totalAmount,
        upfrontPaid: draft.upfrontPaid,
        paymentMethod: draft.paymentMethod,
        costOfGoods: draft.costOfGoods ?? null,
        notes: draft.notes ?? null,
        items: draft.items.map((item, idx) => ({
          lineNo: idx + 1,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discount: item.discount ?? 0,
          total: item.total,
        })),
      });

      // Purely applied so a freshly posted sale (and its line items) is in
      // state immediately, without waiting for a reload.
      const applied = applyPostedSale(
        { sales: rawSales, journalEntries, payments },
        result,
      );
      setSales(applied.sales);
      setJournalEntries(applied.journalEntries);
      setPayments(applied.payments);

      // If customer was newly created in database, refresh customer list
      if (!customers.some((c) => c.name.toLowerCase() === draft.customerName.trim().toLowerCase())) {
        fetchCustomers(business.id)
          .then((updated) => setCustomers(updated))
          .catch(() => {});
      }

      return ok(`Invoice ${result.sale.invoiceNumber} recorded.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'The sale could not be posted.';
      return err(msg);
    }
  }, [business.id, customers, journalEntries, payments, rawSales, refFor]);

  const addPurchase = useCallback(async (draft: PurchaseDraft): Promise<ActionResult> => {
    if (!business.id) {
      return err('No active business selected.');
    }

    try {
      const supplierId = draft.supplierId
        ?? suppliers.find((s) => s.name.toLowerCase() === draft.supplierName.trim().toLowerCase())?.id
        ?? null;

      const result = await postPurchase({
        businessId: business.id,
        supplierId,
        supplierName: draft.supplierName,
        // Blank asks the server to allocate PO-YYYYMMDD-NNN under an advisory
        // lock. The client-side generator derives the next number from local
        // state, so two devices can both compute the same reference.
        referenceNumber: '',
        date: draft.date,
        // Same rule on the supplier side: terms go, the due date does not.
        paymentTermsDays: draft.paymentTermsDays,
        subtotal: draft.subtotal,
        discountTotal: draft.discountTotal,
        taxAmount: draft.taxAmount,
        totalAmount: draft.totalAmount,
        upfrontPaid: draft.upfrontPaid,
        paymentMethod: draft.paymentMethod,
        notes: draft.notes ?? null,
        items: draft.items.map((item, idx) => ({
          lineNo: idx + 1,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discount: item.discount ?? 0,
          total: item.total,
        })),
        priceIncludesVat: draft.priceIncludesVat ?? null,
        idempotencyKey: newId('po'),
      });

      // Purely applied, so a just-posted purchase and its line items are in
      // state immediately and no refresh is needed to see them.
      const applied = applyPostedPurchase(
        { purchases: rawPurchases, journalEntries, payments },
        result,
      );
      setPurchases(applied.purchases);
      setJournalEntries(applied.journalEntries);
      setPayments(applied.payments);

      // A supplier the RPC had to create is not in the payload; refresh the
      // list in the background, exactly like a newly created customer.
      if (!suppliers.some((s) => s.name.toLowerCase() === draft.supplierName.trim().toLowerCase())) {
        fetchSuppliers(business.id)
          .then((updated) => setSuppliers(updated))
          .catch(() => {});
      }

      return ok(`Purchase ${result.purchase.referenceNumber} recorded.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'The purchase could not be posted.';
      return err(msg);
    }
  }, [business.id, journalEntries, payments, rawPurchases, suppliers]);

  const addExpense = useCallback(async (
    draft: {
      accountId: string;
      date: string;
      description: string;
      amount: number;
      taxAmount: number;
      totalAmount: number;
      paymentMethod: Expense['paymentMethod'];
      notes?: string;
      priceIncludesVat?: boolean | null;
      /** Supplied by the form so one user action keeps one key across retries. */
      idempotencyKey?: string | null;
    },
  ): Promise<ActionResult> => {
    if (!business.id) {
      return err('No active business selected.');
    }
    if (!isSupported('expenses')) return unsupported('expenses', 'Recording an expense');

    try {
      const result = await postExpense({
        businessId: business.id,
        accountId: draft.accountId,
        // Blank asks the server to allocate EXP-YYYYMMDD-NNN under the advisory
        // lock: the client-side generator derives the next number from local
        // state, so two devices could otherwise both compute the same number.
        reference: '',
        date: draft.date,
        amount: draft.amount,
        taxAmount: draft.taxAmount,
        totalAmount: draft.totalAmount,
        paymentMethod: draft.paymentMethod,
        description: draft.description,
        notes: draft.notes ?? null,
        priceIncludesVat: draft.priceIncludesVat ?? null,
        // The category name is not sent: the RPC derives it from the account.
        idempotencyKey: draft.idempotencyKey ?? newId('exp'),
      });

      // Purely applied, so the just-posted expense and its journal entry are in
      // state immediately and no refresh is needed to see them. No payments
      // array is touched: an expense never produces a settlement row.
      const applied = applyPostedExpense({ expenses, journalEntries }, result);
      setExpenses(applied.expenses);
      setJournalEntries(applied.journalEntries);

      return ok(`Expense ${result.expense.reference} recorded.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'The expense could not be posted.';
      return err(msg);
    }
  }, [business.id, expenses, journalEntries]);

  /**
   * Record a settlement in the cloud (post_payment, migration 009).
   *
   * A settlement is always against a persisted sale or purchase. The server
   * locks that document, recomputes what is still outstanding from the persisted
   * payments, decides the direction (SALE → INCOMING, PURCHASE → OUTGOING), the
   * party snapshot, the payment status, the journal entry and the reference — so
   * none of those are accepted from here. The RPC is called first and React
   * state is only touched from the rows it returned, which means a rejected or
   * over-settling payment changes nothing at all.
   */
  const addPayment = useCallback(async (
    draft: {
      /** Exactly one of these is set, and it decides the payment direction. */
      linkedSaleId?: string;
      linkedPurchaseId?: string;
      amount: number;
      paymentMethod: Payment['paymentMethod'];
      date: string;
      notes?: string;
      /** Supplied by the form so one user action keeps one key across retries. */
      idempotencyKey?: string | null;
    },
  ): Promise<ActionResult> => {
    if (!business.id) {
      return err('No active business selected.');
    }
    if (!isSupported('payments')) return unsupported('payments', 'Recording a settlement');

    const documentType = draft.linkedSaleId ? 'SALE' as const
      : draft.linkedPurchaseId ? 'PURCHASE' as const
        : null;
    const documentId = draft.linkedSaleId ?? draft.linkedPurchaseId;
    if (!documentType || !documentId) {
      return err('Pick the document this settlement settles.');
    }

    try {
      const result = await postPayment({
        businessId: business.id,
        documentType,
        documentId,
        amount: draft.amount,
        paymentMethod: draft.paymentMethod,
        date: draft.date,
        // Blank asks the server to allocate RCP-/PAY-YYYYMMDD-NNN under the
        // per-business advisory lock. The client-side generator derives the next
        // number from local state, so two devices could otherwise both compute
        // the same reference.
        reference: '',
        notes: draft.notes ?? null,
        // The party name is not sent: the RPC snapshots it from the document.
        idempotencyKey: draft.idempotencyKey ?? newId('pay'),
      });

      // Purely applied, so the just-posted settlement and its journal entry are
      // in state immediately. The sale or purchase is deliberately left alone:
      // reconcile() derives paidAmount and paymentStatus from `payments`, so
      // inserting the settlement row is what moves them.
      const applied = applyPostedPayment({ payments, journalEntries }, result);
      setPayments(applied.payments);
      setJournalEntries(applied.journalEntries);

      return ok(`Settlement ${result.payment.reference} recorded.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'The settlement could not be recorded.';
      return err(msg);
    }
  }, [business.id, journalEntries, payments]);

  /**
   * Void a document in the cloud (void_document, migration 008).
   *
   * The RPC writes exactly one mirror reversal, links it from the original,
   * marks the document VOIDED and voids any embedded settlement — atomically,
   * and without deleting anything. The RPC is called first and React state is
   * only touched from the rows it returns, so a rejected void changes nothing.
   */
  const voidDocument = useCallback(async (
    kind: VoidableDocumentKind,
    id: string,
  ): Promise<ActionResult> => {
    if (!business.id) {
      return err('No active business selected.');
    }
    if (!isSupported('voiding') || !isVoidable(kind === 'sale' ? 'sales' : kind === 'purchase' ? 'purchases' : 'expenses')) {
      return unsupported('voiding', 'Voiding a document');
    }

    try {
      const result = await voidDocumentRpc({
        businessId: business.id,
        documentType: kind === 'sale' ? 'SALE' : kind === 'purchase' ? 'PURCHASE' : 'EXPENSE',
        documentId: id,
      });

      const applied = applyVoidedDocument(
        { sales: rawSales, purchases: rawPurchases, expenses, journalEntries, payments },
        kind,
        result,
      );
      setSales(applied.sales);
      setPurchases(applied.purchases);
      setExpenses(applied.expenses);
      setJournalEntries(applied.journalEntries);
      setPayments(applied.payments);

      const reference = kind === 'sale'
        ? (result.document as Sale).invoiceNumber
        : kind === 'purchase'
          ? (result.document as Purchase).referenceNumber
          : (result.document as Expense).reference;

      return ok(`${reference} voided. A reversing entry has been posted.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'The document could not be voided.';
      return err(msg);
    }
  }, [business.id, expenses, journalEntries, payments, rawPurchases, rawSales]);

  /**
   * Void a settlement in the cloud (void_payment, migration 010).
   *
   * The server locks the settlement, reverses its own journal entry and flips
   * the row to VOIDED; the sale or purchase it settled stays POSTED and simply
   * shows the money as outstanding again, because reconcile() stops counting the
   * voided row. React state is only touched from the rows the RPC returned, so a
   * refused void (an upfront settlement, a settlement that is already voided,
   * another tenant's row) changes nothing and reports why.
   */
  const voidPayment = useCallback(async (id: string): Promise<ActionResult> => {
    if (!business.id) {
      return err('No active business selected.');
    }
    if (!isSupported('voiding') || !isVoidable('payments')) {
      return unsupported('voiding', 'Voiding a settlement');
    }

    try {
      const result = await voidPaymentRpc({ businessId: business.id, paymentId: id });

      const applied = applyVoidedPayment({ payments, journalEntries }, result);
      setPayments(applied.payments);
      setJournalEntries(applied.journalEntries);

      return ok(`Settlement ${result.payment.reference} voided. A reversing entry has been posted.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'The settlement could not be voided.';
      return err(msg);
    }
  }, [business.id, journalEntries, payments]);

  /* ---------------------------------------------------------------------- */
  /* Gateway                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Start an online collection (initiate_gateway_txn, migration 011).
   *
   * The browser cannot write a gateway row, so this RPC is the only way one
   * exists: it re-checks the invoice under a lock, recomputes the outstanding
   * balance from the persisted settlements and records the provider reference
   * with auth.uid() as its initiator. Nothing is posted to the books here — a
   * collection is a provider interaction, not an accounting event.
   */
  const startGatewayCollection = useCallback(async (input: {
    provider: GatewayProvider;
    gatewayRef: string;
    amount: number;
    linkedSaleId: string;
    customerName?: string;
  }): Promise<GatewayStartResult> => {
    if (!isSupported('gateway')) return unsupported('gateway', 'Collecting online');
    if (!business.id || business.id === emptyBusiness.id) {
      return err('No active business selected.');
    }

    try {
      const result = await initiateGatewayTxnRpc({ businessId: business.id, ...input });
      const txn = result.gatewayTransaction;
      setGatewayTxns((prev) => applyGatewayInitiation(prev, result));

      return {
        ok: true,
        gatewayTxnId: txn.id,
        replayed: result.replayed,
        message: result.replayed
          ? `Collection ${txn.gatewayRef} was already being tracked.`
          : `Collection ${txn.gatewayRef} started.`,
      };
    } catch (e) {
      return err(e instanceof Error ? e.message : 'The online collection could not be started.');
    }
  }, [business.id]);

  /**
   * Settle a verified collection (settle_gateway_txn, migration 012).
   *
   * This is the only path that turns a gateway answer into money on the books.
   * The database re-validates the answer against the persisted collection
   * (provider, reference, amount, currency), locks the invoice, recomputes what
   * is outstanding and then posts exactly one settlement through the same
   * accounting core post_payment uses — or posts nothing at all. A replay
   * returns the settlement that is already committed, and a collection whose
   * settlement was voided is reported as such instead of being revived.
   */
  const settleGatewayTxn = useCallback(async (
    txnId: string,
    verification: ProviderVerification,
  ): Promise<ActionResult> => {
    if (!isSupported('gateway')) return unsupported('gateway', 'Collecting online');
    if (!business.id || business.id === emptyBusiness.id) {
      return err('No active business selected.');
    }

    try {
      const result = await settleGatewayTxnRpc({
        businessId: business.id,
        gatewayTxnId: txnId,
        verification,
      });

      const applied = applyGatewaySettlement({ payments, journalEntries, gatewayTxns }, result);
      setPayments(applied.payments);
      setJournalEntries(applied.journalEntries);
      setGatewayTxns(applied.gatewayTxns);

      const outcome = gatewayOutcome(result);
      return outcome.ok ? ok(outcome.message) : err(outcome.message);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'The online collection could not be settled.';
      return err(msg);
    }
  }, [business.id, journalEntries, payments, gatewayTxns]);

  /* ---------------------------------------------------------------------- */
  /* Chart of accounts                                                       */
  /* ---------------------------------------------------------------------- */

  const addAccount = useCallback(async (draft: Omit<Account, 'id' | 'businessId' | 'isActive'>): Promise<ActionResult> => {
    if (!isSupported('accounts')) return unsupported('accounts', 'Adding an account');
    if (accounts.some((a) => a.code === draft.code)) return err(`Account code ${draft.code} is already in use.`);
    if (!/^\d{4}$/.test(draft.code)) return err('Account codes are four digits.');
    if (!draft.name.trim()) return err('Account name is required.');
    try {
      const account = await createAccountInCloud(business.id, draft);
      setAccounts((prev) => [...prev, account].sort((a, b) => a.code.localeCompare(b.code)));
      return ok(`${account.name} added.`);
    } catch (e) {
      return err(e instanceof Error ? e.message : 'Could not save the account to the cloud.');
    }
  }, [accounts, business.id]);

  const archiveAccount = useCallback(async (id: string): Promise<ActionResult> => {
    if (!isSupported('accounts')) return unsupported('accounts', 'Archiving an account');
    const account = accounts.find((a) => a.id === id);
    if (!account) return err('That account no longer exists.');
    if (account.systemAccount) return err(`${account.name} is used by the posting rules and cannot be removed.`);
    if (Math.abs(balances[id] ?? 0) > 0.005) return err(`${account.name} still has a balance. Clear it first.`);
    try {
      await archiveAccountInCloud(business.id, id);
      setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, isActive: false } : a)));
      return ok(`${account.name} archived.`);
    } catch (e) {
      return err(e instanceof Error ? e.message : 'Could not archive the account in the cloud.');
    }
  }, [accounts, balances, business.id]);

  const updateAccount = useCallback(async (
    id: string,
    changes: Pick<Account, 'name' | 'description'>,
  ): Promise<ActionResult> => {
    if (!isSupported('accounts')) return unsupported('accounts', 'Editing an account');
    const account = accounts.find((a) => a.id === id);
    if (!account) return err('That account no longer exists.');
    if (account.systemAccount) return err(`${account.name} is used by the posting rules and cannot be renamed.`);
    if (!changes.name.trim()) return err('Account name is required.');
    try {
      const updated = await updateAccountInCloud(business.id, id, changes);
      setAccounts((prev) => prev.map((a) => (a.id === id ? updated : a)));
      return ok(`${updated.name} updated.`);
    } catch (e) {
      return err(e instanceof Error ? e.message : 'Could not save the account changes to the cloud.');
    }
  }, [accounts, business.id]);

  /* ---------------------------------------------------------------------- */
  /* Backup                                                                  */
  /* ---------------------------------------------------------------------- */

  const snapshot = useCallback((): BooksSnapshot => ({
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    business, accounts, customers, suppliers,
    sales: rawSales, purchases: rawPurchases, expenses, payments,
    gatewayTransactions: gatewayTxns, journalEntries,
  }), [business, accounts, customers, suppliers, rawSales, rawPurchases, expenses, payments, gatewayTxns, journalEntries]);

  const restore = useCallback((data: unknown): ActionResult => {
    if (!isSupported('restore')) return unsupported('restore', 'Restoring a backup');
    const snap = data as Partial<BooksSnapshot>;
    if (!snap || typeof snap !== 'object') return err('That file is not a Zeyks Book backup.');
    if (!Array.isArray(snap.journalEntries) || !Array.isArray(snap.accounts)) {
      return err('That backup is missing its accounts or journal entries.');
    }
    if (snap.schemaVersion !== BACKUP_SCHEMA_VERSION) {
      return err(`That backup is version ${snap.schemaVersion ?? 'unknown'}; this build reads version ${BACKUP_SCHEMA_VERSION}.`);
    }
    if (snap.business) setBusiness(snap.business);
    setAccounts(snap.accounts);
    setCustomers(snap.customers ?? []);
    setSuppliers(snap.suppliers ?? []);
    setSales(snap.sales ?? []);
    setPurchases(snap.purchases ?? []);
    setExpenses(snap.expenses ?? []);
    setPayments(snap.payments ?? []);
    setGatewayTxns(snap.gatewayTransactions ?? []);
    setJournalEntries(snap.journalEntries);
    return ok(`Restored ${snap.journalEntries.length} journal entries.`);
  }, []);

  /**
   * Clear the in-memory application state.
   *
   * Used on sign-out only — it never touches Firestore and is never presented
   * as "erasing" the cloud books.
   */
  const resetAll = useCallback(() => {
    setCustomers([]); setSuppliers([]); setSales([]); setPurchases([]);
    setExpenses([]); setPayments([]); setGatewayTxns([]); setJournalEntries([]);
    setAccounts([]);
    setLoadedBusinessId(null);
    setBusiness(emptyBusiness);
  }, []);

  /**
   * Persist business settings through Firestore (Security Rules enforce OWNER).
   *
   * The database row returned by the update becomes the canonical state, so a
   * rejected write (for example a non-owner) never leaves the UI claiming the
   * change was saved.
   */
  const saveBusinessSettings = useCallback(async (
    patch: BusinessSettingsPatch,
  ): Promise<ActionResult> => {
    if (!business.id || business.id === emptyBusiness.id) {
      return err('No active business selected.');
    }
    const { business: updated, error } = await updateBusiness(business.id, patch);
    if (error || !updated) return err(error ?? 'The business settings were not saved.');
    setBusiness(updated);
    return ok('Settings saved.');
  }, [business.id]);

  return {
    // state
    user, setUser, business, setBusiness, accounts, setAccounts, customers, suppliers,
    sales, purchases, expenses, payments, gatewayTxns, journalEntries,
    isLoadingCloud, cloudError,
    // derived
    balances, integrityIssues, controlIntegrity, receivableByCustomer, payableBySupplier,
    openInvoices, openBills, currentFy, defaultRange, storageError, lookup,
    codes: ACCOUNT_CODES,
    // actions
    loadFromCloud,
    addSale, addPurchase, addExpense, addPayment, voidDocument, voidPayment,
    startGatewayCollection, settleGatewayTxn, addAccount, archiveAccount, updateAccount,
    snapshot, restore, resetAll, saveBusinessSettings, refFor,
  };
}

export type Books = ReturnType<typeof useBooks>;
