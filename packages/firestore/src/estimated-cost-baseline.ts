import { createHash } from 'node:crypto';
import {
  type CurrentBaselineReservation,
  currentHistoricalUnknownMicros,
  type EstimatedCostActor,
  type HistoricalUnknownBaselineRow,
  parseHistoricalUnknownBaseline,
  storedLedgerUsdToMicros,
} from '@assistant/persistence';
import { Timestamp, type Transaction } from '@google-cloud/firestore';
import { decodeRecord, type InstallationStore } from './store.js';

/** Read the frozen baseline and every canonical row in the caller's transaction. */
export async function firestoreEstimatedCostBaseline(
  tx: Transaction,
  store: InstallationStore,
  actor: EstimatedCostActor,
  heldMicros: number,
): Promise<{
  frozen: HistoricalUnknownBaselineRow[];
  eligible: HistoricalUnknownBaselineRow[];
  eligibleMicros: number;
} | null> {
  if (
    actor.installationId !== store.installationId ||
    !Number.isSafeInteger(heldMicros) ||
    heldMicros < 0
  )
    return null;
  const baseline = await tx.get(store.doc('estimatedCostBaselines', actor.installationId));
  if (
    !baseline.exists ||
    baseline.get('installationId') !== actor.installationId ||
    baseline.get('ownerId') !== actor.ownerId
  )
    return null;
  const capturedAt = baseline.createTime;
  if (!(capturedAt instanceof Timestamp)) return null;
  const frozen = parseHistoricalUnknownBaseline(decodeRecord(baseline.get('rows')));
  if (
    !frozen ||
    createHash('sha256').update(JSON.stringify(frozen)).digest('hex') !== baseline.get('digest')
  )
    return null;
  const docs = frozen.length
    ? await tx.getAll(...frozen.map((row) => store.doc('costReservations', row.reservationId)))
    : [];
  try {
    const current: CurrentBaselineReservation[] = docs
      .filter((doc) => doc.exists)
      .map((doc) => {
        const createdAt = doc.createTime;
        return {
          reservationId: String(doc.get('id') ?? ''),
          estimatedMicros: storedLedgerUsdToMicros(doc.get('estimatedUsd')),
          status: String(doc.get('status') ?? ''),
          provenance:
            (doc.get('reservationKind') === undefined ||
              doc.get('reservationKind') === 'attempt') &&
            doc.get('costGrantId') == null &&
            createdAt instanceof Timestamp &&
            (createdAt.seconds < capturedAt.seconds ||
              (createdAt.seconds === capturedAt.seconds &&
                createdAt.nanoseconds <= capturedAt.nanoseconds))
              ? ('proven-historical-unapproved' as const)
              : ('unrecognized' as const),
        };
      });
    const eligibleMicros = currentHistoricalUnknownMicros(frozen, current);
    if (eligibleMicros === null || eligibleMicros > heldMicros) return null;
    const unknownIds = new Set(
      current.filter((row) => row.status === 'unknown').map((row) => row.reservationId),
    );
    return {
      frozen,
      eligible: frozen.filter((row) => unknownIds.has(row.reservationId)),
      eligibleMicros,
    };
  } catch {
    return null;
  }
}
