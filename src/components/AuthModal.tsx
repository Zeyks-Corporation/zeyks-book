import React, { useEffect, useState } from 'react';
import { UserProfile } from '../types';
import { signInWithGoogle } from '../services/authService';
import { Button, Callout, Modal } from './ui';

export const AuthModal: React.FC<{
  isOpen: boolean;
  onSignedIn: (user: UserProfile) => void;
  arrivalNotice?: string | null;
  arrivalNoticeTone?: 'info' | 'warn';
}> = ({ isOpen, arrivalNotice, arrivalNoticeTone }) => {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isOpen) setError(null);
  }, [isOpen]);

  const continueWithGoogle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const message = await signInWithGoogle();
      if (message) setError(message);
    } catch {
      setError('Google sign-in could not start. Please try again.');
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
      description="Continue with your Google account."
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <img src="/zeyks-mark.png" alt="Zeyks Book" className="h-5 w-5 object-contain shrink-0" />
          <span className="text-[12px] font-semibold uppercase tracking-[0.22em] text-[var(--label-secondary)]">Zeyks Book</span>
          <span className="h-px grow bg-[var(--separator)]" aria-hidden="true" />
          <span className="text-[12px] text-[var(--label-tertiary)]">Bookkeeping</span>
        </div>
        {error && <Callout tone="error">{error}</Callout>}
        {arrivalNotice && <Callout tone={arrivalNoticeTone === 'warn' ? 'warn' : 'info'}>{arrivalNotice}</Callout>}
        <Button type="button" variant="primary" size="md" disabled={busy}
          className="w-full" onClick={() => void continueWithGoogle()}>
          {busy ? 'Opening Google…' : 'Continue with Google'}
        </Button>
        <p className="text-[12px] text-[var(--label-tertiary)] text-center">
          New accounts start locked. Contact us to activate Starter or Premium.
        </p>
      </div>
    </Modal>
  );
};
