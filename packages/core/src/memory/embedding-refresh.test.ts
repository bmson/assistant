import type {
  MemoryEmbeddingRefresh,
  MemoryEmbeddingRefreshRepository,
} from '@assistant/persistence';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { refreshMemoryEmbeddingPage } from './embedding-refresh.js';

describe('generic memory embedding refresh', () => {
  it('rejects a target key that does not identify the declared model revision before reading candidates', async () => {
    const getCursor = vi.fn(async () => null);
    const embed = vi.fn(async () => [1, 0, 0]);
    const repository = {
      kind: 'memory-embedding-refresh-repository',
      getCursor,
    } as unknown as MemoryEmbeddingRefreshRepository;
    const targetSpace = { provider: 'test', model: 'embedding', dimensions: 3, revision: '2' };

    await expect(
      refreshMemoryEmbeddingPage({
        repository,
        agentId: 'owner',
        targetSpace,
        targetSpaceKey: embeddingSpaceIdentityKey({ ...targetSpace, revision: '1' }),
        batch: 10,
        embed,
      }),
    ).rejects.toThrow('Target embedding key does not match');
    expect(getCursor).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it('pins the validated target space across a deferred embedding call', async () => {
    const targetSpace = {
      provider: 'synthetic',
      model: 'refresh-width',
      dimensions: 384,
      revision: 'r1',
    };
    const targetSpaceKey = embeddingSpaceIdentityKey(targetSpace);
    const receipt: MemoryEmbeddingRefresh = {
      id: 'receipt',
      agentId: 'owner',
      memoryId: 'memory',
      sourceHash: 'a'.repeat(64),
      targetSpaceKey,
      targetDimensions: 384,
      observedSpaceKey: null,
      status: 'dispatching',
      preparedVector: null,
      privacyGeneration: null,
      claimToken: 'claim',
      leaseUntil: new Date('2026-10-07T12:05:00Z'),
      unknownReason: null,
      createdAt: new Date('2026-10-07T12:00:00Z'),
      updatedAt: new Date('2026-10-07T12:00:00Z'),
    };
    let claimCount = 0;
    const repository = {
      kind: 'memory-embedding-refresh-repository',
      getCursor: vi.fn(async () => null),
      listCandidates: vi.fn(async () => ({
        rows: [
          {
            id: 'memory',
            agentId: 'owner',
            content: 'source',
            contentHash: 'a'.repeat(64),
            embeddingSpaceKey: null,
          },
        ],
        nextCursor: null,
      })),
      claim: vi.fn(async () => {
        claimCount += 1;
        return claimCount === 1
          ? ({ kind: 'claimed', receipt } as const)
          : ({
              kind: 'prepared',
              receipt: {
                ...receipt,
                status: 'prepared',
                preparedVector: new Array(384).fill(0.02),
              },
            } as const);
      }),
      savePrepared: vi.fn(async () => true),
      applyPrepared: vi.fn(async () => 'applied' as const),
      saveCursor: vi.fn(async () => undefined),
      markUnknown: vi.fn(async () => undefined),
      listUnknown: vi.fn(async () => []),
      resolveUnknown: vi.fn(async () => ({ authorized: false })),
    } as unknown as MemoryEmbeddingRefreshRepository;

    let signalStarted!: () => void;
    let finishEmbed!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let observedSpace: Readonly<typeof targetSpace> | undefined;
    const embed = vi.fn((_text: string, expectedSpace: Readonly<typeof targetSpace>) => {
      observedSpace = expectedSpace;
      signalStarted();
      return new Promise<number[]>((resolve) => {
        finishEmbed = () => resolve(new Array(384).fill(0.02));
      });
    });

    const refresh = refreshMemoryEmbeddingPage({
      repository,
      agentId: 'owner',
      targetSpace,
      targetSpaceKey,
      batch: 1,
      embed,
    });
    await started;
    targetSpace.provider = 'mutated';
    targetSpace.model = 'other';
    targetSpace.dimensions = 2048;
    targetSpace.revision = 'r2';
    finishEmbed();

    await expect(refresh).resolves.toMatchObject({ embedded: 1, applied: 1, done: true });
    expect(observedSpace).toEqual({
      provider: 'synthetic',
      model: 'refresh-width',
      dimensions: 384,
      revision: 'r1',
    });
    expect(observedSpace && Object.isFrozen(observedSpace)).toBe(true);
    expect(repository.claim).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ targetSpaceKey, targetDimensions: 384 }),
    );
    expect(repository.claim).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ targetSpaceKey, targetDimensions: 384 }),
    );
    expect(repository.applyPrepared).toHaveBeenCalledWith(
      expect.objectContaining({ targetSpaceKey }),
    );
    expect(embed).toHaveBeenCalledTimes(1);
  });
});
