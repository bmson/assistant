import { randomUUID } from 'node:crypto';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import {
  agents,
  conversations,
  emailIngest,
  emailObserverWork,
  maintenanceCursors,
  messages,
  writingSamples,
} from './schema.js';
import { createPostgresVoiceContextRepository } from './voice-context-repository.js';

const space = { provider: 'synthetic', model: 'voice-fence', dimensions: 1536, revision: '1' };
const text = `Owner writing sample ${randomUUID()} ${'你好世界 prose. '.repeat(150)}`.trim();
const embedding = Array(1536).fill(0.1);
function values(agentId: string, conversationId: string) {
  const channelMessageId = `gmail:${randomUUID()}`,
    messageId = randomUUID();
  const input = {
    register: 'email_casual',
    text,
    context: 'auto:inbound-email',
    embedding,
    embeddingSpaceKey: embeddingSpaceIdentityKey(space),
  };
  const work = {
    id: randomUUID(),
    agentId,
    sourceKey: channelMessageId,
    channelMessageId,
    sourceKind: 'message',
    observerKey: 'google.owner-voice-sample',
    observerVersion: 1,
    workClass: 'paid_ambiguous',
    status: 'prepared',
    attemptCount: 1,
    claimToken: randomUUID(),
    claimGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    privacyGeneration: null,
    preparedResult: {
      register: 'email_casual',
      context: 'inbound-email',
      observedGeneration: null,
      embeddingSpaceKey: input.embeddingSpaceKey,
      embedding,
    },
  };
  const ingest = {
    id: randomUUID(),
    agentId,
    channelMessageId,
    conversationId,
    fromEmail: 'owner@example.test',
    subject: 'Synthetic voice',
    contentTrust: 'owner',
    authenticated: true,
    ingestMode: 'direct',
    hasExternalOrUnknown: false,
    admittedSourceKind: 'message',
    admittedSourceId: messageId,
  };
  const message = {
    id: messageId,
    conversationId,
    channelMessageId,
    role: 'user',
    text: `From: owner@example.test\nSubject: Synthetic voice\n\n${text}`,
    parts: [{ type: 'text', text }],
    origin: 'owner',
    hiddenAt: null,
  };
  const fence = {
    id: work.id,
    agentId,
    claimToken: work.claimToken,
    claimGeneration: 1,
    expectedPrivacyGeneration: null,
  };
  return { input, work, ingest, message, fence };
}

describe('PostgreSQL atomic email voice effect', () => {
  let db: Db;
  let f: ReturnType<typeof values>;
  let voice: ReturnType<typeof createPostgresVoiceContextRepository>;
  let agentId: string;
  let conversationId: string;
  let savedPrivacyCursors: Array<typeof maintenanceCursors.$inferSelect>;
  beforeEach(async () => {
    if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))
      throw new Error('requires allocator test DB');
    db = createDb(process.env.DATABASE_URL);
    const owners = await db.select({ id: agents.id }).from(agents).limit(2);
    const [owner] = owners;
    if (!owner || owners.length !== 1) throw new Error('requires isolated seeded single owner');
    agentId = owner.id;
    const privacyCursorNames = [
      `privacy-erasure-result:${agentId}`,
      `privacy-erasure-generation:${agentId}`,
      `privacy-erasure-active:${agentId}`,
    ];
    savedPrivacyCursors = await db
      .select()
      .from(maintenanceCursors)
      .where(inArray(maintenanceCursors.name, privacyCursorNames));
    await db.delete(maintenanceCursors).where(inArray(maintenanceCursors.name, privacyCursorNames));
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('conversation missing');
    conversationId = conversation.id;
    f = values(agentId, conversationId);
    voice = createPostgresVoiceContextRepository(db);
    await db.insert(messages).values(f.message);
    await db.insert(emailIngest).values(f.ingest);
    await db.insert(emailObserverWork).values(f.work);
  });
  afterEach(async () => {
    await db
      .delete(writingSamples)
      .where(
        and(
          eq(writingSamples.text, text),
          eq(writingSamples.embeddingSpaceKey, f.input.embeddingSpaceKey),
        ),
      );
    const privacyCursorNames = [
      `privacy-erasure-result:${agentId}`,
      `privacy-erasure-generation:${agentId}`,
      `privacy-erasure-active:${agentId}`,
    ];
    await db.delete(maintenanceCursors).where(inArray(maintenanceCursors.name, privacyCursorNames));
    if (savedPrivacyCursors.length) await db.insert(maintenanceCursors).values(savedPrivacyCursors);
    await db.delete(emailObserverWork).where(eq(emailObserverWork.id, f.work.id));
    await db.delete(emailIngest).where(eq(emailIngest.id, f.ingest.id));
    await db.delete(messages).where(eq(messages.id, f.message.id));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.$client.end();
  });
  const count = async (db: Db) =>
    (await db.select().from(writingSamples).where(eq(writingSamples.text, text))).length;
  it('accepts initial null privacy generation and atomically deduplicates concurrent replay', async () => {
    await Promise.all([
      voice.addSample(f.input, null, { emailObserverEffectFence: f.fence }),
      voice.addSample(f.input, null, { emailObserverEffectFence: f.fence }),
    ]);
    expect(await count(db)).toBe(1);
  });
  it('rejects stale token without saving a sample', async () => {
    await expect(
      voice.addSample(f.input, null, {
        emailObserverEffectFence: { ...f.fence, claimToken: randomUUID() },
      }),
    ).rejects.toThrow(/claim or source/);
    expect(await count(db)).toBe(0);
  });
  it('rejects changed body or embedding despite matching claim identity', async () => {
    await expect(
      voice.addSample({ ...f.input, text: `${text} injected` }, null, {
        emailObserverEffectFence: f.fence,
      }),
    ).rejects.toThrow(/claim or source/);
    await expect(
      voice.addSample({ ...f.input, embedding: Array(1536).fill(0.2) }, null, {
        emailObserverEffectFence: f.fence,
      }),
    ).rejects.toThrow(/claim or source/);
    expect(await count(db)).toBe(0);
  });
  it('rejects erasure generation advanced after preparation', async () => {
    await db
      .insert(maintenanceCursors)
      .values({ name: `privacy-erasure-generation:${f.fence.agentId}`, cursor: randomUUID() });
    await expect(
      voice.addSample(f.input, null, { emailObserverEffectFence: f.fence }),
    ).rejects.toThrow(/Privacy erasure changed/);
    expect(await count(db)).toBe(0);
  });
  it('refreshes clock after a work-row lock wait before saving', async () => {
    await db
      .update(emailObserverWork)
      .set({ leaseExpiresAt: new Date(Date.now() + 300) })
      .where(eq(emailObserverWork.id, f.work.id));
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (locked = r));
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`select id from email_observer_work where id=${f.work.id} for update`);
      locked();
      await gate;
    });
    await ready;
    const write = voice.addSample(f.input, null, { emailObserverEffectFence: f.fence });
    const rejected = expect(write).rejects.toThrow(/claim or source/);
    await new Promise((r) => setTimeout(r, 400));
    release();
    await blocker;
    await rejected;
    expect(await count(db)).toBe(0);
  });
});
