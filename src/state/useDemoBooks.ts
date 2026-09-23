import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Account, BooksSnapshot, BusinessProfile, ControlIntegrityReport, Customer, DateRange, Expense,
  GatewayTransaction, JournalEntry, Payment, Purchase, PurchaseDraft,
  Sale, SaleDraft, Supplier, UserProfile,
} from '../types';
import { defaultAccounts } from '../data/initialData';
import { ACCOUNT_CODES, AccountingEngine } from '../services/accountingEngine';
import { AccountLookup, outstandingByParty, outstandingOn, reconcile } from '../services/posting';
import { nextReference, RefKind } from '../services/referenceGenerator';
import { BACKUP_SCHEMA_VERSION } from '../lib/backupVersion';
import type { BusinessSettingsPatch, VoidableDocumentKind } from '../lib/dbTypes';
import { fiscalYearOf, todayNpt } from '../lib/nepaliDate';
import { newId } from '../lib/ids';
import type { ActionResult, GatewayStartResult } from './useBooks';

const DEMO_STORAGE_KEY = 'zeyks.demo_snapshot';

const initialDemoBusiness: BusinessProfile = {
  id: 'biz_demo',
  userId: 'demo_user',
  businessName: 'Himalayan Traders Pvt. Ltd.',
  ownerName: 'Aman Sharma',
  email: 'demo@himalayantraders.np',
  phone: '9851012345',
  panNumber: '609182374',
  address: 'New Road, Ward 22',
  city: 'Kathmandu',
  currency: 'NPR',
  currencySymbol: 'NPR',
  timezone: 'Asia/Kathmandu',
  fiscalYearStartMonth: 4, // Shrawan
  vatRegistered: true,
  vatRate: 13,
  trackInventory: true,
  createdAt: '2026-04-14T00:00:00Z',
};

const initialDemoCustomers: Customer[] = [
  { id: 'cust_1', businessId: 'biz_demo', name: 'Apex Hardware & Supplies', email: 'info@apex.np', phone: '9841223344', address: 'Kathmandu', panNumber: '601234567', createdAt: '2026-04-14T00:00:00Z' },
  { id: 'cust_2', businessId: 'biz_demo', name: 'Pokhara Departmental Store', email: 'contact@pokharamart.np', phone: '9801122334', address: 'Pokhara', panNumber: '602345678', createdAt: '2026-04-14T00:00:00Z' },
];

const initialDemoSuppliers: Supplier[] = [
  { id: 'supp_1', businessId: 'biz_demo', name: 'Lumbini Commercial Importers', email: 'sales@lumbini.np', phone: '9851234567', address: 'Birgunj', panNumber: '603456789', createdAt: '2026-04-14T00:00:00Z' },
  { id: 'supp_2', businessId: 'biz_demo', name: 'Valley Paper & Stationers', email: 'order@valleypaper.np', phone: '9841998877', address: 'Lalitpur', panNumber: '604567890', createdAt: '2026-04-14T00:00:00Z' },
];

const initialDemoSales: Sale[] = [
  {
    id: 'sale_1',
    businessId: 'biz_demo',
    invoiceNumber: 'INV-2083-0142',
    date: '2026-07-29',
    dueDate: '2026-08-28',
    paymentTermsDays: 30,
    customerId: 'cust_1',
    customerName: 'Apex Hardware & Supplies',
    subtotal: 40000,
    discountTotal: 0,
    taxAmount: 5200,
    totalAmount: 45200,
    paidAmount: 45200, // Fully settled by RCT-2083-0089
    postingSnapshot: { upfrontPaid: 0 },
    paymentStatus: 'PAID',
    paymentMethod: 'BANK',
    status: 'POSTED',
    journalEntryId: 'je_sale_1',
    createdAt: '2026-07-29T10:00:00Z',
    createdBy: 'demo_user',
    items: [
      { id: 'si_1', description: 'Commercial Hardware Tools Batch A', quantity: 10, unitPrice: 4000, discount: 0, total: 40000 },
    ],
  },
];

