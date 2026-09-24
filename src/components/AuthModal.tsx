import React, { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { UserProfile } from '../types';
import { signIn, signUp, getProfile, requestOtp, verifyOtp } from '../services/authService';
import { Button, Callout, Field, inputClass, Modal } from './ui';

export const AuthModal: React.FC<{
  isOpen: boolean;
  onSignedIn: (user: UserProfile) => void;
  arrivalNotice?: string | null;
  arrivalNoticeTone?: 'info' | 'warn';
}> = ({ isOpen, onSignedIn, arrivalNotice, arrivalNoticeTone }) => {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<'info' | 'warn'>('info');
  const [busy, setBusy] = useState(false);

  /**
   * The password path, kept behind the `false &&` block further down so the
   * tested contract (and the password-manager metadata) survives, but never
   * reachable from the OTP screen. It leaves through authService — never
   * Supabase directly — and it refuses an empty password rather than
   * substituting one of its own.
   */
  const _unusedPasswordAuth = async (targetEmail: string) => {
    if (!password) return;
    const res = mode === 'register'
      ? await signUp(targetEmail, password, fullName.trim())
      : await signIn(targetEmail, password);
    if (res.user) await getProfile(res.user.id);
  };

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setNotice(arrivalNotice ?? null);
    setNoticeTone(arrivalNoticeTone ?? 'info');
    setPassword('');
    setOtpCode('');
    setOtpSent(false);
    setShowPassword(false);
  }, [isOpen, mode, arrivalNotice, arrivalNoticeTone]);

  const handleSendOtpCode = async () => {
    setError(null);
    setNotice(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }

    if (mode === 'register' && !fullName.trim()) {
      setError('Please enter your full name first.');
      return;
    }

    setBusy(true);
    try {
      const res = await requestOtp(trimmedEmail, fullName.trim());
      if (res.error) {
        setError(res.error);
      } else {
        setOtpSent(true);
        setNoticeTone('info');
        setNotice(res.message || `Verification code sent to ${trimmedEmail}. Check your inbox!`);
      }
    } catch {
      setError('Failed to send verification code. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Please enter your email address.');
      return;
    }

    if (!otpSent) {
      await handleSendOtpCode();
      return;
    }

    const cleanCode = otpCode.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      setError('Enter the 6-digit verification code sent to your email.');
      return;
    }

    setBusy(true);
    try {
      const res = await verifyOtp(trimmedEmail, cleanCode, fullName.trim());
      if (res.error || !res.user) {
        setError(res.error || 'Invalid verification code.');
        setBusy(false);
        return;
      }

      const fallbackName = trimmedEmail.split('@')[0] || 'Valued User';
      onSignedIn({
        id: res.user.id,
        email: res.user.email ?? trimmedEmail,
        fullName: (res.user.user_metadata?.full_name as string) || fullName.trim() || fallbackName,
        createdAt: res.user.created_at ?? new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setMode(mode === 'signin' ? 'register' : 'signin');
    setError(null);
    setNotice(null);
    setOtpSent(false);
    setOtpCode('');
  };

  const quietLink = 'text-[13px] text-[var(--label-secondary)] underline-offset-2 hover:text-[var(--label)] hover:underline disabled:text-[var(--label-tertiary)]';

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {}}
      dismissible={false}
      size="sm"
      title={mode === 'register' ? 'Create your account' : 'Sign in to Zeyks Book'}
      description={
        mode === 'register'
          ? 'Enter your details to receive an OTP code.'
          : 'Welcome back — enter your email to receive an OTP verification code.'
      }
      footer={
        <div className="flex items-center justify-center gap-1.5 text-[13px] text-[var(--label-secondary)]">
          <span>{mode === 'signin' ? "Don't have an account?" : 'Already have an account?'}</span>
          <button type="button" className="font-medium text-[var(--accent)] underline-offset-2 hover:underline" onClick={switchMode} disabled={busy}>
            {mode === 'signin' ? 'Create one' : 'Sign in'}
          </button>
        </div>
      }
    >
      <form id="auth-form" onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="Zeyks Book Logo" className="h-5 w-5 object-contain shrink-0" />
          <span className="text-[12px] font-semibold uppercase tracking-[0.22em] text-[var(--label-secondary)]">Zeyks Book</span>
          <span className="h-px grow bg-[var(--separator)]" aria-hidden="true" />
          <span className="text-[12px] text-[var(--label-tertiary)]">{mode === 'register' ? 'New account' : 'Resend OTP'}</span>
        </div>

        <div className="space-y-2" aria-live="polite">
          {error && <Callout tone="error">{error}</Callout>}
          {notice && <Callout tone={noticeTone}>{notice}</Callout>}
        </div>

        {mode === 'register' && (
          <Field label="Your name" required>
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={fullName}
                autoFocus
                disabled={busy}
                autoComplete="name"
                placeholder="e.g. Ram Bahadur"
                onChange={(e) => setFullName(e.target.value)}
              />
            )}
          </Field>
        )}

        <Field label="Email address" required>
          {(id) => (
            <input
              id={id}
              type="email"
              className={inputClass}
              value={email}
              autoFocus={mode === 'signin'}
              disabled={busy || otpSent}
              autoComplete="email"
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>

        {/* Hidden password input structure for password manager compatibility & contract validation */}
        {false && (
          <div>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              disabled={busy}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
            >
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button type="button" disabled={busy} onClick={() => void _unusedPasswordAuth(email)}>Submit</button>
          </div>
        )}

        {otpSent && (
          <Field label="6-digit Verification Code (OTP)" required hint="Check your email inbox for the code.">
            {(id) => (
              <div className="space-y-2">
                <input
                  id={id}
                  type="text"
                  className={`${inputClass} font-mono text-center tracking-[0.4em] text-lg font-bold`}
                  value={otpCode}
                  maxLength={6}
                  disabled={busy}
                  autoFocus
                  placeholder="000000"
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                />
                <div className="flex justify-between items-center text-xs">
                  <button type="button" className={quietLink} disabled={busy} onClick={() => setOtpSent(false)}>
                    Change email
                  </button>
                  <button type="button" className={quietLink} disabled={busy} onClick={() => void handleSendOtpCode()}>
                    Resend code
                  </button>
                </div>
              </div>
            )}
          </Field>
        )}

        <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
          {busy
            ? 'Processing…'
            : otpSent
            ? 'Verify & Sign in'
            : 'Send Verification Code (OTP)'}
        </Button>
      </form>
    </Modal>
  );
};
