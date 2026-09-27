/**
 * App-level role gating.
 *
 * The DB column `profiles.role` carries one of four values — user / plus /
 * premium / admin — and the rest of the app reads role through this module
 * so the rules live in one place.
 *
 *   user    — signed up, no subscription, dashboard is locked.
 *   plus    — Starter plan (399 NPR/mo): dashboard, sales, purchase only.
 *   premium — Premium plan (599 NPR/mo): every feature.
 *   admin   — staff at zeyksbook, hidden /king panel.
 *
 * Permissions are NOT additive (a premium does not also inherit `plus`); they
 * are intentionally distinct so a tier change is meaningful and visible.
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
  | 'admin';

/**
 * Which features each role unlocks.
 *
 * admin implicitly gets every feature for testing; the king panel itself is
 * gated by a separate `admin` flag (handled by the route, not by the matrix).
 */
export const FEATURE_FOR_ROLE: Record<AppRole, ReadonlyArray<Feature>> = {
  user: [],
  plus: ['dashboard', 'sales', 'purchases'],
  premium: ['dashboard', 'sales', 'purchases', 'expenses', 'payments', 'reports', 'health', 'inventory'],
  admin: ['dashboard', 'sales', 'purchases', 'expenses', 'payments', 'reports', 'health', 'inventory', 'admin'],
};

export function roleHasFeature(role: AppRole | undefined, feature: Feature): boolean {
  if (!role) return false;
  return FEATURE_FOR_ROLE[role].includes(feature);
}

export function isAppAdmin(role: AppRole | undefined): boolean {
  return role === 'admin';
}

export function isPayingTier(role: AppRole | undefined): boolean {
  return role === 'plus' || role === 'premium';
}

/** Default role for newly-created profiles (matches the DB column default). */
export const DEFAULT_ROLE: AppRole = 'user';