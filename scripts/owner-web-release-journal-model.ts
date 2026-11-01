/** Offline journal/fence simulation ONLY. No token, signature verification, transport or runtime authority. */

import { planLifecycleAction, verifyLifecycleState } from './owner-web-release-lifecycle-model.js';
import { projectNativeWebSnapshot } from './owner-web-release-native-proof.js';
import { WEB_SERVICE } from './owner-web-tag-retirement.js';
import {
  reconciliationDigest as digest,
  planWebTrafficReconciliation,
  verifyWebTrafficReconciliationPost,
} from './owner-web-traffic-reconciliation-model.js';

type Obj = Record<string, unknown>;
export const JOURNAL_KEY = 'assistant.release/journal-v1';
export type Origin = {
  source: string;
  runId: string;
  attempt: '1';
  jobId: string;
  checkRunId: string;
  repositoryId: '1304152266';
  ownerId: '890821';
};
export type IntentKind =
  | 'reconcileKnown'
  | 'createP'
  | 'attachP'
  | 'promoteP'
  | 'retireCaptured'
  | 'createR'
  | 'attachR'
  | 'promoteR'
  | 'closeP'
  | 'restoreC'
  | 'repauseP'
  | 'closeR';
export type Head = {
  version: 1;
  genesis: string;
  serviceUid: string;
  sequence: number;
  parent: string | null;
  previousArchive: { id: number; digest: string } | null;
  owner: Origin;
  status: 'idle' | 'prepared' | 'complete';
  intent: { kind: IntentKind; logicalDigest: string } | null;
  admissionPossible: boolean;
  retiredTags: string[];
};
export type Anchor = { genesis: string; serviceUid: string; genesisDigest: string };
export type HistoryEvent = {
  head: Head;
  postEtag: string;
  postGeneration: string;
  postDigest: string;
  archive: {
    id: number;
    name: string;
    digest: string;
    memberDigest: string;
    expired: boolean;
    expiresAt: string;
    source: string;
    runId: string;
    attempt: string;
    jobId: string;
    checkRunId: string;
  };
};
export type JournalSimulation = {
  simulationOnly: true;
  mutationAuthorized: false;
  origin: Origin;
  anchor: Anchor;
  raw: Obj;
  history: HistoryEvent[];
  head: Head;
  pending: null | {
    plan: MetadataPlan;
    outcome: 'attempted' | 'unknown';
    operation: string | null;
  };
  preparedBefore: Obj | null;
  action: null | {
    intentDigest: string;
    outcome: 'prepared' | 'attempted' | 'unknown' | 'confirmed';
    operation: string | null;
  };
  drain: null | {
    etag: string;
    generation: string;
    startedAt: number;
    completedAt: number | null;
    verifiedAt: number | null;
  };
  seal: string;
};
export type MetadataPlan = {
  simulationOnly: true;
  mutationAuthorized: false;
  origin: Origin;
  purpose: 'prepare' | 'complete' | 'claim' | 'consumeBarrier';
  beforeDigest: string;
  beforeHeadDigest: string;
  next: Head;
  request: {
    method: 'PATCH';
    updateMask: 'annotations';
    body: { name: typeof WEB_SERVICE; etag: string; annotations: Record<string, string> };
  };
};
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function hold(): never {
  throw new Error('Offline web journal held');
}
function check(v: unknown): asserts v {
  if (!v) hold();
}
function object(v: unknown): Obj {
  check(v && typeof v === 'object' && !Array.isArray(v));
  return v as Obj;
}
function text(v: unknown, re: RegExp): string {
  check(typeof v === 'string' && re.test(v));
  return v;
}
function hash(v: unknown) {
  return text(v, /^[a-f0-9]{64}$/);
}
function equal(a: unknown, b: unknown) {
  return digest(a) === digest(b);
}
function ordinal(v: unknown) {
  check(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 64);
  return v;
}
function generation(v: unknown) {
  const n = text(v, /^[1-9][0-9]{0,18}$/);
  check(BigInt(n) <= 9223372036854775807n);
  return n;
}
function origin(o: Origin) {
  check(
    Object.keys(o).sort().join(',') ===
      'attempt,checkRunId,jobId,ownerId,repositoryId,runId,source',
  );
  text(o.source, /^[a-f0-9]{40}$/);
  text(o.runId, /^[1-9][0-9]{0,19}$/);
  text(o.jobId, /^[1-9][0-9]{0,19}$/);
  text(o.checkRunId, /^[1-9][0-9]{0,19}$/);
  check(o.attempt === '1' && o.repositoryId === '1304152266' && o.ownerId === '890821');
}
/** Inputs model already signature-verified claims and authenticated API responses; it does NOT verify either origin. */
export function simulateOriginBinding(claims: Obj, run: Obj, job: Obj, now: number): Origin {
  check(Number.isFinite(now));
  const c = claims,
    source = text(c.sha, /^[a-f0-9]{40}$/),
    runId = text(c.run_id, /^[1-9][0-9]{0,19}$/),
    checkRunId = text(c.check_run_id, /^[1-9][0-9]{0,19}$/),
    jobId = String(job.id);
  check(
    c.iss === 'https://token.actions.githubusercontent.com' &&
      c.aud === 'assistant-web-journal-v1' &&
      c.repository === 'bmson/assistant' &&
      c.repository_id === '1304152266' &&
      c.repository_owner_id === '890821' &&
      c.ref === 'refs/heads/main' &&
      c.environment === 'production' &&
      c.workflow_ref === 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main' &&
      c.workflow_sha === source &&
      c.run_attempt === '1' &&
      ['workflow_dispatch', 'workflow_run'].includes(String(c.event_name)),
  );
  check(
    typeof c.exp === 'number' &&
      typeof c.nbf === 'number' &&
      typeof c.iat === 'number' &&
      c.nbf * 1000 <= now &&
      c.iat * 1000 <= now &&
      c.exp * 1000 > now &&
      c.exp - c.iat <= 600,
  );
  check(
    String(run.id) === runId &&
      run.run_attempt === 1 &&
      run.head_sha === source &&
      run.path === '.github/workflows/deploy.yml' &&
      run.status === 'in_progress' &&
      object(run.repository).id === 1304152266 &&
      object(run.head_repository).id === 1304152266,
  );
  check(
    String(job.run_id) === runId &&
      job.head_sha === source &&
      job.status === 'in_progress' &&
      job.url === `https://api.github.com/repos/bmson/assistant/actions/jobs/${jobId}` &&
      job.check_run_url === `https://api.github.com/repos/bmson/assistant/check-runs/${checkRunId}`,
  );
  const result = {
    source,
    runId,
    attempt: '1' as const,
    jobId,
    checkRunId,
    repositoryId: '1304152266' as const,
    ownerId: '890821' as const,
  };
  origin(result);
  return result;
}
function annotations(raw: Obj): Record<string, string> {
  const a = raw.annotations === undefined ? {} : object(raw.annotations);
  let size = 0;
  for (const [k, v] of Object.entries(a)) {
    check(typeof v === 'string');
    size += Buffer.byteLength(k) + Buffer.byteLength(v);
  }
  check(size <= 65536);
  return a as Record<string, string>;
}
function settled(raw: Obj, uid: string) {
  check(
    raw.name === WEB_SERVICE &&
      raw.uid === uid &&
      (raw.reconciling === undefined || raw.reconciling === false) &&
      object(raw.terminalCondition).state === 'CONDITION_SUCCEEDED' &&
      generation(raw.generation) === raw.observedGeneration,
  );
  text(raw.etag, /^[ -~]{1,512}$/);
  annotations(raw);
}
function validateHead(h: Head) {
  check(
    Object.keys(h).sort().join(',') ===
      'admissionPossible,genesis,intent,owner,parent,previousArchive,retiredTags,sequence,serviceUid,status,version',
  );
  check(h.version === 1 && typeof h.admissionPossible === 'boolean');
  hash(h.genesis);
  text(h.serviceUid, /^[A-Za-z0-9-]{1,128}$/);
  ordinal(h.sequence);
  if (h.parent !== null) hash(h.parent);
  if (h.previousArchive !== null) {
    check(Object.keys(h.previousArchive).sort().join(',') === 'digest,id');
    check(Number.isSafeInteger(h.previousArchive.id) && h.previousArchive.id > 0);
    hash(h.previousArchive.digest);
  }
  origin(h.owner);
  check(
    ['idle', 'prepared', 'complete'].includes(h.status) &&
      Array.isArray(h.retiredTags) &&
      h.retiredTags.length <= 64 &&
      new Set(h.retiredTags).size === h.retiredTags.length,
  );
  h.retiredTags.forEach((t) => {
    text(t, /^(candidate|resume)-[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$/);
  });
  if (h.intent) {
    check(Object.keys(h.intent).sort().join(',') === 'kind,logicalDigest');
    check(
      [
        'reconcileKnown',
        'createP',
        'attachP',
        'promoteP',
        'retireCaptured',
        'createR',
        'attachR',
        'promoteR',
        'closeP',
        'restoreC',
        'repauseP',
        'closeR',
      ].includes(h.intent.kind),
    );
    hash(h.intent.logicalDigest);
  }
  check(h.status !== 'prepared' || h.intent !== null);
  check(h.status !== 'idle' || h.intent === null);
  check(Buffer.byteLength(JSON.stringify(h)) <= 8192);
}
function head(raw: Obj): Head {
  try {
    const h = JSON.parse(text(annotations(raw)[JOURNAL_KEY], /^[\s\S]{1,8192}$/)) as Head;
    validateHead(h);
    return h;
  } catch {
    return hold();
  }
}
const VOLATILE = new Set([
  'etag',
  'generation',
  'observedGeneration',
  'updateTime',
  'lastModifier',
  'terminalCondition',
  'conditions',
  'reconciling',
]);
/** Excludes only the one owned key. All unowned annotations/config/traffic/latest identities stay frozen. */
export function journalPreservedDigest(raw: Obj) {
  const a = { ...annotations(raw) };
  delete a[JOURNAL_KEY];
  return digest({
    ...Object.fromEntries(Object.entries(raw).filter(([k]) => !VOLATILE.has(k))),
    annotations: a,
  });
}
function seal(s: Omit<JournalSimulation, 'seal'>): JournalSimulation {
  const { seal: _old, ...body } = s as JournalSimulation;
  return { ...body, seal: digest(body) };
}
function verify(s: JournalSimulation) {
  const { seal: value, ...body } = s;
  check(s.simulationOnly === true && s.mutationAuthorized === false && digest(body) === value);
  origin(s.origin);
  validateHead(s.head);
  check(equal(head(s.raw), s.head));
}
export function validateSimulatedHistory(
  raw: Obj,
  anchor: Anchor,
  events: HistoryEvent[],
  now: number,
) {
  settled(raw, anchor.serviceUid);
  const h = head(raw);
  check(
    h.genesis === anchor.genesis &&
      h.serviceUid === anchor.serviceUid &&
      events.length > 0 &&
      events.length <= 65 &&
      events.length === h.sequence + 1,
  );
  let previous: Head | undefined;
  const ids = new Set<number>();
  events.forEach((e, i) => {
    validateHead(e.head);
    const a = e.archive;
    check(
      e.head.sequence === i &&
        e.head.genesis === anchor.genesis &&
        e.head.serviceUid === anchor.serviceUid &&
        e.head.parent === (previous ? digest(previous) : null),
    );
    check(
      Number.isSafeInteger(a.id) &&
        a.id > 0 &&
        !ids.has(a.id) &&
        a.expired === false &&
        Number.isFinite(Date.parse(a.expiresAt)) &&
        Date.parse(a.expiresAt) > now,
    );
    ids.add(a.id);
    hash(a.digest);
    check(
      a.memberDigest ===
        digest({
          head: e.head,
          postEtag: e.postEtag,
          postGeneration: e.postGeneration,
          postDigest: e.postDigest,
        }) &&
        a.name ===
          `web-journal-${e.head.genesis.slice(0, 12)}-${e.head.owner.source}-${e.head.owner.runId}-1-${i}` &&
        a.source === e.head.owner.source &&
        a.runId === e.head.owner.runId &&
        a.attempt === '1' &&
        a.jobId === e.head.owner.jobId &&
        a.checkRunId === e.head.owner.checkRunId,
    );
    text(e.postEtag, /^[ -~]{1,512}$/);
    generation(e.postGeneration);
    hash(e.postDigest);
    if (previous) {
      const priorArchive = events[i - 1]?.archive;
      check(
        priorArchive &&
          equal(e.head.previousArchive, { id: priorArchive.id, digest: priorArchive.digest }),
      );
      check(previous.retiredTags.every((t) => e.head.retiredTags.includes(t)));
      if (equal(previous.owner, e.head.owner))
        check(!previous.admissionPossible || e.head.admissionPossible);
      else
        check(
          (previous.status === 'complete' ||
            (previous.sequence === 0 && previous.status === 'idle')) &&
            e.head.status === 'idle' &&
            !e.head.admissionPossible,
        );
    } else
      check(
        digest(e.head) === anchor.genesisDigest &&
          e.head.sequence === 0 &&
          e.head.previousArchive === null,
      );
    previous = e.head;
  });
  check(equal(previous, h));
  const last = events.at(-1);
  check(
    last &&
      last.postEtag === raw.etag &&
      last.postGeneration === raw.generation &&
      last.postDigest === digest(raw),
  );
  return copy(h);
}
export function enrollJournalSimulation(
  raw: Obj,
  anchor: Anchor,
  events: HistoryEvent[],
  owner: Origin,
  now: number,
): JournalSimulation {
  origin(owner);
  const h = validateSimulatedHistory(raw, anchor, events, now);
  check(equal(h.owner, owner));
  return seal({
    simulationOnly: true,
    mutationAuthorized: false,
    origin: copy(owner),
    anchor: copy(anchor),
    raw: copy(raw),
    history: copy(events),
    head: h,
    pending: null,
    preparedBefore: null,
    action: null,
    drain: null,
  });
}
/** Genesis is a separate proposal. The anchor/quiescence/origin proof is NOT supplied by this simulation. */
export function simulateGenesis(
  raw: Obj,
  owner: Origin,
  genesis: string,
): {
  head: Head;
  anchor: Anchor;
  request: MetadataPlan['request'];
  simulationOnly: true;
  mutationAuthorized: false;
} {
  origin(owner);
  hash(genesis);
  settled(raw, text(raw.uid, /^[A-Za-z0-9-]{1,128}$/));
  check(!Object.hasOwn(annotations(raw), JOURNAL_KEY));
  const h: Head = {
    version: 1,
    genesis,
    serviceUid: raw.uid as string,
    sequence: 0,
    parent: null,
    previousArchive: null,
    owner: copy(owner),
    status: 'idle',
    intent: null,
    admissionPossible: false,
    retiredTags: [],
  };
  validateHead(h);
  const a = { ...annotations(raw), [JOURNAL_KEY]: JSON.stringify(h) };
  check(
    Object.entries(a).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0) <=
      65536,
  );
  return {
    head: h,
    anchor: { genesis, serviceUid: h.serviceUid, genesisDigest: digest(h) },
    request: {
      method: 'PATCH',
      updateMask: 'annotations',
      body: { name: WEB_SERVICE, etag: raw.etag as string, annotations: a },
    },
    simulationOnly: true,
    mutationAuthorized: false,
  };
}
export function prepareJournalSimulation(
  s: JournalSimulation,
  kind: IntentKind,
  logicalDigest: string,
  addTombstones: string[] = [],
): MetadataPlan {
  verify(s);
  hash(logicalDigest);
  check(!s.pending && !s.action && !s.drain && s.head.status !== 'prepared' && kind !== 'createR');
  const retired = [...new Set([...s.head.retiredTags, ...addTombstones])].sort();
  const prior = s.history.at(-1);
  check(prior);
  const next: Head = {
    ...copy(s.head),
    sequence: ordinal(s.head.sequence + 1),
    parent: digest(s.head),
    previousArchive: { id: prior.archive.id, digest: prior.archive.digest },
    status: 'prepared',
    intent: { kind, logicalDigest },
    admissionPossible: s.head.admissionPossible,
    retiredTags: retired,
  };
  validateHead(next);
  annotations({ annotations: { ...annotations(s.raw), [JOURNAL_KEY]: JSON.stringify(next) } });
  return {
    simulationOnly: true,
    mutationAuthorized: false,
    origin: copy(s.origin),
    purpose: 'prepare',
    beforeDigest: digest(s.raw),
    beforeHeadDigest: digest(s.head),
    next,
    request: {
      method: 'PATCH',
      updateMask: 'annotations',
      body: {
        name: WEB_SERVICE,
        etag: s.raw.etag as string,
        annotations: { ...annotations(s.raw), [JOURNAL_KEY]: JSON.stringify(next) },
      },
    },
  };
}
export function beginJournalPrepare(s: JournalSimulation, p: MetadataPlan): JournalSimulation {
  verify(s);
  check(
    !s.pending &&
      p.beforeDigest === digest(s.raw) &&
      p.beforeHeadDigest === digest(s.head) &&
      p.next.parent === digest(s.head) &&
      p.request.body.etag === s.raw.etag &&
      p.request.method === 'PATCH' &&
      p.request.updateMask === 'annotations' &&
      p.request.body.name === WEB_SERVICE,
  );
  let expected: MetadataPlan;
  if (p.purpose === 'prepare')
    expected = prepareJournalSimulation(
      s,
      p.next.intent?.kind as IntentKind,
      p.next.intent?.logicalDigest ?? '',
      p.next.retiredTags,
    );
  else if (p.purpose === 'complete') expected = planJournalCompletion(s);
  else {
    check(p.purpose === 'claim' || p.purpose === 'consumeBarrier');
    // These plans must be begun using the specialized constructors below, which recheck their fresh evidence.
    return hold();
  }
  check(equal(expected, p));
  return seal({ ...copy(s), pending: { plan: copy(p), outcome: 'attempted', operation: null } });
}
export function bindJournalPrepareOperation(s: JournalSimulation, name: string): JournalSimulation {
  verify(s);
  check(s.pending?.outcome === 'attempted' && !s.pending.operation);
  operation(name);
  return seal({ ...copy(s), pending: { ...copy(s.pending), operation: name } });
}
export function unknownJournalPrepare(s: JournalSimulation): JournalSimulation {
  verify(s);
  check(s.pending);
  return seal({ ...copy(s), pending: { ...copy(s.pending), outcome: 'unknown' } });
}
/** Same observed journal result only; no retry. Metadata generation qualification is an explicit external blocker. */
export function confirmJournalPrepare(
  s: JournalSimulation,
  after: Obj,
  event: HistoryEvent,
  now: number,
  completion: { name: string; done: boolean; error?: unknown; responseService: string },
): JournalSimulation {
  verify(s);
  const p = s.pending?.plan;
  check(
    p &&
      s.pending?.operation === completion.name &&
      completion.done === true &&
      completion.error === undefined &&
      completion.responseService === WEB_SERVICE,
  );
  operation(completion.name);
  settled(after, s.anchor.serviceUid);
  check(
    after.etag !== s.raw.etag &&
      BigInt(after.generation as string) >= BigInt(s.raw.generation as string) &&
      journalPreservedDigest(after) === journalPreservedDigest(s.raw) &&
      equal(head(after), p.next),
  );
  check(
    equal(event.head, p.next) &&
      event.postEtag === after.etag &&
      event.postGeneration === after.generation,
  );
  const history = [...s.history, copy(event)];
  validateSimulatedHistory(after, s.anchor, history, now);
  return seal({
    ...copy(s),
    raw: copy(after),
    head: copy(p.next),
    history,
    pending: null,
    preparedBefore: copy(s.raw),
    origin: copy(p.origin),
    drain: p.purpose === 'consumeBarrier' ? null : s.drain,
    action:
      p.next.status === 'prepared'
        ? { intentDigest: hash(p.next.intent?.logicalDigest), outcome: 'prepared', operation: null }
        : null,
  });
}
/** Fresh-etag theft is refused: the complete head, fixed owner and exact prepared etag must all match. */
function beginAction(
  s: JournalSimulation,
  remote: Obj,
  nonEtagRequest: Obj,
  known = false,
): JournalSimulation {
  verify(s);
  check(
    (known || s.head.intent?.kind !== 'reconcileKnown') &&
      !s.pending &&
      s.action?.outcome === 'prepared' &&
      !s.drain &&
      equal(head(remote), s.head) &&
      equal(s.head.owner, s.origin) &&
      remote.etag === s.raw.etag &&
      digest(remote) === digest(s.raw) &&
      digest(nonEtagRequest) === s.action.intentDigest,
  );
  return seal({ ...copy(s), action: { ...copy(s.action), outcome: 'attempted' } });
}
export function unknownJournalAction(s: JournalSimulation): JournalSimulation {
  verify(s);
  check(s.action && s.action.outcome !== 'prepared');
  return seal({ ...copy(s), action: { ...copy(s.action), outcome: 'unknown' } });
}
/** Operation name is retained by the simulation before uncertainty; late adoption is forbidden. */
export function bindJournalOperation(s: JournalSimulation, name: string): JournalSimulation {
  verify(s);
  check(s.action?.outcome === 'attempted' && !s.action.operation);
  text(name, /^projects\/bmson-assistant\/locations\/us-west1\/operations\/[A-Za-z0-9_-]{1,128}$/);
  return seal({ ...copy(s), action: { ...copy(s.action), operation: name } });
}

