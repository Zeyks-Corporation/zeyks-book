export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  /** Legacy per-business role; the app-level subscription/admin role lives in profiles.role. */
  role?: 'OWNER' | 'ACCOUNTANT' | 'VIEWER';
  /**
   * App-level role that drives route guards and the admin panel.
   *   user    — signed up, no subscription, dashboard locked.
   *   plus    — Plus plan (299 NPR, kirana-tier, dashboard + sales + purchase only).
   *   premium — Premium plan (499 NPR, every feature).
   *   admin   — staff at zeyksbook, hidden /king panel.
   */
  appRole?: 'user' | 'plus' | 'premium' | 'admin';
  isStaff?: boolean;
  createdAt: string;
}

export interface BusinessProfile {
  id: string;
  userId: string;
  businessName: string;
  ownerName: string;
  email: string;
  phone: string;
  panNumber: string;
  address: string;
  city: string;
  currency: 'NPR';
  currencySymbol: 'रू' | 'NPR';
  timezone: 'Asia/Kathmandu';
  /** BS month the fiscal year opens in. 4 = Shrawan, Nepal's statutory start. */
  fiscalYearStartMonth: number;
  /** Registered for VAT with the IRD. Drives whether tax lines are posted. */
  vatRegistered: boolean;
  /** Standard Nepal VAT rate. */
  vatRate: number;
  /** Track stock through an inventory account instead of expensing on purchase. */
  trackInventory: boolean;
  createdAt: string;
}

export interface Account {
  id: string;
  businessId: string;
  code: string;
  name: string;
  type: AccountType;
  description?: string;
  isActive: boolean;
  /** System accounts are referenced by the posting rules and cannot be deleted. */
  systemAccount?: boolean;
}

export interface Party {
  id: string;
  businessId: string;
  name: string;
  email?: string;
  phone?: string;
  panNumber?: string;
  address?: string;
  createdAt: string;
}

export type Customer = Party;
export type Supplier = Party;

export type PaymentStatus = 'PAID' | 'UNPAID' | 'PARTIALLY_PAID';
export type PaymentMethod = 'CASH' | 'BANK' | 'ESEWA' | 'KHALTI';
export type DocStatus = 'POSTED' | 'VOIDED';

export interface LineItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  /** quantity * unitPrice - discount, VAT exclusive. */
  total: number;
}

/**
 * What a document recorded as settled *at the moment it was posted*.
 *
 * `sales.upfront_paid` / `purchases.upfront_paid` are frozen snapshots written
 * once by `post_sale` / `post_purchase`. They are kept for one purpose only:
 * reproducing a historical document — a reprinted invoice can show what the
 * original said it received on the day it was issued.
 *
 * This is NOT a balance and NOT a second source of money. A live outstanding
 * figure is always `Total − SUM(COMPLETED + POSTED settlement rows)`. Nothing
 * may add this value to a paid total or subtract it from a balance; the name
 * says `snapshot` so that mistake is visible in review.
 */
export interface PostingSnapshot {
  upfrontPaid: number;
}

interface DocumentBase {
  id: string;
  businessId: string;
  /** The document's own date — when it was written, not when it is payable. */
  date: string;
  /**
   * Whole days of credit agreed when this document was posted; 0 means it fell
   * due immediately (cash terms). It is the historical record of what was
   * agreed, so a reprint can still state the terms it was posted under, and it
   * is one of the two facts the due date is held to.
   */
  paymentTermsDays: number;
  /**
   * The contractual due date — `date + paymentTermsDays`, computed by the
   * posting RPC inside the same transaction that writes the journal, so the day
   * the form showed and the day the books hold cannot disagree.
   *
   * Aging reads THIS and nothing else. It is metadata about WHEN the money is
   * expected, never an amount: no balance, journal line or settlement figure is
   * derived from it.
   */
  dueDate: string;
  items: LineItem[];
  subtotal: number;
  discountTotal: number;
  taxAmount: number;
  totalAmount: number;
  /**
   * Every settlement linked to this document: COMPLETED rows with doc_status
   * POSTED, summed. Derived by `reconcile()` from the `payments` rows and never
   * written by a form.
   *
   * Deliberately the ONLY settable amount here. The `upfront_paid` column the
   * database also stores is a frozen posting-time record of what was settled
   * when the document was created — it is not a second source of money, and
   * nothing in this app derives a balance from it. See `SaleDraft` below.
   */
  paidAmount: number;
  /**
   * The posting-time record, for historical document presentation only.
   * Every balance reads `paidAmount` and the settlement rows; never this.
   */
  postingSnapshot: PostingSnapshot;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  status: DocStatus;
  notes?: string;
  journalEntryId?: string;
  createdAt: string;
  createdBy: string;
}

export interface Sale extends DocumentBase {
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  /** Cost of the goods sold, posted against inventory when tracking is on. */
  costOfGoods?: number;
}

