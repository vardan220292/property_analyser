import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE_URL = process.env.APP_URL || 'http://127.0.0.1:4180';
const EMAIL = process.env.UI_EMAIL || 'ui-bug-hunt@test.local';
const PASSWORD = process.env.UI_PASS || 'uipass1234';
const OUTPUT_DIR = 'ui-review';

const TARGETS = [
  { id: 'overview', label: 'Dashboard', file: '01-overview' },
  { id: 'inputs', label: 'Investment Inputs', file: '02-inputs' },
  { id: 'property', label: 'Property Intelligence', file: '03-property' },
  { id: 'area', label: 'Area & Suburb', file: '04-area' },
  { id: 'cashflow', label: 'Cash Flow', file: '05-cashflow' },
  { id: 'projections', label: 'Projections', file: '06-projections' },
  { id: 'exit', label: 'Exit & CGT', file: '07-exit' },
  { id: 'borrowing', label: 'Borrowing Capacity', file: '08-borrowing' },
  { id: 'scenarios', label: 'Scenarios & Reports', file: '09-scenarios' },
  { id: 'actuals', label: 'Actuals', file: '10-actuals' },
  { id: 'workspace', label: 'Client Workspace', file: '11-workspace' }
];

const VIEWPORTS = [
  { name: 'desktop-1512', width: 1512, height: 982 },
  { name: 'laptop-1280', width: 1280, height: 800 },
  { name: 'tablet-834', width: 834, height: 1112 },
  { name: 'mobile-390', width: 390, height: 844 }
];

const report = {
  url: BASE_URL,
  captured: [],
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  httpErrors: [],
  fatalError: null
};

const login = await fetch(`${BASE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD })
}).then(r => r.json());

if (!login.ok) throw new Error('login failed: ' + JSON.stringify(login));
const TOKEN = login.data.token;
console.log('Logged in as', EMAIL);

fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });

try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce'
    });
    const page = await context.newPage();

    page.on('console', m => {
      if (m.type() === 'error') report.consoleErrors.push({ vp: vp.name, message: m.text(), location: m.location() });
    });
    page.on('pageerror', e => report.pageErrors.push({ vp: vp.name, message: e.message, stack: e.stack }));
    page.on('requestfailed', r => report.failedRequests.push({ vp: vp.name, url: r.url(), error: r.failure()?.errorText }));
    page.on('response', r => {
      if (r.status() >= 400) report.httpErrors.push({ vp: vp.name, status: r.status(), url: r.url() });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(t => localStorage.setItem('pa_token', t), TOKEN);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#section-overview.active', { timeout: 30000 });
    await page.waitForTimeout(2500);

    // landing + portal once per viewport
    await page.goto(`${BASE_URL}/welcome`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUTPUT_DIR}/${vp.name}-00-landing.png`, fullPage: true });
    await page.goto(`${BASE_URL}/portal`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUTPUT_DIR}/${vp.name}-12-portal.png`, fullPage: true });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#section-overview.active', { timeout: 30000 });
    await page.waitForTimeout(2000);

    for (const t of TARGETS) {
      try {
        await page.locator('details.nav-group').evaluateAll(els => els.forEach(el => { el.open = true; }));
        const link = page.locator(`a[data-target="${t.id}"]`).first();
        if (!(await link.count())) throw new Error('nav link missing');
        await link.click();
        await page.waitForSelector(`#section-${t.id}.active`, { timeout: 15000 });
        await page.waitForTimeout(1800);
        await page.screenshot({ path: `${OUTPUT_DIR}/${vp.name}-${t.file}.png`, fullPage: true });
        report.captured.push({ vp: vp.name, id: t.id });
      } catch (e) {
        report.skipped = report.skipped || [];
        report.skipped.push({ vp: vp.name, id: t.id, reason: e.message });
        console.error(`FAILED ${vp.name} ${t.id}:`, e.message);
      }
    }
    await context.close();
    console.log(`Done viewport ${vp.name}`);
  }

  fs.writeFileSync(`${OUTPUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  console.log('Console errors:', report.consoleErrors.length);
  console.log('Page errors:', report.pageErrors.length);
  console.log('HTTP errors:', report.httpErrors.length);
  console.log('Failed requests:', report.failedRequests.length);
} finally {
  await browser.close();
}
