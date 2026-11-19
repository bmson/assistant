import {
  assertPostgresInstallationOwner,
  createPostgresScheduleRepository,
  type Db,
  maintenanceCursors,
  readPostgresSavedBriefing,
  tasks,
} from '@assistant/db';
import {
  assertFirestoreInstallationOwner,
  decodeRecord,
  FirestoreScheduleRepository,
  type InstallationStore,
  readFirestoreSavedBriefing,
} from '@assistant/firestore';
import {
  BRIEFING_DEADLINE_MS,
  briefingActivationDate,
  briefingCursorName,
  DAILY_BRIEFING,
  type Records,
  readBriefingWatchdogRecord,
  scheduledBriefingIdentity,
} from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';

type Task = Pick<Records['tasks'], 'id' | 'agentId' | 'createdAt' | 'trigger' | 'status'>;

async function evaluateBriefingWatchdog(input: {
  scope: string;
  owner: string;
  schedule: Records['schedules'] | null;
  clock: Date;
  cursor(name: string): Promise<unknown>;
  task(id: string): Promise<Task | null>;
  saved(taskId: string, receipt: string): Promise<{ createdAt: Date } | null>;
}) {
  const schedule = input.schedule;
  if (!schedule) return { ok: false, state: 'missing' } as const;
  if (!schedule.enabled) return { ok: true, state: 'disabled' } as const;
  if (
    schedule.agentId !== input.owner ||
    (schedule.taskTemplate as { job?: unknown } | null)?.job !== 'briefing.compose'
  )
    return { ok: false, state: 'unavailable' } as const;
  const now = input.clock.getTime();
  const activated = briefingActivationDate(schedule).getTime();
  if (!Number.isFinite(now) || !Number.isFinite(activated) || now < activated)
    return { ok: false, state: 'unavailable' } as const;
  const raw = await input.cursor(briefingCursorName(input.owner, schedule.id));
  const cursor = readBriefingWatchdogRecord(raw);
  if (raw != null && !cursor) return { ok: false, state: 'unavailable' } as const;
  if (cursor?.scope !== input.scope || cursor.taskCreatedAtMs < activated) {
    const ageMs = now - activated;
    return ageMs >= BRIEFING_DEADLINE_MS
      ? ({ ok: false, state: 'stale', ageMs } as const)
      : ({ ok: true, state: 'awaiting_first_run', ageMs } as const);
  }
  if (
    cursor.agentId !== input.owner ||
    cursor.scheduleId !== schedule.id ||
    cursor.recordedAtMs > now
  )
    return { ok: false, state: 'unavailable' } as const;
  const ageMs = now - cursor.recordedAtMs;
  const recordedAt = new Date(cursor.recordedAtMs).toISOString();
  const { outcome } = cursor;
  if (outcome.kind === 'aborted' || outcome.kind === 'unavailable')
    return { ok: false, state: outcome.kind, ageMs, recordedAt } as const;
  const task = await input.task(cursor.taskId);
  const legal = task && scheduledBriefingIdentity(task);
  if (
    !task ||
    task.status !== 'done' ||
    legal?.scheduleId !== schedule.id ||
    legal.agentId !== input.owner ||
    legal.taskId !== cursor.taskId ||
    task.createdAt.getTime() !== cursor.taskCreatedAtMs
  )
    return { ok: false, state: 'unavailable', ageMs, recordedAt } as const;
  const saved = outcome.kind === 'delivered' ? await input.saved(task.id, outcome.messageId) : null;
  const completedAt = saved ? saved.createdAt.getTime() : cursor.recordedAtMs;
  if (
    (outcome.kind === 'delivered' && !saved) ||
    !Number.isFinite(completedAt) ||
    completedAt < cursor.taskCreatedAtMs ||
    completedAt > now
  )
    return { ok: false, state: 'unavailable', ageMs, recordedAt } as const;
  const completionAgeMs = now - completedAt;
  return completionAgeMs >= BRIEFING_DEADLINE_MS
    ? ({
        ok: false,
        state: 'stale',
        lastOutcome: outcome.kind,
        ageMs: completionAgeMs,
        recordedAt,
      } as const)
    : ({ ok: true, state: outcome.kind, ageMs: completionAgeMs, recordedAt } as const);
}

export async function readPostgresBriefingHealth(db: Db, clock = new Date()) {
  const owner = await assertPostgresInstallationOwner(db);
  const schedule = await createPostgresScheduleRepository(db).getByName(owner, DAILY_BRIEFING);
  return evaluateBriefingWatchdog({
    scope: 'postgres',
    owner,
    schedule,
    clock,
    async cursor(name) {
      const [row] = await db
        .select({ cursor: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, name));
      return row?.cursor;
    },
    async task(id) {
      const [task] = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.agentId, owner)));
      return task ?? null;
    },
    saved: (taskId, messageId) => readPostgresSavedBriefing(db, owner, taskId, messageId),
  });
}

export async function readFirestoreBriefingHealth(
  store: InstallationStore,
  agentId: string,
  clock = store.now(),
) {
  await assertFirestoreInstallationOwner(store, agentId);
  const migration = await store.doc('coordination', 'migration').get();
  if (migration.exists && migration.get('status') !== 'active')
    return { ok: false, state: 'inactive' } as const;
  const schedule = await new FirestoreScheduleRepository(store).getByName(agentId, DAILY_BRIEFING);
  return evaluateBriefingWatchdog({
    scope: `firestore:${store.installationId}`,
    owner: agentId,
    schedule,
    clock,
    async cursor(name) {
      const row = await store.doc('maintenanceCursors', name).get();
      return row.get('cursor');
    },
    async task(id) {
      const row = await store.doc('tasks', id).get();
      return row.exists ? decodeRecord<Task>(row.data()) : null;
    },
    saved: (taskId, messageId) => readFirestoreSavedBriefing(store, agentId, taskId, messageId),
  });
}
