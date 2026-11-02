import { describe, expect, it, vi } from 'vitest';
import { fixedTrafficFixture, secret } from './fixtures/web-traffic-reconciliation.js';
import { WEB_SERVICE } from './owner-web-tag-retirement.js';
import { retirementFailureTracker } from './owner-web-tag-retirement-failure.js';
import {
  reconciliationFailureReceipt,
  reconciliationPacket,
  reconciliationPacketHash,
  runReconciliationCommand,
} from './owner-web-traffic-reconciliation-command.js';
import {
  planWebTrafficReconciliation,
  type TrafficReconciliationIO,
} from './owner-web-traffic-reconciliation-model.js';

const source = 'a'.repeat(40),
  at = '2026-11-01T18:00:00.000Z',
  fresh = Date.parse(at) + 300000;
function fixture(mode = '--apply') {
  const f = fixedTrafficFixture(),
    plan = planWebTrafficReconciliation(f.before, f.native, source, at);
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
    OWNER_RECONCILIATION_REVIEWED_SOURCE: source,
    GITHUB_WORKFLOW_REF:
      'bmson/assistant/.github/workflows/owner-web-traffic-reconciliation.yml@refs/heads/main',
    GCP_DEPLOY_SERVICE_ACCOUNT: 'deploy@bmson-assistant.iam.gserviceaccount.com',
    GCP_WORKLOAD_IDENTITY_PROVIDER:
      'projects/123/locations/global/workloadIdentityPools/existing/providers/existing',
    OWNER_RECONCILIATION_REVIEWED_OBSERVED_AT: at,
    OWNER_RECONCILIATION_REVIEWED_PLAN_SHA256: reconciliationPacketHash(
      reconciliationPacket(plan, source, at),
    ),
  };
  let patched = false;
  const io = {
    readService: vi.fn<TrafficReconciliationIO['readService']>(async () =>
      structuredClone(patched ? f.after : f.before),
    ),
    readRevision: vi.fn<TrafficReconciliationIO['readRevision']>(async (name: string) =>
      structuredClone(f.native[name as keyof typeof f.native]),
    ),
    patchTraffic: vi.fn<TrafficReconciliationIO['patchTraffic']>(async () => {
      patched = true;
      return {
        name: 'projects/bmson-assistant/locations/us-west1/operations/fixed',
        done: true,
        response: { name: WEB_SERVICE },
      };
    }),
    waitOperation: vi.fn<TrafficReconciliationIO['waitOperation']>(async () => {}),
  };
  const deps = {
    cloud: vi.fn(async (mark: ReturnType<typeof retirementFailureTracker>['mark']) => {
      mark('cloud_access_token');
      return io as TrafficReconciliationIO;
    }),
    now: vi.fn(() => fresh),
    write: vi.fn(),
  };
  const tracker = retirementFailureTracker(env, mode);
  const run = (args = [mode]) => runReconciliationCommand(args, env, tracker, deps);
  return { f, env, io, deps, tracker, run, plan };
}
describe('fixed one-off protected reconciliation command, real model and fake cloud only', () => {
  it('verifies source without cloud access, reads, artifacts or writes', async () => {
    const f = fixture('--verify-source');
    await f.run();
    expect(f.deps.cloud).not.toHaveBeenCalled();
    expect(f.deps.write).not.toHaveBeenCalled();
  });
  it('plan reads only the fixed service/two revisions and writes sanitized packet, never PATCH/LRO', async () => {
    const f = fixture('--plan');
    await f.run();
    expect(f.io.readService).toHaveBeenCalledTimes(1);
    expect(f.io.readRevision.mock.calls.map((c) => c[0])).toEqual([
      f.f.old.revision,
      f.f.current.revision,
    ]);
    expect(f.io.patchTraffic).not.toHaveBeenCalled();
    expect(f.io.waitOperation).not.toHaveBeenCalled();
    expect(f.deps.write).toHaveBeenCalledTimes(1);
    expect(f.deps.write.mock.calls[0]?.[0]).toBe('owner-web-traffic-reconciliation-plan.json');
    expect(JSON.stringify(f.deps.write.mock.calls)).not.toContain(secret);
  });
  it('reuses a refused plan snapshot for existing bounded hints without another read or raw data', async () => {
    const f = fixture('--plan');
    f.io.readService.mockResolvedValue(f.f.after);
    const error = await f.run().catch((e) => e),
      receipt = reconciliationFailureReceipt(f.tracker, error);
    expect(receipt).toMatchObject({
      reason: 'unexpected_topology',
      mutationState: 'not_attempted',
    });
    expect(receipt).toHaveProperty('trafficDiscrepancy');
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(f.io.readService).toHaveBeenCalledTimes(1);
    expect(f.io.readRevision).toHaveBeenCalledTimes(2);
    expect(f.io.patchTraffic).not.toHaveBeenCalled();
    expect(f.deps.write).not.toHaveBeenCalled();
  });
  it('separate apply run reconstructs exact reviewed packet and makes one traffic-only CAS, then strict postcheck and stops', async () => {
    const f = fixture();
    f.env.GITHUB_RUN_ID = '456';
    await f.run();
    expect(f.io.patchTraffic).toHaveBeenCalledTimes(1);
    expect(f.io.readService).toHaveBeenCalledTimes(3);
    expect(f.io.readRevision).toHaveBeenCalledTimes(6);
    expect(f.io.waitOperation).toHaveBeenCalledTimes(1);
    expect(f.io.patchTraffic.mock.calls[0]?.[0]).toEqual(f.plan.request.body);
    expect(f.deps.write.mock.calls[1]?.[0]).toBe('owner-web-traffic-reconciliation-result.json');
    expect(f.deps.write.mock.calls[1]?.[1]).toMatchObject({
      source,
      outcome: 'strict_equality_restored_both_tags_preserved',
      retiresTags: false,
      createsRevision: false,
      editingAuthorized: false,
      retirementDrainCompleted: false,
      requiresNewNormalRetirementPlan: true,
    });
    expect(JSON.stringify(f.deps.write.mock.calls)).not.toContain(secret);
  });
  it.each([
    ['GITHUB_ACTIONS', 'false'],
    ['GITHUB_REPOSITORY', 'other/assistant'],
    ['GITHUB_REF', 'refs/heads/other'],
    ['GITHUB_RUN_ATTEMPT', '2'],
    ['GCP_PROJECT', 'other'],
    ['GITHUB_EVENT_NAME', 'push'],
    ['GITHUB_WORKFLOW_REF', 'other'],
    ['GITHUB_WORKFLOW_SHA', 'b'.repeat(40)],
    ['OWNER_RECONCILIATION_REVIEWED_SOURCE', 'b'.repeat(40)],
  ])('refuses changed %s before cloud/authentication', async (key, value) => {
    const f = fixture();
    Object.assign(f.env, { [key]: value });
    await expect(f.run()).rejects.toThrow();
    expect(f.deps.cloud).not.toHaveBeenCalled();
  });
  it.each([
    { args: [] },
    { args: ['--unknown'] },
    { args: ['--plan', '--apply'] },
    { args: ['--apply', '--retry'] },
  ])('rejects mode/extra arguments before cloud: %j', async ({ args }) => {
    const f = fixture();
    await expect(f.run(args)).rejects.toThrow();
    expect(f.deps.cloud).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    '2026-11-01T18:06:00.000Z',
    '2026-11-01T17:34:59.999Z',
    '2026-11-01T18:00:00Z',
    '2026-02-30T12:00:00.000Z',
  ])('refuses invalid/future/expired approval time before cloud', async (value) => {
    const f = fixture();
    Object.assign(f.env, { OWNER_RECONCILIATION_REVIEWED_OBSERVED_AT: value });
    await expect(f.run()).rejects.toThrow();
    expect(f.deps.cloud).not.toHaveBeenCalled();
  });
  it.each(['', 'PRIVATE', 'f'.repeat(63)])(
    'refuses missing/malformed reviewed hash before cloud',
    async (value) => {
      const f = fixture();
      f.env.OWNER_RECONCILIATION_REVIEWED_PLAN_SHA256 = value;
      await expect(f.run()).rejects.toThrow();
      expect(f.deps.cloud).not.toHaveBeenCalled();
    },
  );
  it('refuses a different approved hash before PATCH', async () => {
    const f = fixture();
    f.env.OWNER_RECONCILIATION_REVIEWED_PLAN_SHA256 = 'b'.repeat(64);
    const error = await f.run().catch((e) => e);
    expect(reconciliationFailureReceipt(f.tracker, error)).toMatchObject({
      reason: 'stale_plan',
      mutationState: 'not_attempted',
    });
    expect(f.io.patchTraffic).not.toHaveBeenCalled();
  });
  it('detects fresh pre-write drift instead of refreshing or adopting it', async () => {
    const f = fixture();
    f.io.readService
      .mockResolvedValueOnce(f.f.before)
      .mockResolvedValue({ ...f.f.before, etag: 'different' });
    const error = await f.run().catch((e) => e);
    expect(reconciliationFailureReceipt(f.tracker, error)).toMatchObject({
      reason: 'stale_plan',
      mutationState: 'not_attempted',
    });
    expect(f.io.patchTraffic).not.toHaveBeenCalled();
  });
  it('rechecks approval expiry at the actual PATCH boundary', async () => {
    const f = fixture();
    let calls = 0;
    f.deps.now.mockImplementation(() => (++calls <= 4 ? fresh : Date.parse(at) + 1800001));
    const error = await f.run().catch((e) => e);
    expect(reconciliationFailureReceipt(f.tracker, error)).toMatchObject({
      stage: 'apply_write_boundary',
      reason: 'stale_review',
      mutationState: 'not_attempted',
    });
    expect(f.io.patchTraffic).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -1])('refuses corrupt current clock before cloud', async (value) => {
    const f = fixture();
    f.deps.now.mockReturnValue(value);
    await expect(f.run()).rejects.toThrow();
    expect(f.deps.cloud).not.toHaveBeenCalled();
  });
  it('marks PATCH uncertainty sticky, redacts raw error and never retries', async () => {
    const f = fixture();
    f.io.patchTraffic.mockRejectedValue(new Error(`PRIVATE ${secret} https://private.invalid`));
    const error = await f.run().catch((e) => e),
      receipt = reconciliationFailureReceipt(f.tracker, error);
    expect(receipt).toMatchObject({
      reason: 'patch_unconfirmed',
      mutationState: 'may_have_been_attempted',
      retryAuthorized: false,
      authorityEstablished: false,
    });
    expect(f.io.patchTraffic).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|private.invalid/);
    expect(f.deps.write).toHaveBeenCalledTimes(1);
  });
  it('failed strict postcheck is UNKNOWN, no inverse or second PATCH', async () => {
    const f = fixture();
    f.io.readService
      .mockResolvedValueOnce(f.f.before)
      .mockResolvedValueOnce(f.f.before)
      .mockResolvedValue({ ...f.f.after, uid: 'changed-service' });
    const error = await f.run().catch((e) => e);
    expect(reconciliationFailureReceipt(f.tracker, error)).toMatchObject({
      reason: 'postcheck_failed',
      mutationState: 'may_have_been_attempted',
      editingAuthorized: false,
      retirementDrainCompleted: false,
    });
    expect(f.io.patchTraffic).toHaveBeenCalledTimes(1);
    expect(f.deps.write).toHaveBeenCalledTimes(1);
  });
});
