/** Actual card component with synthetic data on loopback; no product routes or providers. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const output = path.resolve('.workspace/playbook-review/web-card-compatibility');
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const runtimeRequire = createRequire(webRequire.resolve('tsx'));
const { build } = runtimeRequire('esbuild') as {
  build(options: Record<string, unknown>): Promise<void>;
};
type Builder = {
  onResolve(
    opts: { filter: RegExp },
    callback: (args: { path: string; kind: string; resolveDir: string }) => unknown,
  ): void;
  onLoad(opts: { filter: RegExp; namespace: string }, callback: () => unknown): void;
  resolve(name: string, opts: { kind: string; resolveDir: string }): Promise<unknown>;
};
await mkdir(output, { recursive: true });
await build({
  stdin: {
    loader: 'tsx',
    resolveDir: path.join(root, 'apps/web'),
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ResponseCards, rendersAllCards } from './app/chat/[id]/response-card';
const root = createRoot(document.getElementById('app'));
const facts = [
{id:'origin',label:'Origin',value:'Oakland'}, {id:'destination',label:'Destination',value:'Sacramento'},
{id:'completed',label:'Completed',value:'3'}, {id:'total',label:'Total',value:'5'},
{id:'departure',label:'Departure',value:new Date(Date.now()+20*60*1000).toISOString()},
{id:'secret',label:'Booking code',value:'72',sensitive:true},
{id:'negative',label:'Change',value:'-2'}, {id:'private_place',label:'Private place',value:'PRIVATE-PLACE-X9',sensitive:true}
];
const blocks = [
{type:'journey',mode:'train',fromFact:'origin',toFact:'destination',departFact:'departure'},
{type:'section',title:'Preparation',blocks:[{type:'progress',valueFact:'completed',totalFact:'total'}, {type:'checklist',factIds:['origin','destination']}]},
{type:'metrics',factIds:['completed','total']},
{type:'stages',factIds:['origin','destination'],currentFact:'origin'},
{type:'countdown',dateFact:'departure'},
{type:'table',columns:['From','To'],rows:[['origin','destination']]},
{type:'chart',kind:'bar',points:[{labelFact:'origin',valueFact:'completed'},{labelFact:'destination',valueFact:'negative'}]},
{type:'chart',kind:'line',points:[{labelFact:'origin',valueFact:'completed'},{labelFact:'destination',valueFact:'total'}]},
{type:'map',placeFactIds:['origin','private_place']},
{type:'section',title:'Private details',blocks:[{type:'chart',kind:'bar',points:[{labelFact:'secret',valueFact:'secret'},{labelFact:'destination',valueFact:'total'}]},{type:'progress',valueFact:'secret',totalFact:'total'}]}
];
window.__mount = (revision='one') => {
 const card = {kind:'generated-card',id:'travel',revisionId:revision,spec:{version:1,title:'Your train journey',sourceLabel:'Synthetic booking',accessibilityLabel:'Train journey',facts,blocks}};
 root.render(<><p id="prose">{!rendersAllCards([card]) ? 'The map and private details also have a text fallback.' : ''}</p><ResponseCards cards={[card]} timeZone="UTC"/></>);
};
`,
  },
  outfile: path.join(output, 'client.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'client-safe-boundaries',
      setup(builder: Builder) {
        builder.onResolve({ filter: /^next\/image$/ }, () => ({
          path: 'image',
          namespace: 'image',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'image' }, () => ({
          contents:
            "import React from 'react'; export default props => React.createElement('img', props);",
          loader: 'js',
          resolveDir: path.join(root, 'apps/web'),
        }));
        builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'link' }));
        builder.onLoad({ filter: /.*/, namespace: 'link' }, () => ({
          contents:
            "import React from 'react'; export default props => React.createElement('a', props);",
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
const postcssRequire = createRequire(webRequire.resolve('@tailwindcss/postcss'));
const postcss = postcssRequire('postcss');
const tailwind = webRequire('@tailwindcss/postcss');
const cssPath = path.join(root, 'apps/web/app/globals.css');
const styled = await postcss([tailwind()]).process(await readFile(cssPath, 'utf8'), {
  from: cssPath,
});
await writeFile(path.join(output, 'styles.css'), styled.css);
const server = createServer(async (request, response) => {
  if (request.url === '/client.js' || request.url === '/styles.css') {
    response.setHeader(
      'Content-Type',
      request.url.endsWith('.js') ? 'text/javascript' : 'text/css',
    );
    response.end(await readFile(path.join(output, request.url.slice(1))));
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(
    '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body class="bg-surface font-sans text-strong"><main id="app" style="max-width:720px;margin:24px auto;padding:16px"></main><script type="module" src="/client.js"></script></body></html>',
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing loopback address');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const passed: string[] = [];
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => typeof Reflect.get(window, '__mount') === 'function');
  await page.evaluate(() => Reflect.get(window, '__mount')());
  await page.getByText('Preparation', { exact: true }).waitFor();
  await page.getByText('More details', { exact: true }).click();
  await page.getByText('Private details', { exact: true }).waitFor();
  assert.match(await page.locator('#prose').innerText(), /text fallback/);
  assert.equal(await page.getByRole('table').count(), 1);
  assert.equal(await page.getByRole('checkbox').count(), 2);
  assert.equal(await page.getByRole('progressbar').count(), 1);
  assert.match(await page.locator('#app').innerText(), /In 20 minutes/);
  assert.doesNotMatch(await page.locator('#app').innerHTML(), /PRIVATE-PLACE-X9/);
  assert.doesNotMatch(
    await page.locator('section[aria-label="Private details"]').innerHTML(),
    />72</,
  );
  await page.getByRole('checkbox').first().check();
  assert.equal(await page.getByRole('checkbox').first().isChecked(), true);
  await page.keyboard.press('Tab');
  const keyboardFocus = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const style = getComputedStyle(active);
    return { outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle };
  });
  assert.deepEqual(keyboardFocus, { outlineWidth: '2px', outlineStyle: 'solid' });
  passed.push(
    'Actual mounted content: second-position section, expanded detail section, table, progress, both charts, countdown, map fallback, interactive checklist, and visible keyboard focus',
  );
  const privateSection = page.locator('section[aria-label="Private details"]');
  await privateSection
    .getByRole('button', { name: 'Show booking code', exact: true })
    .first()
    .click();
  assert.match(await privateSection.innerText(), /72/);
  assert.doesNotMatch(await privateSection.locator('svg').innerHTML(), /NaN|Infinity/);
  await page.evaluate(() => Reflect.get(window, '__mount')('two'));
  await privateSection
    .getByRole('button', { name: 'Show booking code', exact: true })
    .first()
    .waitFor();
  assert.doesNotMatch(await privateSection.innerHTML(), />72</);
  passed.push(
    'Sensitive numeric data withheld until an explicit reveal; new card revision remasks it; private map query never appears',
  );
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const dark of [false, true]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      // Wait for the existing chip color transition to settle before comparing themes.
      await page.waitForFunction(() => {
        const link = document.querySelector('a');
        const probe = document.createElement('span');
        probe.style.color = 'var(--accent)';
        document.body.append(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        return !!link && getComputedStyle(link).color === expected;
      });
      await page.screenshot({
        path: path.join(output, `${width}-${dark ? 'dark' : 'light'}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '200%';
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
  });
  passed.push(
    'Six current-source light/dark screenshots at 320/390/1280px; no overflow at 200% zoom',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        passed,
        limitations: [
          'Synthetic data, loopback browser and an image component stub; no product route activation, provider effects, native behavior or full application acceptance.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(passed.join('\n'));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
