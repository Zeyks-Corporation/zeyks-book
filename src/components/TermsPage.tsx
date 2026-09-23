import React from 'react';
import { FileCheck2, Scale, ShieldCheck, Check } from 'lucide-react';
import { PublicLayout } from './PublicLayout';
import { Button } from './ui';

export const TermsPage: React.FC<{
  currentPath?: string;
  navigate?: (to: string) => void;
  onSignIn: () => void;
}> = ({ currentPath = '/terms', navigate = () => {}, onSignIn }) => {
  return (
    <PublicLayout currentPath={currentPath} navigate={navigate} onSignIn={onSignIn}>
      <section className="relative overflow-hidden pt-12 pb-16 sm:pt-20 sm:pb-24">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          {/* Header */}
          <div className="text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-1.5 text-[13px] font-semibold text-[var(--accent)]">
              <Scale size={14} />
              <span>Terms of Service</span>
            </span>

            <h1 className="mt-6 text-[36px] font-extrabold leading-[44px] tracking-[-0.03em] sm:text-[48px] sm:leading-[56px] text-[var(--label)]">
              Terms & Operational Guarantees
            </h1>

            <p className="mx-auto mt-4 max-w-2xl text-[16px] leading-[26px] text-[var(--label-secondary)] sm:text-[18px]">
              Simple, transparent terms designed to protect your business integrity and statutory accounting practices in Nepal.
            </p>
          </div>

          {/* Terms Content */}
          <div className="mt-12 space-y-8 rounded-[24px] border border-[var(--separator)] bg-[var(--bg)] p-6 sm:p-10 shadow-sm text-[15px] leading-[26px] text-[var(--label-secondary)]">
            <div>
              <h2 className="text-[20px] font-bold text-[var(--label)] flex items-center gap-2">
                <FileCheck2 size={18} className="text-[var(--accent)]" />
                1. Service Scope & Double-Entry Accounting
              </h2>
              <p className="mt-2">
                Zeyks Book provides double-entry general ledger management, Bikram Sambat (BS) date conversion, IRD 13% VAT calculation, and financial statement generation. Users are responsible for maintaining accurate input records.
              </p>
            </div>

            <div className="border-t border-[var(--separator)] pt-6">
              <h2 className="text-[20px] font-bold text-[var(--label)] flex items-center gap-2">
                <ShieldCheck size={18} className="text-[var(--accent)]" />
                2. Account Credentials & Security
              </h2>
              <p className="mt-2">
                You are responsible for maintaining the confidentiality of your account authentication details. All data access requests require valid bearer tokens issued through authenticated user sessions.
              </p>
            </div>

            <div className="border-t border-[var(--separator)] pt-6">
              <h2 className="text-[20px] font-bold text-[var(--label)] flex items-center gap-2">
                <Check size={18} className="text-[var(--success)]" />
                3. Payment Processing & Gateway Terms
              </h2>
              <p className="mt-2">
                Online payment collection via eSewa or Khalti is subject to the respective payment provider's operational terms and verification criteria. Zeyks Book processes verified webhook confirmations directly into settlement ledgers.
              </p>
            </div>
          </div>

          {/* CTA */}
          <div className="mt-12 text-center">
            <Button variant="primary" size="lg" onClick={onSignIn} className="rounded-full px-8 h-12 text-[16px] font-semibold shadow-md">
              Accept & Get Started
            </Button>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
};
