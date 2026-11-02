import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  cloud: vi.fn(),
  artifact: vi.fn(),
  openReceipts: vi.fn(),
  bindRetirement: vi.fn(),
  hold: vi.fn(),
  project: vi.fn(),
}));
vi.mock('./owner-web-tag-cloud.js', () => ({ protectedWebTagCloud: mocked.cloud }));
vi.mock('./owner-web-tag-artifact.js', () => ({ readProtectedWebTagArtifact: mocked.artifact }));
vi.mock('./owner-web-release-phase-receipts.js', () => ({
  openPrivateReleasePhaseReceipts: mocked.openReceipts,
}));
vi.mock('./owner-web-release-retirement-binding.js', () => ({
  bindCapturedRetirementToLifecycle: mocked.bindRetirement,
}));
vi.mock('./owner-web-release-operator-hold.js', () => ({ verifyOperatorOwnedHold: mocked.hold }));
vi.mock('./owner-web-release-native-proof.js', () => ({
  projectNativeWebSnapshot: mocked.project,
}));

import { runWebTagAdmission, verifyAdmissionContext } from './owner-web-tag-admission.js';
import { HISTORICAL_WEB_TAGS, WEB_SERVICE } from './owner-web-tag-retirement.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const source = 'a'.repeat(40),
  newImage = `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'b'.repeat(64)}`;
const candidate = 'candidate-123-1',
  resume = 'resume-123-1';
