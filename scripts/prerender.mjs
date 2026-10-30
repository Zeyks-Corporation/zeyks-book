/**
 * Route-specific static documents for the public pages.
 *
 * The SPA ships one `index.html`, so every public address used to arrive at a
 * crawler as the landing page: same `<title>`, same description, same canonical
 * URL. `dist/pricing.html` and its siblings fix that — each carries the title,
 * description and canonical URL of the page it is, and `vercel.json` (and the
 * Express fallback in `server/index.js`) serve them for their paths.
 *
 * The documents are the app shell with a different `<head>`; the client still
 * boots and takes over exactly as before.
 *
 * This module is build tooling, so it is plain Node ESM: `vite.config.ts`
 * imports it as a plugin, and `tests/run.mjs` imports `PRERENDER_PAGES` and
 * `renderPageHtml` to check that the build-time copy of the metadata agrees with
 * the app's own copy in `src/lib/pageMetadata.ts` and with the tags in
 * `index.html`. A document that disagrees with the page it serves is the bug
 * this whole mechanism exists to prevent, so a drift is a failing test rather
 * than a stale `<title>`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Must equal `SITE_ORIGIN` in `src/lib/pageMetadata.ts` — see the note there. */
export const CANONICAL_ORIGIN = 'https://www.zeyksbook.app';

/**
 * The public pages that need a document of their own.
 *
 * The landing page is `index.html` itself, so it is not listed here. Title and
 * description are duplicated from `PUBLIC_PAGES` in `src/lib/pageMetadata.ts`
 * because Node cannot import the TypeScript app module; the drift test in
 * `tests/run.mjs` compares the two lists verbatim.
 */
export const PRERENDER_PAGES = [
  {
    slug: 'pricing',
    path: '/pricing',
    title: 'Pricing — Plus NPR 299, Premium NPR 499 | Zeyks Book',
    description:
      'Zeyks Book has two monthly plans for businesses in Nepal: Plus at NPR 299 for daily sales, purchases and expenses, and Premium at NPR 499 adding inventory, aged receivables and payables, printable reports and data health. No per-seat charges.',
  },
  {
    slug: 'about',
    path: '/about',
    title: 'About — Zeyks Book',
    description: 'Zeyks Book is web-based double-entry accounting for businesses in Nepal, built around Bikram Sambat and AD dates, NPR amounts, and printable A4 reports.',
  },
  {
    slug: 'contact',
    path: '/contact',
    title: 'Contact — Zeyks Book',
    description: 'Contact the Zeyks Book team in Janakpur and Biratnagar, Nepal about the interactive demo, the Plus and Premium monthly plans, where business records are stored, or moving your books.',
  },
  {
    slug: 'privacy',
    path: '/privacy',
    title: 'Privacy — Zeyks Book',
    description: 'How Zeyks Book stores accounting records in a managed Neon Postgres database, signs you in through Google and Neon Auth, and handles demo data, downloadable JSON backups, and service providers.',
  },
  {
    slug: 'terms',
    path: '/terms',
    title: 'Terms — Zeyks Book',
    description:
      'The terms that govern your use of Zeyks Book, including the accounting guarantees and the limits of the service.',
  },
  {
    slug: 'signin',
    path: '/signin',
    title: 'Sign in — Zeyks Book',
    description: 'Sign in to Zeyks Book with Google.',
  },
  {
    slug: 'demo',
    path: '/demo',
    title: 'Interactive Accounting Software Demo for Nepal — Zeyks Book',
    description:
      'Try Zeyks Book with sample books in your browser: sales, purchases, settlements, printable A4 reports and Bikram Sambat dates. No sign-in, and demo changes never leave the device.',
  },
  /*
   * The intent pages. Title, description, breadcrumb label and FAQ text are the
   * same strings as `INTENT_PAGES` in `src/lib/intentPages.ts`; the drift test
   * compares every one of them, because a document that disagrees with the page
   * it serves is the failure this whole mechanism exists to catch.
   */
  {
    slug: 'hallbook-software',
    path: '/hallbook-software',
    title: 'Hallbook Software for Kirana Pasals in Nepal — Zeyks Book',
    description:
      'A digital hallbook for Nepali shops: daily sales, customer udhar with due dates, supplier bills and expenses in NPR, with Bikram Sambat dates and printable A4 statements. From NPR 299 per month.',
  },
  {
    slug: 'agency-accounting',
    path: '/agency-accounting',
    title: 'Accounting Software for Agencies and Freelancers in Nepal — Zeyks Book',
    description:
      'Service businesses bill clients in NPR with PAN and due dates, record expenses under their own heads, and see profit, unpaid invoices and VAT on printable A4 reports. For agencies, studios and freelancers in Nepal.',
  },
  {
    slug: 'bikram-sambat-accounting',
    path: '/bikram-sambat-accounting',
    title: 'Accounting Software with Bikram Sambat Dates — Zeyks Book',
    description:
      'Enter dates in the Bikram Sambat calendar and keep the Gregorian date beside them. Zeyks Book converts both ways, caps each BS month to its real length, and prints reports in BS or AD for businesses in Nepal.',
  },
  {
    slug: 'vat-reporting-nepal',
    path: '/vat-reporting-nepal',
    title: 'VAT Reporting Software for Businesses in Nepal — Zeyks Book',
    description:
      'Record VAT on sales, purchases and expenses, then run a VAT summary for any date range: taxable sales and purchases, output VAT, input VAT, and the net payable or credit carried forward, on printable A4.',
  },
];

