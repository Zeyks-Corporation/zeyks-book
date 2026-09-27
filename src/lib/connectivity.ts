import { useEffect, useState } from 'react';

/**
 * Browser connectivity, read in one place.
 *
 * `navigator.onLine` is the only signal the browser gives, and it is coarse: it
 * says the device has a network route, not that the Neon Data API will answer.
 * So it is used to decide whether to *attempt* a cloud load or fall back to the
 * last cached snapshot — never as proof a write landed. A request that goes out
 * while `onLine` is true can still fail; that path is handled where it is made.
 */
export function isBrowserOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

/** Subscribe a component to the online/offline edge. */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(isBrowserOnline);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  return online;
}
