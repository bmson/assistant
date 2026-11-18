import { createHash, randomBytes } from 'node:crypto';
import { boundedProviderResponse } from './bounded-provider-response.js';
import {
  MCP_AUTHORIZATION_LIMITS,
  type McpAuthorizationIo,
  type McpOAuthServer,
  openMcpAuthorizationRequest,
  readMcpOAuthServers,
} from './mcp-authorization.js';
import { resolveMcpEndpoint } from './mcp-http.js';

export type { McpOAuthServer } from './mcp-authorization.js';

export type McpOAuthTokenEndpointAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: McpOAuthTokenEndpointAuthMethod;
}

export interface McpOAuthToken {
  accessToken: string;
  refreshToken: string | null;
  /** Lifetime in seconds, when explicitly reported. */
  expiresIn: number | null;
  scope: string | null;
}

type ProviderOptions = { signal?: AbortSignal; io?: McpAuthorizationIo };
type McpOAuthErrorReason =
  | 'discovery_failed'
  | 'issuer_mismatch'
  | 'invalid_request'
  | 'unsupported_client'
  | 'invalid_response'
  | 'invalid_grant'
  | 'provider_unavailable';

export class McpOAuthError extends Error {
  constructor(readonly reason: McpOAuthErrorReason) {
    super(`MCP authorization failed: ${reason}.`);
  }
}

export async function discoverMcpOAuthServer(
  endpoint: string,
  issuer: string,
  options?: ProviderOptions,
): Promise<McpOAuthServer> {
  const [server] = await readMcpOAuthServers(endpoint, { ...options, issuer });
  if (!server) throw new McpOAuthError('discovery_failed');
  return server;
}

export async function discoverMcpOAuthServers(
  endpoint: string,
  options?: ProviderOptions,
): Promise<McpOAuthServer[]> {
  const servers = await readMcpOAuthServers(endpoint, options);
  if (!servers.length) throw new McpOAuthError('discovery_failed');
  return servers;
}

export function generateMcpOAuthSecrets(): { state: string; codeVerifier: string } {
  return {
    state: randomBytes(32).toString('base64url'),
    codeVerifier: randomBytes(32).toString('base64url'),
  };
}

export function validateMcpOAuthCallbackIssuer(
  server: McpOAuthServer,
  issuer?: string | null,
): void {
  if (issuer == null ? server.authorizationResponseIssuerRequired : issuer !== server.issuer)
    throw new McpOAuthError('issuer_mismatch');
}

function httpsUrl(value: string): URL {
  if (
    !/^https:\/\//i.test(value) ||
    /[^\x21-\x7e]/.test(value) ||
    value.length > MCP_AUTHORIZATION_LIMITS.maxUrlLength
  )
    throw new McpOAuthError('invalid_request');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError('invalid_request');
  }
  if (url.username || url.password || url.hash || url.search)
    throw new McpOAuthError('invalid_request');
  return url;
}

function verifier(value: string): string {
  if (value.length < 43 || value.length > 128 || /[^A-Za-z0-9._~-]/.test(value))
    throw new McpOAuthError('invalid_request');
  return value;
}

function opaqueValue(value: string, maxBytes: number): string {
  if (!value || /[^\x20-\x7e]/.test(value) || value.length > maxBytes)
    throw new McpOAuthError('invalid_request');
  return value;
}

function validScope(value: string): boolean {
  return (
    value.length <= 4096 &&
    !/[^\x20-\x21\x23-\x5b\x5d-\x7e]/.test(value) &&
    value.split(' ').every(Boolean)
  );
}

export function createMcpOAuthAuthorization(input: {
  server: McpOAuthServer;
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  scope?: string;
}): URL {
  const url = httpsUrl(input.server.authorizationEndpoint);
  httpsUrl(input.redirectUri);
  httpsUrl(input.server.resource);
  if (!/^[A-Za-z0-9._~-]{43,512}$/.test(input.state)) throw new McpOAuthError('invalid_request');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: opaqueValue(input.clientId, 2048),
    redirect_uri: input.redirectUri,
    resource: input.server.resource,
    state: input.state,
    code_challenge: createHash('sha256').update(verifier(input.codeVerifier)).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  const scope = input.scope ?? input.server.scope;
  if (scope !== undefined) {
    if (!validScope(scope)) throw new McpOAuthError('invalid_request');
    url.searchParams.set('scope', scope);
  }
  return url;
}

export async function exchangeMcpOAuthCode(
  input: {
    server: McpOAuthServer;
    client: McpOAuthClient;
    redirectUri: string;
    codeVerifier: string;
    code: string;
    callbackIssuer?: string | null;
  },
  options?: ProviderOptions,
): Promise<McpOAuthToken> {
  validateMcpOAuthCallbackIssuer(input.server, input.callbackIssuer);
  httpsUrl(input.redirectUri);
  return requestMcpOAuthToken(
    input.server,
    input.client,
    {
      grant_type: 'authorization_code',
      code: opaqueValue(input.code, 8192),
      redirect_uri: input.redirectUri,
      code_verifier: verifier(input.codeVerifier),
    },
    options,
  );
}

