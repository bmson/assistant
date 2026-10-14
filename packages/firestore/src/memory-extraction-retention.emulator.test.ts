import { randomUUID } from 'node:crypto';
import { newTaskRecord } from '@assistant/persistence';
import { afterEach, describe, expect, it } from 'vitest';
import { FirestoreMemoryExtractionRepository } from './memory-extraction.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore memory retention boundary', () => {
  let store: InstallationStore;

  afterEach(async () => {
    if (store) await disposeStore(store);
  });

  it('filters the marked task and its assistant reply while retaining later unrelated owner input', async () => {
    store = emulatorStore();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const ephemeralTaskId = randomUUID();
    const normalTaskId = randomUUID();
    const now = new Date();
    const ephemeralText = 'This is a fictional exercise, not personal information.';
    const normalText = 'I prefer a quiet desk in the morning';
    await store.doc('agents', agentId).set({
      id: agentId,
      name: 'Retention test owner',
      createdAt: now,
      updatedAt: now,
    });
    await store.doc('conversations', conversationId).set({
      id: conversationId,
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: 'Retention test',
      createdAt: now,
      updatedAt: now,
    });
    const ephemeralTask = newTaskRecord(
      {
        agentId,
        conversationId,
        type: 'chat_turn',
        trust: 'owner',
        title: ephemeralText,
        trigger: {
          source: 'chat',
          agentId,
          conversationId,
          trust: 'owner',
          payload: { text: ephemeralText },
        },
      },
      ephemeralTaskId,
      now,
    );
    const normalTask = newTaskRecord(
      {
        agentId,
        conversationId,
        type: 'chat_turn',
        trust: 'owner',
        title: normalText,
        trigger: {
          source: 'chat',
          agentId,
          conversationId,
          trust: 'owner',
          payload: { text: normalText },
        },
      },
      normalTaskId,
      new Date(now.getTime() + 2000),
    );
    await store.doc('tasks', ephemeralTaskId).set(encodeRecord(ephemeralTask));
    await store.doc('tasks', normalTaskId).set(encodeRecord(normalTask));
    const seed = (
      id: string,
      taskId: string,
      role: 'user' | 'assistant',
      text: string,
      time: number,
    ) =>
      store.doc('messages', id).set(
        encodeRecord({
          id,
          conversationId,
          taskId,
          role,
          origin: role === 'user' ? 'owner' : 'assistant',
          parts: [{ type: 'text', text }],
          text,
          createdAt: new Date(now.getTime() + time),
          hiddenAt: null,
          appendSequence: String(time).padStart(20, '0'),
        }),
      );
    await seed(randomUUID(), ephemeralTaskId, 'user', ephemeralText, 0);
    await seed(
      randomUUID(),
      ephemeralTaskId,
      'assistant',
      'Understood; those fictional details are only for this exercise.',
      1,
    );
    await seed(randomUUID(), normalTaskId, 'user', normalText, 2000);

    const repository = new FirestoreMemoryExtractionRepository(store, {
      provider: 'test',
      model: 'retention-test',
      dimensions: 1536,
      revision: '1',
    });
    const result = await repository.recentConversations({
      agentId,
      since: new Date(now.getTime() - 1000),
      maxConversations: 10,
      maxMessages: 30,
      minTextLength: 0,
    });
    const transcript = result
      .flatMap((conversation) => conversation.messages)
      .map((row) => row.text);
    expect(transcript).toContain(normalText);
    expect(transcript).not.toContain(ephemeralText);
    expect(transcript).not.toContain(
      'Understood; those fictional details are only for this exercise.',
    );
  });
});
