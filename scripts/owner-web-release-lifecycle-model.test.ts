// biome-ignore-all lint/style/noNonNullAssertion: Fixed synthetic fixtures populate each referenced row.
import { describe, expect, it } from 'vitest';
import {
  acceptAgentReady,
  acceptAlreadyPausedRecovery,
  acceptCapturedRetirement,
  acceptUnattachedRDrain,
  beginCapturedRetirement,
  beginLifecycleAttempt,
  bindCapturedRetirementOperation,
  bindLifecycleOperation,
  type Context,
  captureLifecycle,
  creationTemplate,
  type Mode,
  planLifecycleAction,
  releaseIdentity,
  type Snapshot,
  type State,
  settleLifecycleAttempt,
  unknownCapturedRetirement,
  unknownLifecycleOutcome,
} from './owner-web-release-lifecycle-model.js';
import { WEB_SERVICE } from './owner-web-tag-retirement.js';
import { reconciliationDigest as digest } from './owner-web-traffic-reconciliation-model.js';

const secret = 'DO_NOT_LOG_NATIVE_SECRET_REFERENCE';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const operation = 'projects/bmson-assistant/locations/us-west1/operations/fixed-1';
const completed = (name = operation) => ({ name, done: true, responseService: WEB_SERVICE });
function fixture() {
  const c: Context = {
    source: 'a'.repeat(40),
    runId: '123456',
    attempt: '1',
    manifest: 'b'.repeat(64),
    image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'c'.repeat(64)}`,
    canonical: 'assistant-web-current',
    retiredTags: ['resume-111-1'],
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
  const template = {
    revision: c.canonical,
    serviceAccount: 'runtime@bmson-assistant.iam.gserviceaccount.com',
    timeout: '300s',
    scaling: { minInstanceCount: 1 },
    containers: [
      {
        image: c.image,
        env: [{ name: 'PRIVATE', valueSource: { secretKeyRef: { secret, version: '1' } } }],
        resources: { limits: { cpu: '1', memory: '512Mi' } },
      },
    ],
    vpcAccess: { connector: 'private-network' },
  };
  const traffic = [
    {
      type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' as const,
      revision: c.canonical,
      tag: 'resume-999-1',
      percent: 100,
    },
  ];
  const s: Snapshot = {
    name: WEB_SERVICE,
    uid: 'service-uid',
    etag: 'etag-1',
    generation: '1',
    observedGeneration: '1',
    reconciling: false,
    succeeded: true,
    desired: traffic,
    observed: clone(traffic),
    latestReady: c.canonical,
    latestCreated: c.canonical,
    template,
    stableConfigSha256: digest('config'),
    rootUriSha256: digest('root'),
    tagUris: { 'resume-999-1': digest('Curi') },
    urls: [digest('root'), digest('Curi')],
    revisions: {
      [c.canonical]: {
        uid: digest('Cuid'),
        image: c.image,
        source: 'd'.repeat(40),
        runId: '999',
        attempt: '1',
        manifest: 'e'.repeat(64),
        paused: false,
        templateSha256: digest(template),
      },
    },
  };
  return captureLifecycle(c, s);
}
function post(s: State, mode: Mode): Snapshot {
  const p = planLifecycleAction(s, mode),
    a = clone(s.snapshot);
  a.etag += `-${mode}`;
  a.generation = String(BigInt(a.generation) + 1n);
  a.observedGeneration = a.generation;
  a.desired = clone(p.expectedTraffic);
  a.observed = clone(a.desired);
  if (mode === 'createP' || mode === 'createR') {
    const role = mode === 'createP' ? 'P' : 'R',
      id = releaseIdentity(s.context, role);
    a.template = clone(p.request.body.template as Record<string, unknown>);
    a.latestReady = id.revision;
    a.latestCreated = id.revision;
    a.revisions[id.revision] = {
      uid: digest(id.revision),
      image: s.context.image,
      source: s.context.source,
      runId: s.context.runId,
      attempt: s.context.attempt,
      manifest: s.context.manifest,
      paused: role === 'P',
      templateSha256: p.templateSha256,
    };
  }
  const tags = a.desired.map((t) => t.tag).filter(Boolean);
  a.tagUris = Object.fromEntries(tags.map((t) => [t, a.tagUris[t] ?? digest(t)]));
  a.urls = [a.rootUriSha256, ...Object.values(a.tagUris)];
  return a;
}
function step(s: State, mode: Mode) {
  const after = post(s, mode);
  return settleLifecycleAttempt(
    bindLifecycleOperation(beginLifecycleAttempt(s, planLifecycleAction(s, mode)), operation),
    completed(),
    after,
  );
}
function paused() {
  return step(step(step(fixture(), 'createP'), 'attachP'), 'promoteP');
}
function retired(overrides: Record<string, unknown> = {}) {
  const s = bindCapturedRetirementOperation(beginCapturedRetirement(paused()), operation),
    a = clone(s.snapshot),
    p = releaseIdentity(s.context, 'P');
  a.desired = a.desired.filter((t) => t.tag === p.tag);
  a.observed = clone(a.desired);
  a.tagUris = { [p.tag]: a.tagUris[p.tag]! };
  a.urls = [a.rootUriSha256, ...Object.values(a.tagUris)];
  a.etag += '-retired';
  a.generation = String(BigInt(a.generation) + 1n);
  a.observedGeneration = a.generation;
  return acceptCapturedRetirement(s, a, {
    source: s.context.source,
    runId: s.context.runId,
    attempt: s.context.attempt,
    manifest: s.context.manifest,
    beforeReceipt: s.receipt,
    serviceUid: a.uid,
    etag: a.etag,
    generation: a.generation,
    drainSeconds: 600,
    drainCompleted: true,
    operation,
    ...overrides,
  });
}
function agentReady() {
  const s = retired();
  return acceptAgentReady(s, {
    beforeReceipt: s.receipt,
    agentProofSha256: digest('agent'),
    stableEtag: s.snapshot.etag,
    stableGeneration: s.snapshot.generation,
  });
}
function resumed() {
  return step(step(step(agentReady(), 'createR'), 'attachR'), 'promoteR');
}
describe('source-only lifecycle model', () => {
  it('completes ordered exact creation/attachment/promotion/retirement/resume/cleanup', () => {
    const s = step(resumed(), 'closeP');
    expect(s.phase).toBe('complete');
    expect(s.admissionPossible).toBe(true);
    expect(s.pending).toBeNull();
    expect(s.retiredTags).toContain('resume-999-1');
    expect(s.retiredTags).toContain(releaseIdentity(s.context, 'P').tag);
    expect(s.snapshot.desired).toHaveLength(1);
    expect(s.snapshot.desired[0]?.tag).toBe(releaseIdentity(s.context, 'R').tag);
  });
  it('uses deterministic run/source revision identities and exact template-only mask', () => {
    const s = fixture(),
      p = planLifecycleAction(s, 'createP');
    expect(releaseIdentity(s.context, 'P')).toEqual(releaseIdentity(clone(s.context), 'P'));
    expect(p.request.updateMask).toBe('template');
    expect(Object.keys(p.request.body).sort()).toEqual(['etag', 'name', 'template']);
    expect(p.expectedTraffic).toEqual(s.snapshot.desired);
    expect((p.request.body.template as Record<string, unknown>).revision).toBe(
      releaseIdentity(s.context, 'P').revision,
    );
  });
  it('preserves every unrelated template field and private secret reference', () => {
    const s = fixture(),
      t = creationTemplate(s.snapshot.template, s.context, 'P');
    expect(t.vpcAccess).toEqual(s.snapshot.template.vpcAccess);
    expect(t.scaling).toEqual(s.snapshot.template.scaling);
    expect(t.serviceAccount).toEqual(s.snapshot.template.serviceAccount);
    const container = (t.containers as Record<string, unknown>[])[0]!;
    expect(JSON.stringify(container.env)).toContain(secret);
    expect(container.resources).toEqual(
      (s.snapshot.template.containers as Record<string, unknown>[])[0]!.resources,
    );
    expect(
      JSON.stringify({ receipt: s.receipt, planDigest: digest(planLifecycleAction(s, 'createP')) }),
    ).not.toContain(secret);
  });
  it('records admissionPossible before createR attempt, even without any new tag', () => {
    const s = agentReady(),
      a = beginLifecycleAttempt(s, planLifecycleAction(s, 'createR'));
    expect(s.admissionPossible).toBe(false);
    expect(a.admissionPossible).toBe(true);
    expect(a.snapshot.desired).toHaveLength(1);
  });
  it('retains unknown create with no operation identity and forbids retry/adoption/rollback', () => {
    const s = agentReady(),
      plan = planLifecycleAction(s, 'createR'),
      a = unknownLifecycleOutcome(beginLifecycleAttempt(s, plan));
    expect(a.pending?.outcome).toBe('unknown');
    expect(a.admissionPossible).toBe(true);
    expect(() => beginLifecycleAttempt(a, plan)).toThrow();
    expect(() => planLifecycleAction(a, 'restoreC')).toThrow();
    expect(() => settleLifecycleAttempt(a, completed(), post(s, 'createR'))).toThrow();
  });
  it('allows readback recovery only through the original bound operation and exact deterministic revision', () => {
    const s = agentReady(),
      a = unknownLifecycleOutcome(
        bindLifecycleOperation(
          beginLifecycleAttempt(s, planLifecycleAction(s, 'createR')),
          operation,
        ),
      );
    expect(() =>
      settleLifecycleAttempt(a, completed(`${operation}other`), post(s, 'createR')),
    ).toThrow();
    expect(settleLifecycleAttempt(a, completed(), post(s, 'createR')).phase).toBe('createdR');
    expect(a.admissionPossible).toBe(true);
  });
  it('requires strict recording after attachment, not immediately after creation', () => {
    const s = step(fixture(), 'createP');
    expect(s.snapshot.tagUris[releaseIdentity(s.context, 'P').tag]).toBeUndefined();
    expect(() => planLifecycleAction(s, 'promoteP')).toThrow();
    const a = step(s, 'attachP');
    expect(a.phase).toBe('attachedP');
    expect(
      a.snapshot.desired.find((t) => t.tag === releaseIdentity(s.context, 'P').tag)?.percent,
    ).toBe(0);
  });
  it('restores C without recreating retired aliases', () => {
    const s = retired(),
      a = step(s, 'restoreC');
    expect(a.snapshot.desired.find((t) => t.percent === 100)).toMatchObject({
      revision: s.context.canonical,
      tag: '',
    });
    expect(a.snapshot.tagUris['resume-999-1']).toBeUndefined();
    expect(a.retiredTags).toEqual(s.retiredTags);
  });
  it('restores retained C tag before retirement without inventing a duplicate row', () => {
    const s = paused(),
      a = step(s, 'restoreC');
    expect(a.snapshot.desired.find((t) => t.percent === 100)?.tag).toBe('resume-999-1');
    expect(a.snapshot.desired).toHaveLength(2);
  });
  it('retains admission and tombstones through repause/closure and never permits old runtime rollback', () => {
    const s = resumed();
    expect(() => planLifecycleAction(s, 'restoreC')).toThrow();
    const p = step(s, 'repauseP'),
      a = step(p, 'closeR');
    expect(a.phase).toBe('closedR');
    expect(a.admissionPossible).toBe(true);
    expect(a.retiredTags).toContain(releaseIdentity(s.context, 'R').tag);
    expect(a.snapshot.desired[0]?.tag).toBe(releaseIdentity(s.context, 'P').tag);
  });
  it('uses read-only confirmation when R exists without an attached alias, then requires drain evidence', () => {
    const s = step(agentReady(), 'createR');
    expect(() => planLifecycleAction(s, 'repauseP')).toThrow();
    const p = acceptAlreadyPausedRecovery(s, clone(s.snapshot));
    expect(() => planLifecycleAction(p, 'closeR')).toThrow();
    expect(
      acceptUnattachedRDrain(p, {
        beforeReceipt: p.receipt,
        revision: releaseIdentity(p.context, 'R').revision,
        drainSeconds: 600,
        drainCompleted: true,
      }).phase,
    ).toBe('closedR');
  });
  it('confirms already-paused attached R without a redundant traffic write, then closes only R', () => {
    const s = step(step(agentReady(), 'createR'), 'attachR');
    const p = acceptAlreadyPausedRecovery(s, clone(s.snapshot));
    expect(step(p, 'closeR').phase).toBe('closedR');
  });
  it.each([
    'etag',
    'generation',
    'observedGeneration',
    'uid',
    'config',
    'root',
    'desired',
    'observed',
    'template',
    'latest',
    'image',
    'source',
    'run',
    'manifest',
    'pause',
    'nativeUid',
    'oldAliasUri',
    'newAlias',
    'newRevision',
  ] as const)('holds adversarial creation postcheck: %s', (kind) => {
    const s = fixture(),
      a = post(s, 'createP'),
      id = releaseIdentity(s.context, 'P'),
      native = a.revisions[id.revision]!;
    if (kind === 'etag') a.etag = s.snapshot.etag;
    if (kind === 'generation') a.generation = s.snapshot.generation;
    if (kind === 'observedGeneration') a.observedGeneration = '999';
    if (kind === 'uid') a.uid = 'other';
    if (kind === 'config') a.stableConfigSha256 = digest('different');
    if (kind === 'root') a.rootUriSha256 = digest('different');
    if (kind === 'desired') a.desired[0]!.percent = 0;
    if (kind === 'observed') a.observed[0]!.percent = 0;
    if (kind === 'template') a.template.timeout = '599s';
    if (kind === 'latest') a.latestReady = s.context.canonical;
    if (kind === 'image')
      native.image = s.snapshot.revisions[s.context.canonical]!.image.replace(/.$/, 'd');
    if (kind === 'source') native.source = 'f'.repeat(40);
    if (kind === 'run') native.runId = '7';
    if (kind === 'manifest') native.manifest = 'f'.repeat(64);
    if (kind === 'pause') native.paused = false;
    if (kind === 'nativeUid') a.revisions[s.context.canonical]!.uid = digest('changed');
    if (kind === 'oldAliasUri') {
      a.tagUris['resume-999-1'] = digest('changed');
      a.urls = [a.rootUriSha256, ...Object.values(a.tagUris)];
    }
    if (kind === 'newAlias') {
      a.tagUris[id.tag] = digest('unexpected');
      a.urls.push(digest('unexpected'));
    }
    if (kind === 'newRevision') a.latestReady = a.latestCreated = 'assistant-web-unplanned';
    const attempt = bindLifecycleOperation(
      beginLifecycleAttempt(s, planLifecycleAction(s, 'createP')),
      operation,
    );
    expect(() => settleLifecycleAttempt(attempt, completed(), a)).toThrow();
  });
  it.each(['mask', 'body', 'before', 'receipt', 'afterTraffic'] as const)(
    'refuses a forged plan: %s',
    (kind) => {
      const s = fixture(),
        p = planLifecycleAction(s, 'createP');
      if (kind === 'mask') p.request.updateMask = 'traffic';
      if (kind === 'body') p.request.body.traffic = [];
      if (kind === 'before') p.beforeSha256 = digest('wrong');
      if (kind === 'receipt') p.priorReceipt = digest('wrong');
      if (kind === 'afterTraffic') p.expectedTraffic = [];
      expect(() => beginLifecycleAttempt(s, p)).toThrow();
    },
  );
  it.each([
    'extraEnv',
    'duplicateEnv',
    'wrongSource',
    'wrongManifest',
    'wrongDriver',
    'wrongTarget',
    'forbiddenTag',
    'tooManyContainers',
  ] as const)('refuses unbounded/foreign template context: %s', (kind) => {
    const s = fixture();
    if (kind === 'extraEnv') s.context.releaseEnv.PRIVATE = 'replace';
    if (kind === 'duplicateEnv')
      (s.snapshot.template.containers as { env: unknown[] }[])[0]!.env.push({
        name: 'PRIVATE',
        value: 'overwrite',
      });
    if (kind === 'wrongSource') s.context.releaseEnv.ASSISTANT_RELEASE_SOURCE_SHA = 'f'.repeat(40);
    if (kind === 'wrongManifest') s.context.releaseEnv.ASSISTANT_RELEASE_MANIFEST = 'f'.repeat(64);
    if (kind === 'wrongDriver') s.context.releaseEnv.ASSISTANT_RELEASE_SCHEMA_DRIVER = 'postgres';
    if (kind === 'wrongTarget') s.context.image = `elsewhere@sha256:${'a'.repeat(64)}`;
    if (kind === 'forbiddenTag') s.context.retiredTags.push(releaseIdentity(s.context, 'P').tag);
    if (kind === 'tooManyContainers') (s.snapshot.template.containers as unknown[]).push({});
    expect(() => planLifecycleAction(s, 'createP')).toThrow();
  });
  it.each(['shortDrain', 'wrongEtag', 'foreignRun', 'wrongReceipt'] as const)(
    'refuses invalid external retirement/agent evidence: %s',
    (kind) => {
      const s = retired(),
        e = {
          beforeReceipt: s.receipt,
          agentProofSha256: digest('agent'),
          stableEtag: s.snapshot.etag,
          stableGeneration: s.snapshot.generation,
        };
      if (kind === 'shortDrain') e.stableGeneration = '999';
      if (kind === 'wrongEtag') e.stableEtag = 'foreign';
      if (kind === 'foreignRun') e.agentProofSha256 = 'invalid';
      if (kind === 'wrongReceipt') e.beforeReceipt = 'invalid';
      expect(() => acceptAgentReady(s, e)).toThrow();
    },
  );
  it('does not mutate prior receipts/snapshots or permit a second same-stage attempt', () => {
    const s = fixture(),
      original = clone(s),
      a = step(s, 'createP');
    expect(s).toEqual(original);
    expect(() => planLifecycleAction(a, 'createP')).toThrow();
  });
  it('refuses provider operations outside the fixed service region', () => {
    const s = fixture(),
      a = beginLifecycleAttempt(s, planLifecycleAction(s, 'createP'));
    expect(() =>
      bindLifecycleOperation(a, 'projects/other/locations/us-west1/operations/x'),
    ).toThrow();
  });
});

describe('retirement uncertainty and monotonic tombstones', () => {
  it.each([
    ['drainSeconds', 599],
    ['drainCompleted', false],
    ['runId', 'other'],
    ['etag', 'stale'],
    ['operation', `${operation}other`],
  ])('holds bad external retirement evidence %s', (key, value) => {
    expect(() => retired({ [String(key)]: value })).toThrow();
  });
  it('keeps attempted retired aliases forbidden and blocks all new actions on uncertain retirement', () => {
    const s = unknownCapturedRetirement(beginCapturedRetirement(paused()));
    expect(s.retiredTags).toContain('resume-999-1');
    expect(() => planLifecycleAction(s, 'restoreC')).toThrow();
    expect(() => beginCapturedRetirement(s)).toThrow();
  });
  it('marks a closing alias forbidden before PATCH, including a lost response', () => {
    const s = resumed(),
      a = unknownLifecycleOutcome(beginLifecycleAttempt(s, planLifecycleAction(s, 'closeP')));
    expect(a.retiredTags).toContain(releaseIdentity(s.context, 'P').tag);
    expect(() => planLifecycleAction(a, 'repauseP')).toThrow();
  });
});

describe('same-operation terminal evidence', () => {
  it.each(['unfinished', 'error', 'wrongService'])('holds incomplete/failed LRO %s', (kind) => {
    const s = fixture(),
      a = bindLifecycleOperation(
        beginLifecycleAttempt(s, planLifecycleAction(s, 'createP')),
        operation,
      ),
      e: { name: string; done: boolean; responseService: string; error?: unknown } = completed();
    if (kind === 'unfinished') e.done = false;
    if (kind === 'error') e.error = { private: secret };
    if (kind === 'wrongService') e.responseService = 'projects/elsewhere/services/other';
    expect(() => settleLifecycleAttempt(a, e, post(s, 'createP'))).toThrow(
      'Web lifecycle model held',
    );
  });
});
