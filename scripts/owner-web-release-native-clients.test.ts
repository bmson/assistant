// biome-ignore-all lint/style/noNonNullAssertion: Explicit synthetic fixtures populate each referenced field.

import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeWebCreationFixtureClient } from './owner-web-release-creation-client.js';
import {
  acceptAgentReady,
  acceptCapturedRetirement,
  beginCapturedRetirement,
  bindCapturedRetirementOperation,
  type Context,
  captureLifecycle,
  releaseIdentity,
  type State,
  verifyLifecycleState,
} from './owner-web-release-lifecycle-model.js';
import {
  initializePairedWebLifecycle,
  runPairedWebLifecyclePhase,
} from './owner-web-release-native-controller.js';
import { projectNativeWebSnapshot } from './owner-web-release-native-proof.js';
import { type FixtureDependencies, NativeReleaseHold } from './owner-web-release-native-session.js';
import { verifyOperatorOwnedHold } from './owner-web-release-operator-hold.js';
import { createPrivateReleasePhaseReceipts } from './owner-web-release-phase-receipts.js';
import { bindCapturedRetirementToLifecycle } from './owner-web-release-retirement-binding.js';
import { nativeWebTrafficFixtureClient } from './owner-web-release-traffic-client.js';
import { HISTORICAL_WEB_TAGS, WEB_SERVICE } from './owner-web-tag-retirement.js';

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const stamp = '2026-11-01T22:40:00.000Z',
  privateValue = 'NATIVE_PRIVATE_SECRET_OR_TOKEN_DO_NOT_DISCLOSE';
