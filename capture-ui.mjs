
import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE_URL = process.env.APP_URL || 'http://127.0.0.1:4180';

const TARGETS = [
  { id: 'overview', label: 'Dashboard', file: '01-overview.png' },
  { id: 'inputs', label: 'Investment Inputs', file: '02-inputs.png' },
  { id: 'property', label: 'Property Intelligence', file: '03-property.png' },
  { id: 'area', label: 'Area & Suburb', file: '04-area.png' },
  { id: 'cashflow', label: 'Cash Flow', file: '05-cashflow.png' },
  { id: 'projections', label: 'Projections', file: '06-projections.png' },
  { id: 'exit', label: 'Exit & CGT', file: '07-exit.png' },
  { id: 'borrowing', label: 'Borrowing Capacity', file: '08-borrowing.png' },
  { id: 'scenarios', label: 'Scenarios & Reports', file: '09-scenarios.png' },
  { id: 'actuals', label: 'Actuals', file: '10-actuals.png' },
  { id: 'workspace', label: 'Client Workspace', file: '11-workspace.png' }
];

const OUTPUT_DIR = 'ui-review';
const ZIP_FILE = 'ui-review.zip';

const report = {
  url: BASE_URL,
  timestamp: new Date().toISOString(),
  captured: [],
  skipped: [],
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  httpErrors: [],
  portfolioVerification: null,
  fatalError: null
};

const browser = await chromium.launch({
  headless: false
});