export interface Purchase extends DocumentBase {
  referenceNumber: string;
  supplierId: string;
  supplierName: string;
}

/**
 * A sale a form is asking the server to post.
 *
 * `upfrontPaid` lives here — on the request — and nowhere on `Sale`, because it
 * is not a property of the document: `post_sale` records it as a real
 * settlement row in `payments`, exactly the row a later receipt would create,
 * and that row is the only thing any balance is derived from. Keeping the field
 * off the document type is what makes the rule structural rather than a
 * convention: no code can add an upfront amount to a paid total by accident.
 */
export type SaleDraft = Omit<
  Sale,
  'id' | 'businessId' | 'invoiceNumber' | 'status' | 'paidAmount' | 'postingSnapshot'
  | 'paymentStatus' | 'createdAt' | 'createdBy' | 'customerId'
  // `dueDate` is the database's to compute from the date and the terms, so a
  // draft cannot carry one — `paymentTermsDays` is inherited and required
  // instead, which is the only due-date input the browser has.
  | 'dueDate'
> & {
  customerName: string;
  customerId?: string;
  /** Settled as the document is posted; the server turns it into a payment row. */
  upfrontPaid: number;
};

/** The purchase equivalent of `SaleDraft`. */
export type PurchaseDraft = Omit<
  Purchase,
  'id' | 'businessId' | 'referenceNumber' | 'status' | 'paidAmount' | 'postingSnapshot'
  | 'paymentStatus' | 'createdAt' | 'createdBy' | 'supplierId'
  // Same rule as `SaleDraft`: terms travel, the due date does not.
  | 'dueDate'
> & {
  supplierName: string;
  supplierId?: string;
  priceIncludesVat?: boolean;
  /** Settled as the document is posted; the server turns it into a payment row. */
  upfrontPaid: number;
};

export interface Expense {
  id: string;
  businessId: string;
  accountId: string;
  categoryName: string;
  date: string;
  description: string;
  amount: number;
  taxAmount: number;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  reference: string;
  status: DocStatus;
  notes?: string;
  journalEntryId?: string;
  createdAt: string;
  createdBy: string;
}

export type GatewayProvider = 'ESEWA' | 'KHALTI';
export type GatewayStatus = 'INITIATED' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'REFUNDED' | 'CANCELED';

/**
 * The derived settlement state of a collection. Derived, never stored twice:
 * `gateway_transactions.payment_id` plus that payment's doc_status is the truth
 * (public.gateway_settlement_state in migration 011 mirrors this).
 */
export type GatewaySettlementState = 'UNSETTLED' | 'SETTLED' | 'VOIDED';

/**
 * An online collection attempt — the provider interaction and its verification
 * state, not an accounting fact.
 *
 * A COMPLETED row means the gateway confirmed the money moved; it does NOT mean
 * a payment exists. Only a successful settle_gateway_txn (migration 012) writes
 * one, and `paymentId` is the link it leaves behind.
 */
export interface GatewayTransaction {
  id: string;
  businessId: string;
  provider: GatewayProvider;
  /** Khalti pidx / eSewa transaction_uuid — the provider's identifier for this attempt. */
  gatewayRef: string;
  /** The provider's own transaction id, written once, by the settlement. */
  gatewayTransactionId?: string;
  amount: number;
  /** Both providers settle in NPR; 001 pins every business to NPR too. */
  currency: string;
  status: GatewayStatus;
  /** Set once, by a server-side verification that actually reached the provider. */
  verifiedAt?: string;
  linkedSaleId?: string;
  customerName: string;
  /** The settlement this collection produced, if any. */
  paymentId?: string;
  /** auth.uid() at initiation — never a client-supplied value. */
  initiatedBy?: string;
  initiatedAt: string;
  settledAt?: string;
  lastError?: string;
}

export interface Payment {
  id: string;
  businessId: string;
  amount: number;
  paymentMethod: PaymentMethod;
  date: string;
  reference: string;
  bankName?: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
  paymentType: 'INCOMING' | 'OUTGOING';
  linkedSaleId?: string;
  linkedPurchaseId?: string;
  partyId?: string;
  partyName: string;
  /** Set when the money arrived through eSewa or Khalti rather than by hand. */
  gatewayTransactionId?: string;
  docStatus: DocStatus;
  notes?: string;
  journalEntryId?: string;
  createdAt: string;
  createdBy: string;
}

export interface JournalLine {
  id: string;
  journalEntryId: string;
  accountId: string;
  accountName: string;
  accountType: AccountType;
  debit: number;
  credit: number;
}

export type JournalSource = 'SALE' | 'PURCHASE' | 'EXPENSE' | 'PAYMENT' | 'MANUAL' | 'REVERSAL' | 'CLOSING' | 'OPENING';

