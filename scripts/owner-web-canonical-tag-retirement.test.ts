import { describe, expect, it, vi } from 'vitest';
import { nativeRetirementClient } from './owner-web-tag-native.js';
import {
  canonicalCurrentWebRevision,
  executeOwnedWebTagRetirement,
  HISTORICAL_WEB_TAGS,
  observeCanonicalCurrentWeb,
  planOwnedWebTagRetirement,
  type RetirementIO,
  verifyOwnedWebTagRetirement,
  WEB_CANONICAL_URL,
  WEB_SERVICE,
} from './owner-web-tag-retirement.js';

function fixture(absent = false) {
  const proof = HISTORICAL_WEB_TAGS[1];
  if (!proof) throw new Error('Missing historical proof');
  const current = 'assistant-web-reviewed-current';
  const image = `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'e'.repeat(64)}`;
  const account = 'assistant-web@bmson-assistant.iam.gserviceaccount.com';
  const makeRevision = (revision: string, image: string, source: string) => ({
    name: `${WEB_SERVICE}/revisions/${revision}`,
    service: WEB_SERVICE,
    uid: `${revision}-uid`,
    serviceAccount: account,
    timeout: '300s',
    conditions: [{ state: 'CONDITION_SUCCEEDED' }],
    containers: [
      {
        image,
        env: [
          { name: 'ASSISTANT_RELEASE_WRITES_PAUSED', value: 'false' },
          { name: 'ASSISTANT_RELEASE_SOURCE_SHA', value: source },
          { name: 'PRIVATE', value: 'private-do-not-publish' },
        ],
      },
    ],
  });
  const currentNative = makeRevision(current, image, 'a'.repeat(40));
  const historicalNative = makeRevision(proof.revision, proof.image, proof.source);
  const traffic: Record<string, unknown>[] = [
    ...(!absent
      ? [
          {
            type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
            revision: proof.revision,
            tag: proof.tag,
          },
        ]
      : []),
    { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: current, percent: 100 },
  ];
  const trafficStatuses: Record<string, unknown>[] = traffic.map((row) => ({
    ...row,
    ...(row.tag ? { uri: `https://${proof.tag}---assistant-web-3gimfiaifa-uw.a.run.app` } : {}),
  }));
  const service = {
    name: WEB_SERVICE,
    uid: 'fixed-service-uid',
    uri: WEB_CANONICAL_URL,
    etag: 'before-etag',
    generation: '8',
    observedGeneration: '8',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    latestCreatedRevision: current,
    latestReadyRevision: current,
    labels: { preserve: 'unchanged' },
    template: { serviceAccount: account, containers: structuredClone(currentNative.containers) },
    traffic,
    trafficStatuses,
  };
  const native: Record<string, unknown> = {
    [current]: currentNative,
    [proof.revision]: historicalNative,
  };
  return { service, native, current, currentNative, historicalNative, proof };
}

function plan(f: ReturnType<typeof fixture>) {
  return planOwnedWebTagRetirement(
    f.service,
    f.native,
    [f.proof],
    observeCanonicalCurrentWeb(f.service, f.currentNative),
  );
}

function retiredState(f: ReturnType<typeof fixture>) {
  return {
    ...structuredClone(f.service),
    etag: 'after-etag',
    generation: '9',
    observedGeneration: '9',
    traffic: f.service.traffic.filter((row) => row.tag !== f.proof.tag),
    trafficStatuses: f.service.trafficStatuses.filter((row) => row.tag !== f.proof.tag),
  };
}

