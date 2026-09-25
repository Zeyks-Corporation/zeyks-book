import { GatewayProvider, GatewayStatus } from '../types';
import { auth } from '../lib/firebase';
import {
  PAYMENT_API_DISABLED_MESSAGE, paymentApiConfigured, paymentApiUrl,
} from '../lib/paymentApi';

/**
 * Browser-side gateway client.
 *
 * Every call goes to our own API. No secret, signature or merchant credential
 * is ever present in this bundle — the browser only ever sees a pre-signed
 * form payload or a redirect URL.
 *
 * Every route on that API requires the signed-in session, so each call carries
 * the caller's Firebase ID token. Identity is never sent as a field: the server
 * verifies the token against Firebase Admin and nothing in a request body can
 * override it.
 */

export interface GatewayConfig {
  mode: 'sandbox' | 'live';
  esewa: { enabled: boolean; productCode: string };
  khalti: { enabled: boolean };
}

export interface EsewaFormPayload {
  provider: 'ESEWA';
  method: 'FORM_POST';
  action: string;
  transactionUuid: string;
  totalAmount: number;
  fields: Record<string, string>;
}

export interface KhaltiInitiatePayload {
  provider: 'KHALTI';
  method: 'REDIRECT';
  pidx: string;
  paymentUrl: string;
  expiresAt: string | null;
  amount: number;
}

/**
 * The one internal verification shape (server/verification.js).
 *
 * `verified` is the SERVER's conclusion after asking the provider directly, and
 * `amount` is what the PROVIDER said it took. The browser only forwards this to
 * public.settle_gateway_txn through toVerificationPayload, which re-checks it
 * against the persisted collection: this shape is data, not authority.
 */
export interface VerificationResult {
  provider: GatewayProvider;
  verified: boolean;
  status: GatewayStatus;
  /** The provider's own transaction id — what the settlement records. */
  gatewayTransactionId: string | null;
  amount: number;
  currency: string;
  /** The provider reference this answer belongs to (eSewa transaction_uuid / Khalti pidx). */
  reference: string;
  detail?: string | null;
  /** The provider's raw body, kept for the server log — never sent to the database. */
  raw?: unknown;
}

export class GatewayError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'GatewayError';
  }
}

/**
 * The `Authorization` header the payment API requires.
 *
 * `getSession` refreshes an expired access token, so this never hands over a
 * stale one. No session means no header at all — the API then answers 401 and
 * the person is told to sign in, which is more honest than a client-side guess
 * about who they are.
 */
async function authHeaders(): Promise<Record<string, string>> {
  try {
    const token = await auth.currentUser?.getIdToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  // No API, no request. A deployment that has not declared one has nothing at
  // this path, and calling it anyway is what produced a 404 on every page load.
  if (!paymentApiConfigured()) throw new GatewayError(PAYMENT_API_DISABLED_MESSAGE);

  let res: Response;
  try {
    res = await fetch(paymentApiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GatewayError('Could not reach the payment server. Check that it is running on port 4000.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GatewayError((data as { error?: string }).error ?? `Request failed (${res.status}).`, res.status);
  return data as T;
}

export const gateway = {
  async config(): Promise<GatewayConfig> {
    // A failed config read means "no gateway usable here", never a fake sandbox
    // that would let the UI start a collection nothing can verify — and when
    // this deployment has no payment API at all, that answer is reached without
    // sending a request that could only 404.
    const disabled: GatewayConfig = {
      mode: 'sandbox', esewa: { enabled: false, productCode: '' }, khalti: { enabled: false },
    };
    if (!paymentApiConfigured()) return disabled;
    try {
      const res = await fetch(paymentApiUrl('/api/payments/config'), { headers: await authHeaders() });
      if (!res.ok) throw new Error();
      return (await res.json()) as GatewayConfig;
    } catch {
      return disabled;
    }
  },

  /**
   * The invoice is named by id; the amount is the only number the browser
   * chooses. The server reads the invoice (and the customer name, and the
   * reference that gets signed) from the database through our own session.
   */
  initiateEsewa(input: { saleId: string; amount: number; taxAmount: number }) {
    return post<EsewaFormPayload>('/api/payments/esewa/initiate', input);
  },

  verifyEsewa(input: { data?: string; transactionUuid?: string; totalAmount?: number }) {
    return post<VerificationResult>('/api/payments/esewa/verify', input);
  },

  initiateKhalti(input: {
    saleId: string; amount: number; customerEmail?: string; customerPhone?: string;
  }) {
    return post<KhaltiInitiatePayload>('/api/payments/khalti/initiate', input);
  },

  lookupKhalti(pidx: string) {
    return post<VerificationResult>('/api/payments/khalti/lookup', { pidx });
  },
};

/**
 * eSewa needs a real form POST rather than fetch — it responds with a redirect
 * to its own login page, which cannot be followed from script.
 */
export function submitEsewaForm(payload: EsewaFormPayload): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = payload.action;
  form.style.display = 'none';
  for (const [name, value] of Object.entries(payload.fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

/** Pending collections survive the redirect in sessionStorage. */
const PENDING_KEY = 'zeyks_pending_gateway';

export interface PendingCollection {
  txnId: string;
  provider: GatewayProvider;
  gatewayRef: string;
  amount: number;
  saleId?: string;
  customerName: string;
}

export function rememberPending(p: PendingCollection): void {
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch { /* non-fatal */ }
}

export function takePending(): PendingCollection | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_KEY);
    return JSON.parse(raw) as PendingCollection;
  } catch {
    return null;
  }
}
