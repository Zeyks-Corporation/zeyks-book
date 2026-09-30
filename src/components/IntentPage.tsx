import React from 'react';
import { ArrowRight, Check, HelpCircle, MinusCircle } from 'lucide-react';
import { PublicLayout } from './PublicLayout';
import { Button } from './ui';
import type { IntentPage as IntentPageData } from '../lib/intentPages';

/**
 * One intent page: the question a business goes looking for, answered on its own
 * address.
 *
 * The shape is fixed on purpose — hero, what it does, what it does *not* do,
 * questions, and a way to try it — so the four pages read as one product rather
 * than four separately-written articles, and so the "what this does not do"
 * block can never be dropped by accident when a page is added.
 *
 * The copy comes from `lib/intentPages.ts`, which is also where the router and
 * the document metadata read it from.
 */
export const IntentPageView: React.FC<{
  page: IntentPageData;
  currentPath: string;
  navigate: (to: string) => void;
  onSignIn: () => void;
}> = ({ page, currentPath, navigate, onSignIn }) => (
  <PublicLayout currentPath={currentPath} navigate={navigate} onSignIn={onSignIn}>
    <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
      <header>
        <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--label-tertiary)]">
          {page.eyebrow}
        </p>
        <h1 className="mt-3 text-[30px] leading-[38px] font-bold tracking-[-0.4px] text-[var(--label)] sm:text-[36px] sm:leading-[44px]">
          {page.h1}
        </h1>
        <p className="mt-4 text-[17px] leading-[26px] text-[var(--label-secondary)]">{page.lead}</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Button variant="primary" size="md" onClick={() => navigate('/demo')}>
            Try it with sample books <ArrowRight size={15} strokeWidth={1.8} aria-hidden="true" />
          </Button>
          <Button size="md" onClick={() => navigate('/pricing')}>
            See the plans
          </Button>
        </div>
      </header>

      {page.sections.map((section) => (
        <section key={section.heading} className="mt-14">
          <h2 className="text-[22px] leading-[28px] font-bold tracking-[-0.2px] text-[var(--label)]">
            {section.heading}
          </h2>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph} className="mt-3 text-[16px] leading-[26px] text-[var(--label-secondary)]">
              {paragraph}
            </p>
          ))}
          {section.bullets && (
            <ul className="mt-5 space-y-3">
              {section.bullets.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[15px] leading-[24px] text-[var(--label-secondary)]">
                  <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--success-bg)] text-[var(--success)]">
                    <Check size={11} strokeWidth={2.2} aria-hidden="true" />
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {/* The honest edge of the product, on every page, in the same place. */}
      <section className="mt-14 rounded-[14px] border border-[var(--separator)] bg-[var(--bg-secondary)] p-6 sm:p-8">
        <h2 className="text-[19px] leading-[25px] font-bold text-[var(--label)]">{page.notForHeading}</h2>
        <ul className="mt-4 space-y-3">
          {page.notFor.map((item) => (
            <li key={item} className="flex items-start gap-2.5 text-[15px] leading-[24px] text-[var(--label-secondary)]">
              <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--bg)] text-[var(--label-tertiary)]">
                <MinusCircle size={11} strokeWidth={2.2} aria-hidden="true" />
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-14">
        <h2 className="text-[22px] leading-[28px] font-bold tracking-[-0.2px] text-[var(--label)]">
          Questions this page answers
        </h2>
        <dl className="mt-6 space-y-5">
          {page.faqs.map(({ q, a }) => (
            <div key={q} className="rounded-[12px] border border-[var(--separator)] bg-[var(--bg)] p-5">
              <dt className="flex items-start gap-2 text-[15px] font-semibold leading-[22px] text-[var(--label)]">
                <HelpCircle size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
                <h3>{q}</h3>
              </dt>
              <dd className="mt-2 pl-6 text-[15px] leading-[24px] text-[var(--label-secondary)]">{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-14 rounded-[14px] border border-[var(--separator)] bg-[var(--bg)] p-6 sm:p-8">
        <h2 className="text-[19px] font-bold text-[var(--label)]">Talk to someone in Janakpur or Biratnagar</h2>
        <p className="mt-2 text-[15px] leading-[24px] text-[var(--label-secondary)]">
          Ask about the demo, a plan, where your records live, or whether this is the right shape for your
          business before you pay for it.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button variant="primary" size="md" onClick={() => navigate('/contact')}>
            Contact us
          </Button>
          <Button size="md" onClick={onSignIn}>
            Sign in
          </Button>
        </div>
      </section>
    </article>
  </PublicLayout>
);
