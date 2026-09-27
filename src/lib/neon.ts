/**
 * Neon client — Database + Auth via Neon Data API + Managed Better Auth.
 *
 * `SupabaseAuthAdapter()` keeps Supabase-shaped method names on the auth
 * namespace so existing `signInWithPassword` / `signInWithOtp` / `verifyOtp`
 * calls continue to work without rewrites.
 *
 * The cast through `unknown` to a combined interface works around a Neon JS
 * type-inference quirk: the SDK declares the adapter as an instance type, but
 * the runtime exports a builder factory, so `createClient(url, { auth: { adapter:
 * SupabaseAuthAdapter() } })` is inferred as the React adapter by default.
 * The cast is sound because both shapes cover the same `from()`, `rpc()` and
 * `auth.*` method set we actually use.
 *
 * `VITE_NEON_URL` is the bare Neon host URL (e.g. `https://ep-xxx.region...
 * .aws.neon.tech/neondb`). The SDK derives the auth and Data API hosts from
 * it by inserting `neonauth` / `apirest` after the first hostname label. Some
 * dashboards hand out a data-API URL that already ends in `/rest/v1`; we
 * strip that suffix here, otherwise the SDK ends up calling
 * `https://ep-xxx.neonauth.../neondb/rest/v1/auth/get-session` and gets a 404.
 */

import { createClient, SupabaseAuthAdapter } from '@neondatabase/neon-js';
import type { SupabaseAuthAdapterInstance } from '@neondatabase/neon-js';

const envUrl = (() => {
  try {
    // @ts-ignore - import.meta is available in Vite environment
    return import.meta.env?.VITE_NEON_URL as string | undefined;
  } catch {
    return undefined;
  }
})();

if (!envUrl) {
  throw new Error('Neon configuration missing: VITE_NEON_URL is required.');
}

// Normalise to the bare Neon base URL. The SDK's URL derivator appends `/auth`
// and `/rest/v1` itself, so any `/rest/v1` already in the input has to go.
const url = envUrl.replace(/\/rest\/v1\/?$/, '');

/**
 * Never let a book row be served from the HTTP cache.
 *
 * Every Data API answer is private to the JWT that asked for it — row-level
 * security decides which rows come back, and two accounts asking for the same
 * URL must not get the same bytes. The Data API replies without
 * `Cache-Control` and without `Vary: Authorization`, so a cache keyed only on
 * the URL is free to reuse one person's rows for the next. `no-store` closes
 * that at the single place all data requests are made.
 */
function noStoreFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, cache: 'no-store' });
}

const baseClient = createClient(url, {
  auth: { adapter: SupabaseAuthAdapter() as unknown as never },
  dataApi: { options: { global: { fetch: noStoreFetch } } },
});

/** Combined client surface used by the rest of the app. */
type SupabaseShape = {
  from: (table: string) => ReturnType<typeof baseClient.from>;
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => ReturnType<typeof baseClient.rpc>;
  auth: SupabaseAuthAdapterInstance;
};

export const supabase = baseClient as unknown as SupabaseShape;

/**
 * Run the Neon-side claim_profile() RPC once after first sign-in to create
 * (or relink) a public.profiles row keyed on the Neon Auth user id. Returns
 * the resulting profiles.id or null if the claim failed.
 */
export async function claimProfile(): Promise<string | null> {
  const { data, error } = await baseClient.rpc('claim_profile');
  if (error) {
    console.warn('[Neon Auth] claim_profile failed:', error.message);
    return null;
  }
  return data as string | null;
}

/**
 * Fetch the signed-in user's profile (which carries the role used by route
 * guards and the admin panel). Returns null when signed-out or on read error.
 *
 * Scoped by id, never by "whatever row comes back": an admin passes
 * `profiles_select_admin`, so an unscoped read matches every profile in the
 * database and can hand another account's name, email and role to the UI.
 */
export async function fetchMyProfile(
  userId: string,
): Promise<{ id: string; email: string; full_name: string; role: string } | null> {
  if (!userId) return null;
  const { data, error } = await baseClient
    .from('profiles')
    .select('id, email, full_name, role')
    .eq('id', userId)
    .single();
  if (error || !data) return null;
  return data as { id: string; email: string; full_name: string; role: string };
}