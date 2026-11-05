import { createHash } from 'node:crypto';
import {
  type OwnerEditorScope,
  ownerEditorPrivacyDigest,
  ownerMemoryCorrectionEligibility,
  parseOwnerCorrection,
  parseOwnerEditorEpochCursor,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { decodeMemoryRecord } from './memory-record.js';
import { ownerEditorFirestorePrivacyToken } from './owner-editor-repository.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

type Reason =
  | 'scope_mismatch'
  | 'owner_unavailable'
  | 'privacy_unavailable'
  | 'epoch_unavailable'
  | 'memory_unavailable'
  | 'memory_malformed'
  | 'memory_ineligible'
  | 'replacement_invalid'
  | 'tombstone_present'
  | 'lineage_incomplete'
  | 'contact_unavailable'
  | 'transaction_unknown';

type UnknownObservation = { status: 'unknown'; reason: Reason };
type NativeVersion = { seconds: number; nanoseconds: number };

interface DependencyRead {
  collection: string;
  key: string;
  state: 'present' | 'missing';
  value: unknown;
  nativeVersion: { kind: 'firestore_timestamp'; seconds: number; nanoseconds: number } | null;
}

interface ManualManifestV2 {
  version: 2;
  driver: 'firestore';
  ownerId: string;
  memoryId: string;
  observedAt: string;
  memory: Record<string, unknown>;
  oldHashTombstone: DependencyRead;
  newHashTombstone: DependencyRead;
  subjectContact: DependencyRead | null;
  lineageQuery: {
    collection: 'memoryImportLineage';
    scope: { memoryId: string };
    limit: 2;
    complete: true;
    keys: [];
  };
  replacement: { content: string; contentHash: string };
}

export interface FirestoreManualOwnerMemoryEvidence {
  status: 'observed';
  /** Internal input evidence. This is not a write grant or currentness receipt. */
  manifest: ManualManifestV2;
  /** Metadata needed to interpret this observation; never serialize or log it. */
  readSet: {
    ownerPageCount: number;
    privacyGeneration: string | null;
    privacyNativeVersion: NativeVersion | null;
    editorEpoch: string;
    editorEpochNativeVersion: NativeVersion;
    nativeSnapshot: { state: 'unavailable' };
  };
}

export type FirestoreManualOwnerMemoryObservation =
  | FirestoreManualOwnerMemoryEvidence
  | UnknownObservation;

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const epochName = (ownerId: string) => `owner-editor-epoch:${ownerId}`;

function nativeVersion(snapshot: DocumentSnapshot): NativeVersion | null {
  const updateTime = snapshot.updateTime;
  if (!snapshot.exists || !updateTime) return null;
  if (
    !Number.isSafeInteger(updateTime.seconds) ||
    !Number.isSafeInteger(updateTime.nanoseconds) ||
    updateTime.nanoseconds < 0 ||
    updateTime.nanoseconds >= 1_000_000_000
  )
    throw new TypeError('Native version unavailable');
  return { seconds: updateTime.seconds, nanoseconds: updateTime.nanoseconds };
}

function iso(value: unknown): string | null {
  if (value === null) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string') {
    const date = new Date(value);
    if (Number.isFinite(date.getTime()) && date.toISOString() === value) return value;
  }
  throw new TypeError('Lifecycle time unavailable');
}

function unknown(reason: Reason): UnknownObservation {
  return { status: 'unknown', reason };
}

/**
 * Collects one bounded Firestore read observation in the caller's native
 * transaction. The transaction must be a normal read-write transaction with
 * no writes queued. Every invocation, including SDK retries, rebuilds all reads.
 */
