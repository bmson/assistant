/** Package isolated UI screenshots into a browsable, before/after review. */
import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const source = path.resolve(process.argv[2] ?? '.workspace/ui-review-2026-10-03');
const destination = path.resolve(process.argv[3] ?? 'docs/audits/assets/ui-review-2026-10-03');
const htmlEscape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
type Capture = { group: string; name: string; before?: string; after?: string };
const captures = new Map<string, Capture>();
await mkdir(destination, { recursive: true });
for (const group of ['console', 'products', 'native']) {
  for (const phase of ['before', 'after'] as const) {
    const directory = path.join(source, `${phase}-${group}`);
    const files: string[] = await readdir(directory).catch(() => []);
    if (!files.length) continue;
    await mkdir(path.join(destination, `${phase}-${group}`), { recursive: true });
    const packaged = path.join(destination, `${phase}-${group}`);
    for (const file of await readdir(packaged)) {
      if (file.endsWith('.png') && !files.includes(file)) await unlink(path.join(packaged, file));
    }
    for (const file of files.filter((file) => file.endsWith('.png')).sort()) {
      const relative = `${phase}-${group}/${file}`;
      await copyFile(path.join(directory, file), path.join(destination, relative));
      const key = `${group}/${file}`;
      const capture = captures.get(key) ?? { group, name: file.replace(/\.png$/, '') };
      capture[phase] = relative;
      captures.set(key, capture);
    }
    // Keep measurements and inventories beside the exact captures they describe.
    for (const file of files.filter((file) =>
      /(?:manifest|measurements|inventory|security-receipts|test-summary)\.json$/.test(file),
    )) {
      await copyFile(path.join(directory, file), path.join(destination, `${phase}-${group}`, file));
    }
  }
}
// Settled chat layouts have their own evidence boundary: these use the actual
// hydrated ChatClient rather than the static page-component matrix.
for (const series of [
  { directory: 'hydrated-chat', suffix: 'hydrated' },
  { directory: 'hydrated-chat-states', suffix: 'hydrated-state' },
]) {
  const hydratedDirectory = path.join(source, series.directory);
  const hydratedFiles = await readdir(hydratedDirectory).catch(() => []);
  if (!hydratedFiles.length) continue;
  await mkdir(path.join(destination, series.directory), { recursive: true });
  for (const file of hydratedFiles.filter((file) => /\.(?:png|json)$/.test(file)).sort()) {
    await copyFile(
      path.join(hydratedDirectory, file),
      path.join(destination, series.directory, file),
    );
    if (file.endsWith('.png')) {
      const name = `${file.replace(/\.png$/, '')}-${series.suffix}`;
      captures.set(`products/${name}`, {
        group: 'products',
        name,
        after: `${series.directory}/${file}`,
      });
    }
  }
}
const items = [...captures.values()];
await writeFile(path.join(destination, 'captures.json'), `${JSON.stringify(items, null, 2)}\n`);
const picture = (capture: Capture, phase: 'before' | 'after') =>
  capture[phase]
    ? `<a href="${htmlEscape(capture[phase])}" target="_blank" rel="noopener"><img loading="lazy" src="${htmlEscape(capture[phase])}" alt="${htmlEscape(capture.name)} ${phase}"></a>`
    : '<p class="missing">No capture in this phase.</p>';
