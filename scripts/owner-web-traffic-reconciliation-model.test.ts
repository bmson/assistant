// biome-ignore-all lint/style/noNonNullAssertion: Mutations target arrays populated by the fixed synthetic fixture.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HISTORICAL_WEB_TAGS,
  planOwnedWebTagRetirement,
  WEB_SERVICE,
} from './owner-web-tag-retirement.js';
import {
  executeWebTrafficReconciliation,
  planWebTrafficReconciliation,
  reconciliationDigest,
  type TrafficReconciliationIO,
  TrafficReconciliationStop,
  verifyWebTrafficReconciliationPost,
} from './owner-web-traffic-reconciliation-model.js';

const secret = 'PRIVATE_NATIVE_ENV_STDERR_CREDENTIAL_PAYLOAD';
const source = 'a'.repeat(40),
  observedAt = '2026-11-01T21:40:00.000Z';
function fixture() {
  const old = HISTORICAL_WEB_TAGS[0],
    current = HISTORICAL_WEB_TAGS[1];
  if (!old || !current) throw new Error('Missing reviewed pins');
  const nativeRevision = (p: typeof old) => ({
    name: `${WEB_SERVICE}/revisions/${p.revision}`,
    uid: `uid-${p.revision}`,
    serviceAccount: 'runtime@bmson-assistant.iam.gserviceaccount.com',
    timeout: '300s',
    containers: [
      {
        image: p.image,
        env: [
          { name: 'ASSISTANT_RELEASE_WRITES_PAUSED', value: 'false' },
          { name: 'PRIVATE', value: secret },
        ],
      },
    ],
  });
  const native = {
    [old.revision]: nativeRevision(old),
    [current.revision]: nativeRevision(current),
  };
  const row = (p: typeof old, percent?: number) => ({
    type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
    revision: p.revision,
    tag: p.tag,
    ...(percent === undefined ? {} : { percent }),
  });
  const uri = (p: typeof old) => `https://${p.tag}---assistant-web-3gimfiaifa-uw.a.run.app`;
  const before = {
    name: WEB_SERVICE,
    uid: 'same-service-uid',
    etag: 'before-etag',
    generation: '7',
    observedGeneration: '7',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    uri: 'https://assistant-web-3gimfiaifa-uw.a.run.app',
    urls: ['https://assistant-web-3gimfiaifa-uw.a.run.app'],
    template: {
      serviceAccount: native[current.revision]!.serviceAccount,
      containers: [{ image: current.image, env: [{ name: 'PRIVATE', value: secret }] }],
    },
    labels: { scope: 'unchanged' },
    latestReadyRevision: current.revision,
    latestCreatedRevision: current.revision,
    traffic: [
      { type: row(current).type, revision: current.revision, percent: 100 },
      row(current),
      row(old),
    ],
    trafficStatuses: [
      { ...row(current, 100), uri: uri(current) },
      { ...row(old), uri: uri(old) },
    ],
  };
  const plan = planWebTrafficReconciliation(before, native, source, observedAt);
  const after = {
    ...structuredClone(before),
    etag: 'new-settled-etag',
    generation: '8',
    observedGeneration: '8',
    traffic: structuredClone(plan.request.body.traffic),
  };
  return { old, current, native, before, after, plan };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T21:45:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('separate explicit known web traffic reconciliation model', () => {
  it('keeps the actual3/2 mismatch rejected by the strict retirement planner', () => {
    const f = fixture();
    expect(() =>
      planOwnedWebTagRetirement(f.before, f.native, [f.old], {
        revision: f.current.revision,
        image: f.current.image,
        tag: f.current.tag,
        uriSha256: f.current.uriSha256,
        paused: false,
      }),
    ).toThrow('Desired and observed traffic differ');
    expect(f.plan.request).toEqual({
      method: 'PATCH',
      updateMask: 'traffic',
      body: {
        name: WEB_SERVICE,
        etag: 'before-etag',
        traffic: [
          {
            type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
            revision: f.current.revision,
            tag: f.current.tag,
            percent: 100,
          },
          {
            type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
            revision: f.old.revision,
            tag: f.old.tag,
            percent: 0,
          },
        ],
      },
    });
    expect(Object.keys(f.plan.request.body).sort()).toEqual(['etag', 'name', 'traffic']);
    expect(f.plan.before.desired).toHaveLength(3);
    expect(f.plan.before.observed).toHaveLength(2);
    expect(f.plan).toMatchObject({
      retiresTags: false,
      createsRevision: false,
      editingAuthorized: false,
      retirementDrainCompleted: false,
      requiresNewNormalRetirementPlan: true,
      nativeRevisionProofs: { old: { timeoutSeconds: 300 }, current: { timeoutSeconds: 300 } },
    });
    expect(JSON.stringify(f.plan)).not.toContain(secret);
    expect(JSON.stringify(f.plan)).not.toContain('https://');
  });
  it('makes only order/full revision paths/protozero differences immaterial to the same exact proposal', () => {
    const f = fixture();
    const changed = structuredClone(f.before);
    changed.traffic.reverse();
    changed.trafficStatuses.reverse();
    changed.traffic = changed.traffic.map((r) => ({
      ...r,
      revision: `${WEB_SERVICE}/revisions/${r.revision}`,
      percent: r.percent ?? 0,
    }));
    expect(
      reconciliationDigest(planWebTrafficReconciliation(changed, f.native, source, observedAt)),
    ).toBe(reconciliationDigest(f.plan));
  });
  it.each([
    'extra_desired',
    'extra_observed',
    'duplicate_desired',
    'duplicate_observed',
    'reassigned_current',
    'reassigned_old',
    'active_old',
    'changed_current_percent',
    'split_current_percent',
    'latest_type',
    'empty_tag',
    'missing_old',
    'missing_current',
    'already_equal',
    'wrong_root',
    'bad_generation',
    'reconciling',
    'unready',
    'missing_etag',
    'old_uri',
    'current_uri',
    'wrong_current_image',
    'wrong_old_image',
    'pause_change',
    'timeout_change',
    'template_image',
    'template_account',
    'unknown_field',
    'null_percent',
    'string_percent',
    'observed_latest',
    'missing_latest',
    'ready_wrong',
    'created_wrong',
    'both_latest_wrong',
    'missing_native_uid',
  ] as const)('refuses any topology/provenance variant: %s', (kind) => {
    const f = fixture(),
      s = structuredClone(f.before),
      n = structuredClone(f.native);
    if (kind === 'extra_desired') s.traffic.push({ ...s.traffic[0]!, tag: 'operator' });
    if (kind === 'extra_observed')
      s.trafficStatuses.push({ ...s.trafficStatuses[0]!, tag: 'operator' });
    if (kind === 'duplicate_desired') s.traffic.push({ ...s.traffic[1]! });
    if (kind === 'duplicate_observed') s.trafficStatuses.push({ ...s.trafficStatuses[1]! });
    if (kind === 'reassigned_current') s.traffic[1]!.revision = f.old.revision;
    if (kind === 'reassigned_old') s.trafficStatuses[1]!.revision = f.current.revision;
    if (kind === 'active_old') s.trafficStatuses[1]!.percent = 1;
    if (kind === 'changed_current_percent') s.traffic[0]!.percent = 99;
    if (kind === 'split_current_percent') {
      s.traffic[0]!.percent = 50;
      s.traffic[1]!.percent = 50;
    }
    if (kind === 'latest_type') s.traffic[0]!.type = 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST';
    if (kind === 'empty_tag') Object.assign(s.traffic[1]!, { tag: '' });
    if (kind === 'missing_old') s.traffic.pop();
    if (kind === 'missing_current') s.trafficStatuses.shift();
    if (kind === 'already_equal') s.traffic = structuredClone(f.plan.request.body.traffic);
    if (kind === 'wrong_root') s.name = 'projects/operator/services/elsewhere';
    if (kind === 'bad_generation') s.observedGeneration = '6';
    if (kind === 'reconciling') Object.assign(s, { reconciling: true });
    if (kind === 'unready') s.terminalCondition.state = 'CONDITION_FAILED';
    if (kind === 'missing_etag') s.etag = '';
    if (kind === 'old_uri') s.trafficStatuses[1]!.uri = 'https://operator.invalid';
    if (kind === 'current_uri') s.trafficStatuses[0]!.uri = 'https://operator.invalid';
    if (kind === 'wrong_current_image') n[f.current.revision]!.containers[0]!.image = f.old.image;
    if (kind === 'wrong_old_image') n[f.old.revision]!.containers[0]!.image = f.current.image;
    if (kind === 'pause_change') n[f.old.revision]!.containers[0]!.env[0]!.value = 'true';
    if (kind === 'timeout_change') n[f.old.revision]!.timeout = '601s';
    if (kind === 'template_image') s.template.containers[0]!.image = f.old.image;
    if (kind === 'template_account')
      s.template.serviceAccount = 'operator@elsewhere.iam.gserviceaccount.com';
    if (kind === 'unknown_field') Object.assign(s.traffic[0]!, { private: secret });
    if (kind === 'null_percent') Object.assign(s.traffic[1]!, { percent: null });
    if (kind === 'string_percent') Object.assign(s.traffic[1]!, { percent: '0' });
    if (kind === 'observed_latest')
      s.trafficStatuses[0]!.type = 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST';
    if (kind === 'missing_latest') Reflect.deleteProperty(s, 'latestCreatedRevision');
    if (kind === 'ready_wrong' || kind === 'both_latest_wrong')
      s.latestReadyRevision = f.old.revision;
    if (kind === 'created_wrong' || kind === 'both_latest_wrong')
      s.latestCreatedRevision = f.old.revision;
    if (kind === 'missing_native_uid') Reflect.deleteProperty(n[f.old.revision]!, 'uid');
    expect(() => planWebTrafficReconciliation(s, n, source, observedAt)).toThrow(
      TrafficReconciliationStop,
    );
  });
  it('accepts new settled etag/generation and exact two-row equality, preserving both tags', () => {
    const f = fixture();
    const result = verifyWebTrafficReconciliationPost(f.after, f.native, f.plan);
    expect(result).toMatchObject({
      outcome: 'strict_equality_restored_both_tags_preserved',
      serviceEtag: 'new-settled-etag',
      serviceGeneration: '8',
      retiresTags: false,
      editingAuthorized: false,
      retirementDrainCompleted: false,
      requiresNewNormalRetirementPlan: true,
    });
    expect(result.tagBindings).toHaveLength(2);
    // A separately invoked normal planner now passes strict equality, but its
    // executor/full drain have not run as part of reconciliation.
    expect(
      planOwnedWebTagRetirement(f.after, f.native, [f.old], {
        revision: f.current.revision,
        image: f.current.image,
        tag: f.current.tag,
        uriSha256: f.current.uriSha256,
        paused: false,
      }),
    ).toMatchObject({ drainSeconds: 600, action: 'retire_exact_tags' });
  });
  it('keeps malformed source/time and hostile exception payload out of the proposal/error', () => {
    const f = fixture();
    for (const [sha, time] of [
      [secret, observedAt],
      [source, secret],
      [source, '2026-02-30T21:40:00.000Z'],
    ])
      expect(() => planWebTrafficReconciliation(f.before, f.native, sha!, time!)).toThrow(
        TrafficReconciliationStop,
      );
    const hostile = Object.defineProperty({ ...f.before }, 'name', {
      get() {
        throw new Error(secret);
      },
    });
    try {
      planWebTrafficReconciliation(hostile, f.native, source, observedAt);
      throw new Error('Expected refusal');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(error).toBeInstanceOf(TrafficReconciliationStop);
    }
  });
  it.each([
    'same_etag',
    'same_generation',
    'unobserved_generation',
    'uid',
    'root_uri',
    'root_urls',
    'config',
    'template',
    'new_revision',
    'old_binding',
    'current_binding',
    'old_retired',
    'tag_uri',
    'wrong_image',
    'native_recreated',
    'native_timeout',
  ] as const)('holds on post-write drift: %s', (kind) => {
    const f = fixture(),
      s = structuredClone(f.after),
      n = structuredClone(f.native);
    if (kind === 'same_etag') s.etag = f.before.etag;
    if (kind === 'same_generation') s.generation = s.observedGeneration = '7';
    if (kind === 'unobserved_generation') s.observedGeneration = '7';
    if (kind === 'uid') s.uid = 'different-service';
    if (kind === 'root_uri') s.uri = 'https://operator.invalid';
    if (kind === 'root_urls') s.urls.push('https://operator.invalid');
    if (kind === 'config') s.labels.scope = 'changed';
    if (kind === 'template') s.template.containers[0]!.env[0]!.value = 'changed';
    if (kind === 'new_revision') s.latestCreatedRevision = 'assistant-web-new';
    if (kind === 'old_binding') s.traffic[1]!.revision = f.current.revision;
    if (kind === 'current_binding') s.trafficStatuses[0]!.revision = f.old.revision;
    if (kind === 'old_retired') s.trafficStatuses.pop();
    if (kind === 'tag_uri') s.trafficStatuses[1]!.uri = 'https://operator.invalid';
    if (kind === 'wrong_image') n[f.current.revision]!.containers[0]!.image = f.old.image;
    if (kind === 'native_recreated') n[f.old.revision]!.uid = 'new-immutable-incarnation';
    if (kind === 'native_timeout') n[f.old.revision]!.timeout = '299s';
    expect(() => verifyWebTrafficReconciliationPost(s, n, f.plan)).toThrow('postcheck_failed');
  });
});

function ioFixture() {
  const f = fixture();
  let serviceReads = 0;
  const readService = vi
    .fn()
    .mockImplementation(async () => structuredClone(serviceReads++ === 0 ? f.before : f.after));
  const readRevision = vi
    .fn()
    .mockImplementation(async (name: string) => structuredClone(f.native[name]));
  const patchTraffic = vi.fn().mockResolvedValue({
    name: 'projects/bmson-assistant/locations/us-west1/operations/reconcile-once',
    done: true,
    response: {},
  });
  const waitOperation = vi.fn().mockResolvedValue(undefined);
  const io: TrafficReconciliationIO = { readService, readRevision, patchTraffic, waitOperation };
  return { ...f, io, readService, readRevision, patchTraffic, waitOperation };
}
describe('source-only one-attempt reconciliation executor with fake IO', () => {
  it('rereads and binds exact state, PATCHes once, polls only its operation and postchecks new state', async () => {
    const f = ioFixture();
    const result = await executeWebTrafficReconciliation(f.plan, f.io);
    expect(f.patchTraffic).toHaveBeenCalledTimes(1);
    expect(f.patchTraffic).toHaveBeenCalledWith(
      f.plan.request.body,
      expect.objectContaining({ updateMask: 'traffic', signal: expect.any(AbortSignal) }),
    );
    expect(f.readService).toHaveBeenCalledTimes(2);
    expect(f.readRevision).toHaveBeenCalledTimes(4);
    expect(f.waitOperation).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      serviceEtag: 'new-settled-etag',
      retirementDrainCompleted: false,
      requiresNewNormalRetirementPlan: true,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('refuses stale pre-write etag without a PATCH', async () => {
    const f = ioFixture();
    f.readService.mockResolvedValueOnce({ ...f.before, etag: 'changed-before-write' });
    await expect(executeWebTrafficReconciliation(f.plan, f.io)).rejects.toMatchObject({
      reason: 'stale_plan',
      mutationState: 'not_attempted',
    });
    expect(f.patchTraffic).not.toHaveBeenCalled();
  });
  it('refuses an expired or future review before any provider callback', async () => {
    for (const time of ['2026-11-01T21:14:59.999Z', '2026-11-01T21:46:00.000Z']) {
      const f = ioFixture();
      const p = { ...f.plan, observedAt: time };
      await expect(executeWebTrafficReconciliation(p, f.io)).rejects.toMatchObject({
        reason: 'stale_review',
        mutationState: 'not_attempted',
      });
      expect(f.readService).not.toHaveBeenCalled();
      expect(f.patchTraffic).not.toHaveBeenCalled();
    }
  });
  it('does not treat an unknown clock as a fresh review', async () => {
    const f = ioFixture();
    await expect(
      executeWebTrafficReconciliation(f.plan, f.io, () => Number.NaN),
    ).rejects.toMatchObject({ reason: 'stale_review', mutationState: 'not_attempted' });
    expect(f.readService).not.toHaveBeenCalled();
    expect(f.patchTraffic).not.toHaveBeenCalled();
  });
  it('refuses forged field masks or body fields before writing', async () => {
    for (const mode of ['mask', 'body']) {
      const f = ioFixture();
      if (mode === 'mask') Object.assign(f.plan.request, { updateMask: 'traffic,template' });
      else
        Object.assign(f.plan.request.body, { template: { private: secret }, allowMissing: true });
      await expect(executeWebTrafficReconciliation(f.plan, f.io)).rejects.toMatchObject({
        reason: 'stale_plan',
        mutationState: 'not_attempted',
      });
      expect(f.patchTraffic).not.toHaveBeenCalled();
    }
  });
  it('rechecks review expiry immediately before PATCH', async () => {
    const f = ioFixture();
    f.readRevision.mockImplementation(async (name: string) => {
      vi.setSystemTime(new Date('2026-11-01T22:11:00.000Z'));
      return structuredClone(f.native[name]);
    });
    await expect(executeWebTrafficReconciliation(f.plan, f.io)).rejects.toMatchObject({
      reason: 'stale_review',
      mutationState: 'not_attempted',
    });
    expect(f.patchTraffic).not.toHaveBeenCalled();
  });
  it.each([
    'etag-conflict',
    'uncertain-response',
    'operation-failure',
    'postcheck-failure',
  ] as const)('never retries/rolls back after %s; attempted stays UNKNOWN', async (kind) => {
    const f = ioFixture();
    if (kind === 'etag-conflict') f.patchTraffic.mockRejectedValue(new Error(`412 ${secret}`));
    if (kind === 'uncertain-response') f.patchTraffic.mockRejectedValue(new Error(secret));
    if (kind === 'operation-failure') f.waitOperation.mockRejectedValue(new Error(secret));
    if (kind === 'postcheck-failure')
      f.readService
        .mockResolvedValueOnce(f.before)
        .mockResolvedValueOnce({ ...f.after, uid: 'changed' });
    const error = await executeWebTrafficReconciliation(f.plan, f.io).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ mutationState: 'may_have_been_attempted' });
    expect(String(error)).not.toContain(secret);
    expect(f.patchTraffic).toHaveBeenCalledTimes(1);
  });
  it('refuses an arbitrary operation URL without passing it to a polling adapter', async () => {
    const f = ioFixture();
    f.patchTraffic.mockResolvedValue({ name: 'https://operator.invalid', done: false });
    await expect(executeWebTrafficReconciliation(f.plan, f.io)).rejects.toMatchObject({
      reason: 'operation_unconfirmed',
      mutationState: 'may_have_been_attempted',
    });
    expect(f.waitOperation).not.toHaveBeenCalled();
    expect(f.patchTraffic).toHaveBeenCalledTimes(1);
  });
  it('bounds a stalled post-PATCH operation at180s without retry or success', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T21:45:00.000Z'));
    const f = ioFixture();
    f.waitOperation.mockImplementation(() => new Promise(() => undefined));
    const pending = executeWebTrafficReconciliation(f.plan, f.io).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(180001);
    expect(await pending).toMatchObject({
      reason: 'operation_unconfirmed',
      mutationState: 'may_have_been_attempted',
    });
    expect(f.patchTraffic).toHaveBeenCalledTimes(1);
  });
});
