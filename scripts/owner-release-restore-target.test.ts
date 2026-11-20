import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as transition from './owner-release-api-transition.js';
import { bootstrapDigest, type CurrentBinding } from './owner-release-current-snapshot.js';
import {
  checkpointDormantBaseline,
  checkpointNativeRole,
  verifyRestoreCheckpoint,
  verifyRestoreJournal,
} from './owner-release-restore-target.js';

describe('protected restore checkpoint journal', () => {
  let root: string;
  let dir: string;
  const source = 'b'.repeat(40),
    runId = '12345',
    attempt = '1',
    proof = 'fixture signed envelope';
  const env = () => ({
    RUNNER_TEMP: root,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: attempt,
    IMAGE_TAG: source,
    OWNER_RELEASE_RESTORE_TARGET_PROOF: proof,
  });
  function marker(file: string, phase: string, decision: string, overrides = {}) {
    writeFileSync(
      join(dir, file),
      JSON.stringify({
        format: 1,
        source,
        runId,
        attempt,
        phase,
        decision,
        mutationAuthorized: false,
        observationRequired: false,
        proofSha256: createHash('sha256').update(proof).digest('hex'),
        ...overrides,
      }),
      { mode: 0o600, flag: 'wx' },
    );
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'restore-checkpoint-'));
    dir = join(root, 'owner-release-recovery-12345-1');
  });
  afterEach(() => rmSync(root, { force: true, recursive: true }));
  it('binds a first attempt to a single monotonic direction including a lost admission response', () => {
    expect(() => verifyRestoreJournal(env(), 'before_mutation')).not.toThrow();
    expect(() => verifyRestoreJournal(env(), 'pre_admission_restore')).toThrow();
    mkdirSync(dir, { mode: 0o700 });
    marker('start.json', 'started', 'verified');
    expect(() => verifyRestoreJournal(env(), 'before_mutation')).toThrow();
    expect(() => verifyRestoreJournal(env(), 'pre_admission_restore')).not.toThrow();
    expect(() => verifyRestoreJournal(env(), 'before_admission')).not.toThrow();
    expect(() => verifyRestoreJournal(env(), 'post_admission_forward')).toThrow();
    marker('admission.json', 'admission_possible', 'api3_forward_only');
    expect(() => verifyRestoreJournal(env(), 'post_admission_forward')).not.toThrow();
    expect(() => verifyRestoreJournal(env(), 'before_web_resume')).not.toThrow();
    expect(() => verifyRestoreJournal(env(), 'before_admission')).toThrow();
    expect(() => verifyRestoreJournal(env(), 'pre_admission_restore')).toThrow();
  });
  it('requires another exact drained transition readback if staging failed before creating its manifest', async () => {
    for (const [key, value] of Object.entries(env())) vi.stubEnv(key, value);
    vi.stubEnv('RELEASE_MANIFEST_PATH', join(root, `assistant-release-${source}.json`));
    const verify = vi.spyOn(transition, 'verifyProductionApiTransition').mockResolvedValue();
    try {
      mkdirSync(dir, { mode: 0o700 });
      marker('start.json', 'started', 'verified');
      await expect(verifyRestoreCheckpoint('pre_admission_restore')).resolves.toMatchObject({
        decision: 'rehydrate_original_children',
      });
      expect(verify).toHaveBeenCalledExactlyOnceWith(true);
      verify.mockRejectedValueOnce(new Error('native pair changed'));
      await expect(verifyRestoreCheckpoint('pre_admission_restore')).rejects.toThrow();
      marker('admission.json', 'admission_possible', 'api3_forward_only');
      await expect(verifyRestoreCheckpoint('pre_admission_restore')).rejects.toThrow();
      await expect(verifyRestoreCheckpoint('post_admission_forward')).rejects.toThrow();
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      verify.mockRestore();
      vi.unstubAllEnvs();
    }
  });
  it('holds on mismatched proof, wrong-run journal, prior outcome, partial or dangling admission seal', () => {
    mkdirSync(dir, { mode: 0o700 });
    marker('start.json', 'started', 'verified');
    expect(() =>
      verifyRestoreJournal(
        { ...env(), OWNER_RELEASE_RESTORE_TARGET_PROOF: 'changed' },
        'before_admission',
      ),
    ).toThrow();
    marker('admission.json', 'admission_possible', 'api3_forward_only', { runId: '9999' });
    expect(() => verifyRestoreJournal(env(), 'post_admission_forward')).toThrow();
    expect(() => verifyRestoreJournal(env(), 'pre_admission_restore')).toThrow();
    rmSync(join(dir, 'admission.json'));
    symlinkSync(join(root, 'missing'), join(dir, 'admission.json'));
    expect(() => verifyRestoreJournal(env(), 'pre_admission_restore')).toThrow();
    rmSync(join(dir, 'admission.json'));
    writeFileSync(join(dir, 'outcome.json'), '');
    expect(() => verifyRestoreJournal(env(), 'before_admission')).toThrow();
  });
});

