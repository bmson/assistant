import type { Config } from '@assistant/config';
import { createDb, type Db, maintenanceCursors } from '@assistant/db';
import {
  assertFirestoreInstallationOwner,
  createInstallationStore,
  type InstallationStore,
} from '@assistant/firestore';
import { eq, lte } from 'drizzle-orm';

import { readFirestoreBriefingHealth, readPostgresBriefingHealth } from './briefing-watchdog.js';

const HEARTBEAT_CURSOR = 'scheduler-sweep-heartbeat-v1';
const STALE_MS = 30 * 60_000;
const STEP_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/;
const FAILURE_LIMIT = 64;

interface SweepHeartbeat {
  version: 1;
  completedAtMs: number;
  scope: string;
  failedSteps: string[];
  skippedSteps: string[];
}

function diagnosticStepNames(names: readonly string[]): string[] {
  return [
    ...new Set(
      names.map((name) => {
        const step = name.split(':', 1)[0] ?? '';
        return STEP_NAME.test(step) ? step : 'unclassifiedStep';
      }),
    ),
  ].slice(0, FAILURE_LIMIT);
}

function validStepNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= FAILURE_LIMIT &&
    value.every((name) => typeof name === 'string' && STEP_NAME.test(name))
  );
}

function serialize(
  scope: string,
  failedSteps: readonly string[],
  skippedSteps: readonly string[],
  completedAt: Date,
): string {
  const diagnostic: SweepHeartbeat = {
    version: 1,
    scope,
    completedAtMs: completedAt.getTime(),
    failedSteps: diagnosticStepNames(failedSteps),
    skippedSteps: diagnosticStepNames(skippedSteps),
  };
  return JSON.stringify(diagnostic);
}

function evaluateSweepHeartbeat(scope: string, cursor: unknown, now: Date) {
  if (cursor === null || cursor === undefined) return { ok: false, state: 'missing' } as const;
  try {
    if (typeof cursor !== 'string' || cursor.length > 12_000)
      throw new Error('Invalid sweep heartbeat');
    const value = JSON.parse(cursor) as Partial<SweepHeartbeat>;
    if (
      value.version !== 1 ||
      typeof value.completedAtMs !== 'number' ||
      !Number.isSafeInteger(value.completedAtMs) ||
      value.completedAtMs < 0 ||
      !validStepNames(value.failedSteps) ||
      !validStepNames(value.skippedSteps)
    )
      throw new Error('Invalid sweep heartbeat');
    // Importing the PostgreSQL cursor into Firestore is not evidence that the
    // target installation's scheduler has ever run.
    if (value.scope !== scope) return { ok: false, state: 'missing' } as const;
    const ageMs = now.getTime() - value.completedAtMs;
    if (!Number.isFinite(ageMs) || ageMs < 0) throw new Error('Invalid sweep clock');
    const state = ageMs >= STALE_MS ? 'stale' : value.failedSteps.length ? 'failed' : 'healthy';
    return {
      ok: state === 'healthy',
      state,
      ageMs,
      completedAt: new Date(value.completedAtMs).toISOString(),
      failedSteps: value.failedSteps,
      skippedSteps: value.skippedSteps,
    };
  } catch {
    return { ok: false, state: 'unavailable' } as const;
  }
}

export async function recordFirestoreSweepHeartbeat(
  store: InstallationStore,
  agentId: string,
  startedAt: Date,
  completedAt: Date,
  failedSteps: readonly string[],
  skippedSteps: readonly string[],
): Promise<void> {
  const ref = store.doc('maintenanceCursors', HEARTBEAT_CURSOR);
  await store.db.runTransaction(async (tx) => {
    const [old, owner, migration] = await tx.getAll(
      ref,
      store.doc('agents', agentId),
      store.doc('coordination', 'migration'),
    );
    if (owner?.get('id') !== agentId || (migration?.exists && migration.get('status') !== 'active'))
      return;
    const prior = old?.get('updatedAt') as { toMillis?: () => number } | undefined;
    if (prior?.toMillis && prior.toMillis() > startedAt.getTime()) return;
    tx.set(ref, {
      name: HEARTBEAT_CURSOR,
      updatedAt: startedAt,
      cursor: serialize(
        `firestore:${store.installationId}`,
        failedSteps,
        skippedSteps,
        completedAt,
      ),
    });
  });
}

export async function readFirestoreSweepHealth(
  store: InstallationStore,
  agentId: string,
  now?: Date,
) {
  await assertFirestoreInstallationOwner(store, agentId);
  const migration = await store.doc('coordination', 'migration').get();
  if (migration.exists && migration.get('status') !== 'active')
    return { ok: false, state: 'inactive' } as const;
  const snapshot = await store.doc('maintenanceCursors', HEARTBEAT_CURSOR).get();
  return evaluateSweepHeartbeat(
    `firestore:${store.installationId}`,
    snapshot.get('cursor'),
    now ?? new Date(),
  );
}

export async function recordPostgresSweepHeartbeat(
  db: Db,
  startedAt: Date,
  completedAt: Date,
  failedSteps: readonly string[],
  skippedSteps: readonly string[],
): Promise<void> {
  const row = {
    name: HEARTBEAT_CURSOR,
    cursor: serialize('postgres', failedSteps, skippedSteps, completedAt),
    updatedAt: startedAt,
  };
  await db
    .insert(maintenanceCursors)
    .values(row)
    .onConflictDoUpdate({
      target: maintenanceCursors.name,
      set: { cursor: row.cursor, updatedAt: row.updatedAt },
      setWhere: lte(maintenanceCursors.updatedAt, startedAt),
    });
}

export async function readPostgresSweepHealth(db: Db, now?: Date) {
  const [row] = await db
    .select({ cursor: maintenanceCursors.cursor })
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, HEARTBEAT_CURSOR))
    .limit(1);
  return evaluateSweepHeartbeat('postgres', row?.cursor, now ?? new Date());
}

// The watchdog never constructs a model router, queue, notifier or worker.
export async function readConfiguredSweepHealth(config: Config) {
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const store = createInstallationStore({
      projectId: config.GCP_PROJECT,
      installationId: config.ASSISTANT_WORKSPACE_ID,
      databaseId: config.FIRESTORE_DATABASE_ID,
    });
    try {
      const clock = new Date();
      const [sweep, briefing] = await Promise.all([
        readFirestoreSweepHealth(store, config.FIRESTORE_AGENT_ID, clock),
        readFirestoreBriefingHealth(store, config.FIRESTORE_AGENT_ID, clock).catch(
          () => ({ ok: false, state: 'unavailable' }) as const,
        ),
      ]);
      return { ...sweep, ok: sweep.ok && briefing.ok, briefing };
    } finally {
      await store.db.terminate();
    }
  }
  const db = createDb(config.DATABASE_URL, {
    max: 1,
    readOnly: true,
    connectTimeoutSeconds: 5,
    statementTimeoutMs: 5000,
  });
  try {
    const clock = new Date();
    const [sweep, briefing] = await Promise.all([
      readPostgresSweepHealth(db, clock),
      readPostgresBriefingHealth(db, clock).catch(
        () => ({ ok: false, state: 'unavailable' }) as const,
      ),
    ]);
    return { ...sweep, ok: sweep.ok && briefing.ok, briefing };
  } finally {
    await db.$client.end();
  }
}
