import React from 'react';
import { Check, HelpCircle } from 'lucide-react';
import { PublicLayout } from './PublicLayout';
import { Button } from './ui';

export const PricingPage: React.FC<{
  currentPath: string;
  navigate: (to: string) => void;
  onSignIn: () => void;
}> = ({ currentPath, navigate, onSignIn }) => {
  const FEATURES = [
    'Double-entry accounting engine by construction',
    'Bikram Sambat (BS) & AD calendar support',
    'Aged receivables & payables (30, 60, 90 days)',
    'A4 print-ready financial statements & tax reports',
    'Automatic ledger & document health checks',
    'Self-hosted on your own private cloud database',
    'Zero monthly subscription or user limits',
    'Full control over your financial data',
  ];

  const FAQS = [
    {
      q: 'Is Zeyks Book really free?',
      a: 'Yes. Zeyks Book is an open accounting system designed to run on your own private database tier. You only pay for your own infrastructure if you exceed standard usage limits.',
    },
    {
      q: 'Where are my financial records stored?',
      a: 'Your records stay entirely within your own PostgreSQL database. Zeyks Book holds no central servers that read or store your financial ledger.',
    },
    {
      q: 'Can I export statements for my bank or auditor?',
      a: 'Yes. Profit & Loss, Balance Sheet, Trial Balance, General Ledger, VAT return, and Cash/Bank statements are designed as standard A4 sheets ready to print or export as PDF.',
    },
  ];

  return (
    <PublicLayout currentPath={currentPath} navigate={navigate} onSignIn={onSignIn}>
      <section className="mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="text-center max-w-2xl mx-auto">
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--label-tertiary)]">
            Simple & Transparent
          </p>
          <h1 className="mt-3 text-[34px] font-bold leading-[41px] tracking-[-0.4px] text-[var(--label)]">
            Honest pricing for your business
          </h1>
          <p className="mt-4 text-[17px] leading-[22px] text-[var(--label-secondary)]">
            No hidden tiers, per-seat charges, or vendor lock-in.
          </p>
        </div>

        {/* Pricing Card */}
        <div className="mt-12 max-w-lg mx-auto bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] p-8 shadow-sm">
          <div className="flex items-baseline justify-between border-b border-[var(--separator)] pb-6">
            <div>
              <h2 className="text-[22px] font-bold text-[var(--label)]">Community Edition</h2>
              <p className="mt-1 text-[13px] text-[var(--label-secondary)]">Self-hosted & open</p>
            </div>
            <div className="text-right">
              <span className="text-[34px] font-bold text-[var(--label)]">NPR 999</span>
              <span className="text-[13px] text-[var(--label-tertiary)]"> / Mo</span>
            </div>
          </div>

          <ul className="mt-6 space-y-3.5">
            {FEATURES.map((item) => (
              <li key={item} className="flex items-center gap-3 text-[15px] text-[var(--label-secondary)]">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--success-bg)] text-[var(--success)]">
                  <Check size={13} strokeWidth={2.2} />
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>

          <div className="mt-8">
            <Button variant="primary" size="lg" className="w-full" onClick={onSignIn}>
              Get started with your books
            </Button>
          </div>
        </div>

        {/* FAQ Section */}
        <div className="mt-20 border-t border-[var(--separator)] pt-14">
          <h2 className="text-[22px] font-semibold text-[var(--label)] text-center">Frequently asked questions</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {FAQS.map(({ q, a }) => (
              <div key={q} className="bg-[var(--bg)] border border-[var(--separator)] rounded-[12px] p-5">
                <div className="flex items-center gap-2 text-[15px] font-semibold text-[var(--label)]">
                  <HelpCircle size={16} strokeWidth={1.8} className="text-[var(--accent)] shrink-0" />
                  <h3>{q}</h3>
                </div>
                <p className="mt-2 text-[13px] leading-[18px] text-[var(--label-secondary)]">{a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </PublicLayout>
  );
};
