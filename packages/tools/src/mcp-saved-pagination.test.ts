import { reloadConfig } from '@assistant/config';
import { encryptMcpBearerToken } from '@assistant/core/mcp-secrets';
import type { Db, TaskRow } from '@assistant/db';
import {
  type ApprovalPolicyRepository,
  type ApprovalRepository,
  type CostRepository,
  type McpOAuthRepository,
  parseMcpOAuthState,
  type ToolExecutionRepository,
} from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatcher } from './dispatcher.js';
import {
  inspectMcpConnection,
  invokeMcpTool,
  type McpToolConnectionRecord,
  registerMcpTools,
} from './mcp.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

// Exercise the real legacy RPC reader, discovery, OAuth registration and
// dispatcher; replace only the DNS/socket boundary. No external network/owner.
vi.mock('./mcp-http.js', () => ({
  resolveMcpEndpoint: vi.fn(async (endpoint: string) => ({
    endpoint: new URL(endpoint),
    address: '93.184.216.34',
    family: 4,
  })),
  pinnedAgent: vi.fn(() => ({ destroy: vi.fn() })),
  pinnedRequest: vi.fn(async (session: { endpoint: URL }, init: RequestInit) =>
    fetch(session.endpoint, init),
  ),
}));

const endpoint = 'https://mcp.example.invalid/mcp';
const ownerId = 'synthetic-owner';
const connectionId = '11111111-1111-4111-8111-111111111111';
const first = {
  name: 'projects.first',
  description: 'Read first synthetic project',
  inputSchema: { type: 'object', properties: {} },
};
const second = {
  name: 'projects.second',
  description: 'Read second synthetic project',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', enum: ['synthetic-2'] } },
    required: ['id'],
    additionalProperties: false,
  },
};
const cursor = 'opaque second /+=?';
type Mode = 'same' | 'changed' | 'missing' | 'later-failure' | 'cycle' | 'ambiguous-call';
const oldKey = process.env.MCP_ENC_KEY;
beforeEach(() => {
  process.env.MCP_ENC_KEY = '11'.repeat(32);
  reloadConfig();
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (oldKey === undefined) delete process.env.MCP_ENC_KEY;
  else process.env.MCP_ENC_KEY = oldKey;
  reloadConfig();
});

function wire(mode: Mode = 'same', pages?: Array<Record<string, unknown>>) {
  let listedPages = 0;
  const requests: Array<{
    body: { id?: number; method: string; params: Record<string, unknown> };
    headers: Headers;
  }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ body, headers: new Headers(init?.headers) });
    const result = (value: unknown) =>
      Response.json(
        { jsonrpc: '2.0', id: body.id, result: value },
        body.method === 'initialize'
          ? { headers: { 'Mcp-Session-Id': 'synthetic-session' } }
          : undefined,
      );
    if (body.method === 'initialize')
      return result({
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'Saved synthetic server', version: '1.0' },
      });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') {
      if (pages) return result(pages[listedPages++]);
      if (body.params.cursor === undefined) return result({ tools: [first], nextCursor: cursor });
      expect(body.params.cursor).toBe(cursor);
      if (mode === 'later-failure') return new Response(null, { status: 503 });
      if (mode === 'cycle') return result({ tools: [], nextCursor: cursor });
      return result({
        tools:
          mode === 'missing'
            ? []
            : [
                mode === 'changed'
                  ? {
                      ...second,
                      inputSchema: { ...second.inputSchema, required: ['id', 'newOwnerDecision'] },
                    }
                  : second,
              ],
      });
    }
    if (body.method === 'tools/call') {
      if (mode === 'ambiguous-call') throw new TypeError('synthetic connection lost after send');
      return result({ content: [{ type: 'text', text: 'Synthetic project 2' }] });
    }
    throw new Error('Unexpected MCP method');
  });
  return {
    fetchImpl,
    requests,
    calls: () => requests.filter((r) => r.body.method === 'tools/call'),
  };
}

