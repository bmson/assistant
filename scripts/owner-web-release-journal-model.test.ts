// biome-ignore-all lint/style/noNonNullAssertion: Deliberately mutated finite offline fixtures.
import { describe, expect, it } from 'vitest';
import * as J from './owner-web-release-journal-model.js';
import {
  beginLifecycleAttempt,
  bindLifecycleOperation,
  type Context,
  captureLifecycle,
  planLifecycleAction,
  settleLifecycleAttempt,
  verifyLifecycleState,
} from './owner-web-release-lifecycle-model.js';
import { projectNativeWebSnapshot } from './owner-web-release-native-proof.js';
import { HISTORICAL_WEB_TAGS, WEB_SERVICE } from './owner-web-tag-retirement.js';
import {
  reconciliationDigest as digest,
  planWebTrafficReconciliation,
} from './owner-web-traffic-reconciliation-model.js';

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const at = '2026-11-01T23:00:00.000Z',
  now = Date.parse(at),
  op = 'projects/bmson-assistant/locations/us-west1/operations/journal-fixed';
const owner: J.Origin = {
  source: 'a'.repeat(40),
  runId: '700001',
  attempt: '1',
  jobId: '9001',
  checkRunId: '8001',
  repositoryId: '1304152266',
  ownerId: '890821',
};
const completed = { name: op, done: true, responseService: WEB_SERVICE };
const privateValue = 'PRIVATE_NATIVE_VALUE_MUST_NOT_BE_A_PUBLIC_RECEIPT';
// biome-ignore lint/suspicious/noExplicitAny: Heterogeneous malformed wire fixtures, never production projections.
type Raw = Record<string, any>;
function rawFixture(known = false) {
  const old = HISTORICAL_WEB_TAGS[0]!,
    current = HISTORICAL_WEB_TAGS[1]!,
    root = 'https://assistant-web-3gimfiaifa-uw.a.run.app',
    uri = (tag: string) => `https://${tag}---assistant-web-3gimfiaifaifa-uw.a.run.app`;
  const native = (p: typeof old) => ({
    name: `${WEB_SERVICE}/revisions/${p.revision}`,
    uid: `uid-${p.revision}`,
    service: WEB_SERVICE,
    conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
    serviceAccount: 'runtime@bmson-assistant.iam.gserviceaccount.com',
    timeout: '300s',
    containers: [
      {
        image: p.image,
        env: [
          { name: 'ASSISTANT_RELEASE_WRITES_PAUSED', value: 'false' },
          { name: 'ASSISTANT_RELEASE_MANIFEST', value: 'e'.repeat(64) },
          { name: 'PRIVATE', value: privateValue },
        ],
      },
    ],
  });
  const revisions: Record<string, Raw> = { [current.revision]: native(current) };
  if (known) revisions[old.revision] = native(old);
  const {
    name: _name,
    uid: _uid,
    service: _service,
    conditions: _conditions,
    ...fields
  } = revisions[current.revision]!;
  const template = { ...fields, revision: current.revision };
  const row = (p: typeof old, percent: number, tagged = true) => ({
    type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
    revision: p.revision,
    ...(tagged ? { tag: p.tag } : {}),
    percent,
  });
  const tagUri = (p: typeof old) => `https://${p.tag}---assistant-web-3gimfiaifa-uw.a.run.app`;
  const raw: Raw = {
    name: WEB_SERVICE,
    uid: 'fixed-service-uid',
    etag: 'etag-base',
    generation: '1',
    observedGeneration: '1',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    latestReadyRevision: current.revision,
    latestCreatedRevision: current.revision,
    template,
    annotations: { 'unowned.example/opaque': privateValue },
    traffic: known ? [row(current, 100, false), row(current, 0), row(old, 0)] : [row(current, 100)],
    trafficStatuses: known
      ? [
          { ...row(current, 100), uri: tagUri(current) },
          { ...row(old, 0), uri: tagUri(old) },
        ]
      : [{ ...row(current, 100), uri: tagUri(current) }],
    uri: root,
    urls: known ? [root, tagUri(current), tagUri(old)] : [root, tagUri(current)],
    ingress: 'INGRESS_TRAFFIC_ALL',
  };
  void uri;
  return { raw, native: revisions, current, old };
}
function bump(raw: Raw, annotations?: Record<string, string>): Raw {
  const a = copy(raw);
  if (annotations) a.annotations = copy(annotations);
  a.etag += `-next`;
  a.generation = String(BigInt(a.generation) + 1n);
  a.observedGeneration = a.generation;
  return a;
}
function event(
  raw: Raw,
  head: J.Head,
  resolution: J.SimulatedResolution | null = null,
  barrier: J.BarrierProjection | null = null,
): J.HistoryEvent {
  const postDigest = digest(raw),
    base = {
      head: copy(head),
      postEtag: raw.etag as string,
      postGeneration: raw.generation as string,
      postDigest,
    };
  return {
    ...base,
    postRaw: copy(raw),
    resolution: copy(resolution),
    barrier: copy(barrier),
    archive: {
      id: head.sequence + 101,
      name: `web-journal-${head.genesis.slice(0, 12)}-${head.owner.source}-${head.owner.runId}-1-${head.sequence}`,
      digest: 'c'.repeat(64),
      memberDigest: digest({
        ...base,
        resolutionDigest: resolution ? digest(resolution) : null,
        barrier,
      }),
      expired: false,
      expiresAt: '2026-12-01T00:00:00.000Z',
      source: head.owner.source,
      runId: head.owner.runId,
      attempt: '1',
      jobId: head.owner.jobId,
      checkRunId: head.owner.checkRunId,
    },
  };
}
function fixture(known = false) {
  const f = rawFixture(known),
    g = J.simulateGenesis(f.raw, owner, 'b'.repeat(64)),
    raw = bump(f.raw, g.request.body.annotations),
    s = J.enrollJournalSimulation(raw, g.anchor, [event(raw, g.head)], owner, now);
  return { ...f, state: s };
}
function commitMeta(s: J.JournalSimulation, p: J.MetadataPlan) {
  const started = J.bindJournalPrepareOperation(J.beginJournalPrepare(s, p), op),
    raw = bump(s.raw, p.request.body.annotations);
  return J.confirmJournalPrepare(
    started,
    raw,
    event(raw, p.next, p.resolution, p.barrier),
    now,
    completed,
  );
}
function commitSpecial(s: J.JournalSimulation) {
  const started = J.bindJournalPrepareOperation(s, op),
    p = started.pending!.plan,
    raw = bump(started.raw, p.request.body.annotations);
  return J.confirmJournalPrepare(
    started,
    raw,
    event(raw, p.next, p.resolution, p.barrier),
    now,
    completed,
  );
}
const trafficRequest = (raw: Raw): J.LogicalAction => ({
  method: 'PATCH',
  updateMask: 'traffic',
  body: { name: WEB_SERVICE, traffic: copy(raw.traffic) },
});
function prepared(kind: J.IntentKind = 'promoteP') {
  const f = fixture(),
    request = trafficRequest(f.state.raw);
  return {
    ...f,
    request,
    state: commitMeta(f.state, J.prepareJournalSimulation(f.state, kind, digest(request))),
  };
}
function confirmed(kind: J.IntentKind = 'promoteP') {
  const f = prepared(kind),
    started = J.bindJournalOperation(J.beginJournalAction(f.state, f.state.raw, f.request), op),
    after = bump(started.raw);
  return { ...f, state: J.confirmJournalAction(started, after, f.request, completed) };
}
function terminal() {
  const f = confirmed();
  return { ...f, state: commitMeta(f.state, J.planJournalCompletion(f.state)) };
}
function oldMetadata(o = owner) {
  return {
    run: { id: Number(o.runId), run_attempt: 1, head_sha: o.source, status: 'completed' },
    job: {
      id: Number(o.jobId),
      run_id: Number(o.runId),
      head_sha: o.source,
      status: 'completed',
      check_run_url: `https://api.github.com/repos/bmson/assistant/check-runs/${o.checkRunId}`,
    },
  };
}
function identityFixture() {
  return {
    claims: {
      iss: 'https://token.actions.githubusercontent.com',
      aud: 'assistant-web-journal-v1',
      repository: 'bmson/assistant',
      repository_id: owner.repositoryId,
      repository_owner_id: owner.ownerId,
      ref: 'refs/heads/main',
      environment: 'production',
      workflow_ref: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
      workflow_sha: owner.source,
      sha: owner.source,
      run_id: owner.runId,
      run_attempt: '1',
      check_run_id: owner.checkRunId,
      event_name: 'workflow_dispatch',
      nbf: now / 1000 - 1,
      iat: now / 1000 - 1,
      exp: now / 1000 + 300,
    } as Raw,
    run: {
      id: Number(owner.runId),
      run_attempt: 1,
      head_sha: owner.source,
      path: '.github/workflows/deploy.yml',
      status: 'in_progress',
      repository: { id: 1304152266 },
      head_repository: { id: 1304152266 },
    } as Raw,
    job: {
      id: Number(owner.jobId),
      run_id: Number(owner.runId),
      head_sha: owner.source,
      status: 'in_progress',
      name: 'irrelevant-name',
      url: `https://api.github.com/repos/bmson/assistant/actions/jobs/${owner.jobId}`,
      check_run_url: `https://api.github.com/repos/bmson/assistant/check-runs/${owner.checkRunId}`,
    } as Raw,
  };
}
describe('offline origin/job binding contract', () => {
  it('binds check_run_id to actual job check_run_url, not its display name', () => {
    const f = identityFixture();
    f.job.name = 'not-release';
    expect(J.simulateOriginBinding(f.claims, f.run, f.job, now)).toEqual(owner);
  });
  it.each([
    'checkRun',
    'jobRun',
    'jobSource',
    'runSource',
    'attempt',
    'repository',
    'environment',
    'workflow',
    'expiry',
    'unsignedAudience',
    'jobURL',
  ] as const)('holds mismatched simulated origin %s', (kind) => {
    const f = identityFixture();
    if (kind === 'checkRun') f.claims.check_run_id = '999';
    if (kind === 'jobRun') f.job.run_id = 88;
    if (kind === 'jobSource') f.job.head_sha = 'f'.repeat(40);
    if (kind === 'runSource') f.run.head_sha = 'f'.repeat(40);
    if (kind === 'attempt') f.claims.run_attempt = '2';
    if (kind === 'repository') f.claims.repository_id = '999';
    if (kind === 'environment') f.claims.environment = 'test';
    if (kind === 'workflow') f.claims.workflow_sha = 'f'.repeat(40);
    if (kind === 'expiry') f.claims.exp = now / 1000;
    if (kind === 'unsignedAudience') f.claims.aud = 'foreign';
    if (kind === 'jobURL') f.job.check_run_url = 'https://evil.invalid/check-runs/8001';
    expect(() => J.simulateOriginBinding(f.claims, f.run, f.job, now)).toThrow();
  });
});
describe('journal same-resource CAS simulation', () => {
  it('persists exact owned annotation only and rebases full config hash', () => {
    const f = fixture(),
      p = J.prepareJournalSimulation(f.state, 'promoteP', digest(trafficRequest(f.state.raw))),
      s = commitMeta(f.state, p);
    expect(p.request.updateMask).toBe('annotations');
    expect(p.request.body.annotations['unowned.example/opaque']).toBe(privateValue);
    expect(J.journalPreservedDigest(s.raw)).toBe(J.journalPreservedDigest(f.state.raw));
    expect(digest(s.raw)).not.toBe(digest(f.state.raw));
    expect(s.head.sequence).toBe(1);
    expect(s.mutationAuthorized).toBe(false);
    expect(JSON.stringify(s.head)).not.toContain(privateValue);
  });
  it('holds unknown PREPARE without duplicate planning or late operation adoption', () => {
    const f = fixture(),
      p = J.prepareJournalSimulation(f.state, 'promoteP', digest({})),
      s = J.unknownJournalPrepare(J.beginJournalPrepare(f.state, p));
    expect(() => J.prepareJournalSimulation(s, 'promoteP', digest({}))).toThrow();
    expect(() => J.bindJournalPrepareOperation(s, op)).toThrow();
    expect(() =>
      J.confirmJournalPrepare(
        s,
        bump(s.raw, p.request.body.annotations),
        event(bump(s.raw, p.request.body.annotations), p.next),
        now,
        completed,
      ),
    ).toThrow();
  });
  it('can settle unknown PREPARE only through the originally bound operation and exact native head delta', () => {
    const f = fixture(),
      p = J.prepareJournalSimulation(f.state, 'promoteP', digest({})),
      s = J.unknownJournalPrepare(
        J.bindJournalPrepareOperation(J.beginJournalPrepare(f.state, p), op),
      ),
      after = bump(s.raw, p.request.body.annotations);
    expect(
      J.confirmJournalPrepare(s, after, event(after, p.next), now, completed).head.sequence,
    ).toBe(1);
    expect(() =>
      J.confirmJournalPrepare(s, after, event(after, p.next), now, {
        ...completed,
        name: `${op}other`,
      }),
    ).toThrow();
  });
  it.each([
    'etag',
    'generation',
    'otherAnnotation',
    'template',
    'traffic',
    'revision',
    'head',
    'uid',
  ] as const)('refuses PREPARE drift %s', (kind) => {
    const f = fixture(),
      p = J.prepareJournalSimulation(f.state, 'promoteP', digest({})),
      s = J.bindJournalPrepareOperation(J.beginJournalPrepare(f.state, p), op),
      after = bump(s.raw, p.request.body.annotations);
    if (kind === 'etag') after.etag = s.raw.etag;
    if (kind === 'generation') after.generation = after.observedGeneration = '1';
    if (kind === 'otherAnnotation') after.annotations['unowned.example/opaque'] = 'changed';
    if (kind === 'template') after.template.timeout = '599s';
    if (kind === 'traffic') after.traffic = [];
    if (kind === 'revision') after.latestCreatedRevision = 'assistant-web-new';
    if (kind === 'head')
      after.annotations[J.JOURNAL_KEY] = JSON.stringify({ ...p.next, sequence: 2 });
    if (kind === 'uid') after.uid = 'foreign';
    expect(() => J.confirmJournalPrepare(s, after, event(after, p.next), now, completed)).toThrow();
  });
  it('forbids an old owner even if it obtains the new service etag', () => {
    const old = prepared(),
      done = terminal(),
      nextOwner = {
        ...owner,
        source: 'd'.repeat(40),
        runId: '700002',
        jobId: '9002',
        checkRunId: '8002',
      },
      meta = oldMetadata(),
      claimed = commitSpecial(J.beginJournalClaim(done.state, nextOwner, meta.run, meta.job, now));
    expect(() => J.beginJournalAction(old.state, claimed.raw, old.request)).toThrow();
    const forged = copy(old.state);
    forged.raw.etag = claimed.raw.etag;
    expect(() => J.beginJournalAction(forged, claimed.raw, old.request)).toThrow();
  });
  it('rejects stale metadata plans after another head/etag wins', () => {
    const f = fixture(),
      p = J.prepareJournalSimulation(f.state, 'promoteP', digest({})),
      winner = commitMeta(f.state, p);
    expect(() => J.beginJournalPrepare(winner, p)).toThrow();
  });
  it('refuses fresh owner claims on an unresolved intent and rejects attempt2', () => {
    const f = prepared(),
      n = { ...owner, runId: '700002', jobId: '9002', checkRunId: '8002' },
      m = oldMetadata();
    expect(() => J.planJournalClaim(f.state, n, m.run, m.job, now)).toThrow();
    expect(() =>
      J.planJournalClaim(terminal().state, { ...n, attempt: '2' } as never, m.run, m.job, now),
    ).toThrow();
  });
  it('transfers anchored genesis only after the original bootstrap run/job are completed', () => {
    const f = fixture(),
      n = { ...owner, runId: '700002', jobId: '9002', checkRunId: '8002' },
      m = oldMetadata();
    expect(commitSpecial(J.beginJournalClaim(f.state, n, m.run, m.job, now)).head.owner).toEqual(n);
    m.job.status = 'in_progress';
    expect(() => J.beginJournalClaim(f.state, n, m.run, m.job, now)).toThrow();
  });
  it('keeps unknown action pending, refuses retry and refuses a late adopted operation', () => {
    const f = prepared(),
      s = J.unknownJournalAction(J.beginJournalAction(f.state, f.state.raw, f.request));
    expect(J.journalSimulationSafety(s).held).toBe(true);
    expect(() => J.beginJournalAction(s, s.raw, f.request)).toThrow();
    expect(() => J.bindJournalOperation(s, op)).toThrow();
    expect(() => J.planJournalCompletion(s)).toThrow();
  });
  it('requires original successful terminal operation for action confirmation', () => {
    const f = prepared(),
      s = J.bindJournalOperation(J.beginJournalAction(f.state, f.state.raw, f.request), op);
    expect(() =>
      J.confirmJournalAction(s, bump(s.raw), f.request, { ...completed, done: false }),
    ).toThrow();
    expect(() =>
      J.confirmJournalAction(s, bump(s.raw), f.request, { ...completed, name: `${op}other` }),
    ).toThrow();
  });
});

