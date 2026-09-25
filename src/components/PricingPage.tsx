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
    'Managed cloud database with business level access controls',
    'One simple plan — no per-user fees',
    'Downloadable JSON backup from Settings',
  ];

  const FAQS = [
    {
      q: 'How does pricing work?',
      a: 'One simple plan at NPR 999 per month. No per-seat charges, no hidden tiers — every feature, including the full double-entry engine and A4 reports, is included.'
    },
    {
      q: 'Where are my financial records stored?',
      a: 'Business records are stored in a managed Supabase database; Firebase handles sign-in. You can download a JSON snapshot from Settings. Restoring a backup is not available yet.',
    },
    {
      q: 'Can I export statements for my bank or auditor?',
      a: 'Yes. Profit & Loss, Balance Sheet, Trial Balance, General Ledger, VAT return, and Cash/Bank statements are designed as standard A4 sheets ready to print or export as PDF.',
    },
    {
      q: 'Is there a free trial or refund policy?',
      a: 'Trial terms and a refund policy are not currently published. Please contact us to confirm the current subscription terms before paying.',
    },
    {
      q: 'Is Zeyks Book approved by Nepal’s IRD?',
      a: 'The site does not publish an IRD approval or verification status. VAT reports and A4 statements are product features, not proof of government approval. Confirm your compliance requirements with the IRD or your accountant.',
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
              <h2 className="text-[22px] font-bold text-[var(--label)]">Zeyks Book</h2>
              <p className="mt-1 text-[13px] text-[var(--label-secondary)]">Every feature included</p>
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
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
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
