import { createHash, randomUUID } from 'node:crypto';
import { decryptStoredCredential, encryptStoredCredential } from '@assistant/core/mcp-secrets';
import type {
  McpOAuthBinding,
  McpOAuthConnectionKey,
  McpOAuthGrant,
  McpOAuthRepository,
  McpOAuthTokens,
} from '@assistant/persistence';
import { inspectMcpConnection, type McpToolConnectionRecord } from './mcp.js';
import {
  createMcpOAuthAuthorization,
  discoverMcpOAuthServer,
  discoverMcpOAuthServers,
  exchangeMcpOAuthCode,
  generateMcpOAuthSecrets,
  McpOAuthError,
  type McpOAuthServer,
  type McpOAuthToken,
  refreshMcpOAuthToken,
  validateMcpOAuthCallbackIssuer,
} from './mcp-oauth.js';
import { type McpOAuthRegistration, resolveMcpOAuthClient } from './mcp-oauth-registration.js';

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FLOW_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 30_000;
const UNKNOWN_LIFETIME_SECONDS = 300;

type Device = 'web' | 'ios';
type GrantStatus = 'none' | 'authorized' | 'reauthorization_required';
type FlowOutcome =
  | 'pending'
  | 'processing'
  | 'authorized'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'superseded';

interface InstallationClient {
  metadata: { client_id: string; redirect_uris: string[] };
  registrations?: readonly McpOAuthRegistration[];
}

interface ServiceOptions extends InstallationClient {
  repo: McpOAuthRepository;
  readConnection(ownerId: string, connectionId: string): Promise<McpToolConnectionRecord | null>;
  resolveOwner(): Promise<string | null>;
}

function makeState(connectionId: string, flowId: string): string {
  return Buffer.from((connectionId + flowId).replaceAll('-', ''), 'hex').toString('base64url');
}

function parseState(state: string) {
  if (!STATE_PATTERN.test(state)) return null;
  const locator = state.slice(0, 43);
  const hex = Buffer.from(locator, 'base64url').toString('hex');
  const uuid = (value: string) =>
    [
      value.slice(0, 8),
      value.slice(8, 12),
      value.slice(12, 16),
      value.slice(16, 20),
      value.slice(20),
    ].join('-');
  const connectionId = uuid(hex.slice(0, 32));
  const flowId = uuid(hex.slice(32));
  return UUID.test(connectionId) && UUID.test(flowId) && makeState(connectionId, flowId) === locator
    ? { connectionId, flowId }
    : null;
}

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

function selectClient(
  server: McpOAuthServer,
  installation: InstallationClient,
  binding?: McpOAuthBinding,
) {
  const redirectUri = installation.metadata.redirect_uris[0];
  if (!redirectUri || (binding && binding.redirectUri !== redirectUri)) return null;
  return resolveMcpOAuthClient(server, {
    hostedClientId: installation.metadata.client_id,
    redirectUri,
    registrations: installation.registrations,
    expectedClientId: binding?.clientId,
    expectedTokenEndpointAuthMethod: binding?.tokenEndpointAuthMethod,
  });
}

function hasInstalledClient(
  installation: InstallationClient,
  binding: McpOAuthBinding,
  clientSecretEncrypted: string | null,
): boolean {
  try {
    // The status surface checks local config drift without remote requests.
    // Runtime attempts additionally verify the advertised provider metadata.
    const client = selectClient(
      {
        issuer: binding.issuer,
        resource: binding.resource,
        authorizationEndpoint: binding.authorizationEndpoint,
        tokenEndpoint: binding.tokenEndpoint,
        authorizationResponseIssuerRequired: binding.authorizationResponseIssuerRequired,
        clientIdMetadataDocument: true,
        tokenEndpointAuthMethods: [binding.tokenEndpointAuthMethod],
      },
      installation,
      binding,
    );
    return (
      client !== null &&
      client.clientSecret ===
        (clientSecretEncrypted ? decryptStoredCredential(clientSecretEncrypted) : undefined)
    );
  } catch {
    return false;
  }
}

