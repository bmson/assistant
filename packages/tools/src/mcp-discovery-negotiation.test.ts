import { createServer, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qualifyMcpDiscovery } from './mcp-discovery-qualification.js';

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';
const endpoint = 'http://127.0.0.1:3010/mcp';
const tool = (name: string) => ({ name, inputSchema: { type: 'object', properties: {} } });
const modern = {
  resultType: 'complete',
  supportedVersions: [MODERN],
  capabilities: { tools: {} },
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Modern fixture', version: '1' } },
};
const legacy = {
  protocolVersion: LEGACY,
  capabilities: { tools: {} },
  serverInfo: { name: 'Legacy fixture', version: '1' },
};
const rpc = (id: number, result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
const requests = (f: ReturnType<typeof vi.fn<typeof fetch>>) =>
  f.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
afterEach(() => vi.unstubAllEnvs());

describe('explicit dual-era MCP discovery qualification', () => {
  it('selects modern discovery without attempting any legacy handshake', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rpc(1, modern))
      .mockResolvedValueOnce(rpc(2, { resultType: 'complete', tools: [tool('get_modern')] }));
    await expect(
      qualifyMcpDiscovery(endpoint, { enabled: true, allowLegacyFallback: true, fetchImpl }),
    ).resolves.toMatchObject({
      protocolVersion: MODERN,
      complete: true,
      tools: [tool('get_modern')],
    });
    expect(requests(fetchImpl).map((r) => r.method)).toEqual(['server/discover', 'tools/list']);
  });

  it('does not interpret legacy eligibility as permission without explicit opt-in', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(qualifyMcpDiscovery(endpoint, { enabled: true, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 500, 503])(
    'does not fall back, authenticate or retry after HTTP %s',
    async (status) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status }));
      await expect(
        qualifyMcpDiscovery(endpoint, { enabled: true, allowLegacyFallback: true, fetchImpl }),
      ).rejects.toThrow();
      expect(requests(fetchImpl).map((r) => r.method)).toEqual(['server/discover']);
    },
  );

  it.each([
    [
      'recognized RPC rejection',
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32601, message: 'synthetic private error' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    ],
    [
      'malformed successful JSON',
      new Response('{invalid', { headers: { 'content-type': 'application/json' } }),
    ],
    ['mismatched modern response', rpc(9, modern)],
    ['unsupported modern revision', rpc(1, { ...modern, supportedVersions: ['1900-01-01'] })],
    ['invalid modern capability', rpc(1, { ...modern, capabilities: {} })],
  ])('never masks %s by switching protocol eras', async (_label, response) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    await expect(
      qualifyMcpDiscovery(endpoint, { enabled: true, allowLegacyFallback: true, fetchImpl }),
    ).rejects.toThrow();
    expect(requests(fetchImpl).map((r) => r.method)).toEqual(['server/discover']);
  });

  it.each([
    ['empty rejection', new Response(null, { status: 400 })],
    [
      'initialization required',
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: 'Server not initialized' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    ],
  ])('permits only opted-in positive legacy evidence: %s', async (_label, response) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(rpc(2, legacy))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(rpc(3, { tools: [tool('get_legacy')] }));
    await expect(
      qualifyMcpDiscovery(endpoint, { enabled: true, allowLegacyFallback: true, fetchImpl }),
    ).resolves.toMatchObject({
      protocolVersion: LEGACY,
      complete: true,
      tools: [tool('get_legacy')],
    });
    expect(requests(fetchImpl).map((r) => r.method)).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
  });

  it.each([
    [
      'HTML400',
      new Response('<html>not evidence</html>', {
        status: 400,
        headers: { 'content-type': 'text/html' },
      }),
    ],
    [
      'malformed400',
      new Response('{broken', { status: 400, headers: { 'content-type': 'application/json' } }),
    ],
    [
      'wrongID400',
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          error: { code: -32000, message: 'Server not initialized' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    ],
    ['bare404', new Response(null, { status: 404 })],
  ])('never treats %s as legacy evidence', async (_label, response) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    await expect(
      qualifyMcpDiscovery(endpoint, { enabled: true, allowLegacyFallback: true, fetchImpl }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not fall back after modern discovery succeeded but listing failed', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rpc(1, modern))
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(
      qualifyMcpDiscovery(endpoint, { enabled: true, allowLegacyFallback: true, fetchImpl }),
    ).rejects.toThrow();
    expect(requests(fetchImpl).map((r) => r.method)).toEqual(['server/discover', 'tools/list']);
  });

  it('does not fall back after a discovery timeout or ignored abort', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    await expect(
      qualifyMcpDiscovery(endpoint, {
        enabled: true,
        allowLegacyFallback: true,
        fetchImpl,
        timeoutMs: 20,
      }),
    ).rejects.toThrow();
    expect(requests(fetchImpl).map((r) => r.method)).toEqual(['server/discover']);
  });

  it.each([
    ['wrong returned version', { ...legacy, protocolVersion: MODERN }],
    ['missing tools capability', { ...legacy, capabilities: {} }],
  ])('rejects legacy %s before initialization notification or listing', async (_label, result) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(rpc(2, result));
    await expect(
      qualifyMcpDiscovery(endpoint, { enabled: true, allowLegacyFallback: true, fetchImpl }),
    ).rejects.toThrow();
    expect(requests(fetchImpl).map((r) => r.method)).toEqual(['server/discover', 'initialize']);
  });

  it('does not retry or restart a failed legacy list', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(rpc(2, legacy))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockRejectedValueOnce(new Error('synthetic lost list response'));
    await expect(
      qualifyMcpDiscovery(endpoint, { enabled: true, allowLegacyFallback: true, fetchImpl }),
    ).rejects.toThrow();
    expect(requests(fetchImpl).map((r) => r.method)).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
  });

  it('does not switch again or retry when a legacy continuation requires authorization', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(rpc(2, legacy))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(rpc(3, { tools: [tool('first')], nextCursor: 'next' }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(
      qualifyMcpDiscovery(endpoint, { enabled: true, allowLegacyFallback: true, fetchImpl }),
    ).rejects.toThrow();
    expect(requests(fetchImpl).map((r) => r.method)).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/list',
    ]);
    expect(requests(fetchImpl).map((r) => r.id)).toEqual([1, 2, undefined, 3, 4]);
  });

  it('rejects legacy cursor cycles rather than returning a partial successful list', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(rpc(2, legacy))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(rpc(3, { tools: [tool('first')], nextCursor: 'same' }))
      .mockResolvedValueOnce(rpc(4, { tools: [tool('second')], nextCursor: 'same' }));
    await expect(
      qualifyMcpDiscovery(endpoint, { enabled: true, allowLegacyFallback: true, fetchImpl }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('attempts session cleanup once and preserves successful discovery after cleanup transport failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(
        Response.json(
          { jsonrpc: '2.0', id: 2, result: legacy },
          { headers: { 'mcp-session-id': 'fixture-session' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(rpc(3, { tools: [tool('first')] }))
      .mockRejectedValueOnce(new Error('synthetic cleanup failure'));
    await expect(
      qualifyMcpDiscovery(endpoint, { enabled: true, allowLegacyFallback: true, fetchImpl }),
    ).resolves.toMatchObject({ protocolVersion: LEGACY, complete: true });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const cleanup = fetchImpl.mock.calls[4]?.[1];
    expect(cleanup?.method).toBe('DELETE');
    expect(cleanup?.body).toBeUndefined();
    expect(new Headers(cleanup?.headers).get('mcp-session-id')).toBe('fixture-session');
  });

  it('shares one deadline through the probe and legacy handshake', async () => {
    let count = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve(++count === 1 ? new Response(null, { status: 400 }) : rpc(2, legacy)),
              40,
            ),
          ),
      );
    await expect(
      qualifyMcpDiscovery(endpoint, {
        enabled: true,
        allowLegacyFallback: true,
        fetchImpl,
        timeoutMs: 60,
      }),
    ).rejects.toThrow();
    expect(requests(fetchImpl).map((r) => r.method)).toEqual(['server/discover', 'initialize']);
    expect(new Set(fetchImpl.mock.calls.map(([, init]) => init?.signal)).size).toBe(1);
  });
});

