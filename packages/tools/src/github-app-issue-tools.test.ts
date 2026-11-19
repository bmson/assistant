import { approvalRule } from '@assistant/core/approval-rule';
import type { Db, TaskRow } from '@assistant/db';
import type {
  ApprovalPolicyRepository,
  ApprovalRepository,
  CostRepository,
  ToolExecutionRepository,
} from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatcher } from './dispatcher.js';
import { GitHubAppIssueCreateError } from './github-app-issue-creator.js';
import { registerGitHubAppIssueTools } from './github-app-issue-tools.js';
import type { GitHubAppSelection } from './github-app-tools.js';
import { policyTemplates } from './policies.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

const NAME = 'github.create_issue';
const input = {
  repositoryFullName: 'example/synthetic',
  title: 'Synthetic issue',
  body: 'Exact paragraph one.\n\n  Exact paragraph two.\n',
};
const confirmed = {
  repositoryId: 100,
  repositoryFullName: input.repositoryFullName,
  id: 1234,
  number: 17,
  title: input.title,
  body: input.body,
  state: 'open' as const,
  url: 'https://github.com/example/synthetic/issues/17',
  verified: true as const,
};
function fixture(enabled = true, ids = [100]) {
  let active = enabled;
  let selection: GitHubAppSelection | null = {
    appClientId: 'Iv1.synthetic',
    installationId: 42,
    selectedRepositoryIds: ids,
  };
  const controller = new AbortController();
  const ctx: ToolContext = {
    agentId: 'owner',
    taskId: 'synthetic-task',
    trust: 'owner',
    tainted: false,
    db: {} as Db,
    now: () => new Date(),
    signal: controller.signal,
    log: async () => {},
  };
  const resolveOwner = vi.fn(async () => 'owner');
  const createIssue = vi.fn(
    async (
      _id: number,
      _input: typeof input,
      _signal?: AbortSignal,
      preflight?: () => Promise<void>,
    ) => {
      await preflight?.();
      return confirmed;
    },
  );
  const loadCreator = vi.fn(async () =>
    selection ? { selection, creator: { createIssue } } : null,
  );
  const registry = registerGitHubAppIssueTools(new ToolRegistry(), {
    enabled: () => active,
    resolveOwner,
    selection: () => selection,
    loadCreator,
  });
  const tool = registry.get(NAME)?.tool;
  const executing = {
    ...ctx,
    execution: { toolName: NAME, dbToolCallId: 'call-1', modelToolCallId: 'model-1' },
  };
  return {
    registry,
    tool,
    ctx,
    executing,
    createIssue,
    loadCreator,
    resolveOwner,
    controller,
    disable: () => {
      active = false;
    },
    select: (value: GitHubAppSelection | null) => {
      selection = value;
    },
  };
}
function dispatcherFixture(f: ReturnType<typeof fixture>, allowPolicy = false) {
  const task = {
    id: f.ctx.taskId,
    agentId: f.ctx.agentId,
    type: 'adhoc',
    status: 'running',
    trust: 'owner',
    trigger: {},
    conversationId: null,
    createdAt: new Date(),
  } as unknown as TaskRow;
  const calls = new Map<string, Record<string, unknown>>();
  const approvals = new Map<string, Record<string, unknown>>();
  let claims = 0;
  const execution = {
    kind: 'tool-execution-repository',
    load: async (_owner: string, _task: string, id: string) => {
      const toolCall = calls.get(id);
      return toolCall ? { toolCall, task, approval: approvals.get(id) } : null;
    },
    outcome: async (request: {
      toolCallId: string;
      status: string;
      result?: unknown;
      error?: unknown;
    }) => {
      const row = calls.get(request.toolCallId);
      if (!row) return false;
      calls.set(request.toolCallId, {
        ...row,
        status: request.status,
        result: request.result,
        error: request.error ?? null,
      });
      return true;
    },
    claim: async (request: { toolCallId: string }) => {
      claims++;
      const row = calls.get(request.toolCallId);
      if (row?.status !== 'approved') return null;
      const toolCall = { ...row, status: 'executing' };
      calls.set(request.toolCallId, toolCall);
      return { toolCall, task, approval: approvals.get(request.toolCallId) };
    },
  } as unknown as ToolExecutionRepository;
  const approvalRepo = {
    kind: 'approval-repository',
    create: async (request: Record<string, unknown>) => {
      const id = `call-${calls.size + 1}`;
      calls.set(id, {
        id,
        taskId: task.id,
        status: 'awaiting_approval',
        toolName: request.toolName,
        args: request.args,
        decision: request.decision,
        step: request.step,
        approvalId: `approval-${id}`,
        result: null,
      });
      approvals.set(id, {
        id: `approval-${id}`,
        status: 'pending',
        taskId: task.id,
        toolCallId: id,
        resolutionPayload: null,
      });
      return {
        toolCallId: id,
        approvalId: `approval-${id}`,
        shortCode: 'A1',
        summary: request.summary,
      };
    },
  } as unknown as ApprovalRepository;
  const policyRepo = {
    kind: 'approval-policy-repository',
    list: async () =>
      allowPolicy
        ? [
            {
              id: 'legacy-blanket',
              agentId: task.agentId,
              toolName: NAME,
              templateKey: 'test.issue.always',
              version: 1,
              match: {},
              effect: 'allow',
              enabled: true,
            },
          ]
        : [],
  } as unknown as ApprovalPolicyRepository;
  const dispatcher = new ToolDispatcher(
    f.ctx.db,
    f.registry,
    execution,
    {} as CostRepository,
    approvalRepo,
    policyRepo,
  );
  return {
    calls,
    approvals,
    claims: () => claims,
    dispatch: (args = input, step = 1) =>
      dispatcher.dispatch({
        task,
        step,
        toolName: NAME,
        args,
        ctx: f.ctx,
        modelToolCallId: `model-${step}`,
        provenance: { plannerVersion: 1, promptVersion: 1, model: 'test/model' },
      }),
    approve: (id: string, payload?: Record<string, unknown>) => {
      const row = calls.get(id);
      const approval = approvals.get(id);
      if (!row || !approval) throw new Error('Missing approval');
      calls.set(id, { ...row, status: 'approved' });
      approvals.set(id, { ...approval, status: 'approved', resolutionPayload: payload ?? null });
    },
    execute: (id: string) => dispatcher.executeApproved(id, f.ctx),
  };
}
afterEach(() => {
  delete policyTemplates['test.issue.always'];
});

