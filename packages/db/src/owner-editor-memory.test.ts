import { createHash, randomUUID } from 'node:crypto';
import {
  embeddingSpaceIdentityKey,
  type OwnerEditorClaim,
  type OwnerEditorOperationRecord,
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
} from '@assistant/persistence';
import type { SQL } from 'drizzle-orm';
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import {
  commitPostgresOwnerMemoryCorrection,
  readPostgresOwnerMemoryEditorSnapshot,
} from './owner-editor-memory.js';
import { createPostgresProfileMemoryManagementRepository } from './profile-memory-management-repository.js';
import {
  agents,
  contacts,
  importSources,
  maintenanceCursors,
  memories,
  memoryImportLineage,
  memoryTombstones,
  ownerCard,
  ownerEditorOperations,
} from './schema.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const now = new Date(),
    ownerId = randomUUID(),
    memoryId = randomUUID();
  const scope = {
    ownerId,
    epoch: randomUUID(),
    privacyGeneration: null,
    command: 'correct_owner_memory' as const,
    operationId: randomUUID(),
    targetId: memoryId,
    sessionDigest: 'a'.repeat(64),
    nonce: randomUUID(),
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 600000,
  };
  const claim: OwnerEditorClaim = {
    scope,
    requestHash: 'b'.repeat(64),
    claimToken: randomUUID(),
    claimExpiresAt: new Date(now.getTime() + 60000),
    statusVersion: 1,
  };
  const operation: OwnerEditorOperationRecord = {
    id: ownerEditorOperationId(scope),
    ownerId,
    epoch: scope.epoch,
    privacyGenerationDigest: ownerEditorPrivacyDigest(null),
    scopeDigest: ownerEditorScopeDigest(scope),
    operationId: scope.operationId,
    requestHash: claim.requestHash,
    command: scope.command,
    protocolVersion: 1,
    formIssuedAt: now,
    formExpiresAt: new Date(scope.expiresAt),
    claimToken: claim.claimToken,
    claimExpiresAt: claim.claimExpiresAt,
    status: 'preparing',
    statusVersion: 1,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
  const memory = {
    id: memoryId,
    agentId: ownerId,
    content: 'Original source note',
    contentHash: hash('Original source note'),
    createdAt: now,
    source: 'manual',
    sourceTaskId: null,
    subjectContactId: null,
    category: 'knowledge',
    expiresAt: null,
    supersededById: null,
    quarantined: false,
    kind: 'fact',
    domain: 'home',
    originTrust: 'known',
    ownerConfirmed: false,
    ownerCorrection: null as unknown,
    pinned: false,
    embedding: [1, 0, 0],
    embeddingSpaceKey: embeddingSpaceIdentityKey({
      provider: 'test',
      model: 'unit',
      dimensions: 3,
      revision: '1',
    }),
  };
  const state = {
    memory,
    operation,
    leased: false,
    failReceipt: false,
    nativeSuffix: '123456',
    tombstones: [] as Array<Record<string, unknown>>,
    card: null as Record<string, unknown> | null,
    duplicates: [] as Array<{ id: string }>,
    lineage: [] as Array<Record<string, unknown>>,
    events: [] as string[],
  };
  const dialect = new PgDialect();
  function select(leased: boolean, fields?: Record<string, unknown>) {
    if (state.leased && !leased) throw new Error('Outer pool query while tx owns single lease');
    let table: PgTable, where: SQL | undefined;
    const query = {
      from(value: PgTable) {
        table = value;
        return query;
      },
      where(value: SQL) {
        where = value;
        return query;
      },
      leftJoin() {
        return query;
      },
      orderBy() {
        return query;
      },
      limit() {
        return query;
      },
      for(mode: string) {
        state.events.push(`lock:${mode}`);
        return query;
      },
      // biome-ignore lint/suspicious/noThenProperty: actual Drizzle builders are thenable; this is their offline transport seam.
      then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) {
        try {
          const params = where ? dialect.sqlToQuery(where).params : [];
          let rows: unknown[] = [];
          if (table === agents) rows = [{ id: ownerId }];
          else if (table === maintenanceCursors) {
            if (String(params[0]).startsWith('owner-editor-epoch:'))
              rows = [
                {
                  cursor: JSON.stringify({
                    ownerId,
                    epoch: scope.epoch,
                    ready: true,
                    privacyGenerationDigest: ownerEditorPrivacyDigest(null),
                  }),
                },
              ];
          } else if (table === ownerEditorOperations) {
            state.events.push('receipt-read');
            rows = [state.operation];
          } else if (table === memories) {
            state.events.push('memory-read');
            if (fields?.memory)
              rows = [
                {
                  memory: state.memory,
                  native: JSON.parse(
                    JSON.stringify({
                      ...state.memory,
                      embedding: undefined,
                      created_at: `2026-10-25T00:00:00.${state.nativeSuffix}+00:00`,
                    }),
                  ),
                },
              ];
            else if (fields?.id) rows = state.duplicates;
            else rows = [state.memory];
          } else if (table === memoryImportLineage) rows = state.lineage;
          else if (table === memoryTombstones)
            rows = state.tombstones.filter((row) => row.contentHash === params[0]);
          else if (table === contacts || table === importSources) rows = [];
          else throw new Error('Unexpected unbounded/source query');
          return Promise.resolve(rows).then(resolve, reject);
        } catch (error) {
          return Promise.reject(error).then(resolve, reject);
        }
      },
    };
    return query;
  }
  const tx = {
    select: (fields?: Record<string, unknown>) => select(true, fields),
    execute: async () => {
      state.events.push('card-advisory');
    },
    update(table: PgTable) {
      let values: Record<string, unknown>;
      const query = {
        set(value: Record<string, unknown>) {
          values = value;
          return query;
        },
        where() {
          return query;
        },
        async returning() {
          if (!state.leased) throw new Error('Unleased write');
          if (table === memories) {
            state.events.push('memory-write');
            Object.assign(state.memory, values);
            return [state.memory];
          }
          if (table === ownerEditorOperations) {
            state.events.push('receipt-write');
            if (state.failReceipt) return [];
            Object.assign(state.operation, values);
            return [state.operation];
          }
          throw new Error('Unexpected update');
        },
      };
      return query;
    },
    insert(table: PgTable) {
      const query = {
        values(value: Record<string, unknown>) {
          if (!state.leased) throw new Error('Unleased insert');
          if (table === memoryTombstones) {
            state.events.push('tombstone-write');
            state.tombstones.push(value);
          } else if (table === ownerCard) {
            state.events.push('card-invalidate');
            state.card = value;
          } else throw new Error('Unexpected insert');
          return query;
        },
        onConflictDoNothing: async () => {},
        onConflictDoUpdate: async () => {},
      };
      return query;
    },
  };
  const db = {
    select: (fields?: Record<string, unknown>) => select(false, fields),
    async transaction<T>(run: (transaction: typeof tx) => Promise<T>) {
      if (state.leased) throw new Error('Nested transaction would consume another pool lease');
      const original = structuredClone({
        memory: state.memory,
        operation: state.operation,
        tombstones: state.tombstones,
        card: state.card,
      });
      state.leased = true;
      try {
        return await run(tx);
      } catch (error) {
        Object.assign(state, original);
        throw error;
      } finally {
        state.leased = false;
      }
    },
  } as unknown as Db;
  const read = () =>
    db.transaction((tx) => readPostgresOwnerMemoryEditorSnapshot(tx, ownerId, memoryId));
  return { db, state, claim, now, ownerId, memoryId, read };
}
async function prepared(f: ReturnType<typeof fixture>) {
  const snapshot = await f.read();
  if (!snapshot) throw new Error('Missing snapshot');
  return {
    memoryId: f.memoryId,
    expectedContentHash: snapshot.contentHash,
    expectedMemoryRevision: snapshot.revision,
    content: 'Owner revised note',
    contentHash: hash('Owner revised note'),
    embedding: [1, 0, 0],
    embeddingSpaceKey: f.state.memory.embeddingSpaceKey,
  };
}
describe('actual PG correction/claim/card/receipt on one offline leased transaction', () => {
  it('preserves source identity and uses canonical primitive/marker with no nested/advisory inversion', async () => {
    const f = fixture(),
      input = await prepared(f);
    f.state.events = [];
    expect(await commitPostgresOwnerMemoryCorrection(f.db, f.claim, input, f.now)).toMatchObject({
      outcome: 'saved',
      ids: { memoryId: f.memoryId },
      refreshPending: true,
    });
    expect(f.state.memory).toMatchObject({
      id: f.memoryId,
      source: 'manual',
      sourceTaskId: null,
      subjectContactId: null,
      kind: 'fact',
      domain: 'home',
      content: input.content,
      originTrust: 'owner',
      ownerConfirmed: true,
      ownerCorrection: {
        priorContentHash: input.expectedContentHash,
        currentContentHash: input.contentHash,
      },
    });
    expect(f.state.tombstones).toHaveLength(1);
    expect(f.state.card?.content).toBe('');
    expect(f.state.operation.status).toBe('committed');
    expect(f.state.events).not.toContain('card-advisory');
    expect(f.state.events.indexOf('lock:no key update')).toBeLessThan(
      f.state.events.indexOf('memory-write'),
    );
    expect(f.state.events.indexOf('memory-write')).toBeLessThan(
      f.state.events.indexOf('receipt-write'),
    );
  });
  it('native microsecond change rejects a same-content-hash stale edit before tombstones or primary writes', async () => {
    const f = fixture(),
      input = await prepared(f);
    f.state.nativeSuffix = '123457';
    f.state.events = [];
    expect(await commitPostgresOwnerMemoryCorrection(f.db, f.claim, input, f.now)).toMatchObject({
      outcome: 'conflict',
    });
    expect(f.state.events).not.toContain('memory-write');
    expect(f.state.tombstones).toHaveLength(0);
  });
  it('conditional terminal receipt failure rolls the source/card/tombstone/marker back', async () => {
    const f = fixture(),
      input = await prepared(f),
      before = structuredClone(f.state.memory);
    f.state.failReceipt = true;
    await expect(commitPostgresOwnerMemoryCorrection(f.db, f.claim, input, f.now)).rejects.toThrow(
      'claim changed',
    );
    expect(f.state.memory).toEqual(before);
    expect(f.state.tombstones).toEqual([]);
    expect(f.state.card).toBeNull();
    expect(f.state.operation.status).toBe('preparing');
  });
  it('same text is unchanged without embedding or correction marker writes', async () => {
    const f = fixture(),
      input = await prepared(f);
    input.content = f.state.memory.content;
    input.contentHash = f.state.memory.contentHash;
    f.state.events = [];
    expect(await commitPostgresOwnerMemoryCorrection(f.db, f.claim, input, f.now)).toMatchObject({
      outcome: 'unchanged',
    });
    expect(f.state.memory.ownerCorrection).toBeNull();
    expect(f.state.events).not.toContain('memory-write');
    expect(f.state.card).toBeNull();
  });
  it('same-text receipt preserves an existing correction marker exactly', async () => {
    const f = fixture();
    const marker = {
      version: 1,
      correctedByOwner: true,
      priorContentHash: hash('An earlier saved note'),
      currentContentHash: f.state.memory.contentHash,
      correctedAt: new Date('2026-10-25T12:00:00.000Z').toISOString(),
    };
    f.state.memory.ownerCorrection = marker;
    const input = await prepared(f);
    input.content = f.state.memory.content;
    input.contentHash = f.state.memory.contentHash;
    f.state.events = [];
    expect(await commitPostgresOwnerMemoryCorrection(f.db, f.claim, input, f.now)).toMatchObject({
      outcome: 'unchanged',
    });
    expect(f.state.memory.ownerCorrection).toEqual(marker);
    expect(f.state.events).not.toContain('memory-write');
  });
  it('duplicate target hash conflicts without partially tombstoning old content', async () => {
    const f = fixture(),
      input = await prepared(f);
    f.state.duplicates = [{ id: randomUUID() }];
    expect(await commitPostgresOwnerMemoryCorrection(f.db, f.claim, input, f.now)).toMatchObject({
      outcome: 'conflict',
    });
    expect(f.state.tombstones).toHaveLength(0);
    expect(f.state.memory.content).toBe('Original source note');
  });
  it('legacy public correct keeps its existing advisory order and uses same marker primitive', async () => {
    const f = fixture(),
      input = await prepared(f);
    f.state.events = [];
    expect(
      await createPostgresProfileMemoryManagementRepository(f.db, f.ownerId).correct(input),
    ).toMatchObject({ status: 'updated' });
    expect(f.state.events[0]).toBe('card-advisory');
    expect(f.state.memory.ownerCorrection).toMatchObject({
      correctedByOwner: true,
      currentContentHash: input.contentHash,
    });
  });
});

it('suppresses correction attribution when body differs from its valid stored marker hash', async () => {
  const f = fixture();
  const marker = {
    version: 1 as const,
    correctedByOwner: true as const,
    priorContentHash: 'a'.repeat(64),
    currentContentHash: f.state.memory.contentHash,
    correctedAt: '2026-10-25T00:00:00.000Z',
  };
  f.state.memory.ownerCorrection = marker;
  f.state.memory.content = 'Altered body';
  expect(await f.read()).toMatchObject({
    eligible: false,
    readOnlyReason: 'memory_content_hash_mismatch',
    ownerCorrection: null,
  });
});
