import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EstimatedCostReleaseProfile } from '../infra/gcp/estimated-cost-release-config.mjs';
import {
  recordVerifiedEstimatedCostReleaseProfile,
  reviewedEstimatedCostReleaseProfile,
  verifyEstimatedCostReleaseMetadata,
  verifyNoInheritedEstimatedCostProfile,
} from './estimated-cost-release-profile.js';
import { type BootstrapReceipt, bootstrapDigest } from './owner-release-current-snapshot.js';

const now = Date.parse('2026-11-18T09:05:00.000Z');
const profile: EstimatedCostReleaseProfile = {
  format: 1,
  mode: 'compatible-off',
  source: 'a'.repeat(40),
  projectId: 'bmson-assistant',
  projectNumber: '1234567890',
  installationId: 'test-installation',
  ownerId: 'test-owner',
  providerSecret: 'existing',
  providerVersion: '31',
  reviewedAt: '2026-11-18T09:00:00.000Z',
  expiresAt: '2026-11-18T09:30:00.000Z',
};
const evidence = {
  baselineReceiptSha256: 'b'.repeat(64),
  writersReceiptSha256: 'c'.repeat(64),
  drainReceiptSha256: 'd'.repeat(64),
};
const environment = (directory: string, p = profile) => ({
  IMAGE_TAG: p.source,
  GCP_PROJECT: p.projectId,
  RELEASE_COMPONENTS: 'agent,web',
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'bmson/assistant',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
  GITHUB_WORKFLOW_SHA: p.source,
  GITHUB_SHA: p.source,
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '1',
  RUNNER_TEMP: directory,
  ESTIMATED_COST_RELEASE_PROFILE_JSON: JSON.stringify(p),
});

function nativeFixture() {
  const responses = new Map<string, unknown>();
  const services = {} as BootstrapReceipt['services'];
  for (const role of ['web', 'agent'] as const) {
    const service = `projects/bmson-assistant/locations/us-west1/services/assistant-${role}`;
    const revision = `assistant-${role}-test`;
    const image = `us-west1-docker.pkg.dev/bmson-assistant/assistant/${role}@sha256:${'e'.repeat(64)}`;
    const env = [
      { name: 'GCP_PROJECT', value: profile.projectId },
      { name: 'ASSISTANT_WORKSPACE_ID', value: profile.installationId },
      { name: 'FIRESTORE_AGENT_ID', value: profile.ownerId },
      {
        name: 'OPENROUTER_API_KEY',
        valueSource: {
          secretKeyRef: { secret: 'projects/1234567890/secrets/existing', version: 'latest' },
        },
      },
    ];
    const traffic = [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision, percent: 100 }];
    const s = {
      name: service,
      uid: `${role}-uid`,
      template: { containers: [{ image, env }] },
      traffic,
      trafficStatuses: traffic,
      terminalCondition: { state: 'CONDITION_SUCCEEDED' },
      latestCreatedRevision: revision,
      reconciling: false,
    };
    const r = {
      name: `${service}/revisions/${revision}`,
      containers: [{ image, env }],
      conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
    };
    responses.set(`https://run.googleapis.com/v2/${service}`, s);
    responses.set(`https://run.googleapis.com/v2/${r.name}`, r);
    services[role] = {
      service,
      uid: s.uid,
      revision,
      image,
      serviceSha256: bootstrapDigest(s),
      revisionSha256: bootstrapDigest(r),
      proof: {
        source: profile.source,
        uid: 'f'.repeat(64),
        image,
        runId: '1',
        attempt: '1',
        manifest: 'b'.repeat(64),
        paused: false,
        templateSha256: 'c'.repeat(64),
      },
    };
  }
  responses.set('https://cloudresourcemanager.googleapis.com/v3/projects/bmson-assistant', {
    name: 'projects/1234567890',
    projectId: 'bmson-assistant',
    state: 'ACTIVE',
  });
  responses.set(
    'https://secretmanager.googleapis.com/v1/projects/bmson-assistant/secrets/existing/versions/31',
    { name: 'projects/1234567890/secrets/existing/versions/31', state: 'ENABLED' },
  );
  const current: BootstrapReceipt = {
    format: 1,
    kind: 'current-snapshot',
    source: profile.source,
    services,
    closureReceiptSha256: '',
    drainReceiptSha256: '',
    recoveryReceiptSha256: '',
  };
  const read = async (url: string) => {
    if (!responses.has(url)) throw new Error('Unexpected metadata request');
    return responses.get(url);
  };
  return { current, responses, read };
}

