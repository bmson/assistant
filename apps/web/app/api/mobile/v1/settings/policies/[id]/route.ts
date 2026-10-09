import { loadConfig } from '@assistant/config';
import { runFirestoreSettingsMutation } from '@/lib/firestore-settings-mutation';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid policy id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, ['enabled']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as { enabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean') {
    return mobileJson({ error: 'enabled must be a boolean' }, { status: 400 });
  }
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    await runFirestoreSettingsMutation((settings) =>
      settings.setApprovalPolicyEnabled(id, body.enabled as boolean),
    );
  } else {
    await getApplication().setPolicyEnabled(id, body.enabled);
  }
  return mobileJson({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid policy id' }, { status: 400 });
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore') {
    await runFirestoreSettingsMutation((settings) => settings.deleteApprovalPolicy(id));
  } else {
    await getApplication().deletePolicy(id);
  }
  return mobileJson({ ok: true });
}
