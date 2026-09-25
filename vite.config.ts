import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { prerenderPublicPages } from './scripts/prerender.mjs';

export default defineConfig({
  // The build writes one static document per public page (see the plugin), so a
  // crawler receives that page's own canonical URL and title rather than the
  // landing page's for every address.
  plugins: [react(), tailwindcss(), prerenderPublicPages()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    // The payment gateway lives on the API server. Secrets never reach the browser.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
});
