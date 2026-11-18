import { createHash } from 'node:crypto';
import {
  canonicalEstimatedCostJson,
  parseHistoricalUnknownBaseline,
  type HistoricalUnknownBaselineRow,
} from './estimated-cost-approval.js';

/** A target independently selected by the operator's trusted runtime. */
export interface EstimatedCostBaselineTarget {
  driver: 'postgres' | 'firestore';
  projectId: string;
  databaseId: string;
  installationId: string;
}

/** External verification of these proofs is the operator's responsibility. */
export interface EstimatedCostBaselineWitness {
  format: 1;
  operationId: string;
  ownerId: string;
  target: EstimatedCostBaselineTarget;
  releaseSha: string;
  cutoff: string;
  issuedAt: string;
  expiresAt: string;
  sourceDigest: string;
  drainDigest: string;
  observedCensusDigest: string;
}

export interface EstimatedCostBaselineProposal {
  format: 1;
  witnessDigest: string;
  censusDigest: string;
  ownerVersion: string;
  privacyGeneration: string | null;
  heldMicros: number;
  rows: HistoricalUnknownBaselineRow[];
  digest: string;
}

export function estimatedCostProvisionDigest(value: unknown): string {
  return createHash('sha256').update(canonicalEstimatedCostJson(value)).digest('hex');
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, i) => actual[i] === key);
}

function iso(value: unknown): number {
  if (typeof value !== 'string') throw new Error('Invalid witness time');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new Error('Invalid witness time');
  return date.getTime();
}

/** Validates the binding, not the authenticity of the operator's evidence. */
export function validateEstimatedCostBaselineWitness(
  witness: EstimatedCostBaselineWitness,
  target: EstimatedCostBaselineTarget,
  releaseSha: string,
  now: Date,
): void {
  if (
    !witness ||
    typeof witness !== 'object' ||
    !exactKeys(witness, [
      'format',
      'operationId',
      'ownerId',
      'target',
      'releaseSha',
      'cutoff',
      'issuedAt',
      'expiresAt',
      'sourceDigest',
      'drainDigest',
      'observedCensusDigest',
    ]) ||
    !witness.target ||
    typeof witness.target !== 'object' ||
    !exactKeys(witness.target, ['driver', 'projectId', 'databaseId', 'installationId']) ||
    witness.format !== 1 ||
    typeof witness.operationId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(witness.operationId) ||
    typeof witness.ownerId !== 'string' ||
    !witness.ownerId ||
    !['postgres', 'firestore'].includes(witness.target.driver) ||
    ![witness.target.projectId, witness.target.databaseId, witness.target.installationId].every(
      (part) => typeof part === 'string' && part.length > 0 && part.length <= 256,
    ) ||
    canonicalEstimatedCostJson(witness.target) !== canonicalEstimatedCostJson(target) ||
    !/^[a-f0-9]{40}$/.test(witness.releaseSha) ||
    witness.releaseSha !== releaseSha ||
    ![witness.sourceDigest, witness.drainDigest, witness.observedCensusDigest].every(
      (digest) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest),
    )
  )
    throw new Error('Invalid baseline witness binding');
  const cutoff = iso(witness.cutoff);
  const issued = iso(witness.issuedAt);
  const expires = iso(witness.expiresAt);
  const current = now.getTime();
  if (
    !Number.isFinite(current) ||
    cutoff > issued ||
    issued > current ||
    current >= expires ||
    expires - issued > 30 * 60 * 1000
  )
    throw new Error('Baseline witness expired or has invalid times');
}

/** Read-only recovery checks the original binding without reviving expired authority. */
export function validateEstimatedCostBaselineHistoricalWitness(
  witness: EstimatedCostBaselineWitness,
  target: EstimatedCostBaselineTarget,
): void {
  if (!witness || typeof witness !== 'object' || typeof witness.issuedAt !== 'string')
    throw new Error('Invalid baseline witness');
  validateEstimatedCostBaselineWitness(
    witness,
    target,
    witness.releaseSha,
    new Date(witness.issuedAt),
  );
}