describe('history, genesis and native rollback refusal', () => {
  it.each([
    'missing',
    'expired',
    'deleted',
    'wrongDigest',
    'wrongRun',
    'wrongSource',
    'wrongAttempt',
    'wrongJob',
    'wrongCheckRun',
    'wrongGenesis',
    'oldPrefix',
    'reordered',
    'oldEtag',
    'rawTamper',
  ] as const)('rejects incomplete/replayed simulated history %s', (kind) => {
    const f = terminal(),
      events = copy(f.state.history),
      anchor = copy(f.state.anchor),
      raw = copy(f.state.raw) as Raw;
    if (kind === 'missing') events.pop();
    if (kind === 'expired') events[0]!.archive.expired = true;
    if (kind === 'deleted') events.splice(1, 1);
    if (kind === 'wrongDigest') events[0]!.archive.memberDigest = 'f'.repeat(64);
    if (kind === 'wrongRun') events[0]!.archive.runId = '99';
    if (kind === 'wrongSource') events[0]!.archive.source = 'f'.repeat(40);
    if (kind === 'wrongAttempt') events[0]!.archive.attempt = '2';
    if (kind === 'wrongJob') events[0]!.archive.jobId = '99';
    if (kind === 'wrongCheckRun') events[0]!.archive.checkRunId = '99';
    if (kind === 'wrongGenesis') anchor.genesis = 'f'.repeat(64);
    if (kind === 'oldPrefix') events.splice(1);
    if (kind === 'reordered') events.reverse();
    if (kind === 'oldEtag') raw.etag = 'fresh-etag-stolen';
    if (kind === 'rawTamper') raw.ingress = 'foreign';
    expect(() => J.validateSimulatedHistory(raw, anchor, events, now)).toThrow();
  });
  it('rejects expiry even if the expired flag is false', () => {
    const f = fixture(),
      events = copy(f.state.history);
    events[0]!.archive.expiresAt = '2026-10-01T00:00:00.000Z';
    expect(() => J.validateSimulatedHistory(f.state.raw, f.state.anchor, events, now)).toThrow();
  });
  it('rejects missing/malformed owned head rather than bootstrapping again', () => {
    const f = fixture(),
      raw = copy(f.state.raw) as Raw;
    delete raw.annotations[J.JOURNAL_KEY];
    expect(() =>
      J.enrollJournalSimulation(raw, f.state.anchor, f.state.history, owner, now),
    ).toThrow();
    raw.annotations[J.JOURNAL_KEY] = '{PRIVATE';
    expect(() =>
      J.enrollJournalSimulation(raw, f.state.anchor, f.state.history, owner, now),
    ).toThrow('Offline web journal held');
  });
  it('requires a pinned genesis digest, and rejects an existing head in the genesis constructor', () => {
    const f = fixture();
    expect(() =>
      J.enrollJournalSimulation(
        f.state.raw,
        { ...f.state.anchor, genesisDigest: 'f'.repeat(64) },
        f.state.history,
        owner,
        now,
      ),
    ).toThrow();
    expect(() => J.simulateGenesis(f.state.raw, owner, 'b'.repeat(64))).toThrow();
  });
  it('holds on unbounded annotation values and forged annotation masks', () => {
    const f = fixture(),
      raw = copy(f.raw);
    raw.annotations.opaque = 'x'.repeat(65536);
    expect(() => J.simulateGenesis(raw, owner, 'b'.repeat(64))).toThrow();
    const p = J.prepareJournalSimulation(f.state, 'promoteP', digest({}));
    p.request.updateMask = 'traffic' as never;
    expect(() => J.beginJournalPrepare(f.state, p)).toThrow();
  });
});
describe('600second immutable drain and exact barrier consumption', () => {
  function drained() {
    const f = confirmed('retireCaptured'),
      started = J.startJournalDrain(f.state, now),
      complete = J.completeJournalDrain(started, started.raw, now + 600000);
    return { ...f, state: J.verifyJournalAdmissionBarrier(complete, complete.raw, now + 600001) };
  }
  const createR: J.LogicalAction = {
    method: 'PATCH',
    updateMask: 'template',
    body: { name: WEB_SERVICE, template: { revision: 'assistant-web-r-700001-1-aaaaaaaa' } },
  };
  it('forbids every metadata transition during drain and before the admission verifier', () => {
    const f = confirmed('retireCaptured'),
      s = J.startJournalDrain(f.state, now);
    expect(() => J.prepareJournalSimulation(s, 'attachP', digest({}))).toThrow();
    expect(() => J.planJournalCompletion(s)).toThrow();
    expect(() => J.planConsumeJournalBarrier(s, s.raw, createR, now + 600000)).toThrow();
    const c = J.completeJournalDrain(s, s.raw, now + 600000);
    expect(() => J.planConsumeJournalBarrier(c, c.raw, createR, now + 600001)).toThrow();
  });
  it('does not permit a direct prepareR or retirement completion shortcut', () => {
    const f = fixture();
    expect(() => J.prepareJournalSimulation(f.state, 'createR', digest(createR))).toThrow();
    expect(() => J.planJournalCompletion(confirmed('retireCaptured').state)).toThrow();
  });
  it.each([599000, 599999])('refuses a short drain: %dms', (elapsed) => {
    const s = J.startJournalDrain(confirmed('retireCaptured').state, now);
    expect(() => J.completeJournalDrain(s, s.raw, now + elapsed)).toThrow();
  });
  it.each(['etag', 'generation', 'traffic', 'annotation'])(
    'refuses mid-drain native change %s',
    (kind) => {
      const s = J.startJournalDrain(confirmed('retireCaptured').state, now),
        raw = copy(s.raw) as Raw;
      if (kind === 'etag') raw.etag = 'changed';
      if (kind === 'generation') raw.generation = '999';
      if (kind === 'traffic') raw.traffic = [];
      if (kind === 'annotation') raw.annotations['unowned.example/opaque'] = 'changed';
      expect(() => J.completeJournalDrain(s, raw, now + 600000)).toThrow();
    },
  );
  it('consumes exactly the verified barrier etag and durably raises conservative admission on uncertain PREPARE', () => {
    const f = drained(),
      p = J.planConsumeJournalBarrier(f.state, f.state.raw, createR, now + 600002);
    expect(p.request.body.etag).toBe(f.state.drain?.etag);
    const pending = J.unknownJournalPrepare(
      J.beginConsumeJournalBarrier(f.state, f.state.raw, createR, now + 600002),
    );
    expect(J.journalSimulationSafety(pending).admissionPossible).toBe(true);
    expect(() => J.prepareJournalSimulation(pending, 'restoreC', digest({}))).toThrow();
  });
  it('rebases only the verified owned metadata delta after barrier consumption, without inventing another drain', () => {
    const f = drained(),
      pending = J.beginConsumeJournalBarrier(f.state, f.state.raw, createR, now + 600002),
      s = commitSpecial(pending);
    expect(s.head.admissionPossible).toBe(true);
    expect(s.drain).toBeNull();
    expect(s.action?.outcome).toBe('prepared');
    expect(s.raw.etag).not.toBe(f.state.drain?.etag);
    expect(J.journalPreservedDigest(s.raw)).toBe(J.journalPreservedDigest(f.state.raw));
  });
  it('refuses a stale verifier, a fresh stolen etag, and reuse of the old barrier after consumption', () => {
    const f = drained();
    expect(() =>
      J.planConsumeJournalBarrier(f.state, f.state.raw, createR, now + 615002),
    ).toThrow();
    expect(() =>
      J.planConsumeJournalBarrier(
        f.state,
        { ...f.state.raw, etag: 'fresh' },
        createR,
        now + 600002,
      ),
    ).toThrow();
    const s = commitSpecial(
      J.beginConsumeJournalBarrier(f.state, f.state.raw, createR, now + 600002),
    );
    expect(() => J.planConsumeJournalBarrier(s, s.raw, createR, now + 600003)).toThrow();
  });
});
describe('concrete exact known3desired2observed handoff', () => {
  function ready() {
    const f = fixture(true),
      p = J.prepareKnownJournalReconciliation(f.state, f.native, at),
      s = commitMeta(f.state, p),
      packet = J.knownJournalHandoffPacket(s, f.native, at),
      review: J.SimulatedReview = {
        origin: owner,
        packetDigest: digest(packet),
        headDigest: packet.headDigest,
        reviewedAt: now,
        expiresAt: now + 1800000,
      };
    return { ...f, state: s, packet, review };
  }
  it('constructs the fresh packet AFTER metadata PREPARE with its actual new etag/config', () => {
    const f = ready();
    expect(f.packet.knownPlan.before.etag).toBe(f.state.raw.etag);
    expect(f.packet.knownPlan.before.desired).toHaveLength(3);
    expect(f.packet.knownPlan.before.observed).toHaveLength(2);
    expect(
      J.acceptKnownJournalHandoff(f.state, f.native, f.packet, f.review, now).request.body.etag,
    ).toBe(f.state.raw.etag);
    expect(f.packet.mutationAuthorized).toBe(false);
  });
  it('keeps the normal lifecycle capture blocked until real equality is confirmed', () => {
    const f = ready();
    const context = {
      source: owner.source,
      runId: owner.runId,
      attempt: '1',
      manifest: 'b'.repeat(64),
      image: f.current.image,
      canonical: f.current.revision,
      releaseEnv: {},
      retiredTags: [],
    };
    expect(() =>
      captureLifecycle(context, projectNativeWebSnapshot(f.state.raw, f.native, context)),
    ).toThrow();
  });
  it.each([
    'run',
    'source',
    'job',
    'checkRun',
    'packet',
    'head',
    'expired',
    'changedConfig',
    'earlyReview',
  ] as const)('rejects initial review/ownership drift %s', (kind) => {
    const f = ready(),
      r = copy(f.review),
      p = copy(f.packet),
      s = copy(f.state);
    if (kind === 'run') r.origin.runId = '700002';
    if (kind === 'source') r.origin.source = 'f'.repeat(40);
    if (kind === 'job') r.origin.jobId = '9002';
    if (kind === 'checkRun') r.origin.checkRunId = '8002';
    if (kind === 'packet') r.packetDigest = 'f'.repeat(64);
    if (kind === 'head') r.headDigest = 'f'.repeat(64);
    if (kind === 'expired') r.expiresAt = now;
    if (kind === 'changedConfig') (s.raw.template as Raw).timeout = '599s';
    if (kind === 'earlyReview') r.reviewedAt = now - 1;
    expect(() => J.acceptKnownJournalHandoff(s, f.native, p, r, now)).toThrow();
  });
  it('cannot bypass packet review through the generic action path', () => {
    const f = ready(),
      { etag: _etag, ...body } = f.packet.knownPlan.request.body;
    expect(() =>
      J.beginJournalAction(f.state, f.state.raw, { method: 'PATCH', updateMask: 'traffic', body }),
    ).toThrow();
  });
  it('refuses the generic completion shortcut even after a valid packet review', () => {
    const f = ready(),
      started = J.bindJournalOperation(
        J.acceptKnownJournalHandoff(f.state, f.native, f.packet, f.review, now).state,
        op,
      ),
      { etag: _etag, ...body } = f.packet.knownPlan.request.body;
    expect(() =>
      J.confirmJournalAction(
        started,
        bump(started.raw),
        { method: 'PATCH', updateMask: 'traffic', body },
        completed,
      ),
    ).toThrow();
  });
  it('composes the original strict postcheck and yields a distinct receipt before a NEW normal retirement plan', () => {
    const f = ready(),
      started = J.bindJournalOperation(
        J.acceptKnownJournalHandoff(f.state, f.native, f.packet, f.review, now).state,
        op,
      ),
      after = bump(started.raw);
    after.traffic = copy(f.packet.knownPlan.request.body.traffic);
    after.trafficStatuses = after.traffic.map((r: Raw) => ({
      ...r,
      uri: `https://${r.tag}---assistant-web-3gimfiaifa-uw.a.run.app`,
    }));
    const done = J.confirmKnownJournalReconciliation(started, after, f.native, f.packet, completed);
    expect(done.receipt.outcome).toBe('strict_equality_restored_both_tags_preserved');
    expect(done.requiresNewNormalRetirementPlan).toBe(true);
    expect(done.state.action?.outcome).toBe('confirmed');
    expect(done.receipt.retirementDrainCompleted).toBe(false);
    expect(done.mutationAuthorized).toBe(false);
  });
});

