/**
 * Resend Email Service Integration.
 *
 * Handles sending emails using Resend (https://resend.com).
 * Reads `RESEND_API_KEY` from the environment.
 */

import { Resend } from 'resend';

const apiKey = process.env.RESEND_API_KEY;
const resendClient = apiKey ? new Resend(apiKey) : null;

/**
 * Escape a value for HTML text or quoted-attribute context.
 *
 * Every value the public contact form submits (name, email, message) is echoed
 * into an email body, so it must arrive as text and never as markup. These
 * five characters cover both contexts.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Flatten a value that is interpolated into a header (a subject, a display
 * name) so CR/LF cannot inject a second header.
 */
export function singleLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * A conservative reply-to check: one @, no whitespace or control characters,
 * a dotted domain, at most 254 characters. Deliberately not a full RFC 5322
 * grammar — the requirement is narrower, that an address cannot carry markup
 * or a header break into the message Resend is asked to send.
 */
export function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const email = value.trim();
  if (!email || email.length > 254) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(email)) return false;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(email);
}

export const resendService = {
  isConfigured() {
    return Boolean(apiKey && apiKey.trim().length > 0);
  },

  /**
   * Send a contact form email submission via Resend.
   */
  async sendContactEmail({ name, email, message }) {
    if (!isValidEmail(email)) {
      throw new Error('A valid reply-to email address is required.');
    }

    const safeName = escapeHtml(singleLine(name));
    const safeEmail = escapeHtml(singleLine(email));
    const safeMessage = escapeHtml(message);

    if (!resendClient) {
      // The body itself is never logged: what the simulator records is that a
      // submission happened, and who to reply to.
      console.log(`[resend] Simulation: Contact form submitted by ${singleLine(name)} <${singleLine(email)}>`);
      return {
        success: true,
        simulated: true,
        message: 'Resend API key not configured on server. Submission logged.',
      };
    }

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'Zeyks Book <onboarding@resend.dev>';
    const toEmail = process.env.RESEND_TO_EMAIL || 'support@zeyks.book';

    try {
      const data = await resendClient.emails.send({
        from: fromEmail,
        to: [toEmail],
        replyTo: singleLine(email),
        subject: `[Zeyks Book Contact] New Inquiry from ${singleLine(name)}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e4e4e7; rounded: 12px;">
            <h2 style="color: #09090b; margin-top: 0;">New Contact Form Message</h2>
            <p style="color: #71717a; font-size: 14px;">You received a message via the Zeyks Book contact page.</p>
            <hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 20px 0;" />
            <p><strong>Name:</strong> ${safeName}</p>
            <p><strong>Email:</strong> <a href="mailto:${safeEmail}">${safeEmail}</a></p>
            <p><strong>Message:</strong></p>
            <div style="background-color: #f4f4f5; padding: 15px; border-radius: 8px; font-size: 15px; color: #18181b; white-space: pre-wrap;">${safeMessage}</div>
            <hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 20px 0;" />
            <p style="color: #a1a1aa; font-size: 12px; margin-bottom: 0;">Zeyks Book Email System · Resend Service</p>
          </div>
        `,
      });

      return { success: true, data };
    } catch (error) {
      console.error('[resend] Failed to send email via Resend:', error);
      throw error;
    }
  },

};
