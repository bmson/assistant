import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';

const root = process.cwd();
const webRoot = path.join(root, 'apps/web');
const componentPath = path.join(webRoot, 'app/tasks/[id]/checklist-correction-entry.tsx');
if (!existsSync(path.join(webRoot, 'package.json')) || !existsSync(componentPath)) {
  throw new Error('Run this verification from the repository root.');
}
const output = await mkdtemp(path.join(tmpdir(), 'assistant-checklist-cancellation-ui-'));
const bundleDir = path.join(output, 'bundle');
await mkdir(bundleDir, { recursive: true });
const webRequire = createRequire(path.join(webRoot, 'package.json'));
const runtimeRequire = createRequire(webRequire.resolve('tsx'));
const { build } = runtimeRequire('esbuild') as {
  build(options: Record<string, unknown>): Promise<void>;
};
const cssModule = webRequire.resolve('@tailwindcss/postcss');
const cssRequire = createRequire(cssModule);
const postcss = cssRequire('postcss') as (plugins: unknown[]) => {
  process(css: string, options: Record<string, unknown>): Promise<{ css: string }>;
};
const tailwind = cssRequire('@tailwindcss/postcss') as () => unknown;
async function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
          milliseconds,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const files = [
  'apps/web/app/tasks/[id]/checklist-correction-entry.tsx',
  'apps/web/app/tasks/[id]/checklist-cancellation-client.ts',
  'apps/web/app/tasks/[id]/checklist-correction-client.ts',
  'apps/web/app/globals.css',
];
const hashes = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(path.join(root, file)))
        .digest('hex'),
    ]),
  ),
);