export async function refreshMcpOAuthToken(
  input: { server: McpOAuthServer; client: McpOAuthClient; refreshToken: string },
  options?: ProviderOptions,
): Promise<McpOAuthToken> {
  return requestMcpOAuthToken(
    input.server,
    input.client,
    {
      grant_type: 'refresh_token',
      refresh_token: opaqueValue(input.refreshToken, 8192),
    },
    options,
  );
}

function tokenParameters(
  server: McpOAuthServer,
  client: McpOAuthClient,
  parameters: Record<string, string>,
): { body: string; headers: Record<string, string> } {
  const method = client.tokenEndpointAuthMethod;
  if (!server.tokenEndpointAuthMethods.includes(method))
    throw new McpOAuthError('unsupported_client');
  const clientId = opaqueValue(client.clientId, 2048);
  const body = new URLSearchParams({ ...parameters, resource: server.resource });
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Encoding': 'identity',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (method === 'none') {
    if (client.clientSecret !== undefined) throw new McpOAuthError('unsupported_client');
    body.set('client_id', clientId);
  } else {
    if (!client.clientSecret) throw new McpOAuthError('unsupported_client');
    const secret = opaqueValue(client.clientSecret, 4096);
    if (method === 'client_secret_basic') {
      const encode = (value: string) =>
        new URLSearchParams({ value }).toString().slice('value='.length);
      headers.Authorization = `Basic ${Buffer.from(`${encode(clientId)}:${encode(secret)}`).toString('base64')}`;
    } else if (method === 'client_secret_post') {
      body.set('client_id', clientId);
      body.set('client_secret', secret);
    } else {
      throw new McpOAuthError('unsupported_client');
    }
  }
  return { body: body.toString(), headers };
}

async function requestMcpOAuthToken(
  server: McpOAuthServer,
  client: McpOAuthClient,
  parameters: Record<string, string>,
  options?: ProviderOptions,
): Promise<McpOAuthToken> {
  httpsUrl(server.resource);
  const endpoint = httpsUrl(server.tokenEndpoint).href;
  const { headers, body } = tokenParameters(server, client, parameters);
  let close: (() => void) | undefined;
  let response: Response;
  try {
    response = await boundedProviderResponse(
      async (_url, init) => {
        const signal = init?.signal ?? undefined;
        const target = await resolveMcpEndpoint(endpoint, {
          publicHttpsOnly: true,
          lookup: options?.io?.lookup,
          signal,
        });
        signal?.throwIfAborted();
        const opened = await (options?.io?.request ?? openMcpAuthorizationRequest)(
          target,
          init ?? {},
        );
        if (signal?.aborted) {
          opened.close();
          signal.throwIfAborted();
        }
        close = () => opened.close();
        const encoding = opened.response.headers.get('content-encoding');
        if (encoding && encoding.toLowerCase() !== 'identity')
          throw new McpOAuthError('invalid_response');
        if (opened.response.status >= 300 && opened.response.status < 400)
          throw new McpOAuthError('invalid_response');
        return opened.response;
      },
      endpoint,
      { method: 'POST', headers, body, redirect: 'error', signal: options?.signal },
      {
        timeoutMs: MCP_AUTHORIZATION_LIMITS.timeoutMs,
        maxBytes: MCP_AUTHORIZATION_LIMITS.maxResponseBytes,
        label: 'MCP token',
      },
    );
  } catch (error) {
    // Upstream exceptions can contain remote URLs, request bodies, or credentials.
    if (error instanceof McpOAuthError) throw error;
    throw new McpOAuthError('provider_unavailable');
  } finally {
    close?.();
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500)
    throw new McpOAuthError('provider_unavailable');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
    throw new McpOAuthError('invalid_response');
  let value: unknown;
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer());
    value = JSON.parse(raw);
  } catch {
    throw new McpOAuthError('invalid_response');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new McpOAuthError('invalid_response');
  const record = value as Record<string, unknown>;
  if (response.status === 400 && record.error === 'invalid_grant')
    throw new McpOAuthError('invalid_grant');
  if (!response.ok || Object.hasOwn(record, 'error')) throw new McpOAuthError('invalid_response');
  return parseToken(record);
}

function parseToken(record: Record<string, unknown>): McpOAuthToken {
  const { access_token, token_type, refresh_token, expires_in, scope } = record;
  if (
    typeof access_token !== 'string' ||
    access_token.length > 8192 ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(access_token) ||
    typeof token_type !== 'string' ||
    token_type.toLowerCase() !== 'bearer' ||
    (refresh_token !== undefined &&
      (typeof refresh_token !== 'string' ||
        !refresh_token ||
        refresh_token.length > 8192 ||
        /[^\x20-\x7e]/.test(refresh_token))) ||
    (expires_in !== undefined &&
      (typeof expires_in !== 'number' ||
        !Number.isSafeInteger(expires_in) ||
        expires_in < 0 ||
        expires_in > 2_147_483_647)) ||
    (scope !== undefined && (typeof scope !== 'string' || !validScope(scope)))
  )
    throw new McpOAuthError('invalid_response');
  return {
    accessToken: access_token,
    refreshToken: refresh_token ?? null,
    expiresIn: expires_in ?? null,
    scope: scope ?? null,
  };
}
