/**
 * Firebase client — REMOVED.
 *
 * The auth + data cutover moved everything to Neon Auth (Managed Better Auth)
 * and the Neon Data API, so the Firebase SDK is no longer used by the browser
 * bundle. The file is kept as a stub so any stray import (e.g. types) keeps
 * type-checking; nothing in this module is loaded by the app at runtime.
 */

export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
  measurementId: '',
};

/** No-op placeholders so legacy imports type-check. Nothing calls them. */
export const auth = null as unknown as never;
export const db = null as unknown as never;
export const functions = null as unknown as never;