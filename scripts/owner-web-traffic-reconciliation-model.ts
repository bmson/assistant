/** Separate source-only reconciliation model. Not wired to credentials, workflow or production. */
import { createHash } from 'node:crypto';
import { operationName } from './owner-web-tag-native.js';
import {
  HISTORICAL_WEB_TAGS,
  immutableWebRevision,
  type OwnedWebTagProof,
  validateOwnedProof,
  WEB_SERVICE,
} from './owner-web-tag-retirement.js';

type ObjectValue = Record<string, unknown>;
type Traffic = {
  type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION';
  revision: string;
  tag: string;
  percent: number;
};
type Reason =
  | 'invalid_metadata'
  | 'unexpected_topology'
  | 'native_proof_refused'
  | 'stale_review'
  | 'stale_plan'
  | 'read_failed'
  | 'patch_unconfirmed'
  | 'operation_unconfirmed'
  | 'postcheck_failed';
const reasons = new Set<Reason>([
  'invalid_metadata',
  'unexpected_topology',
  'native_proof_refused',
  'stale_review',
  'stale_plan',
  'read_failed',
  'patch_unconfirmed',
  'operation_unconfirmed',
  'postcheck_failed',
]);
export class TrafficReconciliationStop extends Error {
  constructor(
    readonly reason: Reason,
    readonly mutationState: 'not_attempted' | 'may_have_been_attempted' = 'not_attempted',
  ) {
    super(`Traffic reconciliation held: ${reason}`);
  }
}
function stop(reason: Reason): never {
  throw new TrafficReconciliationStop(reason);
}
function safeReason(error: unknown, fallback: Reason): Reason {
  try {
    if (error instanceof TrafficReconciliationStop && reasons.has(error.reason))
      return error.reason;
  } catch {
    /* Do not disclose hostile exception getters, stacks or causes. */
  }
  return fallback;
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) stop('invalid_metadata');
  return value as ObjectValue;
}
function text(value: unknown, pattern: RegExp) {
  if (typeof value !== 'string' || !pattern.test(value)) stop('invalid_metadata');
  return value;
}
function revisionIdentity(value: unknown) {
  const name = text(value, /^[A-Za-z0-9/_-]{1,512}$/);
  return text(
    name.startsWith(`${WEB_SERVICE}/revisions/`)
      ? name.slice(`${WEB_SERVICE}/revisions/`.length)
      : name,
    /^assistant-web-[a-z0-9-]{1,63}$/,
  );
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
export const reconciliationDigest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const uriHash = (value: unknown) =>
  createHash('sha256')
    .update(text(value, /^https:\/\/[^\s]{1,512}$/))
    .digest('hex');
function generation(value: unknown) {
  const result = text(value, /^[1-9][0-9]{0,18}$/);
  if (BigInt(result) > 9223372036854775807n) stop('invalid_metadata');
  return result;
}
function pins(): [OwnedWebTagProof, OwnedWebTagProof] {
  const old = HISTORICAL_WEB_TAGS[0],
    current = HISTORICAL_WEB_TAGS[1];
  if (!old || !current) stop('native_proof_refused');
  return [validateOwnedProof(old), validateOwnedProof(current)];
}
function row(proof: OwnedWebTagProof, percent: number, tagged = true): Traffic {
  return {
    type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
    revision: proof.revision,
    tag: tagged ? proof.tag : '',
    percent,
  };
}
function rows(raw: unknown, status: boolean): Traffic[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) stop('unexpected_topology');
  return raw.map((value) => {
    const r = object(value);
    if (
      Object.keys(r).some(
        (key) => !['type', 'revision', 'tag', 'percent', ...(status ? ['uri'] : [])].includes(key),
      ) ||
      r.type !== 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION'
    )
      stop('unexpected_topology');
    const revision =
      typeof r.revision === 'string' && r.revision.startsWith(`${WEB_SERVICE}/revisions/`)
        ? r.revision.slice(`${WEB_SERVICE}/revisions/`.length)
        : r.revision;
    const percent = r.percent === undefined ? 0 : r.percent;
    if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > 100)
      stop('unexpected_topology');
    return {
      type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
      revision: text(revision, /^assistant-web-[a-z0-9-]{1,63}$/),
      tag: r.tag === undefined ? '' : text(r.tag, /^[a-z][a-z0-9-]{0,62}$/),
      percent,
    };
  });
}
const trafficHash = (values: Traffic[]) =>
  reconciliationDigest(values.map((value) => JSON.stringify(value)).sort());
