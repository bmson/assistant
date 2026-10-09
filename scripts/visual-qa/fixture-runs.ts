import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  agents,
  commitments,
  contacts,
  conversations,
  type Db,
  generatedCardRevisions,
  generatedCards,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  messages,
  occasions,
  situationPacks,
} from '@assistant/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { VerifiedScriptTestTarget } from '../test-target.js';
import { assertAllocatedTestDatabaseOwnership } from '../test-target.js';
import {
  appendPrivateJsonLine,
  readPrivateJson,
  replacePrivateJson,
  writeImmutableJson,
} from './chat-readability-safety.js';

export type VisualQaFixtureKind =
  | 'qa-messages'
  | 'people-evidence'
  | 'knowledge-graph'
  | 'person-tree'
  | 'situation-packs';

export interface VisualQaFixtureManifest {
  schemaVersion: 1;
  fixtureKind: VisualQaFixtureKind;
  runId: string;
  targetDatabaseName: string;
  targetToken: string;
  agentId: string;
  createdAt: string;
  status: 'planned' | 'seeded' | 'complete' | 'failed' | 'cleaned';
  ids: {
    conversationId?: string;
    conversationCreated?: boolean;
    messageIds?: string[];
    contactIds?: string[];
    entityIds?: string[];
    memoryIds?: string[];
    memoryContentHashes?: string[];
    relationIds?: string[];
    relationFingerprints?: string[];
    occasionIds?: string[];
    commitmentIds?: string[];
    cardIds?: string[];
    cardRevisionIds?: string[];
    situationPackIds?: string[];
    situationCreationKeys?: string[];
  };
  provenance: {
    marker: string;
    channelMessageIds?: string[];
    contactNotes?: string;
    entityCanonicalKeys?: string[];
    relationFingerprintPrefix?: string;
    cardFingerprint?: string;
  };
}

export const visualQaArtifactDirectory =
  process.env.ASSISTANT_VISUAL_QA_ARTIFACT_DIR ?? '/tmp/assistant-visual-qa-runs';

export function newVisualQaRunId(): string {
  return randomUUID();
}

export function visualQaManifestPath(runId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('invalid visual QA run ID');
  return path.join(visualQaArtifactDirectory, `${runId}.manifest.json`);
}

/** Persist exact IDs and ownership evidence before a fixture writer touches PostgreSQL. */
export async function writeVisualQaManifest(
  input: Omit<VisualQaFixtureManifest, 'schemaVersion' | 'createdAt' | 'status'>,
): Promise<VisualQaFixtureManifest> {
  const manifest: VisualQaFixtureManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    status: 'planned',
    ...input,
  };
  const file = visualQaManifestPath(manifest.runId);
  await writeImmutableJson(file, manifest);
  await appendPrivateJsonLine(path.join(visualQaArtifactDirectory, `${manifest.runId}.jsonl`), {
    at: manifest.createdAt,
    event: 'fixture_run_planned',
    runId: manifest.runId,
    fixtureKind: manifest.fixtureKind,
    targetDatabaseName: manifest.targetDatabaseName,
    ids: manifest.ids,
  });
  return manifest;
}

export async function markVisualQaRun(
  manifest: VisualQaFixtureManifest,
  status: VisualQaFixtureManifest['status'],
  details: Record<string, unknown> = {},
): Promise<void> {
  const at = new Date().toISOString();
  const file = visualQaManifestPath(manifest.runId);
  const current = await readPrivateJson<VisualQaFixtureManifest>(file);
  if (
    current.runId !== manifest.runId ||
    current.targetToken !== manifest.targetToken ||
    current.fixtureKind !== manifest.fixtureKind
  )
    throw new Error('visual QA manifest identity changed during the run');
  current.status = status;
  await appendPrivateJsonLine(path.join(visualQaArtifactDirectory, `${manifest.runId}.jsonl`), {
    at,
    event: `fixture_run_${status}`,
    runId: manifest.runId,
    ...details,
  });
  await replacePrivateJson(file, current);
  manifest.status = status;
}

/**
 * Recover a planned, interrupted, or completed local fixture run. Every delete
 * is constrained by the manifest's explicit IDs plus a second owner/run marker
 * read from the row. Missing partial-write rows are harmless; mismatched rows
 * stop cleanup before any mutation.
 */