export type LogicalAction = { method: 'PATCH'; updateMask: 'traffic' | 'template'; body: Obj };
function logical(a: LogicalAction, kind: IntentKind) {
  check(
    a.method === 'PATCH' &&
      a.body.name === WEB_SERVICE &&
      a.updateMask === (kind === 'createP' || kind === 'createR' ? 'template' : 'traffic') &&
      Object.keys(a.body).sort().join(',') ===
        (a.updateMask === 'template' ? 'name,template' : 'name,traffic'),
  );
}
function operation(name: string) {
  text(name, /^projects\/bmson-assistant\/locations\/us-west1\/operations\/[A-Za-z0-9_-]{1,128}$/);
}
/** Supplied action projections are simulation hypotheses, NOT evidence of actual provider execution. */
function confirmAction(
  s: JournalSimulation,
  after: Obj,
  request: LogicalAction,
  completion: { name: string; done: boolean; error?: unknown; responseService: string },
  known = false,
): JournalSimulation {
  verify(s);
  check(known || s.head.intent?.kind !== 'reconcileKnown');
  check(
    s.action &&
      s.action.outcome !== 'prepared' &&
      s.action.operation === completion.name &&
      completion.done === true &&
      completion.error === undefined &&
      completion.responseService === WEB_SERVICE,
  );
  operation(completion.name);
  check(s.head.intent && digest(request) === s.head.intent.logicalDigest);
  logical(request, s.head.intent.kind);
  settled(after, s.anchor.serviceUid);
  check(
    equal(head(after), s.head) &&
      after.etag !== s.raw.etag &&
      BigInt(after.generation as string) > BigInt(s.raw.generation as string),
  );
  const field = request.updateMask,
    omit = (raw: Obj) =>
      Object.fromEntries(
        Object.entries(raw).filter(
          ([k]) =>
            !VOLATILE.has(k) &&
            k !== field &&
            !(field === 'traffic' && k === 'trafficStatuses') &&
            !(
              field === 'template' && ['latestReadyRevision', 'latestCreatedRevision'].includes(k)
            ) &&
            !(field === 'traffic' && k === 'urls'),
        ),
      );
  check(equal(omit(s.raw), omit(after)) && equal(after[field], request.body[field]));
  // The existing lifecycle/retirement/reconciliation verifier must additionally validate its phase's raw semantic poststate.
  return seal({
    ...copy(s),
    raw: copy(after),
    action: { ...copy(s.action), outcome: 'confirmed' },
  });
}
function metadataPlan(
  s: JournalSimulation,
  next: Head,
  purpose: 'complete' | 'claim' | 'consumeBarrier',
  owner = s.origin,
): MetadataPlan {
  const last = s.history.at(-1);
  check(last);
  next = { ...copy(next), previousArchive: { id: last.archive.id, digest: last.archive.digest } };
  validateHead(next);
  annotations({ annotations: { ...annotations(s.raw), [JOURNAL_KEY]: JSON.stringify(next) } });
  annotations({ annotations: { ...annotations(s.raw), [JOURNAL_KEY]: JSON.stringify(next) } });
  return {
    simulationOnly: true,
    mutationAuthorized: false,
    origin: copy(owner),
    beforeDigest: digest(s.raw),
    beforeHeadDigest: digest(s.head),
    next,
    request: {
      method: 'PATCH',
      updateMask: 'annotations',
      body: {
        name: WEB_SERVICE,
        etag: s.raw.etag as string,
        annotations: { ...annotations(s.raw), [JOURNAL_KEY]: JSON.stringify(next) },
      },
    },
    purpose,
  };
}
export function planJournalCompletion(s: JournalSimulation): MetadataPlan {
  verify(s);
  check(
    !s.pending &&
      !s.drain &&
      s.action?.outcome === 'confirmed' &&
      s.head.intent?.kind !== 'retireCaptured',
  );
  return metadataPlan(
    s,
    {
      ...copy(s.head),
      sequence: ordinal(s.head.sequence + 1),
      parent: digest(s.head),
      status: 'complete',
    },
    'complete',
  );
}
export function planJournalClaim(
  s: JournalSimulation,
  newOwner: Origin,
  priorRun: Obj,
  priorJob: Obj,
): MetadataPlan {
  verify(s);
  origin(newOwner);
  check(
    !s.pending &&
      !s.action &&
      !s.drain &&
      (s.head.status === 'complete' || (s.head.sequence === 0 && s.head.status === 'idle')) &&
      !equal(newOwner, s.origin) &&
      newOwner.runId !== s.origin.runId,
  );
  check(
    String(priorRun.id) === s.origin.runId &&
      priorRun.run_attempt === 1 &&
      priorRun.head_sha === s.origin.source &&
      priorRun.status === 'completed' &&
      String(priorJob.id) === s.origin.jobId &&
      String(priorJob.run_id) === s.origin.runId &&
      priorJob.head_sha === s.origin.source &&
      priorJob.status === 'completed' &&
      priorJob.check_run_url ===
        `https://api.github.com/repos/bmson/assistant/check-runs/${s.origin.checkRunId}`,
  );
  return metadataPlan(
    s,
    {
      ...copy(s.head),
      sequence: ordinal(s.head.sequence + 1),
      parent: digest(s.head),
      owner: copy(newOwner),
      status: 'idle',
      intent: null,
      admissionPossible: false,
    },
    'claim',
    newOwner,
  );
}
/** No metadata mutation is permitted from start of the existing retirement drain through admission verification. */
export function startJournalDrain(s: JournalSimulation, now: number): JournalSimulation {
  verify(s);
  check(!s.pending && !s.drain && s.action?.outcome === 'confirmed');
  check(s.head.intent?.kind === 'retireCaptured' && Number.isFinite(now));
  return seal({
    ...copy(s),
    drain: {
      etag: s.raw.etag as string,
      generation: s.raw.generation as string,
      startedAt: now,
      completedAt: null,
      verifiedAt: null,
    },
  });
}
export function completeJournalDrain(
  s: JournalSimulation,
  remote: Obj,
  now: number,
): JournalSimulation {
  verify(s);
  check(
    s.drain &&
      s.drain.completedAt === null &&
      Number.isFinite(now) &&
      now - s.drain.startedAt >= 600000 &&
      digest(remote) === digest(s.raw) &&
      remote.etag === s.drain.etag &&
      remote.generation === s.drain.generation,
  );
  return seal({ ...copy(s), drain: { ...copy(s.drain), completedAt: now } });
}
export function verifyJournalAdmissionBarrier(
  s: JournalSimulation,
  remote: Obj,
  now: number,
): JournalSimulation {
  verify(s);
  check(
    s.drain?.completedAt !== null &&
      s.drain &&
      Number.isFinite(now) &&
      now >= s.drain.completedAt &&
      digest(remote) === digest(s.raw) &&
      remote.etag === s.drain.etag &&
      remote.generation === s.drain.generation,
  );
  return seal({ ...copy(s), drain: { ...copy(s.drain), verifiedAt: now } });
}
export function planConsumeJournalBarrier(
  s: JournalSimulation,
  remote: Obj,
  createR: LogicalAction,
  now: number,
): MetadataPlan {
  verify(s);
  check(
    s.drain?.verifiedAt !== null &&
      s.drain &&
      Number.isFinite(now) &&
      now >= s.drain.verifiedAt &&
      now - s.drain.verifiedAt <= 15000 &&
      digest(remote) === digest(s.raw) &&
      remote.etag === s.drain.etag &&
      remote.generation === s.drain.generation &&
      !s.pending &&
      s.action?.outcome === 'confirmed',
  );
  logical(createR, 'createR');
  return metadataPlan(
    s,
    {
      ...copy(s.head),
      sequence: ordinal(s.head.sequence + 1),
      parent: digest(s.head),
      status: 'prepared',
      intent: { kind: 'createR', logicalDigest: digest(createR) },
      admissionPossible: true,
    },
    'consumeBarrier',
  );
}
export function journalSimulationSafety(s: JournalSimulation) {
  verify(s);
  return {
    simulationOnly: true,
    mutationAuthorized: false,
    admissionPossible: s.head.admissionPossible || s.pending?.plan.next.admissionPossible === true,
    everAdmitted:
      s.history.some((e) => e.head.admissionPossible) ||
      s.head.admissionPossible ||
      s.pending?.plan.next.admissionPossible === true,
    retiredTags: [
      ...new Set([...s.head.retiredTags, ...(s.pending?.plan.next.retiredTags ?? [])]),
    ].sort(),
    held: s.pending?.outcome === 'unknown' || s.action?.outcome === 'unknown',
  };
}

