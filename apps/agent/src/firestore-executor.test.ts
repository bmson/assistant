import { type ExecutorDeps, executeTask, TaskStateSchema } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import { finalChannelDelivery } from '@assistant/persistence';
import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { firestoreExecutorSmoke } from '../../../scripts/firestore-executor-smoke.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore executor recovery composition',
  () => {
    let store: InstallationStore;
    let deps: ExecutorDeps;
    beforeEach(async () => {
      store = emulatorStore();
      // Any unmigrated SQL/model/tool path is an immediate failure in this recovery test.
      const unavailable = new Proxy(
        {},
        {
          get: (_target, property) => {
            throw new Error(`Unexpected dependency access: ${String(property)}`);
          },
        },
      );
      deps = {
        db: unavailable as Db,
        router: unavailable as ExecutorDeps['router'],
        dispatcher: unavailable as ExecutorDeps['dispatcher'],
        persistence: createFirestoreExecutionPersistence(store, 'agent', {
          provider: 'synthetic',
          model: 'recovery-fixture',
          dimensions: 1536,
          revision: '1',
        }),
      };
      await store
        .doc('conversations', 'chat')
        .set({ id: 'chat', agentId: 'agent', channel: 'chat' });
    });
    afterEach(async () => {
      await disposeStore(store);
    });

    async function pendingFinalTask() {
      const task = taskFixture({
        id: 'task',
        agentId: 'agent',
        conversationId: 'chat',
        reminderId: '',
      });
      task.trigger = {};
      task.state = TaskStateSchema.parse({
        pendingFinal: {
          text: 'Verified response',
          progress: 'Completed',
          terminalStatus: 'done',
          outcome: 'done',
        },
      });
      await store.doc('tasks', task.id).set(task);
      return task;
    }

    it('exercises the same scoped queries and recovery workload as live validation', async () => {
      expect(await firestoreExecutorSmoke(store)).toMatchObject({ finalized: true, delivered: 1 });
    });

    it('resumes a durable final response and completes without PostgreSQL or another model call', async () => {
      const task = await pendingFinalTask();
      const deliver = vi.fn(async (_task, _text, attemptId) =>
        finalChannelDelivery('dashboard', 'accepted', attemptId),
      );
      deps.deliverFinal = deliver;
      expect(await executeTask(deps, task.id)).toEqual({ outcome: 'done', detail: 'Completed' });
      expect(deliver).toHaveBeenCalledOnce();
      expect((await store.doc('tasks', task.id).get()).get('status')).toBe('done');
      expect((await store.collection('messages').get()).size).toBe(1);
      expect((await store.collection('responseChecks').get()).size).toBe(1);
      expect(await executeTask(deps, task.id)).toEqual({ outcome: 'not_claimable' });
      expect(deliver).toHaveBeenCalledOnce();
    });

    it('answers save-status questions from prior Firestore receipts with PostgreSQL unreachable', async () => {
      const previous = taskFixture({
        id: 'prior-owner-turn',
        agentId: 'agent',
        conversationId: 'chat',
        reminderId: '',
      });
      previous.type = 'chat_turn';
      previous.status = 'done';
      previous.createdAt = new Date(Date.now() - 60_000);
      previous.trigger = { payload: { text: 'Remember our new order is two cheese pupusas.' } };
      const current = taskFixture({
        id: 'save-status-turn',
        agentId: 'agent',
        conversationId: 'chat',
        reminderId: '',
      });
      current.type = 'chat_turn';
      current.createdAt = new Date();
      current.trigger = { payload: { text: 'Was it saved to long term memory?' } };
      current.state = {};
      await store.doc('agents', 'agent').set({ id: 'agent', name: 'Synthetic owner' });
      await store.doc('tasks', previous.id).set(previous);
      await store.doc('toolCalls', 'prior-save').set({
        id: 'prior-save',
        createdAt: previous.createdAt,
        status: 'succeeded',
        taskId: previous.id,
        startedAt: previous.createdAt,
        step: 1,
        toolName: 'memory.save',
        args: { content: 'Our order is two cheese pupusas.' },
        risk: 'low',
        idempotencyKey: null,
        result: { saved: true },
        error: null,
        approvalId: null,
        decision: null,
        finishedAt: previous.createdAt,
      });
      await store.doc('tasks', current.id).set(current);

      const result = await executeTask(deps, current.id);
      expect(result).toMatchObject({ outcome: 'done' });
      expect(result.detail).toContain('Our order is two cheese pupusas.');
      expect((await store.doc('tasks', current.id).get()).get('status')).toBe('done');
    });

    it('reads a renewed request after a prior failed Firestore document call', async () => {
      const url = 'Please read https://docs.google.com/document/d/doc-1234567890/edit';
      const previous = taskFixture({
        id: 'prior-doc-turn',
        agentId: 'agent',
        conversationId: 'chat',
        reminderId: '',
      });
      previous.type = 'chat_turn';
      previous.status = 'done';
      previous.createdAt = new Date(Date.now() - 60_000);
      previous.trigger = { payload: { text: url } };
      const current = taskFixture({
        id: 'doc-followup-turn',
        agentId: 'agent',
        conversationId: 'chat',
        reminderId: '',
      });
      current.type = 'chat_turn';
      current.trigger = { payload: { text: url } };
      current.plan = {
        action: 'reply',
        reasoning: 'Answer the owner about the supplied document.',
        steps: [],
        missingInfo: [],
      };
      current.state = TaskStateSchema.parse({
        contextWindow: [{ role: 'user', content: url }],
      });
      await store.doc('agents', 'agent').set({ id: 'agent', name: 'Synthetic owner' });
      await store.doc('tasks', previous.id).set(previous);
      await store.doc('toolCalls', 'prior-doc-read').set({
        id: 'prior-doc-read',
        createdAt: previous.createdAt,
        status: 'failed',
        taskId: previous.id,
        startedAt: previous.createdAt,
        step: 1,
        toolName: 'docs.get',
        args: { documentId: 'doc-1234567890' },
        risk: 'low',
        idempotencyKey: null,
        result: null,
        error: 'permission denied',
        approvalId: null,
        decision: null,
        finishedAt: previous.createdAt,
      });
      await store.doc('tasks', current.id).set(current);
      const step = vi.fn().mockResolvedValue({
        ok: true,
        modelId: 'fixture-model',
        degraded: false,
        text: 'I can help with that document.',
        toolCalls: [],
      });
      deps.router = {
        step,
        embed: vi.fn().mockResolvedValue([new Array(1536).fill(0)]),
      } as unknown as ExecutorDeps['router'];
      const dispatch = vi.fn().mockResolvedValue({
        kind: 'executed',
        toolCallId: 'current-doc-read',
        result: { title: 'Current version', content: 'Updated owner document' },
      });
      deps.dispatcher = {
        toolDefs: () => [],
        resultIsUntrusted: () => false,
        dispatch,
        executeApproved: vi.fn(),
      } as unknown as ExecutorDeps['dispatcher'];

      const result = await executeTask(deps, current.id);
      expect(result).toMatchObject({ outcome: 'done' });
      expect(step).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          task: expect.objectContaining({ id: current.id }),
          toolName: 'docs.get',
          args: { documentId: 'doc-1234567890' },
        }),
      );
    });

    it('reuses the persisted message after a definitive delivery rejection', async () => {
      const task = await pendingFinalTask();
      let attempts = 0;
      deps.deliverFinal = vi.fn(async (_task, _text, attemptId) => {
        attempts += 1;
        return attempts === 1
          ? finalChannelDelivery('dashboard', 'rejected', attemptId, 'provider-rejected')
          : finalChannelDelivery('dashboard', 'accepted', attemptId);
      });
      expect((await executeTask(deps, task.id)).outcome).toBe('needs_attention');
      expect((await store.collection('messages').get()).size).toBe(1);
      await store.doc('tasks', task.id).update({ status: 'pending', runAfter: new Date(0) });
      expect((await executeTask(deps, task.id)).outcome).toBe('done');
      expect(deps.deliverFinal).toHaveBeenCalledTimes(2);
      expect((await store.collection('messages').get()).size).toBe(1);
      expect((await store.collection('responseChecks').get()).size).toBe(1);
    });

    it('refuses to append a final response into another agent conversation', async () => {
      const task = await pendingFinalTask();
      await store
        .doc('conversations', 'foreign-chat')
        .set({ id: 'foreign-chat', agentId: 'other', channel: 'chat' });
      await store.doc('tasks', task.id).update({ conversationId: 'foreign-chat' });

      expect((await executeTask(deps, task.id)).outcome).toBe('failed');
      expect((await store.collection('messages').get()).empty).toBe(true);
      expect((await store.doc('tasks', task.id).get()).get('status')).toBe('sleeping');
    });

    it('parks approved work on its budget while preserving the pending action', async () => {
      const task = await pendingFinalTask();
      await store.doc('agents', 'agent').set({ id: 'agent', name: 'Synthetic owner' });
      await store.doc('tasks', task.id).update({
        state: TaskStateSchema.parse({
          step: 1,
          contextWindow: [{ role: 'user', content: 'Continue' }],
          pendingApprovals: [
            {
              approvalId: 'approval',
              dbToolCallId: 'call',
              toolCallId: 'model-call',
              toolName: 'synthetic.action',
            },
          ],
        }),
      });
      await store
        .doc('approvals', 'approval')
        .set({ id: 'approval', taskId: task.id, toolCallId: 'call', status: 'approved' });
      const executeApproved = vi.fn(async () => ({
        kind: 'budget_blocked' as const,
        reason: 'daily cap',
        resumeAt: new Date(Date.now() + 60_000),
      }));
      deps.dispatcher = { executeApproved } as unknown as ExecutorDeps['dispatcher'];
      expect((await executeTask(deps, task.id)).outcome).toBe('parked');
      expect(executeApproved).toHaveBeenCalledOnce();
      const row = await store.doc('tasks', task.id).get();
      expect(row.get('status')).toBe('waiting_budget');
      expect(row.get('state').pendingApprovals).toHaveLength(1);
      expect((await store.collection('messages').get()).size).toBe(1);
    });

    it('never executes an approval referenced from a different task', async () => {
      const task = await pendingFinalTask();
      await store.doc('agents', 'agent').set({ id: 'agent', name: 'Synthetic owner' });
      await store.doc('tasks', task.id).update({
        state: TaskStateSchema.parse({
          step: 1,
          contextWindow: [{ role: 'user', content: 'Continue' }],
          pendingApprovals: [
            {
              approvalId: 'foreign-approval',
              dbToolCallId: 'call',
              toolCallId: 'model-call',
              toolName: 'synthetic.action',
            },
          ],
        }),
      });
      await store.doc('approvals', 'foreign-approval').set({
        id: 'foreign-approval',
        taskId: 'other-task',
        toolCallId: 'call',
        status: 'approved',
      });
      const executeApproved = vi.fn();
      deps.dispatcher = { executeApproved } as unknown as ExecutorDeps['dispatcher'];
      expect((await executeTask(deps, task.id)).outcome).toBe('parked');
      expect(executeApproved).not.toHaveBeenCalled();
      expect((await store.doc('tasks', task.id).get()).get('status')).toBe('waiting_approval');
    });

    it('cancels queued work for an abandoned goal before loading model or tool dependencies', async () => {
      const task = await pendingFinalTask();
      await store
        .doc('goals', 'goal')
        .set({ id: 'goal', agentId: 'agent', status: 'abandoned', archivedAt: null });
      await store.doc('tasks', task.id).update({ goalId: 'goal' });
      expect(await executeTask(deps, task.id)).toEqual({
        outcome: 'cancelled',
        detail: 'goal stopped',
      });
      expect((await store.doc('tasks', task.id).get()).get('status')).toBe('cancelled');
      expect((await store.collection('messages').get()).empty).toBe(true);
    });
  },
);