async function verifyBinding(
  installation: InstallationClient,
  binding: McpOAuthBinding,
  clientSecretEncrypted: string | null,
) {
  const server = await discoverMcpOAuthServer(binding.endpoint, binding.issuer);
  if (
    !binding.authorizationResponseIssuerRequired ||
    server.resource !== binding.resource ||
    server.authorizationEndpoint !== binding.authorizationEndpoint ||
    server.tokenEndpoint !== binding.tokenEndpoint
  )
    throw new McpOAuthError('discovery_failed');
  const client = selectClient(server, installation, binding);
  if (
    !client ||
    client.clientSecret !==
      (clientSecretEncrypted ? decryptStoredCredential(clientSecretEncrypted) : undefined)
  ) {
    throw new McpOAuthError('unsupported_client');
  }
  return { server, client };
}

function encryptedTokens(
  token: McpOAuthToken,
  issuedAt: Date,
  oldScopes: string[] = [],
): McpOAuthTokens {
  return {
    accessTokenEncrypted: encryptStoredCredential(token.accessToken),
    refreshTokenEncrypted: token.refreshToken ? encryptStoredCredential(token.refreshToken) : null,
    accessTokenExpiresAt: new Date(
      issuedAt.getTime() + (token.expiresIn ?? UNKNOWN_LIFETIME_SECONDS) * 1_000,
    ).toISOString(),
    scopes: token.scope?.split(' ') ?? oldScopes,
  };
}

function grantStatus(grant: McpOAuthGrant | null | undefined): GrantStatus {
  if (!grant) return 'none';
  const time = Date.now();
  if (
    grant.reconnectRequired ||
    (grant.refresh && Date.parse(grant.refresh.expiresAt) <= time) ||
    (!grant.tokens.refreshTokenEncrypted && Date.parse(grant.tokens.accessTokenExpiresAt) <= time)
  )
    return 'reauthorization_required';
  return 'authorized';
}

