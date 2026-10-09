import {
  FirestoreApprovalRepository,
  FirestoreExecutionJobRepository,
  FirestoreMessageRepository,
  FirestoreTaskRepository,
} from '@assistant/firestore';
import { taskFixture } from '@assistant/persistence/testing';
import { Firestore } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';
import { InstallationStore } from '../../../../firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../../firestore/src/test-store.js';
import { taskState } from '../machine.js';
import { type RunContext, resumePendingApprovals } from './phases.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore parked approval recovery contract',
  () => {
    it('recovers a real budget checkpoint and approval park without repeating the delivered receipt', async () => {
      let store = emulatorStore();
      try {
        let repository = new FirestoreTaskRepository(store);
        const task = {
          ...taskFixture({
            id: 'task',
            agentId: 'owner',
            conversationId: 'conversation',
            reminderId: '',
          }),
          type: 'chat_turn',
        };
        await store.doc('tasks', task.id).set(task);
        await store
          .doc('conversations', 'conversation')
          .set({ id: 'conversation', agentId: 'owner', channel: 'chat', trust: 'owner' });
        await store.doc('toolCalls', 'tool').set({
          id: 'tool',
          taskId: task.id,
          toolName: 'gmail.send',
          args: { to: 'person@example.com' },
          status: 'awaiting_approval',
          step: 0,
          risk: 'approval',
        });
        await store.doc('approvals', 'approval').set({
          id: 'approval',
          taskId: task.id,
          toolCallId: 'tool',
          shortCode: 'A7',
          summary: 'Send exact reply',
          payload: { to: 'person@example.com' },
          status: 'pending',
          expiresAt: new Date(Date.now() + 60000),
          notifiedChannels: [],
        });
        const pending = [
          {
            approvalId: 'approval',
            toolCallId: 'model-call',
            dbToolCallId: 'tool',
            toolName: 'gmail.send',
          },
        ];
        const firstLease = await repository.claim(task.id);
        if (!firstLease) throw new Error('Missing initial lease');
        const checkpoint = JSON.parse(
          JSON.stringify({
            pendingApprovals: pending,
            completedToolCallIds: [],
            contextWindow: [],
            plannerState: { phase: 'waiting_budget' },
          }),
        );
        expect(
          await repository.parkForBudget(firstLease, checkpoint, new Date(Date.now() - 1000)),
        ).toBe(true);

        // Simulate fresh-client recovery after the durable checkpoint by terminating the
        // SDK client, then reconnecting to the same isolated installation.
        const installationId = store.installationId;
        await store.db.terminate();
        store = new InstallationStore(
          new Firestore({ projectId: 'demo-assistant-test', databaseId: '(default)' }),
          installationId,
        );
        repository = new FirestoreTaskRepository(store);

        const lease = await repository.claim(task.id);
        if (!lease) throw new Error('Missing resumed lease');
        const notifyApproval = vi.fn(async () => {});
        const context = {
          deps: {
            notifyApproval,
            persistence: {
              tasks: repository,
              executionJobs: new FirestoreExecutionJobRepository(store),
              approvals: new FirestoreApprovalRepository(store),
              messages: new FirestoreMessageRepository(store),
            },
          },
          task: lease,
          state: taskState(lease),
          window: [],
          dispatcher: {},
          ctx: {},
        } as unknown as RunContext;
        expect(await resumePendingApprovals(context)).toEqual({
          outcome: 'parked',
          detail: 'still waiting on approvals',
        });
        expect(notifyApproval).toHaveBeenCalledOnce();
        const parked = await repository.getTask(task.id);
        expect(parked?.status).toBe('waiting_approval');
        expect(parked?.lockedUntil).toBeNull();
        expect(parked && taskState(parked).pendingApprovals).toEqual(pending);
        await repository.wakeTask(task.id);
        const next = await repository.claim(task.id);
        if (!next) throw new Error('Missing recovery lease');
        context.task = next;
        context.state = taskState(next);
        expect(await resumePendingApprovals(context)).toEqual({
          outcome: 'parked',
          detail: 'still waiting on approvals',
        });
        expect(notifyApproval).toHaveBeenCalledOnce();
        expect((await store.collection('messages').get()).size).toBe(1);
        expect((await store.doc('approvals', 'approval').get()).get('notifiedChannels')).toEqual(
          expect.arrayContaining(['conversation', 'owner']),
        );
      } finally {
        await disposeStore(store);
      }
    });
  },
);
