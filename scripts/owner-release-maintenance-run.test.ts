import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  archivedOriginalReceiptBinding,
  createBeforeMaintenanceReceipt,
  maintenanceRunDomain,
  maintenanceRunName,
  maintenanceWorkflowPath,
  maintenanceWorkflowRef,
  readBeforeMaintenanceIntent,
  readTrustedMaintenanceRun,
  writeBeforeMaintenanceReceipt,
} from './owner-release-maintenance-run.js';

const source = 'a'.repeat(40);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const now = Date.parse('2026-11-19T12:00:00Z');
function fixture() {
  return {
    format: 1,
    kind: maintenanceRunName,
    source,
    workflowRef: maintenanceWorkflowRef,
    project: 'bmson-assistant',
    region: 'us-west1',
    database: 'assistant-production',
    generation: '183456789876543',
    objectSha256: hash('object'),
    packSha256: hash('pack'),
    nativeBindingSha256: hash('native'),
    recoveryEvidenceSha256: hash('recovery'),
    candidateBuildRunId: '3333',
    candidateBuildSha256: hash('build'),
    candidateReviewSha256: hash('review'),
    reviewedAt: now - 60_000,
    expiresAt: now + 60_000,
  };
}
function signed(value: unknown, domain = maintenanceRunDomain) {
  const payload = Buffer.from(JSON.stringify(value));
  return JSON.stringify({
    payload: payload.toString('base64url'),
    signature: sign(null, Buffer.concat([Buffer.from(domain), payload]), key.privateKey).toString(
      'base64url',
    ),
  });
}
function nativeRun() {
  return {
    id: 123456789,
    run_attempt: 1,
    path: maintenanceWorkflowPath,
    event: 'workflow_dispatch',
    head_sha: source,
    head_branch: 'main',
    status: 'in_progress',
    repository: { full_name: 'bmson/assistant' },
    head_repository: { full_name: 'bmson/assistant' },
  };
}

describe('before-maintenance receipt authority boundary', () => {
  it('authenticates signed intent with no future GitHub run ID', () => {
    const raw = fixture();
    const intent = readBeforeMaintenanceIntent(signed(raw), source, publicKey, now);
    expect(intent).toMatchObject({
      intentSha256: hash(JSON.stringify(raw)),
      packSha256: raw.packSha256,
    });
    expect(intent).not.toHaveProperty('runId');
    expect(() =>
      readBeforeMaintenanceIntent(signed({ ...raw, runId: '123456789' }), source, publicKey, now),
    ).toThrow();
    expect(() =>
      readBeforeMaintenanceIntent(signed(raw, 'wrong domain'), source, publicKey, now),
    ).toThrow();
    expect(() =>
      readBeforeMaintenanceIntent(signed(raw), 'c'.repeat(40), publicKey, now),
    ).toThrow();
    expect(() =>
      readBeforeMaintenanceIntent(signed(raw), source, publicKey, raw.expiresAt),
    ).toThrow();
  });

  it('rereads only authenticated actual attempt metadata on the fixed repository', async () => {
    const run = nativeRun();
    const token = 'ephemeral-mock-token';
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(run));
    expect(await readTrustedMaintenanceRun('123456789', source, token, request)).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(request).toHaveBeenCalledWith(
      'https://api.github.com/repos/bmson/assistant/actions/runs/123456789/attempts/1',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      }),
    );
    for (const bad of [
      { ...run, id: 333 },
      { ...run, run_attempt: 2 },
      { ...run, path: '.github/workflows/deploy.yml' },
      { ...run, status: 'completed' },
      { ...run, head_repository: { full_name: 'fork/assistant' } },
    ]) {
      request.mockResolvedValueOnce(Response.json(bad));
      await expect(
        readTrustedMaintenanceRun('123456789', source, token, request),
      ).rejects.toThrow();
    }
  });

  it('writes one sanitized readback artifact with original identities and zero claimed changes', () => {
    const role = (name: string) => ({
      revision: `assistant-${name}-fixture`,
      serviceUidSha256: hash(`${name}service`),
      revisionUidSha256: hash(`${name}revision`),
      serviceSha256: hash('private-service'),
      revisionSha256: hash('private-revision'),
    });
    const archived = (name: string) => ({
      parent: Buffer.from(`${name}parent`),
      child: Buffer.from(`${name}child`),
      receipt: Buffer.from('private receipt'),
      signature: Buffer.from('private signature'),
      sbom: Buffer.from('private SBOM'),
    });
    const original = archivedOriginalReceiptBinding({
      nativeBinding: { format: 1, roles: { agent: role('agent'), web: role('web') } },
      roles: { agent: archived('agent'), web: archived('web') },
    });
    const intent = readBeforeMaintenanceIntent(signed(fixture()), source, publicKey, now);
    const input = {
      intent,
      runId: '123456789',
      runIdentitySha256: hash('actual run'),
      archivedReadbackSha256: hash('same archive obs'),
      original,
      observedAt: now,
    };
    const receipt = createBeforeMaintenanceReceipt(input);
    expect(receipt).toMatchObject({
      runId: '123456789',
      workflowSha: source,
      attempt: '1',
      original,
      recoveryTargetsReadBack: true,
      mutationAuthorized: false,
      admissionChangePerformed: false,
    });
    expect(receipt).not.toHaveProperty('held');
    expect(receipt).not.toHaveProperty('settled');
    expect(JSON.stringify(receipt)).not.toContain('private');
    expect(() =>
      createBeforeMaintenanceReceipt({ ...input, observedAt: intent.expiresAt }),
    ).toThrow();
    const directory = mkdtempSync(join(tmpdir(), 'owner-before-maintenance-'));
    try {
      writeBeforeMaintenanceReceipt(directory, receipt);
      const path = join(directory, `${maintenanceRunName}.json`);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(receipt);
      expect(() => writeBeforeMaintenanceReceipt(directory, receipt)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
