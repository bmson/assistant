/** The only API 1-to-3 exception is a reviewed, disabled Firestore pair. */
import { readFileSync } from 'node:fs';
import { protectedRecoveryReview } from '../infra/gcp/api3-recovery-proof.mjs';
import { estimatedCostMetadataRead } from './estimated-cost-release-native-read.js';
import { reviewedEstimatedCostReleaseProfile } from './estimated-cost-release-profile.js';
import { loadReviewedArchivedRuntimePack } from './owner-archived-runtime-input.js';
import { verifyPreAuthEnvironment } from './owner-editor-release-inventory.js';
import { verifyBootstrapRevisionTemplate } from './owner-release-bootstrap.js';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  object,
  type ReclosedPair,
  RUN_ROOT,
  reviewedCurrentEnvironment,
  verifyCurrentSnapshot,
} from './owner-release-current-snapshot.js';
import { createImageResolutionReader } from './owner-release-image-resolution.js';
import {
  assertRestoreTargetReviewFresh,
  protectedRestoreTargetReview,
} from './owner-restore-target-review.js';
import {
  recheckArchivedRestoreTargets,
  registerReviewedArchivedOriginal,
  verifyArchivedOriginalNativePair,
} from './owner-restore-target-verify.js';
import { verifyOperatorOwnedHold } from './owner-web-release-operator-hold.js';
import { protectedWebTagCredential } from './owner-web-tag-cloud.js';
import { tagHash } from './owner-web-tag-retirement.js';

function check(value: unknown): asserts value {
  if (!value) throw new Error('Drained API transition held');
}

const roles = ['agent', 'web'] as const;
type Role = (typeof roles)[number];

function environment(template: unknown) {
  const containers = object(template).containers;
  check(Array.isArray(containers) && containers.length === 1);
  const env = object(containers[0]).env;
  check(Array.isArray(env) && env.length <= 256);
  const entries = env.map(object);
  check(new Set(entries.map((entry) => entry.name)).size === entries.length);
  return (name: string) => {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) return undefined;
    check(typeof entry.value === 'string' && Object.keys(entry).sort().join(',') === 'name,value');
    return entry.value;
  };
}

export function verifyTransitionCandidateContract(raw: unknown): void {
  const contract = object(raw);
  check(object(contract.storageSchemaVersion).firestore === 1);
  for (const role of roles) {
    const component = object(object(contract.components)[role]);
    const peer = object(component.peerApi);
    const schema = object(object(component.schema).firestore);
    check(component.apiContract === 3 && peer.min === 3 && peer.max === 3);
    check(schema.min === 1 && schema.max === 1);
  }
}

type NativePair = Record<Role, { service: unknown; revision: unknown }>;

export function verifyDrainedApiTransition(
  current: BootstrapReceipt,
  native: NativePair,
  scope: { ownerId: string; installationId: string },
  reclosed?: ReclosedPair,
): void {
  check(current.kind === 'disabled-bootstrap');
  const oldAgent = current.services.agent.proof;
  const oldWeb = current.services.web.proof;
  check(oldAgent.source === oldWeb.source && oldAgent.manifest === oldWeb.manifest);
  check(oldAgent.runId === oldWeb.runId && oldAgent.attempt === oldWeb.attempt);
  for (const role of roles) {
    const binding = current.services[role];
    const service = object(native[role].service);
    const revision = object(native[role].revision);
    check(binding.proof.source !== current.source);
    check(typeof revision.uid === 'string' && tagHash(revision.uid) === binding.proof.uid);
    verifyCurrentSnapshot(binding, service, revision, true, reclosed?.[role]);
    const originalTemplate = reclosed?.[role].originalTemplate ?? service.template;
    verifyBootstrapRevisionTemplate(binding.service, originalTemplate, revision, binding.revision);
    for (const resource of [service, revision]) {
      check(
        typeof resource.generation === 'string' && /^[1-9][0-9]{0,18}$/.test(resource.generation),
      );
      check(resource.generation === resource.observedGeneration && resource.reconciling !== true);
      check(resource.deleteTime === undefined && resource.expireTime === undefined);
    }
    const peer = role === 'agent' ? 'WEB' : 'AGENT';
    for (const template of [object(originalTemplate), revision]) {
      check(
        template.serviceAccount === `assistant-${role}@bmson-assistant.iam.gserviceaccount.com`,
      );
      const value = environment(template);
      check(value('PERSISTENCE_DRIVER') === 'firestore');
      check(value('FIRESTORE_DATABASE_ID') === 'assistant-production');
      check(value('ASSISTANT_RELEASE_SCHEMA_DRIVER') === 'firestore');
      check(
        value('ASSISTANT_RELEASE_SCHEMA_MIN') === '1' &&
          value('ASSISTANT_RELEASE_SCHEMA_MAX') === '1',
      );
      check(value('ASSISTANT_RELEASE_SCHEMA_VERSION') === '1');
      check(value('ASSISTANT_RELEASE_API_CONTRACT') === '1');
      check(
        value(`ASSISTANT_RELEASE_${peer}_API_MIN`) === '1' &&
          value(`ASSISTANT_RELEASE_${peer}_API_MAX`) === '1',
      );
      check(value('FIRESTORE_AGENT_ID') === scope.ownerId);
      check(value('ASSISTANT_WORKSPACE_ID') === scope.installationId);
      check(value('ASSISTANT_RELEASE_SOURCE_SHA') === binding.proof.source);
      check(value('ASSISTANT_RELEASE_MANIFEST') === binding.proof.manifest);
      check(value('ASSISTANT_RELEASE_WORKFLOW_RUN_ID') === binding.proof.runId);
      check(value('ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT') === binding.proof.attempt);
      check(value('ASSISTANT_RELEASE_WRITES_PAUSED') === String(binding.proof.paused));
      const oauth = value('MCP_OAUTH_ENABLED');
      check(oauth === undefined || oauth === 'false');
      if (role === 'web') {
        const uri = object(native.agent.service).uri;
        check(
          typeof uri === 'string' &&
            /^https:\/\/assistant-agent-[a-z0-9]+-uw\.a\.run\.app$/.test(uri),
        );
        check(value('AGENT_URL') === uri);
      }
    }
  }
}

