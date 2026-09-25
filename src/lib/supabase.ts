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

/**
 * Synchronize the Firebase Auth user into a Supabase authenticated session.
 * This establishes auth.uid() in PostgreSQL so that RLS and accounting RPCs succeed.
 */
export async function syncSupabaseSession(
  user?: { email?: string | null; displayName?: string | null } | null,
): Promise<boolean> {
  const email = user?.email?.trim().toLowerCase();
  if (!email) return false;

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user?.email?.toLowerCase() === email) {
      return true;
    }
  } catch {
    // continue to sync
  }

  if (syncPromise) return syncPromise;

  syncPromise = (async () => {
    const deterministicPassword = `zb_auth_bridge_${email}_v1!`;

    try {
      // 0. Direct client-side bridge (works without any server API roundtrip for existing users)
      try {
        const { data: pwData, error: pwErr } = await supabase.auth.signInWithPassword({
          email,
          password: deterministicPassword,
        });
        if (!pwErr && pwData?.session) {
          return true;
        }
      } catch {
        // Proceed to server bridge
      }

      const res = await fetch('/api/auth/supabase-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          name: user?.displayName || '',
        }),
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

      // 2. Fallback: verifyOtp with token_hash and verification_type
      if (json?.token_hash && json?.verification_type) {
        const { data, error } = await supabase.auth.verifyOtp({
          token_hash: json.token_hash,
          type: json.verification_type,
        });
        if (!error && data?.session) {
          return true;
        }
        console.warn('[Supabase Auth] verifyOtp(token_hash) failed:', error?.message);
      }

      // 3. Fallback: verifyOtp with email and numeric email_otp
      if (json?.email_otp) {
        const { data, error } = await supabase.auth.verifyOtp({
          email: json.email || email,
          token: json.email_otp,
          type: json.verification_type || 'magiclink',
        });
        if (!error && data?.session) {
          return true;
        }
        console.warn('[Supabase Auth] verifyOtp(email_otp) failed:', error?.message);
      }

      // 4. Retry direct password sign-in after server created/updated user
      try {
        const { data: retryData, error: retryErr } = await supabase.auth.signInWithPassword({
          email,
          password: deterministicPassword,
        });
        if (!retryErr && retryData?.session) {
          return true;
        }
      } catch {
        // ignore
      }

      return false;
    } catch (e) {
      console.warn('[Supabase Auth] Session sync network error:', e);
      return false;
    } finally {
      syncPromise = null;
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

