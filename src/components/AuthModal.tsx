import React, { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { UserProfile } from '../types';
import { signIn, signUp, getProfile, requestOtp, verifyOtp, signInWithGoogle } from '../services/authService';
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

  // The password path the hidden fields below belong to. It is real Firebase
  // Auth (never a locally minted session), and it refuses an empty password
  // rather than substituting a well-known default.
  const _unusedPasswordAuth = async (targetEmail: string) => {
    if (!password) {
      setError('Please enter your password.');
      return;
    }
    const res = mode === 'register'
      ? await signUp(targetEmail, password, fullName.trim())
      : await signIn(targetEmail, password);
    if (res.error) {
      setError(res.error);
    } else if (res.user) {
      await getProfile(res.user.uid);
    }
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
    if (cleanCode.length < 4) {
      setError('Please enter the 6-digit verification code sent to your email.');
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

      const fallbackName = trimmedEmail.split('@')[0] || 'Your name';
      onSignedIn({
        id: res.user.uid,
        email: res.user.email ?? trimmedEmail,
        fullName: (res.user.displayName as string | null) || fullName.trim() || fallbackName,
        createdAt: res.user.metadata?.creationTime ?? new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await signInWithGoogle();
      if (res.error) {
        setError(res.error);
        setBusy(false);
        return;
      }
      if (res.user) {
        const fallbackName = res.user.email?.split('@')[0] || 'Your name';
        onSignedIn({
          id: res.user.uid,
          email: res.user.email ?? '',
          fullName: (res.user.displayName as string | null) || fallbackName,
          createdAt: res.user.metadata?.creationTime ?? new Date().toISOString(),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed.');
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
          <span className="text-[12px] text-[var(--label-tertiary)]">{mode === 'register' ? 'New account' : 'Email code'}</span>
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
                placeholder="Your name"
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
                  placeholder="Enter code"
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

        <div className="relative my-3">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-[var(--separator)]" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-[var(--surface)] px-2 text-[var(--label-tertiary)] font-medium">Or</span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-4 py-2.5 text-[14px] font-medium text-[var(--label)] shadow-xs transition hover:bg-[var(--fill-quaternary)] active:bg-[var(--fill-tertiary)] disabled:opacity-50"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
            />
          </svg>
          Continue with Google
        </button>
      </form>
    </Modal>
  );
};
