import { authenticateMcpAuthorizationRead } from '@/lib/mcp-authorization-auth';
import { diagnoseOwnerMcpAuthorization } from '@/lib/mcp-authorization-runtime';
import { mobileJson, mobileUnauthorized } from '@/mobile-auth';
export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Transient OAuth support diagnostics. Authentication, registration and consent are not offered. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const owner = await authenticateMcpAuthorizationRead(request);
  if (owner.kind === 'unauthenticated') return mobileUnauthorized();
  if (owner.kind === 'unavailable')
    return mobileJson({ error: 'MCP authorization diagnostics are unavailable.' }, { status: 503 });
  const { id } = await params;
  if (!UUID.test(id) || new URL(request.url).search)
    return mobileJson({ error: 'Invalid MCP authorization diagnostic request.' }, { status: 400 });
  try {
    const result = await diagnoseOwnerMcpAuthorization(owner.ownerId, id, request.signal);
    if (result.kind === 'not_found')
      return mobileJson({ error: 'MCP connection not found.' }, { status: 404 });
    if (result.kind === 'changed')
      return mobileJson({ error: 'MCP connection changed during the check.' }, { status: 409 });
    return mobileJson(result.diagnostic);
  } catch {
    return mobileJson({ error: 'MCP authorization diagnostics are unavailable.' }, { status: 503 });
  }
}
