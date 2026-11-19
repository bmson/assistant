import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type BootstrapReceipt, bootstrapDigest } from './owner-release-current-snapshot.js';
import {
  assertRestoreTargetReviewFresh,
  RESTORE_TARGET_REVIEW_DOMAIN,
  verifyRestoreTargetReview,
} from './owner-restore-target-review.js';

const source = 'e'.repeat(40);
const original = '1c2ea3907bf17b14368846708002f9d4633f2092';
const buildRun = '123456';
const run = '123457';
const exactManifest = '9ca6dcbb6a1c4b6e25ca6ea857c86ae1c3103a75d9a8e4e26af801f7b1c32647';
const roles = ['agent', 'web'] as const;
const repository = 'us-west1-docker.pkg.dev/bmson-assistant/assistant';
const scope = 'projects/friendly-vigil-514906-p2/locations/us-west1/services';
const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const images = {
  agent: {
    parent: 'sha256:1298263587c4021246c7a4832e174ea95bb5a5a2ffef8359b989ba60d694690b',
    child: 'sha256:7ab38d59edcf5d5f47a0884a928249ffd4e0457aa67f3cbf948fae4cb17c65e5',
  },
  web: {
    parent: 'sha256:34d027a7e04daf667428d615f60fb537b5090caf785a3c4f65db0a714b42eb0a',
    child: 'sha256:fde5cc2ae8bfe91405a4c5a56bcac59cff74f951f89e542a05b387fcc82e8d36',
  },
};
const packSha256 = sha('test pack');
const fixedNow = Date.parse('2026-10-01T09:00:00Z');

function signed(value: unknown, domain = RESTORE_TARGET_REVIEW_DOMAIN) {
  const payload = Buffer.from(JSON.stringify(value));
  return JSON.stringify({
    payload: payload.toString('base64url'),
    signature: sign(null, Buffer.concat([Buffer.from(domain), payload]), key.privateKey).toString(
      'base64url',
    ),
  });
}

function fixture(now = fixedNow) {
  const bindings = roles.map((role) => {
    const image = `${repository}/${role}@${images[role].parent}`;
    return {
      service: `projects/bmson-assistant/locations/us-west1/services/assistant-${role}`,
      uid: `baseline-${role}-service`,
      revision: `assistant-${role}-original-test`,
      image,
      serviceSha256: sha(`baseline-${role}-service`),
      revisionSha256: sha(`baseline-${role}-revision`),
      automaticScaling: { scalingMode: 'AUTOMATIC' },
      proof: {
        uid: sha(`baseline-${role}-uid`),
        image,
        source: original,
        runId: '44263661117',
        attempt: '1',
        manifest: exactManifest,
        paused: false,
        templateSha256: sha(`baseline-${role}-template`),
      },
    };
  });
  const [agent, web] = bindings;
  if (!agent || !web) throw new Error('invalid test fixture');
  const current: BootstrapReceipt = {
    format: 1,
    kind: 'disabled-bootstrap',
    source,
    closureReceiptSha256: sha('closure'),
    drainReceiptSha256: sha('drain'),
    recoveryReceiptSha256: sha('recovery'),
    services: { agent, web },
  };
  const expected = {
    current,
    packSha256,
    buildRunId: buildRun,
    runId: run,
    candidateBuildSha256: sha('candidate verified build'),
    candidateReviewSha256: sha('candidate verified review'),
  };
  const observed = (outcome: string) => ({ outcome, evidenceSha256: sha(outcome) });
  const target = (role: (typeof roles)[number]) => ({
    ...images[role],
    baselineUidSha256: current.services[role].proof.uid,
    baselineTemplateSha256: current.services[role].proof.templateSha256,
    rehearsalUidSha256: sha(`rehearsal-${role}-fresh-revision`),
  });
  const payload = {
    format: 1,
    kind: 'owner-release-restore-target',
    purpose: 'restore-paused-original-runtime-pair',
    source,
    buildRunId: buildRun,
    buildAttempt: '1',
    candidateBuildSha256: expected.candidateBuildSha256,
    candidateReviewSha256: expected.candidateReviewSha256,
    originalSource: original,
    originalRunId: '44263661117',
    originalAttempt: '1',
    project: 'bmson-assistant',
    region: 'us-west1',
    database: 'assistant-production',
    bootstrapSha256: bootstrapDigest(current),
    packSha256,
    observedAt: now - 30_000,
    expiresAt: now + 60_000,
    targets: { agent: target('agent'), web: target('web') },
    rehearsal: {
      project: 'friendly-vigil-514906-p2',
      region: 'us-west1',
      importedBytes: observed('verified-exact-runtime-bytes'),
      createdPausedPair: observed('verified-fresh-paused-pair'),
      heldRestore: observed('verified-held-restore'),
      heldForward: observed('verified-held-forward'),
    },
  };
  return { expected, payload };
}

