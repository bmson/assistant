import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  observeArchivedRuntimePair,
  RECLOSED_ARCHIVE_RUN_ID,
} from './owner-archived-runtime-native.js';
import { bootstrapDigest, RUN_ROOT, SERVICE_ROOT } from './owner-release-current-snapshot.js';
import { verifyRevisionImage } from './owner-release-image-resolution.js';

const source = '1c2ea3907bf17b14368846708002f9d4633f2092';
const manifest = '9ca6dcbb6a1c4b6e25ca6ea857c86ae1c3103a75d9a8e4e26af801f7b1c32647';
const failure = 'Archived runtime native pair is unproven';
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function roleFixture(role: 'agent' | 'web', id: string) {
  const parent = Buffer.from(`fixture-${role}-parent`);
  const child = Buffer.from(`fixture-${role}-child`);
  const repo = `us-west1-docker.pkg.dev/bmson-assistant/assistant/${role}`;
  const image = `${repo}@sha256:${sha(parent)}`;
  const resolved = `${repo}@sha256:${sha(child)}`;
  const env = Object.entries({
    ASSISTANT_RELEASE_SOURCE_SHA: source,
    ASSISTANT_RELEASE_MANIFEST: manifest,
    ASSISTANT_RELEASE_API_CONTRACT: '1',
    ASSISTANT_RELEASE_WRITES_PAUSED: 'false',
    ASSISTANT_WORKSPACE_ID: 'fixture-workspace',
    FIRESTORE_AGENT_ID: 'fixture-owner',
    FIRESTORE_DATABASE_ID: 'assistant-production',
    PERSISTENCE_DRIVER: 'firestore',
  }).map(([name, value]) => ({ name, value }));
  const c = { name: `${role}-1`, image, env };
  const revision = `assistant-${role}-fixture`;
  const serviceName = `${SERVICE_ROOT}${role}`;
  const revisionName = `${serviceName}/revisions/${revision}`;
  const account = `assistant-${role}@bmson-assistant.iam.gserviceaccount.com`;
  const routes = [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision, percent: 100 }];
  const service = {
    name: serviceName,
    uid: `11111111-1111-4111-8111-${id.repeat(12)}`,
    generation: '2',
    observedGeneration: '2',
    latestCreatedRevision: revisionName,
    latestReadyRevision: revisionName,
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    scaling: { scalingMode: 'AUTOMATIC' },
    traffic: routes,
    trafficStatuses: structuredClone(routes),
    template: { revision, serviceAccount: account, containers: [c] },
  };
  return {
    service,
    native: {
      name: revisionName,
      service: serviceName,
      uid: `22222222-2222-4222-8222-${id.repeat(12)}`,
      generation: '1',
      observedGeneration: '1',
      serviceAccount: account,
      conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
      containers: [{ ...structuredClone(c), image: resolved }],
      containerStatuses: [{ name: c.name, imageDigest: resolved }],
    },
    evidence: {
      parent,
      child,
      receipt: Buffer.alloc(0),
      signature: Buffer.alloc(0),
      sbom: Buffer.alloc(0),
    },
    revision,
  };
}

function fixture() {
  const agent = roleFixture('agent', '1');
  const web = roleFixture('web', '2');
  const urls = new Map<string, Record<string, unknown>>([
    [RUN_ROOT + agent.service.name, agent.service],
    [RUN_ROOT + agent.native.name, agent.native],
    [RUN_ROOT + web.service.name, web.service],
    [RUN_ROOT + web.native.name, web.native],
  ]);
  const mk = (row: typeof agent) => ({
    revision: row.revision,
    serviceUidSha256: bootstrapDigest(row.service.uid),
    revisionUidSha256: bootstrapDigest(row.native.uid),
    serviceSha256: bootstrapDigest(row.service),
    revisionSha256: bootstrapDigest(row.native),
  });
  return {
    agent,
    web,
    urls,
    binding: () => ({ format: 1, roles: { agent: mk(agent), web: mk(web) } }),
    roles: { agent: agent.evidence, web: web.evidence },
    read: vi.fn(async (url: string) => urls.get(url)),
  };
}

function reclosedFixture() {
  const f = fixture();
  const binding = f.binding();
  const names = { agent: '', web: '' };
  for (const role of ['agent', 'web'] as const) {
    const { service, native } = f[role];
    const paused = `assistant-${role}-p-${RECLOSED_ARCHIVE_RUN_ID}-1-bc74fbf7`;
    const name = `${service.name}/revisions/${paused}`;
    service.latestCreatedRevision = name;
    service.latestReadyRevision = name;
    const [container] = service.template.containers;
    if (!container) throw new Error('Expected fixture container');
    service.template = {
      ...service.template,
      revision: paused,
      containers: [{ ...container, image: 'synthetic-reviewed-api3' }],
    };
    f.urls.set(RUN_ROOT + name, { ...native, name, uid: 'previous-paused-uid' });
    names[role] = paused;
  }
  const verify = vi.fn(async () => {});
  return {
    ...f,
    optIn: { runId: RECLOSED_ARCHIVE_RUN_ID, verify },
    binding,
    names,
    verify,
  };
}

