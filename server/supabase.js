/** Server-side Supabase clients used by the session bridge. Missing or invalid
 * settings disable that route without preventing other API routes from starting.
 */

import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = process.env.SUPABASE_URL
  || process.env.VITE_SUPABASE_URL;

export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY;

export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_ANON_KEY;

let adminClient;

export function getSupabaseAdmin() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  adminClient ??= createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminClient;
}

export function createAnonClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Supabase session bridge is not configured.');
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

