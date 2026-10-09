import { isAuthed } from '@/auth';
import { readBoundedJson } from '@/lib/bounded-json';
import { getRecallSurfacingPorts } from '@/lib/server';

export const dynamic = 'force-dynamic';

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ sourceKey: string }> },
): Promise<Response> {
  if (!(await isAuthed())) return json({ error: 'unauthorized' }, 401);
  const { sourceKey } = await context.params;
  if (!/^[a-f0-9]{64}$/.test(sourceKey)) return json({ error: 'invalid source key' }, 400);
  const sourceRevision = new URL(request.url).searchParams.get('sourceRevision');
  if (sourceRevision !== null && !/^[a-f0-9]{64}$/.test(sourceRevision))
    return json({ error: 'invalid source revision' }, 400);
  try {
    const { agentId, repository } = await getRecallSurfacingPorts();
    const suppressed = await repository.suppressed(
      agentId,
      [sourceKey],
      sourceRevision ? { [sourceKey]: sourceRevision } : undefined,
    );
    return json({ suppressed: suppressed.has(sourceKey) });
  } catch {
    return json({ error: 'recall controls are unavailable' }, 503);
  }
}

/** Owner control for a source already disclosed on one of their assistant replies. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ sourceKey: string }> },
): Promise<Response> {
  if (!(await isAuthed())) return json({ error: 'unauthorized' }, 401);
  const { sourceKey } = await context.params;
  if (!/^[a-f0-9]{64}$/.test(sourceKey)) return json({ error: 'invalid source key' }, 400);
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) {
    const error =
      parsed.status === 413
        ? 'request body too large'
        : parsed.status === 408
          ? 'request body took too long'
          : 'invalid JSON';
    return json({ error }, parsed.status);
  }
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return json({ error: 'invalid control' }, 400);
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'suppressed' && key !== 'expectedSourceRevision'))
    return json({ error: 'unknown control fields' }, 400);
  if (
    typeof value.suppressed !== 'boolean' ||
    !(
      value.expectedSourceRevision === null ||
      (typeof value.expectedSourceRevision === 'string' &&
        /^[a-f0-9]{64}$/.test(value.expectedSourceRevision))
    )
  )
    return json({ error: 'suppressed and expectedSourceRevision are required' }, 400);

  try {
    const { agentId, repository } = await getRecallSurfacingPorts();
    const result = await repository.setSuppressed({
      agentId,
      sourceKey,
      expectedSourceRevision: value.expectedSourceRevision,
      suppressed: value.suppressed,
    });
    return result.ok
      ? json({ ok: true, version: result.version })
      : json({ error: 'That source is no longer current. Refresh the chat and try again.' }, 409);
  } catch {
    return json({ error: 'recall controls are unavailable' }, 503);
  }
}
