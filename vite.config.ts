import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    // The payment gateway lives on the API server. Secrets never reach the browser.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
});
