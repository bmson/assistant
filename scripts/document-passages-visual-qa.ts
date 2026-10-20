/** Actual passage UI against controlled loopback GET responses; no owner or storage I/O. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? '.workspace/passage-recovery');
const before = process.argv.includes('--before');
const web = createRequire(path.join(root, 'apps/web/package.json'));
const runtime = createRequire(path.join(root, 'package.json'));
const { build } = createRequire(runtime.resolve('tsx'))('esbuild');
const postcss = createRequire(web.resolve('@tailwindcss/postcss'))('postcss');
const tailwind = web('@tailwindcss/postcss');
await mkdir(output, { recursive: true });
const component = 'apps/web/app/documents/document-passages.tsx';
const sourceFiles = [
  component,
  'apps/web/lib/document-passage-state.ts',
  'apps/web/lib/ui.tsx',
  'apps/web/app/globals.css',
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(path.join(root, file)))
        .digest('hex'),
    ]),
  ),
);
const entry = `import React from ${JSON.stringify(web.resolve('react'))};
import {createRoot} from ${JSON.stringify(web.resolve('react-dom/client'))};
import {DocumentPassages} from ${JSON.stringify(path.join(root, component))};
createRoot(document.getElementById('fixture')).render(React.createElement(DocumentPassages,{documentId:'synthetic-document',total:101}));`;
const javascript = (
  await build({
    stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    tsconfig: path.join(root, 'apps/web/tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
  })
).outputFiles[0].text;
const cssPath = path.join(root, 'apps/web/app/globals.css');
const css = (
  await postcss([tailwind({ base: path.join(root, 'apps/web') })]).process(
    await readFile(cssPath, 'utf8'),
    { from: cssPath },
  )
).css;
type Scenario = 'pagination' | 'initial' | 'conflict' | 'opaque';
let scenario: Scenario = 'pagination';
let requests: string[] = [];
let release: (() => void) | null = null;
const opaque = 'passage:0?offset=10&version=synthetic';
const chunks = (start: number, length: number) =>
  Array.from({ length }, (_, index) => ({
    chunkIndex: start + index,
    text: `Passage proof ${start + index + 1}. Retained document content.`,
    charCount: 50,
  }));
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  if (url.pathname === '/client.js') {
    response.setHeader('content-type', 'text/javascript');
    response.end(javascript);
    return;
  }
  if (url.pathname === '/style.css') {
    response.setHeader('content-type', 'text/css');
    response.end(css);
    return;
  }
  if (url.pathname === '/api/documents/synthetic-document') {
    const cursor = url.searchParams.get('cursor') ?? '';
    requests.push(cursor);
    const attempts = requests.filter((value) => value === cursor).length;
    response.setHeader('content-type', 'application/json');
    const failing =
      (scenario === 'initial' && cursor === '0' && attempts === 1) ||
      (scenario !== 'initial' &&
        cursor === (scenario === 'opaque' ? opaque : '50') &&
        attempts === 1);
    if (failing) {
      response.statusCode = scenario === 'conflict' ? 409 : 503;
      response.end(
        JSON.stringify({
          error:
            scenario === 'conflict'
              ? { code: 'document_changed', message: 'Synthetic version conflict' }
              : 'Temporary document service unavailable. Try again.',
        }),
      );
      return;
    }
    // Hold retries so synchronous repeated activation and Hide/Read cannot hide duplicates.
    if (requests.length > 1 && cursor !== '100') {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    if (scenario === 'opaque') {
      const first = cursor === '0';
      response.end(
        JSON.stringify({
          chunks: [
            {
              chunkIndex: 0,
              text: first ? 'Beginning ' : 'complete.',
              charCount: first ? 10 : 9,
              fragment: { offset: first ? 0 : 10, totalChars: 19, complete: !first },
            },
          ],
          nextCursor: first ? opaque : null,
          totalChunks: 1,
        }),
      );
    } else {
      const start = Number(cursor);
      response.end(
        JSON.stringify({
          chunks: chunks(start, start === 100 ? 1 : 50),
          nextCursor: start === 100 ? null : start + 50,
          totalChunks: 101,
        }),
      );
    }
    return;
  }
  response.setHeader('content-type', 'text/html');
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="min-h-dvh bg-surface font-sans text-strong antialiased"><main class="page-gutter mx-auto min-w-0 max-w-4xl py-7 sm:py-10"><h1>Document passages</h1><div id="fixture"></div></main><script src="/client.js"></script></body></html>`,
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results: Record<string, unknown>[] = [];
const errors: string[] = [];
async function capture(page: Page, name: string) {
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  return `${name}.png`;
}
function resumeRequest() {
  assert(release);
  const resume = release;
  release = null;
  resume();
}
async function waitForRelease() {
  for (let attempt = 0; attempt < 100 && !release; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert(release, 'Controlled retry request must reach the local server');
}
try {
  for (const profile of [
    { width: 390, fontSize: 16, scheme: 'light' },
    { width: 390, fontSize: 16, scheme: 'dark' },
    { width: 320, fontSize: 32, scheme: 'light' },
    { width: 320, fontSize: 32, scheme: 'dark' },
  ] as const) {
    for (const nextScenario of before
      ? (['pagination'] as const)
      : (['pagination', 'initial', 'conflict', 'opaque'] as const)) {
      scenario = nextScenario;
      requests = [];
      release = null;
      const page = await browser.newPage({
        viewport: { width: profile.width, height: 844 },
        colorScheme: profile.scheme,
        reducedMotion: 'reduce',
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        errors.push(`Unexpected external request: ${route.request().url()}`);
        return route.abort();
      });
      const prefix = `${scenario}-${profile.width}-${profile.fontSize}-${profile.scheme}`;
      await page.goto(`${origin}/documents`);
      await page.evaluate(({ fontSize, scheme }) => {
        document.documentElement.style.fontSize = `${fontSize}px`;
        document.documentElement.classList.toggle('dark', scheme === 'dark');
      }, profile);
      await page.getByRole('button', { name: 'Read passages', exact: true }).click();
      if (scenario !== 'initial') {
        await page.locator('article').first().waitFor();
        await page.getByRole('button', { name: 'Load more', exact: true }).click();
      }
      const status = page.getByRole('status');
      await status.waitFor();
      await status.scrollIntoViewIfNeeded();
      if (!before) {
        const retry = page.getByRole('button', { name: 'Retry loading passages', exact: true });
        await retry.scrollIntoViewIfNeeded();
        const bounds = await retry.boundingBox();
        assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= profile.width);
        assert(bounds.y >= 0 && bounds.y + bounds.height <= 844);
      }
      const retained = await page.locator('article').allTextContents();
      const failureScreenshot = await capture(page, `${prefix}-failed`);
      assert.equal(retained.length, scenario === 'pagination' ? 50 : scenario === 'opaque' ? 1 : 0);
      await page.getByRole('button', { name: 'Hide passages', exact: true }).click();
      await page.getByRole('button', { name: 'Read passages', exact: true }).click();
      if (before) {
        assert.equal(await page.getByRole('button', { name: /Retry/ }).count(), 0);
        assert.deepEqual(requests, ['0', '50']);
        assert.equal(await page.getByRole('button').count(), 1);
        results.push({
          profile,
          scenario,
          expectedDeadEnd: true,
          requests: [...requests],
          failureScreenshot,
        });
        await page.close();
        continue;
      }
      // With no retained chunks, reopening already retries zero. Other paths expose Retry.
      if (scenario === 'initial' || scenario === 'conflict') {
        await waitForRelease();
      } else {
        const retry = page.getByRole('button', { name: 'Retry loading passages', exact: true });
        await retry.waitFor();
        assert.equal(await retry.getAttribute('aria-describedby'), await status.getAttribute('id'));
        await page.getByRole('button', { name: 'Hide passages', exact: true }).focus();
        await page.keyboard.press('Tab');
        assert.equal(await retry.evaluate((button) => button === document.activeElement), true);
        await page.keyboard.press('Enter');
        await waitForRelease();
      }
      const beforeDuplicateActivation = requests.length;
      const pending = page.getByRole('button', { name: 'Loading…', exact: true });
      assert.equal(await pending.isDisabled(), true);
      // Synchronous DOM events deliberately exercise the guard separately from native keyboard Retry.
      await pending.evaluate((button) => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.getByRole('button', { name: 'Hide passages', exact: true }).click();
      await page.getByRole('button', { name: 'Read passages', exact: true }).click();
      assert.equal(requests.length, beforeDuplicateActivation);
      assert.deepEqual(await page.locator('article').allTextContents(), retained);
      resumeRequest();
      await status.waitFor({ state: 'detached' });
      if (scenario === 'opaque') {
        await page.getByText('Beginning complete.', { exact: true }).waitFor();
        assert.equal(await page.locator('article').count(), 1);
        assert.deepEqual(requests, ['0', opaque, opaque]);
      } else {
        const loadMore = page.getByRole('button', { name: 'Load more', exact: true });
        await loadMore.waitFor();
        if (scenario === 'pagination') {
          assert.equal(await page.locator('article').count(), 100);
          assert.deepEqual(
            (await page.locator('article').allTextContents()).slice(0, 50),
            retained,
          );
          assert.deepEqual(requests, ['0', '50', '50']);
          await loadMore.click();
          await page
            .getByText('Passage proof 101. Retained document content.', { exact: true })
            .waitFor();
          assert.equal(await page.locator('article').count(), 101);
          assert.deepEqual(requests, ['0', '50', '50', '100']);
        } else {
          assert.equal(await page.locator('article').count(), 50);
          assert.deepEqual(requests, scenario === 'initial' ? ['0', '0'] : ['0', '50', '0']);
        }
      }
      const headings = await page.locator('article h4').allTextContents();
      assert.equal(new Set(headings).size, headings.length);
      await page.locator('article').last().scrollIntoViewIfNeeded();
      const successScreenshot = await capture(page, `${prefix}-recovered`);
      results.push({
        profile,
        scenario,
        requests: [...requests],
        retainedCount: retained.length,
        finalCount: headings.length,
        duplicateActivationAddsRequests: false,
        keyboardRetry: scenario === 'pagination' || scenario === 'opaque',
        errorCleared: (await status.count()) === 0,
        failureScreenshot,
        successScreenshot,
      });
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'observations.json'),
    `${JSON.stringify(
      {
        before,
        sourceHashes,
        harnessSha256: createHash('sha256')
          .update(await readFile(fileURLToPath(import.meta.url)))
          .digest('hex'),
        boundary:
          'Actual DocumentPassages/React client and CSS, controlled loopback GET responses only. No authenticated route, owner data, database, storage writes or provider. Native Tab/Return Retry in retained numeric/opaque paths; duplicate event activation separately synthetic.',
        errors,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ output, before, passed: results.length }));
} finally {
  if (release) resumeRequest();
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
