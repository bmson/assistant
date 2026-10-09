import type {
  ApplicationConfirmationNoticeFence,
  EmailObserverEffectFence,
  NotificationsConversationRepository,
} from '@assistant/persistence';
import { matchesPreparedEmailObserverClaim } from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import { postgresApplicationConfirmationNoticeIsCurrent } from './application-confirmation-notice-fence.js';
import type { Db } from './client.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { conversations, emailObserverWork } from './schema.js';

/**
 * Nothing in the schema makes the Notifications conversation unique, so first
 * uses serialize on a per-owner advisory lock. The key is the one the watch
 * suggestion commit takes before it creates the same conversation.
 */
export function createPostgresNotificationsConversationRepository(
  db: Db,
): NotificationsConversationRepository {
  return {
    kind: 'notifications-conversation-repository',
    getOrCreate: (
      agentId,
      fence?: EmailObserverEffectFence,
      noticeFence?: ApplicationConfirmationNoticeFence,
    ) =>
      db.transaction(async (tx) => {
        if (fence && noticeFence)
          throw new Error('Notifications conversation accepts one producer fence');
        if (fence) {
          const current = await lockPostgresPrivacyObservationFence(tx as unknown as Db, agentId);
          if (fence.agentId !== agentId || current !== fence.expectedPrivacyGeneration)
            throw new Error('Email observer notification conversation fence changed');
          const [work] = await tx
            .select()
            .from(emailObserverWork)
            .where(and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, agentId)))
            .for('update')
            .limit(1);
          if (!matchesPreparedEmailObserverClaim(work ?? null, fence, new Date()))
            throw new Error('Email observer notification conversation claim is stale');
        }
        if (
          noticeFence &&
          (noticeFence.agentId !== agentId ||
            !(await postgresApplicationConfirmationNoticeIsCurrent(
              tx as unknown as Db,
              noticeFence,
              true,
            )))
        )
          throw new Error('Application confirmation conversation fence is stale');
        const lock = `watch-notifications:${agentId}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lock}))`);
        if (fence) {
          const [work] = await tx
            .select()
            .from(emailObserverWork)
            .where(and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, agentId)))
            .for('update')
            .limit(1);
          if (!matchesPreparedEmailObserverClaim(work ?? null, fence, new Date()))
            throw new Error('Email observer notification conversation claim expired');
        }
        if (
          noticeFence &&
          !(await postgresApplicationConfirmationNoticeIsCurrent(
            tx as unknown as Db,
            noticeFence,
            true,
          ))
        )
          throw new Error('Application confirmation conversation claim expired');
        const [existing] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.agentId, agentId), eq(conversations.title, 'Notifications')))
          .limit(1);
        if (existing) return existing.id;
        const [created] = await tx
          .insert(conversations)
          .values({
            agentId,
            channel: 'chat',
            trust: 'assistant',
            title: 'Notifications',
          })
          .returning({ id: conversations.id });
        if (!created) throw new Error('failed to create Notifications conversation');
        return created.id;
      }),
  };
}