export async function cleanupVisualQaRuns(input: {
  db: Db;
  target: VerifiedScriptTestTarget;
  runId: string;
  fixtureKind: VisualQaFixtureKind;
}): Promise<{ cleaned: number; skipped: number }> {
  if (!/^[0-9a-f-]{36}$/i.test(input.runId)) throw new Error('cleanup requires a visual QA run ID');
  await assertAllocatedTestDatabaseOwnership(input.db, input.target);
  let manifest: VisualQaFixtureManifest;
  try {
    manifest = await readVisualQaManifest(input.runId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cleaned: 0, skipped: 0 };
    throw error;
  }
  if (manifest.runId !== input.runId) throw new Error('visual QA manifest run ID mismatch');
  if (manifest.fixtureKind !== input.fixtureKind)
    throw new Error('visual QA run ID belongs to a different fixture writer');
  if (
    manifest.schemaVersion !== 1 ||
    manifest.targetDatabaseName !== input.target.databaseName ||
    manifest.targetToken !== input.target.token
  )
    throw new Error('refusing cleanup: fixture manifest target does not match allocated database');
  if (manifest.status === 'cleaned') return { cleaned: 0, skipped: 1 };
  await cleanupOne(input.db, manifest);
  manifest.status = 'cleaned';
  await appendPrivateJsonLine(path.join(visualQaArtifactDirectory, `${manifest.runId}.jsonl`), {
    at: new Date().toISOString(),
    event: 'fixture_run_cleaned',
    runId: manifest.runId,
    fixtureKind: manifest.fixtureKind,
  });
  await replacePrivateJson(visualQaManifestPath(manifest.runId), manifest);
  return { cleaned: 1, skipped: 0 };
}

