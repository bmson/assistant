import {
  archiveGoalRecord,
  changeGoalAutonomy,
  changeGoalStatus,
  getGoalRecord,
  restoreGoalRecord,
  startExistingGoalWork,
  updateGoalSettings,
} from '@assistant/application/goals';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { FirestoreGoalMutationRepository, FirestoreGoalReadRepository } from '@assistant/firestore';
import { readBoundedJson } from '@/lib/bounded-json';
import { parseGoalInput } from '@/lib/goal-input';
import {
  getDb,
  getFirestoreGoalScheduleUpdate,
  getFirestoreInstallationStore,
  startFirestoreGoalWork,
} from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid goal id' }, { status: 400 });
  const config = loadConfig();
  let goal: Awaited<ReturnType<FirestoreGoalReadRepository['get']>> = null;
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    goal = await new FirestoreGoalReadRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    ).get(config.FIRESTORE_AGENT_ID, id);
  } else {
    goal = await getGoalRecord(getDb(), id);
  }
  return goal ? mobileJson({ goal }) : mobileJson({ error: 'goal not found' }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid goal id' }, { status: 400 });
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return mobileJson({ error: parsed.error }, { status: parsed.status });
  const input = parseGoalInput(parsed.value);
  if ('error' in input) return mobileJson({ error: input.error }, { status: 400 });
  try {
    const config = loadConfig();
    if (config.PERSISTENCE_DRIVER === 'firestore') {
      const problems = validateAgentPersistenceConfig(config);
      if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
      await new FirestoreGoalMutationRepository(
        getFirestoreInstallationStore(),
        config.FIRESTORE_AGENT_ID,
      ).updateSettings(id, input, getFirestoreGoalScheduleUpdate(id, input));
    } else {
      await updateGoalSettings(getDb(), id, input);
    }
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Goal could not be updated.' },
      { status: 409 },
    );
  }
}

/** “Delete” on mobile archives the goal, preserving its work and evidence like the web app. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid goal id' }, { status: 400 });
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return mobileJson({ error: parsed.error }, { status: parsed.status });
  const body = parsed.value as {
    action?: unknown;
    enabled?: unknown;
    status?: unknown;
  } | null;
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const mutations = new FirestoreGoalMutationRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    );
    try {
      if (body?.action === 'start')
        return mobileJson({ ok: true, ...(await startFirestoreGoalWork(id)) });
      if (body?.action === 'delete' || body?.action === 'archive') await mutations.archive(id);
      else if (body?.action === 'restore') await mutations.restore(id);
      else if (body?.action === 'status') {
        if (!['active', 'paused', 'done', 'abandoned'].includes(String(body.status)))
          return mobileJson({ error: 'invalid goal status' }, { status: 400 });
        await mutations.setStatus(id, body.status as 'active' | 'paused' | 'done' | 'abandoned');
      } else if (body?.action === 'autonomy') {
        if (typeof body.enabled !== 'boolean')
          return mobileJson({ error: 'enabled must be a boolean' }, { status: 400 });
        await mutations.setAutonomy(id, body.enabled);
      } else {
        return mobileJson(
          { error: 'action must be delete, archive, restore, status, or autonomy' },
          { status: 400 },
        );
      }
      return mobileJson({ ok: true });
    } catch (error) {
      return mobileJson(
        { error: error instanceof Error ? error.message : 'Goal could not be updated.' },
        { status: 409 },
      );
    }
  }
  try {
    if (body?.action === 'delete' || body?.action === 'archive')
      await archiveGoalRecord(getDb(), id);
    else if (body?.action === 'restore') await restoreGoalRecord(getDb(), id);
    else if (body?.action === 'start') {
      const work = await startExistingGoalWork(getDb(), id);
      return mobileJson({ ok: true, ...work });
    } else if (body?.action === 'status') {
      if (!['active', 'paused', 'done', 'abandoned'].includes(String(body.status))) {
        return mobileJson({ error: 'invalid goal status' }, { status: 400 });
      }
      await changeGoalStatus(
        getDb(),
        id,
        body.status as 'active' | 'paused' | 'done' | 'abandoned',
      );
    } else if (body?.action === 'autonomy') {
      if (typeof body.enabled !== 'boolean') {
        return mobileJson({ error: 'enabled must be a boolean' }, { status: 400 });
      }
      await changeGoalAutonomy(getDb(), id, body.enabled);
    } else {
      return mobileJson(
        { error: 'action must be delete, archive, restore, start, status, or autonomy' },
        { status: 400 },
      );
    }
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Goal could not be updated.' },
      { status: 409 },
    );
  }
}
