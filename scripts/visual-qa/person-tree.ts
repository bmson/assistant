/** Isolated fixtures and browser interaction regression checks. Start local web on 3107 first.
 * DATABASE_URL=<allocated URL> ASSISTANT_TEST_TARGET_TOKEN=<token> pnpm tsx scripts/visual-qa/person-tree.ts
 * Cleanup: pnpm visual-qa:cleanup <printed-run-id> with the same allocated target.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { getAgent } from '@assistant/core/chat';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import {
  contacts,
  createDb,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  occasions,
} from '@assistant/db';
import { eq } from 'drizzle-orm';
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
const marker = `visual-qa:${runId}:person-tree`;
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
const contactIds = [randomUUID(), randomUUID()];
const entityIds = fixture.map(() => randomUUID());
const occasionIds = [randomUUID()];
const entityCanonicalKeys = fixture.map(([label, kind], index) =>
  index < 2 ? `contact:${contactIds[index]}` : `${kind}:graph-qa-${runId}-${label}`,
);
const memoryIds = facts.map(() => randomUUID());
const memoryContentHashes = facts.map((_, index) => `${marker}:memory:${index}`);
const relationIds = facts.map(() => randomUUID());
const relationFingerprints = facts.map((_, index) => `${marker}:relation:${index}`);
const manifest = await writeVisualQaManifest({
  fixtureKind: 'person-tree',
  runId,
  targetDatabaseName: target.databaseName,
  targetToken: target.token,
  agentId: agent.id,
  ids: {
    contactIds,
    entityIds,
    memoryIds,
    memoryContentHashes,
    relationIds,
    occasionIds,
  },
  provenance: {
    marker,
    contactNotes: marker,
    entityCanonicalKeys,
    relationFingerprintPrefix: `${marker}:relation:`,
  },
});
const nodes = fixture.map(([label, kind], index) => ({
  id: entityIds[index] as string,
  agentId: agent.id,
  label: label as string,
  kind: kind as string,
  canonicalKey: entityCanonicalKeys[index] as string,
  contactId: index < 2 ? (contactIds[index] ?? null) : null,
}));
const alex = nodes[0];
const robin = nodes[1];
const alexContactId = contactIds[0];
if (!alex || !robin || !alexContactId || !contactIds[1]) throw new Error('Missing fixture');
await db.transaction(async (tx) => {
  await tx.insert(contacts).values([
    {
      id: contactIds[0] as string,
      name: 'Alex Rivera',
      trust: 'known',
      relationship: 'Friend',
      notes: marker,
    },
    {
      id: contactIds[1] as string,
      name: 'Robin Rivera',
      trust: 'known',
      relationship: 'Friend',
      notes: marker,
    },
  ]);
  await tx.insert(knowledgeGraphEntities).values(nodes);
  await tx.insert(occasions).values({
    id: occasionIds[0],
    agentId: agent.id,
    contactId: alexContactId,
    kind: 'birthday',
    month: 3,
    day: 18,
    year: 1985,
    leadDays: 14,
    notes: 'Gift ideas',
    ownerConfirmed: true,
  });
  for (const [index, [from, predicate, to, content, reviewStatus]] of facts.entries()) {
    const subject = nodes[from];
    const object = nodes[to];
    const memoryId = memoryIds[index];
    const contentHash = memoryContentHashes[index];
    const relationId = relationIds[index];
    const fingerprint = relationFingerprints[index];
    if (!subject || !object || !memoryId || !contentHash || !relationId || !fingerprint)
      throw new Error('Incomplete person tree fixture manifest');
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

mkdirSync('/tmp/assistant-people-qa', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const personURL = `http://127.0.0.1:3107/people/${alexContactId}`;
try {
  await page.goto(personURL);
  const dates = page.locator('#important-dates');
  await dates.getByRole('button', { name: 'Edit birthday', exact: true }).click();
  await dates.getByLabel('Month', { exact: true }).fill('2');
  await dates.getByLabel('Day', { exact: true }).fill('29');
  await dates.getByLabel('Year (optional)', { exact: true }).fill('');
  await dates.getByLabel('Notes / gift ideas (optional)', { exact: true }).fill('');
  assert.equal(await dates.getByLabel('Remind (days before)').inputValue(), '14');
  await dates.getByRole('button', { name: 'Save changes', exact: true }).click();
  await dates
    .getByRole('button', { name: 'Save changes', exact: true })
    .waitFor({ state: 'detached' });
  await dates.getByText('Feb 29', { exact: true }).waitFor();
  await page.reload();
  assert.match(await dates.innerText(), /Feb 29/);
  const saved = await db.select().from(occasions).where(eq(occasions.contactId, alexContact.id));
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.year, null);
  assert.equal(saved[0]?.notes, '');
  assert.equal(saved[0]?.leadDays, 14);
  await dates.getByRole('button', { name: 'Edit birthday', exact: true }).click();
  await dates.getByLabel('Day', { exact: true }).fill('30');
  await dates.getByRole('button', { name: 'Save changes', exact: true }).click();
  await dates
    .getByRole('alert')
    .getByText(/does not exist/)
    .waitFor();
  await dates.getByRole('button', { name: 'Cancel', exact: true }).click();

  const tree = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Explore connections', exact: true }) });
  await tree.getByRole('button', { name: 'Expand Northstar Robotics', exact: true }).click();
  await tree.getByRole('button', { name: 'Expand Maya Chen', exact: true }).click();
  await tree.getByRole('button', { name: 'Return to Northstar Robotics', exact: true }).waitFor();
  await tree.getByRole('button', { name: 'Maya Chen', exact: true }).click();
  await tree
    .getByRole('navigation', { name: 'Connection trail' })
    .getByRole('button', { name: 'Maya Chen', exact: true })
    .waitFor();
  await tree
    .getByRole('navigation', { name: 'Connection trail' })
    .getByRole('button', { name: 'Alex Rivera', exact: true })
    .click();
  await tree.getByText('Manage connection · 2 sources', { exact: true }).click();
  const managed = tree.locator('details[open]');
  await managed.getByRole('button', { name: 'View source 1', exact: true }).click();
  await managed.locator('blockquote').waitFor();
  await tree.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/assistant-people-qa/tree-desktop.png' });
  await managed.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await managed.getByRole('button', { name: 'Cancel', exact: true }).click();
  await managed.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await managed.getByRole('button', { name: 'Remove connection', exact: true }).click();
  await tree.getByRole('button', { name: 'Expand Robin Rivera', exact: true }).waitFor();
  await tree
    .getByText('Manage connection · 2 sources', { exact: true })
    .waitFor({ state: 'detached' });
  const relations = await db
    .select()
    .from(knowledgeGraphRelations)
    .where(eq(knowledgeGraphRelations.subjectEntityId, alex.id));
  assert.equal(
    relations.filter((row) => row.predicate === 'parent_of' && row.reviewStatus === 'rejected')
      .length,
    1,
  );
  assert.equal(
    relations.filter((row) => row.predicate === 'parent_of' && row.reviewStatus !== 'rejected')
      .length,
    1,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await tree.getByRole('button', { name: 'Expand Northstar Robotics', exact: true }).click();
  await tree.getByRole('button', { name: 'Expand Maya Chen', exact: true }).click();
  await tree.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/assistant-people-qa/tree-phone.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.reload();
  await tree.getByRole('button', { name: 'Expand Northstar Robotics', exact: true }).click();
  await tree.getByRole('button', { name: 'Expand Maya Chen', exact: true }).click();
  await tree.scrollIntoViewIfNeeded();
  assert.equal(
    await page
      .locator('html')
      .getAttribute('class')
      .then((value) => value?.includes('dark')),
    true,
  );
  await page.screenshot({ path: '/tmp/assistant-people-qa/tree-phone-dark.png' });
  await page.goto(`http://127.0.0.1:3107/profile/knowledge?view=map&entity=${alex.id}`);
  await page.getByRole('button', { name: 'Tree', exact: true }).click();
  await page.getByRole('button', { name: 'Expand Robin Rivera', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, runId, personURL, screenshots: '/tmp/assistant-people-qa' }),
  );
} finally {
  await browser.close();
  await db.$client.end({ timeout: 5 });
}
await markVisualQaRun(manifest, 'complete');
