import { isAuthed } from '@/auth';
import { authenticateMobileBearer, resolveAuthenticatedInstallationOwner } from '@/mobile-auth';

export type McpAuthorizationReadOwner =
  | { kind: 'authenticated'; ownerId: string }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable' };

/** Only this read surface accepts a web owner session. Supplied invalid bearer headers never fall back. */
export async function authenticateMcpAuthorizationRead(
  request: Request,
): Promise<McpAuthorizationReadOwner> {
  if (request.method !== 'GET') return { kind: 'unauthenticated' };
  try {
    if (request.headers.has('authorization')) {
      if (!(await authenticateMobileBearer(request))) return { kind: 'unauthenticated' };
    } else if (!(await isAuthed())) return { kind: 'unauthenticated' };
    const owner = await resolveAuthenticatedInstallationOwner();
    return owner.ok ? { kind: 'authenticated', ownerId: owner.ownerId } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
