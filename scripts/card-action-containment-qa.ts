/** Actual card consumers, synthetic props and forbidden server actions. First arm/cancel only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? '.workspace/card-containment');
const before = process.argv.includes('--before');
await mkdir(output, { recursive: true });
const req = createRequire(path.join(root, 'package.json'));
const web = createRequire(path.join(root, 'apps/web/package.json'));
const { build } = createRequire(req.resolve('tsx'))('esbuild');
const postcss = createRequire(web.resolve('@tailwindcss/postcss'))('postcss');
const tailwind = web('@tailwindcss/postcss');
const sourceFiles = [
  'apps/web/app/settings/mobile-token.tsx',
  'apps/web/app/profile/privacy-controls.tsx',
  'apps/web/app/settings/page.tsx',
  'apps/web/app/profile/data/page.tsx',
  'apps/web/lib/ui.tsx',
  'apps/web/lib/ui-client.tsx',
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
const entry = `import React from ${JSON.stringify(web.resolve('react'))};import{createRoot}from${JSON.stringify(web.resolve('react-dom/client'))};
import{ConfirmButton}from${JSON.stringify(path.join(root, 'apps/web/lib/ui-client.tsx'))};
import{Card,PageShell,PageHeader,SectionHeading}from${JSON.stringify(path.join(root, 'apps/web/lib/ui.tsx'))};
import{MobileTokenPanel}from${JSON.stringify(path.join(root, 'apps/web/app/settings/mobile-token.tsx'))};
import{PrivacyControls}from${JSON.stringify(path.join(root, 'apps/web/app/profile/privacy-controls.tsx'))};
const h=React.createElement,kind=new URLSearchParams(location.search).get('kind');const forbid=()=>{document.body.dataset.forbiddenActions=String(Number(document.body.dataset.forbiddenActions)+1);throw Error('Forbidden synthetic action')};
const mobile=h(Card,{className:'mt-4'},h(MobileTokenPanel,{maskedToken:kind==='mobile-create'?null:'demo…only',serverUrl:'https://example.invalid',canRotate:true}));
const body=kind.startsWith('mobile')?h(PageShell,{size:'reading',className:'grid gap-8'},h(PageHeader,{title:'Settings',intro:'Connect your iPhone and manage your assistant account.'}),h('section',null,h(SectionHeading,{title:'Mobile app connection'}),mobile)):kind==='privacy'?h(PageShell,{size:'reading'},h(PageHeader,{back:{href:'/profile',label:'Memory'},title:'Your data',intro:'Export everything the assistant remembers, or forget it permanently.'}),h(PrivacyControls)):h(PageShell,{size:'reading'},h('div',null,h(ConfirmButton,{variant:'outline',confirmLabel:'Replace recovery code?',onConfirm:forbid},'Replace recovery code')));
createRoot(document.getElementById('fixture')).render(body)`;
type Builder = {
  onResolve(
    options: { filter: RegExp },
    callback: (args: { path: string }) => { path: string; namespace: string },
  ): void;
  onLoad(
    options: { filter: RegExp; namespace: string },
    callback: () => { contents: string; loader: string },
  ): void;
};
const js = (
  await build({
    stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    tsconfig: path.join(root, 'apps/web/tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [
      {
        name: 'forbid-server-actions',
        setup(builder: Builder) {
          builder.onResolve({ filter: /^@\/app\/(settings|profile)\/actions$/ }, (args) => ({
            path: args.path,
            namespace: 'forbidden-actions',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'forbidden-actions' }, () => ({
            contents: `const forbid=()=>{document.body.dataset.forbiddenActions=String(Number(document.body.dataset.forbiddenActions)+1);throw Error('Forbidden synthetic action')};export const rotateMobileToken=forbid;export const forgetLongTermMemoryAction=forbid;`,
            loader: 'js',
          }));
        },
      },
    ],
  })
).outputFiles[0].text;
const cssFile = path.join(root, 'apps/web/app/globals.css');
const css = (
  await postcss([tailwind({ base: path.join(root, 'apps/web') })]).process(
    await readFile(cssFile, 'utf8'),
    { from: cssFile },
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
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="min-h-dvh bg-surface font-sans text-strong antialiased" data-forbidden-actions="0"><main class="page-gutter mx-auto min-w-0 max-w-4xl py-7 sm:py-10"><button id="keyboard-start" type="button" class="sr-only">Start keyboard check</button><div id="fixture"></div></main><script src="/client.js"></script></body></html>',
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const profiles = [
  { width: 390, fontSize: 16, scheme: 'light' },
  { width: 320, fontSize: 32, scheme: 'dark' },
  { width: 1280, fontSize: 16, scheme: 'light' },
  { width: 1280, fontSize: 32, scheme: 'dark' },
] as const;
type Kind = 'mobile-rotate' | 'mobile-create' | 'privacy' | 'recovery';
const cases = profiles.flatMap((profile) =>
  (['mobile-rotate', 'mobile-create', 'privacy'] as Kind[]).map((kind) => ({ profile, kind })),
);
for (const profile of [profiles[0], profiles[1]]) cases.push({ profile, kind: 'recovery' });
const copy = {
  'mobile-rotate': ['Create a replacement key', 'Confirm rotate'],
  'mobile-create': ['Create access key', 'Confirm generate'],
  privacy: ['Forget long-term memory', 'Erase memory & voice'],
  recovery: ['Replace recovery code', 'Replace recovery code?'],
} as const;
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function measure(page: Page, kind: Kind) {
  await settle(page);
  return page.evaluate((kind) => {
    const button = document.querySelector<HTMLButtonElement>(
      'button:has(span[aria-live="polite"])',
    );
    if (!button) throw new Error('Missing stable confirmation target');
    const rect = (element: Element) => {
      const b = element.getBoundingClientRect();
      return {
        left: b.left,
        right: b.right,
        top: b.top,
        bottom: b.bottom,
        width: b.width,
        height: b.height,
      };
    };
    const content = (element: Element) => {
      const b = rect(element),
        s = getComputedStyle(element);
      return {
        ...b,
        contentLeft: b.left + parseFloat(s.paddingLeft),
        contentRight: b.right - parseFloat(s.paddingRight),
      };
    };
    const lines = (element: Element) => {
      const result = [],
        walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const b of range.getClientRects())
          if (b.width && b.height)
            result.push({ left: b.left, right: b.right, top: b.top, bottom: b.bottom });
      }
      return result;
    };
    const card = button.closest('.overflow-hidden');
    const frame = kind === 'privacy' ? button.closest('footer') : card;
    const main = document.querySelector('main');
    if (!main) throw new Error('Missing root main');
    const mainBox = content(main);
    const box = rect(button),
      cardBox = card ? content(card) : null,
      frameBox = frame ? content(frame) : null;
    const live = button.querySelector('[aria-live="polite"]');
    if (!live) throw new Error('Missing confirmation copy');
    const visible = lines(live),
      reserves = [...button.querySelectorAll('span[aria-hidden="true"]')].map(lines);
    const fitsButton = (b: { left: number; right: number; top: number; bottom: number }) =>
      b.left >= box.left - 1 &&
      b.right <= box.right + 1 &&
      b.top >= box.top - 1 &&
      b.bottom <= box.bottom + 1;
    const paragraphs = card
      ? [...card.querySelectorAll('p')]
          .filter((p) => p.textContent?.trim())
          .map((p) => {
            const b = content(p),
              text = p.textContent ?? '',
              textLines = lines(p);
            return {
              text,
              fontSize: getComputedStyle(p).fontSize,
              lineHeight: getComputedStyle(p).lineHeight,
              box: b,
              lines: textLines,
              fitsOwnContent: textLines.every(
                (line) => line.left >= b.contentLeft - 1 && line.right <= b.contentRight + 1,
              ),
              fitsCard: textLines.every(
                (line) =>
                  !cardBox || (line.left >= cardBox.left - 1 && line.right <= cardBox.right + 1),
              ),
            };
          })
      : [];
    const warning = paragraphs.find((p) => p.text.includes('disconnects devices using')) ?? null;
    const ancestors = [];
    for (let p = button.parentElement; p; p = p.parentElement)
      ancestors.push({
        tag: p.tagName,
        className: p.className,
        scrollLeft: p.scrollLeft,
        width: p.getBoundingClientRect().width,
        gridColumns: getComputedStyle(p).gridTemplateColumns,
        spacing: getComputedStyle(p).getPropertyValue('--spacing').trim(),
      });
    const style = getComputedStyle(button),
      icon = live.querySelector('svg'),
      form = button.closest('form');
    return {
      button: box,
      main: mainBox,
      cardFitsMain:
        !cardBox ||
        (cardBox.left >= mainBox.contentLeft - 1 && cardBox.right <= mainBox.contentRight + 1),
      card: cardBox,
      frame: frameBox,
      text: live.textContent,
      visible,
      reserves,
      labelFitsButton: visible.length > 0 && visible.every(fitsButton),
      reservedLabelsFit:
        reserves.length === 3 &&
        reserves.every((rows) => rows.length > 0 && rows.every(fitsButton)),
      buttonFitsGutter:
        !frameBox ||
        (box.left >= frameBox.contentLeft - 1 && box.right <= frameBox.contentRight + 1),
      paragraphs,
      warning,
      ancestors,
      focusIsTarget: document.activeElement === button,
      forbiddenActions: document.body.dataset.forbiddenActions,
      style: {
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        minHeight: style.minHeight,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        icon: icon ? rect(icon) : null,
        formSpacing: form ? getComputedStyle(form).getPropertyValue('--spacing').trim() : null,
        hyphens: style.hyphens,
        disabled: button.disabled,
        busy: button.getAttribute('aria-busy'),
      },
    };
  }, kind);
}
async function verticalView(page: Page, y: number) {
  await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - window.innerHeight / 2)), y);
}
const results = [];
const errors: string[] = [];
try {
  for (const { kind, profile } of cases) {
    const page = await browser.newPage({
      viewport: { width: profile.width, height: 844 },
      colorScheme: profile.scheme,
      reducedMotion: 'reduce',
    });
    await page.addInitScript('globalThis.__name = (target) => target;');
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin && route.request().method() === 'GET')
        return route.continue();
      errors.push('Unexpected request');
      return route.abort();
    });
    await page.goto(`${origin}/?kind=${kind}`);
    await page.evaluate(({ fontSize, scheme }) => {
      document.documentElement.style.fontSize = `${fontSize}px`;
      document.documentElement.classList.toggle('dark', scheme === 'dark');
    }, profile);
    await page.getByRole('button', { name: copy[kind][0], exact: true }).waitFor();
    const target = page.locator('button:has(span[aria-live="polite"])');
    assert.equal(await target.count(), 1);
    const initial = await measure(page, kind);
    assert(initial.ancestors.every((row) => row.scrollLeft === 0));
    const prefix = `${kind}-${profile.width}-${profile.fontSize}-${profile.scheme}`;
    let warningScreenshot: string | null = null;
    if (kind === 'mobile-rotate') {
      assert(initial.warning, 'Existing-key warning must be present');
      assert.equal(parseFloat(initial.warning.fontSize), profile.fontSize * 0.875);
    }
    if (initial.warning) {
      assert(initial.warning.text.includes('within 30 seconds.'));
      await verticalView(page, (initial.warning.box.top + initial.warning.box.bottom) / 2);
      const view = await measure(page, kind);
      assert(view.warning);
      const allVertical = view.warning.lines.every((line) => line.top >= -1 && line.bottom <= 845);
      assert(allVertical, 'Entire warning must be reachable in a vertical-only reading view');
      warningScreenshot = `${prefix}-warning.png`;
      await page.screenshot({ path: path.join(output, warningScreenshot), animations: 'disabled' });
    }
    const targetCenter = await target.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return box.top + window.scrollY + box.height / 2;
    });
    await verticalView(page, targetCenter);
    const resting = await measure(page, kind);
    await page.screenshot({
      path: path.join(output, `${prefix}-rest.png`),
      animations: 'disabled',
    });
    if (!before) {
      assert(
        resting.cardFitsMain &&
          resting.buttonFitsGutter &&
          resting.labelFitsButton &&
          resting.reservedLabelsFit,
        `${prefix}: control and full copy must fit card content`,
      );
      assert(
        resting.paragraphs.every((p) => p.fitsOwnContent && p.fitsCard),
        `${prefix}: paragraph clipping`,
      );
      assert.equal(parseFloat(resting.style.fontSize), profile.fontSize * 0.875);
      assert(resting.button.width >= 44 && resting.button.height >= 44);
      if (profile.width >= 768)
        assert.equal(parseFloat(resting.style.paddingLeft), profile.fontSize * 1.25);
    } else if (profile.width === 320 && kind !== 'recovery') {
      assert.equal(
        resting.buttonFitsGutter && resting.cardFitsMain,
        false,
        'Historical narrow control must reproduce containment failure',
      );
      if (kind === 'mobile-rotate')
        assert(resting.warning && (!resting.warning.fitsCard || !resting.cardFitsMain));
    }
    const box = resting.button;
    await page.mouse.click(
      Math.min((box.left + box.right) / 2, profile.width - 16),
      (box.top + box.bottom) / 2,
    );
    await page.getByRole('button', { name: copy[kind][1], exact: true }).waitFor();
    const armed = await measure(page, kind);
    assert.equal(armed.text, copy[kind][1]);
    assert.deepEqual(armed.button, resting.button, 'First arm must preserve target bounds');
    assert.equal(armed.forbiddenActions, '0');
    await page.screenshot({
      path: path.join(output, `${prefix}-armed.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: copy[kind][0], exact: true }).waitFor();
    await page.locator('#keyboard-start').focus();
    let reached = false;
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press('Tab');
      if (await target.evaluate((button) => document.activeElement === button)) {
        reached = true;
        break;
      }
    }
    assert(reached, 'Native Tab must reach the real confirmation');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: copy[kind][1], exact: true }).waitFor();
    const keyboardArmed = await measure(page, kind);
    assert.equal(keyboardArmed.text, armed.text);
    assert(keyboardArmed.focusIsTarget);
    if (!before)
      for (const state of [initial, resting, armed, keyboardArmed]) {
        assert(
          state.cardFitsMain &&
            state.buttonFitsGutter &&
            state.labelFitsButton &&
            state.reservedLabelsFit,
        );
        assert(state.ancestors.every((row) => row.scrollLeft === 0));
      }
    let keyboardScreenshot: string | null = null;
    if (profile.width < 640) {
      keyboardScreenshot = `${prefix}-keyboard.png`;
      await page.screenshot({
        path: path.join(output, keyboardScreenshot),
        animations: 'disabled',
      });
    }
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: copy[kind][0], exact: true }).waitFor();
    assert.equal(await page.locator('body').getAttribute('data-forbidden-actions'), '0');
    results.push({
      kind,
      profile,
      initial,
      resting,
      armed,
      keyboardArmed,
      warningScreenshot,
      keyboardScreenshot,
      restScreenshot: `${prefix}-rest.png`,
      armedScreenshot: `${prefix}-armed.png`,
    });
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
          'Actual MobileTokenPanel/Card and PrivacyControls in source-faithful Settings/Data PageShell, header and section composition; synthetic props, forbidden action modules. Recovery reference is an exact representative control. No auth/API/second confirmation/provider write. Only vertical diagnostic window scrolling; native Tab/Enter first-arm and Escape, no ancestor horizontal correction. Normal/enlarged narrow and desktop fixtures, not full routes or physical zoom.',
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
