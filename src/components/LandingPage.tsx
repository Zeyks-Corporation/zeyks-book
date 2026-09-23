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
  ShieldCheck,
  Wallet,
  X,
  XCircle,
} from 'lucide-react';
import { PublicLayout } from './PublicLayout';
import { Button } from './ui';

const COMPARISON = [
  {
    feature: 'Nepali Calendar (Bikram Sambat)',
    zeyks: 'Native BS with AD dual-date support and Shrawan 1 fiscal year',
    excel: 'Manual conversions, broken formulas on leap months',
    foreign: 'Gregorian (AD) only; requires painful workarounds',
  },
  {
    feature: 'Ledger Reconciliation',
    zeyks: 'Balanced double-entry journals by construction (Dr = Cr)',
    excel: 'Prone to silent formula overwrites and manual drift',
    foreign: 'Rigid enterprise configurations with slow sync',
  },
  {
    feature: 'Statement Output',
    zeyks: 'Official A4 paper-ready reports (P&L, Balance Sheet, VAT)',
    excel: 'Messy print scaling; inconsistent multi-page breaks',
    foreign: 'Cluttered US-Letter exports requiring reformatting',
  },
  {
    feature: 'Data Ownership & Privacy',
    zeyks: 'Self-hosted on your own private cloud database (100% Private)',
    excel: 'Scattered unencrypted .xlsx files vulnerable to loss',
    foreign: 'Locked on proprietary cloud servers with monthly fees',
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
            <h1 className="mx-auto max-w-4xl text-[36px] font-extrabold leading-[44px] tracking-[-0.03em] sm:text-[58px] sm:leading-[66px] text-[var(--label)] font-lovelace">
              Simple, powerful tools to manage your business from one place.{' '}
            </h1>

            <p className="mx-auto mt-4 max-w-2xl text-[16px] leading-[24px] text-[var(--label-secondary)] sm:text-[19px] sm:leading-[28px]">
              Every invoice, settlement, and expense posts an immutable double-entry journal.
              Zero balance drift, native Bikram Sambat dates, and A4 reports formatted for paper and tax filing.
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
                <span>See Demo</span>
                <ArrowRight size={16} className="opacity-70" />
              </a>
            </div>

            {/* Trust Strip */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-6 text-[13px] text-[var(--label-tertiary)]">
              <div className="flex items-center gap-2">
                <ShieldCheck size={16} className="text-[var(--accent)]" />
                <span>100% Private</span>
              </div>
              <div className="flex items-center gap-2">
                <Scale size={16} className="text-[var(--success)]" />
                <span>Mathematical Proof</span>
              </div>
              <div className="flex items-center gap-2">
                <Printer size={16} className="text-[var(--warning)]" />
                <span>Standard A4 Statement</span>
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
              Engineered for Certainty
            </p>
            <h2 className="mt-3 text-[36px] font-extrabold leading-[44px] tracking-[-0.02em] text-[var(--label)]">
              Architecture that refuses to drift.
            </h2>
            <p className="mt-4 text-[17px] leading-[26px] text-[var(--label-secondary)]">
              Accounting software should not guess. Every balance in Zeyks Book derives strictly from posted ledger rows.
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
                Every invoice, bill, expense and settlement writes balanced debit and credit entries.
                The ledger is the single source of truth — never a detached running total that can silently drift.
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
                <span className="text-[12px] text-[var(--label-tertiary)]">⇄ 2026 July 16</span>
              </div>
            </div>

            {/* Bento Card 3: Settlements that Stay Honest */}
            <div className="apple-card p-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--fill-secondary)] text-[var(--accent)] shadow-xs">
                <Wallet size={24} strokeWidth={1.8} />
              </div>
              <h3 className="mt-6 text-[22px] font-bold text-[var(--label)]">
                Honest settlements
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
                Statements you can file
              </h3>
              <p className="mt-2.5 text-[15px] leading-[24px] text-[var(--label-secondary)]">
                Profit & Loss, Balance Sheet, VAT returns, Trial Balance, Cash & Bank statements laid out as 210mm A4 sheets.
              </p>
            </div>

            {/* Bento Card 5: Self-Hosted on Supabase */}
            <div className="apple-card p-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--fill-secondary)] text-[var(--accent)] shadow-xs">
                <Database size={24} strokeWidth={1.8} />
              </div>
              <h3 className="mt-6 text-[22px] font-bold text-[var(--label)]">
                Your data, your database
              </h3>
              <p className="mt-2.5 text-[15px] leading-[24px] text-[var(--label-secondary)]">
                Zero telemetry or third-party tracking. Your accounting records live privately in your own project.
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
              Clear Differentiation
            </p>
            <h2 className="mt-3 text-[34px] font-bold leading-[41px] tracking-[-0.02em] text-[var(--label)]">
              Why Nepali businesses choose Zeyks Book
            </h2>
          </div>

          <div className="mt-12 overflow-x-auto">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="border-b border-[var(--separator)] text-[13px] font-semibold text-[var(--label)]">
                  <th className="py-4 pr-6 w-1/4">Requirement</th>
                  <th className="py-4 px-4 w-1/4 bg-[var(--accent)]/10 rounded-t-xl text-[var(--accent)] font-bold">
                    Zeyks Book
                  </th>
                  <th className="py-4 px-4 w-1/4 text-[var(--label-tertiary)]">Excel / Spreadsheets</th>
                  <th className="py-4 px-4 w-1/4 text-[var(--label-tertiary)]">Imported Western/Indian ERP</th>
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
                      <div className="flex items-start gap-2">
                        <X size={16} className="text-[var(--destructive)] mt-0.5 shrink-0" />
                        <span>{row.excel}</span>
                      </div>
                    </td>
                    <td className="py-4 px-4 text-[var(--label-secondary)]">
                      <div className="flex items-start gap-2">
                        <X size={16} className="text-[var(--warning)] mt-0.5 shrink-0" />
                        <span>{row.foreign}</span>
                      </div>
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
                  <span>Businesses needing receivables and payables to strictly agree with the general ledger.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 text-[var(--accent)] font-bold">•</span>
                  <span>Anyone requiring formatted A4 financial statements to submit to banks, auditors, or IRD.</span>
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
                  <span>No demo data and no sample figures anywhere in the application.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 text-[var(--warning)] font-bold">•</span>
                  <span>No payroll calculations or automated factory inventory valuation.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 text-[var(--warning)] font-bold">•</span>
                  <span>Online wallet collection is strictly optional: stays dormant unless you deploy a server.</span>
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
              Ready for honest accounting in Nepal?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[17px] leading-[26px] text-[var(--label-secondary)]">
              Create an account or connect your database. Your chart of accounts and 2083 fiscal year configure in one click.
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
