import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    // The preview proxy needs a public bind address and must accept Arena's
    // generated *.e2b.app host. Localhost remains allowed by Vite by default.
    host: true,
    allowedHosts: ['.e2b.app'],
    // The payment gateway lives on the API server. Secrets never reach the browser.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
});
