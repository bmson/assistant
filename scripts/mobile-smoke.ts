import { chromium } from 'playwright';

// Run this against an owner-authenticated browser session. The smoke opens chat
// and history but never submits a message or calls a model/provider.
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
    for (const name of ['Chat', 'Memory', 'Settings', 'Audit trail']) {
      const link = page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name, exact: true });
      const bounds = await link.boundingBox();
      if (!bounds || bounds.height < 44) throw new Error(`${name} needs a 44px touch target`);
    }
    const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
    if (viewportMeta?.includes('user-scalable=no'))
      throw new Error('Browser zoom must remain available');
    await page
      .getByRole('navigation', { name: 'Main navigation' })
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

    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Chat', exact: true })
      .click();
    await page.waitForURL((url) => url.origin === baseUrl && url.pathname === '/chat');
    await page.getByRole('log', { name: 'Conversation' }).waitFor();
    await page.getByRole('combobox', { name: 'Message' }).waitFor();

    await page.goto(`${baseUrl}/chat/all`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL((url) => url.origin === baseUrl && url.pathname === '/chat/all');
    await page.getByRole('heading', { name: 'All chats', exact: true }).waitFor();
    const chatOverflowing = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    if (chatOverflowing) throw new Error(`Chat history overflows at ${viewport.width}px`);
  }
  // These exact owner pages are intentionally browseable. Check real content,
  // not just a 200 that could be a Settings redirect or a load-error shell.
  for (const [path, heading] of [
    ['/profile', 'What I remember'],
    ['/people', 'People'],
    ['/profile/knowledge?view=library', 'Knowledge'],
    ['/profile/knowledge?view=map', 'Knowledge'],
  ] as const) {
    const result = await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
    if (result?.status() !== 200 || new URL(page.url()).pathname !== path.split('?')[0])
      throw new Error(`Memory browse route ${path} did not return its own page`);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    if (path === '/profile') {
      await page.locator('main').getByRole('link', { name: 'People', exact: true }).waitFor();
      await page
        .getByRole('navigation', { name: 'Memory', exact: true })
        .getByRole('link', { name: 'Saved notes', exact: true })
        .waitFor();
    } else if (path === '/people') {
      await page.getByLabel('Search people', { exact: true }).waitFor();
      if ((await page.locator('form:has(input[name="q"])').getAttribute('method')) !== 'get')
        throw new Error('People search must remain a GET form');
    } else {
      await page.getByRole('navigation', { name: 'Knowledge views' }).waitFor();
      const filters = page.locator('form[action="/profile/knowledge"]');
      await filters
        .getByLabel(path.endsWith('view=map') ? 'Search items by name' : 'Search saved notes', {
          exact: true,
        })
        .waitFor();
      if ((await filters.getAttribute('method')) !== 'get')
        throw new Error('Knowledge filters must remain a GET form');
    }
  }
  const missingPerson = '00000000-0000-4000-8000-000000000099';
  for (const path of ['/profile', '/people', '/profile/knowledge', `/people/${missingPerson}`]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const result = await context.request.fetch(`${baseUrl}${path}`, {
        method,
        maxRedirects: 0,
        headers: { 'next-action': 'smoke-must-not-dispatch' },
      });
      if (result.status() !== 405 || result.headers().location)
        throw new Error(`Browse mutation ${method} ${path} must be rejected before dispatch`);
    }
  }
  for (const path of [
    '/tasks',
    '/documents',
    '/people/not-an-id',
    `/people/${missingPerson}/extra`,
    '/profile/about',
    '/profile/knowledge/extra',
  ]) {
    const result = await context.request.get(`${baseUrl}${path}`, { maxRedirects: 0 });
    const location = result.headers().location;
    const destination = location ? new URL(location, baseUrl).href : '';
    if (result.status() !== 307 || destination !== `${baseUrl}/settings`)
      throw new Error(
        `Retired route ${path} returned ${result.status()} with location ${location ?? 'missing'}`,
      );
    const mutation = await context.request.post(`${baseUrl}${path}`, { maxRedirects: 0 });
    if (mutation.status() !== 410 || mutation.headers().location)
      throw new Error(`Retired mutation POST ${path} must stay unavailable`);
  }
  const health = await context.request.get(`${baseUrl}/api/health`);
  if (!health.ok()) throw new Error('Backend health check failed');
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(
    'Owner chat, chat history, Memory navigation, Settings, mobile access, audit filters, and browser zoom passed at three viewport sizes; exact Memory browse content, mutation denials, and unrelated retired routes passed.',
  );
} finally {
  await browser.close();
}
