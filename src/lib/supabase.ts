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
    try {
      const res = await fetch('/api/auth/supabase-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          name: user?.displayName || '',
        }),
      });

      if (!res.ok) {
        return false;
      }

      const json = await res.json();
      if (!json?.email_otp) {
        return false;
      }

      const { data, error } = await supabase.auth.verifyOtp({
        email: json.email || email,
        token: json.email_otp,
        type: 'magiclink',
      });

      if (error) {
        return false;
      }

      return !!data.session;
    } catch {
      return false;
    } finally {
      syncPromise = null;
    }
  })();

  return syncPromise;
}
