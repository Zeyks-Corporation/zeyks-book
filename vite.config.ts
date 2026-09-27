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
  // Vite injects every VITE_* value from the environment into the bundle, so
  // the one thing the build must refuse is a privileged credential among them.
  for (const [name, value] of Object.entries(loadEnv(mode, process.cwd(), 'VITE_'))) {
    if (looksPrivileged(value)) {
      throw new Error(`${name} contains a privileged credential and cannot be bundled into the browser.`);
    }
  }

  return {
    plugins: [react(), tailwindcss(), prerenderPublicPages()],
    resolve: { alias: { '@': path.resolve(__dirname, './src') } },
    server: {
      proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
    },
  };
});
