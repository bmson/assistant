import { execFileSync } from 'node:child_process';
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
  ordinary: vi.fn(),
  review: vi.fn(),
  verifyCurrent: vi.fn(),
  initialize: vi.fn(),
}));
vi.mock('./owner-ordinary-canonical-recovery.js', () => ({
  loadOrdinaryCanonicalRecovery: mocked.ordinary,
}));
vi.mock('./owner-release-bootstrap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./owner-release-bootstrap.js')>()),
  reviewedBootstrap: mocked.review,
  verifyCurrentSnapshot: mocked.verifyCurrent,
}));
vi.mock('./owner-web-tag-cloud.js', () => ({ protectedWebTagCloud: mocked.cloud }));
vi.mock('./owner-web-tag-artifact.js', () => ({ readProtectedWebTagArtifact: mocked.artifact }));
vi.mock('./owner-web-release-native-controller.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./owner-web-release-native-controller.js')>()),
  initializePairedWebLifecycle: mocked.initialize,
}));
vi.mock('./owner-web-release-phase-receipts.js', () => ({
  openPrivateReleasePhaseReceipts: mocked.openReceipts,
  createPrivateReleasePhaseReceipts: mocked.openReceipts,
}));
vi.mock('./owner-web-release-retirement-binding.js', () => ({
  bindCapturedRetirementToLifecycle: mocked.bindRetirement,
}));
vi.mock('./owner-web-release-operator-hold.js', () => ({ verifyOperatorOwnedHold: mocked.hold }));
vi.mock('./owner-web-release-native-proof.js', () => ({
  projectNativeWebSnapshot: mocked.project,
}));

