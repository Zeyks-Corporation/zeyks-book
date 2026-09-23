import { test, expect, chromium, devices } from '@playwright/test';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

// Common mobile phone device viewports to test
const PHONE_MODELS = [
  { name: 'iPhone 15 Pro', viewport: { width: 393, height: 852 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { name: 'iPhone SE', viewport: { width: 375, height: 667 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1' },
  { name: 'Samsung Galaxy S23', viewport: { width: 360, height: 780 }, userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' },
  { name: 'Google Pixel 8', viewport: { width: 412, height: 915 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36' },
];

const PAGES_TO_TEST = ['/', '/demo', '/pricing', '/about', '/contact', '/privacy', '/terms'];

test.describe('Mobile Responsiveness Verification Suite', () => {
  let server;

  test.beforeAll(async () => {
    // Serve the compiled dist directory on PORT 4173
    const distPath = path.resolve(process.cwd(), 'dist');
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };

    server = createServer((req, res) => {
      let reqUrl = req.url.split('?')[0];
      let filePath = path.join(distPath, reqUrl === '/' ? 'index.html' : reqUrl);

      if (!existsSync(filePath) || !filePath.includes('.')) {
        filePath = path.join(distPath, 'index.html');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      try {
        const data = readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      } catch (err) {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    await new Promise((resolve) => server.listen(PORT, resolve));
  });

  test.afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  for (const phone of PHONE_MODELS) {
    test.describe(`Viewport: ${phone.name} (${phone.viewport.width}x${phone.viewport.height})`, () => {
      for (const pagePath of PAGES_TO_TEST) {
        test(`Page ${pagePath} should fit viewport without horizontal overflow`, async ({ page }) => {
          await page.setViewportSize(phone.viewport);
          await page.goto(`${BASE_URL}${pagePath}`);
          await page.waitForLoadState('networkidle');

          // Check for horizontal overflow (element width exceeding viewport width)
          const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
          const viewportWidth = phone.viewport.width;

          expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 2);

          // Verify header brand logo and mobile navigation buttons are visible
          const header = page.locator('header');
          await expect(header).toBeVisible();

          // Take screenshot for visual audit
          const sanitizePath = pagePath.replace(/\//g, '_') || '_home';
          await page.screenshot({
            path: `tests/screenshots/${phone.name.toLowerCase().replace(/\s+/g, '_')}${sanitizePath}.png`,
            fullPage: false,
          });
        });
      }
    });
  }
});
