import { getKnowledgeSourceImpact } from '@assistant/application';
import { loadConfig } from '@assistant/config';
import { getFirestoreKnowledgeWorkspace } from '@/lib/firestore-knowledge';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getDb, getOwnerMemoryCommands } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * These ids reach a `uuid` column, where a malformed one is a Postgres cast
 * error rather than a miss — a 500 for what is really "no such source".
 */
function sourceId(id: string): string | null {
  return UUID_RE.test(id) ? id : null;
}

const notFound = () => mobileJson({ error: 'source not found' }, { status: 404 });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const id = sourceId((await params).id);
  if (!id) return notFound();
  const impact =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? await getFirestoreKnowledgeWorkspace().sourceImpact(id)
      : await getKnowledgeSourceImpact(getDb(), id);
  return impact ? mobileJson(impact) : notFound();
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const id = sourceId((await params).id);
  if (!id) return notFound();
  const mutationBody = await readMobileMutationBody(request, ['content']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as Record<string, unknown> | null;
  const result = await getOwnerMemoryCommands().correctMemory(
    id,
    typeof body?.content === 'string' ? body.content : '',
  );
  return result.error ? mobileJson(result, { status: 400 }) : mobileJson({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const id = sourceId((await params).id);
  if (!id) return notFound();
  await getOwnerMemoryCommands().forgetMemory(id);
  return mobileJson({ ok: true });
}
