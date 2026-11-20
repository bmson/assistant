import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  estimatedCostMetadataRead,
  estimatedCostMetadataUrl,
} from './estimated-cost-release-native-read.js';
import { loadReviewedArchivedRuntimePack } from './owner-archived-runtime-input.js';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  disabled,
  object,
  RUN_ROOT,
  requireProof,
  retiredCurrentCondition,
  retiredCurrentRevisionCondition,
  SERVICE_ROOT,
} from './owner-release-current-snapshot.js';
import { verifyReclosedPredecessorJournal } from './owner-release-reclosed-api1.js';
import { protectedRestoreTargetReview } from './owner-restore-target-review.js';
import { registerReviewedArchivedOriginal } from './owner-restore-target-verify.js';
import { TEMPLATE_FIELDS } from './owner-web-release-native-proof.js';
import { protectedWebTagCredential } from './owner-web-tag-cloud.js';

const roles = ['agent', 'web'] as const;
type Role = (typeof roles)[number];
type NativePair = Record<Role, { service: unknown; revisions: Record<string, unknown> }>;
const proofSha256 = 'c599a97c7589fcac7e358ee67eec59dd02c7db503d42cf2af6c417cc546bf59c';
const imageRoot = 'us-west1-docker.pkg.dev/bmson-assistant/assistant';
export const reclosedPredecessor = {
  source: 'bc74fbf7678231d83049558c2ba3d6f9c29baf09',
  runId: '44632388669',
  attempt: '1',
  buildRunId: '44624620356',
  manifestDigest: '098b1de132c43a33e14c80f890f15889da3ef21e738f89f4ab1e2cdacf4c3857',
  agent: 'assistant-agent-p-44632388669-1-bc74fbf7',
  web: 'assistant-web-p-44632388669-1-bc74fbf7',
} as const;
const pinned = {
  agent: {
    original: 'assistant-agent-rec-ad1a3c5f5cda4eba',
    serviceUid: 'b41dea48c285b644d3ef3fb9f779b6c0d7ba2bc6c5ffac2efc682d4981571b2b',
    originalUid: '230794340b4bfdefbce9d41443ef102d7af2634c4ea4dc0d92c70e43670b3a2e',
    originalTemplate: '8ed6937de80a52651b1e80d3f464bb5c61149dd433c70cc0064dc3f541a01932',
    originalParent: '1298263587c4021246c7a4832e174ea95bb5a5a2ffef8359b989ba60d694690b',
    originalChild: '7ab38d59edcf5d5f47a0884a928249ffd4e0457aa67f3cbf948fae4cb17c65e5',
    previousUid: '03163a20987b36dc554b74f6a633750ef59ce3e8c2580b474b0c443bbef31f73',
    previousServiceTemplate: '6f9b805c80c39da2e558189249678b31cb3d3998467ec9c46300ac7081bf32b3',
    previousRevisionTemplate: 'f568dc20ec68fdc4fb4483bbc337d5cde3384b6bf2312a8522579a2926e32483',
    previousParent: '1517b35a7c2131778e6bd64df5e6270f658ef94f60cf1908f1af8184effabc3a',
    previousChild: '32e55dfeabf887f4a744b4e12de3528a53837f420c7f7145aa27304986002947',
  },
  web: {
    original: 'assistant-web-rec-ad1a3c5f5cda4eba',
    serviceUid: 'fac439a9416a5c0b070ead4664f575255d85a2636fe9d744c251894f44276885',
    originalUid: '30f1f5a32438d9c11c3d03e00f5c607dc9ac1ac4010766049d4c01c805672ee6',
    originalTemplate: '938c1530e8b97793f94eaaa31909d9c03075fadbce2ccfca0fff9811f4fa4b5f',
    originalParent: '34d027a7e04daf667428d615f60fb537b5090caf785a3c4f65db0a714b42eb0a',
    originalChild: 'fde5cc2ae8bfe91405a4c5a56bcac59cff74f951f89e542a05b387fcc82e8d36',
    previousUid: '3ec5000025f4f029480827db034526a4e7ca60c7a3cad96ef05011cb8b88ad9f',
    previousServiceTemplate: 'bf160a842164c8ed49ccdeadac7abce45b05de57f9b72fe54a33ec3fb56206d0',
    previousRevisionTemplate: '1e7378c645eae5e1a709067bbb1c1e6f832cc0dd9a4128d598943d56e0f4bb8a',
    previousParent: 'd6576d785201c530c97b2041fae8c3eb79aabe855c9b1ebec09f76dfb6e6a0bd',
    previousChild: '1be5fd3835cd34ea0537fc9472a08d3d72ef1f8601254e0da7e955d4a8d18a5b',
  },
} as const;
const memberPins = {
  journal: {
    'start.json': '9b32c3aefdcf67e645b321f5085d3c3cfa39d94dba5e1aba3a23354cae4a6e11',
    'outcome.json': '0dbf526db2acdc6583298297f35bc7b009b2ac8ea45ce779aa9eeaf53dc8c955',
  },
  manifest: {
    [`assistant-release-${reclosedPredecessor.source}.json`]:
      '3fdd75de4ca2677d005881125b31ff0f32791123a67c47fd9e7abe88184d42c3',
  },
  handoff: {
    'owner-release-archive-handoff.json':
      'eabb49be13a6238ef19cd156395562bbbe723913911f91dbb7b74bb6723b4955',
  },
};

