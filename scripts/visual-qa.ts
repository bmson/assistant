/**
 * Visual QA: screenshot every primary surface at desktop and phone widths.
 * Run against a dedicated QA dev server using the same allocated QA database.
 * Start the server with AUTH_DEV_BYPASS=true and the same QA origin and
 * allocator environment used for this command:
 *   pnpm tsx scripts/visual-qa.ts [baseUrl]
 * Output lands in /tmp/visual-qa/.
 *
 * Set QA_PERSON_ID to also shoot a person's card (`pnpm tsx
 * scripts/demo-people.ts` prints ids), and QA_BROWSER_PATH to use a Chromium
 * already on the machine when `playwright install` cannot reach its CDN.
 */

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  requireQaOrigin,
  restrictQaBrowserContext,
  verifyQaBrowserInstallation,
} from './visual-qa/qa-installation.js';

const base = requireQaOrigin(process.argv[2], process.env.ASSISTANT_QA_WEB_ORIGIN);
await verifyQaBrowserInstallation(base);
const outDir = '/tmp/visual-qa';
mkdirSync(outDir, { recursive: true });

const pages: Array<{ name: string; path: string; wait?: number }> = [
  { name: 'chat', path: '/chat' },
  { name: 'chat-all', path: '/chat/all' },
  { name: 'goals', path: '/goals' },
  { name: 'tasks', path: '/tasks' },
  { name: 'approvals', path: '/approvals' },
  { name: 'costs', path: '/costs' },
  { name: 'settings', path: '/settings' },
  { name: 'documents', path: '/documents' },
  { name: 'skills', path: '/skills' },
  { name: 'profile', path: '/profile' },
  { name: 'profile-about', path: '/profile/about' },
  { name: 'profile-voice', path: '/profile/voice' },
  { name: 'profile-data', path: '/profile/data' },
  { name: 'profile-memories', path: '/profile/memories' },
  { name: 'people', path: '/people' },
  // The person page needs a real id. `pnpm tsx scripts/demo-people.ts` prints
  // the ids it creates; pass one to shoot the card itself.
  ...(process.env.QA_PERSON_ID
    ? [{ name: 'person', path: `/people/${process.env.QA_PERSON_ID}` }]
    : []),
  { name: 'anomalies', path: '/anomalies' },
  { name: 'improvements', path: '/improvements' },
  { name: 'suggestions', path: '/suggestions' },
  { name: 'import', path: '/import' },
];

const viewports = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

const browser = await chromium.launch(
  process.env.QA_BROWSER_PATH ? { executablePath: process.env.QA_BROWSER_PATH } : {},
);
for (const viewport of viewports) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    serviceWorkers: 'block',
    // Cards reveal on scroll via `animation-timeline: view()`. A full-page
    // screenshot never scrolls, so without this everything below the first
    // viewport is captured at opacity 0 and the shot looks half-empty.
    reducedMotion: 'reduce',
    deviceScaleFactor: viewport.name === 'phone' ? 2 : 1,
    isMobile: viewport.name === 'phone',
    hasTouch: viewport.name === 'phone',
  });
  await restrictQaBrowserContext(context, base);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  for (const target of pages) {
    const url = `${base}${target.path}`;
    try {
      // NOT networkidle: the chat holds a long poll open against
      // /api/chat/status and opens the next one as soon as it returns, so that
      // page never goes quiet and every shot of it would burn the full
      // timeout. `load` plus the per-target settle below is what these
      // screenshots actually need.
      const response = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForTimeout(target.wait ?? 600);
      const status = response?.status() ?? 0;
      const file = `${outDir}/${viewport.name}-${target.name}.png`;
      await page.screenshot({ path: file, fullPage: true });
      console.log(
        `${status} ${viewport.name}/${target.name}${errors.length ? `  [console: ${errors[errors.length - 1]?.slice(0, 120)}]` : ''}`,
      );
      errors.length = 0;
    } catch (error) {
      console.log(`ERR ${viewport.name}/${target.name}: ${String(error).slice(0, 160)}`);
    }
  }
  await context.close();
}
await browser.close();
console.log(`\nScreenshots in ${outDir}`);
