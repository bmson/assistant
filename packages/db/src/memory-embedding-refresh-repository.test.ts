import { createHash, randomUUID } from 'node:crypto';
import { refreshMemoryEmbeddingPage } from '@assistant/core';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { createPostgresMemoryEmbeddingRefreshRepository } from './memory-embedding-refresh-repository.js';
import { lockPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import {
  agents,
  maintenanceCursors,
  memories,
  memoryEmbeddingRefreshes,
  memoryTombstones,
} from './schema.js';

const url = process.env.DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Requires isolated _test database');
const vector = (head: number) =>
  Array.from({ length: 1536 }, (_, index) => (index === 0 ? head : 0));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('PostgreSQL completed-memory embedding refresh', () => {
  it('rejects a Firestore-only refresh width before writing a receipt', async () => {
    const db = createDb(url);
    const [agent] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!agent) throw new Error('Seed the isolated database');
    const repository = createPostgresMemoryEmbeddingRefreshRepository(db);
    const memoryId = randomUUID();
    const contentHash = hash(`postgres-width-preflight:${randomUUID()}`);
    const targetSpace = {
      provider: 'test',
      model: 'firestore-only-refresh',
      dimensions: 2048,
      revision: '1',
    } as const;
    await db.insert(memories).values({
      id: memoryId,
      agentId: agent.id,
      category: 'knowledge',
      kind: 'fact',
      content: 'PostgreSQL remains fixed at 1536 dimensions.',
      contentHash,
      embedding: vector(1),
      embeddingSpaceKey: hash('old-width-preflight'),
    });
    try {
      let embedCalls = 0;
      await expect(
        refreshMemoryEmbeddingPage({
          repository,
          agentId: agent.id,
          targetSpace,
          targetSpaceKey: embeddingSpaceIdentityKey(targetSpace),
          batch: 1,
          embed: async () => {
            embedCalls += 1;
            return vector(0.5);
          },
        }),
      ).rejects.toThrow('Invalid memory embedding refresh claim');
      expect(embedCalls).toBe(0);
      expect(
        await db
          .select()
          .from(memoryEmbeddingRefreshes)
          .where(eq(memoryEmbeddingRefreshes.memoryId, memoryId)),
      ).toEqual([]);
    } finally {
      await db.delete(memories).where(eq(memories.id, memoryId));
      await db.$client.end();
    }
  });

  it('resumes prepared output, fences changed source, and requires explicit review after an ambiguous attempt', async () => {
    const db = createDb(url);
    const agent = {
      id: randomUUID(),
      name: `embedding-refresh-${randomUUID().slice(0, 8)}`,
      email: `${randomUUID()}@embedding-refresh.invalid`,
      workspacePrefix: `embedding-refresh/${randomUUID()}`,
    };
    await db.insert(agents).values(agent);
    const repository = createPostgresMemoryEmbeddingRefreshRepository(db);
    const targetSpace = {
      provider: 'test',
      model: 'refresh',
      dimensions: 1536,
      revision: '2',
    } as const;
    const target = embeddingSpaceIdentityKey(targetSpace);
    const oldSpace = hash('old-space');
    const now = new Date('2026-10-07T12:00:00Z');
    const ids: string[] = [];
    const hashes: string[] = [];
    const makeMemory = async (label: string) => {
      const id = randomUUID();
      const contentHash = hash(`${label}:${randomUUID()}`);
      ids.push(id);
      hashes.push(contentHash);
      await db.insert(memories).values({
        id,
        agentId: agent.id,
        category: 'knowledge',
        kind: 'fact',
        content: `Completed memory ${label}`,
        contentHash,
        embedding: vector(1),
        embeddingSpaceKey: oldSpace,
      });
      return { id, contentHash, content: `Completed memory ${label}` };
    };
    try {
      const preparedSource = await makeMemory('prepared-restart');
      const claim = await repository.claim({
        agentId: agent.id,
        memoryId: preparedSource.id,
        sourceHash: preparedSource.contentHash,
        targetSpaceKey: target,
        targetDimensions: 1536,
        now,
        leaseUntil: new Date(now.getTime() + 60_000),
      });
      expect(claim.kind).toBe('claimed');
      if (claim.kind !== 'claimed' || !claim.receipt.claimToken) throw new Error('Claim failed');
      await repository.savePrepared({
        agentId: agent.id,
        receiptId: claim.receipt.id,
        claimToken: claim.receipt.claimToken,
        vector: vector(0.5),
        now,
      });
      let embedCalls = 0;
      const resumed = await refreshMemoryEmbeddingPage({
        repository,
        agentId: agent.id,
        targetSpace,
        targetSpaceKey: target,
        batch: 5,
        embed: async () => {
          embedCalls += 1;
          return vector(0.25);
        },
        now: () => new Date(now.getTime() + 2),
      });
      expect(resumed.resumed).toBe(1);
      expect(resumed.applied).toBe(1);
      expect(embedCalls).toBe(0);
      const [refreshed] = await db
        .select()
        .from(memories)
        .where(eq(memories.id, preparedSource.id));
      expect(refreshed?.embeddingSpaceKey).toBe(target);
      expect(refreshed?.embedding?.[0]).toBe(0.5);
      const noOpReplay = await refreshMemoryEmbeddingPage({
        repository,
        agentId: agent.id,
        targetSpace,
        targetSpaceKey: target,
        batch: 5,
        embed: async () => {
          embedCalls += 1;
          return vector(0.25);
        },
        now: () => new Date(now.getTime() + 2),
      });
      expect(noOpReplay).toMatchObject({ done: true, applied: 0, embedded: 0 });
      expect(embedCalls).toBe(0);

      const changedSource = await makeMemory('source-edit');
      const pending = await repository.claim({
        agentId: agent.id,
        memoryId: changedSource.id,
        sourceHash: changedSource.contentHash,
        targetSpaceKey: target,
        targetDimensions: 1536,
        now,
        leaseUntil: new Date(now.getTime() + 60_000),
      });
      if (pending.kind !== 'claimed' || !pending.receipt.claimToken)
        throw new Error('Claim failed');
      await repository.savePrepared({
        agentId: agent.id,
        receiptId: pending.receipt.id,
        claimToken: pending.receipt.claimToken,
        vector: vector(0.75),
        now,
      });
      const changedHash = hash(`edited:${randomUUID()}`);
      hashes.push(changedHash);
      await db
        .update(memories)
        .set({ content: 'Edited after embedding', contentHash: changedHash })
        .where(eq(memories.id, changedSource.id));
      expect(
        await repository.applyPrepared({
          agentId: agent.id,
          memoryId: changedSource.id,
          sourceHash: changedSource.contentHash,
          targetSpaceKey: target,
          receiptId: pending.receipt.id,
          now: new Date(now.getTime() + 3),
        }),
      ).toBe('stale');
      const [staleReceipt] = await db
        .select()
        .from(memoryEmbeddingRefreshes)
        .where(eq(memoryEmbeddingRefreshes.id, pending.receipt.id));
      expect(staleReceipt?.status).toBe('stale');
      await db.delete(memories).where(eq(memories.id, changedSource.id));

      const ambiguousSource = await makeMemory('ambiguous-attempt');
      const expiredClaim = await repository.claim({
        agentId: agent.id,
        memoryId: ambiguousSource.id,
        sourceHash: ambiguousSource.contentHash,
        targetSpaceKey: target,
        targetDimensions: 1536,
        now: new Date(now.getTime() - 10_000),
        leaseUntil: new Date(now.getTime() - 1_000),
      });
      if (expiredClaim.kind !== 'claimed') throw new Error('Claim failed');
      embedCalls = 0;
      const held = await refreshMemoryEmbeddingPage({
        repository,
        agentId: agent.id,
        targetSpace,
        targetSpaceKey: target,
        batch: 5,
        embed: async () => {
          embedCalls += 1;
          return vector(0.9);
        },
        now: () => now,
      });
      expect(embedCalls).toBe(0);
      expect(held.needsReview).toBe(1);
      const unknown = await repository.listUnknown(agent.id, 10);
      const receipt = unknown.find((row) => row.memoryId === ambiguousSource.id);
      expect(receipt?.status).toBe('unknown');
      if (!receipt) throw new Error('Unknown attempt was not retained');
      expect(
        await repository.resolveUnknown({
          agentId: agent.id,
          receiptId: receipt.id,
          expectedUpdatedAt: receipt.updatedAt,
          action: 'authorize_retry',
          now: new Date(now.getTime() + 1),
        }),
      ).toMatchObject({ authorized: true });
      const retry = await repository.claim({
        agentId: agent.id,
        memoryId: ambiguousSource.id,
        sourceHash: ambiguousSource.contentHash,
        targetSpaceKey: target,
        targetDimensions: 1536,
        now: new Date(now.getTime() + 2),
        leaseUntil: new Date(now.getTime() + 60_000),
      });
      expect(retry.kind).toBe('claimed');
      if (retry.kind === 'claimed') {
        expect(retry.receipt.id).not.toBe(receipt.id);
        if (!retry.receipt.claimToken) throw new Error('Retry claim omitted token');
        await repository.markUnknown({
          agentId: agent.id,
          receiptId: retry.receipt.id,
          claimToken: retry.receipt.claimToken,
          reason: 'test_unknown',
          now: new Date(now.getTime() + 3),
        });
      }
      const retryUnknown = (await repository.listUnknown(agent.id, 10)).find(
        (row) => row.memoryId === ambiguousSource.id,
      );
      if (!retryUnknown) throw new Error('Retry attempt was not retained as unknown');
      await repository.resolveUnknown({
        agentId: agent.id,
        receiptId: retryUnknown.id,
        expectedUpdatedAt: retryUnknown.updatedAt,
        action: 'abandon',
        now: new Date(now.getTime() + 4),
      });
      embedCalls = 0;
      const abandonedReplay = await refreshMemoryEmbeddingPage({
        repository,
        agentId: agent.id,
        targetSpace: targetSpace,
        targetSpaceKey: target,
        batch: 5,
        embed: async () => {
          embedCalls += 1;
          return vector(0.8);
        },
        now: () => new Date(now.getTime() + 5),
      });
      expect(abandonedReplay.embedded).toBe(0);
      expect(embedCalls).toBe(0);
    } finally {
      if (ids.length) await db.delete(memories).where(inArray(memories.id, ids));
      if (hashes.length)
        await db.delete(memoryTombstones).where(inArray(memoryTombstones.contentHash, hashes));
      await db
        .delete(maintenanceCursors)
        .where(eq(maintenanceCursors.name, `memory-embedding-refresh:${agent.id}:${target}`));
      await db.delete(agents).where(eq(agents.id, agent.id));
      await db.$client.end();
    }
  });

  it('does not retain callback output after source edit, source deletion, tombstone, or privacy-generation change', async () => {
    const db = createDb(url);
    const [agent] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!agent) throw new Error('Seed the isolated database');
    const repository = createPostgresMemoryEmbeddingRefreshRepository(db);
    const targetSpace = {
      provider: 'test',
      model: 'refresh-race',
      dimensions: 1536,
      revision: '1',
    } as const;
    const target = embeddingSpaceIdentityKey(targetSpace);
    const oldSpace = hash('old-refresh-race-space');
    const ids: string[] = [];
    const hashes: string[] = [];
    const now = new Date('2026-10-07T13:00:00Z');
    const makeMemory = async (label: string) => {
      const id = randomUUID();
      const contentHash = hash(`${label}:${randomUUID()}`);
      ids.push(id);
      hashes.push(contentHash);
      await db.insert(memories).values({
        id,
        agentId: agent.id,
        category: 'knowledge',
        kind: 'fact',
        content: `Callback race source ${label}`,
        contentHash,
        embedding: vector(1),
        embeddingSpaceKey: oldSpace,
      });
      return { id, contentHash };
    };
    const claim = async (source: { id: string; contentHash: string }, time = now) => {
      const result = await repository.claim({
        agentId: agent.id,
        memoryId: source.id,
        sourceHash: source.contentHash,
        targetSpaceKey: target,
        targetDimensions: 1536,
        now: time,
        leaseUntil: new Date(time.getTime() + 60_000),
      });
      if (result.kind !== 'claimed' || !result.receipt.claimToken)
        throw new Error(`Expected a refresh claim, received ${result.kind}`);
      return result.receipt;
    };
    try {
      const edited = await makeMemory('edit');
      const editReceipt = await claim(edited);
      const editedHash = hash(`edited:${randomUUID()}`);
      hashes.push(editedHash);
      await db
        .update(memories)
        .set({ content: 'Edited while callback was in flight', contentHash: editedHash })
        .where(eq(memories.id, edited.id));
      expect(
        await repository.savePrepared({
          agentId: agent.id,
          receiptId: editReceipt.id,
          claimToken: editReceipt.claimToken as string,
          vector: vector(0.5),
          now: new Date(now.getTime() + 1),
        }),
      ).toBe(false);
      const [editedRow] = await db
        .select()
        .from(memoryEmbeddingRefreshes)
        .where(eq(memoryEmbeddingRefreshes.id, editReceipt.id));
      expect(editedRow).toMatchObject({ status: 'stale', preparedVector: null });

      const deleted = await makeMemory('delete');
      const deleteReceipt = await claim(deleted, new Date(now.getTime() + 2));
      await db.delete(memories).where(eq(memories.id, deleted.id));
      expect(
        await repository.savePrepared({
          agentId: agent.id,
          receiptId: deleteReceipt.id,
          claimToken: deleteReceipt.claimToken as string,
          vector: vector(0.5),
          now: new Date(now.getTime() + 3),
        }),
      ).toBe(false);
      expect(
        await db
          .select()
          .from(memoryEmbeddingRefreshes)
          .where(eq(memoryEmbeddingRefreshes.id, deleteReceipt.id)),
      ).toHaveLength(0);

      const forgotten = await makeMemory('tombstone');
      const tombstoneReceipt = await claim(forgotten, new Date(now.getTime() + 4));
      await db
        .insert(memoryTombstones)
        .values({ contentHash: forgotten.contentHash, reason: 'test forget' });
      hashes.push(forgotten.contentHash);
      expect(
        await repository.savePrepared({
          agentId: agent.id,
          receiptId: tombstoneReceipt.id,
          claimToken: tombstoneReceipt.claimToken as string,
          vector: vector(0.5),
          now: new Date(now.getTime() + 5),
        }),
      ).toBe(false);
      const [forgottenRow] = await db
        .select()
        .from(memoryEmbeddingRefreshes)
        .where(eq(memoryEmbeddingRefreshes.id, tombstoneReceipt.id));
      expect(forgottenRow).toMatchObject({ status: 'stale', preparedVector: null });

      const privacySource = await makeMemory('privacy-generation');
      const privacyReceipt = await claim(privacySource, new Date(now.getTime() + 6));
      const generationName = `privacy-erasure-generation:${agent.id}`;
      await db.transaction(async (tx) => {
        await lockPostgresPrivacyObservationFence(
          tx as unknown as import('./client.js').Db,
          agent.id,
        );
        await tx
          .insert(maintenanceCursors)
          .values({ name: generationName, cursor: randomUUID() })
          .onConflictDoUpdate({
            target: maintenanceCursors.name,
            set: { cursor: randomUUID(), updatedAt: new Date(now.getTime() + 7) },
          });
      });
      expect(
        await repository.savePrepared({
          agentId: agent.id,
          receiptId: privacyReceipt.id,
          claimToken: privacyReceipt.claimToken as string,
          vector: vector(0.5),
          now: new Date(now.getTime() + 8),
        }),
      ).toBe(false);
      const [privacyRow] = await db
        .select()
        .from(memoryEmbeddingRefreshes)
        .where(eq(memoryEmbeddingRefreshes.id, privacyReceipt.id));
      expect(privacyRow).toMatchObject({ status: 'stale', preparedVector: null });
      await db.delete(maintenanceCursors).where(eq(maintenanceCursors.name, generationName));
    } finally {
      if (ids.length) await db.delete(memories).where(inArray(memories.id, ids));
      if (hashes.length)
        await db.delete(memoryTombstones).where(inArray(memoryTombstones.contentHash, hashes));
      await db
        .delete(maintenanceCursors)
        .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agent.id}`));
      await db
        .delete(maintenanceCursors)
        .where(eq(maintenanceCursors.name, `memory-embedding-refresh:${agent.id}:${target}`));
      await db.$client.end();
    }
  });
});
