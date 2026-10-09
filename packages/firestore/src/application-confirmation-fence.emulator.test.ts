import { createHash, randomUUID } from 'node:crypto';
import {
  applicationConfirmationTaskInput,
  applicationExternalEffectArgsDigest,
  type EmailObserverEffectFence,
  newTaskRecord,
  type Records,
} from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerApplicationTools } from '../../tools/src/applications.js';
import { ToolRegistry } from '../../tools/src/registry.js';
import { FirestoreApplicationConfirmationRepository } from './application-confirmations.js';
import { FirestoreMessageRepository } from './messages.js';
import { FirestoreNotificationOutboxRepository } from './notification-outbox.js';
import { FirestoreOwnerNoticeRepository } from './owner-notices.js';
import { privacyErasureGeneration } from './privacy-erasure.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { createTask as createTaskInTransaction } from './task-creation.js';
import { disposeStore, emulatorStore } from './test-store.js';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
describe.skipIf(!HOST)('Firestore durable email application-confirmation fence', () => {
  let store: InstallationStore | undefined;

  afterEach(async () => {
    if (store) await disposeStore(store);
    store = undefined;
  });

  it('commits an opaque unknown receipt before dispatch and blocks replay', async () => {
    const agentId = randomUUID();
    const applicationId = randomUUID();
    const taskId = randomUUID();
    const toolCallId = randomUUID();
    const taskLeaseToken = randomUUID();
    const toolName = 'applications.apply_confirmation';
    const idempotencyKey = `application-confirmation-apply-${applicationId}`;
    const trackerUpdate = {
      spreadsheetId: 'spreadsheet_123456789',
      sheetName: 'Applications',
      startCell: 'A2',
      rows: [['Example Corp', 'Engineer']],
    };
    store = emulatorStore();
    await store.doc('agents', agentId).set({ id: agentId, name: 'Owner' });
    await store.doc('tasks', taskId).set({
      id: taskId,
      agentId,
      status: 'running',
      leaseToken: taskLeaseToken,
      lockedUntil: new Date(Date.now() + 60_000),
      externalEventId: `application-confirmation:gmail:${applicationId}`,
      trigger: {
        source: 'internal',
        externalEventId: `application-confirmation:gmail:${applicationId}`,
        payload: {
          kind: 'application_confirmation',
          applicationId,
          confirmationMessageId: `gmail:${applicationId}`,
          producerPrivacyGeneration: null,
        },
      },
    });
    await store.doc('toolCalls', toolCallId).set({
      id: toolCallId,
      taskId,
      toolName,
      args: { applicationId },
      status: 'executing',
      idempotencyKey,
    });
    const application: Records['applicationConfirmations'] = {
      id: applicationId,
      agentId,
      sourceTaskId: taskId,
      conversationId: randomUUID(),
      company: 'Example Corp',
      role: 'Engineer',
      expectedSenderEmails: ['sender@example.test'],
      confirmationTokenHash: 'a'.repeat(64),
      confirmationTokenHint: '1234',
      trackerUpdate,
      documentUpdate: null,
      actionState: { sheet: { status: 'pending' } },
      status: 'confirmation_received',
      expiresAt: new Date(Date.now() + 60_000),
      confirmationMessageId: `gmail:${applicationId}`,
      confirmationFrom: 'sender@example.test',
      confirmedAt: new Date(),
      producerPrivacyGeneration: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await store.doc('applicationConfirmations', applicationId).set(encodeRecord(application));

    const repository = new FirestoreApplicationConfirmationRepository(store, agentId);
    const input = {
      agentId,
      applicationId,
      action: 'sheet' as const,
      expectedProducerPrivacyGeneration: null,
      taskId,
      taskLeaseToken,
      toolCallId,
      toolName,
      idempotencyKey,
      argsDigest: applicationExternalEffectArgsDigest('sheet', trackerUpdate),
      now: new Date(),
    };
    const claimed = await repository.claimExternalEffect(input);
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') return;
    expect(claimed.record.actionState).toMatchObject({ sheet: { status: 'unknown' } });
    expect(await repository.claimExternalEffect(input)).toEqual({ status: 'blocked' });
    expect(
      await repository.settleExternalEffect({
        agentId,
        applicationId,
        action: 'sheet',
        claimToken: claimed.claimToken,
        status: 'succeeded',
        now: new Date(),
      }),
    ).toMatchObject({ actionState: { sheet: { status: 'succeeded' } } });
  });

  it('routes registered Sheet and Doc tools through the Firestore effect gate', async () => {
    const agentId = randomUUID();
    store = emulatorStore();
    await store.doc('agents', agentId).set({ id: agentId, name: 'Owner' });

    for (const action of ['sheet', 'document'] as const) {
      const applicationId = randomUUID();
      const taskId = randomUUID();
      const toolCallId = randomUUID();
      const taskLeaseToken = randomUUID();
      const toolName =
        action === 'sheet'
          ? 'applications.apply_confirmation'
          : 'applications.append_confirmation_doc';
      const idempotencyKey =
        action === 'sheet'
          ? `application-confirmation-apply-${applicationId}`
          : `application-confirmation-doc-${applicationId}`;
      const confirmationMessageId = `gmail:${applicationId}`;
      const externalEventId = `application-confirmation:${confirmationMessageId}`;
      await store.doc('tasks', taskId).set({
        id: taskId,
        agentId,
        status: 'running',
        leaseToken: taskLeaseToken,
        lockedUntil: new Date(Date.now() + 60_000),
        externalEventId,
        trigger: {
          source: 'internal',
          externalEventId,
          payload: {
            kind: 'application_confirmation',
            applicationId,
            confirmationMessageId,
            producerPrivacyGeneration: null,
          },
        },
      });
      await store.doc('toolCalls', toolCallId).set({
        id: toolCallId,
        taskId,
        toolName,
        args: { applicationId },
        status: 'executing',
        idempotencyKey,
      });
      const trackerUpdate = {
        spreadsheetId: 'spreadsheet_123456789',
        sheetName: 'Applications',
        startCell: 'A2',
        rows: [['Example Corp', 'Engineer']],
      };
      const documentUpdate = {
        documentId: 'document_123456789',
        content: 'Application received.',
      };
      const application: Records['applicationConfirmations'] = {
        id: applicationId,
        agentId,
        sourceTaskId: taskId,
        conversationId: randomUUID(),
        company: 'Example Corp',
        role: 'Engineer',
        expectedSenderEmails: ['sender@example.test'],
        confirmationTokenHash: 'a'.repeat(64),
        confirmationTokenHint: '1234',
        trackerUpdate: action === 'sheet' ? trackerUpdate : null,
        documentUpdate: action === 'document' ? documentUpdate : null,
        actionState:
          action === 'sheet'
            ? { sheet: { status: 'pending' } }
            : { document: { status: 'pending' } },
        status: 'confirmation_received',
        expiresAt: new Date(Date.now() + 60_000),
        confirmationMessageId,
        confirmationFrom: 'sender@example.test',
        confirmedAt: new Date(),
        producerPrivacyGeneration: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await store.doc('applicationConfirmations', applicationId).set(encodeRecord(application));

      const provider = vi.fn(async (_url: string, init: RequestInit = {}) =>
        (init.method ?? 'GET') === 'GET' ? { body: { content: [{ endIndex: 1 }] } } : {},
      );
      const registry = new ToolRegistry();
      const repository = new FirestoreApplicationConfirmationRepository(store, agentId);
      registerApplicationTools(registry, {
        client: { api: provider } as never,
        applications: repository,
        tasks: {
          getTask: async (id) => {
            const snapshot = await store?.doc('tasks', id).get();
            return (snapshot?.data() as never) ?? null;
          },
        },
      });
      const registered = registry.get(toolName)?.tool;
      if (!registered) throw new Error(`${toolName} was not registered`);
      const execute = registered.execute as (args: unknown, context: unknown) => Promise<unknown>;
      const context = {
        taskId,
        taskLeaseToken,
        agentId,
        trust: 'assistant',
        tainted: false,
        now: () => new Date(),
        signal: new AbortController().signal,
        log: async () => {},
        execution: { dbToolCallId: toolCallId, modelToolCallId: randomUUID(), toolName },
      };
      const outcome = await execute({ applicationId }, context);
      expect(outcome).toMatchObject({ action, status: 'succeeded' });
      const mutations = provider.mock.calls.filter(
        ([, init]) => init?.method === 'PUT' || init?.method === 'POST',
      );
      expect(mutations).toHaveLength(1);
      const replay = await execute({ applicationId }, context);
      expect(replay).toMatchObject({ action, status: 'succeeded', alreadyApplied: true });
      expect(
        provider.mock.calls.filter(([, init]) => init?.method === 'PUT' || init?.method === 'POST'),
      ).toHaveLength(1);
    }
  });

  async function fixture(suffix: string, clock?: () => Date, ambiguous = false) {
    const agentId = randomUUID();
    const channelMessageId = `gmail:confirmation-${suffix}-${randomUUID()}`;
    const providerMessageId = channelMessageId.slice('gmail:'.length);
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const ingestId = randomUUID();
    const workId = randomUUID();
    const watchId = randomUUID();
    const token = `receipt-${suffix}`;
    const externalToken = `external-${suffix}`;
    const absentToken = `absent-${suffix}`;
    const authoredBody = `Confirmation ${token}\n`;
    const body = `${authoredBody}> quoted ${externalToken}`;
    const contentHash = createHash('sha256')
      .update('assistant-email-content-v1\0')
      .update(body)
      .digest('hex');
    const provenance = {
      version: 1 as const,
      mode: 'direct' as const,
      authenticated: true,
      sourceLength: body.length,
      storedLength: body.length,
      sourceHash: contentHash,
      bodyHash: contentHash,
      messageHash: contentHash,
      prefixLength: 0,
      hasExternalOrUnknown: true,
      spans: [
        { start: 0, end: authoredBody.length, author: 'sender' as const },
        { start: authoredBody.length, end: body.length, author: 'external' as const },
      ],
      parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: true, replyHeaders: false }],
    };
    const tokenHash = createHash('sha256').update(token.toUpperCase()).digest('hex');
    const externalTokenHash = createHash('sha256')
      .update(externalToken.toUpperCase())
      .digest('hex');
    const absentTokenHash = createHash('sha256').update(absentToken.toUpperCase()).digest('hex');
    const claimToken = `claim-${suffix}`;
    const now = new Date();
    store = emulatorStore(clock);
    await store
      .doc('agents', agentId)
      .set({ id: agentId, name: 'Owner', email: 'owner@example.test' });
    await store.doc('conversations', conversationId).set({
      id: conversationId,
      agentId,
      channel: 'email',
      title: 'Confirmation source',
    });
    const message: Partial<Records['messages']> = {
      id: messageId,
      conversationId,
      channelMessageId,
      role: 'user',
      origin: 'unknown',
      parts: [{ type: 'text', text: body }],
      text: body,
      hiddenAt: null,
    };
    await store.doc('messages', messageId).set(encodeRecord(message));
    await store.doc('messageChannelIds', channelMessageId).set({
      messageId,
      conversationId,
      agentId,
    });
    const ingest: Partial<Records['emailIngest']> = {
      id: ingestId,
      agentId,
      channelMessageId,
      conversationId,
      fromEmail: 'sender@example.test',
      subject: 'Application receipt',
      authenticated: true,
      ingestMode: 'direct',
      hasExternalOrUnknown: true,
      emailContentProvenance: provenance,
      providerMessageId,
      admittedSourceKind: 'message',
      admittedSourceId: messageId,
      directRouting: null,
    };
    await store.doc('emailIngest', ingestId).set(encodeRecord(ingest));
    const fence: EmailObserverEffectFence = {
      id: workId,
      agentId,
      claimToken,
      claimGeneration: 4,
      expectedPrivacyGeneration: null,
    };
    const work: Partial<Records['emailObserverWork']> = {
      id: workId,
      agentId,
      sourceKey: channelMessageId,
      channelMessageId,
      sourceKind: 'message',
      observerKey: 'google.application-confirmation',
      observerVersion: 1,
      workClass: 'idempotent_db',
      status: 'prepared',
      claimToken,
      claimGeneration: 4,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      privacyGeneration: null,
      preparedResult: {},
    };
    await store.doc('emailObserverWork', workId).set(encodeRecord(work));
    const watch: Partial<Records['applicationConfirmations']> = {
      id: watchId,
      agentId,
      sourceTaskId: randomUUID(),
      conversationId,
      company: 'Example Corp',
      role: 'Engineer',
      expectedSenderEmails: ['sender@example.test'],
      confirmationTokenHash: tokenHash,
      confirmationTokenHint: '1234',
      trackerUpdate: null,
      documentUpdate: null,
      actionState: {},
      status: 'awaiting_confirmation',
      expiresAt: new Date(now.getTime() + 120_000),
      confirmationMessageId: null,
      confirmationFrom: null,
      confirmedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await store.doc('applicationConfirmations', watchId).set(encodeRecord(watch));
    const secondWatchId = randomUUID();
    await store.doc('applicationConfirmations', secondWatchId).set(
      encodeRecord({
        ...watch,
        id: secondWatchId,
        company: 'Other Corp',
        role: 'Designer',
        confirmationTokenHash: ambiguous ? tokenHash : externalTokenHash,
        confirmationTokenHint: ambiguous ? '2222' : '5678',
      }),
    );
    const absentWatchId = randomUUID();
    await store.doc('applicationConfirmations', absentWatchId).set(
      encodeRecord({
        ...watch,
        id: absentWatchId,
        company: 'Absent Corp',
        role: 'Analyst',
        confirmationTokenHash: absentTokenHash,
        confirmationTokenHint: '9876',
      }),
    );
    const sourceDigest = createHash('sha256')
      .update(
        JSON.stringify([channelMessageId, 'sender@example.test', 'Application receipt', body]),
      )
      .digest('hex');
    return {
      agentId,
      conversationId,
      channelMessageId,
      watchId,
      tokenHash,
      fence,
      sourceDigest,
      secondWatchId,
      externalTokenHash,
      absentWatchId,
      absentTokenHash,
    };
  }

  it('claims a matching owner watch only from the live prepared canonical direct source', async () => {
    const fixtureData = await fixture('positive');
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    const noticeId = await new FirestoreOwnerNoticeRepository(
      fixtureStore,
      fixtureData.agentId,
    ).getOrCreate(fixtureData.agentId, fixtureData.fence);
    const notice = await fixtureStore.doc('conversations', noticeId).get();
    expect(notice.get('title')).toBe('Notifications');
    const repository = new FirestoreApplicationConfirmationRepository(
      fixtureStore,
      fixtureData.agentId,
    );
    const claimed = await repository.claim(fixtureData.watchId, {
      confirmationMessageId: fixtureData.channelMessageId,
      confirmationFrom: 'sender@example.test',
      now: new Date(),
      emailObserverEffectFence: fixtureData.fence,
      confirmationTokenHash: fixtureData.tokenHash,
      sourceDigest: fixtureData.sourceDigest,
    });
    expect(claimed).toMatchObject({
      id: fixtureData.watchId,
      status: 'confirmation_received',
      confirmationMessageId: fixtureData.channelMessageId,
    });
  });

  it('atomically creates one exact internal task with the claimed watch and replays it', async () => {
    const data = await fixture('atomic-handoff');
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    const repository = new FirestoreApplicationConfirmationRepository(fixtureStore, data.agentId);
    const input = {
      confirmationMessageId: data.channelMessageId,
      confirmationFrom: 'sender@example.test',
      now: new Date(),
      emailObserverEffectFence: data.fence,
      confirmationTokenHash: data.tokenHash,
      sourceDigest: data.sourceDigest,
    };
    const first = await repository.claimAndEnqueue(data.watchId, input);
    expect(first).not.toBeNull();
    if (!first) throw new Error('handoff was not created');
    expect(first.record).toMatchObject({
      status: 'confirmation_received',
      confirmationMessageId: data.channelMessageId,
      producerPrivacyGeneration: null,
    });
    expect(first.task.trigger).toMatchObject({
      source: 'internal',
      payload: {
        kind: 'application_confirmation',
        applicationId: data.watchId,
        confirmationMessageId: data.channelMessageId,
        producerPrivacyGeneration: null,
      },
    });
    expect(first.created).toBe(true);

    const replay = await repository.claimAndEnqueue(data.watchId, input);
    expect(replay).toMatchObject({
      record: { status: 'confirmation_received', confirmationMessageId: data.channelMessageId },
      task: { id: first.task.id },
      created: false,
    });
    const tasks = await fixtureStore
      .collection('tasks')
      .where('externalEventId', '==', `application-confirmation:${data.channelMessageId}`)
      .get();
    expect(tasks.size).toBe(1);
    expect(tasks.docs[0]?.get('id')).toBe(first.task.id);
  });

  it('records a bounded ambiguous observer task and all deterministic notices atomically', async () => {
    const data = await fixture('ambiguous-observer', undefined, true);
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    const repository = new FirestoreApplicationConfirmationRepository(fixtureStore, data.agentId);
    const first = await repository.recordAmbiguousObserver({
      emailObserverEffectFence: data.fence,
    });
    expect(first).toMatchObject({
      kind: 'recorded',
      applicationIds: expect.arrayContaining([data.watchId, data.secondWatchId]),
    });
    if (first.kind === 'not_ambiguous') throw new Error('ambiguous source was not recorded');
    const externalEventId = `application-confirmation:${data.channelMessageId}:ambiguous`;
    const eventKey = fixtureStore.doc(
      'taskEventKeys',
      createHash('sha256').update(externalEventId).digest('hex'),
    );
    const event = await eventKey.get();
    expect(event.get('taskId')).toBe(first.taskId);
    const task = await fixtureStore.doc('tasks', first.taskId).get();
    expect(task.data()).toMatchObject({
      status: 'needs_attention',
      type: 'adhoc',
      trust: 'assistant',
    });
    const notices = await fixtureStore
      .collection('messages')
      .where('taskId', '==', first.taskId)
      .get();
    expect(notices.size).toBe(2);
    expect(
      notices.docs.every((notice) =>
        notice
          .get('channelMessageId')
          ?.startsWith(`application-confirmation-notice:${externalEventId}:ambiguous:`),
      ),
    ).toBe(true);

    const replay = await repository.recordAmbiguousObserver({
      emailObserverEffectFence: data.fence,
    });
    expect(replay).toMatchObject({ kind: 'replay', taskId: first.taskId });
    expect(
      (await fixtureStore.collection('messages').where('taskId', '==', first.taskId).get()).size,
    ).toBe(2);
  });

  it('does not write an ambiguous task or notice when every matching token is quoted', async () => {
    const data = await fixture('quoted-only-ambiguous');
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    const repository = new FirestoreApplicationConfirmationRepository(fixtureStore, data.agentId);
    await expect(
      repository.recordAmbiguousObserver({ emailObserverEffectFence: data.fence }),
    ).resolves.toEqual({ kind: 'not_ambiguous' });
    const externalEventId = `application-confirmation:${data.channelMessageId}:ambiguous`;
    expect(
      (await fixtureStore.collection('tasks').where('externalEventId', '==', externalEventId).get())
        .size,
    ).toBe(0);
    expect(
      (await fixtureStore.collection('messages').get()).docs.some((notice) =>
        notice
          .get('channelMessageId')
          ?.startsWith(`application-confirmation-notice:${externalEventId}:ambiguous:`),
      ),
    ).toBe(false);
  });

  it('fails closed above the bounded matching-watch limit without creating task or notices', async () => {
    const data = await fixture('ambiguous-watch-overflow', undefined, true);
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    const now = new Date();
    const tokens = Array.from(
      { length: 101 },
      (_, index) => `CASE-${String(index).padStart(3, '0')}`,
    );
    const authoredBody = `Confirmed ${tokens.join(' ')}`;
    const body = `${authoredBody}\n> quoted unrelated history`;
    const contentHash = createHash('sha256')
      .update('assistant-email-content-v1\0')
      .update(body)
      .digest('hex');
    const provenance = {
      version: 1 as const,
      mode: 'direct' as const,
      authenticated: true,
      sourceLength: body.length,
      storedLength: body.length,
      sourceHash: contentHash,
      bodyHash: contentHash,
      messageHash: contentHash,
      prefixLength: 0,
      hasExternalOrUnknown: true,
      spans: [
        { start: 0, end: authoredBody.length, author: 'sender' as const },
        { start: authoredBody.length, end: body.length, author: 'external' as const },
      ],
      parts: [{ path: '0', mimeType: 'text/plain', quoteMarkup: true, replyHeaders: false }],
    };
    const channelSnapshot = await fixtureStore
      .doc('messageChannelIds', data.channelMessageId)
      .get();
    const messageId = channelSnapshot.get('messageId');
    if (typeof messageId !== 'string') throw new Error('canonical source message is missing');
    await fixtureStore.doc('messages', messageId).update({
      parts: [{ type: 'text', text: body }],
      text: body,
    });
    const ingests = await fixtureStore
      .collection('emailIngest')
      .where('agentId', '==', data.agentId)
      .where('channelMessageId', '==', data.channelMessageId)
      .get();
    if (ingests.size !== 1) throw new Error('canonical ingest is missing');
    await ingests.docs[0]?.ref.update({
      emailContentProvenance: provenance,
      hasExternalOrUnknown: true,
    });
    await fixtureStore.doc('applicationConfirmations', data.watchId).update({
      confirmationTokenHash: createHash('sha256')
        .update(tokens[0]?.toUpperCase() ?? '')
        .digest('hex'),
    });
    await fixtureStore.doc('applicationConfirmations', data.secondWatchId).update({
      confirmationTokenHash: createHash('sha256')
        .update(tokens[1]?.toUpperCase() ?? '')
        .digest('hex'),
    });
    await Promise.all(
      tokens.slice(2).map((token, index) => {
        const id = randomUUID();
        return fixtureStore.doc('applicationConfirmations', id).set(
          encodeRecord({
            id,
            agentId: data.agentId,
            sourceTaskId: randomUUID(),
            conversationId: data.conversationId,
            company: `Overflow Corp ${index}`,
            role: 'Engineer',
            expectedSenderEmails: ['sender@example.test'],
            confirmationTokenHash: createHash('sha256').update(token.toUpperCase()).digest('hex'),
            confirmationTokenHint: '1234',
            trackerUpdate: null,
            documentUpdate: null,
            actionState: {},
            status: 'awaiting_confirmation',
            expiresAt: new Date(now.getTime() + 120_000),
            confirmationMessageId: null,
            confirmationFrom: null,
            confirmedAt: null,
            producerPrivacyGeneration: null,
            lastError: null,
            createdAt: now,
            updatedAt: now,
          } satisfies Records['applicationConfirmations']),
        );
      }),
    );
    const repository = new FirestoreApplicationConfirmationRepository(fixtureStore, data.agentId);
    await expect(
      repository.recordAmbiguousObserver({ emailObserverEffectFence: data.fence }),
    ).rejects.toThrow(/watch_limit/);
    const externalEventId = `application-confirmation:${data.channelMessageId}:ambiguous`;
    expect(
      (await fixtureStore.collection('tasks').where('externalEventId', '==', externalEventId).get())
        .size,
    ).toBe(0);
    expect(
      (await fixtureStore.collection('messages').get()).docs.some((notice) =>
        notice
          .get('channelMessageId')
          ?.startsWith(`application-confirmation-notice:${externalEventId}:ambiguous:`),
      ),
    ).toBe(false);
  });

  it('rejects an ambiguous write after owner privacy generation advances', async () => {
    const data = await fixture('ambiguous-erasure-race', undefined, true);
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    await fixtureStore.doc('privacyErasureJobs', data.agentId).set({
      id: data.agentId,
      agentId: data.agentId,
      status: 'complete',
      generation: randomUUID(),
      version: 2,
    });
    const repository = new FirestoreApplicationConfirmationRepository(fixtureStore, data.agentId);
    await expect(
      repository.recordAmbiguousObserver({ emailObserverEffectFence: data.fence }),
    ).rejects.toThrow(/fence|privacy/i);
    const externalEventId = `application-confirmation:${data.channelMessageId}:ambiguous`;
    expect(
      (await fixtureStore.collection('tasks').where('externalEventId', '==', externalEventId).get())
        .size,
    ).toBe(0);
    expect(
      (await fixtureStore.collection('messages').get()).docs.some((notice) =>
        notice
          .get('channelMessageId')
          ?.startsWith(`application-confirmation-notice:${externalEventId}:ambiguous:`),
      ),
    ).toBe(false);
  });

  it('fences final task notices across erasure and allows only a current-generation task replay', async () => {
    const data = await fixture('task-notice-generation');
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    const activeStore = fixtureStore;
    async function taskNoticeFixture(suffix: string, producerPrivacyGeneration: string | null) {
      const applicationId = randomUUID();
      const confirmationMessageId = `gmail:result-${suffix}-${randomUUID()}`;
      const taskInput = applicationConfirmationTaskInput({
        agentId: data.agentId,
        applicationId,
        confirmationMessageId,
        conversationId: data.conversationId,
        subject: 'Application receipt',
        producerPrivacyGeneration,
      });
      const taskId = randomUUID();
      const now = new Date();
      const leaseToken = randomUUID();
      const task = {
        ...newTaskRecord(taskInput, taskId, now),
        status: 'running',
        leaseToken,
        queueGeneration: 5,
        lockedUntil: new Date(now.getTime() + 60_000),
      };
      await activeStore.doc('tasks', taskId).set(encodeRecord(task));
      await activeStore.doc('applicationConfirmations', applicationId).set(
        encodeRecord({
          id: applicationId,
          agentId: data.agentId,
          sourceTaskId: randomUUID(),
          conversationId: data.conversationId,
          company: 'Example Corp',
          role: 'Engineer',
          expectedSenderEmails: ['sender@example.test'],
          confirmationTokenHash: randomUUID().replaceAll('-', ''),
          confirmationTokenHint: '1234',
          trackerUpdate: null,
          documentUpdate: null,
          actionState: {},
          status: 'updated',
          confirmationMessageId,
          confirmationFrom: 'sender@example.test',
          confirmedAt: now,
          producerPrivacyGeneration,
          expiresAt: new Date(now.getTime() + 120_000),
          lastError: null,
          createdAt: now,
          updatedAt: now,
        } satisfies Partial<Records['applicationConfirmations']>),
      );
      return {
        taskId,
        applicationId,
        confirmationMessageId,
        fence: {
          agentId: data.agentId,
          taskId,
          taskLeaseToken: leaseToken,
          taskQueueGeneration: 5,
          applicationId,
          confirmationMessageId,
          producerPrivacyGeneration,
        },
      };
    }

    const stale = await taskNoticeFixture('stale', null);
    const erasureRef = fixtureStore.doc('privacyErasureJobs', data.agentId);
    await erasureRef.set({
      id: data.agentId,
      agentId: data.agentId,
      status: 'complete',
      generation: randomUUID(),
      version: 2,
    });
    const completedErasure = await erasureRef.get();
    const currentGeneration = privacyErasureGeneration(completedErasure, data.agentId);
    if (!currentGeneration) throw new Error('completed erasure generation is missing');
    const messageRepository = new FirestoreMessageRepository(fixtureStore);
    const staleInput = {
      conversationId: data.conversationId,
      taskId: stale.taskId,
      role: 'assistant' as const,
      origin: 'assistant' as const,
      parts: [{ type: 'text', text: 'The watch is updated.' }],
      text: 'The watch is updated.',
      channelMessageId: `application-confirmation-notice:${stale.taskId}:updated`,
      applicationConfirmationNoticeFence: stale.fence,
    };
    await expect(messageRepository.append(staleInput)).rejects.toThrow(/Privacy erasure changed/);
    expect(
      (await fixtureStore.doc('messageChannelIds', staleInput.channelMessageId).get()).exists,
    ).toBe(false);

    const fresh = await taskNoticeFixture('fresh', currentGeneration);
    const freshInput = {
      ...staleInput,
      taskId: fresh.taskId,
      channelMessageId: `application-confirmation-notice:${fresh.taskId}:updated`,
      applicationConfirmationNoticeFence: fresh.fence,
    };
    expect(await messageRepository.append(freshInput)).toMatchObject({
      taskId: fresh.taskId,
      channelMessageId: freshInput.channelMessageId,
    });
    expect(await messageRepository.append(freshInput)).toBeUndefined();
    expect(
      (await fixtureStore.doc('messageChannelIds', freshInput.channelMessageId).get()).exists,
    ).toBe(true);
  });

  it('delivers a prepared task notice after task completion and suppresses it after owner erasure', async () => {
    const data = await fixture('outbox-task-complete');
    const activeStore = store;
    if (!activeStore) throw new Error('Firestore emulator store is unavailable');
    const fixtureStore: InstallationStore = activeStore;
    const outbox = new FirestoreNotificationOutboxRepository(fixtureStore, data.agentId);
    async function taskNoticeFixture(suffix: string) {
      const applicationId = randomUUID();
      const confirmationMessageId = `gmail:outbox-${suffix}-${randomUUID()}`;
      const now = new Date();
      const leaseToken = randomUUID();
      const producerPrivacyGeneration = privacyErasureGeneration(
        await fixtureStore.doc('privacyErasureJobs', data.agentId).get(),
        data.agentId,
      );
      const taskInput = applicationConfirmationTaskInput({
        agentId: data.agentId,
        applicationId,
        confirmationMessageId,
        conversationId: data.conversationId,
        subject: 'Application receipt',
        producerPrivacyGeneration,
      });
      const taskId = randomUUID();
      const task = {
        ...newTaskRecord(taskInput, taskId, now),
        status: 'running',
        leaseToken,
        queueGeneration: 5,
        lockedUntil: new Date(now.getTime() + 60_000),
      };
      await fixtureStore.doc('tasks', taskId).set(encodeRecord(task));
      await fixtureStore.doc('applicationConfirmations', applicationId).set(
        encodeRecord({
          id: applicationId,
          agentId: data.agentId,
          sourceTaskId: randomUUID(),
          conversationId: data.conversationId,
          company: 'Example Corp',
          role: 'Engineer',
          expectedSenderEmails: ['sender@example.test'],
          confirmationTokenHash: randomUUID().replaceAll('-', ''),
          confirmationTokenHint: '1234',
          trackerUpdate: null,
          documentUpdate: null,
          actionState: {},
          status: 'confirmation_received',
          confirmationMessageId,
          confirmationFrom: 'sender@example.test',
          confirmedAt: now,
          producerPrivacyGeneration,
          expiresAt: new Date(now.getTime() + 120_000),
          lastError: null,
          createdAt: now,
          updatedAt: now,
        } satisfies Partial<Records['applicationConfirmations']>),
      );
      return {
        taskId,
        fence: {
          agentId: data.agentId,
          taskId,
          taskLeaseToken: leaseToken,
          taskQueueGeneration: 5,
          applicationId,
          confirmationMessageId,
          producerPrivacyGeneration,
        },
      };
    }
    const completed = await taskNoticeFixture('outbox-complete');
    const prepared = await outbox.prepare({
      agentId: data.agentId,
      deliveryKey: `application-confirmation-result:${completed.taskId}:updated`,
      legKey: 'dashboard',
      adapter: 'dashboard',
      destination: { conversationId: data.conversationId },
      payload: { taskId: completed.taskId, text: 'The watch is updated.' },
      applicationConfirmationNoticeFence: completed.fence,
      now: new Date(),
    });
    await fixtureStore.doc('tasks', completed.taskId).update({
      status: 'done',
      leaseToken: null,
      lockedUntil: null,
    });
    const claim = await outbox.claim({
      agentId: data.agentId,
      legId: prepared.id,
      now: new Date(),
      leaseMs: 10_000,
    });
    expect(claim?.status).toBe('sending');
    if (!claim?.leaseToken) throw new Error('notification outbox lease token missing');
    await expect(
      outbox.complete({
        agentId: data.agentId,
        legId: prepared.id,
        leaseToken: claim.leaseToken,
        status: 'delivered',
        now: new Date(),
      }),
    ).resolves.toBe(true);

    const stale = await taskNoticeFixture('outbox-erased');
    const stalePrepared = await outbox.prepare({
      agentId: data.agentId,
      deliveryKey: `application-confirmation-result:${stale.taskId}:updated`,
      legKey: 'dashboard',
      adapter: 'dashboard',
      destination: { conversationId: data.conversationId },
      payload: { taskId: stale.taskId, text: 'The watch is updated.' },
      applicationConfirmationNoticeFence: stale.fence,
      now: new Date(),
    });
    const erasureRef = fixtureStore.doc('privacyErasureJobs', data.agentId);
    await erasureRef.set({
      id: data.agentId,
      agentId: data.agentId,
      status: 'complete',
      generation: randomUUID(),
      version: 2,
    });
    const suppressedResult = await outbox.claim({
      agentId: data.agentId,
      legId: stalePrepared.id,
      now: new Date(),
      leaseMs: 10_000,
    });
    expect(suppressedResult?.status).toBe('skipped');
    expect(suppressedResult?.payload).toBeNull();
    const suppressed = await fixtureStore.doc('notificationOutbox', stalePrepared.id).get();
    expect(suppressed.get('status')).toBe('skipped');
    expect(suppressed.get('payload')).toBeNull();
  });

  it('rolls back queued task writes when the lease expires during the handoff', async () => {
    const initial = new Date();
    let clockReads = 0;
    const data = await fixture('atomic-clock-expiry', () =>
      ++clockReads >= 3 ? new Date(initial.getTime() + 180_000) : initial,
    );
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    const repository = new FirestoreApplicationConfirmationRepository(fixtureStore, data.agentId);
    await expect(
      repository.claimAndEnqueue(data.watchId, {
        confirmationMessageId: data.channelMessageId,
        confirmationFrom: 'sender@example.test',
        now: initial,
        emailObserverEffectFence: data.fence,
        confirmationTokenHash: data.tokenHash,
        sourceDigest: data.sourceDigest,
      }),
    ).rejects.toThrow('Application confirmation claim expired before handoff commit');
    expect(clockReads).toBeGreaterThanOrEqual(3);
    expect(await repository.get(data.watchId)).toMatchObject({ status: 'awaiting_confirmation' });
    const tasks = await fixtureStore
      .collection('tasks')
      .where('externalEventId', '==', `application-confirmation:${data.channelMessageId}`)
      .get();
    expect(tasks.empty).toBe(true);
  });

  it('creates neither the watch claim nor its task after the captured privacy generation changes', async () => {
    const data = await fixture('atomic-handoff-stale');
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    await fixtureStore.doc('privacyErasureJobs', data.agentId).set({
      id: data.agentId,
      agentId: data.agentId,
      status: 'complete',
      generation: 'after-erasure',
      version: 2,
    });
    const repository = new FirestoreApplicationConfirmationRepository(fixtureStore, data.agentId);
    await expect(
      repository.claimAndEnqueue(data.watchId, {
        confirmationMessageId: data.channelMessageId,
        confirmationFrom: 'sender@example.test',
        now: new Date(),
        emailObserverEffectFence: data.fence,
        confirmationTokenHash: data.tokenHash,
        sourceDigest: data.sourceDigest,
      }),
    ).rejects.toThrow(/Privacy erasure changed/);
    expect(await repository.get(data.watchId)).toMatchObject({ status: 'awaiting_confirmation' });
    const tasks = await fixtureStore
      .collection('tasks')
      .where('externalEventId', '==', `application-confirmation:${data.channelMessageId}`)
      .get();
    expect(tasks.empty).toBe(true);
  });

  it('leaves the watch awaiting when the event index points to a different task payload', async () => {
    const data = await fixture('atomic-handoff-mismatch');
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    const eventId = `application-confirmation:${data.channelMessageId}`;
    const conflict = await createTaskInTransaction(fixtureStore, {
      agentId: data.agentId,
      type: 'adhoc',
      trust: 'assistant',
      externalEventId: eventId,
      maxSteps: 2,
      trigger: {
        source: 'internal',
        externalEventId: eventId,
        agentId: data.agentId,
        trust: 'assistant',
        payload: { kind: 'wrong_task' },
      },
    });
    const repository = new FirestoreApplicationConfirmationRepository(fixtureStore, data.agentId);
    await expect(
      repository.claimAndEnqueue(data.watchId, {
        confirmationMessageId: data.channelMessageId,
        confirmationFrom: 'sender@example.test',
        now: new Date(),
        emailObserverEffectFence: data.fence,
        confirmationTokenHash: data.tokenHash,
        sourceDigest: data.sourceDigest,
      }),
    ).rejects.toThrow('Task event does not match its fenced email source');
    expect(await repository.get(data.watchId)).toMatchObject({ status: 'awaiting_confirmation' });
    const tasks = await fixtureStore
      .collection('tasks')
      .where('externalEventId', '==', eventId)
      .get();
    expect(tasks.size).toBe(1);
    expect(tasks.docs[0]?.get('id')).toBe(conflict.task.id);
  });

  it('leaves the watch unchanged when the durable claim or captured privacy generation is stale', async () => {
    const fixtureData = await fixture('stale');
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    const beforeNotices = await fixtureStore
      .collection('conversations')
      .where('agentId', '==', fixtureData.agentId)
      .where('title', '==', 'Notifications')
      .get();
    await expect(
      new FirestoreOwnerNoticeRepository(fixtureStore, fixtureData.agentId).getOrCreate(
        fixtureData.agentId,
        { ...fixtureData.fence, claimToken: 'superseded-token' },
      ),
    ).rejects.toThrow('claim is stale');
    const afterNotices = await fixtureStore
      .collection('conversations')
      .where('agentId', '==', fixtureData.agentId)
      .where('title', '==', 'Notifications')
      .get();
    expect(afterNotices.size).toBe(beforeNotices.size);
    const repository = new FirestoreApplicationConfirmationRepository(
      fixtureStore,
      fixtureData.agentId,
    );
    const before = await repository.get(fixtureData.watchId);
    await expect(
      repository.claim(fixtureData.watchId, {
        confirmationMessageId: fixtureData.channelMessageId,
        confirmationFrom: 'sender@example.test',
        now: new Date(),
        emailObserverEffectFence: { ...fixtureData.fence, claimToken: 'superseded-token' },
        confirmationTokenHash: fixtureData.tokenHash,
        sourceDigest: fixtureData.sourceDigest,
      }),
    ).resolves.toBeNull();
    await fixtureStore.doc('privacyErasureJobs', fixtureData.agentId).set({
      id: fixtureData.agentId,
      agentId: fixtureData.agentId,
      status: 'complete',
      generation: 'after-erasure',
      version: 2,
    });
    await expect(
      repository.claim(fixtureData.watchId, {
        confirmationMessageId: fixtureData.channelMessageId,
        confirmationFrom: 'sender@example.test',
        now: new Date(),
        emailObserverEffectFence: fixtureData.fence,
        confirmationTokenHash: fixtureData.tokenHash,
        sourceDigest: fixtureData.sourceDigest,
      }),
    ).rejects.toThrow(/Privacy erasure changed/);
    expect(await repository.get(fixtureData.watchId)).toEqual(before);
  });

  it('rejects a same-sender watch whose token appears only in a quoted external span', async () => {
    const fixtureData = await fixture('quoted-token');
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    const repository = new FirestoreApplicationConfirmationRepository(
      fixtureStore,
      fixtureData.agentId,
    );
    const before = await repository.get(fixtureData.secondWatchId);
    await expect(
      repository.claim(fixtureData.secondWatchId, {
        confirmationMessageId: fixtureData.channelMessageId,
        confirmationFrom: 'sender@example.test',
        now: new Date(),
        emailObserverEffectFence: fixtureData.fence,
        confirmationTokenHash: fixtureData.externalTokenHash,
        sourceDigest: fixtureData.sourceDigest,
      }),
    ).resolves.toBeNull();
    expect(await repository.get(fixtureData.secondWatchId)).toEqual(before);
  });

  it('rejects a same-sender watch whose token is absent from the canonical source', async () => {
    const fixtureData = await fixture('absent-token');
    const fixtureStore = store;
    if (!fixtureStore) throw new Error('Firestore emulator store is unavailable');
    const repository = new FirestoreApplicationConfirmationRepository(
      fixtureStore,
      fixtureData.agentId,
    );
    const before = await repository.get(fixtureData.absentWatchId);
    await expect(
      repository.claim(fixtureData.absentWatchId, {
        confirmationMessageId: fixtureData.channelMessageId,
        confirmationFrom: 'sender@example.test',
        now: new Date(),
        emailObserverEffectFence: fixtureData.fence,
        confirmationTokenHash: fixtureData.absentTokenHash,
        sourceDigest: fixtureData.sourceDigest,
      }),
    ).resolves.toBeNull();
    expect(await repository.get(fixtureData.absentWatchId)).toEqual(before);
  });
});
