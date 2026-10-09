import { timingSafeEqual } from 'node:crypto';
import {
  ACTIVE_CALL_STATUSES,
  acceptCallTranscriptBatch,
  assertCallAdmissionOptions,
  type CallAdmissionOptions,
  type CallAdmissionResult,
  type CallCheckin,
  type CallSession,
  type CallSessionCreate,
  type CallSessionPatch,
  type CallSessionRepository,
  type CallTranscriptLine,
  isCallFinishDelivery,
  isCallLineRate,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const COLLECTION = 'callSessions';
/** Firestore documents cap at 1 MiB; keep transcripts well under it. */
const MAX_TRANSCRIPT_LINES = 2_000;

function hashesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Phone calls for the configured owner. Every read checks the owner scope. */
export class FirestoreCallSessionRepository implements CallSessionRepository {
  readonly kind = 'call-session-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {
    if (!agentId) throw new Error('Call sessions require an agent identity');
  }

  private owned(snapshot: DocumentSnapshot | undefined): CallSession | null {
    if (!snapshot?.exists) return null;
    const row = decodeRecord<CallSession>(snapshot.data());
    if (row?.agentId !== this.agentId || documentKey(row.id) !== snapshot.id) return null;
    return { ...row, lineRate: isCallLineRate(row.lineRate) ? row.lineRate : null };
  }

  private async mutate(
    id: string,
    change: (row: CallSession, tx: Transaction) => Partial<CallSession> | null,
  ): Promise<CallSession | null> {
    const ref = this.store.doc(COLLECTION, id);
    return this.store.db.runTransaction(async (tx) => {
      const row = this.owned(await tx.get(ref));
      if (!row) return null;
      const patch = change(row, tx);
      if (!patch) return null;
      const next = { ...row, ...patch, updatedAt: this.store.now() };
      tx.set(ref, encodeRecord(next));
      return next;
    });
  }

  private record(input: CallSessionCreate, now: Date): CallSession {
    if (input.agentId !== this.agentId) throw new Error('Call is outside the configured owner');
    return {
      ...input,
      createdAt: now,
      updatedAt: now,
      twilioCallSid: null,
      answeredBy: null,
      startedAt: null,
      endedAt: null,
      durationSeconds: null,
      transcript: [],
      transcriptState: { nextSequence: 1, pending: [], acknowledged: [] },
      notes: [],
      checkins: [],
      hangupRequested: false,
      outcome: null,
      summary: null,
      costUsd: null,
      error: null,
      finishDelivery: null,
      lineRate: input.lineRate ?? null,
      capacityReleasedAt: null,
    };
  }

  async create(input: CallSessionCreate): Promise<CallSession> {
    const row = this.record(input, this.store.now());
    await this.store.doc(COLLECTION, input.id).create(encodeRecord(row));
    return row;
  }

  async admit(
    input: CallSessionCreate,
    options: CallAdmissionOptions,
  ): Promise<CallAdmissionResult> {
    assertCallAdmissionOptions(options);
    if (input.agentId !== this.agentId || input.status !== 'dialing')
      throw new Error('Call admission is outside the owner or dialing state');
    const coordination = this.store.doc('coordination', `call-admission:${this.agentId}`);
    const ref = this.store.doc(COLLECTION, input.id);
    return this.store.db.runTransaction(async (tx) => {
      const fence = await tx.get(coordination);
      if (fence.exists && fence.get('agentId') !== this.agentId)
        throw new Error('Call admission fence belongs to another owner');
      const existingSnapshot = await tx.get(ref);
      if (existingSnapshot.exists) {
        const existing = this.owned(existingSnapshot);
        if (
          !existing ||
          existing.taskId !== input.taskId ||
          existing.toolCallId !== input.toolCallId
        )
          throw new Error('Call admission identity belongs to another operation');
        return { kind: 'existing', call: existing };
      }
      const active = await tx.get(
        this.store
          .collection(COLLECTION)
          .where('agentId', '==', this.agentId)
          .where('status', 'in', [...ACTIVE_CALL_STATUSES])
          .limit(1),
      );
      if (!active.empty) return { kind: 'active_limit' };
      const since = new Date(options.now.getTime() - 24 * 60 * 60_000);
      // Include legacy rows without a release projection. An unusually large
      // history fails closed instead of guessing the number of occupied slots.
      const recent = await tx.get(
        this.store
          .collection(COLLECTION)
          .where('agentId', '==', this.agentId)
          .where('createdAt', '>=', since)
          .limit(501),
      );
      if (recent.size > 500) throw new Error('Call capacity history exceeds its safe bound');
      const used = recent.docs.filter((doc) => doc.get('capacityReleasedAt') == null).length;
      if (used >= options.dailyLimit) return { kind: 'daily_limit' };
      const row = this.record(input, options.now);
      tx.set(coordination, { agentId: this.agentId, updatedAt: options.now });
      tx.create(ref, encodeRecord(row));
      return { kind: 'admitted', call: row };
    });
  }

  async releaseAdmission(id: string, now: Date): Promise<boolean> {
    return Boolean(
      await this.mutate(id, (row) =>
        row.status === 'failed' && !row.twilioCallSid && row.endedAt && !row.capacityReleasedAt
          ? { capacityReleasedAt: now }
          : null,
      ),
    );
  }

  async get(id: string): Promise<CallSession | null> {
    return this.owned(await this.store.doc(COLLECTION, id).get());
  }

  async getByCallSid(callSid: string): Promise<CallSession | null> {
    const page = await this.store
      .collection(COLLECTION)
      .where('twilioCallSid', '==', callSid)
      .limit(2)
      .get();
    if (page.size !== 1) return null;
    return this.owned(page.docs[0]);
  }

  async list(agentId: string, limit: number): Promise<CallSession[]> {
    if (agentId !== this.agentId) return [];
    const page = await this.store
      .collection(COLLECTION)
      .where('agentId', '==', agentId)
      .orderBy('createdAt', 'desc')
      .limit(Math.max(1, Math.min(200, limit)))
      .get();
    return page.docs.flatMap((doc) => {
      const row = this.owned(doc);
      return row ? [row] : [];
    });
  }

  async countSince(agentId: string, since: Date): Promise<number> {
    if (agentId !== this.agentId) return 0;
    const result = await this.store
      .collection(COLLECTION)
      .where('agentId', '==', agentId)
      .where('createdAt', '>=', since)
      .count()
      .get();
    return result.data().count;
  }

  async activeCount(agentId: string): Promise<number> {
    if (agentId !== this.agentId) return 0;
    const result = await this.store
      .collection(COLLECTION)
      .where('agentId', '==', agentId)
      .where('status', 'in', [...ACTIVE_CALL_STATUSES])
      .count()
      .get();
    return result.data().count;
  }

  async update(id: string, patch: CallSessionPatch): Promise<void> {
    await this.mutate(id, () => patch);
  }

  async claimStream(id: string, tokenHash: string, now: Date): Promise<CallSession | null> {
    return this.mutate(id, (row) =>
      row.streamTokenHash &&
      hashesMatch(row.streamTokenHash, tokenHash) &&
      (ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status)
        ? { streamTokenHash: null, status: 'in_progress', startedAt: now }
        : null,
    );
  }

  async finish(id: string, patch: CallSessionPatch): Promise<CallSession | null> {
    return this.mutate(id, (row) =>
      (ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status) ? patch : null,
    );
  }

  async listPendingFinishDelivery(
    agentId: string,
    limit: number,
    now = this.store.now(),
  ): Promise<CallSession[]> {
    if (agentId !== this.agentId) return [];
    const bounded = Math.max(1, Math.min(200, limit));
    const [costPage, resultPage] = await Promise.all([
      this.store
        .collection(COLLECTION)
        .where('agentId', '==', agentId)
        .where('finishDelivery.costs.done', '==', false)
        .where('finishDelivery.nextAttemptAt', '<=', now)
        .orderBy('finishDelivery.nextAttemptAt', 'asc')
        .limit(bounded)
        .get(),
      this.store
        .collection(COLLECTION)
        .where('agentId', '==', agentId)
        .where('finishDelivery.resultDelivered', '==', false)
        .where('finishDelivery.nextAttemptAt', '<=', now)
        .orderBy('finishDelivery.nextAttemptAt', 'asc')
        .limit(bounded)
        .get(),
    ]);
    const docs = new Map([...costPage.docs, ...resultPage.docs].map((doc) => [doc.id, doc]));
    return [...docs.values()].flatMap((doc) => {
      const row = this.owned(doc);
      const delivery = row && isCallFinishDelivery(row.finishDelivery) ? row.finishDelivery : null;
      return delivery && (!delivery.costs.done || !delivery.resultDelivered)
        ? [row as CallSession]
        : [];
    });
  }

  async deferFinishDelivery(id: string): Promise<boolean> {
    const updated = await this.mutate(id, (row) => {
      const delivery = isCallFinishDelivery(row.finishDelivery) ? row.finishDelivery : null;
      if (!delivery || (delivery.costs.done && delivery.resultDelivered)) return null;
      const attempts = delivery.attempts + 1;
      const delayMs = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempts, 10));
      return {
        finishDelivery: {
          ...delivery,
          attempts,
          nextAttemptAt: new Date(this.store.now().getTime() + delayMs),
        },
      };
    });
    return updated !== null;
  }

  async markFinishDelivery(id: string, leg: 'costs' | 'result'): Promise<boolean> {
    const updated = await this.mutate(id, (row) => {
      const delivery = isCallFinishDelivery(row.finishDelivery) ? row.finishDelivery : null;
      if (!delivery) return null;
      if (leg === 'costs')
        return { finishDelivery: { ...delivery, costs: { ...delivery.costs, done: true } } };
      return { finishDelivery: { ...delivery, resultDelivered: true } };
    });
    const delivery =
      updated && isCallFinishDelivery(updated.finishDelivery) ? updated.finishDelivery : null;
    return leg === 'costs' ? Boolean(delivery?.costs.done) : Boolean(delivery?.resultDelivered);
  }

  async updateFinishCostLedger(
    id: string,
    ledger: import('@assistant/persistence').CallCostLedger,
    resultCostUsd: number | null,
  ): Promise<boolean> {
    const updated = await this.mutate(id, (row) => {
      const delivery = isCallFinishDelivery(row.finishDelivery) ? row.finishDelivery : null;
      if (!delivery || delivery.costs.done) return null;
      return {
        finishDelivery: {
          ...delivery,
          result: { ...delivery.result, costUsd: resultCostUsd, costBreakdown: ledger },
          costs: { ...delivery.costs, ledger },
        },
        costUsd: resultCostUsd === null ? null : resultCostUsd.toFixed(6),
      };
    });
    return Boolean(updated && isCallFinishDelivery(updated.finishDelivery));
  }

  async appendTranscript(id: string, lines: readonly CallTranscriptLine[]): Promise<void> {
    if (lines.length === 0) return;
    await this.mutate(id, (row) => ({
      transcript: [...((row.transcript as CallTranscriptLine[]) ?? []), ...lines].slice(
        -MAX_TRANSCRIPT_LINES,
      ),
    }));
  }

  async appendTranscriptBatch(
    id: string,
    batch: import('@assistant/persistence').CallTranscriptBatch,
  ) {
    const ref = this.store.doc(COLLECTION, id);
    return this.store.db.runTransaction(async (tx) => {
      const row = this.owned(await tx.get(ref));
      if (!row) return { accepted: false, reason: 'invalid', nextSequence: 1 } as const;
      const accepted = acceptCallTranscriptBatch(
        (row.transcript as CallTranscriptLine[]) ?? [],
        row.transcriptState,
        batch,
      );
      if (accepted.result.accepted && !accepted.result.duplicate) {
        tx.set(
          ref,
          encodeRecord({
            ...row,
            transcript: accepted.transcript.slice(-MAX_TRANSCRIPT_LINES),
            transcriptState: accepted.state,
            updatedAt: this.store.now(),
          }),
        );
      }
      return accepted.result;
    });
  }

  async appendNote(id: string, note: string): Promise<void> {
    await this.mutate(id, (row) => ({
      notes: [...((row.notes as string[]) ?? []), note.slice(0, 500)].slice(-100),
    }));
  }

  async addCheckin(id: string, checkin: CallCheckin): Promise<CallCheckin | null> {
    const updated = await this.mutate(id, (row) => {
      if (!(ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status)) return null;
      const checkins = (row.checkins as CallCheckin[]) ?? [];
      const revision =
        checkins.reduce((max, current) => Math.max(max, current.revision ?? 0), 0) + 1;
      const created: CallCheckin = { ...checkin, revision, deliveryStatus: 'pending' };
      return {
        checkins: [
          ...checkins.map((current) =>
            current.answer === null &&
            ['pending', 'delivered'].includes(current.deliveryStatus ?? 'pending')
              ? { ...current, deliveryStatus: 'superseded' as const }
              : current,
          ),
          created,
        ],
      };
    });
    return updated ? ((updated.checkins as CallCheckin[]).at(-1) ?? null) : null;
  }

  async markCheckinDelivery(
    id: string,
    checkinId: string,
    revision: number,
    delivered: boolean,
  ): Promise<boolean> {
    let accepted = false;
    const updated = await this.mutate(id, (row) => {
      const checkins = (row.checkins as CallCheckin[]) ?? [];
      const target = checkins.find(
        (checkin) => checkin.id === checkinId && checkin.revision === revision,
      );
      const live =
        (ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status) &&
        (!target?.expiresAt || Date.parse(target.expiresAt) > this.store.now().getTime());
      if (target?.deliveryStatus !== 'pending' || target.answer !== null) return null;
      accepted = delivered && live;
      return {
        checkins: checkins.map((checkin) =>
          checkin.id === checkinId
            ? { ...checkin, deliveryStatus: accepted ? 'delivered' : 'failed' }
            : checkin,
        ),
      };
    });
    return updated !== null && accepted;
  }

  async answerCheckin(
    agentId: string,
    id: string,
    checkinId: string,
    revision: number,
    answer: string,
    via: string,
  ): Promise<boolean> {
    if (agentId !== this.agentId) return false;
    const updated = await this.mutate(id, (row) => {
      const checkins = (row.checkins as CallCheckin[]) ?? [];
      const target = checkins.find((checkin) => checkin.id === checkinId);
      const latest = [...checkins]
        .reverse()
        .find(
          (checkin) =>
            checkin.answer === null &&
            ['pending', 'delivered'].includes(checkin.deliveryStatus ?? 'pending'),
        );
      if (
        !target ||
        target.answer !== null ||
        target.revision !== revision ||
        target.deliveryStatus !== 'delivered' ||
        latest?.id !== target.id ||
        !(ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status) ||
        (target.expiresAt !== null &&
          target.expiresAt !== undefined &&
          Date.parse(target.expiresAt) <= this.store.now().getTime())
      )
        return null;
      return {
        checkins: checkins.map((checkin) =>
          checkin.id === checkinId
            ? {
                ...checkin,
                answer: answer.slice(0, 1_000),
                answeredAt: this.store.now().toISOString(),
                via,
                deliveryStatus: 'answered',
              }
            : checkin,
        ),
      };
    });
    return updated !== null;
  }

  async requestHangup(agentId: string, id: string): Promise<boolean> {
    if (agentId !== this.agentId) return false;
    const updated = await this.mutate(id, (row) =>
      (ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status)
        ? { hangupRequested: true }
        : null,
    );
    return updated !== null;
  }
}
