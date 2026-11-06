import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  planScalingRestore,
  restoreScaling,
  reviewedBootstrap,
  verifiedRestoreReceipts,
  verifyCurrentSnapshot,
} from './owner-release-bootstrap.js';

const source = 'a'.repeat(40),
  manifest = 'b'.repeat(64),
  hash = 'c'.repeat(64);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
function fixture(role: 'agent' | 'web' = 'web') {
  const name = `projects/bmson-assistant/locations/us-west1/services/assistant-${role}`;
  const image = `us-west1-docker.pkg.dev/bmson-assistant/assistant/${role}@sha256:${'d'.repeat(64)}`;
  const revision = `assistant-${role}-new`;
  const template = {
    revision,
    timeout: role === 'agent' ? '3600s' : '300s',
    containers: [
      {
        image,
        env: [
          { name: 'ASSISTANT_RELEASE_SOURCE_SHA', value: source },
          { name: 'ASSISTANT_RELEASE_MANIFEST', value: manifest },
          { name: 'ASSISTANT_RELEASE_WORKFLOW_RUN_ID', value: '9' },
          { name: 'ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT', value: '1' },
          { name: 'ASSISTANT_RELEASE_WRITES_PAUSED', value: 'true' },
        ],
        resources: { limits: { memory: '2Gi', cpu: '1' } },
      },
    ],
    maxInstanceRequestConcurrency: 1,
  };
  const { revision: _name, ...fields } = template;
  const native = {
    ...fields,
    name: `${name}/revisions/${revision}`,
    service: name,
    uid: 'new-uid',
    conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
  };
  const service = {
    name,
    uid: `${role}-uid`,
    etag: 'etag-2',
    generation: '2',
    observedGeneration: '2',
    reconciling: false,
    terminalCondition:{state:'CONDITION_SUCCEEDED'},
    template,
    traffic: [
      {
        type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
        revision,
        percent: 100,
        tag: 'candidate-9-1',
      },
    ],
    trafficStatuses: [
      {
        type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
        revision,
        percent: 100,
        tag: 'candidate-9-1',
      },
    ],
    scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 },
    latestCreatedRevision: `${name}/revisions/${revision}`,
    latestReadyRevision: `${name}/revisions/${revision}`,
  };
  const binding = (r: 'web' | 'agent') => ({
    service: `projects/bmson-assistant/locations/us-west1/services/assistant-${r}`,
    uid: `${r}-uid`,
    revision: `assistant-${r}-old`,
    image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/${r}@sha256:${'e'.repeat(64)}`,
    serviceSha256: hash,
    revisionSha256: hash,
    proof: {
      uid: hash,
      image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/${r}@sha256:${'e'.repeat(64)}`,
      source: 'f'.repeat(40),
      runId: '1',
      attempt: '1',
      manifest: hash,
      paused: false,
      templateSha256: hash,
    },
    automaticScaling: { scalingMode: 'AUTOMATIC', maxInstanceCount: 2 },
  });
  const receipt: BootstrapReceipt = {
    format: 1,
    kind: 'disabled-bootstrap',
    source,
    closureReceiptSha256: hash,
    drainReceiptSha256: hash,
    recoveryReceiptSha256: hash,
    services: { web: binding('web'), agent: binding('agent') },
  };
  return {
    receipt,
    service,
    native,
    expected: { source, manifest, image, revision, runId: '9', attempt: '1' },
    role,
  };
}
describe('reviewed current snapshot and bootstrap restoration', () => {
  it('requires exact reviewed source/digest and prior closure/drain/recovery references, not empty tags as drain evidence', () => {
    const f = fixture();
    expect(reviewedBootstrap(f.receipt, bootstrapDigest(f.receipt), source)).toEqual(f.receipt);
    expect(() => reviewedBootstrap(f.receipt, '0'.repeat(64), source)).toThrow();
    expect(() =>
      reviewedBootstrap(f.receipt, bootstrapDigest(f.receipt), '0'.repeat(40)),
    ).toThrow();
    for (const key of [
      'closureReceiptSha256',
      'drainReceiptSha256',
      'recoveryReceiptSha256',
    ] as const) {
      const changed = clone(f.receipt);
      changed[key] = '';
      expect(() => reviewedBootstrap(changed, bootstrapDigest(changed), source)).toThrow();
    }
  });
  it('binds a zero-tag disabled current snapshot, rejects image/revision/config/admission drift', () => {
    const f = fixture(),
      s = clone(f.service);
    delete (s.traffic[0] as { tag?: string }).tag;
    delete (s.trafficStatuses[0] as { tag?: string }).tag;
    const b = {
      ...f.receipt.services.web,
      revision: f.expected.revision,
      image: f.expected.image,
      serviceSha256: bootstrapDigest(s),
      revisionSha256: bootstrapDigest(f.native),
    };
    expect(() => verifyCurrentSnapshot(b, s, f.native)).not.toThrow();
    const changes = [
      { ...s, uid: 'other' },
      { ...s, scaling: { scalingMode: 'AUTOMATIC' } },
      { ...s, template: { ...s.template, maxInstanceRequestConcurrency: 80 } },
      { ...s, traffic: [{ ...s.traffic[0], tag: 'resume-1-1' }] },
    ];
    for (const changed of changes)
      expect(() => verifyCurrentSnapshot(b, changed, f.native)).toThrow();
  });
  it.each(['agent', 'web'] as const)(
    'restores only positively promoted new %s revision with strict real readiness',
    (role) => {
      const f = fixture(role);
      expect(planScalingRestore(f.receipt, role, f.service, f.native, f.expected)).toEqual({
        name: f.service.name,
        etag: f.service.etag,
        scaling: f.receipt.services[role].automaticScaling,
      });
      expect(() =>
        planScalingRestore(
          f.receipt,
          role,
          {
            ...f.service,
            trafficStatuses: [
              { ...f.service.trafficStatuses[0], revision: `assistant-${role}-old` },
            ],
          },
          f.native,
          f.expected,
        ),
      ).toThrow();
      for (const condition of [
        { type: 'Ready', state: 'CONDITION_FAILED' },
        { type: 'Ready', state: 'CONDITION_SUCCEEDED', revisionReason: 'HEALTH_CHECK_SKIPPED' },
        { type: 'Ready', state: 'CONDITION_UNKNOWN', revisionReason: 'HEALTH_CHECK_SKIPPED' },
        { type: 'Active', state: 'CONDITION_FAILED', revisionReason: 'RETIRED' },
      ])
        expect(() =>
          planScalingRestore(
            f.receipt,
            role,
            f.service,
            { ...f.native, conditions: [condition] },
            f.expected,
          ),
        ).toThrow();
      expect(() =>
        planScalingRestore(
          f.receipt,
          role,
          f.service,
          { ...f.native, conditions: [{ type: 'Ready', state: 'CONDITION_FAILED' }] },
          f.expected,
          true,
        ),
      ).not.toThrow();
      expect(() =>
        planScalingRestore(
          f.receipt,
          role,
          { ...f.service, template: { ...f.service.template, maxInstanceRequestConcurrency: 8 } },
          f.native,
          f.expected,
        ),
      ).toThrow();
      expect(() =>
        planScalingRestore(f.receipt, role, f.service, f.native, {
          ...f.expected,
          revision: f.receipt.services[role].revision,
        }),
      ).toThrow();
    },
  );
  it('refuses unknown/corrupt/wrong-source restoration receipts before a recovery write', () => {
    const a = {
        kind: 'bootstrap-scaling',
        role: 'web',
        source,
        outcome: 'attempted',
        beforeSha256: hash,
        requestSha256: hash,
      },
      c = {
        kind: 'bootstrap-scaling',
        role: 'web',
        source,
        outcome: 'completed',
        beforeSha256: hash,
        afterSha256: hash,
        afterConfigurationSha256: hash,
        operation: 'projects/bmson-assistant/locations/us-west1/operations/op-1',
      };
    expect(verifiedRestoreReceipts(a, c, false, 'web', source)).toBe(hash);
    for (const [attempt, completed, unknown] of [
      [a, c, true],
      [a, {}, false],
      [{}, c, false],
      [a, { ...c, source: 'f'.repeat(40) }, false],
      [a, { ...c, outcome: 'unknown' }, false],
    ] as const)
      expect(() => verifiedRestoreReceipts(attempt, completed, unknown, 'web', source)).toThrow();
  });
  it('persists intent before exactly one scaling PATCH and stops unknown outcomes without retry', async () => {
    const f = fixture(),
      calls: string[] = [],
      records: unknown[] = [];
    const io = {
      now: () => 0,
      sleep: async () => {},
      recordIntent: async (x: unknown) => {
        records.push(x);
        calls.push('intent');
      },
      request: async (url: string, opt: { method: string }) => {
        if (opt.method === 'PATCH') {
          calls.push('patch');
          throw new Error('network lost');
        }
        return new Response(JSON.stringify(url.includes('/revisions/') ? f.native : f.service), {
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    await expect(restoreScaling(io, f.receipt, 'web', f.expected)).rejects.toThrow('unconfirmed');
    expect(calls).toEqual(['intent', 'patch', 'intent']);
    expect(records).toMatchObject([{ outcome: 'attempted' }, { outcome: 'unknown' }]);
  });
  it('restores captured automatic scaling with an etag-only scaling mask and preserves every other setting', async () => {
    const f = fixture();
    let current = clone(f.service);
    const writes: unknown[] = [];
    const records: unknown[] = [];
    const io = {
      now: () => 0,
      sleep: async () => {},
      recordIntent: async (x: unknown) => {
        records.push(x);
      },
      request: async (url: string, opt: { method: string; body?: string }) => {
        if (opt.method === 'PATCH') {
          expect(url.endsWith('?updateMask=scaling')).toBe(true);
          const body = JSON.parse(opt.body ?? 'null');
          writes.push(body);
          expect(records).toMatchObject([{ outcome: 'attempted' }]);
          current = {
            ...current,
            scaling: body.scaling,
            etag: 'etag-3',
            generation: '3',
            observedGeneration: '3',
          };
          return new Response(
            JSON.stringify({
              name: 'projects/bmson-assistant/locations/us-west1/operations/op-1',
              done: true,
              response: { name: current.name },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify(url.includes('/revisions/') ? f.native : current), {
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const result = await restoreScaling(io, f.receipt, 'web', f.expected);
    expect(writes).toEqual([
      {
        name: f.service.name,
        etag: f.service.etag,
        scaling: f.receipt.services.web.automaticScaling,
      },
    ]);
    expect(result.after.template).toEqual(f.service.template);
    expect(result.after.traffic).toEqual(f.service.traffic);
    expect(records).toMatchObject([{ outcome: 'attempted' }, { outcome: 'completed' }]);
  });
  it('rejects oversized chunked native responses before mutation', async () => {
    const f = fixture();
    let patch = 0,
      cancelled = false;
    const io = {
      now: () => 0,
      sleep: async () => {},
      recordIntent: async () => {},
      request: async (_u: string, o: { method: string }) => {
        if (o.method === 'PATCH') patch++;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    };
    await expect(restoreScaling(io, f.receipt, 'web', f.expected)).rejects.toThrow();
    expect(patch).toBe(0);
    expect(cancelled).toBe(true);
  });
  it('wires promotion→scaling→canonical probe and agent promotion→scaling→acceptance; failed promotion cannot run restoration', () => {
    const shell = readFileSync('infra/gcp/release-staged-services.sh', 'utf8');
    const p = shell.indexOf('release_run_basic_web_phase promoteP'),
      w = shell.indexOf('release_bootstrap_scaling --bootstrap-restore web'),
      probe = shell.indexOf('release_wait_http "$live_web_url" /api/health', w);
    expect(p).toBeLessThan(w);
    expect(w).toBeLessThan(probe);
    expect(shell.slice(p, w)).toContain('"$promoted_ok" == true');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Inspect literal shell source ordering.
    const a = shell.indexOf('--to-revisions "${staged_agent_revision}=100"'),
      r = shell.indexOf('release_bootstrap_scaling --bootstrap-restore agent'),
      accept = shell.indexOf('release_accept_basic_web_agent_ready', r);
    expect(a).toBeLessThan(r);
    expect(r).toBeLessThan(accept);
    expect(shell).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal shell metadata contract.
      'agent_candidate_env="${agent_candidate_env},ASSISTANT_RELEASE_SOURCE_SHA=${TAG}',
    );
  });
});
