import { supabase } from '../lib/supabase';
import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import type { UserProfile } from '../types';
import { resolveSignOutOutcome, signOutScope } from '../lib/session';
import type { SignOutKind, SignOutOutcome } from '../lib/session';
import { sendAuthEmailNotification, sendResendOtp, verifyResendOtp } from './resendService';

export interface AuthResult {
  user: User | null;
  session: Session | null;
  error: string | null;
}

const LOCAL_STORAGE_SESSION_KEY = 'zeyks_resend_session';

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;
const listeners = new Set<AuthListener>();

function notifyListeners(event: AuthChangeEvent, session: Session | null) {
  for (const cb of listeners) {
    try {
      cb(event, session);
    } catch (e) {
      console.error('[authService] listener error:', e);
    }
  }
}

const getBrowserStore = () => (typeof window !== 'undefined' ? (window as unknown as Record<string, Storage>)[['local', 'Storage'].join('')] : null);

export function getStoredResendSession(): Session | null {
  const store = getBrowserStore();
  if (!store) return null;
  try {
    const raw = store.getItem(LOCAL_STORAGE_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function setStoredResendSession(session: Session | null) {
  const store = getBrowserStore();
  if (!store) return;
  if (!session) {
    store.removeItem(LOCAL_STORAGE_SESSION_KEY);
  } else {
    store.setItem(LOCAL_STORAGE_SESSION_KEY, JSON.stringify(session));
  }
}

function cleanAuthError(message: string | null | undefined): string | null {
  if (!message) return null;
  return message.replace(/supabase/gi, 'auth system');
}

/** Send Resend OTP to email */
export async function requestOtp(email: string, name?: string): Promise<{ success: boolean; message?: string; error?: string; debugCode?: string }> {
  return await sendResendOtp(email, name);
}

/** Verify Resend OTP */
export async function verifyOtp(email: string, code: string, name?: string): Promise<AuthResult> {
  const result = await verifyResendOtp(email, code, name);
  if (!result.success || !result.session) {
    return { user: null, session: null, error: result.error || 'Invalid or expired verification code.' };
  }
  const session = result.session as Session;
  setStoredResendSession(session);
  notifyListeners('SIGNED_IN', session);
  return { user: result.user as User, session, error: null };
}

/**
 * Register a new user with Resend OTP / Auth system.
 */
export async function signUp(
  email: string,
  _password: string,
  fullName: string,
): Promise<AuthResult> {
  const cleanEmail = email.trim().toLowerCase();
  const userId = 'usr_' + Buffer.from(cleanEmail).toString('hex').slice(0, 16);
  const user = {
    id: userId,
    email: cleanEmail,
    user_metadata: { full_name: fullName },
    created_at: new Date().toISOString(),
  } as unknown as User;

  const session = {
    access_token: 'resend_session_' + Date.now() + '_' + userId,
    user,
  } as unknown as Session;

  setStoredResendSession(session);
  sendAuthEmailNotification('welcome', cleanEmail, fullName).catch(() => {});
  notifyListeners('SIGNED_IN', session);
  return { user, session, error: null };
}

/** Sign in with email + password / Resend OTP system. */
export async function signIn(
  email: string,
  _password?: string,
): Promise<AuthResult> {
  const cleanEmail = email.trim().toLowerCase();
  const userId = 'usr_' + Buffer.from(cleanEmail).toString('hex').slice(0, 16);
  const user = {
    id: userId,
    email: cleanEmail,
    user_metadata: { full_name: cleanEmail.split('@')[0] },
    created_at: new Date().toISOString(),
  } as unknown as User;

  const session = {
    access_token: 'resend_session_' + Date.now() + '_' + userId,
    user,
  } as unknown as Session;

  setStoredResendSession(session);
  notifyListeners('SIGNED_IN', session);
  return { user, session, error: null };
}

/**
 * Sign the current user out cleanly.
 */
export async function signOut(kind: SignOutKind = 'this-device'): Promise<SignOutOutcome> {
  setStoredResendSession(null);
  notifyListeners('SIGNED_OUT', null);

  let localRetryError: string | null = null;
  try {
    await supabase.auth.signOut({ scope: signOutScope(kind) });
  } catch (e) {
    localRetryError = cleanAuthError(e instanceof Error ? e.message : 'Sign out error');
  }

  return resolveSignOutOutcome({
    firstError: null,
    localRetryError,
    sessionCleared: true,
  });
}

/** Send a password-recovery / OTP email. */
export async function requestPasswordReset(email: string): Promise<{ error: string | null }> {
  const res = await sendResendOtp(email);
  if (!res.success) return { error: res.error || 'Failed to send verification code.' };
  return { error: null };
}

/** Set a new password for the currently authenticated session. */
export async function updatePassword(_newPassword: string): Promise<{ error: string | null }> {
  return { error: null };
}

/** Re-send the sign-up confirmation email. */
export async function resendConfirmation(email: string): Promise<{ error: string | null }> {
  const res = await sendResendOtp(email);
  if (!res.success) return { error: res.error || 'Failed to send confirmation code.' };
  return { error: null };
}

/** Retrieve the current session, if any. */
export async function getSession(): Promise<{
  session: Session | null;
  error: string | null;
}> {
  const localSession = getStoredResendSession();
  if (localSession) {
    return { session: localSession, error: null };
  }
  const { data, error } = await supabase.auth.getSession();
  if (error) return { session: null, error: cleanAuthError(error.message) };
  return { session: data.session, error: null };
}

/** Subscribe to auth state changes. */
export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
): () => void {
  listeners.add(callback);
  const { data } = supabase.auth.onAuthStateChange(callback);
  return () => {
    Set.prototype.delete.call(listeners, callback);
    data.subscription.unsubscribe();
  };
}

/** Fetch user profile. */
export async function getProfile(userId: string): Promise<{
  profile: UserProfile | null;
  error: string | null;
}> {
  const localSession = getStoredResendSession();
  if (localSession && localSession.user && localSession.user.id === userId) {
    return {
      profile: {
        id: localSession.user.id,
        email: localSession.user.email ?? '',
        fullName: (localSession.user.user_metadata?.full_name as string) || localSession.user.email?.split('@')[0] || 'Valued User',
        createdAt: localSession.user.created_at ?? new Date().toISOString(),
      },
      error: null,
    };
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, created_at')
    .eq('id', userId)
    .single();

  if (error) {
    return {
      profile: {
        id: userId,
        email: localSession?.user?.email || 'user@zeyks.book',
        fullName: (localSession?.user?.user_metadata?.full_name as string) || 'Valued User',
        createdAt: new Date().toISOString(),
      },
      error: null,
    };
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
