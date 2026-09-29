import React, { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { UserProfile } from '../types';
import { signInWithEmail } from '../services/authService';
import { Button, Callout, Field, Modal, inputClass } from './ui';

export const AuthModal: React.FC<{
  isOpen: boolean;
  onSignedIn: (user: UserProfile) => void;
  arrivalNotice?: string | null;
  arrivalNoticeTone?: 'info' | 'warn';
}> = ({ isOpen, onSignedIn, arrivalNotice, arrivalNoticeTone }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setNotice(arrivalNotice ?? null);
  }, [isOpen, arrivalNotice, arrivalNoticeTone]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      const res = await signInWithEmail(email, password);
      if (res.user) {
        onSignedIn({
          id: res.user.id,
          email: res.user.email,
          fullName: res.user.name || res.user.email.split('@')[0] || 'Your account',
          createdAt: res.user.createdAt ?? new Date().toISOString(),
        });
        return;
      }
      setError(res.error ?? 'Sign-in failed. Please try again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {}}
      dismissible={false}
      size="sm"
      title="Sign in to Zeyks Book"
      description="Use the email and password issued for your account."
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <img src="/zeyks-mark.png" alt="Zeyks Book" className="h-5 w-5 object-contain shrink-0" />
          <span className="text-[12px] font-semibold uppercase tracking-[0.22em] text-[var(--label-secondary)]">Zeyks Book</span>
          <span className="h-px grow bg-[var(--separator)]" aria-hidden="true" />
          <span className="text-[12px] text-[var(--label-tertiary)]">Bookkeeping</span>
        </div>

        <div className="space-y-2" aria-live="polite">
          {error && <Callout tone="error">{error}</Callout>}
          {notice && <Callout tone={arrivalNoticeTone === 'warn' ? 'warn' : 'info'}>{notice}</Callout>}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Field label="Email" required>
            {(id) => (
              <input
                id={id}
                type="email"
                name="email"
                autoComplete="username"
                spellCheck={false}
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
                placeholder="you@example.com"
              />
            )}
          </Field>

          <Field label="Password" required>
            {(id) => (
              <div className="relative">
                <input
                  id={id}
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${inputClass} pr-12`}
                  placeholder="Your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-11 w-11 flex items-center justify-center text-[var(--label-tertiary)] hover:text-[var(--label-secondary)]"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            )}
          </Field>

          <Button type="submit" variant="primary" size="md" disabled={busy} className="w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="text-[12px] text-[var(--label-tertiary)] text-center">
          Accounts are created by Zeyks Book. No sign-up is offered — contact us to get one for your business.
        </p>
      </div>
    </Modal>
  );
};