describe('verified raw lifecycle rebase bridge', () => {
  function base() {
    const f = fixture(),
      c: Context = {
        source: owner.source,
        runId: owner.runId,
        attempt: '1',
        manifest: 'b'.repeat(64),
        image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'c'.repeat(64)}`,
        canonical: f.current.revision,
        retiredTags: [],
        releaseEnv: {},
      };
    c.releaseEnv = {
      ASSISTANT_RELEASE_API_CONTRACT: '1',
      ASSISTANT_RELEASE_AGENT_API_MIN: '1',
      ASSISTANT_RELEASE_AGENT_API_MAX: '1',
      ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
      ASSISTANT_RELEASE_SCHEMA_MIN: '133',
      ASSISTANT_RELEASE_SCHEMA_MAX: '133',
      ASSISTANT_RELEASE_SCHEMA_VERSION: '133',
      ASSISTANT_RELEASE_MANIFEST: c.manifest,
      ASSISTANT_RELEASE_WORKFLOW_RUN_ID: c.runId,
      ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT: c.attempt,
      ASSISTANT_RELEASE_SOURCE_SHA: c.source,
    };
    const lifecycle = captureLifecycle(c, projectNativeWebSnapshot(f.state.raw, f.native, c)),
      beforePlan = planLifecycleAction(lifecycle, 'createP'),
      { etag: _etag, ...body } = beforePlan.request.body,
      request: J.LogicalAction = { method: 'PATCH', updateMask: 'template', body },
      journal = commitMeta(
        f.state,
        J.prepareJournalSimulation(f.state, 'createP', digest(request)),
      );
    return { ...f, lifecycle, journal, beforePlan };
  }
  it('rebuilds raw before/after proofs and freezes the full new prepared config hash', () => {
    const f = base(),
      r = J.rebaseLifecycleJournalSimulation(f.journal, f.lifecycle, f.native);
    expect(() => verifyLifecycleState(r.state)).not.toThrow();
    expect(r.plan.request.body.etag).toBe(f.journal.raw.etag);
    expect(r.state.snapshot.stableConfigSha256).not.toBe(f.lifecycle.snapshot.stableConfigSha256);
    expect(r.plan.templateSha256).toBe(f.beforePlan.templateSha256);
    expect(r.mutationAuthorized).toBe(false);
  });
  it('does not accept a caller-edited projection or a changed unowned raw annotation', () => {
    const f = base(),
      s = copy(f.lifecycle);
    s.snapshot.stableConfigSha256 = 'f'.repeat(64);
    expect(() => J.rebaseLifecycleJournalSimulation(f.journal, s, f.native)).toThrow();
    const j = copy(f.journal);
    (j.raw.annotations as Raw)['unowned.example/opaque'] = 'different';
    expect(() => J.rebaseLifecycleJournalSimulation(j, f.lifecycle, f.native)).toThrow();
  });
  it('binds acknowledged predecessor artifact IDs/digests and rejects delete/recreate substitutions', () => {
    const f = terminal();
    for (const key of ['id', 'digest'] as const) {
      const events = copy(f.state.history);
      if (key === 'id') events[0]!.archive.id = 999;
      else events[0]!.archive.digest = 'f'.repeat(64);
      expect(() => J.validateSimulatedHistory(f.state.raw, f.state.anchor, events, now)).toThrow();
    }
  });
});

describe('explicit simulation/qualification boundaries', () => {
  it('models metadata etag change with equal settled generation without granting runtime qualification', () => {
    const f = fixture(),
      p = J.prepareJournalSimulation(f.state, 'promoteP', digest({})),
      s = J.bindJournalPrepareOperation(J.beginJournalPrepare(f.state, p), op),
      after = bump(s.raw, p.request.body.annotations);
    after.generation = after.observedGeneration = s.raw.generation;
    const result = J.confirmJournalPrepare(s, after, event(after, p.next), now, completed);
    expect(result.mutationAuthorized).toBe(false);
    expect(result.simulationOnly).toBe(true);
  });
  it('rejects a native action that has no newer settled generation', () => {
    const f = prepared(),
      s = J.bindJournalOperation(J.beginJournalAction(f.state, f.state.raw, f.request), op),
      after = bump(s.raw);
    after.generation = after.observedGeneration = s.raw.generation;
    expect(() => J.confirmJournalAction(s, after, f.request, completed)).toThrow();
  });
  it('caps tombstones and head growth rather than clearing history', () => {
    const f = fixture(),
      tags = Array.from({ length: 65 }, (_, i) => `resume-${i + 1}-1`);
    expect(() => J.prepareJournalSimulation(f.state, 'retireCaptured', digest({}), tags)).toThrow();
  });
  it('carries conservative tombstones at unknown metadata PREPARE', () => {
    const f = fixture(),
      tag = 'resume-123-1',
      p = J.prepareJournalSimulation(f.state, 'retireCaptured', digest({}), [tag]),
      s = J.unknownJournalPrepare(J.beginJournalPrepare(f.state, p));
    expect(J.journalSimulationSafety(s).retiredTags).toContain(tag);
  });
});

describe('durable head nested allowlist', () => {
  it('refuses an extra private caller field in owner rather than copying it into the journal', () => {
    const f = rawFixture(),
      bad = { ...owner, privateValue };
    expect(() => J.simulateGenesis(f.raw, bad, 'b'.repeat(64))).toThrow();
  });
});

describe('terminal action replay and pending read recovery', () => {
  it('rejects a second confirmation and a generic confirmed-to-unknown downgrade', () => {
    const f = confirmed();
    expect(() =>
      J.confirmJournalAction(f.state, bump(f.state.raw), f.request, completed),
    ).toThrow();
    expect(() => J.unknownJournalAction(f.state)).toThrow();
  });
  it('permits originally bound unknown-to-confirmed once, then rejects replay', () => {
    const f = prepared(),
      pending = J.bindJournalOperation(J.beginJournalAction(f.state, f.state.raw, f.request), op),
      unknown = J.unknownJournalAction(pending),
      done = J.confirmJournalAction(unknown, bump(unknown.raw), f.request, completed);
    expect(done.action?.outcome).toBe('confirmed');
    expect(() => J.confirmJournalAction(done, bump(done.raw), f.request, completed)).toThrow();
  });
});
describe('history requires matching prepared intent resolution', () => {
  function forged(mode: 'skipped' | 'altered' | 'operation' | 'native' | 'idleComplete') {
    const f = mode === 'idleComplete' ? fixture() : mode === 'skipped' ? prepared() : terminal(),
      base =
        mode === 'altered' || mode === 'operation' || mode === 'native'
          ? f.state.history.slice(0, -1)
          : f.state.history,
      prior = base.at(-1)!,
      next: J.Head = {
        ...copy(prior.head),
        sequence: prior.head.sequence + 1,
        parent: digest(prior.head),
        previousArchive: { id: prior.archive.id, digest: prior.archive.digest },
        status: 'complete',
      };
    const resolution: J.SimulatedResolution | null =
      mode === 'skipped' || mode === 'idleComplete'
        ? null
        : copy(f.state.history.at(-1)!.resolution);
    if (mode === 'altered')
      next.intent = { kind: 'attachP', logicalDigest: prior.head.intent!.logicalDigest };
    if (mode === 'operation') resolution!.boundOperation = `${op}other`;
    if (mode === 'native') resolution!.after.traffic = [];
    const after = bump(resolution?.after ?? prior.postRaw, {
        ...(prior.postRaw.annotations as Record<string, string>),
        [J.JOURNAL_KEY]: JSON.stringify(next),
      }),
      events = [...base, event(after, next, resolution)];
    const fake = {
      ...copy(f.state),
      head: next,
      raw: after,
      history: events,
      action: null,
      pending: null,
      drain: null,
    };
    const { seal: _old, ...body } = fake;
    return { state: { ...body, seal: digest(body) }, raw: after, events, anchor: f.state.anchor };
  }
  it.each(['skipped', 'altered', 'operation', 'native', 'idleComplete'] as const)(
    'refuses correctly chained but illegal %s history and subsequent owner claim',
    (kind) => {
      const f = forged(kind),
        n = {
          ...owner,
          source: 'd'.repeat(40),
          runId: '700002',
          jobId: '9002',
          checkRunId: '8002',
        },
        m = oldMetadata();
      expect(() => J.validateSimulatedHistory(f.raw, f.anchor, f.events, now)).toThrow();
      expect(() => J.planJournalClaim(f.state, n, m.run, m.job, now)).toThrow();
    },
  );
  it('requires the matching confirmed resolution even when completion is constructed by the current controller', () => {
    const f = confirmed(),
      p = J.planJournalCompletion(f.state),
      s = J.bindJournalPrepareOperation(J.beginJournalPrepare(f.state, p), op),
      raw = bump(s.raw, p.request.body.annotations);
    expect(() =>
      J.confirmJournalPrepare(s, raw, event(raw, p.next, null), now, completed),
    ).toThrow();
  });
});

describe('sequential native lifecycle with prepare AND completion rebases', () => {
  it('runs createP → native confirm → journal complete → prepare attachP without manual lifecycle reset/reseal', () => {
    const f = fixture(),
      c: Context = {
        source: owner.source,
        runId: owner.runId,
        attempt: '1',
        manifest: 'b'.repeat(64),
        image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'c'.repeat(64)}`,
        canonical: f.current.revision,
        retiredTags: [],
        releaseEnv: {},
      };
    c.releaseEnv = {
      ASSISTANT_RELEASE_API_CONTRACT: '1',
      ASSISTANT_RELEASE_AGENT_API_MIN: '1',
      ASSISTANT_RELEASE_AGENT_API_MAX: '1',
      ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
      ASSISTANT_RELEASE_SCHEMA_MIN: '133',
      ASSISTANT_RELEASE_SCHEMA_MAX: '133',
      ASSISTANT_RELEASE_SCHEMA_VERSION: '133',
      ASSISTANT_RELEASE_MANIFEST: c.manifest,
      ASSISTANT_RELEASE_WORKFLOW_RUN_ID: c.runId,
      ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT: c.attempt,
      ASSISTANT_RELEASE_SOURCE_SHA: c.source,
    };
    const initial = captureLifecycle(c, projectNativeWebSnapshot(f.state.raw, f.native, c)),
      plan = planLifecycleAction(initial, 'createP'),
      { etag: _etag, ...body } = plan.request.body,
      request: J.LogicalAction = { method: 'PATCH', updateMask: 'template', body },
      jp = commitMeta(f.state, J.prepareJournalSimulation(f.state, 'createP', digest(request))),
      prepared = J.rebaseLifecycleJournalSimulation(jp, initial, f.native);
    const lifecyclePending = bindLifecycleOperation(
        beginLifecycleAttempt(prepared.state, prepared.plan),
        op,
      ),
      journalPending = J.bindJournalOperation(J.beginJournalAction(jp, jp.raw, request), op),
      after = bump(jp.raw),
      template = copy(request.body.template as Raw),
      { revision, ...fields } = template;
    after.template = template;
    after.latestReadyRevision = after.latestCreatedRevision = revision;
    const native = {
        ...f.native,
        [revision]: {
          ...fields,
          name: `${WEB_SERVICE}/revisions/${revision}`,
          uid: 'native-new-paused',
          service: WEB_SERVICE,
          conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
        },
      },
      nativeProjection = projectNativeWebSnapshot(after, native, c),
      lifeConfirmed = settleLifecycleAttempt(lifecyclePending, completed, nativeProjection),
      jConfirmed = J.confirmJournalAction(journalPending, after, request, completed),
      jComplete = commitMeta(jConfirmed, J.planJournalCompletion(jConfirmed)),
      completion = J.rebaseLifecycleJournalCompletionSimulation(jComplete, lifeConfirmed, native);
    expect(completion.state.phase).toBe('createdP');
    expect(completion.state.previousReceipt).toBe(lifeConfirmed.receipt);
    expect(completion.state.ordinal).toBe(lifeConfirmed.ordinal + 1);
    expect(completion.state.snapshot.stableConfigSha256).not.toBe(
      lifeConfirmed.snapshot.stableConfigSha256,
    );
    expect(() => verifyLifecycleState(completion.state)).not.toThrow();
    const attach = planLifecycleAction(completion.state, 'attachP'),
      { etag: _secondEtag, ...attachBody } = attach.request.body,
      attachRequest: J.LogicalAction = { method: 'PATCH', updateMask: 'traffic', body: attachBody },
      nextJ = commitMeta(
        jComplete,
        J.prepareJournalSimulation(jComplete, 'attachP', digest(attachRequest)),
      ),
      next = J.rebaseLifecycleJournalSimulation(nextJ, completion.state, native);
    expect(next.plan.mode).toBe('attachP');
    expect(next.plan.request.body.etag).toBe(nextJ.raw.etag);
    expect(next.state.previousReceipt).toBe(completion.state.receipt);
    expect(next.state.phase).toBe('createdP');
    expect(jComplete.history.at(-1)?.resolution?.boundOperation).toBe(op);
    expect(next.mutationAuthorized).toBe(false);
  });
});

