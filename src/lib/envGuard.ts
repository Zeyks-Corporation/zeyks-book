/**
 * Environment safety: which Supabase project is this build about to talk to?
 *
 * A development build that silently connects to the production project is the
 * single most damaging configuration mistake available in this repository: the
 * app has no local data model any more, so every click writes to real books.
 * `supabase start` gives you a local stack, but nothing in Vite stops you from
 * leaving a production URL in `.env.local`. This module is the stop.
 *
 * Three questions, answered purely so they can be tested without a browser:
 *
 *   1. WHERE does the configured URL point? `local`, `staging`, `production`
 *      or `unknown`, derived from the host generically — no production
 *      hostname is hardcoded, because the next project will have a different
 *      one. An explicit `VITE_SUPABASE_ENV` always wins over the guess.
 *   2. IS the key safe to hand to a browser? A publishable/anon key is public
 *      by design; a service-role key in a browser bundle is a full privilege
 *      escalation, and it is refused outright — then and there, not in review.
 *   3. MAY this build start? A development build pointed at production refuses
 *      to start, and says how to fix it. A development build pointed at a
 *      *declared* staging project is allowed with a warning. Production builds
 *      are allowed to reach production — that is the point of them.
 *
 * Deliberate escape hatch: `VITE_ALLOW_REMOTE_IN_DEV` must be exactly `yes`.
 * Anything else (`true`, `1`, a typo) is ignored, so it cannot be switched on
 * by accident.
 */

export type SupabaseTarget = 'local' | 'staging' | 'production' | 'unknown';

export type TargetSource = 'declared' | 'derived';

export interface SupabaseEnvInput {
  url: string | undefined;
  /** The publishable/anon key. Must never be a secret key. */
  publishableKey: string | undefined;
  /** Explicit `VITE_SUPABASE_ENV`, when the environment sets one. */
  declared?: string | undefined;
  /** True for a development build (`import.meta.env.DEV`), false for a bundle. */
  isDevBuild: boolean;
  /** `VITE_ALLOW_REMOTE_IN_DEV` — only the exact string "yes" counts. */
  allowRemoteInDev?: string | undefined;
}

export type SupabaseConfigResult =
  | { ok: true; target: SupabaseTarget; source: TargetSource; host: string; warnings: string[] }
  | { ok: false; error: string };

/* -------------------------------------------------------------------------- */
/* Host classification                                                         */
/* -------------------------------------------------------------------------- */

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'host.docker.internal'];

/** Private and link-local IPv4 ranges — a laptop, a LAN box or a compose network. */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 127) return true;
  return false;
}

/**
 * Which kind of Supabase project a URL points at.
 *
 * `local` covers everything a developer runs on their own machine: loopback,
 * the docker host name and private addresses (the `supabase start` stack is
 * reachable as 127.0.0.1, and from inside a container as a private address).
 * Everything hosted at `supabase.co` is a cloud project; whether it is staging
 * or production is a *policy* question, not a technical one, so the answer here
 * is `production` and only an explicit declaration can soften it.
 */
export function classifySupabaseTarget(url: string): SupabaseTarget {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }

  if (LOOPBACK_HOSTS.includes(host) || host.endsWith('.localhost') || host.endsWith('.local')) return 'local';
  if (isPrivateIpv4(host)) return 'local';
  // Cloud projects: <ref>.supabase.co / .supabase.in (and the newer pooler hosts).
  if (/(^|\.)supabase\.(co|in)$/.test(host)) return 'production';
  // A self-hosted or custom domain. Not provably production, but not local either.
  return 'unknown';
}

/** `https://abc.supabase.co/rest` → `abc.supabase.co`, for a message a human reads. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/* -------------------------------------------------------------------------- */
/* Key shape                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Decode one base64url segment without Node's Buffer.
 *
 * This module runs in the browser, where `Buffer` does not exist; `atob` does
 * exist in every browser and in Node from v16, so the same code path works in
 * the app and in the test runner.
 */
function decodeBase64Url(segment: string): string | null {
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
    const binary = (globalThis as { atob?: (s: string) => string }).atob
      ? globalThis.atob(padded)
      : null;
    if (binary === null) return null;
    return decodeURIComponent(
      binary.split('').map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
    );
  } catch {
    return null;
  }
}

/**
 * Is this key safe to embed in a browser bundle?
 *
 * A publishable/anon key is designed to be public — RLS is the boundary. The
 * two things that must never ship are the new-style secret key (`sb_secret_…`)
 * and the legacy service-role JWT, which carries `"role":"service_role"` and
 * would give whoever reads the bundle full access to every tenant.
 *
 * The check is deliberately shape-based and does not try to be a JWT validator:
 * it reads the payload's role claim, which is all that is needed to tell an
 * anon key from a service-role key.
 */
export function isServerSecretKey(key: string): { secret: boolean; reason?: string } {
  const trimmed = key.trim();
  if (!trimmed) return { secret: false };
  if (/^sb_secret_/.test(trimmed)) {
    return { secret: true, reason: 'holds a Supabase secret key (sb_secret_…)' };
  }
  if (/^sbp_/.test(trimmed)) {
    return { secret: true, reason: 'holds a Supabase personal access token (sbp_…)' };
  }
  const parts = trimmed.split('.');
  if (parts.length === 3) {
    const json = decodeBase64Url(parts[1]!);
    if (json) {
      try {
        const role = (JSON.parse(json) as { role?: string }).role;
        if (role === 'service_role') {
          return { secret: true, reason: 'holds a service-role JWT' };
        }
      } catch {
        /* Not a JWT payload we can read; the shape checks below still apply. */
      }
    }
  }
  return { secret: false };
}

