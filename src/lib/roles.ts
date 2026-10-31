/**
 * App-level role gating.
 *
 * The DB column `profiles.role` carries customer plans only — user / plus /
 * premium — and the rest of the app reads plans through this module
 * so the rules live in one place.
 *
 *   user    — Starter: may read records for businesses they belong to, but
 *             cannot change business data or accounting settings.
 *   plus    — Plus plan (299 NPR/mo): dashboard, sales, purchases,
 *             expenses and settings.
 *   premium — Premium plan (499 NPR/mo): every feature.
 * Staff at Zeyks Book are tracked separately by `profiles.is_staff`.
 */

export type AppRole = 'user' | 'plus' | 'premium';

export const ALL_ROLES: AppRole[] = ['user', 'plus', 'premium'];

/** A human-readable label and price (per month, NPR) for the pricing UI. */
export const ROLE_LABEL: Record<AppRole, string> = {
  user: 'Starter / User',
  plus: 'Plus',
  premium: 'Premium',
};

export const ROLE_PRICE_NPR: Partial<Record<AppRole, number>> = {
  plus: 299,
  premium: 499,
};

/** Every feature the app knows about; one row in the capability matrix. */
export type Feature =
  | 'dashboard'
  | 'sales'
  | 'purchases'
  | 'expenses'
  | 'payments'
  | 'reports'
  | 'health'
  | 'inventory'
  | 'tools'
  | 'settings';

/**
 * Which features each role unlocks. Locked features stay visible in the
 * sidebar and open a plan-lock screen — nothing is hidden.
 *
 * Staff pages are guarded separately by `profiles.is_staff`.
 */
export const FEATURE_FOR_ROLE: Record<AppRole, ReadonlyArray<Feature>> = {
  user: ['dashboard', 'sales', 'purchases', 'expenses', 'payments', 'reports', 'inventory'],
  plus: ['dashboard', 'sales', 'purchases', 'expenses', 'payments', 'reports', 'settings', 'inventory'],
  premium: ['dashboard', 'sales', 'purchases', 'expenses', 'settings', 'payments', 'reports', 'health', 'inventory', 'tools'],
};

/** Write capabilities that exist in the shipped product today. The database
 * remains authoritative; these values control whether the UI offers actions. */
export type PlanWriteCapability = 'business.write' | 'inventory.manage' | 'report.export';

const WRITE_CAPABILITIES_FOR_ROLE: Record<AppRole, ReadonlyArray<PlanWriteCapability>> = {
  user: [],
  plus: ['business.write', 'report.export'],
  premium: ['business.write', 'inventory.manage', 'report.export'],
};

export function roleCanWrite(role: AppRole | undefined, capability: PlanWriteCapability): boolean {
  return role ? WRITE_CAPABILITIES_FOR_ROLE[role].includes(capability) : false;
}

/**
 * Plan gating, switched on.
 *
 * While this is true, `FEATURE_FOR_ROLE` decides what each account reaches.
 * Set it to false to open every bookkeeping section to every signed-in
 * account regardless of `profiles.role` — the sidebar locks, the plan-lock
 * screen and the "New" action all derive from `roleHasFeature`, so one flip
 * turns them off together and nothing about a person's plan is lost.
 *
 * Staff routes remain separate from subscription entitlements.
 */
export const ROLE_GATING_ENABLED = true;

export function roleHasFeature(role: AppRole | undefined, feature: Feature): boolean {
  if (!role) return false;
  if (!ROLE_GATING_ENABLED) return true;
  return FEATURE_FOR_ROLE[role].includes(feature);
}

/**
 * Marketing bullet lists for the two paid plans. Shared by the pricing page
 * and the dashboard's upgrade section so the copy cannot drift apart.
 */
export const PLAN_FEATURES: Record<'plus' | 'premium', ReadonlyArray<string>> = {
  plus: [
    'Double-entry accounting engine by construction',
    'Bikram Sambat (BS) & AD calendar support',
    'Sales recording with invoice numbers and credit terms',
    'Purchase recording with bill numbers and credit terms',
    'Expense tracking with category mapping',
    'Settings: currency, fiscal year, VAT, branding',
    'JSON backup from Settings',
  ],
  premium: [
    'Everything in Plus:',
    'Aged receivables & payables (30, 60, 90 days)',
    'A4 print-ready financial statements & tax reports',
    'Automatic ledger & document health checks',
    'Settlements & receipts against any invoice or bill',
    'Inventory: items, stock adjustments, valuation, low-stock alerts',
    'Budgets, bank reconciliation, recurring invoices, attachments, fixed assets',
  ],
};

/** The paid plan a role is on; staff admins and free accounts have none. */
export function planOfRole(role: AppRole | undefined): 'plus' | 'premium' | null {
  if (role === 'plus' || role === 'premium') return role;
  return null;
}

/**
 * The cheapest plan that unlocks a feature. Used by the lock screen so a free
 * account clicking a Plus-tier section is nudged to Plus, not Premium.
 */
export function planForFeature(feature: Feature): 'plus' | 'premium' {
  return FEATURE_FOR_ROLE.plus.includes(feature) ? 'plus' : 'premium';
}

/** Plan purchases happen over WhatsApp until online checkout is wired. */
export const WHATSAPP_PLAN_URL = 'https://wa.me/9779701066114?text=I%20want%20to%20buy%20a%20plan%20of%20Zeyks%20Book';

export function isPayingTier(role: AppRole | undefined): boolean {
  return role === 'plus' || role === 'premium';
}

/**
 * Starter accounts can open their authorized records in read-only mode.
 */
export function paywallHoldsAccount(role: AppRole | undefined): boolean {
  void role;
  return false;
}

/** Default role for newly-created profiles (matches the DB column default). */
export const DEFAULT_ROLE: AppRole = 'user';
