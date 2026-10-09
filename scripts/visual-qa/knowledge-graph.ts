/** Isolated fixtures and browser interaction regression checks. Start local web on 3107 first.
 * Addressed as localhost, not 127.0.0.1: the dev server's client bundle does not
 * boot on the loopback IP (the RSC payload never runs, so nothing hydrates) and
 * every interaction below would fail for a reason that has nothing to do with
 * the map. launch.json opens localhost for the same reason.
 * DATABASE_URL=<allocated URL> ASSISTANT_TEST_TARGET_TOKEN=<token> pnpm tsx scripts/visual-qa/knowledge-graph.ts
 * Cleanup: pnpm visual-qa:cleanup <printed-run-id> with the same allocated target.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { getAgent } from '@assistant/core/chat';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import {
  createDb,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
} from '@assistant/db';
import { chromium } from 'playwright';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from '../test-target.js';
import { markVisualQaRun, newVisualQaRunId, writeVisualQaManifest } from './fixture-runs.js';

const target = assertAllocatedTestTargetMarker({
  databaseUrl: process.env.DATABASE_URL,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
});
const db = createDb(target.databaseUrl);
await assertAllocatedTestDatabaseOwnership(db, target);
const agent = await getAgent(db);
const runId = newVisualQaRunId();
const marker = `visual-qa:${runId}:knowledge-graph`;
const fixture = [
  ['Alex Rivera', 'person'],
  ['Robin Rivera', 'person'],
  ['Northstar Robotics', 'organization'],
  ['San Francisco', 'place'],
  ['School fundraiser', 'project'],
  ['Maya Chen', 'person'],
];
const facts: Array<[number, string, number, string, 'confirmed' | 'unreviewed']> = [
  [0, 'parent_of', 1, 'Alex Rivera is the parent of Robin Rivera.', 'confirmed'],
  [0, 'parent_of', 1, 'Family notes: Alex Rivera is the parent of Robin Rivera.', 'unreviewed'],
  [0, 'works_at', 2, 'Alex Rivera works at Northstar Robotics.', 'confirmed'],
  [0, 'lives_in', 3, 'Alex Rivera lives in San Francisco.', 'confirmed'],
  [0, 'organizes', 4, 'Alex Rivera organizes the School fundraiser.', 'unreviewed'],
  [5, 'works_at', 2, 'Maya Chen works at Northstar Robotics.', 'unreviewed'],
  [5, 'organizes', 4, 'Maya Chen organizes the School fundraiser.', 'confirmed'],
];
const entityIds = fixture.map(() => randomUUID());
const entityCanonicalKeys = fixture.map(([label, kind]) => `${kind}:graph-qa-${runId}-${label}`);
const memoryIds = facts.map(() => randomUUID());
const memoryContentHashes = facts.map((_, index) => `${marker}:memory:${index}`);
const relationIds = facts.map(() => randomUUID());
const relationFingerprints = facts.map((_, index) => `${marker}:relation:${index}`);
const manifest = await writeVisualQaManifest({
  fixtureKind: 'knowledge-graph',
  runId,
  targetDatabaseName: target.databaseName,
  targetToken: target.token,
  agentId: agent.id,
  ids: {
    entityIds,
    memoryIds,
    memoryContentHashes,
    relationIds,
  },
  provenance: {
    marker,
    entityCanonicalKeys,
    relationFingerprintPrefix: `${marker}:relation:`,
  },
});
const nodes = fixture.map(([label, kind], index) => ({
  id: entityIds[index],
  agentId: agent.id,
  label: label as string,
  kind: kind as string,
  canonicalKey: entityCanonicalKeys[index] as string,
}));
const alex = nodes[0];
const robin = nodes[1];
if (!alex || !robin) throw new Error('Missing fixture');
await db.transaction(async (tx) => {
  await tx.insert(knowledgeGraphEntities).values(nodes);
  for (const [index, [from, predicate, to, content, reviewStatus]] of facts.entries()) {
    const subject = nodes[from];
    const object = nodes[to];
    const memoryId = memoryIds[index];
    const contentHash = memoryContentHashes[index];
    const relationId = relationIds[index];
    const fingerprint = relationFingerprints[index];
    if (!subject || !object || !memoryId || !contentHash || !relationId || !fingerprint)
      throw new Error('Incomplete knowledge graph fixture manifest');
    await tx.insert(memories).values({
      id: memoryId,
      agentId: agent.id,
      category: 'knowledge',
      kind: 'fact',
      content,
      contentHash,
      originTrust: 'assistant',
      quarantined: true,
      embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
    });
    await tx.insert(knowledgeGraphSources).values({
      memoryId,
      contentHash,
      status: 'ready',
      extractionVersion: GRAPH_EXTRACTION_VERSION,
    });
    await tx.insert(knowledgeGraphRelations).values({
      id: relationId,
      agentId: agent.id,
      subjectEntityId: subject.id,
      objectEntityId: object.id,
      predicate,
      sourceMemoryId: memoryId,
      evidenceQuote: content,
      sourceFingerprint: fingerprint,
      ordinal: 0,
      confidence: '0.9',
      reviewStatus,
    });
  }
});
await markVisualQaRun(manifest, 'seeded');

mkdirSync('/tmp/assistant-graph-qa', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const url = `http://localhost:3107/profile/knowledge?view=map&entity=${alex.id}`;
try {
  // The map with no item named opens on starting points, not on a drawing of
  // everything: that is the change this section exists to hold in place.
  await page.goto('http://localhost:3107/profile/knowledge?view=map');
  const start = page.getByRole('region', { name: 'Choose where to start' });
  await start.getByRole('heading', { name: 'Open an item to see what it connects to' }).waitFor();
  assert.equal(
    await page.getByRole('application', { name: /Whole knowledge map/ }).count(),
    0,
    'The overview is asked for, not arrived at',
  );
  // `.first()` because a re-run against the same database leaves an earlier
  // marker's fixture in place; everything after this addresses this run's
  // entities by id so it cannot be reading someone else's Alex.
  await start
    .getByRole('button', { name: /^Alex Rivera/ })
    .first()
    .click();
  await page.getByRole('img', { name: /Alex Rivera and \d+ of its \d+ connected items/ }).waitFor();

  await page.goto(url);
  const inspector = page.getByRole('complementary', { name: 'Selected knowledge item' });
  await inspector.getByRole('heading', { name: 'Alex Rivera', exact: true }).waitFor();
  const ring = page.getByRole('img', { name: /Alex Rivera and \d+ of its \d+ connected items/ });
  await ring.waitFor();
  // Every spoke is named and carries the phrase it records — the reason the
  // focused view is a drawing of its own rather than the overview zoomed in.
  // textContent, not innerText: the ring is an <svg>, which has no innerText.
  const ringText = (await ring.textContent()) ?? '';
  for (const name of ['Robin Rivera', 'Northstar Robotics', 'San Francisco']) {
    assert.ok(ringText.includes(name), `Ring is missing ${name}: ${ringText}`);
  }
  assert.ok(
    /Parent|Works at|Lives in/.test(ringText),
    `Ring has no relationship phrase: ${ringText}`,
  );
  await page.getByRole('heading', { name: 'How your knowledge connects' }).scrollIntoViewIfNeeded();
  await inspector.getByText('Supporting evidence (2)', { exact: true }).click();
  await page.screenshot({ path: '/tmp/assistant-graph-qa/web-desktop.png' });
  await inspector.getByRole('button', { name: 'Explore Robin Rivera', exact: true }).click();
  await inspector.getByRole('heading', { name: 'Robin Rivera', exact: true }).waitFor();
  assert.match(await inspector.innerText(), /Alex Rivera is Robin Rivera.s parent/);
  assert.equal(
    await inspector.getByRole('link', { name: 'Review or edit Robin Rivera' }).getAttribute('href'),
    `/profile/knowledge?view=map&entity=${robin.id}#knowledge-item`,
  );

  // The whole-graph drawing: still reachable, still pannable, and now naming
  // what it has room for rather than everything at once.
  await page.getByRole('button', { name: 'Whole map', exact: true }).click();
  const svg = page.getByRole('application', { name: /Whole knowledge map/ });
  await svg.waitFor();
  const box = await svg.boundingBox();
  if (!box) throw new Error('No map bounds');
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 60, { steps: 5 });
  await page.mouse.up();
  const transform = await svg.locator('svg > g').first().getAttribute('transform');
  const shift = Number(transform?.match(/translate\(([^ ]+)/)?.[1]);
  assert.ok(Math.abs(shift - (80 * 1000) / box.width) < 2, `Incorrect pan: ${transform}`);
  await page.getByRole('button', { name: /Focus on Robin/ }).click();
  await inspector.getByRole('heading', { name: 'Robin Rivera', exact: true }).waitFor();
  await inspector.getByRole('link', { name: 'Review or edit Robin Rivera' }).click();
  await page.waitForURL(`**entity=${robin.id}#knowledge-item`);
  await page.getByRole('heading', { name: 'Connections around Robin Rivera' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await inspector.getByRole('heading', { name: 'Alex Rivera', exact: true }).waitFor();
  // A 356px canvas cannot hold readable names, so the phone gets the same
  // spokes as a list. Asserting the canvas is hidden is what keeps a future
  // change from quietly shipping five-pixel labels to a phone.
  assert.equal(
    await page.getByRole('img', { name: /Alex Rivera and \d+ of its/ }).isVisible(),
    false,
    'The focus ring must not render at phone width',
  );
  assert.ok(
    (await page.getByRole('button', { name: /^Open Robin Rivera/ }).count()) > 0 ||
      (await page.getByText('Robin Rivera').count()) > 0,
    'The phone still lists the spokes',
  );
  await inspector.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/assistant-graph-qa/web-phone.png' });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Horizontal overflow',
  );
  await inspector.getByRole('button', { name: 'Explore Robin Rivera', exact: true }).click();
  await inspector.getByRole('heading', { name: 'Robin Rivera', exact: true }).waitFor();
  await inspector.getByText('Supporting evidence (2)', { exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await inspector.getByRole('heading', { name: 'Alex Rivera', exact: true }).waitFor();
  await inspector.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/assistant-graph-qa/web-phone-dark.png' });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      runId,
      alexId: alex.id,
      robinId: robin.id,
      screenshots: '/tmp/assistant-graph-qa',
    }),
  );
} finally {
  await browser.close();
  await db.$client.end({ timeout: 5 });
}
await markVisualQaRun(manifest, 'complete');
