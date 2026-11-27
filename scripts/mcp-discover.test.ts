import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { inspectMcpConnection } from '@assistant/tools/mcp';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const args = ['--import', 'tsx', 'scripts/mcp-discover.ts'];
it('lists tools from a local server through the CLI without executing them', async () => {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method } = JSON.parse(Buffer.concat(chunks).toString());
    methods.push(method);
    if (method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    const result =
      method === 'server/discover'
        ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
        : method === 'initialize'
          ? {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : { tools: [{ name: 'calendar_lookup', inputSchema: { type: 'object' } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    const modern = req.headers['mcp-method'] !== undefined;
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: modern ? { resultType: 'complete', ...result } : result,
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const { stdout } = await run(process.execPath, [...args, `http://127.0.0.1:${port}/mcp`]);
    expect(JSON.parse(stdout)).toEqual({
      protocolVersion: '2026-07-28',
      complete: true,
      toolNames: ['calendar_lookup'],
    });
    expect(methods).toEqual(['server/discover', 'tools/list']);
    methods.length = 0;
    const inspection = await inspectMcpConnection(`http://127.0.0.1:${port}/mcp`);
    expect(inspection.status).toBe('ready');
    expect(inspection.tools.map((tool) => tool.name)).toEqual(['calendar_lookup']);
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('rejects unknown flags with usage and a nonzero exit code', async () => {
  await expect(
    run(process.execPath, [...args, 'http://localhost/mcp', '--execute']),
  ).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringContaining('Usage:'),
  });
});
