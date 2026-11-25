import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE_URL = process.env.APP_URL || 'http://127.0.0.1:4180';
const EMAIL = 'ui-bug-hunt@test.local';
const PASSWORD = 'uipass1234';
const OUT = 'ui-review';

const login = await fetch(`${BASE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD })
}).then(r => r.json());
const TOKEN = login.data.token;

const report = { consoleErrors: [], pageErrors: [], overflow: [], captured: [] };
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });

async function newPage(vp, fresh) {
  const context = await browser.newContext({
    viewport: { width: vp.w, height: vp.h },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce'
  });
  const page = await context.newPage();
  page.on('console', m => {
    if (m.type() === 'error') report.consoleErrors.push({ tag: vp.tag, message: m.text() });
  });
  page.on('pageerror', e => report.pageErrors.push({ tag: vp.tag, message: e.message }));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ t, fresh }) => {
    localStorage.setItem('pa_token', t);
    if (!fresh) localStorage.setItem('pa_tour_seen', '1');
  }, { t: TOKEN, fresh });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#section-overview.active', { timeout: 30000 });
  await page.waitForTimeout(2600);
  return { context, page };
}

async function checkOverflow(page, tag) {
  const o = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    bodyScrollW: document.body.scrollWidth
  }));
  const bad = o.scrollW > o.innerW + 1 || o.bodyScrollW > o.innerW + 1;
  report.overflow.push({ tag, ...o, overflow: bad });
  return bad;
}

try {
  // Dashboard at 4 viewports, tour pre-dismissed.
  for (const vp of [
    { tag: 'desktop-1512', w: 1512, h: 982 },
    { tag: 'laptop-1280', w: 1280, h: 800 },
    { tag: 'tablet-834', w: 834, h: 1112 },
    { tag: 'mobile-390', w: 390, h: 844 },
  ]) {
    const { context, page } = await newPage(vp, false);
    await checkOverflow(page, vp.tag + '/dashboard');
    await page.screenshot({ path: `${OUT}/fix-${vp.tag}-dashboard.png`, fullPage: true });
    report.captured.push(vp.tag + '/dashboard');
    await context.close();
    console.log('done', vp.tag);
  }

  // Fresh profile: tour must spotlight the hero metrics, not the corner.
  {
    const { context, page } = await newPage({ tag: 'tour-1512', w: 1512, h: 982 }, true);
    await page.waitForTimeout(800);
    const tour = await page.evaluate(() => {
      const tip = document.getElementById('tour-tip');
      const card = document.getElementById('tour-card');
      const hero = document.getElementById('dashboard-hero-metrics');
      const h = hero && hero.getBoundingClientRect();
      const t = tip && tip.getBoundingClientRect();
      return {
        tipRect: t ? { x: t.x, y: t.y, w: t.width, h: t.height } : null,
        heroRect: h ? { x: h.x, y: h.y, w: h.width, h: h.height } : null,
        cardOverNav: (() => {
          const c = card.getBoundingClientRect();
          const el = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
          return el ? !!el.closest('.app-sidebar') : false;
        })(),
      };
    });
    report.tourCheck = tour;
    await page.screenshot({ path: `${OUT}/fix-tour-fresh.png`, fullPage: false });
    // Nav must be clickable while tour is up.
    await page.locator('a[data-target="inputs"]').click({ timeout: 5000 }).catch(() => {});
    report.navClickableWhileTourUp = page.url() !== 'about:blank' &&
      await page.evaluate(() => document.querySelector('#section-inputs').classList.contains('active'));
    await context.close();
  }

  // Collapsed sidebar at desktop — no overlap.
  {
    const { context, page } = await newPage({ tag: 'collapsed-1512', w: 1512, h: 982 }, false);
    await page.evaluate(() => {
      localStorage.setItem('pa_sidebar_collapsed', '1');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    await checkOverflow(page, 'collapsed-1512/dashboard');
    const overlap = await page.evaluate(() => {
      const main = document.querySelector('.main');
      const sb = document.querySelector('.app-sidebar');
      const m = main.getBoundingClientRect();
      const s = sb.getBoundingClientRect();
      return m.left < s.right - 2;
    });
    report.collapsedSidebarOverlap = overlap;
    await page.screenshot({ path: `${OUT}/fix-collapsed-dashboard.png`, fullPage: false });
    await context.close();
  }

  // Dark theme dashboard.
  {
    const { context, page } = await newPage({ tag: 'dark-1512', w: 1512, h: 982 }, false);
    await page.evaluate(() => {
      localStorage.setItem('pa_ui', JSON.stringify({ theme: 'dark', scale: 1 }));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2400);
    await checkOverflow(page, 'dark-1512/dashboard');
    await page.screenshot({ path: `${OUT}/fix-dark-dashboard.png`, fullPage: true });
    await context.close();
  }

  // Portal header, desktop + mobile.
  for (const vp of [
    { tag: 'portal-1512', w: 1512, h: 982 },
    { tag: 'portal-390', w: 390, h: 844 },
  ]) {
    const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/portal`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    const brandColor = await page.evaluate(() => {
      const el = document.getElementById('portal-ba');
      const cs = getComputedStyle(el);
      const head = getComputedStyle(document.querySelector('.portal-head'));
      return { text: el.textContent, color: cs.color, headBg: head.backgroundColor, headColor: head.color };
    });
    report.portalHeader = report.portalHeader || {};
    report.portalHeader[vp.tag] = brandColor;
    await page.screenshot({ path: `${OUT}/fix-${vp.tag}-portal.png`, fullPage: false });
    await context.close();
  }

  fs.writeFileSync(`${OUT}/verify-report.json`, JSON.stringify(report, null, 2));
  console.log('consoleErrors:', report.consoleErrors.length, 'pageErrors:', report.pageErrors.length);
  report.overflow.forEach(o => console.log('overflow', o.tag, o.overflow, o.scrollW, 'vs', o.innerW));
  console.log('tour:', JSON.stringify(report.tourCheck));
  console.log('navClickableWhileTourUp:', report.navClickableWhileTourUp);
  console.log('collapsedSidebarOverlap:', report.collapsedSidebarOverlap);
  console.log('portal:', JSON.stringify(report.portalHeader, null, 1));
} finally {
  await browser.close();
}
