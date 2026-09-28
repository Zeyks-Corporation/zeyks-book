/**
 * App-level role gating.
 *
 * The DB column `profiles.role` carries one of four values — user / plus /
 * premium / admin — and the rest of the app reads role through this module
 * so the rules live in one place.
 *
 *   user    — signed up, no subscription; the dashboard is reachable but
 *             every section, including adding or editing anything, is locked.
 *   plus    — Starter plan (399 NPR/mo): dashboard, sales, purchases,
 *             expenses and settings.
 *   premium — Premium plan (599 NPR/mo): every feature.
 *   admin   — staff at zeyksbook, hidden /king panel.
 *
 * Permissions are NOT additive (a premium does not also inherit `plus`); they
 * are intentionally distinct so a tier change is meaningful and visible.
 *
 * CURRENTLY DORMANT: `ROLE_GATING_ENABLED` below is false, so every signed-in
 * account has all of it. Read that constant before acting on this table.
 */

export type AppRole = 'user' | 'plus' | 'premium' | 'admin';

export const ALL_ROLES: AppRole[] = ['user', 'plus', 'premium', 'admin'];

/** A human-readable label and price (per month, NPR) for the pricing UI. */
export const ROLE_LABEL: Record<AppRole, string> = {
  user: 'Free account',
  plus: 'Starter',
  premium: 'Premium',
  admin: 'Admin',
};

export const ROLE_PRICE_NPR: Partial<Record<AppRole, number>> = {
  plus: 399,
  premium: 599,
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
  | 'settings'
  | 'admin';

/**
 * Which features each role unlocks. Locked features stay visible in the
 * sidebar and open a plan-lock screen — nothing is hidden.
 *
 * `admin` is not a plan benefit at any setting of the switch: it is the staff
 * panel, and only role='admin' reaches it.
 */
export const FEATURE_FOR_ROLE: Record<AppRole, ReadonlyArray<Feature>> = {
  user: [],
  plus: ['dashboard', 'sales', 'purchases', 'expenses', 'settings'],
  premium: ['dashboard', 'sales', 'purchases', 'expenses', 'settings', 'payments', 'reports', 'health', 'inventory'],
  admin: ['dashboard', 'sales', 'purchases', 'expenses', 'settings', 'payments', 'reports', 'health', 'inventory', 'admin'],
};

/**
 * Plan gating, switched off.
 *
 * While this is false every signed-in account reaches every bookkeeping
 * section — the dashboard, sales, purchases, expenses, payments, reports,
 * health, inventory and settings — regardless of `profiles.role`. The sidebar
 * shows no locks, the plan-lock screen never renders, and the "New" action is
 * available everywhere, because all three derive from `roleHasFeature`.
 *
 * `profiles.role` is still read, stored and displayed; nothing about a
 * person's plan is lost by flipping this. Set it back to true to restore the
 * matrix above exactly as it was.
 *
 * The `/king` admin panel is deliberately NOT covered by this. It is guarded
 * by `isAppAdmin`, which still requires role='admin' — it can change other
 * people's plans and erase their books, so it is not a section of the app.
 */
export const ROLE_GATING_ENABLED = false;

export function roleHasFeature(role: AppRole | undefined, feature: Feature): boolean {
  if (!role) return false;
  // Switching the gate off opens the paid sections; it does not hand out staff
  // access, which keeps meaning what the matrix says it means.
  if (!ROLE_GATING_ENABLED) return feature === 'admin' ? role === 'admin' : true;
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
    'Everything in Starter, plus:',
    'Aged receivables & payables (30, 60, 90 days)',
    'A4 print-ready financial statements & tax reports',
    'Automatic ledger & document health checks',
    'Settlements & receipts against any invoice or bill',
    'Inventory: items, stock adjustments, valuation, low-stock alerts',
  ],
};

/** The paid plan a role is on; staff admins and free accounts have none. */
export function planOfRole(role: AppRole | undefined): 'plus' | 'premium' | null {
  if (role === 'plus' || role === 'premium') return role;
  return null;
}

/**
 * The cheapest plan that unlocks a feature. Used by the lock screen so a free
 * account clicking a Starter-tier section is nudged to Starter, not Premium.
 */
export function planForFeature(feature: Feature): 'plus' | 'premium' {
  return FEATURE_FOR_ROLE.plus.includes(feature) ? 'plus' : 'premium';
}

/** Plan purchases happen over WhatsApp until online checkout is wired. */
export const WHATSAPP_PLAN_URL = 'https://wa.me/9779701066114?text=I%20want%20to%20buy%20a%20plan%20of%20Zeyks%20Book';

export function isAppAdmin(role: AppRole | undefined): boolean {
  return role === 'admin';
}

export function isPayingTier(role: AppRole | undefined): boolean {
  return role === 'plus' || role === 'premium';
}

/**
 * Whether the subscription wall should replace the app for this account.
 *
 * The wall is a second, coarser gate than `roleHasFeature`: it hides the whole
 * shell rather than one section, so it has to read the same switch. Deriving
 * it from `isPayingTier` alone left a signed-in free account outside the app
 * even with `ROLE_GATING_ENABLED` off — the sections were unlocked, but the
 * screen in front of them was the plan page.
 */
export function paywallHoldsAccount(role: AppRole | undefined): boolean {
  if (!ROLE_GATING_ENABLED) return false;
  return !(isPayingTier(role) || isAppAdmin(role));
}

/** Default role for newly-created profiles (matches the DB column default). */
export const DEFAULT_ROLE: AppRole = 'user';