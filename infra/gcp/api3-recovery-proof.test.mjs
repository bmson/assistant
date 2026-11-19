import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_ROOT,
  protectedRecoveryReview,
  ROLES,
  rehearsalManifest,
  validatePrebuiltImages,
  verifyApi3RecoveryProof,
  verifyPromotionManifest,
} from './api3-recovery-proof.mjs';
import { createManifest } from './release-manifest.mjs';
import {
  verifyBuildRun,
  verifyReuseContext,
  verifyRoleReceipt,
} from './verify-prebuilt-firestore.mjs';

const source = 'e'.repeat(40);
const runId = '123456';
const now = Date.parse('2026-10-01T09:00:00Z');
const prebuilt = {
  source,
  runId,
  completedAt: now - 600_000,
  digests: Object.fromEntries(
    ROLES.map((role, index) => [role, `sha256:${String(index).repeat(64)}`]),
  ),
};
const root = 'projects/friendly-vigil-514906-p2/locations/us-west1/services';
const old = 'assistant-agent-previous';
const agent = 'assistant-agent-p-123456-1-eeeeeeee';
const web = 'assistant-web-p-123456-1-eeeeeeee';
const parked = 'assistant-agent-park-123456-1-eeeeeeee';
const manifest = rehearsalManifest(prebuilt);
const reviewKey = generateKeyPairSync('ed25519');
const publicKey = reviewKey.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

function closed(role, revision) {
  const rows = [{ revision, percent: 100, tag: '' }];
  return {
    service: `${root}/assistant-${role}`,
    revision,
    latestCreated: revision,
    latestReady: revision,
    generation: '14',
    observedGeneration: '14',
    scalingMode: 'MANUAL',
    manualInstances: 0,
    desired: structuredClone(rows),
    observed: structuredClone(rows),
  };
}
function observations() {
  return {
    format: 1,
    kind: 'firestore-api3-recovery-review',
    source,
    buildRunId: runId,
    observedAt: now - 300_000,
    expiresAt: now + 60_000,
    manifest,
    images: { agent: prebuilt.digests.agent, web: prebuilt.digests.web },
    staged: {
      agentTag: 'candidate-123456-1',
      agentTagPercent: 0,
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
    },
    mixed: { agentRevision: old, agentApi: 1, webRevision: web, webApi: 3 },
    parking: {
      revision: parked,
      tag: 'park-123456-1',
      percent: 0,
      canonical: old,
      latestReady: parked,
      source,
      manifest,
      writesPaused: true,
      mcpOAuthEnabled: false,
      createdWithoutTag: parked,
      priorLatest: 'assistant-agent-r-123456-1-eeeeeeee',
    },
    closed: { agent: closed('agent', parked), web: closed('web', web) },
    evidence: Object.fromEntries(
      ['staged', 'mixed', 'successor', 'parkCreation', 'startup', 'closed', 'images'].map(
        (name) => [name, 'f'.repeat(64)],
      ),
    ),
  };
}
function signed(value, key = reviewKey.privateKey) {
  const payload = Buffer.from(JSON.stringify(value));
  return JSON.stringify({
    payload: payload.toString('base64url'),
    signature: sign(null, payload, key).toString('base64url'),
  });
}

describe('authenticated recovery review', () => {
  it('accepts only a verified review with the expected signed subject', () => {
    const value = observations();
    assert.deepEqual(
      verifyApi3RecoveryProof({ envelope: signed(value), publicKey, prebuilt, now }),
      value,
    );
  });
  it('rejects an input-supplied or substituted signer, an attempted boolean, and altered signed bytes', () => {
    const value = observations();
    const attacker = generateKeyPairSync('ed25519');
    const intercepted = JSON.parse(signed(value));
    intercepted.payload = Buffer.from(
      JSON.stringify({ ...value, expiresAt: now + 600_000 }),
    ).toString('base64url');
    for (const envelope of [
      signed(value, attacker.privateKey),
      JSON.stringify({ ready: true }),
      JSON.stringify(intercepted),
      '',
      JSON.stringify({ evidence: value.evidence }),
    ]) {
      assert.throws(() => verifyApi3RecoveryProof({ envelope, publicKey, prebuilt, now }));
    }
    assert.throws(() =>
      protectedRecoveryReview(
        { API3_RECOVERY_PROOF: signed(value), API3_RECOVERY_REVIEW_PUBLIC_KEY: publicKey },
        source,
      ),
    );
  });
  it('rejects authentic reviews with obsolete time, artifact, project, or recovery observations', () => {
    for (const mutate of [
      (v) => {
        v.observedAt = prebuilt.completedAt - 1;
      },
      (v) => {
        v.expiresAt = now;
      },
      (v) => {
        v.observedAt = now + 1;
      },
      (v) => {
        v.expiresAt = now + 25 * 60 * 60 * 1000;
      },
      (v) => {
        v.images.web = prebuilt.digests.agent;
      },
      (v) => {
        v.buildRunId = '987654';
      },
      (v) => {
        v.source = 'a'.repeat(40);
      },
      (v) => {
        v.manifest = 'd'.repeat(64);
      },
      (v) => {
        v.staged.agentTagPercent = 100;
      },
      (v) => {
        v.staged.agent.mcpOAuthEnabled = true;
      },
      (v) => {
        v.parking.createdWithoutTag = agent;
      },
      (v) => {
        v.parking.latestReady = agent;
      },
      (v) => {
        v.closed.web.observed[0].tag = 'still-live';
      },
      (v) => {
        v.closed.agent.service = `${root.replace('friendly-vigil-514906-p2', 'bmson-assistant')}/assistant-agent`;
      },
    ]) {
      const value = observations();
      mutate(value);
      assert.throws(() =>
        verifyApi3RecoveryProof({ envelope: signed(value), publicKey, prebuilt, now }),
      );
    }
  });
});

