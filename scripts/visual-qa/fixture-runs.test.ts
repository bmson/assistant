import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { getAgent } from '@assistant/core';
import {
  commitments,
  contacts,
  conversations,
  createDb,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  messages,
  occasions,
  situationPacks,
} from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertAllocatedTestTargetMarker } from '../test-target.js';
import {
  cleanupVisualQaRuns,
  newVisualQaRunId,
  visualQaManifestPath,
  writeVisualQaManifest,
} from './fixture-runs.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const token = process.env.ASSISTANT_TEST_TARGET_TOKEN;
if (!databaseUrl || !token) throw new Error('Run through the allocated pnpm test wrapper');
const target = assertAllocatedTestTargetMarker({
  databaseUrl,
  testDatabaseUrl: databaseUrl,
  token,
  kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
});
const db = createDb(databaseUrl, { max: 3 });
const runIds: string[] = [];
let agentId = '';
let primaryConversationId = '';
let dbUp = false;

describe('visual QA fixture run ownership and cleanup', () => {
  beforeAll(async () => {
    const agent = await getAgent(db);
    agentId = agent.id;
    dbUp = true;
    primaryConversationId = randomUUID();
    await db.insert(conversations).values({
      id: primaryConversationId,
      agentId,
      channel: 'chat',
      title: 'Fixture cleanup test primary',
      trust: 'owner',
      isPrimary: true,
    });
  });

  afterAll(async () => {
    if (dbUp) {
      await db.delete(messages).where(eq(messages.conversationId, primaryConversationId));
      await db.delete(conversations).where(eq(conversations.id, primaryConversationId));
    }
    for (const runId of runIds) {
      await Promise.all([
        unlink(visualQaManifestPath(runId)).catch(() => {}),
        unlink(visualQaManifestPath(runId).replace('.manifest.json', '.jsonl')).catch(() => {}),
      ]);
    }
    await db.$client.end({ timeout: 5 });
  });

  it('recovers a partial planned run by exact IDs and retains unrelated primary history', async () => {
    if (!dbUp) return;
    const runId = newVisualQaRunId();
    runIds.push(runId);
    const marker = `visual-qa:${runId}:qa-messages`;
    const fixtureMessageId = randomUUID();
    const unrelatedMessageId = randomUUID();
    const [owner] = await db
      .select({ id: conversations.agentId })
      .from(conversations)
      .where(eq(conversations.id, primaryConversationId))
      .limit(1);
    if (!owner || owner.id !== agentId) throw new Error('primary owner changed unexpectedly');
    await writeVisualQaManifest({
      fixtureKind: 'qa-messages',
      runId,
      targetDatabaseName: target.databaseName,
      targetToken: target.token,
      agentId,
      ids: {
        conversationId: primaryConversationId,
        conversationCreated: false,
        messageIds: [fixtureMessageId],
      },
      provenance: {
        marker,
        channelMessageIds: [`${marker}:reply`],
      },
    });
    await db.insert(messages).values([
      {
        id: fixtureMessageId,
        conversationId: primaryConversationId,
        role: 'assistant',
        origin: 'assistant',
        text: 'synthetic visual reply',
        parts: [],
        channelMessageId: `${marker}:reply`,
      },
      {
        id: unrelatedMessageId,
        conversationId: primaryConversationId,
        role: 'user',
        origin: 'owner',
        text: 'ordinary owner content must remain',
        parts: [],
      },
    ]);

    const result = await cleanupVisualQaRuns({
      db,
      target,
      runId,
      fixtureKind: 'qa-messages',
    });
    expect(result).toEqual({ cleaned: 1, skipped: 0 });
    expect(
      await cleanupVisualQaRuns({
        db,
        target,
        runId,
        fixtureKind: 'qa-messages',
      }),
    ).toEqual({ cleaned: 0, skipped: 1 });
    expect(
      await db.select({ id: messages.id }).from(messages).where(eq(messages.id, fixtureMessageId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.id, unrelatedMessageId)),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, primaryConversationId)),
    ).toHaveLength(1);
  });

  it('refuses a manifest ID whose row no longer has the run marker', async () => {
    const runId = newVisualQaRunId();
    runIds.push(runId);
    const fixtureMessageId = randomUUID();
    const marker = `visual-qa:${runId}:qa-messages`;
    await writeVisualQaManifest({
      fixtureKind: 'qa-messages',
      runId,
      targetDatabaseName: target.databaseName,
      targetToken: target.token,
      agentId,
      ids: { conversationId: primaryConversationId, messageIds: [fixtureMessageId] },
      provenance: { marker, channelMessageIds: [`${marker}:reply`] },
    });
    await db.insert(messages).values({
      id: fixtureMessageId,
      conversationId: primaryConversationId,
      role: 'assistant',
      origin: 'assistant',
      text: 'row was replaced after the fixture manifest',
      parts: [],
      channelMessageId: 'ordinary-channel-message',
    });
    await expect(
      cleanupVisualQaRuns({ db, target, runId, fixtureKind: 'qa-messages' }),
    ).rejects.toThrow(/fixture identity mismatch/);
    expect(
      await db.select({ id: messages.id }).from(messages).where(eq(messages.id, fixtureMessageId)),
    ).toHaveLength(1);
    await db.delete(messages).where(eq(messages.id, fixtureMessageId));
  });

  it('rejects a different fixture kind and mismatched allocator token before deleting rows', async () => {
    const runId = newVisualQaRunId();
    runIds.push(runId);
    await writeVisualQaManifest({
      fixtureKind: 'qa-messages',
      runId,
      targetDatabaseName: target.databaseName,
      targetToken: target.token,
      agentId,
      ids: { conversationId: primaryConversationId },
      provenance: { marker: `visual-qa:${runId}:qa-messages` },
    });
    await expect(
      cleanupVisualQaRuns({ db, target, runId, fixtureKind: 'people-evidence' }),
    ).rejects.toThrow(/different fixture writer/);
    await expect(
      cleanupVisualQaRuns({
        db,
        target: { ...target, token: randomUUID() },
        runId,
        fixtureKind: 'qa-messages',
      }),
    ).rejects.toThrow(/ownership marker/);
  });

  it('cleans only run-owned graph and people rows, retaining unrelated owner data', async () => {
    const runId = newVisualQaRunId();
    runIds.push(runId);
    const marker = `visual-qa:${runId}:person-tree`;
    const contactId = randomUUID();
    const unrelatedContactId = randomUUID();
    const entityIds = [randomUUID(), randomUUID()];
    const canonicalKeys = [`contact:${contactId}`, `contact:${randomUUID()}`];
    const memoryId = randomUUID();
    const memoryContentHash = `${marker}:memory:0`;
    const relationId = randomUUID();
    const occasionId = randomUUID();
    await writeVisualQaManifest({
      fixtureKind: 'person-tree',
      runId,
      targetDatabaseName: target.databaseName,
      targetToken: target.token,
      agentId,
      ids: {
        contactIds: [contactId],
        entityIds,
        memoryIds: [memoryId],
        memoryContentHashes: [memoryContentHash],
        relationIds: [relationId],
        occasionIds: [occasionId],
      },
      provenance: {
        marker,
        contactNotes: marker,
        entityCanonicalKeys: canonicalKeys,
        relationFingerprintPrefix: `${marker}:relation:`,
      },
    });
    await db.transaction(async (tx) => {
      await tx.insert(contacts).values([
        { id: contactId, name: 'Visual QA person', trust: 'known', notes: marker },
        {
          id: unrelatedContactId,
          name: 'Ordinary owner person',
          trust: 'known',
          notes: 'owner data',
        },
      ]);
      await tx.insert(knowledgeGraphEntities).values([
        {
          id: entityIds[0] as string,
          agentId,
          label: 'Visual QA person',
          kind: 'person',
          contactId,
          canonicalKey: canonicalKeys[0] as string,
        },
        {
          id: entityIds[1] as string,
          agentId,
          label: 'Visual QA place',
          kind: 'place',
          canonicalKey: canonicalKeys[1] as string,
        },
      ]);
      await tx.insert(memories).values({
        id: memoryId,
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: 'Visual QA synthetic graph statement',
        contentHash: memoryContentHash,
        originTrust: 'assistant',
        quarantined: true,
        embedding: Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
      });
      await tx.insert(knowledgeGraphSources).values({
        memoryId,
        contentHash: memoryContentHash,
        status: 'ready',
        extractionVersion: 2,
      });
      await tx.insert(knowledgeGraphRelations).values({
        id: relationId,
        agentId,
        subjectEntityId: entityIds[0] as string,
        objectEntityId: entityIds[1] as string,
        predicate: 'lives_in',
        sourceMemoryId: memoryId,
        evidenceQuote: 'Visual QA synthetic graph statement',
        sourceFingerprint: `${marker}:relation:0`,
        ordinal: 0,
        confidence: '0.9',
        reviewStatus: 'unreviewed',
      });
      await tx.insert(occasions).values({
        id: occasionId,
        agentId,
        contactId,
        kind: 'birthday',
        month: 3,
        day: 18,
        notes: marker,
      });
    });
    const result = await cleanupVisualQaRuns({
      db,
      target,
      runId,
      fixtureKind: 'person-tree',
    });
    expect(result).toEqual({ cleaned: 1, skipped: 0 });
    expect(
      await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.id, unrelatedContactId)),
    ).toHaveLength(1);
    expect(
      await db.select({ id: memories.id }).from(memories).where(eq(memories.id, memoryId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: knowledgeGraphRelations.id })
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.id, relationId)),
    ).toEqual([]);
  });

  it('removes a manifest-created non-primary conversation only after its exact children', async () => {
    const runId = newVisualQaRunId();
    runIds.push(runId);
    const marker = `visual-qa:${runId}:situation-packs`;
    const conversationId = randomUUID();
    const commitmentId = randomUUID();
    const packId = randomUUID();
    const creationKey = `${marker}:pack:${randomUUID()}`;
    await writeVisualQaManifest({
      fixtureKind: 'situation-packs',
      runId,
      targetDatabaseName: target.databaseName,
      targetToken: target.token,
      agentId,
      ids: {
        conversationId,
        conversationCreated: true,
        commitmentIds: [commitmentId],
        situationPackIds: [packId],
        situationCreationKeys: [creationKey],
      },
      provenance: { marker },
    });
    await db.insert(conversations).values({
      id: conversationId,
      agentId,
      channel: 'chat',
      title: 'Synthetic situation fixture',
      trust: 'owner',
      metadata: { visualQaRunId: runId, targetDatabaseName: target.databaseName },
    });
    await db.insert(commitments).values({
      id: commitmentId,
      agentId,
      conversationId,
      kind: 'waiting_on',
      title: 'Synthetic QA child',
      details: `${marker}:commitment`,
      contentHash: `${marker}:commitment-hash`,
    });
    await db.insert(situationPacks).values({
      id: packId,
      agentId,
      title: 'Synthetic QA pack',
      creationKey,
      data: { items: [], decisions: [] },
    });

    const result = await cleanupVisualQaRuns({
      db,
      target,
      runId,
      fixtureKind: 'situation-packs',
    });
    expect(result).toEqual({ cleaned: 1, skipped: 0 });
    expect(
      await db
        .select({ id: commitments.id })
        .from(commitments)
        .where(eq(commitments.id, commitmentId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: situationPacks.id })
        .from(situationPacks)
        .where(eq(situationPacks.id, packId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId)),
    ).toEqual([]);
  });
});
