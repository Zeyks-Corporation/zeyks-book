/**
 * Supabase client — configured for storage & database.
 * Authentication is initiated through Firebase Auth, then synchronized
 * to Supabase Auth so all database RLS and accounting RPCs work seamlessly.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL)
  || 'https://rlymuofhrreqwqhmmhqw.supabase.co';

const SUPABASE_ANON_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_ANON_KEY)
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJseW11b2ZocnJlcXdxaG1taHF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3ODYzNTIsImV4cCI6MjEwNTM2MjM1Mn0.PNyXm5YW3U-RSxFDYG-CU7e40r3hoNqv3BcEalfdXw8';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

let syncPromise: Promise<boolean> | null = null;
let syncingEmail: string | null = null;

/**
 * Synchronize the Firebase Auth user into a Supabase authenticated session.
 * This establishes auth.uid() in PostgreSQL so that RLS and accounting RPCs succeed.
 */
export async function syncSupabaseSession(
  user?: {
    email?: string | null;
    displayName?: string | null;
    getIdToken?: () => Promise<string>;
  } | null,
): Promise<boolean> {
  const email = user?.email?.trim().toLowerCase();
  if (!email) return false;

  // A previous account may still be completing its bridge request during a
  // sign-out/sign-in switch. Do not reuse its result for the new account.
  if (syncPromise) {
    if (syncingEmail === email) return syncPromise;
    await syncPromise;
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user?.email?.toLowerCase() === email) {
      return true;
    }
  } catch {
    // continue to sync
  }

  syncingEmail = email;
  syncPromise = (async () => {
    try {
      if (!user?.getIdToken) return false;
      const firebaseIdToken = await user.getIdToken();

      const res = await fetch('/api/auth/supabase-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${firebaseIdToken}`,
        },
        body: JSON.stringify({ name: user.displayName || '' }),
      });

      if (!res.ok) {
        console.warn(`[Supabase Auth] Session bridge responded with status ${res.status}`);
        return false;
      }

      const json = await res.json();

      // 1. Direct session tokens provided by the server
      if (json?.access_token && json?.refresh_token) {
        const { data, error } = await supabase.auth.setSession({
          access_token: json.access_token,
          refresh_token: json.refresh_token,
        });
        if (!error && data?.session) {
          return true;
        }
        console.warn('[Supabase Auth] setSession failed:', error?.message);
      }

      return false;
    } catch (e) {
      console.warn('[Supabase Auth] Session sync network error:', e);
      return false;
    } finally {
      syncPromise = null;
      syncingEmail = null;
    }
  })();

  return syncPromise;
}

/**
 * Ensure Supabase has an active session before database queries run.
 */
export async function ensureSupabaseSession(): Promise<boolean> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) return true;
  } catch {
    // ignore
  }
  return false;
}

