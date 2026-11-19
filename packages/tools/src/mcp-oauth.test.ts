import { createHash } from 'node:crypto';
import type { lookup } from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectMcpAuthorization, type McpAuthorizationIo } from './mcp-authorization.js';
import {
  createMcpOAuthAuthorization,
  discoverMcpOAuthServer,
  discoverMcpOAuthServers,
  exchangeMcpOAuthCode,
  generateMcpOAuthSecrets,
  type McpOAuthClient,
  type McpOAuthServer,
  refreshMcpOAuthToken,
} from './mcp-oauth.js';

const server: McpOAuthServer = {
  issuer: 'https://issuer.example/tenant',
  resource: 'https://mcp.example/mcp',
  authorizationEndpoint: 'https://issuer.example/authorize',
  tokenEndpoint: 'https://issuer.example/token',
  authorizationResponseIssuerRequired: true,
  clientIdMetadataDocument: true,
  tokenEndpointAuthMethods: ['none', 'client_secret_basic', 'client_secret_post'],
};
const client: McpOAuthClient = {
  clientId: 'test-client',
  tokenEndpointAuthMethod: 'none',
};
const redirectUri = 'https://assistant.example/oauth/callback';
const code = 'code+secret';
const grant = { access_token: 'issued.access-token', token_type: 'Bearer', expires_in: 3600 };
function fixture() {
  const lookupMock = vi.fn(async (_host: string) => [{ address: '93.184.216.34', family: 4 }]);
  const close = vi.fn();
  const request = vi.fn<McpAuthorizationIo['request']>();
  request.mockResolvedValue({ response: Response.json(grant), close });
  const io = { lookup: lookupMock as unknown as typeof lookup, request };
  const secrets = generateMcpOAuthSecrets();
  const exchange = (callbackIssuer: string | null = server.issuer) =>
    exchangeMcpOAuthCode(
      { server, client, redirectUri, codeVerifier: secrets.codeVerifier, code, callbackIssuer },
      { io },
    );
  return { io, lookupMock, request, close, secrets, exchange };
}

afterEach(() => vi.useRealTimers());

