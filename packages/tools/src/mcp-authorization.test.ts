import type { lookup as dnsLookup } from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectMcpAuthorization,
  MCP_AUTHORIZATION_LIMITS,
  type McpAuthorizationIo,
  mcpResourceMetadataChallenge,
} from './mcp-authorization.js';

const ENDPOINT = 'https://mcp.example/public/mcp';
const RESOURCE_META = 'https://metadata.example/resource';
const ISSUER = 'https://auth.example/tenant';
const AS_META = 'https://auth.example/.well-known/oauth-authorization-server/tenant';
function server(issuer = ISSUER, patch: Record<string, unknown> = {}) {
  return {
    issuer,
    authorization_endpoint: 'https://login.example/authorize',
    token_endpoint: 'https://tokens.example/token',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    registration_endpoint: 'https://registration.example/register',
    authorization_response_iss_parameter_supported: true,
    ...patch,
  };
}
function fixture(endpoint = ENDPOINT) {
  const routes = new Map<string, () => Response>();
  const close = vi.fn();
  const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
  const request = vi.fn<McpAuthorizationIo['request']>(async (target) => ({
    response: routes.get(target.endpoint.href)?.() ?? new Response(null, { status: 404 }),
    close,
  }));
  const io: McpAuthorizationIo = { lookup: lookup as unknown as typeof dnsLookup, request };
  routes.set(
    endpoint,
    () =>
      new Response(null, {
        status: 401,
        headers: {
          'WWW-Authenticate': `Basic realm="other, realm", Bearer resource_metadata="${RESOURCE_META}", scope="read write"`,
        },
      }),
  );
  routes.set(RESOURCE_META, () =>
    Response.json({ resource: endpoint, authorization_servers: [ISSUER] }),
  );
  routes.set(AS_META, () => Response.json(server()));
  return {
    routes,
    lookup,
    request,
    close,
    io,
    inspect: () => inspectMcpAuthorization(endpoint, { io }),
  };
}
afterEach(() => vi.useRealTimers());

