import { createHash, randomUUID } from 'node:crypto';
import { type OwnerEditorScope, ownerEditorPrivacyDigest } from '@assistant/persistence';
import { type DocumentReference, Firestore, type Transaction } from '@google-cloud/firestore';
import { afterEach, describe, expect, it } from 'vitest';
import { projectManualOwnerMemoryCorrection } from '../../persistence/src/owner-memory-manual-projection.js';
import { ownerEditorFirestorePrivacyToken } from './owner-editor-repository.js';
import { collectFirestoreManualOwnerMemoryEvidenceInTransaction } from './owner-memory-manual-evidence.js';
import { documentKey, InstallationStore } from './store.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const memoryId = '22222222-2222-4222-8222-222222222222';
const contactId = '33333333-3333-4333-8333-333333333333';
const editorEpoch = '44444444-4444-4444-8444-444444444444';
const content = 'Synthetic stored manual note';
const replacement = 'Synthetic corrected manual note';
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const epochId = `owner-editor-epoch:${ownerId}`;
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost ?? '');
if (emulatorHost && !localEmulator) throw new Error('Loopback Firestore emulator required');
if (localEmulator && process.env.ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS !== '1')
  throw new Error('Run Firestore emulator tests through the credential-isolating test runner');

type NativeFixture = {
  store: InstallationStore;
  refs: DocumentReference[];
  ownerId: string;
  memoryId: string;
  contactId: string;
  content: string;
  replacement: string;
  scope: OwnerEditorScope;
  epochName: string;
  privacyRef: DocumentReference;
  epochRef: DocumentReference;
  contactRef: DocumentReference;
};

let activeNativeResources: { store: InstallationStore; refs: DocumentReference[] } | undefined;

async function createNativeFixture(): Promise<NativeFixture> {
  if (!localEmulator) throw new Error('Local Firestore emulator is not configured');
  const projectId = 'demo-assistant-test';
  const installationId = `manual-evidence-${randomUUID()}`;
  const now = new Date('2026-11-04T14:00:00.000Z');
  const store = new InstallationStore(
    new Firestore({ projectId }),
    installationId,
    () => new Date(now),
    projectId,
  );
  const ownerId = randomUUID();
  const memoryId = randomUUID();
  const contactId = randomUUID();
  const content = `Synthetic Firestore memory ${randomUUID()}`;
  const replacement = `Synthetic Firestore replacement ${randomUUID()}`;
  const epoch = randomUUID();
  const epochName = `owner-editor-epoch:${ownerId}`;
  const refs: DocumentReference[] = [];
  activeNativeResources = { store, refs };
  const put = async (collection: string, id: string, value: Record<string, unknown>) => {
    const ref = store.doc(collection, id);
    refs.push(ref);
    await ref.set(value);
    return ref;
  };
  const privacyRef = await put('privacyErasureJobs', ownerId, {
    agentId: ownerId,
    status: 'complete',
    generation: `generation-${randomUUID()}`,
  });
  const privacyToken = ownerEditorFirestorePrivacyToken(await privacyRef.get(), ownerId);
  if (!privacyToken) throw new Error('Fixture privacy token unavailable');
  const epochRef = await put('maintenanceCursors', epochName, {
    name: epochName,
    cursor: JSON.stringify({
      ownerId,
      epoch,
      ready: true,
      privacyGenerationDigest: ownerEditorPrivacyDigest(privacyToken),
    }),
  });
  await put('agents', ownerId, { id: ownerId });
  const contentHash = hash(content);
  await put('memories', memoryId, {
    id: memoryId,
    agentId: ownerId,
    content,
    contentHash,
    category: 'knowledge',
    source: 'manual',
    sourceTaskId: null,
    subjectContactId: contactId,
    expiresAt: null,
    supersededById: null,
    quarantined: false,
    ownerCorrection: null,
  });
  const contactRef = await put('contacts', contactId, {
    id: contactId,
    agentId: ownerId,
    name: 'Synthetic emulator contact',
    aliases: ['Synthetic alias'],
    trust: 'known',
    identityAuthority: null,
    notes: 'Excluded from normalized evidence',
  });
  const fixture: NativeFixture = {
    store,
    refs,
    ownerId,
    memoryId,
    contactId,
    content,
    replacement,
    scope: {
      ownerId,
      sessionDigest: 'synthetic-session-digest',
      epoch,
      privacyGeneration: privacyToken,
      command: 'correct_owner_memory',
      operationId: randomUUID(),
      targetId: memoryId,
      nonce: randomUUID(),
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 60_000,
    },
    epochName,
    privacyRef,
    epochRef,
    contactRef,
  };
  return fixture;
}

