import { randomUUID } from 'node:crypto';
import { getChatConversationView } from '@assistant/application/chat';
import { renotifyStalledApprovals } from '@assistant/core/workflow/approvals';
import {
  createInstallationStore,
  FirestoreApplicationChatPersistence,
  FirestoreApprovalRepository,
  FirestoreMessageRepository,
  FirestoreTaskRepository,
  type InstallationStore,
} from '@assistant/firestore';
import { CHAT_ADMISSION_PROTOCOL, chatAdmissionExternalEventId } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firestoreApprovalSmoke } from '../../../scripts/firestore-approval-smoke.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore approval maintenance', () => {
  let store: InstallationStore;

  beforeEach(() => {
    vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? ''))
      throw new Error('Requires a loopback emulator');
    store = createInstallationStore({
      projectId: 'demo-assistant-test',
      installationId: `test-${randomUUID()}`,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
  });

  it('rehearses approval creation, notices, expiry and pre-park recovery', async () => {
    const report = await firestoreApprovalSmoke(store);
    expect(report).toMatchObject({
      approvalInbox: 'passed',
      policyManagement: 'passed',
      approvalCreation: 'passed',
      notificationRepair: 'passed',
      approvalExpiry: 'passed',
      preParkRecovery: 'passed',
      generationFences: 'passed',
      durableWakeIntents: 'passed',
    });
  }, 60_000);

  it('reconciles repaired approval cards only to their verified chat operation', async () => {
    const agentId = randomUUID();
    await store.doc('agents', agentId).set({
      id: agentId,
      name: 'Synthetic approval owner',
      email: 'approval@example.test',
      timezone: 'UTC',
    });
    const chat = new FirestoreApplicationChatPersistence(store, agentId);
    const conversation = await chat.createConversation(agentId);
    const approvalStore = {
      approvals: new FirestoreApprovalRepository(store),
      messages: new FirestoreMessageRepository(store),
    };
    const tasks = new FirestoreTaskRepository(store);

    async function parkedApproval(clientOperationId?: string) {
      const triggerMessageId = randomUUID();
      const { task } = await tasks.createTask({
        agentId,
        conversationId: conversation.id,
        type: 'chat_turn',
        trust: 'owner',
        ...(clientOperationId
          ? {
              externalEventId: chatAdmissionExternalEventId({
                agentId,
                conversationId: conversation.id,
                clientOperationId,
              }),
            }
          : {}),
        trigger: {
          source: 'chat',
          payload: {
            triggerMessageId,
            ...(clientOperationId
              ? {
                  chatAdmission: {
                    protocol: CHAT_ADMISSION_PROTOCOL,
                    requestHash: 'synthetic',
                    phase: 'queued',
                    clientOperationId,
                    triggerMessageId,
                  },
                }
              : {}),
          },
        },
      });
      const lease = await tasks.claim(task.id, task.queueGeneration);
      if (!lease) throw new Error('Expected a synthetic task lease');
      const approval = await approvalStore.approvals.create({
        taskId: task.id,
        step: 0,
        toolName: 'synthetic.action',
        args: {},
        decision: { source: 'synthetic' },
        summary: 'Synthetic pending decision',
      });
      await store.doc('approvals', approval.approvalId).update({
        requestedAt: new Date(Date.now() - 600_000),
      });
      expect(await tasks.parkForApproval(lease, { phase: 'execute' }, [approval])).toBe(true);
      return { taskId: task.id, triggerMessageId, approvalId: approval.approvalId };
    }

    const operation = randomUUID();
    const current = await parkedApproval(operation);
    const legacy = await parkedApproval();
    expect(await renotifyStalledApprovals(approvalStore)).toBe(2);
    const view = await getChatConversationView(chat, conversation.id, {});
    expect(view?.messages).toHaveLength(2);
    const currentReply = view?.messages.find(
      (message) => (message.metadata as { taskId?: string } | undefined)?.taskId === current.taskId,
    );
    const legacyReply = view?.messages.find(
      (message) => (message.metadata as { taskId?: string } | undefined)?.taskId === legacy.taskId,
    );
    expect(currentReply).toMatchObject({
      metadata: {
        taskId: current.taskId,
        triggerMessageId: current.triggerMessageId,
        clientOperationId: operation,
      },
      parts: [
        expect.objectContaining({
          type: 'approval',
          approvalId: current.approvalId,
          status: 'pending',
        }),
      ],
    });
    expect(legacyReply?.metadata).toMatchObject({
      taskId: legacy.taskId,
      triggerMessageId: legacy.triggerMessageId,
    });
    expect(legacyReply?.metadata).not.toHaveProperty('clientOperationId');
    expect(await renotifyStalledApprovals(approvalStore)).toBe(0);
  });
});
