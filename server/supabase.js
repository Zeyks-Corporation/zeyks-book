/**
 * Server-side Supabase client with administrative privileges.
 * Used exclusively by the API server to manage users and generate authentication links.
 */

import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = process.env.SUPABASE_URL
  || process.env.VITE_SUPABASE_URL
  || 'https://rlymuofhrreqwqhmmhqw.supabase.co';

export const SUPABASE_KEY = process.env.SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJseW11b2ZocnJlcXdxaG1taHF3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTc4NjM1MiwiZXhwIjoyMTA1MzYyMzUyfQ.udIsm-sMMU80P_iOpFcgRl7wPGvxu-utbPQdHKc9hxM';

export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJseW11b2ZocnJlcXdxaG1taHF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3ODYzNTIsImV4cCI6MjEwNTM2MjM1Mn0.PNyXm5YW3U-RSxFDYG-CU7e40r3hoNqv3BcEalfdXw8';

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

export const createAnonClient = () => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

