import React from 'react';
import {
  ArrowRight,
  Calendar,
  Check,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  Printer,
  Scale,
  Wallet,
  XCircle,
} from 'lucide-react';
import { PublicLayout } from './PublicLayout';
import { Button } from './ui';
import { bsToAd, formatAd } from '../lib/nepaliDate';

const COMPARISON = [
  {
    feature: 'Nepali calendar (Bikram Sambat)',
    zeyks: 'BS dates with AD support and a Shrawan 1 fiscal year',
    excel: 'Check date conversion and fiscal year support for your workflow',
    foreign: 'Check date conversion and fiscal year support for your workflow',
  },
  {
    feature: 'Double-entry bookkeeping',
    zeyks: 'Transactions create balanced debit and credit journal entries',
    excel: 'Compare your current posting and reconciliation process',
    foreign: 'Confirm the ledger and reporting workflows match your needs',
  },
  {
    feature: 'A4 financial reports',
    zeyks: 'Print-ready Profit & Loss, Balance Sheet, Trial Balance, and VAT reports',
    excel: 'Preview report layout and totals before you file',
    foreign: 'Preview report layout and totals before you file',
  },
  {
    feature: 'Data storage and backups',
    zeyks: 'Managed cloud database with account based access controls',
    excel: 'Downloadable JSON backup; restore is not yet available',
    foreign: 'Review the privacy page for providers and current limits',
  },
];