async function dismissWalkthrough(page) {
  const possibleButtons = [
    /^skip$/i,
    /^close$/i,
    /^got it$/i,
    /^finish$/i,
    /^done$/i,
    /^×$/,
    /^✕$/
  ];

  for (const pattern of possibleButtons) {
    const button = page.getByRole('button', {
      name: pattern
    }).first();

    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  const closeSelectors = [
    '[aria-label="Close"]',
    '[title="Close"]',
    '.tour-close',
    '.introjs-skipbutton',
    '.shepherd-cancel-icon',
    '.driver-popover-close-btn'
  ];

  for (const selector of closeSelectors) {
    const close = page.locator(selector).first();

    if (await close.isVisible().catch(() => false)) {
      await close.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  await page.evaluate(() => {
    const selectors = [
      '.introjs-overlay',
      '.introjs-helperLayer',
      '.introjs-tooltip',
      '.shepherd-modal-overlay-container',
      '.driver-overlay',
      '.driver-popover'
    ];

    document.querySelectorAll(selectors.join(',')).forEach(element => {
      element.remove();
    });

    document.body.classList.remove(
      'introjs-showElement',
      'shepherd-enabled',
      'driver-active'
    );
  }).catch(() => {});
}


// Wait for the actual portfolio data to appear.
// Both properties must be visible before Dashboard capture.
async function waitForPortfolioProperties(page) {
  console.log('\nVerifying portfolio properties...');

  const ppor = page.getByText('8 Atkinson Close', {
    exact: false
  }).first();

  const investment = page.getByText('Beaconsfield', {
    exact: false
  }).first();

  let pporVisible = false;
  let investmentVisible = false;

  try {
    await ppor.waitFor({
      state: 'visible',
      timeout: 30000
    });

    pporVisible = true;

    console.log('FOUND: PPOR - 8 Atkinson Close');

    await investment.waitFor({
      state: 'visible',
      timeout: 30000
    });

    investmentVisible = true;

    console.log('FOUND: Investment - Beaconsfield');

  } catch (error) {
    const bodyText = await page.locator('body').innerText()
      .catch(() => '');

    report.portfolioVerification = {
      ppor: pporVisible,
      investment: investmentVisible,
      success: false,
      error: error.message
    };

    // Save diagnostic screenshot.
    await page.screenshot({
      path: `${OUTPUT_DIR}/dashboard-verification-failed.png`,
      fullPage: true
    }).catch(() => {});

    fs.writeFileSync(
      `${OUTPUT_DIR}/dashboard-debug.txt`,
      bodyText
    );

    throw new Error(
      `Portfolio verification failed. PPOR: ${pporVisible}, ` +
      `Investment: ${investmentVisible}. Check dashboard-debug.txt`
    );
  }

  const result = {
    ppor: pporVisible,
    investment: investmentVisible,
    total: 2,
    success: true
  };

  report.portfolioVerification = result;

  console.log('SUCCESS: Both properties are visible.');

  return result;
}


async function waitForSection(page, target) {
  await page.waitForSelector(
    `#section-${target.id}.active`,
    { timeout: 15000 }
  );

  // Wait for page rendering and layout stability.
  await page.waitForLoadState('domcontentloaded')
    .catch(() => {});

  await page.waitForTimeout(1500);

  await dismissWalkthrough(page);
}


try {
  const context = await browser.newContext({
    viewport: {
      width: 1660,
      height: 1100
    },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce'
  });

  const page = await context.newPage();

  // Collect browser diagnostics.
  page.on('console', message => {
    if (message.type() === 'error') {
      report.consoleErrors.push({
        message: message.text(),
        location: message.location()
      });
    }
  });

  page.on('pageerror', error => {
    report.pageErrors.push({
      message: error.message,
      stack: error.stack
    });
  });

  page.on('requestfailed', request => {
    report.failedRequests.push({
      url: request.url(),
      method: request.method(),
      error: request.failure()?.errorText
    });
  });

  page.on('response', response => {
    if (response.status() >= 400) {
      report.httpErrors.push({
        status: response.status(),
        url: response.url(),
        method: response.request().method()
      });
    }
  });

  console.log('\n================================');
  console.log('PROPERTY ANALYSER UI CAPTURE');
  console.log('================================');
  console.log('Application:', BASE_URL);

  await page.goto(BASE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('\nLog in if required.');
  console.log('Waiting for Dashboard...\n');

  await page.waitForSelector(
    '#section-overview.active',
    { timeout: 0 }
  );

  await page.waitForTimeout(2000);
  await dismissWalkthrough(page);

  // Start with a clean output folder.
  fs.rmSync(OUTPUT_DIR, {
    recursive: true,
    force: true
  });

  fs.rmSync(ZIP_FILE, {
    force: true
  });

  fs.mkdirSync(OUTPUT_DIR, {
    recursive: true
  });

  for (const target of TARGETS) {
    try {
      console.log(`\n--------------------------------`);
      console.log(`Opening: ${target.label}`);
      console.log(`--------------------------------`);

      // Expand navigation groups.
      await page.locator('details.nav-group')
        .evaluateAll(elements => {
          elements.forEach(element => {
            element.open = true;
          });
        });

      const link = page.locator(
        `a[data-target="${target.id}"]`
      ).first();

      if (!(await link.count())) {
        throw new Error('Navigation link not found');
      }

      await link.click();

      await waitForSection(page, target);

      // Special validation for Dashboard.
      if (target.id === 'overview') {
        await waitForPortfolioProperties(page);
      }

      // Allow additional rendering for other sections.
      if (target.id !== 'overview') {
        await page.waitForTimeout(2000);
      }

      await dismissWalkthrough(page);

      const outputPath = `${OUTPUT_DIR}/${target.file}`;

      // Capture full page.
      await page.screenshot({
        path: outputPath,
        fullPage: true,
        animations: 'disabled'
      });

      report.captured.push({
        id: target.id,
        label: target.label,
        file: target.file,
        url: page.url()
      });

      console.log(`CAPTURED: ${target.label}`);

    } catch (error) {
      report.skipped.push({
        id: target.id,
        label: target.label,
        reason: error.message
      });

      console.error(`FAILED: ${target.label}`);
      console.error(error.message);

      // Dashboard verification is critical.
      // Stop further capture if portfolio is incomplete.
      if (target.id === 'overview') {
        report.fatalError = error.message;
        break;
      }
    }
  }

  // Save diagnostics.
  fs.writeFileSync(
    `${OUTPUT_DIR}/report.json`,
    JSON.stringify(report, null, 2)
  );

  // Create fresh ZIP.
  execFileSync('zip', [
    '-qr',
    ZIP_FILE,
    OUTPUT_DIR
  ]);

  console.log('\n================================');
  console.log('SCREENSHOT CAPTURE COMPLETE');
  console.log('================================');

  console.log(`Captured: ${report.captured.length}`);
  console.log(`Skipped: ${report.skipped.length}`);
  console.log(`Console errors: ${report.consoleErrors.length}`);
  console.log(`Page errors: ${report.pageErrors.length}`);
  console.log(`HTTP errors: ${report.httpErrors.length}`);
  console.log(`Failed requests: ${report.failedRequests.length}`);

  console.log(
    'Portfolio verified:',
    report.portfolioVerification?.success ? 'YES' : 'NO'
  );

  console.log(`ZIP created: ${ZIP_FILE}`);

  if (report.fatalError) {
    console.error('\nDashboard validation failed.');
    process.exitCode = 1;
  }

} catch (error) {
  report.fatalError = error.message;

  console.error('\nCAPTURE ERROR:', error.message);

  process.exitCode = 1;

} finally {
  await browser.close();
}
