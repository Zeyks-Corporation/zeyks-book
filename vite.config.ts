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
  if (process.env.VERCEL && mode === 'production') {
    const required = [
      'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID',
      'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY',
    ];
    const missing = required.filter((name) => !publicEnv[name]?.trim());
    if (missing.length > 0) {
      throw new Error(`Missing public deployment configuration: ${missing.join(', ')}`);
    }
  }
  for (const [name, value] of Object.entries(publicEnv)) {
    if (name.startsWith('VITE_') && looksPrivileged(value)) {
      throw new Error(`${name} contains a privileged credential and cannot be bundled into the browser.`);
    }
  }

  return {
    // The build writes one static document per public page (see the plugin), so a
    // crawler receives that page's own canonical URL and title rather than the
    // landing page's for every address.
    plugins: [react(), tailwindcss(), prerenderPublicPages()],
    resolve: { alias: { '@': path.resolve(__dirname, './src') } },
    server: {
      // The payment gateway lives on the API server. Secrets never reach the browser.
      proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
    },
  };
});
