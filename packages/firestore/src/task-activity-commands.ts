import { randomUUID } from 'node:crypto';
import type {
  ArchiveOldActivityProgress,
  TaskActivityCommandOutcome,
  TaskActivityCommandRepository,
  TaskActivityCurrentState,
} from '@assistant/persistence';
import {
  isChatAdmissionCancellationProjection,
  normalizeTaskBudget,
  taskActivityOutcome,
} from '@assistant/persistence';
import {
  type DocumentReference,
  type DocumentSnapshot,
  FieldPath,
  type QueryDocumentSnapshot,
  type Transaction,
} from '@google-cloud/firestore';
import { createWakeIntent } from './outbox.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const WAKEABLE = new Set([
  'waiting_approval',
  'waiting_event',
  'sleeping',
  'waiting_budget',
  'needs_attention',
]);
const ARCHIVE_BATCH_SIZE = 250;
const ARCHIVE_OPERATION_COLLECTION = 'taskActivityArchiveRuns';

function currentTask(task: Record<string, unknown>): TaskActivityCurrentState {
  if (typeof task.id !== 'string' || typeof task.status !== 'string')
    throw new Error('Invalid activity task');
  const generation = task.queueGeneration;
  if (
    generation !== undefined &&
    generation !== null &&
    (!Number.isSafeInteger(generation) || Number(generation) < 0)
  )
    throw new Error('Invalid activity task');
  const archivedAt = task.archivedAt;
  if (
    archivedAt !== undefined &&
    archivedAt !== null &&
    (!(archivedAt instanceof Date) || !Number.isFinite(archivedAt.getTime()))
  )
    throw new Error('Invalid activity task');
  const grant = task.autonomyGrant;
  if (grant !== undefined && grant !== null && (typeof grant !== 'object' || Array.isArray(grant)))
    throw new Error('Invalid activity task');
  const revoked = (grant as Record<string, unknown> | null | undefined)?.revokedAt;
  return {
    id: task.id,
    status: task.status,
    queueGeneration: generation === undefined || generation === null ? null : Number(generation),
    archivedAt: archivedAt instanceof Date ? archivedAt.toISOString() : null,
    budgetUsdLimit: typeof task.budgetUsdLimit === 'string' ? task.budgetUsdLimit : null,
    autonomyRevoked: typeof revoked === 'string' && revoked.length > 0,
  };
}

function withCurrent(
  task: Record<string, unknown>,
  patch: Partial<TaskActivityCurrentState>,
  outcome: Parameters<typeof taskActivityOutcome>[0],
  transitioned = false,
): TaskActivityCommandOutcome {
  return taskActivityOutcome(outcome, { ...currentTask(task), ...patch }, transitioned);
}

interface ArchiveRun {
  operationId: string;
  agentId: string;
  cutoff: Date;
  cursorId: string | null;
  scannedTotal: number;
  archivedTotal: number;
  complete: boolean;
}

function archiveRun(value: unknown, agentId: string): ArchiveRun {
  const row = decodeRecord<Record<string, unknown>>(value);
  if (
    row.agentId !== agentId ||
    typeof row.operationId !== 'string' ||
    !row.operationId ||
    !(row.cutoff instanceof Date) ||
    !Number.isFinite(row.cutoff.getTime()) ||
    !(row.cursorId === null || typeof row.cursorId === 'string') ||
    !Number.isSafeInteger(row.scannedTotal) ||
    Number(row.scannedTotal) < 0 ||
    !Number.isSafeInteger(row.archivedTotal) ||
    Number(row.archivedTotal) < 0 ||
    typeof row.complete !== 'boolean'
  )
    throw new Error('Invalid archive-old activity progress');
  return row as unknown as ArchiveRun;
}

function progress(
  run: ArchiveRun,
  scannedThisBatch: number,
  archivedThisBatch: number,
): ArchiveOldActivityProgress {
  return {
    operationId: run.operationId,
    scannedThisBatch,
    archivedThisBatch,
    scannedTotal: run.scannedTotal,
    archivedTotal: run.archivedTotal,
    complete: run.complete,
  };
}

