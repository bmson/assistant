import { isIP } from 'node:net';
import { providerTransaction, withProviderSignal } from './bounded-provider-response.js';
import { pinnedAgent, pinnedRequest, resolveMcpEndpoint } from './mcp-http.js';
import { readMcpRpcResponse } from './mcp-transport.js';

const VERSION = '2026-07-28';
const MAX_BYTES = 300_000;
const MAX_TOOLS = 80;
const MAX_LIST_PAGES = 8;

export interface McpDiscoveryQualificationOptions {
  /** Explicit local qualification only. Never used by connection discovery or execution. */
  enabled: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface McpDiscoveryQualification {
  protocolVersion: typeof VERSION;
  /** Self-reported, unverified display metadata; never authorization authority. */
  serverInfo?: { name: string; version: string };
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  complete: true;
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
function hasHeaderAnnotation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasHeaderAnnotation);
  if (!record(value)) return false;
  return Object.hasOwn(value, 'x-mcp-header') || Object.values(value).some(hasHeaderAnnotation);
}

/**
 * Opt-in, credential-free, loopback-only discovery qualification. This is not a
 * production MCP client or a protocol activation flag. It deliberately exposes
 * no arbitrary RPC method, handshake fallback, session, authentication, or tool
 * execution. JSON or request-scoped SSE, bounded tools pagination, no retries; metadata remains untrusted.
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
      async function rpc(method: 'server/discover' | 'tools/list', id: number, cursor?: string) {
        signal.throwIfAborted();
        const init: RequestInit = {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'MCP-Protocol-Version': VERSION,
            'Mcp-Method': method,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            params: {
              ...(cursor === undefined ? {} : { cursor }),
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
          redirect: 'error',
          signal,
        };
        const pending = fetcher ? fetcher(target.endpoint, init) : pinnedRequest(session, init);
        // Even a fixture fetch that ignores abort must not keep qualification alive.
        void pending.then(
          (response) => {
            if (signal.aborted) void response.body?.cancel().catch(() => {});
          },
          () => {},
        );
        const response = await withProviderSignal(pending, signal);
        try {
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
          // MIME types are case-insensitive; normalize without changing the legacy parser.
          const headers = new Headers(response.headers);
          headers.set('content-type', mediaType);
          const normalized = new Response(response.body, { status: response.status, headers });
          const reply = await readMcpRpcResponse(normalized, id, signal, { maxBytes: MAX_BYTES });
          requireValue(!Object.hasOwn(reply, 'error'), 'MCP qualification returned an RPC error.');
          requireValue(
            record(reply.result) && reply.result.resultType === 'complete',
            'MCP qualification requires a complete result.',
          );
          return reply.result;
        } finally {
          // Also close rejected HTTP/content-type bodies, which never reach the reader.
          if (!response.body?.locked) void response.body?.cancel().catch(() => {});
        }
      }
      try {
        const discovery = await rpc('server/discover', 1);
        requireValue(
          Array.isArray(discovery.supportedVersions) &&
            discovery.supportedVersions.every((version) => text(version, 32)) &&
            discovery.supportedVersions.includes(VERSION),
          'MCP qualification server does not advertise the requested protocol version.',
        );
        requireValue(
          record(discovery.capabilities) && record(discovery.capabilities.tools),
          'MCP qualification server does not advertise tools.',
        );
        const meta = discovery._meta;
        const info = record(meta) ? meta['io.modelcontextprotocol/serverInfo'] : undefined;
        let serverInfo: McpDiscoveryQualification['serverInfo'];
        if (info !== undefined) {
          requireValue(
            record(info) && text(info.name, 160) && text(info.version, 80),
            'MCP qualification server identity is malformed.',
          );
          serverInfo = { name: info.name, version: info.version };
        }
        const names = new Set<string>();
        const cursors = new Set<string>();
        const tools: McpDiscoveryQualification['tools'] = [];
        let cursor: string | undefined;
        for (let page = 1; ; page++) {
          const listing = await rpc('tools/list', page + 1, cursor);
          requireValue(
            Array.isArray(listing.tools) && tools.length + listing.tools.length <= MAX_TOOLS,
            'MCP qualification tool page is invalid or exceeds its bound.',
          );
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
            // Header schema validation and execution are outside this JSON discovery slice.
            requireValue(
              !hasHeaderAnnotation(tool.inputSchema),
              'MCP qualification does not support annotated tool headers.',
            );
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
          protocolVersion: VERSION,
          ...(serverInfo === undefined ? {} : { serverInfo }),
          tools,
          complete: true,
        };
      } finally {
        agent.destroy();
      }
    },
  ).catch((error: unknown) => {
    if (error instanceof QualificationError) throw error;
    throw new QualificationError('MCP discovery qualification failed or was interrupted.');
  });
}
