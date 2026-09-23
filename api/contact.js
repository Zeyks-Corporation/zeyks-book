import { resendService } from '../server/resend.js';
import { validateContactPayload } from '../server/contact.js';

/**
 * Vercel's static deployment does not run server/index.js. Keep the public
 * contact form available there with a small function that shares validation
 * and email delivery with the local Express runtime.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const validated = validateContactPayload(req.body);
  if (!validated.ok) return res.status(400).json({ error: validated.error });

  // Unlike the local server's development simulation, a deployed function must
  // fail closed rather than tell a visitor that an email was sent when there is
  // no Resend account configured.
  if (!resendService.isConfigured()) {
    return res.status(503).json({ error: 'Contact email is not configured on the server.' });
  }

  try {
    const result = await resendService.sendContactEmail(validated.value);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[contact] Failed to send email via Resend:', error);
    return res.status(500).json({ error: 'Failed to send message via Resend.' });
  }
}
