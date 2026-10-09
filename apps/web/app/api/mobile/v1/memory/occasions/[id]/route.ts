import {
  forgetPersonOccasion,
  reviewPersonOccasion,
  updatePersonOccasion,
} from '@assistant/application/profile';
import { loadConfig } from '@assistant/config';
import { getFirestoreProfileCommands } from '@/lib/firestore-profile-commands';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid occasion id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, ['verdict']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as { verdict?: unknown } | null;
  if (body?.verdict !== 'approve' && body?.verdict !== 'reject') {
    return mobileJson({ error: 'verdict must be approve or reject' }, { status: 400 });
  }
  const repository =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? getFirestoreProfileCommands().occasions
      : getDb();
  await reviewPersonOccasion(repository, id, body.verdict);
  return mobileJson({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid occasion id' }, { status: 400 });
  const repository =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? getFirestoreProfileCommands().occasions
      : getDb();
  await forgetPersonOccasion(repository, id);
  return mobileJson({ ok: true });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid occasion id' }, { status: 400 });
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
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return mobileJson({ error: 'invalid occasion body' }, { status: 400 });
  const text = (key: string) => (typeof body[key] === 'string' ? body[key] : '');
  const repository =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? getFirestoreProfileCommands().occasions
      : getDb();
  const result = await updatePersonOccasion(repository, id, {
    kind: text('kind'),
    label: text('label'),
    month: text('month'),
    day: text('day'),
    year: text('year'),
    leadDays: text('leadDays'),
    notes: text('notes'),
  });
  return result.error
    ? mobileJson({ error: result.error }, { status: 400 })
    : mobileJson({ ok: true });
}
