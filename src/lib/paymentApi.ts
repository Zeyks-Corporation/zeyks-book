/**
 * Payment API availability — the environment half.
 *
 * The payment endpoints are a *separate runtime* from this application: a server
 * that holds the merchant signing secrets, deploys independently, and
 * authenticates every caller (Stage 14). The Vercel deployment serves the static
 * app only, so unless a deployment declares where that API lives there is
 * nothing at `/api/payments/*` to answer — and asking anyway is what made the
 * browser hammer a 404 on every page load.
 *
 * So availability is declared, not guessed:
 *
 *   development   the Vite dev server proxies `/api` to the local API server
 *                 (`npm run dev` starts both), so the relative path is correct.
 *   deployment    only when `VITE_PAYMENT_API_URL` names the API's origin. An
 *                 empty value means payments are not enabled in this
 *                 deployment, and the UI says so instead of calling.
 *
 * This is a capability flag, not a secret: it is a public URL. Nothing here
 * grants access to anything — every route on that API still authenticates the
 * caller, and the database still refuses to settle money it cannot verify.
 *
 * The rule itself lives in `paymentApiConfig.ts` (pure, and unit tested); this
 * module only reads the build's own values and hands them over. `import.meta.env`
 * is read directly and by name so the Vite build substitutes it — a dynamic
 * lookup would not be replaced.
 */

import { isSupported } from './capabilities';
import {
  PAYMENT_API_DISABLED_MESSAGE, paymentApiDecision, paymentApiUrlFor,
} from './paymentApiConfig';

export { PAYMENT_API_DISABLED_MESSAGE };

const DECLARED_URL = import.meta.env.VITE_PAYMENT_API_URL;
const IS_DEV = Boolean(import.meta.env.DEV);

const DECISION = paymentApiDecision({
  isDev: IS_DEV,
  declaredUrl: typeof DECLARED_URL === 'string' ? DECLARED_URL : '',
});

export function isDevBuild(): boolean {
  return IS_DEV;
}

/** The configured API origin, without a trailing slash. Empty when unset. */
export function paymentApiBase(): string {
  return DECISION.base;
}

/**
 * Can this build reach the payment API at all?
 *
 * The consequence of `false` is that no request is ever sent and no payment
 * screen is offered — never a silent failure.
 */
export function paymentApiConfigured(): boolean {
  return DECISION.configured;
}

/** `/api/payments/config` in development; `<origin>/api/payments/config` when declared. */
export function paymentApiUrl(path: string): string {
  return paymentApiUrlFor(DECISION.base, path);
}

/**
 * May the online-collection flow be offered here?
 *
 * It needs both halves: the database RPCs that can record and settle a provider
 * interaction, and a reachable server to talk to the provider.
 */
export function onlineCollectionAvailable(): boolean {
  return isSupported('gateway') && DECISION.configured;
}
