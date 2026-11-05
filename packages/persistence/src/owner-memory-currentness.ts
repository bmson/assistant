import { createHash } from 'node:crypto';
import type { OwnerEditorCommand, OwnerEditorOperationRecord } from './owner-editor.js';
import {
  type OwnerMemoryCorrectionEligibilityInput,
  ownerMemoryCorrectionEligibility,
} from './owner-memory-correction.js';
import {
  ownerMemoryProvenanceFingerprint,
  parseOwnerMemoryProvenancePayload,
} from './owner-memory-provenance.js';
import { parseOwnerMemoryWriteWitness } from './owner-memory-write-witness.js';

/** Proposed stored receipt extension; legacy receipts have no such proof. */
export interface OwnerMemoryCorrectionReceiptProof {
  version: 1;
  writeVersion: string;
  contentHash: string;
  /** Immutable PRE-write evidence; matches witness attribution. */
  provenanceFingerprint: string;
  /** Distinct POST-write evidence; null means projection was not closed. */
  expectedCurrentProvenanceFingerprint: string | null;
}

export interface OwnerMemoryCurrentnessRequest {
  ownerId: string;
  memoryId: string;
  operationKey: string;
  requestHash: string;
}

/**
 * Server-only normalized inputs from ONE canonical adapter transaction.
 * This type and the pure classifier cannot prove that transaction, authorization,
 * query coverage, or commit-time projection happened. There are no runtime callers.
 */
export interface OwnerMemoryCurrentnessRead {
  receipt: {
    ownerId: string;
    memoryId: string;
    operationKey: string;
    requestHash: string;
    command: OwnerEditorCommand;
    status: OwnerEditorOperationRecord['status'];
    outcome: string;
    proof: unknown;
  } | null;
  memory:
    | (OwnerMemoryCorrectionEligibilityInput['memory'] & {
        content: string;
        memoryWriteWitness: unknown;
      })
    | null;
  currentProvenance: unknown;
  eligibilityProof: OwnerMemoryCorrectionEligibilityInput['proof'];
  readAt: Date;
}

export type OwnerMemoryCurrentness =
  | { disposition: 'saved_current'; contentHash: string }
  | { disposition: 'unknown' | 'not_current'; contentHash: null };

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unknown = (): OwnerMemoryCurrentness => ({ disposition: 'unknown', contentHash: null });
const notCurrent = (): OwnerMemoryCurrentness => ({
  disposition: 'not_current',
  contentHash: null,
});

/**
 * Pure receipt/readback semantics only, not a read API or attribution mint.
 * saved_current describes the supplied canonical read instant. Later mutation
 * can change a later result. Separate receipt/snapshot reads cannot use this API.
 */
export function classifyOwnerMemoryCurrentness(
  request: OwnerMemoryCurrentnessRequest,
  read: OwnerMemoryCurrentnessRead | null,
): OwnerMemoryCurrentness {
  try {
    if (
      !UUID.test(request.ownerId) ||
      !UUID.test(request.memoryId) ||
      !HASH.test(request.operationKey) ||
      !HASH.test(request.requestHash) ||
      !read?.receipt
    )
      return unknown();
    const { receipt, memory } = read;
    if (
      receipt.command !== 'correct_owner_memory' ||
      receipt.status !== 'committed' ||
      receipt.outcome !== 'saved' ||
      receipt.ownerId !== request.ownerId ||
      receipt.memoryId !== request.memoryId ||
      receipt.operationKey !== request.operationKey ||
      receipt.requestHash !== request.requestHash
    )
      return notCurrent();
    if (!memory) return notCurrent();
    const proof = parseReceiptProof(receipt.proof);
    const witness = parseOwnerMemoryWriteWitness(memory.memoryWriteWitness);
    if (!proof || !witness?.attribution || proof.expectedCurrentProvenanceFingerprint === null)
      return unknown();
    if (
      memory.agentId !== request.ownerId ||
      memory.id !== request.memoryId ||
      witness.attribution.operationKey !== request.operationKey ||
      witness.attribution.requestHash !== request.requestHash ||
      witness.attribution.provenanceFingerprint !== proof.provenanceFingerprint ||
      witness.writeVersion !== proof.writeVersion ||
      witness.contentHash !== proof.contentHash ||
      witness.contentHash !== memory.contentHash ||
      createHash('sha256').update(memory.content, 'utf8').digest('hex') !== memory.contentHash
    )
      return notCurrent();
    const provenance = parseOwnerMemoryProvenancePayload(read.currentProvenance);
    if (
      provenance.ownerId !== request.ownerId ||
      provenance.memoryId !== request.memoryId ||
      provenance.contentHash !== memory.contentHash ||
      provenance.targetSource.source !== memory.source ||
      provenance.targetSource.sourceTaskId !== memory.sourceTaskId ||
      provenance.targetSource.subjectContactId !== memory.subjectContactId
    )
      return notCurrent();
    const currentFingerprint = ownerMemoryProvenanceFingerprint(provenance);
    if (currentFingerprint === null || !read.eligibilityProof.complete) return unknown();
    if (currentFingerprint !== proof.expectedCurrentProvenanceFingerprint) return notCurrent();
    const eligibility = ownerMemoryCorrectionEligibility({
      ownerId: request.ownerId,
      memory,
      now: read.readAt,
      proof: read.eligibilityProof,
    });
    if (!eligibility.eligible) return notCurrent();
    return { disposition: 'saved_current', contentHash: memory.contentHash };
  } catch {
    return unknown();
  }
}

function parseReceiptProof(value: unknown): OwnerMemoryCorrectionReceiptProof | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid receipt proof');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Invalid receipt proof prototype');
  const keys = [
    'version',
    'writeVersion',
    'contentHash',
    'provenanceFingerprint',
    'expectedCurrentProvenanceFingerprint',
  ];
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))
  )
    throw new TypeError('Invalid receipt proof keys');
  const proof = value as OwnerMemoryCorrectionReceiptProof;
  if (
    proof.version !== 1 ||
    typeof proof.writeVersion !== 'string' ||
    !UUID.test(proof.writeVersion) ||
    typeof proof.contentHash !== 'string' ||
    !HASH.test(proof.contentHash) ||
    typeof proof.provenanceFingerprint !== 'string' ||
    !HASH.test(proof.provenanceFingerprint) ||
    (proof.expectedCurrentProvenanceFingerprint !== null &&
      (typeof proof.expectedCurrentProvenanceFingerprint !== 'string' ||
        !HASH.test(proof.expectedCurrentProvenanceFingerprint)))
  )
    throw new TypeError('Invalid receipt proof values');
  return proof;
}
