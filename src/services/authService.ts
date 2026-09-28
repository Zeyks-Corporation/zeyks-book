/**
 * Authentication, in one place, on top of Neon Auth (Managed Better Auth).
 *
 * `SupabaseAuthAdapter()` keeps the Supabase-shaped method names so existing
 * call sites can be migrated without a wider rewrite. The browser client lives
 * in `lib/neon.ts`; this file is the only place the auth flow is shaped.
 *
 * Google-only sign-in. Email + password and magic-link / OTP have been turned
 * off on the Neon Auth side; this file no longer exposes them, so the only way
 * the front door opens is signInWithGoogle().
 *
 * One limit that cannot be coded around: Google is Neon's shared OAuth app
 * (`isShared: true` in `neon_auth.project_config`), and the authorization URL
 * it builds carries no `prompt` parameter. Google therefore answers with the
 * account this browser is already signed in to, without ever showing a chooser
 * — and Neon's provider config exposes only client id/secret, so nothing here
 * can ask for one. What this file *can* guarantee is that a sign-in never
 * starts on top of a session the server still holds, and that a sign-out is
 * only reported once the server agrees.
 */

import { supabase, claimProfile, fetchMyProfile } from '../lib/neon';
import { resolveSignInHandoff, resolveSignOutOutcome, ownProfileRow } from '../lib/session';
import type { SignOutKind, SignOutOutcome } from '../lib/session';

/** What Neon Auth's getSession returns. We name it here so callers can read it. */
export interface NeonSession {
  user: { id: string; email: string; name?: string | null; createdAt?: string };
  access_token: string;
}

export interface AuthResult {
  user: NeonSession['user'] | null;
  session: { user: NeonSession['user'] } | null;
  error: string | null;
}

/** Map a Neon-side error to a sentence the UI can show without leaking internals. */
function cleanAuthError(message: string | null | undefined): string | null {
  if (!message) return null;
  const lower = message.toLowerCase();
  if (lower.includes('rate') || lower.includes('too many')) {
    return 'Too many attempts. Please wait a minute and try again.';
  }
  if (lower.includes('network') || lower.includes('fetch')) {
    return 'You appear to be offline. Check your connection and try again.';
  }
  if (lower.includes('invalid') || lower.includes('expired')) {
    return 'That code is invalid or has expired.';
  }
  if (lower.includes('not found') || lower.includes('no user')) {
    return 'No account exists for that email.';
  }
  if (lower.includes('email')) {
    return 'That email address is not accepted. Please use a real mailbox.';
  }
  return 'Sign-in failed. Please try again.';
}

const GENERIC_SIGNIN = 'Sign-in is temporarily unavailable. Please try again later.';

/**
 * Ask the auth server what this browser is still holding, and let go of it.
 *
 * Returns the facts `resolveSignInHandoff` decides from. Every read is
 * `forceFetch`: the SDK answers from an in-memory cache otherwise, and a cache
 * filled earlier in this page's life is exactly the stale answer being cleared.
 */
async function inspectStaleSession(): Promise<{
  reachable: boolean; hadSession: boolean; signOutError: string | null;
}> {
  let read;
  try {
    read = await supabase.auth.getSession({ forceFetch: true });
  } catch {
    return { reachable: false, hadSession: false, signOutError: null };
  }
  if (read.error) return { reachable: false, hadSession: false, signOutError: null };
  if (!read.data.session?.user) return { reachable: true, hadSession: false, signOutError: null };
  try {
    const { error } = await supabase.auth.signOut();
    return { reachable: true, hadSession: true, signOutError: error?.message ?? null };
  } catch (e) {
    return { reachable: true, hadSession: true, signOutError: e instanceof Error ? e.message : 'sign-out error' };
  }
}

/**
 * Google OAuth. The browser is redirected to Google's consent screen, then back
 * to the Neon Auth callback. The session resolves asynchronously — App.tsx's
 * `onAuthStateChange` listener picks it up; this function returns `user: null`
 * on success because the redirect has not completed yet.
 *
 * A session the server still holds is ended first. The person clicking this
 * button asked to sign in; if the browser answered from a session it never
 * released, they would come back as the same account they were trying to leave.
 */
export async function signInWithGoogle(): Promise<AuthResult> {
  const handoff = resolveSignInHandoff(await inspectStaleSession());
  if (!handoff.proceed) {
    return { user: null, session: null, error: handoff.error };
  }
  try {
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google' });
    if (error) {
      return { user: null, session: null, error: cleanAuthError(error.message) ?? GENERIC_SIGNIN };
    }
    // Redirect is in flight. The session will arrive via onAuthStateChange.
    return { user: null, session: null, error: null };
  } catch (e) {
    return { user: null, session: null, error: cleanAuthError(e instanceof Error ? e.message : null) ?? GENERIC_SIGNIN };
  }
}