export type KnownHandoffPacket = {
  simulationOnly: true;
  mutationAuthorized: false;
  origin: Origin;
  headDigest: string;
  observedAt: string;
  knownPlan: ReturnType<typeof planWebTrafficReconciliation>;
};
export function prepareKnownJournalReconciliation(
  s: JournalSimulation,
  native: unknown,
  observedAt: string,
): MetadataPlan {
  verify(s);
  const plan = planWebTrafficReconciliation(s.raw, native, s.origin.source, observedAt),
    { etag: _etag, ...body } = plan.request.body;
  const request: LogicalAction = { method: 'PATCH', updateMask: 'traffic', body };
  return prepareJournalSimulation(s, 'reconcileKnown', digest(request));
}
/** The selected composition is SAME protected run AND SAME authenticated check-run/job, after PREPARE is settled. */
export function knownJournalHandoffPacket(
  s: JournalSimulation,
  native: unknown,
  observedAt: string,
): KnownHandoffPacket {
  verify(s);
  check(
    !s.pending &&
      s.action?.outcome === 'prepared' &&
      s.head.intent?.kind === 'reconcileKnown' &&
      equal(s.head.owner, s.origin),
  );
  const plan = planWebTrafficReconciliation(s.raw, native, s.origin.source, observedAt);
  return {
    simulationOnly: true,
    mutationAuthorized: false,
    origin: copy(s.origin),
    headDigest: digest(s.head),
    observedAt,
    knownPlan: plan,
  };
}
export type SimulatedReview = {
  origin: Origin;
  packetDigest: string;
  headDigest: string;
  reviewedAt: number;
  expiresAt: number;
};
export function acceptKnownJournalHandoff(
  s: JournalSimulation,
  native: unknown,
  packet: KnownHandoffPacket,
  review: SimulatedReview,
  now: number,
): {
  state: JournalSimulation;
  request: ReturnType<typeof planWebTrafficReconciliation>['request'];
  simulationOnly: true;
  mutationAuthorized: false;
} {
  verify(s);
  check(
    Number.isFinite(now) &&
      Number.isFinite(review.reviewedAt) &&
      Number.isFinite(review.expiresAt) &&
      review.reviewedAt <= now &&
      review.expiresAt > now &&
      review.expiresAt - review.reviewedAt <= 1800000 &&
      equal(review.origin, s.origin) &&
      review.headDigest === digest(s.head) &&
      review.packetDigest === digest(packet),
  );
  const at = Date.parse(packet.observedAt);
  check(Number.isFinite(at) && at <= review.reviewedAt && now - at <= 1800000);
  check(equal(packet, knownJournalHandoffPacket(s, native, packet.observedAt)));
  const { etag: _etag, ...body } = packet.knownPlan.request.body;
  const logicalRequest: LogicalAction = { method: 'PATCH', updateMask: 'traffic', body };
  return {
    state: beginAction(s, s.raw, logicalRequest, true),
    request: copy(packet.knownPlan.request),
    simulationOnly: true,
    mutationAuthorized: false,
  };
}

