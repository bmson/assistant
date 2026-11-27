import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Context, releaseIdentity } from './owner-web-release-lifecycle-model.js';
import {
  acceptPairedAgentReadiness,
  initializePairedWebLifecycle,
  runPairedWebLifecyclePhase,
} from './owner-web-release-native-controller.js';
import { projectNativeWebSnapshot } from './owner-web-release-native-proof.js';
import type { FixtureDependencies } from './owner-web-release-native-session.js';
import { createPrivateReleasePhaseReceipts } from './owner-web-release-phase-receipts.js';
import { bindCapturedRetirementToLifecycle } from './owner-web-release-retirement-binding.js';
import { nativeRetirementClient } from './owner-web-tag-native.js';
import {
  executeOwnedWebTagRetirement,
  planOwnedWebTagRetirement,
  tagHash,
  WEB_CANONICAL_URL,
  WEB_SERVICE,
} from './owner-web-tag-retirement.js';
import { reconciliationDigest as digest } from './owner-web-traffic-reconciliation-model.js';

const endpoint = 'https://run.googleapis.com/v2/';
const url = 'https://assistant-web-synthetic-uw.a.run.app';
const aliasUrl = (tag: string) => url.replace('https://', `https://${tag}---`);
const trafficType = 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' as const;
const source = 'a'.repeat(40);
const manifest = 'b'.repeat(64);
const oldManifest = 'c'.repeat(64);
const image = (hex: string) =>
  `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${hex.repeat(64)}`;
const oldImage = image('d');
const newImage = image('e');
const evidence = 'f'.repeat(64);
const canonical = 'assistant-web-recovered-canonical';
const historical = 'assistant-web-historical-paused';
const historicalTag = 'candidate-1234-1';
const date = '2026-11-27T00:00:00.000Z';

type Row = { type: typeof trafficType; revision: string; percent: number; tag?: string };
const row = (revision: string, percent: number, tag?: string): Row => ({
  type: trafficType,
  revision,
  percent,
  ...(tag ? { tag } : {}),
});
const env = (values: Record<string, string>) =>
  Object.entries(values).map(([name, value]) => ({ name, value }));
const runtime = 'runtime@bmson-assistant.iam.gserviceaccount.com';
const template = {
  revision: canonical,
  serviceAccount: runtime,
  timeout: '300s',
  containers: [
    {
      image: oldImage,
      env: env({
        ASSISTANT_RELEASE_MANIFEST: oldManifest,
        ASSISTANT_RELEASE_WRITES_PAUSED: 'false',
      }),
    },
  ],
};
function revision(t: typeof template, uid: string) {
  const { revision, ...fields } = structuredClone(t);
  return {
    ...fields,
    name: `${WEB_SERVICE}/revisions/${revision}`,
    service: WEB_SERVICE,
    uid,
    conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }] as Array<{
      type: string;
      state: string;
      revisionReason?: string;
    }>,
  };
}

