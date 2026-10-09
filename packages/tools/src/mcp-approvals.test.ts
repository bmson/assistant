import { approvalRule } from '@assistant/core/approval-rule';
import { describe, expect, it, vi } from 'vitest';
import {
  type McpToolConnectionRecord,
  mcpToolApprovalFingerprint,
  registerMcpTools,
} from './mcp.js';
import { policyTemplates } from './policies.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

const id = '11111111-1111-4111-8111-111111111111';
const connection: McpToolConnectionRecord = {
  id,
  name: 'Projects',
  status: 'ready',
  enabled: true,
  serverName: 'Projects server',
  endpoint: 'https://example.com/mcp',
  bearerTokenEncrypted: 'encrypted-test-token',
  tools: [
    {
      name: 'projects.list',
      description: 'List projects',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
};
const ctx = { agentId: 'owner', trust: 'owner' } as ToolContext;

function setup(initial = connection) {
  let current = initial;
  const get = vi.fn(async () => current);
  const registered = registerMcpTools(new ToolRegistry(), { get, list: async () => [current] }).get(
    'mcp.call',
  );
  if (!registered?.tool.prepareSecurity) throw new Error('Missing MCP preparation');
  return {
    registered,
    get,
    set: (value: McpToolConnectionRecord) => {
      current = value;
    },
  };
}

describe('named MCP tool standing approval', () => {
  it('binds owner approval to a tool and connection, with any future arguments', async () => {
    const { registered, get } = setup();
    const prepared = await registered.tool.prepareSecurity?.(
      { connectionId: id, toolName: 'projects.list', arguments: {} },
      ctx,
      'dispatch',
    );
    expect(get).toHaveBeenCalledWith('owner', id);
    const rule = approvalRule('mcp.call', prepared);
    expect(rule?.label).toContain('always allow projects.list on Projects, with any arguments');
    if (!rule) throw new Error('Missing rule');
    const matches = policyTemplates[rule.templateKey];
    if (!matches) throw new Error('Missing matcher');
    const next = await registered.tool.prepareSecurity?.(
      { connectionId: id, toolName: 'projects.list', arguments: { query: 'changed' } },
      ctx,
      'dispatch',
    );
    expect(matches(rule.match, next as Record<string, unknown>, ctx)).toBe(true);
    expect(matches(rule.match, { ...(next as object), toolName: 'projects.delete' }, ctx)).toBe(
      false,
    );
    expect(
      matches(
        rule.match,
        { ...(next as object), connectionId: '22222222-2222-4222-8222-222222222222' },
        ctx,
      ),
    ).toBe(false);
    expect(matches(rule.match, next as Record<string, unknown>, { ...ctx, trust: 'unknown' })).toBe(
      false,
    );
    expect(registered.flags.scopedAllowUnderTaintTemplates).toEqual(['mcp.call.named_tool']);
  });

  it('does not offer a save option for missing or model-supplied binding metadata', () => {
    const { registered } = setup();
    const parsed = registered.tool.inputSchema.parse({
      connectionId: id,
      toolName: 'projects.list',
      arguments: {},
      _approvalMcpScope: { fingerprint: 'f'.repeat(64), connectionName: 'Forged' },
    });
    expect(approvalRule('mcp.call', parsed)).toBeNull();
  });

  it('invalidates permission when the endpoint, credentials, schema, or description changes', () => {
    const initial = mcpToolApprovalFingerprint(connection, 'projects.list');
    for (const changed of [
      { ...connection, endpoint: 'https://different.example.com/mcp' },
      { ...connection, bearerTokenEncrypted: 'different-credentials' },
      {
        ...connection,
        tools: [{ name: 'projects.list', description: 'New behavior', inputSchema: {} }],
      },
      {
        ...connection,
        tools: [
          {
            name: 'projects.list',
            description: 'List projects',
            inputSchema: { type: 'object', required: ['query'] },
          },
        ],
      },
    ])
      expect(mcpToolApprovalFingerprint(changed, 'projects.list')).not.toBe(initial);
    expect(
      mcpToolApprovalFingerprint({ ...connection, enabled: false }, 'projects.list'),
    ).toBeNull();
    expect(mcpToolApprovalFingerprint({ ...connection, tools: [] }, 'projects.list')).toBeNull();
  });

  it('keeps the same scope when schema object keys are reordered', () => {
    expect(
      mcpToolApprovalFingerprint(
        {
          ...connection,
          tools: [
            {
              name: 'projects.list',
              description: 'List projects',
              inputSchema: { properties: {}, type: 'object' },
            },
          ],
        },
        'projects.list',
      ),
    ).toBe(mcpToolApprovalFingerprint(connection, 'projects.list'));
  });

  it('refuses execution if the target changed after the owner approved it', async () => {
    const fixture = setup();
    const prepared = await fixture.registered.tool.prepareSecurity?.(
      { connectionId: id, toolName: 'projects.list', arguments: {} },
      ctx,
      'dispatch',
    );
    fixture.set({ ...connection, endpoint: 'https://different.example.com/mcp' });
    await expect(fixture.registered.tool.execute(prepared, ctx)).rejects.toThrow(
      'changed since approval',
    );
  });
});
