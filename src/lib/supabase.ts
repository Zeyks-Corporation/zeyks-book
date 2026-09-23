/**
 * Supabase browser client — singleton.
 *
 * Uses the publishable (anon) key only. The service-role key must never
 * appear in browser code: RLS on every table means this client can only reach
 * the rows the signed-in user is allowed to see, and a service-role key would
 * bypass all of it.
 *
 * The configuration is checked before the client is created (see `envGuard`):
 * a missing value, a *secret* key, or a development build pointed at a remote
 * project each refuse to start, with instructions. Better an empty screen and a
 * loud message than a development session quietly writing to real books.
 */

import { createClient } from '@supabase/supabase-js';
import { checkSupabaseConfig, describeTarget } from './envGuard';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

const config = checkSupabaseConfig({
  url,
  publishableKey: key,
  declared: import.meta.env.VITE_SUPABASE_ENV as string | undefined,
  isDevBuild: Boolean(import.meta.env.DEV),
  allowRemoteInDev: import.meta.env.VITE_ALLOW_REMOTE_IN_DEV as string | undefined,
});

if (!config.ok) {
  throw new Error(config.error);
}

// Which project this build is talking to is the first thing to check when
// something looks wrong, so it is stated once, on startup, in the console.
console.info(`[Zeyks Book] ${describeTarget(config.target, config.host, config.source)}`);
for (const warning of config.warnings) {
  console.warn(`[Zeyks Book] ${warning}`);
}

export const supabase = createClient(url!, key!);