const ROOT = 'https://run.googleapis.com/v2/';
function reply(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function fixture() {
  const pin = HISTORICAL_WEB_TAGS[1]!;
  const context: Context = {
    source: 'a'.repeat(40),
    runId: '700001',
    attempt: '1',
    manifest: 'b'.repeat(64),
    image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'c'.repeat(64)}`,
    canonical: pin.revision,
    retiredTags: [HISTORICAL_WEB_TAGS[0]!.tag],
    releaseEnv: {},
  };
  context.releaseEnv = {
    ASSISTANT_RELEASE_API_CONTRACT: '1',
    ASSISTANT_RELEASE_AGENT_API_MIN: '1',
    ASSISTANT_RELEASE_AGENT_API_MAX: '1',
    ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
    ASSISTANT_RELEASE_SCHEMA_MIN: '133',
    ASSISTANT_RELEASE_SCHEMA_MAX: '133',
    ASSISTANT_RELEASE_SCHEMA_VERSION: '133',
    ASSISTANT_RELEASE_MANIFEST: context.manifest,
    ASSISTANT_RELEASE_WORKFLOW_RUN_ID: context.runId,
    ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT: context.attempt,
    ASSISTANT_RELEASE_SOURCE_SHA: context.source,
  };
  const root = 'https://assistant-web-3gimfiaifa-uw.a.run.app',
    uri = (tag: string) => `https://${tag}---assistant-web-3gimfiaifa-uw.a.run.app`;
  const template = {
    revision: pin.revision,
    serviceAccount: 'runtime@bmson-assistant.iam.gserviceaccount.com',
    timeout: '300s',
    containers: [
      {
        image: pin.image,
        env: [
          { name: 'ASSISTANT_RELEASE_WRITES_PAUSED', value: 'false' },
          { name: 'ASSISTANT_RELEASE_MANIFEST', value: 'e'.repeat(64) },
          {
            name: 'PRIVATE',
            valueSource: { secretKeyRef: { secret: privateValue, version: '1' } },
          },
        ],
        resources: { limits: { cpu: '1', memory: '512Mi' } },
      },
    ],
    scaling: { minInstanceCount: 1 },
    vpcAccess: { connector: 'preserved-network' },
  };
  // biome-ignore lint/suspicious/noExplicitAny: Heterogeneous mutable wire fixtures intentionally introduce malformed fields.
  type Raw = Record<string, any>;
  const revision = (t: Raw, uid: string) => {
    const { revision: name, ...fields } = copy(t);
    return {
      ...fields,
      name: `${WEB_SERVICE}/revisions/${name}`,
      uid,
      service: WEB_SERVICE,
      conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
    };
  };
  const service: Raw = {
    name: WEB_SERVICE,
    uid: 'fixed-service-uid',
    etag: 'etag-1',
    generation: '1',
    observedGeneration: '1',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    latestReadyRevision: pin.revision,
    latestCreatedRevision: pin.revision,
    template,
    traffic: [
      {
        type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
        revision: pin.revision,
        tag: pin.tag,
        percent: 100,
      },
    ],
    trafficStatuses: [
      {
        type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
        revision: pin.revision,
        tag: pin.tag,
        percent: 100,
        uri: uri(pin.tag),
      },
    ],
    uri: root,
    urls: [root, uri(pin.tag)],
    ingress: 'INGRESS_TRAFFIC_ALL',
  };
  const native: Record<string, Raw> = { [pin.revision]: revision(template, 'native-current-uid') };
  let clock = Date.parse(stamp),
    writes = 0;
  const recorded: State[] = [],
    requests: {
      url: string;
      method: string;
      body?: string;
      signal: AbortSignal;
      redirect: string;
    }[] = [];
  let override:
    | ((
        url: string,
        options: Parameters<FixtureDependencies['request']>[1],
      ) => Response | Promise<Response> | undefined)
    | undefined;
  const operations: Record<string, Raw> = {};
  let renderInitial: (op: Raw) => Response = (op) => reply(op);
  const request = vi.fn(
    async (url: string, options: Parameters<FixtureDependencies['request']>[1]) => {
      requests.push({ url, ...options });
      const altered = override?.(url, options);
      if (altered !== undefined) return await altered;
      expect(url.startsWith(ROOT)).toBe(true);
      expect(options.redirect).toBe('error');
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const path = url.slice(ROOT.length);
      if (options.method === 'GET') {
        if (path === WEB_SERVICE) return reply(service);
        if (path.startsWith(`${WEB_SERVICE}/revisions/`)) {
          const name = path.slice(`${WEB_SERVICE}/revisions/`.length);
          return native[name] ? reply(native[name]) : reply({ message: privateValue }, 404);
        }
        if (operations[path]) return reply(operations[path]);
        throw new Error('Unexpected fixture path');
      }
      writes++;
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.at(-1)?.pending).not.toBeNull();
      const body = JSON.parse(options.body!),
        op = `projects/bmson-assistant/locations/us-west1/operations/op-${writes}`;
      expect(body.etag).toBe(service.etag);
      expect(body.name).toBe(WEB_SERVICE);
      if (path === `${WEB_SERVICE}?updateMask=template`) {
        expect(Object.keys(body).sort()).toEqual(['etag', 'name', 'template']);
        service.template = body.template;
        service.latestCreatedRevision = service.latestReadyRevision = body.template.revision;
        native[body.template.revision] = revision(body.template, `native-created-${writes}`);
      } else {
        expect(path).toBe(`${WEB_SERVICE}?updateMask=traffic`);
        expect(Object.keys(body).sort()).toEqual(['etag', 'name', 'traffic']);
        service.traffic = body.traffic.map((r: Raw) => {
          const x = copy(r);
          if (x.percent === 0) delete x.percent;
          if (x.tag === '') delete x.tag;
          return x;
        });
        service.trafficStatuses = service.traffic.map((r: Raw) => ({
          ...r,
          ...(r.tag ? { uri: uri(r.tag) } : {}),
        }));
        service.urls = [
          root,
          ...service.traffic.filter((r: Raw) => r.tag).map((r: Raw) => uri(r.tag)),
        ];
      }
      service.etag = `etag-${writes + 1}`;
      service.generation = String(BigInt(service.generation) + 1n);
      service.observedGeneration = service.generation;
      operations[op] = { name: op, done: true, response: { name: WEB_SERVICE } };
      return renderInitial(operations[op]!);
    },
  );
  const deps: FixtureDependencies = {
    request,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    recordIntent: async (s) => {
      verifyLifecycleState(s);
      recorded.push(copy(s));
    },
  };
  const state = () => captureLifecycle(context, projectNativeWebSnapshot(service, native, context));
  return {
    context,
    service,
    native,
    requests,
    recorded,
    request,
    deps,
    state,
    operations,
    setInitialReply: (fn: typeof renderInitial) => {
      renderInitial = fn;
    },
    writes: () => writes,
    setClock: (n: number) => {
      clock = n;
    },
    setOverride: (fn: typeof override) => {
      override = fn;
    },
    pin,
  };
}
afterEach(() => vi.useRealTimers());
describe('unwired fixed native fixture clients', () => {
  it('initializes only from a fresh canonical-only native projection and checks hold before a phase', async () => {
    const f = fixture(),
      root = mkdtempSync(join(tmpdir(), 'owner-web-controller-private-')),
      receipts = createPrivateReleasePhaseReceipts(root, {
        source: f.context.source,
        runId: f.context.runId,
        attempt: f.context.attempt,
        manifest: f.context.manifest,
      });
    const initial = initializePairedWebLifecycle(f.context, f.service, f.native, receipts);
    expect(initial.phase).toBe('captured');
    expect(receipts.readCurrent().receipt).toBe(initial.receipt);
    const hold = vi.fn(async () => {});
    const after = await runPairedWebLifecyclePhase('createP', stamp, f.deps, receipts, hold);
    expect(hold).toHaveBeenCalledOnce();
    expect(after.phase).toBe('createdP');
  });

  it('refuses to initialize from unsupported starting aliases', () => {
    const f = fixture(),
      root = mkdtempSync(join(tmpdir(), 'owner-web-controller-private-')),
      receipts = createPrivateReleasePhaseReceipts(root, {
        source: f.context.source,
        runId: f.context.runId,
        attempt: f.context.attempt,
        manifest: f.context.manifest,
      }),
      changed = copy(f.service);
    changed.traffic.push({
      type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
      revision: f.context.canonical,
      tag: 'resume-40350727924-1',
      percent: 0,
    });
    expect(() => initializePairedWebLifecycle(f.context, changed, f.native, receipts)).toThrow(
      'canonical web tag',
    );
  });

  it('requires manually disabled workflows, cleanup false, and a complete run/job census', async () => {
    const f = fixture(),
      root = mkdtempSync(join(tmpdir(), 'owner-web-controller-private-')),
      tokenPath = join(root, 'owner-web-tag-github-token'),
      state = f.state();
    writeFileSync(tokenPath, 'fixture-token', { mode: 0o600 });
    const env = {
      GITHUB_REPOSITORY: 'bmson/assistant',
      GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
      GITHUB_WORKFLOW_SHA: f.context.source,
      GITHUB_SHA: f.context.source,
      GITHUB_RUN_ID: f.context.runId,
      GITHUB_RUN_ATTEMPT: f.context.attempt,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_JOB: 'release',
      RUNNER_TEMP: root,
      CURRENT_ONLY_CLEANUP: 'false',
    } as NodeJS.ProcessEnv;
    const request = vi.fn(async (url: string) => {
      if (url.endsWith('/actions/workflows/deploy.yml'))
        return { id: 1, state: 'disabled_manually' };
      if (url.endsWith('/actions/workflows/cleanup.yml'))
        return { id: 2, state: 'disabled_manually' };
      if (url.endsWith('/actions/workflows/workspace-import.yml'))
        return { id: 3, state: 'disabled_manually' };
      if (url.includes('/runs?')) {
        const active = url.includes('status=in_progress');
        const deploy = url.includes('/deploy.yml/');
        return {
          total_count: active && deploy ? 1 : 0,
          workflow_runs:
            active && deploy
              ? [
                  {
                    id: Number(f.context.runId),
                    run_attempt: 1,
                    head_sha: f.context.source,
                    event: 'workflow_dispatch',
                    status: 'in_progress',
                  },
                ]
              : [],
        };
      }
      if (url.includes('/jobs?'))
        return { total_count: 1, jobs: [{ name: 'release', status: 'in_progress' }] };
      throw new Error('unexpected hold URL');
    });
    const receipt = await verifyOperatorOwnedHold(state.context, env, request);
    expect(receipt).toEqual({
      source: f.context.source,
      runId: f.context.runId,
      attempt: f.context.attempt,
      currentJob: 'release',
      deployWorkflowId: 1,
      cleanupWorkflowId: 2,
      workspaceImportWorkflowId: 3,
      cleanupVariable: 'false',
    });
    await expect(
      verifyOperatorOwnedHold(
        state.context,
        env,
        vi.fn(async () => {
          throw new Error('403');
        }),
      ),
    ).rejects.toThrow();
  });

  it('grants actions read only to the selected release job', () => {
    const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
    expect(workflow).toMatch(
      / {2}release:\n {4}permissions:\n {6}actions: read\n {6}contents: read\n {6}id-token: write\n/,
    );
    const workflowPermissions = workflow.slice(0, workflow.indexOf('\njobs:\n'));
    expect(workflowPermissions).toMatch(/permissions:\n {2}contents: read\n {2}id-token: write\n/);
    expect(workflowPermissions).not.toMatch(/actions:\s*read/);
  });

  it('constructs raw proofs, creates without traffic change then attaches and promotes through separate client', async () => {
    const f = fixture(),
      initial = f.state(),
      creation = nativeWebCreationFixtureClient(f.deps),
      p = await creation.execute(initial, 'createP', stamp);
    expect(p.phase).toBe('createdP');
    expect(p.snapshot.desired).toEqual(initial.snapshot.desired);
    expect(p.snapshot.template.vpcAccess).toEqual(initial.snapshot.template.vpcAccess);
    expect(p.snapshot.revisions[releaseIdentity(f.context, 'P').revision]?.paused).toBe(true);
    const attached = await nativeWebTrafficFixtureClient(f.deps).execute(p, 'attachP', stamp);
    expect(attached.phase).toBe('attachedP');
    const promoted = await nativeWebTrafficFixtureClient(f.deps).execute(
      attached,
      'promoteP',
      stamp,
    );
    expect(promoted.snapshot.desired.find((r) => r.percent === 100)?.tag).toBe(
      releaseIdentity(f.context, 'P').tag,
    );
    expect(f.writes()).toBe(3);
    expect(f.requests.filter((r) => r.method === 'PATCH').map((r) => r.url.split('?')[1])).toEqual([
      'updateMask=template',
      'updateMask=traffic',
      'updateMask=traffic',
    ]);
    expect(JSON.stringify(creation.checkpoint())).not.toContain(privateValue);
  });
  it('rejects a creation mode at the traffic boundary even after bypassing static typing', async () => {
    const f = fixture(),
      client = nativeWebTrafficFixtureClient(f.deps);
    await expect(client.execute(f.state(), 'createP' as never, stamp)).rejects.toMatchObject({
      mutationState: 'not_attempted',
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('rejects traffic modes at the creation boundary', async () => {
    const f = fixture();
    await expect(
      nativeWebCreationFixtureClient(f.deps).execute(f.state(), 'attachP' as never, stamp),
    ).rejects.toMatchObject({ mutationState: 'not_attempted' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('requires deterministic revision absence and refuses adoption of an existing identity', async () => {
    const f = fixture(),
      s = f.state(),
      id = releaseIdentity(f.context, 'P');
    f.native[id.revision] = copy(f.native[f.pin.revision]!);
    await expect(
      nativeWebCreationFixtureClient(f.deps).execute(s, 'createP', stamp),
    ).rejects.toMatchObject({ mutationState: 'not_attempted' });
    expect(f.writes()).toBe(0);
  });
  it.each([
    'etag',
    'generation',
    'uri',
    'template',
    'nativeImage',
    'nativePause',
    'uid',
    'unknownTemplate',
    'duplicateEnv',
    'desiredMismatch',
    'unready',
  ] as const)('rejects raw drift without trusting supplied projection: %s', async (kind) => {
    const f = fixture(),
      s = f.state();
    if (kind === 'etag') f.service.etag = 'foreign';
    if (kind === 'generation') f.service.generation = '999';
    if (kind === 'uri') f.service.uri = 'https://evil.invalid';
    if (kind === 'template') f.service.template.timeout = '599s';
    if (kind === 'nativeImage') f.native[f.pin.revision]!.containers[0].image = f.context.image;
    if (kind === 'nativePause') f.native[f.pin.revision]!.containers[0].env[0].value = 'true';
    if (kind === 'uid') f.native[f.pin.revision]!.uid = 'foreign';
    if (kind === 'unknownTemplate') f.service.template.unsupported = privateValue;
    if (kind === 'duplicateEnv')
      f.native[f.pin.revision]!.containers[0].env.push({
        name: 'ASSISTANT_RELEASE_MANIFEST',
        value: 'e'.repeat(64),
      });
    if (kind === 'desiredMismatch') f.service.traffic[0].percent = 0;
    if (kind === 'unready') f.service.terminalCondition.state = 'CONDITION_FAILED';
    await expect(
      nativeWebCreationFixtureClient(f.deps).execute(s, 'createP', stamp),
    ).rejects.toMatchObject({ mutationState: 'not_attempted' });
    expect(f.writes()).toBe(0);
  });
  it.each(['old', 'future', 'invalid', 'nan'] as const)(
    'rejects invalid review age/clock %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'nan') f.setClock(Number.NaN);
      const at =
        kind === 'old'
          ? '2026-11-01T21:00:00.000Z'
          : kind === 'future'
            ? '2026-11-01T23:00:00.000Z'
            : kind === 'invalid'
              ? 'not-a-date'
              : stamp;
      await expect(
        nativeWebCreationFixtureClient(f.deps).execute(f.state(), 'createP', at),
      ).rejects.toMatchObject({ mutationState: 'not_attempted' });
      expect(f.writes()).toBe(0);
    },
  );
  it('rechecks TTL after intent recording before one PATCH', async () => {
    const f = fixture();
    f.deps.recordIntent = async () => {
      f.setClock(Date.parse(stamp) + 1800001);
    };
    await expect(
      nativeWebCreationFixtureClient(f.deps).execute(f.state(), 'createP', stamp),
    ).rejects.toMatchObject({ mutationState: 'not_attempted' });
    expect(f.writes()).toBe(0);
  });
  it('holds if durable intent hook fails before the PATCH', async () => {
    const f = fixture();
    f.deps.recordIntent = async () => {
      throw new Error(privateValue);
    };
    const c = nativeWebCreationFixtureClient(f.deps);
    await expect(c.execute(f.state(), 'createP', stamp)).rejects.toMatchObject({
      reason: 'intent_unconfirmed',
      mutationState: 'not_attempted',
    });
    expect(f.writes()).toBe(0);
  });
  it('marks a rejected PATCH uncertain and never retries or adopts another operation', async () => {
    const f = fixture(),
      s = f.state(),
      c = nativeWebCreationFixtureClient(f.deps);
    f.setOverride((_url, o) =>
      o.method === 'PATCH' ? reply({ private: privateValue }, 412) : undefined,
    );
    const error = await c.execute(s, 'createP', stamp).catch((e) => e);
    expect(error).toBeInstanceOf(NativeReleaseHold);
    expect(error.mutationState).toBe('may_have_been_attempted');
    expect(JSON.stringify(error)).not.toContain(privateValue);
    await expect(c.recoverSameOperation()).rejects.toBeInstanceOf(NativeReleaseHold);
    await expect(c.execute(s, 'createP', stamp)).rejects.toBeInstanceOf(NativeReleaseHold);
    expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    expect(c.checkpoint().operation).toBeNull();
  });
  it('rejects a foreign returned LRO before any poll to it', async () => {
    const f = fixture();
    f.setOverride((_u, o) =>
      o.method === 'PATCH'
        ? reply({ name: 'projects/evil/locations/us-west1/operations/x' })
        : undefined,
    );
    const c = nativeWebCreationFixtureClient(f.deps);
    await expect(c.execute(f.state(), 'createP', stamp)).rejects.toMatchObject({
      mutationState: 'may_have_been_attempted',
    });
    expect(f.requests.some((r) => r.url.includes('/evil/'))).toBe(false);
  });
  it('rejects redirect status and invalid JSON content types without reading their payload', async () => {
    for (const status of [302, 401, 500]) {
      const f = fixture();
      f.setOverride(
        () =>
          new Response(privateValue, {
            status,
            headers: { Location: 'https://evil.invalid', 'Content-Type': 'text/plain' },
          }),
      );
      await expect(
        nativeWebCreationFixtureClient(f.deps).execute(f.state(), 'createP', stamp),
      ).rejects.toMatchObject({ mutationState: 'not_attempted' });
      expect(f.writes()).toBe(0);
    }
  });
  it('bounds oversized, malformed and invalid UTF8 bodies', async () => {
    for (const body of ['x'.repeat(2 * 1024 * 1024 + 1), 'not-json', new Uint8Array([255])]) {
      const f = fixture();
      f.setOverride(() => new Response(body, { headers: { 'Content-Type': 'application/json' } }));
      await expect(
        nativeWebCreationFixtureClient(f.deps).execute(f.state(), 'createP', stamp),
      ).rejects.toMatchObject({ mutationState: 'not_attempted' });
      expect(f.requests).toHaveLength(1);
    }
  });
  it('bounds a stalled stream and aborts it even if reader cancellation stalls', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      cancel = vi.fn(() => new Promise<void>(() => undefined));
    f.setOverride(
      () =>
        new Response(new ReadableStream({ pull: () => new Promise(() => undefined), cancel }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const c = nativeWebCreationFixtureClient(f.deps),
      out = c.execute(f.state(), 'createP', stamp).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15001);
    expect(await out).toMatchObject({ mutationState: 'not_attempted' });
    expect(cancel).toHaveBeenCalled();
    expect(f.requests[0]?.signal.aborted).toBe(true);
  });
  it('bounds a stalled transport without relying on its signal compliance', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setOverride(() => new Promise(() => undefined));
    const out = nativeWebCreationFixtureClient(f.deps)
      .execute(f.state(), 'createP', stamp)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(15001);
    expect(await out).toMatchObject({ mutationState: 'not_attempted' });
  });
});

describe('same-LRO bounded polling and read recovery', () => {
  it('polls only the returned fixed operation with GET and no second PATCH', async () => {
    const f = fixture();
    f.setInitialReply((op) => reply({ name: op.name, done: false }));
    const c = nativeWebCreationFixtureClient(f.deps);
    expect((await c.execute(f.state(), 'createP', stamp)).phase).toBe('createdP');
    const polls = f.requests.filter((r) => r.url.includes('/operations/'));
    expect(polls.length).toBeGreaterThan(0);
    expect(
      polls.every(
        (r) =>
          r.method === 'GET' &&
          r.url === `${ROOT}projects/bmson-assistant/locations/us-west1/operations/op-1`,
      ),
    ).toBe(true);
    expect(f.writes()).toBe(1);
  });
  it('recovers only the originally bound LRO after an uncertain poll response', async () => {
    const f = fixture();
    f.setInitialReply((op) => reply({ name: op.name, done: false }));
    f.setOverride((url) =>
      url.includes('/operations/')
        ? reply({ name: 'projects/foreign/locations/us-west1/operations/other', done: true })
        : undefined,
    );
    const c = nativeWebCreationFixtureClient(f.deps);
    await expect(c.execute(f.state(), 'createP', stamp)).rejects.toMatchObject({
      mutationState: 'may_have_been_attempted',
    });
    expect(c.checkpoint().outcome).toBe('unknown');
    f.setOverride(undefined);
    expect((await c.recoverSameOperation()).phase).toBe('createdP');
    expect(f.writes()).toBe(1);
    await expect(c.recoverSameOperation()).rejects.toBeInstanceOf(NativeReleaseHold);
  });
  it('refuses post-write config drift even if the LRO claims success', async () => {
    const f = fixture();
    f.setOverride((url) =>
      f.writes() > 0 && url === ROOT + WEB_SERVICE
        ? reply({ ...f.service, ingress: 'changed' })
        : undefined,
    );
    const c = nativeWebCreationFixtureClient(f.deps);
    await expect(c.execute(f.state(), 'createP', stamp)).rejects.toMatchObject({
      reason: 'postcheck_refused',
      mutationState: 'may_have_been_attempted',
    });
    expect(f.writes()).toBe(1);
  });
  it('stops fixed polling at its deadline and bounds total calls, including one GET-only recovery', async () => {
    const f = fixture();
    f.setInitialReply((op) => reply({ name: op.name, done: false }));
    f.setOverride((url) =>
      url.includes('/operations/')
        ? reply({
            name: 'projects/bmson-assistant/locations/us-west1/operations/op-1',
            done: false,
          })
        : undefined,
    );
    const c = nativeWebCreationFixtureClient(f.deps);
    await expect(c.execute(f.state(), 'createP', stamp)).rejects.toMatchObject({
      mutationState: 'may_have_been_attempted',
    });
    await expect(c.recoverSameOperation()).rejects.toBeInstanceOf(NativeReleaseHold);
    expect(f.requests.length).toBeLessThanOrEqual(100);
    expect(f.writes()).toBe(1);
  });
  it('holds a streamed PATCH response whose body stalls, without recovering an unbound operation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setInitialReply(
      () =>
        new Response(new ReadableStream({ pull: () => new Promise(() => undefined) }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const c = nativeWebCreationFixtureClient(f.deps),
      out = c.execute(f.state(), 'createP', stamp).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15001);
    expect(await out).toMatchObject({ mutationState: 'may_have_been_attempted' });
    expect(f.writes()).toBe(1);
    expect(c.checkpoint().operation).toBeNull();
    await expect(c.recoverSameOperation()).rejects.toBeInstanceOf(NativeReleaseHold);
    expect(f.writes()).toBe(1);
  });
  it.each(['error', 'malformedDone', 'missingResponse', 'wrongResponse'])(
    'holds terminal/raw LRO variant %s',
    async (kind) => {
      const f = fixture();
      f.setInitialReply((op) =>
        reply({
          ...op,
          ...(kind === 'error'
            ? { error: { private: privateValue } }
            : kind === 'malformedDone'
              ? { done: 'true' }
              : kind === 'missingResponse'
                ? { response: undefined }
                : { response: { name: 'projects/foreign/services/other' } }),
        }),
      );
      const c = nativeWebCreationFixtureClient(f.deps);
      await expect(c.execute(f.state(), 'createP', stamp)).rejects.toMatchObject({
        mutationState: 'may_have_been_attempted',
      });
      expect(f.writes()).toBe(1);
    },
  );
});

async function readyForResume(f: ReturnType<typeof fixture>) {
  let s = await nativeWebCreationFixtureClient(f.deps).execute(f.state(), 'createP', stamp);
  s = await nativeWebTrafficFixtureClient(f.deps).execute(s, 'attachP', stamp);
  s = await nativeWebTrafficFixtureClient(f.deps).execute(s, 'promoteP', stamp);
  const operation = 'projects/bmson-assistant/locations/us-west1/operations/existing-retirement';
  s = bindCapturedRetirementOperation(beginCapturedRetirement(s), operation);
  const p = releaseIdentity(f.context, 'P');
  f.service.traffic = f.service.traffic.filter((r: { tag: string }) => r.tag === p.tag);
  f.service.trafficStatuses = f.service.trafficStatuses.filter(
    (r: { tag: string }) => r.tag === p.tag,
  );
  f.service.urls = [f.service.uri, ...f.service.trafficStatuses.map((r: { uri: string }) => r.uri)];
  f.service.etag = 'external-retirement-etag';
  f.service.generation = String(BigInt(f.service.generation) + 1n);
  f.service.observedGeneration = f.service.generation;
  const after = projectNativeWebSnapshot(f.service, f.native, f.context);
  s = acceptCapturedRetirement(s, after, {
    source: f.context.source,
    runId: f.context.runId,
    attempt: f.context.attempt,
    manifest: f.context.manifest,
    beforeReceipt: s.receipt,
    serviceUid: after.uid,
    etag: after.etag,
    generation: after.generation,
    drainSeconds: 600,
    drainCompleted: true,
    operation,
  });
  return acceptAgentReady(s, {
    beforeReceipt: s.receipt,
    agentProofSha256: 'f'.repeat(64),
    stableEtag: s.snapshot.etag,
    stableGeneration: s.snapshot.generation,
  });
}
describe('native enum traffic phase maps', () => {
  it('creates verified R after sticky admission intent, then attaches/promotes/closes P without SDK writes', async () => {
    const f = fixture(),
      s = await readyForResume(f),
      r = await nativeWebCreationFixtureClient(f.deps).execute(s, 'createR', stamp);
    expect(r.admissionPossible).toBe(true);
    expect(f.recorded.find((x) => x.pending?.plan.mode === 'createR')?.admissionPossible).toBe(
      true,
    );
    expect(r.snapshot.revisions[releaseIdentity(f.context, 'R').revision]?.paused).toBe(false);
    const attached = await nativeWebTrafficFixtureClient(f.deps).execute(r, 'attachR', stamp),
      promoted = await nativeWebTrafficFixtureClient(f.deps).execute(attached, 'promoteR', stamp),
      closed = await nativeWebTrafficFixtureClient(f.deps).execute(promoted, 'closeP', stamp);
    expect(closed.phase).toBe('complete');
    expect(closed.snapshot.desired).toHaveLength(1);
    expect(closed.snapshot.desired[0]?.tag).toBe(releaseIdentity(f.context, 'R').tag);
    expect(closed.retiredTags).toContain(f.pin.tag);
  });
  it('restores captured C with an untagged100 row and never recreates its retired alias', async () => {
    const f = fixture(),
      s = await readyForResume(f),
      restored = await nativeWebTrafficFixtureClient(f.deps).execute(s, 'restoreC', stamp);
    expect(restored.snapshot.desired.find((x) => x.percent === 100)).toMatchObject({
      revision: f.pin.revision,
      tag: '',
    });
    expect(restored.snapshot.tagUris[f.pin.tag]).toBeUndefined();
  });
  it('repauses P after R promotion, then closes only the verified R alias', async () => {
    const f = fixture();
    let s = await readyForResume(f);
    s = await nativeWebCreationFixtureClient(f.deps).execute(s, 'createR', stamp);
    s = await nativeWebTrafficFixtureClient(f.deps).execute(s, 'attachR', stamp);
    s = await nativeWebTrafficFixtureClient(f.deps).execute(s, 'promoteR', stamp);
    const p = await nativeWebTrafficFixtureClient(f.deps).execute(s, 'repauseP', stamp),
      closed = await nativeWebTrafficFixtureClient(f.deps).execute(p, 'closeR', stamp);
    expect(closed.phase).toBe('closedR');
    expect(closed.admissionPossible).toBe(true);
    expect(closed.snapshot.desired[0]?.tag).toBe(releaseIdentity(f.context, 'P').tag);
  });
});

describe('receipt and transport budget failures', () => {
  it('keeps unknown after terminal success if completion receipt recording fails', async () => {
    const f = fixture(),
      record = f.deps.recordIntent;
    let fail = true;
    f.deps.recordIntent = async (state) => {
      if (state.phase === 'createdP' && fail) throw new Error(privateValue);
      await record(state);
    };
    const c = nativeWebCreationFixtureClient(f.deps);
    await expect(c.execute(f.state(), 'createP', stamp)).rejects.toMatchObject({
      reason: 'intent_unconfirmed',
      mutationState: 'may_have_been_attempted',
    });
    expect(c.checkpoint().outcome).toBe('unknown');
    fail = false;
    expect((await c.recoverSameOperation()).phase).toBe('createdP');
    expect(f.writes()).toBe(1);
  });
  it('reaches shared60operationGET cap before100requests even with a frozen fixture clock', async () => {
    const f = fixture();
    f.deps.sleep = async () => undefined;
    f.setInitialReply((op) => reply({ name: op.name, done: false }));
    f.setOverride((url) =>
      url.includes('/operations/')
        ? reply({
            name: 'projects/bmson-assistant/locations/us-west1/operations/op-1',
            done: false,
          })
        : undefined,
    );
    const c = nativeWebCreationFixtureClient(f.deps);
    await expect(c.execute(f.state(), 'createP', stamp)).rejects.toBeInstanceOf(NativeReleaseHold);
    await expect(c.recoverSameOperation()).rejects.toBeInstanceOf(NativeReleaseHold);
    expect(f.requests.length).toBeLessThanOrEqual(100);
    expect(f.requests.filter((r) => r.url.includes('/operations/'))).toHaveLength(60);
    expect(c.checkpoint().operationGets).toBe(60);
    expect(f.writes()).toBe(1);
  });
  it('does not extend the original operation deadline for recovery', async () => {
    const f = fixture();
    f.setInitialReply((op) => reply({ name: op.name, done: false }));
    f.setOverride((url) =>
      url.includes('/operations/')
        ? reply({ name: 'projects/other/locations/us-west1/operations/x' })
        : undefined,
    );
    const c = nativeWebCreationFixtureClient(f.deps);
    await expect(c.execute(f.state(), 'createP', stamp)).rejects.toBeInstanceOf(NativeReleaseHold);
    const count = f.requests.length;
    f.setClock(Date.parse(stamp) + 180001);
    f.setOverride(undefined);
    await expect(c.recoverSameOperation()).rejects.toBeInstanceOf(NativeReleaseHold);
    expect(f.requests).toHaveLength(count);
    expect(f.writes()).toBe(1);
  });
  it('bounds a stalled poll sleep whose fixture ignores abort', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setInitialReply((op) => reply({ name: op.name, done: false }));
    f.deps.sleep = () => new Promise(() => undefined);
    const c = nativeWebCreationFixtureClient(f.deps),
      out = c.execute(f.state(), 'createP', stamp).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15001);
    expect(await out).toMatchObject({ mutationState: 'may_have_been_attempted' });
    expect(f.writes()).toBe(1);
  });
  it('sends no authorization header and never follows a returned external URL', async () => {
    const f = fixture();
    await nativeWebCreationFixtureClient(f.deps).execute(f.state(), 'createP', stamp);
    expect(
      f.request.mock.calls.every(
        ([url, init]) =>
          url.startsWith(ROOT) &&
          init.redirect === 'error' &&
          !Object.keys(init.headers ?? {}).some((k) => k.toLowerCase() === 'authorization'),
      ),
    ).toBe(true);
  });
});

describe('private single-run lifecycle receipts', () => {
  function storeFor(f: ReturnType<typeof fixture>) {
    const root = mkdtempSync(join(tmpdir(), 'owner-web-release-private-'));
    chmodSync(root, 0o700);
    const store = createPrivateReleasePhaseReceipts(root, {
      source: f.context.source,
      runId: f.context.runId,
      attempt: f.context.attempt,
      manifest: f.context.manifest,
    });
    store.initialize(f.state());
    return store;
  }
  it('fsyncs immutable attempted and completion receipts around one native creation', async () => {
    const f = fixture(),
      store = storeFor(f),
      client = nativeWebCreationFixtureClient({
        ...f.deps,
        recordIntent: async (state) => {
          store.recordIntent(state);
          await f.deps.recordIntent(state);
        },
      });
    const completed = await client.execute(store.readCurrent(), 'createP', stamp);
    expect(completed.phase).toBe('createdP');
    expect(store.readCurrent().receipt).toBe(completed.receipt);
    expect(readdirSync(store.directory).sort()).toEqual([
      'attempt-1-createP.json',
      'complete-3-createdP.json',
      'operation-2-createP.json',
      'state.json',
    ]);
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(store.directory, 'attempt-1-createP.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(store.directory, 'attempt-1-createP.json'), 'utf8')).toContain(
      privateValue,
    );
    await expect(
      nativeWebCreationFixtureClient({
        ...f.deps,
        recordIntent: async (state) => {
          store.recordIntent(state);
          await f.deps.recordIntent(state);
        },
      }).execute(store.readCurrent(), 'createP', stamp),
    ).rejects.toMatchObject({ mutationState: 'not_attempted' });
    expect(f.writes()).toBe(1);
  });
  it('refuses the native PATCH when the immutable prewrite receipt already exists', async () => {
    const f = fixture(),
      store = storeFor(f),
      initial = store.readCurrent();
    writeFileSync(join(store.directory, 'attempt-1-createP.json'), 'prior attempt\n', {
      flag: 'wx',
      mode: 0o600,
    });
    const client = nativeWebCreationFixtureClient({
      ...f.deps,
      recordIntent: async (state) => {
        store.recordIntent(state);
        await f.deps.recordIntent(state);
      },
    });
    await expect(client.execute(initial, 'createP', stamp)).rejects.toMatchObject({
      mutationState: 'not_attempted',
    });
    expect(f.writes()).toBe(0);
    expect(() => store.readCurrent()).toThrow('held');
  });
  it('persists an unresolved native outcome and refuses a later phase read', async () => {
    const f = fixture(),
      store = storeFor(f);
    f.setOverride((_url, options) =>
      options.method === 'PATCH' ? reply({ private: privateValue }, 412) : undefined,
    );
    const client = nativeWebCreationFixtureClient({
      ...f.deps,
      recordIntent: async (state) => {
        store.recordIntent(state);
        await f.deps.recordIntent(state);
      },
    });
    await expect(client.execute(store.readCurrent(), 'createP', stamp)).rejects.toMatchObject({
      mutationState: 'may_have_been_attempted',
    });
    expect(readdirSync(store.directory)).toContain('unknown-2-createP.json');
    expect(() => store.readCurrent()).toThrow('held');
    expect(f.requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });
  it('keeps the phase unresolved when terminal postcheck completion cannot be durably recorded', async () => {
    const f = fixture(),
      store = storeFor(f);
    writeFileSync(join(store.directory, 'complete-3-createdP.json'), 'prior completion\n', {
      flag: 'wx',
      mode: 0o600,
    });
    const client = nativeWebCreationFixtureClient({
      ...f.deps,
      recordIntent: async (state) => {
        store.recordIntent(state);
        await f.deps.recordIntent(state);
      },
    });
    await expect(client.execute(store.readCurrent(), 'createP', stamp)).rejects.toMatchObject({
      mutationState: 'may_have_been_attempted',
    });
    expect(() => store.readCurrent()).toThrow('held');
    expect(f.writes()).toBe(1);
  });
});

describe('captured retirement lifecycle binding', () => {
  async function promotedPausedCandidate() {
    const f = fixture(),
      store = (() => {
        const root = mkdtempSync(join(tmpdir(), 'owner-web-retirement-private-'));
        chmodSync(root, 0o700);
        const receipts = createPrivateReleasePhaseReceipts(root, {
          source: f.context.source,
          runId: f.context.runId,
          attempt: f.context.attempt,
          manifest: f.context.manifest,
        });
        receipts.initialize(f.state());
        return receipts;
      })();
    const deps = {
      ...f.deps,
      recordIntent: async (state: State) => {
        store.recordIntent(state);
        await f.deps.recordIntent(state);
      },
    };
    const created = await nativeWebCreationFixtureClient(deps).execute(
      store.readCurrent(),
      'createP',
      stamp,
    );
    const attached = await nativeWebTrafficFixtureClient(deps).execute(created, 'attachP', stamp);
    const promoted = await nativeWebTrafficFixtureClient(deps).execute(attached, 'promoteP', stamp);
    return { f, store, promoted };
  }
  function retirementBody(state: State) {
    const candidate = releaseIdentity(state.context, 'P');
    return {
      name: WEB_SERVICE as typeof WEB_SERVICE,
      etag: state.snapshot.etag,
      traffic: [
        {
          type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' as const,
          revision: candidate.revision,
          tag: candidate.tag,
          percent: 100,
        },
      ],
    };
  }
  it('binds the real returned operation before wait and checkpoints only after captured completion', async () => {
    const { f, store, promoted } = await promotedPausedCandidate(),
      initialOperation = {
        name: 'projects/bmson-assistant/locations/us-west1/operations/op-retire-captured',
      },
      patchTraffic = vi.fn(async () => initialOperation),
      waitOperation = vi.fn(async (operation: unknown) => {
        expect(operation).toBe(initialOperation);
        expect(readdirSync(store.directory)).toContain('retirement-operation-11-promotedP.json');
      }),
      binding = bindCapturedRetirementToLifecycle(
        promoted,
        {
          readService: async () => ({}),
          readRevision: async () => ({}),
          patchTraffic,
          waitOperation,
          drain: async (seconds) => expect(seconds).toBe(600),
        },
        store,
      );
    const operation = await binding.io.patchTraffic(retirementBody(promoted));
    expect(operation).toBe(initialOperation);
    await binding.io.waitOperation(operation);
    expect(readdirSync(store.directory)).toContain('retirement-attempt-10-promotedP.json');

    const candidate = releaseIdentity(promoted.context, 'P');
    f.service.traffic = retirementBody(promoted).traffic;
    f.service.trafficStatuses = retirementBody(promoted).traffic.map(
      (row: {
        revision: string;
        tag: string;
        percent: number;
        type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION';
      }) => ({
        ...row,
        uri: `https://${row.tag}---assistant-web-3gimfiaifa-uw.a.run.app`,
      }),
    );
    f.service.urls = [
      f.service.uri,
      ...f.service.trafficStatuses.map((row: { uri: string }) => row.uri),
    ];
    f.service.latestReadyRevision = candidate.revision;
    f.service.latestCreatedRevision = candidate.revision;
    f.service.etag = 'after-retirement';
    f.service.generation = String(BigInt(f.service.generation) + 1n);
    f.service.observedGeneration = f.service.generation;
    const after = projectNativeWebSnapshot(
      f.service,
      {
        [promoted.context.canonical]: f.native[promoted.context.canonical]!,
        [candidate.revision]: f.native[candidate.revision]!,
      },
      promoted.context,
    );
    const completed = binding.complete(
      {
        serviceEtag: after.etag,
        serviceGeneration: after.generation,
        action: 'retire_exact_tags',
        drainSeconds: 600,
        drainCompleted: true,
      },
      after,
    );
    expect(completed.phase).toBe('retired');
    expect(store.readCurrent().receipt).toBe(completed.receipt);
    expect(readdirSync(store.directory)).toContain('checkpoint-12-retired.json');
  });
  it('does not call the provider if the prewrite retirement receipt cannot be created', async () => {
    const { store, promoted } = await promotedPausedCandidate(),
      body = retirementBody(promoted);
    writeFileSync(
      join(store.directory, 'retirement-attempt-10-promotedP.json'),
      'prior attempt\n',
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
    const patchTraffic = vi.fn(async () => ({
      name: 'projects/bmson-assistant/locations/us-west1/operations/never',
    }));
    const binding = bindCapturedRetirementToLifecycle(
      promoted,
      {
        readService: async () => ({}),
        readRevision: async () => ({}),
        patchTraffic,
        waitOperation: async () => {},
        drain: async () => {},
      },
      store,
    );
    await expect(binding.io.patchTraffic(body)).rejects.toThrow();
    expect(patchTraffic).not.toHaveBeenCalled();
  });
  it('holds an uncertain patch and refuses to wait when op receipt persistence fails', async () => {
    const { store, promoted } = await promotedPausedCandidate(),
      body = retirementBody(promoted),
      operation = { name: 'projects/bmson-assistant/locations/us-west1/operations/op-bind-fail' };
    writeFileSync(join(store.directory, 'retirement-operation-11-promotedP.json'), 'prior op\n', {
      flag: 'wx',
      mode: 0o600,
    });
    const patchTraffic = vi.fn(async () => operation),
      waitOperation = vi.fn(async () => {}),
      binding = bindCapturedRetirementToLifecycle(
        promoted,
        {
          readService: async () => ({}),
          readRevision: async () => ({}),
          patchTraffic,
          waitOperation,
          drain: async () => {},
        },
        store,
      );
    await expect(binding.io.patchTraffic(body)).rejects.toThrow('held');
    expect(patchTraffic).toHaveBeenCalledTimes(1);
    expect(waitOperation).not.toHaveBeenCalled();
    expect(readdirSync(store.directory)).toContain('retirement-attempt-10-promotedP.json');
    expect(() => store.readCurrent()).toThrow('held');
  });
  it('marks a completed-write postcheck or drain failure unresolved without retry', async () => {
    const { store, promoted } = await promotedPausedCandidate(),
      body = retirementBody(promoted),
      patchTraffic = vi.fn(async () => ({
        name: 'projects/bmson-assistant/locations/us-west1/operations/op-drain-fail',
      }));
    const binding = bindCapturedRetirementToLifecycle(
      promoted,
      {
        readService: async () => ({}),
        readRevision: async () => ({}),
        patchTraffic,
        waitOperation: async () => {},
        drain: async () => {
          throw new Error('untrusted drain failure');
        },
      },
      store,
    );
    await binding.io.patchTraffic(body);
    await binding.io.waitOperation({
      name: 'projects/bmson-assistant/locations/us-west1/operations/op-drain-fail',
    });
    binding.markUnresolved();
    expect(() => store.readCurrent()).toThrow('held');
    expect(patchTraffic).toHaveBeenCalledTimes(1);
  });
});

describe('pre-GET fixed revision scope', () => {
  it('refuses a sealed but unapproved extra native revision before any transport call', async () => {
    const f = fixture(),
      projection = projectNativeWebSnapshot(f.service, f.native, f.context);
    projection.revisions['assistant-web-unrelated'] = copy(projection.revisions[f.pin.revision]!);
    const s = captureLifecycle(f.context, projection);
    await expect(
      nativeWebCreationFixtureClient(f.deps).execute(s, 'createP', stamp),
    ).rejects.toMatchObject({ mutationState: 'not_attempted' });
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe('shared operation GET recovery budget', () => {
  it('charges recovery initial GET against the remaining single-session poll budget', async () => {
    const f = fixture();
    f.deps.sleep = async () => undefined;
    f.setInitialReply((op) => reply({ name: op.name, done: false }));
    let gets = 0;
    f.setOverride((url) => {
      if (!url.includes('/operations/')) return undefined;
      gets++;
      return reply({
        name:
          gets === 59
            ? 'projects/foreign/locations/us-west1/operations/x'
            : 'projects/bmson-assistant/locations/us-west1/operations/op-1',
        done: false,
      });
    });
    const c = nativeWebCreationFixtureClient(f.deps);
    await expect(c.execute(f.state(), 'createP', stamp)).rejects.toBeInstanceOf(NativeReleaseHold);
    expect(gets).toBe(59);
    await expect(c.recoverSameOperation()).rejects.toBeInstanceOf(NativeReleaseHold);
    expect(gets).toBe(60);
    expect(c.checkpoint().operationGets).toBe(60);
    expect(f.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
  });
  it('allows terminal read recovery on the final60th operation GET without a61st request', async () => {
    const f = fixture();
    f.deps.sleep = async () => undefined;
    f.setInitialReply((op) => reply({ name: op.name, done: false }));
    let gets = 0;
    f.setOverride((url) => {
      if (!url.includes('/operations/')) return undefined;
      gets++;
      if (gets === 59) return reply({ name: 'projects/foreign/locations/us-west1/operations/x' });
      if (gets < 59)
        return reply({
          name: 'projects/bmson-assistant/locations/us-west1/operations/op-1',
          done: false,
        });
      return undefined;
    });
    const c = nativeWebCreationFixtureClient(f.deps);
    await expect(c.execute(f.state(), 'createP', stamp)).rejects.toBeInstanceOf(NativeReleaseHold);
    expect((await c.recoverSameOperation()).phase).toBe('createdP');
    expect(gets).toBe(60);
    expect(c.checkpoint().operationGets).toBe(60);
    expect(f.writes()).toBe(1);
  });
});

describe('raw proof error privacy', () => {
  it('wraps hostile raw URL parser errors without their input payload', () => {
    const f = fixture();
    f.service.uri = 'https://%PRIVATE_NATIVE_PAYLOAD';
    let error: unknown;
    try {
      projectNativeWebSnapshot(f.service, f.native, f.context);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('Error: Native release validation held');
    expect(JSON.stringify(error)).not.toContain('PRIVATE_NATIVE_PAYLOAD');
    expect((error as Error & { input?: unknown }).input).toBeUndefined();
  });
});
