import { approvalRule } from '@assistant/core/approval-rule';
import type { Db, TaskRow } from '@assistant/db';
import type {
  ApprovalPolicyRepository,
  ApprovalRepository,
  CostRepository,
  ToolExecutionRepository,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { ToolDispatcher } from './dispatcher.js';
import { type McpToolConnectionRecord, registerMcpTools } from './mcp.js';
import { AmbiguousMcpMutationError } from './mcp-transport.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

const connectionId = '11111111-1111-4111-8111-111111111111';
const agentId = 'owner';
const taskId = 'task-1';
const task = {
  id: taskId,
  agentId,
  type: 'adhoc',
  status: 'running',
  trust: 'owner',
  trigger: {},
  createdAt: new Date(),
  conversationId: null,
} as unknown as TaskRow;
const baseConnection: McpToolConnectionRecord = {
  id: connectionId,
  name: 'Projects',
  status: 'ready',
  enabled: true,
  serverName: 'Projects server',
  endpoint: 'https://example.com/mcp',
  bearerTokenEncrypted: 'encrypted-test-token',
  tools: [{ name: 'projects.list', description: 'List projects', inputSchema: { type: 'object' } }],
};

function fixture() {
  let currentConnection: McpToolConnectionRecord = baseConnection;
  let transientFailure = true;
  const invoke = vi.fn(async (_endpoint, toolName, input) => ({ invoked: toolName, input }));
  const registry = registerMcpTools(
    new ToolRegistry(),
    {
      list: async () => [currentConnection],
      get: async () => {
        if (transientFailure) {
          transientFailure = false;
          throw new Error('temporary connection read failure');
        }
        return currentConnection;
      },
    },
    { invoke },
  );

  let call: Record<string, unknown> | null = null;
  let approval: Record<string, unknown> | null = null;
  let taskRecord: Record<string, unknown> = { ...task, status: 'running' };
  let claimCount = 0;
  let policies: Array<Record<string, unknown>> = [];
  const execution = {
    kind: 'tool-execution-repository',
    load: async () =>
      call
        ? {
            toolCall: call,
            task: taskRecord,
            approval,
          }
        : null,
    outcome: async ({
      status,
      error,
      result,
    }: {
      status: string;
      error?: string;
      result?: unknown;
    }) => {
      if (!call) return false;
      call = { ...call, status, error: error ?? null, result };
      return true;
    },
    claim: async () => {
      claimCount++;
      if (call?.status !== 'approved' || taskRecord.status !== 'running') return null;
      call = { ...call, status: 'executing' };
      return { toolCall: call, task: taskRecord, approval };
    },
  } as unknown as ToolExecutionRepository;
  const approvalRepo = {
    kind: 'approval-repository',
    create: async (input: Record<string, unknown>) => {
      call = {
        id: 'call-1',
        taskId,
        status: 'awaiting_approval',
        toolName: input.toolName,
        args: input.args,
        decision: input.decision,
        step: input.step,
        approvalId: 'approval-1',
        result: null,
      };
      approval = {
        id: 'approval-1',
        status: 'pending',
        taskId,
        toolCallId: 'call-1',
        resolutionPayload: null,
      };
      return { toolCallId: 'call-1', approvalId: 'approval-1', shortCode: 'A1' };
    },
  } as unknown as ApprovalRepository;
  const policyRepo = {
    kind: 'approval-policy-repository',
    list: async () => policies,
  } as unknown as ApprovalPolicyRepository;
  const costRepo = {} as CostRepository;
  const dispatcher = new ToolDispatcher(
    {} as Db,
    registry,
    execution,
    costRepo,
    approvalRepo,
    policyRepo,
  );
  const ctx: ToolContext = {
    agentId,
    taskId,
    trust: 'owner',
    tainted: false,
    db: {} as Db,
    now: () => new Date(),
    signal: new AbortController().signal,
    log: async () => {},
  };
  return {
    dispatcher,
    ctx,
    invoke,
    setConnection(value: McpToolConnectionRecord) {
      currentConnection = value;
    },
    setTaskStatus(status: string) {
      taskRecord = { ...taskRecord, status };
    },
    setTaskTrust(trust: string) {
      taskRecord = { ...taskRecord, trust };
    },
    setPolicies(rows: Array<Record<string, unknown>>) {
      policies = rows;
    },
    getCall: () => call,
    getClaimCount: () => claimCount,
    approveCurrentCall() {
      if (call) call = { ...call, status: 'approved' };
      if (approval) approval = { ...approval, status: 'approved' };
    },
  };
}

async function dispatch(f: ReturnType<typeof fixture>) {
  return f.dispatcher.dispatch({
    task,
    step: 1,
    toolName: 'mcp.call',
    args: { connectionId, toolName: 'projects.list', arguments: {} },
    ctx: f.ctx,
    provenance: { plannerVersion: 1, promptVersion: 1, model: 'test/model' },
  });
}

describe('dispatcher and MCP authority binding', () => {
  it('fails closed on transient preparation, changed bindings, and legacy unbound approvals', async () => {
    const f = fixture();
    expect(await dispatch(f)).toMatchObject({ kind: 'rejected' });
    expect(f.getCall()).toBeNull();
    expect(f.invoke).not.toHaveBeenCalled();

    const parked = await dispatch(f);
    expect(parked).toMatchObject({ kind: 'awaiting_approval' });
    f.approveCurrentCall();
    expect(f.invoke).not.toHaveBeenCalled();
    f.setConnection({ ...baseConnection, endpoint: 'https://changed.example.com/mcp' });
    const changed = await f.dispatcher.executeApproved('call-1', f.ctx);
    expect(changed).toMatchObject({ kind: 'failed' });
    expect(f.getClaimCount()).toBe(0);
    expect(f.invoke).not.toHaveBeenCalled();

    // An older stored call can omit the internal binding; schema parsing must
    // not turn that omission into a newly authorized target.
    const legacy = f.getCall();
    if (!legacy) throw new Error('expected stored approval');
    legacy.args = { connectionId, toolName: 'projects.list', arguments: {} };
    f.setConnection(baseConnection);
    const unbound = await f.dispatcher.executeApproved('call-1', f.ctx);
    expect(unbound).toMatchObject({ kind: 'failed' });
    expect(f.getClaimCount()).toBe(0);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('rechecks hard denies and cancellation before claiming, then executes a fresh bound grant', async () => {
    const f = fixture();
    expect(await dispatch(f)).toMatchObject({ kind: 'rejected' });
    const parked = await dispatch(f);
    expect(parked).toMatchObject({ kind: 'awaiting_approval' });
    f.approveCurrentCall();
    const args = f.getCall()?.args as Record<string, unknown>;
    const rule = approvalRule('mcp.call', args);
    if (!rule) throw new Error('expected MCP named-tool policy template');
    f.setPolicies([
      {
        id: 'deny-1',
        agentId,
        toolName: 'mcp.call',
        effect: 'deny',
        templateKey: rule.templateKey,
        match: rule.match,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      },
    ]);
    expect(await f.dispatcher.executeApproved('call-1', f.ctx)).toMatchObject({ kind: 'failed' });
    expect(f.getClaimCount()).toBe(0);
    expect(f.invoke).not.toHaveBeenCalled();

    // Clear the deny, create a new approval against the current target and
    // fence task cancellation at the repository claim boundary.
    f.setPolicies([]);
    const second = await dispatch(f);
    expect(second).toMatchObject({ kind: 'awaiting_approval' });
    f.approveCurrentCall();
    f.setTaskTrust('unknown');
    expect(await f.dispatcher.executeApproved('call-1', f.ctx)).toMatchObject({ kind: 'failed' });
    expect(f.getClaimCount()).toBe(0);
    expect(f.invoke).not.toHaveBeenCalled();

    f.setTaskTrust('owner');
    const reapproved = await dispatch(f);
    expect(reapproved).toMatchObject({ kind: 'awaiting_approval' });
    f.approveCurrentCall();
    f.setTaskStatus('cancelled');
    expect(await f.dispatcher.executeApproved('call-1', f.ctx)).toMatchObject({ kind: 'failed' });
    expect(f.getClaimCount()).toBe(0);
    expect(f.invoke).not.toHaveBeenCalled();

    f.setTaskStatus('running');
    const third = await dispatch(f);
    expect(third).toMatchObject({ kind: 'awaiting_approval' });
    f.approveCurrentCall();
    expect(await f.dispatcher.executeApproved('call-1', f.ctx)).toMatchObject({ kind: 'executed' });
    expect(f.getClaimCount()).toBe(1);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
});

it('persists an unknown MCP effect and replays the same approval without repeating the action', async () => {
  const f = fixture();
  await dispatch(f); // transient fixture read failure
  expect(await dispatch(f)).toMatchObject({ kind: 'awaiting_approval' });
  f.approveCurrentCall();
  f.invoke.mockRejectedValueOnce(new AmbiguousMcpMutationError());
  const first = await f.dispatcher.executeApproved('call-1', f.ctx);
  expect(first).toMatchObject({
    kind: 'executed',
    result: { deliveryStatus: 'unknown', retrySuppressed: true },
  });
  expect(f.getCall()).toMatchObject({ status: 'succeeded', result: { deliveryStatus: 'unknown' } });
  const replay = await f.dispatcher.executeApproved('call-1', f.ctx);
  expect(replay).toMatchObject({
    kind: 'executed',
    result: { deliveryStatus: 'unknown', retrySuppressed: true },
  });
  expect(f.invoke).toHaveBeenCalledTimes(1);
});
