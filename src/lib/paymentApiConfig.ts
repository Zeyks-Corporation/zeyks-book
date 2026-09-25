/**
 * The payment API decision, with the environment passed in.
 *
 * Kept separate from `paymentApi.ts` for the same reason `envGuard` keeps its
 * rules in one place: the decision is worth testing, and a module that reads
 * `import.meta.env` at import time cannot be loaded outside a Vite build. So the
 * decision is a pure function of two inputs and the caller supplies them.
 */

export interface PaymentApiInput {
  /** A development build (`import.meta.env.DEV`). */
  isDev: boolean;
  /** The declared API origin, or an empty string when none is declared. */
  declaredUrl: string;
}

export interface PaymentApiDecision {
  /** May this build send a request to the payment API at all? */
  configured: boolean;
  /** The origin to prefix with, without a trailing slash. Empty when unset. */
  base: string;
}

export const PAYMENT_API_DISABLED_MESSAGE =
  'Online collection needs the payment API server, which is not enabled in this deployment. '
  + 'Record the receipt or the payment instead — that path is fully supported.';

export function paymentApiDecision({ isDev, declaredUrl }: PaymentApiInput): PaymentApiDecision {
  const base = String(declaredUrl ?? '').trim().replace(/\/+$/, '');
  // Development always has somewhere to send `/api/...`: `npm run dev` starts
  // the API server and the Vite dev server proxies that prefix to it. A built
  // deployment offers online collection only when an API origin is declared.
  return { configured: isDev || base.length > 0, base };
}

/** The absolute or origin-relative URL for one payment API path. */
export function paymentApiUrlFor(base: string, path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${suffix}` : suffix;
}
