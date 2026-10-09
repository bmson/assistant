import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { readPrivateJson } from './chat-readability-safety.js';

// Re-render the saved model outputs, without generating new replies or changing
// conversations. Top and bottom screenshots preserve the actual scrolling UI.
const root = path.resolve(import.meta.dirname, '../..');
const artifacts = path.join(root, '.artifacts/chat-readability');
const output = path.join(artifacts, 'semantic-ui');
const metrics: unknown[] = [];
const selectedCases = new Set(process.argv.slice(2).map(Number));
if ([...selectedCases].some((value) => !Number.isInteger(value) || value < 1 || value > 30)) {
  throw new Error('Optional case numbers must be integers from 1 to 30');
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const run of ['baseline', 'reframed']) {
    const pointer = await readPrivateJson<{ runId: string; manifestFile: string }>(
      path.join(artifacts, `${run}-current.json`),
    );
    const manifest = await readPrivateJson<{
      run: string;
      runId: string;
      status: string;
      conversationId: string | null;
    }>(path.join(artifacts, path.basename(pointer.manifestFile)));
    if (
      manifest.run !== run ||
      manifest.runId !== pointer.runId ||
      manifest.status !== 'complete' ||
      !manifest.conversationId
    ) {
      throw new Error(`${run}: current readability run is missing or incomplete`);
    }
    const { conversationId } = manifest;
    for (const width of [1280, 390]) {
      const directory = path.join(output, `${run}-${width}`);
      await mkdir(directory, { recursive: true });
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        reducedMotion: 'reduce',
      });
      await page.goto(`http://localhost:3000/chat/${conversationId}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.locator('.bubble-assistant').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      // Hydration measures the composer and restores the bottom. Wait for that
      // initial layout before deliberately scrolling to a historical answer.
      await page.waitForTimeout(2500);
      const cards = page.locator('[data-message-block][data-role="assistant"]');
      if ((await cards.count()) !== 30)
        throw new Error(`${run}: expected 30 messages, got ${await cards.count()}`);
      for (let index = 0; index < 30; index++) {
        if (selectedCases.size > 0 && !selectedCases.has(index + 1)) continue;
        const card = cards.nth(index);
        for (const position of ['start', 'end'] as const) {
          await card.evaluate((element, block) => {
            const scroller = element.closest('[role="log"]');
            if (!scroller) throw new Error('Missing transcript scroll container');
            const bounds = element.getBoundingClientRect();
            const frame = scroller.getBoundingClientRect();
            // Normal scroll positions, with the ending above composer/jump
            // controls. This does not hide controls or mutate the layout.
            scroller.scrollTop +=
              block === 'start' ? bounds.top - frame.top - 16 : bounds.bottom - frame.bottom + 160;
          }, position);
          await page.waitForTimeout(250);
          const targetVisible = await card.evaluate((element) => {
            const frame = element.closest('[role="log"]')?.getBoundingClientRect();
            const bounds = element.getBoundingClientRect();
            return frame && bounds.bottom > frame.top && bounds.top < frame.bottom;
          });
          if (!targetVisible)
            throw new Error(`Scroll restoration displaced ${run} case ${index + 1}`);
          await page.screenshot({
            path: path.join(directory, `${String(index + 1).padStart(2, '0')}-${position}.png`),
          });
        }
        metrics.push(
          await card.evaluate(
            (element, info) => {
              const context = element.querySelector('.answer-context');
              return {
                ...info,
                viewport: document.documentElement.clientWidth,
                pageWidth: document.documentElement.scrollWidth,
                code: [...element.querySelectorAll('pre')].map((code) => ({
                  width: code.clientWidth,
                  scrollWidth: code.scrollWidth,
                })),
                contextPosition: context ? getComputedStyle(context).position : null,
              };
            },
            { run, width, index: index + 1 },
          ),
        );
      }
      await page.close();
      console.log(
        `Captured ${run} at ${width}px: ${selectedCases.size || 30} answers, top + bottom`,
      );
    }
  }
  const metricsName =
    selectedCases.size > 0 ? `metrics-${[...selectedCases].join('-')}.json` : 'metrics.json';
  await writeFile(path.join(output, metricsName), JSON.stringify(metrics, null, 2));
} finally {
  await browser.close();
}
