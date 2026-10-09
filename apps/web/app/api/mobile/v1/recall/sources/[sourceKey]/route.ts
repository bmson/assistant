import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getRecallSurfacingPorts } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

function validSourceKey(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ sourceKey: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { sourceKey } = await context.params;
  if (!validSourceKey(sourceKey))
    return mobileJson({ error: 'invalid source key' }, { status: 400 });
  const sourceRevision = new URL(request.url).searchParams.get('sourceRevision');
  if (sourceRevision !== null && !/^[a-f0-9]{64}$/.test(sourceRevision))
    return mobileJson({ error: 'invalid source revision' }, { status: 400 });
  try {
    const { agentId, repository } = await getRecallSurfacingPorts();
    const suppressed = await repository.suppressed(
      agentId,
      [sourceKey],
      sourceRevision ? { [sourceKey]: sourceRevision } : undefined,
    );
    return mobileJson({ suppressed: suppressed.has(sourceKey) });
  } catch {
    return mobileJson({ error: 'recall controls are unavailable' }, { status: 503 });
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ sourceKey: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { sourceKey } = await context.params;
  if (!validSourceKey(sourceKey))
    return mobileJson({ error: 'invalid source key' }, { status: 400 });
  const parsed = await readMobileMutationBody(request, ['suppressed', 'expectedSourceRevision']);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { suppressed?: unknown; expectedSourceRevision?: unknown } | null;
  if (
    typeof body?.suppressed !== 'boolean' ||
    !(
      body.expectedSourceRevision === null ||
      (typeof body.expectedSourceRevision === 'string' &&
        /^[a-f0-9]{64}$/.test(body.expectedSourceRevision))
    )
  )
    return mobileJson(
      { error: 'suppressed and expectedSourceRevision are required' },
      { status: 400 },
    );
  try {
    const { agentId, repository } = await getRecallSurfacingPorts();
    const result = await repository.setSuppressed({
      agentId,
      sourceKey,
      expectedSourceRevision: body.expectedSourceRevision,
      suppressed: body.suppressed,
    });
    return result.ok
      ? mobileJson({ ok: true, version: result.version })
      : mobileJson(
          { error: 'That source is no longer current. Refresh the chat and try again.' },
          { status: 409 },
        );
  } catch {
    return mobileJson({ error: 'recall controls are unavailable' }, { status: 503 });
  }
}
