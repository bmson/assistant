import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getOwnerMemoryCommands } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Owner-authored facts go straight into the same memory library as the web form. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, [
    'content',
    'domain',
    'importance',
    'pinned',
    'subjectContactId',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as Record<string, unknown> | null;
  if (!body) return mobileJson({ error: 'invalid memory body' }, { status: 400 });
  const result = await getOwnerMemoryCommands().createMemory({
    content: typeof body.content === 'string' ? body.content : '',
    domain: typeof body.domain === 'string' ? body.domain : 'other',
    importance: typeof body.importance === 'number' ? String(body.importance) : '3',
    pinned: body.pinned === true,
    subjectContactId: typeof body.subjectContactId === 'string' ? body.subjectContactId : '',
  });
  return result.error
    ? mobileJson(result, { status: 400 })
    : mobileJson({ ok: true }, { status: 201 });
}
