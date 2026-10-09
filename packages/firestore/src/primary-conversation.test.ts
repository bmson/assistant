import { describe, expect, it } from 'vitest';
import { FirestoreApplicationChatPersistence } from './application-chat.js';
import { conversationDocument } from './conversation-document.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore owner primary purpose', () => {
  it('does not rewrite a stable primary conversation or its marker on repeated reads', async () => {
    const store = emulatorStore();
    try {
      await store.doc('agents', 'owner').set({ id: 'owner' });
      const repository = new FirestoreApplicationChatPersistence(store, 'owner');
      const primary = await repository.getOrCreatePrimaryConversation('owner');
      const conversationRef = store.doc('conversations', primary.id);
      const markerRef = store.doc('primaryConversations', 'owner');
      const beforeConversation = await conversationRef.get();
      const beforeMarker = await markerRef.get();
      const beforeConversationUpdateTime = beforeConversation.updateTime;
      const beforeMarkerUpdateTime = beforeMarker.updateTime;
      if (!beforeConversationUpdateTime || !beforeMarkerUpdateTime)
        throw new Error('Emulator snapshots must include update times');
      const beforeUpdatedAt = beforeConversation.get('updatedAt');

      const repeated = await repository.getOrCreatePrimaryConversation('owner');

      const afterConversation = await conversationRef.get();
      const afterMarker = await markerRef.get();
      expect(repeated.id).toBe(primary.id);
      expect(afterConversation.updateTime?.isEqual(beforeConversationUpdateTime)).toBe(true);
      expect(afterMarker.updateTime?.isEqual(beforeMarkerUpdateTime)).toBe(true);
      expect(afterConversation.get('updatedAt')).toEqual(beforeUpdatedAt);
      expect(afterConversation.get('isPrimary')).toBe(true);
      expect(afterConversation.get('archived')).toBe(false);
      expect(afterConversation.get('archivedAt')).toBeNull();
      expect(afterConversation.get('metadata')).toMatchObject({ purpose: 'owner-chat' });
    } finally {
      await disposeStore(store);
    }
  });

  it.each([false, true])(
    'excludes Notifications and repairs legacy primary marker (legacy=%s)',
    async (legacy) => {
      const store = emulatorStore();
      try {
        await store.doc('agents', 'owner').set({ id: 'owner' });
        const repository = new FirestoreApplicationChatPersistence(store, 'owner');
        let notificationId = 'notifications';
        if (legacy) {
          const initial = await repository.getOrCreatePrimaryConversation('owner');
          notificationId = initial.id;
          await store
            .doc('conversations', notificationId)
            .update({ trust: 'assistant', title: 'Notifications', metadata: {} });
        } else {
          const now = new Date();
          await store.doc('conversations', notificationId).set(
            conversationDocument({
              id: notificationId,
              agentId: 'owner',
              channel: 'chat',
              trust: 'assistant',
              title: 'Notifications',
              isPrimary: false,
              archivedAt: null,
              createdAt: now,
              updatedAt: now,
              metadata: {},
            }),
          );
        }
        const results = await Promise.all(
          Array.from({ length: 8 }, () => repository.getOrCreatePrimaryConversation('owner')),
        );
        expect(new Set(results.map((row) => row.id)).size).toBe(1);
        expect(results[0]).toMatchObject({
          trust: 'owner',
          isPrimary: true,
          metadata: { purpose: 'owner-chat' },
        });
        expect(results[0]?.id).not.toBe(notificationId);
        expect((await store.doc('conversations', notificationId).get()).data()).toMatchObject({
          trust: 'assistant',
          title: 'Notifications',
          isPrimary: false,
        });
        expect((await store.collection('conversations').get()).size).toBe(2);
        await expect(repository.getOrCreatePrimaryConversation('foreign')).rejects.toThrow(
          'outside this installation',
        );
      } finally {
        await disposeStore(store);
      }
    },
  );
});
