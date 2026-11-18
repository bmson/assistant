import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  estimatedCostProvisionDigest,
  estimatedCostBaselineCensusDigest,
  makeEstimatedCostBaselineProposal,
  validateEstimatedCostBaselineProposal,
  validateEstimatedCostBaselineWitness,
  type EstimatedCostBaselineWitness,
} from './estimated-cost-baseline-provision.js';

const target = {
  driver: 'postgres' as const,
  projectId: 'project',
  databaseId: 'db',
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
const now = new Date('2026-11-18T00:02:00.000Z');
const rows = [{ reservationId: 'a', estimatedMicros: 2 }];
const proposal = {
  format: 1 as const,
  witnessDigest: estimatedCostProvisionDigest(witness),
  censusDigest: witness.observedCensusDigest,
  ownerVersion: '1',
  privacyGeneration: null,
  heldMicros: 2,
  rows,
  digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
};

describe('estimated cost baseline provision contract', () => {
  it('accepts an exact unexpired witness and proposal', () => {
    expect(() =>
      validateEstimatedCostBaselineWitness(witness, target, witness.releaseSha, now),
    ).not.toThrow();
    expect(() => validateEstimatedCostBaselineProposal(proposal, witness)).not.toThrow();
  });
  it('rejects expired or mismatched runtime bindings', () => {
    expect(() =>
      validateEstimatedCostBaselineWitness(
        witness,
        target,
        witness.releaseSha,
        new Date(witness.expiresAt),
      ),
    ).toThrow();
    expect(() =>
      validateEstimatedCostBaselineWitness(
        witness,
        { ...target, databaseId: 'other' },
        witness.releaseSha,
        now,
      ),
    ).toThrow();
    expect(() =>
      validateEstimatedCostBaselineWitness(witness, target, 'e'.repeat(40), now),
    ).toThrow();
  });
  it('rejects changed proof, census, rows and insufficient liability', () => {
    expect(() =>
      validateEstimatedCostBaselineProposal(proposal, { ...witness, sourceDigest: 'e'.repeat(64) }),
    ).toThrow();
    expect(() =>
      validateEstimatedCostBaselineProposal({ ...proposal, censusDigest: 'e'.repeat(64) }, witness),
    ).toThrow();
    expect(() =>
      validateEstimatedCostBaselineProposal({ ...proposal, rows: [...rows, ...rows] }, witness),
    ).toThrow();
    expect(() =>
      validateEstimatedCostBaselineProposal({ ...proposal, heldMicros: 1 }, witness),
    ).toThrow();
  });
  it('rejects long-lived witnesses, malformed proofs and changed rows', () => {
    expect(() =>
      validateEstimatedCostBaselineWitness(
        { ...witness, expiresAt: '2026-11-18T01:00:00.000Z' },
        target,
        witness.releaseSha,
        now,
      ),
    ).toThrow();
    expect(() =>
      validateEstimatedCostBaselineWitness(
        { ...witness, drainDigest: 'invalid' },
        target,
        witness.releaseSha,
        now,
      ),
    ).toThrow();
    expect(() =>
      validateEstimatedCostBaselineProposal(
        { ...proposal, rows: [{ reservationId: 'a', estimatedMicros: 3 }] },
        witness,
      ),
    ).toThrow();
  });
  it('excludes unknowns whose native Firestore update is at or after the cutoff', () => {
    const cutoff = Date.parse(witness.cutoff),
      seconds = Math.floor(cutoff / 1000);
    const census = {
      ownerVersion: '1:0',
      privacyGeneration: null,
      heldMicros: 3,
      ledgerVersion: '1:0',
      grants: [],
      reservations: [
        {
          reservationId: 'a',
          status: 'unknown',
          estimatedMicros: 1,
          reservationKind: 'attempt',
          grantId: null,
          createdMicros: String((cutoff - 10000) * 1000),
          version: `${seconds - 1}:999999999`,
        },
        {
          reservationId: 'b',
          status: 'unknown',
          estimatedMicros: 1,
          reservationKind: 'attempt',
          grantId: null,
          createdMicros: String((cutoff - 10000) * 1000),
          version: `${seconds}:0`,
        },
        {
          reservationId: 'c',
          status: 'unknown',
          estimatedMicros: 1,
          reservationKind: 'attempt',
          grantId: null,
          createdMicros: String((cutoff - 10000) * 1000),
          version: `${seconds}:1`,
        },
      ],
    };
    const fireWitness = {
      ...witness,
      target: { ...target, driver: 'firestore' as const },
      observedCensusDigest: estimatedCostBaselineCensusDigest(census),
    };
    expect(makeEstimatedCostBaselineProposal(census, fireWitness).rows).toEqual([
      { reservationId: 'a', estimatedMicros: 1 },
    ]);
  });
});
