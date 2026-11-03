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
    if (await configuredMobileBearerMatches(token, config)) return true;
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

export type MobileBearerPrincipal =
  | { kind: 'configured_installation_bearer' }
  | { kind: 'owner_device_bearer'; deviceId: string };

export interface AuthenticatedMobileOwner {
  principal: MobileBearerPrincipal;
  ownerId: string;
}

export type MobileOwnerResolution =
  | { ok: true; ownerId: string }
  | { ok: false; reason: 'unavailable' };

/**
 * Resolve only the configured bearer credential. This preserves the existing
 * rotation and warm-cache behavior used by legacy mobile routes.
 */
async function configuredMobileBearerMatches(
  token: string,
  config: ReturnType<typeof loadConfig>,
): Promise<boolean> {
  try {
    if (secureTokenMatches(await getMobileAccessToken(), token)) return true;
    // A freshly rotated token must work even on an instance with a warm cache.
    return Boolean(
      process.env.K_SERVICE &&
        config.GCP_PROJECT &&
        secureTokenMatches(await getMobileAccessToken('mismatch'), token),
    );
  } catch {
    // Do not accept the stale startup secret when the current secret cannot
    // be checked. Owner sessions and independent device keys remain usable.
    console.error('[mobile-auth] could not verify mobile access token');
    return false;
  }
}

/**
 * Authenticate a bearer without the Auth.js cookie fallback. Device tokens
 * are checked fresh here so a cached legacy Boolean cannot be mistaken for a
 * current revocation check. The configured bearer has no per-user scope.
 */
export async function authenticateMobileBearer(
  request: Request,
): Promise<MobileBearerPrincipal | null> {
  const config = loadConfig();
  const token = bearerToken(request);
  if (!token) return null;

  // Reserve this prefix for per-device credentials, even when the token is
  // malformed or this installation uses another owner-auth mode.
  if (token.startsWith('asd1_')) {
    if (config.OWNER_AUTH_MODE !== 'passkey') return null;
    try {
      const { ownerAuthService } = await import('./lib/owner-auth/runtime');
      const deviceId = await ownerAuthService().verifyDeviceToken(token);
      return deviceId ? { kind: 'owner_device_bearer', deviceId } : null;
    } catch {
      return null;
    }
  }

  return (await configuredMobileBearerMatches(token, config))
    ? { kind: 'configured_installation_bearer' }
    : null;
}

/** Resolve installation ownership only after this request's bearer is valid. */
export async function authenticateMobileOwner(
  request: Request,
): Promise<AuthenticatedMobileOwner | null> {
  const principal = await authenticateMobileBearer(request);
  if (!principal) return null;

  const owner = await resolveMobileOwner(principal);
  return owner.ok ? { principal, ownerId: owner.ownerId } : null;
}

/** Resolve the installation owner after bearer authentication, preserving outage state. */
export async function resolveMobileOwner(
  _principal: MobileBearerPrincipal,
): Promise<MobileOwnerResolution> {
  try {
    const config = loadConfig();
    if (config.PERSISTENCE_DRIVER !== 'firestore') {
      const { assertPostgresInstallationOwner, getDb } = await import('./lib/server');
      const ownerId = await assertPostgresInstallationOwner(getDb());
      return typeof ownerId === 'string' && ownerId.length > 0
        ? { ok: true, ownerId }
        : { ok: false, reason: 'unavailable' };
    }

    const { validateAgentPersistenceConfig } = await import('@assistant/config');
    if (validateAgentPersistenceConfig(config).length || !config.FIRESTORE_AGENT_ID)
      return { ok: false, reason: 'unavailable' };
    return { ok: true, ownerId: config.FIRESTORE_AGENT_ID };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
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

const SAFE_MOBILE_FAILURE =
  'The request could not be completed. Check its status before trying again.';
const INTERNAL_DIAGNOSTIC =
  /(?:firestore.{0,80}(?:index|project|collection)|(?:index|project).{0,80}firestore|console\.firebase\.google\.com|firestore\.googleapis\.com|googleapis\.com\/.*(?:index|project)|^\s*Failed query:|\b(?:FAILED_PRECONDITION|PERMISSION_DENIED|SQLSTATE|PostgresError|DrizzleError)\b|\b(?:syntax error at or near|relation ["']?\w+["']? does not exist|duplicate key value violates unique constraint)\b|\bat\s+[\w$.<>]+\s*\([^\n]*:\d+:\d+\))/i;
const OMITTED_ERROR_FIELDS = new Set(['cause', 'debug', 'stack']);

function sanitizeMobileErrorPayload(value: unknown, status: number, key = ''): unknown {
  if (Array.isArray(value))
    return value.map((item) => sanitizeMobileErrorPayload(item, status, key));
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const sanitized: Record<string, unknown> = {};
    for (const [field, child] of Object.entries(value)) {
      const normalizedField = field.toLowerCase();
      if (status >= 400 && OMITTED_ERROR_FIELDS.has(normalizedField)) continue;
      sanitized[field] = sanitizeMobileErrorPayload(child, status, normalizedField);
    }
    return sanitized;
  }
  if (typeof value !== 'string') return value;
  if (status >= 500 && key === '') return SAFE_MOBILE_FAILURE;
  if (status >= 500 && ['error', 'message', 'details'].includes(key)) return SAFE_MOBILE_FAILURE;
  if (['error', 'message', 'details'].includes(key) && INTERNAL_DIAGNOSTIC.test(value))
    return SAFE_MOBILE_FAILURE;
  return value;
}

export function mobileJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'no-store');
  const status = init.status ?? 200;
  const payload = status >= 400 ? sanitizeMobileErrorPayload(value, status) : value;
  return Response.json(payload, { ...init, headers });
}