export function selectedReclosedPredecessor(env: NodeJS.ProcessEnv = process.env) {
  const requested = env.OWNER_RELEASE_RECLOSED_PREDECESSOR_RUN_ID;
  if (!requested) return undefined;
  requireProof(requested === reclosedPredecessor.runId);
  return reclosedPredecessor;
}

function protectedContext(env: NodeJS.ProcessEnv, job: 'release' | 'maintenance') {
  const workflow = job === 'release' ? 'deploy.yml' : 'owner-editor-v1-maintenance.yml';
  requireProof(selectedReclosedPredecessor(env));
  requireProof(
    env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_REPOSITORY === 'bmson/assistant' &&
      env.GITHUB_REF === 'refs/heads/main' &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_WORKFLOW_REF === `bmson/assistant/.github/workflows/${workflow}@refs/heads/main` &&
      env.GITHUB_SHA &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA) &&
      env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA &&
      env.GITHUB_JOB === job &&
      env.GITHUB_RUN_ATTEMPT === '1' &&
      /^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '') &&
      env.GITHUB_RUN_ID !== reclosedPredecessor.runId &&
      env.GCP_PROJECT === 'bmson-assistant' &&
      env.RUNNER_TEMP &&
      lstatSync(env.RUNNER_TEMP).isDirectory(),
  );
  return env.RUNNER_TEMP;
}

function pinnedMembers(root: string, subdir: keyof typeof memberPins) {
  const path = join(root, 'owner-reclosed-predecessor', subdir);
  const dir = lstatSync(path);
  const files = memberPins[subdir];
  requireProof(dir.isDirectory());
  requireProof(readdirSync(path).sort().join(',') === Object.keys(files).sort().join(','));
  return Object.fromEntries(
    Object.entries(files).map(([name, sha]) => {
      const file = join(path, name);
      const stat = lstatSync(file);
      requireProof(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= 16384);
      const raw = readFileSync(file);
      requireProof(
        raw.length === stat.size && createHash('sha256').update(raw).digest('hex') === sha,
      );
      return [name, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))] as const;
    }),
  );
}

/** The fixed downloaded bytes prove what the failed workflow recorded, not an
 * independent signature. Current signed intent/review and original archive trust
 * are verified by the protected callers before this observation can be used.
 */
export function verifyPinnedReclosedArtifacts(root: string): void {
  requireProof(lstatSync(join(root, 'owner-reclosed-predecessor')).isDirectory());
  const journal = pinnedMembers(root, 'journal');
  const prior = verifyReclosedPredecessorJournal(reclosedPredecessor, proofSha256, journal);
  const manifest = object(
    pinnedMembers(root, 'manifest')[`assistant-release-${prior.source}.json`],
  );
  const handoff = object(pinnedMembers(root, 'handoff')['owner-release-archive-handoff.json']);
  requireProof(
    manifest.release === prior.source &&
      manifest.manifestDigest === prior.manifestDigest &&
      manifest.storageDriver === 'firestore' &&
      manifest.schemaVersion === 1 &&
      handoff.runId === prior.runId &&
      handoff.attempt === '1' &&
      handoff.source === prior.source &&
      handoff.proofSha256 === proofSha256,
  );
  for (const role of roles) {
    const component = object(object(manifest.components)[role]);
    requireProof(
      component.image === image(role, pinned[role].previousParent) && component.apiContract === 3,
    );
  }
}

const image = (role: Role, digest: string) => `${imageRoot}/${role}@sha256:${digest}`;
function exactContainer(native: Record<string, unknown>, role: Role, child: string) {
  const containers = native.containers;
  const statuses = native.containerStatuses;
  requireProof(
    Array.isArray(containers) &&
      containers.length === 1 &&
      Array.isArray(statuses) &&
      statuses.length === 1,
  );
  const container = object(containers[0]);
  const status = object(statuses[0]);
  requireProof(
    container.name === `${role}-1` &&
      status.name === container.name &&
      container.image === image(role, child) &&
      status.imageDigest === container.image,
  );
  return container;
}

