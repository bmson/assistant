import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresOwnerContextRepository } from './owner-context-repository.js';
import {
  agents,
  commitments,
  conversations,
  locationPings,
  messages,
  ownerCard,
} from './schema.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://assistant@127.0.0.1:55432/assistant_test';

describe('PostgreSQL owner context repository', () => {
  let db: Db;
  let agentId: string;
  const commitmentIds: string[] = [];
  const conversationIds: string[] = [];
  const locationIds: string[] = [];
  const messageIds: string[] = [];

  beforeEach(async () => {
    db = createDb(DATABASE_URL);
    const configured = await db.query.agents.findMany({ columns: { id: true }, limit: 2 });
    if (configured.length !== 1 || !configured[0]) {
      throw new Error('Owner context tests require exactly one seeded installation agent');
    }
    agentId = configured[0].id;
  });

  afterEach(async () => {
    if (commitmentIds.length) {
      await db.delete(commitments).where(inArray(commitments.id, commitmentIds));
    }
    if (messageIds.length) await db.delete(messages).where(inArray(messages.id, messageIds));
    if (conversationIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    if (locationIds.length) {
      await db.delete(locationPings).where(inArray(locationPings.id, locationIds));
    }
    commitmentIds.length = 0;
    conversationIds.length = 0;
    locationIds.length = 0;
    messageIds.length = 0;
    await db.$client.end();
  });

  it('exposes the legacy singleton only to the sole configured agent', async () => {
    const inserted = await db
      .insert(ownerCard)
      .values({ id: 1, content: 'Synthetic owner card' })
      .onConflictDoNothing()
      .returning({ id: ownerCard.id });
    const repository = createPostgresOwnerContextRepository(db);
    await expect(repository.getOwnerCard(agentId)).resolves.not.toBeNull();
    await expect(repository.getOwnerCard(randomUUID())).resolves.toBeNull();
    await db.transaction(async (tx) => {
      const secondAgentId = randomUUID();
      await tx.insert(agents).values({
        id: secondAgentId,
        name: 'Temporary second agent',
        email: `${secondAgentId}@example.test`,
        workspacePrefix: `test/${secondAgentId}`,
      });
      const scoped = createPostgresOwnerContextRepository(tx as unknown as Db);
      await expect(scoped.getOwnerCard(agentId)).resolves.toBeNull();
      await expect(scoped.getOwnerCard(secondAgentId)).resolves.toBeNull();
      await tx.delete(agents).where(eq(agents.id, secondAgentId));
    });
    if (inserted.length) await db.delete(ownerCard).where(eq(ownerCard.id, 1));
  });

  it('reads the latest location inside retention and source scope', async () => {
    const repository = createPostgresOwnerContextRepository(db);
    const source = `xtest-owner-context-${randomUUID()}`;
    const rows = [
      {
        id: randomUUID(),
        agentId,
        lat: '1',
        lng: '1',
        label: 'old',
        source,
        capturedAt: new Date('2026-09-12T10:00:00Z'),
      },
      {
        id: randomUUID(),
        agentId,
        lat: '2',
        lng: '2',
        label: 'latest',
        source,
        capturedAt: new Date('2026-09-12T11:59:00Z'),
      },
    ];
    locationIds.push(...rows.map((row) => row.id));
    await db.insert(locationPings).values(rows);
    await expect(
      repository.getLatestLocation({
        agentId,
        source,
        notBefore: new Date('2026-09-12T11:30:00Z'),
        notAfter: new Date('2026-09-12T12:00:00Z'),
      }),
    ).resolves.toMatchObject({ id: rows[1]?.id, label: 'latest' });
    await expect(
      repository.getLatestLocation({
        agentId,
        source,
        notBefore: new Date('2026-09-12T11:59:30Z'),
        notAfter: new Date('2026-09-12T12:00:00Z'),
      }),
    ).resolves.toBeNull();
  });

  it('keeps direct fixture commitments and missing source provenance out of owner context', async () => {
    const ordinaryId = randomUUID();
    const fixtureId = randomUUID();
    const malformedMetadataId = randomUUID();
    const normalMessageId = randomUUID();
    const taggedMessageId = randomUUID();
    const readabilityMessageId = randomUUID();
    const deletedMessageId = randomUUID();
    const sourceOccurrence = (conversationId: string, messageId: string) =>
      `v1:${agentId}:${conversationId}:promise:${messageId}`;
    const [ordinaryConversation, fixtureConversation] = await db
      .insert(conversations)
      .values([
        {
          id: ordinaryId,
          agentId,
          title: 'xtest ordinary context',
          channel: 'chat',
          trust: 'owner',
        },
        {
          id: fixtureId,
          agentId,
          title: 'xtest direct visual fixture',
          channel: 'chat',
          trust: 'owner',
          metadata: { visualQaRunId: randomUUID() },
        },
        {
          id: malformedMetadataId,
          agentId,
          title: 'xtest malformed owner context metadata',
          channel: 'chat',
          trust: 'owner',
          metadata: 'malformed' as unknown as Record<string, unknown>,
        },
      ])
      .returning({ id: conversations.id });
    if (!ordinaryConversation || !fixtureConversation)
      throw new Error('Failed to seed conversations');
    conversationIds.push(ordinaryId, fixtureId, malformedMetadataId);
    const sourceRows = [
      {
        id: normalMessageId,
        conversationId: ordinaryId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'Ordinary owner evidence',
      },
      {
        id: taggedMessageId,
        conversationId: ordinaryId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'Synthetic fixture evidence',
        channelMessageId: `visual-qa:${randomUUID()}:commitment`,
      },
      {
        id: readabilityMessageId,
        conversationId: ordinaryId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'Readability fixture evidence',
        channelMessageId: `readability-run-${randomUUID()}-01-user`,
      },
      {
        id: deletedMessageId,
        conversationId: ordinaryId,
        role: 'user',
        origin: 'owner',
        parts: [],
        text: 'Evidence removed before recall',
      },
    ];
    messageIds.push(normalMessageId, taggedMessageId, readabilityMessageId, deletedMessageId);
    await db.insert(messages).values(sourceRows);
    const manualReopenOperationId = randomUUID();
    const sourceFreeId = randomUUID();
    const emptyOccurrenceId = randomUUID();
    const manualReopenId = randomUUID();
    const ordinarySourcedId = randomUUID();
    const rows = [
      {
        id: sourceFreeId,
        agentId,
        conversationId: ordinaryId,
        sourceMessageId: null,
        sourceOccurrenceKey: null,
        kind: 'promise',
        title: `xtest legitimate source-free ${randomUUID()}`,
        contentHash: randomUUID(),
      },
      {
        id: emptyOccurrenceId,
        agentId,
        conversationId: ordinaryId,
        sourceMessageId: null,
        sourceOccurrenceKey: '',
        kind: 'promise',
        title: `xtest malformed empty occurrence ${randomUUID()}`,
        contentHash: randomUUID(),
      },
      {
        id: manualReopenId,
        agentId,
        conversationId: ordinaryId,
        sourceMessageId: null,
        sourceOccurrenceKey: `manual-reopen:v1:${agentId}:${manualReopenOperationId}`,
        reopenedFromId: randomUUID(),
        reopenOperationId: manualReopenOperationId,
        kind: 'promise',
        title: `xtest owner-reopened source-free loop ${randomUUID()}`,
        contentHash: randomUUID(),
      },
      {
        id: ordinarySourcedId,
        agentId,
        conversationId: ordinaryId,
        sourceMessageId: normalMessageId,
        sourceOccurrenceKey: sourceOccurrence(ordinaryId, normalMessageId),
        kind: 'promise',
        title: `xtest ordinary sourced ${randomUUID()}`,
        contentHash: randomUUID(),
      },
      {
        id: randomUUID(),
        agentId,
        conversationId: ordinaryId,
        sourceMessageId: taggedMessageId,
        sourceOccurrenceKey: sourceOccurrence(ordinaryId, taggedMessageId),
        kind: 'promise',
        title: `xtest tagged source ${randomUUID()}`,
        contentHash: randomUUID(),
      },
      {
        id: randomUUID(),
        agentId,
        conversationId: ordinaryId,
        sourceMessageId: readabilityMessageId,
        sourceOccurrenceKey: sourceOccurrence(ordinaryId, readabilityMessageId),
        kind: 'promise',
        title: `xtest readability source ${randomUUID()}`,
        contentHash: randomUUID(),
      },
      {
        id: randomUUID(),
        agentId,
        conversationId: ordinaryId,
        sourceMessageId: deletedMessageId,
        sourceOccurrenceKey: sourceOccurrence(ordinaryId, deletedMessageId),
        kind: 'promise',
        title: `xtest vanished source ${randomUUID()}`,
        contentHash: randomUUID(),
      },
      {
        id: randomUUID(),
        agentId,
        conversationId: malformedMetadataId,
        sourceMessageId: null,
        sourceOccurrenceKey: null,
        kind: 'promise',
        title: `xtest malformed metadata row ${randomUUID()}`,
        contentHash: randomUUID(),
      },
      {
        id: randomUUID(),
        agentId,
        conversationId: fixtureId,
        sourceMessageId: null,
        sourceOccurrenceKey: null,
        kind: 'promise',
        title: `xtest direct fixture row ${randomUUID()}`,
        contentHash: randomUUID(),
      },
    ];
    commitmentIds.push(...rows.map((row) => row.id));
    await db.insert(commitments).values(rows);
    // The schema nulls the FK on delete while keeping the extraction occurrence
    // key; owner context must fail closed instead of treating this as source-free.
    await db.delete(messages).where(eq(messages.id, deletedMessageId));

    const found = await createPostgresOwnerContextRepository(db).listOpenCommitments({
      agentId,
      now: new Date(),
      limit: 10,
    });
    expect(found.map((row) => row.id).sort()).toEqual(
      [sourceFreeId, manualReopenId, ordinarySourcedId].sort(),
    );
  });

  it('retains the public sixty-row owner-context bound', async () => {
    const repository = createPostgresOwnerContextRepository(db);
    await expect(
      repository.listOpenCommitments({ agentId, now: new Date(), limit: 61 }),
    ).rejects.toThrow('between 1 and 60');
  });

  it('filters commitment statuses and elapsed snoozes before updated ordering', async () => {
    const repository = createPostgresOwnerContextRepository(db);
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, title: 'xtest-owner-context', channel: 'chat', trust: 'owner' })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('Failed to seed owner-context conversation');
    conversationIds.push(conversation.id);
    const make = (input: { status: string; updatedAt: Date; snoozedUntil?: Date }) => ({
      id: randomUUID(),
      agentId,
      conversationId: conversation.id,
      kind: 'promise',
      title: `xtest-${randomUUID()}`,
      status: input.status,
      snoozedUntil: input.snoozedUntil,
      confidence: '0.90',
      contentHash: randomUUID(),
      updatedAt: input.updatedAt,
    });
    const rows = [
      make({ status: 'open', updatedAt: new Date('2099-01-03T00:00:00Z') }),
      make({
        status: 'snoozed',
        snoozedUntil: new Date('2099-01-01T00:00:00Z'),
        updatedAt: new Date('2099-01-02T00:00:00Z'),
      }),
      make({
        status: 'snoozed',
        snoozedUntil: new Date('2101-01-01T00:00:00Z'),
        updatedAt: new Date('2099-01-04T00:00:00Z'),
      }),
      make({ status: 'resolved', updatedAt: new Date('2099-01-05T00:00:00Z') }),
    ];
    commitmentIds.push(...rows.map((row) => row.id));
    await db.insert(commitments).values(rows);
    const found = await repository.listOpenCommitments({
      agentId,
      now: new Date('2100-01-01T00:00:00Z'),
      limit: 2,
    });
    expect(found.map((row) => row.id)).toEqual([rows[0]?.id, rows[1]?.id]);
  });
});
