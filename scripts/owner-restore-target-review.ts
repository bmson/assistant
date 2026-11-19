import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { protectedRecoveryReview } from '../infra/gcp/api3-recovery-proof.mjs';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  reviewedBootstrap,
} from './owner-release-current-snapshot.js';

const require = createRequire(import.meta.url);
const { API3_RECOVERY_REVIEW_PUBLIC_KEY } =
  require('../infra/gcp/api3-recovery-review-key.mjs') as {
    API3_RECOVERY_REVIEW_PUBLIC_KEY: string;
  };

export const RESTORE_TARGET_REVIEW_DOMAIN = 'owner-release-restore-target-v1\0';
const ORIGINAL_SOURCE = '1c2ea3907bf17b14368846708002f9d4633f2092';
const ORIGINAL_RUN = '44263661117';
const ORIGINAL_MANIFEST = '9ca6dcbb6a1c4b6e25ca6ea857c86ae1c3103a75d9a8e4e26af801f7b1c32647';
const PROJECT = 'bmson-assistant';
const REGION = 'us-west1';
const DATABASE = 'assistant-production';
const REHEARSAL_PROJECT = 'friendly-vigil-514906-p2';
const REPOSITORY = 'us-west1-docker.pkg.dev/bmson-assistant/assistant';
const WORKFLOW_REF = 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main';
const TTL = 24 * 60 * 60 * 1000;
const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RUN = /^[1-9][0-9]{0,19}$/;
const ROLES = ['agent', 'web'] as const;
type Role = (typeof ROLES)[number];

const ORIGINAL_IMAGES = {
  agent: {
    parent: 'sha256:1298263587c4021246c7a4832e174ea95bb5a5a2ffef8359b989ba60d694690b',
    child: 'sha256:7ab38d59edcf5d5f47a0884a928249ffd4e0457aa67f3cbf948fae4cb17c65e5',
  },
  web: {
    parent: 'sha256:34d027a7e04daf667428d615f60fb537b5090caf785a3c4f65db0a714b42eb0a',
    child: 'sha256:fde5cc2ae8bfe91405a4c5a56bcac59cff74f951f89e542a05b387fcc82e8d36',
  },
} as const;

type Target = {
  image: string;
  parent: string;
  child: string;
  baselineUidSha256: string;
  baselineTemplateSha256: string;
  rehearsalUidSha256: string;
};

export type RestoreTargetReview = {
  reviewSha256: string;
  source: string;
  /** Actual first-attempt production dispatch. This ID does not exist at signing time. */
  runId: string;
  /** Known, reviewed protected build-only run, signed with the target evidence. */
  buildRunId: string;
  candidateBuildSha256: string;
  observedAt: number;
  expiresAt: number;
  targets: Record<Role, Target>;
};

type ExpectedReview = {
  current: BootstrapReceipt;
  packSha256: string;
  candidateBuildSha256: string;
  candidateReviewSha256: string;
  buildRunId: string;
  runId: string;
};

