import {
  archiveActivity,
  archiveActivityWithRepository,
  cancelActivity,
  cancelActivityWithRepository,
  raiseTaskBudget,
  raiseTaskBudgetWithRepository,
  restoreActivity,
  restoreActivityWithRepository,
  retryActivity,
  retryActivityWithRepository,
  revokeTaskAutonomy,
  revokeTaskAutonomyWithRepository,
} from '@assistant/application/tasks';
import { loadConfig } from '@assistant/config';
import {
  createInstallationStore,
  FirestoreTaskActivityCommandRepository,
} from '@assistant/firestore';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function activityOutcomeResponse(
  action: string,
  result: Awaited<ReturnType<typeof archiveActivity>>,
): Response {
  const status =
    result.outcome === 'not_found' ? 404 : result.outcome === 'no_longer_retriable' ? 409 : 200;
  return mobileJson(
    {
      ok: status === 200,
      ...result,
      ...(action === 'cancel'
        ? {
            effectStatus:
              result.outcome === 'cancelled' || result.outcome === 'already_cancelled'
                ? 'unknown'
                : 'not_applicable',
          }
        : {}),
    },
    { status },
  );
}

/** Apply owner-scoped task activity commands through the configured persistence driver. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid activity id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, ['action', 'budgetUsdLimit']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as {
    action?: unknown;
    budgetUsdLimit?: unknown;
  } | null;
  try {
    const config = loadConfig();
    if (config.PERSISTENCE_DRIVER === 'firestore') {
      if (
        body?.action !== 'archive' &&
        body?.action !== 'restore' &&
        body?.action !== 'retry' &&
        body?.action !== 'cancel' &&
        body?.action !== 'revoke-autonomy' &&
        body?.action !== 'raise-budget'
      )
        return mobileJson(
          { error: 'This Activity action is unavailable in Firestore mode.' },
          { status: 503 },
        );
      if (body.action === 'raise-budget' && typeof body.budgetUsdLimit !== 'number')
        return mobileJson({ error: 'budgetUsdLimit must be a number' }, { status: 400 });
      const store = createInstallationStore({
        projectId: config.GCP_PROJECT,
        installationId: config.ASSISTANT_WORKSPACE_ID,
        databaseId: config.FIRESTORE_DATABASE_ID,
      });
      try {
        const repository = new FirestoreTaskActivityCommandRepository(store);
        let result: Awaited<ReturnType<typeof archiveActivity>>;
        if (body.action === 'archive')
          result = await archiveActivityWithRepository(repository, config.FIRESTORE_AGENT_ID, id);
        else if (body.action === 'restore')
          result = await restoreActivityWithRepository(repository, config.FIRESTORE_AGENT_ID, id);
        else if (body.action === 'retry')
          result = await retryActivityWithRepository(repository, config.FIRESTORE_AGENT_ID, id);
        else if (body.action === 'cancel')
          result = await cancelActivityWithRepository(repository, config.FIRESTORE_AGENT_ID, id);
        else if (body.action === 'revoke-autonomy')
          result = await revokeTaskAutonomyWithRepository(
            repository,
            config.FIRESTORE_AGENT_ID,
            id,
          );
        else
          result = await raiseTaskBudgetWithRepository(
            repository,
            config.FIRESTORE_AGENT_ID,
            id,
            body.budgetUsdLimit as number,
          );
        return activityOutcomeResponse(body.action, result);
      } finally {
        await store.db.terminate();
      }
    }
    let result: Awaited<ReturnType<typeof archiveActivity>>;
    if (body?.action === 'archive') result = await archiveActivity(getDb(), id);
    else if (body?.action === 'restore') result = await restoreActivity(getDb(), id);
    else if (body?.action === 'retry') result = await retryActivity(getDb(), id);
    else if (body?.action === 'cancel') result = await cancelActivity(getDb(), id);
    else if (body?.action === 'revoke-autonomy') result = await revokeTaskAutonomy(getDb(), id);
    else if (body?.action === 'raise-budget') {
      const budget = body.budgetUsdLimit;
      if (typeof budget !== 'number' || !Number.isFinite(budget)) {
        return mobileJson({ error: 'budgetUsdLimit must be a number' }, { status: 400 });
      }
      result = await raiseTaskBudget(getDb(), id, budget);
    } else {
      return mobileJson(
        {
          error: 'action must be archive, restore, retry, cancel, revoke-autonomy, or raise-budget',
        },
        { status: 400 },
      );
    }
    return activityOutcomeResponse(body?.action ?? '', result);
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Activity could not be updated.' },
      { status: 409 },
    );
  }
}
