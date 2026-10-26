import { createHash, randomUUID } from 'node:crypto';
import {
  embeddingSpaceIdentityKey,
  type OwnerEditorApply,
  type OwnerEditorScope,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  type Records,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { applyOwnerEditorCommand } from '../../application/src/owner-editor.js';
import { createOwnerEditorDomain } from '../../application/src/owner-editor-domain.js';
import { ownerEditorRequestHash } from '../../application/src/owner-editor-hash.js';
import {
  ownerEditorPath,
  parseOwnerEditorRequest,
} from '../../application/src/owner-editor-wire.js';
import { createFirestoreOwnerEditorDomainStorage } from './owner-editor-domain.js';
import { readFirestoreOwnerMemoryEditorSnapshot } from './owner-editor-memory.js';
import { createFirestoreOwnerEditorOperationRepository } from './owner-editor-repository.js';
import { ownerEditorTestStore } from './owner-editor-test-store.js';
import { FirestoreProfileMemoryManagementRepository } from './profile-memory-management.js';
import { decodeRecord } from './store.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const f = ownerEditorTestStore(),
    ownerId = randomUUID(),
    memoryId = randomUUID(),
    epoch = randomUUID(),
    now = new Date();
  const space = { provider: 'test', model: 'unit', dimensions: 3, revision: '1' };
  f.seed('agents', ownerId, { id: ownerId });
  f.seed('maintenanceCursors', `owner-editor-epoch:${ownerId}`, {
    name: `owner-editor-epoch:${ownerId}`,
    cursor: JSON.stringify({
      ownerId,
      epoch,
      ready: true,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
    }),
  });
  const memory: Records['memories'] = {
    id: memoryId,
    agentId: ownerId,
    createdAt: now,
    content: 'Original saved note',
    contentHash: hash('Original saved note'),
    category: 'knowledge',
    source: 'manual',
    sourceTaskId: null,
    subjectContactId: null,
    expiresAt: null,
    supersededById: null,
    quarantined: false,
    kind: 'fact',
    domain: 'home',
    originTrust: 'known',
    ownerConfirmed: false,
    confidence: '0.70',
    importance: 3,
    pinned: false,
    validFrom: null,
    validUntil: null,
    goalId: null,
    embedding: [1, 0, 0],
    embeddingSpaceKey: embeddingSpaceIdentityKey(space),
    lastAccessedAt: null,
    lastConsolidatedAt: null,
  };
  const seed = (patch: Partial<Records['memories']> = {}) =>
    f.seed('memories', memoryId, { ...memory, ...patch });
  seed();
  const embed = vi.fn(async (_texts: string[]) => [[1, 0, 0]]);
  const actualStorage = createFirestoreOwnerEditorDomainStorage(f.store, ownerId, space);
  const domain = createOwnerEditorDomain({
    storage: { ...actualStorage, memoryFollowup: undefined },
    router: { embed, embeddingSpace: async () => space },
  });
  const operations = createFirestoreOwnerEditorOperationRepository(f.store, ownerId);
  const read = () => readFirestoreOwnerMemoryEditorSnapshot(f.store, ownerId, memoryId);
  async function request(): Promise<
    Extract<OwnerEditorApply, { command: 'correct_owner_memory' }>
  > {
    const snapshot = await read();
    if (!snapshot) throw new Error('Missing source');
    return {
      version: 1,
      intent: 'apply',
      command: 'correct_owner_memory',
      operationId: randomUUID(),
      memoryId,
      expectedContentHash: snapshot.contentHash,
      expectedMemoryRevision: snapshot.revision,
      content: 'Revised saved note',
    };
  }
  const scope = (request: OwnerEditorApply): OwnerEditorScope => ({
    ownerId,
    epoch,
    privacyGeneration: null,
    command: request.command,
    operationId: request.operationId,
    targetId: memoryId,
    sessionDigest: 'a'.repeat(64),
    nonce: randomUUID(),
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 600000,
  });
  async function run(request: OwnerEditorApply, issued = scope(request)) {
    const parsed = parseOwnerEditorRequest(request, ownerEditorPath(request.command));
    if (!parsed.ok || parsed.request.intent !== 'apply') throw new Error(JSON.stringify(parsed));
    return applyOwnerEditorCommand({ request: parsed.request, scope: issued, domain, operations });
  }
  return {
    ...f,
    rawSeed: f.seed,
    ownerId,
    memoryId,
    epoch,
    memory,
    space,
    seed,
    embed,
    read,
    request,
    scope,
    run,
    operations,
    domain,
  };
}
describe('actual FS saved-note domain + claim + legacy correction primitive offline', () => {
  it('atomically saves same ID, prior tombstone/hash binding/marker/card invalidation and compact receipt, then replays with zero extra embedding', async () => {
    const f = fixture(),
      request = await f.request(),
      scope = f.scope(request),
      before = f.memory;
    const saved = await f.run(request, scope);
    expect(saved).toMatchObject({
      authority: 'operation_receipt',
      outcome: 'saved',
      ids: { memoryId: f.memoryId },
      refreshPending: true,
    });
    const after = decodeRecord<Records['memories']>(f.rows('memories')[0]);
    expect(after).toMatchObject({
      id: f.memoryId,
      content: request.content,
      contentHash: hash(request.content),
      source: before.source,
      sourceTaskId: before.sourceTaskId,
      subjectContactId: before.subjectContactId,
      kind: before.kind,
      domain: before.domain,
      originTrust: 'owner',
      ownerConfirmed: true,
      ownerCorrection: {
        version: 1,
        correctedByOwner: true,
        priorContentHash: before.contentHash,
        currentContentHash: hash(request.content),
      },
    });
    expect(f.rows('memoryTombstones')).toHaveLength(1);
    expect(f.rows('memoryContentHashes')).toEqual([{ memoryId: f.memoryId }]);
    expect(f.rows('ownerCards')[0]?.content).toBe('');
    expect(await f.run(request, scope)).toEqual(saved);
    expect(f.embed).toHaveBeenCalledTimes(1);
    expect(f.stats.readsAfterWrites).toBe(0);
    expect(JSON.stringify(f.rows('ownerEditorOperations'))).not.toContain(request.content);
  });
  it('a proven atomic save remains saved when the actual domain follow-up queue fails', async () => {
    const f = fixture(),
      request = await f.request(),
      scope = f.scope(request);
    const storage = createFirestoreOwnerEditorDomainStorage(f.store, f.ownerId, f.space);
    const queue = vi.fn(async () => {
      throw new Error('Synthetic graph refresh unavailable');
    });
    storage.memoryFollowup.maintenance.queueGraphSync = queue;
    const domain = createOwnerEditorDomain({
      storage,
      router: { embeddingSpace: async () => f.space, embed: f.embed },
    });
    const saved = await applyOwnerEditorCommand({
      request,
      scope,
      operations: f.operations,
      domain,
    });
    expect(saved).toMatchObject({
      authority: 'operation_receipt',
      outcome: 'saved',
      refreshPending: true,
    });
    expect((await f.operations.lookup(scope, new Date())).reply).toEqual(saved);
    expect(f.rows('memories')[0]?.content).toBe(request.content);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(
      await applyOwnerEditorCommand({ request, scope, operations: f.operations, domain }),
    ).toEqual(saved);
    expect(queue).toHaveBeenCalledTimes(1);
  });
  it('legacy public correction also records the durable marker without changing original source provenance', async () => {
    const f = fixture(),
      content = 'Legacy explicit owner correction';
    expect(
      await new FirestoreProfileMemoryManagementRepository(f.store, f.space).correct({
        memoryId: f.memoryId,
        expectedContentHash: f.memory.contentHash,
        content,
        contentHash: hash(content),
        embedding: [1, 0, 0],
        embeddingSpaceKey: embeddingSpaceIdentityKey(f.space),
      }),
    ).toMatchObject({ status: 'updated' });
    expect(f.rows('memories')[0]).toMatchObject({
      source: f.memory.source,
      sourceTaskId: f.memory.sourceTaskId,
      ownerCorrection: {
        correctedByOwner: true,
        priorContentHash: f.memory.contentHash,
        currentContentHash: hash(content),
      },
    });
    expect(f.stats.readsAfterWrites).toBe(0);
  });
  it('same text returns unchanged without inventing marker, embedding or primary/card writes', async () => {
    const f = fixture(),
      request = await f.request();
    request.content = f.memory.content;
    expect(await f.run(request)).toMatchObject({ outcome: 'unchanged' });
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.rows('memories')[0]?.ownerCorrection).toBeUndefined();
    expect(f.rows('memoryTombstones')).toHaveLength(0);
    expect(f.rows('ownerCards')).toHaveLength(0);
  });
  it('same-text receipt preserves a valid existing correction marker without a new embedding', async () => {
    const f = fixture();
    const marker = {
      version: 1,
      correctedByOwner: true,
      priorContentHash: hash('An earlier saved note'),
      currentContentHash: f.memory.contentHash,
      correctedAt: new Date('2026-10-25T12:00:00.000Z').toISOString(),
    } as const;
    f.seed({ ownerCorrection: marker });
    const request = await f.request();
    request.content = f.memory.content;
    expect(await f.run(request)).toMatchObject({ outcome: 'unchanged' });
    expect(f.rows('memories')[0]?.ownerCorrection).toEqual(marker);
    expect(f.embed).not.toHaveBeenCalled();
  });
  it('same-hash native source change is stale before embedding rather than silently refreshed', async () => {
    const f = fixture(),
      request = await f.request();
    f.seed({ pinned: true });
    expect(await f.run(request)).toMatchObject({ outcome: 'conflict' });
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.rows('memoryTombstones')).toHaveLength(0);
  });
  it('rechecks actual native lifecycle/proof after slow embedding', async () => {
    const f = fixture(),
      request = await f.request();
    f.embed.mockImplementation(async () => {
      f.seed({ supersededById: randomUUID() });
      return [[1, 0, 0]];
    });
    expect(await f.run(request)).toMatchObject({ outcome: 'conflict' });
    expect(f.rows('memories')[0]?.content).toBe(f.memory.content);
    expect(f.rows('memoryTombstones')).toHaveLength(0);
  });
  it('a completed privacy generation invalidates held preparation without recreating erased source or receipt', async () => {
    const f = fixture(),
      request = await f.request(),
      scope = f.scope(request);
    f.embed.mockImplementation(async () => {
      f.rawSeed('privacyErasureJobs', f.ownerId, {
        agentId: f.ownerId,
        generation: randomUUID(),
        status: 'complete',
      });
      f.remove('memories', f.memoryId);
      f.remove('ownerEditorOperations', ownerEditorOperationId(scope));
      return [[1, 0, 0]];
    });
    expect(await f.run(request, scope)).toMatchObject({
      outcome: 'voided',
      authority: 'scope_retirement',
    });
    expect(f.rows('memories')).toHaveLength(0);
    expect(f.rows('ownerEditorOperations')).toHaveLength(0);
    expect(f.rows('memoryTombstones')).toHaveLength(0);
  });
  it('receipt write failure rolls back content, tombstone, hash marker, card and epoch touch together', async () => {
    const f = fixture(),
      request = await f.request();
    f.embed.mockImplementation(async () => {
      f.stats.failReceipt = true;
      return [[1, 0, 0]];
    });
    expect(await f.run(request)).toMatchObject({ outcome: 'outcome_unknown' });
    expect(f.rows('memories')[0]?.content).toBe(f.memory.content);
    expect(f.rows('memoryTombstones')).toHaveLength(0);
    expect(f.rows('memoryContentHashes')).toHaveLength(0);
    expect(f.rows('ownerCards')).toHaveLength(0);
    expect(f.rows('ownerEditorOperations')[0]?.status).toBe('preparing');
    expect(f.stats.readsAfterWrites).toBe(0);
  });
  it.each(['unknown', null] as const)(
    'unknown provenance %s stays readable without grant or embedding',
    async (source) => {
      const f = fixture();
      f.seed({ source });
      const snapshot = await f.read();
      expect(snapshot).toMatchObject({
        content: f.memory.content,
        eligible: false,
        readOnlyReason: 'unknown_provenance',
      });
      expect(await f.run(await f.request())).toMatchObject({ outcome: 'conflict' });
      expect(f.embed).not.toHaveBeenCalled();
    },
  );
  it('task ID alone is insufficient; exact owned conversation/user-message relationship enables extracted note', async () => {
    const f = fixture(),
      taskId = randomUUID(),
      conversationId = randomUUID(),
      messageId = randomUUID(),
      text = 'A source chat message';
    f.seed({ source: 'extraction', sourceTaskId: taskId });
    f.rawSeed('tasks', taskId, {
      id: taskId,
      agentId: f.ownerId,
      conversationId,
      trigger: { source: 'chat', agentId: f.ownerId, payload: { text } },
    });
    expect((await f.read())?.eligible).toBe(false);
    f.rawSeed('conversations', conversationId, { id: conversationId, agentId: f.ownerId });
    f.rawSeed('messages', messageId, {
      id: messageId,
      taskId,
      conversationId,
      role: 'user',
      origin: 'owner',
      text,
    });
    expect(await f.read()).toMatchObject({ eligible: true, sourceLabel: 'Extracted saved note' });
    expect(await f.run(await f.request())).toMatchObject({ outcome: 'saved' });
    expect(decodeRecord<Records['memories']>(f.rows('memories')[0])).toMatchObject({
      source: 'extraction',
      sourceTaskId: taskId,
      ownerCorrection: { correctedByOwner: true },
    });
  });
  it('single canonical imported source and strict unit permit owner correction while multi-unit/shared/foreign provenance stays readonly', async () => {
    const f = fixture(),
      source = 'test-archive',
      sourceId = randomUUID();
    f.seed({ source });
    const lineageId = hash(JSON.stringify([source, f.memoryId]));
    const unit = {
      sourceOffset: 0,
      unitOffset: 0,
      observedAt: null,
      authorEmail: null,
      header: 'Synthetic source',
      hasQuotedContent: false,
      unitTextHash: hash('source unit'),
    };
    f.rawSeed('importSources', sourceId, {
      id: sourceId,
      agentId: f.ownerId,
      source,
      status: 'done',
    });
    const lineage = {
      agentId: f.ownerId,
      memoryId: f.memoryId,
      source,
      sourceUnitProvenance: [unit],
      createdAt: new Date(),
    };
    f.rawSeed('memoryImportLineage', lineageId, lineage);
    expect(await f.read()).toMatchObject({ eligible: true, sourceLabel: 'Imported saved note' });
    const original = await f.request();
    f.rawSeed('memoryImportLineage', lineageId, {
      ...lineage,
      sourceUnitProvenance: [unit, { ...unit, unitOffset: 1 }],
    });
    expect((await f.read())?.eligible).toBe(false);
    expect(await f.run(original)).toMatchObject({ outcome: 'conflict' });
    expect(f.embed).not.toHaveBeenCalled();
    f.rawSeed('memoryImportLineage', lineageId, lineage);
    f.rawSeed('importSources', sourceId, {
      id: sourceId,
      agentId: randomUUID(),
      source,
      status: 'done',
    });
    expect((await f.read())?.eligible).toBe(false);
    f.rawSeed('importSources', sourceId, {
      id: sourceId,
      agentId: f.ownerId,
      source,
      status: 'done',
    });
    expect(await f.run(await f.request())).toMatchObject({ outcome: 'saved' });
    expect(f.rows('importSources')[0]?.source).toBe(source);
    expect(f.rows('memoryImportLineage')[0]?.sourceUnitProvenance).toEqual([unit]);
  });
  it.each(['id', 'agentId'] as const)(
    'rejects a conflicting stored lineage %s despite its canonical physical key',
    async (field) => {
      const f = fixture(),
        source = 'exact-import',
        sourceId = randomUUID();
      f.seed({ source });
      const id = hash(JSON.stringify([source, f.memoryId]));
      f.rawSeed('importSources', sourceId, {
        id: sourceId,
        agentId: f.ownerId,
        source,
        status: 'done',
      });
      f.rawSeed('memoryImportLineage', id, {
        source,
        memoryId: f.memoryId,
        sourceUnitProvenance: [],
        [field]: randomUUID(),
      });
      await expect(f.read()).rejects.toThrow('Memory lineage binding unavailable');
      expect(f.embed).not.toHaveBeenCalled();
    },
  );
  it('raw provenance sentinel fails unavailable with no partial capability or embedding', async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      const source = `archive-${i}`,
        id = hash(JSON.stringify([source, f.memoryId]));
      f.rawSeed('memoryImportLineage', id, {
        id,
        source,
        memoryId: f.memoryId,
        sourceUnitProvenance: [],
      });
    }
    expect(await f.read()).toMatchObject({
      eligible: false,
      readOnlyReason: 'incomplete_provenance',
    });
    expect(await f.run(await f.request())).toMatchObject({ outcome: 'unavailable' });
    expect(f.embed).not.toHaveBeenCalled();
  });
  it('forgotten and duplicate target hashes never partially tombstone the original note', async () => {
    for (const table of ['memoryTombstones', 'memoryContentHashes']) {
      const f = fixture(),
        request = await f.request(),
        target = hash(request.content);
      f.rawSeed(
        table,
        target,
        table === 'memoryTombstones'
          ? { id: target, contentHash: target, reason: 'owner_forget' }
          : { memoryId: randomUUID() },
      );
      expect(await f.run(request)).toMatchObject({ outcome: 'conflict' });
      expect(f.rows('memories')[0]?.content).toBe(f.memory.content);
      expect(
        f.rows('memoryTombstones').some((row) => row.contentHash === f.memory.contentHash),
      ).toBe(false);
    }
  });
  it('malformed correction attribution is visible as unproven, never an editing capability', async () => {
    const f = fixture();
    f.seed({
      ownerCorrection: {
        version: 1,
        correctedByOwner: true,
        priorContentHash: 'a'.repeat(64),
        currentContentHash: 'b'.repeat(64),
        correctedAt: new Date().toISOString(),
      },
    });
    expect(await f.read()).toMatchObject({
      eligible: false,
      readOnlyReason: 'malformed_owner_correction',
      ownerCorrection: null,
    });
    expect(await f.run(await f.request())).toMatchObject({ outcome: 'conflict' });
    expect(f.embed).not.toHaveBeenCalled();
  });
});

it('suppresses correction attribution when body differs from its valid stored marker hash', async () => {
  const f = fixture();
  const marker = {
    version: 1 as const,
    correctedByOwner: true as const,
    priorContentHash: 'a'.repeat(64),
    currentContentHash: f.memory.contentHash,
    correctedAt: '2026-10-25T00:00:00.000Z',
  };
  f.seed({ ownerCorrection: marker, content: 'Altered body' });
  expect(await f.read()).toMatchObject({
    eligible: false,
    readOnlyReason: 'memory_content_hash_mismatch',
    ownerCorrection: null,
  });
});
