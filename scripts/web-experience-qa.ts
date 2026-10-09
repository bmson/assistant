/** Synthetic browser QA: actual components and CSS; no Next server, database, or model calls. */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? '/tmp/assistant-web-experience-qa');
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
// esbuild is supplied by the existing tsx runtime; no new workspace dependency.
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
const fixtures = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', 'apps/web/app/console-visual-fixture.test.tsx'],
  {
    cwd: root,
    env: { ...process.env, WEB_EXPERIENCE_QA_DIR: output },
    encoding: 'utf8',
  },
);
if (fixtures.status !== 0) throw new Error(`${fixtures.stdout}\n${fixtures.stderr}`);
const cssFile = path.join(root, 'apps/web/app/globals.css');
const css = await postcss([tailwind({ base: path.join(root, 'apps/web') })]).process(
  await readFile(cssFile, 'utf8'),
  { from: cssFile },
);
await writeFile(path.join(output, 'style.css'), css.css);
await build({
  stdin: {
    contents: `import React from 'react'; import { hydrateRoot, createRoot } from 'react-dom/client';
import { AdminNavigation } from './app/admin-navigation';
import { AppearanceMenu } from './app/appearance-control';
import { SecurityClient } from './app/security/security-client';
import { SignInClient } from './app/signin/signin-client';
import { SetupClient } from './app/setup/setup-client';
import { MobileTokenPanel } from './app/settings/mobile-token';
import { InvestigationBrief } from './app/audit/[id]/investigation-brief';
import RouteError from './app/error';
const nav = document.querySelector('nav[aria-label="Administration"]');
if (nav) { const passkey = nav.textContent.includes('Security'); const host = document.createElement('div'); nav.replaceWith(host); createRoot(host).render(<AdminNavigation passkey={passkey} />); }
for (const host of document.querySelectorAll('[data-qa-client]')) {
const name = host.dataset.qaClient;
const clients = {
appearance: () => <AppearanceMenu />,
security: () => <SecurityClient serverUrl={host.dataset.serverUrl} mode={host.dataset.securityMode} />,
signin: () => <SignInClient />,
setup: () => <SetupClient />,
'mobile-token': () => <MobileTokenPanel serverUrl={host.dataset.serverUrl} maskedToken={host.dataset.maskedToken || null} canRotate={host.dataset.canRotate === 'true'} />,
investigation: () => <InvestigationBrief prompt={host.dataset.prompt} />,
'route-error': () => <RouteError error={new Error('Synthetic error')} retry={() => Reflect.set(window, '__qaPageRetries', (Reflect.get(window, '__qaPageRetries') || 0) + 1)} />,
};
if (clients[name]) hydrateRoot(host, clients[name](), { identifierPrefix: 'qa-' + name + '-' });
}`,
    resolveDir: path.join(root, 'apps/web'),
    sourcefile: 'web-console-preview.tsx',
    loader: 'tsx',
  },
  outfile: path.join(output, 'client.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'synthetic-next-navigation',
      setup(builder) {
        builder.onResolve({ filter: /^@simplewebauthn\/browser$/ }, (args) => ({
          path: args.path,
          namespace: 'qa-passkeys',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'qa-passkeys' }, () => ({
          contents:
            'export async function startRegistration() { return { id: "synthetic-passkey-not-a-credential" }; } export async function startAuthentication() { throw new DOMException("Synthetic cancellation", "NotAllowedError"); }',
          loader: 'js',
        }));
        builder.onResolve({ filter: /^@\/app\/settings\/actions$/ }, (args) => ({
          path: args.path,
          namespace: 'qa-actions',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'qa-actions' }, () => ({
          contents:
            'export async function rotateMobileToken() { window.__qaRotations = (window.__qaRotations || 0) + 1; return window.__qaRotationError ? { error: "Synthetic replacement unavailable." } : { token: "synthetic-replacement-key-not-a-credential" }; }',
          loader: 'js',
        }));
        builder.onResolve({ filter: /^next\/(link|navigation)$/ }, (args) => ({
          path: args.path,
          namespace: 'qa',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'qa' }, (args) => ({
          contents:
            args.path === 'next/link'
              ? `import React from 'react'; export default function Link({href,prefetch,...props}) { return React.createElement('a',{...props,href}); }`
              : `export const usePathname = () => location.pathname;`,
          loader: 'js',
          resolveDir: path.join(root, 'apps/web'),
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
const routes: Record<string, string> = {
  '/settings': 'settings',
  '/settings?auth=google': 'settings-token',
  '/settings?auth=google&rotate=true': 'settings-token-rotate',
  '/security': 'security',
  '/signin': 'signin',
  '/setup': 'setup',
  '/audit': 'audit',
  '/audit/00000000-0000-4000-8000-000000000001': 'audit-detail',
  '/preview/global-error': 'global-error',
  '/preview/long-content': 'long-content',
  '/preview/not-found': 'not-found',
  '/preview/route-error': 'route-error',
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/client.js' || pathname === '/style.css') {
      response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      response.end(await readFile(path.join(output, pathname.slice(1))));
      return;
    }
    const name =
      routes[
        url.searchParams.get('auth') === 'google'
          ? `${pathname}?auth=google${url.searchParams.get('rotate') === 'true' ? '&rotate=true' : ''}`
          : pathname
      ];
    if (!name) {
      response.writeHead(404);
      response.end('Synthetic preview only');
      return;
    }
    const html = (await readFile(path.join(output, `${name}.html`), 'utf8'))
      .replace('</head>', '<link rel="stylesheet" href="/style.css"></head>')
      .replace('</body>', '<script type="module" src="/client.js"></script></body>');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html);
  } catch {
    response.writeHead(500);
    response.end('Fixture unavailable');
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No synthetic server address');
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const measurements: unknown[] = [];
const blockedRequests: string[] = [];
async function guardPreviewRequests(page: import('playwright').Page) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) {
      blockedRequests.push(`${url.protocol}//${url.host}${url.pathname}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}
let mutations = 0;
async function checkCredentialReceipts() {
  const checks: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      viewport: { width: scheme === 'light' ? 320 : 390, height: 844 },
      colorScheme: scheme,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await guardPreviewRequests(page);
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && /hydration|hydrated|server rendered/i.test(message.text()))
        failures.push(message.text());
    });
    let failReads = false;
    let failMutations = false;
    const requests: Array<{ method: string; path: string; action?: string }> = [];
    const passkeys = [
      {
        id: 'receipt-old-passkey',
        label: 'Existing passkey',
        createdAt: '2026-10-03T00:00:00Z',
        lastUsedAt: null,
        revokedAt: null,
        backedUp: false,
      },
    ];
    let devices = [
      {
        id: 'receipt-old-device',
        name: 'Existing phone',
        createdAt: '2026-10-03T00:00:00Z',
        revokedAt: null,
      },
    ];
    await page.route('**/api/owner/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const body =
        method === 'GET' ? {} : (request.postDataJSON() as { action?: string; name?: string });
      requests.push({ method, path: url.pathname, action: body.action });
      if (method === 'GET') {
        // One projection can return fresh state while the other fails. Neither
        // list may be published until the complete refresh succeeds.
        await route.fulfill({
          status: failReads && url.pathname.endsWith('/devices') ? 503 : 200,
          json: url.pathname.endsWith('/passkeys') ? { passkeys } : { devices },
        });
      } else if (failMutations) {
        await route.fulfill({ status: 503, json: { error: 'synthetic_failure' } });
      } else if (url.pathname.endsWith('/devices') && method === 'POST') {
        devices.push({
          id: `receipt-new-device-${requests.length}`,
          name: body.name ?? 'iPhone',
          createdAt: '2026-10-03T00:00:00Z',
          revokedAt: null,
        });
        failReads = true;
        await route.fulfill({ json: { token: 'synthetic-receipt-device-key-not-a-credential' } });
      } else if (url.pathname.endsWith('/devices') && method === 'DELETE') {
        devices = devices.filter((device) => device.id !== url.searchParams.get('id'));
        failReads = true;
        await route.fulfill({ json: { ok: true } });
      } else if (url.pathname.endsWith('/recovery-code')) {
        await route.fulfill({ json: { recoveryCode: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' } });
      } else if (url.pathname.endsWith('/passkeys') && body.action === 'options') {
        await route.fulfill({
          json: { options: {}, challengeToken: 'synthetic-receipt-challenge' },
        });
      } else if (url.pathname.endsWith('/passkeys') && body.action === 'verify') {
        passkeys.push({
          id: 'receipt-new-passkey',
          label: 'Added passkey',
          createdAt: '2026-10-03T00:00:00Z',
          lastUsedAt: null,
          revokedAt: null,
          backedUp: false,
        });
        failReads = true;
        await route.fulfill({ json: { ok: true } });
      } else {
        throw new Error(`Unexpected synthetic owner request: ${method} ${url.pathname}`);
      }
    });
    const writes = () => requests.filter((request) => request.method !== 'GET');
    const assertText = async (text: string) => {
      await page.getByText(text, { exact: true }).waitFor();
    };
    const assertFreshControls = async () => {
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find(
          (element) => element.textContent?.trim() === 'Create device key',
        );
        return button && !button.disabled;
      });
    };
    const assertStale = async () => {
      await page.getByText('The change is saved, but the', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Refresh lists', exact: true }).waitFor();
      if (
        !(await page.getByRole('button', { name: 'Create device key', exact: true }).isDisabled())
      )
        throw new Error('A stale credential projection allows repeated creation');
      if (!(await page.getByRole('button', { name: 'Add a passkey', exact: true }).isDisabled()))
        throw new Error('A stale credential projection allows repeated passkey registration');
      if (
        !(await page
          .getByRole('button', { name: 'Replace recovery code', exact: true })
          .isDisabled())
      )
        throw new Error('A stale credential projection allows recovery replacement');
      if (await page.getByText('Something went wrong. Try again.', { exact: true }).count())
        throw new Error('Confirmed credential effect is represented as a failed action');
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error('The credential receipt or stale-list warning overflows the phone');
    };
    const refreshWithoutWrites = async () => {
      const before = writes().length;
      failReads = false;
      await page.getByRole('button', { name: 'Refresh lists', exact: true }).click();
      await page
        .getByRole('button', { name: 'Refresh lists', exact: true })
        .waitFor({ state: 'hidden' });
      await assertFreshControls();
      if (writes().length !== before)
        throw new Error('Refreshing a stale list repeats a credential mutation');
    };

    await page.goto(`${base}/security`);
    await assertText('Existing passkey');
    await assertFreshControls();
    await page.getByLabel('Device name', { exact: true }).fill('Travel phone');
    await page.getByRole('button', { name: 'Create device key', exact: true }).click();
    await assertText(
      'Device key created for “Travel phone”. Copy the key below into that device’s Connection screen; it will not be shown again.',
    );
    await assertText('synthetic-receipt-device-key-not-a-credential');
    await assertStale();
    if (writes().length !== 1) throw new Error('Creation did not make exactly one mutation');
    if (
      await page
        .getByRole('button', { name: 'Device options for Travel phone', exact: true })
        .count()
    )
      throw new Error('A partially refreshed device list replaced the last known list');
    await page.screenshot({
      path: path.join(output, `security-created-refresh-failed-${scheme}.png`),
      fullPage: true,
    });
    const writesBeforeRetry = writes().length;
    await page.getByRole('button', { name: 'Refresh lists', exact: true }).click();
    await assertText(
      'The lists still could not refresh. Your confirmed change is saved. Check the connection and try Refresh lists again.',
    );
    await assertText('synthetic-receipt-device-key-not-a-credential');
    await assertStale();
    if (writes().length !== writesBeforeRetry)
      throw new Error('A failed list retry repeats device creation');
    await refreshWithoutWrites();
    await page
      .getByRole('button', { name: 'Device options for Travel phone', exact: true })
      .waitFor();
    await assertText('synthetic-receipt-device-key-not-a-credential');
    checks.push(
      `${scheme}: create confirmed → partial GET failure → failed read-only retry → successful read-only retry; token retained`,
    );

    const readsBeforeRecovery = requests.filter((request) => request.method === 'GET').length;
    await page.getByRole('button', { name: 'Replace recovery code', exact: true }).click();
    await page.getByRole('button', { name: 'Replace recovery code?', exact: true }).click();
    await assertText(
      'Recovery code replaced. The old code no longer works. Save the new code below before leaving.',
    );
    await assertText('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE');
    await assertFreshControls();
    if (requests.filter((request) => request.method === 'GET').length !== readsBeforeRecovery)
      throw new Error('Recovery replacement requires an irrelevant projection refresh');
    await page
      .getByRole('button', { name: 'Device options for Existing phone', exact: true })
      .click();
    await page.getByRole('button', { name: 'Revoke device key', exact: true }).click();
    await page.getByRole('button', { name: 'Revoke device key?', exact: true }).click();
    await assertText('Device key for “Existing phone” revoked. Other devices stay connected.');
    await assertStale();
    await assertText('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE');
    await assertText('synthetic-receipt-device-key-not-a-credential');
    await page.keyboard.press('Escape');
    await page
      .getByRole('button', { name: 'Device options for Existing phone', exact: true })
      .click();
    if (!(await page.getByRole('button', { name: 'Revoke device key', exact: true }).isDisabled()))
      throw new Error('A stale device row invites a duplicate revoke');
    await page.keyboard.press('Escape');
    await page.screenshot({
      path: path.join(output, `security-revoked-refresh-failed-${scheme}.png`),
      fullPage: true,
    });
    await refreshWithoutWrites();
    if (
      await page
        .getByRole('button', { name: 'Device options for Existing phone', exact: true })
        .count()
    )
      throw new Error('A recovered device list retains the revoked device');
    if (writes().filter((request) => request.method === 'DELETE').length !== 1)
      throw new Error('A stale-list retry repeats device revocation');
    checks.push(
      `${scheme}: recovery replacement requires no GET; subsequent confirmed revoke preserves both one-time secrets; retry makes no DELETE`,
    );

    const beforePasskey = writes().length;
    await page.getByRole('button', { name: 'Add a passkey', exact: true }).click();
    await assertText('Passkey added on this device. You can use it to sign in.');
    await assertStale();
    if (await page.getByText('Added passkey', { exact: true }).count())
      throw new Error('A partial projection read publishes only one fresh list');
    const enrollment = writes().slice(beforePasskey);
    if (
      enrollment.length !== 2 ||
      enrollment[0]?.action !== 'options' ||
      enrollment[1]?.action !== 'verify'
    )
      throw new Error(
        'Passkey enrollment must contain exactly the authorized options and verification requests',
      );
    await page.screenshot({
      path: path.join(output, `security-passkey-refresh-failed-${scheme}.png`),
      fullPage: true,
    });
    await refreshWithoutWrites();
    await assertText('Added passkey');
    checks.push(
      `${scheme}: passkey options + verify confirmed → partial GET failure; old lists retained; GET-only retry publishes added passkey`,
    );

    await page.goto(`${base}/security`);
    await assertText('Existing passkey');
    await assertFreshControls();
    failMutations = true;
    const requestsBeforeFailure = requests.length;
    await page.getByLabel('Device name', { exact: true }).fill('Failed phone');
    await page.getByRole('button', { name: 'Create device key', exact: true }).click();
    await assertText('Something went wrong. Try again.');
    await assertFreshControls();
    if (await page.getByText('Last confirmed change', { exact: true }).count())
      throw new Error('A failed creation has a success receipt');
    if (
      await page.getByText('synthetic-receipt-device-key-not-a-credential', { exact: true }).count()
    )
      throw new Error('A failed creation has a fabricated token');
    if (await page.getByRole('button', { name: 'Refresh lists', exact: true }).count())
      throw new Error('A failed mutation has a misleading stale-success notice');
    if (requests.slice(requestsBeforeFailure).some((request) => request.method === 'GET'))
      throw new Error('Failed mutation unexpectedly refreshes projections');
    if ((await page.getByLabel('Device name', { exact: true }).inputValue()) !== 'Failed phone')
      throw new Error('A failed mutation loses the owner draft');
    checks.push(
      `${scheme}: failed POST has real error, no success/secret/stale-success notice, no GET, draft preserved`,
    );

    failMutations = false;
    await page.goto(`${base}/settings`);
    await page
      .getByRole('button', { name: 'Device options for Travel phone', exact: true })
      .waitFor();
    await assertFreshControls();
    const requestsBeforePairing = requests.length;
    await page.getByLabel('Device name', { exact: true }).fill('Pairing phone');
    await page.getByRole('button', { name: 'Create device key', exact: true }).click();
    await page
      .getByText('The change is saved, but the device list could not refresh.', { exact: false })
      .waitFor();
    await assertText('synthetic-receipt-device-key-not-a-credential');
    if (requests.slice(requestsBeforePairing).some((request) => request.path.endsWith('/passkeys')))
      throw new Error('Pairing refresh unexpectedly reads passkeys');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    const clips = await page.evaluate(() =>
      [...document.querySelectorAll('main button, main input')]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && (box.left < 0 || box.right > innerWidth + 1);
        })
        .map((element) => element.textContent),
    );
    if (
      clips.length ||
      (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    )
      throw new Error(`Enlarged stale receipt clips the viewport: ${clips.join(', ')}`);
    await page.screenshot({
      path: path.join(output, `settings-created-refresh-failed-large-${scheme}.png`),
      fullPage: true,
    });
    await refreshWithoutWrites();
    checks.push(
      `${scheme}: Settings pairing receipt, device-only retry, retained token, 200% text without clipping`,
    );

    if (failures.length) throw new Error(failures.join('\n'));
    await context.close();
  }
  await writeFile(
    path.join(output, 'security-receipts.json'),
    `${JSON.stringify({ checks, authBoundary: 'Synthetic owner API and WebAuthn; actual hydrated SecurityClient + shared controls and CSS.', noLiveCredentials: true }, null, 2)}\n`,
  );
  console.log(`Security receipt scenarios passed: ${checks.length} checks. Artifacts: ${output}`);
}
try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const viewport of [
      { width: 1280, height: 960 },
      { width: 390, height: 844 },
      { width: 320, height: 740 },
      { width: 640, height: 900 },
    ]) {
      const context = await browser.newContext({
        viewport,
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      await guardPreviewRequests(page);
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(error.message));
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          /hydration|hydrated|server rendered/i.test(message.text())
        )
          failures.push(message.text());
      });
      await page.route('**/api/owner/**', async (route) => {
        const request = route.request();
        if (request.method() !== 'GET') {
          mutations++;
          await route.fulfill({ json: {} });
          return;
        }
        await route.fulfill({
          json: request.url().includes('/passkeys')
            ? {
                passkeys: [
                  {
                    id: 'fixture-passkey',
                    label: 'MacBook passkey',
                    createdAt: '2026-10-01T17:00:00Z',
                    lastUsedAt: null,
                    revokedAt: null,
                    backedUp: true,
                  },
                  {
                    id: 'fixture-backup',
                    label: 'Backup hardware key',
                    createdAt: '2026-10-01T17:00:00Z',
                    lastUsedAt: null,
                    revokedAt: null,
                    backedUp: false,
                  },
                ],
              }
            : {
                devices: [
                  {
                    id: 'fixture-device',
                    name: 'Personal iPhone',
                    createdAt: '2026-10-01T17:00:00Z',
                    revokedAt: null,
                  },
                ],
              },
        });
      });
      for (const [route, name] of Object.entries(routes)) {
        const start = performance.now();
        await page.goto(
          `${base}${route}${name === 'setup' ? '#claim=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' : ''}`,
        );
        if (name !== 'global-error')
          await page.getByRole('button', { name: 'Appearance', exact: true }).waitFor();
        else await page.getByRole('heading', { level: 1 }).waitFor();
        if (name === 'security') await page.getByText('MacBook passkey', { exact: true }).waitFor();
        if (name === 'settings')
          await page
            .getByRole('button', { name: 'Device options for Personal iPhone', exact: true })
            .waitFor();
        const contentReadyMs = Math.round(performance.now() - start);
        await page.screenshot({
          path: path.join(output, `${name}-${viewport.width}-${scheme}.png`),
          fullPage: true,
        });
        const metrics = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          zoom: getComputedStyle(document.documentElement).touchAction,
          headingCount: document.querySelectorAll('h1').length,
          dark: document.documentElement.classList.contains('dark'),
          headerHeight:
            document.querySelector('body > header')?.getBoundingClientRect().height ?? null,
          selectedEvidenceTop:
            [...document.querySelectorAll('h2')]
              .find((heading) => heading.textContent?.startsWith('Tool actions'))
              ?.getBoundingClientRect().top ?? null,
        }));
        if (metrics.scrollWidth > metrics.width)
          throw new Error(`${name} overflows at ${viewport.width}`);
        if (metrics.headingCount !== 1)
          throw new Error(`${name} has ${metrics.headingCount} page titles`);
        if (metrics.dark !== (scheme === 'dark'))
          throw new Error(`${name} does not follow system appearance`);
        if (viewport.width === 320 && metrics.headerHeight && metrics.headerHeight > 125)
          throw new Error(`${name} has oversized phone chrome`);
        if (
          name === 'audit-detail' &&
          metrics.selectedEvidenceTop !== null &&
          metrics.selectedEvidenceTop >= metrics.height
        )
          throw new Error(`${name} hides the first evidence heading below the viewport`);
        measurements.push({
          route,
          scheme,
          viewport: viewport.width,
          syntheticContentReadyMs: contentReadyMs,
          ...metrics,
        });
        if (failures.length)
          throw new Error(`${name} ${viewport.width}px ${scheme}: ${failures.join('\n')}`);
      }
      if (failures.length) throw new Error(failures.join('\n'));
      await context.close();
    }
  }
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  await guardPreviewRequests(page);
  await page.route('**/api/owner/**', (route) =>
    route.fulfill({
      json: route.request().url().includes('/passkeys') ? { passkeys: [] } : { devices: [] },
    }),
  );
  await page.goto(`${base}/security`);
  await page.getByText('No device keys yet.', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(output, 'security-empty.png'), fullPage: true });
  await page.keyboard.press('Tab');
  if ((await page.locator(':focus').textContent()) !== 'Skip to content')
    throw new Error('Skip link is not first keyboard stop');
  await page.keyboard.press('Enter');
  if ((await page.locator(':focus').getAttribute('id')) !== 'main-content')
    throw new Error('Skip link does not move focus');
  const appearanceTrigger = page.getByRole('button', { name: 'Appearance', exact: true });
  await appearanceTrigger.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  if ((await page.locator(':focus').getAttribute('aria-label')) !== 'Appearance')
    throw new Error('Appearance popover does not follow its invoker in keyboard order');
  await page.screenshot({ path: path.join(output, 'appearance-menu.png'), fullPage: true });
  await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await page.emulateMedia({ colorScheme: 'light' });
  if (!(await page.locator('html').getAttribute('class'))?.includes('dark'))
    throw new Error('Explicit dark preference was lost');
  await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('system');
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await page.keyboard.press('Escape');
  await page
    .getByRole('combobox', { name: 'Appearance', exact: true })
    .waitFor({ state: 'hidden' });
  if ((await page.locator(':focus').getAttribute('title')) !== 'Appearance')
    throw new Error('Appearance Escape does not return focus to its invoker');
  await page.setViewportSize({ width: 320, height: 180 });
  await appearanceTrigger.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const bounds = document.querySelector('[popover]:popover-open')?.getBoundingClientRect();
    return bounds && bounds.y >= 8 && bounds.y + bounds.height <= 172;
  });
  const appearanceBounds = await page.getByRole('region', { name: 'Appearance' }).boundingBox();
  if (
    !appearanceBounds ||
    appearanceBounds.y < 8 ||
    appearanceBounds.y + appearanceBounds.height > 172 ||
    appearanceBounds.x < 8 ||
    appearanceBounds.x + appearanceBounds.width > 312
  )
    throw new Error('Appearance popover escapes a short phone viewport');
  await page.screenshot({ path: path.join(output, 'appearance-short-viewport.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  let ownerFailed = true;
  await page.unroute('**/api/owner/**');
  await page.route('**/api/owner/**', async (route) => {
    if (route.request().method() !== 'GET') {
      mutations++;
      await route.fulfill({ json: {} });
      return;
    }
    if (ownerFailed) {
      await route.fulfill({ status: 503, json: {} });
      return;
    }
    await route.fulfill({
      json: route.request().url().includes('/passkeys')
        ? {
            passkeys: [
              {
                id: 'fixture-last-key',
                label: 'Last passkey',
                createdAt: '2026-10-01T00:00:00Z',
                lastUsedAt: null,
                revokedAt: null,
                backedUp: false,
              },
            ],
          }
        : {
            devices: [
              {
                id: 'fixture-device',
                name: 'Test phone',
                createdAt: '2026-10-01T00:00:00Z',
                revokedAt: null,
              },
            ],
          },
    });
  });
  await page.goto(`${base}/security`);
  await page.getByRole('alert').waitFor();
  await page.screenshot({ path: path.join(output, 'security-error.png'), fullPage: true });
  ownerFailed = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('button', { name: 'Device options for Test phone', exact: true }).waitFor();
  const before = mutations;
  await page.getByRole('button', { name: 'Device options for Test phone', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke device key', exact: true }).click();
  if (mutations !== before) throw new Error('Revocation ran without confirmation');
  await page.getByRole('button', { name: 'Revoke device key?' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null);
  if (mutations !== before + 1) throw new Error('Confirmed revocation did not execute once');
  await page.getByRole('button', { name: 'Passkey options for Last passkey', exact: true }).click();
  if (!(await page.getByRole('button', { name: 'Remove passkey', exact: true }).isDisabled()))
    throw new Error('Last passkey removal is not protected');
  await page
    .getByText('Add a backup passkey before removing your last one.', { exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await page.goto(`${base}/settings?auth=google&rotate=true`);
  const replacement = page.getByRole('button', { name: 'Create a replacement key', exact: true });
  await replacement.click();
  if (await page.evaluate(() => '__qaRotations' in window))
    throw new Error('Key rotation ran without confirmation');
  await page.getByRole('button', { name: 'Confirm rotate', exact: true }).click();
  await page.getByText('synthetic-replacement-key-not-a-credential', { exact: true }).waitFor();
  await page.screenshot({
    path: path.join(output, 'settings-replacement-key.png'),
    fullPage: true,
  });
  if (!(await page.locator(':focus').textContent())?.startsWith('New key'))
    throw new Error('A replacement key does not receive focus');
  await page.evaluate(() => Reflect.set(window, '__qaRotationError', true));
  await replacement.click();
  await page.getByRole('button', { name: 'Confirm rotate', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.getByText('synthetic-replacement-key-not-a-credential', { exact: true }).waitFor();

  // Exercise actual auth presentation; the WebAuthn boundary and owner APIs
  // are synthetic. Never ask the OS to create a credential in this harness.
  const recoveryCode = 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE';
  let recoveryFailure = true;
  let recoveryGeneration = 0;
  await page.unroute('**/api/owner/**');
  await page.route('**/api/owner/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        json: request.url().includes('/passkeys')
          ? {
              passkeys: [
                {
                  id: 'synthetic-key',
                  label: 'Test passkey',
                  createdAt: '2026-10-03T00:00:00Z',
                  lastUsedAt: null,
                  revokedAt: null,
                  backedUp: false,
                },
              ],
            }
          : { devices: [] },
      });
      return;
    }
    const body = request.postDataJSON() as { action?: string };
    if (request.url().endsWith('/recovery-code')) {
      recoveryGeneration++;
      await route.fulfill({
        json: {
          recoveryCode: recoveryGeneration === 1 ? recoveryCode : 'ZZZZZ-YYYYY-XXXXX-WWWWW-VVVVV',
        },
      });
    } else if (request.url().endsWith('/devices')) {
      await route.fulfill({ json: { token: 'synthetic-device-key-not-a-credential' } });
    } else if (request.url().endsWith('/recovery') && recoveryFailure) {
      await route.fulfill({ status: 400, json: { error: 'recovery_invalid' } });
    } else {
      await route.fulfill({
        json:
          body.action === 'options'
            ? { options: {}, challengeToken: 'synthetic-challenge' }
            : { recoveryCode },
      });
    }
  });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${base}/signin`);
  const recoverySummary = page.getByText('Lost your passkey?', { exact: true });
  await recoverySummary.focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Recovery code', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'recovery-code');
  if ((await page.locator(':focus').getAttribute('id')) !== 'recovery-code')
    throw new Error('Opening recovery does not focus its input');
  await page.getByLabel('Recovery code', { exact: true }).fill(recoveryCode);
  await page.getByRole('button', { name: 'Add passkey with recovery code', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.screenshot({ path: path.join(output, 'signin-recovery-error.png'), fullPage: true });
  await recoverySummary.click();
  await page.getByRole('alert').waitFor({ state: 'hidden' });
  await recoverySummary.focus();
  await page.keyboard.press('Enter');
  if ((await page.getByLabel('Recovery code', { exact: true }).inputValue()) !== '')
    throw new Error('Closing recovery does not clear the sensitive code');
  recoveryFailure = false;
  await page.getByLabel('Recovery code', { exact: true }).fill(recoveryCode);
  await page.getByRole('button', { name: 'Add passkey with recovery code', exact: true }).click();
  await page.getByRole('heading', { name: 'Save your recovery code', exact: true }).waitFor();
  if ((await page.locator(':focus').textContent()) !== 'Save your recovery code')
    throw new Error('A successful recovery does not hand focus to the new code');
  if (!(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled()))
    throw new Error('Recovery continuation does not require acknowledgement');
  await page.evaluate(`Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => { throw new Error('Synthetic clipboard denial'); } },
  });`);
  await page.getByRole('button', { name: 'Copy recovery code', exact: true }).click();
  await page.getByText('Clipboard access is unavailable.', { exact: false }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Recovery code overflows the smallest phone');
  await page.screenshot({ path: path.join(output, 'recovery-copy-fallback.png'), fullPage: true });
  await page.evaluate(`Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value) => { Reflect.set(window, '__qaCopied', value); } },
  });`);
  await page.getByRole('button', { name: 'Copy recovery code', exact: true }).click();
  await page.getByText('Recovery code copied.', { exact: true }).waitFor();
  if ((await page.evaluate(() => Reflect.get(window, '__qaCopied'))) !== recoveryCode)
    throw new Error('Recovery copy does not preserve the exact code');
  await page.screenshot({
    path: path.join(output, 'recovery-code-phone-dark.png'),
    fullPage: true,
  });
  await page.getByRole('checkbox', { name: 'I saved the recovery code', exact: true }).check();
  if (await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled())
    throw new Error('Saved recovery code does not enable continuation');

  await page.goto(`${base}/security`);
  await page.getByText('Test passkey', { exact: true }).waitFor();
  const replaceRecovery = page.getByRole('button', { name: 'Replace recovery code', exact: true });
  await replaceRecovery.click();
  await page.getByRole('button', { name: 'Replace recovery code?', exact: true }).click();
  await page.getByRole('heading', { name: 'Save your recovery code', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'I saved the recovery code', exact: true }).check();
  await replaceRecovery.click();
  await page.getByRole('button', { name: 'Replace recovery code?', exact: true }).click();
  await page.getByText('ZZZZZ-YYYYY-XXXXX-WWWWW-VVVVV', { exact: true }).waitFor();
  if (
    await page.getByRole('checkbox', { name: 'I saved the recovery code', exact: true }).isChecked()
  )
    throw new Error('A replacement recovery code inherits an older acknowledgement');
  if ((await page.locator(':focus').textContent()) !== 'Save your recovery code')
    throw new Error('A replacement recovery code does not receive focus');
  await page.getByRole('button', { name: 'Create device key', exact: true }).click();
  await page.getByText('synthetic-device-key-not-a-credential', { exact: true }).waitFor();
  if (!(await page.locator(':focus').textContent())?.startsWith('Device key'))
    throw new Error('A new device key does not receive focus');
  await page.screenshot({ path: path.join(output, 'security-new-device-key.png'), fullPage: true });

  await page.goto(`${base}/audit/00000000-0000-4000-8000-000000000001`);
  await page.evaluate(`Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => { throw new Error('Synthetic clipboard denial'); } },
  });`);
  await page.getByText('Investigate with the assistant', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Copy investigation request', exact: true }).click();
  await page.getByText('Clipboard access is unavailable.', { exact: false }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Investigation copy fallback overflows the smallest phone');
  await page.screenshot({ path: path.join(output, 'audit-copy-fallback.png'), fullPage: true });
  await page.goto(`${base}/preview/route-error`);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.waitForFunction(() => Reflect.get(window, '__qaPageRetries') === 1);
  // Enlarged text catches clipping that a normal-size screenshot can conceal.
  for (const route of [
    '/settings',
    '/security',
    '/audit',
    '/signin',
    '/setup',
    '/preview/long-content',
  ]) {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(
      `${base}${route}${route === '/setup' ? '#claim=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' : ''}`,
    );
    await page.getByRole('button', { name: 'Appearance', exact: true }).waitFor();
    if (route === '/security') await page.getByText('Test passkey', { exact: true }).waitFor();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    const clipped = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          'main button, main input:not([type="hidden"]), main select, main textarea',
        ),
      ]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && (box.left < 0 || box.right > innerWidth + 1);
        })
        .map(
          (element) =>
            element.textContent?.trim() || element.getAttribute('aria-label') || element.tagName,
        ),
    );
    if (clipped.length)
      throw new Error(`${route} clips controls with enlarged text: ${clipped.join(', ')}`);
    await page.screenshot({
      path: path.join(output, `${routes[route] ?? route.slice(1)}-320-large-text.png`),
      fullPage: true,
    });
  }
  await checkCredentialReceipts();
  if (blockedRequests.length)
    throw new Error(
      `Unexpected external preview requests were blocked: ${blockedRequests.join(', ')}`,
    );
  await writeFile(
    path.join(output, 'measurements.json'),
    `${JSON.stringify(
      {
        measurements,
        checks: [
          `${measurements.length} responsive/theme renders`,
          'single page title',
          'no horizontal overflow',
          'system theme and explicit theme',
          'keyboard skip link',
          'security empty/error/retry',
          'revocation requires two activations',
          'key replacement requires confirmation and shows the full synthetic key',
          'compact 320px chrome',
          'selected audit evidence heading in initial viewport',
          'appearance popover and Escape dismissal',
          'native popover keyboard order and invoker focus restoration',
          'popover placement stays inside a short phone viewport',
          'last passkey cannot be removed',
          'recovery disclosure keyboard focus and sensitive-code clearing',
          'recovery failure followed by successful registration presentation',
          '320px recovery code wrapping, exact copy, and clipboard-denied fallback',
          'recovery acknowledgement gates continuation and resets for a replacement code',
          'new recovery/device/shared keys receive focus',
          'failed shared-key replacement preserves the existing one-time key',
          'investigation clipboard failure keeps a readable manual fallback',
          'isolated client hydration has no mismatch errors',
          'page-error retry invokes its callback once and offers a Settings destination',
          '320px layouts with 200% text keep controls inside the viewport',
          '10 confirmed credential/failed refresh scenarios; see security-receipts.json',
          'stale credential-list retries make GET requests only and preserve one-time secrets',
        ],
        cssBytes: Buffer.byteLength(css.css),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Synthetic web QA passed: ${measurements.length} renders. Artifacts: ${output}`);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
