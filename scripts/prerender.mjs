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
 * the app's own copy in `src/lib/pageMeta.ts`. A document that disagrees with
 * the page it serves is the bug this whole mechanism exists to prevent, so a
 * drift is a failing test rather than a stale `<title>`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CANONICAL_ORIGIN = 'https://zeyksbook.app';

/**
 * The public pages that need a document of their own.
 *
 * The landing page is `index.html` itself, so it is not listed here. Keep in
 * step with `PUBLIC_PAGE_META` in `src/lib/pageMeta.ts`.
 */
export const PRERENDER_PAGES = [
  {
    slug: 'pricing',
    path: '/pricing',
    title: 'Pricing — Zeyks Book',
    description:
      'Zeyks Book costs NPR 999 per month for Nepali businesses. See the included bookkeeping features, managed cloud storage, backup limits, and answers about trials and refunds.',
  },
  {
    slug: 'about',
    path: '/about',
    title: 'About — Zeyks Book',
    description: 'Web-based double-entry accounting for businesses in Nepal with Bikram Sambat and AD dates, NPR records, and printable A4 reports.',
  },
  {
    slug: 'contact',
    path: '/contact',
    title: 'Contact — Zeyks Book',
    description: 'Contact Zeyks Book in Kathmandu about the accounting demo, NPR 999 monthly plan, data storage, or moving your business books.',
  },
  {
    slug: 'privacy',
    path: '/privacy',
    title: 'Privacy — Zeyks Book',
    description: 'Learn how Zeyks Book stores accounting records in a managed Supabase database, uses Firebase sign-in, and handles demo data, downloadable backups, and service providers.',
  },
  {
    slug: 'terms',
    path: '/terms',
    title: 'Terms — Zeyks Book',
    description:
      'The terms Zeyks Book is provided under, including the accounting guarantees and the limits of the service.',
  },
  {
    slug: 'signin',
    path: '/signin',
    title: 'Sign in — Zeyks Book',
    description: 'Sign in to Zeyks Book with a one-time code sent to your email address.',
  },
  {
    slug: 'demo',
    path: '/demo',
    title: 'Interactive Accounting Software Demo for Nepal — Zeyks Book',
    description:
      'Walk through Zeyks Book with sample books that live only in your browser. No account, and no data '
      + 'leaves the device.',
  },
];

/** Small, route-specific copy visible before JavaScript runs. */
const SEO_CONTENT = {
  '/pricing': '<main class="seo-fallback"><p>Pricing for Nepal</p><h1>Simple pricing for Nepali business accounting</h1><p>Zeyks Book has one plan at NPR 999 per month. The plan includes double-entry bookkeeping, Bikram Sambat and AD dates, NPR records, and A4 reports.</p><h2>Know what is included</h2><p>Business records are held in a managed Supabase database and Firebase handles sign-in. Download a JSON backup from Settings; restore is not available yet. Trial terms, refund policy, and IRD approval status are not currently published.</p><p><a href="/demo">Explore sample books in the interactive demo</a> or <a href="/contact">contact Zeyks Book</a> before subscribing.</p></main>',
  '/about': '<main class="seo-fallback"><p>About Zeyks Book</p><h1>Double-entry bookkeeping for businesses in Nepal</h1><p>Zeyks Book is a web-based accounting app for Nepali businesses. It supports Bikram Sambat and Gregorian dates, NPR amounts, sales, purchases, expenses, settlements, and printable A4 reports.</p><h2>Designed around local bookkeeping needs</h2><p>Explore sample books in the interactive demo. The public site currently lists Kathmandu, Nepal and contact details; registered company details and uptime commitments are not published.</p><p><a href="/demo">Try the demo</a> · <a href="/pricing">See pricing</a> · <a href="/contact">Contact</a></p></main>',
  '/contact': '<main class="seo-fallback"><p>Contact Zeyks Book</p><h1>Questions about accounting software in Nepal?</h1><p>Contact the Zeyks Book team about the interactive demo, NPR 999 monthly plan, data storage, or moving your books.</p><p>Location: Kathmandu, Nepal. Email: contact@zeyksbook.app. Phone: +977 9767784817.</p><p><a href="/demo">Try the interactive demo</a> · <a href="/pricing">Read pricing and terms</a></p></main>',
  '/privacy': '<main class="seo-fallback"><p>Privacy and data storage</p><h1>Where Zeyks Book stores accounting data</h1><p>Zeyks Book uses a managed Supabase database for business records and Firebase for sign-in. This is managed cloud storage, not a database in the customer’s own cloud account. The interactive demo uses sample books stored in the browser.</p><h2>Backups and recovery</h2><p>Users can download a JSON backup from Settings. Restoring a backup is not available yet, and automatic backup and recovery commitments are not published.</p><p><a href="/pricing">See pricing</a> · <a href="/contact">Ask a question</a></p></main>',
  '/terms': '<main class="seo-fallback"><p>Terms of use</p><h1>Using Zeyks Book for business accounts</h1><p>Zeyks Book provides web-based bookkeeping, Bikram Sambat and AD dates, NPR records, and printable reports. Review your accounting outputs with a qualified professional before statutory filing. The public site does not claim IRD certification or approval.</p><p><a href="/pricing">Pricing and subscription questions</a> · <a href="/privacy">Data and backup details</a> · <a href="/contact">Contact</a></p></main>',
  '/signin': '<main class="seo-fallback"><p>Zeyks Book sign in</p><h1>Sign in to your business books</h1><p>Sign in to Zeyks Book with a one-time code sent to your email address.</p><p>Want to explore first? <a href="/demo">Open the interactive demo with sample books</a>.</p></main>',
  '/demo': '<main class="seo-fallback"><p>Interactive product demo</p><h1>Explore Nepali accounting software with sample books</h1><p>Walk through Zeyks Book’s double-entry ledger, invoices, purchases, settlements, reports, and Bikram Sambat dates using sample books. Demo changes stay in this browser.</p><p><a href="/pricing">See the NPR 999 monthly plan</a> · <a href="/privacy">Read about data storage</a></p></main>',
};

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
