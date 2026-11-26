import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as recovery from '../infra/gcp/api3-recovery-proof.mjs';
import * as metadata from './estimated-cost-release-native-read.js';
import * as spending from './estimated-cost-release-profile.js';
import * as input from './owner-archived-runtime-input.js';
import type { ArchivedRoleEvidence } from './owner-archived-runtime-pack.js';
import {
  verifyDrainedApiTransition,
  verifyProductionApiTransition,
  verifyTransitionCandidateContract,
} from './owner-release-api-transition.js';
import { type BootstrapReceipt, bootstrapDigest } from './owner-release-current-snapshot.js';
import * as images from './owner-release-image-resolution.js';
import * as restoreReview from './owner-restore-target-review.js';
import * as restoreTarget from './owner-restore-target-verify.js';
import * as holds from './owner-web-release-operator-hold.js';
import * as credentials from './owner-web-tag-cloud.js';
import { tagHash } from './owner-web-tag-retirement.js';

const scope = {
  installationId: 'fixture-installation',
  ownerId: '11111111-1111-4111-8111-111111111111',
};
const source = 'a'.repeat(40);
const oldSource = 'b'.repeat(40);
const oldManifest = 'c'.repeat(64);
const agentUrl = 'https://assistant-agent-fixture-uw.a.run.app';

function nativeRole(role: 'agent' | 'web') {
  const name = `projects/bmson-assistant/locations/us-west1/services/assistant-${role}`;
  const revisionId = `assistant-${role}-old`;
  const image = `us-west1-docker.pkg.dev/bmson-assistant/assistant/${role}@sha256:${'d'.repeat(64)}`;
  const peer = role === 'web' ? 'AGENT' : 'WEB';
  const container = {
    image,
    env: Object.entries({
      PERSISTENCE_DRIVER: 'firestore',
      FIRESTORE_DATABASE_ID: 'assistant-production',
      ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
      ASSISTANT_RELEASE_SCHEMA_MIN: '1',
      ASSISTANT_RELEASE_SCHEMA_MAX: '1',
      ASSISTANT_RELEASE_SCHEMA_VERSION: '1',
      ASSISTANT_RELEASE_API_CONTRACT: '1',
      [`ASSISTANT_RELEASE_${peer}_API_MIN`]: '1',
      [`ASSISTANT_RELEASE_${peer}_API_MAX`]: '1',
      ASSISTANT_RELEASE_SOURCE_SHA: oldSource,
      ASSISTANT_RELEASE_MANIFEST: oldManifest,
      ASSISTANT_RELEASE_WORKFLOW_RUN_ID: '123',
      ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT: '1',
      ASSISTANT_RELEASE_WRITES_PAUSED: 'false',
      FIRESTORE_AGENT_ID: scope.ownerId,
      ASSISTANT_WORKSPACE_ID: scope.installationId,
      ...(role === 'web' ? { AGENT_URL: agentUrl } : {}),
    }).map(([name, value]) => ({ name, value })),
  };
  const runtime = {
    serviceAccount: `assistant-${role}@bmson-assistant.iam.gserviceaccount.com`,
    containers: [container],
  };
  const traffic = [
    {
      type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
      revision: revisionId,
      percent: 100,
      tag: '',
    },
  ];
  const service = {
    name,
    uid: `svc-${role}`,
    uri: role === 'agent' ? agentUrl : 'https://assistant-web-fixture-uw.a.run.app',
    generation: '2',
    observedGeneration: '2',
    reconciling: false,
    template: { revision: revisionId, ...structuredClone(runtime) },
    scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 },
    traffic,
    trafficStatuses: structuredClone(traffic),
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    latestCreatedRevision: revisionId,
  };
  const revision = {
    name: `${name}/revisions/${revisionId}`,
    uid: `rev-${role}`,
    service: name,
    generation: '1',
    observedGeneration: '1',
    reconciling: false,
    ...runtime,
    conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
  };
  const binding = {
    service: name,
    uid: service.uid,
    revision: revisionId,
    image,
    serviceSha256: bootstrapDigest(service),
    revisionSha256: bootstrapDigest(revision),
    automaticScaling: { scalingMode: 'AUTOMATIC', maxInstanceCount: 20 },
    proof: {
      uid: tagHash(revision.uid),
      source: oldSource,
      manifest: oldManifest,
      image,
      runId: '123',
      attempt: '1',
      paused: false,
      templateSha256: bootstrapDigest(service.template),
    },
  };
  return { service, revision, binding };
}

