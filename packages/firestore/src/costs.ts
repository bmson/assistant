import { createHash, randomUUID } from 'node:crypto';
import {
  addLedgerMicros,
  addMicros,
  type CostEventInput,
  type CostRepository,
  type CostTotals,
  ledgerUsdToMicros,
  MAX_LEDGER_USD_MICROS,
  microsToUsd,
  nextUtcDailyReset,
  nextUtcMonthlyReset,
  type ReservationActual,
  type ReserveCostInput,
  type ReserveOutcome,
  storedLedgerUsdToMicros,
  storedTaskBudgetToMicros,
  usdToMicros,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { withEmulatorTransactionRetry } from './emulator-transaction.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

interface Policy {
  dailyLimitMicros: number;
  monthlyLimitMicros: number;
  softPct: number;
}

function integer(snapshot: DocumentSnapshot, field: string): number {
  const value: unknown = snapshot.get(field) ?? 0;
  if (typeof value !== 'number') throw new Error(`Invalid ledger counter ${field}`);
  microsToUsd(value);
  return value;
}

function policy(snapshot: DocumentSnapshot): Policy {
  if (!snapshot.exists) throw new Error('Budget policy has not been initialized');
  const data = snapshot.data() as Policy;
  microsToUsd(data.dailyLimitMicros);
  microsToUsd(data.monthlyLimitMicros);
  if (!Number.isInteger(data.softPct) || data.softPct < 0 || data.softPct > 100) {
    throw new Error('Invalid budget policy');
  }
  return data;
}

function fingerprint(input: ReserveCostInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.source,
        usdToMicros(input.estimatedUsd),
        input.taskId ?? null,
        input.description ?? '',
      ]),
    )
    .digest('hex');
}

/** Counters, hold transitions, ledger events, and per-task spend commit together. */
export class FirestoreCostRepository implements CostRepository {
  readonly kind = 'cost-repository' as const;

  constructor(private readonly store: InstallationStore) {}

  async getRate(key: string) {
    const snapshot = await this.store.doc('rateTable', key).get();
    if (!snapshot.exists) return null;
    const unitPriceUsd = Number(snapshot.get('unitPriceUsd'));
    if (!Number.isFinite(unitPriceUsd) || unitPriceUsd < 0) throw new Error('Invalid cost rate');
    return { unit: String(snapshot.get('unit')), unitPriceUsd };
  }

  private refs(now: Date, taskId?: string | null) {
    return {
      policy: this.store.doc('coordination', 'budget-policy'),
      holds: this.store.doc('coordination', 'budget-holds'),
      daily: this.store.doc('budgetPeriods', `day:${now.toISOString().slice(0, 10)}`),
      monthly: this.store.doc('budgetPeriods', `month:${now.toISOString().slice(0, 7)}`),
      ...(taskId
        ? {
            task: this.store.doc('tasks', taskId),
            taskHolds: this.store.doc('taskBudgetHolds', taskId),
          }
        : {}),
    };
  }

  async totals(): Promise<CostTotals> {
    return this.store.db.runTransaction(
      async (tx) => {
        const refs = this.refs(this.store.now());
        const [p, holds, daily, monthly] = await tx.getAll(
          refs.policy,
          refs.holds,
          refs.daily,
          refs.monthly,
        );
        if (!p || !holds || !daily || !monthly) throw new Error('Incomplete budget snapshot');
        const limits = policy(p);
        return {
          dailySpentUsd: microsToUsd(integer(daily, 'spentMicros')),
          monthlySpentUsd: microsToUsd(integer(monthly, 'spentMicros')),
          heldUsd: microsToUsd(integer(holds, 'heldMicros')),
          dailyLimitUsd: microsToUsd(limits.dailyLimitMicros),
          monthlyLimitUsd: microsToUsd(limits.monthlyLimitMicros),
          softPct: limits.softPct,
        };
      },
      { readOnly: true },
    );
  }

