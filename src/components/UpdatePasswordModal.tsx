import React, { useState } from 'react';
import { updatePassword } from '../services/authService';
import { Button, Callout, Field, inputClass, Modal } from './ui';

/**
 * Shown when Firebase raises PASSWORD_RECOVERY (the user followed a reset
 * link). Setting the new password uses the recovery session; finishing or
 * cancelling signs out so the app returns to a clean sign-in.
 */
export const UpdatePasswordModal: React.FC<{ onFinish: () => void }> = ({ onFinish }) => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError('The two passwords do not match.'); return; }

    setBusy(true);
    const { error: err } = await updatePassword(password);
    setBusy(false);
    if (err) { setError(err); return; }
    onFinish();
  };

  return (
    <Modal
      isOpen
      onClose={onFinish}
      title="Choose a new password"
      description="You followed a password-reset link. Set a new password to continue."
      footer={
        <div className="flex justify-end">
          <Button type="submit" form="update-password-form" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Update password'}
          </Button>
        </div>
      }
    >
      <form id="update-password-form" onSubmit={submit} className="space-y-3" noValidate>
        {error && <Callout tone="error">{error}</Callout>}
        <Field label="New password" required hint="At least 6 characters.">
          {(id) => (
            <input
              id={id} type="password" className={inputClass} value={password} autoFocus
              placeholder="••••••••" onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Field label="Confirm new password" required>
          {(id) => (
            <input
              id={id} type="password" className={inputClass} value={confirm}
              placeholder="••••••••" onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
};