/** Small, route-specific copy visible before JavaScript runs. */
const SEO_CONTENT = {
  '/pricing': '<main class="seo-fallback"><p>Pricing for Nepal</p><h1>Simple pricing for Nepali business accounting</h1><p>Zeyks Book has two monthly plans: Plus at NPR 299 and Premium at NPR 499. Plus covers daily books, sales, purchases and expenses. Premium adds inventory, aged receivables and payables, print-ready reports, data health and settlements. There are no per-seat charges.</p><h2>Know what is included</h2><p>Business records are held in a managed Neon Postgres database, and Google sign-in uses Neon Auth. Download a JSON snapshot from Settings; restore is not available yet. Trial terms, refund policy, and IRD approval status are not currently published.</p><p><a href="/demo">Explore sample books in the interactive demo</a> or <a href="/contact">contact Zeyks Book</a> before subscribing.</p></main>',
  '/about': '<main class="seo-fallback"><p>About Zeyks Book</p><h1>Double-entry bookkeeping for businesses in Nepal</h1><p>Zeyks Book is a web-based accounting app for Nepali businesses. It supports Bikram Sambat and Gregorian dates, NPR amounts, sales, purchases, expenses, settlements, and printable A4 reports.</p><h2>Designed around local bookkeeping needs</h2><p>Explore sample books in the interactive demo. The team builds and supports Zeyks Book from Janakpur, with a branch in Biratnagar; registered company details and uptime commitments are not published.</p><p><a href="/demo">Try the demo</a> · <a href="/pricing">See pricing</a> · <a href="/contact">Contact</a></p></main>',
  '/contact': '<main class="seo-fallback"><p>Contact Zeyks Book</p><h1>Accounting software support from Janakpur and Biratnagar</h1><p>Contact the Zeyks Book team about the interactive demo, the Plus and Premium monthly plans, data storage, or moving your books.</p><p>Head office: Janakpur, Nepal. Branch: Biratnagar, Nepal. Email: contact@zeyksbook.app. Phone and WhatsApp: +977 9701066114.</p><p><a href="/demo">Try the interactive demo</a> · <a href="/pricing">Read pricing and terms</a></p></main>',
  '/privacy': '<main class="seo-fallback"><p>Privacy and data storage</p><h1>Where Zeyks Book stores accounting data</h1><p>Zeyks Book uses a managed Neon Postgres database for business records and Google sign-in through Neon Auth. This is managed cloud storage, not a database in the customer’s own cloud account. The interactive demo uses sample books stored in the browser.</p><h2>Backups and recovery</h2><p>Users can download a JSON backup from Settings. Restoring a backup is not available yet, and automatic backup and recovery commitments are not published.</p><p><a href="/pricing">See pricing</a> · <a href="/contact">Ask a question</a></p></main>',
  '/terms': '<main class="seo-fallback"><p>Terms of use</p><h1>Using Zeyks Book for business accounts</h1><p>Zeyks Book provides web-based bookkeeping, Bikram Sambat and AD dates, NPR records, and printable reports. Review your accounting outputs with a qualified professional before statutory filing. The public site does not claim IRD certification or approval.</p><p><a href="/pricing">Pricing and subscription questions</a> · <a href="/privacy">Data and backup details</a> · <a href="/contact">Contact</a></p></main>',
  '/signin': '<main class="seo-fallback"><p>Zeyks Book sign in</p><h1>Sign in to your business books</h1><p>Sign in to Zeyks Book with Google. New accounts need Plus or Premium access before creating books.</p><p>Want to explore first? <a href="/demo">Open the interactive demo with sample books</a>.</p></main>',
  '/demo': '<main class="seo-fallback"><p>Interactive product demo</p><h1>Explore Nepali accounting software with sample books</h1><p>Walk through Zeyks Book’s double-entry ledger, invoices, purchases, settlements, reports, and Bikram Sambat dates using sample books. Demo changes stay in this browser.</p><p><a href="/pricing">See the Plus and Premium plans</a> · <a href="/privacy">Read about data storage</a></p></main>',
  '/hallbook-software': '<main class="seo-fallback"><p>Hallbook software for shops</p><h1>Hallbook software for kirana pasals</h1><p>A digital hallbook keeps the four pages a shop already writes: sales, customer udhar with due dates, supplier bills and shop expenses — in NPR, on Bikram Sambat dates, with party balances that add themselves and A4 statements to print. Plus is NPR 299 per month; Premium at NPR 499 adds settlements, reports, inventory and data health.</p><p>It is not a till: there is no barcode checkout, no payment collection and no payroll. <a href="/demo">Try it with sample books</a> or <a href="/pricing">see the plans</a>.</p></main>',
  '/agency-accounting': '<main class="seo-fallback"><p>Accounting for agencies and freelancers</p><h1>Accounting for agencies, studios and freelancers</h1><p>Invoice clients in NPR with PAN, discount and VAT, record expenses under your own heads, settle payments against open invoices, and print profit and loss, trial balance and aged receivables on A4.</p><p>There is no project or job costing, no time tracking, no payroll and no recurring invoices — the books are one ledger for the whole business. <a href="/demo">Try the demo</a> · <a href="/pricing">See pricing</a></p></main>',
  '/bikram-sambat-accounting': '<main class="seo-fallback"><p>Bikram Sambat dates</p><h1>Accounting software that reads Bikram Sambat</h1><p>Dates are entered in the BS calendar with year, month and day, each month capped to its real published length, and the Gregorian date is kept beside it as the stored, sortable key. Reports print in either calendar and today is computed for Asia/Kathmandu.</p><p>The published day-count table covers BS 2000 to BS 2090; a date outside it is shown as stored rather than guessed. <a href="/demo">Try it</a> · <a href="/contact">Ask a question</a></p></main>',
  '/vat-reporting-nepal': '<main class="seo-fallback"><p>VAT reporting</p><h1>VAT reporting for Nepali businesses</h1><p>Tax posts only when the business is marked VAT-registered, at a rate that defaults to 13% and is editable. Output VAT collects in a VAT payable account, input VAT in a VAT receivable account, and the VAT summary reads those postings for any date range: taxable sales, taxable purchases, output VAT, input VAT, and the net payable or credit carried forward, on A4.</p><p>Zeyks Book is not IRD-approved, files nothing, and has no e-billing integration. <a href="/pricing">Plans</a> · <a href="/contact">Contact</a></p></main>',
};

