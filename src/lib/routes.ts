/**
 * The URL is the route.
 *
 * This app used to keep its current screen in React state only, which meant a
 * hard refresh threw the person back to the dashboard, a link could not be
 * shared or bookmarked, and every unknown path rendered whatever the initial
 * state happened to be. The screen now *is* the address bar: `parseRoute` turns
 * a pathname into the one screen that path names, and `pathForTab` is the
 * inverse, so refresh, back/forward, a pasted link and the sidebar all agree.
 *
 * Pure and dependency-free on purpose: this is the part worth testing, and it
 * is tested without a browser.
 */

import type { ViewTab } from '../types';

/** Where each signed-in screen lives. The inverse of `parseRoute`. */
const TAB_PATHS: Record<ViewTab, string> = {
  dashboard: '/dashboard',
  sales: '/sales',
  purchases: '/purchases',
  expenses: '/expenses',
  payments: '/payments',
  reports: '/reports',
  health: '/health',
  settings: '/settings',
  inventory: '/inventory',
};

/** Every path that maps to a signed-in screen. */
export const APP_TABS: ViewTab[] = Object.keys(TAB_PATHS) as ViewTab[];

export type Route =
  /** The public landing page: what this is, and how to sign in. */
  | { kind: 'landing' }
  /** The sign-in / sign-up screen, as a page of its own, not a modal over a book. */
  | { kind: 'signin' }
  /** A page shown to a signed-in user whose role does not unlock the dashboard. */
  | { kind: 'subscribe' }
  /** Public informational pages. */
  | { kind: 'demo' }
  | { kind: 'pricing' }
  | { kind: 'about' }
  | { kind: 'contact' }
  | { kind: 'privacy' }
  | { kind: 'terms' }
  /** A signed-in screen. */
  | { kind: 'app'; tab: ViewTab }
  /** The hidden admin panel; reachable only at `/king` and only for admins. */
  | { kind: 'king' }
  /** Nothing here. Rendered as a real 404, never as a random application screen. */
  | { kind: 'not-found'; path: string };

/** `/dashboard/` → `/dashboard`, `dashboard` → `/dashboard`, `''` → `/`. */
export function normalizePath(pathname: string): string {
  let p = (pathname || '/').split('?')[0]!.split('#')[0]!;
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

export function pathForTab(tab: ViewTab): string {
  return TAB_PATHS[tab];
}

/** True when the path names a signed-in screen (so a session is required). */
export function isAppPath(pathname: string): boolean {
  return parseRoute(pathname).kind === 'app';
}

/**
 * The one place a pathname becomes a screen.
 *
 * Anything the application does not serve is `not-found` — including paths that
 * merely *look* like a route, so a typo can never land on the dashboard by
 * accident.
 */
export function parseRoute(pathname: string): Route {
  const path = normalizePath(pathname);

  if (path === '/') return { kind: 'landing' };
  // Both spellings, because people type both and neither should 404.
  if (path === '/signin' || path === '/login') return { kind: 'signin' };
  if (path === '/subscribe') return { kind: 'subscribe' };
  if (path === '/demo') return { kind: 'demo' };
  if (path === '/pricing') return { kind: 'pricing' };
  if (path === '/about') return { kind: 'about' };
  if (path === '/contact') return { kind: 'contact' };
  if (path === '/privacy') return { kind: 'privacy' };
  if (path === '/terms') return { kind: 'terms' };

  for (const tab of APP_TABS) {
    if (TAB_PATHS[tab] === path) return { kind: 'app', tab };
  }

  // The admin panel has no nav button — a staff member types `/king` and only
  // an admin role may render it; everyone else sees 404.
  if (path === '/king') return { kind: 'king' };

  return { kind: 'not-found', path };
}

/**
 * Where a route *should* be, given who is looking.
 *
 * Two rules, both about not showing the wrong surface:
 *
 *  - A signed-in person asking for the landing page or the sign-in screen is
 *    sent to the books. Their session is a fact; a marketing page is not the
 *    screen they wanted.
 *  - A signed-out person asking for a book screen stays on that path, and is
 *    shown the sign-in screen; once they sign in they land on the screen they
 *    actually asked for. The private data is never rendered either way — the
 *    redirect is a convenience, and the gate below is the boundary.
 *
 * `null` means "render the route as it is".
 */
export function redirectFor(route: Route, authenticated: boolean): string | null {
  if (authenticated && (route.kind === 'landing' || route.kind === 'signin' || route.kind === 'demo' || route.kind === 'pricing' || route.kind === 'about' || route.kind === 'contact' || route.kind === 'privacy' || route.kind === 'terms')) {
    return pathForTab('dashboard');
  }
  return null;
}