import { registerImageResolution } from './owner-release-image-resolution.js';
import { runWebTagAdmission, verifyAdmissionContext } from './owner-web-tag-admission.js';
import { HISTORICAL_WEB_TAGS, WEB_SERVICE } from './owner-web-tag-retirement.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const source = 'a'.repeat(40);
const webImageRoot = 'us-west1-docker.pkg.dev/bmson-assistant/assistant/web';
const ociManifest = 'application/vnd.oci.image.manifest.v1+json';
const child = JSON.stringify({
  schemaVersion: 2,
  mediaType: ociManifest,
  config: {
    digest: `sha256:${'b'.repeat(64)}`,
    size: 1,
    mediaType: 'application/vnd.oci.image.config.v1+json',
  },
  layers: [
    {
      digest: `sha256:${'b'.repeat(64)}`,
      size: 1,
      mediaType: 'application/vnd.oci.image.layer.v1.tar',
    },
  ],
});
const index = JSON.stringify({
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.index.v1+json',
  manifests: [
    {
      digest: `sha256:${hash(child)}`,
      size: Buffer.byteLength(child),
      mediaType: ociManifest,
      platform: { os: 'linux', architecture: 'amd64' },
    },
  ],
});
const newImage = `${webImageRoot}@sha256:${hash(index)}`;
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
        digest: `sha256:${hash(index)}`,
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
function ordinaryFixture() {
  const canonicalRevision = 'assistant-web-recovered';
  const candidateRevision = 'assistant-web-old-paused';
  const candidateTag = 'candidate-111-1';
  const retiredTag = 'resume-111-1';
  const oldSource = 'd'.repeat(40);
  const evidenceSha256 = 'e'.repeat(64);
  const canonicalRevisionSha256 = 'f'.repeat(64);
  const canonicalRevisionUidSha256 = 'a'.repeat(64);
  const canonicalImage = `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'d'.repeat(64)}`;
  const definition = {
    revision: canonicalRevision,
    uid: 'service-uid',
    proof: { uid: canonicalRevisionUidSha256, source: oldSource },
    revisionSha256: canonicalRevisionSha256,
    image: canonicalImage,
  };
  mocked.ordinary.mockReturnValue({
    canonicalRevision,
    candidateRevision,
    candidateTag,
    retiredAliases: {
      candidate: { tag: candidateTag, uriSha256: hash(uri(candidateTag)) },
      resume: { tag: retiredTag, uriSha256: hash(uri(retiredTag)) },
    },
    canonicalServiceUidSha256: hash(definition.uid),
    canonicalRevisionUidSha256,
    canonicalRevisionSha256,
    canonicalImage,
    priorBarrierSha256: 'c'.repeat(64),
    evidenceSha256,
  });
  mocked.review.mockReturnValue({ kind: 'current-snapshot', services: { web: definition } });
  vi.stubEnv('OWNER_RELEASE_BOOTSTRAP_RECEIPT', '{}');
  native[canonicalRevision] = revision(canonicalRevision, canonicalImage, false);
  native[candidateRevision] = revision(candidateRevision, canonicalImage, true);
  setService([], canonicalImage);
  service.traffic = [{ type, revision: canonicalRevision, percent: 100 }];
  service.trafficStatuses = structuredClone(service.traffic);

  const manifestFile = process.env.OWNER_TAG_MANIFEST_PATH as string;
  const { manifestDigest: _currentDigest, ...template } = JSON.parse(
    readFileSync(manifestFile, 'utf8'),
  );
  template.release = oldSource;
  template.components.web.image = canonicalImage;
  template.components.web.digest = `sha256:${'d'.repeat(64)}`;
  const manifest = JSON.stringify({ ...template, manifestDigest: hash(JSON.stringify(template)) });
  const archivePath = join(temp, 'old-creation.zip');
  const receiptFile = join(temp, 'owner-web-tag-creation.json');
  const priorManifestFile = join(temp, 'release-manifest.json');
  writeFileSync(priorManifestFile, manifest);
  writeFileSync(
    receiptFile,
    JSON.stringify({
      format: 1,
      runId: 111,
      runAttempt: 1,
      source: oldSource,
      manifestSha256: hash(manifest),
      records: [
        {
          kind: 'candidate',
          revision: candidateRevision,
          image: canonicalImage,
          writesPaused: true,
          uriSha256: hash(uri(candidateTag)),
          legacyBarrierCompleted: false,
        },
      ],
    }),
  );
  execFileSync('zip', ['-q', '-0', '-X', '-j', archivePath, receiptFile, priorManifestFile]);
  const archiveBytes = readFileSync(archivePath);
  mocked.artifact.mockResolvedValue({
    runMetadata: {
      repository: { full_name: 'bmson/assistant' },
      head_repository: { full_name: 'bmson/assistant' },
      path: '.github/workflows/deploy.yml',
      head_branch: 'main',
      event: 'workflow_dispatch',
      id: 111,
      run_attempt: 1,
      head_sha: oldSource,
      status: 'completed',
      conclusion: 'failure',
    },
    artifactMetadata: {
      name: `owner-web-tag-creation-${oldSource}-111-1`,
      digest: `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`,
      size_in_bytes: archiveBytes.length,
      expired: false,
      workflow_run: { id: 111, head_sha: oldSource },
    },
    archiveBytes,
  });
  mocked.openReceipts.mockReturnValue({
    readCurrent: () => ({
      context: { currentBinding: { ordinaryRecoverySha256: evidenceSha256 } },
      phase: 'promotedP',
      snapshot: { revisions: {} },
    }),
  });
  return { canonicalRevision, candidateRevision, candidateTag, retiredTag, evidenceSha256 };
}