/**
 * The questions the pricing page answers, verbatim as `FAQS` in
 * `src/components/PricingPage.tsx`.
 *
 * FAQ markup that does not match the visible page is a spam signal, so this list
 * is the same copy, and `tests/run.mjs` compares it against the component's own
 * array to keep the two from drifting apart.
 */
export const PRICING_FAQS = [
  {
    q: 'How does pricing work?',
    a: 'Two plans, billed monthly. Plus (NPR 299) is sized for kirana counters — daily books, sales, purchases and expenses. Premium (NPR 499) unlocks inventory, aged receivables & payables, print-ready reports, data health and settlements. There are no per-seat charges.',
  },
  {
    q: 'Can I upgrade from Plus to Premium later?',
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

/**
 * The questions each intent page answers, verbatim from `INTENT_PAGES` in
 * `src/lib/intentPages.ts`.
 *
 * Same rule as `PRICING_FAQS`: FAQ markup that does not match the visible page
 * is a spam signal, so the static document carries the same answers the page
 * renders, and the drift test compares them string for string.
 */
export const GUIDE_FAQS = {
  '/hallbook-software': [
    {
      q: 'Is a hallbook the same thing as an accounting ledger?',
      a: 'It is the hand-written version of the same record: daily sales, credit given to customers, purchases from suppliers, shop expenses. Zeyks Book keeps those as posted entries, so the totals, the party balances and the reports all come out of the numbers you wrote down rather than a second set of figures.',
    },
    {
      q: 'Can I track customer udhar (credit) in Zeyks Book?',
      a: 'Yes. Enter the sale as a credit sale with a due date and it stays open. Record a payment against that customer when money comes in, and the balance shows what remains owed. The aged receivables report groups what is still outstanding into time bands on the Premium plan.',
    },
    {
      q: 'Do I need an accountant to start?',
      a: 'No. The interactive demo walks through sample books, and a new account opens with a chart of accounts already seeded for a Nepali trading business. Most shops only need their own expense heads, their regular customers and their suppliers before the first entry.',
    },
    {
      q: 'What happens to my old paper hallbook?',
      a: 'You keep it. Most shops start Zeyks Book from the current date rather than re-typing years of pages. Past balances can be entered — an opening stock figure, what each customer owed on the day you switched — but there is no migration service and no way to read the old book in.',
    },
    {
      q: 'Does it work on a phone, and without internet?',
      a: 'It runs in the browser on a phone or a computer, and the layout adapts to a small screen. Saving needs a connection. Without one, the app shows the last books it had saved on that device, read-only, until you are back online.',
    },
  ],
  '/agency-accounting': [
    {
      q: 'Is this sized for a two-person agency?',
      a: 'Yes. Small is the target: one account, one set of books, and pricing per business rather than per seat. Nothing scales down to a price that only makes sense for a large firm.',
    },
    {
      q: 'Can I show VAT on a service invoice?',
      a: 'When the business is marked VAT-registered in Settings, tax lines post automatically. The rate defaults to 13% and is editable, and a line can be entered as VAT-inclusive or VAT-exclusive. The VAT summary reads what was posted, not what the invoice says.',
    },
    {
      q: 'Do you handle retainers and monthly billing?',
      a: 'You issue each month’s invoice yourself. There is no recurring-invoice scheduler, so a retainer stays a habit rather than an automation.',
    },
    {
      q: 'Can I see profit per client or per project?',
      a: 'Not today. There is no project or job dimension on a journal line, so profit is reported for the business as a whole. You can filter the sales register by party to see what one client was billed and what they still owe, but that is not the same figure as project margin.',
    },
    {
      q: 'What does an agency pay?',
      a: 'NPR 499 per month on Premium if you want the reports, settlements and data health. NPR 299 on Plus covers invoicing, expenses and settings. There is no per-seat charge and no setup fee published; confirm current terms before paying.',
    },
  ],
  '/bikram-sambat-accounting': [
    {
      q: 'Which calendar does Zeyks Book store?',
      a: 'The Gregorian date is the stored, sortable key, and the Bikram Sambat date is what you enter and what most screens show. Both come from the same day, so a record has one date with two readings rather than two fields that can disagree.',
    },
    {
      q: 'Can I run a report for a Nepali calendar period?',
      a: 'Yes. Reports take a start and an end date, and the period can be chosen in BS. The printed report labels the range in the calendar you are reading and shows the other calendar beside it.',
    },
    {
      q: 'Do BS months have fixed lengths?',
      a: 'No. A BS month can be 29, 30, 31 or 32 days, and which one it is depends on the year. Zeyks Book reads the lengths from a published table, which is why the day list changes when you change the month.',
    },
    {
      q: 'What date range is supported?',
      a: 'BS 2000 to BS 2090, roughly AD 1943 to 2034. Beyond that the converter has no published month lengths to work from, so the app shows the date as stored instead of inventing a conversion.',
    },
    {
      q: 'Does the time zone matter?',
      a: 'It does. "Today" is calculated for Asia/Kathmandu rather than the browser’s zone, so a shop owner entering an invoice at 11 pm Nepal time does not get the next day’s date because their laptop is set somewhere else.',
    },
  ],
  '/vat-reporting-nepal': [
    {
      q: 'Is the VAT rate fixed at 13%?',
      a: '13% is the default, and each business sets its own rate in Settings. There is a single rate per business, so a shop that mixes exempt and taxable supplies has to separate them before entering the taxable ones.',
    },
    {
      q: 'Does Zeyks Book file my VAT return?',
      a: 'No. It produces a VAT summary for a date range from your posted journal entries. The return itself is prepared and filed by you or your accountant with the IRD.',
    },
    {
      q: 'Where does the input VAT figure come from?',
      a: 'From the VAT receivable account. Purchase entries post tax there when the business is registered, and expense entries post tax there when the expense carries it. Anything that did not reach that account is not in the summary.',
    },
    {
      q: 'Why is my input VAT larger than 13% of the taxable purchases?',
      a: 'Because the two totals read different parts of the ledger. Taxable purchases are the cost-of-goods side; input VAT is everything posted to the VAT receivable account, which also takes tax from expenses. They are not expected to be a clean ratio.',
    },
    {
      q: 'Is the VAT report ready to hand to the IRD?',
      a: 'It carries the figures a return asks for, printed on A4 with your PAN and the period. It is a working document produced by software with no IRD approval status — review it with your accountant before relying on it.',
    },
  ],
};

/** Short labels for the breadcrumb trail; the page titles are too long for it. */
const CRUMB = {
  '/pricing': 'Pricing',
  '/about': 'About',
  '/contact': 'Contact',
  '/privacy': 'Privacy',
  '/terms': 'Terms',
  '/signin': 'Sign in',
  '/demo': 'Demo',
  '/hallbook-software': 'Hallbook',
  '/agency-accounting': 'Agencies',
  '/bikram-sambat-accounting': 'BS dates',
  '/vat-reporting-nepal': 'VAT reporting',
};

const ORG = `${CANONICAL_ORIGIN}/#organization`;
const SITE = `${CANONICAL_ORIGIN}/#website`;
const SOFTWARE = `${CANONICAL_ORIGIN}/#software`;

const ORGANIZATION = {
  '@type': 'Organization',
  '@id': ORG,
  name: 'Zeyks Book',
  url: `${CANONICAL_ORIGIN}/`,
  logo: { '@type': 'ImageObject', url: `${CANONICAL_ORIGIN}/logo.jpg`, width: 1024, height: 1024 },
  email: 'contact@zeyksbook.app',
  telephone: '+977 9701066114',
  // Confirmed by the owner 2026-09-30: run from Janakpur, branch in Biratnagar.
  address: { '@type': 'PostalAddress', addressLocality: 'Janakpur', addressCountry: 'NP' },
  location: [
    {
      '@type': 'Place',
      name: 'Janakpur (head office)',
      address: { '@type': 'PostalAddress', addressLocality: 'Janakpur', addressCountry: 'NP' },
    },
    {
      '@type': 'Place',
      name: 'Biratnagar (branch)',
      telephone: '+977 9701066114',
      address: { '@type': 'PostalAddress', addressLocality: 'Biratnagar', addressCountry: 'NP' },
    },
  ],
  areaServed: { '@type': 'Country', name: 'Nepal' },
  contactPoint: [{
    '@type': 'ContactPoint',
    contactType: 'customer support',
    email: 'contact@zeyksbook.app',
    telephone: '+977 9701066114',
    areaServed: 'NP',
    availableLanguage: 'en',
  }],
};

const FEATURES = [
  'Double-entry bookkeeping',
  'Bikram Sambat (BS) and AD calendar support',
  'Sales invoicing with credit terms',
  'Purchase bills with credit terms',
  'Expense tracking with category mapping',
  'Inventory items, stock adjustments and valuation',
  'Aged receivables and payables',
  'A4 print-ready financial statements and VAT reports',
  'Ledger and document data health checks',
  'JSON data export',
];

const SOFTWARE_APPLICATION = {
  '@type': 'SoftwareApplication',
  '@id': SOFTWARE,
  name: 'Zeyks Book',
  url: `${CANONICAL_ORIGIN}/`,
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web browser',
  publisher: { '@id': ORG },
  description:
    'Double-entry accounting software for businesses in Nepal: Bikram Sambat and AD dates, '
    + 'NPR amounts, sales, purchases, expenses, settlements, inventory and printable A4 reports.',
  featureList: FEATURES,
  offers: {
    '@type': 'AggregateOffer',
    priceCurrency: 'NPR',
    lowPrice: '299',
    highPrice: '499',
    offerCount: '2',
    url: `${CANONICAL_ORIGIN}/pricing`,
    description: 'Plus NPR 299 per month, Premium NPR 499 per month. Billed monthly, no per-seat charges.',
  },
};

/** One page's graph: who publishes it, where it sits, and what it is about. */
function jsonLdFor(page) {
  const url = `${CANONICAL_ORIGIN}${page.path}`;
  const graph = [
    ORGANIZATION,
    {
      '@type': 'WebSite',
      '@id': SITE,
      url: `${CANONICAL_ORIGIN}/`,
      name: 'Zeyks Book',
      inLanguage: 'en',
      publisher: { '@id': ORG },
    },
    {
      '@type': page.path === '/about' ? 'AboutPage' : page.path === '/contact' ? 'ContactPage' : 'WebPage',
      '@id': `${url}#webpage`,
      url,
      name: page.title,
      description: page.description,
      isPartOf: { '@id': SITE },
      about: { '@id': page.path === '/signin' ? SITE : SOFTWARE },
      primaryImageOfPage: { '@type': 'ImageObject', url: `${CANONICAL_ORIGIN}/logo.jpg` },
      breadcrumb: {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${CANONICAL_ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: CRUMB[page.path], item: url },
        ],
      },
    },
  ];

  // The product node travels with the pages that describe the product: the
  // marketing set and the intent pages, which each answer one question about it.
  if (page.path === '/pricing' || page.path === '/demo' || page.path === '/about' || GUIDE_FAQS[page.path]) {
    graph.push(page.path === '/demo'
      ? { ...SOFTWARE_APPLICATION, isAccessibleForFree: true, offers: undefined }
      : SOFTWARE_APPLICATION);
  }

  const faqs = page.path === '/pricing' ? PRICING_FAQS : GUIDE_FAQS[page.path];
  if (faqs) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: faqs.map((entry) => ({
        '@type': 'Question',
        name: entry.q,
        acceptedAnswer: { '@type': 'Answer', text: entry.a },
      })),
    });
  }

  // `<` inside a JSON string would be read as markup by an HTML parser.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })
    .replace(/</g, '\\u003c');
}

