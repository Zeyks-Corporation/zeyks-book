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
      body: 'Your books are stored in a managed cloud database. You can download a JSON backup from Settings; restore is not available yet.',
    },
    {
      icon: Award,
      title: 'Built for Nepal',
      body: 'Designed around the Bikram Sambat calendar, a fiscal year starting Shrawan 1, NPR formatting, and reports that support accounting workflows. IRD approval is not claimed.',
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
            Zeyks Book is a web-based double-entry bookkeeping app for businesses in Nepal. It supports Bikram Sambat and Gregorian dates, NPR amounts, and printable A4 reports. The interactive demo lets you explore sample books before signing up.
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
            Zeyks Book stores business records in a managed Supabase database and uses Firebase for sign-in. Posted journal entries and settlements follow the app's accounting rules. Downloadable JSON backups are available in Settings; restore and a published recovery guarantee are not available. A4 reports are provided as working documents, and should be reviewed with an accountant before statutory use.
          </p>
          <div className="mt-6">
            <Button variant="primary" size="md" onClick={onSignIn}>
              Start using Zeyks Book
            </Button>
          </div>
        </div>

        <div className="mt-6 grid gap-5 rounded-[14px] border border-[var(--separator)] bg-[var(--bg-secondary)] p-6 sm:grid-cols-2 sm:p-8">
          <div>
            <h2 className="text-[18px] font-bold text-[var(--label)]">Company and service details</h2>
            <p className="mt-2 text-[14px] leading-[22px] text-[var(--label-secondary)]">
              The site lists Kathmandu, Nepal and contact details. It does not currently publish a registered company identity, uptime guarantee, or recovery-time commitment.
            </p>
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-[var(--label)]">Before subscribing</h3>
            <p className="mt-2 text-[14px] leading-[22px] text-[var(--label-secondary)]">
              Try the sample demo, confirm the trial and refund terms with us, and check whether a downloadable JSON backup meets your recovery needs. Restore is not available yet.
            </p>
            <a href="/contact" className="mt-3 inline-flex min-h-[44px] items-center text-[14px] font-semibold text-[var(--accent)] underline underline-offset-4">
              Ask about your requirements
            </a>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
};
