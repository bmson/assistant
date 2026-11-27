import { describe, expect, it } from 'vitest';
import { permitsLegacyDiscoveryProbe } from './mcp-discovery-probe.js';
import { qualifyMcpDiscovery } from './mcp-discovery-qualification.js';

const modern = '2026-07-28';
const legacy = '2025-11-25';
const supported = '2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07';
const versionError = (requested = modern, versions = supported) =>
  `Bad Request: Unsupported protocol version: ${requested} (supported versions: ${versions})`;
const envelope = (message: string, id: unknown = null, code = -32000, status = 400) =>
  Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status });
const inspect = (response: Response) =>
  permitsLegacyDiscoveryProbe(response, 1, AbortSignal.timeout(1000));

describe('published SDK 1.32.2 legacy probe envelopes', () => {
  it.each(['Bad Request: Server not initialized', versionError()])(
    'accepts the exact initial transport rejection: %s',
    async (message) => {
      expect(await inspect(envelope(message))).toBe(true);
      expect(await inspect(envelope(message, 1))).toBe(true);
    },
  );
  it.each([
    envelope('Bad Request: Server not initialized', 2),
    envelope('Bad Request: Server not initialized', '1'),
    Response.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Server not initialized' } },
      { status: 400 },
    ),
    envelope('Bad Request: Server not initialized', null, -32022),
    envelope('Bad Request: Server not initialized', null, -32020),
    envelope('Bad Request: Server not initialized', null, -32602),
    envelope('Bad Request: Server not initialized', null, -32000, 404),
    envelope('Bad Request: Server not initialized', null, -32000, 401),
    envelope(versionError('2025-06-18')),
    envelope(versionError(modern, '2025-06-18')),
    envelope(versionError(modern, `${legacy}, ${modern}`)),
    envelope(versionError(modern, `${legacy}, 2027-01-01`)),
    envelope(versionError(modern, `${legacy}, 2025-02-30`)),
    envelope(versionError(modern, `${legacy}, ${legacy}`)),
    envelope(`${versionError()} extra`),
    envelope('Bad Request: Unsupported protocol version'),
    envelope('Server not initialized'),
    Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        result: {},
        error: { code: -32000, message: 'Bad Request: Server not initialized' },
      },
      { status: 400 },
    ),
  ])('rejects unrelated, contradictory, modern, or malformed envelopes %#', async (response) => {
    expect(await inspect(response)).toBe(false);
  });
  it.each(['Bad Request: Server not initialized', versionError()])(
    'qualifies discovery after exact SDK rejection without invoking a tool: %s',
    async (message) => {
      const methods: string[] = [];
      const fetchImpl: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        methods.push(body.method);
        if (body.method === 'server/discover') return envelope(message);
        if (body.method === 'initialize')
          return Response.json({
            jsonrpc: '2.0',
            id: 2,
            result: {
              protocolVersion: legacy,
              capabilities: { tools: {} },
              serverInfo: { name: 'SDK fixture', version: '1.32.2' },
            },
          });
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
        if (body.method === 'tools/list')
          return Response.json({
            jsonrpc: '2.0',
            id: 3,
            result: { tools: [{ name: 'synthetic_lookup', inputSchema: { type: 'object' } }] },
          });
        throw Error('Unexpected method');
      };
      const result = await qualifyMcpDiscovery('http://127.0.0.1:3010/mcp', {
        enabled: true,
        allowLegacyFallback: true,
        fetchImpl,
      });
      expect(result.protocolVersion).toBe(legacy);
      expect(result.tools.map((tool) => tool.name)).toEqual(['synthetic_lookup']);
      expect(methods).toEqual([
        'server/discover',
        'initialize',
        'notifications/initialized',
        'tools/list',
      ]);
    },
  );
});

const pythonUnsupported = `Bad Request: Unsupported protocol version: ${modern}. Supported versions: 2024-11-05, 2025-03-26, 2025-06-18, ${legacy}`;
describe('published Python SDK 1.30.0 probe sentinel', () => {
  it.each(['Bad Request: Missing session ID', pythonUnsupported])(
    'accepts only exact transport evidence: %s',
    async (message) => {
      expect(await inspect(envelope(message, 'server-error', -32600))).toBe(true);
    },
  );
  it.each([
    envelope('Bad Request: Missing session ID', null, -32600),
    envelope('Bad Request: Missing session ID', 2, -32600),
    envelope('Bad Request: Missing session ID', 'server-error', -32022),
    envelope('Bad Request: Missing session ID', 'server-error', -32000),
    envelope('Server not initialized', 'server-error', -32600),
    envelope('Bad Request: Server not initialized', 'server-error', -32000),
    envelope(pythonUnsupported.replace(modern, '2025-06-18'), 'server-error', -32600),
    envelope(pythonUnsupported.replace(legacy, modern), 'server-error', -32600),
    envelope(`${pythonUnsupported} extra`, 'server-error', -32600),
    envelope('Bad Request: Missing session ID', 'server-error', -32600, 403),
  ])('rejects sentinel generalization or malformed evidence %#', async (response) => {
    expect(await inspect(response)).toBe(false);
  });
});