function templateFields(revision: Record<string, unknown>) {
  return Object.fromEntries(
    TEMPLATE_FIELDS.filter((field) => Object.hasOwn(revision, field)).map((field) => [
      field,
      revision[field],
    ]),
  );
}

export function verifyReclosedRevisionConditions(value: unknown, allowRetired: boolean) {
  const revision = object(value);
  const conditions = revision.conditions;
  requireProof(
    Array.isArray(conditions) &&
      conditions.length > 0 &&
      conditions.length <= 16 &&
      revision.reconciling !== true,
  );
  const rows = conditions.map(object);
  const exact = (row: Record<string, unknown>) =>
    row.state === 'CONDITION_SUCCEEDED' || (allowRetired && retiredCurrentRevisionCondition(row));
  requireProof(rows.filter((row) => row.type === 'Ready').length === 1 && rows.every(exact));
}

export function verifyReclosedCanonicalEndpoints(service: Record<string, unknown>, role: Role) {
  const root = `https://assistant-${role}-3gimfiaifa-uw.a.run.app`;
  const regional = `https://assistant-${role}-83709630368.us-west1.run.app`;
  const urls = service.urls;
  requireProof(
    service.uri === root &&
      Array.isArray(urls) &&
      urls.length === 2 &&
      urls.includes(root) &&
      urls.includes(regional),
  );
}

export function verifyPinnedReclosedNativeRole(
  role: Role,
  native: NativePair[Role],
  archivedNativeBinding: unknown,
  mode: 'automatic' | 'closed',
  current?: BootstrapReceipt,
) {
  const archived = object(object(archivedNativeBinding).roles);
  const expected = pinned[role];
  const baseline = object(archived[role]);
  const predecessorRevision = reclosedPredecessor[role];
  const { service: rawService, revisions } = native;
  const service = object(rawService);
  const serviceName = `${SERVICE_ROOT}${role}`;
  const reference = (revision: string) => `${serviceName}/revisions/${revision}`;
  const old = object(revisions[expected.original]);
  const previous = object(revisions[predecessorRevision]);
  const terminal = object(service.terminalCondition);
  const scaling = object(service.scaling);
  requireProof(
    Object.keys(revisions).length === 2 &&
      baseline.revision === expected.original &&
      baseline.serviceUidSha256 === expected.serviceUid &&
      baseline.revisionUidSha256 === expected.originalUid &&
      service.name === serviceName &&
      bootstrapDigest(service.uid) === expected.serviceUid &&
      typeof service.etag === 'string' &&
      service.etag.length > 0 &&
      typeof service.generation === 'string' &&
      /^[1-9][0-9]{0,18}$/.test(service.generation) &&
      service.generation === service.observedGeneration &&
      !service.reconciling &&
      !service.deleteTime &&
      !service.expireTime &&
      !service.invokerIamDisabled &&
      (terminal.state === 'CONDITION_SUCCEEDED' ||
        (mode === 'closed' && retiredCurrentCondition(terminal))) &&
      (mode === 'closed'
        ? disabled(service)
        : scaling.scalingMode === 'AUTOMATIC' && scaling.manualInstanceCount === undefined) &&
      old.name === reference(expected.original) &&
      previous.name === reference(predecessorRevision) &&
      bootstrapDigest(old.uid) === expected.originalUid &&
      bootstrapDigest(previous.uid) === expected.previousUid &&
      !old.deleteTime &&
      !old.expireTime &&
      !previous.deleteTime &&
      !previous.expireTime &&
      service.latestCreatedRevision === reference(predecessorRevision) &&
      service.latestReadyRevision === reference(predecessorRevision) &&
      bootstrapDigest(service.template) === expected.previousServiceTemplate &&
      bootstrapDigest(templateFields(previous)) === expected.previousRevisionTemplate,
  );
  for (const rows of [service.traffic, service.trafficStatuses]) {
    requireProof(Array.isArray(rows) && rows.length === 1);
    const row = object(rows[0]);
    requireProof(
      row.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' &&
        row.percent === 100 &&
        row.revision === expected.original &&
        !row.tag &&
        row.uri === undefined,
    );
  }
  verifyReclosedCanonicalEndpoints(service, role);
  verifyReclosedRevisionConditions(old, mode === 'closed');
  // The provider retires a correctly paused predecessor when its last alias disappears.
  verifyReclosedRevisionConditions(previous, true);
  exactContainer(previous, role, expected.previousChild);
  const originalContainer = {
    ...exactContainer(old, role, expected.originalChild),
    image: image(role, expected.originalParent),
  };
  if (role === 'agent') delete (originalContainer as Record<string, unknown>).name;
  const originalTemplate = {
    ...templateFields(old),
    revision: expected.original,
    containers: [originalContainer],
  };
  requireProof(bootstrapDigest(originalTemplate) === expected.originalTemplate);
  if (current) {
    const binding = current.services[role];
    requireProof(
      mode === 'closed' &&
        current.kind === 'disabled-bootstrap' &&
        binding.uid === service.uid &&
        binding.service === serviceName &&
        binding.revision === expected.original &&
        binding.image === originalContainer.image &&
        bootstrapDigest(service) === binding.serviceSha256 &&
        bootstrapDigest(old) === binding.revisionSha256,
    );
  }
  return {
    predecessorRevision,
    predecessorRevisionSha256: bootstrapDigest(previous),
    originalTemplate,
    originalRevision: old,
  };
}

