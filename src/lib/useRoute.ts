import { useCallback, useEffect, useState } from 'react';
import { normalizePath } from './routes';

/**
 * The address bar as React state.
 *
 * `popstate` covers the back and forward buttons; `navigate` covers the app's
 * own links. Nothing else may change the URL, so there is exactly one way a
 * screen can change and exactly one place the route is read from.
 *
 * The pathname — never the query string — is the route. The gateway return
 * (`?data=…` from eSewa, `?pidx=…` from Khalti) is handled by its own code,
 * which owns those parameters and clears them.
 */
export function useRoute(): {
  path: string;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
} {
  const [path, setPath] = useState(() =>
    typeof window === 'undefined' ? '/' : normalizePath(window.location.pathname));

  useEffect(() => {
    const onPopState = () => setPath(normalizePath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    const qIdx = to.indexOf('?');
    const pathPart = qIdx >= 0 ? to.slice(0, qIdx) : to;
    const queryPart = qIdx >= 0 ? to.slice(qIdx) : '';
    const next = normalizePath(pathPart);
    const fullUrl = next + queryPart;
    if (typeof window === 'undefined') return;
    if (normalizePath(window.location.pathname) === next && window.location.search === queryPart) {
      setPath(next);
      return;
    }
    if (opts?.replace) window.history.replaceState({}, '', fullUrl);
    else window.history.pushState({}, '', fullUrl);
    setPath(next);
    window.scrollTo(0, 0);
  }, []);

  return { path, navigate };
}