/* -------------------------------------------------------------------------- */
/* The decision                                                                */
/* -------------------------------------------------------------------------- */

const NORMALISED_TARGETS: Record<string, SupabaseTarget> = {
  local: 'local',
  development: 'local',
  dev: 'local',
  test: 'local',
  testing: 'local',
  staging: 'staging',
  stage: 'staging',
  prod: 'production',
  production: 'production',
  live: 'production',
};

function normaliseDeclared(value: string | undefined): SupabaseTarget | undefined {
  if (!value) return undefined;
  return NORMALISED_TARGETS[value.trim().toLowerCase()];
}

function missingConfigError(): string {
  return [
    'Missing Supabase configuration.',
    '',
    'Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.',
    'For local development, start the local stack and copy the values it prints:',
    '',
    '  supabase start      # then `supabase status` for the URL and publishable key',
    '',
    'See .env.example for the template and README.md for the environment model.',
  ].join('\n');
}

/**
 * Decide whether this configuration may be used, and say why when it may not.
 *
 * Returns a message rather than throwing so the caller decides the blast
 * radius, and so the whole rule is testable without a browser or a network.
 */
export function checkSupabaseConfig(input: SupabaseEnvInput): SupabaseConfigResult {
  const { url, publishableKey, declared, isDevBuild } = input;

  if (!url || !publishableKey) {
    return { ok: false, error: missingConfigError() };
  }

  const keyCheck = isServerSecretKey(publishableKey);
  if (keyCheck.secret) {
    return {
      ok: false,
      error: [
        'Refusing to start: the configured Supabase key is a server secret.',
        '',
        `The value in VITE_SUPABASE_PUBLISHABLE_KEY ${keyCheck.reason}.`,
        'Every VITE_* value is embedded in the browser bundle, so this key would be',
        'readable by anyone who opens the app — and it bypasses every row-level',
        'security rule.',
        '',
        'Use the publishable (anon) key instead. Keep server secrets in the server',
        'env file (.env), which only server/index.js reads. If a secret has been',
        'exposed, rotate it in the Supabase dashboard before doing anything else.',
      ].join('\n'),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      error: `Refusing to start: VITE_SUPABASE_URL is not a URL. Received ${JSON.stringify(url)}.`,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: `Refusing to start: VITE_SUPABASE_URL must be http(s). Received ${JSON.stringify(url)}.`,
    };
  }

  const declaredTarget = normaliseDeclared(declared);
  const derivedTarget = classifySupabaseTarget(url);
  const target = declaredTarget ?? derivedTarget;
  const source: TargetSource = declaredTarget ? 'declared' : 'derived';
  const host = hostOf(url);

  // The declaration must not be used to relabel a cloud project as local: that
  // would let a mislabelled .env.local switch the guard off while pointing at a
  // remote project.
  if (declaredTarget === 'local' && derivedTarget !== 'local') {
    return {
      ok: false,
      error: [
        `Refusing to start: VITE_SUPABASE_ENV says "local" but ${host} is a remote host.`,
        '',
        'A declaration cannot turn a remote project into a local one, so this file',
        'would either be lying to you or quietly writing to a remote database.',
        'Point the URL at http://127.0.0.1:54321 (see `supabase start`) or declare',
        'the target that matches the host ("staging" or "production").',
      ].join('\n'),
    };
  }

  if (declared && !declaredTarget) {
    return {
      ok: false,
      error: `Refusing to start: VITE_SUPABASE_ENV must be one of local, staging, production. Received ${JSON.stringify(declared)}.`,
    };
  }

  const warnings: string[] = [];

  if (isDevBuild && (target === 'production' || target === 'unknown')) {
    const allowed = input.allowRemoteInDev === 'yes';
    if (!allowed) {
      return {
        ok: false,
        error: [
          `Refusing to start: this development build is pointed at ${host}`,
          `(read as ${target}${source === 'declared' ? ', as you declared' : ''}).`,
          '',
          'Development and database testing must use the local Supabase stack:',
          '',
          '  1. supabase start',
          '  2. VITE_SUPABASE_URL="http://127.0.0.1:54321" in .env.local',
          '  3. VITE_SUPABASE_PUBLISHABLE_KEY="<publishable key from supabase status>"',
          '',
          'If this is a dedicated staging project (never production), declare it:',
          '  VITE_SUPABASE_ENV="staging"',
          '',
          'If you genuinely mean to run a development build against this remote',
          'project, set VITE_ALLOW_REMOTE_IN_DEV="yes" and know that every action you',
          'take writes to that project.',
        ].join('\n'),
      };
    }
    warnings.push(
      `A development build is connected to ${host} (${target}) because VITE_ALLOW_REMOTE_IN_DEV=yes. `
      + 'Every action writes to that project. This is not a test environment.',
    );
  } else if (isDevBuild && target === 'staging') {
    warnings.push(
      `Development build connected to the staging project ${host}. Staging is for controlled testing: `
      + 'do not load customer data here, and keep database tests on the local stack.',
    );
  }

  if (!isDevBuild && target === 'local') {
    warnings.push(
      `This production build is pointed at the local stack (${host}). That is only correct for a local `
      + 'preview: rebuild with the production project URL before deploying.',
    );
  }

  return { ok: true, target, source, host, warnings };
}

/** One line that makes the active target impossible to miss in a dev console. */
export function describeTarget(target: SupabaseTarget, host: string, source: TargetSource): string {
  return `Database target: ${target} (${host})${source === 'declared' ? ', declared by VITE_SUPABASE_ENV' : ''}`;
}
