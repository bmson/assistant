import {
  addMicros,
  type CostBasis,
  type CostEvidence,
  costBasis,
  microsToUsd,
  storedLedgerUsdToMicros,
  usdToMicros,
} from '@assistant/persistence';
import type { Query, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { FirestoreCostRepository } from './costs.js';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { FirestoreSettingsRepository } from './settings.js';
import { decodeRecord, type InstallationStore } from './store.js';

const PAGE_SIZE = 1000;
const UNKNOWN_ATTEMPT_SCAN_LIMIT = 501;

interface CostEvent {
  evidence?: CostEvidence;
  id: string;
  taskId: string | null;
  source: string;
  description: string;
  usd: string;
  createdAt: Date;
}

interface ModelCall {
  model: string;
  costUsd: string;
  createdAt: Date;
}

interface Reservation {
  id: string;
  source: string;
  description: string;
  estimatedUsd: string;
  status: string;
}

interface UnknownAttemptSummary {
  count: number;
  countComplete: boolean;
  estimatedUsd: string | null;
  estimateComplete: boolean;
}

interface ModelCostEvidenceGroup {
  provider: string | null;
  model: string | null;
  basis: CostBasis;
  micros: number;
  count: number;
}

function evidenceDimension(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function compareEvidenceDimension(left: string | null, right: string | null): number {
  const a = left ?? '';
  const b = right ?? '';
  return a < b ? -1 : a > b ? 1 : 0;
}

function modelEvidenceRows(groups: Map<string, ModelCostEvidenceGroup>) {
  return [...groups.values()]
    .sort((a, b) => {
      if (a.micros !== b.micros) return a.micros > b.micros ? -1 : 1;
      const providerOrder = compareEvidenceDimension(a.provider, b.provider);
      if (providerOrder !== 0) return providerOrder;
      const modelOrder = compareEvidenceDimension(a.model, b.model);
      return modelOrder || (a.basis < b.basis ? -1 : a.basis > b.basis ? 1 : 0);
    })
    .map(({ micros, ...row }) => ({ ...row, usd: microsToUsd(micros).toFixed(6) }));
}

export function summarizeUnknownAttemptEstimates(
  estimates: readonly unknown[],
  truncated: boolean,
): UnknownAttemptSummary {
  if (truncated)
    return {
      count: UNKNOWN_ATTEMPT_SCAN_LIMIT,
      countComplete: false,
      estimatedUsd: null,
      estimateComplete: false,
    };
  let micros = 0;
  try {
    for (const value of estimates) {
      micros = addMicros(micros, storedLedgerUsdToMicros(value));
    }
  } catch {
    return {
      count: estimates.length,
      countComplete: true,
      estimatedUsd: null,
      estimateComplete: false,
    };
  }
  return {
    count: estimates.length,
    countComplete: true,
    estimatedUsd: microsToUsd(micros).toFixed(6),
    estimateComplete: true,
  };
}

/** One bounded snapshot prevents a count/sum race; 501 means the amount is unknown. */
export async function unknownAttemptSummary(
  store: Pick<InstallationStore, 'collection'>,
): Promise<UnknownAttemptSummary> {
  const snapshot = await store
    .collection('costReservations')
    .where('status', '==', 'unknown')
    .select('estimatedUsd')
    .limit(UNKNOWN_ATTEMPT_SCAN_LIMIT)
    .get();
  const complete = snapshot.size < UNKNOWN_ATTEMPT_SCAN_LIMIT;
  if (!complete) return summarizeUnknownAttemptEstimates([], true);
  return summarizeUnknownAttemptEstimates(
    snapshot.docs.map((doc) => doc.get('estimatedUsd')),
    false,
  );
}

/** One bounded snapshot of reservations with the retained dispatching status. */
export async function dispatchingAttemptSummary(
  store: Pick<InstallationStore, 'collection'>,
): Promise<UnknownAttemptSummary> {
  const snapshot = await store
    .collection('costReservations')
    .where('status', '==', 'dispatching')
    .select('estimatedUsd')
    .limit(UNKNOWN_ATTEMPT_SCAN_LIMIT)
    .get();
  const complete = snapshot.size < UNKNOWN_ATTEMPT_SCAN_LIMIT;
  if (!complete) return summarizeUnknownAttemptEstimates([], true);
  return summarizeUnknownAttemptEstimates(
    snapshot.docs.map((doc) => doc.get('estimatedUsd')),
    false,
  );
}

/** Reads every matching page. A dashboard must never present a partial spend total. */
async function scan<T>(query: Query, visit: (row: T) => void): Promise<void> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const page = await (cursor ? query.startAfter(cursor) : query).limit(PAGE_SIZE).get();
    for (const doc of page.docs) visit(decodeRecord<T>(doc.data()));
    cursor = page.docs.at(-1);
    if (page.size < PAGE_SIZE) return;
  }
}

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function ranked<K extends string>(values: Map<K, { micros: number; count: number }>) {
  return [...values.entries()]
    .map(([key, value]) => ({ key, usd: microsToUsd(value.micros).toFixed(6), count: value.count }))
    .sort((a, b) => Number(b.usd) - Number(a.usd) || a.key.localeCompare(b.key));
}

