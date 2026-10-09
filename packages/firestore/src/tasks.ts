import { randomUUID } from 'node:crypto';
import type {
  Records,
  TaskCheckpoint,
  TaskLease,
  TaskLeaseRepository,
} from '@assistant/persistence';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

const CLAIMABLE = new Set(['pending', 'sleeping', 'waiting_budget', 'running']);
const LEASE_MS = 10 * 60_000;

function leaseMatches(row: TaskLease, lease: TaskLease, now: Date): boolean {
  return (
    row.status === 'running' &&
    Boolean(lease.leaseToken) &&
    row.leaseToken === lease.leaseToken &&
    row.lockedUntil.getTime() > now.getTime()
  );
}

/** No callback or provider call executes inside a retryable transaction. */
export class FirestoreTaskLeaseRepository implements TaskLeaseRepository {
  readonly kind = 'task-lease-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async claim(taskId: string, generation?: number): Promise<TaskLease | null> {
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0))
      return null;
    const ref = this.store.doc('tasks', taskId);
    return this.store.db.runTransaction(async (tx) => {
      const migration = await tx.get(this.store.doc('coordination', 'migration'));
      if (migration.exists && migration.get('status') !== 'active') return null;
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const row = decodeRecord<Records['tasks']>(snap.data());
      const now = this.store.now();
      if (
        (generation !== undefined && row.queueGeneration !== generation) ||
        !CLAIMABLE.has(row.status) ||
        (row.lockedUntil && row.lockedUntil > now) ||
        (row.runAfter && row.runAfter > now)
      )
        return null;
      // A delivery queued before cancellation must never be claimed afterwards.
      const trigger = row.trigger as { payload?: { scheduleId?: string } } | null;
      const scheduleId = trigger?.payload?.scheduleId;
      if (scheduleId) {
        const schedule = await tx.get(this.store.doc('schedules', scheduleId));
        const template = schedule.data()?.taskTemplate;
        if (!schedule.exists || template?.reminderCancelledAt || template?.reminderDeliveredAt)
          return null;
      }
      const lease: TaskLease = {
        ...row,
        status: 'running',
        updatedAt: now,
        lockedUntil: new Date(now.getTime() + LEASE_MS),
        leaseToken: randomUUID(),
      };
      tx.update(
        ref,
        encodeRecord({
          status: lease.status,
          updatedAt: now,
          lockedUntil: lease.lockedUntil,
          leaseToken: lease.leaseToken,
        }),
      );
      return lease;
    });
  }

  async renew(lease: TaskLease): Promise<boolean> {
    const ref = this.store.doc('tasks', lease.id);
    const renewed = await this.store.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const row = decodeRecord<TaskLease>(snap.data());
      const now = this.store.now();
      if (!leaseMatches(row, lease, now)) return null;
      const update = { lockedUntil: new Date(now.getTime() + LEASE_MS), leaseToken: randomUUID() };
      tx.update(ref, { ...update, updatedAt: now });
      return update;
    });
    if (!renewed) return false;
    Object.assign(lease, renewed);
    return true;
  }

  async checkpoint(lease: TaskLease, state: unknown, extra: TaskCheckpoint = {}): Promise<boolean> {
    const { preserveFailureCounters, ...fields } = extra;
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('tasks', lease.id);
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const now = this.store.now();
      if (!leaseMatches(decodeRecord<TaskLease>(snap.data()), lease, now)) return false;
      tx.update(
        ref,
        encodeRecord({
          state,
          ...fields,
          ...(preserveFailureCounters ? {} : { attempt: 0, reclaimCount: 0 }),
          updatedAt: now,
        }),
      );
      return true;
    });
  }
}