const uri = (tag: string) => `https://${tag}---assistant-web-3gimfiaifa-uw.a.run.app`;
const type = 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION';
let temp: string;
let service: Record<string, unknown>;
let native: Record<string, unknown>;
const io = {
  readService: vi.fn(),
  readRevision: vi.fn(),
  patchTraffic: vi.fn(),
  waitOperation: vi.fn(),
  drain: vi.fn(),
};
function revision(name: string, image: string, paused: boolean, own = false) {
  return {
    name: `${WEB_SERVICE}/revisions/${name}`,
    serviceAccount: 'runtime@bmson-assistant.iam.gserviceaccount.com',
    timeout: '300s',
    containers: [
      {
        image,
        env: [
          { name: 'ASSISTANT_RELEASE_WRITES_PAUSED', value: String(paused) },
          { name: 'PRIVATE', value: 'private-never-publish' },
          ...(own
            ? [
                { name: 'ASSISTANT_RELEASE_SOURCE_SHA', value: source },
                { name: 'ASSISTANT_RELEASE_WORKFLOW_RUN_ID', value: '123' },
                { name: 'ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT', value: '1' },
              ]
            : []),
        ],
      },
    ],
  };
}
function setService(
  rows: { tag: string; revision: string; percent?: number }[],
  currentImage: string,
) {
  service = {
    name: WEB_SERVICE,
    uid: 'service-uid',
    etag: 'fresh',
    generation: '1',
    observedGeneration: '1',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    labels: { unchanged: 'yes' },
    template: {
      serviceAccount: 'runtime@bmson-assistant.iam.gserviceaccount.com',
      containers: [{ image: currentImage }],
    },
    traffic: rows.map((r) => ({ type, ...r })),
    trafficStatuses: rows.map((r) => ({ type, ...r, uri: uri(r.tag) })),
  };
}
function staged(promoted = false) {
  const current = HISTORICAL_WEB_TAGS[1];
  if (!current) throw new Error('fixture');
  setService(
    [
      { tag: current.tag, revision: current.revision, ...(promoted ? {} : { percent: 100 }) },
      {
        tag: candidate,
        revision: 'assistant-web-new-paused',
        ...(promoted ? { percent: 100 } : {}),
      },
    ],
    newImage,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  temp = mkdtempSync(join(tmpdir(), 'owner-tag-admission-'));
  const manifest = {
    format: 1,
    release: source,
    selected: ['agent', 'web'],
    storageDriver: 'firestore',
    schemaVersion: 1,
    components: {
      web: {
        image: newImage,
        digest: `sha256:${'b'.repeat(64)}`,
        apiContract: 1,
        peerApi: { min: 1, max: 1 },
        schema: { min: 1, max: 1 },
      },
      agent: {
        image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/agent@sha256:${'c'.repeat(64)}`,
        digest: `sha256:${'c'.repeat(64)}`,
        apiContract: 1,
        peerApi: { min: 1, max: 1 },
        schema: { min: 1, max: 1 },
      },
    },
  };
  const manifestDigest = hash(JSON.stringify(manifest));
  const manifestPath = join(temp, 'assistant-release.json');
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, manifestDigest }));
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'bmson/assistant',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '123',
    GITHUB_SHA: source,
    GITHUB_WORKFLOW_SHA: source,
    GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_run',
    GCP_PROJECT: 'bmson-assistant',
    GCP_DEPLOY_SERVICE_ACCOUNT: 'deployer@bmson-assistant.iam.gserviceaccount.com',
    GCP_WORKLOAD_IDENTITY_PROVIDER:
      'projects/123/locations/global/workloadIdentityPools/ci/providers/github',
    RUNNER_TEMP: temp,
    OWNER_TAG_RELEASE_SOURCE: source,
    OWNER_TAG_STAGING_TAG: candidate,
    OWNER_TAG_MANIFEST_PATH: manifestPath,
    OWNER_TAG_MANIFEST_DIGEST: manifestDigest,
  }))
    vi.stubEnv(key, value);
  native = Object.fromEntries(
    HISTORICAL_WEB_TAGS.map((p) => [p.revision, revision(p.revision, p.image, false)]),
  );
  native['assistant-web-new-paused'] = revision('assistant-web-new-paused', newImage, true, true);
  native['assistant-web-new-resume'] = revision('assistant-web-new-resume', newImage, false, true);
  const current = HISTORICAL_WEB_TAGS[1];
  if (!current) throw new Error('fixture');
  setService([{ tag: current.tag, revision: current.revision, percent: 100 }], current.image);
  io.readService.mockImplementation(async () => structuredClone(service));
  io.readRevision.mockImplementation(async (name: string) => {
    if (!native[name]) throw new Error('Missing immutable revision');
    return structuredClone(native[name]);
  });
  io.patchTraffic.mockImplementation(async (patch: { traffic: Record<string, unknown>[] }) => {
    service.traffic = patch.traffic;
    service.trafficStatuses = patch.traffic.map((row) => ({ ...row, uri: uri(String(row.tag)) }));
    return { name: 'fixed-operation' };
  });
  io.waitOperation.mockResolvedValue(undefined);
  io.drain.mockResolvedValue(undefined);
  mocked.cloud.mockResolvedValue(io);
  mocked.openReceipts.mockReturnValue({
    readCurrent: () => ({ context: {}, phase: 'promotedP', snapshot: { revisions: {} } }),
  });
  mocked.bindRetirement.mockImplementation((_state: unknown, retirementIo: unknown) => ({
    io: retirementIo,
    markUnresolved: vi.fn(),
    complete: vi.fn(),
  }));
  mocked.hold.mockResolvedValue({});
  mocked.project.mockReturnValue({});
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(temp, { recursive: true, force: true });
});
async function completeBarrier() {
  await runWebTagAdmission('--capture');
  staged();
  await runWebTagAdmission('--record-candidate');
  staged(true);
  await runWebTagAdmission('--retire-after-paused');
}
describe('paired native admission command', () => {
  it('captures absent legacy alias with immutable timeout proof and always completes600 before admission', async () => {
    await completeBarrier();
    expect(io.readRevision).toHaveBeenCalledWith(HISTORICAL_WEB_TAGS[0]?.revision);
    expect(io.patchTraffic).toHaveBeenCalledTimes(1);
    expect(io.drain).toHaveBeenCalledWith(600);
    await runWebTagAdmission('--verify-admission');
    const saved = readFileSync(join(temp, 'owner-web-tag-barrier.json'), 'utf8');
    expect(saved).toContain('"drainCompleted":true');
    expect(saved).not.toContain('private-never-publish');
  });
  it('rejects unknown operator alias before capture or mutation', async () => {
    const rows = service.trafficStatuses as Record<string, unknown>[];
    const desired = service.traffic as Record<string, unknown>[];
    rows.push({ type, tag: 'operator', revision: 'assistant-web-operator', uri: uri('operator') });
    desired.push({ type, tag: 'operator', revision: 'assistant-web-operator' });
    native['assistant-web-operator'] = revision('assistant-web-operator', newImage, false);
    await expect(runWebTagAdmission('--capture')).rejects.toThrow('Unknown operator alias');
    expect(io.patchTraffic).not.toHaveBeenCalled();
  });
  it.each(['--verify-admission', '--record-resume'])(
    'refuses %s without completed barrier',
    async (mode) => {
      await runWebTagAdmission('--capture');
      staged(true);
      await expect(runWebTagAdmission(mode)).rejects.toThrow();
      expect(io.patchTraffic).not.toHaveBeenCalled();
    },
  );
  it('drain failure produces no completion and cannot authorize admission', async () => {
    await runWebTagAdmission('--capture');
    staged(true);
    io.drain.mockRejectedValue(new Error('Interrupted drain'));
    await expect(runWebTagAdmission('--retire-after-paused')).rejects.toThrow('unresolved');
    await expect(runWebTagAdmission('--verify-admission')).rejects.toThrow();
  });
  it('post-barrier operator alias blocks the fresh admission check', async () => {
    await completeBarrier();
    (service.traffic as unknown[]).push({
      type,
      revision: 'assistant-web-operator',
      tag: 'operator',
    });
    (service.trafficStatuses as unknown[]).push({
      type,
      revision: 'assistant-web-operator',
      tag: 'operator',
      uri: uri('operator'),
    });
    await expect(runWebTagAdmission('--verify-admission')).rejects.toThrow();
  });
  it.each(['etag', 'generation'] as const)(
    'refuses metadata-only %s drift after the drain before admission',
    async (kind) => {
      await completeBarrier();
      if (kind === 'etag') service.etag = 'etag-external-change';
      else {
        service.generation = '2';
        service.observedGeneration = '2';
      }
      await expect(runWebTagAdmission('--verify-admission')).rejects.toThrow(
        'Service version changed',
      );
    },
  );
  it.each(['serviceEtag', 'serviceGeneration'] as const)(
    'refuses a barrier missing required %s evidence',
    async (field) => {
      await completeBarrier();
      const file = join(temp, 'owner-web-tag-barrier.json');
      const receipt = JSON.parse(readFileSync(file, 'utf8'));
      delete receipt.result[field];
      writeFileSync(file, JSON.stringify(receipt));
      await expect(runWebTagAdmission('--verify-admission')).rejects.toThrow('barrier incomplete');
    },
  );
  it('records candidate then verified resume with completed barrier in public receipt only', async () => {
    await completeBarrier();
    await runWebTagAdmission('--verify-admission');
    setService(
      [
        { tag: candidate, revision: 'assistant-web-new-paused', percent: 100 },
        { tag: resume, revision: 'assistant-web-new-resume' },
      ],
      newImage,
    );
    await runWebTagAdmission('--record-resume');
    const saved = readFileSync(join(temp, 'owner-web-tag-creation.json'), 'utf8');
    const receipt = JSON.parse(saved);
    expect(
      receipt.records.map((r: { legacyBarrierCompleted: boolean }) => r.legacyBarrierCompleted),
    ).toEqual([false, true]);
    expect(saved).not.toContain('private-never-publish');
  });
  it('fails before patch for changed UID or unsafe old native timeout', async () => {
    await runWebTagAdmission('--capture');
    staged(true);
    service.uid = 'recreated';
    await expect(runWebTagAdmission('--retire-after-paused')).rejects.toThrow(
      'Captured service identity changed',
    );
    service.uid = 'service-uid';
    const old = HISTORICAL_WEB_TAGS[0];
    if (!old) throw new Error('fixture');
    (native[old.revision] as { timeout: string }).timeout = '601s';
    await expect(runWebTagAdmission('--retire-after-paused')).rejects.toThrow('timeout');
    expect(io.patchTraffic).not.toHaveBeenCalled();
  });
  it('rejects source/context drift before provider access', async () => {
    expect(() => verifyAdmissionContext({ ...process.env, GITHUB_RUN_ATTEMPT: '2' })).toThrow();
    vi.stubEnv('OWNER_TAG_RELEASE_SOURCE', 'c'.repeat(40));
    await expect(runWebTagAdmission('--capture')).rejects.toThrow();
    expect(mocked.cloud).not.toHaveBeenCalled();
  });
});
