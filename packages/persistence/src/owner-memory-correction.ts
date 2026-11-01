import type { Records } from './records.js';

export interface OwnerCorrection {
  version: 1;
  correctedByOwner: true;
  priorContentHash: string;
  currentContentHash: string;
  correctedAt: string;
}
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** An absent legacy marker stays absent; malformed or stale attribution is never trusted. */
export function parseOwnerCorrection(
  value: unknown,
  currentContentHash: string,
): OwnerCorrection | null {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid owner correction marker');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !==
      'correctedAt,correctedByOwner,currentContentHash,priorContentHash,version' ||
    row.version !== 1 ||
    row.correctedByOwner !== true ||
    typeof row.priorContentHash !== 'string' ||
    !HASH.test(row.priorContentHash) ||
    typeof row.currentContentHash !== 'string' ||
    !HASH.test(row.currentContentHash) ||
    row.currentContentHash !== currentContentHash ||
    row.priorContentHash === row.currentContentHash ||
    typeof row.correctedAt !== 'string' ||
    row.correctedAt.length !== 24 ||
    !Number.isFinite(Date.parse(row.correctedAt)) ||
    new Date(row.correctedAt).toISOString() !== row.correctedAt
  )
    throw new Error('Invalid owner correction marker');
  return {
    version: 1,
    correctedByOwner: true,
    priorContentHash: row.priorContentHash,
    currentContentHash: row.currentContentHash,
    correctedAt: row.correctedAt,
  };
}
export function validOwnerCorrection(value: unknown, currentContentHash: string): boolean {
  try {
    return parseOwnerCorrection(value, currentContentHash) !== null;
  } catch {
    return false;
  }
}
/** priorContentHash is the immediately preceding saved note, never the original imported document. */
export function nextOwnerCorrection(input: {
  previous: unknown;
  priorContentHash: string;
  currentContentHash: string;
  correctedAt: Date | string;
}): OwnerCorrection | null {
  if (!HASH.test(input.priorContentHash) || !HASH.test(input.currentContentHash))
    throw new Error('Invalid correction content hash');
  const previous = parseOwnerCorrection(input.previous, input.priorContentHash);
  if (input.priorContentHash === input.currentContentHash) return previous;
  const date = input.correctedAt instanceof Date ? input.correctedAt : new Date(input.correctedAt);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid correction time');
  return parseOwnerCorrection(
    {
      version: 1,
      correctedByOwner: true,
      priorContentHash: input.priorContentHash,
      currentContentHash: input.currentContentHash,
      correctedAt: date.toISOString(),
    },
    input.currentContentHash,
  );
}
export interface OwnerMemoryCorrectionEligibilityInput {
  ownerId: string;
  memory: Pick<
    Records['memories'],
    | 'id'
    | 'agentId'
    | 'contentHash'
    | 'category'
    | 'source'
    | 'sourceTaskId'
    | 'expiresAt'
    | 'supersededById'
    | 'quarantined'
    | 'subjectContactId'
  > & { ownerCorrection?: unknown };
  now: Date;
  proof: {
    complete: boolean;
    tombstoned: boolean;
    shared: boolean;
    conflictingLineage: boolean;
    subjectValid: boolean;
    provenance:
      | { kind: 'manual' | 'graph_owner' }
      | {
          kind: 'extracted';
          taskId: string;
          taskOwnerId: string;
          sourceRelationship: 'conversation_message' | 'email_source';
          sourceOwnerId: string;
          exactSourceMatch: boolean;
        }
      | {
          kind: 'import';
          canonicalOwnerId: string;
          canonicalSource: string;
          lineageCount: number;
          unitCount: number;
          strictUnit: boolean;
        }
      | { kind: 'unknown' };
  };
}
export interface OwnerMemoryCorrectionEligibility {
  eligible: boolean;
  readOnlyReason?: string;
  sourceLabel: string;
}
/** Pure classification only. Drivers must prove these normalized facts in their bounded owner/privacy/CAS read. */
export function ownerMemoryCorrectionEligibility(
  input: OwnerMemoryCorrectionEligibilityInput,
): OwnerMemoryCorrectionEligibility {
  const { memory, proof, ownerId } = input;
  const no = (reason: string): OwnerMemoryCorrectionEligibility => ({
    eligible: false,
    readOnlyReason: reason,
    sourceLabel: 'Saved note',
  });
  if (
    !UUID.test(ownerId) ||
    !UUID.test(memory.id) ||
    memory.agentId !== ownerId ||
    !HASH.test(memory.contentHash)
  )
    return no('invalid_owner_or_identity');
  try {
    parseOwnerCorrection(memory.ownerCorrection, memory.contentHash);
  } catch {
    return no('malformed_owner_correction');
  }
  if (memory.category !== 'knowledge') return no('unsupported_memory_category');
  if (
    !Number.isFinite(input.now.getTime()) ||
    (memory.expiresAt !== null &&
      (!(memory.expiresAt instanceof Date) ||
        !Number.isFinite(memory.expiresAt.getTime()) ||
        memory.expiresAt <= input.now))
  )
    return no('expired_or_invalid_lifecycle');
  if (memory.supersededById !== null) return no('superseded');
  if (memory.quarantined !== false) return no('quarantined');
  if (proof.tombstoned !== false) return no('tombstoned');
  if (!proof.complete) return no('incomplete_provenance');
  if (proof.shared !== false) return no('shared_source');
  if (proof.conflictingLineage !== false) return no('conflicting_lineage');
  if (
    memory.subjectContactId !== null &&
    (!UUID.test(memory.subjectContactId) || !proof.subjectValid)
  )
    return no('unverified_subject');
  const p = proof.provenance;
  if (p.kind === 'manual' || p.kind === 'graph_owner') {
    if (
      memory.sourceTaskId !== null ||
      memory.source !== (p.kind === 'manual' ? 'manual' : 'knowledge-graph-owner')
    )
      return no('source_identity_mismatch');
    return {
      eligible: true,
      sourceLabel: p.kind === 'manual' ? 'Saved manual note' : 'Owner-authored graph note',
    };
  }
  if (p.kind === 'extracted') {
    if (
      !UUID.test(p.taskId) ||
      memory.sourceTaskId !== p.taskId ||
      p.taskOwnerId !== ownerId ||
      p.sourceOwnerId !== ownerId ||
      !p.exactSourceMatch ||
      !['conversation_message', 'email_source'].includes(p.sourceRelationship)
    )
      return no('unverified_extraction_source');
    return { eligible: true, sourceLabel: 'Extracted saved note' };
  }
  if (p.kind === 'import') {
    if (
      p.canonicalOwnerId !== ownerId ||
      !p.canonicalSource ||
      p.canonicalSource !== memory.source ||
      p.lineageCount !== 1 ||
      p.unitCount !== 1 ||
      !p.strictUnit
    )
      return no('unsupported_import_provenance');
    return { eligible: true, sourceLabel: 'Imported saved note' };
  }
  return no('unknown_provenance');
}

