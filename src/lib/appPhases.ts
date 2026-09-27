/**
 * Pure onboarding/auth state machine.
 *
 * The application must never confuse "we could not check your memberships"
 * with "you have no memberships": the first is an error to retry, the second
 * is the only state that offers to create a business. Keeping the decision in
 * a pure function makes that distinction testable without a browser.
 */

export interface MembershipLike {
  businessId: string;
  userId?: string;
  role?: string;
  createdAt: string;
}

export type SessionPhase = 'checking-session' | 'unauthenticated' | 'authenticated';

export type MembershipState =
  | { kind: 'pending' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'ready'; memberships: MembershipLike[] };

export type DataState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

export type AppPhase =
  | 'checking-session'
  | 'unauthenticated'
  | 'loading-memberships'
  | 'membership-error'
  | 'loading-data'
  | 'data-error'
  | 'onboarding'
  | 'ready';

/**
 * Resolve which screen the app should show. Membership lookup failure yields
 * `membership-error` — never `onboarding` — so a transient failure can never
 * create a second business.
 */
export function resolveAppPhase(input: {
  session: SessionPhase;
  membership: MembershipState;
  data: DataState;
}): AppPhase {
  const { session, membership, data } = input;

  if (session === 'checking-session') return 'checking-session';
  if (session === 'unauthenticated') return 'unauthenticated';
  if (membership.kind === 'pending') return 'loading-memberships';
  if (membership.kind === 'error') return 'membership-error';
  if (membership.kind === 'empty') return 'onboarding';

  if (data.kind === 'error') return 'data-error';
  if (data.kind === 'ready') return 'ready';
  return 'loading-data';
}

/**
 * Deterministic active-business rule.
 *
 * TEMPORARY: there is no business switcher yet, so with more than one
 * membership the app always picks the same one — oldest membership first
 * (createdAt ascending), ties broken by businessId — so PC and phone agree.
 * Replace this with an explicit switcher in a later phase.
 */
export function selectActiveMembership<T extends MembershipLike>(memberships: T[]): T | null {
  if (memberships.length === 0) return null;
  const sorted = [...memberships].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.businessId !== b.businessId) return a.businessId < b.businessId ? -1 : 1;
    return 0;
  });
  return sorted[0] ?? null;
}

/**
 * Keep only the memberships that provably belong to the signed-in user.
 *
 * Row-level security already filters `business_memberships` on `auth.uid()`, so
 * a row carrying a different user id means the token that answered is NOT the
 * token this screen thinks is signed in — the usual shape of an account switch
 * where a load started for person A resolves after person B signed in. Dropping
 * those rows is the difference between showing an empty account and showing
 * someone else's books. An unknown id (null) cannot be verified either, so it
 * yields nothing rather than trusting the whole list.
 */
export function membershipsOwnedBy<T extends MembershipLike>(
  memberships: T[], userId: string | null | undefined,
): T[] {
  if (!userId) return [];
  return memberships.filter((m) => m.userId === userId);
}

export type AuthAction =
  | 'bootstrap'
  | 'sign-out'
  | 'reload-books'
  | 'refresh-profile'
  | 'token-only'
  | 'ignore';

/** Map a Neon auth event to a deferred action (never run inside the callback). */
export function resolveAuthEvent(event: string): AuthAction {
  switch (event) {
    case 'INITIAL_SESSION': return 'bootstrap';
    case 'SIGNED_IN': return 'reload-books';
    case 'SIGNED_OUT': return 'sign-out';
    case 'TOKEN_REFRESHED': return 'token-only';
    case 'USER_UPDATED': return 'refresh-profile';
    default: return 'ignore';
  }
}