  async reserve(input: ReserveCostInput): Promise<ReserveOutcome> {
    const amount = ledgerUsdToMicros(input.estimatedUsd);
    if (amount <= 0) throw new Error('Cost estimate must be at least one microdollar');
    const id = input.operationId ?? randomUUID();
    const ref = this.store.doc('costReservations', id);
    const signature = fingerprint(input);
    return this.store.db.runTransaction(async (tx): Promise<ReserveOutcome> => {
      const now = this.store.now();
      const refs = this.refs(now, input.taskId);
      const [existing, p, holds, daily, monthly] = await tx.getAll(
        ref,
        refs.policy,
        refs.holds,
        refs.daily,
        refs.monthly,
      );
      if (!existing || !p || !holds || !daily || !monthly)
        throw new Error('Incomplete budget snapshot');
      if (existing.exists) {
        if (existing.get('fingerprint') !== signature)
          throw new Error('Reservation ID reused for different work');
        if (existing.get('status') === 'held') return { ok: true, reservationId: id };
        return {
          ok: false,
          reason: 'reservation already closed; do not repeat provider work',
          resumeAt: nextUtcDailyReset(now),
        };
      }
      const limits = policy(p);
      const held = integer(holds, 'heldMicros');
      const factor = input.critical ? 1.1 : 1;
      for (const [name, spent, cap, reset] of [
        [
          'monthly',
          integer(monthly, 'spentMicros'),
          limits.monthlyLimitMicros,
          nextUtcMonthlyReset(now),
        ],
        ['daily', integer(daily, 'spentMicros'), limits.dailyLimitMicros, nextUtcDailyReset(now)],
      ] as const) {
        if (addMicros(spent, held, amount) > Math.floor(cap * factor)) {
          return {
            ok: false,
            reason: `${name} budget cannot cover this reservation`,
            resumeAt: reset,
          };
        }
      }
      let taskHeld = 0;
      if (refs.task && refs.taskHolds) {
        const [task, taskHolds] = await tx.getAll(refs.task, refs.taskHolds);
        if (!task?.exists || !taskHolds) throw new Error('Reservation task does not exist');
        taskHeld = integer(taskHolds, 'heldMicros');
        const spent = storedLedgerUsdToMicros(task.get('spentUsd') ?? '0');
        const limit = storedTaskBudgetToMicros(task.get('budgetUsdLimit'));
        if (taskHeld > MAX_LEDGER_USD_MICROS - spent - amount) {
          return {
            ok: false,
            reason: 'task ledger storage capacity cannot cover this reservation',
            resumeAt: nextUtcDailyReset(now),
          };
        }
        if (addMicros(spent, taskHeld, amount) > Math.floor(limit * factor)) {
          return {
            ok: false,
            reason: 'task budget cannot cover this reservation',
            resumeAt: nextUtcDailyReset(now),
          };
        }
      }
      tx.set(refs.holds, { heldMicros: addMicros(held, amount) });
      if (refs.taskHolds) tx.set(refs.taskHolds, { heldMicros: addMicros(taskHeld, amount) });
      tx.create(ref, {
        id,
        taskId: input.taskId ?? null,
        source: input.source,
        estimatedUsd: microsToUsd(amount).toFixed(6),
        actualUsd: null,
        status: 'held',
        description: input.description ?? '',
        fingerprint: signature,
        createdAt: now,
        reconciledAt: null,
      });
      return { ok: true, reservationId: id };
    });
  }

  async beginAttempt(
    reservationId: string,
    metadata: import('@assistant/persistence').CostAttemptMetadata,
  ): Promise<boolean> {
    const ref = this.store.doc('costReservations', reservationId);
    return this.store.db.runTransaction(async (tx) => {
      const reservation = await tx.get(ref);
      if (!reservation.exists || reservation.get('status') !== 'held') return false;
      tx.update(ref, {
        status: 'dispatching',
        attemptStartedAt: this.store.now(),
        attemptMetadata: metadata,
      });
      return true;
    });
  }

