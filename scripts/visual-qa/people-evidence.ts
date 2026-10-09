/** Seed isolated, intentionally conflicting claims for native People evidence QA.
 * DATABASE_URL=<allocator URL> ASSISTANT_TEST_TARGET_TOKEN=<token> pnpm tsx scripts/visual-qa/people-evidence.ts
 * Never targets production or invokes a model. Cleanup: pnpm visual-qa:cleanup <run-id>.
 */
import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import {
  contacts,
  createDb,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
} from '@assistant/db';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from '../test-target.js';
import {
  cleanupVisualQaRuns,
  markVisualQaRun,
  newVisualQaRunId,
  writeVisualQaManifest,
} from './fixture-runs.js';

const target = assertAllocatedTestTargetMarker({
  databaseUrl: process.env.DATABASE_URL,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
});
const db = createDb(target.databaseUrl);
await assertAllocatedTestDatabaseOwnership(db, target);
let manifest: Awaited<ReturnType<typeof writeVisualQaManifest>> | undefined;
try {
  const cleanupIndex = process.argv.indexOf('--cleanup');
  if (cleanupIndex >= 0) {
    const runId = process.argv[cleanupIndex + 1] ?? '';
    const result = await cleanupVisualQaRuns({ db, target, runId, fixtureKind: 'people-evidence' });
    if (!result.cleaned && !result.skipped) throw new Error(`No fixture run found for ${runId}`);
    console.log(JSON.stringify(result));
  } else {
    const agent = await getAgent(db);
    const runId = newVisualQaRunId();
    const marker = `visual-qa:${runId}:people-evidence`;
    const names = ['Alex Rivera', 'Robin Rivera'];
    const contactIds = names.map(() => randomUUID());
    const entityIds = names.map(() => randomUUID());
    const memoryIds = [randomUUID(), randomUUID()];
    const memoryContentHashes = [0, 1].map((index) => `${marker}:memory:${index}`);
    const relationIds = [randomUUID(), randomUUID()];
    const relationFingerprints = [0, 1].map((index) => `${marker}:relation:${index}`);
    const entityCanonicalKeys = contactIds.map((id) => `contact:${id}`);
    manifest = await writeVisualQaManifest({
      fixtureKind: 'people-evidence',
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
        relationFingerprints,
      },
      provenance: {
        marker,
        contactNotes: marker,
        entityCanonicalKeys,
        relationFingerprintPrefix: `${marker}:relation:`,
      },
    });

    const predicates = ['parent_of', 'son_of'];
    const claims = [
      'Alex Rivera is the parent of Robin Rivera.',
      'Alex Rivera is the son of Robin Rivera. This QA claim is intentionally incorrect.',
    ];
    await db.transaction(async (tx) => {
      const insertedContacts = await tx
        .insert(contacts)
        .values(
          names.map((name, index) => ({
            id: contactIds[index],
            name,
            relationship: 'Family',
            trust: 'known',
            notes: marker,
          })),
        )
        .returning();
      await tx.insert(knowledgeGraphEntities).values(
        names.map((name, index) => ({
          id: entityIds[index],
          agentId: agent.id,
          label: name,
          kind: 'person',
          contactId: insertedContacts[index]?.id,
          canonicalKey: entityCanonicalKeys[index],
        })),
      );
      for (let index = 0; index < 2; index += 1) {
        const memoryId = memoryIds[index];
        const contentHash = memoryContentHashes[index];
        const relationId = relationIds[index];
        const fingerprint = relationFingerprints[index];
        const content = claims[index];
        const predicate = predicates[index];
        if (!memoryId || !contentHash || !relationId || !fingerprint || !content || !predicate)
          throw new Error('Incomplete people evidence fixture manifest');
        await tx.insert(memories).values({
          id: memoryId,
          agentId: agent.id,
          category: 'knowledge',
          kind: 'fact',
          content,
          contentHash,
          originTrust: 'assistant',
          quarantined: true,
          subjectContactId: contactIds[0],
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
          subjectEntityId: entityIds[0],
          objectEntityId: entityIds[1],
          predicate,
          sourceMemoryId: memoryId,
          evidenceQuote: content,
          sourceFingerprint: fingerprint,
          ordinal: 0,
          confidence: '0.9',
          reviewStatus: index === 0 ? 'confirmed' : 'unreviewed',
        });
      }
    });
    await markVisualQaRun(manifest, 'seeded');
    await markVisualQaRun(manifest, 'complete');
    console.log(JSON.stringify({ runId, marker, alex: contactIds[0], robin: contactIds[1] }));
  }
} catch (error) {
  if (manifest) await markVisualQaRun(manifest, 'failed', { error: 'fixture writer failed' });
  throw error;
} finally {
  await db.$client.end({ timeout: 5 });
}
