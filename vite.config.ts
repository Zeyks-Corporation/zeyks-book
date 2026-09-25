import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { prerenderPublicPages } from './scripts/prerender.mjs';

function supabaseAuthBridgePlugin() {
  return {
    name: 'supabase-auth-bridge',
    configureServer(server: any) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = req.url?.split('?')[0] || '';
        if (
          url === '/api/auth/supabase-session' ||
          url === '/api/business/my-memberships' ||
          url === '/api/business/get' ||
          url === '/api/resend/status'
        ) {
          try {
            const { default: apiHandler } = await import('./api/index.js');
            return apiHandler(req, res);
          } catch (err) {
            console.error('[Vite Auth Bridge Error]:', err);
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  // The build writes one static document per public page (see the plugin), so a
  // crawler receives that page's own canonical URL and title rather than the
  // landing page's for every address.
  plugins: [react(), tailwindcss(), prerenderPublicPages(), supabaseAuthBridgePlugin()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    // The payment gateway lives on the API server. Secrets never reach the browser.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
});