describe('reviewed cost runtime profile', () => {
  it('finds an inherited declaration in the actual selected revision before delivery changes', async () => {
    const f = nativeFixture();
    await expect(verifyNoInheritedEstimatedCostProfile(f.read)).resolves.toBeUndefined();
    const path =
      'https://run.googleapis.com/v2/projects/bmson-assistant/locations/us-west1/services/assistant-agent/revisions/assistant-agent-test';
    const revision = f.responses.get(path) as {
      name: string;
      containers: Array<{ image: string; env: unknown[] }>;
      conditions: unknown[];
    };
    const changed = structuredClone(revision);
    changed.containers[0]?.env.push({
      name: 'ESTIMATED_COST_PROVIDER_SOURCE_JSON',
      value: '{"sourceRelease":"old"}',
    });
    f.responses.set(path, changed);
    await expect(verifyNoInheritedEstimatedCostProfile(f.read)).rejects.toThrow('source-bound');
  });
  it('checks both actual native bindings and enabled numeric-version metadata', async () => {
    const f = nativeFixture();
    await expect(verifyEstimatedCostReleaseMetadata(profile, f.current, f.read)).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
    const secret =
      'https://secretmanager.googleapis.com/v1/projects/bmson-assistant/secrets/existing/versions/31';
    f.responses.set(secret, {
      name: 'projects/1234567890/secrets/existing/versions/31',
      state: 'DISABLED',
    });
    await expect(verifyEstimatedCostReleaseMetadata(profile, f.current, f.read)).rejects.toThrow();
    f.responses.set(secret, {
      name: 'projects/9999999999/secrets/existing/versions/31',
      state: 'ENABLED',
    });
    await expect(verifyEstimatedCostReleaseMetadata(profile, f.current, f.read)).rejects.toThrow();
    await expect(
      verifyEstimatedCostReleaseMetadata(
        { ...profile, projectNumber: '9999999999' },
        f.current,
        f.read,
      ),
    ).rejects.toThrow();
  });

  it('binds private preflight receipt to the exact profile and release attempt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cost-profile-test-'));
    try {
      const env = environment(directory);
      expect(() => reviewedEstimatedCostReleaseProfile(env, now)).toThrow();
      recordVerifiedEstimatedCostReleaseProfile(profile, 'e'.repeat(64), undefined, env, now);
      expect(reviewedEstimatedCostReleaseProfile(env, now)).toEqual(profile);
      expect(() =>
        recordVerifiedEstimatedCostReleaseProfile(profile, 'e'.repeat(64), undefined, env, now),
      ).toThrow();
      expect(() =>
        reviewedEstimatedCostReleaseProfile({ ...env, GITHUB_RUN_ID: '12346' }, now),
      ).toThrow();
      expect(() =>
        reviewedEstimatedCostReleaseProfile(
          {
            ...env,
            ESTIMATED_COST_RELEASE_PROFILE_JSON: JSON.stringify({
              ...profile,
              providerVersion: '32',
            }),
          },
          now,
        ),
      ).toThrow();
      expect(() =>
        reviewedEstimatedCostReleaseProfile(env, Date.parse(profile.expiresAt)),
      ).toThrow();
      chmodSync(join(directory, 'estimated-cost-release-verified.json'), 0o644);
      expect(() => reviewedEstimatedCostReleaseProfile(env, now)).toThrow();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('enable receipt requires the independently verified exact three proof digests', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cost-enable-profile-test-'));
    try {
      const p: EstimatedCostReleaseProfile = { ...profile, mode: 'enable', ...evidence };
      const env = environment(directory, p);
      expect(() =>
        recordVerifiedEstimatedCostReleaseProfile(p, 'e'.repeat(64), undefined, env, now),
      ).toThrow();
      expect(() =>
        recordVerifiedEstimatedCostReleaseProfile(
          p,
          'e'.repeat(64),
          { ...evidence, drainReceiptSha256: 'f'.repeat(64) },
          env,
          now,
        ),
      ).toThrow();
      recordVerifiedEstimatedCostReleaseProfile(p, 'e'.repeat(64), evidence, env, now);
      expect(reviewedEstimatedCostReleaseProfile(env, now)).toEqual(p);
      const file = join(directory, 'estimated-cost-release-verified.json');
      const receipt = JSON.parse(readFileSync(file, 'utf8'));
      delete receipt.evidence;
      writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
      expect(() => reviewedEstimatedCostReleaseProfile(env, now)).toThrow();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
