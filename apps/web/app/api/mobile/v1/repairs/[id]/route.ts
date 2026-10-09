import { z } from 'zod';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { decideOwnerRepair } from '@/lib/self-repair-server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const id = z
    .string()
    .uuid()
    .safeParse((await params).id);
  const mutationBody = await readMobileMutationBody(request, ['action']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = z
    .object({ action: z.enum(['dismiss', 'retry', 'resolve', 'run_now']) })
    .safeParse(mutationBody.value);
  if (!id.success || !body.success)
    return mobileJson({ error: 'Invalid repair action' }, { status: 400 });
  try {
    await decideOwnerRepair(id.data, body.data.action);
    return mobileJson({ ok: true });
  } catch (err) {
    return mobileJson(
      { error: err instanceof Error ? err.message : 'Could not update repair' },
      { status: 409 },
    );
  }
}