function buildJobs() {
  return [
    {
      name: 'plan',
      conclusion: 'success',
      steps: [
        {
          name: 'Validate build-only scope before source verification or authentication',
          conclusion: 'success',
        },
        { name: 'Verify exact source passed main CI', conclusion: 'success' },
      ],
    },
    { name: 'release', conclusion: 'skipped' },
    ...ROLES.map((role) => ({
      name: `image (${role}, infra/docker/${role}.Dockerfile)`,
      conclusion: 'success',
      completed_at: new Date(prebuilt.completedAt).toISOString(),
    })),
  ];
}

describe('prebuilt artifact promotion', () => {
  const run = {
    id: Number(runId),
    path: '.github/workflows/deploy.yml',
    head_sha: source,
    head_branch: 'main',
    run_attempt: 1,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: 'bmson/assistant' },
    head_repository: { full_name: 'bmson/assistant' },
  };
  const listing = { jobs: buildJobs(), total_count: ROLES.length + 2 };
  it('requires one exact successful trusted build-only run and all five images', () => {
    assert.equal(verifyBuildRun(run, listing, source, runId), prebuilt.completedAt);
    assert.throws(() => verifyBuildRun({ ...run, run_attempt: 2 }, listing, source, runId));
    assert.throws(() =>
      verifyBuildRun(
        { ...run, head_repository: { full_name: 'fork/assistant' } },
        listing,
        source,
        runId,
      ),
    );
    const wrong = structuredClone(listing);
    wrong.jobs[0].steps[0].conclusion = 'skipped';
    assert.throws(() => verifyBuildRun(run, wrong, source, runId));
    wrong.jobs[0].steps[0].conclusion = 'success';
    wrong.jobs[1].conclusion = 'success';
    assert.throws(() => verifyBuildRun(run, wrong, source, runId));
  });
  it('rejects build-only, reruns, break-glass, an unrelated source and non-Firestore promotion', () => {
    const env = {
      RELEASE_PREBUILT_RUN_ID: runId,
      GITHUB_REPOSITORY: 'bmson/assistant',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
      GITHUB_WORKFLOW_SHA: source,
      GITHUB_SHA: source,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_RUN_ATTEMPT: '1',
      REQUESTED_COMPONENTS: 'full',
      REQUESTED_PERSISTENCE: 'firestore',
    };
    verifyReuseContext(env, source);
    for (const changed of [
      { BUILD_ONLY: 'true' },
      { BREAK_GLASS: 'true' },
      { GITHUB_RUN_ATTEMPT: '2' },
      { GITHUB_SHA: 'a'.repeat(40) },
      { REQUESTED_PERSISTENCE: 'postgres' },
      { NATIVE_WEB_QUALIFICATION: 'read_only' },
      { RELEASE_PREBUILT_RUN_ID: '' },
    ])
      assert.throws(() => verifyReuseContext({ ...env, ...changed }, source));
  });
  it('binds an immutable image receipt to the protected run and package role', () => {
    const receipt = {
      format: 1,
      image: `${IMAGE_ROOT}/web`,
      source,
      workflowSha: source,
      workflowRef: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
      runId,
      runAttempt: '1',
      registryManifestDigest: prebuilt.digests.web,
      sbomSha256: 'a'.repeat(64),
    };
    assert.equal(verifyRoleReceipt(receipt, 'web', source, runId), receipt.registryManifestDigest);
    assert.throws(() => verifyRoleReceipt(receipt, 'agent', source, runId));
    assert.throws(() => verifyRoleReceipt(receipt, 'web', source, '123457'));
    assert.throws(() =>
      validatePrebuiltImages(
        { ...prebuilt, digests: { agent: prebuilt.digests.agent } },
        source,
        runId,
      ),
    );
  });
  it('binds the production manifest and all worker digests to that exact build', () => {
    const contract = JSON.parse(readFileSync(new URL('./release-contracts.json', import.meta.url)));
    const manifest = createManifest({
      release: source,
      imageRoot: IMAGE_ROOT,
      selected: ROLES,
      digests: prebuilt.digests,
      contract,
      storageDriver: 'firestore',
    });
    manifest.manifestDigest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    assert.equal(verifyPromotionManifest(manifest, prebuilt), manifest.manifestDigest);
    manifest.components.processor.digest = prebuilt.digests.web;
    assert.throws(() => verifyPromotionManifest(manifest, prebuilt));
  });
});

it('uses the immutable receipt in the release shell and refuses to fall back to a tag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'firestore-prebuilt-test-'));
  try {
    const path = join(dir, 'verified.json');
    writeFileSync(path, JSON.stringify(prebuilt));
    const shell = fileURLToPath(new URL('./release-staged-services.sh', import.meta.url));
    const run = (extra) =>
      spawnSync(
        'bash',
        [
          '-c',
          'source "$1"; gcloud() { echo "mutable tag lookup" >&2; return 91; }; release_component_digest web',
          'release-test',
          shell,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            IMAGE_ROOT,
            TAG: source,
            RELEASE_PREBUILT_RUN_ID: runId,
            RELEASE_PREBUILT_IMAGES_PATH: path,
            ...extra,
          },
        },
      );
    const selected = run({});
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.stdout, prebuilt.digests.web);
    for (const input of [{ RELEASE_PREBUILT_IMAGES_PATH: '' }, { TAG: 'd'.repeat(40) }]) {
      const denied = run(input);
      assert.notEqual(denied.status, 0);
      assert.equal(denied.stdout, '');
      assert(!denied.stderr.includes('mutable tag lookup'));
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
