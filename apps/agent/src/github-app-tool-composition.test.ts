import { randomUUID } from 'node:crypto';
import {
  assertFirestoreInstallationOwner,
  FirestoreApprovalPolicyRepository,
  FirestoreApprovalRepository,
  FirestoreCostRepository,
  FirestoreToolExecutionRepository,
} from '@assistant/firestore';
import { type ToolContext, ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { expect, it, vi } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { registerConfiguredGitHubAppTools } from './deps.js';

const config = { RESTORE_REHEARSAL: false, ASSISTANT_RELEASE_WRITES_PAUSED: false };
const provider = vi.hoisted(() => ({
  selection: vi.fn(),
  loadReader: vi.fn(),
  loadCreator: vi.fn(),
  createIssue: vi.fn(),
  readPullRequest: vi.fn(),
}));
vi.mock('@assistant/tools/github-app-issue-creator-config', () => ({
  configuredGitHubAppIssueCreator: provider.loadCreator,
}));
vi.mock('@assistant/tools/github-app-reader-config', () => ({
  configuredGitHubAppSelection: provider.selection,
  configuredGitHubAppReader: provider.loadReader,
}));

const selection = {
  appClientId: 'Iv1.synthetic',
  installationId: 42,
  selectedRepositoryIds: [100],
};

it('keeps GitHub tools out of the existing registry when missing configuration or in a held runtime', () => {
  const registry = new ToolRegistry();
  const resolveOwner = vi.fn();
  provider.selection.mockReturnValue(null);
  expect(registerConfiguredGitHubAppTools(registry, config, resolveOwner)).toBe(registry);
  expect(registry.all()).toEqual([]);
  provider.selection.mockReturnValue(selection);
  for (const hold of ['RESTORE_REHEARSAL', 'ASSISTANT_RELEASE_WRITES_PAUSED'] as const) {
    registerConfiguredGitHubAppTools(registry, { ...config, [hold]: true }, resolveOwner);
    expect(registry.all()).toEqual([]);
  }
  expect(resolveOwner).not.toHaveBeenCalled();
  expect(provider.loadReader).not.toHaveBeenCalled();
});

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'binds a GitHub approval through Firestore and blocks a conflicting owner before a second read',
  async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const taskId = randomUUID();
    provider.selection.mockReturnValue(selection);
    provider.loadReader.mockResolvedValue({
      selection,
      getPullRequest: provider.readPullRequest,
      getRepository: vi.fn(),
    });
    provider.readPullRequest.mockResolvedValue({
      repositoryId: 100,
      number: 17,
      title: 'Synthetic',
    });
    try {
      await store.doc('agents', agentId).set({ id: agentId });
      const task = {
        id: taskId,
        agentId,
        type: 'adhoc' as const,
        trust: 'owner' as const,
        status: 'running' as const,
        createdAt: new Date(),
        trigger: null,
        conversationId: null,
        goalId: null,
      };
      await store.doc('tasks', taskId).set(task);
      const registry = registerConfiguredGitHubAppTools(new ToolRegistry(), config, () =>
        assertFirestoreInstallationOwner(store, agentId),
      );
      const db = new Proxy({} as ToolContext['db'], {
        get(_target, property) {
          throw new Error(`Unexpected PostgreSQL access: ${String(property)}`);
        },
      });
      const approvals = new FirestoreApprovalRepository(store);
      const dispatcher = new ToolDispatcher(
        db,
        registry,
        new FirestoreToolExecutionRepository(store),
        new FirestoreCostRepository(store),
        approvals,
        new FirestoreApprovalPolicyRepository(store),
      );
      const ctx: ToolContext = {
        taskId,
        agentId,
        trust: 'owner',
        tainted: false,
        db,
        now: () => new Date(),
        signal: new AbortController().signal,
        log: async () => {},
      };
      async function park(step: number) {
        const result = await dispatcher.dispatch({
          task: task as never,
          step,
          toolName: 'github.get_pull_request',
          args: { pullRequestNumber: 17 },
          ctx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        if (result.kind !== 'awaiting_approval')
          throw new Error(`Expected approval, got ${JSON.stringify(result)}`);
        const resolved = await approvals.resolve({
          approvalId: result.approvalId,
          decision: 'approved',
          via: 'web',
          deferNotification: true,
        });
        expect(resolved.ok).toBe(true);
        return result;
      }
      const first = await park(1);
      expect(provider.loadReader).not.toHaveBeenCalled();
      expect(await dispatcher.executeApproved(first.toolCallId, ctx)).toMatchObject({
        kind: 'executed',
        result: { repositoryId: 100, number: 17 },
      });
      expect(provider.readPullRequest).toHaveBeenCalledExactlyOnceWith(100, 17, ctx.signal);

      const second = await park(2);
      const otherOwner = randomUUID();
      await store.doc('agents', otherOwner).set({ id: otherOwner });
      expect(await dispatcher.executeApproved(second.toolCallId, ctx)).toMatchObject({
        kind: 'failed',
        error: expect.stringContaining('security binding'),
      });
      expect(provider.readPullRequest).toHaveBeenCalledTimes(1);
    } finally {
      await disposeStore(store);
    }
  },
);

it.each(['postgres', 'firestore'] as const)(
  'registers the same default-off issue capability in the %s agent path',
  async (driver) => {
    provider.selection.mockReturnValue(selection);
    provider.loadCreator.mockClear();
    const enabledConfig = {
      ...config,
      ASSISTANT_GITHUB_ISSUE_CREATION_ENABLED: true,
      PERSISTENCE_DRIVER: driver,
      POSTGRES_SOURCE_WRITES_FENCED: false,
    };
    const owner = vi.fn(async () => 'owner');
    const disabled = registerConfiguredGitHubAppTools(
      new ToolRegistry(),
      { ...enabledConfig, ASSISTANT_GITHUB_ISSUE_CREATION_ENABLED: false },
      owner,
    );
    expect(disabled.get('github.create_issue')).toBeUndefined();
    expect(disabled.get('github.get_repository')).toBeDefined();
    expect(disabled.get('github.get_pull_request')).toBeDefined();
    expect(provider.loadCreator).not.toHaveBeenCalled();
    const active = registerConfiguredGitHubAppTools(new ToolRegistry(), enabledConfig, owner);
    expect(active.get('github.create_issue')).toBeDefined();
    expect(provider.loadCreator).not.toHaveBeenCalled();
    for (const hold of ['RESTORE_REHEARSAL', 'ASSISTANT_RELEASE_WRITES_PAUSED'] as const) {
      expect(
        registerConfiguredGitHubAppTools(
          new ToolRegistry(),
          { ...enabledConfig, [hold]: true },
          owner,
        ).get('github.create_issue'),
      ).toBeUndefined();
    }
    const fenced = registerConfiguredGitHubAppTools(
      new ToolRegistry(),
      { ...enabledConfig, POSTGRES_SOURCE_WRITES_FENCED: true },
      owner,
    );
    expect(Boolean(fenced.get('github.create_issue'))).toBe(driver === 'firestore');
    enabledConfig.ASSISTANT_GITHUB_ISSUE_CREATION_ENABLED = false;
    const ctx = {
      agentId: 'owner',
      taskId: 'task',
      trust: 'owner',
      signal: new AbortController().signal,
    } as ToolContext;
    await expect(
      active
        .get('github.create_issue')
        ?.tool.prepareSecurity?.(
          { repositoryFullName: 'example/synthetic', title: 'Synthetic', body: '' },
          ctx,
          'dispatch',
        ),
    ).rejects.toThrow('disabled');
    expect(provider.loadCreator).not.toHaveBeenCalled();
  },
);

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST).each(['confirmed', 'unknown'] as const)(
  'executes one freshly approved GitHub issue through real Firestore repositories (%s)',
  async (outcome) => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const taskId = randomUUID();
    const input = {
      repositoryFullName: 'example/synthetic',
      title: 'Synthetic issue',
      body: 'Exact synthetic body.\n',
    };
    const result = {
      repositoryId: 100,
      ...input,
      id: 123,
      number: 17,
      state: 'open',
      url: 'https://github.com/example/synthetic/issues/17',
      verified: true,
    };
    provider.selection.mockReturnValue(selection);
    provider.createIssue.mockReset();
    provider.loadCreator.mockResolvedValue({ selection, createIssue: provider.createIssue });
    provider.createIssue.mockImplementation(async (_repoId, _input, _signal, preflight) => {
      await preflight();
      if (outcome === 'unknown') {
        const { GitHubAppIssueCreateError } = await import(
          '../../../packages/tools/src/github-app-issue-creator.js'
        );
        throw new GitHubAppIssueCreateError('outcome_unknown');
      }
      return result;
    });
    try {
      await store.doc('agents', agentId).set({ id: agentId });
      const task = {
        id: taskId,
        agentId,
        type: 'adhoc' as const,
        trust: 'owner' as const,
        status: 'running' as const,
        createdAt: new Date(),
        trigger: null,
        conversationId: null,
        goalId: null,
      };
      await store.doc('tasks', taskId).set(task);
      const activeConfig = {
        ...config,
        ASSISTANT_GITHUB_ISSUE_CREATION_ENABLED: true,
        PERSISTENCE_DRIVER: 'firestore' as const,
        POSTGRES_SOURCE_WRITES_FENCED: false,
      };
      const registry = registerConfiguredGitHubAppTools(new ToolRegistry(), activeConfig, () =>
        assertFirestoreInstallationOwner(store, agentId),
      );
      const db = new Proxy({} as ToolContext['db'], {
        get(_target, key) {
          throw new Error(`Unexpected PostgreSQL access: ${String(key)}`);
        },
      });
      const approvals = new FirestoreApprovalRepository(store);
      const dispatcher = new ToolDispatcher(
        db,
        registry,
        new FirestoreToolExecutionRepository(store),
        new FirestoreCostRepository(store),
        approvals,
        new FirestoreApprovalPolicyRepository(store),
      );
      const ctx: ToolContext = {
        taskId,
        agentId,
        trust: 'owner',
        tainted: false,
        db,
        now: () => new Date(),
        signal: new AbortController().signal,
        log: async () => {},
      };
      async function park(step: number) {
        const parked = await dispatcher.dispatch({
          task: task as never,
          step,
          toolName: 'github.create_issue',
          args: input,
          ctx,
          modelToolCallId: `synthetic-issue-${step}`,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        if (parked.kind !== 'awaiting_approval')
          throw new Error(`Expected approval, got ${JSON.stringify(parked)}`);
        return parked;
      }
      const first = await park(1);
      expect(provider.createIssue).not.toHaveBeenCalled();
      expect(
        (
          await approvals.resolve({
            approvalId: first.approvalId,
            decision: 'approved',
            via: 'web',
            deferNotification: true,
          })
        ).ok,
      ).toBe(true);
      const expected =
        outcome === 'confirmed' ? result : { deliveryStatus: 'unknown', retrySuppressed: true };
      expect(await dispatcher.executeApproved(first.toolCallId, ctx)).toMatchObject({
        kind: 'executed',
        result: expected,
      });
      expect(await dispatcher.executeApproved(first.toolCallId, ctx)).toMatchObject({
        kind: 'executed',
        result: expected,
      });
      expect(provider.createIssue).toHaveBeenCalledExactlyOnceWith(
        100,
        input,
        ctx.signal,
        expect.any(Function),
      );
      const second = await park(2);
      expect(provider.createIssue).toHaveBeenCalledOnce(); // New model dispatch cannot inherit approval.
      expect(
        (
          await approvals.resolve({
            approvalId: second.approvalId,
            decision: 'approved',
            via: 'web',
            deferNotification: true,
          })
        ).ok,
      ).toBe(true);
      const otherOwner = randomUUID();
      await store.doc('agents', otherOwner).set({ id: otherOwner });
      expect(await dispatcher.executeApproved(second.toolCallId, ctx)).toMatchObject({
        kind: 'failed',
        error: expect.stringContaining('security binding'),
      });
      expect(provider.createIssue).toHaveBeenCalledOnce();
    } finally {
      await disposeStore(store);
    }
  },
);
