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
    title: 'Pricing — Starter NPR 399, Premium NPR 599 | Zeyks Book',
    description:
      'Zeyks Book has two monthly plans for businesses in Nepal: Starter at NPR 399 for daily sales, purchases and expenses, and Premium at NPR 599 adding inventory, aged receivables and payables, printable reports and data health. No per-seat charges.',
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
    description: 'Contact the Zeyks Book team in Janakpur and Biratnagar, Nepal about the interactive demo, the Starter and Premium monthly plans, where business records are stored, or moving your books.',
  },
  {
    slug: 'privacy',
    path: '/privacy',
    title: 'Privacy — Zeyks Book',
    description: 'How Zeyks Book stores accounting records in a managed Neon Postgres database, signs you in with Neon Auth email and password, and handles demo data, downloadable JSON backups, and service providers.',
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
    description: 'Sign in to Zeyks Book with the email address and password issued to your business by the Zeyks Book team.',
  },
  {
    slug: 'demo',
    path: '/demo',
    title: 'Interactive Accounting Software Demo for Nepal — Zeyks Book',
    description:
      'Try Zeyks Book with sample books in your browser: sales, purchases, settlements, printable A4 reports and Bikram Sambat dates. No sign-in, and demo changes never leave the device.',
  },
];

/** Small, route-specific copy visible before JavaScript runs. */
const SEO_CONTENT = {
  '/pricing': '<main class="seo-fallback"><p>Pricing for Nepal</p><h1>Simple pricing for Nepali business accounting</h1><p>Zeyks Book has two monthly plans: Starter at NPR 399 and Premium at NPR 599. Starter covers daily books, sales, purchases and expenses. Premium adds inventory, aged receivables and payables, print-ready reports, data health and settlements. There are no per-seat charges.</p><h2>Know what is included</h2><p>Business records are held in a managed Neon Postgres database, and Neon Auth handles email and password sign-in. Download a JSON snapshot from Settings; restore is not available yet. Trial terms, refund policy, and IRD approval status are not currently published.</p><p><a href="/demo">Explore sample books in the interactive demo</a> or <a href="/contact">contact Zeyks Book</a> before subscribing.</p></main>',
  '/about': '<main class="seo-fallback"><p>About Zeyks Book</p><h1>Double-entry bookkeeping for businesses in Nepal</h1><p>Zeyks Book is a web-based accounting app for Nepali businesses. It supports Bikram Sambat and Gregorian dates, NPR amounts, sales, purchases, expenses, settlements, and printable A4 reports.</p><h2>Designed around local bookkeeping needs</h2><p>Explore sample books in the interactive demo. The team builds and supports Zeyks Book from Janakpur, with a branch in Biratnagar; registered company details and uptime commitments are not published.</p><p><a href="/demo">Try the demo</a> · <a href="/pricing">See pricing</a> · <a href="/contact">Contact</a></p></main>',
  '/contact': '<main class="seo-fallback"><p>Contact Zeyks Book</p><h1>Accounting software support from Janakpur and Biratnagar</h1><p>Contact the Zeyks Book team about the interactive demo, the Starter and Premium monthly plans, data storage, or moving your books.</p><p>Head office: Janakpur, Nepal. Branch: Biratnagar, Nepal. Email: contact@zeyksbook.app. Phone and WhatsApp: +977 9701066114.</p><p><a href="/demo">Try the interactive demo</a> · <a href="/pricing">Read pricing and terms</a></p></main>',
  '/privacy': '<main class="seo-fallback"><p>Privacy and data storage</p><h1>Where Zeyks Book stores accounting data</h1><p>Zeyks Book uses a managed Neon Postgres database for business records and Neon Auth for email and password sign-in. This is managed cloud storage, not a database in the customer’s own cloud account. The interactive demo uses sample books stored in the browser.</p><h2>Backups and recovery</h2><p>Users can download a JSON backup from Settings. Restoring a backup is not available yet, and automatic backup and recovery commitments are not published.</p><p><a href="/pricing">See pricing</a> · <a href="/contact">Ask a question</a></p></main>',
  '/terms': '<main class="seo-fallback"><p>Terms of use</p><h1>Using Zeyks Book for business accounts</h1><p>Zeyks Book provides web-based bookkeeping, Bikram Sambat and AD dates, NPR records, and printable reports. Review your accounting outputs with a qualified professional before statutory filing. The public site does not claim IRD certification or approval.</p><p><a href="/pricing">Pricing and subscription questions</a> · <a href="/privacy">Data and backup details</a> · <a href="/contact">Contact</a></p></main>',
  '/signin': '<main class="seo-fallback"><p>Zeyks Book sign in</p><h1>Sign in to your business books</h1><p>Sign in to Zeyks Book with the email address and password issued to your business by the Zeyks Book team.</p><p>Want to explore first? <a href="/demo">Open the interactive demo with sample books</a>.</p></main>',
  '/demo': '<main class="seo-fallback"><p>Interactive product demo</p><h1>Explore Nepali accounting software with sample books</h1><p>Walk through Zeyks Book’s double-entry ledger, invoices, purchases, settlements, reports, and Bikram Sambat dates using sample books. Demo changes stay in this browser.</p><p><a href="/pricing">See the Starter and Premium plans</a> · <a href="/privacy">Read about data storage</a></p></main>',
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
    a: 'Two plans, billed monthly. Starter (NPR 399) is sized for kirana counters — daily books, sales, purchases and expenses. Premium (NPR 599) unlocks inventory, aged receivables & payables, print-ready reports, data health and settlements. There are no per-seat charges.',
  },
  {
    q: 'Can I upgrade from Starter to Premium later?',
    a: 'Yes. Switching plans takes effect on the next page load — the role is read from your profile each time.',
  },
  {
    q: 'Where are my financial records stored?',
    a: 'Records live in a managed Neon Postgres database; sign-in is by email and password through Neon Auth, and each account only ever sees the books it owns. You can download a JSON snapshot from Settings.',
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

/** Short labels for the breadcrumb trail; the page titles are too long for it. */
const CRUMB = {
  '/pricing': 'Pricing',
  '/about': 'About',
  '/contact': 'Contact',
  '/privacy': 'Privacy',
  '/terms': 'Terms',
  '/signin': 'Sign in',
  '/demo': 'Demo',
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
    lowPrice: '399',
    highPrice: '599',
    offerCount: '2',
    url: `${CANONICAL_ORIGIN}/pricing`,
    description: 'Starter NPR 399 per month, Premium NPR 599 per month. Billed monthly, no per-seat charges.',
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

  // The product node only travels with the pages that describe the product.
  if (page.path === '/pricing' || page.path === '/demo' || page.path === '/about') {
    graph.push(page.path === '/demo'
      ? { ...SOFTWARE_APPLICATION, isAccessibleForFree: true, offers: undefined }
      : SOFTWARE_APPLICATION);
  }

  if (page.path === '/pricing') {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: PRICING_FAQS.map((entry) => ({
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
