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
 * One Data API request in flight at a time, and never from the HTTP cache.
 *
 * No-store: every Data API answer is private to the JWT that asked for it —
 * row-level security decides which rows come back, and two accounts asking for
 * the same URL must not get the same bytes. The Data API replies without
 * `Cache-Control` and without `Vary: Authorization`, so a cache keyed only on
 * the URL is free to reuse one person's rows for the next.
 *
 * Serialised: the Data API answers overlapping requests from the same session
 * inconsistently. Measured on production with one valid token and one URL that
 * must return 21 rows: 22 of 40 parallel requests came back `200 []`, while 40
 * sequential requests were correct every time. Row-level security filters
 * rather than rejects, so the bad answer looks exactly like an empty book —
 * a ledger that loads with its chart of accounts missing shows zero balances,
 * a wrong profit and loss, and phantom "unknown account" health errors. A
 * ledger must never be presented half-loaded, so requests are queued here, at
 * the one place every table read and RPC is issued. A failed request must not
 * stall the queue, hence the caught tail.
 */
let queueTail: Promise<unknown> = Promise.resolve();

function dataApiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = queueTail.then(() => fetch(input, { ...init, cache: 'no-store' }));
  queueTail = request.then(() => undefined, () => undefined);
  return request;
}

const baseClient = createClient(url, {
  auth: { adapter: SupabaseAuthAdapter() as unknown as never },
  dataApi: { options: { global: { fetch: dataApiFetch } } },
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
 * The Neon Auth endpoint, derived from the database URL exactly the way the SDK
 * does it: `neonauth` is inserted after the first host label and the path is
 * kept. Deriving it instead of reading `VITE_NEON_AUTH_URL` means the admin API
 * can never point at a different endpoint from the one the SDK signs into.
 */
function authBaseUrl(): string {
  const parsed = new URL(url);
  const [first, ...rest] = parsed.hostname.split('.');
  parsed.hostname = `${first}.neonauth.${rest.join('.')}`;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}/auth`;
}

/**
 * Create a login for a person the admin is onboarding.
 *
 * Self sign-up is disabled in the auth project, so this admin endpoint is the
 * only way an account comes into existence. The request is authenticated by the
 * admin's own session cookie (`HttpOnly; SameSite=None`), which is why
 * `credentials: 'include'` is required and why it only works from a signed-in
 * admin's browser.
 *
 * A password is the one secret that leaves this process in plaintext — over TLS,
 * to the service that stores it hashed. Nothing here logs or caches it.
 */
export async function createAuthUser(opts: {
  email: string;
  name: string;
  password: string;
}): Promise<{ id: string; error: null } | { id: null; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${authBaseUrl()}/admin/create-user`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: opts.email,
        name: opts.name,
        password: opts.password,
      }),
    });
  } catch {
    return { id: null, error: 'Could not reach the sign-in service. Check your connection and try again.' };
  }
  const body: unknown = await res.json().catch(() => null);
  const created = (body as { user?: { id?: string } } | null)?.user?.id;
  const message = (body as { error?: { message?: string } } | null)?.error?.message;
  if (res.ok && created) return { id: created, error: null };
  if (/exist/i.test(message ?? '')) {
    return { id: null, error: 'That email already has a sign-in account.' };
  }
  if (res.status === 403) {
    return {
      id: null,
      error: 'The sign-in service does not let this account create users. It needs the admin role there, which is granted outside the app.',
    };
  }
  return { id: null, error: message ? `Sign-in account failed: ${message}` : 'The sign-in account could not be created.' };
}

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