await writeFile(
  path.join(destination, 'index.html'),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Assistant UI review</title>
<style>
:root{color-scheme:light;--canvas:#eef5f0;--panel:#fff;--ink:#15201a;--muted:#5a6d62;--edge:#d3e1d7}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header,main{max-width:1400px;margin:auto;padding:24px}h1{font-size:32px;letter-spacing:-.025em;margin:0 0 12px}p{max-width:75ch;color:var(--muted)}.controls{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}label{display:grid;gap:4px;font-size:14px}input,select,button{font:inherit;min-height:44px;border:1px solid var(--edge);border-radius:8px;background:var(--panel);color:var(--ink);padding:8px 12px}input{width:min(100%,360px)}a:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #217a4b;outline-offset:3px}article{background:var(--panel);border:1px solid var(--edge);border-radius:16px;overflow:hidden;margin-bottom:28px}h2{font-size:18px;padding:16px 20px;margin:0;border-bottom:1px solid var(--edge)}.pair{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--edge)}figure{margin:0;min-width:0;background:var(--canvas)}figcaption{padding:12px 20px;font-weight:600}figure a{display:block;margin:0 12px 16px;overflow:auto;max-height:900px;border:1px solid var(--edge);border-radius:8px;background:var(--panel)}img{display:block;width:100%;height:auto}.missing{padding:20px}.single figure:first-child{display:none}.single .pair{grid-template-columns:1fr}[hidden]{display:none!important}@media(max-width:639px){header,main{padding:16px}.pair{grid-template-columns:1fr}h1{font-size:28px}}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--canvas:#121a15;--panel:#19241d;--ink:#eef5ef;--muted:#9cb0a2;--edge:#38473d}}
</style></head><body><header><h1>Assistant UI review</h1><p>Actual app components with synthetic data. Browser product pages are retained implementations currently redirected in the running console. Native images, when present, come from isolated simulator fixtures. Select a screenshot to inspect its full size.</p><div class="controls"><label>Find a page<input id="search" type="search" placeholder="Memory, goals, security…"></label><label>Surface<select id="group"><option value="">All surfaces</option><option value="console">Browser console</option><option value="products">Retained browser product pages</option><option value="native">iPhone</option></select></label><label>Appearance<select id="theme"><option value="">Both appearances</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Layout<select id="layout"><option value="">All layouts</option><option value="phone">Phone</option><option value="1280">Desktop</option><option value="320">Narrow phone</option></select></label><label>View<select id="phase"><option value="compare">Before and after</option><option value="after">After</option></select></label></div><p id="count" role="status"></p></header><main>${items.map((capture) => `<article data-group="${capture.group}" data-name="${htmlEscape(capture.name)}"><h2>${htmlEscape(capture.name.replaceAll('-', ' '))} <span style="font-weight:400;color:var(--muted)">(${capture.group})</span></h2><div class="pair"><figure><figcaption>Before</figcaption>${picture(capture, 'before')}</figure><figure><figcaption>After</figcaption>${picture(capture, 'after')}</figure></div></article>`).join('')}</main><script>
const controls=['search','group','theme','layout','phase'].map(id=>document.getElementById(id));function filter(){const [search,group,theme,layout,phase]=controls.map(control=>control.value.toLowerCase());let count=0;for(const article of document.querySelectorAll('article')){article.hidden=Boolean(search&&!article.dataset.name.toLowerCase().includes(search)||group&&article.dataset.group!==group||theme&&!article.dataset.name.includes(theme)||layout&&!(layout==='phone'?/390|phone/.test(article.dataset.name):article.dataset.name.includes(layout))||phase==='after'&&article.querySelector('figure:last-child .missing'));if(!article.hidden)count++;article.classList.toggle('single',phase==='after')}document.getElementById('count').textContent=count+' screenshot entries';}controls.forEach(control=>{control.addEventListener('input',filter)});filter();
</script></body></html>`,
);

// Contact sheets show the first phone viewport. Full-page originals remain in
// the gallery; a contact sheet cannot establish below-the-fold correctness.
for (const group of ['console', 'products', 'native']) {
  for (const phase of ['before', 'after'] as const) {
    const selected = items.filter(
      (item) =>
        item.group === group &&
        item[phase] &&
        /(?:390|phone).*light/.test(item.name) &&
        (group !== 'native' || (item.name.endsWith('-top') && !item.name.includes('-accessible-'))),
    );
    for (let start = 0; start < selected.length; start += 12) {
      const batch = selected.slice(start, start + 12);
      const tiles: Array<{ input: Buffer; left: number; top: number }> = [];
      for (let index = 0; index < batch.length; index++) {
        const item = batch[index];
        if (!item) continue;
        const file = item[phase];
        if (!file) continue;
        const original = await readFile(path.join(destination, file));
        const dimensions = await sharp(original).metadata();
        const preview = await sharp(original)
          .extract({
            left: 0,
            top: 0,
            width: dimensions.width ?? 390,
            height: Math.min(
              dimensions.height ?? 844,
              group === 'native' ? Math.round(((dimensions.width ?? 1206) * 900) / 390) : 900,
            ),
          })
          .resize({
            width: 225,
            height: 520,
            fit: 'contain',
            position: 'top',
            background: '#eef5f0',
          })
          .png()
          .toBuffer();
        const left = (index % 4) * 245 + 10;
        const top = Math.floor(index / 4) * 550;
        tiles.push({
          input: Buffer.from(
            `<svg width="225" height="30"><text x="4" y="20" font-size="12" font-family="Arial" fill="#15201a">${htmlEscape(item.name.replace('-390-light', '').replace(/-phone-light-\d+-top$/, ''))}</text></svg>`,
          ),
          left,
          top,
        });
        tiles.push({ input: preview, left, top: top + 30 });
      }
      const filename = `${phase}-${group}-contact-${Math.floor(start / 12) + 1}.png`;
      await sharp({
        create: {
          width: 980,
          height: Math.ceil(batch.length / 4) * 550,
          channels: 3,
          background: '#eef5f0',
        },
      })
        .composite(tiles)
        .png()
        .toFile(path.join(destination, filename));
    }
  }
}
const goalsBefore = path.join(destination, 'before-native/goals-phone-light-402-top.png');
const goalsAfter = path.join(destination, 'after-native/goals-phone-light-402-top.png');
const goalsImages = await Promise.allSettled([
  sharp(goalsBefore).resize({ width: 390 }).png().toBuffer(),
  sharp(goalsAfter).resize({ width: 390 }).png().toBuffer(),
]);
if (goalsImages[0].status === 'fulfilled' && goalsImages[1].status === 'fulfilled') {
  const beforeImage = goalsImages[0].value;
  const afterImage = goalsImages[1].value;
  const beforeSize = await sharp(beforeImage).metadata();
  const afterSize = await sharp(afterImage).metadata();
  await sharp({
    create: {
      width: 816,
      height: Math.max(beforeSize.height ?? 874, afterSize.height ?? 874) + 48,
      channels: 3,
      background: '#eef5f0',
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="816" height="40"><text x="12" y="28" font-size="20" font-family="Arial" fill="#15201a">Before</text><text x="414" y="28" font-size="20" font-family="Arial" fill="#15201a">After</text></svg>',
        ),
        left: 0,
        top: 0,
      },
      { input: beforeImage, left: 12, top: 44 },
      { input: afterImage, left: 414, top: 44 },
    ])
    .png()
    .toFile(path.join(destination, 'native-goals-comparison.png'));
}
console.log(`Packaged ${items.length} before/after comparisons at ${destination}/index.html`);