function fixture(temp: string, statusOnly = false, reportRetired = false) {
  const native = {
    [canonical]: revision(template, 'canonical-uid'),
    [historical]: revision(
      {
        ...template,
        revision: historical,
        containers: [{ image: oldImage, env: env({ ASSISTANT_RELEASE_WRITES_PAUSED: 'true' }) }],
      },
      'historical-uid',
    ),
  } as Record<string, ReturnType<typeof revision>>;
  const service = {
    name: WEB_SERVICE,
    uid: 'web-uid',
    etag: 'etag-1',
    generation: '1',
    observedGeneration: '1',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    latestReadyRevision: canonical,
    latestCreatedRevision: canonical,
    template: structuredClone(template),
    traffic: [row(canonical, 100)],
    trafficStatuses: [row(canonical, 100)] as Array<Row & { uri?: string }>,
    uri: url,
    urls: [WEB_CANONICAL_URL, url],
  };
  const context: Context = {
    source,
    runId: '700001',
    attempt: '1',
    manifest,
    image: newImage,
    canonical,
    retiredTags: [historicalTag, 'resume-1234-1'],
    currentBinding: {
      proof: {
        uid: tagHash('canonical-uid'),
        image: oldImage,
        source: '1'.repeat(40),
        runId: '1234',
        attempt: '1',
        manifest: oldManifest,
        paused: false,
        templateSha256: digest(template),
      },
      serviceSha256: digest(service),
      revisionSha256: digest(native[canonical]),
      reviewedEvidenceSha256: '2'.repeat(64),
      ordinaryRecoverySha256: evidence,
      preclosed: false,
    },
    releaseEnv: {
      ASSISTANT_RELEASE_API_CONTRACT: '3',
      ASSISTANT_RELEASE_AGENT_API_MIN: '3',
      ASSISTANT_RELEASE_AGENT_API_MAX: '3',
      ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
      ASSISTANT_RELEASE_SCHEMA_MIN: '148',
      ASSISTANT_RELEASE_SCHEMA_MAX: '148',
      ASSISTANT_RELEASE_SCHEMA_VERSION: '148',
      ASSISTANT_RELEASE_MANIFEST: manifest,
      ASSISTANT_RELEASE_WORKFLOW_RUN_ID: '700001',
      ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT: '1',
      ASSISTANT_RELEASE_SOURCE_SHA: source,
    },
  };
  const receipts = createPrivateReleasePhaseReceipts(temp, context);
  const requests: string[] = [];
  const intervals: number[] = [];
  const operations = new Map<string, unknown>();
  const request = async (address: string | URL | Request, options?: RequestInit) => {
    const path = String(address).slice(endpoint.length);
    const method = options?.method;
    expect(String(address)).toBe(endpoint + path);
    requests.push(`${method} ${path}`);
    if (method === 'GET') {
      if (path === WEB_SERVICE) return Response.json(service);
      if (operations.has(path)) return Response.json(operations.get(path));
      const observed = native[path.split('/').at(-1) ?? ''];
      return observed ? Response.json(observed) : new Response(null, { status: 404 });
    }
    expect(method).toBe('PATCH');
    const body = JSON.parse(String(options?.body));
    expect(body.etag).toBe(service.etag);
    if (body.template) {
      service.template = body.template;
      const name = service.template.revision;
      service.latestReadyRevision = service.latestCreatedRevision = name;
      native[name] = revision(service.template, `revision-uid-${requests.length}`);
    }
    service.traffic = body.traffic.map((entry: Row) => {
      const normalized: Partial<Row> = { ...entry };
      if (!normalized.tag) delete normalized.tag;
      if (normalized.percent === 0) delete normalized.percent;
      return normalized;
    });
    service.trafficStatuses = service.traffic.map((entry) => ({
      ...entry,
      ...(entry.tag ? { uri: aliasUrl(entry.tag) } : {}),
    }));
    if (reportRetired) {
      for (const [name, observed] of Object.entries(native)) {
        if (name === historical || service.traffic.some((entry) => entry.revision === name))
          continue;
        observed.conditions = [
          { type: 'Ready', state: 'CONDITION_SUCCEEDED', revisionReason: 'RETIRED' },
          { type: 'Active', state: 'CONDITION_FAILED', revisionReason: 'RETIRED' },
          {
            type: 'ResourcesAvailable',
            state: 'CONDITION_RECONCILING',
            revisionReason: 'RETIRED',
          },
          { type: 'ContainerReady', state: 'CONDITION_SUCCEEDED' },
        ];
      }
    }
    service.urls = [
      WEB_CANONICAL_URL,
      url,
      ...(statusOnly
        ? []
        : service.traffic.flatMap((entry) => (entry.tag ? [aliasUrl(entry.tag)] : []))),
    ];
    service.generation = String(Number(service.generation) + 1);
    service.observedGeneration = service.generation;
    service.etag = `etag-${service.generation}`;
    const name = `projects/bmson-assistant/locations/us-west1/operations/op-${service.generation}`;
    operations.set(name, { name, done: true, response: { name: WEB_SERVICE } });
    return Response.json({ name });
  };
  let clock = Date.parse(date);
  const sleep = async (milliseconds: number) => {
    clock += milliseconds;
    intervals.push(milliseconds);
  };
  const dependencies: FixtureDependencies = {
    request,
    now: () => clock,
    sleep,
    recordIntent: async (state) => receipts.recordIntent(state),
  };
  const io = nativeRetirementClient('synthetic-token', request, sleep, () => clock);
  const phases = (phase: Parameters<typeof runPairedWebLifecyclePhase>[0]) =>
    runPairedWebLifecyclePhase(
      phase,
      new Date(clock).toISOString(),
      dependencies,
      receipts,
      async () => {},
    );
  const writes = () => requests.filter((value) => value.startsWith('PATCH'));
  const project = () =>
    projectNativeWebSnapshot(
      service,
      Object.fromEntries(
        Object.keys(receipts.readCurrent().snapshot.revisions).map((name) => [name, native[name]]),
      ),
      context,
    );
  async function promote() {
    initializePairedWebLifecycle(context, service, { [canonical]: native[canonical] }, receipts);
    await phases('createP');
    await phases('attachP');
    return phases('promoteP');
  }
  function plan() {
    const p = releaseIdentity(context, 'P');
    return planOwnedWebTagRetirement(
      service,
      native,
      [
        {
          tag: historicalTag,
          revision: historical,
          image: oldImage,
          source: '1'.repeat(40),
          uriSha256: tagHash(aliasUrl(historicalTag)),
          provenanceSha256: '3'.repeat(64),
          writesPaused: true,
        },
      ],
      {
        ...p,
        image: newImage,
        paused: true,
        uriSha256: tagHash(aliasUrl(p.tag)),
      },
    );
  }
  return { receipts, context, service, io, intervals, phases, writes, project, promote, plan };
}

