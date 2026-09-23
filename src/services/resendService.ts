/**
 * Resend Email Client Service
 */

export async function sendAuthEmailNotification(
  type: 'welcome' | 'password_reset' | 'signup_notification',
  targetEmail: string,
  userName?: string
): Promise<{ success: boolean }> {
  try {
    const response = await fetch('/api/auth/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, targetEmail, userName }),
    });
    return (await response.json()) as { success: boolean };
  } catch {
    return { success: false };
  }
}