function isTerminalArchiveCandidate(
  document: DocumentSnapshot | QueryDocumentSnapshot,
  agentId: string,
  cutoff: Date,
): boolean {
  const data = document.data();
  if (!document.exists || !data) return false;
  const task = decodeRecord<Record<string, unknown>>(data);
  if (
    task.agentId !== agentId ||
    typeof task.id !== 'string' ||
    documentKey(task.id) !== document.id ||
    typeof task.status !== 'string' ||
    !(
      task.archivedAt === null ||
      (task.archivedAt instanceof Date && Number.isFinite(task.archivedAt.getTime()))
    ) ||
    !(task.updatedAt instanceof Date) ||
    !Number.isFinite(task.updatedAt.getTime())
  )
    throw new Error('Invalid owner activity task');
  if (isChatAdmissionCancellationProjection(task)) return false;
  return (
    task.archivedAt === null &&
    TERMINAL.has(task.status) &&
    task.updatedAt.getTime() < cutoff.getTime()
  );
}

/** Archives or restores one owned task in the same transaction as its safety checks. */
export class FirestoreTaskActivityCommandRepository implements TaskActivityCommandRepository {
  readonly kind = 'task-activity-command-repository' as const;

  constructor(readonly store: InstallationStore) {}

  archive(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome> {
    return this.change(agentId, taskId, 'archive');
  }

  restore(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome> {
    return this.change(agentId, taskId, 'restore');
  }

  /** Requeue a parked owner task and publish its generation in the same transaction. */
  retry(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome> {
    return this.changeOwnerTask(agentId, taskId, (task, ref, tx) => {
      if (typeof task.status !== 'string') throw new Error('Invalid activity task');
      // This makes client retries idempotent: after the first successful wake,
      // pending is no longer wakeable and cannot increment the generation twice.
      if (!WAKEABLE.has(task.status))
        return withCurrent(
          task,
          {},
          TERMINAL.has(task.status) ? 'already_terminal' : 'no_longer_retriable',
        );
      if (!Number.isSafeInteger(task.queueGeneration) || Number(task.queueGeneration) < 0)
        throw new Error('Invalid activity task');

      const generation = Number(task.queueGeneration) + 1;
      const now = this.store.now();
      const state =
        task.state && typeof task.state === 'object' && !Array.isArray(task.state)
          ? { ...(task.state as Record<string, unknown>) }
          : task.state;
      if (task.status === 'needs_attention' && state && typeof state === 'object')
        delete (state as Record<string, unknown>).pendingFinal;
      tx.update(ref, {
        status: 'pending',
        ...(state === undefined ? {} : { state }),
        runAfter: null,
        lockedUntil: null,
        leaseToken: null,
        queueGeneration: generation,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: now,
      });
      createWakeIntent(tx, this.store, { taskId, generation, availableAt: now });
      return withCurrent(
        task,
        { status: 'pending', queueGeneration: generation, archivedAt: null },
        'retried',
        true,
      );
    });
  }

  /** Cancel an owned non-terminal task; clearing its lease fences any live worker. */
  async cancel(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome> {
    if (!agentId || !taskId) throw new Error('Activity agent and task are required');
    return this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const agent = agents.docs[0];
      if (
        agents.size !== 1 ||
        !agent ||
        agent.id !== documentKey(agentId) ||
        agent.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const ref = this.store.doc('tasks', taskId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== agentId)
        return taskActivityOutcome('not_found', null);
      const task = decodeRecord<Record<string, unknown>>(snapshot.data());
      if (task.id !== taskId || documentKey(taskId) !== snapshot.id)
        throw new Error('Invalid activity task');
      if (typeof task.status !== 'string') throw new Error('Invalid activity task');
      if (isChatAdmissionCancellationProjection(task))
        return taskActivityOutcome('not_found', null);
      if (task.status === 'cancelled') return withCurrent(task, {}, 'already_cancelled');
      if (TERMINAL.has(task.status)) return withCurrent(task, {}, 'already_terminal');
      const current = withCurrent(task, { status: 'cancelled' }, 'cancelled', true);
      tx.update(ref, {
        status: 'cancelled',
        lockedUntil: null,
        leaseToken: null,
        runAfter: null,
        attempt: 0,
        updatedAt: this.store.now(),
      });
      return current;
    });
  }

  revokeAutonomy(agentId: string, taskId: string): Promise<TaskActivityCommandOutcome> {
    return this.changeOwnerTask(agentId, taskId, (task, ref, tx) => {
      const grant = task.autonomyGrant;
      if (grant === null || grant === undefined) return withCurrent(task, {}, 'already_applied');
      if (typeof grant !== 'object' || Array.isArray(grant))
        throw new Error('Invalid task autonomy grant');
      const current = grant as Record<string, unknown>;
      if (current.revokedAt) return withCurrent(task, {}, 'already_applied');
      const now = this.store.now();
      tx.update(ref, {
        autonomyGrant: { ...current, revokedAt: now.toISOString() },
        updatedAt: now,
      });
      return withCurrent(task, { autonomyRevoked: true }, 'autonomy_revoked', true);
    });
  }

  async raiseBudget(
    agentId: string,
    taskId: string,
    limit: number,
  ): Promise<TaskActivityCommandOutcome> {
    if (normalizeTaskBudget(limit, 0.01) === null)
      throw new Error(
        'task budget must be between $0.01 and $9,999.9999 with at most four decimal places',
      );
    return this.changeOwnerTask(agentId, taskId, (task, ref, tx) => {
      if (task.status !== 'needs_attention')
        return withCurrent(
          task,
          {},
          TERMINAL.has(String(task.status)) ? 'already_terminal' : 'no_longer_retriable',
        );
      const currentLimit = Number(task.budgetUsdLimit);
      const spent = Number(task.spentUsd);
      if (
        !Number.isFinite(currentLimit) ||
        !Number.isFinite(spent) ||
        limit <= currentLimit ||
        limit < spent
      )
        return withCurrent(task, {}, 'no_longer_retriable');
      if (!Number.isSafeInteger(task.queueGeneration) || Number(task.queueGeneration) < 0)
        throw new Error('Invalid activity task');

      const now = this.store.now();
      const generation = Number(task.queueGeneration) + 1;
      const state =
        task.state && typeof task.state === 'object' && !Array.isArray(task.state)
          ? { ...(task.state as Record<string, unknown>) }
          : task.state;
      if (state && typeof state === 'object' && !Array.isArray(state))
        delete (state as Record<string, unknown>).pendingFinal;
      const statePatch = state === undefined ? {} : { state };
      tx.update(ref, {
        status: 'pending',
        budgetUsdLimit: limit.toFixed(4),
        ...statePatch,
        runAfter: null,
        lockedUntil: null,
        queueGeneration: generation,
        attempt: 0,
        attentionNotifiedAt: null,
        updatedAt: now,
      });
      createWakeIntent(tx, this.store, { taskId, generation, availableAt: now });
      return withCurrent(
        task,
        {
          status: 'pending',
          queueGeneration: generation,
          budgetUsdLimit: limit.toFixed(4),
          archivedAt: null,
        },
        'budget_raised',
        true,
      );
    });
  }

  async archiveOld(
    agentId: string,
    olderThanDays = 30,
    requestedOperationId?: string,
  ): Promise<ArchiveOldActivityProgress> {
    if (!agentId || !Number.isFinite(olderThanDays) || olderThanDays <= 0)
      throw new Error('Invalid archive-old activity request');
    if (requestedOperationId !== undefined && !/^[0-9a-f-]{36}$/i.test(requestedOperationId))
      throw new Error('Invalid archive-old activity operation');
    const operationRef = this.store.doc(ARCHIVE_OPERATION_COLLECTION, agentId);
    const run = await this.store.db.runTransaction(async (tx): Promise<ArchiveRun> => {
      const ownerQuery = await tx.get(this.store.collection('agents').limit(2));
      const owner = ownerQuery.docs[0];
      if (
        ownerQuery.size !== 1 ||
        !owner ||
        owner.id !== documentKey(agentId) ||
        owner.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');
      const snapshot = await tx.get(operationRef);
      if (snapshot.exists) {
        const current = archiveRun(snapshot.data(), agentId);
        if (requestedOperationId && requestedOperationId !== current.operationId)
          throw new Error('Archive-old activity operation changed; refresh its progress');
        if (!current.complete) return current;
        if (requestedOperationId) return current;
      }
      if (requestedOperationId) throw new Error('Archive-old activity operation was not found');
      const created: ArchiveRun = {
        operationId: randomUUID(),
        agentId,
        cutoff: new Date(this.store.now().getTime() - olderThanDays * 24 * 60 * 60 * 1000),
        cursorId: null,
        scannedTotal: 0,
        archivedTotal: 0,
        complete: false,
      };
      tx.set(operationRef, created);
      return created;
    });

    if (run.complete) return progress(run, 0, 0);

    let query = this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('archivedAt', '==', null)
      .where('status', 'in', [...TERMINAL])
      .select(
        'id',
        'agentId',
        'conversationId',
        'externalEventId',
        'type',
        'trust',
        'trigger',
        'status',
        'archivedAt',
        'updatedAt',
      )
      .orderBy(FieldPath.documentId())
      .limit(ARCHIVE_BATCH_SIZE);
    if (run.cursorId) query = query.startAfter(run.cursorId);
    const page = await query.get();
    const cutoff = run.cutoff;
    const candidates = page.docs.filter((document) =>
      isTerminalArchiveCandidate(document, agentId, cutoff),
    );
    const cursorId = page.docs.at(-1)?.id ?? run.cursorId;
    const complete = page.size < ARCHIVE_BATCH_SIZE;
    const now = this.store.now();

    return this.store.db.runTransaction(async (tx) => {
      const ownerQuery = await tx.get(this.store.collection('agents').limit(2));
      const owner = ownerQuery.docs[0];
      if (
        ownerQuery.size !== 1 ||
        !owner ||
        owner.id !== documentKey(agentId) ||
        owner.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');
      const currentSnapshot = await tx.get(operationRef);
      if (!currentSnapshot.exists) throw new Error('Archive-old activity progress disappeared');
      const current = archiveRun(currentSnapshot.data(), agentId);
      if (current.operationId !== run.operationId)
        throw new Error('Archive-old activity operation changed; refresh its progress');
      if (current.complete) return progress(current, 0, 0);
      if (current.cursorId !== run.cursorId) return progress(current, 0, 0);

      const currentCandidates = await Promise.all(
        candidates.map((document) => tx.get(document.ref)),
      );
      let archivedThisBatch = 0;
      for (const snapshot of currentCandidates) {
        if (!snapshot.exists) continue;
        if (isTerminalArchiveCandidate(snapshot, agentId, cutoff)) {
          tx.update(snapshot.ref, { archivedAt: now, updatedAt: now });
          archivedThisBatch += 1;
        }
      }
      const advanced: ArchiveRun = {
        ...current,
        cursorId,
        scannedTotal: current.scannedTotal + page.size,
        archivedTotal: current.archivedTotal + archivedThisBatch,
        complete,
      };
      tx.set(operationRef, advanced);
      return progress(advanced, page.size, archivedThisBatch);
    });
  }

  private async change(
    agentId: string,
    taskId: string,
    action: 'archive' | 'restore',
  ): Promise<TaskActivityCommandOutcome> {
    if (!agentId || !taskId) throw new Error('Activity agent and task are required');
    return this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const agent = agents.docs[0];
      if (
        agents.size !== 1 ||
        !agent ||
        agent.id !== documentKey(agentId) ||
        agent.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const ref = this.store.doc('tasks', taskId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return taskActivityOutcome('not_found', null);
      const task = decodeRecord<Record<string, unknown>>(snapshot.data());
      if (task.agentId !== agentId) return taskActivityOutcome('not_found', null);
      if (
        task.id !== taskId ||
        documentKey(taskId) !== snapshot.id ||
        typeof task.status !== 'string' ||
        !(
          task.archivedAt === null ||
          (task.archivedAt instanceof Date && Number.isFinite(task.archivedAt.getTime()))
        )
      )
        throw new Error('Invalid activity task');

      if (isChatAdmissionCancellationProjection(task))
        return taskActivityOutcome('not_found', null);
      if (action === 'archive') {
        if (!TERMINAL.has(task.status)) return withCurrent(task, {}, 'no_longer_retriable');
        if (task.archivedAt !== null) return withCurrent(task, {}, 'already_archived');
      } else if (task.archivedAt === null) {
        return withCurrent(task, {}, 'already_restored');
      }
      const now = this.store.now();
      tx.update(ref, { archivedAt: action === 'archive' ? now : null, updatedAt: now });
      return withCurrent(
        task,
        { archivedAt: action === 'archive' ? now.toISOString() : null },
        action === 'archive' ? 'archived' : 'restored',
        true,
      );
    });
  }

  private async changeOwnerTask(
    agentId: string,
    taskId: string,
    update: (
      task: Record<string, unknown>,
      ref: DocumentReference,
      tx: Transaction,
    ) => TaskActivityCommandOutcome,
  ): Promise<TaskActivityCommandOutcome> {
    if (!agentId || !taskId) throw new Error('Activity agent and task are required');
    return this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const agent = agents.docs[0];
      if (
        agents.size !== 1 ||
        !agent ||
        agent.id !== documentKey(agentId) ||
        agent.get('id') !== agentId
      )
        throw new Error('Activity requires one matching configured agent');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const ref = this.store.doc('tasks', taskId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== agentId) {
        return taskActivityOutcome('not_found', null);
      }
      const task = decodeRecord<Record<string, unknown>>(snapshot.data());
      if (task.id !== taskId || documentKey(taskId) !== snapshot.id)
        throw new Error('Invalid activity task');
      if (isChatAdmissionCancellationProjection(task))
        return taskActivityOutcome('not_found', null);
      return update(task, ref, tx);
    });
  }
}
