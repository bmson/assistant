import type { ApplicationConfirmationNoticeFence } from '@assistant/persistence';
import { matchesApplicationConfirmationNoticeLineage } from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { applicationConfirmations, tasks } from './schema.js';

export async function postgresApplicationConfirmationNoticeIsCurrent(
  tx: Db,
  fence: ApplicationConfirmationNoticeFence,
  requireLiveTaskLease: boolean,
  expectedConversationId?: string,
): Promise<boolean> {
  if (!fence.agentId || !fence.taskId || !fence.applicationId || !fence.confirmationMessageId)
    return false;
  if (
    (await lockPostgresPrivacyObservationFence(tx, fence.agentId)) !==
    fence.producerPrivacyGeneration
  )
    return false;
  const [task] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, fence.taskId), eq(tasks.agentId, fence.agentId)))
    .for('share')
    .limit(1);
  const [application] = await tx
    .select()
    .from(applicationConfirmations)
    .where(
      and(
        eq(applicationConfirmations.id, fence.applicationId),
        eq(applicationConfirmations.agentId, fence.agentId),
      ),
    )
    .for('share')
    .limit(1);
  const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
  const now = clock ? new Date(clock.now) : null;
  return Boolean(
    now &&
      matchesApplicationConfirmationNoticeLineage(task ?? null, application ?? null, fence, {
        now,
        requireLiveTaskLease,
      }) &&
      (expectedConversationId === undefined ||
        application?.conversationId === expectedConversationId),
  );
}
