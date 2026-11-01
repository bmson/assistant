import { describe, expect, it } from 'vitest';
import {
  executeOwnedWebTagRetirement,
  HISTORICAL_WEB_TAGS,
  planOwnedWebTagRetirement,
  type RetirementIO,
  verifyOwnedWebTagRetirement,
  WEB_SERVICE,
} from './owner-web-tag-retirement.js';

function fixture(absent = false) {
  const old = HISTORICAL_WEB_TAGS[0],
    current = HISTORICAL_WEB_TAGS[1];
  if (!old || !current) throw new Error('Fixture proof missing');
  const makeRevision = (p: typeof old) => ({
    name: `${WEB_SERVICE}/revisions/${p.revision}`,
    serviceAccount: 'runtime@bmson-assistant.iam.gserviceaccount.com',
    timeout: '300s',
    containers: [
      {
        image: p.image,
        env: [
          { name: 'ASSISTANT_RELEASE_WRITES_PAUSED', value: 'false' },
          { name: 'PRIVATE', value: 'private-do-not-publish' },
        ],
      },
    ],
  });
  const native = { [old.revision]: makeRevision(old), [current.revision]: makeRevision(current) };
  const desired = [
    ...(absent
      ? []
      : [
          { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: old.revision, tag: old.tag },
        ]),
    {
      type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
      revision: current.revision,
      tag: current.tag,
      percent: 100,
    },
  ];
  const uri = (tag: string) => `https://${tag}---assistant-web-3gimfiaifa-uw.a.run.app`;
  const service = {
    name: WEB_SERVICE,
    uid: 'service-uid',
    etag: 'etag-one',
    generation: '1',
    observedGeneration: '1',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    template: {
      serviceAccount: 'runtime@bmson-assistant.iam.gserviceaccount.com',
      containers: [
        { image: current.image, env: [{ name: 'PRIVATE', value: 'private-do-not-publish' }] },
      ],
    },
    labels: { deployment: 'unchanged' },
    traffic: desired,
    trafficStatuses: desired.map((t) => ({ ...t, uri: uri(t.tag) })),
  };
  const expected = {
    revision: current.revision,
    image: current.image,
    tag: current.tag,
    uriSha256: current.uriSha256,
    paused: false,
  };
  return { old, current, native, service, expected };
}
describe('exact proven legacy web tag retirement', () => {
  it('plans only traffic+etag, dropping exact old zero row and retaining current100/config', () => {
    const f = fixture(),
      plan = planOwnedWebTagRetirement(f.service, f.native, [f.old], f.expected);
    expect(plan.patch).toEqual({
      name: WEB_SERVICE,
      etag: 'etag-one',
      traffic: [f.service.traffic[1]],
    });
    expect(Object.keys(plan.patch ?? {}).sort()).toEqual(['etag', 'name', 'traffic']);
    expect(JSON.stringify(plan)).not.toContain('private-do-not-publish');
    const after = {
      ...f.service,
      etag: 'etag-two',
      generation: '2',
      observedGeneration: '2',
      traffic: plan.patch?.traffic,
      trafficStatuses: f.service.trafficStatuses.filter((r) => r.tag !== f.old.tag),
    };
    expect(verifyOwnedWebTagRetirement(after, plan)).toMatchObject({
      outcome: 'exact_tags_absent_current_unchanged',
      editingAuthorized: false,
    });
  });
  it.each([
    'wrongTag',
    'reassignedRevision',
    'activeOld',
    'specMismatch',
    'reconciling',
    'generation',
    'missingEtag',
    'wrongOldImage',
    'unknownTimeout',
    'longTimeout',
    'currentTemplate',
    'operatorTag',
  ] as const)('rejects %s without producing a patch', (kind) => {
    const f = fixture();
    const oldRow = f.service.traffic[0],
      oldStatus = f.service.trafficStatuses[0],
      oldRevision = f.native[f.old.revision];
    if (!oldRow || !oldStatus || !oldRevision) throw new Error('Fixture row missing');
    if (kind === 'wrongTag' || kind === 'operatorTag') {
      oldRow.tag = 'operator-owned';
      oldStatus.tag = 'operator-owned';
    }
    if (kind === 'reassignedRevision') {
      oldRow.revision = 'assistant-web-other';
      oldStatus.revision = 'assistant-web-other';
    }
    if (kind === 'activeOld') {
      oldRow.percent = 1;
      oldStatus.percent = 1;
    }
    if (kind === 'specMismatch') oldStatus.percent = 50;
    if (kind === 'reconciling') Object.assign(f.service, { reconciling: true });
    if (kind === 'generation') f.service.observedGeneration = '0';
    if (kind === 'missingEtag') f.service.etag = '';
    if (kind === 'wrongOldImage') {
      const c = oldRevision.containers[0];
      if (c) c.image = 'registry/foreign';
    }
    if (kind === 'unknownTimeout') oldRevision.timeout = '';
    if (kind === 'longTimeout') oldRevision.timeout = '601s';
    if (kind === 'currentTemplate') {
      const c = f.service.template.containers[0];
      if (c) c.image = f.old.image;
    }
    expect(() => planOwnedWebTagRetirement(f.service, f.native, [f.old], f.expected)).toThrow();
  });
  it('never retires the serving revision or accepts null/string percentages/LATEST/URI reassignment', () => {
    const f = fixture();
    expect(() => planOwnedWebTagRetirement(f.service, f.native, [f.current], f.expected)).toThrow();
    for (const percent of [null, '0']) {
      const raw = structuredClone(f.service);
      Object.assign(raw.traffic[0] ?? {}, { percent });
      Object.assign(raw.trafficStatuses[0] ?? {}, { percent });
      expect(() => planOwnedWebTagRetirement(raw, f.native, [f.old], f.expected)).toThrow();
    }
    const latest = structuredClone(f.service);
    Object.assign(latest.traffic[0] ?? {}, { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' });
    expect(() => planOwnedWebTagRetirement(latest, f.native, [f.old], f.expected)).toThrow();
    const uri = structuredClone(f.service);
    Object.assign(uri.trafficStatuses[0] ?? {}, { uri: 'https://foreign.run.app' });
    expect(() => planOwnedWebTagRetirement(uri, f.native, [f.old], f.expected)).toThrow();
  });
  it('requires fresh same-bound state for already-absent, including native old timeout', () => {
    const f = fixture(true),
      plan = planOwnedWebTagRetirement(f.service, f.native, [f.old], f.expected);
    expect(plan).toMatchObject({ action: 'already_absent', patch: null, drainSeconds: 600 });
    const oldRevision = f.native[f.old.revision];
    if (oldRevision) oldRevision.timeout = '';
    expect(() => planOwnedWebTagRetirement(f.service, f.native, [f.old], f.expected)).toThrow();
  });
  it('checks all unrelated configuration and current tag after the operation', () => {
    const f = fixture(),
      plan = planOwnedWebTagRetirement(f.service, f.native, [f.old], f.expected);
    for (const field of ['labels', 'template', 'uid', 'currentTag']) {
      const after = {
        ...structuredClone(f.service),
        traffic: plan.patch?.traffic,
        trafficStatuses: f.service.trafficStatuses.filter((r) => r.tag !== f.old.tag),
      };
      if (field === 'labels') after.labels.deployment = 'changed';
      if (field === 'template') after.template.serviceAccount = 'other';
      if (field === 'uid') after.uid = 'other-service';
      if (field === 'currentTag')
        Object.assign(after.trafficStatuses[0] ?? {}, { tag: 'operator-new' });
      expect(() => verifyOwnedWebTagRetirement(after, plan)).toThrow();
    }
  });
  it.each([false, true])(
    'always drains after postcheck, including already absent=%s recovery',
    async (absent) => {
      const f = fixture(absent),
        plan = planOwnedWebTagRetirement(f.service, f.native, [f.old], f.expected),
        events: string[] = [];
      let state: unknown = f.service;
      const io: RetirementIO = {
        readService: async () => {
          events.push('read');
          return state;
        },
        readRevision: async (name) => f.native[name],
        patchTraffic: async (body) => {
          events.push('patch');
          expect(body.etag).toBe('etag-one');
          state = {
            ...f.service,
            etag: 'etag-two',
            generation: '2',
            observedGeneration: '2',
            traffic: body.traffic,
            trafficStatuses: f.service.trafficStatuses.filter((r) => r.tag !== f.old.tag),
          };
          return { name: 'operation' };
        },
        waitOperation: async () => {
          events.push('poll');
        },
        drain: async (seconds) => {
          events.push(`drain:${seconds}`);
        },
      };
      const result = await executeOwnedWebTagRetirement(plan, io);
      expect(result).toMatchObject({
        drainCompleted: true,
        drainSeconds: 600,
        editingAuthorized: false,
      });
      expect(events).toEqual(
        absent
          ? ['read', 'read', 'drain:600', 'read']
          : ['read', 'patch', 'poll', 'read', 'drain:600', 'read'],
      );
    },
  );
  it.each(['etag', 'generation', 'restoreThenRemove'] as const)(
    'rejects %s drift during an already-absent drain even when final traffic/config match',
    async (kind) => {
      const f = fixture(true);
      const plan = planOwnedWebTagRetirement(f.service, f.native, [f.old], f.expected);
      let state = structuredClone(f.service);
      const events: string[] = [];
      const io: RetirementIO = {
        readService: async () => structuredClone(state),
        readRevision: async (name) => f.native[name],
        patchTraffic: async () => {
          throw new Error('Already-absent path must not PATCH');
        },
        waitOperation: async () => {},
        drain: async (seconds) => {
          expect(seconds).toBe(600);
          if (kind === 'restoreThenRemove') {
            const before = structuredClone(state);
            state.traffic.push({
              type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
              revision: f.old.revision,
              tag: f.old.tag,
            });
            events.push('external-restore');
            state = before;
            state.etag = 'etag-after-external-remove';
            state.generation = '3';
            state.observedGeneration = '3';
            events.push('external-remove');
          } else if (kind === 'etag') state.etag = 'etag-changed';
          else {
            state.generation = '2';
            state.observedGeneration = '2';
          }
          // The prior final-state-only check would accept this exact traffic/config.
          expect(() => verifyOwnedWebTagRetirement(state, plan)).not.toThrow();
        },
      };
      await expect(executeOwnedWebTagRetirement(plan, io)).rejects.toThrow(
        'Service version changed',
      );
      if (kind === 'restoreThenRemove')
        expect(events).toEqual(['external-restore', 'external-remove']);
    },
  );
  it.each(['stale', 'casConflict', 'uncertainPatch', 'badPost', 'drainFailure'] as const)(
    'stops on %s without retry or alias restoration/admission',
    async (kind) => {
      const f = fixture(),
        plan = planOwnedWebTagRetirement(f.service, f.native, [f.old], f.expected);
      let patches = 0,
        drains = 0,
        reads = 0;
      const io: RetirementIO = {
        readService: async () => {
          reads++;
          return kind === 'stale' ? { ...f.service, etag: 'other' } : f.service;
        },
        readRevision: async (name) => f.native[name],
        patchTraffic: async () => {
          patches++;
          if (kind === 'casConflict' || kind === 'uncertainPatch')
            throw new Error('Fixed native failure');
          return {};
        },
        waitOperation: async () => {},
        drain: async () => {
          drains++;
          if (kind === 'drainFailure') throw new Error('Fixed drain failure');
        },
      };
      if (kind === 'drainFailure')
        io.readService = async () => {
          reads++;
          return reads === 1
            ? f.service
            : {
                ...f.service,
                traffic: plan.patch?.traffic,
                trafficStatuses: f.service.trafficStatuses.filter((r) => r.tag !== f.old.tag),
              };
        };
      await expect(executeOwnedWebTagRetirement(plan, io)).rejects.toThrow();
      expect(patches).toBe(kind === 'stale' ? 0 : 1);
      expect(drains).toBe(kind === 'drainFailure' ? 1 : 0);
    },
  );
});