export function beginJournalClaim(
  s: JournalSimulation,
  newOwner: Origin,
  priorRun: Obj,
  priorJob: Obj,
): JournalSimulation {
  const p = planJournalClaim(s, newOwner, priorRun, priorJob);
  return seal({
    ...copy(s),
    origin: copy(newOwner),
    pending: { plan: p, outcome: 'attempted', operation: null },
  });
}
export function beginConsumeJournalBarrier(
  s: JournalSimulation,
  remote: Obj,
  createR: LogicalAction,
  now: number,
): JournalSimulation {
  const p = planConsumeJournalBarrier(s, remote, createR, now);
  return seal({ ...copy(s), pending: { plan: p, outcome: 'attempted', operation: null } });
}

export function beginJournalAction(
  s: JournalSimulation,
  remote: Obj,
  nonEtagRequest: LogicalAction,
): JournalSimulation {
  logical(nonEtagRequest, s.head.intent?.kind as IntentKind);
  return beginAction(s, remote, nonEtagRequest);
}

/** Pure strict lifecycle bridge: rebuild BOTH projections from raw objects, never an injected hash/boolean. */
export function rebaseLifecycleJournalSimulation(
  s: JournalSimulation,
  lifecycle: import('./owner-web-release-lifecycle-model.js').State,
  native: Record<string, unknown>,
) {
  verify(s);
  verifyLifecycleState(lifecycle);
  check(
    s.preparedBefore &&
      !s.pending &&
      s.action?.outcome === 'prepared' &&
      s.head.intent &&
      s.origin.source === lifecycle.context.source &&
      s.origin.runId === lifecycle.context.runId &&
      s.origin.attempt === lifecycle.context.attempt &&
      journalPreservedDigest(s.preparedBefore) === journalPreservedDigest(s.raw),
  );
  const mode = s.head.intent.kind;
  check(!['reconcileKnown', 'retireCaptured'].includes(mode));
  const before = projectNativeWebSnapshot(s.preparedBefore, native, lifecycle.context),
    after = projectNativeWebSnapshot(s.raw, native, lifecycle.context);
  check(digest(before) === digest(lifecycle.snapshot));
  const closingTag =
    mode === 'closeP'
      ? `candidate-${lifecycle.context.runId}-${lifecycle.context.attempt}`
      : mode === 'closeR'
        ? `resume-${lifecycle.context.runId}-${lifecycle.context.attempt}`
        : null;
  const retired = [
    ...new Set([...lifecycle.retiredTags, ...s.head.retiredTags.filter((t) => t !== closingTag)]),
  ].sort();
  const { receipt, ...body } = copy(lifecycle),
    rebasedBody = {
      ...body,
      previousReceipt: receipt,
      ordinal: lifecycle.ordinal + 1,
      snapshot: after,
      retiredTags: retired,
      admissionPossible: lifecycle.admissionPossible || s.head.admissionPossible,
    },
    rebased = { ...rebasedBody, receipt: digest(rebasedBody) };
  verifyLifecycleState(rebased);
  const plan = planLifecycleAction(
      rebased,
      mode as import('./owner-web-release-lifecycle-model.js').Mode,
    ),
    { etag: _etag, ...requestBody } = plan.request.body,
    request: LogicalAction = {
      method: 'PATCH',
      updateMask: plan.request.updateMask,
      body: requestBody,
    };
  check(
    digest(request) === s.head.intent.logicalDigest &&
      plan.expectedTraffic.every((row) => !s.head.retiredTags.includes(row.tag)),
  );
  return {
    simulationOnly: true as const,
    mutationAuthorized: false as const,
    state: rebased,
    plan,
  };
}

