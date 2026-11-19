import { lookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { isPublicIpAddress } from '@assistant/core/public-web';
import { withProviderSignal } from './bounded-provider-response.js';

export interface McpHttpSession {
  endpoint: URL;
  agent: HttpAgent | HttpsAgent;
}

export class McpEndpointError extends Error {
  constructor(
    readonly reason: 'invalid_url' | 'unsafe_address' | 'dns_unavailable',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Split by family on purpose. A single BlockList holding both families rejects
 * every public IPv4 address on the internet: `::ffff:0:0/96` is the IPv4-mapped
 * range, and Node matches a plain IPv4 address against it, so one IPv6 rule
 * silently blocked all of IPv4. Keeping the lists apart means an IPv4 check
 * never consults an IPv6 rule, while `::ffff:…` stays blocked for addresses
 * that really are IPv6 — which is the bypass that rule exists to close.
 */
const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
const publicIpv6Addresses = new BlockList();
publicIpv6Addresses.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, 'ipv6');
}

function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? blockedIpv4Addresses.check(address, 'ipv4')
    : family === 6
      ? blockedIpv6Addresses.check(address, 'ipv6') || !publicIpv6Addresses.check(address, 'ipv6')
      : true;
}

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? address.startsWith('127.') : family === 6 && address === '::1';
}

export interface ResolvedMcpEndpoint {
  endpoint: URL;
  address: string;
  family: 4 | 6;
}

/**
 * Only public HTTPS endpoints are usable in production. This prevents an MCP
 * URL from becoming an SSRF route into the database, metadata service, or a
 * private provider. A session pins one validated address into its keep-alive
 * agent so DNS cannot change between validation and the outbound request.
 */
export async function resolveMcpEndpoint(
  value: string,
  options: { publicHttpsOnly?: boolean; signal?: AbortSignal; lookup?: typeof lookup } = {},
): Promise<ResolvedMcpEndpoint> {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new McpEndpointError('invalid_url', 'Enter a valid MCP endpoint URL.');
  }

  const host = endpoint.hostname.replace(/^\[|\]$/g, '');
  const localDevelopment = !options.publicHttpsOnly && process.env.NODE_ENV !== 'production';
  const isHttp = endpoint.protocol === 'http:';
  const isHttps = endpoint.protocol === 'https:';
  const localHost = host === 'localhost' || isLoopbackAddress(host);
  if (
    (!isHttps && !(localDevelopment && isHttp && localHost)) ||
    endpoint.username ||
    endpoint.password ||
    (options.publicHttpsOnly && (endpoint.hash || endpoint.search))
  ) {
    throw new McpEndpointError(
      'invalid_url',
      'MCP endpoints must use public HTTPS (or localhost HTTP during local development).',
    );
  }

  options.signal?.throwIfAborted();
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await withProviderSignal(
          (options.lookup ?? lookup)(host, { all: true, verbatim: true }),
          options.signal,
        );
  } catch {
    throw new McpEndpointError(
      'dns_unavailable',
      'The MCP endpoint hostname could not be resolved.',
    );
  }
  options.signal?.throwIfAborted();
  if (resolved.length === 0)
    throw new McpEndpointError(
      'dns_unavailable',
      'The MCP endpoint hostname could not be resolved.',
    );
  if (localDevelopment && localHost) {
    if (resolved.some((record) => !isLoopbackAddress(record.address))) {
      throw new McpEndpointError(
        'unsafe_address',
        'Local MCP endpoints must resolve only to the loopback interface.',
      );
    }
  } else if (
    resolved.some(
      (record) =>
        isNonPublicAddress(record.address) ||
        (options.publicHttpsOnly && !isPublicIpAddress(record.address)),
    )
  ) {
    throw new McpEndpointError(
      'unsafe_address',
      'MCP endpoints cannot resolve to a private network address.',
    );
  }
  const selected = resolved[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new McpEndpointError(
      'unsafe_address',
      'The MCP endpoint hostname resolved to an unsupported address.',
    );
  }
  return { endpoint, address: selected.address, family: selected.family };
}

export async function checkedMcpEndpoint(value: string): Promise<URL> {
  return (await resolveMcpEndpoint(value)).endpoint;
}

function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    if (typeof options === 'object' && options && 'all' in options && options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  }) as LookupFunction;
}

export function pinnedAgent(target: ResolvedMcpEndpoint): HttpAgent | HttpsAgent {
  const options = {
    keepAlive: true,
    maxSockets: 1,
    lookup: pinnedLookup(target.address, target.family),
  };
  return target.endpoint.protocol === 'https:' ? new HttpsAgent(options) : new HttpAgent(options);
}

export function pinnedRequest(session: McpHttpSession, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = (session.endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(
      session.endpoint,
      {
        agent: session.agent,
        headers: init.headers as Record<string, string>,
        method: init.method,
        signal: init.signal ?? undefined,
      },
      (incoming) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        const status = incoming.statusCode ?? 500;
        const hasBody = ![101, 204, 205, 304].includes(status);
        resolve(
          new Response(hasBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null, {
            status,
            statusText: incoming.statusMessage,
            headers,
          }),
        );
      },
    );
    request.on('error', reject);
    if (typeof init.body === 'string' || init.body instanceof Uint8Array) request.write(init.body);
    request.end();
  });
}
