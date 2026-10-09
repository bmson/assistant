import { randomUUID } from 'node:crypto';
import {
  curiosityNudgePingId,
  insideQuietHours,
  type NudgePolicyRepository,
  type OutOfBandPingInput,
  ownerLocalMidnightUtc,
  ownerLocalMinutes,
  type PingDecision,
  type Records,
} from '@assistant/persistence';
import { isEmulatorClosedTransaction } from './emulator-transaction.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

function optionalMinutes(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) throw new Error('Notification preferences are malformed');
  return value as number;
}

/**
 * The nudge policy over `notificationPrefs` and the `proactivePings` ledger.
 * Ambient evaluations read and rewrite one per-owner coordination document, so
 * concurrent producers serialize exactly as PostgreSQL's advisory lock makes
 * them: each counts the ledger only after the previous slot is committed.
 */
export class FirestoreNudgePolicyRepository implements NudgePolicyRepository {
  readonly kind = 'nudge-policy-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async evaluate(
    agent: { id: string; timezone: string },
    opts: OutOfBandPingInput,
  ): Promise<PingDecision> {
    if (!agent.id || agent.id !== this.configuredAgentId)
      throw new Error('Nudge policy requires the configured agent');
    const now = opts.now ?? this.store.now();
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid nudge policy time');
    const channel = opts.channel ?? 'out-of-band';
    const id = channel.startsWith('curiosity-nudge:')
      ? curiosityNudgePingId(agent.id, channel)
      : randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.store.db.runTransaction(async (tx) => {
          const owner = await tx.get(this.store.doc('agents', agent.id));
          if (!owner.exists || owner.get('id') !== agent.id || owner.id !== documentKey(agent.id))
            throw new Error('Nudge policy requires the configured agent');
          let decision: PingDecision = { deliver: true };
          let midnight: Date | null = null;
          if (opts.urgency === 'ambient') {
            midnight = ownerLocalMidnightUtc(agent.timezone, now);
            // Read before any ledger count so a concurrent ambient evaluation
            // for this owner contends here and reruns against the committed slot.
            await tx.get(this.store.doc('coordination', `ambient-pings:${agent.id}`));
            if (channel.startsWith('curiosity-nudge:')) {
              const prior = await tx.get(this.store.doc('proactivePings', id));
              if (prior.exists) {
                const row = decodeRecord<Records['proactivePings']>(prior.data());
                if (row.agentId !== agent.id || row.channel !== channel)
                  throw new Error('Curiosity nudge reservation ownership mismatch');
                return {
                  deliver: row.delivered,
                  ...(!row.delivered && (row.reason === 'quiet-hours' || row.reason === 'daily-cap')
                    ? { reason: row.reason }
                    : {}),
                };
              }
            }
            const prefsSnapshot = await tx.get(this.store.doc('notificationPrefs', agent.id));
            const row = prefsSnapshot.exists
              ? decodeRecord<Records['notificationPrefs']>(prefsSnapshot.data())
              : null;
            if (row && row.agentId !== agent.id)
              throw new Error('Notification preferences belong to another agent');
            const prefs = row
              ? {
                  quietStartMin: optionalMinutes(row.quietStartMin),
                  quietEndMin: optionalMinutes(row.quietEndMin),
                  ambientDailyCap: optionalMinutes(row.ambientDailyCap),
                }
              : null;
            if (prefs && insideQuietHours(prefs, ownerLocalMinutes(agent.timezone, now))) {
              decision = { deliver: false, reason: 'quiet-hours' };
            } else if (prefs?.ambientDailyCap != null) {
              const cap = prefs.ambientDailyCap;
              // Counting stops at the cap: only "reached or not" matters here.
              const used =
                cap <= 0
                  ? 0
                  : (
                      await tx.get(
                        this.store
                          .collection('proactivePings')
                          .where('agentId', '==', agent.id)
                          .where('urgency', '==', 'ambient')
                          .where('delivered', '==', true)
                          .where('createdAt', '>=', midnight)
                          .limit(cap)
                          .count(),
                      )
                    ).data().count;
              if (used >= cap) decision = { deliver: false, reason: 'daily-cap' };
            }
          }

          // All reads precede writes; the callback has no external side effects.
          if (midnight)
            tx.set(this.store.doc('coordination', `ambient-pings:${agent.id}`), {
              agentId: agent.id,
              dayStart: midnight,
              lastPingId: id,
              updatedAt: now,
            });
          tx.create(
            this.store.doc('proactivePings', id),
            encodeRecord({
              id,
              agentId: agent.id,
              urgency: opts.urgency,
              channel,
              delivered: decision.deliver,
              reason: decision.reason ?? null,
              // The evaluation's own clock, as in PostgreSQL: a caller pinning
              // `now` lands its row inside the day it judged.
              createdAt: now,
            }),
          );
          return decision;
        });
      } catch (error) {
        if (!isEmulatorClosedTransaction(error) || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }
}
