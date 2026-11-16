import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:4180';
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'ui-bug-hunt@test.local', password: 'uipass1234' })
}).then(r => r.json());
const browser = await chromium.launch({ headless: true });
const report = { overflow: [], consoleErrors: 0 };
try {
  for (const vp of [
    { tag: '1512-light', w: 1512, h: 982, theme: 'light' },
    { tag: '1512-dark', w: 1512, h: 982, theme: 'dark' },
    { tag: '1280', w: 1280, h: 800, theme: 'light' },
    { tag: '834', w: 834, h: 1112, theme: 'light' },
    { tag: '390', w: 390, h: 844, theme: 'light' },
  ]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') report.consoleErrors++; });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ t, theme }) => {
      localStorage.setItem('pa_token', t);
      localStorage.setItem('pa_tour_seen', '1');
      localStorage.setItem('pa_ui', JSON.stringify({ theme, scale: 1 }));
    }, { t: login.data.token, theme: vp.theme });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#section-overview.active', { timeout: 30000 });
    await page.waitForTimeout(2500);
    const o = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, iw: window.innerWidth,
      heroBg: getComputedStyle(document.querySelector('.dash-head.dashboard-v2-head')).backgroundImage.slice(0, 80),
    }));
    report.overflow.push({ tag: vp.tag, ...o, overflow: o.sw > o.iw + 1 });
    await page.screenshot({ path: `ui-review/rollback-${vp.tag}-dashboard.png`, fullPage: vp.tag === '1512-light' || vp.tag === '1512-dark' });
    await ctx.close();
    console.log(vp.tag, 'overflow:', o.sw > o.iw + 1, 'sw:', o.sw);
  }
  fs.writeFileSync('ui-review/rollback-report.json', JSON.stringify(report, null, 2));
} finally { await browser.close(); }