describe('MCP OAuth provider lifecycle', () => {
  it('discovers the exact advertised issuer, keeps endpoint metadata private, and honors the challenge scopes', async () => {
    const f = fixture();
    f.request.mockImplementation(async ({ endpoint }) => {
      let response: Response;
      if (endpoint.href === server.resource)
        response = new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer scope="read list"' },
        });
      else if (endpoint.pathname === '/.well-known/oauth-protected-resource/mcp')
        response = Response.json({
          resource: server.resource,
          authorization_servers: [server.issuer],
          scopes_supported: ['broad'],
        });
      else if (endpoint.pathname === '/.well-known/oauth-authorization-server/tenant')
        response = Response.json({
          issuer: server.issuer,
          authorization_endpoint: server.authorizationEndpoint,
          token_endpoint: server.tokenEndpoint,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: server.tokenEndpointAuthMethods,
          authorization_response_iss_parameter_supported: true,
          client_id_metadata_document_supported: true,
        });
      else response = new Response(null, { status: 404 });
      return { response, close: f.close };
    });
    const discovered = await discoverMcpOAuthServer(server.resource, server.issuer, { io: f.io });
    expect(discovered).toEqual({ ...server, scope: 'read list' });
    f.request.mockClear();
    await expect(discoverMcpOAuthServers(server.resource, { io: f.io })).resolves.toEqual([
      discovered,
    ]);
    expect(f.request).toHaveBeenCalledTimes(3);
    await expect(
      discoverMcpOAuthServer(server.resource, `${server.issuer}/`, { io: f.io }),
    ).rejects.toMatchObject({ reason: 'discovery_failed' });
    const diagnostic = await inspectMcpAuthorization(server.resource, { io: f.io });
    expect(diagnostic.status).toBe('supported');
    expect(JSON.stringify(diagnostic)).not.toContain(server.tokenEndpoint);
    expect(f.request.mock.calls.every(([, request]) => request.method === 'GET')).toBe(true);
  });

  it('binds S256, exact redirect, resource and state in the browser request', () => {
    const secrets = generateMcpOAuthSecrets();
    const scope = 'read list';
    const state = `v1.flow-id.${secrets.state}`;
    const url = createMcpOAuthAuthorization({
      server: { ...server, scope },
      clientId: client.clientId,
      redirectUri,
      ...secrets,
      state,
    });
    const expectedChallenge = createHash('sha256').update(secrets.codeVerifier).digest('base64url');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: client.clientId,
      resource: server.resource,
      redirect_uri: redirectUri,
      state,
      code_challenge: expectedChallenge,
      code_challenge_method: 'S256',
      scope,
    });
    expect(url.toString()).not.toContain(secrets.codeVerifier);
  });

  it.each([null, 'https://ISSUER.example/tenant', `${server.issuer}/`])(
    'rejects an absent or different issuer before DNS or token I/O (%j)',
    async (issuer) => {
      const f = fixture();
      await expect(f.exchange(issuer)).rejects.toMatchObject({ reason: 'issuer_mismatch' });
      expect(f.lookupMock).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it('exchanges the code once and confines secrets to the token POST', async () => {
    const f = fixture();
    await expect(f.exchange()).resolves.toEqual({
      accessToken: grant.access_token,
      refreshToken: null,
      expiresIn: 3600,
      scope: null,
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    const [[target, request] = []] = f.request.mock.calls;
    expect(target?.endpoint.href).toBe(server.tokenEndpoint);
    expect(request).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      resource: server.resource,
      redirect_uri: redirectUri,
      code_verifier: f.secrets.codeVerifier,
      code,
    });
  });

  it('performs refresh against the pinned token endpoint with exact client authentication', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({
      response: Response.json({ ...grant, refresh_token: 'rotated', scope: 'read' }),
      close: f.close,
    });
    await expect(
      refreshMcpOAuthToken(
        {
          server,
          client: {
            clientId: 'id:1',
            clientSecret: 'secret +',
            tokenEndpointAuthMethod: 'client_secret_basic',
          },
          refreshToken: 'existing',
        },
        { io: f.io },
      ),
    ).resolves.toMatchObject({ refreshToken: 'rotated', scope: 'read' });
    const [[target, request] = []] = f.request.mock.calls;
    expect(target).toMatchObject({ address: '93.184.216.34', family: 4 });
    expect(new Headers(request?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('id%3A1:secret+%2B').toString('base64')}`,
    );
    expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'existing',
      resource: server.resource,
    });
  });

  it('rejects a token endpoint when DNS contains any private address', async () => {
    const f = fixture();
    f.lookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(f.exchange()).rejects.toMatchObject({ reason: 'provider_unavailable' });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([
    [302, { location: 'https://redirect.example/token' }, 'invalid_response'],
    [503, { error: 'invalid_grant' }, 'provider_unavailable'],
    [400, { error: 'invalid_grant', error_description: 'untrusted secret' }, 'invalid_grant'],
    [200, { ...grant, token_type: 'DPoP' }, 'invalid_response'],
    [200, { ...grant, access_token: 'x\r\nAuthorization: Bearer stolen' }, 'invalid_response'],
  ] as const)(
    'classifies token HTTP %d safely and makes one attempt',
    async (status, body, reason) => {
      const f = fixture();
      f.request.mockResolvedValueOnce({
        response: Response.json(body, { status }),
        close: f.close,
      });
      await expect(f.exchange()).rejects.toMatchObject({ reason });
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(f.close).toHaveBeenCalledTimes(1);
    },
  );

  it('closes a stalled token response when its deadline expires', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.request.mockResolvedValueOnce({
      response: new Response(
        new ReadableStream({
          pull: () => new Promise(() => {}),
          cancel: () => new Promise(() => {}),
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
      close: f.close,
    });
    const verification = expect(f.exchange()).rejects.toMatchObject({
      reason: 'provider_unavailable',
    });
    await vi.advanceTimersByTimeAsync(20_001);
    await verification;
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});
