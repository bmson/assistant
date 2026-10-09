import { timingSafeEqual } from 'node:crypto';
import {
  ACTIVE_CALL_STATUSES,
  acceptCallTranscriptBatch,
  assertCallAdmissionOptions,
  type CallCheckin,
  type CallSession,
  type CallSessionRepository,
  isCallFinishDelivery,
  isCallLineRate,
  isCallVoiceRouteSnapshot,
} from '@assistant/persistence';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { agents, callSessions } from './schema.js';

function session(row: typeof callSessions.$inferSelect): CallSession {
  return {
    ...row,
    // Legacy or malformed persisted snapshots must be absent and fail closed.
    voiceRoute: isCallVoiceRouteSnapshot(row.voiceRoute) ? row.voiceRoute : null,
    lineRate: isCallLineRate(row.lineRate) ? row.lineRate : null,
  };
}

function hashesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createPostgresCallSessionRepository(db: Db): CallSessionRepository {
  const get = async (id: string) => {
    const [row] = await db.select().from(callSessions).where(eq(callSessions.id, id));
    return row ? session(row) : null;
  };
  return {
    kind: 'call-session-repository',
    async create(input) {
      const [row] = await db.insert(callSessions).values(input).returning();
      if (!row) throw new Error('Call session was not created');
      return session(row);
    },
    async admit(input, options) {
      assertCallAdmissionOptions(options);
      if (input.status !== 'dialing') throw new Error('Call admission must start in dialing state');
      return db.transaction(async (tx) => {
        // Every runtime dial contends on this owner row across agent instances.
        const [owner] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, input.agentId))
          .for('update');
        if (!owner) throw new Error('Call owner does not exist');
        const [existing] = await tx
          .select()
          .from(callSessions)
          .where(eq(callSessions.id, input.id));
        if (existing) {
          if (
            existing.agentId !== input.agentId ||
            existing.taskId !== input.taskId ||
            existing.toolCallId !== input.toolCallId
          )
            throw new Error('Call admission identity belongs to another operation');
          return { kind: 'existing' as const, call: session(existing) };
        }
        const [active] = await tx
          .select({ id: callSessions.id })
          .from(callSessions)
          .where(
            and(
              eq(callSessions.agentId, input.agentId),
              inArray(callSessions.status, [...ACTIVE_CALL_STATUSES]),
            ),
          )
          .limit(1);
        if (active) return { kind: 'active_limit' as const };
        const since = new Date(options.now.getTime() - 24 * 60 * 60_000);
        const [daily] = await tx
          .select({ n: count() })
          .from(callSessions)
          .where(
            and(
              eq(callSessions.agentId, input.agentId),
              gte(callSessions.createdAt, since),
              isNull(callSessions.capacityReleasedAt),
            ),
          );
        if (Number(daily?.n ?? 0) >= options.dailyLimit) return { kind: 'daily_limit' as const };
        const [row] = await tx
          .insert(callSessions)
          .values({ ...input, createdAt: options.now })
          .returning();
        if (!row) throw new Error('Call admission was not created');
        return { kind: 'admitted' as const, call: session(row) };
      });
    },
    async releaseAdmission(id, now) {
      const [released] = await db
        .update(callSessions)
        .set({ capacityReleasedAt: now, updatedAt: sql`now()` })
        .where(
          and(
            eq(callSessions.id, id),
            eq(callSessions.status, 'failed'),
            isNull(callSessions.twilioCallSid),
            isNotNull(callSessions.endedAt),
            isNull(callSessions.capacityReleasedAt),
          ),
        )
        .returning({ id: callSessions.id });
      return Boolean(released);
    },
    get,
    async getByCallSid(callSid) {
      const [row] = await db
        .select()
        .from(callSessions)
        .where(eq(callSessions.twilioCallSid, callSid));
      return row ? session(row) : null;
    },
    list: async (agentId, limit) =>
      (
        await db
          .select()
          .from(callSessions)
          .where(eq(callSessions.agentId, agentId))
          .orderBy(desc(callSessions.createdAt))
          .limit(Math.max(1, Math.min(200, limit)))
      ).map(session),
    async countSince(agentId, since) {
      const [row] = await db
        .select({ n: count() })
        .from(callSessions)
        .where(and(eq(callSessions.agentId, agentId), gte(callSessions.createdAt, since)));
      return Number(row?.n ?? 0);
    },
    async activeCount(agentId) {
      const [row] = await db
        .select({ n: count() })
        .from(callSessions)
        .where(
          and(
            eq(callSessions.agentId, agentId),
            inArray(callSessions.status, [...ACTIVE_CALL_STATUSES]),
          ),
        );
      return Number(row?.n ?? 0);
    },
    async update(id, patch) {
      if (Object.keys(patch).length === 0) return;
      await db
        .update(callSessions)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(callSessions.id, id));
    },
    async claimStream(id, tokenHash, now) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(callSessions)
          .where(
            and(
              eq(callSessions.id, id),
              isNotNull(callSessions.streamTokenHash),
              inArray(callSessions.status, [...ACTIVE_CALL_STATUSES]),
            ),
          )
          .for('update');
        if (!row?.streamTokenHash || !hashesMatch(row.streamTokenHash, tokenHash)) return null;
        const [claimed] = await tx
          .update(callSessions)
          .set({
            streamTokenHash: null,
            status: 'in_progress',
            startedAt: now,
            updatedAt: sql`now()`,
          })
          .where(eq(callSessions.id, id))
          .returning();
        return claimed ? session(claimed) : null;
      });
    },
    async finish(id, patch) {
      const [row] = await db
        .update(callSessions)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(
          and(eq(callSessions.id, id), inArray(callSessions.status, [...ACTIVE_CALL_STATUSES])),
        )
        .returning();
      return row ? session(row) : null;
    },
    async listPendingFinishDelivery(agentId, limit, now = new Date()) {
      return (
        await db
          .select()
          .from(callSessions)
          .where(
            and(
              eq(callSessions.agentId, agentId),
              isNotNull(callSessions.finishDelivery),
              sql`(${callSessions.finishDelivery}->'costs'->>'done' = 'false' OR ${callSessions.finishDelivery}->>'resultDelivered' = 'false')`,
              sql`(${callSessions.finishDelivery}->>'nextAttemptAt')::timestamptz <= ${now.toISOString()}::timestamptz`,
            ),
          )
          .orderBy(sql`(${callSessions.finishDelivery}->>'nextAttemptAt')::timestamptz`)
          .limit(Math.max(1, Math.min(200, limit)))
      )
        .map(session)
        .filter((row) => {
          const delivery = isCallFinishDelivery(row.finishDelivery) ? row.finishDelivery : null;
          return Boolean(delivery && (!delivery.costs.done || !delivery.resultDelivered));
        });
    },
    async deferFinishDelivery(id) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({ finishDelivery: callSessions.finishDelivery })
          .from(callSessions)
          .where(eq(callSessions.id, id))
          .for('update');
        if (!isCallFinishDelivery(row?.finishDelivery)) return false;
        const delivery = row.finishDelivery;
        if (delivery.costs.done && delivery.resultDelivered) return false;
        const attempts = delivery.attempts + 1;
        const delayMs = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempts, 10));
        await tx
          .update(callSessions)
          .set({
            finishDelivery: {
              ...delivery,
              attempts,
              nextAttemptAt: new Date(Date.now() + delayMs),
            },
            updatedAt: sql`now()`,
          })
          .where(eq(callSessions.id, id));
        return true;
      });
    },
    async markFinishDelivery(id, leg) {
      const finishDelivery =
        leg === 'costs'
          ? sql`jsonb_set(coalesce(${callSessions.finishDelivery}, '{}'::jsonb), ARRAY['costs','done']::text[], 'true'::jsonb, false)`
          : sql`jsonb_set(coalesce(${callSessions.finishDelivery}, '{}'::jsonb), ARRAY['resultDelivered']::text[], 'true'::jsonb, false)`;
      const [row] = await db
        .update(callSessions)
        .set({
          finishDelivery,
          updatedAt: sql`now()`,
        })
        .where(and(eq(callSessions.id, id), isNotNull(callSessions.finishDelivery)))
        .returning({ finishDelivery: callSessions.finishDelivery });
      return isCallFinishDelivery(row?.finishDelivery)
        ? leg === 'costs'
          ? row.finishDelivery.costs.done
          : row.finishDelivery.resultDelivered
        : false;
    },
    async updateFinishCostLedger(id, ledger, resultCostUsd) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({ finishDelivery: callSessions.finishDelivery })
          .from(callSessions)
          .where(eq(callSessions.id, id))
          .for('update');
        if (!isCallFinishDelivery(row?.finishDelivery)) return false;
        const delivery = row.finishDelivery;
        if (delivery.costs.done) return false;
        await tx
          .update(callSessions)
          .set({
            finishDelivery: {
              ...delivery,
              result: { ...delivery.result, costUsd: resultCostUsd, costBreakdown: ledger },
              costs: { ...delivery.costs, ledger },
            },
            costUsd: resultCostUsd === null ? null : resultCostUsd.toFixed(6),
            updatedAt: sql`now()`,
          })
          .where(eq(callSessions.id, id));
        return true;
      });
    },
    async appendTranscript(id, lines) {
      if (lines.length === 0) return;
      await db
        .update(callSessions)
        .set({
          transcript: sql`${callSessions.transcript} || ${JSON.stringify(lines)}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(callSessions.id, id));
    },
    async appendTranscriptBatch(id, batch) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(callSessions)
          .where(eq(callSessions.id, id))
          .for('update');
        if (!row) return { accepted: false, reason: 'invalid', nextSequence: 1 } as const;
        const accepted = acceptCallTranscriptBatch(
          (row.transcript as import('@assistant/persistence').CallTranscriptLine[]) ?? [],
          row.transcriptState,
          batch,
        );
        if (accepted.result.accepted && !accepted.result.duplicate) {
          await tx
            .update(callSessions)
            .set({
              transcript: accepted.transcript,
              transcriptState: accepted.state,
              updatedAt: sql`now()`,
            })
            .where(eq(callSessions.id, id));
        }
        return accepted.result;
      });
    },
    async appendNote(id, note) {
      await db
        .update(callSessions)
        .set({
          notes: sql`${callSessions.notes} || ${JSON.stringify([note.slice(0, 500)])}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(callSessions.id, id));
    },
    async addCheckin(id, checkin) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(callSessions)
          .where(eq(callSessions.id, id))
          .for('update');
        if (!row || !(ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status)) return null;
        const checkins = (row.checkins as CallCheckin[] | undefined) ?? [];
        const revision =
          checkins.reduce((max, current) => Math.max(max, current.revision ?? 0), 0) + 1;
        const created: CallCheckin = { ...checkin, revision, deliveryStatus: 'pending' };
        const next = checkins.map((current) =>
          current.answer === null &&
          ['pending', 'delivered'].includes(current.deliveryStatus ?? 'pending')
            ? { ...current, deliveryStatus: 'superseded' as const }
            : current,
        );
        next.push(created);
        await tx
          .update(callSessions)
          .set({ checkins: next, updatedAt: sql`now()` })
          .where(eq(callSessions.id, id));
        return created;
      });
    },
    async markCheckinDelivery(id, checkinId, revision, delivered) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(callSessions)
          .where(eq(callSessions.id, id))
          .for('update');
        const checkins = (row?.checkins as CallCheckin[] | undefined) ?? [];
        const target = checkins.find(
          (checkin) => checkin.id === checkinId && checkin.revision === revision,
        );
        if (!row || !target || target.deliveryStatus !== 'pending' || target.answer !== null)
          return false;
        const live =
          (ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status) &&
          (!target.expiresAt || Date.parse(target.expiresAt) > Date.now());
        await tx
          .update(callSessions)
          .set({
            checkins: checkins.map((checkin) =>
              checkin.id === checkinId
                ? { ...checkin, deliveryStatus: delivered && live ? 'delivered' : 'failed' }
                : checkin,
            ),
            updatedAt: sql`now()`,
          })
          .where(eq(callSessions.id, id));
        return delivered && live;
      });
    },
    async answerCheckin(agentId, id, checkinId, revision, answer, via) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(callSessions)
          .where(and(eq(callSessions.id, id), eq(callSessions.agentId, agentId)))
          .for('update');
        const checkins = (row?.checkins as CallCheckin[] | undefined) ?? [];
        const target = checkins.find((checkin) => checkin.id === checkinId);
        const latest = [...checkins]
          .reverse()
          .find(
            (checkin) =>
              checkin.answer === null &&
              ['pending', 'delivered'].includes(checkin.deliveryStatus ?? 'pending'),
          );
        if (
          !row ||
          !target ||
          target.answer !== null ||
          target.revision !== revision ||
          target.deliveryStatus !== 'delivered' ||
          latest?.id !== target.id ||
          !(ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status) ||
          (target.expiresAt !== null &&
            target.expiresAt !== undefined &&
            Date.parse(target.expiresAt) <= Date.now())
        )
          return false;
        const answeredAt = new Date().toISOString();
        await tx
          .update(callSessions)
          .set({
            checkins: checkins.map((checkin) =>
              checkin.id === checkinId
                ? {
                    ...checkin,
                    answer: answer.slice(0, 1_000),
                    answeredAt,
                    via,
                    deliveryStatus: 'answered',
                  }
                : checkin,
            ),
            updatedAt: sql`now()`,
          })
          .where(eq(callSessions.id, id));
        return true;
      });
    },
    async requestHangup(agentId, id) {
      const rows = await db
        .update(callSessions)
        .set({ hangupRequested: true, updatedAt: sql`now()` })
        .where(
          and(
            eq(callSessions.id, id),
            eq(callSessions.agentId, agentId),
            inArray(callSessions.status, [...ACTIVE_CALL_STATUSES]),
          ),
        )
        .returning({ id: callSessions.id });
      return rows.length === 1;
    },
  };
}
