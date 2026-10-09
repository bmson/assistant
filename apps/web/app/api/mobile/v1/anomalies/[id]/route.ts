import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { dismissOwnerAnomaly, suspendOwnerAnomalyPolicy } from '@/lib/workspace-reviews';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid anomaly id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, ['action']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as { action?: unknown } | null;
  try {
    if (body?.action !== 'dismiss' && body?.action !== 'suspend-policy') {
      return mobileJson({ error: 'action must be dismiss or suspend-policy' }, { status: 400 });
    }
    const updated =
      body.action === 'dismiss'
        ? await dismissOwnerAnomaly(id)
        : await suspendOwnerAnomalyPolicy(id);
    if (!updated) return mobileJson({ error: 'Anomaly not found.' }, { status: 409 });
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Anomaly could not be updated.' },
      { status: 409 },
    );
  }
}
