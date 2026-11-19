/** Offline planning for the failed API 1 to 3 transition. No credentials or network. */
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import {
  type EstimatedCostReleaseProfile,
  validateEstimatedCostReleaseProfile,
  verifyEstimatedCostProvider,
} from '../infra/gcp/estimated-cost-release-config.mjs';
import { verifyBootstrapRevisionTemplate } from './owner-release-bootstrap.js';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  disabled,
  object,
  requireProof,
  reviewedBootstrap,
  SERVICE_ROOT,
  scalingConfigurationDigest,
  verifyCurrentSnapshot,
} from './owner-release-current-snapshot.js';
import {
  registerImageResolution,
  revisionWithRequestedImage,
} from './owner-release-image-resolution.js';
import { captureLifecycle } from './owner-web-release-lifecycle-model.js';
import { pairedWebContext } from './owner-web-release-native-controller.js';
import { projectNativeWebSnapshot, TEMPLATE_FIELDS } from './owner-web-release-native-proof.js';
import { parseWebManifest } from './owner-web-tag-provenance.js';
import { tagHash } from './owner-web-tag-retirement.js';

const roles = ['web', 'agent'] as const;
type Role = (typeof roles)[number];
type Obj = Record<string, unknown>;
const sha = /^[a-f0-9]{64}$/;
const sourceSha = /^[a-f0-9]{40}$/;
const allocation = 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION';
const agentRegionalUri = 'https://assistant-agent-83709630368.us-west1.run.app';
const manualZero = { scalingMode: 'MANUAL', manualInstanceCount: 0 };
const revisionKeys = new Set<string>(TEMPLATE_FIELDS);

type Review = {
  original: BootstrapReceipt;
  originalSha256: string;
  source: string;
  resumeSource: string;
  manifest: string;
  releaseManifest: string;
  costProfile: EstimatedCostReleaseProfile;
  runId: string;
  ownerId: string;
  installationId: string;
  images: Record<Role, string>;
  pausedTemplates?: Partial<Record<Role, Obj>>;
  signedImagesReceiptSha256: string;
  deliveryHoldReceiptSha256: string;
  transitionSettlementReceiptSha256: string;
};
type Native = { service: unknown; revisions: Record<string, unknown> };
type Snapshots = Record<Role, Native>;
type Settlement = {
  serviceSha256: Record<Role, string>;
  evidenceSha256: string;
};
type Traffic = { revision: string; percent: number; tag?: string };
type Action = {
  role: Role;
  step: 'close' | 'warm' | 'pin' | 'create-paused';
  beforeSha256: string;
  updateMask: 'scaling,traffic' | 'traffic' | 'template,traffic';
  body: Obj;
};
type Plan =
  | { outcome: 'action'; action: Action }
  | { outcome: 'startup-required'; role: Role; revision: string }
  | { outcome: 'settlement-required'; serviceSha256: Record<Role, string> }
  | { outcome: 'paused-template-review-required'; missingPaused: Role[] }
  | { outcome: 'closed-api3-pair'; receipt: BootstrapReceipt; receiptSha256: string };

