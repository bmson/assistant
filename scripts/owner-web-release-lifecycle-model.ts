/** Pure source-only BASIC5 lifecycle. No IO, transport, credentials or production caller. */
import { operationName } from './owner-web-tag-native.js';
import { WEB_SERVICE } from './owner-web-tag-retirement.js';
import { reconciliationDigest as digest } from './owner-web-traffic-reconciliation-model.js';

type Obj = Record<string, unknown>;
export type Mode =
  | 'createP'
  | 'attachP'
  | 'promoteP'
  | 'createR'
  | 'attachR'
  | 'promoteR'
  | 'closeP'
  | 'restoreC'
  | 'repauseP'
  | 'closeR';
export type Row = {
  type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION';
  revision: string;
  tag: string;
  percent: number;
};
export type NativeProof = {
  uid: string;
  image: string;
  source: string;
  runId: string;
  attempt: string;
  manifest: string;
  paused: boolean;
  templateSha256: string;
};
export type Snapshot = {
  name: string;
  uid: string;
  etag: string;
  generation: string;
  observedGeneration: string;
  reconciling: boolean;
  succeeded: boolean;
  desired: Row[];
  observed: Row[];
  latestReady: string;
  latestCreated: string;
  template: Obj;
  stableConfigSha256: string;
  rootUriSha256: string;
  tagUris: Record<string, string>;
  urls: string[];
  revisions: Record<string, NativeProof>;
};
export type Context = {
  source: string;
  runId: string;
  attempt: string;
  manifest: string;
  image: string;
  canonical: string;
  releaseEnv: Record<string, string>;
  retiredTags: string[];
  currentBinding?: {
    proof: NativeProof;
    serviceSha256: string;
    revisionSha256: string;
    reviewedEvidenceSha256: string;
    preclosed: boolean;
  };
};
export type Phase =
  | 'captured'
  | 'createdP'
  | 'attachedP'
  | 'promotedP'
  | 'retired'
  | 'agentReady'
  | 'createdR'
  | 'attachedR'
  | 'promotedR'
  | 'complete'
  | 'restoredC'
  | 'repausedP'
  | 'closedR';
