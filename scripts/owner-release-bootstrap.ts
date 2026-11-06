/** Reviewed current-snapshot adapter. Evidence hashes bind reviewed material, never prove drain by absence. */
import {
  type NativeProof,
  type Snapshot,
  type State,
  verifyLifecycleState,
} from './owner-web-release-lifecycle-model.js';
import type { FixtureDependencies } from './owner-web-release-native-session.js';
import { boundedResponseJson } from './owner-web-release-operator-hold.js';
import { reconciliationDigest } from './owner-web-traffic-reconciliation-model.js';

type Obj = Record<string, unknown>;
export const RUN_ROOT = 'https://run.googleapis.com/v2/';
export const SERVICE_ROOT = 'projects/bmson-assistant/locations/us-west1/services/assistant-';
export function object(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Bootstrap receipt held');
  return v as Obj;
}
export const bootstrapDigest = reconciliationDigest;
const SERVICE_OUTPUT = new Set([
  'etag',
  'generation',
  'observedGeneration',
  'createTime',
  'updateTime',
  'creator',
  'lastModifier',
  'conditions',
  'terminalCondition',
  'latestReadyRevision',
  'latestCreatedRevision',
  'trafficStatuses',
  'uri',
  'urls',
  'reconciling',
]);
export const scalingConfigurationDigest = (s: Obj) =>
  bootstrapDigest(Object.fromEntries(Object.entries(s).filter(([k]) => !SERVICE_OUTPUT.has(k))));
