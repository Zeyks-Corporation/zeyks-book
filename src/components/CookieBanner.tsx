import React, { useEffect, useState } from 'react';
import { Cookie, X } from 'lucide-react';
import { Button } from './ui';

const COOKIE_CONSENT_KEY = 'zeyks.cookie_consent';

export const CookieBanner: React.FC = () => {
  const [accepted, setAccepted] = useState(true);

  useEffect(() => {
    try {
      const consent = localStorage.getItem(COOKIE_CONSENT_KEY);
      if (!consent) {
        setAccepted(false);
      }
    } catch {
      setAccepted(true);
    }
  }, []);

  const handleAccept = () => {
    try {
      localStorage.setItem(COOKIE_CONSENT_KEY, 'true');
    } catch { /* fallback */ }
    setAccepted(true);
  };

  if (accepted) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-2xl border border-[var(--separator)] bg-[var(--bg)]/95 p-4 shadow-xl backdrop-blur-xl transition-all animate-in fade-in slide-in-from-bottom-5">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)]/10 text-[var(--accent)]">
          <Cookie size={18} />
        </span>

        <div className="flex-1 text-[13px] leading-[18px]">
          <p className="font-semibold text-[var(--label)]">Cookie & Privacy Choice</p>
          <p className="mt-1 text-[var(--label-secondary)]">
            We use essential local browser storage for authentication and offline demo preferences. No ad tracking.
          </p>

          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={handleAccept} className="rounded-full px-4 h-8 text-[12px] font-semibold">
              Accept Essential
            </Button>
            <button
              type="button"
              onClick={handleAccept}
              className="text-[12px] font-medium text-[var(--label-tertiary)] hover:text-[var(--label)] px-2"
            >
              Dismiss
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={handleAccept}
          className="text-[var(--label-tertiary)] hover:text-[var(--label)] p-1"
          aria-label="Close cookie banner"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
