/** Menu first-stage presentation only: no real confirmation, owner request or action write. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? '.workspace/menu-readability');
const before = process.argv.includes('--before');
await mkdir(output, { recursive: true });
const req = createRequire(path.join(root, 'package.json'));
const web = createRequire(path.join(root, 'apps/web/package.json'));
const { build } = createRequire(req.resolve('tsx'))('esbuild');
const postcss = createRequire(web.resolve('@tailwindcss/postcss'))('postcss');
const tailwind = web('@tailwindcss/postcss');
const files = [
  'apps/web/lib/ui.tsx',
  'apps/web/lib/ui-client.tsx',
  'apps/web/app/globals.css',
  'apps/web/app/goals/goal-card.tsx',
  'apps/web/app/security/security-client.tsx',
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(path.join(root, file)))
        .digest('hex'),
    ]),
  ),
);
const entry = `import React from ${JSON.stringify(web.resolve('react'))};
import {createRoot} from ${JSON.stringify(web.resolve('react-dom/client'))};
import {ActionMenu,ConfirmButton,SubmitButton,ActionButton} from ${JSON.stringify(path.join(root, 'apps/web/lib/ui-client.tsx'))};
import {btn} from ${JSON.stringify(path.join(root, 'apps/web/lib/ui.tsx'))};
const h=React.createElement,p=new URLSearchParams(location.search),kind=p.get('kind'),mode=p.get('mode');
const copy=kind==='goal'?['Run autonomously','Confirm — run autonomously','Enabling…']:kind==='passkey'?['Remove passkey','Remove passkey?','Working…']:kind==='device'?['Revoke device key','Revoke device key?','Working…']:['Delete','Delete?','Deleting…'];
const forbid=(event)=>{event?.preventDefault();document.body.dataset.forbiddenActions=String(Number(document.body.dataset.forbiddenActions)+1)};
const target=h('form',{'data-review-target':true,onSubmit:forbid},h(ConfirmButton,{variant:kind==='goal'?'menu':kind==='standalone'?'dangerOutline':'menuDanger',confirmLabel:copy[1],pendingLabel:copy[2],pending:mode==='pending',disabled:mode==='disabled',onConfirm:forbid},copy[0]));
const menu=kind==='goal'?h(ActionMenu,{label:'More',panelClassName:'w-56'},h('button',{type:'button','data-menu-close':true,className:btn.menu},'Edit goal'),target,h('form',{onSubmit:forbid},h(SubmitButton,{variant:'menu',pendingLabel:'Finishing…'},'Mark done')),h('form',{onSubmit:forbid},h(SubmitButton,{variant:'menu',pendingLabel:'Archiving…'},'Archive')),h(ConfirmButton,{variant:'menuDanger',confirmLabel:'Confirm — stop goal',pendingLabel:'Stopping…',onConfirm:forbid},'Stop goal')):h(ActionMenu,{label:'More'},target,h('p',{className:'px-3 py-2 text-xs leading-5 text-muted'},kind==='passkey'?'Removing it signs out every browser.':'This device will lose access. Other devices stay connected.'));
createRoot(document.getElementById('fixture')).render(kind==='standalone'?target:menu);`;
const js = (
  await build({
    stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
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
const server = createServer((request, response) => {
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/client.js') {
    response.setHeader('content-type', 'text/javascript');
    response.end(js);
    return;
  }
  if (url.pathname === '/style.css') {
    response.setHeader('content-type', 'text/css');
    response.end(css);
    return;
  }
  response.setHeader('content-type', 'text/html');
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="min-h-dvh bg-surface font-sans text-strong antialiased" data-forbidden-actions="0"><main class="page-gutter mx-auto min-w-0 max-w-4xl py-7 sm:py-10"><h1>Menu readability</h1><div id="fixture" class="mt-6" ${url.searchParams.has('bottom') ? 'style="margin-top:550px"' : ''}></div></main><script src="/client.js"></script></body></html>`,
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const profiles = [
  { width: 390, fontSize: 16, scheme: 'light' },
  { width: 390, fontSize: 16, scheme: 'dark' },
  { width: 320, fontSize: 32, scheme: 'light' },
  { width: 320, fontSize: 32, scheme: 'dark' },
] as const;
type Kind = 'goal' | 'passkey' | 'device' | 'standalone';
type Mode = 'normal' | 'pending' | 'disabled';
const cases = profiles.flatMap((profile) =>
  (['goal', 'passkey', 'device'] as Kind[]).map((kind) => ({
    profile,
    kind,
    mode: 'normal' as Mode,
    bottom: false,
  })),
);
for (const profile of [profiles[0], profiles[3]]) {
  for (const kind of ['goal', 'passkey'] as Kind[])
    for (const mode of ['pending', 'disabled'] as Mode[])
      cases.push({ profile, kind, mode, bottom: false });
  cases.push({ profile, kind: 'standalone', mode: 'normal', bottom: false });
}
cases.push({ profile: profiles[0], kind: 'goal', mode: 'normal', bottom: true });
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function measure(page: Page) {
  await settle(page);
  return page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-review-target] button');
    if (!button) throw new Error('Missing actual confirmation control');
    const rect = (element: Element) => {
      const r = element.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const box = rect(button),
      panel = document.querySelector<HTMLElement>('section[popover]');
    const visible = button.querySelector('[aria-live="polite"]');
    if (!visible) throw new Error('Missing live confirmation label');
    const textLines = (element: Element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const lines = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects())
          if (r.width > 0 && r.height > 0)
            lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }
      return lines;
    };
    const lines = textLines(visible);
    const reserves = [...button.querySelectorAll('span[aria-hidden="true"]')].map(textLines);
    const inside = (line: { left: number; right: number; top: number; bottom: number }) =>
      line.left >= box.left - 1 &&
      line.right <= box.right + 1 &&
      line.top >= box.top - 1 &&
      line.bottom <= box.bottom + 1;
    const icon = visible.querySelector('svg');
    return {
      button: box,
      panel: panel
        ? {
            ...rect(panel),
            clientWidth: panel.clientWidth,
            scrollWidth: panel.scrollWidth,
            scrollLeft: panel.scrollLeft,
          }
        : null,
      visibleText: visible.textContent,
      lines,
      reserves,
      visibleFits: lines.length > 0 && lines.every(inside),
      reservesFit:
        reserves.length === 3 && reserves.every((rows) => rows.length > 0 && rows.every(inside)),
      icon: icon ? rect(icon) : null,
      disabled: button.disabled,
      busy: button.getAttribute('aria-busy'),
      forbiddenActions: document.body.dataset.forbiddenActions,
      documentWidth: document.documentElement.scrollWidth,
      focusIsTarget: document.activeElement === button,
    };
  });
}
const results = [];
const errors: string[] = [];
try {
  for (const item of cases) {
    const { profile, kind, mode, bottom } = item;
    const page = await browser.newPage({
      viewport: { width: profile.width, height: 844 },
      colorScheme: profile.scheme,
      reducedMotion: 'reduce',
    });
    // tsx preserves nested helper names; Playwright serializes the callback alone.
    await page.addInitScript('globalThis.__name = (target) => target;');
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin && route.request().method() === 'GET')
        return route.continue();
      errors.push('Unexpected request');
      return route.abort();
    });
    await page.goto(`${origin}/?kind=${kind}&mode=${mode}${bottom ? '&bottom=1' : ''}`);
    await page.evaluate(({ fontSize, scheme }) => {
      document.documentElement.style.fontSize = `${fontSize}px`;
      document.documentElement.classList.toggle('dark', scheme === 'dark');
    }, profile);
    const target = page.locator('[data-review-target] button');
    const more = page.getByRole('button', { name: 'More', exact: true });
    if (kind !== 'standalone') await more.click();
    await target.scrollIntoViewIfNeeded();
    const resting = await measure(page);
    const prefix = `${kind}-${mode}-${profile.width}-${profile.fontSize}-${profile.scheme}${bottom ? '-bottom' : ''}`;
    await page.screenshot({
      path: path.join(output, `${prefix}-rest.png`),
      animations: 'disabled',
    });
    if (!before) {
      assert(
        resting.visibleFits && resting.reservesFit,
        `${prefix}: all reserved/visible text must fit`,
      );
      if (resting.panel) {
        assert(resting.panel.scrollWidth <= resting.panel.clientWidth + 1);
        assert(resting.panel.left >= 7 && resting.panel.right <= profile.width - 7);
        assert(resting.panel.top >= 7 && resting.panel.bottom <= 837);
      }
      assert.equal(resting.documentWidth, profile.width);
    }
    if (mode !== 'normal') {
      assert(resting.disabled);
      assert.equal(resting.busy, String(mode === 'pending'));
      await target.click({ force: true });
      assert.equal(await page.locator('body').getAttribute('data-forbidden-actions'), '0');
      results.push({ ...item, resting });
      await page.close();
      continue;
    }
    await target.click();
    const armed = await measure(page);
    assert.deepEqual(
      armed.button,
      resting.button,
      `${prefix}: first activation must not move or resize target`,
    );
    assert.equal(armed.forbiddenActions, '0');
    if (!before) {
      assert(armed.visibleFits && armed.reservesFit);
      if (armed.icon) assert(armed.icon.width >= 15);
    }
    if (before && kind === 'goal')
      assert.equal(
        armed.visibleFits,
        false,
        'Baseline goal confirmation should reproduce clipping',
      );
    await page.screenshot({
      path: path.join(output, `${prefix}-armed.png`),
      animations: 'disabled',
    });
    // Blur disarms; no second confirmation is ever activated.
    if (kind === 'goal') {
      await page.keyboard.press('Tab');
      await settle(page);
      const reset = await measure(page);
      assert.equal(reset.visibleText, resting.visibleText);
    }
    if (kind !== 'standalone') {
      await page.keyboard.press('Escape');
      await settle(page);
      assert.equal(
        await more.evaluate((button) => button === document.activeElement),
        true,
        'Native Escape restores invoker focus',
      );
      await page.keyboard.press('Enter');
      await settle(page);
      await page.keyboard.press('Tab');
      if (kind === 'goal') await page.keyboard.press('Tab');
      assert.equal(await target.evaluate((button) => button === document.activeElement), true);
      await page.keyboard.press('Enter');
      const keyboardArmed = await measure(page);
      assert.equal(keyboardArmed.visibleText, armed.visibleText);
      if (!before) assert(keyboardArmed.visibleFits);
      await page.keyboard.press('Escape');
      await settle(page);
      assert.equal(await more.evaluate((button) => button === document.activeElement), true);
      results.push({ ...item, resting, armed, keyboardArmed, nativeEscapeFocusRestored: true });
    } else {
      await page.keyboard.press('Escape');
      const reset = await measure(page);
      assert.equal(reset.visibleText, resting.visibleText);
      results.push({ ...item, resting, armed, escapeDisarms: true });
    }
    assert.equal(await page.locator('body').getAttribute('data-forbidden-actions'), '0');
    await page.close();
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
          'Actual shared controls/CSS with exact GoalCard and Security confirmation labels in representative menu wrappers. No complete authenticated route. Only first activation, blur/Escape; no second confirm or owner action. Pending/disabled props synthetic; standalone comparison uses unchanged regular variant. No external request.',
        errors,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ output, before, passed: results.length }));
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
