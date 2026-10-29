import React from 'react';
import { Check, HelpCircle, Sparkles } from 'lucide-react';
import { PublicLayout } from './PublicLayout';
import { Button } from './ui';
import { PLAN_FEATURES, ROLE_LABEL, type AppRole } from '../lib/roles';

/**
 * Two-tier pricing page.
 *
 *   Starter  — NPR 399 / month. Dashboard, sales, purchases, expenses and
 *              settings. Designed for kirana counters that just need daily
 *              books and a stock view.
 *   Premium  — NPR 599 / month. Every feature: inventory, aged receivables &
 *              payables, reports, data health and settlements.
 *
 * Both tiers route through the same payment flow once the eSewa / Khalti
 * integration is wired up. Until then, picking a plan routes a signed-in user
 * to the admin-controlled flow (a no-op until the RPC is connected); signed-
 * out users are asked to sign in first.
 *
 * The bullet lists come from PLAN_FEATURES so this page and the dashboard's
 * upgrade card cannot drift apart.
 */

const FAQS = [
  {
    q: 'How does pricing work?',
    a: 'Two plans, billed monthly. Starter (NPR 399) is sized for kirana counters — daily books, sales, purchases and expenses. Premium (NPR 599) unlocks inventory, aged receivables & payables, print-ready reports, data health and settlements. There are no per-seat charges.',
  },
  {
    q: 'Can I upgrade from Starter to Premium later?',
    a: 'Yes. Switching plans takes effect on the next page load — the role is read from your profile each time.',
  },
  {
    q: 'Where are my financial records stored?',
    a: 'Records live in a managed Neon Postgres database; sign-in is through Google and Neon Auth, and each account only ever sees the books it owns. You can download a JSON snapshot from Settings.',
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

export const PricingPage: React.FC<{
  currentPath: string;
  navigate: (to: string) => void;
  onSignIn: () => void;
  /** Optional: when present, the buttons route through a real plan-pick flow. */
  onPickPlan?: (plan: AppRole) => void;
  signedIn?: boolean;
}> = ({ currentPath, navigate, onSignIn, onPickPlan, signedIn = false }) => {
  const handlePick = (plan: AppRole) => {
    if (!onPickPlan) return;
    // Only plus/premium unlock books; the picker still receives 'user' and
    // 'admin' for type-completeness, but those are no-ops in the UI.
    if (plan === 'plus' || plan === 'premium') onPickPlan(plan);
  };
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
            Pick the plan that fits the size of your shop. No per-seat charges,
            no hidden tiers.
          </p>
        </div>

        {/* Pricing Cards */}
        <div className="mt-12 grid gap-6 sm:grid-cols-2 max-w-3xl mx-auto">
          <PlanCard
            name={ROLE_LABEL.plus}
            priceNPR={399}
            highlight={false}
            features={PLAN_FEATURES.plus}
            ctaLabel={signedIn ? 'Choose Starter' : 'Sign in to start'}
            onCta={() => {
              if (signedIn && onPickPlan) handlePick('plus');
              else onSignIn();
            }}
          />
          <PlanCard
            name={ROLE_LABEL.premium}
            priceNPR={599}
            highlight
            badge={<Sparkles size={12} strokeWidth={1.8} className="inline-block" />}
            features={PLAN_FEATURES.premium}
            ctaLabel={signedIn ? 'Choose Premium' : 'Sign in to start'}
            onCta={() => {
              if (signedIn && onPickPlan) handlePick('premium');
              else onSignIn();
            }}
          />
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

const PlanCard: React.FC<{
  name: string;
  priceNPR: number;
  highlight: boolean;
  badge?: React.ReactNode;
  features: ReadonlyArray<string>;
  ctaLabel: string;
  onCta: () => void;
}> = ({ name, priceNPR, highlight, badge, features, ctaLabel, onCta }) => {
  return (
    <div
      className={`relative rounded-[14px] p-7 shadow-sm border ${
        highlight
          ? 'border-[var(--accent)] bg-[var(--bg)] ring-2 ring-[var(--accent)]/30'
          : 'border-[var(--separator)] bg-[var(--bg)]'
      }`}
    >
      {highlight && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-[var(--accent)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-white">
          {badge}
          <span>Most chosen</span>
        </span>
      )}
      <div className="flex items-baseline justify-between border-b border-[var(--separator)] pb-5">
        <div>
          <h2 className="text-[20px] font-bold text-[var(--label)]">{name}</h2>
          <p className="mt-1 text-[13px] text-[var(--label-secondary)]">
            {highlight ? 'Every feature included' : 'For kirana counters'}
          </p>
        </div>
        <div className="text-right">
          <span className="text-[28px] font-bold text-[var(--label)]">NPR {priceNPR}</span>
          <span className="text-[13px] text-[var(--label-tertiary)]"> / Mo</span>
        </div>
      </div>
      <ul className="mt-5 space-y-3">
        {features.map((item) => (
          <li key={item} className="flex items-start gap-2.5 text-[14px] text-[var(--label-secondary)]">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--success-bg)] text-[var(--success)]">
              <Check size={11} strokeWidth={2.2} />
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
      <div className="mt-7">
        <Button
          variant={highlight ? 'primary' : 'secondary'}
          size="lg"
          className="w-full"
          onClick={onCta}
        >
          {ctaLabel}
        </Button>
      </div>
    </div>
  );
};
