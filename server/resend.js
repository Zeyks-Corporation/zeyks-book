/**
 * Resend email integration — this server's only outbound mail.
 *
 * Three templates, three call sites, and one rule that matters: the content is
 * always built here, from values that are escaped before they are interpolated.
 * A name typed into a contact form, an address, a message body, a subject line
 * — none of them may become markup, a new header, or a link.
 *
 * What used to be here instead: `sendAuthEmail`, reachable from an
 * unauthenticated `POST /api/auth/email`, which would mail any `type`, any
 * recipient and any caller-supplied `resetLink` while wearing this product's
 * branding. Anyone could use the domain to phish its own users. That endpoint
 * and that function are gone; the only auth mail this server sends is a code it
 * generated for a request it rate-limited (see ./otp.js), plus a welcome note
 * for an address whose code was just verified.
 */

import { Resend } from 'resend';

const apiKey = (process.env.RESEND_API_KEY ?? '').trim();
const resendClient = apiKey ? new Resend(apiKey) : null;

const FROM_EMAIL = (process.env.RESEND_FROM_EMAIL ?? '').trim() || 'Zeyks Book <onboarding@resend.dev>';
const CONTACT_TO_EMAIL = (process.env.RESEND_TO_EMAIL ?? '').trim() || 'support@zeyksbook.app';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Render untrusted text as text: no tag, no entity, no attribute can survive. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/**
 * Make a value safe for a mail header.
 *
 * A CR or LF in a subject or a display name is header injection: everything
 * after it becomes another header, which is how a contact form becomes a way to
 * send someone else's mail. Fold to one line and bound the length.
 */
export function headerSafe(value, maxLength = 120) {
  return String(value ?? '')
    .replace(/[\r\n\0]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** A shape check for addresses this server is about to write into a header. */
export function isEmailAddress(value) {
  const candidate = String(value ?? '').trim();
  return candidate.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(candidate);
}

/** The shared shell, so every message looks like it came from one product. */
function shell(inner) {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e4e4e7; border-radius: 12px;">
      ${inner}
      <hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 20px 0;" />
      <p style="color: #6b6b70; font-size: 12px; margin: 0;">Zeyks Book · this message was sent because of an action on your account.</p>
    </div>
  `;
}

export const resendService = {
  isConfigured() {
    return Boolean(resendClient);
  },

  /**
   * Contact-form submission, to the support inbox.
   *
   * The submitter's address becomes `replyTo` only after it passes the shape
   * check, and every field is escaped in the body.
   */
  async sendContactEmail({ name, email, message }) {
    const safeName = headerSafe(name, 120);
    const safeEmail = String(email ?? '').trim();
    const body = String(message ?? '');

    if (!resendClient) {
      console.log(`[resend] Simulation: contact form from ${safeName} <${headerSafe(safeEmail)}>: ${headerSafe(body, 200)}`);
      return {
        success: true,
        simulated: true,
        message: 'Resend API key not configured on server. Submission logged.',
      };
    }

    if (!isEmailAddress(safeEmail)) {
      const error = new Error('A valid email address is required.');
      error.status = 400;
      throw error;
    }

    const data = await resendClient.emails.send({
      from: FROM_EMAIL,
      to: [CONTACT_TO_EMAIL],
      replyTo: safeEmail,
      subject: `[Zeyks Book Contact] New inquiry from ${safeName || 'a visitor'}`,
      html: shell(`
        <h2 style="color: #09090b; margin-top: 0;">New contact form message</h2>
        <p style="color: #6b6b70; font-size: 14px;">A message arrived through the Zeyks Book contact page.</p>
        <p><strong>Name:</strong> ${escapeHtml(safeName) || '—'}</p>
        <p><strong>Email:</strong> ${escapeHtml(safeEmail)}</p>
        <p><strong>Message:</strong></p>
        <div style="background-color: #f4f4f5; padding: 15px; border-radius: 8px; font-size: 15px; color: #18181b; white-space: pre-wrap;">${escapeHtml(body)}</div>
      `),
    });

    return { success: true, data };
  },

  /**
   * A sign-in verification code.
   *
   * Called only by ./otp.js, only for a code this server generated, and only
   * when this service is configured. It throws when it is not: a simulated
   * "sent" here would leave a person waiting for mail that was never sent.
   */
  async sendOtpEmail({ email, code, name }) {
    if (!resendClient) {
      throw new Error('Resend is not configured, so no verification email can be sent.');
    }
    if (!isEmailAddress(email)) {
      throw new Error('A valid recipient email address is required.');
    }
    const safeCode = String(code ?? '');
    if (!/^\d{6}$/.test(safeCode)) {
      // Defence in depth: this template exists to carry exactly six digits.
      throw new Error('A six-digit verification code is required.');
    }

    const greeting = headerSafe(name, 80);

    const data = await resendClient.emails.send({
      from: FROM_EMAIL,
      to: [String(email).trim()],
      // The code is in the subject as well as the body: it is the one thing the
      // person needs, and it is a value this server generated.
      subject: `Your Zeyks Book verification code: ${safeCode}`,
      html: shell(`
        <div style="text-align: center; margin-bottom: 24px;">
          <h2 style="color: #09090b; font-size: 22px; font-weight: 700; margin: 0 0 8px 0;">Zeyks Book verification</h2>
          <p style="color: #6b6b70; font-size: 14px; margin: 0;">
            ${greeting ? `Hello ${escapeHtml(greeting)} — use the code below to finish signing in.` : 'Use the code below to finish signing in.'}
          </p>
        </div>
        <div style="background-color: #f4f4f5; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <span style="font-family: monospace, monospace; font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #0066d6;">${safeCode}</span>
        </div>
        <p style="color: #52525b; font-size: 13px; line-height: 1.5; margin-bottom: 16px;">
          This code is valid for 10 minutes and can be used once. If you did not request it, ignore this
          email — nobody can sign in with it unless they also have your inbox.
        </p>
      `),
    });

    return { success: true, data };
  },

  /**
   * A welcome note for an address whose verification code was just verified.
   *
   * Server-initiated, for an authorized flow only: ./otp.js sends this after it
   * has (a) matched a code it issued and (b) created the account. Best effort —
   * the caller swallows a failure, because a welcome email is not a sign-in.
   */
  async sendWelcomeEmail({ email, name }) {
    if (!resendClient) {
      throw new Error('Resend is not configured, so no welcome email can be sent.');
    }
    if (!isEmailAddress(email)) {
      throw new Error('A valid recipient email address is required.');
    }

    const greeting = headerSafe(name, 80);
    const data = await resendClient.emails.send({
      from: FROM_EMAIL,
      to: [String(email).trim()],
      subject: 'Welcome to Zeyks Book',
      html: shell(`
        <h2 style="color: #09090b; margin-top: 0;">Welcome to Zeyks Book${greeting ? `, ${escapeHtml(greeting)}` : ''}</h2>
        <p style="color: #52525b;">Your account is ready. Your books are yours alone: every row is protected by row level security, and nobody else on the platform can read them.</p>
        <p style="color: #6b6b70; font-size: 13px; margin-bottom: 0;">Set up your business details, then record your first invoice.</p>
      `),
    });

    return { success: true, data };
  },
};
