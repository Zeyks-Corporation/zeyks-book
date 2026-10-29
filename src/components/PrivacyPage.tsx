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
              Know where your accounting data lives.
            </h1>

            <p className="mx-auto mt-4 max-w-2xl text-[16px] leading-[26px] text-[var(--label-secondary)] sm:text-[18px]">
              Zeyks Book is a managed cloud app. Business records use Neon Postgres; sign-in uses Neon Auth. Here is what that means in practice.
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
                Business records are stored in a managed Neon Postgres database. The app uses PostgreSQL row level security (RLS) to limit access to records based on the signed-in user's business membership. This is cloud storage, not a database hosted in your own account. Sign-in is provided by Neon Auth using Google. Google and Neon Auth process the identity information needed to sign you in. These services are third parties that process information needed to operate the app.
              </p>
            </div>

            <div className="border-t border-[var(--separator)] pt-6">
              <h2 className="text-[20px] font-bold text-[var(--label)] flex items-center gap-2">
                <EyeOff size={18} className="text-[var(--accent)]" />
                2. Zero Third-Party Telemetry & Tracking
              </h2>
              <p className="mt-2">
                The app does not use behavioral ad pixels or session recording tools. Core app functions rely on Neon (database and sign-in), and contact messages are sent through the configured email service. Google Fonts may be contacted to load typefaces. These providers receive the technical information required for their services; review their policies for their handling practices.
              </p>
            </div>

            <div className="border-t border-[var(--separator)] pt-6">
              <h2 className="text-[20px] font-bold text-[var(--label)] flex items-center gap-2">
                <Database size={18} className="text-[var(--accent)]" />
                3. Demo Mode Local Storage
              </h2>
              <p className="mt-2">
                The interactive demo starts with sample books and keeps your demo edits only while the page stays open — refreshing resets it to the sample data. Demo data is separate from a signed-in business account and nothing from the demo is saved to your browser or sent to the server.
              </p>
            </div>

            <div className="border-t border-[var(--separator)] pt-6">
              <h2 className="text-[20px] font-bold text-[var(--label)] flex items-center gap-2">
                <Check size={18} className="text-[var(--success)]" />
                4. IRD Compliance & Export Rights
              </h2>
              <p className="mt-2">
                Settings provides a downloadable JSON snapshot of your books. It is a manual backup; automatic backup frequency, recovery time, and restore are not currently documented, and restore is not available in the app. Reports and exports do not establish IRD approval or replace advice from a qualified accountant.
              </p>
            </div>

            <div className="border-t border-[var(--separator)] pt-6">
              <h2 className="text-[20px] font-bold text-[var(--label)] flex items-center gap-2">
                <Check size={18} className="text-[var(--success)]" />
                5. Company, trial, and service commitments
              </h2>
              <p className="mt-2">
                The team works from Janakpur, with a branch in Biratnagar, but no registered company identity, uptime guarantee, trial terms, or refund policy is published yet. Contact us before subscribing if these details affect your decision.
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
