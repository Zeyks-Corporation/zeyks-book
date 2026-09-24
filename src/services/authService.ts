/**
 * Authentication — every session in this app comes from Supabase Auth.
 *
 * There is no second way in. This module used to keep its own session object in
 * `localStorage` and hand it to the UI, which meant "signed in" was a claim made
 * by the client: the access token in it was a string this code had just built,
 * no RLS policy had ever seen it, and every RLS-backed read (the books, the
 * profiles row, the accounting RPCs) could not work with it. The UI said signed
 * in while the database said nobody.
 *
 * The rule now, in one line: a session exists only when Supabase Auth issued
 * one. Concretely —
 *
 *   - the emailed code is verified by the API server (which issued it), and the
 *     successful answer is a one-time Supabase token hash;
 *   - `verifyOtp` exchanges that hash with `supabase.auth.verifyOtp`, which is
 *     the only place a session is created;
 *   - `signOut` reports whether the *stored* session is really gone, by reading
 *     it back, rather than assuming the revoke worked;
 *   - a profile read that fails returns a failure, not a user assembled out of
 *     local guesses.
 */

import { supabase } from '../lib/supabase';
import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import type { UserProfile } from '../types';
import { resolveSignOutOutcome, signOutScope } from '../lib/session';
import type { SignOutKind, SignOutOutcome } from '../lib/session';
import { sendResendOtp, verifyResendOtp } from './resendService';

export interface AuthResult {
  user: User | null;
  session: Session | null;
  error: string | null;
}

function cleanAuthError(message: string | null | undefined): string | null {
  if (!message) return null;
  return message.replace(/supabase/gi, 'auth system');
}

/** Where Supabase should send a password-recovery link back to. */
function recoveryRedirectTo(): string | undefined {
  if (typeof window === 'undefined' || !window.location?.origin) return undefined;
  return `${window.location.origin}/signin`;
}

/**
 * Send a sign-in / sign-up verification code.
 *
 * The server generates it, stores a hash with an expiry, and emails the plain
 * code; nothing on this side ever knows or keeps the code.
 */
export async function requestOtp(
  email: string,
  name?: string,
): Promise<{ success: boolean; message?: string; error?: string }> {
  return await sendResendOtp(email, name);
}

/**
 * Verify a code and turn it into a real Supabase session.
 *
 * Two steps, both required:
 *   1. the API server verifies the code against the row it stored, and answers
 *      with a single-use Supabase token hash;
 *   2. that hash is exchanged with Supabase Auth, which issues the session the
 *      rest of the app (RLS, RPCs, storage) actually accepts.
 *
 * A missing session is a failure. There is no fallback branch.
 */
export async function verifyOtp(
  email: string,
  code: string,
  name?: string,
): Promise<AuthResult> {
  const verified = await verifyResendOtp(email, code);
  if (!verified.success || !verified.tokenHash) {
    return {
      user: null,
      session: null,
      error: verified.error ?? 'Invalid or expired verification code.',
    };
  }

  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: verified.tokenHash,
    type: 'magiclink',
  });

  if (error || !data.session || !data.user) {
    return {
      user: null,
      session: null,
      error: cleanAuthError(error?.message)
        ?? 'That verification code could not be exchanged for a session. Request a new code and try again.',
    };
  }

  // A first-time sign-in created the account from the code request; keep the
  // name the person typed for the profile screen. Best effort, and only when
  // there is nothing recorded yet.
  const fullName = name?.trim();
  if (fullName && !data.user.user_metadata?.full_name) {
    const { data: updated } = await supabase.auth.updateUser({ data: { full_name: fullName } });
    if (updated.user) {
      return { user: updated.user, session: data.session, error: null };
    }
  }

  return { user: data.user, session: data.session, error: null };
}

/**
 * Register with email + password, through Supabase Auth.
 *
 * The OTP screen does not use this path — it verifies an emailed code instead —
 * but password registration is a supported Supabase flow and must go through
 * Supabase rather than being assembled locally.
 */
