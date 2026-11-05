import { createHash } from 'node:crypto';
import {
  ownerMemoryCorrectionEligibility,
  parseOwnerCorrection,
} from './owner-memory-correction.js';
import {
  type OwnerMemoryProvenanceJsonValue,
  type OwnerMemoryProvenancePayload,
  ownerMemoryProvenanceFingerprint,
  parseOwnerMemoryProvenancePayload,
} from './owner-memory-provenance.js';

type Json = OwnerMemoryProvenanceJsonValue;
type Row = Record<string, Json>;

/** Internal pure projection only. No adapter, receipt mint, or public package export. */
export interface ManualOwnerMemoryProjection {
  prewrite: OwnerMemoryProvenancePayload;
  current: OwnerMemoryProvenancePayload;
  prewriteFingerprint: string;
  expectedCurrentFingerprint: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const sha256 = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

/**
 * Closed normalized manifest for one manual-content correction. Every read must
 * eventually come from the same admitted native transaction, BEFORE any writes.
 * This pure function cannot establish authentication, actual read completeness,
 * independent old/new lookups, query phantom fencing, CAS, or writer admission.
 * A non-null result alone never authorizes a write or a Saved/current UI state.
 */
export function projectManualOwnerMemoryCorrection(
  value: unknown,
): ManualOwnerMemoryProjection | null {
  try {
    const manifest = exact(snapshot(value), [
      'version',
      'driver',
      'ownerId',
      'memoryId',
      'observedAt',
      'memory',
      'memoryNativeVersion',
      'oldHashTombstone',
      'newHashTombstone',
      'subjectContact',
      'lineageQuery',
      'replacement',
    ]);
    if (
      manifest.version !== 1 ||
      (manifest.driver !== 'postgres' && manifest.driver !== 'firestore') ||
      !uuid(manifest.ownerId) ||
      !uuid(manifest.memoryId)
    )
      return null;
    const observedAt = instant(manifest.observedAt);
    const memory = exact(manifest.memory, [
      'id',
      'agentId',
      'content',
      'contentHash',
      'category',
      'source',
      'sourceTaskId',
      'subjectContactId',
      'expiresAt',
      'supersededById',
      'quarantined',
      'ownerCorrection',
    ]);
    const replacement = exact(manifest.replacement, ['content', 'contentHash']);
    if (
      memory.id !== manifest.memoryId ||
      memory.agentId !== manifest.ownerId ||
      typeof memory.content !== 'string' ||
      !hash(memory.contentHash) ||
      sha256(memory.content) !== memory.contentHash ||
      memory.category !== 'knowledge' ||
      memory.source !== 'manual' ||
      memory.sourceTaskId !== null ||
      (memory.subjectContactId !== null && !uuid(memory.subjectContactId)) ||
      typeof replacement.content !== 'string' ||
      !replacement.content.trim() ||
      !hash(replacement.contentHash) ||
      sha256(replacement.content) !== replacement.contentHash ||
      replacement.contentHash === memory.contentHash
    )
      return null;
    const expiresAt = memory.expiresAt === null ? null : instant(memory.expiresAt);
    if (memory.ownerCorrection !== null) {
      exact(memory.ownerCorrection, [
        'version',
        'correctedByOwner',
        'priorContentHash',
        'currentContentHash',
        'correctedAt',
      ]);
    }
    parseOwnerCorrection(memory.ownerCorrection, memory.contentHash);

    const lineage = exact(manifest.lineageQuery, [
      'collection',
      'scope',
      'limit',
      'complete',
      'keys',
    ]);
    const scope = exact(lineage.scope, ['memoryId']);
    if (
      lineage.collection !== 'memoryImportLineage' ||
      scope.memoryId !== manifest.memoryId ||
      lineage.limit !== 2 ||
      lineage.complete !== true ||
      !Array.isArray(lineage.keys) ||
      lineage.keys.length !== 0
    )
      return null;

    // Build both payloads from distinct, mandatory hash-scoped read entries.
    // Never turn the old tombstone observation into a new-hash absence proof.
    const oldTombstone = missingTombstone(manifest.oldHashTombstone, memory.contentHash);
    const newTombstone = missingTombstone(manifest.newHashTombstone, replacement.contentHash);
    const dependencies: Json[] = [oldTombstone];
    if (memory.subjectContactId === null) {
      if (manifest.subjectContact !== null) return null;
    } else {
      const contact = exact(manifest.subjectContact, [
        'collection',
        'key',
        'state',
        'value',
        'nativeVersion',
      ]);
      if (
        contact.collection !== 'contacts' ||
        contact.key !== memory.subjectContactId ||
        contact.state !== 'present' ||
        contact.nativeVersion === null
      )
        return null;
      const fields = exact(contact.value, [
        'id',
        'name',
        'aliases',
        'emails',
        'phones',
        'relationship',
        'trust',
        'identityAuthority',
        'notes',
        'createdAt',
        'updatedAt',
      ]);
      if (
        fields.id !== memory.subjectContactId ||
        typeof fields.name !== 'string' ||
        !fields.name.trim() ||
        !strings(fields.aliases) ||
        !strings(fields.emails) ||
        !strings(fields.phones) ||
        typeof fields.relationship !== 'string' ||
        typeof fields.trust !== 'string' ||
        !['owner', 'known', 'unknown'].includes(fields.trust) ||
        ![null, 'owner', 'inferred'].includes(fields.identityAuthority as string | null) ||
        typeof fields.notes !== 'string'
      )
        return null;
      instant(fields.createdAt);
      instant(fields.updatedAt);
      dependencies.push(contact);
    }
    const make = (contentHash: string, reads: Json[]) =>
      parseOwnerMemoryProvenancePayload({
        version: 1,
        driver: manifest.driver,
        ownerId: manifest.ownerId,
        memoryId: manifest.memoryId,
        contentHash,
        targetSource: {
          source: memory.source,
          sourceTaskId: memory.sourceTaskId,
          subjectContactId: memory.subjectContactId,
        },
        dependencies: reads,
        queries: [lineage],
      });
    const prewrite = make(memory.contentHash, dependencies);
    // Validate the old native read version strictly with the unchanged codec,
    // but never fingerprint target-memory updateTime/retrieval metadata. Its
    // own correction necessarily changes that version; future CAS stays separate.
    if (manifest.memoryNativeVersion == null) return null;
    make(memory.contentHash, [
      {
        collection: 'contacts',
        key: manifest.memoryId,
        state: 'present',
        value: {},
        nativeVersion: manifest.memoryNativeVersion,
      },
    ]);
    const eligible = ownerMemoryCorrectionEligibility({
      ownerId: manifest.ownerId,
      memory: {
        id: manifest.memoryId,
        agentId: manifest.ownerId,
        contentHash: memory.contentHash,
        category: memory.category,
        source: memory.source,
        sourceTaskId: null,
        subjectContactId: memory.subjectContactId,
        expiresAt,
        supersededById: memory.supersededById === null ? null : String(memory.supersededById),
        quarantined: memory.quarantined !== false,
        ownerCorrection: memory.ownerCorrection,
      },
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
    if (!eligible.eligible) return null;
    // Creating the old-hash tombstone is expected history after this transition.
    // The new row's provenance requires the independently read NEW hash absence.
    const current = make(replacement.contentHash, [newTombstone, ...dependencies.slice(1)]);
    const prewriteFingerprint = ownerMemoryProvenanceFingerprint(prewrite);
    const expectedCurrentFingerprint = ownerMemoryProvenanceFingerprint(current);
    if (prewriteFingerprint === null || expectedCurrentFingerprint === null) return null;
    return { prewrite, current, prewriteFingerprint, expectedCurrentFingerprint };
  } catch {
    return null;
  }
}

function missingTombstone(value: Json | undefined, contentHash: string): Row {
  const read = exact(value, ['collection', 'key', 'state', 'value', 'nativeVersion']);
  if (
    read.collection !== 'memoryTombstones' ||
    read.key !== `content:${contentHash}` ||
    read.state !== 'missing' ||
    read.value !== null ||
    read.nativeVersion !== null
  )
    throw new TypeError('Missing exact hash-scoped tombstone observation');
  return read;
}

function exact(value: Json | undefined, keys: string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Record');
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new TypeError('Unmodeled manifest fields');
  return value;
}

function instant(value: Json | undefined): Date {
  if (typeof value !== 'string') throw new TypeError('Instant');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new TypeError('Instant');
  return date;
}

function uuid(value: Json | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}
function hash(value: Json | undefined): value is string {
  return typeof value === 'string' && HASH.test(value);
}
function strings(value: Json | undefined): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Snapshot only data properties: getters, symbols, sparse arrays, cycles fail closed. */
function snapshot(value: unknown, seen = new Set<object>()): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('JSON manifest');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('Array keys');
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) throw new TypeError('Array value');
        return snapshot(descriptor.value, seen);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Record prototype');
    const result: Row = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('Symbol key');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new TypeError('Getter');
      result[key] = snapshot(descriptor.value, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
