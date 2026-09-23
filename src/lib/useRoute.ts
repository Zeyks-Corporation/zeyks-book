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
    const next = normalizePath(to);
    if (typeof window === 'undefined') return;
    if (normalizePath(window.location.pathname) === next) {
      // Same screen: refresh the state so a caller can rely on it having run,
      // and leave no duplicate entry in the session history.
      setPath(next);
      return;
    }
    if (opts?.replace) window.history.replaceState({}, '', next);
    else window.history.pushState({}, '', next);
    setPath(next);
    // A new screen starts at the top. Previously the scroll position of the
    // previous screen carried over, which looked like a half-loaded page.
    window.scrollTo(0, 0);
  }, []);

  return { path, navigate };
}
