import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { Buffer } from 'node:buffer';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { prerenderPublicPages } from './scripts/prerender.mjs';

function looksPrivileged(value: string): boolean {
  if (/^(sb_secret_|sbp_)/i.test(value) || /"private_key"\s*:/.test(value)) return true;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'service_role';
  } catch {
    return false;
  }
}

export default defineConfig(({ mode }) => {
  const publicEnv = loadEnv(mode, process.cwd(), 'VITE_');

  // Provide production fallbacks if environment variables are not populated in Vercel dashboard
  publicEnv.VITE_SUPABASE_URL ||= process.env.VITE_SUPABASE_URL || 'https://rlymuofhrreqwqhmmhqw.supabase.co';
  publicEnv.VITE_SUPABASE_ANON_KEY ||= process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJseW11b2ZocnJlcXdxaG1taHF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3ODYzNTIsImV4cCI6MjEwNTM2MjM1Mn0.PNyXm5YW3U-RSxFDYG-CU7e40r3hoNqv3BcEalfdXw8';
  publicEnv.VITE_FIREBASE_API_KEY ||= process.env.VITE_FIREBASE_API_KEY || 'AIzaSyDYyDiI-kSX9EIJuFO7K4dp0I6JNwZ15EI';
  publicEnv.VITE_FIREBASE_AUTH_DOMAIN ||= process.env.VITE_FIREBASE_AUTH_DOMAIN || 'zeyksbook-fa70a.firebaseapp.com';
  publicEnv.VITE_FIREBASE_PROJECT_ID ||= process.env.VITE_FIREBASE_PROJECT_ID || 'zeyksbook-fa70a';
  publicEnv.VITE_FIREBASE_APP_ID ||= process.env.VITE_FIREBASE_APP_ID || '1:309210449964:web:ca48b2e8b6e35c3503e989';

  for (const [name, value] of Object.entries(publicEnv)) {
    if (name.startsWith('VITE_') && looksPrivileged(value)) {
      throw new Error(`${name} contains a privileged credential and cannot be bundled into the browser.`);
    }
  }

  return {
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(publicEnv.VITE_SUPABASE_URL),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(publicEnv.VITE_SUPABASE_ANON_KEY),
      'import.meta.env.VITE_FIREBASE_API_KEY': JSON.stringify(publicEnv.VITE_FIREBASE_API_KEY),
      'import.meta.env.VITE_FIREBASE_AUTH_DOMAIN': JSON.stringify(publicEnv.VITE_FIREBASE_AUTH_DOMAIN),
      'import.meta.env.VITE_FIREBASE_PROJECT_ID': JSON.stringify(publicEnv.VITE_FIREBASE_PROJECT_ID),
      'import.meta.env.VITE_FIREBASE_APP_ID': JSON.stringify(publicEnv.VITE_FIREBASE_APP_ID),
    },
    plugins: [react(), tailwindcss(), prerenderPublicPages()],
    resolve: { alias: { '@': path.resolve(__dirname, './src') } },
    server: {
      proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
    },
  };
});
