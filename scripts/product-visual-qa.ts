/** Retained source-component screenshots. No Next route, owner account, database, or model. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page, type PageScreenshotOptions } from 'playwright';
import {
  requireCurrentVisualCoverage,
  type VisualCaptureReceipt,
  type VisualEvidenceMode,
  visualCaptureFreshness,
  visualCaptureReceipt,
  visualHash,
} from './visual-capture-provenance.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const before = process.argv.includes('--before');
const chatStates = process.argv.includes('--chat-states');
const hydrateChat = process.argv.includes('--hydrate-chat') || chatStates;
const longChat = process.argv.includes('--long-chat');
const cardChat = process.argv.find((arg) => arg.startsWith('--chat-card='))?.slice(12) ?? '';
if (cardChat && !['only', 'with-prose', 'agenda', 'image'].includes(cardChat))
  throw new Error('Unknown card-chat fixture');
const narrow = process.argv.includes('--narrow');
const rootFontSize = process.argv.includes('--large-text') ? 32 : 16;
const captureWidths = narrow ? [320] : hydrateChat ? [390] : [1280, 390];
const staticLargeText = rootFontSize > 16 && !hydrateChat;
if (before && hydrateChat) throw new Error('Keep the before chat baseline static');
const destination = process.argv.find((arg, index) => index > 1 && !arg.startsWith('--'));
const output = path.resolve(
  destination ??
    path.join(
      root,
      '.workspace/ui-review-2026-10-03',
      before
        ? 'before-products'
        : chatStates
          ? 'hydrated-chat-states'
          : hydrateChat
            ? 'hydrated-chat'
            : 'after-products',
    ),
);
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const tsxRequire = createRequire(webRequire.resolve('tsx'));
type BundleArgs = { path: string; kind: string; resolveDir: string };
type BundleContext = {
  onResolve(options: { filter: RegExp }, callback: (args: BundleArgs) => unknown): void;
  onLoad(
    options: { filter: RegExp; namespace: string },
    callback: (args: BundleArgs) => unknown,
  ): void;
  resolve(value: string, options: { kind: string; resolveDir: string }): Promise<unknown>;
};
const { build } = tsxRequire('esbuild') as {
  build(
    options: Record<string, unknown> & {
      plugins: Array<{ name: string; setup(builder: BundleContext): void }>;
    },
  ): Promise<void>;
};
const tailwindRequire = createRequire(webRequire.resolve('@tailwindcss/postcss'));
const postcss = tailwindRequire('postcss');
const tailwind = webRequire('@tailwindcss/postcss');
await mkdir(output, { recursive: true });
async function componentInputHash(): Promise<string> {
  const componentDirectories = before
    ? ['.workspace/ui-review-2026-10-03/baseline']
    : [
        'apps/web/app',
        'apps/web/lib',
        'apps/web/public',
        ...(await readdir(path.join(root, 'packages'))).map((name) => `packages/${name}/src`),
      ];
  const componentFiles = (
    await Promise.all(
      componentDirectories.map(async (directory) =>
        (
          await readdir(path.join(root, directory), { recursive: true }).catch(() => [])
        )
          .filter((name) => /\.(?:ts|tsx|css|svg|png|woff2?|ttf)$/.test(name))
          .map((name) => `${directory}/${name}`),
      ),
    )
  )
    .flat()
    .sort();
  return visualHash(
    JSON.stringify(
      await Promise.all(
        componentFiles.map(async (file) => [
          file,
          visualHash(await readFile(path.join(root, file))),
        ]),
      ),
    ),
  );
}
const componentSha256 = await componentInputHash();
const fixture = process.argv.includes('--reuse-html')
  ? null
  : spawnSync('pnpm', ['exec', 'vitest', 'run', 'apps/web/app/product-visual-fixture.test.tsx'], {
      cwd: root,
      env: {
        ...process.env,
        PRODUCT_VISUAL_QA_DIR: output,
        PRODUCT_VISUAL_QA_BEFORE: before ? '1' : '0',
        PRODUCT_VISUAL_QA_CHAT: hydrateChat ? '1' : '0',
        PRODUCT_VISUAL_QA_CHAT_STATES: chatStates ? '1' : '0',
        PRODUCT_VISUAL_QA_LONG_CHAT: longChat ? '1' : '0',
        PRODUCT_VISUAL_QA_CARD_CHAT: cardChat,
      },
      encoding: 'utf8',
    });
if (fixture && fixture.status !== 0) throw new Error(`${fixture.stdout}\n${fixture.stderr}`);
const sourceCss = before
  ? path.join(root, '.workspace/ui-review-2026-10-03/baseline/globals.css')
  : path.join(root, 'apps/web/app/globals.css');
const sourceHash = createHash('sha256')
  .update(await readFile(sourceCss))
  .digest('hex');
const css = await postcss([tailwind({ base: path.join(root, 'apps/web') })]).process(
  await readFile(sourceCss, 'utf8'),
  { from: path.join(root, 'apps/web/app/globals.css') },
);
await writeFile(path.join(output, 'style.css'), css.css);
// Next imports this global sheet from the retained conversation page only.
// The frozen BEFORE correctly lacks it; do not silently repair that baseline.
if (
  !before &&
  !(await readFile(path.join(root, 'apps/web/app/chat/conversation-page.tsx'), 'utf8')).match(
    /import\s+['"]\.\.\/conversation\.css['"]/,
  )
)
  throw new Error('The retained conversation page no longer imports its stylesheet');
const conversationCss = before
  ? null
  : await readFile(path.join(root, 'apps/web/app/conversation.css'), 'utf8');
const conversationHash =
  conversationCss === null ? null : createHash('sha256').update(conversationCss).digest('hex');
if (conversationCss !== null)
  await writeFile(path.join(output, 'conversation.css'), conversationCss);
if (!before)
  await build({
    stdin: {
      contents: `import React from 'react'; import { hydrateRoot } from 'react-dom/client';
import { SkillsPanel } from './app/skills/skills-panel';
import { VoiceProfileForm } from './app/profile/voice-profile-form';
import { RepairPanel } from './app/improvements/repair-panel';
${hydrateChat ? "import { ChatClient } from './app/chat/[id]/chat-client';" : ''}
const components = { skills: SkillsPanel, voice: VoiceProfileForm, repairs: RepairPanel${hydrateChat ? ', chat: ChatClient' : ''} };
for (const host of document.querySelectorAll('[data-qa-product]')) {
const name = host.dataset.qaProduct; const Component = components[name];
if (Component) hydrateRoot(host, <Component {...JSON.parse(host.dataset.qaProps)} />, { identifierPrefix: 'qa-product-' + name + '-', onRecoverableError(error) { window.__qaHydrationErrors = [...(window.__qaHydrationErrors || []), error.message]; } });
}`,
      resolveDir: path.join(root, 'apps/web'),
      sourcefile: 'product-client-preview.tsx',
      loader: 'tsx',
    },
    outfile: path.join(output, 'client.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    jsx: 'automatic',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [
      {
        name: 'synthetic-product-actions',
        setup(builder) {
          builder.onResolve({ filter: /^next\/navigation$/ }, (args) => ({
            path: args.path,
            namespace: 'qa-product-navigation',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'qa-product-navigation' }, () => ({
            contents: `const forbidden = () => { throw new Error('Synthetic layout check must not navigate'); }; export const useRouter = () => ({ push: forbidden, replace: forbidden, refresh: forbidden });`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /^next\/image$/ }, (args) => ({
            path: args.path,
            namespace: 'qa-product-image',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'qa-product-image' }, () => ({
            contents: `import ImageModule from ${JSON.stringify(webRequire.resolve('next/image'))}; export default ImageModule.default ?? ImageModule;`,
            loader: 'js',
            resolveDir: path.join(root, 'apps/web'),
          }));
          builder.onResolve({ filter: /^next\/link$/ }, (args) => ({
            path: args.path,
            namespace: 'qa-product-link',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'qa-product-link' }, () => ({
            contents: `import React from 'react'; export default function Link({href,prefetch,...props}) { return React.createElement('a',{...props,href}); }`,
            loader: 'js',
            resolveDir: path.join(root, 'apps/web'),
          }));
          builder.onResolve({ filter: /(?:\/actions|\/repair-actions)$/ }, (args) => ({
            path: args.path,
            namespace: 'qa-product-actions',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'qa-product-actions' }, () => ({
            contents: `
const record = name => { window.__qaWrites = [...(window.__qaWrites || []), name]; };
const save = async name => { record(name); return window.__qaFailure ? { error: 'Synthetic save unavailable. Your changes are retained.' } : { error: null }; };
const update = async name => { record(name); if (window.__qaFailure) throw new Error('Synthetic update unavailable.'); };
export const addSkillAction = () => save('add-skill'); export const editSkillAction = () => save('edit-skill');
export const deleteSkillAction = () => update('delete-skill'); export const toggleSkillDeprecatedAction = () => update('retire-skill');
export const updateVoiceProfileAction = () => save('save-voice'); export const forgetLongTermMemoryAction = () => update('forget-memory');
export const reportRepairAction = () => update('report-repair'); export const repairDecisionAction = () => update('repair-decision');`,
            ...(hydrateChat
              ? {
                  contents: `const forbidden = async () => { window.__qaWrites = [...(window.__qaWrites || []), 'unexpected-chat-action']; throw new Error('Synthetic chat layout check must not perform actions.'); };
${chatStates ? "export const cancelChatTask = async taskId => { window.__qaSimulatedCancels = [...(window.__qaSimulatedCancels || []), taskId]; throw new Error('Synthetic cancel unavailable.'); };" : 'export { forbidden as cancelChatTask };'}
export { forbidden as cancelTask, forbidden as addSkillAction, forbidden as editSkillAction, forbidden as deleteSkillAction, forbidden as toggleSkillDeprecatedAction, forbidden as updateVoiceProfileAction, forbidden as forgetLongTermMemoryAction, forbidden as reportRepairAction, forbidden as repairDecisionAction, forbidden as signOutAction, forbidden as archiveConversation, forbidden as changeConversationModel, forbidden as restoreConversation, forbidden as recordRecallFeedbackAction, forbidden as refreshSavedCardInline, forbidden as resolveApprovalInline, forbidden as raiseTaskBudgetAndRetry, forbidden as decideSuggestionInline, forbidden as snoozeSuggestionInline };`,
                }
              : {}),
            loader: 'js',
          }));
          builder.onResolve({ filter: /^@\// }, (args) =>
            builder.resolve(path.join(root, 'apps/web', args.path.slice(2)), {
              kind: args.kind,
              resolveDir: args.resolveDir,
            }),
          );
        },
      },
    ],
  });
type PageFixture = {
  name: string;
  route: string;
  source: string;
  availability: string;
  state?: string;
};
const isConversationFixture = (entry: PageFixture) =>
  /^\/chat(?:\/[^/]+)?$/.test(entry.route) && entry.route !== '/chat/all';
function readLastTranscriptLine() {
  const log = document.querySelector<HTMLElement>('[role="log"]');
  const composer = document.querySelector('[data-testid="chat-composer-surface"]');
  const form = composer?.closest('form');
  const candidates = log?.querySelectorAll(
    '[data-message-block][data-role="assistant"], .my-auto .grid button',
  );
  const last = candidates?.[candidates.length - 1];
  if (!log || !composer || !form || !last) return null;
  const image = last.querySelector<HTMLImageElement>('img[alt="Latest visual card"]');
  if (image) {
    const box = image.getBoundingClientRect();
    const logTop = log.getBoundingClientRect().top;
    const composerTop = composer.getBoundingClientRect().top;
    const visibleMediaPixels = Math.max(
      0,
      Math.min(box.bottom, composerTop) - Math.max(box.top, logTop),
    );
    return {
      readable:
        image.complete &&
        image.naturalWidth > 0 &&
        visibleMediaPixels >= Math.min(48, box.height) &&
        document.body.scrollHeight <= innerHeight + 1 &&
        Math.round(form.getBoundingClientRect().height) ===
          -Number.parseFloat(getComputedStyle(form).marginTop),
      finalText: image.alt,
      mediaHeight: box.height,
      mediaTop: box.top,
      mediaBottom: box.bottom,
      visibleMediaPixels,
      logTop,
      composerTop,
      actualScrollTop: log.scrollTop,
      physicalMaximum: log.scrollHeight - log.clientHeight,
      bodyHeight: document.body.scrollHeight,
      viewportHeight: innerHeight,
    };
  }
  const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT);
  let text: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (
      node.textContent?.trim() &&
      node.parentElement?.checkVisibility({ opacityProperty: true }) &&
      !node.parentElement.closest('.sr-only, [aria-hidden="true"], [data-message-utility]')
    )
      text = node;
  if (!text) return null;
  const range = document.createRange();
  range.selectNodeContents(text);
  const line = [...range.getClientRects()].at(-1);
  const logTop = log.getBoundingClientRect().top;
  const composerTop = composer.getBoundingClientRect().top;
  return {
    readable:
      !!line &&
      line.top >= logTop - 1 &&
      line.bottom <= composerTop + 1 &&
      document.body.scrollHeight <= innerHeight + 1 &&
      Math.round(form.getBoundingClientRect().height) ===
        -Number.parseFloat(getComputedStyle(form).marginTop),
    finalText: text.textContent,
    lineTop: line?.top,
    lineBottom: line?.bottom,
    logTop,
    composerTop,
    actualScrollTop: log.scrollTop,
    physicalMaximum: log.scrollHeight - log.clientHeight,
    bodyHeight: document.body.scrollHeight,
    viewportHeight: innerHeight,
  };
}
const manifestSource =
  hydrateChat && process.argv.includes('--reuse-html')
    ? await readFile(path.join(output, 'source-manifest.json'), 'utf8').catch(() =>
        readFile(path.join(output, 'manifest.json'), 'utf8'),
      )
    : await readFile(path.join(output, 'manifest.json'), 'utf8');
if (hydrateChat) await writeFile(path.join(output, 'source-manifest.json'), manifestSource);
const manifest = JSON.parse(manifestSource) as {
  pages: PageFixture[];
};
const allPages = manifest.pages.filter((entry) => entry.state);
const selectedPages = hydrateChat
  ? chatStates
    ? ['chat-recall-failure', 'notification-recall-failure']
    : ['chat', 'chat-empty', 'side-chat', 'side-chat-empty']
  : process.argv
      .find((arg) => arg.startsWith('--pages='))
      ?.slice(8)
      .split(',');
const pages = allPages.filter(
  (entry) =>
    (!staticLargeText || !isConversationFixture(entry)) &&
    (!selectedPages || selectedPages.includes(entry.name)) &&
    (!process.argv.includes('--forms-only') ||
      ['skills', 'improvements', 'writing-voice'].includes(entry.name)),
);
if ((await componentInputHash()) !== componentSha256)
  throw new Error('Source changed during fixture generation; repeat the capture');
const buildSha256 = visualHash(
  JSON.stringify({
    script: visualHash(await readFile(fileURLToPath(import.meta.url))),
    captureContract: visualHash(
      await readFile(path.join(root, 'scripts/visual-capture-provenance.ts')),
    ),
    lock: visualHash(await readFile(path.join(root, 'pnpm-lock.yaml'))),
    client: before ? null : visualHash(await readFile(path.join(output, 'client.js'))),
    captureWidths,
    rootFontSize,
  }),
);
const stylesheetSha256 = visualHash(
  JSON.stringify({
    globals: visualHash(css.css),
    conversation: conversationHash,
    client: hydrateChat
      ? visualHash(await readFile(path.join(output, 'client.css')).catch(() => ''))
      : null,
  }),
);
const fixtureInputs = {
  before,
  hydrateChat,
  chatStates,
  longChat,
  cardChat,
  componentSha256,
  html: Object.fromEntries(
    await Promise.all(
      allPages.map(async (entry) => [
        entry.name,
        visualHash(await readFile(path.join(output, `${entry.name}.html`))),
      ]),
    ),
  ),
};
if (process.argv.includes('--reuse-html')) {
  const prior = await readFile(path.join(output, 'fixture-source-receipt.json'), 'utf8').catch(
    () => null,
  );
  if (!prior || JSON.stringify(JSON.parse(prior)) !== JSON.stringify(fixtureInputs))
    throw new Error('Cached HTML lacks matching source provenance; repeat without --reuse-html');
} else {
  await writeFile(
    path.join(output, 'fixture-source-receipt.json'),
    `${JSON.stringify(fixtureInputs)}\n`,
  );
}
function evidenceMode(entry: PageFixture): VisualEvidenceMode {
  return before
    ? 'static-frozen-baseline'
    : hydrateChat || ['skills', 'improvements', 'writing-voice'].includes(entry.name)
      ? 'hydrated-synthetic'
      : 'static-source';
}
const captureReceipts = new Map<string, VisualCaptureReceipt>();
async function provenanceScreenshot(page: Page, options: PageScreenshotOptions): Promise<Buffer> {
  const fixture = allPages.find(
    (entry) => new URL(page.url()).pathname === `/fixture/${entry.name}`,
  );
  if (!fixture || !options.path)
    throw new Error('Screenshot has no declared fixture or output path');
  const pixels = await page.screenshot(options);
  const screenshot = path.basename(options.path);
  const provenance = visualCaptureReceipt(
    evidenceMode(fixture),
    await captureInputs(fixture),
    pixels,
  );
  await writeFile(
    path.join(output, 'capture-receipts', `${provenance.id}.json`),
    `${JSON.stringify({ screenshot, fixture: fixture.name, provenance }, null, 2)}\n`,
    { flag: 'wx' },
  );
  captureReceipts.set(screenshot, provenance);
  return pixels;
}
async function renderedFixtureHtml(entry: PageFixture): Promise<string> {
  return (await readFile(path.join(output, `${entry.name}.html`), 'utf8'))
    .replace(
      '</head>',
      `<link rel="stylesheet" href="/style.css">${!before && isConversationFixture(entry) ? '<link rel="stylesheet" href="/conversation.css">' : ''}${hydrateChat ? '<link rel="stylesheet" href="/client.css">' : ''}<style>html { font-size: ${rootFontSize}px; }</style></head>`,
    )
    .replace(
      '</body>',
      `${before ? '' : '<script type="module" src="/client.js"></script>'}</body>`,
    );
}
async function captureInputs(entry: PageFixture, currentComponentHash = componentSha256) {
  return {
    htmlSha256: visualHash(await renderedFixtureHtml(entry)),
    componentSha256: currentComponentHash,
    stylesheetSha256,
    buildSha256,
  };
}
await mkdir(path.join(output, 'capture-receipts'), { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/style.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end(css.css);
      return;
    }
    if (conversationCss !== null && pathname === '/conversation.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end(conversationCss);
      return;
    }
    if (!before && pathname === '/client.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(path.join(output, 'client.js')));
      return;
    }
    if (hydrateChat && pathname === '/client.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end(await readFile(path.join(output, 'client.css')));
      return;
    }
    if (hydrateChat && /^\/[a-zA-Z0-9_-]+\.(?:woff2|woff|ttf)$/.test(pathname)) {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.end(await readFile(path.join(output, pathname)));
      return;
    }
    const entry = allPages.find((entry) => pathname === `/fixture/${entry.name}`);
    if (entry) {
      const html = await renderedFixtureHtml(entry);
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html);
      return;
    }
    if (/^\/icons\/[a-z0-9-]+\.svg$/.test(pathname) || pathname === '/icon.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end(await readFile(path.join(root, 'apps/web/public', pathname)));
      return;
    }
    response.writeHead(404);
    response.end('Synthetic source preview only');
  } catch {
    response.writeHead(500);
    response.end('Synthetic source preview unavailable');
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No synthetic preview address');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const measurements: Array<Record<string, unknown>> = [];
const interactions: Array<Record<string, unknown>> = [];
const syntheticApiRequests: Array<Record<string, unknown>> = [];
let blockedRequests = 0;
try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const viewport of captureWidths.map((width) => ({
      width,
      height: width >= 1280 ? 960 : 844,
    }))) {
      const context = await browser.newContext({
        viewport,
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      // tsx names nested evaluate callbacks through this helper; browser-side
      // probes need its identity behavior, without importing the host runtime.
      await context.addInitScript('globalThis.__name = (fn) => fn;');
      let currentFixture = '';
      await context.route('**/*', async (route) => {
        if (hydrateChat && route.request().url().startsWith(`${origin}/api/`)) {
          const url = new URL(route.request().url());
          syntheticApiRequests.push({
            fixture: currentFixture,
            scheme,
            path: url.pathname,
            method: route.request().method(),
          });
          if (
            cardChat === 'image' &&
            url.pathname === '/api/card-image' &&
            route.request().method() === 'GET' &&
            url.searchParams.get('url') === 'https://visual-qa.invalid/late-image.svg'
          ) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            await route.fulfill({
              contentType: 'image/svg+xml',
              body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1200"><rect width="600" height="1200" fill="#d6eadc"/><path d="M0 0L600 1200M600 0L0 1200" stroke="#217a4b" stroke-width="30"/><circle cx="300" cy="1000" r="120" fill="#217a4b"/></svg>',
            });
            return;
          }
          if (url.pathname === '/api/chat/status' && route.request().method() === 'GET') {
            await route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                taskStatus: chatStates ? 'running' : null,
                messages: [],
                refreshed: [],
                superseded: [],
                nextCursor: null,
                hasMore: false,
              }),
            });
            return;
          }
        }
        if (!route.request().url().startsWith(origin) || route.request().url().includes('/api/')) {
          blockedRequests++;
          await route.abort();
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => process.stderr.write(`Preview error: ${error.message}\n`));
      for (const entry of pages) {
        currentFixture = entry.name;
        const waitForReadable = async (label: string) => {
          try {
            await page.waitForFunction(
              `(${readLastTranscriptLine.toString()})()?.readable === true`,
              undefined,
              { timeout: 5000 },
            );
          } catch (error) {
            const directory = path.join(output, 'failures');
            await mkdir(directory, { recursive: true });
            const stem = `${label}-${entry.name}-${viewport.width}-${scheme}`;
            const observed = await page.evaluate(readLastTranscriptLine);
            await writeFile(
              path.join(directory, `${stem}.json`),
              JSON.stringify(observed, null, 2),
            );
            await page.screenshot({ path: path.join(directory, `${stem}.png`), fullPage: true });
            throw new Error(
              `${label} did not expose readable final content: ${JSON.stringify(observed)}`,
              { cause: error },
            );
          }
        };
        const errors: string[] = [];
        const onError = (error: Error) => errors.push(error.message);
        page.on('pageerror', onError);
        await page.goto(`${origin}/fixture/${entry.name}`, { waitUntil: 'networkidle' });
        if (cardChat && entry.state !== 'empty') {
          const latest = page.locator('[data-message-block][data-role="assistant"]').last();
          if (cardChat === 'agenda')
            await latest.getByText('Latest weekend agenda', { exact: true }).waitFor();
          else
            await latest
              .getByRole('region', {
                name: cardChat === 'image' ? 'Latest visual card' : 'Latest weekend card',
                exact: true,
              })
              .waitFor();
          if (cardChat === 'image')
            await latest.getByRole('img', { name: 'Latest visual card', exact: true }).waitFor();
          else
            await latest
              .getByText('Latest card ends here: bring the hotel confirmation.', { exact: true })
              .waitFor();
          const prose = await latest.locator('.bubble-assistant').count();
          if (
            (cardChat !== 'with-prose' && prose !== 0) ||
            (cardChat === 'with-prose' && prose === 0)
          )
            throw new Error('Card fixture does not represent its declared response shape');
        }
        await page.evaluate((scheme) => {
          document.documentElement.dataset.theme = scheme;
          document.documentElement.classList.toggle('dark', scheme === 'dark');
          document.documentElement.style.colorScheme = scheme;
        }, scheme);
        if (hydrateChat) {
          await page
            .waitForFunction(() => {
              const composer = document.querySelector('[data-testid="chat-composer-surface"]');
              const form = composer?.closest('form');
              return (
                form &&
                Math.round(form.getBoundingClientRect().height) ===
                  -Number.parseFloat(getComputedStyle(form).marginTop) &&
                document.body.scrollHeight <= innerHeight + 1
              );
            })
            .catch(async (error) => {
              const failureDirectory = path.join(output, 'failures');
              await mkdir(failureDirectory, { recursive: true });
              const failureName = `${entry.name}-${viewport.width}-${scheme}`;
              await page.screenshot({
                path: path.join(failureDirectory, `${failureName}.png`),
                fullPage: true,
              });
              const geometry = await page.evaluate(() => {
                const form = document
                  .querySelector('[data-testid="chat-composer-surface"]')
                  ?.closest('form');
                return {
                  viewportHeight: innerHeight,
                  bodyScrollHeight: document.body.scrollHeight,
                  formHeight: form?.getBoundingClientRect().height,
                  marginTop: form ? getComputedStyle(form).marginTop : null,
                  headerHeight: document.querySelector('body > header')?.getBoundingClientRect()
                    .height,
                };
              });
              await writeFile(
                path.join(failureDirectory, `${failureName}.json`),
                JSON.stringify(geometry, null, 2),
              );
              throw error;
            });
          if (chatStates) {
            await page.getByRole('button', { name: 'Stop this task', exact: true }).click();
            await page
              .getByRole('alert')
              .filter({ hasText: 'Could not stop this task. Try again or open Activity.' })
              .waitFor();
            if (
              !(await page.getByRole('button', { name: 'Stop this task', exact: true }).isEnabled())
            )
              throw new Error('Failed stop removed the available retry control');
            if (await page.getByText('Stopped by you.', { exact: true }).count())
              throw new Error('Failed stop presented a false success receipt');
          }
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          );
          if (cardChat === 'image' && entry.state !== 'empty')
            await waitForReadable('initial-image-auto-follow');
        }
        const scrollingProof =
          hydrateChat && (rootFontSize > 16 || longChat || cardChat !== '')
            ? await page.evaluate(async () => {
                const log = document.querySelector<HTMLElement>('[role="log"]');
                const composer = document.querySelector('[data-testid="chat-composer-surface"]');
                if (!log || !composer) throw new Error('Missing conversation regions');
                const targets = log.querySelectorAll<HTMLElement>(
                  '.bubble-assistant, .bubble-owner, [data-decision-card], [data-response-card], .recall-note, .chat-action-error, .my-auto > p:first-of-type, .my-auto .grid button',
                );
                if (targets.length === 0) throw new Error('Missing declared conversation content');
                const settle = () =>
                  new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                  );
                const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT);
                const textNodes: Text[] = [];
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                  const parent = node.parentElement;
                  if (
                    node.textContent?.trim() &&
                    parent?.checkVisibility({ opacityProperty: true }) &&
                    !parent.closest('.sr-only')
                  )
                    textNodes.push(node as Text);
                }
                if (textNodes.length === 0) throw new Error('Missing readable conversation text');
                const expectedLines = new Set<string>();
                const readableLines = new Set<string>();
                const readingHeight = Math.max(
                  1,
                  composer.getBoundingClientRect().top - log.getBoundingClientRect().top,
                );
                const maximum = Math.max(0, log.scrollHeight - log.clientHeight);
                const offsets = Array.from(
                  { length: Math.ceil(maximum / Math.max(1, readingHeight / 3)) + 1 },
                  (_, index) => Math.min(maximum, index * Math.max(1, readingHeight / 3)),
                );
                for (const offset of offsets) {
                  log.scrollTop = offset;
                  await settle();
                  const top = log.getBoundingClientRect().top;
                  const bottom = composer.getBoundingClientRect().top;
                  textNodes.forEach((node, index) => {
                    if (!node.isConnected) throw new Error('Transcript changed during read sweep');
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    [...range.getClientRects()].forEach((box, line) => {
                      if (box.width <= 1 || box.height <= 1) return;
                      const key = `${index}:${line}`;
                      expectedLines.add(key);
                      if (box.top >= top - 1 && box.bottom <= bottom + 1) readableLines.add(key);
                    });
                  });
                }
                const unreadableLines = [...expectedLines].filter((key) => !readableLines.has(key));
                if (expectedLines.size === 0 || unreadableLines.length)
                  throw new Error(`Transcript lines cannot be read: ${unreadableLines.join(', ')}`);
                log.scrollTop = 0;
                await settle();
                await settle();
                await settle();
                const first = targets[0]?.getBoundingClientRect();
                const logBox = log.getBoundingClientRect();
                const readingBottom = Math.min(logBox.bottom, composer.getBoundingClientRect().top);
                const firstLineHeight = targets[0]
                  ? Number.parseFloat(getComputedStyle(targets[0]).lineHeight)
                  : 0;
                const firstReachable =
                  !first ||
                  (first.top >= logBox.top - 1 &&
                    first.top + Math.min(first.height, firstLineHeight) <= readingBottom + 1);
                log.scrollTop = log.scrollHeight;
                await settle();
                await settle();
                let last = targets[targets.length - 1]?.getBoundingClientRect();
                let composerTop = composer.getBoundingClientRect().top;
                const maximumScrollTop = log.scrollTop;
                if (last) {
                  log.scrollTop += last.bottom - (composerTop - 24);
                  await settle();
                  await settle();
                  last = targets[targets.length - 1]?.getBoundingClientRect();
                  composerTop = composer.getBoundingClientRect().top;
                }
                return {
                  firstReachable,
                  textLineCount: expectedLines.size,
                  readableLineCount: readableLines.size,
                  firstActualTextLineReadable: readableLines.has([...expectedLines][0] ?? ''),
                  lastActualTextLineReadable: readableLines.has([...expectedLines].at(-1) ?? ''),
                  readingOffsetsChecked: offsets.length,
                  firstTopAtStart: first?.top ?? null,
                  firstBottomAtStart: first?.bottom ?? null,
                  logTop: logBox.top,
                  logBottom: logBox.bottom,
                  readingBottom,
                  lastReachable:
                    !last || (last.bottom <= composerTop + 1 && last.bottom > logBox.top),
                  scrollHeight: log.scrollHeight,
                  maximumScrollTop,
                  readingScrollTop: log.scrollTop,
                  clientHeight: log.clientHeight,
                  composerTop,
                  lastTopAtEnd: last?.top ?? null,
                  lastBottomAtEnd: last?.bottom ?? null,
                  bodyScrollHeight: document.body.scrollHeight,
                  viewportHeight: innerHeight,
                };
              })
            : null;
        if (
          scrollingProof &&
          (!scrollingProof.firstReachable ||
            !scrollingProof.lastReachable ||
            scrollingProof.bodyScrollHeight !== scrollingProof.viewportHeight)
        )
          throw new Error(
            `Enlarged conversation is not reachable: ${JSON.stringify(scrollingProof)}`,
          );
        if (scrollingProof) {
          const scrollToEdge = async (edge: 'top' | 'bottom') => {
            await page.evaluate(async (edge) => {
              const log = document.querySelector<HTMLElement>('[role="log"]');
              if (!log) throw new Error('Missing conversation log');
              log.scrollTop = edge === 'top' ? 0 : log.scrollHeight;
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              );
              if (edge === 'bottom') {
                const targets = log.querySelectorAll<HTMLElement>(
                  '.bubble-assistant, .bubble-owner, [data-decision-card], [data-response-card], .recall-note, .chat-action-error, .my-auto > p:first-of-type, .my-auto .grid button',
                );
                const last = targets[targets.length - 1]?.getBoundingClientRect();
                const composer = document.querySelector('[data-testid="chat-composer-surface"]');
                if (last && composer)
                  log.scrollTop += last.bottom - (composer.getBoundingClientRect().top - 24);
              }
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              );
            }, edge);
          };
          const topScreenshot = `${entry.name}-${viewport.width}-${scheme}-top.png`;
          await scrollToEdge('top');
          await provenanceScreenshot(page, {
            path: path.join(output, topScreenshot),
            fullPage: true,
            animations: 'disabled',
          });
          await scrollToEdge('bottom');
          Object.assign(scrollingProof, {
            topScreenshot,
            bottomScreenshot: `${entry.name}-${viewport.width}-${scheme}.png`,
          });
        }
        const layout = await page.evaluate(() => {
          const main = document.querySelector('main');
          const overflow = [...document.querySelectorAll<HTMLElement>('main *')]
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return (
                element.checkVisibility() &&
                box.width > 0 &&
                (box.right > innerWidth + 1 || box.left < -1)
              );
            })
            .slice(0, 12)
            .map((element) => ({
              tag: element.tagName,
              text: element.textContent?.trim().slice(0, 100),
              className: element.className,
            }));
          return {
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: innerWidth,
            height: document.documentElement.scrollHeight,
            mainWidth: main?.getBoundingClientRect().width,
            heading: document.querySelector('h1')?.textContent,
            overflow,
          };
        });
        const conversationPresentation = isConversationFixture(entry)
          ? await page.evaluate(() => {
              const chat = document.querySelector('.chat-viewport');
              const composer = document.querySelector('[data-testid="chat-composer-surface"]');
              const assistantBubble = document.querySelector('.bubble-assistant');
              const lastSuggestion = document.querySelector('.my-auto .grid button:last-child');
              const stageProbe = document.createElement('span');
              stageProbe.style.backgroundColor = 'var(--stage)';
              document.body.append(stageProbe);
              const stageColor = getComputedStyle(stageProbe).backgroundColor;
              stageProbe.remove();
              const bodyColor = getComputedStyle(document.body).backgroundColor;
              const chatBox = chat?.getBoundingClientRect();
              const composerTop = composer?.getBoundingClientRect().top ?? null;
              const lastSuggestionBottom = lastSuggestion?.getBoundingClientRect().bottom ?? null;
              const form = composer?.closest('form');
              const transcriptClearComposer = [
                ...document.querySelectorAll(
                  '.bubble-assistant, .bubble-owner, [data-decision-card], [data-response-card], .recall-note, .chat-action-error',
                ),
              ].every((bubble) => {
                const box = bubble.getBoundingClientRect();
                return (
                  composerTop !== null &&
                  box.bottom <= composerTop + 1 &&
                  box.top >= (chatBox?.top ?? 0) - 1
                );
              });
              return {
                stagePainted: bodyColor === stageColor,
                bodyColor,
                stageColor,
                composerBorderStyle: composer ? getComputedStyle(composer).borderTopStyle : null,
                composerBorderColor: composer ? getComputedStyle(composer).borderTopColor : null,
                assistantSurface: assistantBubble
                  ? getComputedStyle(assistantBubble).backgroundColor
                  : null,
                viewportHeight: innerHeight,
                chatTop: chatBox?.top ?? null,
                chatBottom: chatBox?.bottom ?? null,
                bodyScrollHeight: document.body.scrollHeight,
                formHeight: form?.getBoundingClientRect().height ?? null,
                reservedComposerHeight: form
                  ? -Number.parseFloat(getComputedStyle(form).marginTop)
                  : null,
                composerTop,
                lastSuggestionBottom,
                suggestionsClearComposer:
                  lastSuggestionBottom === null ||
                  (composerTop !== null && lastSuggestionBottom <= composerTop),
                transcriptClearComposer,
                recallSurfaces: [...document.querySelectorAll('.recall-note')].map((note) => ({
                  material: note.closest('.paper') ? 'paper' : 'stage',
                  opacity: getComputedStyle(note).opacity,
                  top: note.getBoundingClientRect().top,
                  bottom: note.getBoundingClientRect().bottom,
                })),
                asyncFailureBottom:
                  document.querySelector('.chat-action-error')?.getBoundingClientRect().bottom ??
                  null,
              };
            })
          : null;
        const contrast = isConversationFixture(entry)
          ? await page.evaluate(() => {
              const canvas = document.createElement('canvas');
              canvas.width = canvas.height = 1;
              const context = canvas.getContext('2d');
              if (!context) throw new Error('No browser color resolver');
              const rgba = (value: string) => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = value;
                context.fillRect(0, 0, 1, 1);
                const pixel = context.getImageData(0, 0, 1, 1).data;
                return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, (pixel[3] ?? 0) / 255];
              };
              const background = (element: Element) => {
                const ancestors: Element[] = [];
                for (let node: Element | null = element; node; node = node.parentElement)
                  ancestors.unshift(node);
                context.clearRect(0, 0, 1, 1);
                for (const node of ancestors) {
                  const style = getComputedStyle(node);
                  if (style.backgroundImage !== 'none')
                    throw new Error(
                      'Contrast fixture needs a pixel probe for gradient backgrounds',
                    );
                  context.fillStyle = style.backgroundColor;
                  context.fillRect(0, 0, 1, 1);
                }
                const pixel = context.getImageData(0, 0, 1, 1).data;
                if (pixel[3] !== 255) throw new Error('Contrast background is not resolved opaque');
                return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0];
              };
              const luminance = (rgb: number[]) =>
                rgb.reduce((sum, channel, index) => {
                  const value = channel / 255;
                  const linear =
                    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                  return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
                }, 0);
              const read = (element: Element, target: string, pseudo?: string) => {
                const style = getComputedStyle(element, pseudo);
                const chat = element.closest('.chat-viewport');
                const aboveFade =
                  !chat ||
                  getComputedStyle(chat, '::after').content === 'none' ||
                  element.closest('[data-testid="chat-composer-surface"]') ||
                  element.getBoundingClientRect().bottom <=
                    chat.getBoundingClientRect().bottom -
                      Math.min(
                        144,
                        9 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
                      );
                if (!aboveFade)
                  throw new Error(`Contrast target intersects the conversation fade: ${target}`);
                const ink = rgba(style.color);
                const ground = background(element);
                let opacity = Number.parseFloat(style.opacity);
                for (let node = element.parentElement; node; node = node.parentElement)
                  opacity *= Number.parseFloat(getComputedStyle(node).opacity);
                const alpha = (ink[3] ?? 1) * opacity;
                const foreground = ground.map(
                  (channel, index) => (ink[index] ?? 0) * alpha + channel * (1 - alpha),
                );
                const a = luminance(foreground);
                const b = luminance(ground);
                return {
                  target,
                  label: element.textContent?.trim().slice(0, 80),
                  color: style.color,
                  effectiveOpacity: opacity,
                  resolvedForeground: foreground,
                  resolvedBackground: ground,
                  ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
                };
              };
              const header = document.querySelector('body > header');
              const headerStyle = header ? getComputedStyle(header) : null;
              const headerOpaque =
                headerStyle !== null &&
                rgba(headerStyle.backgroundColor)[3] === 1 &&
                headerStyle.opacity === '1';
              const selectors = [
                ['Header navigation', 'body > header nav a'],
                ['Welcome narrative', '.chat-viewport .my-auto > p:last-of-type'],
                ['Suggestion label', '.chat-viewport .my-auto > .grid button > span'],
                ['Side navigation', '.chat-heading a, .chat-heading button:not(:disabled)'],
                ['Owner message', '.bubble-owner p'],
                ['Recall provenance', '.recall-note > span, .recall-note button:not(:disabled)'],
                ['Async action failure', '.chat-action-error'],
              ] as const;
              const text = selectors.flatMap(([target, selector]) =>
                [...document.querySelectorAll(selector)].map((element) => read(element, target)),
              );
              const input = document.querySelector(
                '[data-testid="chat-composer-surface"] textarea',
              );
              if (input) text.push(read(input, 'Composer placeholder', '::placeholder'));
              return {
                headerOpaque,
                headerBackground: headerStyle?.backgroundColor,
                text,
                disabledControls: [
                  ...document.querySelectorAll('.chat-viewport button:disabled'),
                ].map((element) => ({
                  label: element.getAttribute('aria-label') ?? element.textContent?.trim(),
                  note: 'Disabled controls are excluded from ordinary text contrast assertions.',
                })),
                method:
                  'Browser-computed sRGB ink and ancestor background layers resolved through canvas; includes ink alpha and ancestor opacity. Selected targets have flat opaque final backgrounds, clear of the bottom fade.',
              };
            })
          : null;
        if (
          !before &&
          contrast &&
          (!contrast.headerOpaque ||
            !contrast.text.some((entry) => entry.target === 'Header navigation') ||
            contrast.text.some((entry) => entry.ratio < 4.5))
        )
          throw new Error(
            `Conversation text contrast failed on ${entry.name}: ${JSON.stringify(contrast)}`,
          );
        if (
          !before &&
          conversationPresentation &&
          (!conversationPresentation.stagePainted ||
            conversationPresentation.composerBorderStyle !== 'solid' ||
            conversationPresentation.assistantSurface === 'rgba(0, 0, 0, 0)' ||
            !conversationPresentation.suggestionsClearComposer ||
            (!scrollingProof && !conversationPresentation.transcriptClearComposer) ||
            conversationPresentation.chatBottom === null ||
            conversationPresentation.chatBottom > conversationPresentation.viewportHeight + 1)
        )
          throw new Error(
            `Conversation surface or composer clearance failed on ${entry.name}: ${JSON.stringify(conversationPresentation)}`,
          );
        const name = `${entry.name}-${viewport.width}-${scheme}.png`;
        const capture = await provenanceScreenshot(page, {
          path: path.join(output, name),
          fullPage: true,
          animations: 'disabled',
        });
        const provenance = captureReceipts.get(name);
        const measurement = {
          provenance,

          ...entry,
          screenshot: name,
          width: viewport.width,
          rootFontSize,
          scrollingProof,
          screenshotWidth: capture.readUInt32BE(16),
          screenshotHeight: capture.readUInt32BE(20),
          scheme,
          ...layout,
          errors,
          conversationStylesheet:
            !before && isConversationFixture(entry) ? 'apps/web/app/conversation.css' : null,
          conversationPresentation,
          contrast,
          hydratedChat: hydrateChat,
          evidence: hydrateChat
            ? 'Actual ChatClient and layout effects hydrated with mocked navigation/server actions and synthetic local status reads. No owner reads, provider calls, sends or voice.'
            : 'Actual source HTML and stylesheet. Skills, writing voice and repair forms hydrate against synthetic actions after; other retained pages remain static visual evidence. No owner mutations.',
        };
        measurements.push(measurement);
        if (scrollingProof) {
          const auditLink = page.getByRole('link', { name: 'Audit trail', exact: true });
          await auditLink.focus();
          const navigationReachable = await auditLink.evaluate((link) => {
            const nav = link.closest('nav');
            if (!nav) return false;
            const box = link.getBoundingClientRect();
            const navBox = nav.getBoundingClientRect();
            return box.left >= navBox.left - 1 && box.right <= navBox.right + 1;
          });
          const field = page.getByRole('combobox', { name: 'Message', exact: true });
          const initialJump = page.getByRole('button', { name: 'Jump to latest', exact: true });
          if (entry.state !== 'empty' && (await initialJump.isVisible())) {
            await initialJump.click();
            await waitForReadable('actual-jump');
          }
          const editingDraft = `Draft begins: confirm the weekend plan.\n${'Review the weekend plan. '.repeat(50)}\nDraft ends: bring the hotel confirmation.`;
          await field.fill(editingDraft);
          await field.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
          const draftStart = await field.evaluate((element: HTMLTextAreaElement) => ({
            caretAtStart: element.selectionStart === 0 && element.selectionEnd === 0,
            firstLineVisible: element.scrollTop <= 1,
          }));
          if (!draftStart.caretAtStart || !draftStart.firstLineVisible)
            throw new Error(`Cannot reach the start of the draft: ${JSON.stringify(draftStart)}`);
          const composerStartScreenshot = `${entry.name}-${viewport.width}-${scheme}-editing-start.png`;
          await provenanceScreenshot(page, {
            path: path.join(output, composerStartScreenshot),
            fullPage: true,
            animations: 'disabled',
          });
          await field.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
          await page.waitForFunction(() => {
            const form = document
              .querySelector('[data-testid="chat-composer-surface"]')
              ?.closest('form');
            return (
              form &&
              Math.round(form.getBoundingClientRect().height) ===
                -Number.parseFloat(getComputedStyle(form).marginTop) &&
              document.body.scrollHeight <= innerHeight + 1
            );
          });
          const editing = await page.evaluate(() => {
            const field = document.querySelector<HTMLTextAreaElement>(
              'textarea[aria-label="Message"]',
            );
            const send = document.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
            const box = send?.getBoundingClientRect();
            return {
              focused: document.activeElement === field,
              fieldScrolls: !!field && field.scrollHeight > field.clientHeight,
              caretAtEnd:
                !!field &&
                field.selectionStart === field.value.length &&
                field.selectionEnd === field.value.length,
              caretVisible:
                !!field && field.scrollTop + field.clientHeight >= field.scrollHeight - 1,
              fieldWidth: field?.getBoundingClientRect().width,
              sendEnabled: !!send && !send.disabled,
              sendVisible:
                !!box &&
                box.top >= 0 &&
                box.bottom <= innerHeight &&
                box.left >= 0 &&
                box.right <= innerWidth,
              bodyHeight: document.body.scrollHeight,
              viewportHeight: innerHeight,
            };
          });
          if (
            !navigationReachable ||
            !editing.focused ||
            !editing.fieldScrolls ||
            !editing.caretAtEnd ||
            !editing.caretVisible ||
            !editing.sendEnabled ||
            !editing.sendVisible ||
            editing.bodyHeight !== editing.viewportHeight
          )
            throw new Error(
              `Enlarged composer/navigation is not operable: ${JSON.stringify({ navigationReachable, editing })}`,
            );
          const composerScreenshot = `${entry.name}-${viewport.width}-${scheme}-editing.png`;
          await waitForReadable('composer-growth');
          const lastTextAfterGrowth = await page.evaluate(readLastTranscriptLine);
          if (!lastTextAfterGrowth?.readable)
            throw new Error('Final reply cannot be read while editing');
          await provenanceScreenshot(page, {
            path: path.join(output, composerScreenshot),
            fullPage: true,
            animations: 'disabled',
          });
          const logOverflows = await page.evaluate(() => {
            const log = document.querySelector<HTMLElement>('[role="log"]');
            if (!log) return false;
            log.scrollTop = 0;
            return log.scrollHeight - log.clientHeight > 48;
          });
          let jumpKeyboard = false;
          let jumpPointer = false;
          const jumpOutcomes: Array<Record<string, unknown>> = [];
          const inspectJump = async (activation: string) => {
            await waitForReadable('actual-jump');
            const destination = await page.evaluate(readLastTranscriptLine);
            if (!destination?.readable)
              throw new Error(
                `Actual ${activation} Jump hid final reply: ${JSON.stringify(destination)}`,
              );
            if (
              cardChat &&
              destination.finalText?.trim() !==
                (cardChat === 'image'
                  ? 'Latest visual card'
                  : 'Latest card ends here: bring the hotel confirmation.')
            )
              throw new Error('Jump did not expose the newest generated-card fact');
            const screenshot = `${entry.name}-${viewport.width}-${scheme}-jump-${activation}.png`;
            await provenanceScreenshot(page, {
              path: path.join(output, screenshot),
              fullPage: true,
              animations: 'disabled',
            });
            jumpOutcomes.push({
              activation,
              ...destination,
              screenshot,
              scriptedScrollCorrection: false,
            });
          };
          if (logOverflows && entry.state !== 'empty') {
            const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
            await jump.waitFor({ state: 'visible' });
            await jump.click();
            await inspectJump('pointer');
            jumpPointer = await field.evaluate(
              (element: HTMLTextAreaElement, expected: string) =>
                document.activeElement !== element && element.value === expected,
              editingDraft,
            );
            if (!jumpPointer) throw new Error('Pointer Jump opened editing or lost the draft');
            await page.evaluate(() => {
              const log = document.querySelector<HTMLElement>('[role="log"]');
              if (!log) throw new Error('Missing conversation log');
              log.scrollTop = 0;
            });
            await jump.waitFor({ state: 'visible' });
            await jump.focus();
            await jump.press('Enter');
            await inspectJump('keyboard');
            jumpKeyboard = await field.evaluate(
              (element: HTMLTextAreaElement, expected: string) =>
                document.activeElement === element && element.value === expected,
              editingDraft,
            );
            if (!jumpKeyboard) throw new Error('Keyboard Jump lost focus or draft');
          }
          Object.assign(scrollingProof, {
            navigationReachable,
            draftStart,
            editing,
            composerScreenshot,
            composerStartScreenshot,
            lastTextAfterGrowth,
            jumpKeyboard,
            jumpPointer,
            jumpOutcomes,
          });
          await field.fill('');
        }
        if (hydrateChat) {
          const client = await page.evaluate(() => ({
            writes: (window as Window & { __qaWrites?: string[] }).__qaWrites ?? [],
            errors:
              (window as Window & { __qaHydrationErrors?: string[] }).__qaHydrationErrors ?? [],
            simulatedCancels:
              (window as Window & { __qaSimulatedCancels?: string[] }).__qaSimulatedCancels ?? [],
          }));
          if (client.writes.length || client.errors.length || errors.length)
            throw new Error(`Chat hydration failed on ${name}: ${JSON.stringify(client)}`);
          if (client.simulatedCancels.length !== (chatStates ? 1 : 0))
            throw new Error(`Unexpected synthetic cancellation count on ${name}`);
          if (
            chatStates &&
            (!contrast?.text.some((entry) => entry.target === 'Recall provenance') ||
              !contrast.text.some((entry) => entry.target === 'Async action failure') ||
              contrast.text.some(
                (entry) => entry.target === 'Recall provenance' && entry.effectiveOpacity !== 1,
              ) ||
              conversationPresentation?.recallSurfaces.length !== 1 ||
              conversationPresentation.recallSurfaces[0]?.material !==
                (entry.name.startsWith('notification') ? 'paper' : 'stage'))
          )
            throw new Error(`Recall/failure evidence missing on ${name}`);
          if (
            conversationPresentation?.bodyScrollHeight !== viewport.height ||
            conversationPresentation.formHeight !== conversationPresentation.reservedComposerHeight
          )
            throw new Error(`Chat composer did not settle within ${name}`);
          Object.assign(measurement, {
            actionInvocations: client.writes.length,
            recoverableHydrationErrors: client.errors,
            simulatedCancellationFailures: client.simulatedCancels.length,
          });
          interactions.push({
            name: entry.name,
            scheme,
            check: chatStates
              ? 'Actual ChatClient hydrated; one local cancel stub rejects; failed-stop alert remains readable and Stop control recovers without false success; recall provenance renders on stage or notification paper; no real actions or recoverable hydration errors.'
              : 'Actual ChatClient hydrated; measured composer matches reserved height; document fits viewport; suggestions/transcript clear composer; no actions or recoverable hydration errors.',
          });
        }
        page.off('pageerror', onError);
      }
      if (!before && !hydrateChat && viewport.width === 390) {
        if (!selectedPages || selectedPages.includes('skills')) {
          await page.goto(`${origin}/fixture/skills`, { waitUntil: 'networkidle' });
          await page.getByRole('button', { name: 'Add skill', exact: true }).click();
          if (
            !(await page
              .getByLabel('Skill name', { exact: true })
              .evaluate((element) => element === document.activeElement))
          )
            throw new Error('New skill form did not receive focus');
          await page.getByLabel('Skill name', { exact: true }).fill('Plan a calmer week');
          await page
            .getByLabel('Steps', { exact: true })
            .fill('Check commitments, then leave room for rest.');
          await page.evaluate(() => {
            (window as Window & { __qaFailure?: boolean }).__qaFailure = true;
          });
          await page.getByRole('button', { name: 'Save skill', exact: true }).click();
          await page.getByRole('alert').waitFor();
          if (
            (await page.getByLabel('Skill name', { exact: true }).inputValue()) !==
            'Plan a calmer week'
          )
            throw new Error('Failed skill save lost the draft');
          if (
            (await page.locator('textarea[name="steps"]').inputValue()) !==
            'Check commitments, then leave room for rest.'
          )
            throw new Error('Failed skill save lost the procedure');
          await provenanceScreenshot(page, {
            path: path.join(output, `skills-form-error-390-${scheme}.png`),
            fullPage: true,
          });
          await page.evaluate(() => {
            (window as Window & { __qaFailure?: boolean }).__qaFailure = false;
          });
          await page.getByRole('button', { name: 'Save skill', exact: true }).click();
          await page.getByRole('button', { name: 'Add skill', exact: true }).waitFor();
          interactions.push({
            scheme,
            check:
              'Skill form has visible accessible labels; failed save retains draft and announces error; successful retry closes form.',
          });
        }
        if (!selectedPages || selectedPages.includes('improvements')) {
          await page.goto(`${origin}/fixture/improvements`, { waitUntil: 'networkidle' });
          await page.getByRole('button', { name: 'Report an issue', exact: true }).click();
          if (
            (await page
              .getByRole('button', { name: 'Report an issue', exact: true })
              .getAttribute('aria-expanded')) !== 'true'
          )
            throw new Error('Report disclosure did not expose expanded state');
          const title = page.getByLabel('Issue title', { exact: true });
          if (!(await title.evaluate((element) => element === document.activeElement)))
            throw new Error('Report form did not receive focus');
          await title.fill('Keep useful results visible');
          await page
            .getByLabel('What went wrong', { exact: true })
            .fill('A second lookup failed and hid the first useful result.');
          await page.evaluate(() => {
            (window as Window & { __qaFailure?: boolean }).__qaFailure = true;
          });
          await page.getByRole('button', { name: 'Save report', exact: true }).click();
          await page.getByRole('alert').waitFor();
          if ((await title.inputValue()) !== 'Keep useful results visible')
            throw new Error('Failed issue report lost the draft');
          if (
            (await page.locator('textarea[name="summary"]').inputValue()) !==
            'A second lookup failed and hid the first useful result.'
          )
            throw new Error('Failed issue report lost its description');
          await provenanceScreenshot(page, {
            path: path.join(output, `repair-form-error-390-${scheme}.png`),
            fullPage: true,
          });
          await page.getByRole('button', { name: 'Cancel', exact: true }).click();
          if (
            (await page
              .getByRole('button', { name: 'Report an issue', exact: true })
              .getAttribute('aria-expanded')) !== 'false'
          )
            throw new Error('Closed report retained expanded state');
          if (
            !(await page
              .getByRole('button', { name: 'Report an issue', exact: true })
              .evaluate((element) => element === document.activeElement))
          )
            throw new Error('Closing report did not restore focus');
          interactions.push({
            scheme,
            check:
              'Report disclosure exposes expanded state, moves focus to title, retains failed draft, and returns focus on cancel.',
          });
        }
        if (!selectedPages || selectedPages.includes('writing-voice')) {
          await page.goto(`${origin}/fixture/writing-voice`, { waitUntil: 'networkidle' });
          await page
            .getByLabel(/^The voice in one or two sentences/)
            .fill('Warm and clear. Lead with the decision.');
          await page.evaluate(() => {
            (window as Window & { __qaFailure?: boolean }).__qaFailure = true;
          });
          await page.getByRole('button', { name: 'Save voice', exact: true }).click();
          await page.getByRole('alert').waitFor();
          if (
            (await page.getByLabel(/^The voice in one or two sentences/).inputValue()) !==
            'Warm and clear. Lead with the decision.'
          )
            throw new Error('Failed writing voice save lost the draft');
          await provenanceScreenshot(page, {
            path: path.join(output, `voice-form-error-390-${scheme}.png`),
            fullPage: true,
          });
          await page.evaluate(() => {
            (window as Window & { __qaFailure?: boolean }).__qaFailure = false;
          });
          await page.getByRole('button', { name: 'Save voice', exact: true }).click();
          await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
          interactions.push({
            scheme,
            check:
              'Writing voice save failure announces an error and successful retry announces Saved.',
          });
        }
      }
      await context.close();
    }
  }
  const pngs = (await readdir(output)).filter((file) => file.endsWith('.png'));
  const declaredHydratedScreenshots = measurements.flatMap((entry) => {
    const proof = entry.scrollingProof as {
      topScreenshot?: string;
      composerScreenshot?: string;
      composerStartScreenshot?: string;
      jumpOutcomes?: Array<{ screenshot: string }>;
    } | null;
    return [
      entry.screenshot,
      proof?.topScreenshot,
      proof?.composerScreenshot,
      proof?.composerStartScreenshot,
      ...(proof?.jumpOutcomes?.map((entry) => entry.screenshot) ?? []),
    ].filter((name): name is string => typeof name === 'string');
  });
  if (
    hydrateChat &&
    (measurements.length !== (chatStates ? 4 : 8) ||
      pngs.length !== declaredHydratedScreenshots.length ||
      pngs.some((name) => !declaredHydratedScreenshots.includes(name)))
  )
    throw new Error('Hydrated evidence must contain exactly its declared layouts and screenshots');
  if (
    hydrateChat &&
    (blockedRequests > 0 ||
      syntheticApiRequests.some(
        (request) =>
          request.method !== 'GET' ||
          (request.path !== '/api/chat/status' &&
            !(cardChat === 'image' && request.path === '/api/card-image')),
      ))
  )
    throw new Error('Hydrated chat attempted an unexpected account or external request');
  let combined = measurements;
  if (selectedPages && !hydrateChat) {
    const previous = JSON.parse(
      await readFile(path.join(output, 'measurements.json'), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '{"measurements":[]}';
          throw error;
        },
      ),
    ) as {
      measurements: Array<Record<string, unknown>>;
    };
    const refreshed = new Set(measurements.map((entry) => entry.screenshot));
    combined = [
      ...previous.measurements.filter((entry) => !refreshed.has(entry.screenshot)),
      ...measurements,
    ];
  }
  const latestComponentHash = await componentInputHash();
  combined = await Promise.all(
    combined.map(async (entry) => {
      const fixture = allPages.find((page) => page.name === entry.name);
      const freshness = fixture
        ? visualCaptureFreshness(
            entry.provenance as VisualCaptureReceipt | undefined,
            await captureInputs(fixture, latestComponentHash),
            evidenceMode(fixture),
          )
        : 'unknown';
      const pixelsMatch =
        entry.provenance &&
        visualHash(await readFile(path.join(output, String(entry.screenshot))).catch(() => '')) ===
          (entry.provenance as VisualCaptureReceipt).screenshotSha256;
      return { ...entry, freshness: pixelsMatch ? freshness : 'unknown' };
    }),
  );
  // Hydrated chat is a separate evidence series; static selective recaptures
  // still require the complete product matrix.
  const expectedPages = hydrateChat
    ? pages
    : staticLargeText
      ? allPages.filter((entry) => !isConversationFixture(entry))
      : allPages;
  const expectedScreenshots = expectedPages.flatMap((entry) =>
    captureWidths.flatMap((width) =>
      ['light', 'dark'].map((scheme) => `${entry.name}-${width}-${scheme}.png`),
    ),
  );
  const currentScreenshots = new Set(
    combined.filter((entry) => entry.freshness === 'current').map((entry) => entry.screenshot),
  );
  const missingCurrentScreenshots = expectedScreenshots.filter(
    (name) => !currentScreenshots.has(name),
  );
  const retainedReceipts = new Map<
    string,
    { screenshot: string; fixture: string; provenance: VisualCaptureReceipt }
  >();
  for (const file of await readdir(path.join(output, 'capture-receipts'))) {
    if (!file.endsWith('.json')) continue;
    const receipt = JSON.parse(
      await readFile(path.join(output, 'capture-receipts', file), 'utf8'),
    ) as { screenshot: string; fixture: string; provenance: VisualCaptureReceipt };
    const previous = retainedReceipts.get(receipt.screenshot);
    if (!previous || previous.provenance.capturedAt < receipt.provenance.capturedAt)
      retainedReceipts.set(receipt.screenshot, receipt);
  }
  const captureInventory = await Promise.all(
    pngs.map(async (screenshot) => {
      const retained = retainedReceipts.get(screenshot);
      const fixture = allPages.find((entry) => entry.name === retained?.fixture);
      const pixelsMatch =
        retained &&
        visualHash(await readFile(path.join(output, screenshot))) ===
          retained.provenance.screenshotSha256;
      const freshness =
        fixture && pixelsMatch
          ? visualCaptureFreshness(
              retained?.provenance,
              await captureInputs(fixture, latestComponentHash),
              evidenceMode(fixture),
            )
          : 'unknown';
      return { screenshot, freshness, provenance: retained?.provenance ?? null };
    }),
  );
  const currentCoverage =
    missingCurrentScreenshots.length === 0 &&
    combined.every((entry) => entry.freshness === 'current') &&
    captureInventory.every((entry) => entry.freshness === 'current');
  const sourceFiles = hydrateChat
    ? [
        'apps/web/app/chat/[id]/chat-client.tsx',
        'apps/web/app/chat/[id]/message-view.tsx',
        'apps/web/app/chat/[id]/use-chat-polling.ts',
        'apps/web/app/chat/conversation-page.tsx',
        'apps/web/app/conversation.css',
        'apps/web/app/globals.css',
        'apps/web/app/layout.tsx',
        'apps/web/lib/ui.tsx',
        'apps/web/app/product-visual-fixture.test.tsx',
        'scripts/product-visual-qa.ts',
      ]
    : [];
  const sourceSha256 = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(path.join(root, file)))
          .digest('hex'),
      ]),
    ),
  );
  const boundary = hydrateChat
    ? {
        client: 'Actual ChatClient, AI SDK useChat, useChatPolling and composer layout effects',
        mocks: [
          'Next navigation',
          'server actions',
          chatStates
            ? 'local running GET chat-status responses and rejecting cancellation stub'
            : 'local empty GET chat-status responses',
        ],
        serverActions: combined.reduce(
          (total, entry) => total + Number(entry.actionInvocations),
          0,
        ),
        externalRequestsAttempted: blockedRequests,
        simulatedCancellationFailures: combined.reduce(
          (total, entry) => total + Number(entry.simulatedCancellationFailures),
          0,
        ),
        syntheticStatusReads: syntheticApiRequests.filter(
          (request) => request.path === '/api/chat/status',
        ).length,
        syntheticImageReads: syntheticApiRequests.filter(
          (request) => request.path === '/api/card-image',
        ).length,
        ownerReads: 0,
        providerCalls: 0,
        sendsOrVoiceExercised: false,
        liveRouteAdmissionExercised: false,
      }
    : null;
  if (hydrateChat)
    await writeFile(
      path.join(output, 'manifest.json'),
      `${JSON.stringify(
        {
          kind: chatStates
            ? 'hydrated-retained-chat-recall-failure-states'
            : 'hydrated-retained-chat-source-layouts',
          layouts: combined.length,
          pages: combined.map((entry) => ({
            name: entry.name,
            route: entry.route,
            source: entry.source,
            availability: entry.availability,
            state: entry.state,
            scheme: entry.scheme,
            width: entry.width,
            screenshot: entry.screenshot,
            screenshotWidth: entry.screenshotWidth,
            screenshotHeight: entry.screenshotHeight,
            hydrated: true,
          })),
          boundary,
          sourceSha256,
        },
        null,
        2,
      )}\n`,
    );
  await writeFile(
    path.join(output, 'measurements.json'),
    `${JSON.stringify(
      {
        before,
        hydrateChat,
        boundary,
        sourceSha256,
        fixturePages: selectedPages && !hydrateChat ? allPages.length : pages.length,
        matrixScreenshotCount: combined.length,
        screenshotCount: pngs.length,
        stylesheetSha256: sourceHash,
        stylesheetBytes: Buffer.byteLength(css.css),
        conversationStylesheetSha256: conversationHash,
        conversationStylesheetBytes:
          conversationCss === null ? 0 : Buffer.byteLength(conversationCss),
        blockedRequests,
        syntheticApiRequests,
        currentCoverage,
        coverageScope: hydrateChat
          ? selectedPages
          : staticLargeText
            ? 'non-conversation-product-states; use hydrated chat for enlarged conversation'
            : 'all-product-states',
        captureProfile: { widths: captureWidths, rootFontSize, longChat, cardChat },
        captureInventory,
        missingCurrentScreenshots,
        staleOrUnknownScreenshots: combined
          .filter((entry) => entry.freshness !== 'current')
          .map((entry) => entry.screenshot),
        measurements: combined,
        interactions,
        recapturedPages: selectedPages ?? null,
      },
      null,
      2,
    )}\n`,
  );
  // The main artifact manifest must carry the same per-capture qualification;
  // regenerating its HTML/CSS does not make retained pixels current.
  const artifactManifestPath = path.join(output, 'manifest.json');
  const artifactManifest = JSON.parse(await readFile(artifactManifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(
    artifactManifestPath,
    `${JSON.stringify(
      {
        ...artifactManifest,
        currentCoverage,
        coverageScope: hydrateChat
          ? selectedPages
          : staticLargeText
            ? 'non-conversation-product-states; use hydrated chat for enlarged conversation'
            : 'all-product-states',
        captureProfile: { widths: captureWidths, rootFontSize, longChat, cardChat },
        captureInventory,
        missingCurrentScreenshots,
        provenancePolicy:
          'Only each immutable capture receipt identifies its tested inputs. Current source metadata is not a receipt for retained images.',
      },
      null,
      2,
    )}\n`,
  );
  if (process.argv.includes('--require-current'))
    requireCurrentVisualCoverage(
      [
        ...captureInventory,
        ...missingCurrentScreenshots.map((screenshot) => ({ screenshot, freshness: 'unknown' })),
      ].map((entry) => ({
        screenshot: String(entry.screenshot),
        freshness: String(entry.freshness),
      })),
    );
  process.stdout.write(
    `${pages.length} synthetic source states; ${pngs.length} full-page screenshots; ${blockedRequests} account/external requests blocked.\n`,
  );
} finally {
  await browser.close();
  server.close();
}
