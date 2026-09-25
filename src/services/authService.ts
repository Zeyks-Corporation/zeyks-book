import {
  auth, functions,
} from '../lib/firebase';
import {
  signInWithCustomToken, signOut as fbSignOut, onAuthStateChanged, type User,
  GoogleAuthProvider, signInWithPopup,
} from 'firebase/auth';
import { httpsCallable, type Functions } from 'firebase/functions';
import type { UserProfile } from '../types';
import { resolveSignOutOutcome, signOutScope } from '../lib/session';
import type { SignOutKind, SignOutOutcome } from '../lib/session';
import { supabase, syncSupabaseSession } from '../lib/supabase';

/**
 * Authentication, in one place, on top of Firebase Auth.
 *
 * This file has been on three backends. It minted a fake "Resend" session, then
 * spoke email-OTP, and now speaks Firebase through two callables
 * (`requestOtp` / `verifyOtp`) that email a six-digit code and mint a custom
 * token the client exchanges for a real session. The flow a person sees is
 * unchanged: enter email → receive code → enter code.
 *
 * The session's ID token is what every Firestore rule check resolves through,
 * and `paymentGateway` forwards the same token as its Bearer header, so the
 * payment API verifies one identity everywhere.
 */

export interface AuthResult {
  user: User | null;
  session: { user: User } | null;
  error: string | null;
}

/** Map a backend error to a sentence. Firebase's terms are client-safe here. */
function cleanAuthError(message: string | null | undefined): string | null {
  if (!message) return null;
  return message
    .replace(/firebase/i, 'auth system')
    .replace(/auth\/(.+)/, (_m, code: string) => {
      const known: Record<string, string> = {
        'too-many-requests': 'Too many attempts. Please wait a minute and try again.',
        'network-request-failed': 'You appear to be offline. Check your connection and try again.',
        'user-not-found': 'No account exists for that email.',
        'invalid-credential': 'That code is invalid or has expired.',
      };
      return known[code] ?? 'Sign-in failed. Please try again.';
    });
}

/** The one generic sentence the callable surfaces for any internal failure. */
const GENERIC_SIGNIN = 'Sign-in is temporarily unavailable. Please try again later.';

/** Callable names as deployed (functions/src/index.ts). */
const OTP_REQUEST = 'requestOtp';
const OTP_VERIFY = 'verifyOtp';

/**
 * Send an email sign-in code (OTP). Firebase (via Resend) owns the code, not
 * this app.
 */
export async function requestOtp(
  email: string,
  name?: string,
): Promise<{ success: boolean; message?: string; error?: string }> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return { success: false, error: 'Please enter your email address.' };
  try {
    const call = httpsCallable<unknown, { success: boolean; message?: string }>(
      functions as Functions, OTP_REQUEST,
    );
    // The name rides along for the account-creation path; the server may use
    // it for the greeting but never trusts it for authorization.
    const res = await call({ email: trimmed, name: name?.trim() || undefined });
    return { success: true, message: res.data.message };
  } catch (e) {
    return { success: false, error: extractCallableMessage(e, 'Could not send the verification code.') };
  }
}

/**
 * Verify the emailed code and adopt the Firebase session it returns.
 *
 * The session is real: its ID token is what the client already sends with every
 * Firestore read. There is no fallback code and no locally invented session —
 * a wrong or expired code simply fails.
 */
export async function verifyOtp(email: string, code: string, _name?: string): Promise<AuthResult> {
  const trimmedEmail = email.trim().toLowerCase();
  try {
    const call = httpsCallable<unknown, { custom_token: string; user_id: string }>(
      functions as Functions, OTP_VERIFY,
    );
    const res = await call({ email: trimmedEmail, code: code.trim() });
    await signInWithCustomToken(auth, res.data.custom_token);
    return { user: auth.currentUser, session: auth.currentUser ? { user: auth.currentUser } : null, error: null };
  } catch (e) {
    return {
      user: null,
      session: null,
      error: extractCallableMessage(e, 'Invalid or expired verification code.'),
    };
  }
}

/** Pull a client-safe sentence out of a callable failure. */
function extractCallableMessage(e: unknown, fallback: string): string {
  const code = (e as { code?: string }).code;
  if (code === 'functions/failed-precondition' || code === 'functions/invalid-argument'
    || code === 'functions/resource-exhausted') {
    const text = (e as { message?: string }).message ?? '';
    return text.replace(/^functions\w*\s*/i, '').replace(/\(.*\)\s*$/, '').trim() || fallback;
  }
  return GENERIC_SIGNIN;
}

/**
 * Sign in using Firebase Google Authentication.
 */
