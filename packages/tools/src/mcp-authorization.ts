import type { lookup } from 'node:dns/promises';
import {
  ProviderDeadlineError,
  providerTransaction,
  withProviderSignal,
} from './bounded-provider-response.js';
import {
  McpEndpointError,
  pinnedAgent,
  pinnedRequest,
  type ResolvedMcpEndpoint,
  resolveMcpEndpoint,
} from './mcp-http.js';

export const MCP_AUTHORIZATION_LIMITS = Object.freeze({
  timeoutMs: 20_000,
  maxRequests: 12,
  maxResponseBytes: 65_536,
  maxTotalBytes: 262_144,
  maxAuthorizationServers: 3,
  maxUrlLength: 2048,
  maxChallengeLength: 8192,
});
export type McpAuthorizationStatus = 'supported' | 'unsupported' | 'discovery_failed';
export type McpAuthorizationReason =
  | 'connection_disabled'
  | 'unsafe_endpoint'
  | 'invalid_challenge'
  | 'no_resource_metadata'
  | 'resource_mismatch'
  | 'invalid_resource_metadata'
  | 'issuer_mismatch'
  | 'invalid_server_metadata'
  | 'pkce_s256_required'
  | 'authorization_code_required'
  | 'metadata_unavailable'
  | 'redirect_not_allowed'
  | 'response_limit'
  | 'request_limit'
  | 'deadline'
  | 'request_failed';
export interface McpAuthorizationServerDiagnostic {
  issuer: string;
  pkceS256: true;
  authorizationResponseIssuerRequired: boolean;
  registration: {
    preRegistration: 'not_checked';
    clientIdMetadataDocument: boolean;
    dynamicClientRegistration: boolean;
  };
}
/** `supported` describes discovery metadata only, never a usable connection or grant. */
export interface McpAuthorizationDiagnostic {
  status: McpAuthorizationStatus;
  authenticated: false;
  oauthConnectionSupported: false;
  transportProtocolVersion: '2025-11-25';
  resource: string | null;
  authorizationServers: McpAuthorizationServerDiagnostic[];
  reason: McpAuthorizationReason | null;
}
export interface McpAuthorizationIo {
  lookup: typeof lookup;
  /** Receives an already validated and DNS-pinned target; no ambient credentials. */
  request(
    target: ResolvedMcpEndpoint,
    init: RequestInit,
  ): Promise<{ response: Response; close(): void }>;
}
class DiagnosticError extends Error {
  constructor(
    readonly status: Exclude<McpAuthorizationStatus, 'supported'>,
    readonly reason: McpAuthorizationReason,
  ) {
    super(reason);
  }
}
function unsupported(reason: McpAuthorizationReason): never {
  throw new DiagnosticError('unsupported', reason);
}
function failed(reason: McpAuthorizationReason): never {
  throw new DiagnosticError('discovery_failed', reason);
}
export function unavailableMcpAuthorization(
  reason: McpAuthorizationReason,
): McpAuthorizationDiagnostic {
  return {
    status: 'unsupported',
    authenticated: false,
    oauthConnectionSupported: false,
    transportProtocolVersion: '2025-11-25',
    resource: null,
    authorizationServers: [],
    reason,
  };
}

