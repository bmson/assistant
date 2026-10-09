import { chromium } from 'playwright';

// The browser is the mobile app's administration console. Run this against
// the loopback-only, owner-authenticated preview prepared by CI.
const baseUrl = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const browserPath = process.env.SMOKE_BROWSER_PATH;
const browser = await chromium.launch({
  headless: true,
  ...(browserPath
    ? { executablePath: browserPath }
    : { channel: process.env.SMOKE_BROWSER_CHANNEL ?? 'chrome' }),
});
const failures: string[] = [];
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 900 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(`${baseUrl}/settings`);
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Mobile app connection', exact: true }).waitFor();
    for (const name of ['Settings', 'Audit trail']) {
      const link = page
        .getByRole('navigation', { name: 'Administration' })
        .getByRole('link', { name, exact: true });
      const bounds = await link.boundingBox();
      if (!bounds || bounds.height < 44) throw new Error(`${name} needs a 44px touch target`);
    }
    const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
    if (viewportMeta?.includes('user-scalable=no'))
      throw new Error('Browser zoom must remain available');
    await page
      .getByRole('navigation', { name: 'Administration' })
      .getByRole('link', { name: 'Audit trail' })
      .click();
    await page.getByRole('heading', { name: 'Audit trail', exact: true }).waitFor();
    await page.getByLabel('Search recorded work').fill('smoke-no-matching-record');
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.waitForURL(
      (url) =>
        url.pathname === '/audit' && url.searchParams.get('q') === 'smoke-no-matching-record',
    );
    await page
      .getByText(
        'No matches in this scanned page. Continue to older records if available, or change the filters.',
        { exact: true },
      )
      .waitFor();
    const overflowing = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    if (overflowing) throw new Error(`Audit trail overflows at ${viewport.width}px`);
    await page.goto(`${baseUrl}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(`${baseUrl}/settings`);
  }
  for (const path of ['/chat/all', '/people', '/profile', '/tasks', '/documents']) {
    const result = await context.request.get(`${baseUrl}${path}`, { maxRedirects: 0 });
    const location = result.headers().location;
    const destination = location ? new URL(location, baseUrl).href : '';
    if (result.status() !== 307 || destination !== `${baseUrl}/settings`)
      throw new Error(
        `Retired route ${path} returned ${result.status()} with location ${location ?? 'missing'}`,
      );
  }
  const health = await context.request.get(`${baseUrl}/api/health`);
  if (!health.ok()) throw new Error('Backend health check failed');
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(
    'Settings, mobile access, audit filters, retired routes, and browser zoom passed at three viewport sizes.',
  );
} finally {
  await browser.close();
}