export async function signInWithGoogle(): Promise<AuthResult> {
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await signInWithPopup(auth, provider);
    if (result.user) {
      await syncSupabaseSession(result.user).catch((e) => {
        console.warn('[Auth] syncSupabaseSession error during Google sign-in:', e);
      });
    }
    return {
      user: result.user,
      session: result.user ? { user: result.user } : null,
      error: null,
    };
  } catch (e: unknown) {
    const errorObj = e as { code?: string; message?: string };
    if (errorObj?.code === 'auth/popup-closed-by-user' || errorObj?.code === 'auth/cancelled-popup-request') {
      return { user: null, session: null, error: null };
    }
    const message = errorObj?.message || 'Google sign-in failed.';
    return {
      user: null,
      session: null,
      error: cleanAuthError(message),
    };
  }
}

/**
 * Create an account with a password.
 *
 * The product signs people in with an emailed code (above); this exists for the
 * password path the sign-in screen keeps for password managers. It is kept for
 * interface compatibility: the email-code flow is the product's front door.
 */
export async function signUp(
  email: string,
  password: string,
  fullName: string,
): Promise<AuthResult> {
  void email; void password; void fullName;
  return { user: null, session: null, error: 'Please sign in with the email code we send you.' };
}

/** Sign in with email + password (kept for interface compatibility). */
export async function signIn(email: string, password?: string): Promise<AuthResult> {
  void email; void password;
  return { user: null, session: null, error: 'Please sign in with the email code we send you.' };
}

/**
 * Sign the current user out cleanly.
 *
 * `kind` decides the scope: `'this-device'` ends only this device's session;
 * `'everywhere'` is accepted for interface compatibility — Firebase sessions
 * end on this device, and the ID token's hour-long lifetime is the bound on
 * anything already issued elsewhere.
 */
export async function signOut(kind: SignOutKind = 'this-device'): Promise<SignOutOutcome> {
  void signOutScope(kind);
  try {
    await fbSignOut(auth);
    await supabase.auth.signOut({ scope: signOutScope(kind) }).catch(() => {});
  } catch (e) {
    return { cleared: false, error: cleanAuthError(e instanceof Error ? e.message : 'Sign out error') };
  }
  return resolveSignOutOutcome({ firstError: null, localRetryError: null, sessionCleared: !auth.currentUser });
}

/** Send a password-recovery email — not applicable in the email-code flow. */
export async function requestPasswordReset(email: string): Promise<{ error: string | null }> {
  void email;
  return { error: 'Password sign-in is not used. Sign in with the email code instead.' };
}

/** Set a new password for the currently authenticated session. */
export async function updatePassword(_newPassword: string): Promise<{ error: string | null }> {
  return { error: 'Password sign-in is not used. Sign in with the email code instead.' };
}

/** Re-send the sign-up confirmation email — not applicable in the email-code flow. */
export async function resendConfirmation(email: string): Promise<{ error: string | null }> {
  void email;
  return { error: 'Sign-in codes are sent automatically when you request one.' };
}

/** Retrieve the current Firebase session, if any. */
export async function getSession(): Promise<{
  session: { user: User } | null;
  error: string | null;
}> {
  try {
    const user = auth.currentUser ?? (await new Promise<User | null>((resolve) => {
      const unsub = onAuthStateChanged(auth, (u: User | null) => { unsub(); resolve(u); });
    }));
    if (user) {
      await syncSupabaseSession(user).catch(() => {});
    }
    return { session: user ? { user } : null, error: null };
  } catch (e) {
    return { session: null, error: cleanAuthError(e instanceof Error ? e.message : 'Session error') };
  }
}

/** Subscribe to Firebase auth state changes. */
export function onAuthStateChange(
  callback: (event: string, session: { user: User } | null) => void,
): () => void {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      await syncSupabaseSession(user).catch(() => {});
    }
    callback(user ? 'SIGNED_IN' : 'SIGNED_OUT', user ? { user } : null);
  });
}

/**
 * Fetch the signed-in user's profile document.
 *
 * Reads from Supabase profiles, with fallback to Firebase user metadata.
 */
export async function getProfile(userId: string): Promise<{
  profile: UserProfile | null;
  error: string | null;
}> {
  void userId;
  try {
    const user = auth.currentUser;
    if (user) {
      await syncSupabaseSession(user).catch(() => {});

      // Only query Supabase profiles if an active authenticated Supabase session is established
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', session.user.id)
          .maybeSingle();

        if (!error && data) {
          return {
            profile: {
              id: data.id,
              email: data.email || user.email || '',
              fullName: data.full_name || user.displayName || '',
              createdAt: data.created_at || user.metadata.creationTime || new Date().toISOString(),
            },
            error: null,
          };
        }
      }

      // Clean metadata from authenticated user without throwing 401
      return {
        profile: {
          id: user.uid,
          email: user.email || '',
          fullName: user.displayName || user.email?.split('@')[0] || '',
          createdAt: user.metadata.creationTime || new Date().toISOString(),
        },
        error: null,
      };
    }

    return { profile: null, error: null };
  } catch (e) {
    return { profile: null, error: e instanceof Error ? e.message : 'Profile error' };
  }
}