/** Escape a value for an HTML attribute, since every string here is copy. */
function escapeHtml(value) {
  const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, (character) => escapes[character]);
}

/** Replace exactly once, and fail loudly when the shell no longer matches. */
function replaceOnce(html, pattern, replacement, label) {
  if (!pattern.test(html)) {
    throw new Error(
      `[prerender] the app shell no longer contains a ${label} tag to replace. `
      + 'Update scripts/prerender.mjs alongside index.html.',
    );
  }
  return html.replace(pattern, replacement);
}

/**
 * The app shell with one page's metadata in its head.
 *
 * A pure string in, string out function so the test suite can run it against a
 * fixture and assert the result, without a build.
 */
export function renderPageHtml(shellHtml, page) {
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);
  const canonical = `${CANONICAL_ORIGIN}${page.path}`;

  let html = shellHtml;
  html = replaceOnce(html, /<title>[\s\S]*?<\/title>/, `<title>${title}</title>`, 'title');
  html = replaceOnce(
    html,
    /<meta\s+name="description"[\s\S]*?\/>/,
    `<meta name="description" content="${description}" />`,
    'description',
  );
  html = replaceOnce(
    html,
    /<meta\s+property="og:title"[\s\S]*?\/>/,
    `<meta property="og:title" content="${title}" />`,
    'og:title',
  );
  html = replaceOnce(
    html,
    /<meta\s+property="og:description"[\s\S]*?\/>/,
    `<meta property="og:description" content="${description}" />`,
    'og:description',
  );
  html = replaceOnce(
    html,
    /<meta\s+property="og:url"[\s\S]*?\/>/,
    `<meta property="og:url" content="${canonical}" />`,
    'og:url',
  );
  html = replaceOnce(
    html,
    /<meta\s+name="twitter:title"[\s\S]*?\/>/,
    `<meta name="twitter:title" content="${title}" />`,
    'twitter:title',
  );
  html = replaceOnce(
    html,
    /<meta\s+name="twitter:description"[\s\S]*?\/>/,
    `<meta name="twitter:description" content="${description}" />`,
    'twitter:description',
  );
  html = replaceOnce(
    html,
    /<link rel="canonical"[^>]*>/,
    `<link rel="canonical" href="${canonical}" />`,
    'canonical link',
  );
  if (page.path === '/signin') {
    html = replaceOnce(html, /<meta\s+name="robots"[^>]*\/>/, '<meta name="robots" content="noindex, nofollow" />', 'robots directive');
  }

  // The shell's graph describes the landing page; each document carries its own.
  html = replaceOnce(
    html,
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">${jsonLdFor(page)}</script>`,
    'JSON-LD block',
  );

  const content = SEO_CONTENT[page.path];
  if (content) {
    html = replaceOnce(html, /<div id="root">[\s\S]*?<\/div>/, `<div id="root">${content}</div>`, 'root content');
  }

  return html;
}

