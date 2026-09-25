import React from 'react';
import { ShieldCheck, Lock, EyeOff, Database, Check } from 'lucide-react';
import { PublicLayout } from './PublicLayout';
import { Button } from './ui';

export const PrivacyPage: React.FC<{
  currentPath?: string;
  navigate?: (to: string) => void;
  onSignIn: () => void;
}> = ({ currentPath = '/privacy', navigate = () => {}, onSignIn }) => {
  return (
    <PublicLayout currentPath={currentPath} navigate={navigate} onSignIn={onSignIn}>
      <section className="relative overflow-hidden pt-12 pb-16 sm:pt-20 sm:pb-24">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          {/* Header */}
          <div className="text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-1.5 text-[13px] font-semibold text-[var(--accent)]">
              <ShieldCheck size={14} />
              <span>Data Protection & Privacy</span>
            </span>

            <h1 className="mt-6 text-[36px] font-extrabold leading-[44px] tracking-[-0.03em] sm:text-[48px] sm:leading-[56px] text-[var(--label)]">
              Your accounting data belongs to you.{' '}
              <span className="apple-text-gradient block mt-1">Period.</span>
            </h1>

            <p className="mx-auto mt-4 max-w-2xl text-[16px] leading-[26px] text-[var(--label-secondary)] sm:text-[18px]">
              Zeyks Book is designed from the ground up for strict data isolation, zero third-party telemetry, and total privacy.
            </p>
          </div>

          {/* Policy Content */}
          <div className="mt-12 space-y-8 rounded-[24px] border border-[var(--separator)] bg-[var(--bg)] p-6 sm:p-10 shadow-sm text-[15px] leading-[26px] text-[var(--label-secondary)]">
            <div>
              <h2 className="text-[20px] font-bold text-[var(--label)] flex items-center gap-2">
                <Lock size={18} className="text-[var(--accent)]" />
                1. Data Ownership & Storage Isolation
              </h2>
              <p className="mt-2">
                Every business record created in Zeyks Book is bound exclusively to your account using PostgreSQL Row Level Security (RLS). No other user or business on the platform can inspect, query, or access your financial records.
              </p>
            </div>

            <div className="border-t border-[var(--separator)] pt-6">
              <h2 className="text-[20px] font-bold text-[var(--label)] flex items-center gap-2">
                <EyeOff size={18} className="text-[var(--accent)]" />
                2. Zero Third-Party Telemetry & Tracking
              </h2>
              <p className="mt-2">
                We do not sell, rent, share, or monetize your business data, transaction history, customer identities, or financial balances. We do not use third-party analytics trackers, behavioral ad pixels, or session recording tools. Even the two typefaces this app is set in are served from our own origin — loading a page makes no request to any third party.
              </p>
            </div>

            <div className="border-t border-[var(--separator)] pt-6">
              <h2 className="text-[20px] font-bold text-[var(--label)] flex items-center gap-2">
                <Database size={18} className="text-[var(--accent)]" />
                3. Demo Mode Local Storage
              </h2>
              <p className="mt-2">
                When operating in Demo Mode, all created invoices, purchases, settlements, and settings are stored entirely inside your local browser storage (<code className="rounded bg-[var(--fill-secondary)] px-1.5 py-0.5 text-[13px] font-mono">local browser storage</code>). No cloud database communication occurs while in Demo Mode.
              </p>
            </div>

            <div className="border-t border-[var(--separator)] pt-6">
              <h2 className="text-[20px] font-bold text-[var(--label)] flex items-center gap-2">
                <Check size={18} className="text-[var(--success)]" />
                4. IRD Compliance & Export Rights
              </h2>
              <p className="mt-2">
                You retain the right to export your complete books, general journal entries, tax registers, and audit logs at any time in standard CSV or JSON formats for Inland Revenue Department (IRD) audits or local backups.
              </p>
            </div>

            <div className="border-t border-[var(--separator)] pt-6">
              <h2 className="text-[20px] font-bold text-[var(--label)] flex items-center gap-2">
                <Check size={18} className="text-[var(--success)]" />
                5. Third-Party Requests: Google Fonts
              </h2>
              <p className="mt-2">
                Zeyks Book makes exactly one third-party request: the two typefaces this site is set in are loaded from Google Fonts (fonts.googleapis.com / fonts.gstatic.com). This request carries your IP address and browser user agent to Google. No financial data, account details, or app usage information is included in it, and no other third-party service is contacted.
              </p>
            </div>
          </div>

          {/* CTA */}
          <div className="mt-12 text-center">
            <Button variant="primary" size="lg" onClick={onSignIn} className="rounded-full px-8 h-12 text-[16px] font-semibold shadow-md">
              Start Accounting with Confidence
            </Button>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
};