describe('checkpoint native revision census', () => {
  const service = 'projects/bmson-assistant/locations/us-west1/services/assistant-agent',
    source = 'a'.repeat(40),
    runId = '12345';
  const old = 'assistant-agent-original',
    paused = 'assistant-agent-p-12345-1-aaaaaaaa',
    resumed = 'assistant-agent-r-12345-1-aaaaaaaa';
  const binding = { service, uid: 'original-service', revision: old } as CurrentBinding;
  const native = {
    name: service,
    uid: binding.uid,
    latestCreatedRevision: resumed,
    latestReadyRevision: resumed,
    traffic: [{ revision: old }, { revision: resumed }],
    trafficStatuses: [{ revision: old }, { revision: resumed }],
  };
  it('reads the original and hidden paused predecessor as well as the reachable successor', async () => {
    const read = vi.fn(async (url: string) => (url.endsWith(service) ? native : {}));
    const got = await checkpointNativeRole('agent', binding, runId, source, read);
    expect(Object.keys(got.revisions).sort()).toEqual([old, paused, resumed].sort());
    expect(read).toHaveBeenCalledTimes(4);
  });
  it('censuses the pinned dormant web and projects only its independently verified signed baseline', async () => {
    const service = 'projects/bmson-assistant/locations/us-west1/services/assistant-web';
    const original = 'assistant-web-archived',
      predecessor = 'assistant-web-p-44632388669-1-bc74fbf7';
    const nativeOld = { uid: 'signed-original' };
    const nativePrior = { uid: 'signed-prior', paused: true };
    const route = [{ revision: original, percent: 100 }];
    const hosted = {
      name: service,
      uid: binding.uid,
      latestCreatedRevision: `${service}/revisions/${predecessor}`,
      latestReadyRevision: `${service}/revisions/${predecessor}`,
      template: { revision: predecessor },
      scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 },
      traffic: route,
      trafficStatuses: route,
    };
    const reviewed = {
      ...binding,
      service,
      revision: original,
      revisionSha256: bootstrapDigest(nativeOld),
      serviceSha256: bootstrapDigest(hosted),
    };
    const read = vi.fn(async (url: string) => {
      if (url.endsWith(service)) return hosted;
      return url.endsWith(original) ? nativeOld : nativePrior;
    });
    await expect(checkpointNativeRole('web', reviewed, runId, source, read)).rejects.toThrow();
    const raw = await checkpointNativeRole('web', reviewed, runId, source, read, predecessor);
    const originalTemplate = { revision: original, containers: [{ image: 'signed-original' }] };
    const verify = vi.fn(() => ({ originalTemplate }));
    const projected = checkpointDormantBaseline('web', raw, predecessor, reviewed, verify);
    expect(verify).toHaveBeenCalledExactlyOnceWith('web', raw);
    expect(projected.service).toMatchObject({
      latestCreatedRevision: original,
      latestReadyRevision: original,
      template: originalTemplate,
      traffic: route,
    });
    expect(projected.revisions).toEqual({ [original]: nativeOld });
    expect(raw.service.template).toEqual({ revision: predecessor });
    expect(raw.revisions[predecessor]).toEqual(nativePrior);

    expect(() =>
      checkpointDormantBaseline(
        'web',
        { ...raw, service: { ...raw.service, etag: 'drift' } },
        predecessor,
        reviewed,
        verify,
      ),
    ).toThrow();
    expect(() =>
      checkpointDormantBaseline(
        'web',
        { ...raw, revisions: { ...raw.revisions, [original]: { uid: 'different' } } },
        predecessor,
        reviewed,
        verify,
      ),
    ).toThrow();
    expect(verify).toHaveBeenCalledTimes(1);

    const staged = { ...raw, revisions: { [original]: nativeOld } };
    expect(checkpointDormantBaseline('web', staged, predecessor, reviewed, verify)).toBe(staged);
    verify.mockImplementation(() => {
      throw new Error('prior revision cannot be proved');
    });
    expect(() => checkpointDormantBaseline('web', raw, predecessor, reviewed, verify)).toThrow(
      'prior revision cannot be proved',
    );
  });

  it('rejects substituted service and foreign revision names before dispatching a revision read', async () => {
    for (const override of [
      { uid: 'other' },
      { latestReadyRevision: 'assistant-agent-foreign' },
      { traffic: [{ revision: 'https://unreviewed.example' }] },
    ]) {
      const read = vi.fn(async () => ({ ...native, ...override }));
      await expect(checkpointNativeRole('agent', binding, runId, source, read)).rejects.toThrow();
      expect(read).toHaveBeenCalledTimes(1);
    }
  });
});
