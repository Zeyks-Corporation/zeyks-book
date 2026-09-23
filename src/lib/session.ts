/**
 * Session exit policy — pure, so it can be tested without a browser.
 *
 * Three questions live here, all answered without touching React or Supabase:
 *
 *   1. Which sessions does a sign-out end? Signing out on one device must not
 *      silently kill the other one, so the default scope is `local`
 *      (this device only) and `global` is only ever asked for explicitly.
 *   2. Did the sign-out actually work? `signOut()` can fail after the server
 *      revoke, so the outcome is decided from what the client reports about its
 *      stored session — never assumed.
 *   3. May an in-flight book load still write state? A load that began before a
 *      sign-out must never repopulate the books it was fetching, so each load
 *      carries the epoch it started in and is dropped once the epoch moves.
 */

/* -------------------------------------------------------------------------- */
/* Scope                                                                      */
/* -------------------------------------------------------------------------- */

export type SignOutKind = 'this-device' | 'everywhere';

/** Supabase's own scopes. `local` ends this device, `global` revokes the rest. */
export type SignOutScope = 'local' | 'global';

/**
 * Map the user's choice to a Supabase scope.
 *
 * Deliberately not the library default: `supabase.auth.signOut()` defaults to
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
  /** Whether the client's own stored session is gone afterwards. */
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
