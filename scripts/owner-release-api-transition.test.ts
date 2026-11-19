import { afterEach, describe, expect, it, vi } from 'vitest';
import * as recovery from '../infra/gcp/api3-recovery-proof.mjs';
import * as metadata from './estimated-cost-release-native-read.js';
import * as spending from './estimated-cost-release-profile.js';
import {
  verifyDrainedApiTransition,
  verifyProductionApiTransition,
  verifyTransitionCandidateContract,
} from './owner-release-api-transition.js';
import { type BootstrapReceipt, bootstrapDigest } from './owner-release-current-snapshot.js';
import * as images from './owner-release-image-resolution.js';
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
      vi.spyOn(holds, 'verifyOperatorOwnedHold').mockResolvedValue({
        source,
        runId: '456',
        attempt: '1',
        currentJob: 'release',
        deployWorkflowId: 1,
        cleanupWorkflowId: 2,
        workspaceImportWorkflowId: 3,
        cleanupVariable: 'false',
      });
      vi.spyOn(images, 'createImageResolutionReader').mockReturnValue(async () => {});
      const read = vi.fn(async (url: string) => {
        for (const native of Object.values(pair.native)) {
          if (url === `https://run.googleapis.com/v2/${native.service.name}`) return native.service;
          if (url === `https://run.googleapis.com/v2/${native.revision.name}`)
            return native.revision;
        }
        throw new Error('Unexpected provider read');
      });
      vi.spyOn(metadata, 'estimatedCostMetadataRead').mockReturnValue(read);
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
});
