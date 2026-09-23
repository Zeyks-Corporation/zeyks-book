import React from 'react';
import { Award, BookOpen, ShieldCheck } from 'lucide-react';
import { PublicLayout } from './PublicLayout';
import { Button } from './ui';

export const AboutPage: React.FC<{
  currentPath: string;
  navigate: (to: string) => void;
  onSignIn: () => void;
}> = ({ currentPath, navigate, onSignIn }) => {
  const VALUES = [
    {
      icon: BookOpen,
      title: 'Double-entry integrity',
      body: 'Every single ledger entry must balance. We build accounting software where balances are derived, never hardcoded or patched over.',
    },
    {
      icon: ShieldCheck,
      title: 'Data sovereignty',
      body: 'Your financial books belong to you. We store data directly in your own Supabase project without third-party vendor lock-in.',
    },
    {
      icon: Award,
      title: 'Built for Nepal',
      body: 'Designed specifically around the Bikram Sambat calendar, fiscal year starting Shrawan 1, NPR formatting, and IRD compliance standards.',
    },
  ];

  return (
    <PublicLayout currentPath={currentPath} navigate={navigate} onSignIn={onSignIn}>
      <section className="mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="max-w-3xl">
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--label-tertiary)]">
            Our Mission
          </p>
          <h1 className="mt-3 text-[34px] font-bold leading-[41px] tracking-[-0.4px] text-[var(--label)]">
            Accurate accounting for Nepali enterprises
          </h1>
          <p className="mt-5 text-[17px] leading-[26px] text-[var(--label-secondary)]">
            Zeyks Book was crafted to solve a fundamental problem: Nepali businesses needed double-entry accounting software that respects the Bikram Sambat calendar without forcing fragile workarounds or complex setup fees.
          </p>
        </div>

        {/* Values Grid */}
        <div className="mt-16 border-t border-[var(--separator)] pt-14">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--label-tertiary)]">
            Core Principles
          </h2>
          <div className="mt-8 grid gap-8 sm:grid-cols-3">
            {VALUES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] p-6 shadow-sm">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--fill-secondary)] text-[var(--accent)]">
                  <Icon size={20} strokeWidth={1.8} />
                </div>
                <h3 className="mt-4 text-[17px] font-semibold text-[var(--label)]">{title}</h3>
                <p className="mt-2 text-[15px] leading-[22px] text-[var(--label-secondary)]">{body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Detailed story block */}
        <div className="mt-16 bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] p-8">
          <h2 className="text-[22px] font-bold text-[var(--label)]">Designed with precision</h2>
          <p className="mt-3 text-[15px] leading-[24px] text-[var(--label-secondary)]">
            Unlike generic web apps, Zeyks Book enforces rigid accounting rules at the database and application levels. Journal entries are immutable once posted, settlements are tracked against document totals, and statement reports match standard A4 paper specifications for straightforward filing with banks, IRD, or external auditors.
          </p>
          <div className="mt-6">
            <Button variant="primary" size="md" onClick={onSignIn}>
              Start using Zeyks Book
            </Button>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
};
