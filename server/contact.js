/**
 * Shared contact-form validation for the Express and Vercel runtimes.
 *
 * The browser is untrusted in both deployments. Keeping the limits and shape
 * checks in one small, dependency-free module prevents the two handlers from
 * drifting apart.
 */

const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_MESSAGE_LENGTH = 5000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateContactPayload(body) {
  let payload = body ?? {};
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return { ok: false, error: 'The request body must be valid JSON.' };
    }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'The request body must be an object.' };
  }

  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';

  if (!name) return { ok: false, error: 'Your name is required.' };
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `Your name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }
  if (!email || !EMAIL_PATTERN.test(email) || email.length > MAX_EMAIL_LENGTH) {
    return { ok: false, error: 'A valid email address is required.' };
  }
  if (!message) return { ok: false, error: 'A message body is required.' };
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Your message must be ${MAX_MESSAGE_LENGTH} characters or fewer.` };
  }

  return { ok: true, value: { name, email, message } };
}

export const CONTACT_LIMITS = Object.freeze({
  name: MAX_NAME_LENGTH,
  email: MAX_EMAIL_LENGTH,
  message: MAX_MESSAGE_LENGTH,
});