/** Write one document per public page into a built `dist`. Returns the paths. */
export function writeDocuments(distDir) {
  const shell = readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const written = [];
  for (const page of PRERENDER_PAGES) {
    const target = path.join(distDir, `${page.slug}.html`);
    writeFileSync(target, renderPageHtml(shell, page), 'utf8');
    written.push(target);
  }
  return written;
}

/**
 * The Vite plugin: after the bundle is on disk, read the shell it just wrote and
 * produce the per-page documents beside it.
 */
export function prerenderPublicPages() {
  let root = process.cwd();
  let outDir = 'dist';

  return {
    name: 'zeyks-prerender-public-pages',
    apply: 'build',
    configResolved(config) {
      root = config.root || process.cwd();
      outDir = config.build?.outDir || 'dist';
    },
    closeBundle() {
      const dist = path.isAbsolute(outDir) ? outDir : path.resolve(root, outDir);
      const written = writeDocuments(dist);
      console.log(
        `[prerender] wrote ${written.length} public documents: ${written.map((file) => path.basename(file)).join(', ')}`,
      );
    },
  };
}

/* Allow `node scripts/prerender.mjs` as a repair step for an existing build. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  console.log(`[prerender] ${writeDocuments(path.resolve(here, '../dist')).join('\n')}`);
}
