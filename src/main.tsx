import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker only exists to boot the shell offline, which matters in a
// real deployment. In dev it would sit between the browser and Vite's hot
// reload, so it is registered in production builds only.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* Offline boot is an extra; an unavailable worker changes nothing else. */
    });
  });
}
