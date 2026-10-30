import React from 'react';
import { ArrowLeft, Lock } from 'lucide-react';
import { Button } from './ui';
import { ROLE_LABEL, ROLE_PRICE_NPR, WHATSAPP_PLAN_URL, type AppRole } from '../lib/roles';

/**
 * Shown to a signed-in user whose role does not unlock the dashboard.
 *
 * The same page renders whether the user has just signed up (role='user') or
 * downgraded from a paying tier. From here they can either buy a plan (opens
 * WhatsApp with a pre-filled message) or sign out.
 */
export const SubscribeView: React.FC<{
  role: AppRole | undefined;
  email: string | null;
  onHome: () => void;
  onSignOut: () => void;
}> = ({ role, email, onHome, onSignOut }) => {
  const tierLabel = ROLE_LABEL[role ?? 'user'];
  return (
    <div className="min-h-screen bg-[var(--bg-secondary)] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] shadow-sm p-8 text-center space-y-5">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--fill-secondary)] text-[var(--label-secondary)]">
          <Lock size={20} strokeWidth={1.8} aria-hidden="true" />
        </div>
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--label-tertiary)]">
            {tierLabel} account
          </p>
          <h1 className="mt-3 text-[24px] font-bold leading-[30px] tracking-[-0.3px] text-[var(--label)]">
            Choose a plan to open your books
          </h1>
          <p className="mt-3 text-[15px] leading-[22px] text-[var(--label-secondary)]">
            Zeyks Book is a complete double-entry engine. Pick a plan that fits the
            size of your shop — Plus for kirana counters, Premium for everything
            including inventory and reports.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-[10px] border border-[var(--separator)] p-4 text-left">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--label-tertiary)]">Plus</p>
            <p className="mt-1 text-[20px] font-bold text-[var(--label)]">NPR {ROLE_PRICE_NPR.plus}</p>
            <p className="mt-1 text-[12px] text-[var(--label-secondary)]">Dashboard, sales, purchases & expenses</p>
          </div>
          <div className="rounded-[10px] border-2 border-[var(--accent)] p-4 text-left bg-[var(--accent)]/5">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--accent)]">Premium</p>
            <p className="mt-1 text-[20px] font-bold text-[var(--label)]">NPR {ROLE_PRICE_NPR.premium}</p>
            <p className="mt-1 text-[12px] text-[var(--label-secondary)]">Every feature + reports</p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <a
            href={WHATSAPP_PLAN_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-1.5 font-medium transition-[transform,background-color] active:scale-[0.97] rounded-full px-6 py-3 text-[17px] min-h-[44px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
          >
            See plans
          </a>
          <Button variant="secondary" size="md" className="w-full" onClick={onHome}>
            <ArrowLeft size={14} aria-hidden="true" /> Back to home
          </Button>
          <button
            type="button"
            onClick={onSignOut}
            className="text-[13px] text-[var(--label-secondary)] underline-offset-2 hover:text-[var(--label)] hover:underline"
          >
            Sign out{email ? ` (${email})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
};
