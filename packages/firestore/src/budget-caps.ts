import {
  type BudgetCapsRepository,
  type BudgetRetry,
  type BudgetWakeCursor,
  budgetWakeScheduleId,
  budgetWakeScheduleIsCurrent,
  canWakeForBudget,
  microsToUsd,
  type Records,
  readBudgetRetry,
  readBudgetWakeCursor,
  storedLedgerUsdToMicros,
  storedTaskBudgetToMicros,
  type TaskWake,
  usdToMicros,
} from '@assistant/persistence';
import { FieldPath } from '@google-cloud/firestore';
import { FirestoreCostRepository } from './costs.js';
import { createWakeIntent } from './outbox.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

/** Mutates the same policy document read by cost reservations, atomically. */
export class FirestoreBudgetCapsRepository implements BudgetCapsRepository {
  readonly kind = 'budget-caps-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async resumeWakes(agentId: string): Promise<TaskWake[]> {
    if (!(await this.store.doc('coordination', `budget-cap-wake:${agentId}`).get()).exists)
      return [];
    return this.update(agentId, {});
  }

  async update(
    agentId: string,
    values: Partial<Record<'task_default' | 'daily' | 'monthly', string>>,
  ): Promise<TaskWake[]> {
    if (!agentId) throw new Error('Budget caps require a configured agent');
    if (
      Object.values(values).some(
        (value) =>
          typeof value !== 'string' ||
          !/^(?:0|[1-9]\d*)\.\d{2}$/.test(value) ||
          Number(value) > 10_000,
      )
    )
      throw new Error('Budget caps must be normalized, nonnegative USD amounts');
    return this.store.db.runTransaction(async (tx) => {
      const agents = await tx.get(this.store.collection('agents').limit(2));
      const agent = agents.docs[0];
      if (
        agents.size !== 1 ||
        !agent ||
        agent.id !== documentKey(agentId) ||
        agent.get('id') !== agentId
      )
        throw new Error('Budget caps require one matching configured owner');

      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime)
      )
        throw new Error('Privacy erasure is in progress');

      const policyRef = this.store.doc('coordination', 'budget-policy');
      const taskRef = this.store.doc('budgets', 'task_default');
      const cursorRef = this.store.doc('coordination', `budget-cap-wake:${agentId}`);
      const [policy, task, pendingWake] = await tx.getAll(policyRef, taskRef, cursorRef);
      if (!policy?.exists) throw new Error('Budget policy must be initialized');
      microsToUsd(policy.get('dailyLimitMicros'));
      microsToUsd(policy.get('monthlyLimitMicros'));
      const softPct = policy.get('softPct');
      if (!Number.isInteger(softPct) || softPct < 0 || softPct > 100)
        throw new Error('Budget policy is malformed');
      if (
        values.task_default !== undefined &&
        (!task?.exists ||
          task.get('scope') !== 'task_default' ||
          typeof task.get('limitUsd') !== 'string')
      )
        throw new Error('Default task cap is malformed');

      const now = this.store.now();
      const dailyCap =
        values.daily === undefined
          ? policy.get('dailyLimitMicros')
          : usdToMicros(Number(values.daily));
      const monthlyCap =
        values.monthly === undefined
          ? policy.get('monthlyLimitMicros')
          : usdToMicros(Number(values.monthly));
      const raised: BudgetRetry['scope'][] = [];
      if (dailyCap > policy.get('dailyLimitMicros')) raised.push('daily');
      if (monthlyCap > policy.get('monthlyLimitMicros')) raised.push('monthly');
      const previousCursor = readBudgetWakeCursor(pendingWake?.data());
      const scopes = new Set([...raised, ...(previousCursor?.scopes ?? [])]);
      const after = raised.length ? undefined : previousCursor?.after;
      let continuation: BudgetWakeCursor | null = null;
      const wakes: TaskWake[] = [];
      if (scopes.size) {
        const candidates = this.store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .where('status', '==', 'waiting_budget')
          .orderBy('updatedAt')
          .orderBy(FieldPath.documentId())
          .limit(101);
        const parked = await tx.get(
          after ? candidates.startAfter(new Date(after.updatedAt), after.id) : candidates,
        );
        if (!parked.empty) {
          const page = parked.docs.slice(0, 100);
          const last = page.at(-1);
          if (parked.size > 100 && last) {
            const updatedAt = decodeRecord<Date>(last.get('updatedAt'));
            continuation = {
              scopes: [...scopes],
              after: { updatedAt: updatedAt.toISOString(), id: last.id },
            };
          }
          const [holds, day, month] = await tx.getAll(
            this.store.doc('coordination', 'budget-holds'),
            this.store.doc('budgetPeriods', `day:${now.toISOString().slice(0, 10)}`),
            this.store.doc('budgetPeriods', `month:${now.toISOString().slice(0, 7)}`),
          );
          const held = holds?.get('heldMicros') ?? 0;
          microsToUsd(held);
          const period = await new FirestoreCostRepository(this.store).periodHolds(tx, now, held);
          for (const doc of page) {
            const row = decodeRecord<Records['tasks']>(doc.data());
            const retry = readBudgetRetry(row.state);
            if (
              !row.id ||
              documentKey(row.id) !== doc.id ||
              !Number.isSafeInteger(row.queueGeneration) ||
              row.queueGeneration < 0 ||
              row.archivedAt != null ||
              !(row.runAfter instanceof Date) ||
              row.runAfter <= now ||
              !retry ||
              !scopes.has(retry.scope)
            )
              continue;
            const [taskHold, pending] = await Promise.all([
              tx.get(this.store.doc('taskBudgetHolds', row.id)),
              tx.get(
                this.store
                  .collection('approvals')
                  .where('taskId', '==', row.id)
                  .where('status', '==', 'pending')
                  .limit(1),
              ),
            ]);
            if (!pending.empty) continue;
            const scheduleId = budgetWakeScheduleId(row.trigger);
            if (scheduleId) {
              const snapshot = await tx.get(this.store.doc('schedules', scheduleId));
              const schedule = decodeRecord<Records['schedules'] | undefined>(snapshot.data());
              if (
                !schedule ||
                schedule.agentId !== agentId ||
                !budgetWakeScheduleIsCurrent(schedule)
              )
                continue;
            }
            // A legacy task hold can be absent only when no open reservation exists.
            if (!taskHold.exists) {
              const reservations = await tx.get(
                this.store
                  .collection('costReservations')
                  .where('taskId', '==', row.id)
                  .select('status')
                  .limit(501),
              );
              if (
                reservations.size >= 501 ||
                reservations.docs.some((reservation) =>
                  ['held', 'dispatching', 'unknown'].includes(reservation.get('status')),
                )
              )
                continue;
            }
            if (
              canWakeForBudget(retry, {
                dailyCap,
                monthlyCap,
                dailySpent: day?.get('spentMicros') ?? 0,
                monthlySpent: month?.get('spentMicros') ?? 0,
                dailyHeld: period.dailyHeld,
                monthlyHeld: period.monthlyHeld,
                taskSpent: storedLedgerUsdToMicros(row.spentUsd),
                taskHeld: taskHold.get('heldMicros') ?? 0,
                taskCap: storedTaskBudgetToMicros(row.budgetUsdLimit),
              })
            )
              wakes.push({ id: row.id, queueGeneration: row.queueGeneration + 1 });
          }
        }
      }

      const policyUpdate: Record<string, unknown> = {};
      if (values.daily !== undefined) policyUpdate.dailyLimitMicros = dailyCap;
      if (values.monthly !== undefined) policyUpdate.monthlyLimitMicros = monthlyCap;
      if (Object.keys(policyUpdate).length)
        tx.update(policyRef, { ...policyUpdate, updatedAt: now });
      if (values.task_default !== undefined)
        tx.update(taskRef, { limitUsd: values.task_default, updatedAt: now });
      if (continuation) tx.set(cursorRef, continuation);
      else if (pendingWake?.exists) tx.delete(cursorRef);
      for (const wake of wakes) {
        tx.update(this.store.doc('tasks', wake.id), {
          status: 'pending',
          runAfter: null,
          leaseToken: null,
          lockedUntil: null,
          queueGeneration: wake.queueGeneration,
          attempt: 0,
          updatedAt: now,
        });
        createWakeIntent(tx, this.store, {
          taskId: wake.id,
          generation: wake.queueGeneration,
          availableAt: now,
        });
      }
      return wakes;
    });
  }
}