await build({
  stdin: {
    loader: 'tsx',
    resolveDir: webRoot,
    contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChecklistCorrectionEntry } from './app/tasks/[id]/checklist-correction-entry';
const initial = {
  taskId: '11111111-1111-4111-8111-111111111111', ownerScope: 'synthetic-owner-scope',
  revision: 4, cancellationRevision: 2,
  items: [{id:'lookup-a',label:'Find the hotel near the central railway station in Berlin'}],
  cancellableItems: [
    {id:'lookup-a',label:'Find the hotel near the central railway station in Berlin'},
    {id:'reminder-b',label:'Remind me to check in after I arrive at the hotel'},
  ],
};
const rootNode = createRoot(document.getElementById('app'));
window.__requests = [];
window.__refreshCount = 0;
window.__mode = 'success';
window.__modePostStart = 0;
window.__held = [];
window.__setMode = (mode) => { window.__mode = mode; window.__modePostStart = window.__requests.filter(r=>r.method==='POST').length; };
window.__setProps = (props) => { window.__setPropsState?.(props); };
window.__applyProps = null;
function App() {
  const [props, setProps] = useState(initial);
  window.__setPropsState = setProps;
  window.__applyProps = setProps;
  return <ChecklistCorrectionEntry {...props} />;
}
window.__refresh = () => { window.__refreshCount += 1; };
rootNode.render(<App />);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  const method = init?.method || 'GET';
  const row = {url:url.pathname+url.search, method, body:init?.body ? JSON.parse(String(init.body)) : null};
  window.__requests.push(row);
  if (method === 'GET') return Response.json({id:initial.taskId, checklistRevision:4, cancellationRevision:2, audit:null});
  if (window.__mode === 'lost-once' && window.__requests.filter(r=>r.method==='POST').length === window.__modePostStart + 1) throw new TypeError('Synthetic lost response');
  if (window.__mode === 'hold') return new Promise((resolve) => window.__held.push({resolve, row}));
  if (window.__mode === 'stale') return Response.json({ok:false,outcome:'stale_revision'},{status:409});
  return Response.json({ok:true,outcome:'cancelled',transitioned:true,queueGeneration:3,taskId:row.body.taskId || initial.taskId,itemId:row.body.itemId,ownerMessageId:row.body.ownerMessageId,checklistRevision:row.body.expectedRevision,cancellationRevision:row.body.expectedCancellationRevision+1});
};
`,
  },
  outfile: path.join(bundleDir, 'client.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"development"',
    'process.env': '{}',
    'process.browser': 'true',
  },
  plugins: [
    {
      name: 'selected-cancellation-next-and-js-extension',
      setup(builder: {
        onResolve(
          options: { filter: RegExp },
          callback: (args: {
            path: string;
            importer: string;
            resolveDir: string;
            kind: string;
          }) => unknown,
        ): void;
        onLoad(options: { filter: RegExp; namespace: string }, callback: () => unknown): void;
        resolve(name: string, options: { kind: string; resolveDir: string }): Promise<unknown>;
      }) {
        builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
          path: 'next/navigation',
          namespace: 'next-navigation',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'next-navigation' }, () => ({
          contents: 'export const useRouter=()=>({refresh(){window.__refresh()}});',
          loader: 'js',
        }));
        builder.onResolve({ filter: /\.js$/ }, (args) => {
          if (!args.path.startsWith('.')) return null;
          const base = path.resolve(path.dirname(args.importer), args.path.slice(0, -3));
          for (const ext of ['.ts', '.tsx', '.js'])
            if (existsSync(base + ext)) return { path: base + ext };
          return null;
        });
        builder.onResolve({ filter: /^@\// }, (args) =>
          builder.resolve(path.join(webRoot, args.path.slice(2)), {
            kind: args.kind,
            resolveDir: webRoot,
          }),
        );
      },
    },
  ],
});
const cssSource = await readFile(path.join(webRoot, 'app/globals.css'), 'utf8');
const builtCss = await postcss([tailwind()]).process(cssSource, {
  from: path.join(webRoot, 'app/globals.css'),
});
await writeFile(path.join(bundleDir, 'styles.css'), builtCss.css);
await writeFile(
  path.join(bundleDir, 'index.html'),
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main id="app"></main><script type="module" src="/client.js"></script></body></html>',
);
const server = createServer(async (req, res) => {
  const file =
    req.url === '/client.js'
      ? 'client.js'
      : req.url === '/styles.css'
        ? 'styles.css'
        : 'index.html';
  res.setHeader(
    'content-type',
    file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.css')
        ? 'text/css'
        : 'text/html; charset=utf-8',
  );
  res.end(await readFile(path.join(bundleDir, file)));
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address !== 'string');
const serverOrigin = `http://127.0.0.1:${address.port}`;
let browser: Browser | null = null;
const errors: string[] = [];
const screenshots: string[] = [];
const summary: Record<string, unknown> = {
  sourceHashes: hashes,
  scriptSha256: createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex'),
  outputDir: output,
  server: `127.0.0.1:${address.port}`,
  requests: [],
  checks: [],
  screenshots,
  errors,
};
let primaryFailure: unknown;
const cleanupErrors: string[] = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 320, height: 780 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === serverOrigin ? route.continue() : route.abort(),
  );
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page
    .getByRole('button', {
      name: 'Cancel Remind me to check in after I arrive at the hotel',
      exact: true,
    })
    .waitFor();
  assert.equal(await page.locator('li').count(), 2);
  const initialWidth = await page.evaluate(() => ({
    viewport: innerWidth,
    body: document.documentElement.scrollWidth,
  }));
  assert(
    initialWidth.body <= initialWidth.viewport,
    `Initial narrow layout overflows: ${JSON.stringify(initialWidth)}`,
  );
  await page.screenshot({ path: path.join(bundleDir, '320-initial.png'), fullPage: true });
  screenshots.push('320-initial.png');
  await page
    .getByRole('button', {
      name: 'Cancel Remind me to check in after I arrive at the hotel',
      exact: true,
    })
    .click();
  await page
    .getByText(
      'Cancel “Remind me to check in after I arrive at the hotel”? Only this item will be stopped.',
    )
    .waitFor();
  await page.screenshot({ path: path.join(bundleDir, '320-confirmation.png'), fullPage: true });
  screenshots.push('320-confirmation.png');
  const geometry = await page.evaluate(() => {
    const li = [...document.querySelectorAll('li')].find((el) =>
      el.querySelector('button[aria-label^="Cancel Remind me"]'),
    );
    const label = li?.querySelector('span');
    const buttons = li?.querySelector('div');
    const confirm = [...(li?.children || [])].find(
      (el) => el.tagName === 'DIV' && el.textContent?.includes('Only this item'),
    );
    return {
      li: li?.getBoundingClientRect().toJSON(),
      label: label?.getBoundingClientRect().toJSON(),
      buttons: buttons?.getBoundingClientRect().toJSON(),
      confirm: confirm?.getBoundingClientRect().toJSON(),
      grid: li ? getComputedStyle(li).display : null,
      bodyWidth: document.documentElement.scrollWidth,
      viewport: innerWidth,
    };
  });
  assert.equal(geometry.grid, 'grid');
  assert(geometry.confirm, 'Expanded confirmation must be measured in the selected item row');
  assert(geometry.bodyWidth <= geometry.viewport, 'Confirmation layout must not overflow viewport');
  summary.narrowConfirmationGeometry = geometry;
  summary.checks.push(
    'Mounted labeled items, 320px layout, explicit single-item confirmation, no horizontal overflow.',
  );

  await page.evaluate(() => window.__setMode('success'));
  await page.getByRole('button', { name: 'Cancel this item', exact: true }).click();
  await page.getByText('Cancellation confirmed.', { exact: true }).waitFor();
  const firstPost = await page.evaluate(
    () => window.__requests.filter((r) => r.method === 'POST')[0],
  );
  assert(firstPost && firstPost.body.action === 'cancel-checklist');
  assert.equal(firstPost.body.itemId, 'reminder-b');
  assert.equal(firstPost.body.expectedRevision, 4);
  assert.equal(firstPost.body.expectedCancellationRevision, 2);
  assert.match(firstPost.body.ownerMessageId, /^[0-9a-f-]{36}$/i);
  assert.equal(
    await page.evaluate(() => window.__refreshCount),
    1,
    'A confirmed cancellation refreshes the Activity projection.',
  );
  assert.equal(
    await page.getByText('Find the hotel near the central railway station in Berlin').count(),
    1,
    'A must remain visible after B cancellation',
  );
  assert.equal(
    await page.locator('li').count(),
    2,
    'UI does not optimistically remove B before the refreshed projection',
  );
  summary.checks.push(
    'Owner confirms B only; A remains visible, request uses exact current revisions and stable UUID.',
  );

  await page.evaluate(() =>
    window.__applyProps({
      taskId: '11111111-1111-4111-8111-111111111111',
      ownerScope: 'synthetic-owner-scope',
      revision: 4,
      cancellationRevision: 3,
      items: [
        { id: 'lookup-a', label: 'Find the hotel near the central railway station in Berlin' },
      ],
      cancellableItems: [
        { id: 'lookup-a', label: 'Find the hotel near the central railway station in Berlin' },
      ],
    }),
  );
  await page
    .getByRole('button', {
      name: 'Cancel Find the hotel near the central railway station in Berlin',
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByText('Remind me to check in after I arrive at the hotel').count(),
    0,
    'Refreshed server projection removes only canceled B',
  );
  summary.checks.push(
    'Synthetic router refresh removes canceled B while retained A remains actionable.',
  );

  await page.evaluate(() =>
    window.__applyProps({
      taskId: '11111111-1111-4111-8111-111111111111',
      ownerScope: 'synthetic-owner-scope',
      revision: 4,
      cancellationRevision: 3,
      items: [
        { id: 'lookup-a', label: 'Find the hotel near the central railway station in Berlin' },
      ],
      cancellableItems: [
        { id: 'lookup-a', label: 'Find the hotel near the central railway station in Berlin' },
        { id: 'reminder-b', label: 'Remind me to check in after I arrive at the hotel' },
      ],
    }),
  );
  await page.evaluate(() => window.__setMode('lost-once'));
  await page
    .getByRole('button', {
      name: 'Cancel Remind me to check in after I arrive at the hotel',
      exact: true,
    })
    .click();
  await page.getByRole('button', { name: 'Cancel this item', exact: true }).click();
  await page
    .getByRole('button', { name: 'Try the same cancellation again', exact: true })
    .waitFor();
  const afterLost = await page.evaluate(
    () => window.__requests.filter((r) => r.method === 'POST').length,
  );
  const gets = await page.evaluate(() => window.__requests.filter((r) => r.method === 'GET'));
  assert.equal(afterLost, 2);
  assert.equal(gets.length, 1, 'Ambiguous POST performs one exact audit read');
  assert(gets[0].url.includes('cancellationOwnerMessageId='));
  assert.equal(await page.getByText('Saving', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Try the same cancellation again', exact: true }).click();
  await page.getByText('Cancellation confirmed.', { exact: true }).waitFor();
  const posts = await page.evaluate(() => window.__requests.filter((r) => r.method === 'POST'));
  assert.equal(posts.length, 3);
  assert.equal(
    posts[1].body.ownerMessageId,
    posts[2].body.ownerMessageId,
    'Retry reuses the same operation identity',
  );
  assert.equal(
    await page.evaluate(() => window.__refreshCount),
    2,
    'A confirmed same-operation retry refreshes the Activity projection.',
  );
  summary.checks.push(
    'Unknown POST stays reconcilable; exact audit GET, visible retry, and same UUID replay are used.',
  );

  await page.evaluate(() =>
    window.__applyProps({
      taskId: '11111111-1111-4111-8111-111111111111',
      ownerScope: 'synthetic-owner-scope',
      revision: 5,
      cancellationRevision: 4,
      items: [
        { id: 'lookup-a', label: 'Find the hotel near the central railway station in Berlin' },
      ],
      cancellableItems: [
        { id: 'lookup-a', label: 'Find the hotel near the central railway station in Berlin' },
        { id: 'reminder-b', label: 'Remind me to check in after I arrive at the hotel' },
      ],
    }),
  );
  await page.evaluate(() => window.__setMode('stale'));
  await page
    .getByRole('button', {
      name: 'Cancel Remind me to check in after I arrive at the hotel',
      exact: true,
    })
    .click();
  await page.getByRole('button', { name: 'Cancel this item', exact: true }).click();
  await page
    .getByText('This request changed while the page was open. Refresh Activity and review it.')
    .waitFor();
  summary.checks.push('A stale revision refusal is shown; it is not retried as a write.');

  await page.evaluate(() =>
    window.__applyProps({
      taskId: '11111111-1111-4111-8111-111111111111',
      ownerScope: 'synthetic-owner-scope',
      revision: 5,
      cancellationRevision: 4,
      items: [
        { id: 'lookup-a', label: 'Find the hotel near the central railway station in Berlin' },
      ],
      cancellableItems: [
        { id: 'lookup-a', label: 'Find the hotel near the central railway station in Berlin' },
        { id: 'reminder-b', label: 'Remind me to check in after I arrive at the hotel' },
      ],
    }),
  );
  await page.evaluate(() => window.__setMode('hold'));
  await page
    .getByRole('button', {
      name: 'Cancel Remind me to check in after I arrive at the hotel',
      exact: true,
    })
    .click();
  await page.getByRole('button', { name: 'Cancel this item', exact: true }).click();
  await page.waitForFunction(
    () => window.__requests.filter((r) => r.method === 'POST').length === 5,
  );
  const beforeSwap = await page.evaluate(
    () => window.__requests.filter((r) => r.method === 'POST').length,
  );
  await page.evaluate(() =>
    window.__applyProps({
      taskId: '11111111-1111-4111-8111-111111111111',
      ownerScope: 'replacement-owner-scope',
      revision: 6,
      cancellationRevision: 4,
      items: [
        { id: 'lookup-a', label: 'Find the hotel near the central railway station in Berlin' },
      ],
      cancellableItems: [
        { id: 'lookup-a', label: 'Find the hotel near the central railway station in Berlin' },
        { id: 'reminder-b', label: 'Remind me to check in after I arrive at the hotel' },
      ],
    }),
  );
  const held = await page.evaluate(() => window.__held.at(-1)?.row.body);
  assert(held, 'Expected the old operation body to remain held');
  await page.evaluate((body) => {
    const held = window.__held.at(-1);
    held.resolve(
      Response.json({
        ok: true,
        outcome: 'cancelled',
        transitioned: true,
        queueGeneration: 7,
        taskId: body.taskId,
        itemId: body.itemId,
        ownerMessageId: body.ownerMessageId,
        checklistRevision: body.expectedRevision,
        cancellationRevision: body.expectedCancellationRevision + 1,
      }),
    );
  }, held);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  assert.equal(
    await page.getByText('Cancellation confirmed.', { exact: true }).count(),
    0,
    'Late old-scope receipt must not confirm in replacement scope',
  );
  assert.equal(await page.locator('li').count(), 2);
  assert.equal(
    await page.evaluate(() => window.__requests.filter((r) => r.method === 'POST').length),
    beforeSwap,
    'Changing owner/revision does not create another write',
  );
  summary.checks.push('Held old-owner/revision response is ignored after scope replacement.');

  await page.setViewportSize({ width: 1024, height: 800 });
  await page.evaluate(() =>
    window.__applyProps({
      taskId: '11111111-1111-4111-8111-111111111111',
      ownerScope: 'wide-scope',
      revision: 6,
      cancellationRevision: 4,
      items: [{ id: 'lookup-a', label: 'Find a hotel '.repeat(20) }],
      cancellableItems: [
        { id: 'lookup-a', label: 'Find a hotel '.repeat(20) },
        { id: 'reminder-b', label: 'Remind me '.repeat(20) },
      ],
    }),
  );
  await page
    .getByRole('button', { name: `Cancel ${'Remind me '.repeat(20)}`, exact: true })
    .waitFor();
  await page
    .getByRole('button', { name: `Cancel ${'Remind me '.repeat(20)}`, exact: true })
    .click();
  await page.getByText(/Only this item will be stopped\./).waitFor();
  const wide = await page.evaluate(() => {
    const li = [...document.querySelectorAll('li')].find((el) =>
      el.querySelector('button[aria-label^="Cancel Remind me"]'),
    );
    const confirm = [...(li?.children || [])].find(
      (el) => el.tagName === 'DIV' && el.textContent?.includes('Only this item'),
    );
    return {
      li: li?.getBoundingClientRect().toJSON(),
      confirm: confirm?.getBoundingClientRect().toJSON(),
      grid: li ? getComputedStyle(li).display : null,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.equal(wide.grid, 'grid');
  assert.equal(wide.overflow, false);
  assert(
    wide.confirm && wide.li && wide.confirm.x >= wide.li.x && wide.confirm.right <= wide.li.right,
    'Confirmation spans within the full responsive row',
  );
  summary.wideConfirmationGeometry = wide;
  await page.screenshot({
    path: path.join(bundleDir, '1024-long-confirmation.png'),
    fullPage: true,
  });
  screenshots.push('1024-long-confirmation.png');
  assert.deepEqual(errors, []);
  summary.requests = await page.evaluate(() => window.__requests);
  summary.status = 'passed';
} catch (error) {
  primaryFailure = error;
  summary.status = 'failed';
  summary.failure = String(error);
  summary.requests = browser
    ? ((await browser
        .contexts()[0]
        ?.pages()[0]
        ?.evaluate(() => window.__requests)
        .catch(() => [])) ?? [])
    : [];
} finally {
  if (browser) {
    try {
      await withDeadline(browser.close(), 5_000, 'Browser close');
      summary.browserClosed = true;
    } catch (error) {
      cleanupErrors.push(`browser: ${String(error)}`);
    }
  }
  if (server.listening) {
    try {
      server.closeAllConnections();
      await withDeadline(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        5_000,
        'Loopback server close',
      );
      summary.serverClosed = true;
    } catch (error) {
      cleanupErrors.push(`server: ${String(error)}`);
    }
  }
  if (cleanupErrors.length) summary.cleanupErrors = cleanupErrors;
  const resultPath = path.join(output, 'result.json');
  await writeFile(resultPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Evidence: ${resultPath}`);
}
if (primaryFailure && cleanupErrors.length) {
  throw new AggregateError(
    [primaryFailure, ...cleanupErrors.map((message) => new Error(message))],
    'Verification and cleanup failed',
  );
}
if (primaryFailure) throw primaryFailure;
if (cleanupErrors.length)
  throw new AggregateError(
    cleanupErrors.map((message) => new Error(message)),
    'Verification cleanup failed',
  );
