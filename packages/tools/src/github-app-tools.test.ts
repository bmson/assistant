import type { Db } from '@assistant/db';
import { describe, expect, it, vi } from 'vitest';
import { type GitHubAppSelection, registerGitHubAppTools } from './github-app-tools.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

const prTool = 'github.get_pull_request';
const localTool = 'github.list_selected_repositories';
const pullRequest = {
  repositoryId: 100,
  number: 17,
  title: 'Synthetic title',
  state: 'open' as const,
  draft: false,
  merged: false,
  updatedAt: '2026-11-18T12:00:00Z',
  url: 'https://github.com/example/synthetic/pull/17',
};

function fixture(ids: number[] = [100]) {
  let selection: GitHubAppSelection | null = {
    appClientId: 'Iv1.synthetic',
    installationId: 2,
    selectedRepositoryIds: ids,
  };
  const controller = new AbortController();
  const ctx: ToolContext = {
    taskId: 'task',
    agentId: 'owner',
    trust: 'owner',
    tainted: false,
    db: {} as Db,
    now: () => new Date(),
    signal: controller.signal,
    log: async () => {},
  };
  const getPullRequest = vi.fn(async () => pullRequest);
  const getRepository = vi.fn();
  const resolveOwner = vi.fn(async () => 'owner');
  const loadReader = vi.fn(async () =>
    selection ? { selection, reader: { getPullRequest, getRepository } } : null,
  );
  const registry = registerGitHubAppTools(new ToolRegistry(), {
    resolveOwner,
    selection: () => selection,
    loadReader,
  });
  const tool = registry.get(prTool)?.tool;
  if (!tool?.prepareSecurity) throw new Error('Expected GitHub PR tool security preparation');
  const prepare = tool.prepareSecurity;
  const executing: ToolContext = {
    ...ctx,
    execution: { toolName: prTool, dbToolCallId: 'call', modelToolCallId: 'model-call' },
  };
  return {
    registry,
    tool,
    prepare,
    ctx,
    executing,
    loadReader,
    getPullRequest,
    resolveOwner,
    controller,
    setSelection(value: GitHubAppSelection | null) {
      selection = value;
    },
  };
}

describe('agent GitHub tools', () => {
  it('shows the owner only their local IDs without loading the signing key or contacting GitHub', async () => {
    const f = fixture([100, 200]);
    const catalog = f.registry.get(localTool)?.tool;
    expect(await catalog?.execute({}, f.ctx)).toEqual({ repositoryIds: [100, 200] });
    for (const trust of ['known', 'unknown', 'assistant'] as const) {
      expect(f.registry.toolsForTask(trust)).toEqual([]);
      await expect(catalog?.execute({}, { ...f.ctx, trust })).rejects.toThrow('configured owner');
    }
    f.resolveOwner.mockResolvedValue('another-owner');
    await expect(catalog?.execute({}, f.ctx)).rejects.toThrow('configured owner');
    expect(f.loadReader).not.toHaveBeenCalled();
    expect(f.getPullRequest).not.toHaveBeenCalled();
  });

  it('resolves a single repo locally and requires exact execution authority before loading the reader', async () => {
    const f = fixture();
    const args = await f.prepare({ pullRequestNumber: 17 }, f.ctx, 'dispatch');
    expect(args).toMatchObject({ repositoryId: 100, pullRequestNumber: 17 });
    expect(f.tool.approvalSummary?.(args)).toBe(
      'Read GitHub pull request #17 (repository ID 100).',
    );
    expect(f.registry.resultIsUntrusted(prTool)).toBe(true);
    expect(f.registry.smsApprovable(prTool)).toBe(false);
    await expect(f.tool.execute(args, f.ctx)).rejects.toThrow('explicit approval');
    expect(f.loadReader).not.toHaveBeenCalled();
    expect(await f.tool.execute(args, f.executing)).toEqual(pullRequest);
    expect(f.getPullRequest).toHaveBeenCalledExactlyOnceWith(100, 17, f.ctx.signal);
  });

  it('refuses to guess among multiple repositories or approve an unselected one', async () => {
    const f = fixture([100, 200]);
    await expect(f.prepare({ pullRequestNumber: 17 }, f.ctx, 'dispatch')).rejects.toThrow(
      'Choose one',
    );
    await expect(
      f.prepare({ repositoryId: 301, pullRequestNumber: 17 }, f.ctx, 'dispatch'),
    ).rejects.toThrow('not selected');
    expect(f.loadReader).not.toHaveBeenCalled();
  });

  it.each(['selection', 'owner', 'abort'] as const)(
    'discards a provider result when %s changes in flight',
    async (change) => {
      const f = fixture();
      const args = await f.prepare({ pullRequestNumber: 17 }, f.ctx, 'dispatch');
      f.getPullRequest.mockImplementationOnce(async () => {
        if (change === 'selection') f.setSelection(null);
        if (change === 'owner') f.resolveOwner.mockResolvedValue('another-owner');
        if (change === 'abort') f.controller.abort();
        return pullRequest;
      });
      await expect(f.tool.execute(args, f.executing)).rejects.toThrow(
        /configured owner|unavailable/,
      );
      expect(f.getPullRequest).toHaveBeenCalledOnce();
    },
  );

  it('rejects an installation switch during local credential loading before contacting GitHub', async () => {
    const f = fixture();
    const args = await f.prepare({ pullRequestNumber: 17 }, f.ctx, 'dispatch');
    f.loadReader.mockImplementationOnce(async () => {
      const selection = {
        appClientId: 'Iv1.synthetic',
        installationId: 3,
        selectedRepositoryIds: [100],
      };
      return { selection, reader: { getPullRequest: f.getPullRequest, getRepository: vi.fn() } };
    });
    await expect(f.tool.execute(args, f.executing)).rejects.toThrow('scope changed');
    expect(f.getPullRequest).not.toHaveBeenCalled();
  });
});
