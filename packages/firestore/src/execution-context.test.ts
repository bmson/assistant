import { Timestamp } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreExecutionContextRepository } from './execution-context.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore execution context repository',
  () => {
    let store: InstallationStore;
    let repository: FirestoreExecutionContextRepository;
    let appendOrder = 0;

    beforeEach(() => {
      appendOrder = 0;
      store = emulatorStore(() => new Date('2026-09-12T12:00:00Z'));
      repository = new FirestoreExecutionContextRepository(store);
    });

    afterEach(async () => disposeStore(store));

    async function addConversation(id: string, agentId: string, channel: 'chat' | 'email') {
      await store.doc('conversations', id).set({ id, agentId, channel });
    }
    it('rejects a normalized impossible checkpoint date before querying replies', async () => {
      await addConversation('invalid-date-chat', 'agent-a', 'chat');
      await expect(
        repository.getOwnerRepliesAfter({
          agentId: 'agent-a',
          conversationId: 'invalid-date-chat',
          after: {
            createdAt: new Date('2026-03-01T00:00:00Z'),
            exactCreatedAt: '2026-02-30T00:00:00.123456Z',
          },
        }),
      ).rejects.toThrow('Invalid conversation watermark');
    });

    function message(input: {
      id: string;
      conversationId: string;
      at: Date;
      text: string;
      role?: string;
      origin?: string;
      channelMessageId?: string | null;
      taskId?: string | null;
    }) {
      return {
        id: input.id,
        conversationId: input.conversationId,
        role: input.role ?? 'user',
        text: input.text,
        parts: [],
        taskId: input.taskId ?? null,
        origin: input.origin ?? (input.role === 'assistant' ? 'assistant' : 'owner'),
        channelMessageId: input.channelMessageId ?? null,
        embedding: null,
        createdAt: input.at,
        appendedAt: Timestamp.fromMillis(1_790_000_000_000 + appendOrder++),
        hiddenAt: null,
      };
    }

    async function writeMessages(rows: ReturnType<typeof message>[]) {
      const batch = store.db.batch();
      for (const row of rows) batch.set(store.doc('messages', row.id), row);
      await batch.commit();
    }

    it('keeps startup and event-message reads within the explicit agent scope', async () => {
      await store.doc('agents', 'agent-a').set({ id: 'agent-a', name: 'A' });
      await store.doc('agents', 'agent-b').set({ id: 'agent-b', name: 'B' });
      await addConversation('email-a', 'agent-a', 'email');
      await addConversation('email-b', 'agent-b', 'email');
      await store.doc('tasks', 'task-a').set({ id: 'task-a', agentId: 'agent-a' });
      await store
        .doc('goals', 'goal-a')
        .set({ id: 'goal-a', agentId: 'agent-a', status: 'active', archivedAt: null });
      await writeMessages([
        message({
          id: 'inbound-a',
          conversationId: 'email-a',
          at: new Date('2026-09-12T11:00:00Z'),
          text: 'event a',
          channelMessageId: 'gmail:event-1',
        }),
        message({
          id: 'inbound-b',
          conversationId: 'email-b',
          at: new Date('2026-09-12T11:00:00Z'),
          text: 'event b',
          channelMessageId: 'gmail:event-1',
        }),
      ]);

      await expect(repository.getAgent('agent-a')).resolves.toMatchObject({ id: 'agent-a' });
      await expect(repository.getTask('agent-b', 'task-a')).resolves.toBeNull();
      await expect(repository.getGoalStopState('agent-b', 'goal-a')).resolves.toBeNull();
      await expect(
        repository.getInboundMessage({
          agentId: 'agent-a',
          conversationId: 'email-a',
          channelMessageId: 'gmail:event-1',
        }),
      ).resolves.toEqual({ text: 'event a' });
      await expect(
        repository.getInboundMessage({
          agentId: 'agent-b',
          conversationId: 'email-a',
          channelMessageId: 'gmail:event-1',
        }),
      ).resolves.toBeNull();
    });

    it('loads exact and latest owner messages by authenticated chat scope, excluding non-owner rows', async () => {
      await addConversation('owner-read-chat', 'agent-a', 'chat');
      await addConversation('owner-read-other', 'agent-a', 'chat');
      const at = new Date('2026-09-12T10:00:00Z');
      const taskId = 'owner-read-task';
      const pinned = message({
        id: 'owner-read-original',
        conversationId: 'owner-read-chat',
        at: new Date(at.getTime() + 60_000),
        text: 'Find my flight tomorrow',
        taskId,
      });
      const assistant = message({
        id: 'owner-read-assistant',
        conversationId: 'owner-read-chat',
        at: new Date(at.getTime() - 60_000),
        text: 'assistant response',
        role: 'assistant',
      });
      const latestOwner = message({
        id: 'owner-read-correction',
        conversationId: 'owner-read-chat',
        at: new Date(at.getTime() - 120_000),
        text: 'Actually find my flight today instead',
        taskId,
      });
      const knownContact = message({
        id: 'owner-read-contact',
        conversationId: 'owner-read-chat',
        at: new Date(at.getTime() + 3_000),
        text: 'known contact',
        origin: 'known_contact',
      });
      await writeMessages([pinned, assistant, latestOwner, knownContact]);

      await expect(
        repository.getOwnerMessage({
          agentId: 'agent-a',
          conversationId: 'owner-read-chat',
          messageId: 'owner-read-original',
        }),
      ).resolves.toMatchObject({
        id: 'owner-read-original',
        taskId,
        role: 'user',
        origin: 'owner',
        text: 'Find my flight tomorrow',
      });
      await expect(
        repository.getOwnerMessage({
          agentId: 'agent-b',
          conversationId: 'owner-read-chat',
          messageId: 'owner-read-original',
        }),
      ).resolves.toBeNull();
      await expect(
        repository.getOwnerMessage({
          agentId: 'agent-a',
          conversationId: 'owner-read-other',
          messageId: 'owner-read-original',
        }),
      ).resolves.toBeNull();
      await expect(
        repository.getOwnerMessage({
          agentId: 'agent-a',
          conversationId: 'owner-read-chat',
          messageId: 'owner-read-contact',
        }),
      ).resolves.toBeNull();
      await expect(
        repository.getLatestOwnerMessage({ agentId: 'agent-a', conversationId: 'owner-read-chat' }),
      ).resolves.toMatchObject({ id: 'owner-read-correction' });
      await expect(
        repository.getLatestOwnerMessage({ agentId: 'agent-b', conversationId: 'owner-read-chat' }),
      ).resolves.toBeNull();
    });

    it('uses append order, then the canonical ID tie-break, for the visible owner head', async () => {
      await addConversation('head-chat', 'agent-a', 'chat');
      const base = Timestamp.fromDate(new Date('2026-09-12T10:00:00Z'));
      const at = (millis: number) => Timestamp.fromMillis(base.toMillis() + millis);
      const rows = [
        {
          ...message({
            id: 'owner-backdated',
            conversationId: 'head-chat',
            at: new Date('2010-01-01T00:00:00Z'),
            text: 'original request',
          }),
          hiddenAt: null,
          appendedAt: at(1),
        },
        {
          ...message({
            id: 'owner-newer-created',
            conversationId: 'head-chat',
            at: new Date('2035-01-01T00:00:00Z'),
            text: 'late createdAt',
          }),
          hiddenAt: null,
          appendedAt: at(2),
        },
        {
          ...message({
            id: 'owner-tie-a',
            conversationId: 'head-chat',
            at: new Date('2000-01-01T00:00:00Z'),
            text: 'same append time, lower ID',
          }),
          hiddenAt: null,
          appendedAt: at(3),
        },
        {
          ...message({
            id: 'owner-tie-z',
            conversationId: 'head-chat',
            at: new Date('1990-01-01T00:00:00Z'),
            text: 'same append time, higher ID',
          }),
          hiddenAt: null,
          appendedAt: at(3),
        },
      ];
      for (const row of rows) await store.doc('messages', row.id).set(row);

      await expect(
        repository.getLatestOwnerMessage({ agentId: 'agent-a', conversationId: 'head-chat' }),
      ).resolves.toMatchObject({ id: 'owner-tie-z', text: 'same append time, higher ID' });
    });

    it('returns the latest 20 eligible messages before the cutoff from an owned email thread', async () => {
      await addConversation('email-a', 'agent-a', 'email');
      const rows = Array.from({ length: 25 }, (_, index) =>
        message({
          id: `history-${String(index).padStart(2, '0')}`,
          conversationId: 'email-a',
          at: new Date(Date.UTC(2026, 8, 12, 10, index)),
          text: `history-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
        }),
      );
      rows.push(
        message({
          id: 'system-row',
          conversationId: 'email-a',
          at: new Date('2026-09-12T10:25:00Z'),
          text: 'system-row',
          role: 'system',
        }),
        message({
          id: 'after-cutoff',
          conversationId: 'email-a',
          at: new Date('2026-09-12T12:00:00Z'),
          text: 'after-cutoff',
        }),
      );
      await writeMessages(rows);

      const history = await repository.seedHistory({
        agentId: 'agent-a',
        conversationId: 'email-a',
        before: new Date('2026-09-12T11:00:00Z'),
      });
      expect(history).toHaveLength(20);
      expect(history.map((row) => row.text)).toEqual(
        Array.from({ length: 20 }, (_, index) => `history-${index + 5}`),
      );
      const wider = {
        agentId: 'agent-a',
        conversationId: 'email-a',
        before: new Date('2026-09-12T11:00:00Z'),
        limit: 100,
      };
      expect(await repository.seedHistory(wider)).toHaveLength(25);
      await expect(repository.seedHistory({ ...wider, limit: 101 })).rejects.toThrow(
        'between 1 and 100',
      );
      await expect(
        repository.seedHistory({
          agentId: 'agent-b',
          conversationId: 'email-a',
          before: new Date('2026-09-12T11:00:00Z'),
        }),
      ).resolves.toEqual([]);
    });

    it('round-trips stored sub-millisecond cursors without replay after a row is removed', async () => {
      await addConversation('nano-chat', 'agent-a', 'chat');
      const seconds = Date.parse('2026-09-12T10:00:00Z') / 1000;
      for (const [index, nanos] of [123456000, 123789000].entries()) {
        await store.doc('messages', `nano-${index}`).set({
          ...message({
            id: `nano-${index}`,
            conversationId: 'nano-chat',
            at: new Date(seconds * 1000),
            text: `nano-${index}`,
          }),
          createdAt: new Timestamp(seconds, nanos),
        });
      }
      const baseline = await repository.getLatestOwnerReplyCursor({
        agentId: 'agent-a',
        conversationId: 'nano-chat',
      });
      expect(baseline?.cursor?.exactCreatedAt).toBe('2026-09-12T10:00:00.123789000Z');
      const rows = await repository.getOwnerRepliesAfter({
        agentId: 'agent-a',
        conversationId: 'nano-chat',
        after: { createdAt: new Date(seconds * 1000) },
      });
      expect(rows.map((r) => r.exactCreatedAt)).toEqual([
        '2026-09-12T10:00:00.123456000Z',
        '2026-09-12T10:00:00.123789000Z',
      ]);
      const last = rows.at(-1);
      if (!last) throw new Error('missing row');
      await store.doc('messages', last.id).delete();
      const cursor = JSON.parse(
        JSON.stringify({ exactCreatedAt: last.exactCreatedAt, id: last.id }),
      );
      expect(
        await repository.getOwnerRepliesAfter({
          agentId: 'agent-a',
          conversationId: 'nano-chat',
          after: { ...cursor, createdAt: last.createdAt },
        }),
      ).toEqual([]);
    });

    it('baselines the latest stable cursor and reads timestamp ties exactly once', async () => {
      await addConversation('chat-a', 'agent-a', 'chat');
      const at = new Date('2026-09-12T10:00:00Z');
      await writeMessages([
        message({ id: 'tie-1', conversationId: 'chat-a', at, text: 'one' }),
        message({ id: 'tie-2', conversationId: 'chat-a', at, text: 'two' }),
        message({ id: 'tie-3', conversationId: 'chat-a', at, text: 'three' }),
        message({
          id: 'tie-4',
          conversationId: 'chat-a',
          at,
          text: 'known contact in chat',
          origin: 'known_contact',
        }),
      ]);

      await expect(
        repository.getLatestOwnerReplyCursor({ agentId: 'agent-a', conversationId: 'chat-a' }),
      ).resolves.toEqual({
        cursor: {
          createdAt: at,
          exactCreatedAt: at.toISOString().replace(/(\.\d{3})Z$/, '$1000000Z'),
          id: 'tie-4',
        },
      });
      const newer = await repository.getOwnerRepliesAfter({
        agentId: 'agent-a',
        conversationId: 'chat-a',
        after: { createdAt: at, id: 'tie-1' },
      });
      expect(newer.map((row) => row.id)).toEqual(['tie-2', 'tie-3']);
      const last = newer.at(-1);
      if (!last) throw new Error('Expected tied owner replies');
      await expect(
        repository.getOwnerRepliesAfter({
          agentId: 'agent-a',
          conversationId: 'chat-a',
          after: { createdAt: last.createdAt, id: last.id },
        }),
      ).resolves.toEqual([]);
    });

    it('bounds only replies after the cursor and rejects overflow instead of dropping it', async () => {
      await addConversation('chat-a', 'agent-a', 'chat');
      const cursorAt = new Date('2026-09-12T10:00:00Z');
      const oldRows = Array.from({ length: 250 }, (_, index) =>
        message({
          id: `old-${String(index).padStart(3, '0')}`,
          conversationId: 'chat-a',
          at: new Date(cursorAt.getTime() - 250_000 + index * 1000),
          text: `old-${index}`,
        }),
      );
      const firstNewRows = Array.from({ length: 2 }, (_, index) =>
        message({
          id: `new-${String(index).padStart(3, '0')}`,
          conversationId: 'chat-a',
          at: new Date(cursorAt.getTime() + (index + 1) * 1000),
          text: `new-${index}`,
        }),
      );
      await writeMessages([...oldRows, ...firstNewRows]);
      await expect(
        repository.getOwnerRepliesAfter({
          agentId: 'agent-a',
          conversationId: 'chat-a',
          after: { createdAt: cursorAt },
        }),
      ).resolves.toHaveLength(2);

      await writeMessages(
        Array.from({ length: 199 }, (_, offset) => {
          const index = offset + 2;
          return message({
            id: `new-${String(index).padStart(3, '0')}`,
            conversationId: 'chat-a',
            at: new Date(cursorAt.getTime() + (index + 1) * 1000),
            text: `new-${index}`,
          });
        }),
      );
      await expect(
        repository.getOwnerRepliesAfter({
          agentId: 'agent-a',
          conversationId: 'chat-a',
          after: { createdAt: cursorAt },
        }),
      ).rejects.toThrow('Owner reply window exceeded 200 messages');
    });

    it('refuses email and foreign folding and scopes task-owned notice classification', async () => {
      await addConversation('chat-a', 'agent-a', 'chat');
      await addConversation('email-a', 'agent-a', 'email');
      await store
        .doc('tasks', 'scheduled-a')
        .set({ id: 'scheduled-a', agentId: 'agent-a', type: 'scheduled' });
      await store
        .doc('tasks', 'scheduled-b')
        .set({ id: 'scheduled-b', agentId: 'agent-b', type: 'scheduled' });
      await expect(
        repository.getLatestOwnerReplyCursor({ agentId: 'agent-a', conversationId: 'email-a' }),
      ).resolves.toBeNull();
      await expect(
        repository.getOwnerRepliesAfter({
          agentId: 'agent-a',
          conversationId: 'email-a',
          after: { createdAt: new Date(0) },
        }),
      ).resolves.toEqual([]);
      await expect(
        repository.getOwnerRepliesAfter({
          agentId: 'agent-b',
          conversationId: 'chat-a',
          after: { createdAt: new Date(0) },
        }),
      ).resolves.toEqual([]);

      const rows = [
        { id: 'structured', role: 'assistant', taskId: null, parts: [{ type: 'notice' }] },
        {
          id: 'proactive',
          role: 'assistant',
          taskId: null,
          parts: [{ type: 'data-card', data: { kind: 'proactive-alert' } }],
        },
        { id: 'unknown', role: 'assistant', taskId: null, parts: [{ type: 42 }, null] },
        { id: 'own-task', role: 'assistant', taskId: 'scheduled-a', parts: [] },
        { id: 'foreign-task', role: 'assistant', taskId: 'scheduled-b', parts: [] },
      ];
      await expect(repository.noticeIds('agent-a', rows)).resolves.toEqual(
        new Set(['structured', 'proactive', 'own-task']),
      );
    });
  },
);
