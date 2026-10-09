import { createPerson } from '@assistant/application/profile';
import { loadConfig } from '@assistant/config';
import {
  getFirestoreProfileCommands,
  recompileFirestoreProfileCard,
} from '@/lib/firestore-profile-commands';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, ['aliases', 'name', 'relationship']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as Record<string, unknown> | null;
  if (!body || Array.isArray(body)) {
    return mobileJson({ error: 'invalid person body' }, { status: 400 });
  }
  const config = loadConfig();
  const commands = config.PERSISTENCE_DRIVER === 'firestore' ? getFirestoreProfileCommands() : null;
  const result = await createPerson(commands?.people ?? getDb(), {
    name: typeof body.name === 'string' ? body.name : '',
    relationship: typeof body.relationship === 'string' ? body.relationship : '',
    aliases: typeof body.aliases === 'string' ? body.aliases : '',
  });
  if (commands && result.contactId) await recompileFirestoreProfileCard(commands);
  return result.error
    ? mobileJson({ error: result.error }, { status: 400 })
    : mobileJson(result, { status: 201 });
}