describe('ordinary canonical release lifecycle', () => {
  it.each([
    { statusOnly: false, reportRetired: false },
    { statusOnly: true, reportRetired: false },
    { statusOnly: true, reportRetired: true },
  ])(
    'drains the closed historical alias before native completion (status-only: $statusOnly, retired: $reportRetired)',
    async ({ statusOnly, reportRetired }) => {
      const temp = mkdtempSync(join(tmpdir(), 'ordinary-canonical-lifecycle-'));
      try {
        const f = fixture(temp, statusOnly, reportRetired);
        const promoted = await f.promote();
        const plan = f.plan();
        expect(plan.action).toBe('already_absent');
        expect(plan.patch).toBeNull();
        const binder = bindCapturedRetirementToLifecycle(promoted, f.io, f.receipts);
        const fake = {
          action: 'already_absent' as const,
          serviceEtag: promoted.snapshot.etag,
          serviceGeneration: promoted.snapshot.generation,
          drainSeconds: 600,
          drainCompleted: true,
        };
        expect(() => binder.complete(fake, f.project())).toThrow('drain is unconfirmed');
        const result = await executeOwnedWebTagRetirement(plan, binder.io);
        expect(f.intervals.filter((duration) => duration === 30_000)).toHaveLength(20);
        expect(f.writes()).toHaveLength(2);
        const fresh = f.project();
        expect(() => binder.complete({ ...result, serviceEtag: 'wrong-etag' }, fresh)).toThrow();
        expect(() => binder.complete(result, { ...fresh, etag: 'changed-after-drain' })).toThrow();
        const retired = binder.complete(result, fresh);
        expect(retired.retirementAttempt).toBeNull();
        expect(retired.phase).toBe('retired');
        acceptPairedAgentReadiness(retired, fresh, f.receipts);
        await f.phases('createR');
        await f.phases('attachR');
        await f.phases('promoteR');
        const complete = await f.phases('closeP');
        expect(complete.phase).toBe('complete');
        const r = releaseIdentity(f.context, 'R');
        expect(complete.snapshot.desired).toEqual([row(r.revision, 100, r.tag)]);
        expect(f.writes()).toHaveLength(5);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it('holds an already-absent retirement for an unreviewed lifecycle', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'unreviewed-canonical-lifecycle-'));
    try {
      const f = fixture(temp);
      delete f.context.currentBinding?.ordinaryRecoverySha256;
      const promoted = await f.promote();
      const binder = bindCapturedRetirementToLifecycle(promoted, f.io, f.receipts);
      const result = await executeOwnedWebTagRetirement(f.plan(), binder.io);
      expect(() => binder.complete(result, f.project())).toThrow(
        'Captured retirement completion is unconfirmed',
      );
      expect(f.receipts.readCurrent().phase).toBe('promotedP');
      expect(f.writes()).toHaveLength(2);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