const sortedRows = (values: Traffic[]) =>
  [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function service(raw: unknown) {
  const s = object(raw);
  if (
    s.name !== WEB_SERVICE ||
    (s.reconciling !== undefined && s.reconciling !== false) ||
    object(s.terminalCondition).state !== 'CONDITION_SUCCEEDED'
  )
    stop('invalid_metadata');
  const gen = generation(s.generation);
  if (s.observedGeneration !== gen) stop('invalid_metadata');
  const uid = text(s.uid, /^[A-Za-z0-9-]{1,128}$/),
    etag = text(s.etag, /^[ -~]{1,512}$/);
  const latestRevisionIdentitySha256 = reconciliationDigest({
    ready: revisionIdentity(s.latestReadyRevision),
    created: revisionIdentity(s.latestCreatedRevision),
  });
  const volatile = new Set([
    'traffic',
    'trafficStatuses',
    'etag',
    'generation',
    'observedGeneration',
    'updateTime',
    'reconciling',
    'terminalCondition',
    'conditions',
    'lastModifier',
    'urls',
  ]);
  const config = Object.fromEntries(Object.entries(s).filter(([key]) => !volatile.has(key)));
  let urls: string[] | null = null;
  if (s.urls !== undefined) {
    if (!Array.isArray(s.urls) || s.urls.length < 1 || s.urls.length > 32) stop('invalid_metadata');
    urls = s.urls.map((value) => text(value, /^https:\/\/[^\s]{1,512}$/)).sort();
    if (new Set(urls).size !== urls.length) stop('invalid_metadata');
  }
  return {
    s,
    uid,
    etag,
    generation: gen,
    rootUriSha256: uriHash(s.uri),
    latestRevisionIdentitySha256,
    urlsSha256: reconciliationDigest(urls),
    configurationSha256: reconciliationDigest(config),
    templateSha256: reconciliationDigest(object(s.template)),
    desired: rows(s.traffic, false),
    observed: rows(s.trafficStatuses, true),
  };
}
function nativeProofs(raw: unknown, s: ObjectValue) {
  const native = object(raw),
    [old, current] = pins();
  if (Object.keys(native).sort().join(',') !== [old.revision, current.revision].sort().join(','))
    stop('native_proof_refused');
  const proof = (p: OwnedWebTagProof) => {
    const r = object(native[p.revision]);
    const checked = immutableWebRevision(r, p.revision, p.image, p.writesPaused);
    const uid = text(r.uid, /^[A-Za-z0-9-]{1,128}$/);
    text(r.serviceAccount, /^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com$/);
    return {
      revision: p.revision,
      image: p.image,
      source: p.source,
      provenanceSha256: p.provenanceSha256,
      timeoutSeconds: checked.timeoutSeconds,
      uidSha256: reconciliationDigest(uid),
      immutableConfigurationSha256: reconciliationDigest({
        name: r.name,
        uid,
        serviceAccount: r.serviceAccount,
        timeout: r.timeout,
        containers: r.containers,
      }),
    };
  };
  const oldProof = proof(old),
    currentProof = proof(current),
    template = object(s.template);
  if (
    !Array.isArray(template.containers) ||
    template.containers.length !== 1 ||
    object(template.containers[0]).image !== current.image ||
    template.serviceAccount !== object(native[current.revision]).serviceAccount
  )
    stop('native_proof_refused');
  return { old: oldProof, current: currentProof };
}
function verifyUris(s: ObjectValue) {
  const statuses = s.trafficStatuses;
  if (!Array.isArray(statuses) || statuses.length !== 2) stop('unexpected_topology');
  const result = pins().map((p) => {
    const matching = statuses.map(object).filter((r) => r.tag === p.tag);
    if (matching.length !== 1 || uriHash(matching[0]?.uri) !== p.uriSha256)
      stop('unexpected_topology');
    return { tag: p.tag, revision: p.revision, uriSha256: p.uriSha256 };
  });
  return result;
}
function stamp(value: unknown) {
  const result = text(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  if (!Number.isFinite(Date.parse(result)) || new Date(Date.parse(result)).toISOString() !== result)
    stop('invalid_metadata');
  return result;
}
export interface ReconciliationPatch {
  name: typeof WEB_SERVICE;
  etag: string;
  traffic: Array<{ type: Traffic['type']; revision: string; tag: string; percent: number }>;
}
function model(raw: unknown, native: unknown, source: string, observedAt: string) {
  text(source, /^[a-f0-9]{40}$/);
  stamp(observedAt);
  const before = service(raw),
    [old, current] = pins();
  const wantedDesired = [row(current, 100, false), row(current, 0), row(old, 0)],
    wantedObserved = [row(current, 100), row(old, 0)];
  if (
    before.desired.length !== 3 ||
    before.observed.length !== 2 ||
    trafficHash(before.desired) !== trafficHash(wantedDesired) ||
    trafficHash(before.observed) !== trafficHash(wantedObserved)
  )
    stop('unexpected_topology');
  const tagBindings = verifyUris(before.s),
    nativeRevisionProofs = nativeProofs(native, before.s);
  const traffic = wantedObserved.map((r) => ({
    type: r.type,
    revision: r.revision,
    tag: r.tag,
    percent: r.percent,
  }));
  const patch: ReconciliationPatch = { name: WEB_SERVICE, etag: before.etag, traffic };
  return {
    format: 1,
    kind: 'exact_known_web_traffic_reconciliation' as const,
    source,
    observedAt,
    service: WEB_SERVICE,
    before: {
      uid: before.uid,
      etag: before.etag,
      generation: before.generation,
      rootUriSha256: before.rootUriSha256,
      latestRevisionIdentitySha256: before.latestRevisionIdentitySha256,
      urlsSha256: before.urlsSha256,
      templateSha256: before.templateSha256,
      configurationSha256: before.configurationSha256,
      desired: sortedRows(before.desired),
      observed: sortedRows(before.observed),
      desiredTrafficSha256: trafficHash(before.desired),
      observedTrafficSha256: trafficHash(before.observed),
      defaultAllocation: [
        { revision: current.revision, percent: 100 },
        { revision: old.revision, percent: 0 },
      ],
      tagBindings,
    },
    after: {
      desired: traffic,
      expectedObserved: traffic,
      defaultAllocation: [
        { revision: current.revision, percent: 100 },
        { revision: old.revision, percent: 0 },
      ],
      tagBindings,
    },
    nativeRevisionProofs,
    request: { method: 'PATCH' as const, updateMask: 'traffic' as const, body: patch },
    retiresTags: false,
    createsRevision: false,
    editingAuthorized: false,
    retirementDrainCompleted: false,
    requiresNewNormalRetirementPlan: true,
  };
}
export type WebTrafficReconciliationPlan = ReturnType<typeof model>;
export function planWebTrafficReconciliation(
  raw: unknown,
  native: unknown,
  source: string,
  observedAt: string,
): WebTrafficReconciliationPlan {
  try {
    return model(raw, native, source, observedAt);
  } catch (error) {
    stop(safeReason(error, 'native_proof_refused'));
  }
}
export function verifyWebTrafficReconciliationPost(
  raw: unknown,
  native: unknown,
  plan: WebTrafficReconciliationPlan,
) {
  try {
    const after = service(raw),
      before = plan.before;
    if (
      after.uid !== before.uid ||
      after.etag === before.etag ||
      BigInt(after.generation) <= BigInt(before.generation) ||
      after.rootUriSha256 !== before.rootUriSha256 ||
      after.latestRevisionIdentitySha256 !== before.latestRevisionIdentitySha256 ||
      after.urlsSha256 !== before.urlsSha256 ||
      after.templateSha256 !== before.templateSha256 ||
      after.configurationSha256 !== before.configurationSha256
    )
      stop('postcheck_failed');
    const expected = plan.after.desired;
    if (
      after.desired.length !== 2 ||
      after.observed.length !== 2 ||
      trafficHash(after.desired) !== trafficHash(expected) ||
      trafficHash(after.observed) !== trafficHash(expected) ||
      reconciliationDigest(verifyUris(after.s)) !== reconciliationDigest(plan.after.tagBindings) ||
      reconciliationDigest(nativeProofs(native, after.s)) !==
        reconciliationDigest(plan.nativeRevisionProofs)
    )
      stop('postcheck_failed');
    return {
      outcome: 'strict_equality_restored_both_tags_preserved' as const,
      serviceUid: after.uid,
      serviceEtag: after.etag,
      serviceGeneration: after.generation,
      desiredTrafficSha256: trafficHash(after.desired),
      observedTrafficSha256: trafficHash(after.observed),
      rootUriSha256: after.rootUriSha256,
      tagBindings: plan.after.tagBindings,
      retiresTags: false,
      createsRevision: false,
      editingAuthorized: false,
      retirementDrainCompleted: false,
      requiresNewNormalRetirementPlan: true,
    };
  } catch {
    stop('postcheck_failed');
  }
}
export interface TrafficReconciliationIO {
  readService(signal: AbortSignal): Promise<unknown>;
  readRevision(name: string, signal: AbortSignal): Promise<unknown>;
  patchTraffic(
    body: ReconciliationPatch,
    options: { updateMask: 'traffic'; signal: AbortSignal },
  ): Promise<unknown>;
  waitOperation(operation: unknown, signal: AbortSignal): Promise<void>;
}
function reviewTime(value: unknown, now: number) {
  if (!Number.isFinite(now)) stop('stale_review');
  const time = Date.parse(stamp(value));
  if (time > now || now - time > 1800000) stop('stale_review');
}
async function bounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  reason: Reason,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TrafficReconciliationStop(reason));
    }, milliseconds);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
