/**
 * Firebase browser client — singleton.
 *
 * Uses the web API key only. Access is gated by Firestore security rules and Auth.
 */

import { initializeApp, getApp, getApps, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { getFirestore, Firestore } from 'firebase/firestore';
import { getFunctions, Functions } from 'firebase/functions';

const getEnvVar = (key: string): string | undefined => {
  try {
    // @ts-ignore - import.meta is available in Vite environment
    if (typeof import.meta !== 'undefined' && import.meta.env) {
      // @ts-ignore
      return import.meta.env[key] as string | undefined;
    }
  } catch {
    // Vite environment
  }
  return undefined;
};

// Check for required configuration keys; refusing to start if essential configuration is missing
const apiKey = getEnvVar('VITE_FIREBASE_API_KEY') || 'AIzaSyDYyDiI-kSX9EIJuFO7K4dp0I6JNwZ15EI';
const projectId = getEnvVar('VITE_FIREBASE_PROJECT_ID') || 'zeyksbook-fa70a';

if (!apiKey || !projectId) {
  throw new Error('Firebase configuration missing: VITE_FIREBASE_API_KEY and VITE_FIREBASE_PROJECT_ID are required — refusing to start.');
}

export const firebaseConfig = {
  apiKey,
  authDomain: getEnvVar('VITE_FIREBASE_AUTH_DOMAIN') || 'zeyksbook-fa70a.firebaseapp.com',
  projectId,
  storageBucket: getEnvVar('VITE_FIREBASE_STORAGE_BUCKET') || 'zeyksbook-fa70a.firebasestorage.app',
  messagingSenderId: getEnvVar('VITE_FIREBASE_MESSAGING_SENDER_ID') || '309210449964',
  appId: getEnvVar('VITE_FIREBASE_APP_ID') || '1:309210449964:web:ca48b2e8b6e35c3503e989',
  measurementId: getEnvVar('VITE_FIREBASE_MEASUREMENT_ID') || 'G-ESNNV3VNGN',
};

const isEmulator = Boolean(getEnvVar('VITE_USE_FIREBASE_EMULATORS'));

const app: FirebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth: Auth = getAuth(app);
export const db: Firestore = getFirestore(app);
export const functions: Functions = getFunctions(app);

if (isEmulator) {
  void import('firebase/auth').then(({ connectAuthEmulator }) =>
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }));
  void import('firebase/firestore').then(({ connectFirestoreEmulator }) =>
    connectFirestoreEmulator(db, '127.0.0.1', 8080));
  void import('firebase/functions').then(({ connectFunctionsEmulator }) =>
    connectFunctionsEmulator(functions, '127.0.0.1', 5001));
}