export type Plan = {
  mode: Mode;
  contextSha256: string;
  priorReceipt: string;
  beforeSha256: string;
  templateSha256: string;
  expectedTraffic: Row[];
  request: { method: 'PATCH'; updateMask: 'template' | 'traffic'; body: Obj };
};
export type State = {
  context: Context;
  phase: Phase;
  snapshot: Snapshot;
  receipt: string;
  previousReceipt: string | null;
  canonicalIdentity: Row;
  ordinal: number;
  retiredTags: string[];
  admissionPossible: boolean;
  retirementAttempt: { operation: string | null; outcome: 'attempted' | 'unknown' } | null;
  pending: null | { plan: Plan; operation: string | null; outcome: 'attempted' | 'unknown' };
};
function refuse(): never {
  throw new Error('Web lifecycle model held');
}
function assert(value: unknown): asserts value {
  if (!value) refuse();
}
function obj(v: unknown): Obj {
  assert(v && typeof v === 'object' && !Array.isArray(v));
  return v as Obj;
}
function hash(v: string) {
  assert(/^[a-f0-9]{64}$/.test(v));
}
function revision(v: string) {
  assert(/^assistant-web-[a-z0-9-]{1,49}$/.test(v));
}
function tag(v: string) {
  assert(/^(candidate|resume)-[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$/.test(v));
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
function equal(a: unknown, b: unknown) {
  return digest(a) === digest(b);
}
function rows(v: Row[]) {
  assert(Array.isArray(v) && v.length > 0 && v.length <= 8);
  const seen = new Set<string>(),
    tags = new Set<string>();
  for (const r of v) {
    assert(Object.keys(r).sort().join(',') === 'percent,revision,tag,type');
    revision(r.revision);
    if (r.tag) tag(r.tag);
    assert(r.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' && [0, 100].includes(r.percent));
    const key = `${r.revision}:${r.tag}`;
    assert(!seen.has(key) && (!r.tag || !tags.has(r.tag)));
    seen.add(key);
    if (r.tag) tags.add(r.tag);
  }
  assert(v.filter((r) => r.percent === 100).length === 1);
  return [...v].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export function releaseIdentity(c: Context, role: 'P' | 'R') {
  return {
    revision: `assistant-web-${role.toLowerCase()}-${c.runId}-${c.attempt}-${c.source.slice(0, 8)}`,
    tag: `${role === 'P' ? 'candidate' : 'resume'}-${c.runId}-${c.attempt}`,
  };
}
function validateSnapshot(s: Snapshot, tombstones: string[]) {
  assert(
    s.name === WEB_SERVICE && /^[A-Za-z0-9-]{1,128}$/.test(s.uid) && /^[ -~]{1,512}$/.test(s.etag),
  );
  assert(
    /^[1-9][0-9]{0,18}$/.test(s.generation) &&
      BigInt(s.generation) <= 9223372036854775807n &&
      s.observedGeneration === s.generation &&
      s.reconciling === false &&
      s.succeeded === true,
  );
  assert(equal(rows(s.desired), rows(s.observed)));
  revision(s.latestReady);
  revision(s.latestCreated);
  assert(s.latestReady === s.latestCreated);
  obj(s.template);
  hash(s.stableConfigSha256);
  hash(s.rootUriSha256);
  const liveTags = s.desired
    .map((r) => r.tag)
    .filter(Boolean)
    .sort();
  assert(
    equal(liveTags, Object.keys(s.tagUris).sort()) &&
      tombstones.every((t) => !liveTags.includes(t)),
  );
  for (const uri of Object.values(s.tagUris)) hash(uri);
  assert(
    s.urls.length === liveTags.length + 1 &&
      new Set(s.urls).size === s.urls.length &&
      s.urls.includes(s.rootUriSha256),
  );
  assert(equal([...s.urls].sort(), [s.rootUriSha256, ...Object.values(s.tagUris)].sort()));
  const native = Object.entries(s.revisions);
  assert(native.length > 0 && native.length <= 3);
  for (const [name, p] of native) {
    revision(name);
    hash(p.uid);
    hash(p.templateSha256);
    assert(/^.+@sha256:[a-f0-9]{64}$/.test(p.image));
  }
  assert(s.desired.every((r) => s.revisions[r.revision]));
}
const ENV = [
  'ASSISTANT_RELEASE_API_CONTRACT',
  'ASSISTANT_RELEASE_AGENT_API_MIN',
  'ASSISTANT_RELEASE_AGENT_API_MAX',
  'ASSISTANT_RELEASE_SCHEMA_DRIVER',
  'ASSISTANT_RELEASE_SCHEMA_MIN',
  'ASSISTANT_RELEASE_SCHEMA_MAX',
  'ASSISTANT_RELEASE_SCHEMA_VERSION',
  'ASSISTANT_RELEASE_MANIFEST',
  'ASSISTANT_RELEASE_WORKFLOW_RUN_ID',
  'ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT',
  'ASSISTANT_RELEASE_SOURCE_SHA',
];
function context(c: Context) {
  assert(
    /^[a-f0-9]{40}$/.test(c.source) &&
      /^[1-9][0-9]{0,19}$/.test(c.runId) &&
      /^[1-9][0-9]{0,5}$/.test(c.attempt),
  );
  hash(c.manifest);
  if (c.currentBinding) {
    hash(c.currentBinding.serviceSha256);
    hash(c.currentBinding.revisionSha256);
    hash(c.currentBinding.reviewedEvidenceSha256);
    hash(c.currentBinding.proof.uid);
    hash(c.currentBinding.proof.templateSha256);
    assert(
      typeof c.currentBinding.preclosed === 'boolean' &&
        /^[a-f0-9]{40}$/.test(c.currentBinding.proof.source),
    );
    assert(
      /^us-west1-docker\.pkg\.dev\/bmson-assistant\/assistant\/web@sha256:[a-f0-9]{64}$/.test(
        c.currentBinding.proof.image,
      ),
    );
  }

  revision(c.canonical);
  assert(
    /^us-west1-docker\.pkg\.dev\/bmson-assistant\/assistant\/web@sha256:[a-f0-9]{64}$/.test(
      c.image,
    ),
  );
  assert(equal(Object.keys(c.releaseEnv).sort(), [...ENV].sort()));
  for (const v of Object.values(c.releaseEnv))
    assert(typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v));
  assert(
    c.releaseEnv.ASSISTANT_RELEASE_MANIFEST === c.manifest &&
      c.releaseEnv.ASSISTANT_RELEASE_SOURCE_SHA === c.source &&
      c.releaseEnv.ASSISTANT_RELEASE_WORKFLOW_RUN_ID === c.runId &&
      c.releaseEnv.ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT === c.attempt &&
      c.releaseEnv.ASSISTANT_RELEASE_SCHEMA_DRIVER === 'firestore',
  );
  assert(new Set(c.retiredTags).size === c.retiredTags.length);
  c.retiredTags.forEach(tag);
  for (const role of ['P', 'R'] as const) {
    const id = releaseIdentity(c, role);
    revision(id.revision);
    tag(id.tag);
    assert(!c.retiredTags.includes(id.tag));
  }
}
/** Full template copy; only these exact paths may differ. Never expose template in receipts. */
export function creationTemplate(before: Obj, c: Context, role: 'P' | 'R') {
  context(c);
  const next = clone(before),
    containers = next.containers;
  assert(Array.isArray(containers) && containers.length === 1);
  const container = obj(containers[0]);
  assert(typeof container.image === 'string');
  const env = container.env;
  assert(Array.isArray(env) && env.length <= 256);
  const names = env.map((e) => obj(e).name);
  assert(names.every((n) => typeof n === 'string') && new Set(names).size === names.length);
  const changes: Record<string, string> = {
    ...c.releaseEnv,
    ASSISTANT_RELEASE_WRITES_PAUSED: String(role === 'P'),
  };
  container.env = env.filter((e) => !Object.hasOwn(changes, String(obj(e).name)));
  (container.env as Obj[]).push(
    ...Object.entries(changes)
      .sort()
      .map(([name, value]) => ({ name, value })),
  );
  container.image = c.image;
  next.revision = releaseIdentity(c, role).revision;
  // All other keys/values survive the complete copy, including secret references and side settings.
  return next;
}
function row(rev: string, alias: string, percent: number): Row {
  return { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: rev, tag: alias, percent };
}
export function captureLifecycle(c: Context, s: Snapshot): State {
  context(c);
  validateSnapshot(s, c.retiredTags);
  assert(
    s.desired.find((r) => r.percent === 100)?.revision === c.canonical &&
      !Object.hasOwn(s.revisions, releaseIdentity(c, 'P').revision) &&
      !Object.hasOwn(s.revisions, releaseIdentity(c, 'R').revision),
  );
  assert(s.desired.every((r) => r.revision === c.canonical));
  const state = {
    context: clone(c),
    phase: 'captured' as const,
    previousReceipt: null,
    canonicalIdentity: clone(s.desired.find((r) => r.percent === 100) as Row),
    snapshot: clone(s),
    ordinal: 0,
    retiredTags: [...c.retiredTags].sort(),
    admissionPossible: false,
    retirementAttempt: null,
    pending: null,
  };
  return { ...state, receipt: digest(state) };
}
/** Detects changes to a sealed projection. Durable origin/anti-replay remains an adapter requirement. */
export function verifyLifecycleState(s: State): void {
  const { receipt, ...body } = s;
  hash(receipt);
  assert(equal(digest(body), receipt));
  if (s.previousReceipt !== null) hash(s.previousReceipt);
}
function seal(s: State, changes: Partial<State>): State {
  verifyLifecycleState(s);
  const { receipt: _prior, ...body } = {
    ...clone(s),
    ...clone(changes),
    previousReceipt: s.receipt,
    ordinal: s.ordinal + 1,
  };
  return { ...body, receipt: digest(body) };
}
function allowed(s: State, mode: Mode) {
  assert(!s.pending && !s.retirementAttempt);
  const stage: Partial<Record<Mode, Phase>> = {
    createP: 'captured',
    attachP: 'createdP',
    promoteP: 'attachedP',
    createR: 'agentReady',
    attachR: 'createdR',
    promoteR: 'attachedR',
    closeP: 'promotedR',
    closeR: 'repausedP',
  };
  if (mode === 'restoreC')
    assert(!s.admissionPossible && ['promotedP', 'retired', 'agentReady'].includes(s.phase));
  else if (mode === 'repauseP') assert(s.admissionPossible && s.phase === 'promotedR');
  else assert(stage[mode] === s.phase);
}
export function planLifecycleAction(s: State, mode: Mode): Plan {
  verifyLifecycleState(s);
  context(s.context);
  assert(s.context.retiredTags.every((t) => s.retiredTags.includes(t)));
  validateSnapshot(s.snapshot, s.retiredTags);
  allowed(s, mode);
  const c = s.context,
    b = s.snapshot,
    p = releaseIdentity(c, 'P'),
    r = releaseIdentity(c, 'R');
  let traffic = clone(b.desired),
    template = b.template;
  if (mode === 'createP' || mode === 'createR') {
    const role = mode === 'createP' ? 'P' : 'R',
      id = releaseIdentity(c, role);
    assert(!b.revisions[id.revision] && !traffic.some((t) => t.tag === id.tag));
    template = creationTemplate(b.template, c, role);
  } else if (mode === 'attachP' || mode === 'attachR') {
    const id = mode === 'attachP' ? p : r;
    assert(b.revisions[id.revision] && !traffic.some((t) => t.tag === id.tag));
    traffic.push(row(id.revision, id.tag, 0));
  } else if (mode === 'closeP' || mode === 'closeR') {
    const id = mode === 'closeP' ? p : r;
    assert(traffic.some((t) => t.tag === id.tag && t.revision === id.revision && t.percent === 0));
    traffic = traffic.filter((t) => t.tag !== id.tag);
  } else {
    const rev = mode === 'restoreC' ? c.canonical : mode === 'promoteR' ? r.revision : p.revision;
    const canonicalTag = s.canonicalIdentity.tag;
    let target = traffic.find(
      (t) =>
        t.revision === rev &&
        (mode === 'restoreC'
          ? t.tag === canonicalTag && !s.retiredTags.includes(t.tag)
          : t.tag === (mode === 'promoteR' ? r.tag : p.tag)),
    );
    if (!target) {
      assert(mode === 'restoreC');
      target = row(rev, '', 0);
      traffic.push(target);
    }
    traffic = traffic
      .filter((t) => t.tag || t.revision === rev)
      .map((t) => ({
        ...t,
        percent: t.revision === target.revision && t.tag === target.tag ? 100 : 0,
      }));
  }
  assert(traffic.every((t) => !s.retiredTags.includes(t.tag)));
  const create = mode === 'createP' || mode === 'createR';
  return {
    mode,
    contextSha256: digest(c),
    priorReceipt: s.receipt,
    beforeSha256: digest(b),
    templateSha256: digest(template),
    expectedTraffic: rows(traffic),
    request: {
      method: 'PATCH',
      updateMask: create ? 'template' : 'traffic',
      body: {
        name: WEB_SERVICE,
        etag: b.etag,
        ...(create ? { template: clone(template) } : { traffic: rows(traffic) }),
      },
    },
  };
}
/** Must be durably recorded by a future caller BEFORE it sends the single PATCH. */
export function beginLifecycleAttempt(s: State, p: Plan): State {
  assert(equal(planLifecycleAction(s, p.mode), p));
  const retired = [...s.retiredTags];
  if (p.mode === 'closeP' || p.mode === 'closeR')
    retired.push(releaseIdentity(s.context, p.mode === 'closeP' ? 'P' : 'R').tag);
  return seal(s, {
    retiredTags: [...new Set(retired)].sort(),
    admissionPossible: s.admissionPossible || p.mode === 'createR',
    pending: { plan: clone(p), operation: null, outcome: 'attempted' },
  });
}
export function bindLifecycleOperation(s: State, name: string): State {
  verifyLifecycleState(s);
  assert(s.pending && !s.pending.operation && s.pending.outcome === 'attempted');
  operationName({ name });
  return seal(s, { pending: { ...clone(s.pending), operation: name } });
}
export function unknownLifecycleOutcome(s: State): State {
  verifyLifecycleState(s);
  assert(s.pending);
  return seal(s, { pending: { ...clone(s.pending), outcome: 'unknown' } });
}
function advance(s: State, phase: Phase, after: Snapshot, retired = s.retiredTags): State {
  return seal(s, {
    phase,
    snapshot: clone(after),
    retiredTags: [...retired].sort(),
    pending: null,
    retirementAttempt: null,
  });
}
function changed(before: Snapshot, after: Snapshot, tombstones: string[]) {
  validateSnapshot(after, tombstones);
  assert(
    before.uid === after.uid &&
      before.etag !== after.etag &&
      BigInt(after.generation) > BigInt(before.generation) &&
      before.stableConfigSha256 === after.stableConfigSha256 &&
      before.rootUriSha256 === after.rootUriSha256,
  );
  for (const [rev, proof] of Object.entries(before.revisions))
    assert(equal(after.revisions[rev], proof));
}
/** Same fixed operation only; unknown without a bound operation cannot be adopted or retried. */
export function settleLifecycleAttempt(
  s: State,
  completion: { name: string; done: boolean; error?: unknown; responseService: string },
  after: Snapshot,
): State {
  assert(
    completion.done === true &&
      completion.error === undefined &&
      completion.responseService === WEB_SERVICE,
  );
  const operation = completion.name;
  verifyLifecycleState(s);
  const pending = s.pending;
  assert(pending && pending.operation === operation);
  operationName({ name: operation });
  const p = pending.plan,
    b = s.snapshot,
    c = s.context;
  changed(b, after, s.retiredTags);
  assert(
    equal(rows(after.desired), p.expectedTraffic) && digest(after.template) === p.templateSha256,
  );
  const create = p.mode === 'createP' || p.mode === 'createR';
  if (create) {
    const role = p.mode === 'createP' ? 'P' : 'R',
      id = releaseIdentity(c, role),
      proof = after.revisions[id.revision];
    assert(
      proof &&
        !Object.values(b.revisions).some((prior) => prior.uid === proof.uid) &&
        after.latestReady === id.revision &&
        after.latestCreated === id.revision &&
        proof.image === c.image &&
        proof.source === c.source &&
        proof.runId === c.runId &&
        proof.attempt === c.attempt &&
        proof.manifest === c.manifest &&
        proof.paused === (role === 'P') &&
        proof.templateSha256 === p.templateSha256,
    );
    assert(
      Object.keys(after.revisions).length === Object.keys(b.revisions).length + 1 &&
        equal(after.tagUris, b.tagUris) &&
        equal([...after.urls].sort(), [...b.urls].sort()),
    );
  } else {
    assert(
      after.latestReady === b.latestReady &&
        after.latestCreated === b.latestCreated &&
        equal(after.revisions, b.revisions),
    );
    for (const [alias, uri] of Object.entries(b.tagUris))
      if (after.tagUris[alias]) assert(after.tagUris[alias] === uri);
  }
  const phase: Record<Mode, Phase> = {
    createP: 'createdP',
    attachP: 'attachedP',
    promoteP: 'promotedP',
    createR: 'createdR',
    attachR: 'attachedR',
    promoteR: 'promotedR',
    closeP: 'complete',
    restoreC: 'restoredC',
    repauseP: 'repausedP',
    closeR: 'closedR',
  };
  const retired = [...s.retiredTags];
  if (p.mode === 'closeP' || p.mode === 'closeR')
    retired.push(releaseIdentity(c, p.mode === 'closeP' ? 'P' : 'R').tag);
  return advance(s, phase[p.mode], after, [...new Set(retired)]);
}
/** Durable intent for the existing retirement executor; conservatively tombstone all possible removals. */
export function beginCapturedRetirement(s: State): State {
  verifyLifecycleState(s);
  assert(!s.pending && !s.retirementAttempt && s.phase === 'promotedP' && !s.admissionPossible);
  const keep = releaseIdentity(s.context, 'P').tag;
  return seal(s, {
    retiredTags: [
      ...new Set([
        ...s.retiredTags,
        ...s.snapshot.desired.map((r) => r.tag).filter((t) => t && t !== keep),
      ]),
    ].sort(),
    retirementAttempt: { operation: null, outcome: 'attempted' },
  });
}
export function bindCapturedRetirementOperation(s: State, name: string): State {
  verifyLifecycleState(s);
  assert(
    s.retirementAttempt &&
      !s.retirementAttempt.operation &&
      s.retirementAttempt.outcome === 'attempted',
  );
  operationName({ name });
  return seal(s, { retirementAttempt: { ...clone(s.retirementAttempt), operation: name } });
}
export function unknownCapturedRetirement(s: State): State {
  verifyLifecycleState(s);
  assert(s.retirementAttempt);
  return seal(s, { retirementAttempt: { ...clone(s.retirementAttempt), outcome: 'unknown' } });
}
/** Consumes supplied existing retirement evidence; does not replace its planner/executor/drain. */
export function acceptCapturedRetirement(
  s: State,
  after: Snapshot,
  evidence: {
    source: string;
    runId: string;
    attempt: string;
    manifest: string;
    beforeReceipt: string;
    serviceUid: string;
    etag: string;
    generation: string;
    drainSeconds: number;
    drainCompleted: boolean;
    operation: string;
  },
): State {
  verifyLifecycleState(s);
  assert(
    !s.pending &&
      s.phase === 'promotedP' &&
      !s.admissionPossible &&
      s.retirementAttempt?.operation &&
      evidence.operation === s.retirementAttempt.operation,
  );
  const c = s.context,
    p = releaseIdentity(c, 'P');
  assert(
    evidence.source === c.source &&
      evidence.runId === c.runId &&
      evidence.attempt === c.attempt &&
      evidence.manifest === c.manifest &&
      evidence.beforeReceipt === s.receipt &&
      evidence.serviceUid === after.uid &&
      evidence.etag === after.etag &&
      evidence.generation === after.generation &&
      evidence.drainSeconds === 600 &&
      evidence.drainCompleted,
  );
  const removed = s.snapshot.desired.map((t) => t.tag).filter((t) => t && t !== p.tag),
    retired = [...new Set([...s.retiredTags, ...removed])];
  changed(s.snapshot, after, retired);
  assert(
    equal(rows(after.desired), [row(p.revision, p.tag, 100)]) &&
      equal(after.template, s.snapshot.template) &&
      after.latestReady === s.snapshot.latestReady &&
      equal(after.revisions, s.snapshot.revisions) &&
      after.tagUris[p.tag] === s.snapshot.tagUris[p.tag],
  );
  return advance(s, 'retired', after, retired);
}
/** Existing agent/readiness and immediate retirement stability proofs remain external prerequisites. */
export function acceptAgentReady(
  s: State,
  evidence: {
    beforeReceipt: string;
    agentProofSha256: string;
    stableEtag: string;
    stableGeneration: string;
  },
): State {
  verifyLifecycleState(s);
  assert(
    !s.pending &&
      s.phase === 'retired' &&
      evidence.beforeReceipt === s.receipt &&
      evidence.stableEtag === s.snapshot.etag &&
      evidence.stableGeneration === s.snapshot.generation,
  );
  hash(evidence.agentProofSha256);
  return advance(s, 'agentReady', s.snapshot);
}
/** Already paused is a read-only recovery checkpoint, not a redundant mutation. */
export function acceptAlreadyPausedRecovery(s: State, fresh: Snapshot): State {
  verifyLifecycleState(s);
  assert(!s.pending && s.admissionPossible && ['createdR', 'attachedR'].includes(s.phase));
  validateSnapshot(fresh, s.retiredTags);
  assert(equal(fresh, s.snapshot));
  const p = releaseIdentity(s.context, 'P');
  assert(
    fresh.desired.some((t) => t.revision === p.revision && t.tag === p.tag && t.percent === 100),
  );
  return advance(s, 'repausedP', fresh);
}
/** No alias was attached: supplied existing drain proof closes recovery without inventing/removing one. */
export function acceptUnattachedRDrain(
  s: State,
  evidence: {
    beforeReceipt: string;
    revision: string;
    drainSeconds: number;
    drainCompleted: boolean;
  },
): State {
  const r = releaseIdentity(s.context, 'R');
  assert(
    !s.pending &&
      s.phase === 'repausedP' &&
      s.admissionPossible &&
      evidence.beforeReceipt === s.receipt &&
      evidence.revision === r.revision &&
      evidence.drainSeconds === 600 &&
      evidence.drainCompleted &&
      s.snapshot.revisions[r.revision] &&
      !s.snapshot.desired.some((t) => t.tag === r.tag),
  );
  return advance(s, 'closedR', s.snapshot);
}

/** Pre-initialization aliases were closed and settled before capture, under a reviewed evidence binding. */
export function acceptPreclosedBootstrap(s: State, fresh: Snapshot): State {
  verifyLifecycleState(s);
  assert(
    s.context.currentBinding?.preclosed &&
      /^[a-f0-9]{64}$/.test(s.context.currentBinding.reviewedEvidenceSha256),
  );
  assert(s.phase === 'promotedP' && !s.pending && !s.admissionPossible && !s.retirementAttempt);
  assert(equal(fresh, s.snapshot));
  const p = releaseIdentity(s.context, 'P');
  assert(equal(rows(fresh.desired), [row(p.revision, p.tag, 100)]));
  assert(Object.keys(fresh.tagUris).length === 1 && fresh.tagUris[p.tag]);
  return advance(s, 'retired', fresh);
}
