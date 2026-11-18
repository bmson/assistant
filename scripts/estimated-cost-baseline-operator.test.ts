import { createHash } from 'node:crypto';
import {
  type EstimatedCostBaselineWitness,
  estimatedCostProvisionDigest,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  parseBaselineOperatorPacket,
  requireReviewedBaselineFreeze,
} from './estimated-cost-baseline-operator.js';
import { type BootstrapReceipt } from './owner-release-current-snapshot.js';
import { type serviceFacts } from './owner-editor-release-inventory.js';

const target = {
  driver: 'firestore' as const,
  projectId: 'bmson-assistant',
  databaseId: 'assistant-production',
  installationId: 'install',
};
const witness: EstimatedCostBaselineWitness = {
  format: 1,
  operationId: 'operation',
  ownerId: 'owner',
  target,
  releaseSha: 'a'.repeat(40),
  cutoff: '2026-11-18T00:00:00.000Z',
  issuedAt: '2026-11-18T00:01:00.000Z',
  expiresAt: '2026-11-18T00:10:00.000Z',
  sourceDigest: 'b'.repeat(64),
  drainDigest: 'c'.repeat(64),
  observedCensusDigest: 'd'.repeat(64),
};
const rows = [{ reservationId: 'one', estimatedMicros: 5 }];
const proposal = {
  format: 1 as const,
  witnessDigest: estimatedCostProvisionDigest(witness),
  censusDigest: witness.observedCensusDigest,
  ownerVersion: '1:2',
  privacyGeneration: null,
  heldMicros: 5,
  rows,
  digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
};
const packet = { format: 1 as const, witness, proposal };
const digest = estimatedCostProvisionDigest(packet);

describe('bounded baseline operator', () => {
  it('binds readback to the exact reviewed original packet, target and owner even after expiry', () => {
    expect(parseBaselineOperatorPacket(packet, digest, target, 'owner')).toEqual(packet);
    expect(() => parseBaselineOperatorPacket(packet, 'e'.repeat(64), target, 'owner')).toThrow();
    expect(() =>
      parseBaselineOperatorPacket(packet, digest, { ...target, installationId: 'other' }, 'owner'),
    ).toThrow();
    expect(() => parseBaselineOperatorPacket(packet, digest, target, 'other')).toThrow();
    expect(() =>
      parseBaselineOperatorPacket(
        { ...packet, witness: { ...witness, sourceDigest: 'e'.repeat(64) } },
        digest,
        target,
        'owner',
      ),
    ).toThrow();
  });
  it('requires both reviewed paused service sources, while snapshot assertions alone never prove writer drain', async () => {
    const current = {
      kind: 'disabled-bootstrap',
      source: witness.releaseSha,
      services: {
        agent: { proof: { source: witness.releaseSha, paused: true } },
        web: { proof: { source: witness.releaseSha, paused: true } },
      },
    } as unknown as BootstrapReceipt;
    const facts = [
      { nonsecretReleaseConfig: { ASSISTANT_RELEASE_WRITES_PAUSED: 'true' } },
      { nonsecretReleaseConfig: { ASSISTANT_RELEASE_WRITES_PAUSED: 'true' } },
    ] as unknown as ReturnType<typeof serviceFacts>[];
    expect(() => requireReviewedBaselineFreeze(current, witness.releaseSha, facts)).not.toThrow();
    expect(() =>
      requireReviewedBaselineFreeze(
        { ...current, kind: 'current-snapshot' },
        witness.releaseSha,
        facts,
      ),
    ).toThrow();
    expect(() => requireReviewedBaselineFreeze(current, 'f'.repeat(40), facts)).toThrow();
    expect(() => requireReviewedBaselineFreeze(current, witness.releaseSha, [facts[0]!])).toThrow();
  });
});