export async function verifyProductionApiTransition(confirmPreAdmission = false) {
  const env = process.env;
  verifyPreAuthEnvironment(env);
  check(env.GITHUB_EVENT_NAME === 'workflow_dispatch');
  check(env.GITHUB_WORKFLOW_REF === 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main');
  check(env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA && env.IMAGE_TAG === env.GITHUB_SHA);
  check(env.RELEASE_COMPONENTS === 'agent,web');
  const current = reviewedCurrentEnvironment(env, env.IMAGE_TAG as string);
  check(current?.kind === 'disabled-bootstrap');
  const recoveryReview = bootstrapDigest(protectedRecoveryReview(env, current.source));
  const profile = reviewedEstimatedCostReleaseProfile();
  check(profile?.mode === 'compatible-off' && !env.ESTIMATED_COST_DRAIN_PACKET_JSON);
  verifyTransitionCandidateContract(
    JSON.parse(readFileSync('infra/gcp/release-contracts.json', 'utf8')),
  );
  // An explicitly empty or malformed restore request must never use the ordinary path.
  const archived = env.OWNER_RELEASE_RESTORE_TARGET_PROOF !== undefined;
  if (archived || confirmPreAdmission) check(env.OWNER_RELEASE_RESTORE_TARGET_PROOF);
  const pack = archived ? await loadReviewedArchivedRuntimePack() : undefined;
  const restore = pack ? protectedRestoreTargetReview(env, current, pack.sha256) : undefined;
  if (pack) registerReviewedArchivedOriginal(current, pack);
  await verifyOperatorOwnedHold({
    source: current.source,
    runId: env.GITHUB_RUN_ID as string,
    attempt: env.GITHUB_RUN_ATTEMPT as string,
  });
  const token = await protectedWebTagCredential();
  const deadline = Date.now() + 60_000;
  const read = estimatedCostMetadataRead(token, deadline);
  const resolveImage = pack ? undefined : createImageResolutionReader(token, fetch, deadline);
  const bindings = current.services;
  async function observe(role: Role) {
    const { image, service, revision } = bindings[role];
    await resolveImage?.(image);
    return {
      service: await read(RUN_ROOT + service),
      revision: await read(`${RUN_ROOT}${service}/revisions/${revision}`),
    };
  }
  const observePair = async () => {
    const { verifyHostedReclosedBaseline } = await import('./owner-release-reclosed-hosted.js');
    const reclosed = await verifyHostedReclosedBaseline(current);
    if (reclosed) check(pack && restore);
    const [agent, web] = await Promise.all([observe('agent'), observe('web')]);
    const pair = { agent, web };
    verifyDrainedApiTransition(current, pair, profile, reclosed);
    if (pack) verifyArchivedOriginalNativePair(current, pack, pair, reclosed);
    return pair;
  };
  const pair = await observePair();
  if (pack && restore) {
    assertRestoreTargetReviewFresh(restore);
    await recheckArchivedRestoreTargets(token, restore.targets, pack.roles, fetch, deadline);
    const reobserved = await observePair();
    check(bootstrapDigest(pair) === bootstrapDigest(reobserved));
    if (confirmPreAdmission) {
      const { assertResumeRevisionsAbsent } = await import('./owner-release-resume-absence.js');
      await assertResumeRevisionsAbsent(current, restore.runId, token, deadline);
    }
    const confirmed = protectedRestoreTargetReview(env, current, pack.sha256);
    check(bootstrapDigest(confirmed) === bootstrapDigest(restore));
    assertRestoreTargetReviewFresh(confirmed);
  }
  // The review must still be current and cover the same images after the provider reads.
  check(bootstrapDigest(protectedRecoveryReview(env, current.source)) === recoveryReview);
}

if (process.argv[1]?.endsWith('/owner-release-api-transition.ts'))
  (process.argv.length === 2
    ? verifyProductionApiTransition()
    : Promise.reject(new Error('Unexpected transition arguments'))
  ).catch(() => {
    process.stderr.write('The reviewed drained Firestore API transition could not be verified.\n');
    process.exitCode = 1;
  });
