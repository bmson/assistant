import { archiveOldActivity, archiveOldActivityWithRepository } from '@assistant/application/tasks';
import { loadConfig } from '@assistant/config';
import {
  createInstallationStore,
  FirestoreTaskActivityCommandRepository,
} from '@assistant/firestore';
import { TaskDiscoveryInputError } from '@assistant/persistence';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getDb } from '@/lib/server';
import { discoverTaskActivity } from '@/lib/task-activity';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Archived activity is intentionally a separate, on-demand mobile read. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const params = new URL(request.url).searchParams;
  try {
    return mobileJson(
      await discoverTaskActivity({
        archived: params.get('archived') === 'true',
        filter: (params.get('filter') ?? 'all') as
          | 'all'
          | 'needs-you'
          | 'working'
          | 'scheduled'
          | 'completed',
        limit: 50,
        q: params.get('q') ?? undefined,
        cursor: params.get('cursor') ?? undefined,
        type: params.get('type') ?? undefined,
        trust: params.get('trust') ?? undefined,
        source: params.get('source') ?? undefined,
        from: params.get('from') ?? undefined,
        until: params.get('until') ?? undefined,
      }),
    );
  } catch (error) {
    if (error instanceof TaskDiscoveryInputError)
      return mobileJson(
        { error: 'Invalid activity discovery request. Refresh the search and try again.' },
        { status: 400 },
      );
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, ['action', 'operationId']);
  if (!mutationBody.ok) return mutationBody.response;
  const config = loadConfig();
  const body = mutationBody.value as {
    action?: unknown;
    operationId?: unknown;
  } | null;
  if (config.PERSISTENCE_DRIVER === 'firestore' && body?.action !== 'archive-old') {
    return mobileJson(
      { error: 'Activity editing is unavailable in Firestore mode.' },
      { status: 503 },
    );
  }
  if (body?.action !== 'archive-old') {
    return mobileJson({ error: 'action must be archive-old' }, { status: 400 });
  }
  if (
    body.operationId !== undefined &&
    (typeof body.operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.operationId))
  ) {
    return mobileJson(
      { error: 'operationId must be a valid archive operation identifier' },
      { status: 400 },
    );
  }
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const store = createInstallationStore({
      projectId: config.GCP_PROJECT,
      installationId: config.ASSISTANT_WORKSPACE_ID,
      databaseId: config.FIRESTORE_DATABASE_ID,
    });
    try {
      const progress = await archiveOldActivityWithRepository(
        new FirestoreTaskActivityCommandRepository(store),
        config.FIRESTORE_AGENT_ID,
        30,
        body.operationId as string | undefined,
      );
      return mobileJson({ ok: true, ...progress });
    } finally {
      await store.db.terminate();
    }
  }
  const progress = await archiveOldActivity(getDb());
  return mobileJson({ ok: true, ...progress });
}
