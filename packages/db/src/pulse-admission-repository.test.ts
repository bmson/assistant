import { randomUUID } from 'node:crypto';
import type { PulseNoticeInput } from '@assistant/persistence';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresPulseAdmissionRepository } from './pulse-admission-repository.js';
import {
  agents,
  conversations,
  maintenanceCursors,
  messages,
  notificationPrefs,
  proactiveMoments,
  suggestions,
  tasks,
} from './schema.js';

const now = new Date('2026-10-03T12:00:00Z');
describe('PostgreSQL atomic pulse admission', () => {
  let db: Db;
  let agentId: string;
  let foreignAgentId: string | undefined;
  beforeEach(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    db = createDb(url);
    agentId = randomUUID();
    foreignAgentId = undefined;
    await db.insert(agents).values({
      id: agentId,
      name: 'Pulse test owner',
      email: `${agentId}@example.test`,
      workspacePrefix: `test/${agentId}`,
    });
  });
  afterEach(async () => {
    const owners = foreignAgentId ? [agentId, foreignAgentId] : [agentId];
    const chats = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.agentId, owners));
    if (chats.length)
      await db.delete(messages).where(
        inArray(
          messages.conversationId,
          chats.map((chat) => chat.id),
        ),
      );
    await db.delete(suggestions).where(inArray(suggestions.agentId, owners));
    await db.delete(tasks).where(inArray(tasks.agentId, owners));
    await db.delete(proactiveMoments).where(inArray(proactiveMoments.agentId, owners));
    await db.delete(notificationPrefs).where(inArray(notificationPrefs.agentId, owners));
    await db.delete(conversations).where(inArray(conversations.agentId, owners));
    await db
      .delete(maintenanceCursors)
      .where(
        inArray(maintenanceCursors.name, [
          `privacy-erasure-generation:${agentId}`,
          `privacy-erasure-result:${agentId}`,
        ]),
      );
    await db.delete(agents).where(inArray(agents.id, owners));
    await db.$client.end();
  });
  const input = (key: string): PulseNoticeInput => ({
    agentId,
    now,
    observationFence: null,
    pacing: {
      gapSince: new Date(now.getTime() - 3600_000),
      windowSince: new Date(now.getTime() - 24 * 3600_000),
      dailyCap: 6,
    },
    moment: { key, kind: 'mail-action', summary: 'A useful observation' },
    notice: {
      text: 'A useful observation',
      extraParts: [{ type: 'data-card', data: { kind: 'proactive-alert', id: key } }],
    },
    suggestion: {
      summary: 'Review this',
      proposedAction: 'Review the stored source. Do not send anything.',
      sourceRef: key,
      origin: 'pulse',
      expiresAt: new Date(now.getTime() + 7 * 24 * 3600_000),
    },
  });
  async function rows() {
    const chats = await db.select().from(conversations).where(eq(conversations.agentId, agentId));
    return {
      chats,
      moments: await db
        .select()
        .from(proactiveMoments)
        .where(eq(proactiveMoments.agentId, agentId)),
      suggestions: await db.select().from(suggestions).where(eq(suggestions.agentId, agentId)),
      messages: chats.length
        ? await db
            .select()
            .from(messages)
            .where(
              inArray(
                messages.conversationId,
                chats.map((chat) => chat.id),
              ),
            )
        : [],
    };
  }
  it('converges same-key races and a retry after commit on one linked notice and proposal', async () => {
    const store = createPostgresPulseAdmissionRepository(db);
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => store.admitNotice(input('same-key'))),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'persisted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'already-said')).toHaveLength(5);
    expect(await store.admitNotice(input('same-key'))).toEqual({ status: 'already-said' });
    const stored = await rows();
    expect(stored.chats).toHaveLength(1);
    expect(stored.messages).toHaveLength(1);
    expect(stored.moments).toHaveLength(1);
    expect(stored.suggestions).toHaveLength(1);
    expect(stored.suggestions[0]?.conversationId).toBe(stored.chats[0]?.id);
    expect(stored.messages[0]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'suggestion', suggestionId: stored.suggestions[0]?.id }),
      ]),
    );
  });
  it('serializes different candidates before either can bypass the hourly gap', async () => {
    const store = createPostgresPulseAdmissionRepository(db);
    const outcomes = await Promise.all(['a', 'b', 'c'].map((key) => store.admitNotice(input(key))));
    expect(outcomes.filter((outcome) => outcome.status === 'persisted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'min-gap')).toHaveLength(2);
    expect((await rows()).messages).toHaveLength(1);
  });
  it('admits only one final daily slot even when candidates pass the gap', async () => {
    await db.insert(proactiveMoments).values({
      agentId,
      kind: 'mail-action',
      momentKey: 'earlier',
      deliveredAt: new Date(now.getTime() - 2 * 3600_000),
    });
    const store = createPostgresPulseAdmissionRepository(db);
    const options = (key: string) => ({
      ...input(key),
      pacing: { ...input(key).pacing, gapSince: now, dailyCap: 2 },
    });
    const outcomes = await Promise.all([
      store.admitNotice(options('a')),
      store.admitNotice(options('b')),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['daily-cap', 'persisted']);
    expect((await rows()).moments).toHaveLength(2);
  });
  it('rechecks tightened preferences inside admission, before writing anything', async () => {
    const store = createPostgresPulseAdmissionRepository(db);
    const observed = input('pref-change');
    expect(await store.observationFence(agentId)).toBeNull();
    await db.insert(proactiveMoments).values({
      agentId,
      kind: 'mail-action',
      momentKey: 'prior-pref',
      deliveredAt: new Date(now.getTime() - 2 * 3600_000),
    });
    await db.insert(notificationPrefs).values({ agentId, ambientDailyCap: 1 });
    expect(await store.admitNotice(observed)).toEqual({ status: 'daily-cap' });
    const stored = await rows();
    expect(stored.messages).toEqual([]);
    expect(stored.moments).toHaveLength(1);
    expect(stored.suggestions).toEqual([]);
  });
  it('rolls back the destination and proposal when message encoding fails, then recovers', async () => {
    const store = createPostgresPulseAdmissionRepository(db);
    let serializations = 0;
    const part = {
      toJSON() {
        if (++serializations > 1) throw new Error('message encoding failed');
        return { type: 'text', text: 'synthetic' };
      },
    };
    await expect(
      store.admitNotice({
        ...input('failed-write'),
        notice: { text: 'synthetic', extraParts: [part] },
      }),
    ).rejects.toThrow('message encoding failed');
    expect(await rows()).toEqual({ chats: [], moments: [], suggestions: [], messages: [] });
    expect((await store.admitNotice(input('failed-write'))).status).toBe('persisted');
  });
  it('does not fabricate a message for an imported legacy claim with unknown delivery history', async () => {
    await db.insert(proactiveMoments).values({
      id: randomUUID(),
      agentId,
      kind: 'mail-action',
      momentKey: 'imported',
      deliveredAt: new Date(now.getTime() - 4 * 3600_000),
    });
    const store = createPostgresPulseAdmissionRepository(db);
    expect(await store.admitNotice(input('imported'))).toEqual({ status: 'already-said' });
    expect((await rows()).messages).toEqual([]);
  });
  it('preserves a dismissed proposal instead of reviving its interactive card', async () => {
    await db.insert(suggestions).values({
      agentId,
      summary: 'Old proposal',
      proposedAction: 'Old action',
      sourceRef: 'dismissed',
      status: 'dismissed',
      expiresAt: new Date(now.getTime() + 3600_000),
    });
    const result = await createPostgresPulseAdmissionRepository(db).admitNotice(input('dismissed'));
    expect(result).toMatchObject({ status: 'persisted', suggestionCreated: false });
    const stored = await rows();
    expect(stored.suggestions).toHaveLength(1);
    expect(stored.suggestions[0]?.status).toBe('dismissed');
    expect(stored.messages[0]?.parts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'suggestion' })]),
    );
  });
  it('rejects source content captured before a completed erase and blocks active erasure', async () => {
    const store = createPostgresPulseAdmissionRepository(db);
    const before = await store.observationFence(agentId);
    await db
      .insert(maintenanceCursors)
      .values({ name: `privacy-erasure-generation:${agentId}`, cursor: randomUUID() });
    await expect(
      store.admitNotice({ ...input('stale'), observationFence: before }),
    ).rejects.toThrow('Privacy erasure changed');
    expect((await rows()).moments).toEqual([]);
    await db
      .insert(maintenanceCursors)
      .values({ name: `privacy-erasure-result:${agentId}`, cursor: '{}' });
    await expect(store.observationFence(agentId)).rejects.toThrow('in progress');
    await expect(store.admitNotice(input('active'))).rejects.toThrow('in progress');
  });
  it('rejects a foreign task and posts valid work into the existing primary conversation', async () => {
    foreignAgentId = randomUUID();
    await db.insert(agents).values({
      id: foreignAgentId,
      name: 'Other test owner',
      email: `${foreignAgentId}@example.test`,
      workspacePrefix: `test/${foreignAgentId}`,
    });
    const [foreignTask] = await db
      .insert(tasks)
      .values({ agentId: foreignAgentId, type: 'adhoc', status: 'pending', trust: 'owner' })
      .returning();
    if (!foreignTask) throw new Error('fixture task missing');
    const store = createPostgresPulseAdmissionRepository(db);
    await expect(
      store.admitNotice({ ...input('foreign'), taskId: foreignTask.id }),
    ).rejects.toThrow('another owner');
    const [primary] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', isPrimary: true })
      .returning();
    if (!primary) throw new Error('fixture primary missing');
    expect(await store.admitNotice(input('valid'))).toMatchObject({
      status: 'persisted',
      conversationId: primary.id,
    });
    expect((await rows()).chats).toHaveLength(1);
    expect(
      await db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, primary.id), eq(messages.role, 'assistant'))),
    ).toHaveLength(1);
  });
});