/** Owner-scoped presentation read for the mobile workspace cost section. */
export async function getFirestoreMobileCosts(store: InstallationStore, agentId: string) {
  if (!agentId) throw new Error('Cost dashboard requires a configured agent');
  const owner = await new FirestoreSettingsRepository(store, agentId).getOwner();
  if (!owner) throw new Error('Cost dashboard owner is missing');
  const fence = await readPrivacyErasureFence(store, owner.id);
  const since = monthStart(store.now());
  const until = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth() + 1, 1));
  const bySource = new Map<string, { micros: number; count: number }>();
  const byModel = new Map<string, { micros: number; count: number }>();
  const byModelEvidence = new Map<string, ModelCostEvidenceGroup>();
  const byTask = new Map<string, number>();
  const byEvidence = new Map<CostBasis, { micros: number; count: number }>();
  const totals = await new FirestoreCostRepository(store).totals();

  await Promise.all([
    scan<CostEvent>(
      store
        .collection('costEvents')
        .where('createdAt', '>=', since)
        .where('createdAt', '<', until)
        .orderBy('createdAt')
        // Only the fields the totals read; a month of events used to come back in full.
        .select('createdAt', 'usd', 'source', 'evidence', 'taskId'),
      (event) => {
        if (
          !(event.createdAt instanceof Date) ||
          event.createdAt < since ||
          event.createdAt >= until
        )
          throw new Error('Invalid cost event timestamp');
        const micros = usdToMicros(Number(event.usd));
        const aggregate = bySource.get(event.source) ?? { micros: 0, count: 0 };
        aggregate.micros = addMicros(aggregate.micros, micros);
        aggregate.count += 1;
        bySource.set(event.source, aggregate);
        const basis = costBasis(event.evidence);
        const evidenceTotal = byEvidence.get(basis) ?? { micros: 0, count: 0 };
        evidenceTotal.micros = addMicros(evidenceTotal.micros, micros);
        evidenceTotal.count += 1;
        byEvidence.set(basis, evidenceTotal);
        if (event.source === 'model') {
          const provider = evidenceDimension(event.evidence?.provider);
          const model = evidenceDimension(event.evidence?.model);
          const key = JSON.stringify([provider, model, basis]);
          const modelEvidence = byModelEvidence.get(key) ?? {
            provider,
            model,
            basis,
            micros: 0,
            count: 0,
          };
          modelEvidence.micros = addMicros(
            modelEvidence.micros,
            storedLedgerUsdToMicros(event.usd),
          );
          modelEvidence.count += 1;
          byModelEvidence.set(key, modelEvidence);
        }
        if (event.taskId)
          byTask.set(event.taskId, addMicros(byTask.get(event.taskId) ?? 0, micros));
      },
    ),
    scan<ModelCall>(
      store
        .collection('modelCalls')
        .where('createdAt', '>=', since)
        .where('createdAt', '<', until)
        .orderBy('createdAt')
        .select('createdAt', 'model', 'costUsd'),
      (call) => {
        if (!(call.createdAt instanceof Date) || call.createdAt < since || call.createdAt >= until)
          throw new Error('Invalid model call timestamp');
        const aggregate = byModel.get(call.model) ?? { micros: 0, count: 0 };
        aggregate.micros = addMicros(aggregate.micros, usdToMicros(Number(call.costUsd)));
        aggregate.count += 1;
        byModel.set(call.model, aggregate);
      },
    ),
  ]);

  const taskIds = [...byTask.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10);
  const [
    taskDefault,
    heldSnapshot,
    dispatchingAttempts,
    unknownAttempts,
    recentSnapshot,
    parkedSnapshot,
    ...taskSnapshots
  ] = await Promise.all([
    store.doc('budgets', 'task_default').get(),
    store
      .collection('costReservations')
      .where('status', '==', 'held')
      .orderBy('createdAt', 'desc')
      .get(),
    dispatchingAttemptSummary(store),
    unknownAttemptSummary(store),
    store.collection('costEvents').orderBy('createdAt', 'desc').limit(15).get(),
    store.collection('tasks').where('status', '==', 'waiting_budget').count().get(),
    ...taskIds.map(([id]) => store.doc('tasks', id).get()),
  ]);
  const topTasks = taskIds.flatMap(([taskId, micros], index) => {
    const snapshot = taskSnapshots[index];
    if (!snapshot?.exists) return [];
    const row = decodeRecord<{ type: string; progress: string }>(snapshot.data());
    return [
      { taskId, usd: microsToUsd(micros).toFixed(6), type: row.type, progress: row.progress },
    ];
  });
  const held = heldSnapshot.docs.map((doc) => {
    const row = decodeRecord<Reservation>(doc.data());
    if (row.status !== 'held') throw new Error('Invalid held reservation');
    return {
      id: row.id,
      source: row.source,
      description: row.description,
      estimatedUsd: row.estimatedUsd,
    };
  });
  const recent = recentSnapshot.docs.map((doc) => {
    const row = decodeRecord<CostEvent>(doc.data());
    return {
      id: row.id,
      createdAt: row.createdAt,
      source: row.source,
      description: row.description,
      usd: row.usd,
      evidence: row.evidence ?? { basis: 'unknown' as const },
    };
  });
  const defaultBudget = taskDefault.exists
    ? decodeRecord<{ limitUsd: string }>(taskDefault.data())
    : null;
  const result = {
    byEvidence: ranked(byEvidence).map(({ key, ...value }) => ({ basis: key, ...value })),
    timezone: owner.timezone,
    totals,
    bySource: ranked(bySource).map(({ key, ...value }) => ({ source: key, ...value })),
    byModel: ranked(byModel).map(({ key, ...value }) => ({ model: key, ...value })),
    byModelEvidence: modelEvidenceRows(byModelEvidence),
    topTasks,
    held,
    dispatchingAttempts,
    unknownAttempts,
    recent,
    parkedTasks: parkedSnapshot.data().count,
    taskDefaultLimit: defaultBudget?.limitUsd ?? null,
  };
  await assertPrivacyErasureFenceUnchanged(store, owner.id, fence);
  return result;
}
