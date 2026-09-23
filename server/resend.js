/**
 * Resend Email Service Integration.
 *
 * Handles sending emails using Resend (https://resend.com).
 * Reads `RESEND_API_KEY` from the environment.
 */

import { Resend } from 'resend';

const apiKey = process.env.RESEND_API_KEY;
const resendClient = apiKey ? new Resend(apiKey) : null;

export const resendService = {
  isConfigured() {
    return Boolean(apiKey && apiKey.trim().length > 0);
  },

  /**
   * Send a contact form email submission via Resend.
   */
  async sendContactEmail({ name, email, message }) {
    if (!resendClient) {
      console.log(`[resend] Simulation: Contact form submitted by ${name} <${email}>: "${message}"`);
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
        replyTo: email,
        subject: `[Zeyks Book Contact] New Inquiry from ${name}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e4e4e7; rounded: 12px;">
            <h2 style="color: #09090b; margin-top: 0;">New Contact Form Message</h2>
            <p style="color: #71717a; font-size: 14px;">You received a message via the Zeyks Book contact page.</p>
            <hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 20px 0;" />
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
            <p><strong>Message:</strong></p>
            <div style="background-color: #f4f4f5; padding: 15px; border-radius: 8px; font-size: 15px; color: #18181b; white-space: pre-wrap;">${message}</div>
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

  /**
   * Send authentication emails (welcome, reset password, confirmation) via Resend.
   */
  async sendAuthEmail({ type, email, name = 'Valued User', resetLink }) {
    if (!resendClient) {
      console.log(`[resend] Simulation: Auth email (${type}) for ${email}`);
      return { success: true, simulated: true };
    }

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'Zeyks Book <onboarding@resend.dev>';
    const subjectMap = {
      welcome: 'Welcome to Zeyks Book!',
      password_reset: 'Reset Your Zeyks Book Password',
      signup_notification: 'New User Registered on Zeyks Book',
    };

    const subject = subjectMap[type] || 'Zeyks Book Security Notification';

    const htmlMap = {
      welcome: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e4e4e7; border-radius: 12px;">
          <h2 style="color: #09090b;">Welcome to Zeyks Book, ${name}!</h2>
          <p style="color: #52525b;">Your account has been created. Start managing your double-entry accounting with native Bikram Sambat dates.</p>
          <hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 20px 0;" />
          <p style="color: #a1a1aa; font-size: 12px;">Zeyks Book Security & Auth System · Powered by Resend</p>
        </div>
      `,
      password_reset: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e4e4e7; border-radius: 12px;">
          <h2 style="color: #09090b;">Password Reset Request</h2>
          <p style="color: #52525b;">We received a request to reset your password for <strong>${email}</strong>.</p>
          ${resetLink ? `<p><a href="${resetLink}" style="display: inline-block; background: #007AFF; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600;">Reset Password</a></p>` : ''}
          <p style="color: #71717a; font-size: 13px;">If you did not request this change, you can safely ignore this email.</p>
          <hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 20px 0;" />
          <p style="color: #a1a1aa; font-size: 12px;">Zeyks Book Security & Auth System · Powered by Resend</p>
        </div>
      `,
      signup_notification: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e4e4e7; border-radius: 12px;">
          <h2 style="color: #09090b;">New Signup Event</h2>
          <p>A new user has registered: <strong>${name}</strong> (${email}).</p>
        </div>
      `,
    };

    try {
      const data = await resendClient.emails.send({
        from: fromEmail,
        to: [email],
        subject,
        html: htmlMap[type] || htmlMap.welcome,
      });
      return { success: true, data };
    } catch (error) {
      console.error(`[resend] Failed to send auth email (${type}):`, error);
      throw error;
    }
  },
};
