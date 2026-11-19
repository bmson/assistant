import { createHash } from 'node:crypto';
import { nextRun } from '@assistant/core';
import {
  assertPrivacyErasureInactiveInTransaction,
  type InstallationStore,
} from '@assistant/firestore';
import { PROACTIVE_AWARENESS_SCHEDULE, type Records } from '@assistant/persistence';

/** Create once on upgraded Firestore installations; owner edits and pauses always win. */
export async function ensureAwarenessSchedule(
  store: InstallationStore,
  agentId: string,
  now: Date = store.now(),
): Promise<number> {
  const definition = PROACTIVE_AWARENESS_SCHEDULE;
  const hash = createHash('sha256').update(`${definition.name}:${agentId}`).digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return store.db.runTransaction(async (tx) => {
    await assertPrivacyErasureInactiveInTransaction(tx, store, agentId);
    const owner = await tx.get(store.doc('agents', agentId));
    if (!owner.exists || owner.get('id') !== agentId)
      throw new Error('Awareness schedule owner is missing');
    const previous = await tx.get(
      store
        .collection('schedules')
        .where('agentId', '==', agentId)
        .where('name', '==', definition.name)
        .limit(1),
    );
    if (!previous.empty) return 0;
    const row: Records['schedules'] = {
      id,
      agentId,
      ...definition,
      taskTemplate: { ...definition.taskTemplate },
      enabled: true,
      seedTemplateKey: `assistant.schedule.${definition.name}`,
      seedTemplateRevision: 1,
      seedDefinition: { cron: definition.cron, taskTemplate: { ...definition.taskTemplate } },
      seedReviewRequired: false,
      nextRunAt: nextRun(definition.cron, owner.get('timezone'), now),
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.create(store.doc('schedules', id), row);
    return 1;
  });
}