type RequestRecord = {
  method: string;
  id?: number;
  params: Record<string, unknown>;
  headers: IncomingHttpHeaders;
};
describe('real loopback dual-era negotiation and cleanup', () => {
  it.each(['modern', 'legacy'] as const)(
    'qualifies paginated %s wire responses with no actions or stale sessions',
    async (era) => {
      const seen: RequestRecord[] = [];
      let sockets = 0;
      let streamsClosed = 0;
      const cursor = 'opaque /+== ? cursor';
      const session = 'local-legacy-session';
      const server = createServer((req, res) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          if (req.method === 'DELETE') {
            seen.push({ method: 'DELETE', params: {}, headers: req.headers });
            res.writeHead(405);
            res.end();
            return;
          }
          const body = JSON.parse(raw);
          seen.push({ ...body, headers: req.headers });
          if (era === 'legacy' && body.method === 'server/discover') {
            res.writeHead(400);
            res.end();
            return;
          }
          if (body.method === 'notifications/initialized') {
            res.writeHead(202);
            res.end();
            return;
          }
          let result: unknown;
          if (body.method === 'server/discover') result = modern;
          else if (body.method === 'initialize') result = legacy;
          else if (body.method === 'tools/list')
            result = {
              ...(era === 'modern' ? { resultType: 'complete' } : {}),
              tools: [tool(body.params.cursor === cursor ? 'get_second' : 'get_first')],
              ...(body.params.cursor === cursor ? {} : { nextCursor: cursor }),
            };
          else {
            res.writeHead(500);
            res.end('Unexpected method');
            return;
          }
          const sse = body.method === 'tools/list' && body.params.cursor === cursor;
          res.writeHead(200, {
            'content-type': sse ? 'text/event-stream' : 'application/json',
            'mcp-session-id': body.method === 'initialize' ? session : 'must-not-replace-session',
          });
          if (!sse) res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
          else {
            res.on('close', () => {
              streamsClosed++;
            });
            res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
            res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`);
          }
        });
      });
      server.on('connection', (socket) => {
        sockets++;
        socket.on('close', () => {
          sockets--;
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
        const result = await qualifyMcpDiscovery(`http://127.0.0.1:${address.port}/mcp`, {
          enabled: true,
          allowLegacyFallback: true,
          timeoutMs: 1000,
        });
        expect(result).toMatchObject({
          protocolVersion: era === 'modern' ? MODERN : LEGACY,
          complete: true,
          tools: [tool('get_first'), tool('get_second')],
        });
        expect(seen.map((r) => r.method)).toEqual(
          era === 'modern'
            ? ['server/discover', 'tools/list', 'tools/list']
            : [
                'server/discover',
                'initialize',
                'notifications/initialized',
                'tools/list',
                'tools/list',
                'DELETE',
              ],
        );
        expect(seen.map((r) => r.id)).toEqual(
          era === 'modern' ? [1, 2, 3] : [1, 2, undefined, 3, 4, undefined],
        );
        const lists = seen.filter((r) => r.method === 'tools/list');
        expect(lists[0]?.params.cursor).toBeUndefined();
        expect(lists[1]?.params.cursor).toBe(cursor);
        expect(seen.every((r) => r.headers.authorization === undefined)).toBe(true);
        if (era === 'legacy') {
          const init = seen[1];
          if (!init) throw new Error('Missing initialization fixture request');
          expect(init.params).toEqual({
            protocolVersion: LEGACY,
            capabilities: {},
            clientInfo: { name: 'assistant-qualification', version: '1.0.0' },
          });
          expect(init.headers['mcp-session-id']).toBeUndefined();
          for (const r of seen.slice(2)) {
            expect(r.headers['mcp-session-id']).toBe(session);
            expect(r.headers['mcp-protocol-version']).toBe(LEGACY);
          }
        } else expect(seen.every((r) => r.headers['mcp-session-id'] === undefined)).toBe(true);
        await vi.waitFor(() => {
          expect(sockets).toBe(0);
          expect(streamsClosed).toBe(1);
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
      }
    },
  );
});