export interface JournalEntry {
  id: string;
  businessId: string;
  transactionDate: string;
  /** Monotonic within a business; breaks same-date ordering ties in the ledger. */
  sequence: number;
  description: string;
  reference: string;
  sourceType: JournalSource;
  sourceId?: string;
  lines: JournalLine[];
  /** Points at the entry this one reverses. */
  reversesEntryId?: string;
  /** Set on the original once a reversal has been posted against it. */
  reversedByEntryId?: string;
  createdBy: string;
  createdAt: string;
}

export type ViewTab =
  | 'dashboard' | 'sales' | 'purchases' | 'expenses'
  | 'payments' | 'reports' | 'health' | 'settings'
  | 'inventory';

export interface LedgerEntry {
  date: string;
  sequence: number;
  journalEntryId: string;
  reference: string;
  description: string;
  accountId: string;
  accountName: string;
  accountType: AccountType;
  debit: number;
  credit: number;
  runningBalance: number;
}

export interface DateRange {
  from: string;
  to: string;
  label: string;
}

export interface DashboardMetrics {
  revenue: number;
  costOfSales: number;
  grossProfit: number;
  operatingExpenses: number;
  netProfit: number;
  cashBalance: number;
  bankBalance: number;
  walletBalance: number;
  liquidTotal: number;
  accountsReceivable: number;
  accountsPayable: number;
  vatPayable: number;
  inventoryValue: number;
  recentTransactions: RecentTransaction[];
}

export interface RecentTransaction {
  id: string;
  date: string;
  type: 'Sale' | 'Purchase' | 'Expense' | 'Payment';
  description: string;
  amount: number;
  status: string;
  paymentMethod: PaymentMethod;
  voided: boolean;
}

export type IssueSeverity = 'ERROR' | 'WARNING';

export interface IntegrityIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  /** Where to look — an entry reference, account name or document number. */
  subject?: string;
}

/**
 * Stage 21 — Inventory Management System types.
 *
 * `inventory_items` is the catalogue of stockable things the business sells
 * or uses. `inventory_movements` is the immutable ledger of every change in
 * on-hand quantity — a sale, a purchase receipt, an adjustment, a voiding
 * reversal. The view `inventory_stock_value` joins them and computes the
 * weighted-average cost and the on-hand total on every read, so there is no
 * cached `current_qty` that can drift out of sync.
 */
export interface InventoryItem {
  id: string;
  businessId: string;
  sku: string;
  name: string;
  description: string;
  unit: string;
  category: string;
  defaultCost: number;
  reorderPoint: number;
  reorderQty: number;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
}

/** A row in `inventory_stock_value` — the catalogue enriched with totals. */
export interface InventoryStockRow extends InventoryItem {
  onHand: number;
  avgCost: number;
  stockValue: number;
}

export type InventoryMovementDirection = 'IN' | 'OUT';
export type InventoryMovementReason =
  | 'PURCHASE' | 'SALE' | 'ADJUST_IN' | 'ADJUST_OUT'
  | 'SCRAP' | 'OPENING' | 'VOID_REVERSAL';

export interface InventoryMovement {
  id: string;
  businessId: string;
  itemId: string;
  movementDate: string;
  direction: InventoryMovementDirection;
  reason: InventoryMovementReason;
  quantity: number;
  unitCost: number | null;
  sourceType: 'SALE' | 'PURCHASE' | 'ADJUSTMENT' | 'OPENING' | null;
  sourceId: string | null;
  signedQuantity: number;
  notes: string;
  createdAt: string;
  createdBy: string;
}

/**
 * One side of the control-account reconciliation.
 *
 * Both figures are derived by the DATABASE (public.control_account_integrity(),
 * migration 014) — the ledger control account from journal lines and the
 * document side from document totals minus their valid settlements — so the
 * answer is the same however much of the book a client happens to have loaded.
 */
export interface ControlSideIntegrity {
  /** Net balance of the control account, from journal lines. */
  control: number;
  /** Live outstanding from the documents, net of valid settlements. */
  documents: number;
  /** control − documents. Zero exactly when the two agree. */
  difference: number;
  /** The database's own verdict for this side. */
  ok: boolean;
}

export interface ControlIntegrity {
  receivable: ControlSideIntegrity;
  payable: ControlSideIntegrity;
}

/**
 * What the browser knows about that diagnosis: the database's answer, or the
 * reason it could not be asked. There is deliberately no third state, because
 * "not checked" must never be reportable as "fine".
 */
export type ControlIntegrityReport =
  | { status: 'known'; integrity: ControlIntegrity }
  | { status: 'unavailable'; reason: string };

export interface BooksSnapshot {
  schemaVersion: number;
  exportedAt: string;
  business: BusinessProfile;
  accounts: Account[];
  customers: Customer[];
  suppliers: Supplier[];
  sales: Sale[];
  purchases: Purchase[];
  expenses: Expense[];
  payments: Payment[];
  gatewayTransactions: GatewayTransaction[];
  journalEntries: JournalEntry[];
}
