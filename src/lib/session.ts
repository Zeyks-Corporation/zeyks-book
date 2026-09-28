/**
 * Session identity and exit policy — pure, so it can be tested without a browser.
 *
 * Four questions live here, all answered without touching React or the SDK:
 *
 *   1. Which sessions does a sign-out end? Signing out on one device must not
 *      silently kill the other one, so the default scope is `local`
 *      (this device only) and `global` is only ever asked for explicitly.
 *   2. Did the sign-out actually work? `signOut()` can fail after the server
 *      revoke, so the outcome is decided from what the client reports about its
 *      stored session — never assumed.
 *   3. May a sign-in start at all? A fresh hand-off on top of a session the
 *      server still holds is answered by that session, so the previous person
 *      comes back and it looks like the app ignores who signed in.
 *   4. May an in-flight book load still write state? A load that began before a
 *      sign-out must never repopulate the books it was fetching, so each load
 *      carries the epoch it started in and is dropped once the epoch moves.
 */

/* -------------------------------------------------------------------------- */
/* Scope                                                                      */
/* -------------------------------------------------------------------------- */

export type SignOutKind = 'this-device' | 'everywhere';

/** The two exit scopes. `local` ends this device, `global` revokes the rest. */
export type SignOutScope = 'local' | 'global';

/**
 * Map the user's choice to a sign-out scope.
 *
 * Deliberately not the auth library's default: signing out everywhere defaults to
 * `global`, so an ordinary sign-out on a PC would revoke the phone's refresh
 * token without the person ever asking for that.
 */
export function signOutScope(kind: SignOutKind): SignOutScope {
  return kind === 'everywhere' ? 'global' : 'local';
}

export const SIGN_OUT_LABELS: Record<SignOutKind, string> = {
  'this-device': 'Sign out',
  everywhere: 'Sign out everywhere',
};

export const SIGN_OUT_HINTS: Record<SignOutKind, string> = {
  'this-device': 'Ends the session on this device only. Your phone stays signed in.',
  everywhere: 'Ends the session on every device, including your phone.',
};

/* -------------------------------------------------------------------------- */
/* Outcome                                                                    */
/* -------------------------------------------------------------------------- */

export interface SignOutAttempt {
  /** Error from the scope the user asked for (the server revoke). */
  firstError: string | null;
  /** Error from the fallback local-only attempt, if one was needed. */
  localRetryError: string | null;
  /** Whether the session really is gone afterwards, as the server last said. */
  sessionCleared: boolean;
}

export interface SignOutOutcome {
  /** True only when this device really is signed out. */
  cleared: boolean;
  /** Non-null when something must be shown to the user. */
  error: string | null;
}

/**
 * Decide what to tell the user after a sign-out attempt.
 *
 * A failed server revoke is not a failure to sign out: the client removes its
 * stored session anyway, and `sessionCleared` reports whether it did. That case
 * is still surfaced (the remote revoke did not happen), but the app proceeds to
 * the auth screen. When the session survives, `cleared` is false and the error
 * is never null, so the caller can refuse to pretend the logout worked.
 */
export function resolveSignOutOutcome(attempt: SignOutAttempt): SignOutOutcome {
  if (attempt.sessionCleared) {
    return { cleared: true, error: attempt.firstError };
  }
  return {
    cleared: false,
    error: attempt.localRetryError ?? attempt.firstError
      ?? 'This device could not be signed out. Close the browser to end the session.',
  };
}

/* -------------------------------------------------------------------------- */
/* Sign-in handoff                                                            */
/* -------------------------------------------------------------------------- */

export interface StaleSessionReport {
  /** Whether the auth server answered the session read at all. */
  reachable: boolean;
  /** Whether the browser was still carrying a live session. */
  hadSession: boolean;
  /** Error from the sign-out that was attempted, when one was needed. */
  signOutError: string | null;
}

/**
 * Decide whether a fresh Google hand-off may start.
 *
 * The front door only appears when this app believes there is no session, and
 * that belief can be wrong: the boot read failed, another tab signed in, the
 * person came back to a tab left open overnight. Starting OAuth on top of a
 * session the server still holds gets that session back — which is what "it
 * keeps using the same session" looks like from the other side of the screen.
 *
 * Three answers, in order of what is knowable:
 *   - the server could not be reached → there is nothing to clear, and the
 *     redirect will report its own failure, so proceed;
 *   - nobody is signed in → proceed;
 *   - somebody is signed out of, but the sign-out failed → do not proceed. A
 *     sign-in started here is answered by the account that is already there,
 *     so the honest move is to say so instead of performing a no-op.
 */
export function resolveSignInHandoff(report: StaleSessionReport): { proceed: boolean; error: string | null } {
  const held = report.reachable && report.hadSession && Boolean(report.signOutError);
  if (!held) return { proceed: true, error: null };
  return {
    proceed: false,
    error: 'This browser is still signed in to another account and could not be '
      + 'signed out. Check your connection and try again.',
  };
}

/* -------------------------------------------------------------------------- */
/* Epoch guard                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Monotonic session epoch.
 *
 * Bumped on every local session clear. A load records the epoch it started in;
 * once the epoch moves, that load is stale and must not write a single row —
 * otherwise a fetch that was already in flight at sign-out can repopulate the
 * previous person's books after the state was cleared.
 */
export function nextEpoch(epoch: number): number {
  return epoch + 1;
}

export function isCurrentEpoch(epoch: number, startedAt: number): boolean {
  return epoch === startedAt;
}

/* -------------------------------------------------------------------------- */
/* Profile identity                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Keep a profile row only when it is the signed-in person's own.
 *
 * Row-level security lets an admin read every profile row
 * (`profiles_select_admin USING (is_app_admin())`), so an unscoped profile
 * lookup can hand back another person's name, email and role — and the UI then
 * says "signed in as" somebody else. The query filters by id; this decides the
 * answer is safe to use even when the server returns something unexpected.
 */
export function ownProfileRow<T extends { id: string }>(
  row: T | null,
  userId: string | null | undefined,
): T | null {
  if (!row || !userId) return null;
  return row.id === userId ? row : null;
}
