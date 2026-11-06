/** Pure reviewed current binding; no transport, credential lookup or settlement observation. */
import type { NativeProof } from './owner-web-release-lifecycle-model.js';
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
export function requireProof(v: unknown): asserts v {
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
  if (!s.scaling || typeof s.scaling !== 'object' || Array.isArray(s.scaling)) return false;
  const scaling = object(s.scaling);
  return (
    scaling.scalingMode === 'MANUAL' &&
    (scaling.manualInstanceCount === undefined || scaling.manualInstanceCount === 0)
  );
}
export function reviewedCurrentEnvironment(env: NodeJS.ProcessEnv, source: string) {
  const raw = env.OWNER_RELEASE_BOOTSTRAP_RECEIPT;
  if (!raw) return undefined;
  requireProof(Buffer.byteLength(raw) <= 32768);
  return reviewedBootstrap(JSON.parse(raw), env.OWNER_RELEASE_BOOTSTRAP_SHA256 ?? '', source);
}
export function verifyCurrentService(
  binding: CurrentBinding,
  service: unknown,
  mustBeDisabled = true,
) {
  const s = object(service);
  requireProof(
    s.name === binding.service &&
      s.uid === binding.uid &&
      (!mustBeDisabled || disabled(s)) &&
      bootstrapDigest(s) === binding.serviceSha256,
  );
  for (const value of [s.traffic, s.trafficStatuses]) {
    requireProof(Array.isArray(value) && value.length === 1);
    const row = object(value[0]);
    requireProof(
      row.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' &&
        row.revision === binding.revision &&
        row.percent === 100 &&
        (!mustBeDisabled || !row.tag),
    );
  }
  const terminal = object(s.terminalCondition);
  requireProof(
    terminal.state === 'CONDITION_SUCCEEDED' ||
      (mustBeDisabled && retiredCurrentCondition(terminal)),
  );
  requireProof(
    s.reconciling !== true &&
      [binding.revision, `${binding.service}/revisions/${binding.revision}`].includes(
        String(s.latestCreatedRevision),
      ),
  );
}
export function retiredCurrentCondition(c: Obj) {
  return (
    ['Ready', 'Active', 'ResourcesAvailable'].includes(String(c.type)) &&
    c.revisionReason === 'RETIRED' &&
    [undefined, 'STATE_UNSPECIFIED', 'CONDITION_FAILED'].includes(c.state as string | undefined)
  );
}
export function verifyCurrentSnapshot(
  binding: CurrentBinding,
  service: unknown,
  revision: unknown,
  mustBeDisabled = true,
) {
  verifyCurrentService(binding, service, mustBeDisabled);
  const r = object(revision);
  requireProof(
    bootstrapDigest(r) === binding.revisionSha256 &&
      r.name === `${binding.service}/revisions/${binding.revision}`,
  );
  requireProof(
    Array.isArray(r.containers) &&
      r.containers.length === 1 &&
      object(r.containers[0]).image === binding.image,
  );
  const conditions = r.conditions;
  requireProof(Array.isArray(conditions) && conditions.length > 0 && conditions.length <= 16);
  const retired = (c: Obj) => mustBeDisabled && retiredCurrentCondition(c);
  requireProof(
    conditions.map(object).every((c) => c.state === 'CONDITION_SUCCEEDED' || retired(c)),
  );
  const ready = conditions.map(object).filter((c) => c.type === 'Ready');
  requireProof(
    ready.length === 1 && (ready[0]?.state === 'CONDITION_SUCCEEDED' || retired(ready[0] as Obj)),
  );
}
