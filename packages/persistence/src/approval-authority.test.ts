import { describe, expect, it } from 'vitest';
import {
  approvalPolicyFingerprint,
  MAX_APPROVAL_POLICY_SNAPSHOT_ROWS,
  mcpApprovalBindingFingerprint,
} from './approval-authority.js';

const policy = (id: string, enabled: boolean) => ({
  id,
  agentId: 'owner',
  toolName: 'gmail.send',
  templateKey: 'gmail.send.to_recipient',
  match: { recipient: 'owner@example.com' },
  effect: 'deny' as const,
  version: 1,
  enabled,
});

describe('approval authority snapshots', () => {
  it('canonicalizes row order while retaining enabled state', () => {
    const disabled = policy('policy-a', false);
    const other = policy('policy-b', true);
    expect(approvalPolicyFingerprint([disabled, other])).toBe(
      approvalPolicyFingerprint([other, disabled]),
    );
    expect(approvalPolicyFingerprint([disabled])).not.toBe(
      approvalPolicyFingerprint([policy('policy-a', true)]),
    );
  });

  it('rejects an overfull or oversized policy snapshot', () => {
    const rows = Array.from({ length: MAX_APPROVAL_POLICY_SNAPSHOT_ROWS + 1 }, (_, index) =>
      policy(`policy-${index}`, false),
    );
    expect(() => approvalPolicyFingerprint(rows)).toThrow('row bound');
    expect(() =>
      approvalPolicyFingerprint([
        { ...policy('large', true), match: { note: 'x'.repeat(300_000) } },
      ]),
    ).toThrow('byte bound');
  });

  it('binds MCP approval to the selected connection, endpoint, credentials, and tool schema', () => {
    const connection = {
      id: 'connection-1',
      endpoint: 'https://example.invalid/mcp',
      bearerTokenEncrypted: 'encrypted-a',
      enabled: true,
      status: 'ready',
      tools: [{ name: 'items.list', description: 'List items', inputSchema: { type: 'object' } }],
    };
    const fingerprint = mcpApprovalBindingFingerprint(connection, 'items.list');
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      mcpApprovalBindingFingerprint(
        { ...connection, endpoint: 'https://changed.invalid/mcp' },
        'items.list',
      ),
    ).not.toBe(fingerprint);
    expect(
      mcpApprovalBindingFingerprint(
        { ...connection, bearerTokenEncrypted: 'encrypted-b' },
        'items.list',
      ),
    ).not.toBe(fingerprint);
    expect(
      mcpApprovalBindingFingerprint(
        {
          ...connection,
          tools: [{ ...connection.tools[0], inputSchema: { type: 'object', required: ['id'] } }],
        },
        'items.list',
      ),
    ).not.toBe(fingerprint);
    expect(
      mcpApprovalBindingFingerprint({ ...connection, enabled: false }, 'items.list'),
    ).toBeNull();
  });
});
