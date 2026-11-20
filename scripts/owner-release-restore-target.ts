/** Read-only dispatcher. The release shell records admission intent before its first possible write. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  protectedRecoveryReview,
  readBoundedJSON,
  verifyPromotionManifest,
} from '../infra/gcp/api3-recovery-proof.mjs';
import { estimatedCostMetadataRead } from './estimated-cost-release-native-read.js';
import { reviewedEstimatedCostReleaseProfile } from './estimated-cost-release-profile.js';
import { loadReviewedArchivedRuntimePack } from './owner-archived-runtime-input.js';
import { verifyPreAuthEnvironment } from './owner-editor-release-inventory.js';
import {
  verifyProductionApiTransition,
  verifyTransitionCandidateContract,
} from './owner-release-api-transition.js';
import {
  type RecoveryNativeContext,
  verifyRestoreCheckpointPair,
} from './owner-release-api3-recovery.js';
import {
  bootstrapDigest,
  type CurrentBinding,
  object,
  RUN_ROOT,
  requireProof,
  reviewedCurrentEnvironment,
} from './owner-release-current-snapshot.js';
import { createImageResolutionReader } from './owner-release-image-resolution.js';
import {
  bothPriorSuccessorsAbsent,
  selectedReclosedPredecessor,
  verifyPinnedReclosedArtifacts,
  verifyPinnedReclosedNativeRole,
} from './owner-release-reclosed-hosted.js';
import { assertResumeRevisionsAbsent } from './owner-release-resume-absence.js';
import {
  assertRestoreTargetReviewFresh,
  protectedRestoreTargetReview,
} from './owner-restore-target-review.js';
import {
  recheckArchivedRestoreTargets,
  registerReviewedArchivedOriginal,
} from './owner-restore-target-verify.js';
import { verifyOperatorOwnedHold } from './owner-web-release-operator-hold.js';
import { protectedWebTagCredential } from './owner-web-tag-cloud.js';

const decisions = {
  before_mutation: 'verified',
  before_admission: 'verified',
  before_web_resume: 'verified',
  pre_admission_restore: 'rehydrate_original_children',
  post_admission_forward: 'api3_forward_only',
} as const;
type Stage = keyof typeof decisions;
type Role = 'agent' | 'web';
const roles = ['agent', 'web'] as const;

export function verifyRestoreJournal(env: NodeJS.ProcessEnv, stage: Stage) {
  const {
    RUNNER_TEMP: root,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: attempt,
    IMAGE_TAG: source,
    OWNER_RELEASE_RESTORE_TARGET_PROOF: proof,
  } = env;
  requireProof(
    root &&
      runId &&
      /^[1-9][0-9]{0,19}$/.test(runId) &&
      attempt === '1' &&
      source &&
      /^[a-f0-9]{40}$/.test(source) &&
      proof,
  );
  requireProof(lstatSync(root).isDirectory());
  const dir = join(root, `owner-release-recovery-${runId}-${attempt}`);
  const directory = lstatSync(dir, { throwIfNoEntry: false });
  if (stage === 'before_mutation') {
    requireProof(!directory);
    return;
  }
  requireProof(directory?.isDirectory() && (directory.mode & 0o077) === 0);
  const proofSha256 = createHash('sha256').update(proof).digest('hex');
  function marker(file: string, phase: string, decision: string) {
    const path = join(dir, file);
    const stat = lstatSync(path);
    requireProof(
      stat.isFile() &&
        stat.nlink === 1 &&
        (stat.mode & 0o077) === 0 &&
        stat.size > 0 &&
        stat.size <= 2048,
    );
    const actual = JSON.parse(readFileSync(path, 'utf8'));
    requireProof(
      bootstrapDigest(actual) ===
        bootstrapDigest({
          format: 1,
          source,
          runId,
          attempt,
          phase,
          decision,
          proofSha256,
          mutationAuthorized: false,
          observationRequired: false,
        }),
    );
  }
  marker('start.json', 'started', 'verified');
  requireProof(!lstatSync(join(dir, 'outcome.json'), { throwIfNoEntry: false }));
  if (stage === 'post_admission_forward' || stage === 'before_web_resume')
    marker('admission.json', 'admission_possible', 'api3_forward_only');
  else requireProof(!lstatSync(join(dir, 'admission.json'), { throwIfNoEntry: false }));
}

type Read = (url: string) => Promise<unknown>;
/** Fetch only the reviewed service, its baseline, and this run's named revisions. */
export async function checkpointNativeRole(
  role: Role,
  binding: CurrentBinding,
  runId: string,
  source: string,
  read: Read,
  dormantPredecessor?: string,
) {
  const url = RUN_ROOT + binding.service;
  const service = object(await read(url));
  requireProof(service.name === binding.service && service.uid === binding.uid);
  const suffix = `${runId}-1-${source.slice(0, 8)}`;
  const allowed = new Set([
    binding.revision,
    ...(dormantPredecessor ? [dormantPredecessor] : []),
    ...['p', 'r', 'park'].map((phase) => `assistant-${role}-${phase}-${suffix}`),
  ]);
  const revisions = new Set([binding.revision]);
  function add(raw: unknown) {
    requireProof(typeof raw === 'string');
    const id = raw.startsWith(`${binding.service}/revisions/`)
      ? raw.slice(binding.service.length + '/revisions/'.length)
      : raw;
    requireProof(allowed.has(id));
    revisions.add(id);
  }
  add(service.latestCreatedRevision);
  if (service.latestReadyRevision !== undefined) add(service.latestReadyRevision);
  for (const list of [service.traffic, service.trafficStatuses]) {
    requireProof(Array.isArray(list) && list.length >= 1 && list.length <= 3);
    for (const row of list) add(object(row).revision);
  }
  // A successor might be the only visible revision. Its exact paused template is still required.
  if (
    [...revisions].some(
      (id) => id === `assistant-${role}-r-${suffix}` || id === `assistant-${role}-park-${suffix}`,
    )
  )
    add(`assistant-${role}-p-${suffix}`);
  const entries = await Promise.all(
    [...revisions].map(async (id) => [id, await read(`${url}/revisions/${id}`)] as const),
  );
  return { service, revisions: Object.fromEntries(entries) };
}

