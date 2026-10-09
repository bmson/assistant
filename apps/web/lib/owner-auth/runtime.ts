import { createHash } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import { FirestoreOwnerAuthRepository, type OwnerAuthState } from '@assistant/firestore';
import { cookies } from 'next/headers';
import { passkeyOrigin } from '@/auth-mode';
import { readBoundedJson } from '@/lib/bounded-json';
import { getFirestoreInstallationStore } from '@/lib/server';
import { OwnerAuthInputError, OwnerPasskeyService } from './service';
import {
  OWNER_SESSION_TTL_SECONDS,
  type OwnerSessionClaims,
  ownerSessionCookieName,
} from './tokens';

const STATE_TTL_MS = 10_000;
const DEVICE_TTL_MS = 30_000;

const cache = globalThis as typeof globalThis & {
  __assistantOwnerAuth?: {
    service: OwnerPasskeyService;
    repository: FirestoreOwnerAuthRepository;
    origin: string;
    state?: { value: OwnerAuthState; at: number };
    devices: Map<string, { deviceId: string | null; at: number }>;
  };
};

function runtime() {
  if (cache.__assistantOwnerAuth) return cache.__assistantOwnerAuth;
  const config = loadConfig();
  const target = passkeyOrigin(config.AUTH_URL);
  if (config.OWNER_AUTH_MODE !== 'passkey' || !target)
    throw new Error('Passkey owner authentication is not configured');
  const repository = new FirestoreOwnerAuthRepository(getFirestoreInstallationStore());
  const service = new OwnerPasskeyService({
    store: repository,
    secret: config.AUTH_SECRET,
    origin: target.origin,
    rpId: target.rpId,
    rpName: 'Assistant',
    installationId: process.env.ASSISTANT_WORKSPACE_ID || 'assistant',
    ownerName: config.OWNER_NAME,
  });
  cache.__assistantOwnerAuth = { service, repository, origin: target.origin, devices: new Map() };
  return cache.__assistantOwnerAuth;
}

export function ownerAuthService(): OwnerPasskeyService {
  return runtime().service;
}

export function ownerAuthRepository(): FirestoreOwnerAuthRepository {
  return runtime().repository;
}

/**
 * Stored claim/generation state, cached briefly per process. Revocation takes
 * effect in this process immediately and in other instances within 10 seconds.
 */
export async function ownerAuthState(fresh = false): Promise<OwnerAuthState> {
  const current = runtime();
  if (!fresh && current.state && Date.now() - current.state.at < STATE_TTL_MS)
    return current.state.value;
  const value = await current.repository.state();
  current.state = { value, at: Date.now() };
  return value;
}

export function forgetOwnerAuthState(): void {
  const current = runtime();
  current.state = undefined;
  current.devices.clear();
}

/** The verified browser session for this request, or null. */
export async function currentOwnerSession(): Promise<OwnerSessionClaims | null> {
  const current = runtime();
  const token = (await cookies()).get(ownerSessionCookieName(current.origin))?.value;
  const claims = current.service.readSession(token);
  if (!claims) return null;
  const state = await ownerAuthState();
  return state.claimed && state.sessionGeneration === claims.gen ? claims : null;
}

export async function setOwnerSessionCookie(token: string): Promise<void> {
  const current = runtime();
  (await cookies()).set(ownerSessionCookieName(current.origin), token, {
    httpOnly: true,
    secure: current.origin.startsWith('https://'),
    sameSite: 'lax',
    path: '/',
    maxAge: OWNER_SESSION_TTL_SECONDS,
  });
}

export async function clearOwnerSessionCookie(): Promise<void> {
  const current = runtime();
  (await cookies()).delete(ownerSessionCookieName(current.origin));
}

/** Native per-device bearer credentials, cached briefly to avoid a read per request. */
export async function verifyOwnerDeviceToken(token: string): Promise<boolean> {
  if (!token.startsWith('asd1_')) return false;
  const current = runtime();
  const key = createHash('sha256').update(token).digest('hex');
  const cached = current.devices.get(key);
  if (cached && Date.now() - cached.at < DEVICE_TTL_MS) return cached.deviceId !== null;
  const deviceId = await current.service.verifyDeviceToken(token);
  if (current.devices.size > 100) current.devices.clear();
  current.devices.set(key, { deviceId, at: Date.now() });
  return deviceId !== null;
}

/**
 * Credential-bearing POST/DELETE requests must come from this exact origin.
 * Browsers always send Origin on these methods; SameSite=Lax is a second layer.
 */
export function sameOrigin(request: Request): boolean {
  return request.headers.get('origin') === runtime().origin;
}

export function ownerAuthJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

/** Map rejected input to a generic status without echoing internal detail. */
export async function ownerAuthRoute(
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  if (loadConfig().OWNER_AUTH_MODE !== 'passkey') return ownerAuthJson({ error: 'not_found' }, 404);
  if (request.method !== 'GET' && !sameOrigin(request))
    return ownerAuthJson({ error: 'forbidden' }, 403);
  try {
    return await handler();
  } catch (error) {
    if (error instanceof OwnerAuthInputError)
      return ownerAuthJson({ error: error.code }, error.status);
    console.error('[owner-auth] request failed', error instanceof Error ? error.name : 'unknown');
    return ownerAuthJson({ error: 'unavailable' }, 503);
  }
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) {
    throw new OwnerAuthInputError(400, parsed.status === 413 ? 'body_too_large' : 'body_invalid');
  }
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value))
    throw new OwnerAuthInputError(400, 'body_invalid');
  return parsed.value as Record<string, unknown>;
}