describe('explicit archived original native pair observation', () => {
  it('binds the original routes plus both fixed paused predecessor revisions to fresh Automatic service evidence', async () => {
    const f = reclosedFixture();
    await expect(observeArchivedRuntimePair(f.binding, f.roles, f.read)).rejects.toThrow(failure);
    f.read.mockClear();
    await expect(
      observeArchivedRuntimePair(f.binding, f.roles, f.read, f.optIn),
    ).resolves.toMatchObject({
      status: 'observed_archived_original_pair',
      reclosedPredecessorRunId: RECLOSED_ARCHIVE_RUN_ID,
      liveServiceSha256: {
        agent: bootstrapDigest(f.agent.service),
        web: bootstrapDigest(f.web.service),
      },
      routing: 'canonical_only',
      mutationAuthorized: false,
    });
    expect(f.verify).toHaveBeenCalledExactlyOnceWith({
      agent: {
        service: f.agent.service,
        revisions: {
          [f.agent.revision]: f.agent.native,
          [f.names.agent]: expect.objectContaining({ name: f.agent.service.latestCreatedRevision }),
        },
      },
      web: {
        service: f.web.service,
        revisions: {
          [f.web.revision]: f.web.native,
          [f.names.web]: expect.objectContaining({ name: f.web.service.latestCreatedRevision }),
        },
      },
    });
    expect(f.read).toHaveBeenCalledTimes(8);
  });

  it('rejects an unpinned run before reading and keeps original UIDs and routes mandatory', async () => {
    const f = reclosedFixture();
    await expect(
      observeArchivedRuntimePair(f.binding, f.roles, f.read, { ...f.optIn, runId: '44632388670' }),
    ).rejects.toThrow(failure);
    expect(f.read).not.toHaveBeenCalled();
    const uid = f.web.native.uid;
    f.web.native.uid = f.agent.native.uid;
    await expect(observeArchivedRuntimePair(f.binding, f.roles, f.read, f.optIn)).rejects.toThrow(
      failure,
    );
    f.web.native.uid = uid;
    f.web.service.trafficStatuses = f.web.service.trafficStatuses.map((row) => ({
      ...row,
      tag: 'candidate-44632388669-1',
    }));
    await expect(observeArchivedRuntimePair(f.binding, f.roles, f.read, f.optIn)).rejects.toThrow(
      failure,
    );
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('rejects the reclosed baseline when its pinned proof fails or fresh services drift', async () => {
    const f = reclosedFixture();
    f.verify.mockRejectedValueOnce(new Error('Predecessor effect unproven'));
    await expect(observeArchivedRuntimePair(f.binding, f.roles, f.read, f.optIn)).rejects.toThrow(
      failure,
    );
    f.verify.mockImplementation(async () => {
      f.web.service.observedGeneration = f.web.service.generation = '3';
    });
    await expect(observeArchivedRuntimePair(f.binding, f.roles, f.read, f.optIn)).rejects.toThrow(
      failure,
    );
  });

  it('uses six fixed GET targets, returns a minimal pair result, and leaves normal image validation untouched', async () => {
    const f = fixture();
    await expect(observeArchivedRuntimePair(f.binding(), f.roles, f.read)).resolves.toEqual({
      status: 'observed_archived_original_pair',
      source,
      observedTemplateWritesPaused: false,
      routing: 'canonical_only',
      mutationAuthorized: false,
      trafficAuthorized: false,
    });
    expect(f.read.mock.calls.flat()).toEqual([
      RUN_ROOT + f.agent.service.name,
      RUN_ROOT + f.agent.native.name,
      RUN_ROOT + f.web.service.name,
      RUN_ROOT + f.web.native.name,
      RUN_ROOT + f.agent.service.name,
      RUN_ROOT + f.web.service.name,
    ]);
    expect(() =>
      verifyRevisionImage(f.agent.native, f.agent.service.template.containers[0]?.image ?? ''),
    ).toThrow();
  });

  it.each(['https://other.example/fake', '../web', 'assistant-agent-x?alt=media'])(
    'rejects invalid revision target %s before reading anything',
    async (value) => {
      const f = fixture();
      const binding = f.binding();
      binding.roles.agent.revision = value;
      await expect(observeArchivedRuntimePair(binding, f.roles, f.read)).rejects.toThrow(failure);
      expect(f.read).not.toHaveBeenCalled();
    },
  );

  it('rejects review UID mismatch and any unreviewed current configuration change', async () => {
    const f = fixture();
    const binding = f.binding();
    binding.roles.web.serviceUidSha256 = 'a'.repeat(64);
    await expect(observeArchivedRuntimePair(binding, f.roles, f.read)).rejects.toThrow(failure);
    f.web.service.template.containers[0]?.env.push({ name: 'PRIVATE_CONFIG', value: 'private' });
    await expect(observeArchivedRuntimePair(binding, f.roles, f.read)).rejects.toThrow(failure);
    await expect(observeArchivedRuntimePair(f.binding(), f.roles, f.read)).rejects.toThrow(failure);
  });

  it.each([
    [
      'different requested parent',
      (f: ReturnType<typeof fixture>) =>
        Object.assign(f.web.service.template.containers[0] ?? {}, {
          image: f.agent.service.template.containers[0]?.image,
        }),
    ],
    [
      'different runtime child',
      (f: ReturnType<typeof fixture>) =>
        Object.assign(f.web.native.containers[0] ?? {}, {
          image: f.agent.native.containers[0]?.image,
        }),
    ],
    [
      'misbound status',
      (f: ReturnType<typeof fixture>) =>
        Object.assign(f.web.native.containerStatuses[0] ?? {}, { name: 'wrong' }),
    ],
    [
      'wrong account',
      (f: ReturnType<typeof fixture>) => {
        f.web.native.serviceAccount = f.agent.native.serviceAccount;
      },
    ],
    [
      'wrong revision service',
      (f: ReturnType<typeof fixture>) => {
        f.web.native.service = f.agent.service.name;
      },
    ],
    [
      'unsettled generation',
      (f: ReturnType<typeof fixture>) => {
        f.web.service.observedGeneration = '1';
      },
    ],
    [
      'partial traffic',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.web.service.trafficStatuses[0] ?? {}, { percent: 50 });
      },
    ],
    [
      'reachable alias',
      (f: ReturnType<typeof fixture>) =>
        Object.assign(f.web.service.traffic[0] ?? {}, { tag: 'unexpected' }),
    ],
    [
      'not ready',
      (f: ReturnType<typeof fixture>) => {
        Object.assign(f.web.native.conditions[0] ?? {}, { state: 'CONDITION_FAILED' });
      },
    ],
  ] as const)('rejects %s even with a matching document hash', async (_name, alter) => {
    const f = fixture();
    alter(f);
    await expect(observeArchivedRuntimePair(f.binding(), f.roles, f.read)).rejects.toThrow(failure);
  });

  it('rejects cross-role evidence and incomplete pair observations without leaking transport errors', async () => {
    const f = fixture();
    await expect(
      observeArchivedRuntimePair(f.binding(), { agent: f.roles.agent, web: f.roles.agent }, f.read),
    ).rejects.toThrow(failure);
    f.read.mockImplementation(async () => {
      throw new Error('PRIVATE_NATIVE_PROVIDER_BODY');
    });
    await expect(observeArchivedRuntimePair(f.binding(), f.roles, f.read)).rejects.toThrow(
      new RegExp(`^${failure}$`),
    );
  });

  it('rejects an incomplete native response set or a different observed write pause', async () => {
    const f = fixture();
    f.urls.delete(RUN_ROOT + f.agent.native.name);
    await expect(observeArchivedRuntimePair(f.binding(), f.roles, f.read)).rejects.toThrow(failure);
    f.urls.set(RUN_ROOT + f.agent.native.name, f.agent.native);
    for (const container of [
      f.agent.native.containers[0],
      f.agent.service.template.containers[0],
    ]) {
      const pause = container?.env.find((row) => row.name === 'ASSISTANT_RELEASE_WRITES_PAUSED');
      if (pause) pause.value = 'true';
    }
    await expect(observeArchivedRuntimePair(f.binding(), f.roles, f.read)).rejects.toThrow(failure);
  });

  it('rejects service drift on the final stable comparison', async () => {
    const f = fixture();
    let agentReads = 0;
    const read = async (url: string) => {
      const value = f.urls.get(url);
      if (url === RUN_ROOT + f.agent.service.name && ++agentReads === 2)
        return { ...value, generation: '3', observedGeneration: '3' };
      return value;
    };
    await expect(observeArchivedRuntimePair(f.binding(), f.roles, read)).rejects.toThrow(failure);
  });
});
