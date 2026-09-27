/*
 * Zeyks Book — app-shell service worker.
 *
 * Scope is deliberately narrow: it exists so the app itself still BOOTS with
 * no network, after it was visited once while online. It caches only
 * same-origin GETs — the built assets are hashed, so a cached file is always
 * the exact file its HTML references.
 *
 * It never touches anything cross-origin. The Neon Data API, the auth server
 * and the payment API are separate hosts: every request to them goes straight
 * to the network untouched, so this worker cannot serve stale accounting data
 * and cannot bypass a token check. The books themselves go to IndexedDB via
 * lib/offlineStore.ts, not here.
 */

const ASSETS = 'zeyks-assets-v1';
const PAGES = 'zeyks-pages-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key !== ASSETS && key !== PAGES)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

function isSameOriginPath(url) {
  return url.origin === self.location.origin;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!isSameOriginPath(url)) return;

  // An API call that happens to live on this origin (/api/...) must always
  // reach the server — a cached answer there is either wrong or expired.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    // Network first: online, the real page (or its prerendered copy) wins.
    // Offline, the last copy of the app shell loads and the boot chain takes
    // it from there (IndexedDB → read-only books, or the sign-in screen).
    event.respondWith((async () => {
      let networkError = null;
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(PAGES);
        cache.put(request, fresh.clone());
        return fresh;
      } catch (e) {
        networkError = e;
      }
      const cached = await caches.match(request)
        || await caches.match('/index.html')
        || await caches.match('/');
      if (cached) return cached;
      throw networkError;
    })());
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    // Cache first: these filenames contain the build hash, so a stored file
    // and a served file are the same bytes forever.
    event.respondWith((async () => {
      const hit = await caches.match(request);
      if (hit) return hit;
      const fresh = await fetch(request);
      if (fresh && fresh.status === 200) {
        const cache = await caches.open(ASSETS);
        cache.put(request, fresh.clone());
      }
      return fresh;
    })());
    return;
  }

  // Icons, fonts and other same-origin files: refresh in the background.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const fetchPromise = (async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.status === 200) {
          const cache = await caches.open(ASSETS);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (e) {
        return null;
      }
    })();
    return cached || fetchPromise || Response.error();
  })());
});
