import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

const PHONE_MODELS = [
  { name: 'iPhone 15 Pro', viewport: { width: 393, height: 852 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { name: 'iPhone SE', viewport: { width: 375, height: 667 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1' },
  { name: 'Samsung Galaxy S23', viewport: { width: 360, height: 780 }, userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' },
  { name: 'Google Pixel 8', viewport: { width: 412, height: 915 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36' },
];

const PAGES = ['/', '/demo', '/pricing', '/about', '/contact', '/privacy', '/terms'];

async function runMobileAudit() {
  console.log('🚀 Starting Playwright Mobile Responsiveness Verification...');

  const distPath = path.resolve(process.cwd(), 'dist');
  const screenshotDir = path.resolve(process.cwd(), 'tests/screenshots');
  if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });

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

  const server = createServer((req, res) => {
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
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`📡 Local preview server running at ${BASE_URL}`);

  const browser = await chromium.launch({ headless: true });
  let totalAudits = 0;
  let passedAudits = 0;
  let failedAudits = 0;

  for (const phone of PHONE_MODELS) {
    console.log(`\n📱 Testing Device: ${phone.name} (${phone.viewport.width}x${phone.viewport.height})`);

    const context = await browser.newContext({
      viewport: phone.viewport,
      userAgent: phone.userAgent,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    for (const routePath of PAGES) {
      totalAudits++;
      const targetUrl = `${BASE_URL}${routePath}`;
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);

        // Check horizontal overflow
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth || document.body.scrollWidth);
        const viewportWidth = phone.viewport.width;
        const overflowPx = scrollWidth - viewportWidth;

        const isHeaderVisible = await page.locator('header').isVisible();

        if (overflowPx <= 2 && isHeaderVisible) {
          passedAudits++;
          console.log(`  ✅ [PASS] ${routePath.padEnd(10)} | Overflow: 0px | Header: Visible`);
        } else {
          failedAudits++;
          console.error(`  ❌ [FAIL] ${routePath.padEnd(10)} | Overflow: ${overflowPx}px | Header: ${isHeaderVisible}`);
        }

        // Save phone screenshot
        const sanitizedName = phone.name.toLowerCase().replace(/\s+/g, '_');
        const sanitizedRoute = routePath.replace(/\//g, '_') || '_home';
        await page.screenshot({ path: path.join(screenshotDir, `${sanitizedName}${sanitizedRoute}.png`), fullPage: false });

      } catch (err) {
        failedAudits++;
        console.error(`  ❌ [ERROR] ${routePath}: ${err.message}`);
      }
    }

    await context.close();
  }

  await browser.close();
  await new Promise((resolve) => server.close(resolve));

  console.log('\n========================================');
  console.log(`📊 Mobile Responsiveness Audit Summary:`);
  console.log(`   Total Audits:  ${totalAudits}`);
  console.log(`   Passed:        ${passedAudits}`);
  console.log(`   Failed:        ${failedAudits}`);
  console.log('========================================\n');

  if (failedAudits > 0) {
    process.exit(1);
  }
}

runMobileAudit().catch((err) => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
