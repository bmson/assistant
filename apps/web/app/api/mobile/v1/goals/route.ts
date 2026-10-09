import {
  archiveInactiveGoalRecords,
  createGoalWithWork,
  listGoalsDashboardWithRepository,
} from '@assistant/application/goals';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { FirestoreGoalMutationRepository, FirestoreGoalReadRepository } from '@assistant/firestore';
import { readBoundedJson } from '@/lib/bounded-json';
import { parseGoalInput } from '@/lib/goal-input';
import {
  createFirestoreGoalWithWork,
  getApplication,
  getDb,
  getFirestoreInstallationStore,
} from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Load current or archived goals without delaying the chat bootstrap. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const archived = new URL(request.url).searchParams.get('archived') === 'true';
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const repository = new FirestoreGoalReadRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    );
    return mobileJson(
      await listGoalsDashboardWithRepository(repository, config.FIRESTORE_AGENT_ID, archived),
    );
  }
  return mobileJson(await getApplication().listGoals(archived));
}

/** Creating a mobile goal starts its first work session just like the web form. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return mobileJson({ error: parsed.error }, { status: parsed.status });
  const body = parsed.value;
  const config = loadConfig();
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body as { action?: unknown }).action === 'archive-inactive'
  ) {
    if (config.PERSISTENCE_DRIVER === 'firestore') {
      const problems = validateAgentPersistenceConfig(config);
      if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
      try {
        await new FirestoreGoalMutationRepository(
          getFirestoreInstallationStore(),
          config.FIRESTORE_AGENT_ID,
        ).archiveInactive();
        return mobileJson({ ok: true });
      } catch (error) {
        return mobileJson(
          { error: error instanceof Error ? error.message : 'Goals could not be archived.' },
          { status: 409 },
        );
      }
    }
    await archiveInactiveGoalRecords(getDb());
    return mobileJson({ ok: true });
  }
  const input = parseGoalInput(body);
  if ('error' in input) return mobileJson({ error: input.error }, { status: 400 });
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
  }
  try {
    const result =
      config.PERSISTENCE_DRIVER === 'firestore'
        ? await createFirestoreGoalWithWork(input)
        : await createGoalWithWork(getDb(), input);
    return mobileJson(result, { status: 201 });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Goal could not be created.' },
      { status: 409 },
    );
  }
}
