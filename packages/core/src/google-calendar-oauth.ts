import { randomUUID } from 'node:crypto';
import type { GoogleCalendarOAuthConfig } from '@assistant/config/google-calendar';

export {
  type GoogleCalendarOAuthConfig,
  googleCalendarOAuthConfig,
} from '@assistant/config/google-calendar';

import {
  GOOGLE_CALENDAR_READ_SCOPE,
  type GoogleCalendarConnectionRepository,
} from '@assistant/persistence';
import { decryptStoredCredential, encryptStoredCredential } from './mcp-secrets.js';

export class GoogleCalendarOAuthError extends Error {
  constructor(
    readonly reason:
      | 'invalid_grant'
      | 'invalid_identity'
      | 'missing_scope'
      | 'provider_unavailable'
      | 'disconnected',
  ) {
    super(`Google Calendar ${reason}`);
  }
}
const allowedScopes = new Set([
  'openid',
  'email',
  'https://www.googleapis.com/auth/userinfo.email',
  GOOGLE_CALENDAR_READ_SCOPE,
]);
export function validGoogleCalendarScopes(scopes: string[]): boolean {
  return (
    scopes.includes(GOOGLE_CALENDAR_READ_SCOPE) &&
    scopes.includes('openid') &&
    (scopes.includes('email') ||
      scopes.includes('https://www.googleapis.com/auth/userinfo.email')) &&
    scopes.every((scope) => allowedScopes.has(scope))
  );
}
export async function googleCalendarTokenRequest(
  body: URLSearchParams,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  try {
    const response = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok)
      throw new GoogleCalendarOAuthError(
        data.error === 'invalid_grant' ? 'invalid_grant' : 'provider_unavailable',
      );
    if (typeof data.access_token !== 'string' || !data.access_token || data.token_type !== 'Bearer')
      throw new GoogleCalendarOAuthError('invalid_grant');
    return data;
  } catch (error) {
    if (error instanceof GoogleCalendarOAuthError) throw error;
    throw new GoogleCalendarOAuthError('provider_unavailable');
  }
}
/** Provider status alone cannot distinguish missing scope from Calendar quota failures. */
export function googleCalendarReadFailureReason(
  status: number,
  body: unknown,
  url?: string,
): 'invalid_grant' | 'missing_scope' | 'provider_unavailable' | null {
  if (status === 401) return 'invalid_grant';
  if (status === 429 || status >= 500) return 'provider_unavailable';
  if (status !== 403) return null;
  let accountFailure: 'provider_unavailable' | null = null;
  try {
    if (url && new URL(url).pathname === '/calendar/v3/users/me/calendarList')
      accountFailure = 'provider_unavailable';
  } catch {
    /* Unknown resource scope stays local to the failed request. */
  }
  let value: unknown = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return accountFailure;
    }
  }
  if (!value || typeof value !== 'object') return accountFailure;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return accountFailure;
  const { errors, details } = error as { errors?: unknown; details?: unknown };
  const reasons = [
    ...(Array.isArray(errors) ? errors : []),
    ...(Array.isArray(details) ? details : []),
  ].flatMap((entry: unknown) =>
    entry && typeof entry === 'object' && typeof (entry as { reason?: unknown }).reason === 'string'
      ? [(entry as { reason: string }).reason]
      : [],
  );
  if (
    reasons.some((reason) =>
      ['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(reason),
    )
  )
    return 'missing_scope';
  if (
    reasons.some((reason) =>
      [
        'rateLimitExceeded',
        'userRateLimitExceeded',
        'dailyLimitExceeded',
        'quotaExceeded',
        'SERVICE_DISABLED',
      ].includes(reason),
    )
  )
    return 'provider_unavailable';
  return accountFailure;
}
/** Report an actual Calendar failure without invalidating a newer token or another account. */
export async function reportGoogleCalendarReadFailure(input: {
  repository: GoogleCalendarConnectionRepository;
  ownerId: string;
  connectionId: string;
  credentialVersion?: number;
  accessToken: string;
  status: number;
  body: unknown;
  url?: string;
  decrypt?: (value: string) => string;
}): Promise<void> {
  const reason = googleCalendarReadFailureReason(input.status, input.body, input.url);
  if (!reason) return;
  const current = await input.repository.get(input.ownerId);
  const credential = current?.connection;
  if (
    !current ||
    !credential ||
    credential.id !== input.connectionId ||
    (input.credentialVersion !== undefined &&
      credential.credentialVersion !== input.credentialVersion) ||
    !credential.accessTokenEncrypted
  )
    return;
  let failedCurrentToken = false;
  try {
    failedCurrentToken =
      (input.decrypt ?? decryptStoredCredential)(credential.accessTokenEncrypted) ===
      input.accessToken;
  } catch {
    return;
  }
  // Let an active refresh finish its own probe/rotation rather than rejecting its result.
  if (!failedCurrentToken || credential.refreshLease) return;
  await input.repository.updateCredential(input.ownerId, current.revision, {
    ...credential,
    accessTokenEncrypted: null,
    accessTokenExpiresAt: null,
    status: reason === 'provider_unavailable' ? 'provider_unavailable' : 'reconnect_required',
    // The store also rejects a refresh claim or newer credential saved since this read.
  });
}
/** A harmless bounded read distinguishes granted OAuth from usable Calendar access. */
export async function probeGoogleCalendar(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  try {
    const response = await fetcher(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1&fields=kind',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      },
    );
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        /* Only fixed provider reasons leave this boundary. */
      }
      throw new GoogleCalendarOAuthError(
        googleCalendarReadFailureReason(response.status, body) ?? 'provider_unavailable',
      );
    }
    const data = (await response.json()) as { kind?: unknown };
    if (data.kind !== 'calendar#calendarList')
      throw new GoogleCalendarOAuthError('provider_unavailable');
  } catch (error) {
    if (error instanceof GoogleCalendarOAuthError) throw error;
    throw new GoogleCalendarOAuthError('provider_unavailable');
  }
}
/** The durable cache and refresh lease coordinate all processes without retaining plaintext. */
export async function getGoogleCalendarAccessToken(input: {
  repository: GoogleCalendarConnectionRepository;
  ownerId: string;
  config: GoogleCalendarOAuthConfig;
  forceRefresh?: boolean;
  rejectedAccessToken?: string;
  expectedConnectionId?: string;
  fetcher?: typeof fetch;
  encrypt?: (value: string) => string;
  decrypt?: (value: string) => string;
  now?: () => Date;
  wait?: () => Promise<void>;
}): Promise<{
  accessToken: string;
  account: { subject: string; email: string };
  revision: number;
  connectionId: string;
  credentialVersion: number;
}> {
  const { repository, ownerId, config } = input;
  const encrypt = input.encrypt ?? encryptStoredCredential;
  const decrypt = input.decrypt ?? decryptStoredCredential;
  const now = input.now ?? (() => new Date());
  const initial = await repository.get(ownerId);
  if (!initial?.connection) throw new GoogleCalendarOAuthError('disconnected');
  const generation = initial.connection.id;
  if (input.expectedConnectionId && input.expectedConnectionId !== generation)
    throw new GoogleCalendarOAuthError('disconnected');
  // The encrypted token bytes identify the rejected cache version without storing plaintext.
  const rejected =
    input.rejectedAccessToken &&
    initial.connection.accessTokenEncrypted &&
    decrypt(initial.connection.accessTokenEncrypted) === input.rejectedAccessToken
      ? initial.connection.accessTokenEncrypted
      : input.rejectedAccessToken
        ? 'already-advanced'
        : undefined;
  const leaseId = randomUUID();
  for (let attempt = 0; attempt < 100; attempt++) {
    const claim = await repository.acquireRefresh(
      ownerId,
      generation,
      leaseId,
      now(),
      input.forceRefresh ?? false,
      rejected,
    );
    if (claim.kind === 'disconnected') throw new GoogleCalendarOAuthError('disconnected');
    if (claim.kind === 'wait') {
      await (input.wait?.() ?? new Promise((resolve) => setTimeout(resolve, 200)));
      continue;
    }
    const credential = claim.credential;
    if (!validGoogleCalendarScopes(credential.scopes))
      throw new GoogleCalendarOAuthError('missing_scope');
    let accessToken: string;
    if (claim.kind === 'ready') {
      if (!credential.accessTokenEncrypted)
        throw new GoogleCalendarOAuthError('provider_unavailable');
      accessToken = decrypt(credential.accessTokenEncrypted);
    } else {
      let refreshedCredential = credential;
      try {
        const token = await googleCalendarTokenRequest(
          new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: decrypt(credential.refreshTokenEncrypted),
          }),
          input.fetcher,
        );
        // Persist rotation even when availability/scopes fail after a successful token exchange.
        refreshedCredential = {
          ...credential,
          refreshTokenEncrypted:
            typeof token.refresh_token === 'string' && token.refresh_token
              ? encrypt(token.refresh_token)
              : credential.refreshTokenEncrypted,
        };
        if (typeof token.scope === 'string' && !validGoogleCalendarScopes(token.scope.split(/\s+/)))
          throw new GoogleCalendarOAuthError('missing_scope');
        if (typeof token.expires_in !== 'number' || token.expires_in <= 0)
          throw new GoogleCalendarOAuthError('invalid_grant');
        accessToken = token.access_token as string;
        await probeGoogleCalendar(accessToken, input.fetcher);
        const updated = {
          ...refreshedCredential,
          status: 'connected' as const,
          accessTokenEncrypted: encrypt(accessToken),
          accessTokenExpiresAt: new Date(
            now().getTime() + Math.min(token.expires_in, 86400) * 1000,
          ).toISOString(),
        };
        if (
          !(await repository.completeRefresh(
            ownerId,
            generation,
            leaseId,
            credential.credentialVersion,
            updated,
          ))
        )
          throw new GoogleCalendarOAuthError('disconnected');
      } catch (error) {
        const reason =
          error instanceof GoogleCalendarOAuthError ? error.reason : 'provider_unavailable';
        if (reason !== 'disconnected')
          await repository.completeRefresh(
            ownerId,
            generation,
            leaseId,
            credential.credentialVersion,
            {
              ...refreshedCredential,
              accessTokenEncrypted: null,
              accessTokenExpiresAt: null,
              status:
                reason === 'invalid_grant' || reason === 'missing_scope'
                  ? 'reconnect_required'
                  : 'provider_unavailable',
            },
          );
        throw new GoogleCalendarOAuthError(reason);
      }
    }
    const current = await repository.get(ownerId);
    if (
      !current?.connection ||
      current.connection.id !== generation ||
      current.connection.status !== 'connected' ||
      !current.connection.accessTokenEncrypted
    )
      throw new GoogleCalendarOAuthError('disconnected');
    return {
      accessToken: decrypt(current.connection.accessTokenEncrypted),
      credentialVersion: current.connection.credentialVersion,
      account: current.connection.account,
      revision: current.revision,
      connectionId: generation,
    };
  }
  throw new GoogleCalendarOAuthError('provider_unavailable');
}
