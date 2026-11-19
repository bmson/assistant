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
  readPullRequest: vi.fn(),
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