/** Exact one-unit provenance grammar shared by both native proof readers. */
export function validSingleOwnerMemoryImportUnit(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !==
    'authorEmail,hasQuotedContent,header,observedAt,sourceOffset,unitOffset,unitTextHash'
  )
    return false;
  const iso = row.observedAt;
  return (
    Number.isSafeInteger(row.sourceOffset) &&
    Number(row.sourceOffset) >= 0 &&
    Number.isSafeInteger(row.unitOffset) &&
    Number(row.unitOffset) >= 0 &&
    (iso === null ||
      (typeof iso === 'string' &&
        iso.length === 24 &&
        Number.isFinite(Date.parse(iso)) &&
        new Date(iso).toISOString() === iso)) &&
    (row.authorEmail === null ||
      (typeof row.authorEmail === 'string' && row.authorEmail.length <= 320)) &&
    typeof row.header === 'string' &&
    row.header.length <= 8000 &&
    typeof row.hasQuotedContent === 'boolean' &&
    typeof row.unitTextHash === 'string' &&
    HASH.test(row.unitTextHash)
  );
}

/** Portable view of the exact native read; revision is source CAS, not an operation receipt. */
export interface OwnerMemoryEditorSnapshot {
  memoryId: string;
  ownerId: string;
  content: string;
  contentHash: string;
  revision: string;
  ownerCorrection: OwnerCorrection | null;
  sourceLabel: string;
  eligible: boolean;
  readOnlyReason?: string;
  sourceHref?: string;
}
