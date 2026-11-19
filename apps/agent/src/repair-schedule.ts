import { createHash } from 'node:crypto';
import {
  assertPrivacyErasureInactiveInTransaction,
  decodeRecord,
  type InstallationStore,
} from '@assistant/firestore';
import {
  REPAIR_POLL_INTERVAL_MS,
  type Records,
  type RepairIssue,
  repairQueueNextEligibleAt,
  repairQueueReady,
} from '@assistant/persistence';
export async function ensureRepairSchedule(
  store: InstallationStore,
  agentId: string,
  dailyLimit = 2,
) {
  const h = createHash('sha256').update(`self-repair:${agentId}`).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  await store.db.runTransaction(async (tx) => {
    await assertPrivacyErasureInactiveInTransaction(tx, store, agentId);
    const owner = await tx.get(store.doc('agents', agentId));
    if (!owner.exists) throw new Error('Repair schedule owner is missing');
    const previous = await tx.get(
      store
        .collection('schedules')
        .where('agentId', '==', agentId)
        .where('name', '==', 'self-repair')
        .limit(1),
    );
    const now = store.now();
    if (!previous.empty) {
      const schedule = previous.docs[0];
      if (!schedule) return;
      if (!schedule.get('enabled') || schedule.get('taskTemplate.job') !== 'self.repair') return;
      const rows = await tx.get(
        store.collection('selfRepairIssues').where('agentId', '==', agentId).limit(1001),
      );
      const issues = rows.docs.map((doc) => decodeRecord<RepairIssue>(doc.data()));
      // Every minute sweep recovers missed wakes and starts waiting work as soon as the rolling
      // allowance returns. The claim transaction remains the final authority for dispatch.
      const eligibleAt = repairQueueNextEligibleAt(issues, now, dailyLimit);
      const followUp = issues.some((issue) =>
        ['fixing', 'testing', 'pr_open', 'merged'].includes(issue.status),
      );
      const next: Date | undefined = schedule.get('nextRunAt')?.toDate?.();
      const lastRun: Date | undefined = schedule.get('lastRunAt')?.toDate?.();
      const earliest = lastRun ? lastRun.getTime() + REPAIR_POLL_INTERVAL_MS : now.getTime();
      // The scheduler already advances the configured cron. A capped queue may
      // have postponed a default poll, so restore it once without sliding it
      // forward every time the minute sweep runs.
      const poll =
        followUp && schedule.get('cron') === '*/15 * * * *'
          ? Math.min(next?.getTime() ?? Infinity, now.getTime() + REPAIR_POLL_INTERVAL_MS)
          : undefined;
      const requested = repairQueueReady(issues, now, dailyLimit)
        ? now.getTime()
        : (eligibleAt?.getTime() ?? poll);
      const nextRunAt =
        requested === undefined ? undefined : new Date(Math.max(earliest, requested));
      if (nextRunAt) {
        if (!next || Math.abs(next.getTime() - nextRunAt.getTime()) > 1000)
          tx.update(schedule.ref, { nextRunAt, updatedAt: now });
      }
      return;
    }
    const row: Records['schedules'] = {
      id,
      agentId,
      name: 'self-repair',
      cron: '*/15 * * * *',
      taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.50', job: 'self.repair' },
      enabled: true,
      seedTemplateKey: 'assistant.schedule.self-repair',
      seedTemplateRevision: 1,
      seedDefinition: {
        cron: '*/15 * * * *',
        taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.50', job: 'self.repair' },
      },
      seedReviewRequired: false,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.create(store.doc('schedules', id), row);
  });
}
