import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({
  cloud: vi.fn(),
  plan: vi.fn(),
  execute: vi.fn(),
  write: vi.fn(),
  readService: vi.fn(),
  readRevision: vi.fn(),
  patchTraffic: vi.fn(),
  waitOperation: vi.fn(),
  drain: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  writeFileSync: ports.write,
}));
vi.mock('./owner-web-tag-cloud.js', async (original) => ({
  ...(await original<typeof import('./owner-web-tag-cloud.js')>()),
  protectedWebTagCloud: ports.cloud,
}));
vi.mock('./owner-web-tag-retirement.js', async (original) => ({
  ...(await original<typeof import('./owner-web-tag-retirement.js')>()),
  planOwnedWebTagRetirement: ports.plan,
  executeOwnedWebTagRetirement: ports.execute,
}));

import type { RetirementPlan } from './owner-web-tag-retirement.js';
import {
  retirementPacket,
  retirementPacketHash,
  runRetirementCommand,
} from './owner-web-tag-retirement-command.js';
import { retirementFailureTracker } from './owner-web-tag-retirement-failure.js';

const source = 'a'.repeat(40),
  observedAt = '2026-11-01T18:00:00.000Z';
const plan = { format: 1, patch: null } as unknown as RetirementPlan;
const oldArgv = process.argv;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T18:05:00.000Z'));
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'bmson/assistant',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '123',
    GCP_PROJECT: 'bmson-assistant',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: source,
    GITHUB_WORKFLOW_SHA: source,
    OWNER_TAG_REVIEWED_SOURCE: source,
    GITHUB_WORKFLOW_REF:
      'bmson/assistant/.github/workflows/owner-web-tag-retirement.yml@refs/heads/main',
    GCP_DEPLOY_SERVICE_ACCOUNT: 'deploy@bmson-assistant.iam.gserviceaccount.com',
    GCP_WORKLOAD_IDENTITY_PROVIDER:
      'projects/123/locations/global/workloadIdentityPools/existing/providers/existing',
    OWNER_TAG_REVIEWED_OBSERVED_AT: observedAt,
    OWNER_TAG_REVIEWED_PLAN_SHA256: retirementPacketHash(
      retirementPacket(plan, source, observedAt),
    ),
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  ports.plan.mockReturnValue(plan);
  ports.readService.mockResolvedValue({});
  ports.readRevision.mockResolvedValue({});
  ports.cloud.mockImplementation(async (mark) => {
    mark('cloud_access_token');
    return {
      readService: ports.readService,
      readRevision: ports.readRevision,
      patchTraffic: ports.patchTraffic,
      waitOperation: ports.waitOperation,
      drain: ports.drain,
    };
  });
});
afterEach(() => {
  process.argv = oldArgv;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const trackerFor = (mode: '--plan' | '--apply') => {
  process.argv = ['node', 'protected-command', mode];
  return retirementFailureTracker(process.env, mode);
};

describe('retirement command diagnostic boundaries with fake transport only', () => {
  it('plan still writes only the same packet and never enters the executor or PATCH', async () => {
    const tracker = trackerFor('--plan');
    await runRetirementCommand(tracker);
    expect(ports.write).toHaveBeenCalledTimes(1);
    expect(ports.write.mock.calls[0]?.[0]).toBe('owner-web-tag-retirement-plan.json');
    expect(ports.execute).not.toHaveBeenCalled();
    expect(ports.patchTraffic).not.toHaveBeenCalled();
    expect(tracker.receipt(new Error('private')).mutationState).toBe('not_attempted');
  });
  it('identifies the fixed helper stage without claiming SDK setup proves token access', async () => {
    ports.cloud.mockImplementation(async (mark) => {
      mark('cloud_access_token');
      throw new Error('private credentials stderr');
    });
    const tracker = trackerFor('--plan');
    await expect(runRetirementCommand(tracker)).rejects.toThrow();
    expect(tracker.receipt(new Error('private credentials stderr'))).toMatchObject({
      stage: 'cloud_access_token',
      reason: 'unclassified_stop',
      mutationState: 'not_attempted',
    });
    expect(ports.readService).not.toHaveBeenCalled();
    expect(ports.write).not.toHaveBeenCalled();
  });
  it('distinguishes native historical read failure from planner rejection', async () => {
    ports.readRevision.mockRejectedValueOnce(new Error('Native read rejected'));
    const tracker = trackerFor('--plan');
    const error = await runRetirementCommand(tracker).catch((error: unknown) => error);
    expect(tracker.receipt(error)).toMatchObject({
      stage: 'plan_read_historical_revision',
      reason: 'native_read_rejected',
      mutationState: 'not_attempted',
    });
    expect(ports.plan).not.toHaveBeenCalled();
    expect(ports.execute).not.toHaveBeenCalled();
  });
  it('keeps an expired pre-write review refusal before the mutation marker and PATCH', async () => {
    ports.execute.mockImplementation(async (_plan, io) => {
      vi.setSystemTime(new Date('2026-11-01T18:31:00.001Z'));
      return io.patchTraffic({});
    });
    const tracker = trackerFor('--apply');
    const error = await runRetirementCommand(tracker).catch((error: unknown) => error);
    expect(tracker.receipt(error)).toMatchObject({
      stage: 'apply_write_boundary',
      reason: 'review_expired',
      mutationState: 'not_attempted',
    });
    expect(ports.patchTraffic).not.toHaveBeenCalled();
  });
  it('identifies fresh apply revision reads separately from service reads before any PATCH', async () => {
    ports.readRevision
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Native read rejected'));
    ports.execute.mockImplementation(async (_plan, io) => {
      await io.readService();
      return io.readRevision('assistant-web-current');
    });
    const tracker = trackerFor('--apply');
    const error = await runRetirementCommand(tracker).catch((error: unknown) => error);
    expect(tracker.receipt(error)).toMatchObject({
      stage: 'apply_revision_read',
      reason: 'native_read_rejected',
      mutationState: 'not_attempted',
    });
    expect(ports.patchTraffic).not.toHaveBeenCalled();
  });
  it('records possible mutation on one uncertain PATCH and never retries', async () => {
    ports.patchTraffic.mockRejectedValue(new Error('Native PATCH outcome uncertain; do not retry'));
    ports.execute.mockImplementation(async (_plan, io) => io.patchTraffic({}));
    const tracker = trackerFor('--apply');
    const error = await runRetirementCommand(tracker).catch((error: unknown) => error);
    expect(tracker.receipt(error)).toMatchObject({
      stage: 'apply_patch',
      reason: 'patch_uncertain',
      mutationState: 'may_have_been_attempted',
      retryAuthorized: false,
    });
    expect(ports.patchTraffic).toHaveBeenCalledTimes(1);
  });
  it('retains possible mutation when PATCH returned but the following operation fails', async () => {
    ports.patchTraffic.mockResolvedValue({});
    ports.waitOperation.mockRejectedValue(new Error('Native operation failed'));
    ports.execute.mockImplementation(async (_plan, io) => {
      const operation = await io.patchTraffic({});
      return io.waitOperation(operation);
    });
    const tracker = trackerFor('--apply');
    const error = await runRetirementCommand(tracker).catch((error: unknown) => error);
    expect(tracker.receipt(error)).toMatchObject({
      stage: 'apply_wait_operation',
      reason: 'operation_failed',
      mutationState: 'may_have_been_attempted',
      retryAuthorized: false,
    });
    expect(ports.patchTraffic).toHaveBeenCalledTimes(1);
  });
  it('keeps an already-absent drain failure separate from any PATCH attempt', async () => {
    ports.drain.mockRejectedValue(new Error('private provider failure'));
    ports.execute.mockImplementation(async (_plan, io) => io.drain(600));
    const tracker = trackerFor('--apply');
    const error = await runRetirementCommand(tracker).catch((error: unknown) => error);
    expect(tracker.receipt(error)).toMatchObject({
      stage: 'apply_drain',
      mutationState: 'not_attempted',
      retryAuthorized: false,
    });
    expect(ports.drain).toHaveBeenCalledWith(600);
    expect(ports.patchTraffic).not.toHaveBeenCalled();
  });
});
