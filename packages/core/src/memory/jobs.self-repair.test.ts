import type { Db, TaskRow } from '@assistant/db';
import type { ExecutionPersistence, SelfRepairRepository } from '@assistant/persistence';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigForTest } from '../config.js';
import type { ModelRouter } from '../model-router/router.js';
import { runCodeJob } from './jobs.js';

afterEach(() => resetConfigForTest());

it('runs the hosted repair queue with dedicated credentials and no legacy Actions token', async () => {
  loadConfig({
    SELF_REPAIR_ENABLED: 'true',
    SELF_REPAIR_PROVIDER: 'openai_hosted',
    SELF_REPAIR_OPENAI_API_KEY: 'test-coding-key',
    SELF_REPAIR_GITHUB_TOKEN: 'test-publisher-token',
    GITHUB_REPO: 'owner/repo',
    GITHUB_TOKEN: '',
  });
  const repository = {
    failures: vi.fn(async () => []),
    modelAccounting: vi.fn(async () => ({
      observedModelCalls: 0,
      knownCostUsd: '0',
      unresolvedReservations: 0,
      complete: false,
    })),
    list: vi.fn(async () => []),
    claim: vi.fn(async () => null),
  } as unknown as SelfRepairRepository;
  expect(
    await runCodeJob(
      {
        db: {} as Db,
        router: {} as ModelRouter,
        persistence: { selfRepair: repository, selfRepairAudit: {} } as ExecutionPersistence,
      },
      'self.repair',
      { id: 'task', agentId: 'owner' } as TaskRow,
    ),
  ).toMatchObject({ done: true, summary: 'self-repair: 0 coding run(s) dispatched' });
  expect(repository.claim).toHaveBeenCalledWith('owner', expect.any(Date), 2, 'task');
});
