import { decryptStoredCredential } from '@assistant/core/mcp-secrets';
import {
  createMcpOAuthRepository,
  type McpOAuthState,
  mcpApprovalBindingFingerprint,
  parseMcpOAuthState,
  projectMcpOAuthApproval,
} from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectMcpConnection } from './mcp.js';
import * as provider from './mcp-oauth.js';
import type { McpOAuthRegistration } from './mcp-oauth-registration.js';
import { createMcpOAuthService, resolveMcpOAuthCredential } from './mcp-oauth-service.js';

vi.mock('./mcp-oauth.js', async (read) => ({
  ...(await read<typeof provider>()),
  discoverMcpOAuthServers: vi.fn(),
  discoverMcpOAuthServer: vi.fn(),
  exchangeMcpOAuthCode: vi.fn(),
  refreshMcpOAuthToken: vi.fn(),
}));
vi.mock('./mcp.js', async (read) => ({
  ...(await read<typeof import('./mcp.js')>()),
  inspectMcpConnection: vi.fn(),
}));

const ownerId = 'owner';
const connectionId = '836ad80e-9c25-4ad0-80cb-84a322677f38';
const endpoint = 'https://mcp.example/mcp';
const issuer = 'https://issuer.example';
const metadata = {
  client_id: 'https://assistant.example/api/oauth/mcp/client-metadata',
  redirect_uris: ['https://assistant.example/api/oauth/mcp/callback'],
};
const server: provider.McpOAuthServer = {
  issuer,
  resource: endpoint,
  authorizationEndpoint: 'https://issuer.example/authorize',
  tokenEndpoint: 'https://issuer.example/token',
  authorizationResponseIssuerRequired: true,
  clientIdMetadataDocument: true,
  tokenEndpointAuthMethods: ['none'],
  scope: 'read',
};
const key = { ownerId, connectionId };
const token = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 600, scope: 'read' };