describe('owner-approved GitHub issue tool', () => {
  it('is absent while disabled and never opens credentials or contacts a provider', () => {
    const f = fixture(false);
    expect(f.registry.all()).toEqual([]);
    expect(f.loadCreator).not.toHaveBeenCalled();
    expect(f.createIssue).not.toHaveBeenCalled();
  });
  it('binds and shows full exact repository, title and 8000-character body without rewriting', async () => {
    const f = fixture();
    const body = '  paragraph\n'.repeat(666).padEnd(8_000, ' ');
    const args = await f.tool?.prepareSecurity?.({ ...input, body }, f.ctx, 'dispatch');
    expect(args).toMatchObject({ repositoryId: 100, body });
    const summary = f.tool?.approvalSummary?.(args);
    expect(summary).toBe(
      `Create GitHub issue in ${input.repositoryFullName} (repository ID 100).\nTitle: ${input.title}\nBody:\n${body}`,
    );
    expect(f.tool?.inputSchema.safeParse({ ...input, body: 'x'.repeat(8_001) }).success).toBe(
      false,
    );
    expect(approvalRule(NAME, args)).toBeNull();
    expect(f.registry.get(NAME)?.flags).toMatchObject({
      ownerOnly: true,
      outwardFacing: true,
      blanketAllowIneligible: true,
      autonomyFloor: true,
    });
    expect(f.registry.get(NAME)?.flags.scopedAllowTemplates).toBeUndefined();
    expect(f.registry.smsApprovable(NAME)).toBe(false);
  });
  it('strips model-forged binding and requires a unique selected repository', async () => {
    const f = fixture(true, [100, 200]);
    expect(
      f.tool?.inputSchema.parse({ ...input, _approvalGitHubIssueScope: 'forged' }),
    ).not.toHaveProperty('_approvalGitHubIssueScope');
    await expect(f.tool?.prepareSecurity?.(input, f.ctx, 'dispatch')).rejects.toThrow('Choose one');
    await expect(
      f.tool?.prepareSecurity?.({ ...input, repositoryId: 300 }, f.ctx, 'dispatch'),
    ).rejects.toThrow('not selected');
    expect(f.loadCreator).not.toHaveBeenCalled();
  });
  it.each(['repositoryId', 'repositoryFullName', 'title', 'body'] as const)(
    'rejects modified approved %s before opening credentials',
    async (field) => {
      const f = fixture(true, [100, 200]);
      const args = await f.tool?.prepareSecurity?.(
        { ...input, repositoryId: 100 },
        f.ctx,
        'dispatch',
      );
      const changed = { ...(args as object), [field]: field === 'repositoryId' ? 200 : 'changed' };
      await expect(f.tool?.execute(changed, f.executing)).rejects.toThrow('changed');
      expect(f.loadCreator).not.toHaveBeenCalled();
    },
  );
  it('requires dispatcher execution and fences disabled, untrusted, changed owner and changed installation', async () => {
    const f = fixture();
    const args = await f.tool?.prepareSecurity?.(input, f.ctx, 'dispatch');
    await expect(f.tool?.execute(args, f.ctx)).rejects.toThrow('explicit approval');
    await expect(f.tool?.execute(args, { ...f.executing, trust: 'unknown' })).rejects.toThrow(
      'configured owner',
    );
    f.resolveOwner.mockResolvedValue('another-owner');
    await expect(f.tool?.execute(args, f.executing)).rejects.toThrow('configured owner');
    f.resolveOwner.mockResolvedValue('owner');
    f.select({ appClientId: 'Iv1.synthetic', installationId: 43, selectedRepositoryIds: [100] });
    await expect(f.tool?.execute(args, f.executing)).rejects.toThrow('changed');
    f.disable();
    await expect(f.tool?.execute(args, f.executing)).rejects.toThrow('disabled');
    expect(f.createIssue).not.toHaveBeenCalled();
  });
  it('rechecks scope after asynchronous creator loading and before the write', async () => {
    const f = fixture();
    const args = await f.tool?.prepareSecurity?.(input, f.ctx, 'dispatch');
    f.loadCreator.mockImplementationOnce(async () => {
      f.select(null);
      return {
        selection: {
          appClientId: 'Iv1.synthetic',
          installationId: 42,
          selectedRepositoryIds: [100],
        },
        creator: { createIssue: f.createIssue },
      };
    });
    await expect(f.tool?.execute(args, f.executing)).rejects.toThrow('unavailable');
    expect(f.createIssue).not.toHaveBeenCalled();
  });
  it('rechecks the owner/flag callback immediately before provider submission', async () => {
    const f = fixture();
    const args = await f.tool?.prepareSecurity?.(input, f.ctx, 'dispatch');
    f.createIssue.mockImplementationOnce(async (_id, _input, _signal, preflight) => {
      f.disable();
      await preflight?.();
      throw new Error('must not submit');
    });
    await expect(f.tool?.execute(args, f.executing)).rejects.toThrow('disabled');
  });
  it('returns unknown rather than a created issue when authority changes after a completed write', async () => {
    const f = fixture();
    const args = await f.tool?.prepareSecurity?.(input, f.ctx, 'dispatch');
    f.createIssue.mockImplementationOnce(async () => {
      f.resolveOwner.mockResolvedValue('another-owner');
      return confirmed;
    });
    expect(await f.tool?.execute(args, f.executing)).toMatchObject({
      deliveryStatus: 'unknown',
      retrySuppressed: true,
    });
  });
  it('creates only after fresh approval despite a legacy blanket allow policy, and replays without another write', async () => {
    const f = fixture();
    policyTemplates['test.issue.always'] = () => true;
    const d = dispatcherFixture(f, true);
    const parked = await d.dispatch();
    if (parked.kind !== 'awaiting_approval') throw new Error(JSON.stringify(parked));
    expect(f.createIssue).not.toHaveBeenCalled();
    d.approve('call-1');
    expect(await d.execute('call-1')).toMatchObject({ kind: 'executed', result: confirmed });
    expect(await d.execute('call-1')).toMatchObject({ kind: 'executed', result: confirmed });
    expect(f.createIssue).toHaveBeenCalledExactlyOnceWith(
      100,
      input,
      f.ctx.signal,
      expect.any(Function),
    );
    expect(d.claims()).toBe(1);
  });
  it('rejects edited approval content instead of inheriting the old fingerprint', async () => {
    const f = fixture();
    const d = dispatcherFixture(f);
    await d.dispatch();
    d.approve('call-1', { ...input, repositoryId: 100, body: 'Edited' });
    expect(await d.execute('call-1')).toMatchObject({ kind: 'failed' });
    expect(f.createIssue).not.toHaveBeenCalled();
    expect(d.claims()).toBe(0);
  });
  it('persists an uncertain write as unknown and suppresses same-approval replay', async () => {
    const f = fixture();
    const d = dispatcherFixture(f);
    f.createIssue.mockRejectedValueOnce(new GitHubAppIssueCreateError('outcome_unknown'));
    await d.dispatch();
    d.approve('call-1');
    const expected = {
      kind: 'executed',
      result: { deliveryStatus: 'unknown', retrySuppressed: true },
    };
    expect(await d.execute('call-1')).toMatchObject(expected);
    expect(await d.execute('call-1')).toMatchObject(expected);
    expect(f.createIssue).toHaveBeenCalledOnce();
    expect(d.claims()).toBe(1);
    expect(d.calls.get('call-1')?.result).not.toHaveProperty('verified');
    expect(await d.dispatch(input, 2)).toMatchObject({ kind: 'awaiting_approval' });
    expect(f.createIssue).toHaveBeenCalledOnce();
    expect(d.calls.get('call-2')?.status).toBe('awaiting_approval');
  });
});
