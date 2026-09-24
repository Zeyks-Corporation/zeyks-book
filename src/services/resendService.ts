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

export async function sendResendOtp(
  email: string,
  name?: string
): Promise<{ success: boolean; message?: string; error?: string; debugCode?: string }> {
  try {
    const response = await fetch('/api/auth/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name }),
    });
    return (await response.json()) as { success: boolean; message?: string; error?: string; debugCode?: string };
  } catch {
    return { success: false, error: 'Network error. Could not send OTP.' };
  }
}

export async function verifyResendOtp(
  email: string,
  code: string,
  name?: string
): Promise<{ success: boolean; user?: any; session?: any; error?: string }> {
  try {
    const response = await fetch('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, name }),
    });
    return (await response.json()) as { success: boolean; user?: any; session?: any; error?: string };
  } catch {
    return { success: false, error: 'Network error. Could not verify OTP.' };
  }
}
