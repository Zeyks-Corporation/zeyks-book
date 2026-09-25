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

/** The canonical production origin. Must match robots.txt and sitemap.xml. */
export const SITE_ORIGIN = 'https://zeyksbook.app';

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

const PUBLIC_PAGES: Record<string, PageMetadata> = {
  '/': {
    title: 'Accounting Software for Nepal | BS Calendar & NPR — Zeyks Book',
    description: PRODUCT_DESCRIPTION,
    path: '/',
    indexable: true,
  },
  '/signin': {
    title: 'Sign in — Zeyks Book',
    description: 'Sign in to Zeyks Book with a one-time code sent to your email address.',
    path: '/signin',
    indexable: false,
  },
  '/demo': {
    title: 'Interactive Accounting Software Demo for Nepal — Zeyks Book',
    description: 'Walk through Zeyks Book with sample books: sales, purchases, settlements, reports, and Bikram Sambat dates. Demo changes stay in this browser.',
    path: '/demo',
    indexable: true,
  },
  '/pricing': {
    title: 'Pricing — Zeyks Book',
    description: 'Zeyks Book costs NPR 999 per month for Nepali businesses. See the included bookkeeping features, managed cloud storage, backup limits, and answers about trials and refunds.',
    path: '/pricing',
    indexable: true,
  },
  '/about': {
    title: 'About — Zeyks Book',
    description: 'Web-based double-entry accounting for businesses in Nepal with Bikram Sambat and AD dates, NPR records, and printable A4 reports.',
    path: '/about',
    indexable: true,
  },
  '/contact': {
    title: 'Contact — Zeyks Book',
    description: 'Contact Zeyks Book in Kathmandu about the accounting demo, NPR 999 monthly plan, data storage, or moving your business books.',
    path: '/contact',
    indexable: true,
  },
  '/privacy': {
    title: 'Privacy — Zeyks Book',
    description: 'Learn how Zeyks Book stores accounting records in a managed Supabase database, uses Firebase sign-in, and handles demo data, downloadable backups, and service providers.',
    path: '/privacy',
    indexable: true,
  },
  '/terms': {
    title: 'Terms — Zeyks Book',
    description: 'The terms that govern your use of Zeyks Book.',
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