async function collectNative(fixture: NativeFixture) {
  let writeAttempts = 0;
  const result = await fixture.store.db.runTransaction(
    (tx) =>
      collectFirestoreManualOwnerMemoryEvidenceInTransaction(
        new Proxy(tx, {
          get(target, property) {
            if (['set', 'create', 'update', 'delete'].includes(String(property)))
              return () => {
                writeAttempts += 1;
                throw new Error('Collector attempted a transaction write');
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as Transaction,
        fixture.store,
        fixture.ownerId,
        fixture.scope,
        fixture.memoryId,
        fixture.replacement,
      ),
    { maxAttempts: 2 },
  );
  expect(writeAttempts).toBe(0);
  return result;
}

afterEach(async () => {
  const fixture = activeNativeResources;
  activeNativeResources = undefined;
  if (!fixture) return;
  try {
    if (fixture.refs.length > 8) throw new Error('Native fixture cleanup bound exceeded');
    const cleanup = fixture.store.db.batch();
    for (const ref of fixture.refs) cleanup.delete(ref);
    await cleanup.commit();
    await fixture.store.root.delete();
    const remaining = await Promise.all(fixture.refs.map((ref) => ref.get()));
    expect(remaining.every((snapshot) => !snapshot.exists)).toBe(true);
  } finally {
    await fixture.store.db.terminate();
  }
});

class Ref {
  constructor(
    readonly table: string,
    readonly key: string,
  ) {}
  get id() {
    return documentKey(this.key);
  }
}

class QueryRef {
  constructor(
    readonly table: string,
    readonly filters: Array<[string, string, unknown]> = [],
    readonly cap = 0,
  ) {}
  where(field: string, op: string, value: unknown) {
    return new QueryRef(this.table, [...this.filters, [field, op, value]], this.cap);
  }
  limit(cap: number) {
    return new QueryRef(this.table, this.filters, cap);
  }
}

function snapshot(
  table: string,
  key: string,
  data: Record<string, unknown> | null,
  version: { seconds: number; nanoseconds: number } | null = {
    seconds: 1_798_688_000,
    nanoseconds: 123_456_789,
  },
) {
  return {
    id: documentKey(key),
    exists: data !== null,
    updateTime: data === null || version === null ? undefined : version,
    get(field: string) {
      return data?.[field];
    },
    data: () => data ?? undefined,
    ref: new Ref(table, key),
  };
}

function fixture(
  overrides: {
    ownerRows?: Array<Record<string, unknown>>;
    privacy?: Record<string, unknown> | null;
    epoch?: Record<string, unknown> | null;
    memory?: Record<string, unknown> | null;
    contact?: Record<string, unknown> | null;
    subjectContactId?: string | null;
    privacyVersion?: { seconds: number; nanoseconds: number };
    scopePrivacyGeneration?: string | null;
    contactVersion?: { seconds: number; nanoseconds: number } | null;
    wrongPhysicalContact?: boolean;
    observedAt?: Date;
    tombstones?: Set<string>;
    lineage?: Array<Record<string, unknown>>;
  } = {},
) {
  const generation = overrides.privacy?.generation;
  const privacyVersion = overrides.privacyVersion ?? {
    seconds: 1_798_688_000,
    nanoseconds: 123_456_789,
  };
  const privacyToken = overrides.privacy ? JSON.stringify({ generation, ...privacyVersion }) : null;
  const defaultMemory = {
    id: memoryId,
    agentId: ownerId,
    content,
    contentHash: hash(content),
    category: 'knowledge',
    source: 'manual',
    sourceTaskId: null,
    subjectContactId:
      overrides.subjectContactId === undefined ? contactId : overrides.subjectContactId,
    expiresAt: null,
    supersededById: null,
    quarantined: false,
    ownerCorrection: null,
  };
  const docs = new Map<string, ReturnType<typeof snapshot>>();
  let ownerRows = overrides.ownerRows ?? [{ id: ownerId }];
  let lineageRows = overrides.lineage ?? [];
  ownerRows.forEach((row, i) => {
    docs.set(`agents:${i}`, snapshot('agents', ownerId, row));
  });
  docs.set(
    `privacyErasureJobs:${ownerId}`,
    snapshot('privacyErasureJobs', ownerId, overrides.privacy ?? null, privacyVersion),
  );
  docs.set(
    `maintenanceCursors:${epochId}`,
    snapshot(
      'maintenanceCursors',
      epochId,
      overrides.epoch ?? {
        name: epochId,
        cursor: JSON.stringify({
          ownerId,
          epoch: editorEpoch,
          ready: true,
          privacyGenerationDigest: ownerEditorPrivacyDigest(privacyToken),
        }),
      },
    ),
  );
  docs.set(
    `memories:${memoryId}`,
    snapshot('memories', memoryId, { ...defaultMemory, ...(overrides.memory ?? {}) }),
  );
  docs.set(
    `contacts:${contactId}`,
    snapshot(
      'contacts',
      contactId,
      overrides.contact ?? {
        id: contactId,
        agentId: ownerId,
        name: 'Synthetic contact',
        aliases: ['Synthetic alias'],
        trust: 'known',
        identityAuthority: null,
        notes: 'Not part of the normalized evidence',
      },
      overrides.contactVersion === undefined
        ? { seconds: 1_798_688_000, nanoseconds: 123_456_789 }
        : overrides.contactVersion,
    ),
  );
  const tombstones = overrides.tombstones ?? new Set<string>();
  for (const key of tombstones)
    docs.set(`memoryTombstones:${key}`, snapshot('memoryTombstones', key, { contentHash: key }));

  const calls: string[] = [];
  let nowCalls = 0;
  const tx = {
    async get(input: Ref | QueryRef) {
      if (input instanceof QueryRef) {
        const filter =
          input.filters.map(([field, op, value]) => `${field}${op}${String(value)}`).join('&') ||
          'none';
        calls.push(`${input.table}:query:${filter}:limit=${input.cap}`);
        if (input.table === 'agents')
          return {
            docs: ownerRows.map((row) => snapshot('agents', String(row.id), row)),
            size: ownerRows.length,
          };
        const rows = lineageRows;
        return {
          docs: rows.map((row, i) => snapshot(input.table, `lineage-${i}`, row)),
          size: rows.length,
        };
      }
      calls.push(`${input.table}:get:${input.key}`);
      const found =
        docs.get(`${input.table}:${input.key}`) ?? snapshot(input.table, input.key, null);
      return input.table === 'contacts' && overrides.wrongPhysicalContact
        ? { ...found, id: 'wrong-physical-contact' }
        : found;
    },
    async getAll(...refs: Ref[]) {
      calls.push(...refs.map((ref) => `${ref.table}:getAll:${ref.key}`));
      return refs.map(
        (ref) => docs.get(`${ref.table}:${ref.key}`) ?? snapshot(ref.table, ref.key, null),
      );
    },
  };
  const store = {
    collection: (table: string) => new QueryRef(table),
    doc: (table: string, key: string) => new Ref(table, key),
    now: () => {
      nowCalls += 1;
      return overrides.observedAt ?? new Date('2026-11-04T14:00:00.000Z');
    },
  };
  const scope: OwnerEditorScope = {
    ownerId,
    sessionDigest: 'session',
    epoch: editorEpoch,
    privacyGeneration:
      overrides.scopePrivacyGeneration === undefined
        ? privacyToken
        : overrides.scopePrivacyGeneration,
    command: 'correct_owner_memory',
    operationId: 'operation',
    targetId: memoryId,
    nonce: 'nonce',
    issuedAt: 1_798_688_000_000,
    expiresAt: 1_798_688_100_000,
  };
  return {
    tx,
    store,
    scope,
    calls,
    readDocument(table: string, key: string) {
      return docs.get(`${table}:${key}`);
    },
    setDocument(
      table: string,
      key: string,
      data: Record<string, unknown>,
      version?: { seconds: number; nanoseconds: number },
    ) {
      const updated = snapshot(
        table,
        key,
        data,
        version ?? docs.get(`${table}:${key}`)?.updateTime,
      );
      docs.set(`${table}:${key}`, updated);
      return updated;
    },
    setOwnerRows(rows: Array<Record<string, unknown>>) {
      ownerRows = rows;
    },
    setLineageRows(rows: Array<Record<string, unknown>>) {
      lineageRows = rows;
    },
    get nowCalls() {
      return nowCalls;
    },
  };
}

describe('internal Firestore manual owner-memory evidence collector', () => {
  it('captures a strict v2 observation from one transaction without queued writes', async () => {
    const f = fixture({
      privacy: { agentId: ownerId, status: 'complete', generation: 'generation-one' },
    });
    const result = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      f.tx as never,
      f.store as never,
      ownerId,
      f.scope,
      memoryId,
      replacement,
    );
    expect(result.status).toBe('observed');
    if (result.status !== 'observed') return;
    expect(result.manifest).toMatchObject({
      version: 2,
      driver: 'firestore',
      ownerId,
      memoryId,
      observedAt: '2026-11-04T14:00:00.000Z',
      oldHashTombstone: {
        key: `content:${hash(content)}`,
        state: 'missing',
        value: null,
        nativeVersion: null,
      },
      newHashTombstone: {
        key: `content:${hash(replacement)}`,
        state: 'missing',
        value: null,
        nativeVersion: null,
      },
      lineageQuery: { scope: { memoryId }, limit: 2, complete: true, keys: [] },
    });
    expect(Object.keys(result.manifest.memory)).not.toContain('memoryNativeVersion');
    expect(result.manifest.subjectContact).toMatchObject({
      value: {
        id: contactId,
        name: 'Synthetic contact',
        aliases: ['Synthetic alias'],
        trust: 'known',
        identityAuthority: null,
      },
      nativeVersion: {
        kind: 'firestore_timestamp',
        seconds: 1_798_688_000,
        nanoseconds: 123_456_789,
      },
    });
    expect(result.manifest.subjectContact?.value).not.toHaveProperty('notes');
    const originalProjection = projectManualOwnerMemoryCorrection(result.manifest);
    expect(originalProjection).not.toBeNull();
    const sameVersionIdentityChange = structuredClone(result.manifest);
    if (
      !sameVersionIdentityChange.subjectContact?.value ||
      typeof sameVersionIdentityChange.subjectContact.value !== 'object'
    )
      throw new Error('Expected normalized contact');
    (sameVersionIdentityChange.subjectContact.value as Record<string, unknown>).name =
      'Synthetic changed contact';
    expect(
      projectManualOwnerMemoryCorrection(sameVersionIdentityChange)?.prewriteFingerprint,
    ).not.toBe(originalProjection?.prewriteFingerprint);

    const nativeVersionOnlyChange = structuredClone(result.manifest);
    if (!nativeVersionOnlyChange.subjectContact?.nativeVersion) {
      throw new Error('Expected native contact version');
    }
    nativeVersionOnlyChange.subjectContact.nativeVersion.nanoseconds += 1;
    expect(
      projectManualOwnerMemoryCorrection(nativeVersionOnlyChange)?.prewriteFingerprint,
    ).not.toBe(originalProjection?.prewriteFingerprint);
    expect(result.readSet.privacyGeneration).toBe(f.scope.privacyGeneration);
    expect(result.readSet.privacyNativeVersion).toEqual({
      seconds: 1_798_688_000,
      nanoseconds: 123_456_789,
    });
    expect(result.readSet.nativeSnapshot).toEqual({ state: 'unavailable' });
    expect(f.tx).not.toHaveProperty('set');
    expect(f.tx).not.toHaveProperty('delete');
    expect(f.nowCalls).toBe(1);
    expect(f.calls).toEqual([
      'agents:query:none:limit=2',
      `privacyErasureJobs:getAll:${ownerId}`,
      `maintenanceCursors:getAll:${epochId}`,
      `memories:get:${memoryId}`,
      `memoryTombstones:get:${hash(content)}`,
      `memoryTombstones:get:${hash(replacement)}`,
      `memoryImportLineage:query:memoryId==${memoryId}:limit=2`,
      `contacts:get:${contactId}`,
    ]);
  });

  it('performs no contact read when the target has no subject', async () => {
    const f = fixture({ subjectContactId: null });
    const result = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      f.tx as never,
      f.store as never,
      ownerId,
      f.scope,
      memoryId,
      replacement,
    );
    expect(result.status).toBe('observed');
    if (result.status === 'observed') expect(result.manifest.subjectContact).toBeNull();
    expect(f.calls).not.toContain(`contacts:get:${contactId}`);
  });

  it('returns bounded unknown outcomes for mismatched scope and incomplete evidence', async () => {
    const wrongScope = fixture();
    const mismatch = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      wrongScope.tx as never,
      wrongScope.store as never,
      ownerId,
      { ...wrongScope.scope, targetId: '44444444-4444-4444-8444-444444444444' },
      memoryId,
      replacement,
    );
    expect(mismatch).toEqual({ status: 'unknown', reason: 'scope_mismatch' });
    expect(wrongScope.calls).toEqual([]);

    const lineage = fixture({ lineage: [{ memoryId }] });
    const incomplete = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      lineage.tx as never,
      lineage.store as never,
      ownerId,
      lineage.scope,
      memoryId,
      replacement,
    );
    expect(incomplete).toEqual({ status: 'unknown', reason: 'lineage_incomplete' });

    const tombstoned = fixture({ tombstones: new Set([hash(replacement)]) });
    const tombstone = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      tombstoned.tx as never,
      tombstoned.store as never,
      ownerId,
      tombstoned.scope,
      memoryId,
      replacement,
    );
    expect(tombstone).toEqual({ status: 'unknown', reason: 'tombstone_present' });

    const oldTombstoned = fixture({ tombstones: new Set([hash(content)]) });
    const oldTombstone = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      oldTombstoned.tx as never,
      oldTombstoned.store as never,
      ownerId,
      oldTombstoned.scope,
      memoryId,
      replacement,
    );
    expect(oldTombstone).toEqual({ status: 'unknown', reason: 'tombstone_present' });
  });

  it('binds the complete privacy token including its native update time', async () => {
    const completeJob = { agentId: ownerId, status: 'complete', generation: 'generation-one' };
    const original = fixture({ privacy: completeJob });
    const timestampChanged = fixture({
      privacy: completeJob,
      privacyVersion: { seconds: 1_798_688_000, nanoseconds: 123_456_790 },
      scopePrivacyGeneration: original.scope.privacyGeneration,
    });
    const staleTimestamp = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      timestampChanged.tx as never,
      timestampChanged.store as never,
      ownerId,
      { ...timestampChanged.scope, privacyGeneration: original.scope.privacyGeneration },
      memoryId,
      replacement,
    );
    expect(staleTimestamp).toEqual({ status: 'unknown', reason: 'privacy_unavailable' });

    const rotated = fixture({
      privacy: { ...completeJob, generation: 'generation-two' },
      scopePrivacyGeneration: original.scope.privacyGeneration,
    });
    const staleGeneration = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      rotated.tx as never,
      rotated.store as never,
      ownerId,
      { ...rotated.scope, privacyGeneration: original.scope.privacyGeneration },
      memoryId,
      replacement,
    );
    expect(staleGeneration).toEqual({ status: 'unknown', reason: 'privacy_unavailable' });

    const active = fixture({ privacy: { ...completeJob, status: 'active' } });
    const activeJob = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      active.tx as never,
      active.store as never,
      ownerId,
      active.scope,
      memoryId,
      replacement,
    );
    expect(activeJob).toEqual({ status: 'unknown', reason: 'privacy_unavailable' });
  });

  it('fails closed for unusable lifecycle and malformed correction markers', async () => {
    for (const memory of [
      { quarantined: true },
      { supersededById: contactId },
      { expiresAt: new Date('2026-11-04T13:59:59.999Z') },
      { expiresAt: new Date('2026-11-04T14:00:00.000Z') },
    ]) {
      const f = fixture({ memory });
      const result = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
        f.tx as never,
        f.store as never,
        ownerId,
        f.scope,
        memoryId,
        replacement,
      );
      expect(result).toEqual({ status: 'unknown', reason: 'memory_ineligible' });
    }
    const malformed = fixture({ memory: { ownerCorrection: { version: 2 } } });
    const invalidMarker = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      malformed.tx as never,
      malformed.store as never,
      ownerId,
      malformed.scope,
      memoryId,
      replacement,
    );
    expect(invalidMarker).toEqual({ status: 'unknown', reason: 'memory_malformed' });

    const expiredDuringCapture = fixture({
      memory: { expiresAt: new Date('2026-11-04T14:00:00.001Z') },
      observedAt: new Date('2026-11-04T14:00:00.002Z'),
    });
    const expired = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      expiredDuringCapture.tx as never,
      expiredDuringCapture.store as never,
      ownerId,
      expiredDuringCapture.scope,
      memoryId,
      replacement,
    );
    expect(expired).toEqual({ status: 'unknown', reason: 'memory_ineligible' });
  });

  it('rejects duplicate owners, identity mismatches, missing contact versions, and saturated lineage', async () => {
    const duplicateOwners = fixture({ ownerRows: [{ id: ownerId }, { id: ownerId }] });
    const duplicate = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      duplicateOwners.tx as never,
      duplicateOwners.store as never,
      ownerId,
      duplicateOwners.scope,
      memoryId,
      replacement,
    );
    expect(duplicate).toEqual({ status: 'unknown', reason: 'owner_unavailable' });

    const wrongMemory = fixture({ memory: { id: contactId } });
    const wrongIdentity = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      wrongMemory.tx as never,
      wrongMemory.store as never,
      ownerId,
      wrongMemory.scope,
      memoryId,
      replacement,
    );
    expect(wrongIdentity).toEqual({ status: 'unknown', reason: 'memory_malformed' });

    const missingVersion = fixture({ contactVersion: null });
    const noVersion = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      missingVersion.tx as never,
      missingVersion.store as never,
      ownerId,
      missingVersion.scope,
      memoryId,
      replacement,
    );
    expect(noVersion).toEqual({ status: 'unknown', reason: 'contact_unavailable' });

    const malformedVersion = fixture({
      contactVersion: { seconds: 1_798_688_000, nanoseconds: 1_000_000_000 },
    });
    const invalidVersion = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      malformedVersion.tx as never,
      malformedVersion.store as never,
      ownerId,
      malformedVersion.scope,
      memoryId,
      replacement,
    );
    expect(invalidVersion).toEqual({ status: 'unknown', reason: 'transaction_unknown' });

    const physicalMismatch = fixture({ wrongPhysicalContact: true });
    const wrongPhysical = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      physicalMismatch.tx as never,
      physicalMismatch.store as never,
      ownerId,
      physicalMismatch.scope,
      memoryId,
      replacement,
    );
    expect(wrongPhysical).toEqual({ status: 'unknown', reason: 'contact_unavailable' });

    const wrongContact = fixture({
      contact: { id: ownerId, name: 'Wrong', aliases: [], trust: 'known', identityAuthority: null },
    });
    const mismatchedContact = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      wrongContact.tx as never,
      wrongContact.store as never,
      ownerId,
      wrongContact.scope,
      memoryId,
      replacement,
    );
    expect(mismatchedContact).toEqual({ status: 'unknown', reason: 'contact_unavailable' });

    const cappedLineage = fixture({ lineage: [{ memoryId }, { memoryId }] });
    const saturated = await collectFirestoreManualOwnerMemoryEvidenceInTransaction(
      cappedLineage.tx as never,
      cappedLineage.store as never,
      ownerId,
      cappedLineage.scope,
      memoryId,
      replacement,
    );
    expect(saturated).toEqual({ status: 'unknown', reason: 'lineage_incomplete' });
  });

  it('rebuilds the complete read set and captures the clock on each invocation', async () => {
    const f = fixture();
    const collect = () =>
      collectFirestoreManualOwnerMemoryEvidenceInTransaction(
        f.tx as never,
        f.store as never,
        ownerId,
        f.scope,
        memoryId,
        replacement,
      );

    const first = await collect();
    expect(first.status).toBe('observed');
    if (first.status !== 'observed') return;
    const originalCalls = [...f.calls];
    f.calls.length = 0;

    const changedContent = `${content} with new state`;
    const changedMemory = f.readDocument('memories', memoryId)?.data();
    if (!changedMemory) throw new Error('Expected fake memory document');
    f.setDocument(
      'memories',
      memoryId,
      { ...changedMemory, content: changedContent, contentHash: hash(changedContent) },
      { seconds: 1_798_688_001, nanoseconds: 1 },
    );

    const changedPrivacy = {
      agentId: ownerId,
      status: 'complete',
      generation: 'synthetic-recaptured-generation',
    };
    const nextPrivacy = f.setDocument('privacyErasureJobs', ownerId, changedPrivacy, {
      seconds: 1_798_688_002,
      nanoseconds: 2,
    });
    const nextPrivacyToken = ownerEditorFirestorePrivacyToken(nextPrivacy as never, ownerId);
    if (!nextPrivacyToken) throw new Error('Expected changed fake privacy token');
    f.scope = { ...f.scope, privacyGeneration: nextPrivacyToken };

    const epochData = f.readDocument('maintenanceCursors', epochId)?.data();
    if (!epochData) throw new Error('Expected fake epoch document');
    const epochCursor = JSON.parse(String(epochData.cursor)) as Record<string, unknown>;
    f.setDocument(
      'maintenanceCursors',
      epochId,
      {
        ...epochData,
        cursor: JSON.stringify({
          ...epochCursor,
          privacyGenerationDigest: ownerEditorPrivacyDigest(nextPrivacyToken),
        }),
      },
      { seconds: 1_798_688_003, nanoseconds: 3 },
    );

    const contactData = f.readDocument('contacts', contactId)?.data();
    if (!contactData) throw new Error('Expected fake contact document');
    f.setDocument(
      'contacts',
      contactId,
      { ...contactData, name: 'Synthetic changed contact' },
      { seconds: 1_798_688_004, nanoseconds: 4 },
    );
    f.setOwnerRows([{ id: ownerId, syntheticRevision: 2 }]);
    f.setLineageRows([]);

    const second = await collect();
    expect(second.status).toBe('observed');
    if (second.status !== 'observed') return;
    expect(f.nowCalls).toBe(2);
    expect(f.calls).toHaveLength(8);
    expect(f.calls).toEqual([
      originalCalls[0],
      originalCalls[1],
      originalCalls[2],
      originalCalls[3],
      `memoryTombstones:get:${hash(changedContent)}`,
      `memoryTombstones:get:${hash(replacement)}`,
      originalCalls[6],
      originalCalls[7],
    ]);
    expect(second.manifest.memory.content).toBe(changedContent);
    expect(second.manifest.subjectContact?.value).toMatchObject({
      name: 'Synthetic changed contact',
    });
    expect(second.manifest.subjectContact?.nativeVersion).toEqual({
      kind: 'firestore_timestamp',
      seconds: 1_798_688_004,
      nanoseconds: 4,
    });
    expect(second.readSet.privacyGeneration).toBe(nextPrivacyToken);
    expect(second.readSet.privacyNativeVersion).toEqual({
      seconds: 1_798_688_002,
      nanoseconds: 2,
    });
    expect(second.readSet.editorEpochNativeVersion).toEqual({
      seconds: 1_798_688_003,
      nanoseconds: 3,
    });
  });
});