describe('independently signed original restore targets', () => {
  it('binds the known build to exact runtime targets and returns the actual dispatch', () => {
    const { expected, payload } = fixture();
    const result = verifyRestoreTargetReview(signed(payload), publicKey, expected, fixedNow);
    expect(result).toMatchObject({
      source,
      runId: run,
      buildRunId: buildRun,
      reviewSha256: sha(JSON.stringify(payload)),
      targets: {
        agent: { ...payload.targets.agent, image: `${repository}/agent@${images.agent.child}` },
        web: { ...payload.targets.web, image: `${repository}/web@${images.web.child}` },
      },
    });
    expect(() => assertRestoreTargetReviewFresh(result, result.expiresAt)).toThrow(/stale/);
  });

  it('requires a signature in the restore domain and pins the signer', () => {
    const { expected, payload } = fixture();
    const other = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64url');
    expect(() =>
      verifyRestoreTargetReview(signed(payload, ''), publicKey, expected, fixedNow),
    ).toThrow(/signature/);
    expect(() => verifyRestoreTargetReview(signed(payload), other, expected, fixedNow)).toThrow(
      /signature/,
    );
  });

  it.each([
    { project: 'foreign-project' },
    { database: 'foreign-database' },
    { region: 'foreign-region' },
    { originalRunId: '44263661118' },
    { originalAttempt: '2' },
    { buildRunId: '789' },
    { buildAttempt: '2' },
    { packSha256: sha('replacement pack') },
    { bootstrapSha256: sha('replacement bootstrap') },
    { candidateBuildSha256: sha('replacement candidate build') },
    { candidateReviewSha256: sha('replacement candidate review') },
    { source: 'b'.repeat(40) },
    { purpose: 'activate-original-runtime-pair' },
    { observedAt: fixedNow + 1 },
    { expiresAt: fixedNow },
    { expiresAt: fixedNow + 25 * 60 * 60 * 1000 },
  ])('rejects altered signed scope or time %j', (overrides) => {
    const { expected, payload } = fixture();
    expect(() =>
      verifyRestoreTargetReview(
        signed({ ...payload, ...overrides }),
        publicKey,
        expected,
        fixedNow,
      ),
    ).toThrow();
  });

  it('rejects a swapped child, substituted template, reused UID, or unproved held case', () => {
    const { expected, payload } = fixture();
    for (const change of [
      {
        targets: { ...payload.targets, web: { ...payload.targets.web, child: images.agent.child } },
      },
      {
        targets: {
          ...payload.targets,
          web: { ...payload.targets.web, baselineTemplateSha256: sha('different template') },
        },
      },
      {
        targets: {
          ...payload.targets,
          web: {
            ...payload.targets.web,
            rehearsalUidSha256: payload.targets.web.baselineUidSha256,
          },
        },
      },
      {
        rehearsal: {
          ...payload.rehearsal,
          heldForward: { outcome: 'unverified', evidenceSha256: sha('unverified') },
        },
      },
    ]) {
      expect(() =>
        verifyRestoreTargetReview(signed({ ...payload, ...change }), publicKey, expected, fixedNow),
      ).toThrow();
    }
  });

  it('uses only the source-pinned key in a real subprocess', () => {
    const root = mkdtempSync(join(tmpdir(), 'restore-target-review-test-'));
    const repo = fileURLToPath(new URL('../', import.meta.url));
    const cli = join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const now = Date.now();
    const { expected, payload } = fixture(now);
    const prebuilt = {
      source,
      runId: buildRun,
      completedAt: now - 120_000,
      digests: Object.fromEntries(
        ['agent', 'web', 'browser', 'code', 'processor'].map((role) => [
          role,
          `sha256:${sha(role)}`,
        ]),
      ),
    };
    // This is the project-specific manifest emitted by the real API3 verifier.
    const manifest = sha(
      JSON.stringify({
        api: 3,
        roles: { agent: prebuilt.digests.agent, web: prebuilt.digests.web },
        run: buildRun,
        schema: 1,
        scope: 'synthetic-google-ai-only',
        source,
      }),
    );
    const agent = `assistant-agent-p-${buildRun}-1-eeeeeeee`;
    const web = `assistant-web-p-${buildRun}-1-eeeeeeee`;
    const parked = `assistant-agent-park-${buildRun}-1-eeeeeeee`;
    const baseline = 'assistant-agent-historical';
    const closed = (role: string, revision: string) => ({
      service: `${scope}/assistant-${role}`,
      revision,
      latestCreated: revision,
      latestReady: revision,
      generation: '14',
      observedGeneration: '14',
      scalingMode: 'MANUAL',
      manualInstances: 0,
      desired: [{ revision, percent: 100, tag: '' }],
      observed: [{ revision, percent: 100, tag: '' }],
    });
    const candidate = {
      format: 1,
      kind: 'firestore-api3-recovery-review',
      source,
      buildRunId: buildRun,
      observedAt: now - 60_000,
      expiresAt: now + 120_000,
      manifest,
      images: { agent: prebuilt.digests.agent, web: prebuilt.digests.web },
      staged: {
        agent: {
          service: 'assistant-agent',
          revision: agent,
          source,
          manifest,
          writesPaused: true,
          mcpOAuthEnabled: false,
        },
        web: {
          revision: web,
          sha: source,
          status: 200,
          ready: true,
          writesPaused: true,
          peer: 'staged',
        },
        agentTag: `candidate-${buildRun}-1`,
        agentTagPercent: 0,
      },
      mixed: { agentRevision: baseline, agentApi: 1, webRevision: web, webApi: 3 },
      parking: {
        revision: parked,
        tag: `park-${buildRun}-1`,
        percent: 0,
        canonical: baseline,
        latestReady: parked,
        source,
        manifest,
        writesPaused: true,
        mcpOAuthEnabled: false,
        createdWithoutTag: parked,
        priorLatest: `assistant-agent-r-${buildRun}-1-eeeeeeee`,
      },
      closed: { agent: closed('agent', parked), web: closed('web', web) },
      evidence: Object.fromEntries(
        ['staged', 'mixed', 'successor', 'parkCreation', 'startup', 'closed', 'images'].map(
          (name) => [name, sha(name)],
        ),
      ),
    };
    const build = join(root, 'verified-build.json');
    const keyPath = join(root, 'infra', 'gcp', 'api3-recovery-review-key.mjs');
    try {
      mkdirSync(join(root, 'infra'), { mode: 0o700 });
      cpSync(join(repo, 'scripts'), join(root, 'scripts'), { recursive: true });
      cpSync(join(repo, 'infra', 'gcp'), join(root, 'infra', 'gcp'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      writeFileSync(build, JSON.stringify(prebuilt), { flag: 'wx', mode: 0o600 });
      writeFileSync(
        keyPath,
        `export const API3_RECOVERY_REVIEW_PUBLIC_KEY = ${JSON.stringify(publicKey)};\n`,
      );
      writeFileSync(
        join(root, 'run.ts'),
        [
          "import { protectedRestoreTargetReview } from './scripts/owner-restore-target-review.ts';",
          'try {',
          'console.log(JSON.stringify(protectedRestoreTargetReview(process.env, JSON.parse(process.env.FIXTURE_CURRENT), process.env.FIXTURE_PACK)));',
          '} catch (error) { console.error(error.message); process.exitCode = 1; }',
        ].join('\n'),
      );
      const bound = {
        ...payload,
        candidateBuildSha256: bootstrapDigest(prebuilt),
        candidateReviewSha256: bootstrapDigest(candidate),
      };
      const dispatch = {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'bmson/assistant',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_SHA: source,
        GITHUB_WORKFLOW_SHA: source,
        IMAGE_TAG: source,
        RELEASE_COMPONENTS: 'agent,web',
        GCP_PROJECT: 'bmson-assistant',
        GCP_REGION: 'us-west1',
        GITHUB_RUN_ID: run,
        RELEASE_PREBUILT_RUN_ID: buildRun,
        RELEASE_PREBUILT_IMAGES_PATH: build,
        OWNER_RELEASE_RESTORE_TARGET_PROOF: signed(bound),
        API3_RECOVERY_PROOF: signed(candidate, ''),
        FIXTURE_CURRENT: JSON.stringify(expected.current),
        FIXTURE_PACK: packSha256,
      };
      const invoke = (env: Record<string, string>) =>
        spawnSync(process.execPath, [cli, join(root, 'run.ts')], {
          cwd: root,
          env,
          encoding: 'utf8',
          timeout: 8_000,
        });
      const result = invoke(dispatch);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ runId: run, buildRunId: buildRun });
      expect(invoke({ ...dispatch, GITHUB_RUN_ATTEMPT: '2' }).stderr).toMatch(
        /untrusted production dispatch/,
      );
      const dispatchKey = generateKeyPairSync('ed25519')
        .publicKey.export({ type: 'spki', format: 'der' })
        .toString('base64url');
      writeFileSync(
        keyPath,
        `export const API3_RECOVERY_REVIEW_PUBLIC_KEY = ${JSON.stringify(dispatchKey)};\n`,
      );
      expect(invoke({ ...dispatch, API3_RECOVERY_REVIEW_PUBLIC_KEY: publicKey }).status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
