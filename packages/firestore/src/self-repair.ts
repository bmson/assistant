import { createHash } from 'node:crypto';
import {
  type RepairIssue,
  type RepairModelAccounting,
  repairClaimCandidate,
  repairFailureKey,
  repairTransition,
  type SelfRepairRepository,
} from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import {
  assertPrivacyErasureFenceUnchanged,
  assertPrivacyErasureInactiveInTransaction,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

/** Arm the existing enabled schedule in the report transaction; the sweep delivers its wake. */
async function repairScheduleToWake(tx: Transaction, store: InstallationStore, agentId: string) {
  const schedules = await tx.get(
    store
      .collection('schedules')
      .where('agentId', '==', agentId)
      .where('name', '==', 'self-repair')
      .limit(2),
  );
  if (schedules.size > 1) throw new Error('Ambiguous repair schedule');
  const schedule = schedules.docs[0];
  return schedule?.get('enabled') === true && schedule.get('taskTemplate.job') === 'self.repair'
    ? schedule
    : null;
}

export class FirestoreSelfRepairRepository implements SelfRepairRepository {
  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}
  private owned(agentId: string) {
    if (agentId !== this.agentId) throw new Error('Repair is outside the configured owner');
  }
  async report(agentId: string, input: Parameters<SelfRepairRepository['report']>[1]) {
    this.owned(agentId);
    const hex = createHash('sha256')
      .update(JSON.stringify([agentId, input.fingerprint]))
      .digest('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    const ref = this.store.doc('selfRepairIssues', id);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      if (input.sourceTaskId) {
        const task = await tx.get(this.store.doc('tasks', input.sourceTaskId));
        if (!task.exists || task.get('agentId') !== agentId)
          throw new Error('Repair evidence task is outside the owner');
      }
      if (input.conversationId) {
        const chat = await tx.get(this.store.doc('conversations', input.conversationId));
        if (!chat.exists || chat.get('agentId') !== agentId)
          throw new Error('Repair conversation is outside the owner');
      }
      const previous = await tx.get(ref);
      if (previous.exists) return decodeRecord<RepairIssue>(previous.data());
      const now = this.store.now();
      const schedule = await repairScheduleToWake(tx, this.store, agentId);
      const row: RepairIssue = {
        id,
        agentId,
        fingerprint: input.fingerprint,
        status: 'reported',
        version: 0,
        data: { ...input, history: [{ status: 'reported', at: now.toISOString(), detail: '' }] },
        createdAt: now,
        updatedAt: now,
      };
      tx.create(ref, encodeRecord(row));
      if (schedule) tx.update(schedule.ref, { nextRunAt: now, updatedAt: now });
      return row;
    });
  }
  async list(agentId: string) {
    this.owned(agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store
      .collection('selfRepairIssues')
      .where('agentId', '==', agentId)
      .limit(1001)
      .get();
    if (snapshot.size > 1000) throw new Error('Repair ledger requires archival');
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return snapshot.docs
      .map((doc) => decodeRecord<RepairIssue>(doc.data()))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async claim(agentId: string, now: Date, dailyLimit: number, taskId?: string) {
    this.owned(agentId);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      // Every claim writes the same owner document, serializing concurrent sweeps.
      const owner = this.store.doc('agents', agentId);
      const snapshot = await tx.get(
        this.store.collection('selfRepairIssues').where('agentId', '==', agentId).limit(1001),
      );
      const ownerRow = await tx.get(owner);
      if (!ownerRow.exists) throw new Error('Repair owner is missing');
      const rows = snapshot.docs.map((doc) => decodeRecord<RepairIssue>(doc.data()));
      const issue = repairClaimCandidate(rows, now, dailyLimit);
      if (!issue) return null;
      const next = repairTransition(
        issue,
        'investigating',
        {
          manualRunStartedAt: issue.data.manualRunRequestedAt ?? issue.data.manualRunStartedAt,
          manualRunRequestedAt: undefined,
          nextEligibleAt: undefined,
          ownerActionRequired: undefined,
          investigationStartedAt: now.toISOString(),
          investigationTaskIds: taskId
            ? [...new Set([...(issue.data.investigationTaskIds ?? []), taskId])].slice(-30)
            : issue.data.investigationTaskIds,
        },
        now,
      );
      tx.update(owner, { updatedAt: now });
      tx.set(this.store.doc('selfRepairIssues', issue.id), encodeRecord(next));
      return next;
    });
  }
  async modelAccounting(
    agentId: string,
    taskIds: string[],
    since: Date,
  ): Promise<RepairModelAccounting> {
    this.owned(agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const ids = [...new Set(taskIds)].slice(-30);
    if (ids.length === 0)
      return {
        observedModelCalls: 0,
        knownCostUsd: null,
        unresolvedReservations: 0,
        complete: false,
      };
    let observedModelCalls = 0;
    let knownMicros = 0;
    let unresolvedReservations = 0;
    for (const taskId of ids) {
      const task = await this.store.doc('tasks', taskId).get();
      if (!task.exists || task.get('agentId') !== agentId)
        throw new Error('Repair accounting task is outside the owner');
      const [calls, reservations] = await Promise.all([
        this.store
          .collection('modelCalls')
          .where('taskId', '==', taskId)
          .where('createdAt', '>=', since)
          .limit(1001)
          .get(),
        this.store.collection('costReservations').where('taskId', '==', taskId).limit(1001).get(),
      ]);
      if (calls.size > 1000 || reservations.size > 1000)
        throw new Error('Repair accounting ledger requires archival');
      for (const row of calls.docs) {
        if (row.get('agentId') !== agentId || row.get('taskId') !== taskId)
          throw new Error('Repair model-call accounting identity mismatch');
        const raw = row.get('costUsd');
        const cost = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
        if (!Number.isFinite(cost) || cost < 0)
          throw new Error('Repair model-call accounting is malformed');
        knownMicros += Math.round(cost * 1_000_000);
        observedModelCalls++;
      }
      for (const row of reservations.docs) {
        const storedOwner = row.get('agentId');
        if ((storedOwner !== undefined && storedOwner !== agentId) || row.get('taskId') !== taskId)
          throw new Error('Repair reservation accounting identity mismatch');
        if (['dispatching', 'unknown'].includes(String(row.get('status'))))
          unresolvedReservations++;
      }
    }
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return {
      observedModelCalls,
      knownCostUsd: observedModelCalls > 0 ? (knownMicros / 1_000_000).toFixed(6) : null,
      unresolvedReservations,
      complete: observedModelCalls > 0 && unresolvedReservations === 0,
    };
  }
  async update(
    issue: RepairIssue,
    status: Parameters<SelfRepairRepository['update']>[1],
    patch: Parameters<SelfRepairRepository['update']>[2],
    now: Date,
  ) {
    this.owned(issue.agentId);
    const ref = this.store.doc('selfRepairIssues', issue.id);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, issue.agentId);
      const saved = await tx.get(ref);
      if (
        !saved.exists ||
        saved.get('agentId') !== issue.agentId ||
        saved.get('version') !== issue.version
      )
        return null;
      const next = repairTransition(issue, status, patch, now);
      const schedule =
        status === 'reported' &&
        (issue.status !== 'reported' ||
          Boolean(patch.manualRunRequestedAt) ||
          typeof patch.nextEligibleAt === 'string')
          ? await repairScheduleToWake(tx, this.store, issue.agentId)
          : null;
      tx.set(ref, encodeRecord(next));
      if (schedule) {
        const nextRunAt = patch.manualRunRequestedAt
          ? now
          : patch.nextEligibleAt && Number.isFinite(Date.parse(patch.nextEligibleAt))
            ? new Date(patch.nextEligibleAt)
            : now;
        tx.update(schedule.ref, { nextRunAt, updatedAt: now });
      }
      return next;
    });
  }
  async failures(agentId: string, since: Date) {
    this.owned(agentId);
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('updatedAt', '>=', since)
      .orderBy('updatedAt', 'desc')
      .limit(100)
      .get();
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return snapshot.docs
      .filter(
        (doc) =>
          ['failed', 'needs_attention'].includes(doc.get('status')) &&
          !String(doc.get('title')).startsWith('self-repair'),
      )
      .slice(0, 20)
      .map((doc) => {
        const row = decodeRecord<{ id: string; title: string; state: unknown; updatedAt: Date }>(
          doc.data(),
        );
        return {
          taskId: row.id,
          title: row.title ?? 'Failed task',
          symptomKey: repairFailureKey(row.title ?? 'Failed task', row.state),
          observedAt: row.updatedAt.toISOString(),
        };
      });
  }
}