describe.skipIf(!localEmulator)(
  'Firestore manual owner-memory evidence on the loopback SDK emulator',
  () => {
    it('captures native updateTime and rebuilds evidence after a same-identity write', async () => {
      const fixture = await createNativeFixture();
      const first = await collectNative(fixture);
      expect(first.status).toBe('observed');
      if (first.status !== 'observed') return;
      const contactSnapshot = await fixture.contactRef.get();
      expect(contactSnapshot.updateTime).toBeDefined();
      expect(first.manifest.subjectContact?.nativeVersion).toEqual({
        kind: 'firestore_timestamp',
        seconds: contactSnapshot.updateTime?.seconds,
        nanoseconds: contactSnapshot.updateTime?.nanoseconds,
      });
      expect(projectManualOwnerMemoryCorrection(first.manifest)).not.toBeNull();

      const sameVersionChange = structuredClone(first.manifest);
      if (
        !sameVersionChange.subjectContact?.value ||
        typeof sameVersionChange.subjectContact.value !== 'object'
      )
        throw new Error('Expected contact observation');
      (sameVersionChange.subjectContact.value as Record<string, unknown>).name =
        'Synthetic same-version name change';
      const changedIdentity = projectManualOwnerMemoryCorrection(sameVersionChange);
      const originalProjection = projectManualOwnerMemoryCorrection(first.manifest);
      expect(changedIdentity?.prewriteFingerprint).not.toBe(
        originalProjection?.prewriteFingerprint,
      );

      await new Promise((resolve) => setTimeout(resolve, 5));
      await fixture.contactRef.update({ notes: 'Synthetic unrelated update' });
      const second = await collectNative(fixture);
      expect(second.status).toBe('observed');
      if (second.status !== 'observed') return;
      expect(second.manifest.subjectContact?.value).toEqual(first.manifest.subjectContact?.value);
      expect(second.manifest.subjectContact?.nativeVersion).not.toEqual(
        first.manifest.subjectContact?.nativeVersion,
      );
      const versionOnlyProjection = projectManualOwnerMemoryCorrection(second.manifest);
      expect(versionOnlyProjection?.prewriteFingerprint).not.toBe(
        originalProjection?.prewriteFingerprint,
      );
    }, 45_000);

    it('rejects changed privacy, unready epoch, and newly present lineage in fresh transactions', async () => {
      const fixture = await createNativeFixture();
      const initial = await collectNative(fixture);
      expect(initial.status).toBe('observed');

      await new Promise((resolve) => setTimeout(resolve, 5));
      await fixture.privacyRef.update({ notes: 'Synthetic same-generation update' });
      const stalePrivacy = await collectNative(fixture);
      expect(stalePrivacy).toEqual({ status: 'unknown', reason: 'privacy_unavailable' });

      await new Promise((resolve) => setTimeout(resolve, 5));
      await fixture.privacyRef.update({ generation: `rotated-${randomUUID()}` });
      const rotatedPrivacy = await collectNative(fixture);
      expect(rotatedPrivacy).toEqual({ status: 'unknown', reason: 'privacy_unavailable' });

      const currentToken = ownerEditorFirestorePrivacyToken(
        await fixture.privacyRef.get(),
        fixture.ownerId,
      );
      if (!currentToken) throw new Error('Expected complete privacy token');
      const currentCursor = JSON.parse(
        String((await fixture.epochRef.get()).get('cursor')),
      ) as Record<string, unknown>;
      await fixture.epochRef.update({
        cursor: JSON.stringify({
          ...currentCursor,
          ready: false,
          privacyGenerationDigest: ownerEditorPrivacyDigest(currentToken),
        }),
      });
      fixture.scope = { ...fixture.scope, privacyGeneration: currentToken };
      const unreadyEpoch = await collectNative(fixture);
      expect(unreadyEpoch).toEqual({ status: 'unknown', reason: 'epoch_unavailable' });

      await fixture.epochRef.update({
        cursor: JSON.stringify({
          ...currentCursor,
          ready: true,
          privacyGenerationDigest: ownerEditorPrivacyDigest(currentToken),
        }),
      });
      const lineageRef = fixture.store.doc('memoryImportLineage', `lineage-${randomUUID()}`);
      fixture.refs.push(lineageRef);
      await lineageRef.set({ source: 'synthetic', memoryId: fixture.memoryId });
      const newlyShared = await collectNative(fixture);
      expect(newlyShared).toEqual({ status: 'unknown', reason: 'lineage_incomplete' });
    }, 45_000);
  },
);