function text(value: unknown, pattern: RegExp): string {
  requireProof(typeof value === 'string' && pattern.test(value));
  return value;
}
function matching(a: unknown, b: unknown) {
  return bootstrapDigest(a) === bootstrapDigest(b);
}
function name(service: string, value: unknown) {
  const prefix = `${service}/revisions/`;
  const raw = text(value, /^[a-z0-9/_-]{1,256}$/);
  return text(
    raw.startsWith(prefix) ? raw.slice(prefix.length) : raw,
    /^assistant-(web|agent)-[a-z0-9-]{1,49}$/,
  );
}
function environment(template: Obj) {
  requireProof(Array.isArray(template.containers) && template.containers.length === 1);
  const entries = object(template.containers[0]).env;
  requireProof(Array.isArray(entries) && entries.length <= 256);
  const byName = new Map<string, Obj>();
  for (const entry of entries.map(object)) {
    const key = text(entry.name, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
    requireProof(!byName.has(key));
    byName.set(key, entry);
  }
  return (key: string) => {
    const entry = object(byName.get(key));
    requireProof(
      Object.keys(entry).sort().join(',') === 'name,value' && typeof entry.value === 'string',
    );
    return entry.value;
  };
}
function routeRows(service: string, value: unknown, role: Role, runId: string, statusUri?: string) {
  requireProof(Array.isArray(value) && value.length >= 1 && value.length <= 3);
  const candidate = `candidate-${runId}-1`;
  const resume = `resume-${runId}-1`;
  const warming = `park-${runId}-1`;
  const rows = value.map(object).map((row): Traffic => {
    requireProof(row.type === allocation);
    const revision = name(service, row.revision);
    const percent = row.percent ?? 0;
    const tag = row.tag === '' ? undefined : row.tag;
    requireProof(percent === 100 || percent === 0);
    requireProof(
      tag === candidate ||
        tag === warming ||
        (role === 'web' && tag === resume) ||
        tag === undefined,
    );
    requireProof(percent === 100 || tag !== undefined);
    if (statusUri && tag)
      requireProof(row.uri === statusUri.replace('https://', `https://${tag}---`));
    return { revision, percent, ...(typeof tag === 'string' ? { tag } : {}) };
  });
  requireProof(rows.filter((row) => row.percent === 100).length === 1);
  const tags = rows.filter((r) => r.tag).map((r) => r.tag);
  requireProof(new Set(tags).size === tags.length);
  return rows.sort((a, b) => (a.tag ?? '').localeCompare(b.tag ?? ''));
}
function target(revision: string, tag?: string) {
  return { type: allocation, revision, ...(tag ? { tag, percent: 0 } : { percent: 100 }) };
}
function semanticTemplate(raw: Obj, image: string, revision: string) {
  const semantic = revisionWithRequestedImage(raw, image);
  return {
    ...Object.fromEntries(
      TEMPLATE_FIELDS.filter((k) => semantic[k] !== undefined).map((k) => [k, semantic[k]]),
    ),
    revision,
  };
}
function reviewInput(review: Review) {
  reviewedBootstrap(review.original, review.originalSha256, review.source);
  requireProof(review.original.kind === 'disabled-bootstrap');
  text(review.resumeSource, sourceSha);
  text(review.manifest, sha);
  requireProof(
    typeof review.releaseManifest === 'string' &&
      Buffer.byteLength(review.releaseManifest) <= 65536,
  );
  const verified = parseWebManifest(Buffer.from(review.releaseManifest));
  const manifest = object(JSON.parse(review.releaseManifest));
  requireProof(verified.release === review.source && verified.manifestDigest === review.manifest);
  requireProof(manifest.storageDriver === 'firestore' && manifest.schemaVersion === 1);

  text(review.runId, /^[1-9][0-9]{0,18}$/);
  text(review.ownerId, /^[A-Za-z0-9_.:-]{1,128}$/);
  text(review.installationId, /^[A-Za-z0-9_.:-]{1,128}$/);
  text(review.signedImagesReceiptSha256, sha);
  text(review.deliveryHoldReceiptSha256, sha);
  text(review.transitionSettlementReceiptSha256, sha);
  requireProof(review.costProfile.mode === 'compatible-off');
  validateEstimatedCostReleaseProfile(review.costProfile, {
    source: review.source,
    projectId: 'bmson-assistant',
    installationId: review.installationId,
    ownerId: review.ownerId,
  });
  for (const role of roles) {
    const image = review.images[role];
    requireProof(
      image.startsWith(`us-west1-docker.pkg.dev/bmson-assistant/assistant/${role}@sha256:`),
    );
    text(image.split(':').at(-1), sha);
    const component = object(object(manifest.components)[role]);
    const peer = object(component.peerApi),
      schema = object(component.schema);
    requireProof(
      component.image === image &&
        component.apiContract === 3 &&
        peer.min === 3 &&
        peer.max === 3 &&
        schema.min === 1 &&
        schema.max === 1,
    );
  }
}
function verifyCandidateTemplate(
  review: Review,
  role: Role,
  template: Obj,
  agentUri: string,
  paused: boolean,
) {
  const env = environment(template);
  const container = object((template.containers as unknown[])[0]);
  verifyEstimatedCostProvider(container.env as unknown[], review.costProfile);
  const peer = role === 'agent' ? 'WEB' : 'AGENT';
  requireProof(
    template.serviceAccount === `assistant-${role}@bmson-assistant.iam.gserviceaccount.com` &&
      env('PERSISTENCE_DRIVER') === 'firestore' &&
      env('FIRESTORE_DATABASE_ID') === 'assistant-production' &&
      env('FIRESTORE_AGENT_ID') === review.ownerId &&
      env('ASSISTANT_WORKSPACE_ID') === review.installationId &&
      (role !== 'web' || env('AGENT_URL') === agentUri) &&
      env('ASSISTANT_RELEASE_SOURCE_SHA') === review.source &&
      env('ASSISTANT_RELEASE_MANIFEST') === review.manifest &&
      env('ASSISTANT_RELEASE_WORKFLOW_RUN_ID') === review.runId &&
      env('ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT') === '1' &&
      env('ASSISTANT_RELEASE_API_CONTRACT') === '3' &&
      env(`ASSISTANT_RELEASE_${peer}_API_MIN`) === '3' &&
      env(`ASSISTANT_RELEASE_${peer}_API_MAX`) === '3' &&
      env('ASSISTANT_RELEASE_SCHEMA_DRIVER') === 'firestore' &&
      env('ASSISTANT_RELEASE_SCHEMA_MIN') === '1' &&
      env('ASSISTANT_RELEASE_SCHEMA_MAX') === '1' &&
      env('ASSISTANT_RELEASE_SCHEMA_VERSION') === '1' &&
      env('ASSISTANT_RELEASE_WRITES_PAUSED') === String(paused) &&
      env('MCP_OAUTH_ENABLED') === 'false',
  );
}

function readRole(review: Review, role: Role, native: Native, agentUri: string) {
  const original = review.original.services[role];
  const service = object(native.service);
  const resource = `${SERVICE_ROOT}${role}`;
  requireProof(service.name === resource && service.uid === original.uid);
  text(service.etag, /^[A-Za-z0-9_+=./-]{1,256}$/);
  text(service.generation, /^[1-9][0-9]{0,18}$/);
  requireProof(service.generation === service.observedGeneration && service.reconciling !== true);
  requireProof(service.deleteTime === undefined && service.expireTime === undefined);
  requireProof(
    disabled(service) ||
      service.scaling === undefined ||
      object(service.scaling).scalingMode === 'AUTOMATIC',
  );
  const serviceUri = text(
    service.uri,
    new RegExp(`^https://assistant-${role}-[a-z0-9]+-uw\\.a\\.run\\.app$`),
  );
  const rows = routeRows(resource, service.traffic, role, review.runId);
  requireProof(
    matching(rows, routeRows(resource, service.trafficStatuses, role, review.runId, serviceUri)),
  );
  const canonical = rows.find((row) => row.percent === 100)?.revision;
  requireProof(canonical);
  const suffix = `${review.runId}-1-${review.source.slice(0, 8)}`;
  const paused = `assistant-${role}-p-${suffix}`;
  const resumed = `assistant-${role}-r-${suffix}`;
  const parked = `assistant-${role}-park-${suffix}`;
  const recognized = [original.revision, paused, resumed, parked];
  const latest = name(resource, service.latestCreatedRevision);
  const ready =
    service.latestReadyRevision === undefined
      ? undefined
      : name(resource, service.latestReadyRevision);
  requireProof(ready === undefined || recognized.includes(ready));
  const warming = rows.find((row) => row.tag === `park-${review.runId}-1`);
  if (warming) {
    requireProof(disabled(service) && rows.length === 2 && warming.percent === 0);
    requireProof(warming.revision === latest && [paused, parked].includes(latest));
  }
  requireProof(recognized.includes(latest));
  for (const row of rows) {
    requireProof(recognized.includes(row.revision));
    if (row.tag?.startsWith('resume-')) requireProof(row.revision === resumed);
    if (row.tag?.startsWith('candidate-'))
      requireProof(
        [original.revision, paused, ...(role === 'agent' ? [resumed] : [])].includes(row.revision),
      );
  }
  const template = object(service.template);
  requireProof(
    template.revision === latest && Object.keys(template).every((k) => revisionKeys.has(k)),
  );
  const revisions = object(native.revisions);
  requireProof(Object.keys(revisions).every((key) => recognized.includes(key)));
  const relevant = new Set([...rows.map((row) => row.revision), latest, ...Object.keys(revisions)]);
  let pausedTemplate: Obj | undefined;
  const revisionObjects: Record<string, Obj> = {};
  for (const revision of relevant) {
    const raw = object(revisions[revision]);
    revisionObjects[revision] = raw;
    requireProof(
      raw.name === `${resource}/revisions/${revision}` &&
        (raw.service === resource || raw.service === `assistant-${role}`),
    );
    const uid = text(raw.uid, /^[A-Za-z0-9-]{1,128}$/);
    requireProof(
      raw.deleteTime === undefined && raw.expireTime === undefined && raw.reconciling !== true,
    );
    const env = environment(raw);
    requireProof(
      raw.serviceAccount === `assistant-${role}@bmson-assistant.iam.gserviceaccount.com` &&
        env('PERSISTENCE_DRIVER') === 'firestore' &&
        env('FIRESTORE_DATABASE_ID') === 'assistant-production' &&
        env('FIRESTORE_AGENT_ID') === review.ownerId &&
        env('ASSISTANT_WORKSPACE_ID') === review.installationId &&
        (role !== 'web' || env('AGENT_URL') === agentUri),
    );
    const isOriginal = revision === original.revision;
    const expectedImage = isOriginal ? original.image : review.images[role];
    const observedTemplate = semanticTemplate(raw, expectedImage, revision);
    if (revision === latest) {
      verifyBootstrapRevisionTemplate(resource, template, raw, latest);
      requireProof(object((template.containers as unknown[])[0]).image === expectedImage);
    }
    if (isOriginal) {
      requireProof(
        tagHash(uid) === original.proof.uid &&
          env('ASSISTANT_RELEASE_API_CONTRACT') === '1' &&
          env('ASSISTANT_RELEASE_SOURCE_SHA') === original.proof.source &&
          env('ASSISTANT_RELEASE_MANIFEST') === original.proof.manifest,
      );
      continue;
    }
    verifyCandidateTemplate(review, role, raw, agentUri, revision !== resumed);
    if (revision === paused) pausedTemplate = observedTemplate;
  }
  const supplied = review.pausedTemplates?.[role];
  if (supplied) {
    requireProof(
      supplied.revision === paused && Object.keys(supplied).every((k) => revisionKeys.has(k)),
    );
    requireProof(Array.isArray(supplied.containers) && supplied.containers.length === 1);
    requireProof(object(supplied.containers[0]).image === review.images[role]);
    verifyCandidateTemplate(review, role, supplied, agentUri, true);
    if (revisionObjects[paused])
      verifyBootstrapRevisionTemplate(resource, supplied, revisionObjects[paused], paused);
    pausedTemplate ??= supplied;
  }
  if (revisionObjects[resumed]) {
    requireProof(pausedTemplate);
    const expected = structuredClone(pausedTemplate);
    expected.revision = resumed;
    const container = object((expected.containers as unknown[])[0]);
    const pause = (container.env as Obj[]).find(
      (v) => v.name === 'ASSISTANT_RELEASE_WRITES_PAUSED',
    );
    requireProof(pause);
    pause.value = 'false';
    verifyBootstrapRevisionTemplate(resource, expected, revisionObjects[resumed], resumed);
  }
  if (revisionObjects[parked]) {
    requireProof(pausedTemplate);
    verifyBootstrapRevisionTemplate(
      resource,
      { ...pausedTemplate, revision: parked },
      revisionObjects[parked],
      parked,
    );
  }
  return {
    service,
    resource,
    canonical,
    latest,
    ready,
    warming,
    rows,
    paused,
    parked,
    pausedTemplate,
    revisionObjects,
  };
}

/** Plan one etag-bound action. Completion always requires a new native snapshot. */
export function planApi3ForwardRecovery(
  review: Review,
  pair: Snapshots,
  settlement?: Settlement,
): Plan {
  reviewInput(review);
  const agentUri = text(
    object(pair.agent.service).uri,
    /^https:\/\/assistant-agent-[a-z0-9]+-uw\.a\.run\.app$/,
  );
  const state = {
    web: readRole(review, 'web', pair.web, agentUri),
    agent: readRole(review, 'agent', pair.agent, agentUri),
  };
  const serviceSha256 = {
    web: bootstrapDigest(state.web.service),
    agent: bootstrapDigest(state.agent.service),
  };
  for (const role of roles) {
    const current = state[role];
    if (
      current.warming ||
      (disabled(current.service) && current.rows.length === 1 && !current.rows[0]?.tag)
    )
      continue;
    return {
      outcome: 'action',
      action: {
        role,
        step: 'close',
        beforeSha256: serviceSha256[role],
        updateMask: 'scaling,traffic',
        body: {
          name: current.resource,
          etag: current.service.etag,
          scaling: manualZero,
          traffic: [target(current.canonical)],
        },
      },
    };
  }
  for (const role of roles) {
    const current = state[role];
    if (!current.warming) continue;
    const warming = current.warming.revision;
    const conditions = current.revisionObjects[warming]?.conditions;
    if (
      current.ready !== warming ||
      !Array.isArray(conditions) ||
      conditions
        .map(object)
        .filter(
          (condition) => condition.type === 'Ready' && condition.state === 'CONDITION_SUCCEEDED',
        ).length !== 1 ||
      !conditions.map(object).every((condition) => condition.state === 'CONDITION_SUCCEEDED')
    )
      return { outcome: 'startup-required', role, revision: warming };
  }
  if (!settlement) return { outcome: 'settlement-required', serviceSha256 };
  text(settlement.evidenceSha256, sha);
  const missingPaused = roles.filter((role) => !state[role].pausedTemplate);
  if (missingPaused.length) {
    requireProof(matching(settlement.serviceSha256, serviceSha256));
    return { outcome: 'paused-template-review-required', missingPaused };
  }
  const bindings = {} as BootstrapReceipt['services'];
  for (const role of roles) {
    const current = state[role];
    const desired =
      current.latest === current.paused || current.latest === current.parked
        ? current.latest
        : current.parked;
    if (
      current.canonical !== desired ||
      current.latest !== desired ||
      current.ready !== desired ||
      current.warming
    ) {
      requireProof(matching(settlement.serviceSha256, serviceSha256));
      const create = current.latest !== desired;
      const warm = create || current.ready !== desired;
      requireProof(!create || !current.revisionObjects[desired]);
      const route = warm
        ? [target(current.canonical), target(desired, `park-${review.runId}-1`)]
        : [target(desired)];
      return {
        outcome: 'action',
        action: {
          role,
          step: create ? 'create-paused' : warm ? 'warm' : 'pin',
          beforeSha256: serviceSha256[role],
          updateMask: create ? 'template,traffic' : 'traffic',
          body: {
            name: current.resource,
            etag: current.service.etag,
            ...(create ? { template: { ...current.pausedTemplate, revision: desired } } : {}),
            traffic: route,
          },
        },
      };
    }
    const revision = object(current.revisionObjects[desired]);
    const image = review.images[role];
    const binding: BootstrapReceipt['services'][Role] = {
      service: current.resource,
      uid: String(current.service.uid),
      revision: desired,
      image,
      serviceSha256: serviceSha256[role],
      revisionSha256: bootstrapDigest(revision),
      automaticScaling: review.original.services[role].automaticScaling,
      proof: {
        uid: tagHash(text(revision.uid, /^[A-Za-z0-9-]{1,128}$/)),
        image,
        source: review.source,
        manifest: review.manifest,
        runId: review.runId,
        attempt: '1',
        paused: true,
        templateSha256: bootstrapDigest(semanticTemplate(revision, image, desired)),
      },
    };
    verifyCurrentSnapshot(binding, current.service, revision);
    if (role === 'agent') {
      const urls = current.service.urls;
      requireProof(
        Array.isArray(urls) &&
          urls.includes(agentUri) &&
          new Set(urls).size === urls.length &&
          urls.every((uri) => uri === agentUri || uri === agentRegionalUri),
      );
    }
    bindings[role] = binding;
  }
  requireProof(matching(settlement.serviceSha256, serviceSha256));
  const receipt: BootstrapReceipt = {
    format: 1,
    kind: 'disabled-bootstrap',
    source: review.resumeSource,
    closureReceiptSha256: bootstrapDigest(serviceSha256),
    drainReceiptSha256: settlement.evidenceSha256,
    recoveryReceiptSha256: bootstrapDigest({
      original: review.originalSha256,
      attemptedSource: review.source,
      manifest: review.manifest,
      signedImagesReceiptSha256: review.signedImagesReceiptSha256,
      costProfileSha256: bootstrapDigest(review.costProfile),
      deliveryHoldReceiptSha256: review.deliveryHoldReceiptSha256,
      transitionSettlementReceiptSha256: review.transitionSettlementReceiptSha256,
    }),
    services: bindings,
  };
  const receiptSha256 = bootstrapDigest(receipt);
  reviewedBootstrap(receipt, receiptSha256, review.resumeSource);
  const binding = receipt.services.web;
  const context = pairedWebContext({
    source: review.resumeSource,
    // Validate the existing capture path using a distinct unused identity. The
    // real follow-on workflow receives its own run ID at dispatch.
    runId: review.runId === '1' ? '2' : '1',
    attempt: '1',
    manifestDigest: review.manifest,
    manifest: object(JSON.parse(review.releaseManifest)),
    current: {
      revision: binding.revision,
      binding: {
        proof: binding.proof,
        serviceSha256: binding.serviceSha256,
        revisionSha256: binding.revisionSha256,
        reviewedEvidenceSha256: receiptSha256,
        preclosed: true,
      },
    },
  });
  captureLifecycle(
    context,
    projectNativeWebSnapshot(
      pair.web.service,
      { [binding.revision]: pair.web.revisions[binding.revision] },
      context,
    ),
  );

  return { outcome: 'closed-api3-pair', receipt, receiptSha256 };
}
type PriorAction = { pair: Snapshots; settlement?: Settlement; action: Action };

/** Inspect the exact intended effect of one attempted action using saved GETs. */
export function reconcileApi3ForwardRecovery(
  review: Review,
  prior: PriorAction,
  observed: Snapshots,
) {
  const plan = planApi3ForwardRecovery(review, prior.pair, prior.settlement);
  requireProof(plan.outcome === 'action' && matching(plan.action, prior.action));
  const { role, step, updateMask, body } = plan.action;
  const before = object(prior.pair[role].service),
    after = object(observed[role].service);
  const other = role === 'agent' ? 'web' : 'agent';
  requireProof(matching(prior.pair[other], observed[other]));
  // Reuse closed-world scope checks for both services before evaluating effect.
  planApi3ForwardRecovery(review, observed);
  requireProof(
    after.etag !== before.etag &&
      BigInt(String(after.generation)) > BigInt(String(before.generation)) &&
      disabled(after),
  );
  const fields = new Set(updateMask.split(','));
  const unchanged = (s: Obj) =>
    scalingConfigurationDigest(
      Object.fromEntries(Object.entries(s).filter(([name]) => !fields.has(name))),
    );
  requireProof(unchanged(before) === unchanged(after));
  for (const rows of [after.traffic, after.trafficStatuses])
    requireProof(
      matching(
        routeRows(String(after.name), rows, role, review.runId),
        routeRows(String(after.name), body.traffic, role, review.runId),
      ),
    );
  if (step === 'create-paused') {
    const template = object(body.template);
    const revision = name(String(after.name), after.latestCreatedRevision);
    requireProof(revision === template.revision);
    const raw = observed[role].revisions[revision];
    verifyBootstrapRevisionTemplate(String(after.name), template, raw, revision);
    verifyBootstrapRevisionTemplate(String(after.name), after.template, raw, revision);
  }
  return {
    outcome: 'observed-exact-effect' as const,
    source: review.source,
    role,
    step,
    beforeSha256: plan.action.beforeSha256,
    requestSha256: bootstrapDigest(plan.action),
    afterSha256: bootstrapDigest(after),
    operationProven: false,
  };
}

function privateBytes(path: string, limit: number) {
  const stat = lstatSync(path);
  requireProof(stat.isFile() && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= limit);
  return readFileSync(path);
}
function main() {
  const [, , input, expected, output] = process.argv;
  requireProof(process.argv.length === 5 && input && expected && output);
  const packet = JSON.parse(privateBytes(input, 16 * 1024 * 1024).toString('utf8')) as {
    review: Review;
    pair: Snapshots;
    settlement?: Settlement;
    imageProofs: { image: string; parent: string; child: string }[];
    unresolvedAttemptSha256?: string;
    reconcile?: PriorAction;
  };
  requireProof(bootstrapDigest(packet) === expected);
  requireProof(Array.isArray(packet.imageProofs) && packet.imageProofs.length <= 4);
  for (const proof of packet.imageProofs)
    registerImageResolution(
      proof.image,
      privateBytes(proof.parent, 2 * 1024 * 1024),
      privateBytes(proof.child, 2 * 1024 * 1024),
    );
  let plan: Plan | ReturnType<typeof reconcileApi3ForwardRecovery>;
  if (packet.unresolvedAttemptSha256) {
    requireProof(
      packet.reconcile &&
        bootstrapDigest(packet.reconcile.action) === packet.unresolvedAttemptSha256,
    );
    plan = reconcileApi3ForwardRecovery(packet.review, packet.reconcile, packet.pair);
  } else {
    requireProof(!packet.reconcile);
    plan = planApi3ForwardRecovery(packet.review, packet.pair, packet.settlement);
  }
  writeFileSync(output, `${JSON.stringify({ inputSha256: expected, ...plan }, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
}
if (process.argv[1]?.endsWith('/owner-release-api3-recovery.ts')) {
  try {
    main();
  } catch {
    process.stderr.write(
      'The reviewed API 3 recovery step could not be planned. Preserve holds and reconcile using reads.\n',
    );
    process.exitCode = 1;
  }
}
