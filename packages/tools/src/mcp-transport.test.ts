import { describe, expect, it, vi } from 'vitest';
import { invokeMcpTool } from './mcp.js';
import { AmbiguousMcpMutationError, readMcpRpcResponse } from './mcp-transport.js';

function stream(parts: string[], keepOpen = false) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      if (!keepOpen) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    cancelled: () => cancelled,
  };
}
describe('MCP matching transport', () => {
  it('ignores notification and unrelated IDs, handles split UTF8 frames, and settles before stream close', async () => {
    const notices: unknown[] = [];
    const fixture = stream(
      [
        'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n',
        'data: {"jsonrpc":"2.0","id":9,"result":{"wrong":true}}\n\n',
        'data: {"jsonrpc":"2.0","id":2,"res',
        'ult":{"name":"Björk"}}\n',
        '\n',
      ],
      true,
    );
    const result = await readMcpRpcResponse(fixture.response, 2, AbortSignal.timeout(500), {
      onNotification: (n) => notices.push(n),
    });
    expect(result.result).toEqual({ name: 'Björk' });
    expect(notices).toHaveLength(1);
    expect(fixture.cancelled()).toBe(true);
  });
  it('does not equate numeric and string request IDs', async () => {
    await expect(
      readMcpRpcResponse(
        Response.json({ jsonrpc: '2.0', id: '2', result: {} }),
        2,
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow('matching');
  });
  it('bounds an open stream even when the supplied fetch ignores abort', async () => {
    const fixture = stream([': heartbeat\n\n'], true);
    await expect(readMcpRpcResponse(fixture.response, 2, AbortSignal.timeout(20))).rejects.toThrow(
      'deadline',
    );
    expect(fixture.cancelled()).toBe(true);
  });
  it('rejects unrelated-only streams and byte overflow', async () => {
    await expect(
      readMcpRpcResponse(
        stream(['data: {"jsonrpc":"2.0","id":8,"result":{}}\n\n']).response,
        2,
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow('matching');
    await expect(
      readMcpRpcResponse(
        stream([`data: ${'x'.repeat(50)}\n\n`]).response,
        2,
        AbortSignal.timeout(500),
        { maxBytes: 20 },
      ),
    ).rejects.toThrow('too large');
  });
  it('does not treat a server-initiated request as the answer', async () => {
    await expect(
      readMcpRpcResponse(
        stream(['data: {"jsonrpc":"2.0","id":3,"method":"sampling/createMessage"}\n\n']).response,
        2,
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow('unsupported');
  });
  it('records an accepted mutation with lost reply as unknown and sends it only once', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'fixture' } } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockRejectedValueOnce(new Error('reply lost'));
    await expect(
      invokeMcpTool('http://localhost:3010/mcp', 'send', { text: 'one' }, null, fetchImpl),
    ).rejects.toBeInstanceOf(AmbiguousMcpMutationError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      fetchImpl.mock.calls.filter((call) => String(call[1]?.body).includes('tools/call')),
    ).toHaveLength(1);
  });
  it('preserves matched remote RPC rejections as definitive errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ jsonrpc: '2.0', id: 1, result: {} }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          jsonrpc: '2.0',
          id: 2,
          error: { code: -32602, message: 'invalid argument' },
        }),
      );
    await expect(
      invokeMcpTool('http://localhost:3010/mcp', 'send', {}, null, fetchImpl),
    ).rejects.toThrow('invalid argument');
  });
});

it('keeps a malformed matched result unknown after the action was submitted', async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ jsonrpc: '2.0', id: 1, result: {} }))
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ jsonrpc: '2.0', id: 2, result: null }));
  await expect(
    invokeMcpTool('http://localhost:3010/mcp', 'send', {}, null, fetchImpl),
  ).rejects.toBeInstanceOf(AmbiguousMcpMutationError);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});
