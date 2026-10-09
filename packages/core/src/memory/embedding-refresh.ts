import { createHash, randomUUID } from 'node:crypto';
import {
  type EmbeddingSpace,
  embeddingSpaceIdentityKey,
  type MemoryEmbeddingRefreshRepository,
  snapshotEmbeddingSpace,
  validateEmbedding,
} from '@assistant/persistence';

const KEY = /^[a-f0-9]{64}$/;
const MAX_BATCH = 100;
const CLAIM_LEASE_MS = 5 * 60_000;

export interface MemoryEmbeddingRefreshResult {
  examined: number;
  embedded: number;
  applied: number;
  resumed: number;
  skipped: number;
  needsReview: number;
  stale: number;
  done: boolean;
  nextCursor: string | null;
}

/**
 * Refresh completed vectors without rerunning extraction. The callback is
 * deliberately injected: a dispatch that may have reached a paid provider
 * but did not persist its output becomes `unknown` and is never retried here.
 */
export async function refreshMemoryEmbeddingPage(input: {
  repository: MemoryEmbeddingRefreshRepository;
  agentId: string;
  targetSpace: EmbeddingSpace;
  targetSpaceKey: string;
  batch: number;
  embed: (text: string, expectedSpace: Readonly<EmbeddingSpace>) => Promise<number[]>;
  now?: () => Date;
}): Promise<MemoryEmbeddingRefreshResult> {
  const targetSpace = snapshotEmbeddingSpace(input.targetSpace);
  const agentId = input.agentId;
  const targetSpaceKey = input.targetSpaceKey;
  const repository = input.repository;
  const batch = input.batch;
  const embed = input.embed;
  if (
    !agentId ||
    !KEY.test(targetSpaceKey) ||
    !Number.isInteger(batch) ||
    batch < 1 ||
    batch > MAX_BATCH
  )
    throw new Error('Invalid memory embedding refresh request');
  if (embeddingSpaceIdentityKey(targetSpace) !== targetSpaceKey)
    throw new Error('Target embedding key does not match the declared provider/model revision');

  const clock = input.now ?? (() => new Date());
  let cursor = await repository.getCursor(agentId, targetSpaceKey);
  const page = await repository.listCandidates({
    agentId,
    targetSpaceKey,
    afterId: cursor,
    limit: batch,
  });
  const result: MemoryEmbeddingRefreshResult = {
    examined: 0,
    embedded: 0,
    applied: 0,
    resumed: 0,
    skipped: 0,
    needsReview: 0,
    stale: 0,
    done: false,
    nextCursor: cursor,
  };

  for (const candidate of page.rows) {
    result.examined += 1;
    cursor = candidate.id;
    const now = clock();
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid refresh clock');
    const claim = await repository.claim({
      agentId,
      memoryId: candidate.id,
      sourceHash: candidate.contentHash,
      targetSpaceKey,
      targetDimensions: targetSpace.dimensions,
      now,
      leaseUntil: new Date(now.getTime() + CLAIM_LEASE_MS),
    });

    if (claim.kind === 'current' || claim.kind === 'busy') {
      result.skipped += 1;
      await repository.saveCursor(agentId, targetSpaceKey, cursor);
      continue;
    }
    if (claim.kind === 'stale') {
      result.stale += 1;
      await repository.saveCursor(agentId, targetSpaceKey, cursor);
      continue;
    }
    if (claim.kind === 'unknown') {
      result.needsReview += 1;
      await repository.saveCursor(agentId, targetSpaceKey, cursor);
      continue;
    }
    if (claim.kind !== 'claimed' && claim.kind !== 'prepared') {
      result.skipped += 1;
      await repository.saveCursor(agentId, targetSpaceKey, cursor);
      continue;
    }

    let receipt = claim.receipt;
    if (claim.kind === 'claimed') {
      const claimToken = receipt.claimToken;
      if (!claimToken) throw new Error('Refresh claim omitted its claim token');
      try {
        const vector = await embed(candidate.content, targetSpace);
        validateEmbedding(targetSpace, vector);
        const prepared = await repository.savePrepared({
          agentId,
          receiptId: receipt.id,
          claimToken,
          vector,
          now: clock(),
        });
        if (!prepared) {
          result.stale += 1;
          await repository.saveCursor(agentId, targetSpaceKey, cursor);
          continue;
        }
        result.embedded += 1;
        const latest = await repository.claim({
          agentId,
          memoryId: candidate.id,
          sourceHash: candidate.contentHash,
          targetSpaceKey,
          targetDimensions: targetSpace.dimensions,
          now: clock(),
          leaseUntil: new Date(clock().getTime() + CLAIM_LEASE_MS),
        });
        if (latest.kind !== 'prepared' || latest.receipt.id !== receipt.id) {
          result.stale += 1;
          await repository.saveCursor(agentId, targetSpaceKey, cursor);
          continue;
        }
        receipt = latest.receipt;
      } catch (error) {
        // The provider may have accepted work before the exception. Keep only a
        // bounded reason and require explicit operator review before retry.
        await repository.markUnknown({
          agentId,
          receiptId: receipt.id,
          claimToken,
          reason: error instanceof Error ? error.name.slice(0, 80) : 'unknown_failure',
          now: clock(),
        });
        result.needsReview += 1;
        await repository.saveCursor(agentId, targetSpaceKey, cursor);
        continue;
      }
    } else {
      result.resumed += 1;
    }

    const applied = await repository.applyPrepared({
      agentId,
      memoryId: candidate.id,
      sourceHash: candidate.contentHash,
      targetSpaceKey,
      receiptId: receipt.id,
      now: clock(),
    });
    if (applied === 'applied') result.applied += 1;
    else if (applied === 'stale') result.stale += 1;
    else result.needsReview += 1;
    await repository.saveCursor(agentId, targetSpaceKey, cursor);
  }

  result.done = page.nextCursor === null;
  if (result.done) {
    cursor = null;
    await repository.saveCursor(agentId, targetSpaceKey, null);
  } else {
    cursor = page.nextCursor;
    await repository.saveCursor(agentId, targetSpaceKey, cursor);
  }
  result.nextCursor = cursor;
  return result;
}

/** Opaque receipt identity; does not contain source text or other private data. */
export function memoryEmbeddingRefreshReceiptId(input: {
  agentId: string;
  memoryId: string;
  sourceHash: string;
  targetSpaceKey: string;
  attemptId?: string;
}): string {
  const identity = [input.agentId, input.memoryId, input.sourceHash, input.targetSpaceKey];
  if (input.attemptId) identity.push(input.attemptId);
  return createHash('sha256').update(identity.join('\0')).digest('hex');
}

export function newMemoryEmbeddingRefreshAttemptId(): string {
  return randomUUID();
}