export function createMcpOAuthService(options: ServiceOptions) {
  const { repo, readConnection, resolveOwner, metadata } = options;
  const redirectUri = metadata.redirect_uris[0];
  const eligible = (binding: McpOAuthBinding) => binding.redirectUri === redirectUri;
  async function load(ownerId: string, connectionId: string) {
    const connection = await readConnection(ownerId, connectionId);
    if (!connection) return null;
    const key = { ownerId, connectionId };
    const { endpoint } = connection;
    const state = connection.enabled ? await repo.get(key, endpoint) : null;
    return { connection, key, endpoint, state };
  }

  return {
    async status(ownerId: string, connectionId: string) {
      const row = await load(ownerId, connectionId);
      if (!row) return null;
      const grant = row.state?.grant;
      // Remote discovery runs when the owner explicitly chooses sign-in.
      return {
        connectionId,
        signInAvailable: row.connection.enabled && row.state !== null,
        grantGeneration: grant?.generation ?? null,
        grant:
          grant && !hasInstalledClient(options, grant.binding, grant.clientSecretEncrypted)
            ? ('reauthorization_required' as const)
            : grantStatus(grant),
      };
    },
    async start(ownerId: string, connectionId: string, client: Device) {
      const row = await load(ownerId, connectionId);
      if (!row?.state || !redirectUri || !UUID.test(connectionId)) return null;
      const { key, endpoint } = row;
      const eligibleServers = (await discoverMcpOAuthServers(endpoint)).flatMap((server) => {
        const registeredClient = selectClient(server, options);
        return registeredClient ? [{ server, registeredClient }] : [];
      });
      const selection =
        eligibleServers.find((item) => item.registeredClient.clientId !== metadata.client_id) ??
        eligibleServers[0];
      if (!selection) return null;
      const { server, registeredClient } = selection;
      const flowId = randomUUID();
      const secrets = generateMcpOAuthSecrets();
      const state = `${makeState(connectionId, flowId)}.${secrets.state}`;
      const { codeVerifier } = secrets;
      const binding = {
        endpoint,
        issuer: server.issuer,
        resource: server.resource,
        authorizationEndpoint: server.authorizationEndpoint,
        tokenEndpoint: server.tokenEndpoint,
        redirectUri,
        clientId: registeredClient.clientId,
        tokenEndpointAuthMethod: registeredClient.tokenEndpointAuthMethod,
        authorizationResponseIssuerRequired: true,
      };
      const authorizationUrl = createMcpOAuthAuthorization({
        server,
        clientId: binding.clientId,
        redirectUri,
        state,
        codeVerifier,
      }).href;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + FLOW_TTL_MS).toISOString();
      const saved = await repo.begin(
        key,
        {
          id: flowId,
          client,
          binding,
          stateHash: hashState(state),
          expiresAt,
          clientSecretEncrypted: registeredClient.clientSecret
            ? encryptStoredCredential(registeredClient.clientSecret)
            : null,
          phase: 'pending',
          verifierEncrypted: encryptStoredCredential(codeVerifier),
        },
        now,
      );
      return saved ? { connectionId, flowId, authorizationUrl, expiresAt } : null;
    },
    async flow(ownerId: string, connectionId: string, flowId: string, cancel: boolean) {
      let row = await load(ownerId, connectionId);
      if (!row?.state) return null;
      if (cancel) {
        const cancelled = await repo.cancel(row.key, row.endpoint, flowId);
        if (cancelled) return { connectionId, flowId, outcome: 'cancelled' as const };
        row = await load(ownerId, connectionId);
      }
      if (!row?.state) return null;
      const state = row.state;
      const flow = state.flow?.id === flowId ? state.flow : null;
      const terminal = state.lastOutcome?.id === flowId ? state.lastOutcome.outcome : null;
      const outcome: FlowOutcome = flow
        ? Date.parse(flow.expiresAt) <= Date.now()
          ? 'expired'
          : flow.phase
        : state.grant?.generation === flowId
          ? 'authorized'
          : terminal === 'invalid_grant' ||
              terminal === 'issuer_mismatch' ||
              terminal === 'provider_unavailable' ||
              terminal === 'connected'
            ? 'failed'
            : (terminal ?? 'superseded');
      return { connectionId, flowId, outcome };
    },
    async disconnect(ownerId: string, connectionId: string) {
      const row = await load(ownerId, connectionId);
      if (!row || !(await repo.disconnect(row.key, row.endpoint))) return null;
      const confirmed = await load(ownerId, connectionId);
      if (!confirmed || confirmed.state?.grant) return null;
      return {
        connectionId,
        signInAvailable: confirmed.connection.enabled,
        grant: 'none' as const,
        grantGeneration: null,
      };
    },
    async callback(params: URLSearchParams) {
      const code = params.getAll('code');
      const errors = params.getAll('error');
      if (
        params.getAll('state').length !== 1 ||
        code.length + errors.length !== 1 ||
        !(code[0] || errors[0])
      )
        return null;
      const state = params.get('state');
      const identifiers = state && parseState(state);
      if (!identifiers || !state) return null;
      const { connectionId, flowId } = identifiers;
      const ownerId = await resolveOwner();
      if (!ownerId) return null;
      const row = await load(ownerId, connectionId);
      const pending = row?.state?.flow;
      if (!row || pending?.id !== flowId || !eligible(pending.binding)) return null;
      // This callback is shared across issuers. Missing or mismatched issuer can never
      // consume a valid pending attempt or cause the code to be sent to a token endpoint.
      if (params.getAll('iss').length !== 1 || params.get('iss') !== pending.binding.issuer)
        return null;
      const { key, endpoint } = row;
      const flow = await repo.consume(key, endpoint, flowId, hashState(state), new Date());
      if (!flow) return null;
      const outcome = { client: flow.client, flowId };
      if (!code[0]) {
        await repo.finish(key, endpoint, flowId, { outcome: 'denied' }, new Date());
        return outcome;
      }
      try {
        const { server, client } = await verifyBinding(
          options,
          flow.binding,
          flow.clientSecretEncrypted,
        );
        validateMcpOAuthCallbackIssuer(server, params.get('iss'));
        const issuedAt = new Date();
        const token = await exchangeMcpOAuthCode({
          server,
          client,
          redirectUri: flow.binding.redirectUri,
          codeVerifier: decryptStoredCredential(flow.verifierEncrypted),
          code: code[0],
          callbackIssuer: params.get('iss'),
        });
        const stillProcessing = (await repo.get(key, endpoint))?.flow;
        if (
          stillProcessing?.id !== flowId ||
          stillProcessing.phase !== 'processing' ||
          Date.parse(stillProcessing.expiresAt) <= Date.now()
        )
          return outcome;
        const tokens = encryptedTokens(token, issuedAt, server.scope?.split(' '));
        const snapshot = await inspectMcpConnection(endpoint, {
          bearerTokenEncrypted: tokens.accessTokenEncrypted,
          publicHttpsOnly: true,
        });
        if (snapshot.status !== 'ready') throw new Error('MCP tools are unavailable.');
        await repo.finish(
          key,
          endpoint,
          flowId,
          {
            outcome: 'connected',
            tokens,
            discovery: { serverName: snapshot.serverName ?? null, tools: snapshot.tools },
          },
          new Date(),
        );
      } catch {
        await repo.finish(key, endpoint, flowId, { outcome: 'failed' }, new Date());
      }
      return outcome;
    },
  };
}