  async markAttemptUnknown(
    reservationId: string,
    reason: string,
    providerReceipt?: { requestId?: string; endpoint?: string },
  ): Promise<void> {
    const ref = this.store.doc('costReservations', reservationId);
    await withEmulatorTransactionRetry(() =>
      this.store.db.runTransaction(async (tx) => {
        const reservation = await tx.get(ref);
        if (
          !reservation.exists ||
          !['dispatching', 'unknown'].includes(String(reservation.get('status')))
        )
          return;
        tx.update(ref, {
          status: 'unknown',
          unknownReason: reason.slice(0, 500),
          ...(providerReceipt
            ? {
                attemptMetadata: {
                  ...((reservation.get('attemptMetadata') as object) ?? {}),
                  ...providerReceipt,
                },
              }
            : {}),
        });
      }),
    );
  }

  private async settle(
    tx: Transaction,
    reservationId: string | null,
    actual: ReservationActual | null,
    direct?: CostEventInput,
    eventId = randomUUID(),
    staleBefore?: Date,
  ): Promise<boolean> {
    const now = this.store.now();
    const reservationRef = reservationId ? this.store.doc('costReservations', reservationId) : null;
    const reservation = reservationRef ? await tx.get(reservationRef) : null;
    const reservationStatus = reservation?.get('status');
    if (
      reservationRef &&
      (!reservation?.exists ||
        (actual === null
          ? reservationStatus !== 'held'
          : !['held', 'dispatching', 'unknown'].includes(String(reservationStatus))))
    )
      return false;
    if (staleBefore && reservation) {
      const created = decodeRecord<Date>(reservation.get('createdAt'));
      if (!(created instanceof Date) || created >= staleBefore) return false;
    }
    const taskId: string | null = reservation?.get('taskId') ?? direct?.taskId ?? null;
    const refs = this.refs(now, taskId);
    // Reservation status and event creation commit together, so the status guard
    // provides deduplication while the event retains its public UUID as its document ID.
    const eventRef = this.store.doc('costEvents', eventId);
    const [holds, daily, monthly, event] = await tx.getAll(
      refs.holds,
      refs.daily,
      refs.monthly,
      eventRef,
    );
    if (!holds || !daily || !monthly || !event) throw new Error('Incomplete ledger snapshot');
    if (event.exists) {
      if (direct?.idempotencyKey && event.get('idempotencyKey') === direct.idempotencyKey)
        return false;
      throw new Error('Ledger event already exists without a settled reservation');
    }
    const writesEvent = actual !== null || direct !== undefined;
    const amount = ledgerUsdToMicros(actual?.usd ?? direct?.usd ?? 0);
    const estimated = reservation ? storedLedgerUsdToMicros(reservation.get('estimatedUsd')) : 0;
    const held = integer(holds, 'heldMicros');
    if (held < estimated) throw new Error('Budget hold underflow');
    const shouldAddTaskSpend = writesEvent && Boolean(reservation || direct?.addToTaskSpend);
    let taskHeld = 0;
    let taskSpent = 0;
    if (refs.task && refs.taskHolds) {
      const [task, taskHolds] = await tx.getAll(refs.task, refs.taskHolds);
      if (!taskHolds || (!task?.exists && shouldAddTaskSpend))
        throw new Error('Ledger task does not exist');
      taskHeld = integer(taskHolds, 'heldMicros');
      taskSpent = storedLedgerUsdToMicros(task?.get('spentUsd') ?? '0');
      if (taskHeld < estimated) throw new Error('Task hold underflow');
    }
    // All reads are complete before any writes: Firestore may rerun this callback.
    if (reservationRef) {
      tx.update(reservationRef, {
        status: writesEvent ? 'reconciled' : 'released',
        actualUsd: writesEvent ? microsToUsd(amount).toFixed(6) : null,
        reconciledAt: now,
      });
      tx.set(refs.holds, { heldMicros: held - estimated });
      if (refs.taskHolds) tx.set(refs.taskHolds, { heldMicros: taskHeld - estimated });
    } else {
      // Direct spend and reservations contend on this same document.
      tx.set(refs.holds, { heldMicros: held });
    }
    if (writesEvent) {
      tx.set(refs.daily, { spentMicros: addMicros(integer(daily, 'spentMicros'), amount) });
      tx.set(refs.monthly, { spentMicros: addMicros(integer(monthly, 'spentMicros'), amount) });
      if (shouldAddTaskSpend && refs.task) {
        tx.update(refs.task, {
          spentUsd: microsToUsd(addLedgerMicros(taskSpent, amount)).toFixed(6),
          updatedAt: now,
        });
      }
      const details = actual ?? direct;
      tx.create(
        eventRef,
        encodeRecord({
          id: eventId,
          evidence: details?.evidence ?? { basis: 'unknown' },
          source: reservation?.get('source') ?? direct?.source,
          taskId,
          toolCallId: details?.toolCallId ?? null,
          reservationId,
          usd: microsToUsd(amount).toFixed(6),
          quantity: details?.quantity?.toFixed(4) ?? null,
          unit: details?.unit ?? null,
          unitPriceUsd: details?.unitPriceUsd?.toFixed(8) ?? null,
          description: details?.description ?? reservation?.get('description') ?? '',
          ...(direct?.idempotencyKey ? { idempotencyKey: direct.idempotencyKey } : {}),
          createdAt: now,
        }),
      );
    }
    return true;
  }