function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Restore target review held: ${reason}`);
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function object(value: unknown, keys: string) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'invalid object');
  check(
    Object.keys(value).sort().join(',') === keys.split(',').sort().join(','),
    'unexpected fields',
  );
  return value as Record<string, unknown>;
}

function decode(value: unknown, limit: number) {
  check(
    matches(value, /^[A-Za-z0-9_-]+$/) && value.length <= Math.ceil((limit * 4) / 3),
    'invalid encoding',
  );
  const bytes = Buffer.from(value, 'base64url');
  check(bytes.length <= limit && bytes.toString('base64url') === value, 'invalid encoding');
  return bytes;
}

function parsePayload(bytes: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const result: unknown = JSON.parse(text);
  // Require compact JSON so duplicate fields cannot be interpreted differently by signers.
  check(JSON.stringify(result) === text, 'noncanonical signed JSON');
  return result;
}

export function assertRestoreTargetReviewFresh(
  review: Pick<RestoreTargetReview, 'observedAt' | 'expiresAt'>,
  now = Date.now(),
): void {
  check(
    Number.isSafeInteger(now) &&
      Number.isSafeInteger(review.observedAt) &&
      Number.isSafeInteger(review.expiresAt) &&
      review.observedAt > 0 &&
      review.observedAt <= now &&
      now < review.expiresAt &&
      review.expiresAt - review.observedAt <= TTL,
    'stale or unbounded review',
  );
}

/** Pure verification; only tests and offline reviewers supply a different public key. */
export function verifyRestoreTargetReview(
  envelope: string,
  publicKey: string,
  expected: ExpectedReview,
  now = Date.now(),
): RestoreTargetReview {
  check(
    typeof envelope === 'string' && Buffer.byteLength(envelope) <= 12 * 1024,
    'invalid envelope size',
  );
  const wrapped = object(JSON.parse(envelope), 'payload,signature');
  const payload = decode(wrapped.payload, 8 * 1024);
  const signature = decode(wrapped.signature, 64);
  const key = createPublicKey({ key: decode(publicKey, 128), type: 'spki', format: 'der' });
  check(
    key.asymmetricKeyType === 'ed25519' &&
      signature.length === 64 &&
      verify(
        null,
        Buffer.concat([Buffer.from(RESTORE_TARGET_REVIEW_DOMAIN), payload]),
        key,
        signature,
      ),
    'invalid signature',
  );

  const value = object(
    parsePayload(payload),
    'format,kind,purpose,source,buildRunId,buildAttempt,candidateBuildSha256,candidateReviewSha256,originalSource,originalRunId,originalAttempt,project,region,database,bootstrapSha256,packSha256,observedAt,expiresAt,targets,rehearsal',
  );
  const { current, runId, buildRunId } = expected;
  const closedSha256 = bootstrapDigest(current);
  reviewedBootstrap(current, closedSha256, current.source);
  check(current.kind === 'disabled-bootstrap', 'current pair is not a drained bootstrap');
  check(
    matches(runId, RUN) && matches(buildRunId, RUN) && runId !== buildRunId,
    'invalid release/build run identity',
  );
  check(
    value.format === 1 &&
      value.kind === 'owner-release-restore-target' &&
      value.purpose === 'restore-paused-original-runtime-pair' &&
      matches(value.source, SHA) &&
      value.source === current.source &&
      value.source !== ORIGINAL_SOURCE &&
      value.buildRunId === buildRunId &&
      value.buildAttempt === '1' &&
      matches(value.candidateBuildSha256, HASH) &&
      value.candidateBuildSha256 === expected.candidateBuildSha256 &&
      matches(value.candidateReviewSha256, HASH) &&
      value.candidateReviewSha256 === expected.candidateReviewSha256 &&
      matches(value.packSha256, HASH) &&
      value.packSha256 === expected.packSha256 &&
      value.bootstrapSha256 === closedSha256 &&
      value.originalSource === ORIGINAL_SOURCE &&
      value.originalRunId === ORIGINAL_RUN &&
      value.originalAttempt === '1' &&
      value.project === PROJECT &&
      value.region === REGION &&
      value.database === DATABASE,
    'release, original pair, bootstrap or pack binding mismatch',
  );
  const { observedAt, expiresAt } = value;
  check(typeof observedAt === 'number' && typeof expiresAt === 'number', 'invalid review times');
  assertRestoreTargetReviewFresh({ observedAt, expiresAt }, now);

  const rehearsal = object(
    value.rehearsal,
    'project,region,importedBytes,createdPausedPair,heldRestore,heldForward',
  );
  check(
    rehearsal.project === REHEARSAL_PROJECT && rehearsal.region === REGION,
    'wrong rehearsal scope',
  );
  for (const [name, outcome] of [
    ['importedBytes', 'verified-exact-runtime-bytes'],
    ['createdPausedPair', 'verified-fresh-paused-pair'],
    ['heldRestore', 'verified-held-restore'],
    ['heldForward', 'verified-held-forward'],
  ] as const) {
    const observed = object(rehearsal[name], 'outcome,evidenceSha256');
    check(
      observed.outcome === outcome && matches(observed.evidenceSha256, HASH),
      'missing rehearsal outcome',
    );
  }

  const signedTargets = object(value.targets, 'agent,web');
  const targets = {} as Record<Role, Target>;
  const uids = new Set<string>();
  for (const role of ROLES) {
    const target = object(
      signedTargets[role],
      'parent,child,baselineUidSha256,baselineTemplateSha256,rehearsalUidSha256',
    );
    const binding = current.services[role];
    const { parent, child } = ORIGINAL_IMAGES[role];
    const { baselineUidSha256, baselineTemplateSha256, rehearsalUidSha256 } = target;
    check(
      target.parent === parent &&
        target.child === child &&
        binding.image === `${REPOSITORY}/${role}@${parent}` &&
        binding.proof.source === ORIGINAL_SOURCE &&
        binding.proof.runId === ORIGINAL_RUN &&
        binding.proof.attempt === '1' &&
        binding.proof.manifest === ORIGINAL_MANIFEST &&
        binding.proof.paused === false &&
        matches(baselineUidSha256, HASH) &&
        baselineUidSha256 === binding.proof.uid &&
        matches(baselineTemplateSha256, HASH) &&
        baselineTemplateSha256 === binding.proof.templateSha256 &&
        matches(rehearsalUidSha256, HASH),
      `${role} runtime or revision binding mismatch`,
    );
    uids.add(baselineUidSha256);
    uids.add(rehearsalUidSha256);
    targets[role] = {
      image: `${REPOSITORY}/${role}@${child}`,
      parent,
      child,
      baselineUidSha256,
      baselineTemplateSha256,
      rehearsalUidSha256,
    };
  }
  check(uids.size === 4, 'baseline and fresh rehearsal revisions must be distinct');

  return {
    reviewSha256: createHash('sha256').update(payload).digest('hex'),
    source: current.source,
    runId,
    buildRunId,
    candidateBuildSha256: expected.candidateBuildSha256,
    observedAt,
    expiresAt,
    targets,
  };
}

function verifiedBuildDigest(env: NodeJS.ProcessEnv, source: string, buildRunId: string) {
  const path = env.RELEASE_PREBUILT_IMAGES_PATH;
  check(typeof path === 'string', 'missing verified candidate build');
  const stat = lstatSync(path);
  check(
    stat.isFile() && stat.size > 0 && stat.size <= 16 * 1024,
    'invalid verified candidate build file',
  );
  const bytes = readFileSync(path);
  check(bytes.length === stat.size, 'verified candidate build changed');
  const prebuilt = object(JSON.parse(bytes.toString('utf8')), 'source,runId,completedAt,digests');
  const digests = object(prebuilt.digests, 'agent,web,browser,code,processor');
  check(
    prebuilt.source === source &&
      prebuilt.runId === buildRunId &&
      typeof prebuilt.completedAt === 'number' &&
      Number.isSafeInteger(prebuilt.completedAt) &&
      prebuilt.completedAt > 0 &&
      Object.values(digests).every((digest) => matches(digest, DIGEST)),
    'verified candidate build mismatch',
  );
  return { candidateBuildSha256: bootstrapDigest(prebuilt), completedAt: prebuilt.completedAt };
}

export function protectedRestoreTargetReview(
  env: NodeJS.ProcessEnv,
  current: BootstrapReceipt,
  packSha256: string,
): RestoreTargetReview {
  const { GITHUB_RUN_ID: runId, RELEASE_PREBUILT_RUN_ID: buildRunId } = env;
  check(
    env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_REPOSITORY === 'bmson/assistant' &&
      env.GITHUB_REF === 'refs/heads/main' &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_WORKFLOW_REF === WORKFLOW_REF &&
      env.GITHUB_RUN_ATTEMPT === '1' &&
      env.GITHUB_SHA === current.source &&
      env.GITHUB_WORKFLOW_SHA === current.source &&
      env.IMAGE_TAG === current.source &&
      env.RELEASE_COMPONENTS === 'agent,web' &&
      env.GCP_PROJECT === PROJECT &&
      env.GCP_REGION === REGION &&
      matches(runId, RUN) &&
      matches(buildRunId, RUN) &&
      matches(packSha256, HASH) &&
      typeof env.OWNER_RELEASE_RESTORE_TARGET_PROOF === 'string',
    'untrusted production dispatch',
  );
  const build = verifiedBuildDigest(env, current.source, buildRunId);
  const candidateReviewSha256 = bootstrapDigest(protectedRecoveryReview(env, current.source));
  const result = verifyRestoreTargetReview(
    env.OWNER_RELEASE_RESTORE_TARGET_PROOF,
    API3_RECOVERY_REVIEW_PUBLIC_KEY,
    {
      current,
      packSha256,
      candidateReviewSha256,
      candidateBuildSha256: build.candidateBuildSha256,
      buildRunId,
      runId,
    },
  );
  check(result.observedAt >= build.completedAt, 'review predates candidate build');
  check(
    verifiedBuildDigest(env, current.source, buildRunId).candidateBuildSha256 ===
      build.candidateBuildSha256,
    'verified candidate build changed during qualification',
  );
  return result;
}
