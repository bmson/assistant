import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DIGEST,
  IMAGE_ROOT,
  protectedRecoveryReview,
  ROLES,
  RUN_ID,
  readBoundedJSON,
  SOURCE,
  validatePrebuiltImages,
  verifyPromotionManifest,
} from './api3-recovery-proof.mjs';

const REPO = 'bmson/assistant';
const WORKFLOW_PATH = '.github/workflows/deploy.yml';
const WORKFLOW_REF = `${REPO}/${WORKFLOW_PATH}@refs/heads/main`;

function check(condition) {
  if (!condition) throw new Error('Verified build-only images are required');
}

export function verifyReuseContext(env, source) {
  check(SOURCE.test(source) && RUN_ID.test(env.RELEASE_PREBUILT_RUN_ID ?? ''));
  check(
    env.GITHUB_REPOSITORY === REPO &&
      env.GITHUB_REF === 'refs/heads/main' &&
      env.GITHUB_WORKFLOW_REF === WORKFLOW_REF &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_RUN_ATTEMPT === '1' &&
      env.GITHUB_SHA === source &&
      env.GITHUB_WORKFLOW_SHA === source,
  );
  check(
    env.REQUESTED_PERSISTENCE === 'firestore' &&
      env.REQUESTED_COMPONENTS === 'full' &&
      env.BUILD_ONLY !== 'true' &&
      env.BREAK_GLASS !== 'true' &&
      ['', 'off'].includes(env.NATIVE_WEB_QUALIFICATION ?? ''),
  );
}

export function verifyBuildRun(run, listing, source, runId) {
  check(
    run &&
      String(run.id) === runId &&
      run.path === WORKFLOW_PATH &&
      run.repository?.full_name === REPO &&
      run.head_repository?.full_name === REPO &&
      run.head_sha === source &&
      run.head_branch === 'main' &&
      run.event === 'workflow_dispatch' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.run_attempt === 1,
  );
  const jobs = listing.jobs;
  check(Array.isArray(jobs) && jobs.length === listing.total_count && jobs.length <= 20);
  const plan = jobs.filter((job) => job.name === 'plan');
  const release = jobs.filter((job) => job.name === 'release');
  check(
    plan.length === 1 &&
      plan[0].conclusion === 'success' &&
      release.length === 1 &&
      release[0].conclusion === 'skipped',
  );
  for (const name of [
    'Validate build-only scope before source verification or authentication',
    'Verify exact source passed main CI',
  ]) {
    const matching = plan[0].steps.filter((step) => step.name === name);
    check(matching.length === 1 && matching[0].conclusion === 'success');
  }
  const imageJobs = jobs.filter((job) => job.name.startsWith('image ('));
  check(imageJobs.length === ROLES.length);
  for (const role of ROLES) {
    const matching = imageJobs.filter((job) => job.name.startsWith(`image (${role}, `));
    check(matching.length === 1 && matching[0].conclusion === 'success');
  }
  const completedAt = Math.max(...imageJobs.map((job) => Date.parse(job.completed_at)));
  check(Number.isSafeInteger(completedAt) && completedAt > 0 && completedAt <= Date.now());
  return completedAt;
}

export function verifyRoleReceipt(receipt, role, source, runId) {
  check(
    receipt &&
      receipt.format === 1 &&
      receipt.image === `${IMAGE_ROOT}/${role}` &&
      receipt.source === source &&
      receipt.workflowSha === source &&
      receipt.workflowRef === WORKFLOW_REF &&
      receipt.runId === runId &&
      receipt.runAttempt === '1' &&
      DIGEST.test(receipt.registryManifestDigest) &&
      /^[a-f0-9]{64}$/.test(receipt.sbomSha256),
  );
  return receipt.registryManifestDigest;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function verifyBuildProvenance(env, source) {
  verifyReuseContext(env, source);
  const runId = env.RELEASE_PREBUILT_RUN_ID;
  const github = (suffix) =>
    JSON.parse(run('gh', ['api', `repos/${REPO}/actions/runs/${runId}${suffix}`]));
  return verifyBuildRun(github(''), github('/jobs?per_page=100'), source, runId);
}

function verifyPrebuilt(env, source, artifactRoot, output) {
  const completedAt = verifyBuildProvenance(env, source);
  const matrix = JSON.parse(env.RELEASE_IMAGE_MATRIX);
  check(Array.isArray(matrix) && matrix.map((entry) => entry.name).join(',') === ROLES.join(','));
  const runId = env.RELEASE_PREBUILT_RUN_ID;
  const digests = Object.fromEntries(
    ROLES.map((role) => {
      const artifact = join(artifactRoot, `release-sboms-${source}-${role}`);
      const receipt = readBoundedJSON(join(artifact, `${role}-build-receipt.json`));
      const digest = verifyRoleReceipt(receipt, role, source, runId);
      const sbom = readFileSync(join(artifact, `${role}.spdx.json`));
      check(createHash('sha256').update(sbom).digest('hex') === receipt.sbomSha256);
      const verified = JSON.parse(
        run(join(env.RUNNER_TEMP, 'estimated-cost-cosign/cosign'), [
          'verify',
          '--output=json',
          `--certificate-identity=https://github.com/${WORKFLOW_REF}`,
          '--certificate-oidc-issuer=https://token.actions.githubusercontent.com',
          `--certificate-github-workflow-sha=${source}`,
          `${IMAGE_ROOT}/${role}@${digest}`,
        ]),
      );
      check(Array.isArray(verified) && verified.length > 0);
      return [role, digest];
    }),
  );
  const images = validatePrebuiltImages({ source, runId, completedAt, digests }, source, runId);
  writeFileSync(output, JSON.stringify(images), { flag: 'wx', mode: 0o600 });
  if (env.API3_RECOVERY_PROOF) {
    protectedRecoveryReview({ ...env, RELEASE_PREBUILT_IMAGES_PATH: output }, source);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env;
    const [mode, source, artifactRoot, output] = process.argv.slice(2);
    if (mode === 'validate-context') verifyReuseContext(env, source);
    else if (mode === 'verify-provenance') verifyBuildProvenance(env, source);
    else if (mode === 'verify' && artifactRoot && output)
      verifyPrebuilt(env, source, artifactRoot, output);
    else if (['digest', 'manifest'].includes(mode) && artifactRoot && output === undefined) {
      const images = validatePrebuiltImages(
        readBoundedJSON(env.RELEASE_PREBUILT_IMAGES_PATH),
        source,
        env.RELEASE_PREBUILT_RUN_ID,
      );
      if (mode === 'manifest') verifyPromotionManifest(readBoundedJSON(artifactRoot), images);
      else {
        check(ROLES.includes(artifactRoot));
        process.stdout.write(images.digests[artifactRoot]);
      }
    } else throw new Error('Invalid build reuse command');
  } catch {
    process.stderr.write('The protected build reuse or recovery proof could not be verified.\n');
    process.exitCode = 1;
  }
}
