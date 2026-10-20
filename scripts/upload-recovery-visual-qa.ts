/** Actual upload UI, synthetic loopback multipart responses; no owner/storage/provider calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? '.workspace/upload-recovery');
await mkdir(output, { recursive: true });
const req = createRequire(path.join(root, 'package.json'));
const web = createRequire(path.join(root, 'apps/web/package.json'));
const { build } = createRequire(req.resolve('tsx'))('esbuild');
const postcss = createRequire(web.resolve('@tailwindcss/postcss'))('postcss');
const tailwind = web('@tailwindcss/postcss');
const sourceFiles = [
  'apps/web/app/upload-panel.tsx',
  'apps/web/app/upload-request.ts',
  'apps/web/app/api/documents/upload/route.ts',
  'apps/web/app/api/import/upload/route.ts',
  'apps/web/lib/ui.tsx',
  'apps/web/app/globals.css',
] as const;
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
import {UploadPanel} from ${JSON.stringify(path.join(root, sourceFiles[0]))};
const kind=location.pathname.slice(1);createRoot(document.getElementById('fixture')).render(React.createElement(UploadPanel,{title:kind==='documents'?'Upload a document':'Upload an archive',action:'/api/'+kind+'/upload',submitLabel:kind==='documents'?'Upload':'Upload and import',labelSummary:'Optional label',labelName:kind==='documents'?'title':'source',labelCaption:'Label',labelPlaceholder:'Review label',hint:'Files can be up to 25MB.'}));`;
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
type Scenario = 'validation' | 'oversize' | 'network' | 'server' | 'auth';
let scenario: Scenario = 'validation';
let calls: { kind: string; accept: string; fileName: string; content: string; label: string }[] =
  [];
let release: (() => void) | null = null;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'POST' && /^\/api\/(documents|import)\/upload$/.test(url.pathname)) {
    const kind = url.pathname.split('/')[2] ?? '';
    const buffers = [];
    for await (const buffer of request) buffers.push(Buffer.from(buffer));
    const multipart = await new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': request.headers['content-type'] ?? '' },
      body: Buffer.concat(buffers),
    }).formData();
    const file = multipart.get('file');
    assert(file instanceof File);
    calls.push({
      kind,
      accept: request.headers.accept ?? '',
      fileName: file.name,
      content: await file.text(),
      label: String(multipart.get(kind === 'documents' ? 'title' : 'source')),
    });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    if (calls.length === 1) {
      response.statusCode =
        scenario === 'oversize'
          ? 413
          : scenario === 'validation'
            ? 400
            : scenario === 'auth'
              ? 401
              : 503;
      response.setHeader('content-type', scenario === 'server' ? 'text/html' : 'application/json');
      response.end(
        scenario === 'server'
          ? '<html>Temporary server failure</html>'
          : JSON.stringify({ error: 'Synthetic rejection' }),
      );
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ redirectTo: `/${kind}?uploaded=synthetic` }));
    }
    return;
  }
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
  response.setHeader('content-type', 'text/html');
  response.end(
    url.search
      ? '<!doctype html><html><body><h1>Upload received</h1></body></html>'
      : '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="min-h-dvh bg-surface font-sans text-strong antialiased"><main class="page-gutter mx-auto min-w-0 max-w-4xl py-7 sm:py-10"><h1>Upload recovery</h1><div id="fixture"></div></main><script src="/client.js"></script></body></html>',
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function waitForRequest() {
  for (let attempt = 0; attempt < 100 && !release; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert(release, 'Controlled request must reach the loopback server');
}
function resume() {
  assert(release);
  const next = release;
  release = null;
  next();
}
const errors: string[] = [];
const results: Record<string, unknown>[] = [];
try {
  for (const kind of ['documents', 'import'])
    for (const profile of [
      { width: 390, fontSize: 16, scheme: 'light' },
      { width: 320, fontSize: 32, scheme: 'dark' },
    ] as const)
      for (const nextScenario of ['validation', 'oversize', 'network', 'server', 'auth'] as const) {
        scenario = nextScenario;
        calls = [];
        release = null;
        const page = await browser.newPage({
          viewport: { width: profile.width, height: 844 },
          colorScheme: profile.scheme,
          reducedMotion: 'reduce',
        });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (
            url.origin === origin &&
            request.method() === 'POST' &&
            scenario === 'network' &&
            calls.length === 0
          ) {
            const body = request.postDataBuffer();
            assert(body);
            const form = await new Request(request.url(), {
              method: 'POST',
              headers: { 'content-type': request.headers()['content-type'] ?? '' },
              body: new Uint8Array(body).buffer,
            }).formData();
            const file = form.get('file');
            assert(file instanceof File);
            calls.push({
              kind,
              accept: request.headers().accept ?? '',
              fileName: file.name,
              content: await file.text(),
              label: String(form.get(kind === 'documents' ? 'title' : 'source')),
            });
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            await route.abort('internetdisconnected');
            return;
          }
          if (url.origin === origin) return route.continue();
          errors.push(`Unexpected external request: ${route.request().url()}`);
          return route.abort();
        });
        await page.goto(`${origin}/${kind}`);
        await page.evaluate(({ fontSize, scheme }) => {
          document.documentElement.style.fontSize = `${fontSize}px`;
          document.documentElement.classList.toggle('dark', scheme === 'dark');
        }, profile);
        const file = page.getByLabel('File to upload', { exact: true });
        await file.setInputFiles({
          name: 'synthetic-review.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Synthetic upload fixture.'),
        });
        await page.getByText('Optional label', { exact: true }).click();
        const label = page.getByRole('textbox', { name: 'Label', exact: true });
        await label.fill('Preserved review label');
        await page
          .getByRole('button', {
            name: kind === 'documents' ? 'Upload' : 'Upload and import',
            exact: true,
          })
          .click();
        await waitForRequest();
        assert.equal(await file.isDisabled(), true);
        assert.equal(await label.isDisabled(), true);
        assert.equal(
          await page.getByRole('button', { name: 'Uploading…', exact: true }).isDisabled(),
          true,
        );
        // Deliberately invoke native submit twice while fields are disabled to test the synchronous guard.
        await page.locator('form').evaluate((form) => {
          if (!(form instanceof HTMLFormElement)) throw new Error('Expected upload form');
          form.requestSubmit();
          form.requestSubmit();
        });
        assert.equal(calls.length, 1);
        resume();
        const alert = page.getByRole('alert');
        await alert.waitFor();
        assert.equal(page.url(), `${origin}/${kind}`);
        assert.equal(await label.inputValue(), 'Preserved review label');
        assert.equal(
          await file.evaluate((input) =>
            input instanceof HTMLInputElement ? input.files?.[0]?.name : null,
          ),
          'synthetic-review.txt',
        );
        assert.equal(
          await page.getByRole('link', { name: 'Refresh list' }).getAttribute('href'),
          `/${kind}`,
        );
        const message = await alert.innerText();
        const prefix = `${kind}-${scenario}-${profile.width}-${profile.fontSize}-${profile.scheme}`;
        await alert.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(output, `${prefix}-error.png`),
          animations: 'disabled',
        });
        await file.focus();
        await page.keyboard.press('Tab');
        const retry = page.getByRole('button', { name: 'Retry upload', exact: true });
        assert.equal(await retry.evaluate((button) => button === document.activeElement), true);
        await page.keyboard.press('Enter');
        await waitForRequest();
        assert.equal(await alert.count(), 0);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1], calls[0]);
        assert(calls[1]);
        assert.equal(calls[1].accept, 'application/json');
        const navigation = page.waitForURL(`${origin}/${kind}?uploaded=synthetic`);
        resume();
        await navigation;
        await page.getByRole('heading', { name: 'Upload received' }).waitFor();
        await page.screenshot({
          path: path.join(output, `${prefix}-success.png`),
          animations: 'disabled',
        });
        results.push({
          kind,
          scenario,
          profile,
          message,
          calls: [...calls],
          fileAndLabelPreserved: true,
          duplicatePendingSubmitAddsRequests: false,
          nativeKeyboardRetry: true,
          destination: page.url().replace(origin, ''),
          errorScreenshot: `${prefix}-error.png`,
          successScreenshot: `${prefix}-success.png`,
        });
        await page.close();
      }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'observations.json'),
    `${JSON.stringify(
      {
        sourceHashes,
        harnessSha256: createHash('sha256')
          .update(await readFile(fileURLToPath(import.meta.url)))
          .digest('hex'),
        boundary:
          'Actual client UploadPanel/helper/CSS with loopback synthetic multipart requests and controlled failure/success responses. Small synthetic file; real server size/type validation, authenticated route admission and storage writes are not exercised. Native route success/denial contracts tested separately in unit fixtures. Error screenshots do not certify preexisting main-base enlarged input geometry.',
        errors,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ output, passed: results.length }));
} finally {
  if (release) resume();
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
