import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FirestoreConversationSegmentationRepository } from './conversation-segmentation.js';
import { disposeStore, emulatorStore } from './test-store.js';

const space = { provider: 'synthetic', model: 'segmentation', dimensions: 1536, revision: '1' };

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore conversation segmentation', () => {
  let store: ReturnType<typeof emulatorStore> | undefined;

  afterEach(async () => {
    if (store) await disposeStore(store);
    store = undefined;
  });

  it('excludes visual QA messages while retaining ordinary owner and assistant turns', async () => {
    store = emulatorStore();
    const repository = new FirestoreConversationSegmentationRepository(store, space);
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const now = new Date('2026-10-07T12:00:00.000Z');
    await store.doc('conversations', conversationId).set({
      id: conversationId,
      agentId,
      trust: 'owner',
      updatedAt: now,
    });
    const message = async (
      channelMessageId?: string,
      role: 'user' | 'assistant' = 'user',
      createdAt = now,
    ) => {
      const id = randomUUID();
      await store?.doc('messages', id).set({
        id,
        conversationId,
        role,
        text: `message ${id}`,
        createdAt,
        ...(channelMessageId ? { channelMessageId } : {}),
      });
      return id;
    };
    const owner = await message(undefined, 'user', now);
    const assistant = await message(undefined, 'assistant', new Date(now.getTime() + 1_000));
    await message('visual-qa:segmentation:fixture', 'user', new Date(now.getTime() + 2_000));
    await message('readability-run-segmentation-01-user', 'user', new Date(now.getTime() + 3_000));

    const result = await repository.unsegmentedMessages(
      agentId,
      conversationId,
      10,
      'a'.repeat(64),
    );
    expect(result.map(({ id }) => id)).toEqual([owner, assistant]);
  });
});
