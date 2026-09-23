import React, { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { UserProfile } from '../types';
import { signIn, signUp, getProfile, requestPasswordReset, resendConfirmation } from '../services/authService';
import { Button, Callout, Field, inputClass, Modal } from './ui';

export const AuthModal: React.FC<{
  isOpen: boolean;
  onSignedIn: (user: UserProfile) => void;
  /**
   * A one-off message to show on arrival, such as a sign-out that ended this
   * device's session but could not revoke the other devices. Rendered once and
   * cleared as soon as the person does anything here.
   */
  arrivalNotice?: string | null;
  arrivalNoticeTone?: 'info' | 'warn';
}> = ({ isOpen, onSignedIn, arrivalNotice, arrivalNoticeTone }) => {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<'info' | 'warn'>('info');
  const [busy, setBusy] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setNotice(arrivalNotice ?? null);
    setNoticeTone(arrivalNoticeTone ?? 'info');
    setPassword('');
    setShowPassword(false);
    setNeedsConfirmation(false);
  }, [isOpen, mode, arrivalNotice, arrivalNoticeTone]);

  const handleForgotPassword = async () => {
    setError(null);
    setNotice(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Enter your email first, then choose "Forgot password?".');
      return;
    }
    setBusy(true);
    const { error: err } = await requestPasswordReset(trimmedEmail);
    setBusy(false);
    if (err) { setError(err); return; }
    setNoticeTone('info');
    setNotice('If that email has an account, a password-reset link is on its way.');
  };

  const handleResendConfirmation = async () => {
    setError(null);
    setNotice(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Enter your email first.');
      return;
    }
    setBusy(true);
    const { error: err } = await resendConfirmation(trimmedEmail);
    setBusy(false);
    if (err) { setError(err); return; }
    setNotice('Confirmation email sent again. Check your inbox.');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Please enter your email.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setBusy(true);
    try {
      if (mode === 'register') {
        const trimmedName = fullName.trim();
        if (!trimmedName) {
          setError('Please enter your name.');
          setBusy(false);
          return;
        }

        const res = await signUp(trimmedEmail, password, trimmedName);
        if (res.error) {
          setError(res.error);
          setBusy(false);
          return;
        }

        if (!res.user) {
          setError('Could not create account. Please try again.');
          setBusy(false);
          return;
        }

        if (!res.session) {
          // Email confirmation is required by Supabase project settings
          setNotice('Account created! Please check your email to confirm your account, then sign in.');
          setNeedsConfirmation(true);
          setMode('signin');
          setBusy(false);
          return;
        }

        // Session obtained immediately
        const { profile } = await getProfile(res.user.id);
        onSignedIn(
          profile ?? {
            id: res.user.id,
            email: res.user.email ?? trimmedEmail,
            fullName: (res.user.user_metadata?.full_name as string) || trimmedName,
            createdAt: res.user.created_at ?? new Date().toISOString(),
          },
        );
      } else {
        const res = await signIn(trimmedEmail, password);
        if (res.error) {
          setError(res.error);
          setBusy(false);
          return;
        }

        if (!res.user) {
          setError('Sign in failed. Please try again.');
          setBusy(false);
          return;
        }

        const { profile } = await getProfile(res.user.id);
        const fallbackName = (res.user.user_metadata?.full_name as string | undefined) || trimmedEmail.split('@')[0] || '';
        onSignedIn(
          profile ?? {
            id: res.user.id,
            email: res.user.email ?? trimmedEmail,
            fullName: fallbackName,
            createdAt: res.user.created_at ?? new Date().toISOString(),
          },
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setMode(mode === 'signin' ? 'register' : 'signin');
    setError(null);
    setNotice(null);
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
          ? 'Invoices, receipts and reports for your business.'
          : 'Welcome back — your books are where you left them.'
      }
      footer={
        <div className="flex items-center justify-center gap-1.5 text-[13px] text-[var(--label-secondary)]">
          <span>{mode === 'signin' ? "Don't have an account?" : 'Already have an account?'}</span>
          <button type="button" className="font-medium text-[var(--accent)] underline-offset-2 hover:underline" onClick={switchMode}>
            {mode === 'signin' ? 'Create one' : 'Sign in'}
          </button>
        </div>
      }
    >
      <form id="auth-form" onSubmit={handleSubmit} className="space-y-4" noValidate>
        {/* The mark, then a hairline, then what this screen is for. The title
            above already says which mode we are in; this is the product naming
            itself in the one place a person sees before they are inside it. */}
        <div className="flex items-center gap-3">
          <span className="text-[12px] font-semibold uppercase tracking-[0.22em] text-[var(--label-secondary)]">Zeyks Book</span>
          <span className="h-px grow bg-[var(--separator)]" aria-hidden="true" />
          <span className="text-[12px] text-[var(--label-tertiary)]">{mode === 'register' ? 'New account' : 'Nepal · NPR'}</span>
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
        <Field label="Email" required>
          {(id) => (
            <input
              id={id}
              type="email"
              className={inputClass}
              value={email}
              autoFocus={mode === 'signin'}
              disabled={busy}
              autoComplete="email"
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Password"
          required
          hint={mode === 'register' ? 'At least 6 characters.' : undefined}
        >
          {(id) => (
            // The reveal control sits inside the field: a mistyped password on a
            // phone keyboard is the most common reason a sign-in fails, and
            // there is nowhere better to fix it than where it was typed.
            <div className="relative">
              <input
                id={id}
                type={showPassword ? 'text' : 'password'}
                className={`${inputClass} pr-10`}
                value={password}
                disabled={busy}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                placeholder="••••••••"
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded min-h-[44px] min-w-[44px] flex items-center justify-center text-[var(--label-tertiary)] hover:text-[var(--label)]"
              >
                {showPassword
                  ? <EyeOff size={14} strokeWidth={1.8} aria-hidden="true" />
                  : <Eye size={14} strokeWidth={1.8} aria-hidden="true" />}
              </button>
            </div>
          )}
        </Field>

        {(mode === 'signin' || needsConfirmation) && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {mode === 'signin' ? (
              <button type="button" className={quietLink} disabled={busy}
                onClick={() => void handleForgotPassword()}>
                Forgot password?
              </button>
            ) : <span />}
            {needsConfirmation && (
              <button type="button" className={`${quietLink} ml-auto`} disabled={busy}
                onClick={() => void handleResendConfirmation()}>
                Resend confirmation email
              </button>
            )}
          </div>
        )}

        {/* One primary action, full width, at the bottom of the thumb's reach. */}
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
          {busy
            ? mode === 'register'
              ? 'Creating account…'
              : 'Signing in…'
            : mode === 'register'
            ? 'Create account'
            : 'Sign in'}
        </Button>
      </form>
    </Modal>
  );
};
