import type { AllBookData } from '../services/bookService';
import type { BusinessProfile, UserProfile } from '../types';
import type { MembershipLike } from './appPhases';

/**
 * The offline copy of the books, kept in IndexedDB.
 *
 * This is deliberately NOT a second ledger. It is a read-only snapshot of the
 * last successful cloud sync, written after each online load, used only to let
 * the app still open and show the books when the network is gone. The server
 * stays the authority: while the offline view is up, every write path is
 * refused, and the moment a real cloud load succeeds the snapshot is
 * overwritten from the server's answer.
 *
 * The invariant "no accounting data survives in the browser" is preserved at
 * the two ends: sign-out calls clearOfflineStore() (see App.clearLocalSession)
 * and a cache older than MAX_AGE_DAYS is treated as absent, so a device left
 * signed in and offline does not hold books indefinitely.
 */

const DB_NAME = 'zeyks-offline';
const DB_VERSION = 1;
const STORE_BOOKS = 'books';      // keyPath: businessId
const STORE_SESSION = 'session';  // single row, key: 'current'

/** A stale cached session is worse than no cached session. */
const MAX_AGE_DAYS = 14;

export interface OfflineBooksRecord {
  businessId: string;
  savedAt: string;
  data: AllBookData;
}

export interface OfflineSessionRecord {
  key: 'current';
  savedAt: string;
  /** The books belong to this identity; a restore must never serve them to another. */
  userId: string;
  user: UserProfile;
  business: BusinessProfile;
  memberships: MembershipLike[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: 'businessId' });
      }
      if (!db.objectStoreNames.contains(STORE_SESSION)) {
        db.createObjectStore(STORE_SESSION, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
}

async function withStore<T>(
  name: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const request = run(tx.objectStore(name));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

function isStale(savedAt: string): boolean {
  const age = Date.now() - Date.parse(savedAt);
  return !Number.isFinite(age) || age > MAX_AGE_DAYS * 86_400_000;
}

/** Best-effort: every failure here only costs the offline view, never data. */
async function attempt<T>(label: string, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (e) {
    console.warn(`[offline] ${label} failed`, e);
    return null;
  }
}

export function cacheOfflineBooks(businessId: string, data: AllBookData): Promise<void> {
  return attempt('cacheOfflineBooks', async () => {
    const record: OfflineBooksRecord = { businessId, savedAt: new Date().toISOString(), data };
    await withStore(STORE_BOOKS, 'readwrite', (store) => store.put(record));
  }).then(() => undefined);
}

export function readOfflineBooks(businessId: string): Promise<OfflineBooksRecord | null> {
  return attempt('readOfflineBooks', async () => {
    const record = await withStore<OfflineBooksRecord | undefined>(
      STORE_BOOKS, 'readonly', (store) => store.get(businessId),
    );
    if (!record || isStale(record.savedAt)) return null;
    return record;
  });
}

export function cacheOfflineSession(
  user: UserProfile, business: BusinessProfile, memberships: MembershipLike[],
): Promise<void> {
  return attempt('cacheOfflineSession', async () => {
    const record: OfflineSessionRecord = {
      key: 'current', savedAt: new Date().toISOString(), userId: user.id, user, business, memberships,
    };
    await withStore(STORE_SESSION, 'readwrite', (store) => store.put(record));
  }).then(() => undefined);
}

export function readOfflineSession(): Promise<OfflineSessionRecord | null> {
  return attempt('readOfflineSession', async () => {
    const record = await withStore<OfflineSessionRecord | undefined>(
      STORE_SESSION, 'readonly', (store) => store.get('current'),
    );
    if (!record || isStale(record.savedAt)) return null;
    return record;
  });
}

/** Drop the entire offline copy — called on sign-out and session loss. */
export function clearOfflineStore(): Promise<void> {
  return attempt('clearOfflineStore', async () => {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_BOOKS, STORE_SESSION], 'readwrite');
        tx.objectStore(STORE_BOOKS).clear();
        tx.objectStore(STORE_SESSION).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }).then(() => undefined);
}
