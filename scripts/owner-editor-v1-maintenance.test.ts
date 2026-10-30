import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OwnerEditorMaintenancePacket } from '@assistant/firestore/owner-editor-maintenance';
import { ownerEditorPrivacyDigest } from '@assistant/persistence';
import { type DocumentSnapshot, Timestamp } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { ownerEditorFirestorePrivacyToken } from '../packages/firestore/src/owner-editor-repository.js';
import { BASIC_EDITOR_COMMANDS } from './owner-editor-release-inventory.js';
import { editorMetadataUrls, observeEditorReadiness } from './owner-editor-release-readiness.js';
import {
  validateOperatorObservation,
  verifyOperatorSource,
} from './owner-editor-v1-maintenance.js';
import {
  decryptMaintenancePacket,
  encryptMaintenancePacket,
  maintenancePacketDigest,
  packetRecipient,
} from './owner-editor-v1-packet.js';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const now = Date.now(),
  sha = 'a'.repeat(40);
function packet(): OwnerEditorMaintenancePacket {
  return {
    format: 1,
    privacyBinding: 'owner-editor-privacy-v1/native-seconds-nanos',
    operationId: '11111111-1111-4111-8111-111111111111',
    action: 'initialize',
    releaseSha: sha,
    target: {
      projectId: 'bmson-assistant',
      databaseId: 'assistant-production',
      installationId: 'private-installation',
      ownerId: '22222222-2222-4222-8222-222222222222',
    },
    issuedAt: now,
    expiresAt: now + 1800000,
    proposedEpoch: '33333333-3333-4333-8333-333333333333',
    expectedOwnerVersion: '123:456',
    expectedPrivacyDigest: 'b'.repeat(64),
    expectedEpoch: null,
    evidence: null,
  };
}
const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'bmson/assistant',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: sha,
  GITHUB_RUN_ID: '123',
  GCP_PROJECT: 'bmson-assistant',
  GCP_DEPLOY_SERVICE_ACCOUNT: 'deployer@bmson-assistant.iam.gserviceaccount.com',
  GCP_WORKLOAD_IDENTITY_PROVIDER:
    'projects/123/locations/global/workloadIdentityPools/pool/providers/provider',
  GITHUB_WORKFLOW_REF:
    'bmson/assistant/.github/workflows/owner-editor-v1-maintenance.yml@refs/heads/main',
  OWNER_EDITOR_RELEASE_SHA: sha,
  OWNER_EDITOR_MAINTENANCE_MODE: 'dry-run',
};
const contract = { components: { web: { ownerEditorV1: [...BASIC_EDITOR_COMMANDS] } } };
describe('protected V1 operator entrypoint and private packet envelope', () => {
  it('round-trips an encrypted bounded packet without exposing target or epoch in the artifact', () => {
    const p = packet(),
      encrypted = encryptMaintenancePacket(p, keys.publicKey),
      serialized = JSON.stringify(encrypted);
    for (const secret of [
      p.target.ownerId,
      p.target.installationId,
      p.proposedEpoch,
      p.operationId,
    ])
      expect(serialized).not.toContain(secret);
    expect(decryptMaintenancePacket(encrypted, keys.privateKey)).toEqual(p);
  });
  it('binds the exact packet independently of JSON key ordering', () => {
    const p = packet();
    expect(maintenancePacketDigest(p)).toBe(
      maintenancePacketDigest(Object.fromEntries(Object.entries(p).reverse())),
    );
    expect(maintenancePacketDigest(p)).not.toBe(
      maintenancePacketDigest({
        ...p,
        evidence: { recoverySha256: 'c'.repeat(64), drainSha256: 'd'.repeat(64) },
      }),
    );
  });
  it('rejects weak, non-RSA, private and malformed recipient keys', () => {
    expect(() => packetRecipient(keys.privateKey)).toThrow();
    expect(() => packetRecipient('bad')).toThrow();
    for (const publicKey of [
      generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey,
      generateKeyPairSync('ed25519').publicKey,
    ])
      expect(() =>
        packetRecipient(String(publicKey.export({ type: 'spki', format: 'pem' }))),
      ).toThrow();
  });
  it('rejects tampering, wrong private key and malformed envelope before yielding plaintext', () => {
    const encrypted = encryptMaintenancePacket(packet(), keys.publicKey);
    expect(() =>
      decryptMaintenancePacket(
        { ...encrypted, tag: Buffer.alloc(16).toString('base64') },
        keys.privateKey,
      ),
    ).toThrow();
    expect(() =>
      decryptMaintenancePacket({ ...encrypted, extra: true }, keys.privateKey),
    ).toThrow();
    expect(() => decryptMaintenancePacket({ ...encrypted, iv: 'bad' }, keys.privateKey)).toThrow();
    const other = generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    expect(() => decryptMaintenancePacket(encrypted, String(other))).toThrow();
  });
  it('accepts only exact trusted main source with intrinsic capability', () => {
    expect(() => verifyOperatorSource(env, sha, contract, true)).not.toThrow();
    for (const changed of [
      { GITHUB_REF: 'refs/heads/feature' },
      { GITHUB_RUN_ATTEMPT: '2' },
      { GITHUB_WORKFLOW_REF: 'other' },
      { OWNER_EDITOR_RELEASE_SHA: 'e'.repeat(40) },
      { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8789' },
      { GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'evil.example' },
      { CLOUDSDK_API_ENDPOINT_OVERRIDES_RUN: 'http://localhost' },
    ])
      expect(() => verifyOperatorSource({ ...env, ...changed }, sha, contract, true)).toThrow();
    expect(() => verifyOperatorSource(env, 'f'.repeat(40), contract, true)).toThrow();
    expect(() => verifyOperatorSource(env, sha, { components: { web: {} } }, true)).toThrow();
  });
  it('requires a valid public-only recipient before authenticating preparation', () => {
    expect(() =>
      verifyOperatorSource(
        {
          ...env,
          OWNER_EDITOR_MAINTENANCE_MODE: 'prepare-initialize',
          OWNER_EDITOR_PACKET_RECIPIENT_PUBLIC_KEY: keys.publicKey,
        },
        sha,
        contract,
        true,
      ),
    ).not.toThrow();
    expect(() =>
      verifyOperatorSource(
        {
          ...env,
          OWNER_EDITOR_MAINTENANCE_MODE: 'prepare-disable',
          OWNER_EDITOR_PACKET_RECIPIENT_PUBLIC_KEY: keys.privateKey,
        },
        sha,
        contract,
        true,
      ),
    ).toThrow();
  });
  it('requires fresh same-source/same-run/same-WIF recovery and index observations', () => {
    const observation = {
      workflowSource: sha,
      workflowRun: '123',
      observedAt: new Date(now).toISOString(),
      observationIdentity: {
        principal: env.GCP_DEPLOY_SERVICE_ACCOUNT,
        provider: env.GCP_WORKLOAD_IDENTITY_PROVIDER,
      },
      indexes: { status: 'exact_manifest_parity' },
      recoveryPoint: { kind: 'pitr' },
      services: [{ servingRevisionVerified: true }, { servingRevisionVerified: true }],
    };
    expect(validateOperatorObservation(observation, env, now)).toHaveLength(2);
    for (const changed of [
      { workflowRun: '124' },
      { workflowSource: 'd'.repeat(40) },
      { observedAt: new Date(now - 120001).toISOString() },
      { observedAt: new Date(now + 1).toISOString() },
      { indexes: { status: 'unknown' } },
      { recoveryPoint: {} },
      { services: [] },
    ])
      expect(() => validateOperatorObservation({ ...observation, ...changed }, env, now)).toThrow();
  });
  it.each([false, true])(
    'binds REST and native SDK privacy tokens identically, completed=%s',
    async (complete) => {
      const p = packet(),
        target = { ownerId: p.target.ownerId, workspaceId: p.target.installationId };
      const stamp = new Timestamp(1793311200, 123456789);
      const values: Record<string, unknown> = {
        agentId: target.ownerId,
        status: 'complete',
        generation: 'private-generation',
      };
      const sdkJob = {
        exists: complete,
        updateTime: stamp,
        get: (key: string) => values[key],
      } as unknown as DocumentSnapshot;
      const digest = ownerEditorPrivacyDigest(
        ownerEditorFirestorePrivacyToken(sdkJob, target.ownerId),
      );
      const urls = editorMetadataUrls(target),
        name = (url: string) => new URL(url).pathname.replace(/^\/v1\//, '');
      const field = (value: string) => ({ stringValue: value });
      const data = [
        {
          documents: [
            {
              name: `${name(urls[0])}/${Buffer.from(target.ownerId).toString('base64url')}`,
              fields: { id: field(target.ownerId) },
            },
          ],
        },
        complete
          ? {
              name: name(urls[1]),
              updateTime: '2026-10-29T22:00:00.123456789Z',
              fields: {
                agentId: field(target.ownerId),
                status: field('complete'),
                generation: field('private-generation'),
              },
            }
          : null,
        {
          name: name(urls[2]),
          fields: {
            name: field(`owner-editor-epoch:${target.ownerId}`),
            cursor: field(
              JSON.stringify({
                ownerId: target.ownerId,
                epoch: p.proposedEpoch,
                ready: true,
                privacyGenerationDigest: digest,
              }),
            ),
          },
        },
      ];
      expect(
        await observeEditorReadiness(
          async (url) => data[urls.indexOf(url as (typeof urls)[number])],
          target,
        ),
      ).toMatchObject({ status: 'ready', privacyBound: true });
    },
  );
  it('retains only ciphertext and sanitized observations in the public workflow', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/owner-editor-v1-maintenance.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('group: production-deploy');
    expect(workflow).toContain('path: owner-editor-v1-packet.encrypted.json');
    expect(workflow).not.toContain('path: owner-editor-v1-packet.json');
    expect(workflow.indexOf('--verify-source')).toBeLessThan(
      workflow.indexOf('google-github-actions/auth@'),
    );
    expect(workflow).toContain('github.run_attempt == 1');
  });
});
