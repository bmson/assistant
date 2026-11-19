import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qualifyMcpDiscovery } from './mcp-discovery-qualification.js';

const ENDPOINT = 'http://127.0.0.1:3010/mcp';
const VERSION = '2026-07-28';
const tool = {
  name: 'projects.get',
  description: 'Read one synthetic project.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};
const discovery = (patch: Record<string, unknown> = {}) => ({
  resultType: 'complete',
  supportedVersions: [VERSION],
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Synthetic tools', version: '1.0.0' } },
  capabilities: { tools: {} },
  ...patch,
});
const rpc = (id: number | string, result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
function fixture(
  first = discovery(),
  second: Record<string, unknown> = { resultType: 'complete', tools: [tool] },
) {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(rpc(1, first))
    .mockResolvedValueOnce(rpc(2, second));
  return {
    fetchImpl,
    run: (options: Record<string, unknown> = {}) =>
      qualifyMcpDiscovery(ENDPOINT, { enabled: true, fetchImpl, ...options }),
  };
}
const bodies = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) =>
  fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
afterEach(() => vi.unstubAllEnvs());

describe('explicit local MCP 2026-07-28 discovery qualification', () => {
  it('uses only server/discover and tools/list with revision metadata, without acting on a tool', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({
      protocolVersion: VERSION,
      serverInfo: { name: 'Synthetic tools', version: '1.0.0' },
      tools: [tool],
      complete: true,
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies(f.fetchImpl).map((b) => b.method)).toEqual(['server/discover', 'tools/list']);
    for (const [url, init] of f.fetchImpl.mock.calls) {
      expect(String(url)).toBe(ENDPOINT);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      const headers = new Headers(init?.headers);
      expect(headers.get('accept')).toContain('application/json');
      expect(headers.get('accept')).toContain('text/event-stream');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('mcp-protocol-version')).toBe(VERSION);
      expect(headers.get('mcp-method')).toBe(JSON.parse(String(init?.body)).method);
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('mcp-session-id')).toBe(false);
    }
    for (const body of bodies(f.fetchImpl)) {
      expect(body.params._meta).toMatchObject({
        'io.modelcontextprotocol/protocolVersion': VERSION,
        'io.modelcontextprotocol/clientInfo': { name: 'assistant-qualification', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      });
    }
  });

  it('follows opaque cursors with unique IDs and no session or action requests', async () => {
    const cursor = 'opaque /+=? cursor';
    const secondTool = { ...tool, name: 'projects.list' };
    const f = fixture(discovery(), { resultType: 'complete', tools: [tool], nextCursor: cursor });
    f.fetchImpl.mockResolvedValueOnce(rpc(3, { resultType: 'complete', tools: [secondTool] }));
    await expect(f.run()).resolves.toMatchObject({ tools: [tool, secondTool], complete: true });
    const requests = bodies(f.fetchImpl);
    expect(requests.map((b) => b.id)).toEqual([1, 2, 3]);
    expect(requests.map((b) => b.method)).toEqual(['server/discover', 'tools/list', 'tools/list']);
    expect(requests[1].params.cursor).toBeUndefined();
    expect(requests[2].params).toEqual({ ...requests[1].params, cursor });
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    for (const [, init] of f.fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).has('mcp-session-id')).toBe(false);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
  });

  it.each([
    { label: 'repeated', cursors: ['A', 'A'] },
    { label: 'cyclic', cursors: ['A', 'B', 'A'] },
  ])('rejects $label cursors before another request', async ({ cursors }) => {
    const f = fixture();
    f.fetchImpl.mockReset().mockResolvedValueOnce(rpc(1, discovery()));
    cursors.forEach((nextCursor, i) => {
      f.fetchImpl.mockResolvedValueOnce(
        rpc(2 + i, { resultType: 'complete', tools: [], nextCursor }),
      );
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1 + cursors.length);
    expect(bodies(f.fetchImpl).map((b) => b.id)).toEqual(
      Array.from({ length: 1 + cursors.length }, (_, i) => 1 + i),
    );
  });

  it('rejects a duplicate tool on a later page rather than silently replacing it', async () => {
    const f = fixture(discovery(), { resultType: 'complete', tools: [tool], nextCursor: 'page2' });
    f.fetchImpl.mockResolvedValueOnce(rpc(3, { resultType: 'complete', tools: [tool] }));
    await expect(f.run()).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects cumulative tool overflow even when each page is within the limit', async () => {
    const tools = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...tool, name: `get_${start + i}` }));
    const f = fixture(discovery(), {
      resultType: 'complete',
      tools: tools(0, 40),
      nextCursor: 'page2',
    });
    f.fetchImpl.mockResolvedValueOnce(rpc(3, { resultType: 'complete', tools: tools(40, 41) }));
    await expect(f.run()).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('accepts a terminal eighth page at the cumulative eighty-tool limit', async () => {
    const f = fixture();
    f.fetchImpl.mockReset().mockResolvedValueOnce(rpc(1, discovery()));
    for (let page = 0; page < 8; page++)
      f.fetchImpl.mockResolvedValueOnce(
        rpc(2 + page, {
          resultType: 'complete',
          tools: Array.from({ length: 10 }, (_, i) => ({ ...tool, name: `get_${page * 10 + i}` })),
          ...(page === 7 ? {} : { nextCursor: `page${page + 1}` }),
        }),
      );
    const result = await f.run();
    expect(result.tools).toHaveLength(80);
    expect(result.complete).toBe(true);
    expect(result).not.toHaveProperty('nextCursor');
    expect(f.fetchImpl).toHaveBeenCalledTimes(9);
    expect(bodies(f.fetchImpl).map((b) => b.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('can finish at eighty tools when a bounded continuation is empty', async () => {
    const f = fixture(discovery(), {
      resultType: 'complete',
      tools: Array.from({ length: 80 }, (_, i) => ({ ...tool, name: `get_${i}` })),
      nextCursor: 'empty-final',
    });
    f.fetchImpl.mockResolvedValueOnce(rpc(3, { resultType: 'complete', tools: [] }));
    await expect(f.run()).resolves.toMatchObject({
      complete: true,
      tools: expect.arrayContaining([{ ...tool, name: 'get_79' }]),
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects a continuation after eight pages without requesting a ninth page', async () => {
    const f = fixture();
    f.fetchImpl.mockReset().mockResolvedValueOnce(rpc(1, discovery()));
    for (let page = 0; page < 8; page++)
      f.fetchImpl.mockResolvedValueOnce(
        rpc(2 + page, { resultType: 'complete', tools: [], nextCursor: `page${page + 1}` }),
      );
    await expect(f.run()).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(9);
  });

  it('bounds a hanging continuation by the same transaction deadline without retries', async () => {
    const f = fixture(discovery(), { resultType: 'complete', tools: [tool], nextCursor: 'page2' });
    f.fetchImpl.mockImplementationOnce(() => new Promise(() => {}));
    await expect(f.run({ timeoutMs: 30 })).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    expect(bodies(f.fetchImpl).map((b) => b.id)).toEqual([1, 2, 3]);
    expect(new Set(f.fetchImpl.mock.calls.map(([, init]) => init?.signal)).size).toBe(1);
  });

  it.each([false, undefined])(
    'denies a missing/disabled opt-in before network (%s)',
    async (enabled) => {
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(
        qualifyMcpDiscovery(ENDPOINT, { enabled: enabled as boolean, fetchImpl }),
      ).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    'https://mcp.example/mcp',
    'http://192.168.1.10/mcp',
    'http://169.254.169.254/mcp',
    'http://127.0.0.1:3010/mcp?token=synthetic',
    'http://user:pass@127.0.0.1:3010/mcp',
  ])('rejects out-of-scope endpoints without network: %s', async (endpoint) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(qualifyMcpDiscovery(endpoint, { enabled: true, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cannot be enabled in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const f = fixture();
    await expect(f.run()).rejects.toThrow();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported revision', { supportedVersions: ['2025-11-25'] }],
    ['missing tools capability', { capabilities: {} }],
    ['invalid tools capability', { capabilities: { tools: true } }],
    ['incomplete server discovery', { resultType: 'partial' }],
  ])('fails honestly before tools/list for %s', async (_label, patch) => {
    const f = fixture(discovery(patch));
    await expect(f.run()).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([302, 401, 403, 404, 429, 503])(
    'does not retry/fallback after HTTP %s',
    async (status) => {
      const f = fixture();
      f.fetchImpl.mockReset().mockResolvedValue(new Response(null, { status }));
      await expect(f.run()).rejects.toThrow();
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry a failed tools/list or fall back to initialize', async () => {
    const f = fixture();
    f.fetchImpl
      .mockReset()
      .mockResolvedValueOnce(rpc(1, discovery()))
      .mockRejectedValueOnce(new Error('synthetic private detail'));
    await expect(f.run()).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies(f.fetchImpl).map((b) => b.method)).toEqual(['server/discover', 'tools/list']);
  });

  it.each([
    ['string ID', { jsonrpc: '2.0', id: '1', result: discovery() }],
    ['wrong ID', { jsonrpc: '2.0', id: 99, result: discovery() }],
    ['notification', { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }],
    [
      'RPC error',
      { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'synthetic private detail' } },
    ],
  ])('does not mistake %s for successful discovery', async (_label, value) => {
    const f = fixture();
    f.fetchImpl.mockReset().mockResolvedValueOnce(Response.json(value));
    await expect(f.run()).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('matches a final SSE response after notifications and cancels open streams', async () => {
    let cancelled = 0;
    const response = (id: number, result: unknown) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
              ),
            );
            c.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} })}\n\n`,
              ),
            );
            c.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`,
              ),
            );
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    const f = fixture();
    f.fetchImpl
      .mockReset()
      .mockResolvedValueOnce(response(1, discovery()))
      .mockResolvedValueOnce(response(2, { resultType: 'complete', tools: [tool] }));
    await expect(f.run()).resolves.toMatchObject({ tools: [tool], complete: true });
    expect(cancelled).toBe(2);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sanitizes provider failure details', async () => {
    const f = fixture();
    f.fetchImpl
      .mockReset()
      .mockRejectedValueOnce(
        new Error('Bearer synthetic-private-value https://private.example/record'),
      );
    const error = await f.run().catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain('synthetic-private-value');
    expect(error.message).not.toContain('private.example');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not truncate an oversized tool list into a complete result', async () => {
    const f = fixture(discovery(), {
      resultType: 'complete',
      tools: Array.from({ length: 81 }, (_, i) => ({ ...tool, name: `get_${i}` })),
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects response byte overflow and cancels the stream', async () => {
    let cancelled = false;
    const f = fixture();
    f.fetchImpl.mockReset().mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(300_001));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(f.run()).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds a fetch that ignores abort without retrying', async () => {
    const f = fixture();
    f.fetchImpl.mockReset().mockImplementation(() => new Promise(() => {}));
    await expect(f.run({ timeoutMs: 20 })).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing result type', { tools: [tool] }],
    ['non-final result', { resultType: 'partial', tools: [tool] }],
    ['duplicate tool identity', { resultType: 'complete', tools: [tool, tool] }],
    ['empty tool identity', { resultType: 'complete', tools: [{ ...tool, name: '' }] }],
    [
      'overlong tool identity',
      { resultType: 'complete', tools: [{ ...tool, name: 'x'.repeat(129) }] },
    ],
    [
      'non-object input schema',
      { resultType: 'complete', tools: [{ ...tool, inputSchema: null }] },
    ],
    [
      'overlong description',
      { resultType: 'complete', tools: [{ ...tool, description: 'x'.repeat(1201) }] },
    ],
    [
      'unsupported header annotation',
      {
        resultType: 'complete',
        tools: [
          {
            ...tool,
            inputSchema: {
              type: 'object',
              properties: { credential: { type: 'string', 'x-mcp-header': 'X-Private' } },
            },
          },
        ],
      },
    ],
    ['overlong cursor', { resultType: 'complete', tools: [tool], nextCursor: 'x'.repeat(4097) }],
  ])('rejects %s without acting or retrying', async (_label, listing) => {
    const f = fixture(discovery(), listing);
    await expect(f.run()).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies(f.fetchImpl).map((b) => b.method)).toEqual(['server/discover', 'tools/list']);
  });

  it.each([0, -1, 20_001, 1.5, Number.NaN])(
    'rejects an invalid deadline before network (%s)',
    async (timeoutMs) => {
      const f = fixture();
      await expect(f.run({ timeoutMs })).rejects.toThrow();
      expect(f.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('shares one deadline across both requests rather than resetting it per phase', async () => {
    const f = fixture();
    let id = 0;
    f.fetchImpl.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          const n = ++id;
          setTimeout(
            () =>
              resolve(rpc(n, n === 1 ? discovery() : { resultType: 'complete', tools: [tool] })),
            40,
          );
        }),
    );
    await expect(f.run({ timeoutMs: 60 })).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honors a caller abort before any network request', async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fixture();
    await expect(f.run({ signal: controller.signal })).rejects.toThrow();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('loopback wire qualification with the default pinned transport', () => {
  it.each(['application/json', 'text/event-stream', 'Text/Event-Stream; charset=utf-8'])(
    'discovers through real %s responses without initialization, sessions or actions',
    async (contentType) => {
      const requests: Array<{
        headers: Record<string, string | string[] | undefined>;
        body: { id: number; method: string; params: Record<string, unknown> };
      }> = [];
      let streamsClosed = 0;
      const server = createServer((req, res) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          const body = JSON.parse(raw);
          requests.push({ headers: req.headers, body });
          const result =
            body.method === 'server/discover'
              ? discovery()
              : { resultType: 'complete', tools: [tool] };
          res.writeHead(200, {
            'content-type': contentType,
            'mcp-session-id': 'must-not-be-reused',
          });
          if (contentType === 'application/json')
            res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
          else {
            res.on('close', () => {
              streamsClosed++;
            });
            res.write(
              'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n',
            );
            res.write(
              `data: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: { unrelated: true } })}\n\n`,
            );
            res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`);
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
        await expect(
          qualifyMcpDiscovery(`http://127.0.0.1:${address.port}/mcp`, {
            enabled: true,
            timeoutMs: 1000,
          }),
        ).resolves.toMatchObject({ protocolVersion: VERSION, tools: [tool], complete: true });
        expect(requests).toHaveLength(2);
        expect(requests.map((r) => r.body.method)).toEqual(['server/discover', 'tools/list']);
        for (const r of requests) {
          expect(r.headers['mcp-protocol-version']).toBe(VERSION);
          expect(r.headers['mcp-method']).toBe(r.body.method);
          expect(r.headers.authorization).toBeUndefined();
          expect(r.headers['mcp-session-id']).toBeUndefined();
          expect(r.body.params).toEqual({
            _meta: {
              'io.modelcontextprotocol/protocolVersion': VERSION,
              'io.modelcontextprotocol/clientInfo': {
                name: 'assistant-qualification',
                version: '1.0.0',
              },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          });
        }
        if (contentType.toLowerCase().startsWith('text/event-stream'))
          await vi.waitFor(() => expect(streamsClosed).toBe(2));
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
  it('follows a real opaque cursor through mixed JSON and SSE pages without sessions', async () => {
    const cursor = 'opaque +/== ? value';
    const requests: Array<{
      method: string;
      id: number;
      params: Record<string, unknown>;
      session: string | undefined;
    }> = [];
    let closed = false;
    const server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        requests.push({ ...body, session: req.headers['mcp-session-id'] });
        const continuation = body.id === 3;
        const result =
          body.method === 'server/discover'
            ? discovery()
            : continuation
              ? { resultType: 'complete', tools: [{ ...tool, name: 'projects.list' }] }
              : { resultType: 'complete', tools: [tool], nextCursor: cursor };
        res.writeHead(200, {
          'content-type': continuation ? 'text/event-stream' : 'application/json',
          'mcp-session-id': 'not-authority',
        });
        if (!continuation) res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        else {
          res.on('close', () => {
            closed = true;
          });
          res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
          res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
      const result = await qualifyMcpDiscovery(`http://127.0.0.1:${address.port}/mcp`, {
        enabled: true,
        timeoutMs: 1000,
      });
      expect(result.tools.map((t) => t.name)).toEqual(['projects.get', 'projects.list']);
      expect(result.complete).toBe(true);
      expect(result).not.toHaveProperty('nextCursor');
      expect(requests.map((r) => r.id)).toEqual([1, 2, 3]);
      expect(requests.map((r) => r.method)).toEqual([
        'server/discover',
        'tools/list',
        'tools/list',
      ]);
      expect(requests[2]?.params).toEqual({ ...requests[1]?.params, cursor });
      expect(requests.every((r) => r.session === undefined)).toBe(true);
      await vi.waitFor(() => expect(closed).toBe(true));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
