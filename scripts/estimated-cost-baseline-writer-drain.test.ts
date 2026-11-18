import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalEstimatedCostJson } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  type BaselineWriterDrainInputs,
  createBaselineCosignRegistryVerifier,
  observeBaselineWriterDrain,
  reconstructBaselineWriterManifest,
  verifyBaselineWriterDrain,
} from './estimated-cost-baseline-writer-drain.js';
import { bootstrapDigest, type BootstrapReceipt } from './owner-release-current-snapshot.js';

const source = 'a'.repeat(40),
  root = 'projects/bmson-assistant/locations/us-west1',
  roles = ['agent', 'web', 'browser', 'code', 'processor'] as const;
const digest = (v: unknown) =>
  createHash('sha256').update(canonicalEstimatedCostJson(v)).digest('hex');
function fixture() {
  const images = Object.fromEntries(
    roles.map((r, i) => [
      r,
      `us-west1-docker.pkg.dev/bmson-assistant/assistant/${r}@sha256:${String(i + 1).repeat(64)}`,
    ]),
  );
  const unsigned = {
    format: 1,
    release: source,
    selected: roles,
    storageDriver: 'firestore',
    schemaVersion: 1,
    components: Object.fromEntries(
      roles.map((r, i) => [
        r,
        {
          image: images[r],
          digest: `sha256:${String(i + 1).repeat(64)}`,
          apiContract: 1,
          peerApi: { min: 1, max: 1 },
          schema: { min: 1, max: 1 },
        },
      ]),
    ),
  };
  const manifest = {
    ...unsigned,
    manifestDigest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
  };
  const responses = new Map<string, unknown>();
  const current: any = {
    format: 1,
    kind: 'disabled-bootstrap',
    source,
    closureReceiptSha256: 'c'.repeat(64),
    drainReceiptSha256: 'd'.repeat(64),
    recoveryReceiptSha256: 'e'.repeat(64),
    services: {},
  };
  for (const role of ['agent', 'web'] as const) {
    const name = `${root}/services/assistant-${role}`,
      revision = `assistant-${role}-revision`,
      image = images[role];
    const env = [
      { name: 'ASSISTANT_RELEASE_WRITES_PAUSED', value: 'true' },
      { name: 'ASSISTANT_RELEASE_SOURCE_SHA', value: source },
      { name: 'ASSISTANT_RELEASE_MANIFEST', value: manifest.manifestDigest },
      ...['browser', 'code', 'processor'].flatMap((r) => [
        { name: `${r.toUpperCase()}_DRIVER`, value: 'cloudrun' },
        { name: `${r.toUpperCase()}_JOB_NAME`, value: `assistant-${r}` },
      ]),
    ];
    const service = {
      name,
      uid: `${role}-uid`,
      scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 },
      template: { containers: [{ image, env }] },
      traffic: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision, percent: 100 }],
      trafficStatuses: [
        { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision, percent: 100 },
      ],
      terminalCondition: { state: 'CONDITION_SUCCEEDED' },
      latestCreatedRevision: revision,
    };
    const rev = {
      name: `${name}/revisions/${revision}`,
      containers: [{ image, env }],
      conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
    };
    const base = `https://run.googleapis.com/v2/${name}`;
    responses.set(base, service);
    responses.set(`${base}/revisions/${revision}`, rev);
    current.services[role] = {
      service: name,
      uid: `${role}-uid`,
      revision,
      image,
      serviceSha256: bootstrapDigest(service),
      revisionSha256: bootstrapDigest(rev),
      automaticScaling: { scalingMode: 'AUTOMATIC' },
      proof: {
        image,
        source,
        paused: true,
        uid: 'a'.repeat(64),
        manifest: manifest.manifestDigest,
        runId: '1',
        attempt: '1',
        templateSha256: 'b'.repeat(64),
      },
    };
  }
  for (const role of ['browser', 'code', 'processor']) {
    const name = `${root}/jobs/assistant-${role}`,
      base = `https://run.googleapis.com/v2/${name}`;
    responses.set(base, {
      name,
      template: {
        template: {
          serviceAccount: `assistant-${role}@bmson-assistant.iam.gserviceaccount.com`,
          containers: [{ image: images[role] }],
        },
      },
    });
    responses.set(`${base}/executions?pageSize=100`, { executions: [] });
  }
  const queue = `${root}/queues/agent-steps`;
  responses.set(`https://cloudtasks.googleapis.com/v2/${queue}`, { name: queue, state: 'PAUSED' });
  responses.set(
    `https://cloudtasks.googleapis.com/v2/${queue}/tasks?pageSize=100&responseView=BASIC`,
    { tasks: [] },
  );
  for (const role of ['assistant-sweep', 'assistant-gmail-sync', 'assistant-gmail-watch']) {
    const name = `${root}/jobs/${role}`;
    responses.set(`https://cloudscheduler.googleapis.com/v1/${name}`, { name, state: 'PAUSED' });
  }
  const subscription = 'projects/bmson-assistant/subscriptions/gmail-events-push';
  responses.set(`https://pubsub.googleapis.com/v1/${subscription}`, {
    name: subscription,
    pushConfig: {},
  });
  const verifyImageSignature = vi.fn(async () => {});
  const input: BaselineWriterDrainInputs = {
    source,
    reviewedCurrent: current as BootstrapReceipt,
    reviewedCurrentDigest: bootstrapDigest(current),
    reviewedManifest: manifest,
    signatureBundles: Object.fromEntries(
      roles.map((r) => [r, new Uint8Array([1])]),
    ) as BaselineWriterDrainInputs['signatureBundles'],
    verifyImageSignature,
    verifyHoldContinuity: async () => {},
    readJson: async (url) => {
      if (!responses.has(url)) throw new Error(`unexpected ${url}`);
      return responses.get(url);
    },
  };
  return { input, responses, current, verifyImageSignature };
}
async function witnessed() {
  const f = fixture();
  const first = await observeBaselineWriterDrain(f.input);
  const packet = {
    format: 1,
    source,
    cutoff: '2026-11-18T00:00:00.000Z',
    censusDigest: 'f'.repeat(64),
    nativeDigest: first.nativeDigest,
    writersDigest: first.writersDigest,
  };
  f.current.drainReceiptSha256 = digest(packet);
  f.input.reviewedCurrentDigest = bootstrapDigest(f.current);
  return { ...f, packet };
}
describe('native writer drain verification', () => {
  it('reads every writer, checks every signature, and binds the fixed reviewed cutoff', async () => {
    const f = await witnessed();
    f.verifyImageSignature.mockClear();
    const value = await verifyBaselineWriterDrain({
      ...f.input,
      drainPacket: f.packet,
      censusDigest: f.packet.censusDigest,
      now: new Date('2026-11-18T00:10:00Z'),
    });
    expect(value.cutoff).toBe(f.packet.cutoff);
    expect(value.drainDigest).toBe(digest(f.packet));
    expect(f.verifyImageSignature).toHaveBeenCalledTimes(5);
  });
  it('fails on unfinished tasks, executions, detached-delivery drift, and writer image mismatch', async () => {
    const cases = [
      [
        `https://cloudtasks.googleapis.com/v2/${root}/queues/agent-steps/tasks?pageSize=100&responseView=BASIC`,
        {
          tasks: [
            { name: `${root}/queues/agent-steps/tasks/x`, dispatchCount: 1, responseCount: 0 },
          ],
        },
      ],
      [
        `https://run.googleapis.com/v2/${root}/jobs/assistant-code/executions?pageSize=100`,
        {
          executions: [
            { name: `${root}/jobs/assistant-code/executions/a`, startTime: '2026-11-18T00:00:00Z' },
          ],
        },
      ],
      [
        'https://pubsub.googleapis.com/v1/projects/bmson-assistant/subscriptions/gmail-events-push',
        {
          name: 'projects/bmson-assistant/subscriptions/gmail-events-push',
          pushConfig: { pushEndpoint: 'https://example.invalid' },
        },
      ],
      [
        `https://run.googleapis.com/v2/${root}/jobs/assistant-code`,
        {
          name: `${root}/jobs/assistant-code`,
          template: { template: { serviceAccount: 'other', containers: [{ image: 'other' }] } },
        },
      ],
    ] as const;
    for (const [path, data] of cases) {
      const f = await witnessed();
      f.responses.set(path, data);
      await expect(
        verifyBaselineWriterDrain({
          ...f.input,
          drainPacket: f.packet,
          censusDigest: f.packet.censusDigest,
          now: new Date('2026-11-18T00:10:00Z'),
        }),
      ).rejects.toThrow();
    }
  });
  it('fails when native pages or signatures cannot be verified', async () => {
    const f = await witnessed();
    f.responses.set(
      `https://cloudtasks.googleapis.com/v2/${root}/queues/agent-steps/tasks?pageSize=100&responseView=BASIC`,
      { nextPageToken: 'next' },
    );
    await expect(
      verifyBaselineWriterDrain({
        ...f.input,
        drainPacket: f.packet,
        censusDigest: f.packet.censusDigest,
        now: new Date('2026-11-18T00:10:00Z'),
      }),
    ).rejects.toThrow();
    const g = await witnessed();
    g.verifyImageSignature.mockRejectedValue(new Error('bad signature'));
    await expect(
      verifyBaselineWriterDrain({
        ...g.input,
        drainPacket: g.packet,
        censusDigest: g.packet.censusDigest,
        now: new Date('2026-11-18T00:10:00Z'),
      }),
    ).rejects.toThrow();
  });
  it('follows every page and rejects an active task on a later page', async () => {
    const f = fixture();
    const base = `https://cloudtasks.googleapis.com/v2/${root}/queues/agent-steps/tasks`;
    f.responses.set(`${base}?pageSize=100&responseView=BASIC`, {
      tasks: [],
      nextPageToken: 'next',
    });
    f.responses.set(`${base}?pageSize=100&responseView=BASIC&pageToken=next`, { tasks: [] });
    await expect(observeBaselineWriterDrain(f.input)).resolves.toMatchObject({
      sourceDigest: expect.any(String),
    });
    f.responses.set(`${base}?pageSize=100&responseView=BASIC&pageToken=next`, {
      tasks: [
        { name: `${root}/queues/agent-steps/tasks/active`, dispatchCount: 1, responseCount: 0 },
      ],
    });
    await expect(observeBaselineWriterDrain(f.input)).rejects.toThrow();
  });
  it('invokes a pinned Cosign adapter with exact source and identity and rejects an old version (synthetic executable)', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'baseline-cosign-test-'));
    try {
      const executable = join(folder, 'cosign'),
        log = join(folder, 'args');
      const code = (version: string) =>
        `#!/bin/sh\nif [ \"$1\" = version ]; then echo '{\"gitVersion\":\"${version}\"}'; else printf '%s\\n' \"$@\" > \"$TEST_LOG\"; echo '[{}]'; fi\n`;
      writeFileSync(executable, code('v3.1.2'), { mode: 0o700 });
      const make = () =>
        createBaselineCosignRegistryVerifier({
          executable,
          executableSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
          environment: { TEST_LOG: log },
        });
      expect(make).toThrow();
      writeFileSync(executable, code('v3.1.3'), { mode: 0o700 });
      const verify = make();
      await verify({
        role: 'agent',
        image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/agent@sha256:${'1'.repeat(64)}`,
        source,
        certificateIdentity:
          'https://github.com/bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
        certificateIssuer: 'https://token.actions.githubusercontent.com',
      });
      const args = readFileSync(log, 'utf8');
      expect(args).toContain(`--certificate-github-workflow-sha=${source}`);
      expect(args).toContain(
        '--certificate-oidc-issuer=https://token.actions.githubusercontent.com',
      );
      expect(args).toContain(
        '--certificate-identity=https://github.com/bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it('reconstructs the exact source manifest from five native templates and contracts', async () => {
    const f = fixture();
    const original = f.input.reviewedManifest as {
      components: Record<string, { apiContract: number; peerApi: unknown; schema: unknown }>;
    };
    const releaseContract = {
      storageSchemaVersion: { firestore: 1 },
      components: Object.fromEntries(
        roles.map((r) => [
          r,
          {
            apiContract: original.components[r]!.apiContract,
            peerApi: original.components[r]!.peerApi,
            schema: { firestore: original.components[r]!.schema },
          },
        ]),
      ),
    };
    expect(
      await reconstructBaselineWriterManifest({
        source,
        readJson: f.input.readJson,
        releaseContract,
      }),
    ).toEqual(f.input.reviewedManifest);
  });
  it('requires independent continuity verification rather than inferring it from matching snapshots', async () => {
    const f = await witnessed();
    const input = {
      ...f.input,
      drainPacket: f.packet,
      censusDigest: f.packet.censusDigest,
      now: new Date('2026-11-18T00:10:00Z'),
    };
    await expect(
      verifyBaselineWriterDrain({ ...input, verifyHoldContinuity: undefined }),
    ).rejects.toThrow();
    await expect(
      verifyBaselineWriterDrain({
        ...input,
        verifyHoldContinuity: async () => {
          throw new Error('continuity unavailable');
        },
      }),
    ).rejects.toThrow('continuity unavailable');
  });
});