/** Resolve access for one already approved grant generation. A failed OAuth path cannot fall back. */
export async function resolveMcpOAuthCredential(
  repo: McpOAuthRepository,
  key: McpOAuthConnectionKey,
  endpoint: string,
  generation: string,
  installation: InstallationClient,
): Promise<string> {
  const reconnect = () => new Error('Reconnect this MCP account before using its tools.');
  const current = () => repo.get(key, endpoint);
  const before = (await current())?.grant;
  if (!before || before.generation !== generation || grantStatus(before) !== 'authorized') {
    throw reconnect();
  }
  // Compare the issuer and endpoints even while the access token is still live.
  if (!hasInstalledClient(installation, before.binding, before.clientSecretEncrypted))
    throw reconnect();
  const { server, client } = await verifyBinding(
    installation,
    before.binding,
    before.clientSecretEncrypted,
  );
  const grant = (await current())?.grant;
  if (!grant || grant.generation !== generation || grantStatus(grant) !== 'authorized')
    throw reconnect();
  const now = new Date();
  const expiry = Date.parse(grant.tokens.accessTokenExpiresAt);
  if (!grant.refresh && expiry > now.getTime() + REFRESH_SKEW_MS)
    return grant.tokens.accessTokenEncrypted;
  if (!grant.tokens.refreshTokenEncrypted && expiry > now.getTime())
    return grant.tokens.accessTokenEncrypted;
  const leaseId = randomUUID();
  const claim = await repo.acquireRefresh(key, endpoint, generation, grant.revision, leaseId, now);
  if (claim?.kind !== 'claimed') {
    if (claim?.kind === 'wait' || claim?.kind === 'current')
      throw new Error('MCP account refresh is in progress. Try a new request shortly.');
    throw reconnect();
  }
  const refreshToken = claim.grant.tokens.refreshTokenEncrypted;
  let result: McpOAuthTokens | 'not_sent' | 'reconnect_required';
  let dispatched = false;
  try {
    if (!refreshToken) throw reconnect();
    const plaintext = decryptStoredCredential(refreshToken);
    const issuedAt = new Date();
    dispatched = true;
    const token = await refreshMcpOAuthToken({
      server,
      client,
      refreshToken: plaintext,
    });
    const scopes = token.scope?.split(' ');
    const scopeChanged =
      scopes &&
      [...new Set(scopes)].sort().join(' ') !==
        [...new Set(claim.grant.tokens.scopes)].sort().join(' ');
    result = scopeChanged
      ? 'reconnect_required'
      : encryptedTokens(token, issuedAt, claim.grant.tokens.scopes);
  } catch (error) {
    const rejectedBeforeSend =
      error instanceof McpOAuthError &&
      ['invalid_request', 'unsupported_client', 'issuer_mismatch', 'discovery_failed'].includes(
        error.reason,
      );
    result = !dispatched || rejectedBeforeSend ? 'not_sent' : 'reconnect_required';
  }
  const saved = await repo.completeRefresh(
    key,
    endpoint,
    generation,
    claim.grant.revision,
    leaseId,
    result,
    new Date(),
  );
  if (!saved || typeof result === 'string') throw reconnect();
  const confirmed = (await current())?.grant;
  if (
    !confirmed ||
    confirmed.generation !== generation ||
    confirmed.revision !== claim.grant.revision + 1 ||
    confirmed.tokens.accessTokenEncrypted !== result.accessTokenEncrypted ||
    Date.parse(confirmed.tokens.accessTokenExpiresAt) <= Date.now()
  )
    throw reconnect();
  return confirmed.tokens.accessTokenEncrypted;
}
