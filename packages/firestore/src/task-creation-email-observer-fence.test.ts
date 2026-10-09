import { createHash, randomUUID } from 'node:crypto';
import type {
  EmailObserverTaskCreationFence,
  Records,
  TaskCreateInput,
} from '@assistant/persistence';
import { expect, it } from 'vitest';
import { encodeRecord } from './store.js';
import { createTask } from './task-creation.js';
import { disposeStore, emulatorStore } from './test-store.js';

const hash = (value: string) =>
  createHash('sha256').update('assistant-email-content-v1\0').update(value).digest('hex');

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'fences direct email task creation and event replay against the prepared owner source',
  async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const providerMessageId = randomUUID();
    const channelMessageId = `gmail:${providerMessageId}`;
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const workId = randomUUID();
    const from = 'sender@example.test';
    const subject = 'Observer source';
    const body = 'Please review the attached travel details.';
    const prefix = `From: ${from}\nSubject: ${subject}\n\n`;
    const text = prefix + body;
    const provenance = {
      version: 1 as const,
      mode: 'direct' as const,
      authenticated: true,
      sourceLength: body.length,
      storedLength: body.length,
      sourceHash: hash(body),
      bodyHash: hash(body),
      messageHash: hash(text),
      prefixLength: prefix.length,
      hasExternalOrUnknown: false,
      spans: [{ start: 0, end: body.length, author: 'sender' as const }],
      parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: false, replyHeaders: false }],
    };
    const now = new Date();
    const fence: EmailObserverTaskCreationFence = {
      id: workId,
      agentId,
      claimToken: randomUUID(),
      claimGeneration: 2,
      expectedPrivacyGeneration: null,
      channelMessageId,
    };
    const input = {
      agentId,
      conversationId,
      type: 'email_triage',
      title: subject,
      trust: 'unknown',
      externalEventId: channelMessageId,
      maxSteps: 16,
      budgetUsdLimit: '1.20',
      emailObserverTaskFence: fence,
      trigger: {
        source: 'email',
        externalEventId: channelMessageId,
        agentId,
        conversationId,
        trust: 'unknown',
        payload: {
          threadId: 'thread-fixture',
          messageId: providerMessageId,
          rfcMessageId: `<${providerMessageId}@example.test>`,
          from,
          subject,
          quotesExternalContent: false,
          emailProvenance: provenance,
          ingest: {
            forwarded: false,
            contentTrust: 'unknown',
            authenticated: true,
            importance: 4,
            category: 'travel',
            ownerAlerted: false,
          },
        },
      },
    } satisfies TaskCreateInput;
    try {
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('rateLimits', 'task').set({ maxPerHour: null, maxPerDay: null });
      const work = {
        id: workId,
        agentId,
        sourceKey: channelMessageId,
        channelMessageId,
        sourceKind: 'message',
        observerKey: 'google.direct-email-routing',
        observerVersion: 1,
        workClass: 'idempotent_db',
        status: 'prepared',
        attemptCount: 1,
        claimToken: fence.claimToken,
        claimGeneration: fence.claimGeneration,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        privacyGeneration: null,
        budgetKey: null,
        budgetWindowStart: null,
        budgetReserved: false,
        preparedResult: { route: 'email_triage' },
        deliveryKey: null,
        lastErrorCode: null,
        claimedAt: now,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      } satisfies Records['emailObserverWork'];
      await store.doc('emailObserverWork', workId).set(encodeRecord(work));
      const ingest = {
        id: randomUUID(),
        agentId,
        conversationId,
        mailbox: `${agentId}@task-fence.invalid`,
        providerMessageId,
        providerThreadId: 'thread-fixture',
        sourceMessageId: `<${providerMessageId}@example.test>`,
        channelMessageId,
        fromEmail: from,
        fromName: null,
        subject,
        contentTrust: 'unknown',
        authenticated: true,
        ingestMode: 'direct',
        hasExternalOrUnknown: false,
        category: 'travel',
        importance: 4,
        actionable: true,
        reason: 'Stored score',
        dates: [],
        pipelineStage: 'admitted',
        scoreStatus: 'prepared',
        scoreOutcome: 'model_prepared',
        scoreClaimToken: null,
        messagePersisted: true,
        triageTaskId: null,
        triaged: false,
        admittedSourceKind: 'message',
        admittedSourceId: messageId,
        directRouting: 'email_triage',
        directRecoveryReason: null,
        emailContentProvenance: provenance,
      } as unknown as Records['emailIngest'];
      await store.doc('emailIngest', ingest.id).set(encodeRecord(ingest));
      await store.doc('conversations', conversationId).set(
        encodeRecord({
          id: conversationId,
          agentId,
          channel: 'email',
          trust: 'unknown',
          title: subject,
        }),
      );
      await store.doc('messages', messageId).set(
        encodeRecord({
          id: messageId,
          conversationId,
          role: 'user',
          origin: 'unknown',
          text,
          parts: [{ type: 'text', text: body }],
          channelMessageId,
          hiddenAt: null,
        }),
      );
      await store.doc('messageChannelIds', channelMessageId).set({
        messageId,
        conversationId,
      });

      const invalid = {
        ...input,
        trigger: {
          ...input.trigger,
          payload: { ...input.trigger.payload, subject: 'Altered source' },
        },
      };
      await expect(createTask(store, invalid)).rejects.toThrow(/fence/);
      await expect(
        createTask(store, {
          ...input,
          emailObserverTaskFence: { ...fence, claimToken: randomUUID() },
        }),
      ).rejects.toThrow(/fence/);
      const workRef = store.doc('emailObserverWork', workId);
      await workRef.update({ leaseExpiresAt: new Date(Date.now() - 1_000) });
      await expect(createTask(store, input)).rejects.toThrow(/fence/);
      await workRef.update({ leaseExpiresAt: new Date(Date.now() + 60_000) });
      await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'complete' });
      await expect(createTask(store, input)).rejects.toThrow(/fence|[Pp]rivacy/);
      await store.doc('privacyErasureJobs', agentId).delete();
      expect((await store.collection('tasks').get()).empty).toBe(true);
      expect((await store.collection('taskEventKeys').get()).empty).toBe(true);
      expect((await store.collection('outbox').get()).empty).toBe(true);

      const created = await createTask(store, input);
      expect(created.created).toBe(true);
      const replay = await createTask(store, input);
      expect(replay).toMatchObject({ created: false, task: { id: created.task.id } });
      await expect(createTask(store, invalid)).rejects.toThrow(/fence/);
      expect((await store.collection('tasks').get()).size).toBe(1);
    } finally {
      await disposeStore(store);
    }
  },
);
