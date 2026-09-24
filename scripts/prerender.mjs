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
      'Honest pricing for Nepali businesses: the Community Edition is self-hosted, with no per-seat charges '
      + 'and no vendor lock-in.',
  },
  {
    slug: 'about',
    path: '/about',
    title: 'About — Zeyks Book',
    description:
      'Why Zeyks Book exists: accurate double-entry accounting for Nepali enterprises, built around the '
      + 'Bikram Sambat calendar instead of working around it.',
  },
  {
    slug: 'contact',
    path: '/contact',
    title: 'Contact — Zeyks Book',
    description:
      'Questions about deploying Zeyks Book, or about setting up your double-entry ledger? Send us a message.',
  },
  {
    slug: 'privacy',
    path: '/privacy',
    title: 'Privacy — Zeyks Book',
    description:
      'How Zeyks Book handles your books: row level security per business, no third-party analytics, '
      + 'no telemetry, and your data exportable at any time.',
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
    title: 'Demo — Zeyks Book',
    description:
      'Walk through Zeyks Book with sample books that live only in your browser. No account, and no data '
      + 'leaves the device.',
  },
];

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
