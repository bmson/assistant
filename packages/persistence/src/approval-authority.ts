import { createHash } from 'node:crypto';
import type { Records } from './records.js';

export const MAX_APPROVAL_POLICY_SNAPSHOT_ROWS = 200;
const MAX_APPROVAL_POLICY_SNAPSHOT_BYTES = 256 * 1024;
const MAX_CANONICAL_DEPTH = 24;
interface CanonicalBudget {
  bytes: number;
  limit: number;
}

export type ApprovalPolicyAuthority = Pick<
  Records['approvalPolicies'],
  'id' | 'agentId' | 'toolName' | 'templateKey' | 'match' | 'effect' | 'version' | 'enabled'
>;

export interface ExpectedMcpApprovalBinding {
  connectionId: string;
  fingerprint: string;
}

export interface McpApprovalConnection {
  id: string;
  endpoint: string;
  bearerTokenEncrypted: string | null;
  enabled: boolean;
  status: string;
  tools: unknown;
}

function charge(budget: CanonicalBudget | undefined, bytes: number): void {
  if (!budget) return;
  budget.bytes += bytes;
  if (budget.bytes > budget.limit)
    throw new Error('Approval authority exceeded its canonicalization byte bound');
}

function canonical(value: unknown, depth = 0, budget?: CanonicalBudget): unknown {
  if (depth > MAX_CANONICAL_DEPTH) throw new Error('Approval authority exceeds the nesting bound');
  if (value === null) {
    charge(budget, 4);
    return value;
  }
  if (typeof value === 'string') {
    charge(budget, Buffer.byteLength(value, 'utf8') + 2);
    return value;
  }
  if (typeof value === 'boolean') {
    charge(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Approval authority contains a non-finite number');
    charge(budget, String(value).length);
    return value;
  }
  if (Array.isArray(value)) {
    charge(budget, 2);
    return value.map((item, index) => {
      if (index > 0) charge(budget, 1);
      return canonical(item, depth + 1, budget);
    });
  }
  if (typeof value === 'object') {
    charge(budget, 2);
    const result: Record<string, unknown> = {};
    for (const [index, key] of Object.keys(value).sort().entries()) {
      if (index > 0) charge(budget, 1);
      charge(budget, Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
      result[key] = canonical((value as Record<string, unknown>)[key], depth + 1, budget);
    }
    return result;
  }
  throw new Error('Approval authority contains a non-JSON value');
}

/** A bounded, order-independent digest of every policy row for one tool. */
export function approvalPolicyFingerprint(rows: readonly ApprovalPolicyAuthority[]): string {
  if (rows.length > MAX_APPROVAL_POLICY_SNAPSHOT_ROWS)
    throw new Error('Approval policy snapshot exceeded its row bound');
  const ordered = rows
    .map(({ id, agentId, toolName, templateKey, match, effect, version, enabled }) => ({
      id,
      agentId,
      toolName,
      templateKey,
      match,
      effect,
      version,
      enabled,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const serialized = JSON.stringify(
    canonical(ordered, 0, { bytes: 0, limit: MAX_APPROVAL_POLICY_SNAPSHOT_BYTES }),
  );
  if (Buffer.byteLength(serialized, 'utf8') > MAX_APPROVAL_POLICY_SNAPSHOT_BYTES)
    throw new Error('Approval policy snapshot exceeded its byte bound');
  return createHash('sha256').update(serialized).digest('hex');
}

const MCP_MAX_TOOLS = 80;
const MCP_MAX_TOOL_NAME = 128;
const MCP_MAX_TOOL_DESCRIPTION = 1_200;
const MCP_MAX_BINDING_BYTES = 128 * 1024;

function clipped(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function sanitizedTool(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const name = clipped(row.name, MCP_MAX_TOOL_NAME);
  if (!name || !/^[a-zA-Z0-9_.:-]+$/.test(name)) return null;
  const inputSchema =
    row.inputSchema && typeof row.inputSchema === 'object' && !Array.isArray(row.inputSchema)
      ? row.inputSchema
      : {};
  return {
    name,
    description: clipped(row.description, MCP_MAX_TOOL_DESCRIPTION) || 'No description provided.',
    inputSchema,
  };
}

/** Stable approval binding shared by the dispatcher and transactional adapters. */
export function mcpApprovalBindingFingerprint(
  connection: McpApprovalConnection,
  toolName: string,
): string | null {
  if (!connection.enabled || connection.status !== 'ready') return null;
  const source = Array.isArray(connection.tools) ? connection.tools : [];
  const tools: Record<string, unknown>[] = [];
  for (const candidate of source) {
    const tool = sanitizedTool(candidate);
    if (tool) tools.push(tool);
    if (tools.length === MCP_MAX_TOOLS) break;
  }
  const selected = tools.find((tool) => tool.name === toolName);
  if (!selected) return null;
  const serialized = JSON.stringify(
    canonical(
      {
        connectionId: connection.id,
        endpoint: connection.endpoint,
        credentials: connection.bearerTokenEncrypted,
        tool: selected,
      },
      0,
      { bytes: 0, limit: MCP_MAX_BINDING_BYTES },
    ),
  );
  if (Buffer.byteLength(serialized, 'utf8') > MCP_MAX_BINDING_BYTES) return null;
  return createHash('sha256').update(serialized).digest('hex');
}
