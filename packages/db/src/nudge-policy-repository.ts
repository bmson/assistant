import {
  curiosityNudgePingId,
  insideQuietHours,
  type NudgePolicyRepository,
  ownerLocalMidnightUtc,
  ownerLocalMinutes,
  type PingDecision,
} from '@assistant/persistence';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { notificationPrefs, proactivePings } from './schema.js';

/** The nudge-policy evaluation core has always issued, behind the port. */
export function createPostgresNudgePolicyRepository(db: Db): NudgePolicyRepository {
  return {
    kind: 'nudge-policy-repository',
    evaluate(agent, opts) {
      const now = opts.now ?? new Date();
      const channel = opts.channel ?? 'out-of-band';
      const id = channel.startsWith('curiosity-nudge:')
        ? curiosityNudgePingId(agent.id, channel)
        : undefined;
      return db.transaction(async (tx) => {
        let decision: PingDecision = { deliver: true };
        if (opts.urgency === 'ambient') {
          // A daily cap is a quota, not an eventual-consistency hint. Concurrent
          // watch, briefing, and arrival workers used to count the same N rows and
          // all send N+1; the transaction-scoped per-owner/day lock reserves the
          // ledger slot before any caller starts its notifier fan-out.
          const midnight = ownerLocalMidnightUtc(agent.timezone, now);
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`assistant:ambient-ping:${agent.id}:${midnight.toISOString()}`}))`,
          );
          if (id) {
            const [prior] = await tx
              .select()
              .from(proactivePings)
              .where(eq(proactivePings.id, id))
              .limit(1);
            if (prior) {
              if (prior.agentId !== agent.id || prior.channel !== channel)
                throw new Error('Curiosity nudge reservation ownership mismatch');
              return {
                deliver: prior.delivered,
                ...(!prior.delivered &&
                (prior.reason === 'quiet-hours' || prior.reason === 'daily-cap')
                  ? { reason: prior.reason }
                  : {}),
              };
            }
          }
          const [prefs] = await tx
            .select()
            .from(notificationPrefs)
            .where(eq(notificationPrefs.agentId, agent.id))
            .limit(1);
          if (prefs && insideQuietHours(prefs, ownerLocalMinutes(agent.timezone, now))) {
            decision = { deliver: false, reason: 'quiet-hours' };
          } else if (prefs?.ambientDailyCap != null) {
            const [used] = await tx
              .select({ value: count() })
              .from(proactivePings)
              .where(
                and(
                  eq(proactivePings.agentId, agent.id),
                  eq(proactivePings.urgency, 'ambient'),
                  eq(proactivePings.delivered, true),
                  gte(proactivePings.createdAt, midnight),
                ),
              );
            if (Number(used?.value ?? 0) >= prefs.ambientDailyCap) {
              decision = { deliver: false, reason: 'daily-cap' };
            }
          }
        }

        await tx.insert(proactivePings).values({
          ...(id ? { id } : {}),
          agentId: agent.id,
          urgency: opts.urgency,
          channel,
          delivered: decision.deliver,
          reason: decision.reason ?? null,
          // The evaluation's own clock, not insert time: a caller pinning `now`
          // (tests, a replayed sweep) must land its row inside the day it judged.
          createdAt: now,
        });
        return decision;
      });
    },
  };
}
