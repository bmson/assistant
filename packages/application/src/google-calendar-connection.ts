import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  type GoogleCalendarOAuthConfig,
  GoogleCalendarOAuthError,
  googleCalendarTokenRequest,
  probeGoogleCalendar,
  validGoogleCalendarScopes,
} from '@assistant/core/google-calendar-oauth';
import { decryptStoredCredential, encryptStoredCredential } from '@assistant/core/mcp-secrets';
import {
  GOOGLE_CALENDAR_READ_SCOPE,
  type GoogleCalendarConnectionRepository,
  type GoogleCalendarConnectionState,
  type GoogleCalendarFlowOutcome,
} from '@assistant/persistence';
import { OAuth2Client } from 'google-auth-library';

export interface GoogleCalendarStatus {
  configured: boolean;
  state:
    | 'unconfigured'
    | 'disconnected'
    | 'connected'
    | 'reconnect_required'
    | 'provider_unavailable';
  account: { subject: string; email: string } | null;
  capabilities: { calendarRead: boolean };
  flow: { id: string; outcome: GoogleCalendarFlowOutcome; expiresAt: string } | null;
}
export interface GoogleCalendarConnectResponse {
  authorizationUrl: string;
  flowId: string;
  expiresAt: string;
}
export interface GoogleCalendarConnectionPorts {
  repository: GoogleCalendarConnectionRepository;
  config: GoogleCalendarOAuthConfig | null;
  now?: () => Date;
  encrypt?: (value: string) => string;
  decrypt?: (value: string) => string;
  fetcher?: typeof fetch;
  verifyIdentity?: (
    idToken: string,
    audience: string,
  ) => Promise<{ sub?: string; email?: string; email_verified?: boolean; nonce?: unknown }>;
}
function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function googleCalendarStatus(
  state: GoogleCalendarConnectionState | null,
  configured: boolean,
  now = new Date(),
): GoogleCalendarStatus {
  const connection = state?.connection;
  const f = state?.flow;
  return {
    configured,
    state: !configured ? 'unconfigured' : (connection?.status ?? 'disconnected'),
    account: connection?.account ?? null,
    capabilities: { calendarRead: configured && connection?.status === 'connected' },
    flow: f
      ? {
          id: f.id,
          expiresAt: f.expiresAt,
          outcome:
            ['pending', 'processing'].includes(f.outcome) &&
            Date.parse(f.expiresAt) <= now.getTime()
              ? 'expired'
              : f.outcome,
        }
      : null,
  };
}
export function createGoogleCalendarConnectionService(ports: GoogleCalendarConnectionPorts) {
  const now = ports.now ?? (() => new Date());
  const encrypt = ports.encrypt ?? encryptStoredCredential;
  const decrypt = ports.decrypt ?? decryptStoredCredential;
  const { repository, config } = ports;
  const status = async (ownerId: string) =>
    googleCalendarStatus(await repository.get(ownerId), config !== null, now());
  return {
    status,
    async connect(ownerId: string): Promise<GoogleCalendarConnectResponse> {
      if (!config) throw new GoogleCalendarOAuthError('disconnected');
      const id = randomUUID();
      const verifier = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      // Authenticated encrypted state avoids a second global owner lookup/index.
      const state = encrypt(
        JSON.stringify({ ownerId, flowId: id, secret: randomBytes(32).toString('base64url') }),
      );
      const expiresAt = new Date(now().getTime() + 10 * 60_000).toISOString();
      await repository.begin(ownerId, {
        id,
        stateHash: digest(state),
        nonce,
        verifierEncrypted: encrypt(verifier),
        expiresAt,
        outcome: 'pending',
      });
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        response_type: 'code',
        scope: `openid email ${GOOGLE_CALENDAR_READ_SCOPE}`,
        access_type: 'offline',
        prompt: 'consent select_account',
        include_granted_scopes: 'false',
        state,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      return { authorizationUrl: url.href, flowId: id, expiresAt };
    },
    async disconnect(ownerId: string) {
      await repository.disconnect(ownerId);
      return status(ownerId);
    },
    async flow(
      ownerId: string,
      flowId: string,
      cancel = false,
    ): Promise<GoogleCalendarStatus | null> {
      const current = await repository.get(ownerId);
      if (current?.flow?.id !== flowId) return null;
      if (cancel) await repository.cancel(ownerId, flowId);
      return status(ownerId);
    },
    async callback(params: URLSearchParams): Promise<{ flowId: string | null; accepted: boolean }> {
      if (!config) return { flowId: null, accepted: false };
      const state = params.get('state');
      if (!state || state.length > 8192 || params.getAll('state').length !== 1)
        return { flowId: null, accepted: false };
      let ownerId: string, flowId: string;
      try {
        const payload = JSON.parse(decrypt(state)) as Record<string, unknown>;
        if (
          typeof payload.ownerId !== 'string' ||
          typeof payload.flowId !== 'string' ||
          typeof payload.secret !== 'string'
        )
          return { flowId: null, accepted: false };
        ownerId = payload.ownerId;
        flowId = payload.flowId;
      } catch {
        return { flowId: null, accepted: false };
      }
      const claimed = await repository.consume(ownerId, flowId, digest(state), now());
      if (!claimed) return { flowId, accepted: false };
      const finish = (
        outcome: GoogleCalendarFlowOutcome,
        credential: GoogleCalendarConnectionState['connection'] = null,
      ) => repository.finish(ownerId, flowId, claimed.revision, outcome, credential, now());
      if (params.has('error')) {
        await finish(params.get('error') === 'access_denied' ? 'denied' : 'invalid_grant');
        return { flowId, accepted: false };
      }
      const code = params.get('code');
      if (
        !code ||
        code.length > 8192 ||
        params.getAll('code').length !== 1 ||
        !claimed.flow.verifierEncrypted
      ) {
        await finish('invalid_grant');
        return { flowId, accepted: false };
      }
      try {
        const tokens = await googleCalendarTokenRequest(
          new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: config.callbackUrl,
            grant_type: 'authorization_code',
            code,
            code_verifier: decrypt(claimed.flow.verifierEncrypted),
          }),
          ports.fetcher,
        );
        const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : [];
        if (!validGoogleCalendarScopes(scopes)) throw new GoogleCalendarOAuthError('missing_scope');
        if (typeof tokens.id_token !== 'string')
          throw new GoogleCalendarOAuthError('invalid_identity');
        const verify: NonNullable<GoogleCalendarConnectionPorts['verifyIdentity']> =
          ports.verifyIdentity ??
          (async (idToken: string, audience: string) => {
            const ticket = await new OAuth2Client().verifyIdToken({ idToken, audience });
            return (
              (ticket.getPayload() as {
                sub?: string;
                email?: string;
                email_verified?: boolean;
                nonce?: unknown;
              }) ?? {}
            );
          });
        let identity: Awaited<
          ReturnType<NonNullable<GoogleCalendarConnectionPorts['verifyIdentity']>>
        >;
        try {
          identity = await verify(tokens.id_token, config.clientId);
        } catch {
          throw new GoogleCalendarOAuthError('invalid_identity');
        }
        const prior = await repository.get(ownerId);
        if (
          !identity.sub ||
          !identity.email ||
          identity.email_verified !== true ||
          identity.nonce !== claimed.flow.nonce ||
          (prior?.connection && prior.connection.account.subject !== identity.sub)
        )
          throw new GoogleCalendarOAuthError('invalid_identity');
        if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token)
          throw new GoogleCalendarOAuthError('invalid_grant');
        if (typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0)
          throw new GoogleCalendarOAuthError('invalid_grant');
        const credential = {
          id: flowId,
          credentialVersion: 0,
          refreshLease: null,
          accessTokenEncrypted: encrypt(tokens.access_token as string),
          accessTokenExpiresAt: new Date(
            now().getTime() + Math.min(tokens.expires_in, 86400) * 1000,
          ).toISOString(),
          account: { subject: identity.sub, email: identity.email },
          scopes,
          refreshTokenEncrypted: encrypt(tokens.refresh_token),
          status: 'connected' as const,
          connectedAt: now().toISOString(),
        };
        try {
          await probeGoogleCalendar(tokens.access_token as string, ports.fetcher);
        } catch (error) {
          if (
            error instanceof GoogleCalendarOAuthError &&
            error.reason === 'provider_unavailable'
          ) {
            // Verified credentials survive a temporary API outage, but remain unavailable.
            await finish(
              'provider_unavailable',
              prior?.connection
                ? null
                : {
                    ...credential,
                    accessTokenEncrypted: null,
                    accessTokenExpiresAt: null,
                    status: 'provider_unavailable',
                  },
            );
            return { flowId, accepted: false };
          }
          throw error;
        }
        return { flowId, accepted: await finish('connected', credential) };
      } catch (error) {
        const outcome =
          error instanceof GoogleCalendarOAuthError && error.reason !== 'disconnected'
            ? error.reason
            : 'provider_unavailable';
        await finish(outcome);
        return { flowId, accepted: false };
      }
    },
  };
}
