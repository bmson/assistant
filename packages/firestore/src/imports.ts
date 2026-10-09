import { createHash, randomUUID } from 'node:crypto';
import {
  type EmbeddingSpace,
  type ImportCommandRepository,
  type ImportDeletionAsset,
  type ImportFactWrite,
  type ImportJobFence,
  type ImportJobRepository,
  type ImportOccasionWrite,
  type ImportProgress,
  type ImportRunCursor,
  type ImportStartInput,
  MAX_OWNER_CARD_CONTACT_SCAN,
  newTaskRecord,
  type Records,
  snapshotEmbeddingSpace,
  type VoiceIngestCursor,
  type VoiceSampleWrite,
  validateEmbedding,
} from '@assistant/persistence';
import {
  type DocumentReference,
  type DocumentSnapshot,
  FieldPath,
  FieldValue,
  type Query,
  type QueryDocumentSnapshot,
  type Transaction,
} from '@google-cloud/firestore';
import { isEmulatorClosedTransaction } from './emulator-transaction.js';
import { embeddingSpaceKey, memoryDocument } from './memory.js';
import {
  occasionDateKey,
  occasionDateKeyId,
  occasionDateKeyRef,
  resolveOccasionIdentity,
} from './occasion-identity.js';
import { createWakeIntent } from './outbox.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { FirestoreProfileMemoryMaintenance } from './profile-memory-maintenance.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type ImportSource = Records['importSources'];
type Task = Records['tasks'];

const IMPORT_JOBS = new Set(['import.run', 'voice.ingest']);
const ACTIVE_TASK_STATUSES = ['pending', 'sleeping', 'running', 'needs_attention'];
const SOURCE_TAG = /^[a-z0-9._-]{2,80}$/;
const PAGE_SIZE = 100;
const SCAN_PAGE_SIZE = 500;
const MAX_WINDOW_FACTS = 25;
const MAX_WINDOW_OCCASIONS = 10;
const MAX_VOICE_BATCH = 100;
const MAX_WRITING_SAMPLE_SCAN = 20_000;
/** One source's memories are purged or reviewed in pages; past this the command fails. */
const MAX_SOURCE_MEMORIES = 100_000;
const IMPORT_ASSET_PAGE = 200;
const ASSISTANT_ALIASES = new Set(['assistant', 'ai bot', 'b bot', 'the assistant', 'bot']);
const VOICE_REGISTERS = new Set(['email_professional', 'email_casual', 'sms', 'chat']);

function sourceKeyId(agentId: string, source: string): string {
  return createHash('sha256').update(`${agentId}\0${source}`).digest('hex');
}

function deletionJobId(agentId: string, source: string): string {
  return createHash('sha256').update(`import-delete\0${agentId}\0${source}`).digest('hex');
}

function snapshotAssetId(agentId: string, sourceId: string, workspacePath: string): string {
  return createHash('sha256')
    .update(`import-snapshot\0${agentId}\0${sourceId}\0${workspacePath}`)
    .digest('hex');
}

function isCanonicalWorkspacePath(value: unknown, prefix: string): value is string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\'))
    return false;
  const parts = value.split('/');
  return (
    value.startsWith(prefix) &&
    !parts.some((part) => !part || part === '.' || part === '..') &&
    parts.join('/') === value
  );
}

function validSourceUploadPath(value: unknown): value is string {
  return isCanonicalWorkspacePath(value, 'import/');
}

function validSnapshotPath(value: unknown, source: string, taskId: string): value is string {
  const prefix = `.assistant/imports/${source}/${taskId}/`;
  return (
    isCanonicalWorkspacePath(value, prefix) &&
    /^(?:manifest\.json|windows-\d{6}\.json)$/.test(value.slice(prefix.length))
  );
}

function importLineageId(source: string, memoryId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([source, memoryId]))
    .digest('hex');
}

function occasionImportLineageId(source: string, occasionId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([source, occasionId]))
    .digest('hex');
}

function mergeImportUnitProvenance(
  current: ImportFactWrite['sourceUnitProvenance'],
  incoming: ImportFactWrite['sourceUnitProvenance'],
): ImportFactWrite['sourceUnitProvenance'] {
  const units = new Map<string, ImportFactWrite['sourceUnitProvenance'][number]>();
  for (const unit of [...current, ...incoming])
    units.set(`${unit.sourceOffset}:${unit.unitOffset}:${unit.unitTextHash}`, unit);
  return [...units.values()].sort(
    (left, right) => left.sourceOffset - right.sourceOffset || left.unitOffset - right.unitOffset,
  );
}

function uuidFromHash(input: string): string {
  const bytes = createHash('sha256').update(input).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Uploaded samples key on owner and text, so a replayed batch finds its own rows. */
function writingSampleId(agentId: string, text: string, embeddingSpaceKey: string): string {
  return uuidFromHash(`writing-sample\0${agentId}\0${embeddingSpaceKey}\0${text}`);
}

function namePrefixMatch(left: string, right: string): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 3 && (shorter === longer || longer.startsWith(`${shorter} `));
}

function nonNegativeInteger(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Import task cursor is malformed');
  return value as number;
}

