import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  EXECUTION_JOB_CALLBACK_STATES,
  type ExecutionJobCallbackDecision,
  type ExecutionJobCallbackInput,
  type ExecutionJobCallbackOutcome,
  type ExecutionJobInput,
  type ExecutionJobRepository,
  type ExecutionJobSettleResult,
  type Records,
  type TaskLease,
} from '@assistant/persistence';
import { createWakeIntent } from './outbox.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/** Artifact rows one callback transaction inventories before it fails explicitly. */
const CALLBACK_FILE_LIMIT = 400;

const PENDING_KINDS = new Set([
  'browser_job_pending',
  'code_job_pending',
  'document_job_pending',
  'call_pending',
]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

function live(row: Records['tasks'], lease: TaskLease, now: Date) {
  return (
    row.id === lease.id &&
    row.agentId === lease.agentId &&
    row.status === 'running' &&
    typeof lease.leaseToken === 'string' &&
    lease.leaseToken.length > 0 &&
    row.leaseToken === lease.leaseToken &&
    row.lockedUntil instanceof Date &&
    Number.isFinite(row.lockedUntil.getTime()) &&
    row.lockedUntil.getTime() > now.getTime()
  );
}
function pending(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const value = result as { pending?: unknown; callbackToken?: unknown; timeoutAt?: unknown };
  return (
    typeof value.pending === 'string' &&
    PENDING_KINDS.has(value.pending) &&
    typeof value.callbackToken === 'string' &&
    SHA256_HEX.test(value.callbackToken) &&
    typeof value.timeoutAt === 'string'
  );
}

function assertInputLease(input: ExecutionJobInput, lease: TaskLease): void {
  if (input.taskId !== lease.id) throw new Error('execution job task does not match lease');
  if (!pending(input.pending)) throw new Error('execution job sentinel is invalid');
}

function validTimeout(timeoutAt: Date): void {
  if (!(timeoutAt instanceof Date) || !Number.isFinite(timeoutAt.getTime()))
    throw new Error('execution job timeout is invalid');
}

export class FirestoreExecutionJobRepository implements ExecutionJobRepository {
  readonly kind = 'execution-job-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async loadToolCall(agentId: string, taskId: string, toolCallId: string) {
    const snapshots = await this.store.db.getAll(
      this.store.doc('tasks', taskId),
      this.store.doc('toolCalls', toolCallId),
    );
    const taskSnapshot = snapshots[0];
    const toolSnapshot = snapshots[1];
    if (!taskSnapshot?.exists || !toolSnapshot?.exists) return null;
    const task = decodeRecord<Records['tasks']>(taskSnapshot.data());
    const tool = decodeRecord<Records['toolCalls']>(toolSnapshot.data());
    return task.id === taskId &&
      task.agentId === agentId &&
      tool.id === toolCallId &&
      tool.taskId === taskId
      ? tool
      : null;
  }

  async listPendingApprovals(agentId: string, taskId: string, approvalIds: string[]) {
    if (approvalIds.length === 0) return [];
    const uniqueIds = [...new Set(approvalIds)];
    const snapshots = await this.store.db.getAll(
      this.store.doc('tasks', taskId),
      ...uniqueIds.map((id) => this.store.doc('approvals', id)),
    );
    const taskSnapshot = snapshots[0];
    if (!taskSnapshot?.exists) return [];
    const task = decodeRecord<Records['tasks']>(taskSnapshot.data());
    if (task.id !== taskId || task.agentId !== agentId) return [];
    return snapshots.slice(1).flatMap((snapshot, index) => {
      if (!snapshot?.exists) return [];
      const approval = decodeRecord<Records['approvals']>(snapshot.data());
      return approval.id === uniqueIds[index] && approval.taskId === taskId ? [approval] : [];
    });
  }

  async stage(input: ExecutionJobInput, lease: TaskLease) {
    assertInputLease(input, lease);
    await this.store.db.runTransaction(async (tx) => {
      const taskRef = this.store.doc('tasks', lease.id);
      const toolRef = this.store.doc('toolCalls', input.toolCallId);
      const snapshots = await tx.getAll(taskRef, toolRef);
      const task = snapshots[0];
      const tool = snapshots[1];
      const now = this.store.now();
      if (!task?.exists || !live(decodeRecord<Records['tasks']>(task.data()), lease, now))
        throw new Error('task lease lost while staging execution job');
      if (!tool?.exists) throw new Error('execution tool call cannot be staged');
      const toolRow = decodeRecord<Records['toolCalls']>(tool.data());
      if (
        toolRow.id !== input.toolCallId ||
        toolRow.taskId !== input.taskId ||
        toolRow.status !== 'executing' ||
        (toolRow.result !== null && !isDeepStrictEqual(toolRow.result, input.pending))
      )
        throw new Error('execution tool call cannot be staged');
      tx.update(toolRef, encodeRecord({ result: input.pending }));
      tx.update(
        taskRef,
        encodeRecord({
          state: input.checkpointState,
          attempt: 0,
          reclaimCount: 0,
          updatedAt: now,
        }),
      );
    });
  }
  async clear(input: ExecutionJobInput, lease: TaskLease) {
    assertInputLease(input, lease);
    await this.store.db.runTransaction(async (tx) => {
      const taskRef = this.store.doc('tasks', lease.id);
      const toolRef = this.store.doc('toolCalls', input.toolCallId);
      const snapshots = await tx.getAll(taskRef, toolRef);
      const task = snapshots[0];
      const tool = snapshots[1];
      const now = this.store.now();
      if (!task?.exists || !live(decodeRecord<Records['tasks']>(task.data()), lease, now))
        throw new Error('task lease lost while clearing execution job');
      if (!tool?.exists) throw new Error('execution tool call cannot be cleared');
      const toolRow = decodeRecord<Records['toolCalls']>(tool.data());
      if (
        toolRow.id !== input.toolCallId ||
        toolRow.taskId !== input.taskId ||
        toolRow.status !== 'executing' ||
        !isDeepStrictEqual(toolRow.result, input.pending)
      )
        throw new Error('execution tool call cannot be cleared');
      tx.update(toolRef, { result: null });
      tx.update(
        taskRef,
        encodeRecord({
          state: input.checkpointState,
          attempt: 0,
          reclaimCount: 0,
          updatedAt: now,
        }),
      );
    });
  }
  async settle(
    input: { taskId: string; toolCallId: string; timeoutAt: Date },
    lease: TaskLease,
  ): Promise<ExecutionJobSettleResult> {
    if (input.taskId !== lease.id) return { kind: 'stale' };
    validTimeout(input.timeoutAt);
    return this.store.db.runTransaction(async (tx) => {
      const taskRef = this.store.doc('tasks', lease.id);
      const toolRef = this.store.doc('toolCalls', input.toolCallId);
      const snapshots = await tx.getAll(taskRef, toolRef);
      const task = snapshots[0];
      const tool = snapshots[1];
      const now = this.store.now();
      if (
        !task?.exists ||
        !tool?.exists ||
        !live(decodeRecord<Records['tasks']>(task.data()), lease, now)
      )
        return { kind: 'stale' };
      const toolRow = decodeRecord<Records['toolCalls']>(tool.data());
      if (toolRow.id !== input.toolCallId || toolRow.taskId !== input.taskId)
        return { kind: 'stale' };
      const result = toolRow.result;
      if (!pending(result))
        return {
          kind: 'result',
          id: input.toolCallId,
          result,
          startedAt: (toolRow.startedAt as Date | null) ?? null,
          decision: toolRow.decision,
        };
      if (toolRow.status !== 'executing' && toolRow.status !== 'succeeded')
        return { kind: 'stale' };
      if (now.getTime() < input.timeoutAt.getTime()) return { kind: 'still_pending' };
      const failure = {
        ok: false as const,
        error: 'the background job never reported back (timed out) — treat this attempt as failed',
      };
      tx.update(
        toolRef,
        encodeRecord({
          status: 'failed',
          result: failure,
          error: failure.error,
          finishedAt: now,
        }),
      );
      return {
        kind: 'timeout',
        id: input.toolCallId,
        failure,
        startedAt: (toolRow.startedAt as Date | null) ?? null,
        decision: toolRow.decision,
      };
    });
  }

  async recordCallback(
    input: ExecutionJobCallbackInput,
    decide: (task: Records['tasks'] | null) => ExecutionJobCallbackDecision,
  ): Promise<ExecutionJobCallbackOutcome> {
    if (input.files.length > CALLBACK_FILE_LIMIT)
      throw new Error('Job reported more artifacts than one callback records');
    return this.store.db.runTransaction(async (tx): Promise<ExecutionJobCallbackOutcome> => {
      // The executor's settle reads this task and tool call in its own
      // transaction, so whichever commits first wins and the other retries
      // against the committed state: a result recorded here is never
      // overwritten by a timeout, and a settled timeout is never revived.
      const taskRef = this.store.doc('tasks', input.taskId);
      const receiptRef = input.idempotencyKey
        ? this.store.doc('executionJobCallbackReceipts', input.idempotencyKey)
        : null;
      if (input.idempotencyKey && (!input.tokenHash || !input.payloadDigest))
        throw new Error('idempotent callback identity is incomplete');
      const snapshots = receiptRef
        ? await tx.getAll(receiptRef, taskRef)
        : [null, await tx.get(taskRef)];
      const receipt = snapshots[0];
      const snapshot = snapshots[1];
      if (!snapshot) throw new Error('execution callback task snapshot is missing');
      if (receipt?.exists) {
        if (
          receipt.get('taskId') !== input.taskId ||
          receipt.get('tokenHash') !== input.tokenHash ||
          receipt.get('payloadDigest') !== input.payloadDigest
        )
          return {
            ok: false,
            status: 409,
            error: 'callback identity was already used for different content',
          };
        return {
          ok: true,
          taskId: input.taskId,
          queueGeneration: Number(receipt.get('queueGeneration')),
          replayed: true,
        };
      }
      const task = snapshot.exists ? decodeRecord<Records['tasks']>(snapshot.data()) : null;
      const owned =
        task !== null && task.id === input.taskId && documentKey(task.id) === snapshot.id;
      const decision = decide(owned ? task : null);
      if (!decision.accept) return { ok: false, status: decision.status, error: decision.error };
      if (!owned || !task) throw new Error('execution job callback accepted a missing task');
      if (!EXECUTION_JOB_CALLBACK_STATES.includes(task.status))
        return { ok: false, status: 409, error: 'task is no longer waiting for this callback' };
      const generation = task.queueGeneration + 1;
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new Error('Invalid task queue generation');
      const toolRef = this.store.doc('toolCalls', decision.toolCallId);
      const tool = await tx.get(toolRef);
      const now = this.store.now();
      if (tool.exists && tool.get('id') === decision.toolCallId && tool.get('taskId') === task.id)
        tx.update(
          toolRef,
          encodeRecord({ status: 'succeeded', result: input.result, finishedAt: now }),
        );
      for (const file of input.files) {
        const id = randomUUID();
        tx.create(
          this.store.doc('files', id),
          encodeRecord({
            id,
            createdAt: now,
            agentId: task.agentId,
            taskId: task.id,
            workspacePath: file.workspacePath,
            mime: file.mime,
            bytes: 0,
            sha256: null,
          }),
        );
      }
      // Moving a running task to pending fences out the launching run's lease.
      tx.update(taskRef, {
        status: 'pending',
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: generation,
        updatedAt: now,
      });
      createWakeIntent(tx, this.store, { taskId: task.id, generation, availableAt: now });
      if (receiptRef && input.tokenHash && input.payloadDigest)
        tx.create(
          receiptRef,
          encodeRecord({
            idempotencyKey: input.idempotencyKey,
            taskId: task.id,
            tokenHash: input.tokenHash,
            payloadDigest: input.payloadDigest,
            queueGeneration: generation,
            createdAt: now,
          }),
        );
      return { ok: true, taskId: task.id, queueGeneration: generation };
    });
  }
}