export function validateEstimatedCostBaselineProposal(
  proposal: EstimatedCostBaselineProposal,
  witness: EstimatedCostBaselineWitness,
): void {
  if (
    !proposal ||
    typeof proposal !== 'object' ||
    !exactKeys(proposal, [
      'format',
      'witnessDigest',
      'censusDigest',
      'ownerVersion',
      'privacyGeneration',
      'heldMicros',
      'rows',
      'digest',
    ]) ||
    proposal.format !== 1 ||
    proposal.witnessDigest !== estimatedCostProvisionDigest(witness) ||
    proposal.censusDigest !== witness.observedCensusDigest ||
    typeof proposal.ownerVersion !== 'string' ||
    !proposal.ownerVersion ||
    !(
      proposal.privacyGeneration === null ||
      (typeof proposal.privacyGeneration === 'string' && proposal.privacyGeneration.length > 0)
    ) ||
    !Number.isSafeInteger(proposal.heldMicros) ||
    proposal.heldMicros < 0
  )
    throw new Error('Invalid baseline proposal binding');
  const rows = parseHistoricalUnknownBaseline(proposal.rows);
  const total = rows?.reduce((sum, row) => sum + row.estimatedMicros, 0);
  if (
    !rows ||
    total === undefined ||
    !Number.isSafeInteger(total) ||
    createHash('sha256').update(JSON.stringify(rows)).digest('hex') !== proposal.digest ||
    total > proposal.heldMicros
  )
    throw new Error('Invalid baseline proposal rows');
}

export interface EstimatedCostBaselineContext {
  ownerId: string;
  target: EstimatedCostBaselineTarget;
  releaseSha: string;
  now: () => Date;
}
export interface EstimatedCostBaselineCensusRow {
  reservationId: string;
  status: string;
  estimatedMicros: number;
  reservationKind: string;
  grantId: string | null;
  createdMicros: string;
  version: string;
}
export interface EstimatedCostBaselineCensus {
  ownerVersion: string;
  privacyGeneration: string | null;
  heldMicros: number;
  reservations: EstimatedCostBaselineCensusRow[];
  grants: { id: string; expiresMicros: string; version: string }[];
  ledgerVersion: string;
}
export interface EstimatedCostBaselineReceipt {
  proposalDigest: string;
  installationId: string;
  ownerId: string;
  digest: string;
  rows: HistoricalUnknownBaselineRow[];
  createdVersion: string;
  createdAt: string;
}

/** Inspectors must enumerate the entire ledger and attest its native versions. */
export function estimatedCostBaselineCensusDigest(census: EstimatedCostBaselineCensus): string {
  return estimatedCostProvisionDigest(census);
}
export function makeEstimatedCostBaselineProposal(
  census: EstimatedCostBaselineCensus,
  witness: EstimatedCostBaselineWitness,
): EstimatedCostBaselineProposal {
  const censusDigest = estimatedCostBaselineCensusDigest(census);
  if (censusDigest !== witness.observedCensusDigest) throw new Error('Baseline census changed');
  const cutoffMicros = BigInt(new Date(witness.cutoff).getTime()) * 1000n;
  const rows = census.reservations
    .filter(
      (r) =>
        r.status === 'unknown' &&
        r.reservationKind === 'attempt' &&
        r.grantId === null &&
        BigInt(r.createdMicros) < cutoffMicros,
    )
    .map((r) => ({ reservationId: r.reservationId, estimatedMicros: r.estimatedMicros }));
  const proposal: EstimatedCostBaselineProposal = {
    format: 1,
    witnessDigest: estimatedCostProvisionDigest(witness),
    censusDigest,
    ownerVersion: census.ownerVersion,
    privacyGeneration: census.privacyGeneration,
    heldMicros: census.heldMicros,
    rows,
    digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
  validateEstimatedCostBaselineProposal(proposal, witness);
  return proposal;
}