export async function collectFirestoreManualOwnerMemoryEvidenceInTransaction(
  tx: Transaction,
  store: InstallationStore,
  configuredOwnerId: string,
  scope: OwnerEditorScope,
  memoryId: string,
  replacementContent: string,
): Promise<FirestoreManualOwnerMemoryObservation> {
  try {
    if (
      !configuredOwnerId ||
      configuredOwnerId !== scope.ownerId ||
      scope.command !== 'correct_owner_memory' ||
      scope.targetId !== memoryId ||
      !memoryId ||
      typeof replacementContent !== 'string' ||
      !replacementContent.trim()
    )
      return unknown('scope_mismatch');

    const ownerPage = await tx.get(store.collection('agents').limit(2));
    if (
      ownerPage.size !== 1 ||
      ownerPage.docs.length !== 1 ||
      ownerPage.docs[0]?.get('id') !== configuredOwnerId ||
      ownerPage.docs[0]?.id !== documentKey(configuredOwnerId)
    )
      return unknown('owner_unavailable');

    const privacyRef = store.doc('privacyErasureJobs', configuredOwnerId);
    const epochId = epochName(configuredOwnerId);
    const epochRef = store.doc('maintenanceCursors', epochId);
    const [privacy, epoch] = await tx.getAll(privacyRef, epochRef);
    if (!privacy || !epoch) return unknown('privacy_unavailable');

    let privacyToken: string | null;
    try {
      privacyToken = ownerEditorFirestorePrivacyToken(privacy, configuredOwnerId);
    } catch {
      return unknown('privacy_unavailable');
    }
    if (privacyToken !== scope.privacyGeneration) return unknown('privacy_unavailable');

    if (
      !epoch.exists ||
      epoch.id !== epochRef.id ||
      epoch.get('name') !== epochId ||
      typeof epoch.get('cursor') !== 'string' ||
      !epoch.updateTime
    )
      return unknown('epoch_unavailable');
    let cursor: ReturnType<typeof parseOwnerEditorEpochCursor>;
    try {
      cursor = parseOwnerEditorEpochCursor(JSON.parse(epoch.get('cursor') as string));
    } catch {
      return unknown('epoch_unavailable');
    }
    if (
      cursor.ownerId !== configuredOwnerId ||
      cursor.epoch !== scope.epoch ||
      cursor.ready !== true ||
      cursor.privacyGenerationDigest !== ownerEditorPrivacyDigest(privacyToken)
    )
      return unknown('epoch_unavailable');
    const privacyNativeVersion = nativeVersion(privacy);
    const editorEpochNativeVersion = nativeVersion(epoch);
    if (!editorEpochNativeVersion) return unknown('epoch_unavailable');

    const memoryRef = store.doc('memories', memoryId);
    const memoryDoc = await tx.get(memoryRef);
    if (!memoryDoc.exists) return unknown('memory_unavailable');
    if (memoryDoc.id !== documentKey(memoryId)) return unknown('memory_malformed');
    const memory = decodeMemoryRecord(memoryDoc.data());
    if (
      memory.id !== memoryId ||
      memory.agentId !== configuredOwnerId ||
      typeof memory.content !== 'string' ||
      typeof memory.contentHash !== 'string' ||
      hash(memory.content) !== memory.contentHash ||
      memory.category !== 'knowledge' ||
      memory.source !== 'manual' ||
      memory.sourceTaskId !== null ||
      (memory.subjectContactId !== null && typeof memory.subjectContactId !== 'string') ||
      (memory.expiresAt !== null && !(memory.expiresAt instanceof Date)) ||
      (memory.supersededById !== null && typeof memory.supersededById !== 'string') ||
      typeof memory.quarantined !== 'boolean'
    )
      return unknown('memory_malformed');
    let ownerCorrection: ReturnType<typeof parseOwnerCorrection>;
    try {
      ownerCorrection = parseOwnerCorrection(memory.ownerCorrection, memory.contentHash);
    } catch {
      return unknown('memory_malformed');
    }

    const replacementHash = hash(replacementContent);
    if (replacementHash === memory.contentHash || replacementContent === memory.content)
      return unknown('replacement_invalid');

    const oldTombstoneRef = store.doc('memoryTombstones', memory.contentHash);
    const newTombstoneRef = store.doc('memoryTombstones', replacementHash);
    const lineageQuery = store
      .collection('memoryImportLineage')
      .where('memoryId', '==', memoryId)
      .limit(2);
    const contactRef = memory.subjectContactId
      ? store.doc('contacts', memory.subjectContactId)
      : null;
    const [oldTombstone, newTombstone, lineage, contact] = await Promise.all([
      tx.get(oldTombstoneRef),
      tx.get(newTombstoneRef),
      tx.get(lineageQuery),
      contactRef ? tx.get(contactRef) : Promise.resolve(null),
    ]);
    if (oldTombstone.exists || newTombstone.exists) return unknown('tombstone_present');
    if (lineage.docs.length !== lineage.size || lineage.size !== 0)
      return unknown('lineage_incomplete');

    let subjectContact: DependencyRead | null = null;
    let normalizedContact: Record<string, unknown> | null = null;
    if (memory.subjectContactId !== null) {
      if (!contact?.exists || contact.id !== documentKey(memory.subjectContactId))
        return unknown('contact_unavailable');
      const row = decodeRecord<unknown>(contact.data());
      if (!row || typeof row !== 'object' || Array.isArray(row))
        return unknown('contact_unavailable');
      const fields = row as Record<string, unknown>;
      if (
        fields.id !== memory.subjectContactId ||
        (fields.agentId !== undefined && fields.agentId !== configuredOwnerId) ||
        typeof fields.name !== 'string' ||
        !fields.name.trim() ||
        !Array.isArray(fields.aliases) ||
        !fields.aliases.every((alias) => typeof alias === 'string') ||
        typeof fields.trust !== 'string' ||
        !['owner', 'known', 'unknown'].includes(fields.trust) ||
        ![null, 'owner', 'inferred'].includes(fields.identityAuthority as string | null)
      )
        return unknown('contact_unavailable');
      const version = nativeVersion(contact);
      if (!version) return unknown('contact_unavailable');
      normalizedContact = {
        id: fields.id,
        name: fields.name,
        aliases: fields.aliases,
        trust: fields.trust,
        identityAuthority: fields.identityAuthority,
      };
      subjectContact = {
        collection: 'contacts',
        key: memory.subjectContactId,
        state: 'present',
        value: normalizedContact,
        nativeVersion: { kind: 'firestore_timestamp', ...version },
      };
    }

    const observedAt = store.now();
    if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime()))
      return unknown('transaction_unknown');
    const eligibility = ownerMemoryCorrectionEligibility({
      ownerId: configuredOwnerId,
      memory: {
        id: memory.id,
        agentId: memory.agentId,
        contentHash: memory.contentHash,
        category: memory.category,
        source: memory.source,
        sourceTaskId: memory.sourceTaskId,
        subjectContactId: memory.subjectContactId,
        expiresAt: memory.expiresAt,
        supersededById: memory.supersededById,
        quarantined: memory.quarantined,
        ownerCorrection,
      },
      now: observedAt,
      proof: {
        complete: true,
        tombstoned: false,
        shared: false,
        conflictingLineage: false,
        subjectValid: memory.subjectContactId === null || subjectContact !== null,
        provenance: { kind: 'manual' },
      },
    });
    if (!eligibility.eligible) return unknown('memory_ineligible');
    const manifest: ManualManifestV2 = {
      version: 2,
      driver: 'firestore',
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
        expiresAt: iso(memory.expiresAt),
        supersededById: memory.supersededById,
        quarantined: memory.quarantined,
        ownerCorrection,
      },
      oldHashTombstone: {
        collection: 'memoryTombstones',
        key: `content:${memory.contentHash}`,
        state: 'missing',
        value: null,
        nativeVersion: null,
      },
      newHashTombstone: {
        collection: 'memoryTombstones',
        key: `content:${replacementHash}`,
        state: 'missing',
        value: null,
        nativeVersion: null,
      },
      subjectContact,
      lineageQuery: {
        collection: 'memoryImportLineage',
        scope: { memoryId },
        limit: 2,
        complete: true,
        keys: [],
      },
      replacement: { content: replacementContent, contentHash: replacementHash },
    };
    return {
      status: 'observed',
      manifest,
      readSet: {
        ownerPageCount: ownerPage.size,
        privacyGeneration: privacyToken,
        privacyNativeVersion,
        editorEpoch: cursor.epoch,
        editorEpochNativeVersion,
        nativeSnapshot: { state: 'unavailable' },
      },
    };
  } catch {
    return unknown('transaction_unknown');
  }
}