describe('redacted public history member', () => {
  it('publishes only hashes and allowlisted metadata, never the native before/after or private template', () => {
    const f = terminal(),
      e = f.state.history.at(-1)!,
      summary = J.journalEventPublicSummary(e);
    expect(digest(summary)).toBe(e.archive.memberDigest);
    expect(JSON.stringify(summary)).not.toContain(privateValue);
    expect(Object.keys(summary).sort()).toEqual([
      'barrier',
      'head',
      'postDigest',
      'postEtag',
      'postGeneration',
      'resolutionDigest',
    ]);
    expect(summary.resolutionDigest).toBe(digest(e.resolution));
  });
});

describe('stored owner consistency', () => {
  it('refuses a rehashed local frame whose owner was replaced without a claim transition', () => {
    const s = copy(fixture().state);
    s.origin = { ...owner, runId: '700002', jobId: '9002', checkRunId: '8002' };
    const { seal: _old, ...body } = s;
    const forged = { ...body, seal: digest(body) };
    expect(() => J.prepareJournalSimulation(forged, 'promoteP', digest({}))).toThrow();
  });
});

describe('final exact validation corrections', () => {
  it('revalidates artifact expiry at current claim time, not old enrollment time', () => {
    const f = terminal(),
      n = { ...owner, runId: '700002', jobId: '9002', checkRunId: '8002' },
      m = oldMetadata();
    expect(() =>
      J.planJournalClaim(f.state, n, m.run, m.job, Date.parse('2026-12-02T00:00:00.000Z')),
    ).toThrow();
    expect(() =>
      J.beginJournalClaim(f.state, n, m.run, m.job, Date.parse('2026-12-02T00:00:00.000Z')),
    ).toThrow();
    expect(() => J.planJournalClaim(f.state, n, m.run, m.job, now - 1)).toThrow();
  });
  it.each([
    'etagObject',
    'etagLong',
    'etagNewline',
    'generationObject',
    'generationLong',
    'generationOverflow',
    'infinite',
    'nan',
    'negative',
    'unsafeInteger',
    'nonNumeric',
  ] as const)('refuses hostile barrier serialization value %s', (kind) => {
    const f = terminal(),
      e = copy(f.state.history.at(-1)!);
    const d: Raw = {
      etag: 'etag-safe',
      generation: '10',
      startedAt: now,
      completedAt: now + 600000,
      verifiedAt: now + 600001,
      consumedAt: now + 600002,
    };
    if (kind === 'etagObject') d.etag = { privateValue };
    if (kind === 'etagLong') d.etag = privateValue.repeat(50);
    if (kind === 'etagNewline') d.etag = `private\n${privateValue}`;
    if (kind === 'generationObject') d.generation = { privateValue };
    if (kind === 'generationLong') d.generation = '1'.repeat(512);
    if (kind === 'generationOverflow') d.generation = '9223372036854775808';
    if (kind === 'infinite') d.startedAt = Infinity;
    if (kind === 'nan') d.verifiedAt = NaN;
    if (kind === 'negative') d.startedAt = -1;
    if (kind === 'unsafeInteger') d.consumedAt = Number.MAX_SAFE_INTEGER + 1;
    if (kind === 'nonNumeric') d.completedAt = privateValue;
    e.barrier = d as J.BarrierProjection;
    let error: unknown;
    try {
      J.journalEventPublicSummary(e);
    } catch (v) {
      error = v;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(privateValue);
    expect(JSON.stringify(error)).not.toContain(privateValue);
  });
  it.each(['reordered', 'omittedZero'] as const)(
    'refuses an alternate known reconciliation wire request in a coherent projected history: %s',
    (kind) => {
      const f = fixture(true),
        p = J.prepareKnownJournalReconciliation(f.state, f.native, at),
        s = commitMeta(f.state, p),
        plan = planWebTrafficReconciliation(s.raw, f.native, owner.source, at),
        { etag: _etag, ...body } = plan.request.body,
        request: J.LogicalAction = { method: 'PATCH', updateMask: 'traffic', body: copy(body) };
      const traffic = request.body.traffic as Raw[];
      if (kind === 'reordered') traffic.reverse();
      else delete traffic.find((r) => r.percent === 0)!.percent;
      const preparedHead = copy(s.head);
      preparedHead.intent!.logicalDigest = digest(request);
      const before = copy(s.raw) as Raw;
      before.annotations[J.JOURNAL_KEY] = JSON.stringify(preparedHead);
      const exactPlan = planWebTrafficReconciliation(before, f.native, owner.source, at),
        packet: J.KnownHandoffPacket = {
          simulationOnly: true,
          mutationAuthorized: false,
          origin: owner,
          headDigest: digest(preparedHead),
          observedAt: at,
          knownPlan: exactPlan,
        };
      const after = bump(before);
      after.traffic = copy(traffic);
      after.trafficStatuses = exactPlan.request.body.traffic.map((r) => ({
        ...r,
        uri: `https://${r.tag}---assistant-web-3gimfiaifa-uw.a.run.app`,
      }));
      const r: J.SimulatedResolution = {
          before,
          after,
          request,
          boundOperation: op,
          completion: completed,
          knownEvidence: { packet, native: f.native },
        },
        preparedEvent = event(before, preparedHead),
        doneHead: J.Head = {
          ...copy(preparedHead),
          sequence: preparedHead.sequence + 1,
          parent: digest(preparedHead),
          previousArchive: { id: preparedEvent.archive.id, digest: preparedEvent.archive.digest },
          status: 'complete',
        },
        doneRaw = bump(after, {
          ...(after.annotations as Record<string, string>),
          [J.JOURNAL_KEY]: JSON.stringify(doneHead),
        }),
        events = [s.history[0]!, preparedEvent, event(doneRaw, doneHead, r)];
      expect(() => J.validateSimulatedHistory(doneRaw, s.anchor, events, now)).toThrow();
    },
  );
});
