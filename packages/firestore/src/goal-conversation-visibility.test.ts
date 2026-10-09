import { describe, expect, it } from 'vitest';
import { FirestoreApplicationChatPersistence } from './application-chat.js';
import { conversationDocument, repairConversationProjectionPage } from './conversation-document.js';
import { FirestoreGoalMutationRepository } from './goal-mutations.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('goal chat list projection', () => {
  it('repairs legacy projections in bounded resumable pages without guessing archive state', async () => {
    const store = emulatorStore();
    try {
      await store.doc('agents', 'owner').set({ id: 'owner' });
      await Promise.all([
        store.doc('conversations', 'old-chat').set({
          id: 'old-chat',
          agentId: 'owner',
          channel: 'chat',
          archivedAt: null,
          updatedAt: new Date(),
          createdAt: new Date(),
        }),
        store.doc('conversations', 'old-email').set({
          id: 'old-email',
          agentId: 'owner',
          channel: 'email',
          archivedAt: new Date(),
          archived: false,
        }),
        store
          .doc('conversations', 'unknown-state')
          .set({ id: 'unknown-state', agentId: 'owner', channel: 'chat' }),
        store
          .doc('conversations', 'foreign')
          .set({ id: 'foreign', agentId: 'other', channel: 'chat', archivedAt: null }),
      ]);
      let cursor: string | undefined;
      let repaired = 0,
        scanned = 0,
        skipped = 0;
      do {
        const result = await repairConversationProjectionPage(store, 'owner', {
          afterDocumentId: cursor,
          limit: 1,
        });
        repaired += result.repaired;
        scanned += result.scanned;
        skipped += result.skipped;
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      expect({ repaired, scanned, skipped }).toEqual({ repaired: 2, scanned: 3, skipped: 1 });
      expect((await store.doc('conversations', 'old-chat').get()).get('archived')).toBe(false);
      expect((await store.doc('conversations', 'old-email').get()).get('archived')).toBe(true);
      expect(
        (await store.doc('conversations', 'unknown-state').get()).get('archived'),
      ).toBeUndefined();
      expect((await store.doc('conversations', 'foreign').get()).get('archived')).toBeUndefined();
      expect((await repairConversationProjectionPage(store, 'owner')).repaired).toBe(0);
      await expect(repairConversationProjectionPage(store, 'other')).rejects.toThrow(
        'configured owner',
      );
    } finally {
      await disposeStore(store);
    }
  });
  it('stops and archives a goal with more than 200 terminal historical runs', async () => {
    const store = emulatorStore();
    try {
      await store.doc('agents', 'owner').set({ id: 'owner', timezone: 'UTC' });
      const goals = new FirestoreGoalMutationRepository(store, 'owner');
      const created = await goals.createWithWork(
        {
          title: 'History',
          description: '',
          priority: 3,
          targetDate: null,
          progress: '',
          nextAction: '',
          mirrorToPrimary: false,
        },
        () => ({
          cron: '0 9 * * *',
          instruction: 'Work',
          nextRunAt: () => new Date('2027-01-01T09:00:00Z'),
        }),
      );
      const batch = store.db.batch();
      for (let index = 0; index < 401; index++)
        batch.set(store.doc('tasks', `history-${index}`), {
          id: `history-${index}`,
          agentId: 'owner',
          goalId: created.goalId,
          status: ['done', 'failed', 'cancelled'][index % 3],
        });
      batch.set(store.doc('tasks', 'still-live'), {
        id: 'still-live',
        agentId: 'owner',
        goalId: created.goalId,
        status: 'waiting_approval',
      });
      await batch.commit();
      await expect(goals.archive(created.goalId)).rejects.toThrow('active work');
      await goals.setStatus(created.goalId, 'abandoned');
      expect((await store.doc('tasks', 'still-live').get()).get('status')).toBe('cancelled');
      await goals.archive(created.goalId);
      expect((await store.doc('goals', created.goalId).get()).get('archivedAt')).not.toBeNull();
      expect((await store.doc('tasks', 'history-0').get()).get('status')).toBe('done');
      expect(
        (await store.collection('tasks').where('goalId', '==', created.goalId).get()).size,
      ).toBe(403);
    } finally {
      await disposeStore(store);
    }
  });
  it('lists and counts work chats from owner create, start and tool create paths', async () => {
    const store = emulatorStore();
    const agentId = 'owner';
    try {
      await store.doc('agents', agentId).set({ id: agentId, timezone: 'UTC' });
      const goals = new FirestoreGoalMutationRepository(store, agentId);
      const input = {
        title: 'Example goal',
        description: 'Do work',
        priority: 3,
        targetDate: null,
        progress: '',
        nextAction: '',
        mirrorToPrimary: false,
      };
      const automation = () => ({
        cron: '0 9 * * *',
        instruction: 'Do the next useful step',
        nextRunAt: () => new Date('2027-01-01T09:00:00Z'),
      });
      const created = await goals.createWithWork(input, automation);
      const started = await goals.startWork(created.goalId, automation);
      const fromTool = await goals.createFromTool({ ...input, taintedOrigin: false }, automation);
      const chats = new FirestoreApplicationChatPersistence(store, agentId);
      const listed = await chats.listConversations(agentId, { archived: false, limit: 10 });
      expect(listed.conversations.map((row) => row.id)).toEqual(
        expect.arrayContaining([
          created.conversationId,
          started.conversationId,
          fromTool.conversationId,
        ]),
      );
      expect(await chats.countConversations(agentId, false)).toBe(3);
      expect(await chats.countConversations(agentId, true)).toBe(0);
    } finally {
      await disposeStore(store);
    }
  });
});

it('derives archived projection from the actual archive timestamp for every channel', () => {
  for (const channel of ['chat', 'email', 'sms', 'voice']) {
    expect(
      conversationDocument({ id: 'id', agentId: 'owner', channel, archivedAt: null }).archived,
    ).toBe(false);
    expect(
      conversationDocument({ id: 'id', agentId: 'owner', channel, archivedAt: new Date() })
        .archived,
    ).toBe(true);
  }
});