type ObservedRole = Awaited<ReturnType<typeof checkpointNativeRole>>;

/** The general checkpoint models the baseline as an original-only template. Use
 * that projection solely after the raw dormant role proves the exact signed baseline. */
export function checkpointDormantBaseline(
  role: Role,
  raw: ObservedRole,
  expected: string,
  original: CurrentBinding,
  verify: (role: Role, raw: ObservedRole) => { originalTemplate: unknown },
): ObservedRole {
  if (!Object.hasOwn(raw.revisions, expected)) return raw;
  requireProof(
    bootstrapDigest(raw.service) === original.serviceSha256 &&
      bootstrapDigest(raw.revisions[original.revision]) === original.revisionSha256,
  );
  const { originalTemplate } = verify(role, raw);
  return {
    service: {
      ...raw.service,
      latestCreatedRevision: original.revision,
      latestReadyRevision: original.revision,
      template: originalTemplate,
    },
    revisions: { [original.revision]: raw.revisions[original.revision] },
  };
}

async function checkStagedPair(env: NodeJS.ProcessEnv, stage: Exclude<Stage, 'before_mutation'>) {
  verifyPreAuthEnvironment(env);
  const current = reviewedCurrentEnvironment(env, env.IMAGE_TAG ?? '');
  requireProof(current?.kind === 'disabled-bootstrap');
  const profile = reviewedEstimatedCostReleaseProfile();
  requireProof(profile?.mode === 'compatible-off' && !env.ESTIMATED_COST_DRAIN_PACKET_JSON);
  verifyTransitionCandidateContract(readBoundedJSON('infra/gcp/release-contracts.json'));
  const pack = await loadReviewedArchivedRuntimePack();
  const signed = protectedRestoreTargetReview(env, current, pack.sha256);
  registerReviewedArchivedOriginal(current, pack);
  const candidate = object(protectedRecoveryReview(env, current.source));
  const digests = object(candidate.images);
  const build = object(readBoundedJSON(env.RELEASE_PREBUILT_IMAGES_PATH ?? ''));
  // Bind the exact read used to reconstruct the production manifest to the signed build.
  requireProof(
    build.source === current.source &&
      build.runId === signed.buildRunId &&
      bootstrapDigest(build) === signed.candidateBuildSha256,
  );
  const manifest = verifyPromotionManifest(readBoundedJSON(env.RELEASE_MANIFEST_PATH ?? ''), build);
  const image = (role: Role) => {
    requireProof(digests[role] === object(build.digests)[role]);
    return `us-west1-docker.pkg.dev/bmson-assistant/assistant/${role}@${digests[role]}`;
  };
  const context: RecoveryNativeContext = {
    original: current,
    images: { agent: image('agent'), web: image('web') },
    source: current.source,
    manifest,
    runId: signed.runId,
    costProfile: profile,
    ownerId: profile.ownerId,
    installationId: profile.installationId,
  };
  await verifyOperatorOwnedHold({ source: current.source, runId: signed.runId, attempt: '1' });
  const token = await protectedWebTagCredential();
  const deadline = Date.now() + 60_000;
  const read = estimatedCostMetadataRead(token, deadline);
  const resolve = createImageResolutionReader(token, fetch, deadline);
  await Promise.all(roles.map((role) => resolve(context.images[role])));
  const previous = selectedReclosedPredecessor(env);
  if (previous) {
    requireProof(env.RUNNER_TEMP);
    verifyPinnedReclosedArtifacts(env.RUNNER_TEMP);
  }
  const observe = async () => {
    const dormant = previous && stage === 'pre_admission_restore' ? previous : undefined;
    const [agent, web] = await Promise.all(
      roles.map((role) =>
        checkpointNativeRole(
          role,
          current.services[role],
          signed.runId,
          current.source,
          read,
          dormant?.[role],
        ),
      ),
    );
    requireProof(agent && web);
    const pair = { agent, web };
    const projected = (role: Role) =>
      dormant
        ? checkpointDormantBaseline(
            role,
            pair[role],
            dormant[role],
            current.services[role],
            (role, raw) =>
              verifyPinnedReclosedNativeRole(role, raw, pack.nativeBinding, 'closed', current),
          )
        : pair[role];
    verifyRestoreCheckpointPair(
      context,
      { agent: projected('agent'), web: projected('web') },
      stage,
    );
    if (stage === 'before_admission' || stage === 'pre_admission_restore') {
      await Promise.all([
        assertResumeRevisionsAbsent(current, signed.runId, token, deadline),
        ...(previous ? [bothPriorSuccessorsAbsent(token, deadline)] : []),
      ]);
    }
    return bootstrapDigest(pair);
  };
  const before = await observe();
  await recheckArchivedRestoreTargets(token, signed.targets, pack.roles, fetch, deadline);
  requireProof((await observe()) === before);
  requireProof(
    bootstrapDigest(protectedRestoreTargetReview(env, current, pack.sha256)) ===
      bootstrapDigest(signed),
  );
  requireProof(bootstrapDigest(reviewedEstimatedCostReleaseProfile()) === bootstrapDigest(profile));
  assertRestoreTargetReviewFresh(signed);
}

