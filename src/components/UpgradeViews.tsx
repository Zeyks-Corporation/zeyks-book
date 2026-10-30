import React from 'react';
import { Check, Lock } from 'lucide-react';
import { Button } from './ui';
import {
  PLAN_FEATURES, ROLE_LABEL, ROLE_PRICE_NPR, WHATSAPP_PLAN_URL, planForFeature, planOfRole,
  type AppRole, type Feature,
} from '../lib/roles';

/**
 * The two paid plans side by side. Used by the dashboard's Upgrade section
 * (where the plan the user is on carries a "Current plan" badge) and by the
 * lock screen that replaces every section the role does not include.
 */
export const UpgradePlansSection: React.FC<{
  role: AppRole | undefined;
  onPickPlan?: (plan: 'plus' | 'premium') => void;
}> = ({ role, onPickPlan }) => {
  const current = planOfRole(role);
  const card = (plan: 'plus' | 'premium') => {
    const isCurrent = current === plan;
    const accent = plan === 'premium';
    return (
      <div
        key={plan}
        className={`relative rounded-[14px] border p-5 ${
          isCurrent
            ? 'border-[var(--accent)] bg-[var(--accent)]/5'
            : accent
              ? 'border-[var(--separator)] bg-[var(--bg)]'
              : 'border-[var(--separator)] bg-[var(--bg)]'
        }`}
      >
        {isCurrent && (
          <span className="absolute -top-2.5 right-4 rounded-full bg-[var(--accent)] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-white">
            Current plan
          </span>
        )}
        <p className={`text-[12px] font-semibold uppercase tracking-[0.12em] ${accent ? 'text-[var(--accent)]' : 'text-[var(--label-tertiary)]'}`}>
          {ROLE_LABEL[plan]}
        </p>
        <p className="mt-1 text-[22px] font-bold text-[var(--label)]">
          NPR {ROLE_PRICE_NPR[plan]}
          <span className="text-[13px] font-medium text-[var(--label-secondary)]"> / month</span>
        </p>
        <ul className="mt-3 space-y-1.5">
          {PLAN_FEATURES[plan].map((f) => (
            <li key={f} className="flex items-start gap-2 text-[13px] leading-[19px] text-[var(--label-secondary)]">
              <Check size={14} className="mt-[3px] shrink-0 text-[var(--accent)]" aria-hidden="true" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
        {onPickPlan && !isCurrent && (
          <Button
            variant={accent ? 'primary' : 'secondary'}
            size="md"
            className="mt-4 w-full"
            onClick={() => onPickPlan(plan)}
          >
            Choose {ROLE_LABEL[plan]}
          </Button>
        )}
      </div>
    );
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {card('plus')}
      {card('premium')}
    </div>
  );
};

/**
 * Replaces any section the signed-in role does not unlock. The section stays
 * visible in the sidebar — clicking it lands here, with both plans listed so
 * the upgrade path is one click away.
 *
 * `feature` names the locked section so we can point at the cheapest plan that
 * unlocks it (Plus for sales/purchases/expenses/settings, Premium for the
 * rest). Omit it on the free dashboard shell, where nothing is unlocked yet.
 */
export const PlanLockedView: React.FC<{
  role: AppRole | undefined;
  /** Screen title the user clicked, e.g. 'Reports'. Omitted on the free shell. */
  section?: string;
  /** The locked section's feature — derives which plan unlocks it. */
  feature?: Feature;
  onSignOut?: () => void;
}> = ({ role, section, feature, onSignOut }) => {
  const needed: 'plus' | 'premium' = feature ? planForFeature(feature) : 'plus';
  const planLabel = ROLE_LABEL[needed];
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--fill-secondary)] text-[var(--label-secondary)]">
          <Lock size={20} strokeWidth={1.8} aria-hidden="true" />
        </div>
        <h2 className="mt-4 text-[22px] font-bold tracking-[-0.2px] text-[var(--label)]">
          {section
            ? <>{section} is part of <span className="text-[var(--accent)]">{planLabel}</span></>
            : 'Your books unlock with a plan'}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-[14px] leading-[21px] text-[var(--label-secondary)]">
          {section
            ? `Upgrade to ${planLabel} to open ${section.toLowerCase()} and everything in it. Your existing data stays exactly as it is.`
            : 'You can see every screen of Zeyks Book, but adding, editing or removing records needs a subscription. Pick the plan that fits your shop.'}
        </p>
      </div>
      <div className="mt-8">
        <UpgradePlansSection role={role} />
      </div>
      <div className="mt-6 flex flex-col items-center gap-3">
        <a
          href={WHATSAPP_PLAN_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-full bg-[var(--accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--accent-hover)] min-h-[44px]"
        >
          {`Get ${planLabel} on WhatsApp`}
        </a>
        {onSignOut && (
          <button
            type="button"
            onClick={onSignOut}
            className="text-[13px] text-[var(--label-secondary)] underline-offset-2 hover:text-[var(--label)] hover:underline"
          >
            Sign out
          </button>
        )}
      </div>
    </div>
  );
};
