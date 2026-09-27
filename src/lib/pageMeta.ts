/**
 * Page metadata — one title, one description and one canonical URL per route.
 *
 * The deployment used to ship a single `index.html` for every address in the
 * product, so all eight public pages arrived at a crawler wearing the landing
 * page's title, the landing page's description and the landing page's canonical
 * URL. A shared link, a search result and an index entry all described the same
 * page no matter which one was asked for.
 *
 * Two halves fix that, and they must agree:
 *
 *   - `scripts/prerender.mjs` writes a document per public page at build time
 *     (`dist/pricing.html` and so on), each with this table's title,
 *     description and canonical URL in its head. That is what a crawler that
 *     does not run JavaScript reads.
 *   - `applyPageMeta` sets the same three things when a person navigates inside
 *     the app, so a client-side route change does not leave the previous page's
 *     title in the tab. That is what a crawler that does run JavaScript reads.
 *
 * The private screens get a title too, and `noindex` — robots.txt disallows them
 * as well, but a page should not have to rely on a file it cannot see.
 */

import type { Route } from './routes';

/** The one host that may appear in a canonical link, an og:url or a sitemap. */
export const CANONICAL_ORIGIN = 'https://zeyksbook.app';

export const SITE_NAME = 'Zeyks Book';

export const SITE_DESCRIPTION =
  'Zeyks Book is accounting software for small businesses in Nepal, with double-entry bookkeeping, Bikram Sambat and AD dates, NPR amounts, invoices, bills, and printable A4 financial reports.';

export interface PublicPageMeta {
  /** The document the build writes; the landing page is the app shell itself. */
  slug: '' | 'signin' | 'demo' | 'pricing' | 'about' | 'contact' | 'privacy' | 'terms';
  /** The public path this page is served at. */
  path: string;
  title: string;
  description: string;
  /** Whether the page belongs in sitemap.xml. */
  sitemap: boolean;
  changefreq: 'monthly' | 'yearly';
  priority: string;
}

/**
 * Every public page, in the order the sitemap lists them.
 *
 * The demo is a public product walkthrough and is included in the sitemap.
 */
export const PUBLIC_PAGE_META: PublicPageMeta[] = [
  {
    slug: '',
    path: '/',
    title: `Accounting Software for Nepal | BS Calendar & NPR — ${SITE_NAME}`,
    description: SITE_DESCRIPTION,
    sitemap: true,
    changefreq: 'monthly',
    priority: '1.0',
  },
  {
    slug: 'pricing',
    path: '/pricing',
    title: `Pricing — ${SITE_NAME}`,
    description:
      `${SITE_NAME} costs NPR 999 per month for Nepali businesses. See the included bookkeeping features, managed cloud storage, backup limits, and answers about trials and refunds.`,
    sitemap: true,
    changefreq: 'monthly',
    priority: '0.8',
  },
  {
    slug: 'about',
    path: '/about',
    title: `About — ${SITE_NAME}`,
    description: 'Web-based double-entry accounting for businesses in Nepal with Bikram Sambat and AD dates, NPR records, and printable A4 reports.',
    sitemap: true,
    changefreq: 'monthly',
    priority: '0.7',
  },
  {
    slug: 'contact',
    path: '/contact',
    title: `Contact — ${SITE_NAME}`,
    description: 'Contact Zeyks Book in Kathmandu about the accounting demo, NPR 999 monthly plan, data storage, or moving your business books.',
    sitemap: true,
    changefreq: 'yearly',
    priority: '0.6',
  },
  {
    slug: 'privacy',
    path: '/privacy',
    title: `Privacy — ${SITE_NAME}`,
    description:
      'Learn how Zeyks Book stores accounting records in a managed Neon Postgres database, uses Neon Auth sign-in, and handles demo data, downloadable backups, and service providers.',
    sitemap: true,
    changefreq: 'yearly',
    priority: '0.5',
  },
  {
    slug: 'terms',
    path: '/terms',
    title: `Terms — ${SITE_NAME}`,
    description:
      'The terms Zeyks Book is provided under, including the accounting guarantees and the limits of the service.',
    sitemap: true,
    changefreq: 'yearly',
    priority: '0.5',
  },
  {
    slug: 'signin',
    path: '/signin',
    title: `Sign in — ${SITE_NAME}`,
    description: 'Sign in to Zeyks Book with a one-time code sent to your email address.',
    sitemap: false,
    changefreq: 'yearly',
    priority: '0.3',
  },
  {
    slug: 'demo',
    path: '/demo',
    title: `Interactive Accounting Software Demo for Nepal — ${SITE_NAME}`,
    description:
      'Walk through Zeyks Book with sample books that live only in your browser. No account, and no data '
      + 'leaves the device.',
    sitemap: true,
    changefreq: 'monthly',
    priority: '0.6',
  },
];

