import type { ViewTab } from '../types';
import { normalizePath, parseRoute } from './routes';

/**
 * Per-route document metadata.
 *
 * This is a single-page app served from one `index.html`, so before this file
 * every public route — pricing, about, contact, privacy, terms, the sign-in
 * screen — emitted the home page's canonical URL, title and description. Each
 * of them told a search engine it *was* the home page, which is a duplicate
 * -content problem across the whole public site.
 *
 * `metadataForPath` is the pure mapping from a URL path to what that page is,
 * and `applyPageMetadata` writes it into the live document: title, description,
 * canonical link, a robots directive, and the Open Graph / Twitter mirrors.
 * A crawler that executes the page therefore sees route-correct metadata. The
 * root `index.html` keeps the home page's own tags as the static default, which
 * is what a non-executing fetcher sees.
 */

/**
 * The canonical production origin.
 *
 * This is the host that actually answers `200`. The apex `zeyksbook.app`
 * answers `308` and points here, so every canonical URL, `og:url`, robots
 * `Sitemap:` line and sitemap `<loc>` has to name this one — publishing a
 * canonical URL that redirects means the crawler drops the signal and keeps the
 * redirecting URL in the index instead. Must match robots.txt and sitemap.xml.
 */
export const SITE_ORIGIN = 'https://www.zeyksbook.app';

/** The shared social preview image, shipped in `public/`. */
export const SOCIAL_IMAGE = `${SITE_ORIGIN}/logo.jpg`;

/**
 * Titles for the signed-in screens.
 *
 * This is the one source of truth: App imports it for the header, and the
 * document title is derived from it here.
 */
export const TITLES: Record<ViewTab, string> = {
  dashboard: 'Dashboard',
  sales: 'Sales',
  purchases: 'Purchases',
  expenses: 'Expenses',
  payments: 'Payments',
  reports: 'Reports',
  health: 'Data health',
  settings: 'Settings',
  inventory: 'Inventory',
};

export interface PageMetadata {
  title: string;
  description: string;
  /** Path only; the canonical URL is `SITE_ORIGIN + path`. */
  path: string;
  /** Signed-in book screens are private and must never be indexed. */
  indexable: boolean;
}

const PRODUCT_DESCRIPTION =
  'Zeyks Book is accounting software for small businesses in Nepal, with double-entry bookkeeping, Bikram Sambat and AD dates, NPR amounts, invoices, bills, and printable A4 financial reports.';

/**
 * Every public page, by path.
 *
 * Exported so `tests/run.mjs` can compare it against `PRERENDER_PAGES` in
 * `scripts/prerender.mjs`: the build-time documents and this live table are the
 * same copy in two places, and a drift between them is the bug.
 */
export const PUBLIC_PAGES: Record<string, PageMetadata> = {
  '/': {
    title: 'Accounting Software for Nepal | BS Calendar & NPR — Zeyks Book',
    description: PRODUCT_DESCRIPTION,
    path: '/',
    indexable: true,
  },
  '/signin': {
    title: 'Sign in — Zeyks Book',
    description: 'Sign in to Zeyks Book with the email address and password issued to your business by the Zeyks Book team.',
    path: '/signin',
    indexable: false,
  },
  '/demo': {
    title: 'Interactive Accounting Software Demo for Nepal — Zeyks Book',
    description: 'Try Zeyks Book with sample books in your browser: sales, purchases, settlements, printable A4 reports and Bikram Sambat dates. No sign-in, and demo changes never leave the device.',
    path: '/demo',
    indexable: true,
  },
  '/pricing': {
    title: 'Pricing — Starter NPR 399, Premium NPR 599 | Zeyks Book',
    description: 'Zeyks Book has two monthly plans for businesses in Nepal: Starter at NPR 399 for daily sales, purchases and expenses, and Premium at NPR 599 adding inventory, aged receivables and payables, printable reports and data health. No per-seat charges.',
    path: '/pricing',
    indexable: true,
  },
  '/about': {
    title: 'About — Zeyks Book',
    description: 'Zeyks Book is web-based double-entry accounting for businesses in Nepal, built around Bikram Sambat and AD dates, NPR amounts, and printable A4 reports.',
    path: '/about',
    indexable: true,
  },
  '/contact': {
    title: 'Contact — Zeyks Book',
    description: 'Contact the Zeyks Book team in Janakpur and Biratnagar, Nepal about the interactive demo, the Starter and Premium monthly plans, where business records are stored, or moving your books.',
    path: '/contact',
    indexable: true,
  },
  '/privacy': {
    title: 'Privacy — Zeyks Book',
    description: 'How Zeyks Book stores accounting records in a managed Neon Postgres database, signs you in with Neon Auth email and password, and handles demo data, downloadable JSON backups, and service providers.',
    path: '/privacy',
    indexable: true,
  },
  '/terms': {
    title: 'Terms — Zeyks Book',
    description: 'The terms that govern your use of Zeyks Book, including the accounting guarantees and the limits of the service.',
    path: '/terms',
    indexable: true,
  },
};

const NOT_FOUND: PageMetadata = {
  title: 'Page not found — Zeyks Book',
  description: 'That page could not be found.',
  path: '/',
  indexable: false,
};

/**
 * What a path's document metadata should be.
 *
 * Signed-in screens get their own title but are marked non-indexable: they
 * render one business's private books and belong in no search index, which is
 * also what robots.txt says.
 */
export function metadataForPath(pathname: string): PageMetadata {
  const route = parseRoute(pathname);
  if (route.kind === 'not-found') return { ...NOT_FOUND, path: normalizePath(pathname) };
  if (route.kind === 'app') {
    return {
      title: `${TITLES[route.tab]} — Zeyks Book`,
      description: PRODUCT_DESCRIPTION,
      path: normalizePath(pathname),
      indexable: false,
    };
  }
  const publicPath = route.kind === 'landing' ? '/' : `/${route.kind}`;
  const page = PUBLIC_PAGES[publicPath] ?? PUBLIC_PAGES['/']!;
  return route.kind === 'signin' ? { ...page, indexable: false } : page;
}

/* -------------------------------------------------------------------------- */
/* Applying it to the live document                                           */
/* -------------------------------------------------------------------------- */

function setMeta(attr: 'name' | 'property', key: string, content: string) {
  if (typeof document === 'undefined') return;
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

/**
 * Write one page's metadata into the current document.
 *
 * Existing tags are updated in place; missing ones are created. Safe to call on
 * every route change — it is idempotent.
 */
export function applyPageMetadata(meta: PageMetadata): void {
  if (typeof document === 'undefined') return;

  const url = `${SITE_ORIGIN}${meta.path === '/' ? '/' : meta.path}`;
  document.title = meta.title;

  setMeta('name', 'description', meta.description);
  setMeta('name', 'robots', meta.indexable ? 'index,follow' : 'noindex,nofollow');

  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }
  canonical.href = url;

  setMeta('property', 'og:title', meta.title);
  setMeta('property', 'og:description', meta.description);
  setMeta('property', 'og:url', url);
  setMeta('property', 'og:image', SOCIAL_IMAGE);
  setMeta('name', 'twitter:title', meta.title);
  setMeta('name', 'twitter:description', meta.description);
  setMeta('name', 'twitter:image', SOCIAL_IMAGE);
}
