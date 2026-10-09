import { loadConfig } from '@assistant/config';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { writeFirestoreMobileSkill } from '@/lib/mobile-skill-write';
import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

function skillInput(
  body: unknown,
): { name: string; preconditions: string; steps: string; gotchas: string } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid skill body' };
  }
  const value = body as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === 'string' ? value[key].trim() : '');
  const name = text('name');
  const steps = text('steps');
  if (!name) return { error: 'Name is required.' };
  if (!steps) return { error: 'Steps are required.' };
  return { name, steps, preconditions: text('preconditions'), gotchas: text('gotchas') };
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, [
    'name',
    'steps',
    'preconditions',
    'gotchas',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const input = skillInput(mutationBody.value);
  if ('error' in input) return mobileJson({ error: input.error }, { status: 400 });
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    try {
      await writeFirestoreMobileSkill(input);
      return mobileJson({ ok: true }, { status: 201 });
    } catch (error) {
      return mobileJson(
        { error: error instanceof Error ? error.message : 'Skill could not be saved.' },
        { status: 409 },
      );
    }
  }
  const result = await getApplication().addSkill(input);
  return result.error
    ? mobileJson({ error: result.error }, { status: 409 })
    : mobileJson({ ok: true }, { status: 201 });
}