export async function signUp(
  email: string,
  password: string,
  fullName: string,
): Promise<AuthResult> {
  const cleanEmail = email.trim().toLowerCase();
  if (!password) {
    return {
      user: null,
      session: null,
      error: 'A password is required to register with a password.',
    };
  }

  const { data, error } = await supabase.auth.signUp({
    email: cleanEmail,
    password,
    options: { data: { full_name: fullName.trim() } },
  });

  if (error) {
    return { user: null, session: null, error: cleanAuthError(error.message) };
  }
  // With email confirmation on, `session` is null until the address is
  // confirmed — a real state, not an error to paper over.
  return { user: data.user, session: data.session, error: null };
}

/**
 * Sign in with email + password, through Supabase Auth.
 *
 * Without a password this refuses rather than inventing a session: the OTP path
 * is `requestOtp` + `verifyOtp`.
 */
export async function signIn(
  email: string,
  password?: string,
): Promise<AuthResult> {
  const cleanEmail = email.trim().toLowerCase();
  if (!password) {
    return {
      user: null,
      session: null,
      error: 'Enter your password, or use the emailed verification code instead.',
    };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: cleanEmail,
    password,
  });

  if (error) {
    return { user: null, session: null, error: cleanAuthError(error.message) };
  }
  return { user: data.user, session: data.session, error: null };
}

/**
 * Sign the current user out cleanly.
 *
 * A failed server revoke is reported, never assumed away: the stored session is
 * read back after the attempt, and when it survives, a local-only sign-out is
 * retried so this device really is signed out. `resolveSignOutOutcome` decides
 * what the person is told.
 */
export async function signOut(kind: SignOutKind = 'this-device'): Promise<SignOutOutcome> {
  let firstError: string | null = null;
  let localRetryError: string | null = null;

  const stillSignedIn = async (): Promise<boolean> => {
    const { data, error } = await supabase.auth.getSession();
    return Boolean(error) || Boolean(data.session);
  };

  try {
    const { error } = await supabase.auth.signOut({ scope: signOutScope(kind) });
    if (error) firstError = cleanAuthError(error.message);
  } catch (e) {
    firstError = cleanAuthError(e instanceof Error ? e.message : 'Sign out error');
  }

  let sessionCleared = !(await stillSignedIn());

  if (!sessionCleared) {
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) localRetryError = cleanAuthError(error.message);
    } catch (e) {
      localRetryError = cleanAuthError(e instanceof Error ? e.message : 'Sign out error');
    }
    sessionCleared = !(await stillSignedIn());
  }

  return resolveSignOutOutcome({ firstError, localRetryError, sessionCleared });
}

/**
 * Send a password-recovery email.
 *
 * Supabase Auth owns this flow end to end: it mints the recovery token and
 * emails the link, and the app only handles the resulting `PASSWORD_RECOVERY`
 * session event.
 */
export async function requestPasswordReset(email: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    redirectTo: recoveryRedirectTo(),
  });
  return { error: error ? cleanAuthError(error.message) : null };
}

/** Set a new password for the currently authenticated session. */
export async function updatePassword(newPassword: string): Promise<{ error: string | null }> {
  if (!newPassword) return { error: 'A new password is required.' };
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  return { error: error ? cleanAuthError(error.message) : null };
}

/** Re-send the sign-up confirmation email, through Supabase Auth. */
export async function resendConfirmation(email: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: email.trim().toLowerCase(),
  });
  return { error: error ? cleanAuthError(error.message) : null };
}

/** Retrieve the current session, if any. Supabase's, and only Supabase's. */
export async function getSession(): Promise<{
  session: Session | null;
  error: string | null;
}> {
  const { data, error } = await supabase.auth.getSession();
  if (error) return { session: null, error: cleanAuthError(error.message) };
  return { session: data.session, error: null };
}

/** Subscribe to auth state changes. */
export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
): () => void {
  const { data } = supabase.auth.onAuthStateChange(callback);
  return () => {
    data.subscription.unsubscribe();
  };
}

/**
 * Fetch the user's profile row.
 *
 * A failed read is a failed read. The caller renders what the session itself
 * carries (`profileFromAuthUser`) rather than this module inventing a profile
 * out of an email address.
 */
export async function getProfile(userId: string): Promise<{
  profile: UserProfile | null;
  error: string | null;
}> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, created_at')
    .eq('id', userId)
    .single();

  if (error) {
    return { profile: null, error: cleanAuthError(error.message) };
  }

  return {
    profile: {
      id: data.id,
      email: data.email,
      fullName: data.full_name || '',
      createdAt: data.created_at,
    },
    error: null,
  };
}