export function verifiedRestoreReceipts(
  attempt: unknown,
  completion: unknown,
  unknownExists: boolean,
  role: string,
  source: string,
) {
  requireProof(!unknownExists);
  const a = object(attempt),
    c = object(completion);
  requireProof(
    a.kind === 'bootstrap-scaling' &&
      c.kind === a.kind &&
      a.source === source &&
      c.source === source &&
      a.role === role &&
      c.role === role &&
      a.outcome === 'attempted' &&
      c.outcome === 'completed',
  );
  for (const value of [
    a.beforeSha256,
    a.requestSha256,
    c.beforeSha256,
    c.afterSha256,
    c.afterConfigurationSha256,
  ])
    requireProof(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
  requireProof(
    a.beforeSha256 === c.beforeSha256 &&
      typeof c.operation === 'string' &&
      /^projects\/bmson-assistant\/locations\/us-west1\/operations\/[A-Za-z0-9-]+$/.test(
        c.operation,
      ),
  );
  return String(c.afterConfigurationSha256);
}

const same = (a: unknown, b: unknown) => bootstrapDigest(a) === bootstrapDigest(b);
function requireProof(v: unknown): asserts v {
  if (!v) throw new Error('Bootstrap receipt held');
}
export type CurrentBinding = {
  service: string;
  uid: string;
  revision: string;
  image: string;
  serviceSha256: string;
  revisionSha256: string;
  proof: NativeProof;
  automaticScaling?: Obj;
};
export type BootstrapReceipt = {
  format: 1;
  kind: 'disabled-bootstrap' | 'current-snapshot';
  source: string;
  closureReceiptSha256: string;
  drainReceiptSha256: string;
  recoveryReceiptSha256: string;
  services: { web: CurrentBinding; agent: CurrentBinding };
};
export function reviewedBootstrap(raw: unknown, digest: string, source: string): BootstrapReceipt {
  const r = object(raw);
  requireProof(
    /^[a-f0-9]{64}$/.test(digest) &&
      bootstrapDigest(r) === digest &&
      r.format === 1 &&
      ['disabled-bootstrap', 'current-snapshot'].includes(String(r.kind)) &&
      r.source === source,
  );
  requireProof(/^[a-f0-9]{40}$/.test(source));
  for (const k of r.kind === 'disabled-bootstrap'
    ? ['closureReceiptSha256', 'drainReceiptSha256', 'recoveryReceiptSha256']
    : [])
    requireProof(typeof r[k] === 'string' && /^[a-f0-9]{64}$/.test(r[k] as string));
  const services = object(r.services);
  requireProof(same(Object.keys(services).sort(), ['agent', 'web']));
  for (const role of ['agent', 'web'] as const) {
    const b = object(services[role]),
      p = object(b.proof);
    requireProof(
      b.service === `${SERVICE_ROOT}${role}` && typeof b.uid === 'string' && b.uid.length > 0,
    );
    requireProof(
      typeof b.revision === 'string' &&
        new RegExp(`^assistant-${role}-[a-z0-9-]+$`).test(b.revision),
    );
    requireProof(
      typeof b.image === 'string' &&
        new RegExp(
          `^us-west1-docker\\.pkg\\.dev/bmson-assistant/assistant/${role}@sha256:[a-f0-9]{64}$`,
        ).test(b.image),
    );
    for (const k of ['serviceSha256', 'revisionSha256'])
      requireProof(typeof b[k] === 'string' && /^[a-f0-9]{64}$/.test(b[k] as string));
    requireProof(
      p.image === b.image && typeof p.source === 'string' && /^[a-f0-9]{40}$/.test(p.source),
    );
    requireProof(
      typeof p.paused === 'boolean' && typeof p.uid === 'string' && /^[a-f0-9]{64}$/.test(p.uid),
    );
    requireProof(
      typeof p.manifest === 'string' &&
        /^[a-f0-9]{64}$/.test(p.manifest) &&
        typeof p.runId === 'string' &&
        /^[1-9][0-9]{0,19}$/.test(p.runId) &&
        typeof p.attempt === 'string' &&
        /^[1-9][0-9]{0,5}$/.test(p.attempt),
    );
    requireProof(typeof p.templateSha256 === 'string' && /^[a-f0-9]{64}$/.test(p.templateSha256));
    if (r.kind === 'disabled-bootstrap') {
      const scaling = object(b.automaticScaling);
      requireProof(
        scaling.scalingMode === 'AUTOMATIC' && scaling.manualInstanceCount === undefined,
      );
      requireProof(
        Object.keys(scaling).every((k) =>
          ['scalingMode', 'minInstanceCount', 'maxInstanceCount'].includes(k),
        ),
      );
    }
  }
  return raw as BootstrapReceipt;
}
export function disabled(s: Obj) {
  const scaling = object(s.scaling);
  return (
    scaling.scalingMode === 'MANUAL' &&
    (scaling.manualInstanceCount === undefined || scaling.manualInstanceCount === 0)
  );
}
export function verifyCurrentSnapshot(
  binding: CurrentBinding,
  service: unknown,
  revision: unknown,
  mustBeDisabled = true,
) {
  const s = object(service),
    r = object(revision);
  requireProof(
    s.name === binding.service && s.uid === binding.uid && (!mustBeDisabled || disabled(s)),
  );
  requireProof(
    bootstrapDigest(s) === binding.serviceSha256 && bootstrapDigest(r) === binding.revisionSha256,
  );
  requireProof(
    r.name === `${binding.service}/revisions/${binding.revision}` &&
      object((r.containers as unknown[])[0]).image === binding.image,
  );
  for (const rows of [s.traffic, s.trafficStatuses]) {
    requireProof(Array.isArray(rows) && rows.length === 1);
    const row = object(rows[0]);
    requireProof(
      row.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' && row.revision === binding.revision && row.percent === 100 && (!mustBeDisabled || !row.tag),
    );
  }
  requireProof(
    s.reconciling !== true &&
      s.latestCreatedRevision === `${binding.service}/revisions/${binding.revision}`,
  );
}
function literal(template: Obj, name: string) {
  const cs = template.containers;
  requireProof(Array.isArray(cs) && cs.length === 1);
  const env = object(cs[0]).env;
  requireProof(Array.isArray(env));
  const es = env.map(object).filter((e) => e.name === name);
  requireProof(es.length === 1 && typeof es[0]?.value === 'string' && !es[0].valueSource);
  return es[0]?.value;
}
export function planScalingRestore(
  receipt: BootstrapReceipt,
  role: 'agent' | 'web',
  service: unknown,
  revision: unknown,
  expected: {
    revision: string;
    image: string;
    source: string;
    manifest: string;
    runId: string;
    attempt: string;
  },
  forHold = false,
) {
  requireProof(receipt.kind === 'disabled-bootstrap');
  const s = object(service),
    r = object(revision),
    b = receipt.services[role];
  requireProof(receipt.source === expected.source && expected.revision !== b.revision);
  requireProof(s.name === b.service && s.uid === b.uid && disabled(s) && s.reconciling !== true);
  requireProof(typeof s.etag === 'string' && s.etag.length > 0);
  requireProof(r.name === `${b.service}/revisions/${expected.revision}` && r.service === b.service);
  if (!forHold) {
    requireProof(s.observedGeneration === s.generation && object(s.terminalCondition).state === 'CONDITION_SUCCEEDED');
    requireProof(String(s.latestCreatedRevision).split('/').at(-1) === expected.revision && String(s.latestReadyRevision).split('/').at(-1) === expected.revision);
    const conditions = r.conditions;
    requireProof(Array.isArray(conditions) && conditions.length > 0 && conditions.length <= 16);
    requireProof(
      conditions
        .map(object)
        .every(
          (c) =>
            c.state === 'CONDITION_SUCCEEDED' &&
            c.reason === undefined &&
            c.revisionReason === undefined,
        ),
    );
    requireProof(
      conditions.map(object).filter((c) => c.type === 'Ready' && c.state === 'CONDITION_SUCCEEDED')
        .length === 1,
    );
  }
  const t = object(s.template),
    cs = t.containers;
  requireProof(Array.isArray(cs) && cs.length === 1 && object(cs[0]).image === expected.image);
  requireProof(
    t.revision === expected.revision &&
      literal(t, 'ASSISTANT_RELEASE_MANIFEST') === expected.manifest,
  );
  requireProof(literal(t, 'ASSISTANT_RELEASE_SOURCE_SHA') === expected.source);
  requireProof(
    literal(t, 'ASSISTANT_RELEASE_WORKFLOW_RUN_ID') === expected.runId &&
      literal(t, 'ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT') === expected.attempt,
  );
  if (role === 'web') requireProof(literal(t, 'ASSISTANT_RELEASE_WRITES_PAUSED') === 'true');
  const projected: Obj = {};
  for (const key of Object.keys(t)) if (r[key] !== undefined) projected[key] = r[key];
  projected.revision = expected.revision;
  requireProof(same(t, projected));
  for (const rows of [s.traffic, s.trafficStatuses]) {
    requireProof(Array.isArray(rows));
    const canonical = rows.map(object).filter((x) => Number(x.percent) > 0);
    requireProof(
      canonical.length === 1 &&
        canonical[0]?.revision === expected.revision &&
        canonical[0]?.percent === 100,
    );
    requireProof(rows.map(object).every((x) => x.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' && x.revision === expected.revision));
  }
  return { name: b.service, etag: s.etag, scaling: object(b.automaticScaling) };
}
/** Metadata-only checkpoint: no phase or admission transition is introduced. */
export function scalingCheckpoint(
  state: State,
  fresh: Snapshot,
  expectedStableHash: string,
): State {
  verifyLifecycleState(state);
  requireProof(
    ['promotedP', 'retired', 'agentReady'].includes(state.phase) &&
      !state.pending &&
      !state.admissionPossible &&
      !state.retirementAttempt,
  );
  const before = state.snapshot;
  const keys = Object.keys(before).filter(
    (k) => !['etag', 'generation', 'observedGeneration', 'stableConfigSha256'].includes(k),
  );
  requireProof(
    same(
      Object.fromEntries(keys.map((k) => [k, before[k as keyof Snapshot]])),
      Object.fromEntries(keys.map((k) => [k, fresh[k as keyof Snapshot]])),
    ),
  );
  requireProof(
    fresh.stableConfigSha256 === expectedStableHash &&
      fresh.etag !== before.etag &&
      BigInt(fresh.generation) > BigInt(before.generation) &&
      fresh.observedGeneration === fresh.generation,
  );
  const { receipt: prior, ...body } = {
    ...state,
    snapshot: fresh,
    previousReceipt: state.receipt,
    ordinal: state.ordinal + 1,
  };
  return { ...body, receipt: bootstrapDigest(body) };
}
export type ScalingIO = Pick<FixtureDependencies, 'now' | 'sleep' | 'request'> & {
  recordIntent: (value: unknown) => Promise<void>;
};
export async function readBootstrapNative(io: Pick<ScalingIO, 'request'>, path: string) {
  requireProof(path.startsWith(SERVICE_ROOT) && !path.includes('?'));
  const response = await io.request(`${RUN_ROOT}${path}`, {
    method: 'GET',
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  return object(await boundedResponseJson(response, 2 * 1024 * 1024, 15000));
}
/** Single PATCH; unknown result is retained and never retried by this adapter. */
export async function restoreScaling(
  io: ScalingIO,
  receipt: BootstrapReceipt,
  role: 'agent' | 'web',
  expected: {
    revision: string;
    image: string;
    source: string;
    manifest: string;
    runId: string;
    attempt: string;
  },
  hold = false,
  expectedAfterConfiguration?: string,
) {
  const deadline = io.now() + 180000;
  async function request(path: string, body?: Obj) {
    requireProof(io.now() < deadline);
    const response = await io.request(`${RUN_ROOT}${path}`, {
      method: body ? 'PATCH' : 'GET',
      ...(body
        ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
        : {}),
      signal: AbortSignal.timeout(Math.min(15000, deadline - io.now())),
      redirect: 'error',
    });
    requireProof(
      response.ok && Number(response.headers.get('content-length') ?? 0) <= 2 * 1024 * 1024,
    );
    return object(
      await boundedResponseJson(response, 2 * 1024 * 1024, Math.min(15000, deadline - io.now())),
    );
  }
  const name = receipt.services[role].service,
    before = await request(name),
    revision = await request(`${name}/revisions/${expected.revision}`);
  const probe = hold
    ? { ...before, scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 } }
    : before;
  if (hold) requireProof(same(before.scaling, receipt.services[role].automaticScaling));
  if (hold)
    requireProof(
      expectedAfterConfiguration &&
        scalingConfigurationDigest(before) === expectedAfterConfiguration,
    );
  const body = planScalingRestore(receipt, role, probe, revision, expected, hold);
  if (hold) body.scaling = { scalingMode: 'MANUAL', manualInstanceCount: 0 };
  await io.recordIntent({
    kind: 'bootstrap-scaling',
    role,
    source: expected.source,
    beforeSha256: bootstrapDigest(before),
    requestSha256: bootstrapDigest(body),
    outcome: 'attempted',
  });
  try {
    let op = await request(`${name}?updateMask=scaling`, body);
    requireProof(
      typeof op.name === 'string' &&
        /^projects\/bmson-assistant\/locations\/us-west1\/operations\/[A-Za-z0-9-]+$/.test(op.name),
    );
    const operation = op.name;
    for (let n = 0; op.done !== true; n++) {
      requireProof(n < 50 && !op.error);
      await io.sleep(3000, AbortSignal.timeout(Math.max(1, deadline - io.now())));
      op = await request(operation);
      requireProof(op.name === operation);
    }
    requireProof(!op.error && object(op.response).name === name);
    const after = await request(name);
    const beforeConfig = { ...before };
    delete beforeConfig.scaling;
    const afterConfig = { ...after };
    delete afterConfig.scaling;
    requireProof(
      scalingConfigurationDigest(beforeConfig) === scalingConfigurationDigest(afterConfig),
    );
    requireProof(
      same(after.scaling, body.scaling) && after.reconciling !== true && after.etag !== before.etag,
    );
    await io.recordIntent({
      kind: 'bootstrap-scaling',
      role,
      source: expected.source,
      beforeSha256: bootstrapDigest(before),
      afterSha256: bootstrapDigest(after),
      afterConfigurationSha256: scalingConfigurationDigest(after),
      operation,
      outcome: 'completed',
    });
    return { before, after, revision };
  } catch {
    await io.recordIntent({
      kind: 'bootstrap-scaling',
      role,
      source: expected.source,
      beforeSha256: bootstrapDigest(before),
      outcome: 'unknown',
    });
    throw new Error('Bootstrap scaling outcome unconfirmed; no retry or legacy resume');
  }
}
