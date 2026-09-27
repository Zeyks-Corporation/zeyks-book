/**
 * Authentication, in one place, on top of Neon Auth (Managed Better Auth).
 *
 * `SupabaseAuthAdapter()` keeps the Supabase-shaped method names so existing
 * call sites can be migrated without a wider rewrite. The browser client lives
 * in `lib/supabase.ts`; this file is the only place the auth flow is shaped.
 *
 * Google-only sign-in. Email + password and magic-link / OTP have been turned
 * off on the Neon Auth side; this file no longer exposes them, so the only way
 * the front door opens is signInWithGoogle().
 */

import { supabase, claimProfile, fetchMyProfile } from '../lib/supabase';
import { resolveSignOutOutcome } from '../lib/session';
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
 * Google OAuth. The browser is redirected to Google's consent screen, then back
 * to the Neon Auth callback. The session resolves asynchronously — App.tsx's
 * `onAuthStateChange` listener picks it up; this function returns `user: null`
 * on success because the redirect has not completed yet.
 */
export async function signInWithGoogle(): Promise<AuthResult> {
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
 * Sign the current user out cleanly. Neon Auth has only a single-device scope
 * model — the JWT's 15-minute expiry is the bound on tokens already issued.
 */
export async function signOut(_kind: SignOutKind = 'this-device'): Promise<SignOutOutcome> {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) {
      return resolveSignOutOutcome({ firstError: cleanAuthError(error.message), localRetryError: null, sessionCleared: false });
    }
    return resolveSignOutOutcome({ firstError: null, localRetryError: null, sessionCleared: true });
  } catch (e) {
    return resolveSignOutOutcome({
      firstError: cleanAuthError(e instanceof Error ? e.message : 'Sign out error'),
      localRetryError: null,
      sessionCleared: false,
    });
  }
}

/** Retrieve the current Neon session, if any. */
export async function getSession(): Promise<{
  session: { user: NeonSession['user'] } | null;
  error: string | null;
}> {
  try {
    const { data, error } = await supabase.auth.getSession();
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
 */
export async function getProfile(_userId: string): Promise<{
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
    let row = await fetchMyProfile();
    if (!row) {
      const claimed = await claimProfile();
      if (claimed) row = await fetchMyProfile();
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