/** Tokenize challenge commas without splitting quoted strings or their escapes. */
export function mcpResourceMetadataChallenge(header: string | null): string | null {
  if (!header) return null;
  if (
    header.length > MCP_AUTHORIZATION_LIMITS.maxChallengeLength ||
    [...header].some((c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127)
  )
    unsupported('invalid_challenge');
  const parts: string[] = [];
  let start = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && c === '\\') {
      escaped = true;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === ',' && !quoted) {
      parts.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quoted || escaped) unsupported('invalid_challenge');
  parts.push(header.slice(start).trim());
  let bearer = false;
  const resources: string[] = [];
  let seen = new Set<string>();
  for (let part of parts) {
    // Auth-params allow optional whitespace before '='. Detect them before
    // interpreting token + whitespace as the start of another auth scheme.
    const parameterContinuation = /^[!#$%&'*+.^_`|~\w-]+\s*=/.test(part);
    const challenge = parameterContinuation
      ? null
      : /^([!#$%&'*+.^_`|~\w-]+)(?:\s+(.+))?$/.exec(part);
    if (challenge) {
      bearer = challenge[1]?.toLowerCase() === 'bearer';
      seen = new Set();
      part = challenge[2] ?? '';
    }
    if (!bearer || !part) continue;
    const param =
      /^([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`|~\w-]+))$/.exec(part);
    if (!param) unsupported('invalid_challenge');
    const key = param[1]?.toLowerCase() ?? '';
    if (seen.has(key)) unsupported('invalid_challenge');
    seen.add(key);
    if (key === 'resource_metadata')
      resources.push((param[2] ?? param[3] ?? '').replace(/\\(.)/g, '$1'));
  }
  if (resources.length > 1 || resources.some((x) => !x)) unsupported('invalid_challenge');
  return resources[0] ?? null;
}
function safeUrl(value: unknown): URL {
  if (
    typeof value !== 'string' ||
    value.length > MCP_AUTHORIZATION_LIMITS.maxUrlLength ||
    !value ||
    [...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) >= 127)
  )
    unsupported('unsafe_endpoint');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    unsupported('unsafe_endpoint');
  }
  // Query-bearing resource/metadata URLs are deliberately unsupported by this
  // diagnostic-only slice: they may carry manual API keys. Never transmit them.
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    unsupported('unsafe_endpoint');
  return url;
}
function resourceMetadataUrls(endpoint: URL): string[] {
  return [
    ...new Set([
      `${endpoint.origin}/.well-known/oauth-protected-resource${endpoint.pathname === '/' ? '' : endpoint.pathname}`,
      `${endpoint.origin}/.well-known/oauth-protected-resource`,
    ]),
  ];
}
function serverMetadataUrls(issuer: string): string[] {
  const url = safeUrl(issuer);
  const path = url.pathname === '/' ? '' : url.pathname;
  return [
    ...new Set([
      `${url.origin}/.well-known/oauth-authorization-server${path}`,
      `${url.origin}/.well-known/openid-configuration${path}`,
      ...(path ? [`${url.origin}${path.replace(/\/$/, '')}/.well-known/openid-configuration`] : []),
    ]),
  ];
}
function object(value: unknown, reason: McpAuthorizationReason): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unsupported(reason);
  return value as Record<string, unknown>;
}
async function defaultRequest(target: ResolvedMcpEndpoint, init: RequestInit) {
  const agent = pinnedAgent(target);
  try {
    const response = await pinnedRequest({ endpoint: target.endpoint, agent }, init);
    return {
      response,
      close() {
        void response.body?.cancel().catch(() => {});
        agent.destroy();
      },
    };
  } catch (error) {
    agent.destroy();
    throw error;
  }
}

/** Transient, unauthenticated GETs only. Does not initialize MCP or mutate saved state. */
export async function inspectMcpAuthorization(
  endpointValue: string,
  options: { signal?: AbortSignal; io?: McpAuthorizationIo } = {},
): Promise<McpAuthorizationDiagnostic> {
  let resource: string | null = null;
  const empty = unavailableMcpAuthorization('request_failed');
  try {
    const endpoint = safeUrl(endpointValue);
    // MCP canonical root identifier has no trailing slash. Once constructed,
    // returned resource metadata must match this string exactly.
    resource = endpoint.pathname === '/' ? endpoint.origin : endpoint.href;
    return await providerTransaction<McpAuthorizationDiagnostic>(
      options.signal,
      MCP_AUTHORIZATION_LIMITS.timeoutMs,
      'MCP authorization discovery',
      async (signal) => {
        let requests = 0,
          totalBytes = 0;
        const resolve = async (value: string) => {
          safeUrl(value);
          try {
            return await resolveMcpEndpoint(value, {
              publicHttpsOnly: true,
              signal,
              lookup: options.io?.lookup,
            });
          } catch (error) {
            if (signal.aborted) failed('deadline');
            if (error instanceof McpEndpointError && error.reason === 'dns_unavailable')
              failed('request_failed');
            unsupported('unsafe_endpoint');
          }
        };
        const request = async (
          value: string,
          headersOnly = false,
        ): Promise<{ status: number; challenge: string | null; data?: unknown }> => {
          if (++requests > MCP_AUTHORIZATION_LIMITS.maxRequests) failed('request_limit');
          const target = await resolve(value);
          const operation = (options.io?.request ?? defaultRequest)(target, {
            method: 'GET',
            headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
            redirect: 'error',
            signal,
          });
          operation.then(
            (opened) => {
              if (signal.aborted) opened.close();
            },
            () => {},
          );
          const opened = await withProviderSignal(operation, signal);
          const close = () => opened.close();
          signal.addEventListener('abort', close, { once: true });
          try {
            const response = opened.response;
            if (response.status >= 300 && response.status < 400) failed('redirect_not_allowed');
            if (headersOnly)
              return {
                status: response.status,
                challenge:
                  response.status === 401 ? response.headers.get('www-authenticate') : null,
              };
            if (response.status === 404 || response.status === 410)
              return { status: response.status, challenge: null };
            if (!response.ok) failed('metadata_unavailable');
            const encoding = response.headers.get('content-encoding');
            if (encoding && encoding.toLowerCase() !== 'identity') failed('response_limit');
            const length = response.headers.get('content-length');
            if (
              length &&
              (!/^\d+$/.test(length) ||
                Number(length) > MCP_AUTHORIZATION_LIMITS.maxResponseBytes ||
                Number(length) + totalBytes > MCP_AUTHORIZATION_LIMITS.maxTotalBytes)
            )
              failed('response_limit');
            if (
              !/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|$)/i.test(
                response.headers.get('content-type') ?? '',
              )
            )
              unsupported('invalid_server_metadata');
            const reader = response.body?.getReader();
            if (!reader) unsupported('invalid_server_metadata');
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
              while (true) {
                const item = await withProviderSignal(reader.read(), signal);
                if (item.done) break;
                size += item.value.byteLength;
                totalBytes += item.value.byteLength;
                if (
                  size > MCP_AUTHORIZATION_LIMITS.maxResponseBytes ||
                  totalBytes > MCP_AUTHORIZATION_LIMITS.maxTotalBytes
                )
                  failed('response_limit');
                chunks.push(item.value);
              }
              const bytes = Buffer.concat(chunks);
              let data: unknown;
              try {
                data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
              } catch {
                unsupported('invalid_server_metadata');
              }
              return { status: response.status, challenge: null, data };
            } finally {
              void reader.cancel().catch(() => {});
            }
          } finally {
            signal.removeEventListener('abort', close);
            opened.close();
          }
        };
        // Probe headers only, without bearer/session/cookie headers or MCP RPCs.
        const probe = await request(endpoint.href, true);
        const challenge = mcpResourceMetadataChallenge(probe.challenge);
        let metadata: Record<string, unknown> | null = null;
        for (const url of challenge ? [challenge] : resourceMetadataUrls(endpoint)) {
          const response = await request(url);
          if (response.status === 404 || response.status === 410) continue;
          metadata = object(response.data, 'invalid_resource_metadata');
          break;
        }
        if (!metadata) {
          if (probe.status === 408 || probe.status === 429 || probe.status >= 500)
            failed('request_failed');
          unsupported('no_resource_metadata');
        }
        if (metadata.resource !== resource) unsupported('resource_mismatch');
        const servers = metadata.authorization_servers;
        if (
          !Array.isArray(servers) ||
          !servers.length ||
          servers.length > MCP_AUTHORIZATION_LIMITS.maxAuthorizationServers ||
          servers.some((x) => typeof x !== 'string') ||
          new Set(servers).size !== servers.length
        )
          unsupported('invalid_resource_metadata');
        const authorizationServers: McpAuthorizationServerDiagnostic[] = [];
        for (const issuer of servers as string[]) {
          safeUrl(issuer);
          let server: Record<string, unknown> | null = null;
          for (const url of serverMetadataUrls(issuer)) {
            const response = await request(url);
            if (response.status === 404 || response.status === 410) continue;
            server = object(response.data, 'invalid_server_metadata');
            break;
          }
          if (!server) failed('metadata_unavailable');
          if (server.issuer !== issuer) unsupported('issuer_mismatch');
          if (
            !Array.isArray(server.code_challenge_methods_supported) ||
            !server.code_challenge_methods_supported.includes('S256')
          )
            unsupported('pkce_s256_required');
          if (
            !Array.isArray(server.response_types_supported) ||
            !server.response_types_supported.includes('code') ||
            (server.grant_types_supported !== undefined &&
              (!Array.isArray(server.grant_types_supported) ||
                !server.grant_types_supported.includes('authorization_code')))
          )
            unsupported('authorization_code_required');
          for (const key of ['authorization_endpoint', 'token_endpoint']) {
            if (typeof server[key] !== 'string') unsupported('invalid_server_metadata');
            await resolve(server[key] as string);
          }
          if (server.registration_endpoint !== undefined) {
            if (typeof server.registration_endpoint !== 'string')
              unsupported('invalid_server_metadata');
            await resolve(server.registration_endpoint);
          }
          if (
            server.client_id_metadata_document_supported !== undefined &&
            typeof server.client_id_metadata_document_supported !== 'boolean'
          )
            unsupported('invalid_server_metadata');
          if (
            server.authorization_response_iss_parameter_supported !== undefined &&
            typeof server.authorization_response_iss_parameter_supported !== 'boolean'
          )
            unsupported('invalid_server_metadata');
          authorizationServers.push({
            issuer,
            pkceS256: true,
            authorizationResponseIssuerRequired:
              server.authorization_response_iss_parameter_supported === true,
            registration: {
              preRegistration: 'not_checked',
              clientIdMetadataDocument: server.client_id_metadata_document_supported === true,
              dynamicClientRegistration: typeof server.registration_endpoint === 'string',
            },
          });
        }
        return { ...empty, status: 'supported', resource, authorizationServers, reason: null };
      },
    );
  } catch (error) {
    if (error instanceof DiagnosticError)
      return { ...empty, status: error.status, resource, reason: error.reason };
    return {
      ...empty,
      status: 'discovery_failed',
      resource,
      reason:
        options.signal?.aborted || error instanceof ProviderDeadlineError
          ? 'deadline'
          : 'request_failed',
    };
  }
}