function plannerSection(state: unknown, key: string): Record<string, unknown> {
  const root = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  const planner =
    root.plannerState && typeof root.plannerState === 'object'
      ? (root.plannerState as Record<string, unknown>)
      : {};
  const value = planner[key];
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stateWith(state: unknown, key: string, cursor: object): Record<string, unknown> {
  const root = state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
  const planner =
    root.plannerState && typeof root.plannerState === 'object'
      ? { ...(root.plannerState as Record<string, unknown>) }
      : {};
  planner[key] = cursor;
  root.plannerState = planner;
  return root;
}

function importCursorFrom(state: unknown): ImportRunCursor {
  const value = plannerSection(state, 'import');
  const cursor: ImportRunCursor = {
    windowIndex: nonNegativeInteger(value.windowIndex),
    saved: nonNegativeInteger(value.saved),
    duplicates: nonNegativeInteger(value.duplicates),
    tombstoned: nonNegativeInteger(value.tombstoned),
    quarantined: nonNegativeInteger(value.quarantined),
    occasionsSaved: nonNegativeInteger(value.occasionsSaved),
  };
  if (typeof value.manifestPath === 'string') cursor.manifestPath = value.manifestPath;
  if (typeof value.manifestHash === 'string') cursor.manifestHash = value.manifestHash;
  return cursor;
}

function voiceCursorFrom(state: unknown): VoiceIngestCursor {
  const value = plannerSection(state, 'voiceIngest');
  const embeddingSpaceKey = value.embeddingSpaceKey;
  if (
    embeddingSpaceKey !== undefined &&
    (typeof embeddingSpaceKey !== 'string' || !/^[a-f0-9]{64}$/.test(embeddingSpaceKey))
  )
    throw new Error('Voice import cursor embedding identity is malformed');
  return {
    index: nonNegativeInteger(value.index),
    saved: nonNegativeInteger(value.saved),
    duplicates: nonNegativeInteger(value.duplicates),
    ...(typeof embeddingSpaceKey === 'string' ? { embeddingSpaceKey } : {}),
  };
}

function validProgress(progress: ImportProgress): ImportProgress {
  if (
    typeof progress.progress !== 'string' ||
    !Number.isSafeInteger(progress.progressPercent) ||
    progress.progressPercent < 0 ||
    progress.progressPercent > 100
  )
    throw new Error('Import progress is malformed');
  return { progress: progress.progress.slice(0, 500), progressPercent: progress.progressPercent };
}

function ownedSource(snapshot: DocumentSnapshot, agentId: string): ImportSource {
  const row = decodeRecord<ImportSource>(snapshot.data());
  if (
    !row.id ||
    documentKey(row.id) !== snapshot.id ||
    row.agentId !== agentId ||
    typeof row.source !== 'string' ||
    typeof row.workspacePath !== 'string'
  )
    throw new Error('Malformed or foreign import source record');
  return row;
}

/** Owner and erasure checks shared by every import mutation, inside its transaction. */
async function readConfiguredOwner(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
): Promise<void> {
  const owners = await tx.get(store.collection('agents').limit(2));
  const owner = owners.docs[0];
  if (
    owners.size !== 1 ||
    !owner ||
    owner.id !== documentKey(agentId) ||
    owner.get('id') !== agentId
  )
    throw new Error('Imports require exactly one matching configured owner');
  const erasure = await tx.get(store.doc('privacyErasureJobs', agentId));
  if (
    erasure.exists &&
    (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
  )
    throw new Error('Privacy erasure is in progress');
}

/**
 * The one source row for `source`, by its identity claim or, for rows imported
 * from PostgreSQL before claims existed, by an owner-scoped lookup.
 */
async function readSource(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
  source: string,
): Promise<{ row: ImportSource; ref: DocumentReference; claimed: boolean } | null> {
  const claim = await tx.get(store.doc('importSourceKeys', sourceKeyId(agentId, source)));
  if (claim.exists) {
    const sourceId = claim.get('sourceId');
    if (claim.get('agentId') !== agentId || claim.get('source') !== source || !sourceId)
      throw new Error('Import source identity claim is malformed');
    const snapshot = await tx.get(store.doc('importSources', String(sourceId)));
    if (!snapshot.exists) throw new Error('Import source identity claim is stale');
    const row = ownedSource(snapshot, agentId);
    if (row.source !== source) throw new Error('Import source identity claim is stale');
    return { row, ref: snapshot.ref, claimed: true };
  }
  const matches = await tx.get(
    store
      .collection('importSources')
      .where('agentId', '==', agentId)
      .where('source', '==', source)
      .limit(2),
  );
  if (matches.size > 1) throw new Error('Duplicate import source identity');
  const snapshot = matches.docs[0];
  if (!snapshot) return null;
  const row = ownedSource(snapshot, agentId);
  if (row.source !== source) throw new Error('Malformed or foreign import source record');
  return { row, ref: snapshot.ref, claimed: false };
}

function invalidateOwnerCard(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
  now: Date,
): void {
  tx.set(
    store.doc('ownerCards', agentId),
    encodeRecord({ agentId, content: '', compiledAt: now, invalidatedAt: now }),
  );
}

/** Firestore state for the import code jobs, fenced by owner, lease, source, and erasure. */
export class FirestoreImportJobRepository implements ImportJobRepository {
  readonly kind = 'import-job-repository' as const;
  readonly embeddingSpace: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
    embeddingSpace: EmbeddingSpace,
  ) {
    this.embeddingSpace = snapshotEmbeddingSpace(embeddingSpace);
  }

  private async readFence(
    tx: Transaction,
    fence: ImportJobFence,
  ): Promise<{
    task: Task;
    taskRef: DocumentReference;
    source: ImportSource;
    sourceRef: DocumentReference;
  } | null> {
    if (
      !this.configuredAgentId ||
      fence.agentId !== this.configuredAgentId ||
      !fence.leaseToken ||
      !Number.isSafeInteger(fence.queueGeneration) ||
      fence.queueGeneration < 0 ||
      !SOURCE_TAG.test(fence.source)
    )
      return null;
    await readConfiguredOwner(tx, this.store, fence.agentId);
    const taskSnap = await tx.get(this.store.doc('tasks', fence.taskId));
    if (!taskSnap.exists) return null;
    const task = decodeRecord<Task>(taskSnap.data());
    const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload;
    if (
      task.id !== fence.taskId ||
      documentKey(task.id) !== taskSnap.id ||
      task.agentId !== fence.agentId ||
      task.status !== 'running' ||
      task.queueGeneration !== fence.queueGeneration ||
      task.leaseToken !== fence.leaseToken ||
      !task.lockedUntil ||
      task.lockedUntil.getTime() <= this.store.now().getTime() ||
      !IMPORT_JOBS.has(String(payload?.job ?? '')) ||
      payload?.source !== fence.source
    )
      return null;
    const source = await readSource(tx, this.store, fence.agentId, fence.source);
    if (!source) return null;
    return { task, taskRef: taskSnap.ref, source: source.row, sourceRef: source.ref };
  }

  /** The fence plus a source still linked to this task and not purged. */
  private async readLinked(tx: Transaction, fence: ImportJobFence, statuses: string[]) {
    const current = await this.readFence(tx, fence);
    if (
      !current ||
      current.source.taskId !== fence.taskId ||
      !statuses.includes(current.source.status)
    )
      return null;
    return current;
  }

  async load(fence: ImportJobFence) {
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readFence(tx, fence);
      return current ? { source: current.source, state: current.task.state } : null;
    });
  }

  async claimSnapshotSlot(fence: ImportJobFence, ttlMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000)
      throw new Error('Import snapshot slot lease is outside its bounds');
    return this.store.db.runTransaction(async (tx) => {
      if (!(await this.readLinked(tx, fence, ['pending', 'running', 'failed', 'done'])))
        return false;
      const slotRef = this.store.doc('coordination', 'import-snapshot');
      const slot = await tx.get(slotRef);
      const now = this.store.now();
      const expiresAt = slot.get('expiresAt')?.toDate?.() as Date | undefined;
      if (
        slot.exists &&
        slot.get('taskId') !== fence.taskId &&
        expiresAt &&
        expiresAt.getTime() > now.getTime()
      )
        return false;
      tx.set(slotRef, {
        taskId: fence.taskId,
        expiresAt: new Date(now.getTime() + ttlMs),
        updatedAt: now,
      });
      return true;
    });
  }

  async releaseSnapshotSlot(fence: ImportJobFence): Promise<void> {
    await this.store.db.runTransaction(async (tx) => {
      const slotRef = this.store.doc('coordination', 'import-snapshot');
      const slot = await tx.get(slotRef);
      if (slot.exists && slot.get('taskId') === fence.taskId) tx.delete(slotRef);
    });
  }

  async registerSnapshotAsset(fence: ImportJobFence, workspacePath: string): Promise<boolean> {
    if (!validSnapshotPath(workspacePath, fence.source, fence.taskId))
      throw new Error('Import snapshot path is outside its source and task namespace');
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readLinked(tx, fence, ['pending', 'running']);
      if (!current) return false;
      const id = snapshotAssetId(fence.agentId, current.source.id, workspacePath);
      const ref = this.store.doc('importSnapshotAssets', id);
      const existing = await tx.get(ref);
      if (existing.exists) {
        if (
          existing.get('id') !== id ||
          existing.get('agentId') !== fence.agentId ||
          existing.get('sourceId') !== current.source.id ||
          existing.get('source') !== fence.source ||
          existing.get('taskId') !== fence.taskId ||
          existing.get('workspacePath') !== workspacePath
        )
          throw new Error('Import snapshot asset ownership or identity mismatch');
        return true;
      }
      tx.create(ref, {
        id,
        agentId: fence.agentId,
        sourceId: current.source.id,
        source: fence.source,
        taskId: fence.taskId,
        workspacePath,
        createdAt: this.store.now(),
      });
      return true;
    });
  }

  async begin(
    fence: ImportJobFence,
    input: {
      itemsTotal: number;
      state: unknown;
      parseDiagnostics?: import('@assistant/persistence').ImportArchiveDiagnostics | null;
    } & ImportProgress,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(input.itemsTotal) || input.itemsTotal < 0)
      throw new Error('Import item total is malformed');
    const progress = validProgress(input);
    // Both cursors must parse before they are persisted.
    importCursorFrom(input.state);
    voiceCursorFrom(input.state);
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readLinked(tx, fence, ['pending', 'running', 'failed', 'done']);
      if (!current) return false;
      const now = this.store.now();
      tx.update(
        current.sourceRef,
        encodeRecord({
          status: 'running',
          itemsTotal: input.itemsTotal,
          ...(input.parseDiagnostics !== undefined
            ? { parseDiagnostics: input.parseDiagnostics }
            : {}),
          updatedAt: now,
        }),
      );
      tx.update(
        current.taskRef,
        encodeRecord({ state: input.state, ...progress, reclaimCount: 0, updatedAt: now }),
      );
      return true;
    });
  }

  async resolveSubjects(
    fence: ImportJobFence,
    subjects: Array<{ subject: string; relationship?: string }>,
  ): Promise<Array<string | null>> {
    if (subjects.length === 0) return [];
    if (subjects.length > MAX_WINDOW_FACTS + MAX_WINDOW_OCCASIONS)
      throw new Error('Import subject resolution is outside its bounds');
    const contacts: Records['contacts'][] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let page = this.store
        .collection('contacts')
        .orderBy(FieldPath.documentId())
        .limit(SCAN_PAGE_SIZE);
      if (cursor) page = page.startAfter(cursor);
      const snapshot = await page.get();
      for (const doc of snapshot.docs) {
        const row = decodeRecord<Records['contacts']>(doc.data());
        if (row.id && documentKey(row.id) === doc.id) contacts.push(row);
      }
      if (contacts.length > MAX_OWNER_CARD_CONTACT_SCAN)
        throw new Error('Import contact scan exceeds its explicit limit');
      if (snapshot.size < SCAN_PAGE_SIZE) break;
      cursor = snapshot.docs.at(-1);
    }
    const owner = contacts.find((row) => row.trust === 'owner');
    const resolved: Array<string | null> = [];
    for (const input of subjects) {
      const name = input.subject.trim();
      const lower = name.toLowerCase();
      if (!name || ASSISTANT_ALIASES.has(lower)) {
        resolved.push(null);
        continue;
      }
      const ownerMatch = owner
        ? [owner.name, ...owner.aliases].some((candidate) =>
            namePrefixMatch(lower, candidate.toLowerCase()),
          )
        : false;
      if (lower === 'owner' || ownerMatch) {
        resolved.push(owner?.id ?? null);
        continue;
      }
      const match = contacts
        .filter((row) => row.trust !== 'owner')
        .find((row) =>
          [row.name, ...row.aliases].some((candidate) =>
            namePrefixMatch(lower, candidate.toLowerCase()),
          ),
        );
      if (match) {
        resolved.push(match.id);
        continue;
      }
      // The same name claim the memory tools use, so both writers converge on
      // one contact and a replayed window never creates a second person.
      const keyRef = this.store.doc(
        'contactNames',
        createHash('sha256').update(lower).digest('hex'),
      );
      const created = await this.store.db.runTransaction(async (tx) => {
        if (!(await this.readLinked(tx, fence, ['running']))) return null;
        const existing = await tx.get(keyRef);
        if (existing.exists) return String(existing.get('contactId'));
        const now = this.store.now();
        const id = randomUUID();
        const contact: Records['contacts'] = {
          id,
          name,
          createdAt: now,
          updatedAt: now,
          trust: 'unknown',
          aliases: [],
          emails: [],
          phones: [],
          relationship: input.relationship?.trim() ?? '',
          notes: '',
        };
        tx.create(this.store.doc('contacts', id), encodeRecord(contact));
        tx.create(keyRef, { contactId: id, createdAt: now });
        return { contact };
      });
      if (created === null) throw new Error('import task lease or source link was lost');
      if (typeof created === 'string') resolved.push(created);
      else {
        contacts.push(created.contact);
        resolved.push(created.contact.id);
      }
    }
    return resolved;
  }

  async commitImportWindow(
    fence: ImportJobFence,
    input: {
      windowIndex: number;
      facts: ImportFactWrite[];
      occasions: ImportOccasionWrite[];
      describe: (cursor: ImportRunCursor) => ImportProgress;
    },
  ): Promise<ImportRunCursor | null> {
    if (
      !Number.isSafeInteger(input.windowIndex) ||
      input.windowIndex < 0 ||
      input.facts.length > MAX_WINDOW_FACTS ||
      input.occasions.length > MAX_WINDOW_OCCASIONS
    )
      throw new Error('Import window is outside its persistence bounds');
    for (const fact of input.facts) {
      validateEmbedding(this.embeddingSpace, fact.embedding);
      if (fact.embeddingSpaceKey !== embeddingSpaceKey(this.embeddingSpace))
        throw new Error('Import embedding space changed');
      if (
        !fact.content ||
        fact.contentHash !== createHash('sha256').update(fact.content).digest('hex') ||
        !Number.isInteger(fact.importance) ||
        fact.importance < 1 ||
        fact.importance > 5 ||
        !/^(0|1)\.\d{2}$/.test(fact.confidence) ||
        (fact.validFrom && !Number.isFinite(fact.validFrom.getTime())) ||
        !Array.isArray(fact.sourceUnitProvenance) ||
        fact.sourceUnitProvenance.length > 512 ||
        fact.sourceUnitProvenance.some(
          (unit) =>
            !Number.isSafeInteger(unit.sourceOffset) ||
            unit.sourceOffset < 0 ||
            !Number.isSafeInteger(unit.unitOffset) ||
            unit.unitOffset < 0 ||
            typeof unit.hasQuotedContent !== 'boolean' ||
            !/^[a-f0-9]{64}$/.test(unit.unitTextHash) ||
            typeof unit.header !== 'string' ||
            (unit.authorEmail !== null && typeof unit.authorEmail !== 'string') ||
            (unit.observedAt !== null &&
              (typeof unit.observedAt !== 'string' ||
                !Number.isFinite(Date.parse(unit.observedAt)))),
        )
      )
        throw new Error('Import fact is malformed');
    }
    for (const occasion of input.occasions) {
      if (
        !occasion.contactId ||
        !['birthday', 'anniversary', 'custom'].includes(occasion.kind) ||
        !Number.isInteger(occasion.month) ||
        occasion.month < 1 ||
        occasion.month > 12 ||
        !Number.isInteger(occasion.day) ||
        occasion.day < 1 ||
        occasion.day > 31
      )
        throw new Error('Import occasion is malformed');
    }
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readLinked(tx, fence, ['running']);
      if (!current) return null;
      const cursor = importCursorFrom(current.task.state);
      if (cursor.windowIndex !== input.windowIndex) return null;

      const contactIds = [
        ...new Set([
          ...input.facts.flatMap((fact) => (fact.subjectContactId ? [fact.subjectContactId] : [])),
          ...input.occasions.map((occasion) => occasion.contactId),
        ]),
      ];
      const factRefs = input.facts.flatMap((fact) => [
        this.store.doc('memoryContentHashes', fact.contentHash),
        this.store.doc('memoryTombstones', fact.contentHash),
      ]);
      const contactRefs = contactIds.map((id) => this.store.doc('contacts', id));
      const reads = [...factRefs, ...contactRefs];
      const snapshots = reads.length ? await tx.getAll(...reads) : [];
      const factSnaps = snapshots.slice(0, factRefs.length);
      const liveContacts = new Set(
        snapshots
          .slice(factRefs.length)
          .filter((snapshot, index) => snapshot.exists && snapshot.get('id') === contactIds[index])
          .map((snapshot) => String(snapshot.get('id'))),
      );
      const occasionResolutions = [];
      for (const occasion of input.occasions)
        occasionResolutions.push(
          await resolveOccasionIdentity(tx, this.store, fence.agentId, occasion),
        );

      const now = this.store.now();
      const memoryIdByHash = new Map<string, string>();
      const seenHashes = new Set<string>();
      const plans = input.facts.map((fact, index) => {
        const [hash, tombstone] = factSnaps.slice(index * 2, index * 2 + 2);
        if (tombstone?.exists) return { fact, memoryId: null, create: false, tombstoned: true };
        const existingId = hash?.exists
          ? hash.get('memoryId')
          : memoryIdByHash.get(fact.contentHash);
        if (hash?.exists && (typeof existingId !== 'string' || !existingId))
          throw new Error('Import content hash points to a malformed memory identity');
        const memoryId = typeof existingId === 'string' ? existingId : randomUUID();
        const alreadySeen = seenHashes.has(fact.contentHash);
        seenHashes.add(fact.contentHash);
        memoryIdByHash.set(fact.contentHash, memoryId);
        return { fact, memoryId, create: !hash?.exists && !alreadySeen, tombstoned: false };
      });

      const lineagePlans = new Map<
        string,
        {
          id: string;
          memoryId: string;
          ref: DocumentReference;
          units: ImportFactWrite['sourceUnitProvenance'];
        }
      >();
      for (const plan of plans) {
        if (!plan.memoryId || plan.tombstoned) continue;
        const id = createHash('sha256')
          .update(JSON.stringify([fence.source, plan.memoryId]))
          .digest('hex');
        const current = lineagePlans.get(id);
        const units = plan.fact.sourceUnitProvenance ?? [];
        lineagePlans.set(id, {
          id,
          memoryId: plan.memoryId,
          ref: this.store.doc('memoryImportLineage', id),
          units: mergeImportUnitProvenance(current?.units ?? [], units),
        });
      }
      const lineageEntries = [...lineagePlans.values()];
      const lineageSnapshots = lineageEntries.length
        ? await tx.getAll(...lineageEntries.map((entry) => entry.ref))
        : [];

      for (const plan of plans) {
        const { fact, memoryId } = plan;
        if (plan.tombstoned) {
          cursor.tombstoned += 1;
          continue;
        }
        if (!memoryId) continue;
        if (!plan.create) {
          cursor.duplicates += 1;
          continue;
        }
        tx.create(
          this.store.doc('memories', memoryId),
          memoryDocument(this.embeddingSpace, {
            id: memoryId,
            createdAt: now,
            agentId: fence.agentId,
            expiresAt: null,
            embedding: fact.embedding,
            embeddingSpaceKey: fact.embeddingSpaceKey,
            sourceTaskId: fence.taskId,
            kind: fact.kind,
            confidence: fact.confidence,
            contentHash: fact.contentHash,
            goalId: null,
            originTrust: 'owner',
            category: 'knowledge',
            content: fact.content,
            importance: fact.importance,
            quarantined: fact.quarantined,
            subjectContactId:
              fact.subjectContactId && liveContacts.has(fact.subjectContactId)
                ? fact.subjectContactId
                : null,
            domain: fact.domain,
            validFrom: fact.validFrom,
            validUntil: null,
            supersededById: null,
            ownerConfirmed: false,
            pinned: false,
            source: fence.source,
            lastAccessedAt: null,
            lastConsolidatedAt: null,
          }),
        );
        tx.create(this.store.doc('memoryContentHashes', fact.contentHash), { memoryId });
        cursor.saved += 1;
        if (fact.quarantined) cursor.quarantined += 1;
      }
      lineageEntries.forEach((entry, index) => {
        const existing = lineageSnapshots[index];
        // Keep the first persisted source window. Repeated facts in later
        // windows do not grow one Firestore document without bound.
        if (existing?.exists) return;
        const value = encodeRecord({
          agentId: fence.agentId,
          source: fence.source,
          memoryId: entry.memoryId,
          sourceUnitProvenance: entry.units,
          createdAt: now,
        });
        tx.create(entry.ref, value);
      });

      const upserted = new Set<string>();
      for (let index = 0; index < input.occasions.length; index++) {
        const occasion = input.occasions[index];
        const resolved = occasionResolutions[index];
        const existing = resolved?.snapshot;
        if (
          !occasion ||
          !resolved ||
          resolved.ambiguous ||
          resolved.superseded ||
          !liveContacts.has(occasion.contactId)
        )
          continue;
        if (upserted.has(resolved.markerRef.id)) continue;
        upserted.add(resolved.markerRef.id);
        const notes = occasion.notes.trim().slice(0, 2000);
        if (existing?.exists) {
          // Fill a previously unknown year and append genuinely new notes;
          // never downgrade trust or re-quarantine a reviewed occasion.
          const row = decodeRecord<Records['occasions']>(existing.data());
          if (row.agentId !== fence.agentId || row.contactId !== occasion.contactId)
            throw new Error('Existing import occasion is malformed');
          tx.update(
            existing.ref,
            encodeRecord({
              year: row.year ?? occasion.year,
              notes:
                row.notes === ''
                  ? notes
                  : notes === '' || row.notes.includes(notes)
                    ? row.notes
                    : `${row.notes}; ${notes}`,
              updatedAt: now,
            }),
          );
          if (!resolved.markerExists)
            tx.create(resolved.markerRef, occasionDateKey(fence.agentId, occasion, String(row.id)));
          continue;
        }
        const id = randomUUID();
        const createRef = this.store.doc('occasions', id);
        const row: Records['occasions'] = {
          id,
          agentId: fence.agentId,
          contactId: occasion.contactId,
          kind: occasion.kind,
          label: occasion.label.slice(0, 120),
          month: occasion.month,
          day: occasion.day,
          year: occasion.year,
          recurrence: 'annual',
          leadDays: 7,
          notes,
          originTrust: 'owner',
          quarantined: occasion.quarantined,
          ownerConfirmed: false,
          source: fence.source,
          createdAt: now,
          updatedAt: now,
        };
        tx.create(createRef, encodeRecord(row));
        tx.create(resolved.markerRef, occasionDateKey(fence.agentId, occasion, id));
        cursor.occasionsSaved += 1;
      }

      cursor.windowIndex += 1;
      const progress = validProgress(input.describe(cursor));
      tx.update(
        current.taskRef,
        encodeRecord({
          state: stateWith(current.task.state, 'import', cursor),
          ...progress,
          // Each committed window is proof of progress; see checkpointTask.
          reclaimCount: 0,
          updatedAt: now,
        }),
      );
      tx.update(
        current.sourceRef,
        encodeRecord({
          itemsProcessed: cursor.windowIndex,
          memoriesSaved: cursor.saved,
          memoriesQuarantined: cursor.quarantined,
          updatedAt: now,
        }),
      );
      return cursor;
    });
  }

  async ownerIdentity(
    fence: ImportJobFence,
  ): Promise<{ emails: string[]; names: string[] } | null> {
    return this.store.db.runTransaction(async (tx) => {
      if (!(await this.readLinked(tx, fence, ['pending', 'running', 'failed', 'done'])))
        return null;
      const owners = await tx.get(
        this.store.collection('contacts').where('trust', '==', 'owner').limit(1),
      );
      const owner = owners.docs[0]
        ? decodeRecord<Records['contacts']>(owners.docs[0].data())
        : null;
      return {
        emails: owner?.emails ?? [],
        names: [owner?.name ?? '', ...(owner?.aliases ?? [])].filter(Boolean),
      };
    });
  }

  async existingSampleTexts(
    fence: ImportJobFence,
    texts: string[],
    exactSpaceKey: string,
  ): Promise<Set<string>> {
    if (fence.agentId !== this.configuredAgentId)
      throw new Error('Writing samples are outside the configured owner');
    const wanted = new Set(texts);
    const found = new Set<string>();
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let page = this.store
        .collection('writingSamples')
        .where('agentId', '==', fence.agentId)
        .orderBy(FieldPath.documentId())
        .select('text')
        .limit(SCAN_PAGE_SIZE) as Query;
      if (cursor) page = page.startAfter(cursor);
      const snapshot = await page.get();
      scanned += snapshot.size;
      if (scanned > MAX_WRITING_SAMPLE_SCAN)
        throw new Error('Writing sample scan exceeds its explicit limit');
      for (const doc of snapshot.docs) {
        const text = doc.get('text');
        const storedSpace = doc.get('embeddingSpaceKey') ?? doc.get('embeddingSpace');
        if (typeof text === 'string' && wanted.has(text) && storedSpace === exactSpaceKey)
          found.add(text);
      }
      if (snapshot.size < SCAN_PAGE_SIZE) return found;
      cursor = snapshot.docs.at(-1);
    }
  }

  async commitVoiceBatch(
    fence: ImportJobFence,
    input: {
      index: number;
      nextIndex: number;
      register: string;
      context: string;
      samples: VoiceSampleWrite[];
      duplicates: number;
      describe: (cursor: VoiceIngestCursor) => ImportProgress;
    },
  ): Promise<VoiceIngestCursor | null> {
    if (
      !Number.isSafeInteger(input.index) ||
      input.index < 0 ||
      !Number.isSafeInteger(input.nextIndex) ||
      input.nextIndex < input.index ||
      input.nextIndex - input.index > MAX_VOICE_BATCH ||
      input.samples.length > input.nextIndex - input.index ||
      !Number.isSafeInteger(input.duplicates) ||
      input.duplicates < 0 ||
      !VOICE_REGISTERS.has(input.register) ||
      !input.context
    )
      throw new Error('Voice sample batch is outside its persistence bounds');
    for (const sample of input.samples) {
      if (!sample.text) throw new Error('Voice sample is malformed');
      validateEmbedding(this.embeddingSpace, sample.embedding);
    }
    const expectedSpaceKey = embeddingSpaceKey(this.embeddingSpace);
    if (input.samples.some((sample) => sample.embeddingSpaceKey !== expectedSpaceKey))
      throw new Error('Voice sample batch embedding space does not match the configured space');
    const ids = input.samples.map((sample) =>
      writingSampleId(fence.agentId, sample.text, sample.embeddingSpaceKey),
    );
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readLinked(tx, fence, ['running']);
      if (!current) return null;
      const cursor = voiceCursorFrom(current.task.state);
      if (
        cursor.index !== input.index ||
        (cursor.embeddingSpaceKey && cursor.embeddingSpaceKey !== expectedSpaceKey) ||
        (cursor.index > 0 && cursor.embeddingSpaceKey !== expectedSpaceKey)
      )
        return null;
      const refs = ids.map((id) => this.store.doc('writingSamples', id));
      const existing = refs.length ? await tx.getAll(...refs) : [];
      const now = this.store.now();
      cursor.duplicates += input.duplicates;
      const written = new Set<string>();
      for (let index = 0; index < input.samples.length; index++) {
        const sample = input.samples[index];
        const ref = refs[index];
        const id = ids[index];
        if (!sample || !ref || !id) continue;
        if (existing[index]?.exists || written.has(id)) {
          cursor.duplicates += 1;
          continue;
        }
        written.add(id);
        tx.create(
          ref,
          encodeRecord({
            id,
            agentId: fence.agentId,
            register: input.register,
            text: sample.text,
            context: input.context,
            embedding: FieldValue.vector(sample.embedding),
            embeddingSpaceKey: expectedSpaceKey,
            embeddingSpace: embeddingSpaceKey(this.embeddingSpace),
            createdAt: now,
          }),
        );
        cursor.saved += 1;
      }
      cursor.index = input.nextIndex;
      const progress = validProgress(input.describe(cursor));
      tx.update(
        current.taskRef,
        encodeRecord({
          state: stateWith(current.task.state, 'voiceIngest', cursor),
          ...progress,
          reclaimCount: 0,
          updatedAt: now,
        }),
      );
      tx.update(
        current.sourceRef,
        encodeRecord({ itemsProcessed: cursor.index, memoriesSaved: cursor.saved, updatedAt: now }),
      );
      return cursor;
    });
  }

  async finish(
    fence: ImportJobFence,
    input: { status: 'done' | 'failed'; error: string | null },
  ): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const current = await this.readLinked(tx, fence, ['running']);
      if (!current) return false;
      tx.update(
        current.sourceRef,
        encodeRecord({
          status: input.status,
          error: input.error ? input.error.slice(0, 2000) : null,
          updatedAt: this.store.now(),
        }),
      );
      return true;
    });
  }
}