describe('transient MCP OAuth support diagnostics', () => {
  it('uses the challenge URL and returns metadata support without claiming authentication or registering', async () => {
    const f = fixture();
    expect(await f.inspect()).toEqual({
      status: 'supported',
      authenticated: false,
      oauthConnectionSupported: false,
      transportProtocolVersion: '2025-11-25',
      resource: ENDPOINT,
      reason: null,
      authorizationServers: [
        {
          issuer: ISSUER,
          pkceS256: true,
          authorizationResponseIssuerRequired: true,
          registration: {
            preRegistration: 'not_checked',
            clientIdMetadataDocument: true,
            dynamicClientRegistration: true,
          },
        },
      ],
    });
    expect(f.request.mock.calls.map(([target]) => target.endpoint.href)).toEqual([
      ENDPOINT,
      RESOURCE_META,
      AS_META,
    ]);
    for (const [target, init] of f.request.mock.calls) {
      expect(target.address).toBe('93.184.216.34');
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
      });
      expect(init.headers).not.toHaveProperty('Authorization');
      expect(init.headers).not.toHaveProperty('Cookie');
      expect(init.body).toBeUndefined();
    }
    expect(f.lookup.mock.calls.length).toBeGreaterThan(f.request.mock.calls.length); // advertised endpoints are validated, never invoked
    expect(f.close).toHaveBeenCalledTimes(3);
  });
  it('falls back path/root then RFC8414/OIDC insertion/appending in exact order', async () => {
    const f = fixture();
    f.routes.set(ENDPOINT, () => new Response(null, { status: 401 }));
    f.routes.delete(AS_META);
    const root = 'https://mcp.example/.well-known/oauth-protected-resource';
    f.routes.set(root, () =>
      Response.json({ resource: ENDPOINT, authorization_servers: [ISSUER] }),
    );
    const append = 'https://auth.example/tenant/.well-known/openid-configuration';
    f.routes.set(append, () => Response.json(server()));
    expect((await f.inspect()).status).toBe('supported');
    expect(f.request.mock.calls.map(([target]) => target.endpoint.href)).toEqual([
      ENDPOINT,
      'https://mcp.example/.well-known/oauth-protected-resource/public/mcp',
      root,
      AS_META,
      'https://auth.example/.well-known/openid-configuration/tenant',
      append,
    ]);
  });
  it.each([408, 429, 500, 502, 503, 504])(
    'reports a retryable discovery failure when the probe returns %i and metadata is absent',
    async (status) => {
      const f = fixture();
      f.routes.set(ENDPOINT, () => new Response(null, { status }));
      expect(await f.inspect()).toMatchObject({
        status: 'discovery_failed',
        reason: 'request_failed',
      });
      expect(f.request.mock.calls.map(([target]) => target.endpoint.href)).toEqual([
        ENDPOINT,
        'https://mcp.example/.well-known/oauth-protected-resource/public/mcp',
        'https://mcp.example/.well-known/oauth-protected-resource',
      ]);
    },
  );
  it('accepts valid fallback metadata after an endpoint probe returns 503', async () => {
    const f = fixture();
    f.routes.set(ENDPOINT, () => new Response(null, { status: 503 }));
    f.routes.set('https://mcp.example/.well-known/oauth-protected-resource', () =>
      Response.json({ resource: ENDPOINT, authorization_servers: [ISSUER] }),
    );
    expect(await f.inspect()).toMatchObject({
      status: 'supported',
      authenticated: false,
      reason: null,
    });
  });
  it('does not use path/root fallback after an authoritative challenge URL fails', async () => {
    const f = fixture();
    f.routes.delete(RESOURCE_META);
    const result = await f.inspect();
    expect(result).toMatchObject({ status: 'unsupported', reason: 'no_resource_metadata' });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each(['https://mcp.example', 'https://mcp.example/'])(
    'constructs one canonical root identifier for %s and requires its exact returned match',
    async (endpoint) => {
      const f = fixture(new URL(endpoint).href);
      f.routes.set(RESOURCE_META, () =>
        Response.json({ resource: 'https://mcp.example', authorization_servers: [ISSUER] }),
      );
      expect(await inspectMcpAuthorization(endpoint, { io: f.io })).toMatchObject({
        status: 'supported',
        resource: 'https://mcp.example',
      });
      f.routes.set(RESOURCE_META, () =>
        Response.json({ resource: 'https://mcp.example/', authorization_servers: [ISSUER] }),
      );
      expect(await inspectMcpAuthorization(endpoint, { io: f.io })).toMatchObject({
        status: 'unsupported',
        reason: 'resource_mismatch',
      });
    },
  );
  it.each([
    'https://mcp.example/public',
    'https://mcp.example/public/mcp/',
    'https://mcp.example/other',
  ])('rejects a different resource %s without AS requests', async (resource) => {
    const f = fixture();
    f.routes.set(RESOURCE_META, () => Response.json({ resource, authorization_servers: [ISSUER] }));
    expect(await f.inspect()).toMatchObject({ status: 'unsupported', reason: 'resource_mismatch' });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each([`${ISSUER}/`, 'https://auth.example/other'])(
    'compares returned issuer as an exact raw string: %s',
    async (issuer) => {
      const f = fixture();
      f.routes.set(AS_META, () => Response.json(server(issuer)));
      expect(await f.inspect()).toMatchObject({ status: 'unsupported', reason: 'issuer_mismatch' });
    },
  );
  it.each([undefined, [], ['plain']])(
    'rejects absent/non-S256 PKCE without a fallback downgrade',
    async (code_challenge_methods_supported) => {
      const f = fixture();
      f.routes.set(AS_META, () =>
        Response.json(server(ISSUER, { code_challenge_methods_supported })),
      );
      expect(await f.inspect()).toMatchObject({
        status: 'unsupported',
        reason: 'pkce_s256_required',
      });
      expect(f.request).toHaveBeenCalledTimes(3);
    },
  );
  it.each([
    { response_types_supported: ['token'] },
    { grant_types_supported: ['client_credentials'] },
  ])('requires authorization-code metadata: %j', async (patch) => {
    const f = fixture();
    f.routes.set(AS_META, () => Response.json(server(ISSUER, patch)));
    expect(await f.inspect()).toMatchObject({
      status: 'unsupported',
      reason: 'authorization_code_required',
    });
  });
  it('keeps registration metadata scoped independently to each advertised issuer', async () => {
    const f = fixture();
    const second = 'https://second.example';
    f.routes.set(RESOURCE_META, () =>
      Response.json({ resource: ENDPOINT, authorization_servers: [ISSUER, second] }),
    );
    f.routes.set(`${second}/.well-known/oauth-authorization-server`, () =>
      Response.json(
        server(second, {
          client_id_metadata_document_supported: false,
          registration_endpoint: undefined,
          authorization_response_iss_parameter_supported: false,
        }),
      ),
    );
    const result = await f.inspect();
    expect(result.status).toBe('supported');
    expect(
      result.authorizationServers.map((s) => [
        s.issuer,
        s.registration.clientIdMetadataDocument,
        s.registration.dynamicClientRegistration,
      ]),
    ).toEqual([
      [ISSUER, true, true],
      [second, false, false],
    ]);
  });
  it('classifies a temporary DNS failure separately from an unsafe address', async () => {
    const f = fixture();
    f.lookup.mockRejectedValueOnce(Error('temporary resolver outage with secret-detail'));
    const result = await f.inspect();
    expect(result).toMatchObject({ status: 'discovery_failed', reason: 'request_failed' });
    expect(JSON.stringify(result)).not.toContain('secret-detail');
    expect(f.request).not.toHaveBeenCalled();
    f.lookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    expect(await f.inspect()).toMatchObject({ status: 'unsupported', reason: 'unsafe_endpoint' });
  });
  it.each([
    'http://mcp.example/mcp',
    'https://user:secret@mcp.example/mcp',
    'https://mcp.example/mcp?api_key=secret',
    'https://mcp.example/mcp#secret',
    'https://127.0.0.1/mcp',
    'https://[::ffff:127.0.0.1]/mcp',
    'https://[2002:7f00:1::]/mcp',
  ])('rejects unsafe endpoint %s without a request', async (endpoint) => {
    const f = fixture();
    expect(await inspectMcpAuthorization(endpoint, { io: f.io })).toMatchObject({
      status: 'unsupported',
      reason: 'unsafe_endpoint',
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('rejects a mixed public/private DNS answer and revalidates DNS for each request', async () => {
    const f = fixture();
    f.lookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    expect((await f.inspect()).reason).toBe('unsafe_endpoint');
    expect(f.request).not.toHaveBeenCalled();
    f.lookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    expect((await f.inspect()).reason).toBe('unsafe_endpoint');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(['authorization_endpoint', 'token_endpoint', 'registration_endpoint'])(
    'validates advertised %s before calling metadata supported',
    async (key) => {
      const f = fixture();
      f.routes.set(AS_META, () =>
        Response.json(server(ISSUER, { [key]: 'https://127.0.0.1/private' })),
      );
      expect(await f.inspect()).toMatchObject({ status: 'unsupported', reason: 'unsafe_endpoint' });
      expect(
        f.request.mock.calls.every(([target]) => target.endpoint.hostname !== '127.0.0.1'),
      ).toBe(true);
    },
  );
  it('does not follow any redirect, including a private Location', async () => {
    const f = fixture();
    f.routes.set(
      RESOURCE_META,
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://169.254.169.254/secret' },
        }),
    );
    expect(await f.inspect()).toMatchObject({
      status: 'discovery_failed',
      reason: 'redirect_not_allowed',
    });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each([
    new Response('provider-secret', { headers: { 'content-type': 'text/html' } }),
    new Response('{"invalid":provider-secret}', {
      headers: { 'content-type': 'application/json' },
    }),
  ])('sanitizes malformed metadata', async (response) => {
    const f = fixture();
    f.routes.set(RESOURCE_META, () => response.clone());
    const result = await f.inspect();
    expect(result.status).toBe('unsupported');
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  });
  it('bounds declared and streamed bytes, and rejects compressed responses', async () => {
    const f = fixture();
    for (const response of [
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': '999999' },
      }),
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      }),
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(40_000));
            c.enqueue(new Uint8Array(40_000));
            c.close();
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    ]) {
      f.routes.set(RESOURCE_META, () => response);
      expect(await f.inspect()).toMatchObject({
        status: 'discovery_failed',
        reason: 'response_limit',
      });
    }
  });
  it('bounds authorization-server fanout before fetching any AS document', async () => {
    const f = fixture();
    f.routes.set(RESOURCE_META, () =>
      Response.json({
        resource: ENDPOINT,
        authorization_servers: [
          'https://a.example',
          'https://b.example',
          'https://c.example',
          'https://d.example',
        ],
      }),
    );
    expect(await f.inspect()).toMatchObject({
      status: 'unsupported',
      reason: 'invalid_resource_metadata',
    });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('applies one transaction deadline to a stalled DNS lookup', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.lookup.mockImplementationOnce(() => new Promise(() => {}));
    const operation = f.inspect();
    await vi.advanceTimersByTimeAsync(MCP_AUTHORIZATION_LIMITS.timeoutMs);
    expect(await operation).toMatchObject({ status: 'discovery_failed', reason: 'deadline' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('closes a late header response after cancellation without reading it', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release: (opened: { response: Response; close(): void }) => void = () => {};
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const operation = f.inspect();
    await vi.advanceTimersByTimeAsync(MCP_AUTHORIZATION_LIMITS.timeoutMs);
    expect((await operation).reason).toBe('deadline');
    release({ response: Response.json({ secret: 'unused' }), close: f.close });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.close).toHaveBeenCalled();
  });
});

describe('WWW-Authenticate parsing', () => {
  it('handles quoted commas, escaped quotes and multiple authentication schemes', () => {
    expect(
      mcpResourceMetadataChallenge(
        'Basic realm="a,b", Bearer realm="a\\"b", resource_metadata="https://meta.example/doc", scope="a b"',
      ),
    ).toBe('https://meta.example/doc');
    expect(mcpResourceMetadataChallenge('Basic realm="not bearer"')).toBeNull();
  });
  it('preserves an authoritative continuation with whitespace around equals', () => {
    expect(
      mcpResourceMetadataChallenge(
        'Basic realm="other, realm", Bearer realm="owner", resource_metadata = "https://meta.example/doc", scope = "read write"',
      ),
    ).toBe('https://meta.example/doc');
    expect(
      mcpResourceMetadataChallenge('Bearer resource_metadata = "https://meta.example/doc"'),
    ).toBe('https://meta.example/doc');
  });
  it.each([
    'Bearer resource_metadata="https://a.example", resource_metadata="https://b.example"',
    'Bearer resource_metadata="https://a.example", Bearer resource_metadata="https://b.example"',
    'Bearer resource_metadata="unterminated',
    'Bearer resource_metadata=""',
  ])('rejects ambiguous or malformed challenge %s', (header) => {
    expect(() => mcpResourceMetadataChallenge(header)).toThrow();
  });
});