export async function verifyRestoreCheckpoint(stage: Stage) {
  requireProof(Object.hasOwn(decisions, stage));
  const env = process.env;
  verifyRestoreJournal(env, stage);
  if (stage === 'before_mutation') await verifyProductionApiTransition();
  else {
    const file = env.RELEASE_MANIFEST_PATH;
    requireProof(
      file &&
        env.RUNNER_TEMP &&
        file === join(env.RUNNER_TEMP, `assistant-release-${env.IMAGE_TAG}.json`),
    );
    const manifest = lstatSync(file, { throwIfNoEntry: false });
    if (!manifest && stage === 'pre_admission_restore') {
      // The first build lookup may have failed before manifest creation. Only the exact
      // original drained pair can establish this pre-staging state.
      await verifyProductionApiTransition(true);
    } else {
      requireProof(manifest?.isFile());
      await checkStagedPair(env, stage);
    }
  }
  verifyRestoreJournal(env, stage);
  return {
    format: 1,
    source: env.IMAGE_TAG,
    runId: env.GITHUB_RUN_ID,
    attempt: '1',
    decision: decisions[stage],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, stage] = process.argv.slice(2);
  (process.argv.length === 4 && mode === '--verify' && stage && Object.hasOwn(decisions, stage)
    ? verifyRestoreCheckpoint(stage as Stage)
    : Promise.reject(new Error('Unknown recovery checkpoint'))
  )
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch(() => {
      process.stderr.write(
        'Restore checkpoint unverified. Keep delivery held for read-only reconciliation.\n',
      );
      process.exitCode = 1;
    });
}
