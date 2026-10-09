import {
  deletePerson,
  getPersonProfile,
  mergePeople,
  updatePersonIdentity,
  updatePersonRelationship,
} from '@assistant/application/profile';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { FirestoreProfilePeopleReadRepository } from '@assistant/firestore';
import {
  deleteFirestorePerson,
  getFirestoreProfileCommands,
  mergeFirestorePeople,
  recompileFirestoreProfileCard,
} from '@/lib/firestore-profile-commands';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getDb, getFirestoreInstallationStore } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const config = loadConfig();
  let reads: Parameters<typeof getPersonProfile>[0];
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    reads = new FirestoreProfilePeopleReadRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    );
  } else reads = getDb();
  const profile = await getPersonProfile(reads, id);
  return profile ? mobileJson(profile) : mobileJson({ error: 'person not found' }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, [
    'action',
    'aliases',
    'name',
    'relationship',
    'targetId',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as Record<string, unknown> | null;
  if (!body || Array.isArray(body)) {
    return mobileJson({ error: 'invalid person body' }, { status: 400 });
  }
  const config = loadConfig();
  const commands = config.PERSISTENCE_DRIVER === 'firestore' ? getFirestoreProfileCommands() : null;
  const identity = await updatePersonIdentity(
    commands?.people ?? getDb(),
    id,
    typeof body.name === 'string' ? body.name : '',
    typeof body.aliases === 'string' ? body.aliases : '',
  );
  if (identity.error) return mobileJson({ error: identity.error }, { status: 400 });
  await updatePersonRelationship(
    commands?.people ?? getDb(),
    id,
    typeof body.relationship === 'string' ? body.relationship : '',
  );
  if (commands) await recompileFirestoreProfileCard(commands);
  return mobileJson({ ok: true });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, ['action', 'targetId']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as {
    action?: unknown;
    targetId?: unknown;
  } | null;
  if (
    body?.action !== 'merge' ||
    typeof body.targetId !== 'string' ||
    !UUID_RE.test(body.targetId)
  ) {
    return mobileJson({ error: 'action must be merge with a valid targetId' }, { status: 400 });
  }
  const merged =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? await mergeFirestorePeople(id, body.targetId)
      : await mergePeople(getDb(), id, body.targetId);
  return merged.error
    ? mobileJson({ error: merged.error }, { status: 409 })
    : mobileJson({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid person id' }, { status: 400 });
  const result =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? await deleteFirestorePerson(id)
      : await deletePerson(getDb(), id);
  return result.error
    ? mobileJson({ error: result.error }, { status: 409 })
    : mobileJson({ ok: true });
}
