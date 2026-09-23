/**
 * Supabase Auth service.
 *
 * Thin wrapper that keeps every call site from importing the raw client.
 * Uses the publishable key only — no service-role key, no RLS bypass.
 */

import { supabase } from '../lib/supabase';
import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import type { UserProfile } from '../types';
import { resolveSignOutOutcome, signOutScope } from '../lib/session';
import type { SignOutKind, SignOutOutcome } from '../lib/session';

export interface AuthResult {
  user: User | null;
  session: Session | null;
  error: string | null;
}

/**
 * Register a new user.
 *
 * `full_name` is stored in `raw_user_meta_data` so the `handle_new_user`
 * trigger (004) can copy it into `profiles.full_name` automatically.
 */
export async function signUp(
  email: string,
  password: string,
  fullName: string,
): Promise<AuthResult> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });
  if (error) return { user: null, session: null, error: error.message };
  return { user: data.user, session: data.session, error: null };
}

/** Sign in with email + password. */
export async function signIn(
  email: string,
  password: string,
): Promise<AuthResult> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) return { user: null, session: null, error: error.message };
  return { user: data.user, session: data.session, error: null };
}

/**
 * Sign the current user out.
 *
 * `kind` defaults to `'this-device'`, which asks for scope `local`: signing out
 * on a PC must not silently revoke the phone's refresh token, which is what the
 * library's `global` default does.
 *
 * Two things make this more than a passthrough:
 *   * a failed server revoke can still leave the stored session behind, so a
 *     second, local-only attempt is made before giving up;
 *   * the outcome is then *checked* with getSession() rather than inferred from
 *     the absence of an error, so the app never claims a logout that did not
 *     happen (the caller is told `cleared: false` instead).
 */
export async function signOut(kind: SignOutKind = 'this-device'): Promise<SignOutOutcome> {
  const { error: firstError } = await supabase.auth.signOut({ scope: signOutScope(kind) });

  let localRetryError: string | null = null;
  if (firstError) {
    // Local scope never touches the network on the way out of storage, so this
    // is a real second chance, not a repeat of the same failure.
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    localRetryError = error?.message ?? null;
  }

  const { data, error: sessionError } = await supabase.auth.getSession();
  const sessionCleared = !sessionError && !data.session;

  return resolveSignOutOutcome({
    firstError: firstError?.message ?? null,
    localRetryError,
    sessionCleared,
  });
}

/**
 * Send a password-recovery email. The link returns to this origin and the
 * client raises PASSWORD_RECOVERY once Supabase parses it.
 */
export async function requestPasswordReset(email: string): Promise<{ error: string | null }> {
  const redirectTo = typeof window !== 'undefined' ? window.location.origin : undefined;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  return { error: error?.message ?? null };
}

/** Set a new password for the currently authenticated (recovery) session. */
export async function updatePassword(newPassword: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  return { error: error?.message ?? null };
}

/** Re-send the sign-up confirmation email (only needed when confirmation is on). */
export async function resendConfirmation(email: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.resend({ type: 'signup', email });
  return { error: error?.message ?? null };
}

/** Retrieve the current session, if any. */
export async function getSession(): Promise<{
  session: Session | null;
  error: string | null;
}> {
  const { data, error } = await supabase.auth.getSession();
  if (error) return { session: null, error: error.message };
  return { session: data.session, error: null };
}

/**
 * Subscribe to auth state changes (sign-in, sign-out, token refresh).
 * Returns an unsubscribe function.
 *
 * The callback runs inside Supabase's auth lock. It must stay synchronous:
 * do not await getProfile(), membership queries or book loading inside it, or
 * the client can deadlock. Record the event, then do the network work in a
 * separate effect/task.
 */
export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
): () => void {
  const { data } = supabase.auth.onAuthStateChange(callback);
  return () => data.subscription.unsubscribe();
}

/** Fetch user profile from public.profiles. */
export async function getProfile(userId: string): Promise<{
  profile: UserProfile | null;
  error: string | null;
}> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, created_at')
    .eq('id', userId)
    .single();

  if (error) return { profile: null, error: error.message };
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
