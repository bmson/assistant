import { z } from 'zod';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getSelfRepairOverview, reportOwnerRepair } from '@/lib/self-repair-server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';
export async function GET(request: Request) {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  return mobileJson(await getSelfRepairOverview());
}
export async function POST(request: Request) {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, ['title', 'summary', 'sourceTaskId']);
  if (!mutationBody.ok) return mutationBody.response;
  const input = z
    .object({
      title: z.string().trim().min(3).max(200),
      summary: z.string().trim().min(5).max(3000),
      sourceTaskId: z.string().uuid().optional(),
    })
    .safeParse(mutationBody.value);
  if (!input.success) return mobileJson({ error: 'Invalid issue report' }, { status: 400 });
  try {
    const issue = await reportOwnerRepair(
      input.data.title,
      input.data.summary,
      input.data.sourceTaskId,
    );
    return mobileJson({ ok: true, issueId: issue.id });
  } catch (err) {
    return mobileJson(
      { error: err instanceof Error ? err.message : 'Could not report issue' },
      { status: 409 },
    );
  }
}