/** The page title for each signed-in screen. */
const TAB_TITLES: Record<string, string> = {
  dashboard: 'Dashboard',
  sales: 'Sales',
  purchases: 'Purchases',
  expenses: 'Expenses',
  payments: 'Payments',
  reports: 'Reports',
  health: 'Data health',
  settings: 'Settings',
};

export interface PageMeta {
  title: string;
  description: string;
  /** Absolute canonical URL, or null when the page must not carry one. */
  canonical: string | null;
  /** Whether crawlers may index the page. */
  indexable: boolean;
}

const NOT_FOUND_META: PageMeta = {
  title: `Page not found — ${SITE_NAME}`,
  description: 'That address does not match a page in Zeyks Book.',
  canonical: null,
  indexable: false,
};

/**
 * The metadata for a route.
 *
 * Pure, so it can be asserted without a browser: public pages carry their own
 * canonical URL, and private or unknown ones carry none and say `noindex`.
 */
export function metaForRoute(route: Route): PageMeta {
  if (route.kind === 'not-found') return NOT_FOUND_META;

  if (route.kind === 'app') {
    const title = TAB_TITLES[route.tab] ?? route.tab;
    return {
      title: `${title} — ${SITE_NAME}`,
      description: 'Your books, signed in. This screen is private to your business and is never indexed.',
      canonical: null,
      indexable: false,
    };
  }

  const page = PUBLIC_PAGE_META.find((entry) => entry.path === pathForRoute(route));
  if (!page) return NOT_FOUND_META;
  return {
    title: page.title,
    description: page.description,
    canonical: `${CANONICAL_ORIGIN}${page.path === '/' ? '/' : page.path}`,
    indexable: page.path !== '/signin',
  };
}

/** The public path a public route is served at. */
function pathForRoute(route: Route): string {
  switch (route.kind) {
    case 'landing': return '/';
    case 'signin': return '/signin';
    case 'demo': return '/demo';
    case 'pricing': return '/pricing';
    case 'about': return '/about';
    case 'contact': return '/contact';
    case 'privacy': return '/privacy';
    case 'terms': return '/terms';
    default: return '';
  }
}

/** Set one `<meta>` tag, creating it when the document does not have it yet. */
function setMetaTag(attribute: 'name' | 'property', key: string, content: string): void {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attribute, key);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}

/**
 * Apply a route's metadata to the live document.
 *
 * Called on every route change by `App`. A signed-in or unknown route loses the
 * canonical link rather than pointing at a page it is not, and gains `noindex`.
 */
export function applyPageMeta(route: Route): PageMeta {
  const meta = metaForRoute(route);
  if (typeof document === 'undefined') return meta;

  document.title = meta.title;
  setMetaTag('name', 'description', meta.description);
  setMetaTag('name', 'robots', meta.indexable ? 'index, follow' : 'noindex, nofollow');
  setMetaTag('property', 'og:title', meta.title);
  setMetaTag('property', 'og:description', meta.description);

  const existing = document.head.querySelector('link[rel="canonical"]');
  if (meta.canonical) {
    const link = existing ?? document.createElement('link');
    link.setAttribute('rel', 'canonical');
    link.setAttribute('href', meta.canonical);
    if (!existing) document.head.appendChild(link);
    setMetaTag('property', 'og:url', meta.canonical);
  } else if (existing?.parentNode) {
    // The page is private, so it must not point at a canonical URL it is not.
    existing.parentNode.removeChild(existing);
  }

  return meta;
}