function scenario() {
  const native = { agent: nativeRole('agent'), web: nativeRole('web') };
  const receipt: BootstrapReceipt = {
    format: 1,
    kind: 'disabled-bootstrap',
    source,
    closureReceiptSha256: 'e'.repeat(64),
    drainReceiptSha256: 'e'.repeat(64),
    recoveryReceiptSha256: 'e'.repeat(64),
    services: { agent: native.agent.binding, web: native.web.binding },
  };
  const check = () => verifyDrainedApiTransition(receipt, native, scope);
  function change(role: 'web' | 'agent', key: string, value: string) {
    const { service, revision, binding } = native[role];
    for (const template of [service.template, revision]) {
      const env = template.containers[0]?.env;
      if (!env) throw new Error('fixture env unavailable');
      const entry = env.find((e) => e.name === key);
      if (entry) entry.value = value;
      else env.push({ name: key, value });
    }
    binding.serviceSha256 = bootstrapDigest(service);
    binding.revisionSha256 = bootstrapDigest(revision);
  }
  return { native, receipt, check, change };
}

describe('protected drained Firestore API transition', () => {
  it('accepts the closed and source-bound API 1 pair with MCP sign-in off', () => {
    const pair = scenario();
    expect(pair.check).not.toThrow();
    pair.change('agent', 'MCP_OAUTH_ENABLED', 'false');
    expect(pair.check).not.toThrow();
  });

  it('reads the serving API 1 contract through a verified dormant template only on the exact closed pair', () => {
    const { receipt, native } = scenario();
    function stagePredecessor(role: 'agent' | 'web') {
      const { binding, service, revision } = native[role];
      const originalTemplate = structuredClone(service.template);
      const predecessorRevision = `assistant-${role}-p-234-1-bbbbbbbb`;
      service.template.revision = predecessorRevision;
      const api = service.template.containers[0]?.env.find(
        (e) => e.name === 'ASSISTANT_RELEASE_API_CONTRACT',
      );
      if (!api) throw new Error('Missing fixture API contract');
      api.value = '3';
      service.latestCreatedRevision = predecessorRevision;
      Object.assign(service, { latestReadyRevision: predecessorRevision });
      binding.serviceSha256 = bootstrapDigest(service);
      return {
        predecessorRevision,
        predecessorRevisionSha256: 'e'.repeat(64),
        originalTemplate,
        originalRevision: revision,
      };
    }
    const reclosed = { agent: stagePredecessor('agent'), web: stagePredecessor('web') };
    expect(() => verifyDrainedApiTransition(receipt, native, scope)).toThrow();
    expect(() => verifyDrainedApiTransition(receipt, native, scope, reclosed)).not.toThrow();
    for (const row of native.agent.service.traffic) row.tag = 'candidate';
    expect(() => verifyDrainedApiTransition(receipt, native, scope, reclosed)).toThrow();
  });

  it.each([
    ['agent', 'ASSISTANT_RELEASE_API_CONTRACT', '3'],
    ['agent', 'ASSISTANT_RELEASE_WEB_API_MAX', '3'],
    ['web', 'ASSISTANT_WORKSPACE_ID', 'other'],
    ['web', 'AGENT_URL', 'https://candidate---assistant-agent-fixture-uw.a.run.app'],
    ['web', 'MCP_OAUTH_ENABLED', 'true'],
    ['agent', 'FIRESTORE_AGENT_ID', 'different'],
  ] as const)('rejects a rehashed but incompatible %s %s', (role, name, value) => {
    const pair = scenario();
    pair.change(role, name, value);
    expect(pair.check).toThrow();
  });

  it('rejects a current snapshot, changed generations, and a reachable old alias', () => {
    const pair = scenario();
    pair.receipt.kind = 'current-snapshot';
    expect(pair.check).toThrow();
    pair.receipt.kind = 'disabled-bootstrap';
    pair.native.agent.service.observedGeneration = '1';
    pair.native.agent.binding.serviceSha256 = bootstrapDigest(pair.native.agent.service);
    expect(pair.check).toThrow();
    pair.native.agent.service.observedGeneration = '2';
    const route = pair.native.agent.service.traffic[0];
    if (!route) throw new Error('missing native route fixture');
    route.tag = 'retained';
    pair.native.agent.binding.serviceSha256 = bootstrapDigest(pair.native.agent.service);
    expect(pair.check).toThrow();
  });

  it('requires the exact API 3 / Firestore 1 candidate contract in both directions', () => {
    const component = {
      apiContract: 3,
      peerApi: { min: 3, max: 3 },
      schema: { firestore: { min: 1, max: 1 } },
    };
    const candidate = {
      storageSchemaVersion: { firestore: 1 },
      components: { agent: structuredClone(component), web: structuredClone(component) },
    };
    expect(() => verifyTransitionCandidateContract(candidate)).not.toThrow();
    candidate.components.web.peerApi.min = 1;
    expect(() => verifyTransitionCandidateContract(candidate)).toThrow();
  });
});