type MemoryPageMode = 'purge' | 'reject' | 'approve';

/**
 * Owner import-source commands. A source's memories are removed in bounded
 * pages after the source itself stops accepting writes, so a crashed purge is
 * resumed by running it again rather than leaving half a source recallable.
 */
export class FirestoreImportCommandRepository implements ImportCommandRepository {
  readonly kind = 'import-command-repository' as const;
  private readonly maintenance: FirestoreProfileMemoryMaintenance;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {
    this.maintenance = new FirestoreProfileMemoryMaintenance(store);
  }

  async start(input: ImportStartInput): Promise<{ sourceId: string; taskId: string }> {
    const agentId = this.configuredAgentId;
    if (!agentId) throw new Error('Imports require a configured owner');
    if (!SOURCE_TAG.test(input.source))
      throw new Error('source tag must be 2-80 chars of letters/digits/._-');
    if (
      !validSourceUploadPath(input.workspacePath) ||
      !['mbox', 'json', 'text'].includes(input.kind)
    )
      throw new Error('Import source file is invalid');
    if (!IMPORT_JOBS.has(input.job)) throw new Error('Unknown import job');
    const label = input.job === 'voice.ingest' ? 'voice import' : 'import';
    const claimRef = this.store.doc('importSourceKeys', sourceKeyId(agentId, input.source));
    const taskId = randomUUID();
    const newSourceId = randomUUID();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.store.db.runTransaction(async (tx) => {
          await readConfiguredOwner(tx, this.store, agentId);
          const deletion = await tx.get(
            this.store.doc('importSourceDeletionJobs', deletionJobId(agentId, input.source)),
          );
          let completedDeletionRef: DocumentReference | null = null;
          if (deletion.exists) {
            if (deletion.get('status') !== 'complete')
              throw new Error(`import "${input.source}" is still being removed`);
            completedDeletionRef = deletion.ref;
          }
          const existing = await readSource(tx, this.store, agentId, input.source);
          if (existing?.row.status === 'running' || existing?.row.status === 'pending')
            throw new Error(`${label} "${input.source}" is already ${existing.row.status}`);
          // Firestore transactions require every read to finish before the first write.
          // Keep the completed retirement receipt until source and claim validation is done.
          if (completedDeletionRef) tx.delete(completedDeletionRef);
          const now = this.store.now();
          const task = newTaskRecord(
            {
              agentId,
              type: 'adhoc',
              trust: 'owner',
              trigger: {
                source: 'internal',
                agentId,
                trust: 'owner',
                payload: {
                  ...input.payload,
                  job: input.job,
                  source: input.source,
                  path: input.workspacePath,
                  kind: input.kind,
                },
              },
              budgetUsdLimit: input.budgetUsdLimit,
            },
            taskId,
            now,
          );
          tx.create(this.store.doc('tasks', task.id), encodeRecord(task));
          createWakeIntent(tx, this.store, {
            taskId: task.id,
            generation: task.queueGeneration,
            availableAt: task.runAfter ?? now,
          });
          if (existing) {
            tx.update(
              existing.ref,
              encodeRecord({
                workspacePath: input.workspacePath,
                kind: input.kind,
                status: 'pending',
                taskId: task.id,
                itemsProcessed: 0,
                memoriesSaved: 0,
                memoriesQuarantined: 0,
                parseDiagnostics: null,
                error: null,
                updatedAt: now,
              }),
            );
            if (!existing.claimed)
              tx.create(claimRef, {
                agentId,
                source: input.source,
                sourceId: existing.row.id,
              });
            return { sourceId: existing.row.id, taskId: task.id };
          }
          const row: ImportSource = {
            id: newSourceId,
            createdAt: now,
            updatedAt: now,
            agentId,
            status: 'pending',
            taskId: task.id,
            kind: input.kind,
            error: null,
            source: input.source,
            workspacePath: input.workspacePath,
            itemsTotal: null,
            itemsProcessed: 0,
            memoriesSaved: 0,
            memoriesQuarantined: 0,
            parseDiagnostics: null,
          };
          tx.create(this.store.doc('importSources', row.id), encodeRecord(row));
          tx.create(claimRef, { agentId, source: input.source, sourceId: row.id });
          return { sourceId: row.id, taskId: task.id };
        });
      } catch (error) {
        if (!isEmulatorClosedTransaction(error) || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }

  /**
   * Apply one page of `mode` to the source's memories. Purged memories are
   * deleted without a tombstone (a re-run may learn them again); rejected ones
   * are tombstoned. Either way a graph deletion intent fences the graph writer.
   */
  private async memoryPage(
    agentId: string,
    source: string,
    mode: MemoryPageMode,
    deletionJob?: { id: string; sourceHash: string },
  ): Promise<string[]> {
    return this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      let query = this.store.collection('memories').where('source', '==', source) as Query;
      if (mode !== 'purge') query = query.where('quarantined', '==', true);
      const [page, lineagePage] = await Promise.all([
        tx.get(query.limit(Math.floor(PAGE_SIZE / 4))),
        tx.get(
          this.store
            .collection('memoryImportLineage')
            .where('source', '==', source)
            .limit(Math.floor(PAGE_SIZE / 4)),
        ),
      ]);
      const lineageRows = lineagePage.docs.map((doc) => {
        const memoryId = doc.get('memoryId');
        if (
          doc.get('agentId') !== agentId ||
          doc.get('source') !== source ||
          typeof memoryId !== 'string' ||
          doc.id !== documentKey(importLineageId(source, memoryId))
        )
          throw new Error('Import memory lineage identity mismatch');
        return { doc, memoryId };
      });
      const linked = lineageRows.length
        ? await tx.getAll(
            ...lineageRows.map(({ memoryId }) => this.store.doc('memories', memoryId)),
          )
        : [];
      const candidates = new Map<string, QueryDocumentSnapshot>();
      for (const doc of page.docs) candidates.set(doc.id, doc);
      for (let index = 0; index < lineageRows.length; index++) {
        const lineage = lineageRows[index];
        const doc = linked[index];
        if (!lineage || !doc?.exists || doc.get('id') !== lineage.memoryId)
          throw new Error('Import memory lineage points to a missing or malformed memory');
        if (doc.get('agentId') !== agentId)
          throw new Error('Import memory lineage points to another agent');
        if (mode !== 'purge' && doc.get('quarantined') !== true) continue;
        candidates.set(doc.id, doc as QueryDocumentSnapshot);
      }
      if (candidates.size === 0) return [];
      const deletionRef = deletionJob
        ? this.store.doc('importSourceDeletionJobs', deletionJob.id)
        : null;
      const deletion = deletionRef ? await tx.get(deletionRef) : null;
      if (
        deletionJob &&
        (!deletion?.exists ||
          deletion.get('agentId') !== agentId ||
          deletion.get('sourceHash') !== deletionJob.sourceHash ||
          deletion.get('status') === 'complete')
      )
        throw new Error('Import deletion fence is missing or belongs to another source');
      const rows = [...candidates.values()].map((doc) => {
        const decoded = decodeRecord<unknown>(doc.data());
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
          throw new Error('Import memory ownership or identity mismatch');
        const row = decoded as Record<string, unknown>;
        const id = row.id;
        const rowAgentId = row.agentId;
        const rowSource = row.source;
        const contentHash = row.contentHash;
        const supersededById = row.supersededById;
        if (typeof id !== 'string' || documentKey(id) !== doc.id)
          throw new Error('Import memory ownership or identity mismatch');
        if (rowAgentId !== agentId)
          throw new Error('Import source memory belongs to another agent');
        if (
          (rowSource !== source && !lineageRows.some((entry) => entry.memoryId === id)) ||
          typeof contentHash !== 'string' ||
          !contentHash
        )
          throw new Error('Import memory ownership or identity mismatch');
        return {
          doc,
          row: {
            id,
            contentHash,
            supersededById: typeof supersededById === 'string' ? supersededById : null,
          },
        };
      });
      const now = this.store.now();
      if (mode === 'approve') {
        for (const { doc } of rows) tx.update(doc.ref, { quarantined: false });
        invalidateOwnerCard(tx, this.store, agentId, now);
        return rows.map(({ row }) => row.id);
      }
      const related = await tx.getAll(
        ...rows.flatMap(({ row }) => [
          this.store.doc('memoryContentHashes', row.contentHash),
          this.store.doc('memoryTombstones', row.contentHash),
          this.store.doc('memoryImportLineage', importLineageId(source, row.id)),
        ]),
      );
      const currentIds = new Set(rows.map(({ row }) => row.id));
      const successorIds = [
        ...new Set(
          rows
            .map(({ row }) => row.supersededById)
            .filter((id): id is string => typeof id === 'string')
            .filter((id) => !currentIds.has(id)),
        ),
      ];
      const successorDocs = successorIds.length
        ? await tx.getAll(...successorIds.map((id) => this.store.doc('memories', id)))
        : [];
      const successorLineageRefs = successorIds.map((id) =>
        this.store.doc('memoryImportLineage', importLineageId(source, id)),
      );
      const successorLineages = successorLineageRefs.length
        ? await tx.getAll(...successorLineageRefs)
        : [];
      const predecessorMap = new Map<string, QueryDocumentSnapshot>();
      const deletedBatch = rows.map(({ row }) => row.id);
      for (let offset = 0; offset < deletedBatch.length; offset += 30) {
        const page = await tx.get(
          this.store
            .collection('memories')
            .where('supersededById', 'in', deletedBatch.slice(offset, offset + 30))
            .limit(PAGE_SIZE),
        );
        for (const doc of page.docs)
          if (doc.get('agentId') === agentId && !currentIds.has(doc.id))
            predecessorMap.set(doc.id, doc);
      }
      const predecessors = [...predecessorMap.values()];
      const predecessorLineages = predecessors.length
        ? await tx.getAll(
            ...predecessors.map(({ id }) =>
              this.store.doc('memoryImportLineage', importLineageId(source, id)),
            ),
          )
        : [];
      const reason = mode === 'purge' ? 'import_purge' : 'quarantine_reject';
      for (let index = 0; index < rows.length; index++) {
        const entry = rows[index];
        if (!entry) continue;
        const [hash, tombstone, lineage] = related.slice(index * 3, index * 3 + 3);
        if (
          lineage?.exists &&
          (lineage.get('source') !== source || lineage.get('memoryId') !== entry.row.id)
        )
          throw new Error('Import memory lineage identity mismatch');
        if (hash?.exists && hash.get('memoryId') === entry.row.id) tx.delete(hash.ref);
        if (lineage?.exists) tx.delete(lineage.ref);
        if (mode === 'reject' && !tombstone?.exists)
          tx.create(
            this.store.doc('memoryTombstones', entry.row.contentHash),
            encodeRecord({
              id: entry.row.contentHash,
              contentHash: entry.row.contentHash,
              reason,
              createdAt: now,
            }),
          );
        tx.set(
          this.store.doc('graphDeletionIntents', entry.row.id),
          encodeRecord({
            memoryId: entry.row.id,
            agentId,
            contentHash: entry.row.contentHash,
            reason,
            source,
            createdAt: now,
            cleanupCompletedAt: null,
          }),
        );
        tx.delete(entry.doc.ref);
      }
      for (let index = 0; index < successorIds.length; index++) {
        const id = successorIds[index];
        const successor = successorDocs[index];
        const lineage = successorLineages[index];
        const lineageRef = successorLineageRefs[index];
        if (!id || !successor?.exists || !lineageRef || successor.get('agentId') !== agentId)
          continue;
        if (lineage?.exists && (lineage.get('source') !== source || lineage.get('memoryId') !== id))
          throw new Error('Import descendant lineage conflicts with its identity');
        if (!lineage?.exists)
          tx.create(
            lineageRef,
            encodeRecord({
              agentId,
              source,
              memoryId: id,
              sourceUnitProvenance: [],
              createdAt: now,
            }),
          );
      }
      for (let index = 0; index < predecessors.length; index++) {
        const predecessor = predecessors[index];
        const lineage = predecessorLineages[index];
        if (!predecessor || !lineage) continue;
        if (
          lineage.exists &&
          (lineage.get('source') !== source || lineage.get('memoryId') !== predecessor.id)
        )
          throw new Error('Import predecessor lineage conflicts with its identity');
        if (predecessor.get('source') !== source && !lineage.exists)
          tx.update(predecessor.ref, { supersededById: null, expiresAt: null });
      }
      if (deletionRef && deletion?.exists)
        tx.update(deletionRef, {
          purgedMemories: nonNegativeInteger(deletion.get('purgedMemories')) + rows.length,
          updatedAt: this.store.now(),
        });
      invalidateOwnerCard(tx, this.store, agentId, now);
      return rows.map(({ row }) => row.id);
    });
  }

  private async applyToSourceMemories(
    agentId: string,
    source: string,
    mode: MemoryPageMode,
    deletionJob?: { id: string; sourceHash: string },
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const ids = await this.memoryPage(agentId, source, mode, deletionJob);
      if (ids.length === 0) break;
      total += ids.length;
      if (total > MAX_SOURCE_MEMORIES)
        throw new Error('Import source memory count exceeds its explicit limit');
    }
    if (mode !== 'approve') await this.cleanupGraph(agentId, source);
    return total;
  }

  /** Delete direct and explicitly derived occasions for one source in bounded, retryable pages. */
  private async occasionPage(
    agentId: string,
    source: string,
    deletionJob?: { id: string; sourceHash: string },
  ): Promise<number> {
    return this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      const [direct, lineagePage] = await Promise.all([
        tx.get(this.store.collection('occasions').where('source', '==', source).limit(PAGE_SIZE)),
        tx.get(
          this.store
            .collection('occasionImportLineage')
            .where('source', '==', source)
            .limit(Math.floor(PAGE_SIZE / 2)),
        ),
      ]);
      const lineageRows = lineagePage.docs.map((doc) => {
        const occasionId = doc.get('occasionId');
        if (
          doc.get('agentId') !== agentId ||
          doc.get('source') !== source ||
          typeof occasionId !== 'string' ||
          doc.id !== documentKey(occasionImportLineageId(source, occasionId))
        )
          throw new Error('Import occasion lineage identity mismatch');
        return { doc, occasionId };
      });
      const linked = lineageRows.length
        ? await tx.getAll(
            ...lineageRows.map(({ occasionId }) => this.store.doc('occasions', occasionId)),
          )
        : [];
      const entries = new Map<
        string,
        { doc: QueryDocumentSnapshot; lineage?: QueryDocumentSnapshot }
      >();
      for (const doc of direct.docs) {
        if (doc.get('agentId') !== agentId)
          throw new Error('Import source occasion belongs to another agent');
        entries.set(doc.id, { doc });
      }
      const staleLineage: QueryDocumentSnapshot[] = [];
      for (let index = 0; index < lineageRows.length; index++) {
        const lineage = lineageRows[index];
        const occasion = linked[index];
        if (!lineage || !occasion) continue;
        if (!occasion.exists) {
          staleLineage.push(lineage.doc);
          continue;
        }
        if (occasion.get('id') !== lineage.occasionId || occasion.get('agentId') !== agentId)
          continue; // Never let a malformed or foreign lineage erase another owner's record.
        const existing = entries.get(occasion.id);
        entries.set(occasion.id, {
          doc: (existing?.doc ?? occasion) as QueryDocumentSnapshot,
          lineage: lineage.doc,
        });
      }
      const deletionRef = deletionJob
        ? this.store.doc('importSourceDeletionJobs', deletionJob.id)
        : null;
      const deletion = deletionRef ? await tx.get(deletionRef) : null;
      if (
        deletionJob &&
        (!deletion?.exists ||
          deletion.get('agentId') !== agentId ||
          deletion.get('sourceHash') !== deletionJob.sourceHash ||
          deletion.get('status') === 'complete')
      )
        throw new Error('Import deletion fence is missing or belongs to another source');
      const rows = [...entries.values()];
      const markerSnapshots = rows.length
        ? await tx.getAll(
            ...rows.map(({ doc }) => {
              const data = doc.data();
              return occasionDateKeyRef(this.store, agentId, {
                contactId: String(data.contactId ?? ''),
                kind: data.kind as Records['occasions']['kind'],
                month: Number(data.month),
                day: Number(data.day),
              });
            }),
          )
        : [];
      for (let index = 0; index < rows.length; index++) {
        const entry = rows[index];
        const marker = markerSnapshots[index];
        if (!entry) continue;
        const data = entry.doc.data();
        const id = data.id;
        if (
          typeof id !== 'string' ||
          documentKey(id) !== entry.doc.id ||
          data.agentId !== agentId ||
          (data.source !== source && !entry.lineage)
        )
          throw new Error('Import occasion ownership or identity mismatch');
        if (marker?.exists) {
          if (
            marker.get('agentId') !== agentId ||
            marker.get('id') !==
              occasionDateKeyId(agentId, {
                contactId: String(data.contactId ?? ''),
                kind: data.kind as Records['occasions']['kind'],
                month: Number(data.month),
                day: Number(data.day),
              }) ||
            documentKey(String(marker.get('id') ?? '')) !== marker.id ||
            typeof marker.get('occasionId') !== 'string' ||
            marker.get('contactId') !== data.contactId ||
            marker.get('kind') !== data.kind ||
            marker.get('month') !== data.month ||
            marker.get('day') !== data.day
          )
            throw new Error('Import occasion date marker is malformed');
          if (marker.get('occasionId') === id) tx.delete(marker.ref);
        }
        tx.delete(entry.doc.ref);
        if (entry.lineage) tx.delete(entry.lineage.ref);
      }
      for (const doc of staleLineage) tx.delete(doc.ref);
      return rows.length + staleLineage.length;
    });
  }

  private async applyToSourceOccasions(
    agentId: string,
    source: string,
    deletionJob?: { id: string; sourceHash: string },
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const count = await this.occasionPage(agentId, source, deletionJob);
      if (!count) return total;
      total += count;
      if (total > MAX_SOURCE_MEMORIES)
        throw new Error('Import source occasion count exceeds its explicit limit');
    }
  }

  /**
   * Remove graph facts sourced from this import's deleted memories. Intents a
   * crashed earlier purge left behind are finished here as well.
   */
  private async cleanupGraph(agentId: string, source: string): Promise<void> {
    let cleaned = 0;
    for (;;) {
      const pending = await this.store
        .collection('graphDeletionIntents')
        .where('agentId', '==', agentId)
        .where('source', '==', source)
        .where('cleanupCompletedAt', '==', null)
        .limit(PAGE_SIZE)
        .get();
      if (pending.empty) return;
      for (const intent of pending.docs) {
        const memoryId = intent.get('memoryId');
        if (typeof memoryId !== 'string' || documentKey(memoryId) !== intent.id)
          throw new Error('Import graph deletion intent is malformed');
        await this.maintenance.removeOrphanedGraphEntities({ agentId, memoryId });
      }
      cleaned += pending.size;
      if (cleaned > MAX_SOURCE_MEMORIES)
        throw new Error('Import graph cleanup exceeds its explicit limit');
    }
  }

  async purge(source: string): Promise<{ agentId: string; purged: number }> {
    if (!SOURCE_TAG.test(source)) throw new Error('Import source tag is malformed');
    const agentId = this.configuredAgentId;
    const id = deletionJobId(agentId, source);
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const jobRef = this.store.doc('importSourceDeletionJobs', id);
    const initial = await this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      const existing = await readSource(tx, this.store, agentId, source);
      const job = await tx.get(jobRef);
      if (job.exists) {
        if (
          job.get('id') !== id ||
          job.get('agentId') !== agentId ||
          job.get('sourceHash') !== sourceHash ||
          job.get('sourceId') !== existing?.row.id
        )
          throw new Error('Import purge receipt ownership or identity mismatch');
        if (job.get('mode') !== 'purge')
          throw new Error('Import source deletion is already in progress or complete');
        if (existing?.row.status !== 'purged')
          throw new Error('Import purge source fence is unavailable');
        return {
          sourceId: existing.row.id,
          complete: job.get('status') === 'complete',
          purged: nonNegativeInteger(job.get('purgedMemories')),
        };
      }
      if (!existing) throw new Error(`unknown import source: ${source}`);
      if (!validSourceUploadPath(existing.row.workspacePath))
        throw new Error('Import source workspace path is outside the import directory');
      const taskSnap = existing.row.taskId
        ? await tx.get(this.store.doc('tasks', existing.row.taskId))
        : null;
      const now = this.store.now();
      if (taskSnap?.exists) {
        if (taskSnap.get('agentId') !== agentId || taskSnap.get('id') !== existing.row.taskId)
          throw new Error('Import task belongs to another agent');
        if (ACTIVE_TASK_STATUSES.includes(String(taskSnap.get('status'))))
          tx.update(taskSnap.ref, {
            status: 'cancelled',
            lockedUntil: null,
            runAfter: null,
            leaseToken: null,
            updatedAt: now,
          });
      }
      tx.update(
        existing.ref,
        encodeRecord({
          status: 'purged',
          memoriesSaved: 0,
          memoriesQuarantined: 0,
          updatedAt: now,
        }),
      );
      tx.create(jobRef, {
        id,
        agentId,
        sourceHash,
        sourceId: existing.row.id,
        sourceTaskId: existing.row.taskId,
        sourceWorkspacePath: existing.row.workspacePath,
        mode: 'purge',
        purgedMemories: 0,
        status: 'purging',
        createdAt: now,
        updatedAt: now,
      });
      return { sourceId: existing.row.id, complete: false, purged: 0 };
    });
    if (initial.complete) return { agentId, purged: initial.purged };

    await this.applyToSourceMemories(agentId, source, 'purge', { id, sourceHash });
    await this.applyToSourceOccasions(agentId, source, { id, sourceHash });
    const purged = await this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      const [job, sourceRow, sourceMemory, sourceLineage, sourceOccasion, occasionLineage] =
        await Promise.all([
          tx.get(jobRef),
          readSource(tx, this.store, agentId, source),
          tx.get(this.store.collection('memories').where('source', '==', source).limit(1)),
          tx.get(
            this.store.collection('memoryImportLineage').where('source', '==', source).limit(1),
          ),
          tx.get(this.store.collection('occasions').where('source', '==', source).limit(1)),
          tx.get(
            this.store.collection('occasionImportLineage').where('source', '==', source).limit(1),
          ),
        ]);
      if (
        !job.exists ||
        job.get('agentId') !== agentId ||
        job.get('sourceHash') !== sourceHash ||
        job.get('sourceId') !== initial.sourceId ||
        job.get('mode') !== 'purge' ||
        job.get('status') !== 'purging' ||
        !sourceRow ||
        sourceRow.row.id !== initial.sourceId ||
        sourceRow.row.status !== 'purged'
      )
        throw new Error('Import purge receipt or source fence changed');
      if (
        !sourceMemory.empty ||
        !sourceLineage.empty ||
        !sourceOccasion.empty ||
        !occasionLineage.empty
      )
        throw new Error('Import purge has remaining source projections');
      const pendingGraphCleanup = await tx.get(
        this.store
          .collection('graphDeletionIntents')
          .where('agentId', '==', agentId)
          .where('source', '==', source)
          .where('cleanupCompletedAt', '==', null)
          .limit(1),
      );
      if (!pendingGraphCleanup.empty) throw new Error('Import purge has pending graph cleanup');
      tx.update(jobRef, { status: 'complete', updatedAt: this.store.now() });
      return nonNegativeInteger(job.get('purgedMemories'));
    });
    return { agentId, purged };
  }

  async remove(
    source: string,
  ): Promise<{ agentId: string; purgedMemories: number; cleanupReady: boolean }> {
    if (!SOURCE_TAG.test(source)) throw new Error('Import source tag is malformed');
    const agentId = this.configuredAgentId;
    const id = deletionJobId(agentId, source);
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const jobRef = this.store.doc('importSourceDeletionJobs', id);

    const initial = await this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      const existing = await readSource(tx, this.store, agentId, source);
      const job = await tx.get(jobRef);
      if (job.exists) {
        if (
          job.get('id') !== id ||
          job.get('agentId') !== agentId ||
          job.get('sourceHash') !== sourceHash
        )
          throw new Error('Import deletion receipt ownership or identity mismatch');
        if (job.get('mode') === 'purge' && job.get('status') !== 'complete')
          throw new Error('Import source purge is still in progress');
        if (job.get('status') === 'complete') {
          if (!existing) return { sourceId: String(job.get('sourceId')), status: 'complete' };
          // A completed receipt may be replaced for the same source tag.
          // Defer its deletion until the remaining task read has completed.
        } else {
          if (existing && existing.row.id !== job.get('sourceId'))
            throw new Error('Import source was restarted while its deletion is pending');
          return {
            sourceId: String(job.get('sourceId')),
            status: String(job.get('status')),
          };
        }
      }
      if (!existing) throw new Error(`unknown import source: ${source}`);
      if (!validSourceUploadPath(existing.row.workspacePath))
        throw new Error('Import source workspace path is outside the import directory');
      const now = this.store.now();
      const taskSnap = existing.row.taskId
        ? await tx.get(this.store.doc('tasks', existing.row.taskId))
        : null;
      if (
        taskSnap?.exists &&
        (taskSnap.get('agentId') !== agentId || taskSnap.get('id') !== existing.row.taskId)
      )
        throw new Error('Import task belongs to another agent');
      if (job.exists && job.get('status') === 'complete') tx.delete(jobRef);
      if (taskSnap?.exists) {
        if (ACTIVE_TASK_STATUSES.includes(String(taskSnap.get('status'))))
          tx.update(taskSnap.ref, {
            status: 'cancelled',
            lockedUntil: null,
            runAfter: null,
            leaseToken: null,
            updatedAt: now,
          });
      }
      tx.update(
        existing.ref,
        encodeRecord({
          status: 'purged',
          memoriesSaved: 0,
          memoriesQuarantined: 0,
          updatedAt: now,
        }),
      );
      tx.create(jobRef, {
        id,
        agentId,
        sourceHash,
        sourceId: existing.row.id,
        sourceTaskId: existing.row.taskId,
        sourceWorkspacePath: existing.row.workspacePath,
        purgedMemories: 0,
        status: 'preparing',
        createdAt: now,
        updatedAt: now,
      });
      return { sourceId: existing.row.id, status: 'preparing' };
    });

    const jobSnapshot = await jobRef.get();
    if (!jobSnapshot.exists) throw new Error('Import deletion receipt disappeared');
    const sourceId = initial.sourceId;
    if (jobSnapshot.get('status') === 'complete') {
      return {
        agentId,
        purgedMemories: nonNegativeInteger(jobSnapshot.get('purgedMemories')),
        cleanupReady: true,
      };
    }

    const purgedMemories = await this.applyToSourceMemories(agentId, source, 'purge', {
      id,
      sourceHash,
    });
    await this.applyToSourceOccasions(agentId, source, { id, sourceHash });
    const prepared = await this.prepareSourceDeletionAssets({
      agentId,
      source,
      id,
      sourceHash,
      sourceId,
    });
    const latest = await jobRef.get();
    return {
      agentId,
      purgedMemories: nonNegativeInteger(latest.get('purgedMemories')) || purgedMemories,
      cleanupReady: prepared,
    };
  }

  private async prepareSourceDeletionAssets(input: {
    agentId: string;
    source: string;
    id: string;
    sourceHash: string;
    sourceId: string;
  }): Promise<boolean> {
    const jobRef = this.store.doc('importSourceDeletionJobs', input.id);
    const initial = await jobRef.get();
    if (!initial.exists) throw new Error('Import deletion receipt disappeared');
    const taskId = initial.get('sourceTaskId');
    if (typeof taskId === 'string' && taskId) {
      const slot = await this.store.doc('coordination', 'import-snapshot').get();
      if (slot.exists && slot.get('taskId') === taskId) {
        const expiry = slot.get('expiresAt')?.toDate?.() as Date | undefined;
        if (!expiry || expiry.getTime() > this.store.now().getTime()) return false;
      }
    }

    for (;;) {
      const remaining = await this.store.db.runTransaction(async (tx) => {
        await readConfiguredOwner(tx, this.store, input.agentId);
        const [job, page] = await Promise.all([
          tx.get(jobRef),
          tx.get(
            this.store
              .collection('importSnapshotAssets')
              .where('sourceId', '==', input.sourceId)
              .limit(IMPORT_ASSET_PAGE),
          ),
        ]);
        if (
          !job.exists ||
          job.get('agentId') !== input.agentId ||
          job.get('sourceHash') !== input.sourceHash ||
          job.get('sourceId') !== input.sourceId
        )
          throw new Error('Import deletion receipt ownership or identity mismatch');
        if (job.get('status') === 'complete' || job.get('status') === 'pending_assets') return 0;
        const entries = page.docs.map((doc) => {
          const source = doc.get('source');
          const task = doc.get('taskId');
          const path = doc.get('workspacePath');
          const id = doc.get('id');
          if (
            typeof id !== 'string' ||
            documentKey(String(id)) !== doc.id ||
            doc.get('agentId') !== input.agentId ||
            doc.get('sourceId') !== input.sourceId ||
            source !== input.source ||
            typeof task !== 'string' ||
            !task ||
            !validSnapshotPath(path, input.source, task)
          )
            throw new Error('Import snapshot asset ownership or path is invalid');
          const assetId = `import-delete:${createHash('sha256')
            .update(`${input.id}\0${path}`)
            .digest('hex')}`;
          return { doc, id: assetId, taskId: task, workspacePath: path };
        });
        const assetRefs = entries.map((entry) => this.store.doc('privacyErasureAssets', entry.id));
        const existing = assetRefs.length ? await tx.getAll(...assetRefs) : [];
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          const prior = existing[index];
          if (!entry) continue;
          if (
            prior?.exists &&
            (prior.get('agentId') !== input.agentId ||
              prior.get('sourceId') !== entry.id ||
              prior.get('importDeletionId') !== input.id ||
              prior.get('workspacePath') !== entry.workspacePath)
          )
            throw new Error('Import workspace cleanup asset belongs to another source');
          if (!prior?.exists)
            tx.create(assetRefs[index] as DocumentReference, {
              id: entry.id,
              sourceId: entry.id,
              agentId: input.agentId,
              importDeletionId: input.id,
              sourceHash: input.sourceHash,
              source: input.source,
              assetKind: 'snapshot',
              taskId: entry.taskId,
              workspacePath: entry.workspacePath,
              createdAt: this.store.now(),
            });
          tx.delete(entry.doc.ref);
        }
        return page.size;
      });
      if (remaining === 0) break;
    }

    return this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, input.agentId);
      const [job, existing, page, claim] = await Promise.all([
        tx.get(jobRef),
        readSource(tx, this.store, input.agentId, input.source),
        tx.get(
          this.store
            .collection('importSnapshotAssets')
            .where('sourceId', '==', input.sourceId)
            .limit(1),
        ),
        tx.get(this.store.doc('importSourceKeys', sourceKeyId(input.agentId, input.source))),
      ]);
      if (
        !job.exists ||
        job.get('agentId') !== input.agentId ||
        job.get('sourceHash') !== input.sourceHash ||
        job.get('sourceId') !== input.sourceId
      )
        throw new Error('Import deletion receipt ownership or identity mismatch');
      if (job.get('status') === 'complete' || job.get('status') === 'pending_assets') return true;
      if (!page.empty) return false;
      if (existing) {
        if (existing.row.id !== input.sourceId || existing.row.status !== 'purged')
          throw new Error(`Import "${input.source}" was restarted while it was being deleted`);
        if (!validSourceUploadPath(existing.row.workspacePath))
          throw new Error('Import source workspace path is outside the import directory');
        const assetId = `import-delete:${createHash('sha256')
          .update(`${input.id}\0${existing.row.workspacePath}`)
          .digest('hex')}`;
        const assetRef = this.store.doc('privacyErasureAssets', assetId);
        const asset = await tx.get(assetRef);
        if (
          asset.exists &&
          (asset.get('agentId') !== input.agentId ||
            asset.get('sourceId') !== assetId ||
            asset.get('importDeletionId') !== input.id ||
            asset.get('workspacePath') !== existing.row.workspacePath)
        )
          throw new Error('Import workspace cleanup asset belongs to another source');
        if (!asset.exists)
          tx.create(assetRef, {
            id: assetId,
            sourceId: assetId,
            agentId: input.agentId,
            importDeletionId: input.id,
            sourceHash: input.sourceHash,
            source: input.source,
            assetKind: 'source',
            taskId: existing.row.taskId,
            workspacePath: existing.row.workspacePath,
            createdAt: this.store.now(),
          });
        tx.delete(existing.ref);
      } else if (!job.get('sourceWorkspacePath')) {
        throw new Error('Import source archive deletion path is missing');
      }
      if (claim.exists) {
        if (claim.get('agentId') !== input.agentId || claim.get('source') !== input.source)
          throw new Error('Import source claim belongs to another owner');
        tx.delete(claim.ref);
      }
      tx.update(jobRef, {
        status: 'pending_assets',
        sourceWorkspacePath: null,
        updatedAt: this.store.now(),
      });
      return true;
    });
  }

  async pendingDeletionAssets(source: string): Promise<ImportDeletionAsset[]> {
    if (!SOURCE_TAG.test(source)) throw new Error('Import source tag is malformed');
    const agentId = this.configuredAgentId;
    const id = deletionJobId(agentId, source);
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const job = await this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      return tx.get(this.store.doc('importSourceDeletionJobs', id));
    });
    if (!job.exists) throw new Error('Import deletion receipt is missing');
    if (
      job.get('agentId') !== agentId ||
      job.get('sourceHash') !== sourceHash ||
      job.get('id') !== id
    )
      throw new Error('Import deletion receipt ownership or identity mismatch');
    if (job.get('status') !== 'pending_assets' && job.get('status') !== 'complete')
      throw new Error('Import deletion assets are not ready to drain');
    const rows = await this.store
      .collection('privacyErasureAssets')
      .where('importDeletionId', '==', id)
      .limit(IMPORT_ASSET_PAGE)
      .get();
    return rows.docs.map((doc) => {
      const assetId = doc.get('id');
      const path = doc.get('workspacePath');
      const kind = doc.get('assetKind');
      const taskId = doc.get('taskId');
      if (
        doc.get('agentId') !== agentId ||
        doc.get('sourceId') !== assetId ||
        doc.get('importDeletionId') !== id ||
        doc.get('sourceHash') !== sourceHash ||
        doc.get('source') !== source ||
        typeof assetId !== 'string' ||
        documentKey(assetId) !== doc.id ||
        (kind === 'source'
          ? !validSourceUploadPath(path)
          : kind !== 'snapshot' ||
            typeof taskId !== 'string' ||
            !validSnapshotPath(path, source, taskId))
      )
        throw new Error('Import workspace cleanup asset ownership or path is invalid');
      return { id: assetId, workspacePath: path as string };
    });
  }

  async assetDeleted(source: string, id: string, workspacePath: string): Promise<void> {
    if (!SOURCE_TAG.test(source)) throw new Error('Import source tag is malformed');
    const agentId = this.configuredAgentId;
    const importDeletionId = deletionJobId(agentId, source);
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const ref = this.store.doc('privacyErasureAssets', id);
    await this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      const [job, asset] = await tx.getAll(
        this.store.doc('importSourceDeletionJobs', importDeletionId),
        ref,
      );
      if (!job?.exists || job.get('agentId') !== agentId || job.get('sourceHash') !== sourceHash)
        throw new Error('Import deletion receipt ownership or identity mismatch');
      if (!asset?.exists) return;
      if (
        asset.get('agentId') !== agentId ||
        asset.get('sourceId') !== id ||
        asset.get('id') !== id ||
        asset.get('importDeletionId') !== importDeletionId ||
        asset.get('sourceHash') !== sourceHash ||
        asset.get('source') !== source ||
        asset.get('workspacePath') !== workspacePath
      )
        throw new Error('Import workspace cleanup asset belongs to another source');
      const kind = asset.get('assetKind');
      const taskId = asset.get('taskId');
      if (
        kind === 'source'
          ? !validSourceUploadPath(workspacePath)
          : kind !== 'snapshot' ||
            typeof taskId !== 'string' ||
            !validSnapshotPath(workspacePath, source, taskId)
      )
        throw new Error('Import workspace cleanup asset path is invalid');
      tx.delete(ref);
    });
  }

  async completeDeletion(source: string): Promise<void> {
    if (!SOURCE_TAG.test(source)) throw new Error('Import source tag is malformed');
    const agentId = this.configuredAgentId;
    const id = deletionJobId(agentId, source);
    const sourceHash = createHash('sha256').update(source).digest('hex');
    await this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      const jobRef = this.store.doc('importSourceDeletionJobs', id);
      const [job, pending] = await Promise.all([
        tx.get(jobRef),
        tx.get(
          this.store
            .collection('privacyErasureAssets')
            .where('importDeletionId', '==', id)
            .limit(1),
        ),
      ]);
      if (
        !job.exists ||
        job.get('agentId') !== agentId ||
        job.get('sourceHash') !== sourceHash ||
        job.get('id') !== id
      )
        throw new Error('Import deletion receipt ownership or identity mismatch');
      if (job.get('status') !== 'pending_assets' && job.get('status') !== 'complete')
        throw new Error('Import source deletion has not finished preparing its assets');
      if (!pending.empty) throw new Error('Import workspace cleanup assets remain');
      if (job.get('status') !== 'complete')
        tx.update(jobRef, { status: 'complete', updatedAt: this.store.now() });
    });
  }

  async review(
    source: string,
    verdict: 'approve' | 'reject',
  ): Promise<{ agentId: string; reviewed: number }> {
    const agentId = this.configuredAgentId;
    const reviewed = await this.applyToSourceMemories(
      agentId,
      source,
      verdict === 'approve' ? 'approve' : 'reject',
    );
    if (reviewed === 0) return { agentId, reviewed };
    await this.store.db.runTransaction(async (tx) => {
      await readConfiguredOwner(tx, this.store, agentId);
      const existing = await readSource(tx, this.store, agentId, source);
      if (existing)
        tx.update(existing.ref, { memoriesQuarantined: 0, updatedAt: this.store.now() });
    });
    return { agentId, reviewed };
  }
}