describe('ordinary recovered canonical admission', () => {
  it('uses the genuine candidate-only archive and preserves the no-write 600-second drain', async () => {
    const f = ordinaryFixture();
    await runWebTagAdmission('--capture');
    const capture = JSON.parse(readFileSync(join(temp, 'owner-web-tag-capture.json'), 'utf8'));
    expect(capture.canonical).toBe(f.canonicalRevision);
    expect(capture.ordinaryRecoverySha256).toBe(f.evidenceSha256);
    expect(capture.proofs).toMatchObject([
      {
        revision: f.candidateRevision,
        tag: f.candidateTag,
        writesPaused: true,
        legacyBarrierCompleted: false,
        nativeTagObserved: false,
      },
    ]);
    expect(mocked.artifact).toHaveBeenCalledExactlyOnceWith(111, 1);
    expect(mocked.verifyCurrent).toHaveBeenCalledOnce();
    await runWebTagAdmission('--native-init');
    expect(mocked.initialize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        canonical: f.canonicalRevision,
        retiredTags: expect.arrayContaining([f.candidateTag, f.retiredTag]),
        currentBinding: expect.objectContaining({ ordinaryRecoverySha256: f.evidenceSha256 }),
      }),
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
    setService([{ tag: candidate, revision: 'assistant-web-new-paused', percent: 100 }], newImage);
    await runWebTagAdmission('--retire-after-paused');
    expect(io.patchTraffic).not.toHaveBeenCalled();
    expect(io.drain).toHaveBeenCalledExactlyOnceWith(600);
    await runWebTagAdmission('--verify-admission');
  });

  it('rejects a candidate receipt that conflicts with the independently observed retired alias URI', async () => {
    ordinaryFixture();
    const evidence = mocked.ordinary();
    evidence.retiredAliases.candidate.uriSha256 = hash('different candidate URI');
    await expect(runWebTagAdmission('--capture')).rejects.toThrow(
      'Reviewed historical candidate ownership changed',
    );
    expect(io.patchTraffic).not.toHaveBeenCalled();
  });

  it('rejects a desired historical alias during capture even when the observed route is untagged', async () => {
    const f = ordinaryFixture();
    service.traffic = [{ type, revision: f.canonicalRevision, percent: 100, tag: f.retiredTag }];
    await expect(runWebTagAdmission('--capture')).rejects.toThrow(
      'Desired and observed traffic differ',
    );
    expect(mocked.artifact).not.toHaveBeenCalled();
  });

  it.each(['candidateTag', 'retiredTag'] as const)(
    'rejects a historical %s that reappears before drain',
    async (alias) => {
      const f = ordinaryFixture();
      await runWebTagAdmission('--capture');
      setService(
        [
          { tag: candidate, revision: 'assistant-web-new-paused', percent: 100 },
          { tag: f[alias], revision: f.candidateRevision },
        ],
        newImage,
      );
      await expect(runWebTagAdmission('--retire-after-paused')).rejects.toThrow('alias reappeared');
      expect(io.patchTraffic).not.toHaveBeenCalled();
      expect(io.drain).not.toHaveBeenCalled();
    },
  );

  it('blocks a reviewed local resume alias that returns after the drain', async () => {
    const f = ordinaryFixture();
    await runWebTagAdmission('--capture');
    setService([{ tag: candidate, revision: 'assistant-web-new-paused', percent: 100 }], newImage);
    await runWebTagAdmission('--retire-after-paused');
    setService(
      [
        { tag: candidate, revision: 'assistant-web-new-paused', percent: 100 },
        { tag: f.retiredTag, revision: f.canonicalRevision },
      ],
      newImage,
    );
    await expect(runWebTagAdmission('--verify-admission')).rejects.toThrow('barrier incomplete');
    expect(io.patchTraffic).not.toHaveBeenCalled();
  });
});

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
  it('binds protected shell resume recording to the exact alias and verified native child', async () => {
    await completeBarrier();
    const expected = 'assistant-web-r-123-1-aaaaaaaa';
    setService(
      [
        { tag: candidate, revision: 'assistant-web-new-paused', percent: 100 },
        { tag: resume, revision: 'assistant-web-new-resume' },
      ],
      newImage,
    );
    vi.stubEnv('OWNER_TAG_EXPECTED_RESUME_REVISION', expected);
    await expect(runWebTagAdmission('--record-resume')).rejects.toThrow('exact protected revision');

    setService(
      [
        { tag: candidate, revision: 'assistant-web-new-paused', percent: 100 },
        { tag: resume, revision: expected },
      ],
      newImage,
    );
    const resolved = registerImageResolution(
      newImage,
      Buffer.from(index),
      Buffer.from(child),
    ).resolved;
    const readback = revision(expected, resolved, false, true);
    const resolvedNative = {
      ...readback,
      containers: readback.containers.map((container) => ({ ...container, name: 'web-1' })),
      containerStatuses: [{ name: 'web-1', imageDigest: newImage }],
    };
    native[expected] = resolvedNative;
    await expect(runWebTagAdmission('--record-resume')).rejects.toThrow('Immutable image');
    native[expected] = {
      ...resolvedNative,
      containerStatuses: [{ name: 'web-1', imageDigest: resolved }],
      containers: resolvedNative.containers.map((container) => ({
        ...container,
        env: container.env.map((entry) =>
          entry.name === 'ASSISTANT_RELEASE_SOURCE_SHA'
            ? { ...entry, value: '9'.repeat(40) }
            : entry,
        ),
      })),
    };
    await expect(runWebTagAdmission('--record-resume')).rejects.toThrow('source identity');
    native[expected] = {
      ...resolvedNative,
      containerStatuses: [{ name: 'web-1', imageDigest: resolved }],
    };
    await runWebTagAdmission('--record-resume');
    const { records } = JSON.parse(readFileSync(join(temp, 'owner-web-tag-creation.json'), 'utf8'));
    expect(records[1]).toMatchObject({ revision: expected, image: newImage, writesPaused: false });
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