/**
 * Ask the server whether this browser is still signed in.
 *
 * Three answers, because "no" and "I cannot tell" are different facts: an
 * unreachable auth server must not lock a person into an account they just
 * left, but a server that still names a user is proof the sign-out did not
 * take — and the next reload would quietly put them back in it.
 */
async function sessionAfterExit(): Promise<'gone' | 'present' | 'unknown'> {
  try {
    const { data, error } = await supabase.auth.getSession({ forceFetch: true });
    if (error) return 'unknown';
    return data.session?.user ? 'present' : 'gone';
  } catch {
    return 'unknown';
  }
}

/**
 * Sign the current user out cleanly. Neon Auth has only a single-device scope
 * model — the JWT's 15-minute expiry is the bound on tokens already issued.
 */
export async function signOut(_kind: SignOutKind = 'this-device'): Promise<SignOutOutcome> {
  let firstError: string | null = null;
  try {
    const { error } = await supabase.auth.signOut();
    firstError = error ? cleanAuthError(error.message) : null;
  } catch (e) {
    firstError = cleanAuthError(e instanceof Error ? e.message : 'Sign out error');
  }
  // A clean answer from `signOut()` is the library's opinion, not the server's.
  // Only the read above can say whether this browser really gave the session up.
  const stillHeld = await sessionAfterExit() === 'present';
  return resolveSignOutOutcome({
    firstError,
    localRetryError: null,
    sessionCleared: !stillHeld,
  });
}

/**
 * Who the auth server says is signed in, right now.
 *
 * `forceFetch` because this is the read the whole application is keyed off:
 * whose books to load, whose name to show, whether to show the front door at
 * all. Without it the SDK answers from a session cache filled earlier in this
 * page's life, so a session that ended elsewhere — revoked, expired, replaced
 * by another tab's sign-in — keeps running this screen against the wrong
 * person's data.
 */
export async function getSession(): Promise<{
  session: { user: NeonSession['user'] } | null;
  error: string | null;
}> {
  try {
    const { data, error } = await supabase.auth.getSession({ forceFetch: true });
    if (error) return { session: null, error: cleanAuthError(error.message) };
    if (!data.session?.user) return { session: null, error: null };
    return {
      session: {
        user: {
          id: data.session.user.id,
          email: data.session.user.email ?? '',
        },
      },
      error: null,
    };
  } catch (e) {
    return { session: null, error: cleanAuthError(e instanceof Error ? e.message : 'Session error') };
  }
}

/**
 * The bearer token the API server expects on every authenticated route.
 *
 * Returns `null` when signed out; the server then answers 401 and the caller
 * treats it as "session ended", not a malformed request.
 */
export async function getAccessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** Subscribe to Neon auth state changes. */
export function onAuthStateChange(
  callback: (event: string, session: { user: NeonSession['user'] } | null) => void,
): () => void {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    const u = session?.user;
    callback(event, u ? { user: { id: u.id, email: u.email ?? '' } } : null);
  });
  return () => data.subscription.unsubscribe();
}

/**
 * Fetch the signed-in user's profile row, which carries the app-level role.
 *
 * `claim_profile()` runs first when no profile row exists yet, so the very
 * first sign-in lands a usable record. The role field defaults to 'user'.
 *
 * The row is accepted only when it belongs to `userId`. An admin's profile read
 * is not limited by row-level security, so without that check another person's
 * profile could be shown as the current one.
 */
export async function getProfile(userId: string): Promise<{
  profile: {
    id: string;
    email: string;
    fullName: string;
    appRole: 'user' | 'plus' | 'premium' | 'admin';
    createdAt: string;
  } | null;
  error: string | null;
}> {
  try {
    let row = ownProfileRow(await fetchMyProfile(userId), userId);
    if (!row) {
      const claimed = await claimProfile();
      if (claimed) row = ownProfileRow(await fetchMyProfile(userId), userId);
    }
    if (!row) return { profile: null, error: null };
    const { data: sess } = await supabase.auth.getSession();
    const sessionUser = sess.session?.user;
    return {
      profile: {
        id: row.id,
        email: row.email || sessionUser?.email || '',
        fullName: row.full_name || (sessionUser as { name?: string | null } | undefined)?.name || row.email.split('@')[0] || '',
        appRole: (['user', 'plus', 'premium', 'admin'].includes(row.role) ? row.role : 'user') as 'user' | 'plus' | 'premium' | 'admin',
        createdAt: sessionUser && (sessionUser as { created_at?: string }).created_at
          ? (sessionUser as { created_at?: string }).created_at!
          : new Date().toISOString(),
      },
      error: null,
    };
  } catch (e) {
    return { profile: null, error: e instanceof Error ? e.message : 'Profile error' };
  }
}