describe('protected transition entry point', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function protectedRun() {
    const pair = scenario();
    vi.stubEnv('OWNER_RELEASE_RESTORE_TARGET_PROOF', undefined);
    for (const [key, value] of Object.entries({
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'bmson/assistant',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
      GITHUB_WORKFLOW_SHA: source,
      GITHUB_SHA: source,
      GITHUB_RUN_ID: '456',
      GITHUB_RUN_ATTEMPT: '1',
      GCP_PROJECT: 'bmson-assistant',
      GCP_DEPLOY_SERVICE_ACCOUNT: 'release@fixture.iam.gserviceaccount.com',
      GCP_WORKLOAD_IDENTITY_PROVIDER:
        'projects/123/locations/global/workloadIdentityPools/test/providers/test',
      IMAGE_TAG: source,
      RELEASE_COMPONENTS: 'agent,web',
      OWNER_RELEASE_BOOTSTRAP_RECEIPT: JSON.stringify(pair.receipt),
      OWNER_RELEASE_BOOTSTRAP_SHA256: bootstrapDigest(pair.receipt),
      ESTIMATED_COST_DRAIN_PACKET_JSON: '',
      API3_RECOVERY_PROOF: '',
    }))
      vi.stubEnv(key, value);
    const credential = vi
      .spyOn(credentials, 'protectedWebTagCredential')
      .mockResolvedValue('fixture');
    return { pair, credential };
  }

  function mockBase(pair: ReturnType<typeof scenario>) {
    vi.spyOn(spending, 'reviewedEstimatedCostReleaseProfile').mockReturnValue({
      ...scope,
      format: 1,
      mode: 'compatible-off',
      source,
      projectId: 'bmson-assistant',
      providerSecret: 'fixture',
      providerVersion: '1',
      reviewedAt: new Date(0).toISOString(),
      expiresAt: new Date(1000).toISOString(),
    });
    const hold = vi.spyOn(holds, 'verifyOperatorOwnedHold').mockResolvedValue({
      source,
      runId: '456',
      attempt: '1',
      currentJob: 'release',
      deployWorkflowId: 1,
      cleanupWorkflowId: 2,
      workspaceImportWorkflowId: 3,
      cleanupVariable: 'false',
    });
    const read = vi.fn(async (url: string) => {
      for (const native of Object.values(pair.native)) {
        if (url === `https://run.googleapis.com/v2/${native.service.name}`) return native.service;
        if (url === `https://run.googleapis.com/v2/${native.revision.name}`) return native.revision;
      }
      throw new Error('Unexpected provider read');
    });
    vi.spyOn(metadata, 'estimatedCostMetadataRead').mockReturnValue(read);
    return { hold, read };
  }

  it('the executable CLI fails closed with a sanitized message outside the protected invocation', () => {
    const cli = fileURLToPath(new URL('./owner-release-api-transition.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', cli], {
      env: { OWNER_RELEASE_RESTORE_TARGET_PROOF: 'untrusted proof contents' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'The reviewed drained Firestore API transition could not be verified.\n',
    );
  });

  it('holds before cloud access when an independent recovery review is missing', async () => {
    const { credential } = protectedRun();
    const hold = vi.spyOn(holds, 'verifyOperatorOwnedHold');
    const review = vi.spyOn(recovery, 'protectedRecoveryReview');
    await expect(verifyProductionApiTransition()).rejects.toThrow();
    expect(review).toHaveBeenCalledWith(process.env, source);
    expect(hold).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
  });

  it.each(['same review', 'changed review', 'expired review'] as const)(
    'requires a stable, current qualification after both native readbacks (%s)',
    async (outcome) => {
      const { pair } = protectedRun();
      const review = vi.spyOn(recovery, 'protectedRecoveryReview').mockReturnValueOnce({ source });
      review.mockImplementationOnce(() => {
        if (outcome === 'expired review') throw new Error('expired review');
        return outcome === 'same review' ? { source } : { source, replacement: true };
      });
      const { read } = mockBase(pair);
      vi.spyOn(images, 'createImageResolutionReader').mockReturnValue(async () => {});
      const preflight = verifyProductionApiTransition();
      if (outcome === 'same review') await expect(preflight).resolves.toBeUndefined();
      else await expect(preflight).rejects.toThrow();
      expect(read).toHaveBeenCalledTimes(4);
      expect(review).toHaveBeenCalledTimes(2);
      expect(Math.max(...read.mock.invocationCallOrder)).toBeLessThan(
        Math.max(...review.mock.invocationCallOrder),
      );
    },
  );
  it('rejects an explicitly empty or malformed archive review without falling back', async () => {
    const { pair, credential } = protectedRun();
    const { hold, read } = mockBase(pair);
    vi.spyOn(recovery, 'protectedRecoveryReview').mockReturnValue({ source });
    const load = vi.spyOn(input, 'loadReviewedArchivedRuntimePack').mockResolvedValue({
      sha256: 'e'.repeat(64),
      nativeBinding: {},
      trustedRoot: Buffer.from('{}'),
      roles: testArchivedRoles(),
    });
    const approval = vi
      .spyOn(restoreReview, 'protectedRestoreTargetReview')
      .mockImplementation(() => {
        throw new Error('malformed archive review');
      });
    const ordinary = vi.spyOn(images, 'createImageResolutionReader');

    vi.stubEnv('OWNER_RELEASE_RESTORE_TARGET_PROOF', '');
    await expect(verifyProductionApiTransition()).rejects.toThrow('Drained API transition held');
    expect(load).not.toHaveBeenCalled();

    vi.stubEnv('OWNER_RELEASE_RESTORE_TARGET_PROOF', 'malformed');
    await expect(verifyProductionApiTransition()).rejects.toThrow('malformed archive review');
    expect(approval).toHaveBeenCalledOnce();
    expect(ordinary).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  function testArchivedRoles() {
    const role = (name: string): ArchivedRoleEvidence => ({
      parent: Buffer.from(`parent-${name}`),
      child: Buffer.from(`child-${name}`),
      receipt: Buffer.from('{}'),
      signature: Buffer.from('{}'),
      sbom: Buffer.from('{}'),
    });
    return { agent: role('agent'), web: role('web') };
  }

  it.each([
    'confirmed',
    'restore target gone',
    'native drift',
    'review changed',
    'expired',
  ] as const)(
    'rechecks deployable targets and both old revisions in the normal transition entry point (%s)',
    async (outcome) => {
      const { pair } = protectedRun();
      const { read } = mockBase(pair);
      const independent = vi.spyOn(recovery, 'protectedRecoveryReview').mockReturnValue({ source });
      const ordinary = vi.spyOn(images, 'createImageResolutionReader');
      vi.stubEnv('OWNER_RELEASE_RESTORE_TARGET_PROOF', 'signed fixture');
      const roles = testArchivedRoles();
      const pack = {
        sha256: 'e'.repeat(64),
        nativeBinding: {},
        trustedRoot: Buffer.from('{}'),
        roles,
      };
      vi.spyOn(input, 'loadReviewedArchivedRuntimePack').mockResolvedValue(pack);
      function target(name: 'agent' | 'web') {
        const { binding } = pair.native[name];
        return {
          image: binding.image,
          parent: 'parent',
          child: 'child',
          baselineUidSha256: binding.proof.uid,
          baselineTemplateSha256: binding.proof.templateSha256,
          rehearsalUidSha256: 'f'.repeat(64),
        };
      }
      const initial = {
        source,
        reviewSha256: 'f'.repeat(64),
        maintenanceRunId: '678',
        maintenanceReceiptSha256: 'a'.repeat(64),
        runId: '456',
        buildRunId: '789',
        candidateBuildSha256: '9'.repeat(64),
        observedAt: 0,
        expiresAt: 1000,
        targets: { agent: target('agent'), web: target('web') },
      };
      const approval = vi
        .spyOn(restoreReview, 'protectedRestoreTargetReview')
        .mockReturnValueOnce(initial)
        .mockReturnValue(
          outcome === 'review changed' ? { ...initial, reviewSha256: '0'.repeat(64) } : initial,
        );
      const fresh = vi
        .spyOn(restoreReview, 'assertRestoreTargetReviewFresh')
        .mockImplementationOnce(() => {});
      fresh.mockImplementation(() => {
        if (outcome === 'expired') throw new Error('expired restore review');
      });
      const register = vi
        .spyOn(restoreTarget, 'registerReviewedArchivedOriginal')
        .mockImplementation(() => {});
      const native = vi
        .spyOn(restoreTarget, 'verifyArchivedOriginalNativePair')
        .mockImplementation(() => {});
      const targets = vi
        .spyOn(restoreTarget, 'recheckArchivedRestoreTargets')
        .mockImplementation(async () => {
          if (outcome === 'restore target gone') throw new Error('missing restore target');
          if (outcome === 'native drift') pair.native.agent.service.reconciling = true;
        });
      const run = verifyProductionApiTransition();
      if (outcome === 'confirmed') await expect(run).resolves.toBeUndefined();
      else await expect(run).rejects.toThrow();
      expect(register).toHaveBeenCalledWith(pair.receipt, pack);
      expect(ordinary).not.toHaveBeenCalled();
      expect(targets).toHaveBeenCalledWith(
        'fixture',
        initial.targets,
        roles,
        expect.any(Function),
        expect.any(Number),
      );
      expect(read).toHaveBeenCalledTimes(outcome === 'restore target gone' ? 4 : 8);
      expect(Math.min(...read.mock.invocationCallOrder)).toBeGreaterThan(
        register.mock.invocationCallOrder[0] ?? 0,
      );
      expect(targets.mock.invocationCallOrder[0]).toBeGreaterThan(
        read.mock.invocationCallOrder[3] ?? 0,
      );
      expect(native).toHaveBeenCalledTimes(
        outcome === 'restore target gone' || outcome === 'native drift' ? 1 : 2,
      );
      expect(approval).toHaveBeenCalledTimes(
        outcome === 'restore target gone' || outcome === 'native drift' ? 1 : 2,
      );
      if (outcome === 'confirmed') expect(independent).toHaveBeenCalledTimes(2);
    },
  );
});
