/** Local-only pack fixture + browser interaction QA. Never point this at production.
 * DATABASE_URL=<allocated URL> ASSISTANT_TEST_TARGET_TOKEN=<token> pnpm tsx scripts/visual-qa/situation-packs.ts
 * Cleanup: pnpm visual-qa:cleanup <printed-run-id> with the same allocated target.
 * Start the web server on 127.0.0.1:3107 with AUTH_DEV_BYPASS=true first.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { getAgent } from '@assistant/core/chat';
import { commandSituationPack, getSituationPack } from '@assistant/core/situations';
import {
  commitments,
  conversations,
  createDb,
  generatedCardRevisions,
  generatedCards,
  situationPacks,
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
const marker = `visual-qa:${runId}:situation-packs`;
const cardId = randomUUID();
const revisionId = randomUUID();
const loopId = randomUUID();
const conversationId = randomUUID();
const packId = randomUUID();
const creationKey = `${marker}:pack:${randomUUID()}`;
const manifest = await writeVisualQaManifest({
  fixtureKind: 'situation-packs',
  runId,
  targetDatabaseName: target.databaseName,
  targetToken: target.token,
  agentId: agent.id,
  ids: {
    conversationId,
    conversationCreated: true,
    commitmentIds: [loopId],
    cardIds: [cardId],
    cardRevisionIds: [revisionId],
    situationPackIds: [packId],
    situationCreationKeys: [creationKey],
  },
  provenance: {
    marker,
    cardFingerprint: `${marker}:card:${randomUUID()}`,
  },
});
try {
  await db.insert(conversations).values({
    id: conversationId,
    agentId: agent.id,
    channel: 'chat',
    title: 'Situation pack QA fixture',
    trust: 'owner',
    metadata: {
      visualQaRunId: runId,
      targetDatabaseName: target.databaseName,
    },
  });
  await db.insert(commitments).values({
    id: loopId,
    agentId: agent.id,
    conversationId,
    kind: 'waiting_on',
    title: 'Hotel confirms late arrival',
    details: `${marker}:commitment`,
    contentHash: randomUUID(),
  });
  await db.insert(generatedCards).values({
    id: cardId,
    agentId: agent.id,
    sourceLabel: 'Synthetic QA fixture',
    sourceFingerprint: manifest.provenance.cardFingerprint,
    currentRevisionId: revisionId,
  });
  await db.insert(generatedCardRevisions).values({
    id: revisionId,
    cardId,
    spec: {
      version: 1,
      title: 'Harbor Hotel',
      accessibilityLabel: 'Synthetic hotel reservation',
      sourceLabel: 'Synthetic QA fixture',
      facts: [
        { id: 'name', value: 'Harbor Hotel', source: 'QA fixture' },
        {
          id: 'arrival',
          label: 'Arrival',
          value: 'Saturday, after the match',
          source: 'QA fixture',
        },
      ],
      blocks: [
        { type: 'hero', titleFact: 'name' },
        { type: 'facts', factIds: ['arrival'] },
      ],
    },
  });
  await db.insert(situationPacks).values({
    id: packId,
    agentId: agent.id,
    title: 'Soccer weekend · QA',
    creationKey,
    data: { items: [], decisions: [] },
  });
  for (const item of [
    {
      id: 'hotel',
      title: 'Hotel for the weekend',
      details: 'Keep the reservation and arrival plan together.',
      source: { kind: 'card', id: cardId },
    },
    {
      id: 'reply',
      title: 'Late-arrival confirmation',
      lane: 'waiting_on',
      source: { kind: 'commitment', id: loopId },
    },
    {
      id: 'route',
      title: 'Plan the drive after the match',
      details: 'Recheck the destination if the hotel changes.',
      dependsOn: ['hotel'],
    },
    {
      id: 'arrival',
      title: 'Send the arrival time',
      details: 'Only after the hotel confirms.',
      lane: 'i_owe',
      dependsOn: ['reply', 'route'],
    },
  ]) {
    const pack = await getSituationPack(db, agent.id, packId);
    const result = await commandSituationPack(db, agent.id, {
      action: 'item',
      packId,
      version: pack?.version,
      item,
    });
    if (!result.ok) throw new Error(result.error);
  }
  const pack = await getSituationPack(db, agent.id, packId);
  await commandSituationPack(
    db,
    agent.id,
    {
      action: 'decision',
      packId,
      version: pack?.version,
      decision: {
        id: 'food',
        option: 'A late sit-down dinner',
        outcome: 'rejected',
        reason: 'Too late for the kids after the match.',
        scope: 'situation',
      },
    },
    { ownerConfirmed: true },
  );
  await markVisualQaRun(manifest, 'seeded');
  // Source mutation, not a pack edit: exercises change-aware projection.
  await db
    .update(commitments)
    .set({
      status: 'resolved',
      resolution: 'QA: the owner confirmed receipt of the hotel reply.',
      updatedAt: new Date(),
    })
    .where(eq(commitments.id, loopId));
} catch (error) {
  await markVisualQaRun(manifest, 'failed', { error: 'fixture seeding failed' });
  throw error;
} finally {
  await db.$client.end({ timeout: 5 });
}

const out = '/tmp/assistant-packs-qa';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:3107/packs', { waitUntil: 'networkidle' });
  await page.getByLabel('Choose pack').selectOption(packId);
  await page.screenshot({ path: `${out}/web-phone-overview.png`, fullPage: true });
  const changedRow = page
    .locator('article')
    .getByRole('heading', { name: 'Hotel for the weekend', exact: true });
  await changedRow
    .locator('..')
    .locator('..')
    .getByRole('button', { name: 'Review / change' })
    .click();
  await page.getByLabel('Title', { exact: true }).fill('Revised hotel plan');
  await page.getByRole('button', { name: 'Preview change', exact: true }).click();
  await page.getByRole('heading', { name: 'Rehearsal · not applied' }).waitFor();
  // The persisted row still has its old title until the explicit Apply button.
  if (await page.getByRole('heading', { name: 'Revised hotel plan', exact: true }).count())
    throw new Error('Preview mutated the plan.');
  await page.screenshot({ path: `${out}/web-phone-preview.png`, fullPage: true });
  await page.getByRole('button', { name: 'Apply to pack', exact: true }).click();
  await page.getByRole('heading', { name: 'Revised hotel plan', exact: true }).waitFor();
  const notice = await page.getByRole('status').filter({ hasText: 'Pack updated.' }).textContent();
  if (!notice?.includes('nothing outside this pack changed'))
    throw new Error('Missing apply scope feedback');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${out}/web-desktop.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('Choose pack').selectOption(packId);
  if (!(await page.locator('html').getAttribute('class'))?.includes('dark'))
    throw new Error('Dark theme was not applied.');
  await page.screenshot({ path: `${out}/web-dark.png`, fullPage: true });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Pack ${packId}: browser preview/apply passed. Run ${runId}. Screenshots: ${out}`);
  await markVisualQaRun(manifest, 'complete');
} catch (error) {
  await markVisualQaRun(manifest, 'failed', { error: 'visual QA interaction failed' });
  throw error;
} finally {
  await browser.close();
}