/** Source-only injected executor. No credential/native adapter or workflow invokes this model. */
export async function executeWebTrafficReconciliation(
  plan: WebTrafficReconciliationPlan,
  io: TrafficReconciliationIO,
  now: () => number = Date.now,
) {
  let attempted = false,
    phase: Reason = 'read_failed';
  try {
    reviewTime(plan.observedAt, now());
    const read = async () => {
      const service = await bounded((signal) => io.readService(signal), 15000, 'read_failed');
      const native: Record<string, unknown> = {};
      for (const p of pins())
        native[p.revision] = await bounded(
          (signal) => io.readRevision(p.revision, signal),
          15000,
          'read_failed',
        );
      return { service, native };
    };
    const fresh = await read();
    if (
      reconciliationDigest(
        planWebTrafficReconciliation(fresh.service, fresh.native, plan.source, plan.observedAt),
      ) !== reconciliationDigest(plan)
    )
      stop('stale_plan');
    reviewTime(plan.observedAt, now());
    phase = 'patch_unconfirmed';
    attempted = true;
    const operation = await bounded(
      (signal) => io.patchTraffic(plan.request.body, { updateMask: 'traffic', signal }),
      15000,
      'patch_unconfirmed',
    );
    phase = 'operation_unconfirmed';
    operationName(operation);
    await bounded((signal) => io.waitOperation(operation, signal), 180000, 'operation_unconfirmed');
    phase = 'postcheck_failed';
    const post = await read();
    const result = verifyWebTrafficReconciliationPost(post.service, post.native, plan);
    return {
      format: 1,
      kind: plan.kind,
      source: plan.source,
      reviewedPlanSha256: reconciliationDigest(plan),
      completedAt: new Date(now()).toISOString(),
      ...result,
    };
  } catch (error) {
    throw new TrafficReconciliationStop(
      safeReason(error, phase),
      attempted ? 'may_have_been_attempted' : 'not_attempted',
    );
  }
}