export function verifyPinnedReclosedNativePair(
  pair: NativePair,
  archivedNativeBinding: unknown,
  mode: 'automatic' | 'closed',
  current?: BootstrapReceipt,
) {
  return {
    agent: verifyPinnedReclosedNativeRole(
      'agent',
      pair.agent,
      archivedNativeBinding,
      mode,
      current,
    ),
    web: verifyPinnedReclosedNativeRole('web', pair.web, archivedNativeBinding, mode, current),
    readbackSha256: bootstrapDigest(pair),
  };
}

export async function bothPriorSuccessorsAbsent(
  token: string,
  deadline: number,
  request: typeof fetch = fetch,
) {
  requireProof(/^[A-Za-z0-9._~-]{20,8192}$/.test(token));
  const remaining = deadline - Date.now();
  requireProof(remaining > 0);
  const signal = AbortSignal.timeout(Math.min(15000, remaining));
  await Promise.all(
    roles.map(async (role) => {
      const url = estimatedCostMetadataUrl(
        `${RUN_ROOT}${SERVICE_ROOT}${role}/revisions/assistant-${role}-r-${reclosedPredecessor.runId}-1-${reclosedPredecessor.source.slice(0, 8)}`,
      );
      const response = await request(url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      void response.body?.cancel().catch(() => undefined);
      requireProof(
        response.status === 404 &&
          response.url === url &&
          !response.redirected &&
          !signal.aborted &&
          Date.now() < deadline,
      );
    }),
  );
}

export async function verifyHostedReclosedAutomatic(input: {
  pair: NativePair;
  archivedNativeBinding: unknown;
  token: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = input.env ?? process.env;
  const root = protectedContext(env, 'maintenance');
  requireProof(env.OWNER_EDITOR_MAINTENANCE_MODE === 'before-maintenance');
  verifyPinnedReclosedArtifacts(root);
  const observed = verifyPinnedReclosedNativePair(
    input.pair,
    input.archivedNativeBinding,
    'automatic',
  );
  await bothPriorSuccessorsAbsent(input.token, Date.now() + 20000);
  return observed;
}

export async function verifyHostedReclosedBaseline(current: BootstrapReceipt) {
  const env = process.env;
  if (!selectedReclosedPredecessor(env)) return undefined;
  const root = protectedContext(env, 'release');
  requireProof(env.GITHUB_SHA === current.source);
  verifyPinnedReclosedArtifacts(root);
  const pack = await loadReviewedArchivedRuntimePack();
  protectedRestoreTargetReview(env, current, pack.sha256);
  registerReviewedArchivedOriginal(current, pack);
  const token = await protectedWebTagCredential();
  const deadline = Date.now() + 60000;
  const read = estimatedCostMetadataRead(token, deadline);
  async function observe(role: Role) {
    const url = RUN_ROOT + SERVICE_ROOT + role;
    const original = pinned[role].original;
    const predecessor = reclosedPredecessor[role];
    const [service, old, paused] = await Promise.all([
      read(url),
      read(`${url}/revisions/${original}`),
      read(`${url}/revisions/${predecessor}`),
    ]);
    return { service, revisions: { [original]: old, [predecessor]: paused } };
  }
  async function observePair() {
    const [agent, web] = await Promise.all([
      observe('agent'),
      observe('web'),
      bothPriorSuccessorsAbsent(token, deadline),
    ]);
    return verifyPinnedReclosedNativePair({ agent, web }, pack.nativeBinding, 'closed', current);
  }
  const before = await observePair();
  requireProof((await observePair()).readbackSha256 === before.readbackSha256);
  return before;
}
