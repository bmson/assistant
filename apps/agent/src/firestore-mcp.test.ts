import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { reloadConfig } from '@assistant/config';
import { encryptMcpBearerToken } from '@assistant/core/mcp-secrets';
import {
  FirestoreApprovalPolicyRepository,
  FirestoreApprovalRepository,
  FirestoreCostRepository,
  FirestoreMcpConnectionReadRepository,
  FirestoreToolExecutionRepository,
  type InstallationStore,
} from '@assistant/firestore';
import { type ToolContext, ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { registerFirestoreMcpTools } from './deps.js';

const originalKey = process.env.MCP_ENC_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.MCP_ENC_KEY;
  else process.env.MCP_ENC_KEY = originalKey;
  reloadConfig();
  vi.unstubAllEnvs();
});

describe('Firestore MCP tool composition', () => {
  it('registers Firestore MCP tools in production, as PostgreSQL does', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const registry = registerFirestoreMcpTools(
        new ToolRegistry(),
        {} as InstallationStore,
        'owner',
      );
      expect(registry.get('mcp.call')?.tool.risk).toBe('approval');
      expect(registry.get('mcp.list_connections')).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('with PostgreSQL unavailable', () => {
    it('reads Firestore snapshots and executes only after approval without touching SQL', async () => {
      process.env.MCP_ENC_KEY = '11'.repeat(32);
      reloadConfig();
      const store = emulatorStore();
      const server = createServer();
      const agentId = randomUUID();
      const connectionId = randomUUID();
      const taskId = randomUUID();
      const toolCallRequests: string[] = [];
      const serverTokenChecks: boolean[] = [];
      try {
        server.on('request', (request, response) => {
          const chunks: Buffer[] = [];
          request.on('data', (chunk: Buffer) => chunks.push(chunk));
          request.on('end', () => {
            const rpc = JSON.parse(Buffer.concat(chunks).toString()) as {
              id?: number;
              method: string;
            };
            serverTokenChecks.push(request.headers.authorization === 'Bearer owner-mcp-secret');
            if (rpc.method === 'tools/call') toolCallRequests.push(rpc.method);
            response.setHeader('content-type', 'application/json');
            response.setHeader('mcp-session-id', 'firestore-mcp-session');
            if (rpc.method === 'notifications/initialized') {
              response.writeHead(202).end();
            } else {
              response.writeHead(200).end(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: rpc.id,
                  result:
                    rpc.method === 'initialize'
                      ? {
                          protocolVersion: '2025-11-25',
                          serverInfo: { name: 'Firestore MCP' },
                        }
                      : { content: [{ type: 'text', text: 'remote result' }] },
                }),
              );
            }
          });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No test server address');
        await store.doc('agents', agentId).set({ id: agentId });
        await store.doc('tasks', taskId).set({
          id: taskId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
        });
        await store.doc('mcpConnections', connectionId).set({
          id: connectionId,
          agentId,
          name: 'Owner test server',
          endpoint: `http://127.0.0.1:${address.port}/mcp`,
          status: 'ready',
          enabled: true,
          bearerTokenEncrypted: encryptMcpBearerToken('owner-mcp-secret'),
          serverName: 'Firestore MCP',
          serverVersion: null,
          instructions: null,
          tools: [{ name: 'lookup', description: 'Search owner data', inputSchema: {} }],
          lastCheckedAt: new Date(),
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        const db = new Proxy({} as ToolContext['db'], {
          get(_target, property) {
            throw new Error(`Unexpected PostgreSQL access: ${String(property)}`);
          },
        });
        const enabledRegistry = registerFirestoreMcpTools(new ToolRegistry(), store, agentId);
        expect(enabledRegistry.get('mcp.call')?.tool.risk).toBe('approval');
        expect(enabledRegistry.get('mcp.call')?.flags).toMatchObject({
          networkEgress: true,
          returnsUntrustedContent: true,
          blanketAllowIneligible: true,
          autonomyFloor: true,
        });
        const port = new FirestoreMcpConnectionReadRepository(store, agentId);
        const connections = await port.list(agentId);
        expect(connections).toMatchObject([
          { id: connectionId, status: 'ready', serverName: 'Firestore MCP' },
        ]);
        expect(JSON.stringify(connections)).not.toContain('owner-mcp-secret');

        const approvals = new FirestoreApprovalRepository(store);
        const dispatcher = new ToolDispatcher(
          db,
          enabledRegistry,
          new FirestoreToolExecutionRepository(store),
          new FirestoreCostRepository(store),
          approvals,
          new FirestoreApprovalPolicyRepository(store),
        );
        const task = {
          id: taskId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          createdAt: new Date(),
          trigger: null,
          conversationId: null,
          goalId: null,
        } as never;
        const ctx = {
          taskId,
          agentId,
          trust: 'owner',
          tainted: false,
          db,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        } as ToolContext;
        const parked = await dispatcher.dispatch({
          task,
          step: 1,
          toolName: 'mcp.call',
          args: { connectionId, toolName: 'lookup', arguments: { query: 'owner' } },
          ctx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        expect(parked.kind).toBe('awaiting_approval');
        expect(toolCallRequests).toHaveLength(0);
        if (parked.kind !== 'awaiting_approval') throw new Error('MCP call was not approval gated');
        const resolution = await approvals.resolve({
          approvalId: parked.approvalId,
          decision: 'approved',
          via: 'web',
          deferNotification: true,
        });
        expect(resolution.ok).toBe(true);
        const execution = await dispatcher.executeApproved(parked.toolCallId, ctx);
        expect(execution).toMatchObject({
          kind: 'executed',
          result: {
            connection: 'Owner test server',
            tool: 'lookup',
            result: { content: [{ text: 'remote result' }] },
          },
        });
        expect(toolCallRequests).toHaveLength(1);
        expect(serverTokenChecks).toEqual([true, true, true]);

        await store.doc('mcpConnections', connectionId).update({
          enabled: false,
          status: 'disabled',
        });
        await expect(
          enabledRegistry
            .get('mcp.call')
            ?.tool.execute({ connectionId, toolName: 'lookup', arguments: {} }, ctx),
        ).rejects.toThrow('is not ready');
        await store.doc('mcpConnections', connectionId).update({
          enabled: true,
          status: 'ready',
          tools: [],
        });
        await expect(
          enabledRegistry
            .get('mcp.call')
            ?.tool.execute({ connectionId, toolName: 'lookup', arguments: {} }, ctx),
        ).rejects.toThrow('is not available');
        await store.doc('mcpConnections', connectionId).update({
          status: 'ready',
          tools: [{ name: 'lookup' }],
        });
        const changedAfterApproval = await dispatcher.dispatch({
          task,
          step: 2,
          toolName: 'mcp.call',
          args: { connectionId, toolName: 'lookup', arguments: { query: 'owner' } },
          ctx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        expect(changedAfterApproval.kind).toBe('awaiting_approval');
        if (changedAfterApproval.kind !== 'awaiting_approval')
          throw new Error('MCP call was not approval gated');
        expect(
          await approvals.resolve({
            approvalId: changedAfterApproval.approvalId,
            decision: 'approved',
            via: 'web',
            deferNotification: true,
          }),
        ).toMatchObject({ ok: true });
        await store.doc('mcpConnections', connectionId).update({
          enabled: false,
          status: 'disabled',
        });
        expect(
          await dispatcher.executeApproved(changedAfterApproval.toolCallId, ctx),
        ).toMatchObject({ kind: 'failed', error: expect.stringContaining('security binding') });
        expect(toolCallRequests).toHaveLength(1);
        await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
        await expect(
          enabledRegistry.get('mcp.list_connections')?.tool.execute({}, ctx),
        ).rejects.toThrow('Privacy erasure is in progress');
        await store.doc('privacyErasureJobs', agentId).delete();
        expect(toolCallRequests).toHaveLength(1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await disposeStore(store);
      }
    }, 30_000);
  });
});
