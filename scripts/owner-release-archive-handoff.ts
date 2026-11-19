import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { protectedRecoveryReview } from '../infra/gcp/api3-recovery-proof.mjs';
import { withHostedArchivedRuntimePack } from './owner-archived-runtime-hosted.js';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  object,
  reviewedCurrentEnvironment,
} from './owner-release-current-snapshot.js';
import {
  maintenanceRunName,
  maintenanceWorkflowPath,
  maintenanceWorkflowRef,
} from './owner-release-maintenance-run.js';
import { protectedRestoreTargetReview } from './owner-restore-target-review.js';
import { recheckReviewedArchivedRuntimeGraph } from './owner-restore-target-verify.js';
import { boundedResponseJson } from './owner-web-release-operator-hold.js';
import { protectedWebTagCredential } from './owner-web-tag-cloud.js';

const runPattern = /^[1-9][0-9]{0,19}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const repository = 'bmson/assistant';
const restoreWorkflow = 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main';
const marker = 'owner-release-archive-handoff.json';

function check(value: unknown): asserts value {
  if (!value) throw new Error('Protected archive promotion handoff is unavailable');
}

function sha(value: unknown): value is string {
  return typeof value === 'string' && shaPattern.test(value);
}

function digest(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readBounded(path: string, maxBytes: number, privateFile = false) {
  const stat = lstatSync(path);
  check(
    stat.isFile() &&
      stat.size > 0 &&
      stat.size <= maxBytes &&
      (!privateFile || (stat.mode & 0o077) === 0),
  );
  const bytes = readFileSync(path);
  check(bytes.length === stat.size);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function context(env: NodeJS.ProcessEnv) {
  const {
    ARCHIVE_MAINTENANCE_RUN_ID: runId,
    GITHUB_RUN_ID: deployRunId,
    RUNNER_TEMP: directory,
  } = env;
  const source = env.IMAGE_TAG;
  const current = reviewedCurrentEnvironment(env, source ?? '');
  check(
    directory &&
      source &&
      current?.kind === 'disabled-bootstrap' &&
      runId &&
      runPattern.test(runId) &&
      deployRunId &&
      runPattern.test(deployRunId) &&
      runId !== deployRunId &&
      runId !== env.RELEASE_PREBUILT_RUN_ID &&
      env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_JOB === 'release' &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_REPOSITORY === repository &&
      env.GITHUB_REF === 'refs/heads/main' &&
      env.GITHUB_WORKFLOW_REF === restoreWorkflow &&
      env.GITHUB_RUN_ATTEMPT === '1' &&
      env.GITHUB_SHA === source &&
      env.GITHUB_WORKFLOW_SHA === source &&
      env.RELEASE_COMPONENTS === 'agent,web' &&
      env.OWNER_RELEASE_RESTORE_TARGET_PROOF,
  );
  return { directory, source, current, runId, deployRunId };
}

export async function verifySucceededArchiveObservation(
  runId: string,
  source: string,
  token: string,
  request: typeof fetch = fetch,
) {
  check(
    runPattern.test(runId) &&
      /^[a-f0-9]{40}$/.test(source) &&
      /^[A-Za-z0-9._~-]{1,4096}$/.test(token),
  );
  const base = `https://api.github.com/repos/${repository}/actions/runs/${runId}`;
  const read = async (suffix: string) =>
    boundedResponseJson(
      await request(base + suffix, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }),
      64 * 1024,
    );
  const [runValue, artifactsValue] = await Promise.all([read(''), read('/artifacts?per_page=100')]);
  const run = object(runValue);
  check(
    String(run.id) === runId &&
      run.run_attempt === 1 &&
      run.event === 'workflow_dispatch' &&
      run.path === maintenanceWorkflowPath &&
      run.head_sha === source &&
      run.head_branch === 'main' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      object(run.repository).full_name === repository &&
      object(run.head_repository).full_name === repository,
  );
  const listing = object(artifactsValue);
  check(
    Array.isArray(listing.artifacts) &&
      listing.artifacts.length === listing.total_count &&
      listing.artifacts.length <= 100,
  );
  const named = listing.artifacts
    .map(object)
    .filter((artifact) => artifact.name === `${maintenanceRunName}-${runId}-1`);
  check(named.length === 1);
  const artifact = named[0];
  check(artifact);
  const id = String(artifact.id);
  check(
    runPattern.test(id) &&
      artifact.expired === false &&
      typeof artifact.size_in_bytes === 'number' &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 64 * 1024,
  );
  const completedAt = Date.parse(String(run.updated_at));
  check(Number.isFinite(completedAt) && completedAt > 0);
  return {
    artifactId: id,
    completedAt,
    runIdentitySha256: bootstrapDigest({
      runId,
      source,
      event: run.event,
      workflowPath: run.path,
      attempt: run.run_attempt,
    }),
  };
}

type Evidence = {
  runId: string;
  runIdentitySha256: string;
  signedMaintenanceRunId: string;
  signedMaintenanceReceiptSha256: string;
  completedAt: number;
  buildRunId: string;
  candidateBuildSha256: string;
  candidateReviewSha256: string;
  packSha256: string;
  nativeBinding: unknown;
  targets: Record<'agent' | 'web', { parent: string; child: string }>;
};

export function bindArchiveMaintenanceReceipt(
  raw: unknown,
  current: BootstrapReceipt,
  proof: Evidence,
) {
  const value = object(raw);
  const observedAt = value.observedAt;
  check(
    value.format === 1 &&
      value.kind === maintenanceRunName &&
      current.kind === 'disabled-bootstrap' &&
      value.source === current.source &&
      value.workflowSha === current.source &&
      value.runId === proof.runId &&
      value.attempt === '1' &&
      value.workflowRef === maintenanceWorkflowRef &&
      value.runIdentitySha256 === proof.runIdentitySha256 &&
      proof.signedMaintenanceRunId === proof.runId &&
      proof.signedMaintenanceReceiptSha256 === bootstrapDigest(value) &&
      value.candidateBuildRunId === proof.buildRunId &&
      value.candidateBuildSha256 === proof.candidateBuildSha256 &&
      value.candidateReviewSha256 === proof.candidateReviewSha256 &&
      value.packSha256 === proof.packSha256 &&
      value.nativeBindingSha256 === bootstrapDigest(proof.nativeBinding) &&
      sha(value.intentSha256) &&
      sha(value.recoveryEvidenceSha256) &&
      value.recoveryEvidenceSha256 === current.recoveryReceiptSha256 &&
      sha(current.closureReceiptSha256) &&
      sha(current.drainReceiptSha256) &&
      sha(value.archivedReadbackSha256) &&
      typeof value.archiveGeneration === 'string' &&
      runPattern.test(value.archiveGeneration) &&
      sha(value.archiveObjectSha256) &&
      typeof observedAt === 'number' &&
      Number.isSafeInteger(observedAt) &&
      observedAt > 0 &&
      observedAt <= proof.completedAt &&
      typeof value.expiresAt === 'number' &&
      Number.isSafeInteger(value.expiresAt) &&
      value.expiresAt > observedAt &&
      value.expiresAt - observedAt <= 30 * 60_000 &&
      value.recoveryTargetsReadBack === true &&
      value.mutationAuthorized === false &&
      value.admissionChangePerformed === false,
  );
  const originals = object(value.original);
  const native = object(object(proof.nativeBinding).roles);
  for (const role of ['agent', 'web'] as const) {
    const original = object(originals[role]);
    const archive = object(native[role]);
    const binding = current.services[role];
    check(
      original.revision === archive.revision &&
        original.revision === binding.revision &&
        original.serviceUidSha256 === archive.serviceUidSha256 &&
        original.serviceUidSha256 === bootstrapDigest(binding.uid) &&
        original.revisionUidSha256 === archive.revisionUidSha256 &&
        original.parent === proof.targets[role].parent &&
        original.child === proof.targets[role].child,
    );
  }
  return { generation: value.archiveGeneration, objectSha256: value.archiveObjectSha256 };
}

async function prepare(env: NodeJS.ProcessEnv) {
  const details = context(env);
  const metadata = await verifySucceededArchiveObservation(
    details.runId,
    details.source,
    env.GH_TOKEN ?? '',
  );
  check(metadata.artifactId === env.ARCHIVE_ARTIFACT_ID);
  const receipt = object(
    readBounded(
      join(details.directory, 'archive-maintenance', `${maintenanceRunName}.json`),
      16 * 1024,
    ),
  );
  // Confirm the receipt's authenticated source and recovery selection before archive access.
  check(
    receipt.runId === details.runId &&
      receipt.source === details.source &&
      receipt.runIdentitySha256 === metadata.runIdentitySha256 &&
      receipt.recoveryEvidenceSha256 === details.current.recoveryReceiptSha256 &&
      typeof receipt.archiveGeneration === 'string' &&
      runPattern.test(receipt.archiveGeneration) &&
      sha(receipt.archiveObjectSha256),
  );
  const token = await protectedWebTagCredential();
  await withHostedArchivedRuntimePack(
    {
      ...env,
      OWNER_ARCHIVED_RUNTIME_GENERATION: receipt.archiveGeneration,
      OWNER_ARCHIVED_RUNTIME_OBJECT_SHA256: receipt.archiveObjectSha256,
    },
    token,
    async (pack, _, packDirectory) => {
      const review = protectedRestoreTargetReview(env, details.current, pack.sha256);
      const candidateReviewSha256 = bootstrapDigest(protectedRecoveryReview(env, details.source));
      const archive = bindArchiveMaintenanceReceipt(receipt, details.current, {
        runId: details.runId,
        completedAt: metadata.completedAt,
        runIdentitySha256: metadata.runIdentitySha256,
        signedMaintenanceRunId: review.maintenanceRunId,
        signedMaintenanceReceiptSha256: review.maintenanceReceiptSha256,
        buildRunId: review.buildRunId,
        candidateBuildSha256: review.candidateBuildSha256,
        candidateReviewSha256,
        packSha256: pack.sha256,
        nativeBinding: pack.nativeBinding,
        targets: review.targets,
      });
      await recheckReviewedArchivedRuntimeGraph(token, pack);
      const target = join(details.directory, 'owner-archived-runtime-pack');
      check(!lstatSync(target, { throwIfNoEntry: false }));
      renameSync(packDirectory, target);
      writeFileSync(
        join(details.directory, marker),
        JSON.stringify({
          format: 1,
          source: details.source,
          runId: details.deployRunId,
          attempt: '1',
          maintenanceRunId: details.runId,
          maintenanceReceiptSha256: bootstrapDigest(receipt),
          maintenanceArtifactId: metadata.artifactId,
          bootstrapSha256: bootstrapDigest(details.current),
          packSha256: pack.sha256,
          proofSha256: digest(Buffer.from(env.OWNER_RELEASE_RESTORE_TARGET_PROOF ?? '')),
          archive,
        }),
        { flag: 'wx', mode: 0o600 },
      );
    },
  );
}

export function verifyArchiveHandoff(env: NodeJS.ProcessEnv) {
  const details = context(env);
  const found = object(readBounded(join(details.directory, marker), 4 * 1024, true));
  check(
    found.format === 1 &&
      found.source === details.source &&
      found.runId === details.deployRunId &&
      found.attempt === '1' &&
      found.maintenanceRunId === details.runId &&
      sha(found.maintenanceReceiptSha256) &&
      sha(found.packSha256) &&
      runPattern.test(String(found.maintenanceArtifactId)) &&
      found.bootstrapSha256 === bootstrapDigest(details.current) &&
      found.proofSha256 === digest(Buffer.from(env.OWNER_RELEASE_RESTORE_TARGET_PROOF ?? '')),
  );
  const reviewed = protectedRestoreTargetReview(env, details.current, found.packSha256);
  check(
    reviewed.maintenanceRunId === found.maintenanceRunId &&
      reviewed.maintenanceReceiptSha256 === found.maintenanceReceiptSha256,
  );
  return found;
}

if (process.argv[1]?.endsWith('/owner-release-archive-handoff.ts')) {
  (async () => {
    const env = process.env;
    const mode = process.argv[2];
    check(process.argv.length === 3);
    if (mode === '--verify') verifyArchiveHandoff(env);
    else if (mode === '--prepare') await prepare(env);
    else {
      check(mode === '--artifact');
      const details = context(env);
      const result = await verifySucceededArchiveObservation(
        details.runId,
        details.source,
        env.GH_TOKEN ?? '',
      );
      check(env.GITHUB_OUTPUT);
      writeFileSync(env.GITHUB_OUTPUT, `artifact_id=${result.artifactId}\n`, { flag: 'a' });
    }
  })().catch(() => {
    process.stderr.write('Protected archive promotion handoff is unavailable.\n');
    process.exitCode = 1;
  });
}
