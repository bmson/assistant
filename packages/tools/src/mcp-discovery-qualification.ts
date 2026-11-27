import { isIP } from 'node:net';
import { providerTransaction, withProviderSignal } from './bounded-provider-response.js';
import { permitsLegacyDiscoveryProbe } from './mcp-discovery-probe.js';
import { pinnedAgent, pinnedRequest, resolveMcpEndpoint } from './mcp-http.js';
import { validateMcpToolHeaderSchema } from './mcp-tool-header-schema.js';
import { readMcpRpcResponse } from './mcp-transport.js';

const VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const MAX_BYTES = 300_000;
const MAX_TOOLS = 80;
const MAX_LIST_PAGES = 8;

export interface McpDiscoveryQualificationOptions {
  /** Explicit local qualification only. Never used by connection discovery or execution. */
  enabled: boolean;
  /** Probe-only conservative fallback; saved runtime connections are unaffected. */
  allowLegacyFallback?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface McpDiscoveryQualification {
  protocolVersion: typeof VERSION | typeof LEGACY_VERSION;
  /** Self-reported, unverified display metadata; never authorization authority. */
  serverInfo?: { name: string; version: string };
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  complete: true;
  /** Invalid modern header-annotated definitions excluded from the terminal listing. */
  excludedTools?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
class QualificationError extends Error {}
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new QualificationError(message);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
async function permitsEmptyNotification(response: Response, signal: AbortSignal): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return true;
  try {
    while (true) {
      const { done, value } = await withProviderSignal(reader.read(), signal);
      if (done) return true;
      if (value?.byteLength) return false;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/**
 * Opt-in, credential-free, loopback-only discovery qualification. This is not a
 * production MCP client or a protocol activation flag. It deliberately exposes
 * no arbitrary RPC method, authentication, or tool execution. Legacy discovery
 * is available only through a separately opted-in, conservatively classified probe. JSON or request-scoped SSE, bounded tools pagination, no retries; metadata remains untrusted.
 *
 * Binding: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
 * Discovery: https://modelcontextprotocol.io/specification/2026-07-28/server/discover
 */
export async function qualifyMcpDiscovery(
  endpoint: string,
  options: McpDiscoveryQualificationOptions,
): Promise<McpDiscoveryQualification> {
  requireValue(options.enabled === true, 'MCP discovery qualification must be explicitly enabled.');
  requireValue(process.env.NODE_ENV !== 'production', 'MCP discovery qualification is local only.');
  const timeoutMs = options.timeoutMs ?? 20_000;
  requireValue(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 20_000,
    'Invalid MCP discovery qualification deadline.',
  );
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid local MCP qualification endpoint.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  requireValue(
    url.protocol === 'http:' &&
      (host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'MCP discovery qualification requires a credential-free loopback HTTP endpoint.',
  );

  return providerTransaction<McpDiscoveryQualification>(
    options.signal,
    timeoutMs,
    'MCP discovery qualification',
    async (signal) => {
      const target = await resolveMcpEndpoint(url.href, { signal });
      const address = target.address;
      requireValue(
        address === '::1' || (isIP(address) === 4 && address.startsWith('127.')),
        'MCP qualification resolved outside loopback.',
      );
      const agent = pinnedAgent(target);
      const session = { endpoint: target.endpoint, agent };
      const fetcher = options.fetchImpl;
      let legacy = false;
      let sessionId: string | undefined;
      async function send(init: RequestInit) {
        signal.throwIfAborted();
        const pending = fetcher ? fetcher(target.endpoint, init) : pinnedRequest(session, init);
        void pending.then(
          (response) => {
            if (signal.aborted) void response.body?.cancel().catch(() => {});
          },
          () => {},
        );
        return withProviderSignal(pending, signal);
      }
      function request(
        method: string,
        id?: number,
        params: Record<string, unknown> = {},
      ): RequestInit {
        const headers: Record<string, string> = {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': legacy ? LEGACY_VERSION : VERSION,
        };
        if (legacy) {
          if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        } else headers['Mcp-Method'] = method;
        return {
          method: 'POST',
          headers,
          redirect: 'error',
          signal,
          body: JSON.stringify({
            jsonrpc: '2.0',
            ...(id === undefined ? {} : { id }),
            method,
            params: legacy
              ? params
              : {
                  ...params,
                  _meta: {
                    'io.modelcontextprotocol/protocolVersion': VERSION,
                    'io.modelcontextprotocol/clientInfo': {
                      name: 'assistant-qualification',
                      version: '1.0.0',
                    },
                    'io.modelcontextprotocol/clientCapabilities': {},
                  },
                },
          }),
        };
      }
      async function parse(response: Response, id: number) {
        requireValue(
          response.status === 200,
          'MCP qualification returned an unsuccessful HTTP status.',
        );
        const mediaType =
          response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
        requireValue(
          ['application/json', 'text/event-stream'].includes(mediaType),
          'MCP qualification requires JSON or request-scoped SSE responses.',
        );
        const headers = new Headers(response.headers);
        headers.set('content-type', mediaType);
        const reply = await readMcpRpcResponse(
          new Response(response.body, { status: response.status, headers }),
          id,
          signal,
          { maxBytes: MAX_BYTES },
        );
        requireValue(!Object.hasOwn(reply, 'error'), 'MCP qualification returned an RPC error.');
        requireValue(
          record(reply.result) &&
            (legacy
              ? reply.result.resultType === undefined || reply.result.resultType === 'complete'
              : reply.result.resultType === 'complete'),
          'MCP qualification requires a complete result.',
        );
        return reply.result;
      }
      async function rpc(
        method: 'server/discover' | 'initialize' | 'tools/list',
        id: number,
        params: Record<string, unknown> = {},
      ) {
        const response = await send(request(method, id, params));
        try {
          if (
            method === 'server/discover' &&
            options.allowLegacyFallback === true &&
            response.status === 400
          ) {
            requireValue(
              await permitsLegacyDiscoveryProbe(response, id, signal),
              'MCP qualification probe does not permit legacy fallback.',
            );
            legacy = true;
            return null;
          }
          if (method === 'initialize' && response.status === 200) {
            const candidate = response.headers.get('mcp-session-id');
            requireValue(
              candidate === null || (candidate.length <= 4_096 && /^[\x21-\x7e]+$/.test(candidate)),
              'MCP qualification session identity is invalid.',
            );
            sessionId = candidate ?? undefined;
          }
          return await parse(response, id);
        } finally {
          if (!response.body?.locked) void response.body?.cancel().catch(() => {});
        }
      }
      try {
        const probe = await rpc('server/discover', 1);
        let info: unknown;
        if (legacy) {
          const discovery = await rpc('initialize', 2, {
            protocolVersion: LEGACY_VERSION,
            capabilities: {},
            clientInfo: { name: 'assistant-qualification', version: '1.0.0' },
          });
          requireValue(
            discovery && discovery.protocolVersion === LEGACY_VERSION,
            'MCP qualification legacy protocol version is incompatible.',
          );
          requireValue(
            record(discovery.capabilities) && record(discovery.capabilities.tools),
            'MCP qualification server does not advertise tools.',
          );
          info = discovery.serverInfo;
          requireValue(record(info), 'MCP qualification server identity is malformed.');
          const initialized = await send(request('notifications/initialized'));
          try {
            requireValue(
              initialized.status === 202,
              'MCP qualification initialized notification was not accepted.',
            );
            requireValue(
              await permitsEmptyNotification(initialized, signal),
              'MCP qualification initialized notification returned a body.',
            );
          } finally {
            if (!initialized.body?.locked) void initialized.body?.cancel().catch(() => {});
          }
        } else {
          requireValue(probe, 'MCP qualification discovery result is missing.');
          requireValue(
            Array.isArray(probe.supportedVersions) &&
              probe.supportedVersions.every((version) => text(version, 32)) &&
              probe.supportedVersions.includes(VERSION),
            'MCP qualification server does not advertise the requested protocol version.',
          );
          requireValue(
            record(probe.capabilities) && record(probe.capabilities.tools),
            'MCP qualification server does not advertise tools.',
          );
          info = record(probe._meta)
            ? probe._meta['io.modelcontextprotocol/serverInfo']
            : undefined;
        }
        let serverInfo: McpDiscoveryQualification['serverInfo'];
        if (info !== undefined) {
          requireValue(
            record(info) &&
              text(info.name, 160) &&
              typeof info.version === 'string' &&
              info.version.length <= 80,
            'MCP qualification server identity is malformed.',
          );
          serverInfo = { name: info.name, version: info.version };
        }
        let receivedTools = 0;
        let excludedTools = 0;
        const names = new Set<string>();
        const cursors = new Set<string>();
        const tools: McpDiscoveryQualification['tools'] = [];
        let cursor: string | undefined;
        for (let page = 1; ; page++) {
          const listing = await rpc(
            'tools/list',
            page + (legacy ? 2 : 1),
            cursor === undefined ? {} : { cursor },
          );
          requireValue(listing, 'MCP qualification tool listing is missing.');
          requireValue(
            Array.isArray(listing.tools) && receivedTools + listing.tools.length <= MAX_TOOLS,
            'MCP qualification tool page is invalid or exceeds its bound.',
          );
          receivedTools += listing.tools.length;
          for (const tool of listing.tools) {
            requireValue(
              record(tool) &&
                text(tool.name, 128) &&
                tool.name.trim() === tool.name &&
                !names.has(tool.name),
              'MCP qualification tool identity is invalid or repeated.',
            );
            requireValue(
              record(tool.inputSchema),
              'MCP qualification tool input schema is invalid.',
            );
            // Modern header-schema validation is supplied by the independent
            // validator. Legacy metadata retains its existing discovery behavior.
            if (!legacy && !validateMcpToolHeaderSchema(tool.inputSchema)) {
              names.add(tool.name);
              excludedTools++;
              continue;
            }
            requireValue(
              tool.description === undefined ||
                (typeof tool.description === 'string' && tool.description.length <= 1_200),
              'MCP qualification tool description exceeds its bound.',
            );
            names.add(tool.name);
            tools.push({
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              inputSchema: tool.inputSchema,
            });
          }
          requireValue(
            listing.nextCursor === undefined || text(listing.nextCursor, 4_096),
            'MCP qualification pagination cursor is invalid.',
          );
          cursor = listing.nextCursor;
          if (cursor === undefined) break;
          requireValue(!cursors.has(cursor), 'MCP qualification pagination cursor repeated.');
          requireValue(page < MAX_LIST_PAGES, 'MCP qualification exceeded the tool page limit.');
          cursors.add(cursor);
        }
        return {
          protocolVersion: legacy ? LEGACY_VERSION : VERSION,
          ...(serverInfo === undefined ? {} : { serverInfo }),
          tools,
          complete: true,
          ...(excludedTools === 0 ? {} : { excludedTools }),
        };
      } finally {
        // Best-effort session termination shares the original deadline. Never
        // reinitialize, retry, or hold cleanup alive after abort.
        try {
          if (legacy && sessionId && !signal.aborted) {
            const response = await send({
              method: 'DELETE',
              headers: { 'MCP-Protocol-Version': LEGACY_VERSION, 'Mcp-Session-Id': sessionId },
              redirect: 'error',
              signal,
            });
            void response.body?.cancel().catch(() => {});
          }
        } catch {
          /* Session cleanup is best effort; HTTP 405 is permitted. */
        }
        agent.destroy();
      }
    },
  ).catch((error: unknown) => {
    if (error instanceof QualificationError) throw error;
    throw new QualificationError('MCP discovery qualification failed or was interrupted.');
  });
}
