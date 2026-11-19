import { createHash } from 'node:crypto';
import {
  type OwnerEditorScope,
  ownerMemoryCorrectionEligibility,
  parseOwnerMemoryProvenancePayload,
} from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import { readPostgresOwnerEditorIssuanceContext } from './owner-editor-repository.js';
import type { PostgresPrivacyObservationTransaction } from './privacy-erasure-repository.js';
import { contacts, memories, memoryImportLineage, memoryTombstones } from './schema.js';

type Input = {
  scope: OwnerEditorScope;
  memoryId: string;
  replacementContent: string;
};
type Observation =
  | {
      kind: 'observed';
      manifest: Record<string, unknown>;
      scopeObservation: { ownerId: string; epoch: string; privacyGeneration: string | null };
    }
  | {
      kind: 'unknown';
      reason:
        | 'invalid_request'
        | 'scope_changed'
        | 'memory_unavailable'
        | 'unsupported_source'
        | 'incomplete_evidence'
        | 'capture_unavailable';
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const unknown = (reason: Extract<Observation, { kind: 'unknown' }>['reason']): Observation => ({
  kind: 'unknown',
  reason,
});

/**
 * Internal, unwired observation collector. Caller owns the actual canonical
 * transaction/isolation and authenticates the server scope; this does not open
 * a pool fallback, issue authority, mutate application rows or mint a receipt.
 * The privacy helper takes its existing owner row lock, so logical read-only
 * here does not mean PostgreSQL's incompatible SQL READ ONLY transaction mode.
 * A coherent observation is not saved_current or freshness at callback return.
 */
export async function collectPostgresManualOwnerMemoryEvidence(
  tx: PostgresPrivacyObservationTransaction,
  configuredOwnerId: string,
  input: Input,
): Promise<Observation> {
  try {
    const { scope, memoryId, replacementContent } = input;
    if (
      !UUID.test(configuredOwnerId) ||
      !UUID.test(memoryId) ||
      scope.ownerId !== configuredOwnerId ||
      scope.command !== 'correct_owner_memory' ||
      scope.targetId !== memoryId ||
      typeof replacementContent !== 'string' ||
      replacementContent !== replacementContent.trim() ||
      replacementContent.length < 3 ||
      replacementContent.length > 4000
    )
      return unknown('invalid_request');

    const context = await readPostgresOwnerEditorIssuanceContext(tx, configuredOwnerId);
    if (
      !context ||
      context.epoch !== scope.epoch ||
      context.privacyGeneration !== scope.privacyGeneration
    )
      return unknown('scope_changed');

    const [memory] = await tx
      .select()
      .from(memories)
      .where(and(eq(memories.id, memoryId), eq(memories.agentId, configuredOwnerId)))
      .limit(1);
    if (
      !memory ||
      typeof memory.content !== 'string' ||
      digest(memory.content) !== memory.contentHash
    )
      return unknown('memory_unavailable');
    if (memory.source !== 'manual' || memory.sourceTaskId !== null)
      return unknown('unsupported_source');
    const replacementHash = digest(replacementContent);
    if (replacementHash === memory.contentHash) return unknown('invalid_request');

    // These are separate hash-bound native reads. Never relabel old absence as
    // new absence, even if the old and replacement bodies look equivalent.
    const [oldTombstones, newTombstones, lineage] = await Promise.all([
      tx
        .select({ contentHash: memoryTombstones.contentHash })
        .from(memoryTombstones)
        .where(eq(memoryTombstones.contentHash, memory.contentHash))
        .limit(1),
      tx
        .select({ contentHash: memoryTombstones.contentHash })
        .from(memoryTombstones)
        .where(eq(memoryTombstones.contentHash, replacementHash))
        .limit(1),
      tx
        .select({ memoryId: memoryImportLineage.memoryId })
        .from(memoryImportLineage)
        .where(eq(memoryImportLineage.memoryId, memoryId))
        .limit(2),
    ]);
    if (oldTombstones.length !== 0 || newTombstones.length !== 0 || lineage.length !== 0)
      return unknown('incomplete_evidence');

    let subjectContact: Record<string, unknown> | null = null;
    if (memory.subjectContactId !== null) {
      const [contact] = await tx
        .select({
          id: contacts.id,
          name: contacts.name,
          aliases: contacts.aliases,
          trust: contacts.trust,
          identityAuthority: contacts.identityAuthority,
          // Preserve actual stored microseconds; never round through JS Date.
          nativeVersion: sql<string>`to_char(${contacts.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(contacts)
        .where(eq(contacts.id, memory.subjectContactId))
        .limit(1);
      if (
        !contact ||
        contact.id !== memory.subjectContactId ||
        typeof contact.name !== 'string' ||
        !contact.name.trim() ||
        !Array.isArray(contact.aliases) ||
        !contact.aliases.every((alias) => typeof alias === 'string') ||
        !['owner', 'known', 'unknown'].includes(contact.trust) ||
        ![null, 'owner', 'inferred'].includes(contact.identityAuthority)
      )
        return unknown('incomplete_evidence');
      subjectContact = {
        collection: 'contacts',
        key: contact.id,
        state: 'present',
        value: {
          id: contact.id,
          name: contact.name,
          aliases: [...contact.aliases],
          trust: contact.trust,
          identityAuthority: contact.identityAuthority,
        },
        nativeVersion: { kind: 'postgres_timestamp', value: contact.nativeVersion },
      };
    }

    const finalContext = await readPostgresOwnerEditorIssuanceContext(tx, configuredOwnerId);
    if (
      !finalContext ||
      finalContext.epoch !== context.epoch ||
      finalContext.privacyGeneration !== context.privacyGeneration
    )
      return unknown('scope_changed');
    // Trusted server lifecycle time, once per actual attempt, not client input
    // or a substitute for native snapshot/commit linearization.
    const observedAt = new Date();
    if (!Number.isFinite(scope.expiresAt) || observedAt.getTime() >= scope.expiresAt)
      return unknown('scope_changed');
    const eligible = ownerMemoryCorrectionEligibility({
      ownerId: configuredOwnerId,
      memory,
      now: observedAt,
      proof: {
        complete: true,
        tombstoned: false,
        shared: false,
        conflictingLineage: false,
        subjectValid: true,
        provenance: { kind: 'manual' },
      },
    });
    if (!eligible.eligible) return unknown('incomplete_evidence');

    const missing = (contentHash: string) => ({
      collection: 'memoryTombstones',
      key: `content:${contentHash}`,
      state: 'missing',
      value: null,
      nativeVersion: null,
    });
    const oldHashTombstone = missing(memory.contentHash);
    const lineageQuery = {
      collection: 'memoryImportLineage',
      scope: { memoryId },
      limit: 2,
      complete: true,
      keys: [],
    };
    // Validate only genuinely observed external dependencies with the existing
    // public codec. This is not a synthetic target-version envelope or mint.
    parseOwnerMemoryProvenancePayload({
      version: 1,
      driver: 'postgres',
      ownerId: configuredOwnerId,
      memoryId,
      contentHash: memory.contentHash,
      targetSource: {
        source: memory.source,
        sourceTaskId: memory.sourceTaskId,
        subjectContactId: memory.subjectContactId,
      },
      dependencies: [oldHashTombstone, ...(subjectContact ? [subjectContact] : [])],
      queries: [lineageQuery],
    });
    return {
      kind: 'observed',
      scopeObservation: finalContext,
      manifest: {
        version: 2,
        driver: 'postgres',
        ownerId: configuredOwnerId,
        memoryId,
        observedAt: observedAt.toISOString(),
        memory: {
          id: memory.id,
          agentId: memory.agentId,
          content: memory.content,
          contentHash: memory.contentHash,
          category: memory.category,
          source: memory.source,
          sourceTaskId: memory.sourceTaskId,
          subjectContactId: memory.subjectContactId,
          expiresAt: memory.expiresAt?.toISOString() ?? null,
          supersededById: memory.supersededById,
          quarantined: memory.quarantined,
          ownerCorrection: memory.ownerCorrection ?? null,
        },
        oldHashTombstone,
        newHashTombstone: missing(replacementHash),
        subjectContact,
        lineageQuery,
        replacement: { content: replacementContent, contentHash: replacementHash },
      },
    };
  } catch (error) {
    // Preserve native abort/cancellation errors for the owning transaction's
    // retry/error boundary. Each retry must invoke this collector from scratch.
    if (hasNativeCode(error)) throw error;
    return unknown('capture_unavailable');
  }
}

function hasNativeCode(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const value = error as { code?: unknown; cause?: unknown };
  return (
    typeof value.code === 'string' ||
    typeof value.code === 'number' ||
    hasNativeCode(value.cause, depth + 1)
  );
}
