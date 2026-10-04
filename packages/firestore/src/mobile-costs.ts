import {
  addMicros,
  type CostBasis,
  type CostEvidence,
  costBasis,
  microsToUsd,
  usdToMicros,
} from '@assistant/persistence';
import type { Query, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { FirestoreCostRepository } from './costs.js';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { FirestoreSettingsRepository } from './settings.js';
import { decodeRecord, type InstallationStore } from './store.js';

const PAGE_SIZE = 1000;

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
  const bySource = new Map<string, { micros: number; count: number }>();
  const byModel = new Map<string, { micros: number; count: number }>();
  const byTask = new Map<string, number>();
  const byEvidence = new Map<CostBasis, { micros: number; count: number }>();
  const totals = await new FirestoreCostRepository(store).totals();

  await Promise.all([
    scan<CostEvent>(
      store
        .collection('costEvents')
        .where('createdAt', '>=', since)
        .orderBy('createdAt')
        // Only the fields the totals read; a month of events used to come back in full.
        .select('createdAt', 'usd', 'source', 'evidence', 'taskId'),
      (event) => {
        if (!(event.createdAt instanceof Date) || event.createdAt < since)
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
        if (event.taskId)
          byTask.set(event.taskId, addMicros(byTask.get(event.taskId) ?? 0, micros));
      },
    ),
    scan<ModelCall>(
      store
        .collection('modelCalls')
        .where('createdAt', '>=', since)
        .orderBy('createdAt')
        .select('createdAt', 'model', 'costUsd'),
      (call) => {
        if (!(call.createdAt instanceof Date) || call.createdAt < since)
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
  const [taskDefault, heldSnapshot, recentSnapshot, parkedSnapshot, ...taskSnapshots] =
    await Promise.all([
      store.doc('budgets', 'task_default').get(),
      store
        .collection('costReservations')
        .where('status', '==', 'held')
        .orderBy('createdAt', 'desc')
        .get(),
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
    topTasks,
    held,
    recent,
    parkedTasks: parkedSnapshot.data().count,
    taskDefaultLimit: defaultBudget?.limitUsd ?? null,
  };
  await assertPrivacyErasureFenceUnchanged(store, owner.id, fence);
  return result;
}
