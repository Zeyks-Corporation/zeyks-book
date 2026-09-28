import React, { useEffect, useState } from 'react';
import { UserProfile } from '../types';
import { signInWithGoogle } from '../services/authService';
import { Callout, Modal } from './ui';

const GoogleMark: React.FC = () => (
  <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
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
);

export const AuthModal: React.FC<{
  isOpen: boolean;
  onSignedIn: (user: UserProfile) => void;
  arrivalNotice?: string | null;
  arrivalNoticeTone?: 'info' | 'warn';
}> = ({ isOpen, onSignedIn, arrivalNotice, arrivalNoticeTone }) => {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setNotice(arrivalNotice ?? null);
    setError(null);
  }, [isOpen, arrivalNotice, arrivalNoticeTone]);

  const handleGoogleSignIn = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await signInWithGoogle();
      if (res.user) {
        const fallbackName = res.user.email?.split('@')[0] || 'Your name';
        onSignedIn({
          id: res.user.id,
          email: res.user.email ?? '',
          fullName: res.user.name || fallbackName,
          createdAt: res.user.createdAt ?? new Date().toISOString(),
        });
        return;
      }
      // OAuth is a redirect: when no user comes back synchronously, the
      // browser is on its way to Google and the next state change is the
      // one we listen for in App.
      if (res.error) setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed.');
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
      description="Continue with Google to access your books."
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <img src="/zeyks-mark.png" alt="Zeyks Book" className="h-5 w-5 object-contain shrink-0" />
          <span className="text-[12px] font-semibold uppercase tracking-[0.22em] text-[var(--label-secondary)]">Zeyks Book</span>
          <span className="h-px grow bg-[var(--separator)]" aria-hidden="true" />
          <span className="text-[12px] text-[var(--label-tertiary)]">Google</span>
        </div>

        <div className="space-y-2" aria-live="polite">
          {error && <Callout tone="error">{error}</Callout>}
          {notice && <Callout tone="info">{notice}</Callout>}
        </div>

        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-4 py-2.5 text-[14px] font-medium text-[var(--label)] shadow-xs transition hover:bg-[var(--fill-quaternary)] active:bg-[var(--fill-tertiary)] disabled:opacity-50"
        >
          <GoogleMark />
          {busy ? 'Opening Google…' : 'Continue with Google'}
        </button>

        <p className="text-[12px] text-[var(--label-tertiary)] text-center">
          Email sign-in is no longer offered. Use a Google account to continue.
        </p>
      </div>
    </Modal>
  );
};