const initialDemoPurchases: Purchase[] = [
  {
    id: 'pur_1',
    businessId: 'biz_demo',
    referenceNumber: 'BIL-2083-0067',
    date: '2026-08-12',
    dueDate: '2026-09-11',
    paymentTermsDays: 30,
    supplierId: 'supp_1',
    supplierName: 'Lumbini Commercial Importers',
    subtotal: 65000,
    discountTotal: 0,
    taxAmount: 8450,
    totalAmount: 73450,
    paidAmount: 0,
    postingSnapshot: { upfrontPaid: 0 },
    paymentStatus: 'UNPAID',
    paymentMethod: 'BANK',
    status: 'POSTED',
    journalEntryId: 'je_pur_1',
    createdAt: '2026-08-12T11:00:00Z',
    createdBy: 'demo_user',
    items: [
      { id: 'pi_1', description: 'Merchandise Stock Intake - Grade A', quantity: 50, unitPrice: 1300, discount: 0, total: 65000 },
    ],
  },
];

const initialDemoExpenses: Expense[] = [
  {
    id: 'exp_1',
    businessId: 'biz_demo',
    reference: 'EXP-2083-0012',
    date: '2026-08-01',
    accountId: 'acc_5040', // Rent
    categoryName: 'Rent',
    amount: 15000,
    taxAmount: 0,
    totalAmount: 15000,
    paymentMethod: 'BANK',
    description: 'Main Store Shop & Office Rent - Shrawan 2083',
    status: 'POSTED',
    journalEntryId: 'je_exp_1',
    createdAt: '2026-08-01T09:00:00Z',
    createdBy: 'demo_user',
  },
];

const initialDemoPayments: Payment[] = [
  {
    id: 'pay_1',
    businessId: 'biz_demo',
    reference: 'RCT-2083-0089',
    paymentType: 'INCOMING',
    linkedSaleId: 'sale_1',
    partyId: 'cust_1',
    partyName: 'Apex Hardware & Supplies',
    amount: 45200,
    paymentMethod: 'BANK',
    date: '2026-08-06',
    status: 'COMPLETED',
    docStatus: 'POSTED',
    journalEntryId: 'je_pay_1',
    createdAt: '2026-08-06T14:00:00Z',
    createdBy: 'demo_user',
  },
];

