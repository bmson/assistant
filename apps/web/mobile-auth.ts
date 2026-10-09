import { loadConfig } from '@assistant/config';
import { isAuthed } from './auth';
import { getMobileAccessToken } from './lib/mobile-access-token';
import { secureTokenMatches } from './mobile-token';

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() ?? '';
}

/**
 * Native routes accept either the explicitly provisioned phone credential or
 * the existing owner web session. The latter keeps browser-based diagnostics
 * useful and lets source development use AUTH_DEV_BYPASS without inventing a
 * production bypass for the app.
 */
export async function isMobileAuthed(request: Request): Promise<boolean> {
  const config = loadConfig();
  const token = bearerToken(request);
  if (token && !token.startsWith('asd1_')) {
    try {
      if (secureTokenMatches(await getMobileAccessToken(), token)) return true;
      // A freshly rotated token must work even on an instance with a warm cache.
      if (
        process.env.K_SERVICE &&
        config.GCP_PROJECT &&
        secureTokenMatches(await getMobileAccessToken('mismatch'), token)
      )
        return true;
    } catch {
      // Do not accept the stale startup secret when the current secret cannot
      // be checked. Owner sessions and independent device keys remain usable.
      console.error('[mobile-auth] could not verify mobile access token');
    }
  }
  // Passkey installations issue revocable per-device credentials from /security.
  if (config.OWNER_AUTH_MODE === 'passkey' && token.startsWith('asd1_')) {
    const { verifyOwnerDeviceToken } = await import('./lib/owner-auth/runtime');
    if (await verifyOwnerDeviceToken(token)) return true;
  }
  // Cookie authentication on a write requires the configured exact origin.
  // SameSite does not separate a hostile sibling host from this application.
  // Originless native writes were already accepted above by their bearer key.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
    try {
      const expectedOrigin = new URL(config.AUTH_URL || config.PUBLIC_URL).origin;
      if (request.headers.get('origin') !== expectedOrigin) return false;
    } catch {
      return false;
    }
  }
  return Boolean(await isAuthed());
}

export function mobileUnauthorized(): Response {
  return Response.json(
    { error: 'unauthorized' },
    {
      status: 401,
      headers: {
        'cache-control': 'no-store',
        'www-authenticate': 'Bearer realm="Assistant iOS"',
      },
    },
  );
}

export function mobileJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'no-store');
  return Response.json(value, { ...init, headers });
}
