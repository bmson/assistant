import { randomUUID } from 'node:crypto';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import type { ExecutionPersistence, Records } from '@assistant/persistence';
import type { GoogleClient } from '@assistant/tools/modules/google';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { deliverEmailFinal } from '../../../packages/modules/src/google/email-channel.js';

const SPACE = { provider: 'synthetic', model: 'reply-fixture', dimensions: 1536, revision: '1' };
const OWNER = 'ada@owner.test';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore email thread replies', () => {
  const agentId = randomUUID();
  let store: InstallationStore;
  let persistence: ExecutionPersistence;
  let sent: Array<{ raw: string; threadId: string }>;

  beforeEach(async () => {
    store = emulatorStore();
    persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
    sent = [];
    await store
      .doc('agents', agentId)
      .set({ id: agentId, name: 'Bot', email: 'bot@assistant.test', timezone: 'UTC' });
    const contactId = randomUUID();
    await store
      .doc('contacts', contactId)
      .set({ id: contactId, name: 'Ada', trust: 'owner', emails: [OWNER], aliases: [] });
    await store.doc('voiceProfile', '1').set({ id: 1, signature: '— Bot', description: '' });
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  function deps() {
    const { emailSync, voiceContext } = persistence;
    if (!emailSync || !voiceContext) throw new Error('missing mail repositories');
    return {
      persistence: { emailSync, voiceContext },
      googleClient: {
        configured: () => true,
        api: async (_url: string, init?: { body?: string }) => {
          sent.push(JSON.parse(init?.body ?? '{}'));
          return {};
        },
      } as unknown as GoogleClient,
    };
  }

  async function thread(channel = 'email') {
    const conversationId = randomUUID();
    const now = new Date();
    await store.doc('conversations', conversationId).set(
      encodeRecord({
        id: conversationId,
        agentId,
        channel,
        trust: 'owner',
        title: 'Thread',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const bindingId = randomUUID();
    await store.doc('channelBindings', bindingId).set(
      encodeRecord({
        id: bindingId,
        channel: 'email',
        conversationId,
        externalId: `gmail-thread-${conversationId}`,
        createdAt: now,
        updatedAt: now,
      }),
    );
    return conversationId;
  }

  async function task(input: {
    conversationId: string;
    type: string;
    trust: string;
    payload?: Record<string, unknown>;
    minutesAgo?: number;
  }): Promise<Records['tasks']> {
    const id = randomUUID();
    const at = new Date(Date.now() - (input.minutesAgo ?? 0) * 60_000);
    const row = {
      id,
      agentId,
      type: input.type,
      trust: input.trust,
      status: 'running',
      conversationId: input.conversationId,
      trigger: { source: 'email', payload: input.payload ?? {} },
      createdAt: at,
      updatedAt: at,
    };
    await store.doc('tasks', id).set(encodeRecord(row));
    return row as unknown as Records['tasks'];
  }

  it('answers an owner email on its thread, and a follow-up task on the same thread', async () => {
    const conversationId = await thread();
    const triage = await task({
      conversationId,
      type: 'email_triage',
      trust: 'owner',
      minutesAgo: 10,
      payload: {
        threadId: `gmail-thread-${conversationId}`,
        from: OWNER,
        subject: 'Plan Friday',
        rfcMessageId: '<orig@mail>',
        messageId: 'g1',
      },
    });
    expect(await deliverEmailFinal(deps(), triage, 'Done — **booked**.')).toMatchObject({
      status: 'accepted',
    });
    const followUp = await task({ conversationId, type: 'adhoc', trust: 'owner' });
    expect(await deliverEmailFinal(deps(), followUp, 'Also moved the call.')).toMatchObject({
      status: 'accepted',
    });

    expect(sent.map((mail) => mail.threadId)).toEqual([
      `gmail-thread-${conversationId}`,
      `gmail-thread-${conversationId}`,
    ]);
    const decoded = Buffer.from(sent[0]?.raw ?? '', 'base64url').toString();
    expect(decoded).toContain(`To: ${OWNER}`);
    expect(decoded).toContain('Subject: Re: Plan Friday');
    expect(decoded).toContain('In-Reply-To: <orig@mail>');
    expect(decoded).toContain('"Bot" <bot@assistant.test>');
    expect(decoded).toContain('— Bot');
  });

  it('never auto-replies to a stranger or a non-email conversation', async () => {
    const strangerThread = await thread();
    await task({
      conversationId: strangerThread,
      type: 'email_triage',
      trust: 'known',
      minutesAgo: 10,
      payload: { threadId: 'x', from: 'grace@friend.test', subject: 'Hi' },
    });
    const followUp = await task({ conversationId: strangerThread, type: 'adhoc', trust: 'owner' });
    expect(await deliverEmailFinal(deps(), followUp, 'Reply')).toMatchObject({
      status: 'rejected',
    });

    const spoof = await task({
      conversationId: await thread(),
      type: 'email_triage',
      trust: 'owner',
      payload: { threadId: 't', from: 'mallory@spoof.test', subject: 'Hi' },
    });
    expect(await deliverEmailFinal(deps(), spoof, 'Reply')).toMatchObject({ status: 'rejected' });

    const chat = await task({
      conversationId: await thread('chat'),
      type: 'adhoc',
      trust: 'owner',
    });
    expect(await deliverEmailFinal(deps(), chat, 'Reply')).toMatchObject({
      status: 'not_applicable',
    });
    expect(sent).toEqual([]);
  });
});