function fixture() {
  let row: McpOAuthState = parseMcpOAuthState(null, key, endpoint);
  const repo = createMcpOAuthRepository({
    async update(requested, target, mutate) {
      if (
        requested.ownerId !== ownerId ||
        requested.connectionId !== connectionId ||
        target !== endpoint
      )
        return null;
      const { state, result } = mutate(row);
      row = parseMcpOAuthState(state, key, endpoint);
      return result;
    },
  });
  const configuredService = (registrations?: readonly McpOAuthRegistration[]) =>
    createMcpOAuthService({
      repo,
      metadata,
      registrations,
      resolveOwner: async () => ownerId,
      readConnection: async (owner, id) =>
        owner === ownerId && id === connectionId
          ? {
              id,
              name: 'MCP',
              status: 'authorization_required',
              enabled: true,
              serverName: null,
              tools: [],
              endpoint,
              bearerTokenEncrypted: null,
            }
          : null,
    });
  const service = configuredService();
  const callback = async (patch: Record<string, string> = {}, active = service) => {
    const attempt = await active.start(ownerId, connectionId, 'web');
    const state = new URL(attempt?.authorizationUrl ?? '').searchParams.get('state') ?? '';
    return new URLSearchParams({ state, code: 'code', iss: issuer, ...patch });
  };
  return { service, repo, callback, configuredService };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('MCP_ENC_KEY', 'ab'.repeat(32));
  vi.mocked(provider.discoverMcpOAuthServers).mockResolvedValue([server]);
  vi.mocked(provider.discoverMcpOAuthServer).mockResolvedValue(server);
  vi.mocked(provider.exchangeMcpOAuthCode).mockResolvedValue(token);
  vi.mocked(inspectMcpConnection).mockResolvedValue({
    status: 'ready',
    serverName: 'MCP',
    tools: [{ name: 'items.list', description: 'List items', inputSchema: {} }],
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('optional MCP OAuth account lifecycle', () => {
  it('rejects issuer and state substitutions before redeeming a legitimate callback once', async () => {
    const { service, repo, callback } = fixture();
    const params = await callback();
    const wrongIssuer = new URLSearchParams(params);
    wrongIssuer.set('iss', 'https://wrong.example');
    expect(await service.callback(wrongIssuer)).toBeNull();
    const wrongState = new URLSearchParams(params);
    const actual = params.get('state') ?? '';
    wrongState.set('state', actual.slice(0, 44) + 'A'.repeat(43));
    expect(await service.callback(wrongState)).toBeNull();
    expect(provider.exchangeMcpOAuthCode).not.toHaveBeenCalled();
    const completed = await service.callback(params);
    expect(completed?.client).toBe('web');
    expect(await service.callback(params)).toBeNull();
    expect(provider.exchangeMcpOAuthCode).toHaveBeenCalledTimes(1);
    const saved = await repo.get(key, endpoint);
    expect(saved?.grant?.generation).toBe(completed?.flowId);
    expect(saved?.grant?.discovery.tools.map(({ name }) => name)).toEqual(['items.list']);
    const sealed = saved?.grant?.tokens.accessTokenEncrypted ?? '';
    expect(sealed).toMatch(/^v2\./);
    expect(decryptStoredCredential(sealed)).toBe('access');
  });

  it('does not restore a disconnected grant when an in-flight exchange completes', async () => {
    const { service, repo, callback } = fixture();
    const params = await callback();
    let finish!: (value: provider.McpOAuthToken) => void;
    vi.mocked(provider.exchangeMcpOAuthCode).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const completing = service.callback(params);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await service.disconnect(ownerId, connectionId);
    finish(token);
    await completing;
    expect((await repo.get(key, endpoint))?.grant).toBeNull();
    expect(inspectMcpConnection).not.toHaveBeenCalled();
  });

  it('preserves the previous grant after denied reauthorization', async () => {
    const { service, repo, callback } = fixture();
    const initial = await service.callback(await callback());
    const denied = await callback();
    denied.delete('code');
    denied.set('error', 'access_denied');
    const closed = await service.callback(denied);
    expect(closed).not.toBeNull();
    expect(await service.flow(ownerId, connectionId, closed?.flowId ?? '', false)).toMatchObject({
      outcome: 'denied',
    });
    expect((await repo.get(key, endpoint))?.grant?.generation).toBe(initial?.flowId);
    expect(provider.exchangeMcpOAuthCode).toHaveBeenCalledTimes(1);
  });

  it('refreshes credentials once without replacing grant identity and fails on redirect mismatch', async () => {
    const { service, repo, callback } = fixture();
    vi.mocked(provider.exchangeMcpOAuthCode).mockResolvedValue({ ...token, expiresIn: 1 });
    vi.mocked(provider.refreshMcpOAuthToken).mockResolvedValue({
      ...token,
      accessToken: 'rotated',
      refreshToken: null,
    });
    const done = await service.callback(await callback());
    const generation = done?.flowId ?? '';
    const credential = await resolveMcpOAuthCredential(repo, key, endpoint, generation, {
      metadata,
    });
    expect(decryptStoredCredential(credential)).toBe('rotated');
    const grant = (await repo.get(key, endpoint))?.grant;
    expect(grant).toMatchObject({ generation, revision: 1, refresh: null });
    expect(decryptStoredCredential(grant?.tokens.refreshTokenEncrypted ?? '')).toBe('refresh');
    await expect(
      resolveMcpOAuthCredential(repo, key, endpoint, generation, {
        metadata: { ...metadata, redirect_uris: ['https://other.example/callback'] },
      }),
    ).rejects.toThrow();
    expect(provider.refreshMcpOAuthToken).toHaveBeenCalledTimes(1);
  });

  it('preserves approvals through refresh but fences a paused grant or new authorization', async () => {
    const { service, repo, callback } = fixture();
    const initial = await service.callback(await callback());
    const first = await repo.get(key, endpoint);
    const connection = {
      id: connectionId,
      endpoint,
      enabled: true,
      status: 'ready',
      tools: [{ name: 'items.list', description: 'List items', inputSchema: {} }],
      bearerTokenEncrypted: 'saved-manual-token',
    };
    const hash = (state: McpOAuthState | null, enabled: boolean) =>
      mcpApprovalBindingFingerprint(
        projectMcpOAuthApproval(connection, ownerId, state, enabled),
        'items.list',
      );
    expect(hash(first, false)).toBeNull();
    const bound = hash(first, true);
    expect(bound).toMatch(/^[a-f0-9]{64}$/);
    expect(bound).not.toBe(hash(null, true));

    if (!first?.grant) throw new Error('Expected active grant');
    const generation = initial?.flowId ?? '';
    const lease = '83ee4772-a697-4008-9165-4800b4619b59';
    expect(
      await repo.acquireRefresh(key, endpoint, generation, 0, lease, new Date()),
    ).toMatchObject({ kind: 'claimed' });
    await repo.completeRefresh(
      key,
      endpoint,
      generation,
      0,
      lease,
      {
        ...first.grant.tokens,
        accessTokenEncrypted: first.grant.tokens.refreshTokenEncrypted ?? '',
      },
      new Date(),
    );
    expect(hash(await repo.get(key, endpoint), true)).toBe(bound);

    await service.callback(await callback());
    expect(hash(await repo.get(key, endpoint), true)).not.toBe(bound);
  });

  it('reports registration drift and confirms only the installed generation', async () => {
    const { configuredService, callback } = fixture();
    const registration: McpOAuthRegistration = {
      issuer,
      resource: endpoint,
      authorizationEndpoint: server.authorizationEndpoint,
      tokenEndpoint: server.tokenEndpoint,
      redirectUri: metadata.redirect_uris[0] ?? '',
      clientId: 'trusted-client',
      clientSecret: 'original-secret',
      tokenEndpointAuthMethod: 'client_secret_basic',
    };
    const registeredServer: provider.McpOAuthServer = {
      ...server,
      tokenEndpointAuthMethods: ['client_secret_basic'],
    };
    vi.mocked(provider.discoverMcpOAuthServers).mockResolvedValue([registeredServer]);
    vi.mocked(provider.discoverMcpOAuthServer).mockResolvedValue(registeredServer);
    const service = configuredService([registration]);
    const first = await service.callback(await callback({}, service));
    if (!first) throw new Error('Expected first grant generation');
    expect(await service.status(ownerId, connectionId)).toMatchObject({
      grant: 'authorized',
      grantGeneration: first.flowId,
    });
    vi.mocked(provider.discoverMcpOAuthServer).mockClear();
    const rotated = configuredService([{ ...registration, clientSecret: 'rotated-secret' }]);
    expect(await rotated.status(ownerId, connectionId)).toMatchObject({
      grant: 'reauthorization_required',
      grantGeneration: first.flowId,
    });
    expect(await configuredService([]).status(ownerId, connectionId)).toMatchObject({
      grant: 'reauthorization_required',
      grantGeneration: first.flowId,
    });
    expect(provider.discoverMcpOAuthServer).not.toHaveBeenCalled();
    const second = await rotated.callback(await callback({}, rotated));
    expect(second?.flowId).not.toBe(first.flowId);
    expect(await rotated.status(ownerId, connectionId)).toMatchObject({
      grant: 'authorized',
      grantGeneration: second?.flowId,
    });
    expect(await rotated.flow(ownerId, connectionId, first.flowId, false)).toMatchObject({
      outcome: 'superseded',
    });
  });
});