const initialDemoJournals: JournalEntry[] = [
  {
    id: 'je_sale_1',
    businessId: 'biz_demo',
    sequence: 1,
    transactionDate: '2026-07-29',
    description: 'Tax Invoice INV-2083-0142 posted',
    reference: 'INV-2083-0142',
    sourceType: 'SALE',
    sourceId: 'sale_1',
    createdAt: '2026-07-29T10:00:00Z',
    createdBy: 'demo_user',
    lines: [
      { id: 'jl_1', journalEntryId: 'je_sale_1', accountId: ACCOUNT_CODES.RECEIVABLE, accountName: 'Accounts receivable', accountType: 'ASSET', debit: 45200, credit: 0 },
      { id: 'jl_2', journalEntryId: 'je_sale_1', accountId: ACCOUNT_CODES.SALES, accountName: 'Sales revenue', accountType: 'REVENUE', debit: 0, credit: 40000 },
      { id: 'jl_3', journalEntryId: 'je_sale_1', accountId: ACCOUNT_CODES.VAT_PAYABLE, accountName: 'VAT payable (output tax)', accountType: 'LIABILITY', debit: 0, credit: 5200 },
    ],
  },
  {
    id: 'je_pur_1',
    businessId: 'biz_demo',
    sequence: 2,
    transactionDate: '2026-08-12',
    description: 'Purchase Bill BIL-2083-0067 posted',
    reference: 'BIL-2083-0067',
    sourceType: 'PURCHASE',
    sourceId: 'pur_1',
    createdAt: '2026-08-12T11:00:00Z',
    createdBy: 'demo_user',
    lines: [
      { id: 'jl_4', journalEntryId: 'je_pur_1', accountId: ACCOUNT_CODES.INVENTORY, accountName: 'Inventory', accountType: 'ASSET', debit: 65000, credit: 0 },
      { id: 'jl_5', journalEntryId: 'je_pur_1', accountId: ACCOUNT_CODES.VAT_RECEIVABLE, accountName: 'VAT receivable (input tax)', accountType: 'ASSET', debit: 8450, credit: 0 },
      { id: 'jl_6', journalEntryId: 'je_pur_1', accountId: ACCOUNT_CODES.PAYABLE, accountName: 'Accounts payable', accountType: 'LIABILITY', debit: 0, credit: 73450 },
    ],
  },
  {
    id: 'je_exp_1',
    businessId: 'biz_demo',
    sequence: 3,
    transactionDate: '2026-08-01',
    description: 'Expense EXP-2083-0012 posted: Rent',
    reference: 'EXP-2083-0012',
    sourceType: 'EXPENSE',
    sourceId: 'exp_1',
    createdAt: '2026-08-01T09:00:00Z',
    createdBy: 'demo_user',
    lines: [
      { id: 'jl_7', journalEntryId: 'je_exp_1', accountId: 'acc_5040', accountName: 'Rent', accountType: 'EXPENSE', debit: 15000, credit: 0 },
      { id: 'jl_8', journalEntryId: 'je_exp_1', accountId: ACCOUNT_CODES.BANK, accountName: 'Bank account', accountType: 'ASSET', debit: 0, credit: 15000 },
    ],
  },
  {
    id: 'je_pay_1',
    businessId: 'biz_demo',
    sequence: 4,
    transactionDate: '2026-08-06',
    description: 'Settlement RCT-2083-0089 posted for INV-2083-0142',
    reference: 'RCT-2083-0089',
    sourceType: 'PAYMENT',
    sourceId: 'pay_1',
    createdAt: '2026-08-06T14:00:00Z',
    createdBy: 'demo_user',
    lines: [
      { id: 'jl_9', journalEntryId: 'je_pay_1', accountId: ACCOUNT_CODES.BANK, accountName: 'Bank account', accountType: 'ASSET', debit: 45200, credit: 0 },
      { id: 'jl_10', journalEntryId: 'je_pay_1', accountId: ACCOUNT_CODES.RECEIVABLE, accountName: 'Accounts receivable', accountType: 'ASSET', debit: 0, credit: 45200 },
    ],
  },
];

