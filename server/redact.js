/**
 * Credential masking for anything the server logs or returns as an error.
 *
 * The payment process holds eSewa's HMAC secret and Khalti's live key, so a
 * provider error or an unexpected `fetch` failure is the one place a secret
 * could reach a log file, a screenshot or an API response. Gateway responses
 * are echoed back to the browser as failure detail (a field-level rejection is
 * genuinely useful to the person paying), so the echo is masked first.
 *
 * This is defence in depth, not the primary boundary: the secrets live only in
 * `process.env` on the server and are never placed in a URL, a response body or
 * the browser bundle. Masking keeps a *useful* business error readable — it
 * only replaces credential-shaped substrings.
 *
 * Pure and dependency-free so it can be tested directly.
 */

const MASK = '[redacted]';

/**
 * Credential shapes: literal prefixes, JWTs, and key=value pairs in query or
 * JSON text. Each pattern captures the *identifying* prefix so the masked result
 * still says what was hidden ("Key [redacted]" is more useful in a log than a
 * bare marker).
 */
const PATTERNS = [
  /(\bsb_secret_)[A-Za-z0-9._-]{6,}/g,
  /(\bsb_publishable_)[A-Za-z0-9._-]{6,}/g,
  /(\bsbp_)[A-Za-z0-9._-]{6,}/g,
  // A JWT: three base64url segments, the payload always starting with "eyJ".
  /(\beyJ)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(\b(?:Key|Bearer)\s+)[A-Za-z0-9._-]{8,}/g,
  /((?:password|passwd|secret|secret_key|secretkey|signature|token|apikey|api_key|service_role_key|access_key)=)([^&\s"']+)/gi,
  /("(?:password|secret|secret_key|signature|token|api_key)"\s*:\s*")([^"]+)(")/gi,
];

/** Replace anything credential-shaped with `[redacted]`, leaving the rest intact. */
export function redact(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  for (const pattern of PATTERNS) {
    // Replacement args are [match, g1, g2, g3, offset, string]: keep the first
    // group (the identifying prefix) and, when present, the third (a closing quote).
    text = text.replace(pattern, (...args) => {
      const groups = args.slice(1, args.length - 2);
      const prefix = groups[0] ?? '';
      const suffix = groups.length >= 3 ? groups[2] ?? '' : '';
      return `${prefix}${MASK}${suffix}`;
    });
  }
  return text;
}

/** Safe text for a log line: an Error's stack, a string, or anything else. */
export function redactDetail(detail) {
  if (!detail) return '';
  if (detail instanceof Error) {
    return redact(`${detail.name}: ${detail.message}${detail.cause ? ` (cause: ${String(detail.cause)})` : ''}`);
  }
  if (typeof detail === 'string') return redact(detail);
  try {
    return redact(JSON.stringify(detail));
  } catch {
    return '[unserialisable detail]';
  }
}