describe('fixed historical alias beside canonical untagged traffic', () => {
  it('removes only the proven zero-percent alias and retains the exact current100 row', () => {
    const f = fixture();
    const approved = plan(f);
    expect(canonicalCurrentWebRevision(f.service)).toBe(f.current);
    expect(approved.patch).toEqual({
      name: WEB_SERVICE,
      etag: f.service.etag,
      traffic: [f.service.traffic.at(-1)],
    });
    expect(approved.current).toMatchObject({
      binding: 'canonical-untagged',
      revision: f.current,
      image: f.currentNative.containers[0]?.image,
      releaseSource: 'a'.repeat(40),
      tag: '',
      paused: false,
    });
    expect(Object.keys(approved.nativeRevisionSha256 ?? {}).sort()).toEqual(
      [f.current, f.proof.revision].sort(),
    );
    expect(JSON.stringify(approved)).not.toContain('private-do-not-publish');
    expect(verifyOwnedWebTagRetirement(retiredState(f), approved)).toMatchObject({
      currentRevision: f.current,
      outcome: 'exact_tags_absent_current_unchanged',
      editingAuthorized: false,
    });
  });

  it('preserves a paused current revision instead of silently unpausing application writes', () => {
    const f = fixture();
    const pause = f.currentNative.containers[0]?.env.find(
      (row) => row.name === 'ASSISTANT_RELEASE_WRITES_PAUSED',
    );
    if (!pause) throw new Error('Missing pause');
    pause.value = 'true';
    f.service.template.containers = structuredClone(f.currentNative.containers);
    expect(plan(f).current.paused).toBe(true);
    expect(plan(f).patch).not.toHaveProperty('template');
  });

  it('accepts the exact provider leaf service alias only alongside the full matching revision identity', () => {
    const f = fixture();
    f.currentNative.service = 'assistant-web';
    expect(plan(f).current.revision).toBe(f.current);
    f.currentNative.service = 'projects/other/locations/us-west1/services/assistant-web';
    expect(() => plan(f)).toThrow();
  });

  it('requires literal, agreeing source aliases and rejects conflicting deployment metadata', () => {
    const f = fixture();
    const env = f.currentNative.containers[0]?.env;
    const source = env?.find((row) => row.name === 'ASSISTANT_RELEASE_SOURCE_SHA');
    if (!env || !source) throw new Error('Missing source');
    source.name = 'RELEASE_SHA';
    expect(plan(f).current.releaseSource).toBe(source.value);
    env.push({ ...source, name: 'ASSISTANT_RELEASE_SOURCE_SHA' });
    expect(plan(f).current.releaseSource).toBe(source.value);
    env.push({ name: 'RELEASE_SHA', value: 'f'.repeat(40) });
    expect(() => plan(f)).toThrow();
  });

  it.each([
    'wrongService',
    'taggedCurrent',
    'latestCandidate',
    'unknownAlias',
    'activeAlias',
    'reassignedAlias',
    'changedAliasUri',
    'unsettled',
    'unobserved',
    'missingEtag',
    'wrongCurrentImage',
    'wrongCurrentAccount',
    'wrongCurrentService',
    'nonliteralService',
    'missingCurrentUid',
    'notReady',
    'badSource',
    'secretSource',
    'legacySecretSource',
    'duplicateSource',
    'oldTimeout',
    'oldImage',
    'oldSource',
  ])('rejects %s without producing a patch', (kind) => {
    const f = fixture();
    if (kind === 'wrongService') f.service.name = 'projects/other/services/assistant-web';
    if (kind === 'taggedCurrent') {
      Object.assign(f.service.traffic.at(-1) ?? {}, { tag: 'operator-current' });
      Object.assign(f.service.trafficStatuses.at(-1) ?? {}, { tag: 'operator-current' });
    }
    if (kind === 'latestCandidate') f.service.latestCreatedRevision = 'assistant-web-candidate';
    if (kind === 'unknownAlias') {
      const extra = {
        type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
        revision: 'assistant-web-operator',
        tag: 'operator',
      };
      f.service.traffic.push(extra);
      f.service.trafficStatuses.push(extra);
    }
    if (kind === 'activeAlias') {
      Object.assign(f.service.traffic[0] ?? {}, { percent: 1 });
      Object.assign(f.service.trafficStatuses[0] ?? {}, { percent: 1 });
    }
    if (kind === 'reassignedAlias') {
      Object.assign(f.service.traffic[0] ?? {}, { revision: 'assistant-web-other' });
      Object.assign(f.service.trafficStatuses[0] ?? {}, { revision: 'assistant-web-other' });
    }
    if (kind === 'changedAliasUri')
      Object.assign(f.service.trafficStatuses[0] ?? {}, { uri: 'https://foreign.run.app' });
    if (kind === 'unsettled') Object.assign(f.service, { reconciling: true });
    if (kind === 'unobserved') f.service.observedGeneration = '7';
    if (kind === 'missingEtag') f.service.etag = '';
    if (kind === 'wrongCurrentImage')
      Object.assign(f.currentNative.containers[0] ?? {}, { image: 'foreign/image' });
    if (kind === 'wrongCurrentAccount') f.currentNative.serviceAccount = 'foreign@elsewhere.test';
    if (kind === 'wrongCurrentService') f.currentNative.service = 'assistant-agent';
    if (kind === 'nonliteralService')
      Object.assign(f.currentNative, { service: ['assistant-web'] });
    if (kind === 'missingCurrentUid') f.currentNative.uid = '';
    if (kind === 'notReady') f.currentNative.conditions[0] = { state: 'CONDITION_PENDING' };
    const env = f.currentNative.containers[0]?.env;
    const source = env?.find((row) => row.name === 'ASSISTANT_RELEASE_SOURCE_SHA');
    if (!env || !source) throw new Error('Missing source');
    if (kind === 'badSource') source.value = 'unknown';
    if (kind === 'secretSource') Object.assign(source, { valueSource: { secretKeyRef: {} } });
    if (kind === 'legacySecretSource') Object.assign(source, { valueFrom: { secretKeyRef: {} } });
    if (kind === 'duplicateSource') env.push({ ...source });
    if (kind === 'oldTimeout') f.historicalNative.timeout = '601s';
    if (kind === 'oldImage')
      Object.assign(f.historicalNative.containers[0] ?? {}, {
        image: f.currentNative.containers[0]?.image,
      });
    if (kind === 'oldSource') {
      const source = f.historicalNative.containers[0]?.env.find(
        (row) => row.name === 'ASSISTANT_RELEASE_SOURCE_SHA',
      );
      if (!source) throw new Error('Missing old source');
      source.value = 'f'.repeat(40);
    }
    expect(() => plan(f)).toThrow();
  });

  it('does not allow the canonical profile to retire a different proof or ignore native/current drift', () => {
    const f = fixture();
    const expected = observeCanonicalCurrentWeb(f.service, f.currentNative);
    const otherProof = HISTORICAL_WEB_TAGS[0];
    if (!otherProof) throw new Error('Missing other proof');
    expect(() => planOwnedWebTagRetirement(f.service, f.native, [otherProof], expected)).toThrow();
    expect(() =>
      planOwnedWebTagRetirement(f.service, f.native, [f.proof], {
        ...expected,
        nativeRevisionSha256: 'f'.repeat(64),
      }),
    ).toThrow();
    const other = retiredState(f);
    other.template.serviceAccount = 'other@bmson-assistant.iam.gserviceaccount.com';
    expect(() => verifyOwnedWebTagRetirement(other, plan(f))).toThrow();
    Object.assign(other, { template: f.service.template, uri: 'https://foreign.run.app' });
    expect(() => verifyOwnedWebTagRetirement(other, plan(f))).toThrow();
  });

  it('requires an advanced post-PATCH version and unchanged already-absent state', () => {
    const f = fixture();
    const approved = plan(f);
    for (const version of [
      { etag: f.service.etag, generation: '9', observedGeneration: '9' },
      { etag: 'after-etag', generation: '8', observedGeneration: '8' },
    ])
      expect(() =>
        verifyOwnedWebTagRetirement({ ...retiredState(f), ...version }, approved),
      ).toThrow();
    const absent = fixture(true);
    expect(() => verifyOwnedWebTagRetirement(retiredState(absent), plan(absent))).toThrow();
  });

  it.each([false, true])('keeps one CAS and a full drain (%s)', async (absent) => {
    const f = fixture(absent);
    const approved = plan(f);
    let state = f.service;
    const patch = vi.fn(async (body) => {
      expect(body).toEqual(approved.patch);
      state = retiredState(f);
      return { name: 'operation' };
    });
    const drain = vi.fn(async (seconds) => {
      expect(seconds).toBe(600);
    });
    const io: RetirementIO = {
      readService: async () => state,
      readRevision: async (name) => f.native[name],
      patchTraffic: patch,
      waitOperation: async () => {},
      drain,
    };
    const result = await executeOwnedWebTagRetirement(approved, io);
    expect(patch).toHaveBeenCalledTimes(absent ? 0 : 1);
    if (!absent) expect(patch).toHaveBeenCalledWith(approved.patch);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ drainCompleted: true, editingAuthorized: false });
  });

  it.each(['currentNative', 'historicalNative', 'serviceEtag'])(
    'refuses %s drift before CAS',
    async (kind) => {
      const f = fixture();
      const approved = plan(f);
      if (kind === 'serviceEtag') f.service.etag = 'changed';
      else if (kind === 'currentNative') f.currentNative.uid = 'changed-immutable-uid';
      else f.historicalNative.uid = 'changed-immutable-uid';
      const patch = vi.fn();
      await expect(
        executeOwnedWebTagRetirement(approved, {
          readService: async () => f.service,
          readRevision: async (name) => f.native[name],
          patchTraffic: patch,
          waitOperation: async () => {},
          drain: async () => {},
        }),
      ).rejects.toThrow();
      expect(patch).not.toHaveBeenCalled();
    },
  );

  it('does not retry an uncertain PATCH or accept service drift during the drain', async () => {
    const f = fixture();
    const approved = plan(f);
    const patch = vi.fn(async () => {
      throw new Error('uncertain');
    });
    const io: RetirementIO = {
      readService: async () => f.service,
      readRevision: async (name) => f.native[name],
      patchTraffic: patch,
      waitOperation: async () => {},
      drain: async () => {},
    };
    await expect(executeOwnedWebTagRetirement(approved, io)).rejects.toThrow('uncertain');
    expect(patch).toHaveBeenCalledTimes(1);
    const absent = fixture(true);
    const completed = plan(absent);
    await expect(
      executeOwnedWebTagRetirement(completed, {
        ...io,
        readService: async () => absent.service,
        readRevision: async (name) => absent.native[name],
        drain: async () => {
          absent.service.etag = 'external-change';
        },
      }),
    ).rejects.toThrow('Service version changed');
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('keeps untagged wire PATCHes opt-in and refuses every tagged target under the new policy', async () => {
    const f = fixture();
    const patch = plan(f).patch;
    if (!patch) throw new Error('Missing patch');
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ name: 'operation' })));
    expect(() => nativeRetirementClient('token', request).patchTraffic(patch)).toThrow();
    const client = nativeRetirementClient(
      'token',
      request,
      undefined,
      undefined,
      'canonical-untagged',
    );
    await client.patchTraffic(patch);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      redirect: 'error',
      body: JSON.stringify(patch),
    });
    expect(() =>
      client.patchTraffic({ ...patch, traffic: [{ ...patch.traffic[0], tag: 'resume-123-1' }] }),
    ).toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