async function cleanupOne(db: Db, manifest: VisualQaFixtureManifest): Promise<void> {
  const ids = manifest.ids;
  await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, manifest.agentId))
      .limit(1);
    if (!owner) throw new Error('refusing cleanup: manifest owner does not exist in this database');
    const messageIds = ids.messageIds ?? [];
    if (messageIds.length) {
      const rows = await tx
        .select()
        .from(messages)
        .where(inArray(messages.id, messageIds))
        .for('update');
      for (const row of rows) {
        if (
          row.conversationId !== ids.conversationId ||
          !manifest.provenance.channelMessageIds?.includes(row.channelMessageId ?? '')
        )
          throw new Error(`refusing to clean message ${row.id}: fixture identity mismatch`);
      }
      if (rows.length)
        await tx.delete(messages).where(
          inArray(
            messages.id,
            rows.map((r) => r.id),
          ),
        );
    }

    const relations = ids.relationIds ?? [];
    if (relations.length) {
      const rows = await tx
        .select()
        .from(knowledgeGraphRelations)
        .where(inArray(knowledgeGraphRelations.id, relations))
        .for('update');
      for (const row of rows) {
        if (
          row.agentId !== manifest.agentId ||
          !manifest.provenance.relationFingerprintPrefix ||
          !row.sourceFingerprint.startsWith(manifest.provenance.relationFingerprintPrefix) ||
          !ids.entityIds?.includes(row.subjectEntityId) ||
          !ids.entityIds.includes(row.objectEntityId) ||
          !ids.memoryIds?.includes(row.sourceMemoryId)
        )
          throw new Error(`refusing to clean graph relation ${row.id}: fixture identity mismatch`);
      }
      if (rows.length)
        await tx
          .delete(knowledgeGraphRelations)
          .where(inArray(knowledgeGraphRelations.id, relations));
    }

    const memoryIds = ids.memoryIds ?? [];
    if (memoryIds.length) {
      const rows = await tx
        .select()
        .from(memories)
        .where(inArray(memories.id, memoryIds))
        .for('update');
      for (const row of rows) {
        const index = memoryIds.indexOf(row.id);
        if (
          row.agentId !== manifest.agentId ||
          row.contentHash !== ids.memoryContentHashes?.[index]
        )
          throw new Error(`refusing to clean memory ${row.id}: fixture identity mismatch`);
      }
      const sources = await tx
        .select()
        .from(knowledgeGraphSources)
        .where(inArray(knowledgeGraphSources.memoryId, memoryIds))
        .for('update');
      for (const row of sources) {
        const index = memoryIds.indexOf(row.memoryId);
        if (row.contentHash !== ids.memoryContentHashes?.[index])
          throw new Error(
            `refusing to clean graph source ${row.memoryId}: fixture identity mismatch`,
          );
      }
      if (sources.length)
        await tx.delete(knowledgeGraphSources).where(
          inArray(
            knowledgeGraphSources.memoryId,
            sources.map((row) => row.memoryId),
          ),
        );
      if (rows.length) await tx.delete(memories).where(inArray(memories.id, memoryIds));
    }

    const entityIds = ids.entityIds ?? [];
    if (entityIds.length) {
      const rows = await tx
        .select()
        .from(knowledgeGraphEntities)
        .where(inArray(knowledgeGraphEntities.id, entityIds))
        .for('update');
      for (const row of rows) {
        const index = entityIds.indexOf(row.id);
        if (
          row.agentId !== manifest.agentId ||
          row.canonicalKey !== manifest.provenance.entityCanonicalKeys?.[index]
        )
          throw new Error(`refusing to clean graph entity ${row.id}: fixture identity mismatch`);
      }
      if (rows.length)
        await tx
          .delete(knowledgeGraphEntities)
          .where(inArray(knowledgeGraphEntities.id, entityIds));
    }

    const occasionIds = ids.occasionIds ?? [];
    if (occasionIds.length) {
      const rows = await tx
        .select()
        .from(occasions)
        .where(inArray(occasions.id, occasionIds))
        .for('update');
      for (const row of rows) {
        if (row.agentId !== manifest.agentId || !ids.contactIds?.includes(row.contactId))
          throw new Error(`refusing to clean occasion ${row.id}: fixture identity mismatch`);
      }
      if (rows.length) await tx.delete(occasions).where(inArray(occasions.id, occasionIds));
    }

    const contactIds = ids.contactIds ?? [];
    if (contactIds.length) {
      const rows = await tx
        .select()
        .from(contacts)
        .where(inArray(contacts.id, contactIds))
        .for('update');
      for (const row of rows) {
        if (!manifest.provenance.contactNotes || row.notes !== manifest.provenance.contactNotes)
          throw new Error(`refusing to clean contact ${row.id}: fixture identity mismatch`);
      }
      if (rows.length) await tx.delete(contacts).where(inArray(contacts.id, contactIds));
    }

    const commitmentIds = ids.commitmentIds ?? [];
    if (commitmentIds.length) {
      const rows = await tx
        .select()
        .from(commitments)
        .where(inArray(commitments.id, commitmentIds))
        .for('update');
      for (const row of rows) {
        if (
          row.agentId !== manifest.agentId ||
          row.conversationId !== ids.conversationId ||
          row.details !== `${manifest.provenance.marker}:commitment`
        )
          throw new Error(`refusing to clean commitment ${row.id}: fixture identity mismatch`);
      }
      if (rows.length) await tx.delete(commitments).where(inArray(commitments.id, commitmentIds));
    }

    const revisionIds = ids.cardRevisionIds ?? [];
    const cardIds = ids.cardIds ?? [];
    if (revisionIds.length && !cardIds.length)
      throw new Error('refusing to clean card revisions without their manifest card IDs');
    if (cardIds.length) {
      const rows = await tx
        .select()
        .from(generatedCards)
        .where(inArray(generatedCards.id, cardIds))
        .for('update');
      for (const row of rows) {
        if (
          row.agentId !== manifest.agentId ||
          row.sourceFingerprint !== manifest.provenance.cardFingerprint
        )
          throw new Error(`refusing to clean card ${row.id}: fixture identity mismatch`);
      }
      const revisions = revisionIds.length
        ? await tx
            .select()
            .from(generatedCardRevisions)
            .where(inArray(generatedCardRevisions.id, revisionIds))
            .for('update')
        : [];
      for (const row of revisions) {
        if (!cardIds.includes(row.cardId))
          throw new Error(`refusing to clean card revision ${row.id}: fixture identity mismatch`);
      }
      if (revisions.length)
        await tx
          .delete(generatedCardRevisions)
          .where(inArray(generatedCardRevisions.id, revisionIds));
      if (rows.length) await tx.delete(generatedCards).where(inArray(generatedCards.id, cardIds));
    }

    const packIds = ids.situationPackIds ?? [];
    if (packIds.length) {
      const rows = await tx
        .select()
        .from(situationPacks)
        .where(inArray(situationPacks.id, packIds))
        .for('update');
      for (const row of rows) {
        const index = packIds.indexOf(row.id);
        if (
          row.agentId !== manifest.agentId ||
          row.creationKey !== ids.situationCreationKeys?.[index] ||
          !row.creationKey.startsWith(`${manifest.provenance.marker}:pack:`)
        )
          throw new Error(`refusing to clean situation pack ${row.id}: fixture identity mismatch`);
      }
      if (rows.length) await tx.delete(situationPacks).where(inArray(situationPacks.id, packIds));
    }

    if (ids.conversationCreated && ids.conversationId) {
      const [row] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, ids.conversationId))
        .limit(1)
        .for('update');
      if (row) {
        const metadata = row.metadata as Record<string, unknown>;
        if (
          row.agentId !== manifest.agentId ||
          row.isPrimary ||
          metadata.visualQaRunId !== manifest.runId ||
          metadata.targetDatabaseName !== manifest.targetDatabaseName
        )
          throw new Error(`refusing to clean conversation ${row.id}: fixture identity mismatch`);
        const remainingMessages = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversationId, row.id))
          .limit(1);
        if (remainingMessages.length)
          throw new Error(`refusing to clean conversation ${row.id}: unrelated messages remain`);
        await tx
          .delete(conversations)
          .where(and(eq(conversations.id, row.id), eq(conversations.agentId, manifest.agentId)));
      }
    }
  });
}

export async function readVisualQaManifest(runId: string): Promise<VisualQaFixtureManifest> {
  return readPrivateJson<VisualQaFixtureManifest>(visualQaManifestPath(runId));
}

export async function listVisualQaManifests(): Promise<VisualQaFixtureManifest[]> {
  let names: string[];
  try {
    names = await readdir(visualQaArtifactDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const results: VisualQaFixtureManifest[] = [];
  for (const name of names.filter((value) => value.endsWith('.manifest.json')))
    results.push(
      await readPrivateJson<VisualQaFixtureManifest>(path.join(visualQaArtifactDirectory, name)),
    );
  return results;
}
