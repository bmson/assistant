/** Fixed-service tag retirement planner. No provider calls or mutation authority. */
import { createHash } from 'node:crypto';
export const WEB_SERVICE = 'projects/bmson-assistant/locations/us-west1/services/assistant-web';
const IMAGE = 'us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export const tagHash = (value: string) => createHash('sha256').update(value).digest('hex');
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid retirement metadata');
  return value as ObjectValue;
};
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value))
    throw new Error('Invalid retirement identity');
  return value;
}
function revisionName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid revision');
  const short = value.startsWith(`${WEB_SERVICE}/revisions/`)
    ? value.slice(`${WEB_SERVICE}/revisions/`.length)
    : value;
  return text(short, /^assistant-web-[a-z0-9-]{1,63}$/);
}
function percentage(row: ObjectValue): number {
  if (row.percent === undefined) return 0; // Native proto3 implicit int32 default.
  if (
    typeof row.percent !== 'number' ||
    !Number.isInteger(row.percent) ||
    row.percent < 0 ||
    row.percent > 100
  )
    throw new Error('Invalid traffic percentage');
  return row.percent;
}
function rows(value: unknown): ObjectValue[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32)
    throw new Error('Invalid traffic rows');
  return value.map(object);
}
function trafficIdentity(row: ObjectValue, status: boolean) {
  if (
    Object.keys(row).some(
      (k) => !['type', 'revision', 'percent', 'tag', ...(status ? ['uri'] : [])].includes(k),
    )
  )
    throw new Error('Unknown traffic field');
  if (row.type !== 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION')
    throw new Error('Unresolved traffic allocation');
  return {
    type: row.type,
    revision: revisionName(row.revision),
    percent: percentage(row),
    tag: row.tag === undefined ? '' : text(row.tag, /^[a-z][a-z0-9-]{0,62}$/),
  };
}
function sameTraffic(a: ObjectValue[], b: ObjectValue[]) {
  return (
    JSON.stringify(a.map((x) => JSON.stringify(trafficIdentity(x, false))).sort()) ===
    JSON.stringify(b.map((x) => JSON.stringify(trafficIdentity(x, true))).sort())
  );
}
export interface OwnedWebTagProof {
  tag: string;
  revision: string;
  image: string;
  source: string;
  uriSha256: string;
  provenanceSha256: string;
  writesPaused: boolean;
}
/** Reviewed historical creation/log/manifest/current-observation correlation. */
export const HISTORICAL_WEB_TAGS: readonly OwnedWebTagProof[] = [
  {
    tag: 'resume-40350727924-1',
    revision: 'assistant-web-01080-hel',
    image: `${IMAGE}0b524e147007d64f63560e89eb2b2693c3161631a6d7afd8f9ae249b1c5121db`,
    source: 'acbd1744c94275d8e47481205271ca5daa131d23',
    uriSha256: '912a218179710bb5d95db9e60e7cd1a6de42a495d9615ea29b7db2f2c241cc71',
    provenanceSha256: '0fb66fad1b8e299b5cc6f942ddba9b4f1fa10c200ac21a79f53be267cc46d42d',
    writesPaused: false,
  },
  {
    tag: 'resume-40403696377-1',
    revision: 'assistant-web-01087-dup',
    image: `${IMAGE}6e8e1f2ba42ac11e846062bdaad1943bf4ce5a18cf07f16aa5b9f40f481c2dff`,
    source: '0c9a7ad7fc9c62b7ff166fe85bd023013ee88d43',
    uriSha256: '2a73a0f87b503cfef7ff38e39d513bbcc21dca53d91ca5970651f9c4ee191fa3',
    provenanceSha256: '0fb66fad1b8e299b5cc6f942ddba9b4f1fa10c200ac21a79f53be267cc46d42d',
    writesPaused: false,
  },
];
export function validateOwnedProof(raw: unknown): OwnedWebTagProof {
  const p = object(raw);
  if (typeof p.writesPaused !== 'boolean') throw new Error('Unknown proof pause state');
  return {
    tag: text(p.tag, /^(candidate|resume)-[0-9]{1,20}-[1-9][0-9]{0,5}$/),
    revision: revisionName(p.revision),
    image: text(
      p.image,
      /^us-west1-docker\.pkg\.dev\/bmson-assistant\/assistant\/web@sha256:[a-f0-9]{64}$/,
    ),
    source: text(p.source, /^[a-f0-9]{40}$/),
    uriSha256: text(p.uriSha256, /^[a-f0-9]{64}$/),
    provenanceSha256: text(p.provenanceSha256, /^[a-f0-9]{64}$/),
    writesPaused: p.writesPaused,
  };
}
export interface ExpectedCurrentWeb {
  revision: string;
  image: string;
  tag: string;
  uriSha256: string;
  paused: boolean;
}
export function immutableWebRevision(
  raw: unknown,
  expectedRevision: string,
  expectedImage: string,
  paused: boolean,
) {
  const r = object(raw);
  if (
    r.name !== `${WEB_SERVICE}/revisions/${revisionName(expectedRevision)}` ||
    !Array.isArray(r.containers) ||
    r.containers.length !== 1
  )
    throw new Error('Immutable revision identity mismatch');
  const c = object(r.containers[0]);
  if (c.image !== expectedImage || !Array.isArray(c.env))
    throw new Error('Immutable image mismatch');
  const pause = c.env.map(object).filter((e) => e.name === 'ASSISTANT_RELEASE_WRITES_PAUSED');
  if (
    pause.length !== 1 ||
    pause[0]?.value !== String(paused) ||
    pause[0]?.valueSource !== undefined
  )
    throw new Error('Immutable pause mismatch');
  const duration = text(r.timeout, /^[1-9][0-9]{0,2}s$/),
    seconds = Number(duration.slice(0, -1));
  if (seconds > 600) throw new Error('Legacy request timeout exceeds drain bound');
  return { image: expectedImage, timeoutSeconds: seconds };
}
function serviceState(raw: unknown) {
  const s = object(raw);
  if (
    s.name !== WEB_SERVICE ||
    (s.reconciling !== undefined && s.reconciling !== false) ||
    object(s.terminalCondition).state !== 'CONDITION_SUCCEEDED'
  )
    throw new Error('Service is not settled');
  const generation = text(s.generation, /^[0-9]+$/);
  if (s.observedGeneration !== generation) throw new Error('Service generation is not observed');
  const etag = text(s.etag, /^[ -~]{1,512}$/),
    uid = text(s.uid, /^[A-Za-z0-9-]{1,128}$/);
  const desired = rows(s.traffic),
    observed = rows(s.trafficStatuses);
  if (!sameTraffic(desired, observed)) throw new Error('Desired and observed traffic differ');
  const template = object(s.template);
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
  const configuration = Object.fromEntries(
    Object.entries(s)
      .filter(([k]) => !volatile.has(k))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    s,
    etag,
    uid,
    generation,
    desired,
    observed,
    template,
    templateSha256: digest(template),
    configurationSha256: digest(configuration),
  };
}
export interface RetirementPlan {
  format: 1;
  service: typeof WEB_SERVICE;
  etag: string;
  uid: string;
  generation: string;
  templateSha256: string;
  configurationSha256: string;
  current: ExpectedCurrentWeb;
  proofs: OwnedWebTagProof[];
  beforeTrafficSha256: string;
  beforeStatusSha256: string;
  patch: { name: typeof WEB_SERVICE; etag: string; traffic: ObjectValue[] } | null;
  drainSeconds: 600;
  action: 'retire_exact_tags' | 'already_absent';
}
/** Proofs must be resolved from reviewed historical pins or protected creation artifacts, never a regex alone. */
export function planOwnedWebTagRetirement(
  raw: unknown,
  nativeRevisions: Record<string, unknown>,
  approvedProofs: OwnedWebTagProof[],
  current: ExpectedCurrentWeb,
): RetirementPlan {
  const state = serviceState(raw),
    proofs = approvedProofs.map(validateOwnedProof);
  if (typeof current.paused !== 'boolean') throw new Error('Unknown current pause state');
  current = {
    revision: revisionName(current.revision),
    image: text(
      current.image,
      /^us-west1-docker\.pkg\.dev\/bmson-assistant\/assistant\/web@sha256:[a-f0-9]{64}$/,
    ),
    tag: text(current.tag, /^(candidate|resume)-[0-9]{1,20}-[1-9][0-9]{0,5}$/),
    uriSha256: text(current.uriSha256, /^[a-f0-9]{64}$/),
    paused: current.paused,
  };
  if (
    proofs.length < 1 ||
    proofs.length > 8 ||
    new Set(proofs.map((p) => p.tag)).size !== proofs.length
  )
    throw new Error('Invalid ownership proof set');
  const active = state.observed.filter((r) => percentage(r) > 0);
  if (
    active.length !== 1 ||
    percentage(active[0] ?? {}) !== 100 ||
    revisionName(active[0]?.revision) !== current.revision ||
    active[0]?.tag !== current.tag ||
    tagHash(text(active[0]?.uri, /^https:\/\/[^\s]{1,512}$/)) !== current.uriSha256
  )
    throw new Error('Current 100 identity changed');
  immutableWebRevision(
    nativeRevisions[current.revision],
    current.revision,
    current.image,
    current.paused,
  );
  if (
    !Array.isArray(state.template.containers) ||
    state.template.containers.length !== 1 ||
    object(state.template.containers[0]).image !== current.image ||
    state.template.serviceAccount !== object(nativeRevisions[current.revision]).serviceAccount
  )
    throw new Error('Current service template identity mismatch');
  const approvedTags = new Set(proofs.map((p) => p.tag));
  for (const row of state.observed) {
    const identity = trafficIdentity(row, true);
    if (identity.percent === 100) continue;
    if (!approvedTags.has(identity.tag))
      throw new Error('Unknown nonserving target must be preserved');
  }
  const remove = new Set<string>();
  for (const proof of proofs) {
    if (proof.revision === current.revision || proof.tag === current.tag)
      throw new Error('Cannot retire current serving identity');
    immutableWebRevision(
      nativeRevisions[proof.revision],
      proof.revision,
      proof.image,
      proof.writesPaused,
    );
    const observed = state.observed.filter((r) => r.tag === proof.tag),
      desired = state.desired.filter((r) => r.tag === proof.tag);
    if (observed.length === 0 && desired.length === 0) continue;
    if (
      observed.length !== 1 ||
      desired.length !== 1 ||
      percentage(observed[0] ?? {}) !== 0 ||
      revisionName(observed[0]?.revision) !== proof.revision ||
      tagHash(text(observed[0]?.uri, /^https:\/\/[^\s]{1,512}$/)) !== proof.uriSha256
    )
      throw new Error('Proven tag was reassigned or active');
    remove.add(proof.tag);
  }
  const traffic = state.desired.filter((r) => !remove.has(String(r.tag)));
  if (traffic.length !== 1 || trafficIdentity(traffic[0] ?? {}, false).percent !== 100)
    throw new Error('Retirement must preserve only exact current allocation');
  return {
    format: 1,
    service: WEB_SERVICE,
    etag: state.etag,
    uid: state.uid,
    generation: state.generation,
    templateSha256: state.templateSha256,
    configurationSha256: state.configurationSha256,
    current,
    proofs,
    beforeTrafficSha256: digest(state.desired),
    beforeStatusSha256: digest(state.observed),
    patch: remove.size ? { name: WEB_SERVICE, etag: state.etag, traffic } : null,
    drainSeconds: 600,
    action: remove.size ? 'retire_exact_tags' : 'already_absent',
  };
}
export function verifyOwnedWebTagRetirement(raw: unknown, plan: RetirementPlan) {
  const state = serviceState(raw);
  if (
    state.uid !== plan.uid ||
    state.templateSha256 !== plan.templateSha256 ||
    state.configurationSha256 !== plan.configurationSha256 ||
    state.observed.length !== 1 ||
    state.desired.length !== 1
  )
    throw new Error('Retirement post-state identity/config changed');
  const row = state.observed[0];
  if (
    !row ||
    row.tag !== plan.current.tag ||
    percentage(row) !== 100 ||
    revisionName(row.revision) !== plan.current.revision ||
    tagHash(text(row.uri, /^https:\/\/[^\s]{1,512}$/)) !== plan.current.uriSha256 ||
    plan.proofs.some((p) => state.observed.some((r) => r.tag === p.tag))
  )
    throw new Error('Retirement post-state traffic changed');
  if (plan.patch && digest(state.desired) !== digest(plan.patch.traffic))
    throw new Error('Retirement desired traffic changed');
  return {
    outcome: 'exact_tags_absent_current_unchanged' as const,
    service: WEB_SERVICE,
    currentRevision: plan.current.revision,
    templateSha256: state.templateSha256,
    trafficSha256: digest(state.desired),
    operationReadiness: 'drain_still_required' as const,
    editingAuthorized: false,
  };
}
export const retirementPlanHash = (plan: RetirementPlan) => digest(plan);
export interface RetirementIO {
  readService(): Promise<unknown>;
  readRevision(name: string): Promise<unknown>;
  patchTraffic(body: NonNullable<RetirementPlan['patch']>): Promise<unknown>;
  waitOperation(operation: unknown): Promise<void>;
  drain(seconds: 600): Promise<void>;
}
/** One CAS attempt only. An uncertain write, postcheck or drain never becomes admission. */
export async function executeOwnedWebTagRetirement(plan: RetirementPlan, io: RetirementIO) {
  const before = await io.readService(),
    native: Record<string, unknown> = {};
  for (const name of new Set([plan.current.revision, ...plan.proofs.map((p) => p.revision)]))
    native[name] = await io.readRevision(name);
  const fresh = planOwnedWebTagRetirement(before, native, plan.proofs, plan.current);
  if (retirementPlanHash(fresh) !== retirementPlanHash(plan))
    throw new Error('Retirement plan is stale; no write attempted');
  if (fresh.patch) await io.waitOperation(await io.patchTraffic(fresh.patch));
  const post = verifyOwnedWebTagRetirement(await io.readService(), fresh);
  // ALWAYS wait, including already-absent recovery after a prior runner failure.
  await io.drain(600);
  verifyOwnedWebTagRetirement(await io.readService(), fresh);
  return {
    ...post,
    action: fresh.action,
    planSha256: retirementPlanHash(fresh),
    drainSeconds: 600,
    drainCompleted: true,
    drainBasis: 'bounded_request_timeout_not_live_request_census',
    editingAuthorized: false,
  };
}