/** Concrete initial path composes the existing exact known 3/2 planner AND its strict post verifier. */
export function confirmKnownJournalReconciliation(
  s: JournalSimulation,
  after: Obj,
  native: unknown,
  packet: KnownHandoffPacket,
  completion: { name: string; done: boolean; error?: unknown; responseService: string },
) {
  verify(s);
  check(
    s.head.intent?.kind === 'reconcileKnown' &&
      equal(packet.origin, s.origin) &&
      packet.headDigest === digest(s.head) &&
      equal(
        packet.knownPlan,
        planWebTrafficReconciliation(s.raw, native, s.origin.source, packet.observedAt),
      ),
  );
  const receipt = verifyWebTrafficReconciliationPost(after, native, packet.knownPlan),
    { etag: _etag, ...body } = packet.knownPlan.request.body;
  const state = confirmAction(
    s,
    after,
    { method: 'PATCH', updateMask: 'traffic', body },
    completion,
    true,
  );
  return {
    simulationOnly: true as const,
    mutationAuthorized: false as const,
    state,
    receipt,
    requiresNewNormalRetirementPlan: true as const,
  };
}

export function confirmJournalAction(
  s: JournalSimulation,
  after: Obj,
  request: LogicalAction,
  completion: { name: string; done: boolean; error?: unknown; responseService: string },
): JournalSimulation {
  return confirmAction(s, after, request, completion);
}
