import { addPersonOccasion } from '@assistant/application/profile';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { FirestoreProfileOccasionCommandRepository } from '@assistant/firestore';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getDb, getFirestoreInstallationStore } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, [
    'kind',
    'label',
    'month',
    'day',
    'year',
    'leadDays',
    'notes',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as Record<string, unknown> | null;
  if (!body || Array.isArray(body)) {
    return mobileJson({ error: 'invalid occasion body' }, { status: 400 });
  }
  const text = (key: string) => (typeof body[key] === 'string' ? body[key] : '');
  const input = {
    kind: text('kind'),
    label: text('label'),
    month: text('month'),
    day: text('day'),
    year: text('year'),
    leadDays: text('leadDays'),
    notes: text('notes'),
  };
  const config = loadConfig();
  let result: { error?: string };
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    result = await addPersonOccasion(
      new FirestoreProfileOccasionCommandRepository(
        getFirestoreInstallationStore(),
        config.FIRESTORE_AGENT_ID,
      ),
      id,
      input,
    );
  } else {
    result = await addPersonOccasion(getDb(), id, input);
  }
  return result.error
    ? mobileJson(
        { error: result.error },
        {
          status:
            result.error === 'Person not found.'
              ? 404
              : result.error.includes('Privacy')
                ? 409
                : 400,
        },
      )
    : mobileJson({ ok: true }, { status: 201 });
}
