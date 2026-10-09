import type { SmsChannelRepository } from '@assistant/persistence';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  approvals,
  channelBindings,
  conversations,
  costEvents,
  rateLimits,
  toolCalls,
} from './schema.js';
import { claimPostgresSmsUsage, settlePostgresSmsUsage } from './sms-usage-reconciliation.js';

/** The SMS channel's PostgreSQL state, with the same queries the channel has always run. */
export function createPostgresSmsChannelRepository(db: Db): SmsChannelRepository {
  return {
    kind: 'sms-channel-repository',
    async underChannelLimit() {
      const [limit] = await db.select().from(rateLimits).where(eq(rateLimits.scope, 'channel:sms'));
      if (!limit) return true;
      const countSince = async (interval: string) => {
        const [row] = await db
          .select({ n: sql<number>`count(*)` })
          .from(costEvents)
          .where(
            and(
              eq(costEvents.source, 'twilio_sms'),
              gte(costEvents.createdAt, sql`now() - ${interval}::interval`),
            ),
          );
        return Number(row?.n ?? 0);
      };
      if (limit.maxPerHour !== null && (await countSince('1 hour')) >= limit.maxPerHour)
        return false;
      if (limit.maxPerDay !== null && (await countSince('1 day')) >= limit.maxPerDay) return false;
      return true;
    },
    async conversationForPeer(agentId, peer, trust) {
      if (!peer) throw new Error('SMS peer is required');
      return db.transaction(async (tx) => {
        // The binding's uniqueness is global to channel/peer, so its lock
        // must use the same identity even when a foreign owner asks for it.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['sms', peer])}, 0))`,
        );
        const [binding] = await tx
          .select()
          .from(channelBindings)
          .where(and(eq(channelBindings.channel, 'sms'), eq(channelBindings.externalId, peer)));
        if (binding) {
          const [conversation] = await tx
            .select()
            .from(conversations)
            .where(eq(conversations.id, binding.conversationId));
          if (!conversation || conversation.agentId !== agentId || conversation.channel !== 'sms')
            throw new Error('SMS binding is missing or outside the owner scope');
          return conversation.id;
        }
        const [conversation] = await tx
          .insert(conversations)
          .values({ agentId, channel: 'sms', trust, title: `SMS ${peer}` })
          .returning();
        if (!conversation) throw new Error('failed to create sms conversation');
        await tx.insert(channelBindings).values({
          conversationId: conversation.id,
          channel: 'sms',
          externalId: peer,
        });
        return conversation.id;
      });
    },
    async finalDestination(conversationId) {
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      if (!conversation) return null;
      const [binding] = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.conversationId, conversationId),
            eq(channelBindings.channel, 'sms'),
          ),
        );
      return {
        channel: conversation.channel,
        trust: conversation.trust,
        externalId: binding?.externalId ?? null,
      };
    },
    async pendingApprovalTool(shortCode) {
      const [pending] = await db
        .select({ toolName: toolCalls.toolName })
        .from(approvals)
        .innerJoin(toolCalls, eq(approvals.toolCallId, toolCalls.id))
        .where(and(eq(approvals.shortCode, shortCode), eq(approvals.status, 'pending')))
        .limit(1);
      return pending?.toolName ?? null;
    },
    claimSmsUsageReconciliation: (now, limit) => claimPostgresSmsUsage(db, now, limit),
    settleSmsUsageReconciliation: (claim, outcome) => settlePostgresSmsUsage(db, claim, outcome),
  };
}