function approvedFixture(mode: Mode = 'same') {
  const network = wire(mode);
  vi.stubGlobal('fetch', network.fetchImpl);
  const credential = encryptMcpBearerToken('synthetic-oauth-access');
  const state = parseMcpOAuthState(
    {
      version: 1,
      ownerId,
      connectionId,
      flow: null,
      lastOutcome: null,
      grant: {
        generation: '22222222-2222-4222-8222-222222222222',
        revision: 0,
        binding: {
          endpoint,
          resource: endpoint,
          issuer: 'https://issuer.example.invalid',
          authorizationEndpoint: 'https://issuer.example.invalid/authorize',
          tokenEndpoint: 'https://issuer.example.invalid/token',
          redirectUri: 'https://assistant.example.invalid/callback',
          clientId: 'synthetic-client',
          tokenEndpointAuthMethod: 'none',
          authorizationResponseIssuerRequired: true,
        },
        clientSecretEncrypted: null,
        tokens: {
          accessTokenEncrypted: credential,
          refreshTokenEncrypted: null,
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          scopes: ['read'],
        },
        discovery: { serverName: 'Saved synthetic server', tools: [first, second] },
        refresh: null,
        reconnectRequired: false,
      },
    },
    { ownerId, connectionId },
    endpoint,
  );
  const connection: McpToolConnectionRecord = {
    id: connectionId,
    name: 'Synthetic saved connection',
    status: 'authorization_required',
    enabled: true,
    endpoint,
    bearerTokenEncrypted: null,
    serverName: null,
    tools: [],
  };
  const repoGet = vi.fn(async () => state);
  const resolve = vi.fn(async () => credential);
  const registry = registerMcpTools(
    new ToolRegistry(),
    { list: async () => [connection], get: async () => connection },
    { oauth: { repo: { get: repoGet } as unknown as McpOAuthRepository, resolve } },
  );
  const task = {
    id: 'synthetic-task',
    agentId: ownerId,
    type: 'adhoc',
    status: 'running',
    trust: 'owner',
    trigger: {},
    createdAt: new Date(),
    conversationId: null,
  } as unknown as TaskRow;
  let call: Record<string, unknown> | null = null;
  let approval: Record<string, unknown> | null = null;
  let claims = 0;
  const execution = {
    kind: 'tool-execution-repository',
    load: async () => (call ? { toolCall: call, task, approval } : null),
    outcome: async ({ status, result, error }: Record<string, unknown>) => {
      if (!call) return false;
      call = { ...call, status, result, error: error ?? null };
      return true;
    },
    claim: async () => {
      claims++;
      if (call?.status !== 'approved') return null;
      call = { ...call, status: 'executing' };
      return { toolCall: call, task, approval };
    },
  } as unknown as ToolExecutionRepository;
  const approvals = {
    kind: 'approval-repository',
    create: async (input: Record<string, unknown>) => {
      call = {
        id: 'synthetic-call',
        taskId: task.id,
        status: 'awaiting_approval',
        toolName: input.toolName,
        args: input.args,
        decision: input.decision,
        step: input.step,
        approvalId: 'synthetic-approval',
        result: null,
      };
      approval = {
        id: 'synthetic-approval',
        status: 'pending',
        taskId: task.id,
        toolCallId: 'synthetic-call',
        resolutionPayload: null,
      };
      return { toolCallId: 'synthetic-call', approvalId: 'synthetic-approval', shortCode: 'A1' };
    },
  } as unknown as ApprovalRepository;
  const dispatcher = new ToolDispatcher(
    {} as Db,
    registry,
    execution,
    {} as CostRepository,
    approvals,
    {
      kind: 'approval-policy-repository',
      list: async () => [],
    } as unknown as ApprovalPolicyRepository,
  );
  const ctx = {
    agentId: ownerId,
    taskId: task.id,
    trust: 'owner',
    tainted: false,
    db: {} as Db,
    now: () => new Date(),
    signal: new AbortController().signal,
    log: async () => {},
  } as ToolContext;
  return {
    ...network,
    registry,
    ctx,
    repoGet,
    resolve,
    async parkAndApprove() {
      expect(
        await dispatcher.dispatch({
          task,
          step: 1,
          toolName: 'mcp.call',
          args: { connectionId, toolName: second.name, arguments: { id: 'synthetic-2' } },
          ctx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test/model' },
        }),
      ).toMatchObject({ kind: 'awaiting_approval' });
      expect(call?.args).toMatchObject({
        _approvalMcpScope: { connectionId, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
      expect(network.requests).toHaveLength(0);
      if (!call || !approval) throw new Error('Missing approval fixture');
      call = { ...call, status: 'approved' };
      approval = { ...approval, status: 'approved' };
    },
    execute: () => dispatcher.executeApproved('synthetic-call', ctx),
    claims: () => claims,
  };
}

describe('active saved MCP tool pagination and grant-bound approvals', () => {
  it('discovers page two with its exact schema, opaque cursor, session and credential', async () => {
    const f = wire();
    const discovery = await inspectMcpConnection(endpoint, {
      fetchImpl: f.fetchImpl,
      bearerTokenEncrypted: encryptMcpBearerToken('synthetic-manual-access'),
    });
    expect(discovery).toMatchObject({ status: 'ready', tools: [first, second] });
    expect(discovery.tools[1]?.inputSchema).toEqual(second.inputSchema);
    expect(f.requests.map((r) => r.body.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/list',
    ]);
    expect(f.requests.filter((r) => r.body.id !== undefined).map((r) => r.body.id)).toEqual([
      1, 2, 3,
    ]);
    expect(f.requests[3]?.body.params).toEqual({ cursor });
    expect(
      f.requests.every((r) => r.headers.get('authorization') === 'Bearer synthetic-manual-access'),
    ).toBe(true);
    expect(
      f.requests.slice(1).every((r) => r.headers.get('mcp-session-id') === 'synthetic-session'),
    ).toBe(true);
    expect(f.calls()).toHaveLength(0);
  });

  it.each(['later-failure', 'cycle'] as const)(
    'never saves a partial ready list when page two has %s',
    async (mode) => {
      const f = wire(mode);
      expect(await inspectMcpConnection(endpoint, { fetchImpl: f.fetchImpl })).toMatchObject({
        status: 'error',
        tools: [],
      });
      expect(f.requests.filter((r) => r.body.method === 'tools/list')).toHaveLength(2);
      expect(f.calls()).toHaveLength(0);
    },
  );

  it('exposes the granted page-two tool and executes only after the actual dispatcher approval', async () => {
    const f = approvedFixture();
    const list = f.registry.get('mcp.list_tools');
    expect(await list?.tool.execute({ connectionId }, f.ctx)).toMatchObject({
      tools: [first, second],
    });
    await f.parkAndApprove();
    expect(await f.execute()).toMatchObject({ kind: 'executed' });
    expect(f.calls()).toHaveLength(1);
    expect(f.calls()[0]?.body).toMatchObject({
      id: 4,
      params: { name: second.name, arguments: { id: 'synthetic-2' } },
    });
    expect(f.requests.filter((r) => r.body.id !== undefined).map((r) => r.body.id)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(
      f.requests.every((r) => r.headers.get('authorization') === 'Bearer synthetic-oauth-access'),
    ).toBe(true);
    expect(f.repoGet).toHaveBeenCalledWith({ ownerId, connectionId }, endpoint);
    expect(f.resolve).toHaveBeenCalledWith(
      ownerId,
      expect.objectContaining({ oauthGeneration: expect.any(String) }),
    );
    expect(f.claims()).toBe(1);
  });

  it.each(['changed', 'missing', 'later-failure', 'cycle'] as const)(
    'refuses changed, absent or incomplete page-two authority (%s) without invocation/retry',
    async (mode) => {
      const f = approvedFixture(mode);
      await f.parkAndApprove();
      expect(await f.execute()).toMatchObject({ kind: 'failed' });
      expect(await f.execute()).toMatchObject({ kind: 'failed' });
      expect(f.calls()).toHaveLength(0);
      expect(f.requests.filter((r) => r.body.method === 'tools/list')).toHaveLength(2);
      expect(f.requests.filter((r) => r.body.method === 'initialize')).toHaveLength(1);
      expect(f.claims()).toBe(1);
    },
  );

  it('never repeats an ambiguous approved page-two call when the same approval is replayed', async () => {
    const f = approvedFixture('ambiguous-call');
    await f.parkAndApprove();
    expect(await f.execute()).toMatchObject({
      kind: 'executed',
      result: { deliveryStatus: 'unknown', retrySuppressed: true },
    });
    expect(await f.execute()).toMatchObject({
      kind: 'executed',
      result: { deliveryStatus: 'unknown', retrySuppressed: true },
    });
    expect(f.calls()).toHaveLength(1);
    expect(f.requests.filter((r) => r.body.method === 'tools/list')).toHaveLength(2);
    expect(f.claims()).toBe(1);
  });
  it('allows eight terminal pages but rejects an unfinished ninth page without a partial ready list', async () => {
    const pages = Array.from({ length: 8 }, (_, i) => ({
      tools: i === 7 ? [second] : [],
      ...(i < 7 ? { nextCursor: `page-${i + 1}` } : {}),
    }));
    const complete = wire('same', pages);
    expect(await inspectMcpConnection(endpoint, { fetchImpl: complete.fetchImpl })).toMatchObject({
      status: 'ready',
      tools: [second],
    });
    expect(complete.requests.filter((r) => r.body.method === 'tools/list')).toHaveLength(8);
    const unfinished = wire(
      'same',
      pages.map((p, i) => ({ ...p, nextCursor: `page-${i + 1}` })),
    );
    expect(await inspectMcpConnection(endpoint, { fetchImpl: unfinished.fetchImpl })).toMatchObject(
      { status: 'error', tools: [] },
    );
    expect(unfinished.requests.filter((r) => r.body.method === 'tools/list')).toHaveLength(8);
    expect(unfinished.calls()).toHaveLength(0);
  });

  it('enforces a cumulative byte bound across two individually small pages', async () => {
    const pages = [
      { tools: [first], padding: 'x'.repeat(160_000), nextCursor: cursor },
      { tools: [second], padding: 'x'.repeat(160_000) },
    ];
    expect(pages.every((page) => Buffer.byteLength(JSON.stringify(page)) < 300_000)).toBe(true);
    const f = wire('same', pages);
    expect(await inspectMcpConnection(endpoint, { fetchImpl: f.fetchImpl })).toMatchObject({
      status: 'error',
      tools: [],
    });
    expect(f.requests.filter((r) => r.body.method === 'tools/list')).toHaveLength(2);
    expect(f.calls()).toHaveLength(0);
  });

  it('retains the first-80 exposure cap while traversing to the terminal page', async () => {
    const visible = Array.from({ length: 80 }, (_, i) => ({
      ...first,
      name: `projects.read_${i}`,
    }));
    const f = wire('same', [{ tools: visible, nextCursor: cursor }, { tools: [second] }]);
    const result = await inspectMcpConnection(endpoint, { fetchImpl: f.fetchImpl });
    expect(result).toMatchObject({ status: 'ready', tools: visible });
    expect(result.tools).toHaveLength(80);
    expect(f.requests.filter((r) => r.body.method === 'tools/list')).toHaveLength(2);
    expect(f.calls()).toHaveLength(0);
  });

  it('rejects a repeated tool identity across pages, including beyond the exposure cap', async () => {
    const visible = Array.from({ length: 80 }, (_, i) => ({
      ...first,
      name: `projects.read_${i}`,
    }));
    const f = wire('same', [{ tools: visible, nextCursor: cursor }, { tools: [visible[0]] }]);
    expect(await inspectMcpConnection(endpoint, { fetchImpl: f.fetchImpl })).toMatchObject({
      status: 'error',
      tools: [],
    });
    expect(f.requests.filter((r) => r.body.method === 'tools/list')).toHaveLength(2);
    expect(f.calls()).toHaveLength(0);
  });

  it('does not authorize null prior and null fresh fingerprints in the direct OAuth entry point', async () => {
    const f = wire('same', [{ tools: [], nextCursor: cursor }, { tools: [] }]);
    const assertCurrent = vi.fn(async () => {});
    const connection: McpToolConnectionRecord = {
      id: connectionId,
      name: 'Synthetic',
      status: 'ready',
      enabled: true,
      serverName: null,
      endpoint,
      bearerTokenEncrypted: null,
      oauthGeneration: '22222222-2222-4222-8222-222222222222',
      tools: [],
    };
    await expect(
      invokeMcpTool(
        endpoint,
        second.name,
        {},
        encryptMcpBearerToken('synthetic-oauth-access'),
        f.fetchImpl,
        { connection, assertCurrent },
      ),
    ).rejects.toThrow('changed since approval');
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(f.calls()).toHaveLength(0);
  });
});
