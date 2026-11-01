import { createHash, randomUUID } from 'node:crypto';
import {
  embeddingSpaceIdentityKey,
  type OwnerEditorClaim,
  type OwnerEditorScope,
  ownerEditorPrivacyDigest,
  type PreparedOwnerMemoryCreation,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { readFirestoreOwnerEditorContact } from './owner-editor-graph.js';
import {
  commitFirestoreOwnerMemoryCreation,
  readFirestoreOwnerMemoryCreationTarget,
} from './owner-editor-memory-create.js';
import { createFirestoreOwnerEditorOperationRepository } from './owner-editor-repository.js';
import { ownerEditorTestStore } from './owner-editor-test-store.js';

const content = 'Ada prefers tea.';
const hash = createHash('sha256').update(content).digest('hex');
function fixture() {
  const f = ownerEditorTestStore();
  const ownerId = randomUUID();
  const subjectContactId = randomUUID();
  const epoch = randomUUID();
  const space = { provider: 'test', model: 'unit', dimensions: 3, revision: '1' };
  const now = new Date();
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
  f.seed('contacts', subjectContactId, {
    id: subjectContactId,
    agentId: ownerId,
    name: 'Ada Example',
    aliases: [],
    trust: 'known',
  });
  const scope: OwnerEditorScope = {
    ownerId,
    epoch,
    privacyGeneration: null,
    command: 'create_owner_memory',
    operationId: randomUUID(),
    targetId: subjectContactId,
    sessionDigest: 'a'.repeat(64),
    nonce: randomUUID(),
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 600_000,
  };
  const prepared: PreparedOwnerMemoryCreation = {
    memoryId: randomUUID(),
    retrievalRevision: randomUUID(),
    subjectContactId,
    expectedSubjectRevision: '',
    content,
    contentHash: hash,
    domain: 'home',
    importance: 3,
    pinned: false,
    embedding: [1, 0, 0],
    embeddingSpaceKey: embeddingSpaceIdentityKey(space),
  };
  const operations = createFirestoreOwnerEditorOperationRepository(f.store, ownerId);
  async function claimFor(useScope = scope): Promise<OwnerEditorClaim> {
    const reserved = await operations.reserve(useScope, 'c'.repeat(64), now);
    if (reserved.kind !== 'claimed') throw new Error(JSON.stringify(reserved));
    return reserved.claim;
  }
  return {
    ...f,
    ownerId,
    subjectContactId,
    epoch,
    space,
    now,
    scope,
    prepared,
    operations,
    claimFor,
  };
}

describe('Firestore owner memory creation transaction (offline fake store)', () => {
  it('commits manual note, hash, card invalidation, and terminal receipt together; replay adopts nothing', async () => {
    const f = fixture();
    const target = await readFirestoreOwnerMemoryCreationTarget(
      f.store,
      f.ownerId,
      f.subjectContactId,
      hash,
      f.scope,
    );
    expect(target).toMatchObject({ status: 'eligible', subjectContactId: f.subjectContactId });
    if (!target) throw new Error('Missing creation target');
    f.prepared.expectedSubjectRevision = target.subjectRevision;
    const claim = await f.claimFor();

    const saved = await commitFirestoreOwnerMemoryCreation(
      f.store,
      f.space,
      claim,
      f.prepared,
      f.now,
    );
    expect(saved).toMatchObject({
      authority: 'operation_receipt',
      outcome: 'saved',
      refreshPending: true,
    });
    expect(f.rows('memories')).toHaveLength(1);
    expect(f.rows('memories')[0]).toMatchObject({
      id: f.prepared.memoryId,
      agentId: f.ownerId,
      subjectContactId: f.subjectContactId,
      content: f.prepared.content,
      contentHash: hash,
      source: 'manual',
      originTrust: 'owner',
      ownerConfirmed: true,
      category: 'knowledge',
      kind: 'fact',
    });
    expect(f.rows('memoryContentHashes')).toEqual([{ memoryId: f.prepared.memoryId }]);
    expect(f.rows('ownerCards')[0]?.content).toBe('');
    expect(f.rows('ownerEditorOperations')[0]?.result).toMatchObject({ outcome: 'saved' });
    expect(f.rows('knowledgeGraphSources')).toHaveLength(0);
    expect(f.rows('knowledgeGraphRelations')).toHaveLength(0);
    expect(
      await commitFirestoreOwnerMemoryCreation(f.store, f.space, claim, f.prepared, f.now),
    ).toEqual(saved);
    expect(f.rows('memories')).toHaveLength(1);
    expect(f.stats.readsAfterWrites).toBe(0);
  });

  it('rechecks exact native subject revision and rejects a changed subject before writes', async () => {
    const f = fixture();
    const target = await readFirestoreOwnerMemoryCreationTarget(
      f.store,
      f.ownerId,
      f.subjectContactId,
      hash,
      f.scope,
    );
    if (!target) throw new Error('Missing creation target');
    f.prepared.expectedSubjectRevision = target.subjectRevision;
    const claim = await f.claimFor();
    f.seed('contacts', f.subjectContactId, {
      id: f.subjectContactId,
      agentId: f.ownerId,
      name: 'Ada Updated',
      aliases: [],
      trust: 'known',
    });

    expect(
      await commitFirestoreOwnerMemoryCreation(f.store, f.space, claim, f.prepared, f.now),
    ).toMatchObject({ outcome: 'conflict' });
    expect(f.rows('memories')).toHaveLength(0);
    expect(f.rows('memoryContentHashes')).toHaveLength(0);
  });

  it('refuses owner/self contacts in preflight and commit, including matching native revision', async () => {
    const f = fixture();
    const beforeSelfCheck = f.stats.raw;
    expect(
      await readFirestoreOwnerMemoryCreationTarget(f.store, f.ownerId, f.ownerId, hash, {
        ...f.scope,
        targetId: f.ownerId,
      }),
    ).toBeNull();
    expect(f.stats.raw).toBe(beforeSelfCheck);

    f.seed('contacts', f.subjectContactId, {
      id: f.subjectContactId,
      agentId: f.ownerId,
      name: 'Owner profile',
      aliases: [],
      trust: 'owner',
    });
    expect(
      await readFirestoreOwnerMemoryCreationTarget(
        f.store,
        f.ownerId,
        f.subjectContactId,
        hash,
        f.scope,
      ),
    ).toBeNull();
    const ownerContact = await readFirestoreOwnerEditorContact(
      f.store,
      f.ownerId,
      f.subjectContactId,
    );
    if (!ownerContact) throw new Error('Owner contact fixture missing');
    f.prepared.expectedSubjectRevision = ownerContact.revision;
    const claim = await f.claimFor();

    expect(
      await commitFirestoreOwnerMemoryCreation(f.store, f.space, claim, f.prepared, f.now),
    ).toMatchObject({ outcome: 'conflict' });
    expect(f.rows('memories')).toHaveLength(0);
    expect(f.rows('memoryContentHashes')).toHaveLength(0);
    expect(f.rows('ownerCards')).toHaveLength(0);
  });

  it('refuses content already tombstoned or hashed and never adopts the old memory', async () => {
    for (const prior of ['memoryTombstones', 'memoryContentHashes'] as const) {
      const f = fixture();
      const target = await readFirestoreOwnerMemoryCreationTarget(
        f.store,
        f.ownerId,
        f.subjectContactId,
        hash,
        f.scope,
      );
      if (!target) throw new Error('Missing creation target');
      expect(target.status).toBe('eligible');
      f.prepared.expectedSubjectRevision = target.subjectRevision;
      f.seed(
        prior,
        hash,
        prior === 'memoryTombstones' ? { contentHash: hash } : { memoryId: randomUUID() },
      );
      expect(
        await readFirestoreOwnerMemoryCreationTarget(
          f.store,
          f.ownerId,
          f.subjectContactId,
          hash,
          f.scope,
        ),
      ).toMatchObject({ status: prior === 'memoryTombstones' ? 'tombstoned' : 'duplicate' });
      const claim = await f.claimFor();
      expect(
        await commitFirestoreOwnerMemoryCreation(f.store, f.space, claim, f.prepared, f.now),
      ).toMatchObject({ outcome: 'conflict' });
      expect(f.rows('memories')).toHaveLength(0);
    }
  });

  it('allows at most one of two independent claims for the same global content hash', async () => {
    const f = fixture();
    const target = await readFirestoreOwnerMemoryCreationTarget(
      f.store,
      f.ownerId,
      f.subjectContactId,
      hash,
      f.scope,
    );
    if (!target) throw new Error('Missing creation target');
    f.prepared.expectedSubjectRevision = target.subjectRevision;
    const firstClaim = await f.claimFor();
    const first = await commitFirestoreOwnerMemoryCreation(
      f.store,
      f.space,
      firstClaim,
      f.prepared,
      f.now,
    );
    expect(first).toMatchObject({ outcome: 'saved' });

    const secondScope = { ...f.scope, operationId: randomUUID(), nonce: randomUUID() };
    const secondClaim = await f.claimFor(secondScope);
    const secondPrepared = {
      ...f.prepared,
      memoryId: randomUUID(),
      retrievalRevision: randomUUID(),
    };
    expect(
      await commitFirestoreOwnerMemoryCreation(
        f.store,
        f.space,
        secondClaim,
        secondPrepared,
        f.now,
      ),
    ).toMatchObject({ authority: 'operation_receipt', outcome: 'conflict' });
    expect(f.rows('memories')).toHaveLength(1);
    expect(f.rows('memoryContentHashes')).toHaveLength(1);
  });

  it('rolls back primary, hash, card, and receipt if terminal receipt staging fails', async () => {
    const f = fixture();
    const target = await readFirestoreOwnerMemoryCreationTarget(
      f.store,
      f.ownerId,
      f.subjectContactId,
      hash,
      f.scope,
    );
    if (!target) throw new Error('Missing creation target');
    f.prepared.expectedSubjectRevision = target.subjectRevision;
    const claim = await f.claimFor();
    f.stats.failReceipt = true;
    await expect(
      commitFirestoreOwnerMemoryCreation(f.store, f.space, claim, f.prepared, f.now),
    ).rejects.toThrow('Injected receipt write failure');
    expect(f.rows('memories')).toHaveLength(0);
    expect(f.rows('memoryContentHashes')).toHaveLength(0);
    expect(f.rows('ownerCards')).toHaveLength(0);
    expect(f.rows('ownerEditorOperations')[0]?.status).toBe('preparing');
  });

  it('recovers a lost response from the same claim receipt without a second memory', async () => {
    const f = fixture();
    const target = await readFirestoreOwnerMemoryCreationTarget(
      f.store,
      f.ownerId,
      f.subjectContactId,
      hash,
      f.scope,
    );
    if (!target) throw new Error('Missing creation target');
    f.prepared.expectedSubjectRevision = target.subjectRevision;
    const claim = await f.claimFor();
    const run = f.store.db.runTransaction.bind(f.store.db);
    let lose = true;
    (f.store.db as unknown as { runTransaction: typeof run }).runTransaction = async (callback) => {
      const result = await run(callback);
      if (lose) {
        lose = false;
        throw new Error('Synthetic lost response after commit');
      }
      return result;
    };
    await expect(
      commitFirestoreOwnerMemoryCreation(f.store, f.space, claim, f.prepared, f.now),
    ).rejects.toThrow('Synthetic lost response after commit');
    const recovered = await commitFirestoreOwnerMemoryCreation(
      f.store,
      f.space,
      claim,
      f.prepared,
      f.now,
    );
    expect(recovered).toMatchObject({ outcome: 'saved' });
    expect((await f.operations.lookup(f.scope, new Date())).reply).toEqual(recovered);
    expect(f.rows('memories')).toHaveLength(1);
  });

  it('rejects a tampered prepared hash before opening the native transaction', async () => {
    const f = fixture();
    const target = await readFirestoreOwnerMemoryCreationTarget(
      f.store,
      f.ownerId,
      f.subjectContactId,
      hash,
      f.scope,
    );
    if (!target) throw new Error('Missing creation target');
    f.prepared.expectedSubjectRevision = target.subjectRevision;
    f.prepared.contentHash = 'd'.repeat(64);
    const claim = await f.claimFor();
    const readsBeforeCommit = f.stats.raw;
    expect(() =>
      commitFirestoreOwnerMemoryCreation(f.store, f.space, claim, f.prepared, f.now),
    ).toThrow('Prepared memory content hash mismatch');
    expect(f.stats.raw).toBe(readsBeforeCommit);
    expect(f.rows('memories')).toHaveLength(0);
  });

  it('rejects invalid transaction and claim dates before native writes', async () => {
    const f = fixture();
    const target = await readFirestoreOwnerMemoryCreationTarget(
      f.store,
      f.ownerId,
      f.subjectContactId,
      hash,
      f.scope,
    );
    if (!target) throw new Error('Missing creation target');
    f.prepared.expectedSubjectRevision = target.subjectRevision;
    const claim = await f.claimFor();
    expect(() =>
      commitFirestoreOwnerMemoryCreation(f.store, f.space, claim, f.prepared, new Date(Number.NaN)),
    ).toThrow('Prepared memory creation failed validation');
    expect(() =>
      commitFirestoreOwnerMemoryCreation(
        f.store,
        f.space,
        { ...claim, claimExpiresAt: new Date(Number.NaN) },
        f.prepared,
        f.now,
      ),
    ).toThrow('Prepared memory creation failed validation');
    expect(f.rows('memories')).toHaveLength(0);
  });

  it('does not write when privacy generation changed after preparation', async () => {
    const f = fixture();
    const target = await readFirestoreOwnerMemoryCreationTarget(
      f.store,
      f.ownerId,
      f.subjectContactId,
      hash,
      f.scope,
    );
    if (!target) throw new Error('Missing creation target');
    f.prepared.expectedSubjectRevision = target.subjectRevision;
    const claim = await f.claimFor();
    f.seed('privacyErasureJobs', f.ownerId, {
      agentId: f.ownerId,
      generation: randomUUID(),
      status: 'complete',
    });
    expect(
      await commitFirestoreOwnerMemoryCreation(f.store, f.space, claim, f.prepared, f.now),
    ).toMatchObject({ authority: 'scope_retirement', outcome: 'voided' });
    expect(f.rows('memories')).toHaveLength(0);
  });

  it('does not write after the reserved claim lease expires', async () => {
    const f = fixture();
    const target = await readFirestoreOwnerMemoryCreationTarget(
      f.store,
      f.ownerId,
      f.subjectContactId,
      hash,
      f.scope,
    );
    if (!target) throw new Error('Missing creation target');
    f.prepared.expectedSubjectRevision = target.subjectRevision;
    const claim = await f.claimFor();
    const expiredAt = new Date(claim.claimExpiresAt.getTime() + 1);

    const result = await commitFirestoreOwnerMemoryCreation(
      f.store,
      f.space,
      claim,
      f.prepared,
      expiredAt,
    );
    expect(result.outcome).not.toBe('saved');
    expect(f.rows('memories')).toHaveLength(0);
    expect(f.rows('memoryContentHashes')).toHaveLength(0);
  });
});
