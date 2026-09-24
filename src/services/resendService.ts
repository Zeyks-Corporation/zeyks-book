/**
 * The verification-code transport — the browser's half of email OTP sign-in.
 *
 * This module is deliberately thin, and deliberately dumb. It carries a code
 * request to the API server and carries the answer back. It does not:
 *
 *   - generate a code, or invent one when the server is unreachable. A build
 *     that can mint its own credential is not an authentication system.
 *   - keep a copy of a code in memory (or anywhere else) to check later. The
 *     only thing that may verify a code is the server that issued it, against
 *     the row it wrote when it did.
 *   - create a user or a session. It cannot: the server answers a successful
 *     verification with a Supabase token hash, and `authService.verifyOtp`
 *     exchanges that hash for a real session through Supabase Auth. Nothing
 *     before that point is signed in.
 *
 * Every failure is a failure. If the API server is down, misconfigured, or
 * answers with an error, the result is `success: false` — there is no local
 * path that could still say yes, because that is exactly the hole this module
 * used to have.
 */

import { paymentApiUrl } from '../lib/paymentApi';

export interface OtpRequestResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface OtpVerificationResult {
  success: boolean;
  email?: string;
  /**
   * A one-time Supabase token hash, returned by the server only after it has
   * verified the code itself. Single-use: exchanging it consumes it.
   */
  tokenHash?: string;
  error?: string;
}

/** One sentence per failure. The server's own wording wins when it has one. */
const SEND_FAILED =
  'We could not send a verification code right now. Please try again in a moment.';
const VERIFY_FAILED =
  'That verification code could not be verified. Request a new code and try again.';

interface JsonRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : null;
}

function errorMessageFrom(data: unknown): string | null {
  const record = asRecord(data);
  const message = record?.error;
  return typeof message === 'string' && message.trim() ? message : null;
}

/**
 * POST one JSON body and read one JSON answer.
 *
 * A non-JSON body is treated as an empty answer rather than as a success, and
 * the HTTP status is preserved so the caller can tell a refusal (4xx) from an
 * outage (5xx).
 */
async function postJson(
  path: string,
  body: JsonRecord,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetch(paymentApiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { ok: response.ok, status: response.status, data };
}

/**
 * Ask the server to email a verification code to this address.
 *
 * The code is generated and stored by the server; this function never sees it,
 * and nothing about the request decides what the code will be.
 */
export async function sendResendOtp(
  email: string,
  name?: string,
): Promise<OtpRequestResult> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name?.trim();

  try {
    const { ok, data } = await postJson('/api/auth/send-otp', {
      email: cleanEmail,
      ...(cleanName ? { name: cleanName } : {}),
    });
    const record = asRecord(data);

    if (!ok || record?.success !== true) {
      return { success: false, error: errorMessageFrom(data) ?? SEND_FAILED };
    }

    const message = record.message;
    return {
      success: true,
      message: typeof message === 'string' && message.trim()
        ? message
        : `Verification code sent to ${cleanEmail}. Check your inbox!`,
    };
  } catch {
    return { success: false, error: SEND_FAILED };
  }
}

/**
 * Hand the code the person received back to the server for verification.
 *
 * On success the answer is a Supabase token hash, not a session: the caller
 * must still exchange it with Supabase Auth before anything is signed in.
 */
export async function verifyResendOtp(
  email: string,
  code: string,
): Promise<OtpVerificationResult> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanCode = code.trim();

  try {
    const { ok, data } = await postJson('/api/auth/verify-otp', {
      email: cleanEmail,
      code: cleanCode,
    });
    const record = asRecord(data);

    if (!ok || record?.success !== true) {
      return { success: false, error: errorMessageFrom(data) ?? VERIFY_FAILED };
    }

    const tokenHash = record.tokenHash;
    if (typeof tokenHash !== 'string' || !tokenHash.trim()) {
      // A success without a token is not a success. Fail closed.
      return { success: false, error: VERIFY_FAILED };
    }

    const verifiedEmail = record.email;
    return {
      success: true,
      email: typeof verifiedEmail === 'string' && verifiedEmail.trim() ? verifiedEmail : cleanEmail,
      tokenHash: tokenHash.trim(),
    };
  } catch {
    return { success: false, error: VERIFY_FAILED };
  }
}