  async record(input: CostEventInput): Promise<void> {
    if (input.reservationId) throw new Error('Use reconcile to settle a reservation');
    const digest = input.idempotencyKey
      ? createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 32)
      : null;
    const id = (
      digest
        ? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20)}`
        : randomUUID()
    ) as ReturnType<typeof randomUUID>;
    await this.store.db.runTransaction((tx) => this.settle(tx, null, null, input, id));
  }

  async reconcile(reservationId: string, actual: ReservationActual): Promise<void> {
    ledgerUsdToMicros(actual.usd);
    const id = randomUUID();
    // Guarded by the reservation's held status, so a retry after a commit is a no-op.
    await withEmulatorTransactionRetry(() =>
      this.store.db.runTransaction((tx) => this.settle(tx, reservationId, actual, undefined, id)),
    );
  }

  async release(reservationId: string): Promise<void> {
    await withEmulatorTransactionRetry(() =>
      this.store.db.runTransaction((tx) => this.settle(tx, reservationId, null)),
    );
  }

  async releaseStale(olderThanMinutes = 120, batch = 500): Promise<number> {
    if (
      !Number.isFinite(olderThanMinutes) ||
      olderThanMinutes <= 0 ||
      !Number.isInteger(batch) ||
      batch < 1 ||
      batch > 500
    ) {
      throw new Error('Invalid reservation cleanup bounds');
    }
    const cutoff = new Date(this.store.now().getTime() - olderThanMinutes * 60_000);
    const stale = await this.store
      .collection('costReservations')
      .where('status', '==', 'held')
      .where('createdAt', '<', cutoff)
      .orderBy('createdAt')
      .limit(batch)
      .get();
    let released = 0;
    for (const doc of stale.docs) {
      const pendingCalls = await this.store
        .collection('callSessions')
        .where('reservationId', '==', doc.get('id'))
        .limit(10)
        .get();
      if (
        pendingCalls.docs.some((call) => {
          const delivery = call.get('finishDelivery') as { costs?: { done?: unknown } } | undefined;
          return delivery?.costs?.done === false;
        })
      )
        continue;
      if (
        await withEmulatorTransactionRetry(() =>
          this.store.db.runTransaction((tx) =>
            this.settle(tx, doc.get('id'), null, undefined, undefined, cutoff),
          ),
        )
      )
        released++;
    }
    const staleDispatches = await this.store
      .collection('costReservations')
      .where('status', '==', 'dispatching')
      .where('attemptStartedAt', '<', cutoff)
      .orderBy('attemptStartedAt')
      .limit(batch)
      .get();
    for (const doc of staleDispatches.docs) {
      const id = String(doc.get('id') ?? doc.id);
      const ref = this.store.doc('costReservations', id);
      const transitioned = await withEmulatorTransactionRetry(() =>
        this.store.db.runTransaction(async (tx) => {
          const current = await tx.get(ref);
          if (!current.exists || current.get('status') !== 'dispatching') return false;
          tx.update(ref, {
            status: 'unknown',
            unknownReason: 'provider dispatch exceeded reconciliation window',
          });
          return true;
        }),
      );
      if (transitioned) released++;
    }
    return released;
  }
}