export const LandingPage: React.FC<{
  currentPath?: string;
  navigate?: (to: string) => void;
  onSignIn: () => void;
}> = ({ currentPath = '/', navigate = () => {}, onSignIn }) => {
  return (
    <PublicLayout currentPath={currentPath} navigate={navigate} onSignIn={onSignIn}>
      <div className="min-h-screen">
        {/* ── Hero Section with Apple Ambient Glow ── */}
      <section className="relative overflow-hidden apple-ambient-glow pt-10 pb-8 sm:pt-16 sm:pb-12">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          {/* Hero Headline & Subtitle */}
          <div className="text-center">
            <h1 className="mx-auto max-w-4xl text-[36px] font-extrabold leading-[44px] tracking-[-0.03em] sm:text-[58px] sm:leading-[66px] text-[var(--label)] font-display">
              Accounting software for Nepal, built around the Bikram Sambat calendar.
            </h1>

            <p className="mx-auto mt-4 max-w-2xl text-[16px] leading-[24px] text-[var(--label-secondary)] sm:text-[19px] sm:leading-[28px]">
              Record sales, purchases, expenses and settlements in NPR. See BS and AD dates together, then print clear A4 financial statements.
            </p>

            {/* CTAs */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3.5">
              <Button
                variant="primary"
                size="lg"
                onClick={onSignIn}
                className="h-11 px-7 text-[15px] font-semibold rounded-full shadow-lg active:scale-[0.97] transition-all group"
              >
                <span>Get started</span>
                <ArrowRight size={17} strokeWidth={2.2} className="ml-1.5 transition-transform group-hover:translate-x-1" />
              </Button>

              <a
                href="/demo"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-11 min-h-[44px] items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--bg)] px-6 text-[15px] font-medium text-[var(--label)] shadow-sm hover:bg-[var(--fill-secondary)] transition-all active:scale-[0.97] gap-1.5"
              >
                <span>Explore the free interactive demo</span>
                <ArrowRight size={16} className="opacity-70" />
              </a>
            </div>

            {/* Trust Strip */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-6 text-[13px] text-[var(--label-tertiary)]">
              <div className="flex items-center gap-2">
                <Calendar size={16} className="text-[var(--accent)]" />
                <span>BS and AD dates</span>
              </div>
              <div className="flex items-center gap-2">
                <Scale size={16} className="text-[var(--success)]" />
                <span>Double-entry bookkeeping</span>
              </div>
              <div className="flex items-center gap-2">
                <Printer size={16} className="text-[var(--warning)]" />
                <span>Printable A4 reports</span>
              </div>
            </div>
          </div>
        </div>
      </section>


      {/* ── Apple-Style Bento Grid (Core Architectural Pillars) ── */}
      <section id="capabilities" className="py-12 sm:py-16">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <div className="max-w-2xl">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--label-tertiary)]">
              From entries to reports
            </p>
            <h2 className="mt-3 text-[36px] font-extrabold leading-[44px] tracking-[-0.02em] text-[var(--label)]">
              See how each balance is built.
            </h2>
            <p className="mt-4 text-[17px] leading-[26px] text-[var(--label-secondary)]">
              Posted journal entries feed the reports. The data health screen flags missing links and mismatches for review.
            </p>
          </div>

          <div className="mt-14 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
            {/* Bento Card 1: Double Entry by Construction */}
            <div className="apple-card p-8 sm:col-span-2">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--fill-secondary)] text-[var(--accent)] shadow-xs">
                <Scale size={24} strokeWidth={1.8} />
              </div>
              <h3 className="mt-6 text-[22px] font-bold text-[var(--label)]">
                Double entry, by construction
              </h3>
              <p className="mt-2.5 max-w-xl text-[15px] leading-[24px] text-[var(--label-secondary)]">
                Sales, purchases, expenses and settlements create debit and credit lines.
                Review the journal and data health screen before relying on a report.
              </p>
              <div className="mt-6 rounded-2xl border border-[var(--separator)] bg-[var(--bg-secondary)]/60 p-4 font-mono text-[13px] shadow-2xs">
                <div className="flex justify-between text-[var(--label-secondary)]">
                  <span>Dr. Sundry Debtors</span>
                  <span className="font-semibold text-[var(--label)]">NPR 45,200.00</span>
                </div>
                <div className="flex justify-between text-[var(--label-secondary)] mt-1.5">
                  <span>Cr. Sales Revenue (Standard)</span>
                  <span className="font-semibold text-[var(--label)]">NPR 40,000.00</span>
                </div>
                <div className="flex justify-between text-[var(--label-secondary)] mt-1.5">
                  <span>Cr. Output VAT (13%)</span>
                  <span className="font-semibold text-[var(--label)]">NPR 5,200.00</span>
                </div>
              </div>
            </div>

            {/* Bento Card 2: Bikram Sambat & Shrawan 1 */}
            <div className="apple-card p-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--fill-secondary)] text-[var(--accent)] shadow-xs">
                <Calendar size={24} strokeWidth={1.8} />
              </div>
              <h3 className="mt-6 text-[22px] font-bold text-[var(--label)]">
                Bikram Sambat & NPR
              </h3>
              <p className="mt-2.5 text-[15px] leading-[24px] text-[var(--label-secondary)]">
                Dates recorded in BS with Gregorian AD beside them. Fiscal year automatically opens on Shrawan 1 and closes on Ashadh 31.
              </p>
              <div className="mt-6 flex items-center justify-between rounded-xl border border-[var(--separator)] bg-[var(--bg-secondary)]/60 px-4 py-3 shadow-2xs">
                <span className="text-[14px] font-semibold text-[var(--label)]">२०८३ श्रावण १</span>
                <span className="text-[12px] text-[var(--label-tertiary)]">⇄ {formatAd(bsToAd(2083, 4, 1), 'long')}</span>
              </div>
            </div>

            {/* Bento Card 3: Settlements that Stay Honest */}
            <div className="apple-card p-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--fill-secondary)] text-[var(--accent)] shadow-xs">
                <Wallet size={24} strokeWidth={1.8} />
              </div>
              <h3 className="mt-6 text-[22px] font-bold text-[var(--label)]">
                Track settlements
              </h3>
              <p className="mt-2.5 text-[15px] leading-[24px] text-[var(--label-secondary)]">
                Part payments, voids, and reversals. What is owed is always the document total less valid settlement rows.
              </p>
            </div>

            {/* Bento Card 4: Statements Made for Paper */}
            <div className="apple-card p-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--fill-secondary)] text-[var(--accent)] shadow-xs">
                <FileSpreadsheet size={24} strokeWidth={1.8} />
              </div>
              <h3 className="mt-6 text-[22px] font-bold text-[var(--label)]">
                Statements you can review and print
              </h3>
              <p className="mt-2.5 text-[15px] leading-[24px] text-[var(--label-secondary)]">
                Profit & Loss, Balance Sheet, VAT returns, Trial Balance, Cash & Bank statements laid out as 210mm A4 sheets.
              </p>
            </div>

            {/* Storage */}
            <div className="apple-card p-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--fill-secondary)] text-[var(--accent)] shadow-xs">
                <Database size={24} strokeWidth={1.8} />
              </div>
              <h3 className="mt-6 text-[22px] font-bold text-[var(--label)]">
                Managed cloud storage
              </h3>
              <p className="mt-2.5 text-[15px] leading-[24px] text-[var(--label-secondary)]">
                Business records are stored in a managed Supabase database. Firebase handles sign-in. Read the privacy page for service and backup details.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Comparison Table (Why Zeyks Book) ── */}
      <section className="border-t border-[var(--separator)] bg-[var(--bg)] py-20 sm:py-28">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <div className="text-center max-w-2xl mx-auto">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--label-tertiary)]">
              Product facts
            </p>
              <h2 className="mt-3 text-[34px] font-bold leading-[41px] tracking-[-0.02em] text-[var(--label)]">
              Accounting tools shaped for Nepali businesses
            </h2>
          </div>

          <div className="mt-12 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" aria-label="Scrollable accounting feature overview">
            <table className="w-full min-w-[680px] text-left text-[14px]">
              <thead>
                <tr className="border-b border-[var(--separator)] text-[13px] font-semibold text-[var(--label)]">
                  <th className="py-4 pr-6 w-1/4">Business need</th>
                  <th className="py-4 px-4 w-1/4 bg-[var(--accent)]/10 rounded-t-xl text-[var(--accent)] font-bold">
                    What Zeyks Book provides
                  </th>
                  <th className="py-4 px-4 w-1/4 text-[var(--label-tertiary)]">Details to review</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--separator)]">
                {COMPARISON.map((row) => (
                  <tr key={row.feature} className="hover:bg-[var(--fill-secondary)]/30 transition-colors">
                    <td className="py-4 pr-6 font-semibold text-[var(--label)]">
                      {row.feature}
                    </td>
                    <td className="py-4 px-4 bg-[var(--accent)]/5 text-[var(--label)] font-medium">
                      <div className="flex items-start gap-2">
                        <Check size={16} className="text-[var(--success)] mt-0.5 shrink-0" />
                        <span>{row.zeyks}</span>
                      </div>
                    </td>
                    <td className="py-4 px-4 text-[var(--label-secondary)]">
                      <span>{row.excel}. {row.foreign}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Suited to & Radical Transparency ── */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <div className="grid gap-8 sm:grid-cols-2">
            <div className="rounded-2xl border border-[var(--separator)] bg-[var(--bg)] p-8 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--success-bg)] text-[var(--success)]">
                  <CheckCircle2 size={20} strokeWidth={2.2} />
                </span>
                <h3 className="text-[18px] font-bold text-[var(--label)]">Suited for</h3>
              </div>
              <ul className="mt-5 space-y-3.5 text-[15px] leading-[24px] text-[var(--label-secondary)]">
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 text-[var(--accent)] font-bold">•</span>
                  <span>Shops, suppliers, consultancies and services operating in Nepal.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 text-[var(--accent)] font-bold">•</span>
                  <span>Businesses that need receivables and payables linked to ledger entries.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 text-[var(--accent)] font-bold">•</span>
                  <span>Teams that need BS and AD dates and printable A4 statements.</span>
                </li>
              </ul>
            </div>

            <div className="rounded-2xl border border-[var(--separator)] bg-[var(--bg)] p-8 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--warning-bg)] text-[var(--warning)]">
                  <XCircle size={20} strokeWidth={2.2} />
                </span>
                <h3 className="text-[18px] font-bold text-[var(--label)]">What it does not do</h3>
              </div>
              <ul className="mt-5 space-y-3.5 text-[15px] leading-[24px] text-[var(--label-secondary)]">
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 text-[var(--warning)] font-bold">•</span>
                  <span>Payroll calculations and automated inventory valuation are not included.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 text-[var(--warning)] font-bold">•</span>
                  <span>Backups can be downloaded, but restoring a backup is not available yet.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 text-[var(--warning)] font-bold">•</span>
                  <span>Online payment collection needs a separate server setup.</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Final Grand Call-to-Action (Keynote Card) ── */}
      <section className="border-t border-[var(--separator)] bg-[var(--bg)] py-18 sm:py-28">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <div className="relative overflow-hidden rounded-[28px] border border-[var(--separator)] bg-[var(--bg-secondary)] px-6 py-14 text-center shadow-xl sm:px-14 sm:py-20">
            <h2 className="text-[30px] font-extrabold leading-[36px] tracking-[-0.02em] text-[var(--label)] sm:text-[42px] sm:leading-[50px]">
              Try the workflow with sample books.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[17px] leading-[26px] text-[var(--label-secondary)]">
              Explore sample books in the interactive demo, review the pricing and data policies, and contact us with questions before you move real records.
            </p>
            <div className="mt-9 flex justify-center">
              <Button
                variant="primary"
                size="lg"
                onClick={onSignIn}
                className="h-13 px-9 text-[17px] font-semibold rounded-full shadow-xl"
              >
                Start using Zeyks Book
              </Button>
            </div>
          </div>
        </div>
      </section>
      </div>
    </PublicLayout>
  );
};