export function useDemoBooks() {
  const [business, setBusiness] = useState<BusinessProfile>(() => {
    try {
      const stored = localStorage.getItem(DEMO_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.business) return parsed.business;
      }
    } catch { /* fallback */ }
    return initialDemoBusiness;
  });

  const [user, setUser] = useState<UserProfile | null>({
    id: 'demo_user',
    email: 'demo@zeyksbook.app',
    fullName: 'Demo User (Local Storage)',
    createdAt: '2026-04-14T00:00:00Z',
  });

  const [accounts, setAccounts] = useState<Account[]>(() => {
    try {
      const stored = localStorage.getItem(DEMO_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed.accounts)) return parsed.accounts;
      }
    } catch { /* fallback */ }
    return defaultAccounts;
  });

  const [customers, setCustomers] = useState<Customer[]>(() => {
    try {
      const stored = localStorage.getItem(DEMO_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed.customers)) return parsed.customers;
      }
    } catch { /* fallback */ }
    return initialDemoCustomers;
  });

  const [suppliers, setSuppliers] = useState<Supplier[]>(() => {
    try {
      const stored = localStorage.getItem(DEMO_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed.suppliers)) return parsed.suppliers;
      }
    } catch { /* fallback */ }
    return initialDemoSuppliers;
  });

  const [rawSales, setSales] = useState<Sale[]>(() => {
    try {
      const stored = localStorage.getItem(DEMO_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed.sales)) return parsed.sales;
      }
    } catch { /* fallback */ }
    return initialDemoSales;
  });

  const [rawPurchases, setPurchases] = useState<Purchase[]>(() => {
    try {
      const stored = localStorage.getItem(DEMO_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed.purchases)) return parsed.purchases;
      }
    } catch { /* fallback */ }
    return initialDemoPurchases;
  });

  const [expenses, setExpenses] = useState<Expense[]>(() => {
    try {
      const stored = localStorage.getItem(DEMO_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed.expenses)) return parsed.expenses;
      }
    } catch { /* fallback */ }
    return initialDemoExpenses;
  });

  const [payments, setPayments] = useState<Payment[]>(() => {
    try {
      const stored = localStorage.getItem(DEMO_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed.payments)) return parsed.payments;
      }
    } catch { /* fallback */ }
    return initialDemoPayments;
  });

  const [gatewayTxns] = useState<GatewayTransaction[]>([]);

  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>(() => {
    try {
      const stored = localStorage.getItem(DEMO_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed.journalEntries)) return parsed.journalEntries;
      }
    } catch { /* fallback */ }
    return initialDemoJournals;
  });

  // Save to localStorage on every change
  useEffect(() => {
    try {
      const snap: BooksSnapshot = {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        business,
        accounts,
        customers,
        suppliers,
        sales: rawSales,
        purchases: rawPurchases,
        expenses,
        payments,
        gatewayTransactions: gatewayTxns,
        journalEntries,
      };
      localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(snap));
    } catch { /* Non-fatal */ }
  }, [business, accounts, customers, suppliers, rawSales, rawPurchases, expenses, payments, gatewayTxns, journalEntries]);

  // Derived state
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

  const controlIntegrity = useMemo<ControlIntegrityReport>(() => ({
    status: 'known',
    integrity: {
      receivable: {
        control: balances[ACCOUNT_CODES.RECEIVABLE] ?? 0,
        documents: sales.reduce((acc, s) => acc + outstandingOn(s), 0),
        difference: 0,
        ok: true,
      },
      payable: {
        control: balances[ACCOUNT_CODES.PAYABLE] ?? 0,
        documents: purchases.reduce((acc, p) => acc + outstandingOn(p), 0),
        difference: 0,
        ok: true,
      },
    },
  }), [balances, purchases, sales]);

  const integrityIssues = useMemo(
    () => AccountingEngine.checkIntegrity({
      accounts, entries: journalEntries, sales, purchases, expenses, payments,
      gateway: gatewayTxns, controls: controlIntegrity,
    }),
    [accounts, journalEntries, sales, purchases, expenses, payments, gatewayTxns, controlIntegrity],
  );

  const openInvoices = useMemo(
    () => sales.filter((s) => s.status === 'POSTED' && outstandingOn(s) > 0.005),
    [sales],
  );

  const openBills = useMemo(
    () => purchases.filter((p) => p.status === 'POSTED' && outstandingOn(p) > 0.005),
    [purchases],
  );

  const refFor = useCallback((kind: RefKind, onDate: string): string => {
    const pools: Record<RefKind, string[]> = {
      INV: rawSales.map((s) => s.invoiceNumber),
      PO: rawPurchases.map((p) => p.referenceNumber),
      EXP: expenses.map((e) => e.reference),
      PAY: payments.map((p) => p.reference),
      RCP: payments.map((p) => p.reference),
    };
    return nextReference(kind, pools[kind], onDate) ?? `${kind}-001`;
  }, [expenses, payments, rawPurchases, rawSales]);

  // Actions (all execute client-side locally, zero cloud)
  const loadFromCloud = useCallback(async (): Promise<boolean> => true, []);

  const addSale = useCallback(async (draft: SaleDraft): Promise<ActionResult> => {
    const invNo = refFor('INV', draft.date);
    const saleId = newId('sale');
    const jeId = newId('je');
    const items = draft.items.map((item) => ({
      id: newId('si'),
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discount: item.discount ?? 0,
      total: item.total,
    }));

    const newSale: Sale = {
      id: saleId,
      businessId: 'biz_demo',
      invoiceNumber: invNo,
      date: draft.date,
      dueDate: draft.date,
      paymentTermsDays: draft.paymentTermsDays,
      customerId: draft.customerId ?? newId('cust'),
      customerName: draft.customerName,
      subtotal: draft.subtotal,
      discountTotal: draft.discountTotal,
      taxAmount: draft.taxAmount,
      totalAmount: draft.totalAmount,
      paidAmount: draft.upfrontPaid,
      postingSnapshot: { upfrontPaid: draft.upfrontPaid },
      paymentStatus: draft.upfrontPaid >= draft.totalAmount ? 'PAID' : draft.upfrontPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID',
      paymentMethod: draft.paymentMethod,
      status: 'POSTED',
      journalEntryId: jeId,
      createdAt: new Date().toISOString(),
      createdBy: 'demo_user',
      items,
    };

    const lines: JournalEntry['lines'] = [
      { id: newId('jl'), journalEntryId: jeId, accountId: ACCOUNT_CODES.RECEIVABLE, accountName: 'Accounts receivable', accountType: 'ASSET', debit: draft.totalAmount, credit: 0 },
      { id: newId('jl'), journalEntryId: jeId, accountId: ACCOUNT_CODES.SALES, accountName: 'Sales revenue', accountType: 'REVENUE', debit: 0, credit: draft.subtotal },
    ];
    if (draft.taxAmount > 0) {
      lines.push({ id: newId('jl'), journalEntryId: jeId, accountId: ACCOUNT_CODES.VAT_PAYABLE, accountName: 'VAT payable (output tax)', accountType: 'LIABILITY', debit: 0, credit: draft.taxAmount });
    }

    const newJe: JournalEntry = {
      id: jeId,
      businessId: 'biz_demo',
      sequence: journalEntries.length + 1,
      transactionDate: draft.date,
      description: `Tax Invoice ${invNo} posted`,
      reference: invNo,
      sourceType: 'SALE',
      sourceId: saleId,
      createdAt: new Date().toISOString(),
      createdBy: 'demo_user',
      lines,
    };

    setSales((prev) => [newSale, ...prev]);
    setJournalEntries((prev) => [newJe, ...prev]);

    if (!customers.some((c) => c.name.toLowerCase() === draft.customerName.trim().toLowerCase())) {
      setCustomers((prev) => [...prev, {
        id: newId('cust'),
        businessId: 'biz_demo',
        name: draft.customerName.trim(),
        email: '',
        phone: '',
        address: '',
        panNumber: '',
        createdAt: new Date().toISOString(),
      }]);
    }

    return { ok: true, message: `Invoice ${invNo} recorded in Demo mode.` };
  }, [customers, journalEntries.length, refFor]);

  const addPurchase = useCallback(async (draft: PurchaseDraft): Promise<ActionResult> => {
    const poNo = refFor('PO', draft.date);
    const purId = newId('pur');
    const jeId = newId('je');
    const items = draft.items.map((item) => ({
      id: newId('pi'),
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discount: item.discount ?? 0,
      total: item.total,
    }));

    const newPurchase: Purchase = {
      id: purId,
      businessId: 'biz_demo',
      referenceNumber: poNo,
      date: draft.date,
      dueDate: draft.date,
      paymentTermsDays: draft.paymentTermsDays,
      supplierId: draft.supplierId ?? newId('supp'),
      supplierName: draft.supplierName,
      subtotal: draft.subtotal,
      discountTotal: draft.discountTotal,
      taxAmount: draft.taxAmount,
      totalAmount: draft.totalAmount,
      paidAmount: draft.upfrontPaid,
      postingSnapshot: { upfrontPaid: draft.upfrontPaid },
      paymentStatus: draft.upfrontPaid >= draft.totalAmount ? 'PAID' : draft.upfrontPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID',
      paymentMethod: draft.paymentMethod,
      status: 'POSTED',
      journalEntryId: jeId,
      createdAt: new Date().toISOString(),
      createdBy: 'demo_user',
      items,
    };

    const lines: JournalEntry['lines'] = [
      { id: newId('jl'), journalEntryId: jeId, accountId: ACCOUNT_CODES.INVENTORY, accountName: 'Inventory', accountType: 'ASSET', debit: draft.subtotal, credit: 0 },
    ];
    if (draft.taxAmount > 0) {
      lines.push({ id: newId('jl'), journalEntryId: jeId, accountId: ACCOUNT_CODES.VAT_RECEIVABLE, accountName: 'VAT receivable (input tax)', accountType: 'ASSET', debit: draft.taxAmount, credit: 0 });
    }
    lines.push({ id: newId('jl'), journalEntryId: jeId, accountId: ACCOUNT_CODES.PAYABLE, accountName: 'Accounts payable', accountType: 'LIABILITY', debit: 0, credit: draft.totalAmount });

    const newJe: JournalEntry = {
      id: jeId,
      businessId: 'biz_demo',
      sequence: journalEntries.length + 1,
      transactionDate: draft.date,
      description: `Purchase Bill ${poNo} posted`,
      reference: poNo,
      sourceType: 'PURCHASE',
      sourceId: purId,
      createdAt: new Date().toISOString(),
      createdBy: 'demo_user',
      lines,
    };

    setPurchases((prev) => [newPurchase, ...prev]);
    setJournalEntries((prev) => [newJe, ...prev]);

    if (!suppliers.some((s) => s.name.toLowerCase() === draft.supplierName.trim().toLowerCase())) {
      setSuppliers((prev) => [...prev, {
        id: newId('supp'),
        businessId: 'biz_demo',
        name: draft.supplierName.trim(),
        email: '',
        phone: '',
        address: '',
        panNumber: '',
        createdAt: new Date().toISOString(),
      }]);
    }

    return { ok: true, message: `Purchase ${poNo} recorded in Demo mode.` };
  }, [journalEntries.length, refFor, suppliers]);

  const addExpense = useCallback(async (draft: {
    accountId: string; date: string; description: string; amount: number;
    taxAmount: number; totalAmount: number; paymentMethod: Expense['paymentMethod'];
    notes?: string; priceIncludesVat?: boolean | null; idempotencyKey?: string | null;
  }): Promise<ActionResult> => {
    const expRef = refFor('EXP', draft.date);
    const expId = newId('exp');
    const jeId = newId('je');
    const accObj = accounts.find((a) => a.id === draft.accountId);
    const catName = accObj?.name ?? 'Expense';

    const newExp: Expense = {
      id: expId,
      businessId: 'biz_demo',
      reference: expRef,
      date: draft.date,
      accountId: draft.accountId,
      categoryName: catName,
      amount: draft.amount,
      taxAmount: draft.taxAmount,
      totalAmount: draft.totalAmount,
      paymentMethod: draft.paymentMethod,
      description: draft.description,
      status: 'POSTED',
      journalEntryId: jeId,
      createdAt: new Date().toISOString(),
      createdBy: 'demo_user',
    };

    const newJe: JournalEntry = {
      id: jeId,
      businessId: 'biz_demo',
      sequence: journalEntries.length + 1,
      transactionDate: draft.date,
      description: `Expense ${expRef} posted: ${draft.description}`,
      reference: expRef,
      sourceType: 'EXPENSE',
      sourceId: expId,
      createdAt: new Date().toISOString(),
      createdBy: 'demo_user',
      lines: [
        { id: newId('jl'), journalEntryId: jeId, accountId: draft.accountId, accountName: catName, accountType: 'EXPENSE', debit: draft.totalAmount, credit: 0 },
        { id: newId('jl'), journalEntryId: jeId, accountId: ACCOUNT_CODES.BANK, accountName: 'Bank account', accountType: 'ASSET', debit: 0, credit: draft.totalAmount },
      ],
    };

    setExpenses((prev) => [newExp, ...prev]);
    setJournalEntries((prev) => [newJe, ...prev]);

    return { ok: true, message: `Expense ${expRef} recorded in Demo mode.` };
  }, [accounts, journalEntries.length, refFor]);

  const addPayment = useCallback(async (draft: {
    linkedSaleId?: string; linkedPurchaseId?: string; amount: number;
    paymentMethod: Payment['paymentMethod']; date: string; notes?: string;
  }): Promise<ActionResult> => {
    const paymentType = draft.linkedSaleId ? 'INCOMING' as const : 'OUTGOING' as const;
    const refKind = paymentType === 'INCOMING' ? 'RCP' as const : 'PAY' as const;
    const ref = refFor(refKind, draft.date);
    const payId = newId('pay');
    const jeId = newId('je');

    let partyName = 'Party';
    if (draft.linkedSaleId) {
      const sale = rawSales.find((s) => s.id === draft.linkedSaleId);
      if (sale) partyName = sale.customerName;
    } else if (draft.linkedPurchaseId) {
      const pur = rawPurchases.find((p) => p.id === draft.linkedPurchaseId);
      if (pur) partyName = pur.supplierName;
    }

    const newPay: Payment = {
      id: payId,
      businessId: 'biz_demo',
      reference: ref,
      paymentType,
      linkedSaleId: draft.linkedSaleId,
      linkedPurchaseId: draft.linkedPurchaseId,
      partyName,
      amount: draft.amount,
      paymentMethod: draft.paymentMethod,
      date: draft.date,
      status: 'COMPLETED',
      docStatus: 'POSTED',
      journalEntryId: jeId,
      createdAt: new Date().toISOString(),
      createdBy: 'demo_user',
    };

    const newJe: JournalEntry = {
      id: jeId,
      businessId: 'biz_demo',
      sequence: journalEntries.length + 1,
      transactionDate: draft.date,
      description: `Settlement ${ref} posted`,
      reference: ref,
      sourceType: 'PAYMENT',
      sourceId: payId,
      createdAt: new Date().toISOString(),
      createdBy: 'demo_user',
      lines: paymentType === 'INCOMING' ? [
        { id: newId('jl'), journalEntryId: jeId, accountId: ACCOUNT_CODES.BANK, accountName: 'Bank account', accountType: 'ASSET', debit: draft.amount, credit: 0 },
        { id: newId('jl'), journalEntryId: jeId, accountId: ACCOUNT_CODES.RECEIVABLE, accountName: 'Accounts receivable', accountType: 'ASSET', debit: 0, credit: draft.amount },
      ] : [
        { id: newId('jl'), journalEntryId: jeId, accountId: ACCOUNT_CODES.PAYABLE, accountName: 'Accounts payable', accountType: 'LIABILITY', debit: draft.amount, credit: 0 },
        { id: newId('jl'), journalEntryId: jeId, accountId: ACCOUNT_CODES.BANK, accountName: 'Bank account', accountType: 'ASSET', debit: 0, credit: draft.amount },
      ],
    };

    setPayments((prev) => [newPay, ...prev]);
    setJournalEntries((prev) => [newJe, ...prev]);

    return { ok: true, message: `Settlement ${ref} recorded in Demo mode.` };
  }, [journalEntries.length, rawPurchases, rawSales, refFor]);

  const voidDocument = useCallback(async (kind: VoidableDocumentKind, id: string): Promise<ActionResult> => {
    if (kind === 'sale') setSales((prev) => prev.map((s) => s.id === id ? { ...s, status: 'VOIDED' } : s));
    if (kind === 'purchase') setPurchases((prev) => prev.map((p) => p.id === id ? { ...p, status: 'VOIDED' } : p));
    if (kind === 'expense') setExpenses((prev) => prev.map((e) => e.id === id ? { ...e, status: 'VOIDED' } : e));
    return { ok: true, message: 'Document voided in Demo mode.' };
  }, []);

  const voidPayment = useCallback(async (id: string): Promise<ActionResult> => {
    setPayments((prev) => prev.map((p) => p.id === id ? { ...p, docStatus: 'VOIDED' } : p));
    return { ok: true, message: 'Settlement voided in Demo mode.' };
  }, []);

  const startGatewayCollection = useCallback(async (): Promise<GatewayStartResult> => {
    return { ok: false, message: 'Gateway collection disabled in Demo mode.' };
  }, []);

  const settleGatewayTxn = useCallback(async (): Promise<ActionResult> => {
    return { ok: false, message: 'Gateway settlement disabled in Demo mode.' };
  }, []);

  const addAccount = useCallback((draft: Omit<Account, 'id' | 'businessId' | 'isActive'>): ActionResult => {
    if (accounts.some((a) => a.code === draft.code)) return { ok: false, message: `Code ${draft.code} in use.` };
    setAccounts((prev) => [...prev, { ...draft, id: newId('acc'), businessId: 'biz_demo', isActive: true }]);
    return { ok: true, message: `${draft.name} added.` };
  }, [accounts]);

  const archiveAccount = useCallback((id: string): ActionResult => {
    setAccounts((prev) => prev.map((a) => a.id === id ? { ...a, isActive: false } : a));
    return { ok: true, message: 'Account archived in Demo mode.' };
  }, []);

  const snapshot = useCallback((): BooksSnapshot => ({
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    business, accounts, customers, suppliers,
    sales: rawSales, purchases: rawPurchases, expenses, payments,
    gatewayTransactions: gatewayTxns, journalEntries,
  }), [business, accounts, customers, suppliers, rawSales, rawPurchases, expenses, payments, gatewayTxns, journalEntries]);

  const restore = useCallback((data: unknown): ActionResult => {
    const snap = data as Partial<BooksSnapshot>;
    if (snap.business) setBusiness(snap.business);
    if (Array.isArray(snap.accounts)) setAccounts(snap.accounts);
    if (Array.isArray(snap.customers)) setCustomers(snap.customers);
    if (Array.isArray(snap.suppliers)) setSuppliers(snap.suppliers);
    if (Array.isArray(snap.sales)) setSales(snap.sales);
    if (Array.isArray(snap.purchases)) setPurchases(snap.purchases);
    if (Array.isArray(snap.expenses)) setExpenses(snap.expenses);
    if (Array.isArray(snap.payments)) setPayments(snap.payments);
    if (Array.isArray(snap.journalEntries)) setJournalEntries(snap.journalEntries);
    return { ok: true, message: 'Demo state restored.' };
  }, []);

  const resetAll = useCallback(() => {
    try { localStorage.removeItem(DEMO_STORAGE_KEY); } catch { /* Non-fatal */ }
    setBusiness(initialDemoBusiness);
    setAccounts(defaultAccounts);
    setCustomers(initialDemoCustomers);
    setSuppliers(initialDemoSuppliers);
    setSales(initialDemoSales);
    setPurchases(initialDemoPurchases);
    setExpenses(initialDemoExpenses);
    setPayments(initialDemoPayments);
    setJournalEntries(initialDemoJournals);
  }, []);

  const saveBusinessSettings = useCallback(async (patch: BusinessSettingsPatch): Promise<ActionResult> => {
    setBusiness((prev) => ({ ...prev, ...patch }));
    return { ok: true, message: 'Business settings updated in Demo mode.' };
  }, []);

  return {
    user, setUser, business, setBusiness, accounts, setAccounts, customers, suppliers,
    sales, purchases, expenses, payments, gatewayTxns, journalEntries,
    isLoadingCloud: false, cloudError: null, storageError: null,
    balances, integrityIssues, controlIntegrity, receivableByCustomer, payableBySupplier,
    openInvoices, openBills, currentFy, defaultRange, lookup,
    codes: ACCOUNT_CODES,
    loadFromCloud, addSale, addPurchase, addExpense, addPayment, voidDocument, voidPayment,
    startGatewayCollection, settleGatewayTxn, addAccount, archiveAccount,
    snapshot, restore, resetAll, saveBusinessSettings, refFor,
  };
}
