import type { Db } from '@assistant/db';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import type { EmbeddingModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProvider } from './provider.js';
import { EMBEDDING_DIMENSIONS, ModelRouter } from './router.js';

const stubs = vi.hoisted(() => ({
  reconcileReservation: vi.fn(async () => {}),
  releaseReservation: vi.fn(async () => {}),
  reserveCost: vi.fn(async () => ({ ok: true as const, reservationId: 'reservation-1' })),
  beginCostAttempt: vi.fn(async () => true),
  markCostAttemptUnknown: vi.fn(async () => {}),
}));

vi.mock('../cost.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cost.js')>()),
  reconcileReservation: stubs.reconcileReservation,
  releaseReservation: stubs.releaseReservation,
  reserveCost: stubs.reserveCost,
  beginCostAttempt: stubs.beginCostAttempt,
  markCostAttemptUnknown: stubs.markCostAttemptUnknown,
}));

type EmbedResult = {
  embeddings: number[][];
  usage?: { tokens: number };
  providerMetadata?: Record<string, unknown>;
  warnings?: unknown[];
};

type FakeEmbeddingModel = {
  modelId: string;
  doEmbed: (this: FakeEmbeddingModel, options: { values: string[] }) => Promise<EmbedResult>;
};

type DoEmbed = FakeEmbeddingModel['doEmbed'];

function vector(): number[] {
  return new Array(EMBEDDING_DIMENSIONS).fill(0);
}

function vectorOfWidth(width: number): number[] {
  return new Array(width).fill(0.25);
}

function database(): Db {
  let selectCount = 0;
  return {
    select: () => ({
      from: () => ({
        where: async () => {
          selectCount += 1;
          return selectCount === 1
            ? [{ role: 'embed', primaryModel: 'test/embedding' }]
            : [
                {
                  id: 'test/embedding',
                  promptCostPerMTok: '1',
                  enabled: true,
                  capabilities: { embedding: true },
                },
              ];
        },
      }),
    }),
    insert: () => ({
      values: () => ({ returning: async () => [{ id: 'call-1' }] }),
    }),
  } as unknown as Db;
}

function provider(model: EmbeddingModel, dimensions?: number): ModelProvider {
  return {
    kind: 'vertex',
    ...(dimensions === undefined ? {} : { embeddingDimensions: dimensions }),
    assertModelId: vi.fn(),
    chat: vi.fn(),
    textEmbeddingModel: vi.fn(() => model),
    optionsFor: vi.fn(() => undefined),
    embeddingOptions: vi.fn(() => undefined),
    cacheHint: vi.fn(() => undefined),
    normalizeUsage: vi.fn((event: unknown) => {
      const usage = (event as { usage?: { inputTokens?: number } } | undefined)?.usage;
      const metadata = (
        event as { providerMetadata?: { vertex?: { usage?: { costUsd?: number } } } } | undefined
      )?.providerMetadata;
      return {
        inputTokens: usage?.inputTokens,
        outputTokens: 0,
        costUsd: metadata?.vertex?.usage?.costUsd ?? 0.01,
      };
    }),
  };
}

function embeddingModel(
  doEmbed: DoEmbed,
  options: { maxEmbeddingsPerCall?: number; supportsParallelCalls?: boolean } = {},
): EmbeddingModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test/embedding',
    maxEmbeddingsPerCall: options.maxEmbeddingsPerCall,
    supportsParallelCalls: options.supportsParallelCalls ?? false,
    doEmbed,
  } as EmbeddingModel;
}

function router(
  model: EmbeddingModel,
  options: {
    dimensions?: number;
    space?: import('@assistant/persistence').EmbeddingSpace;
    fixedDimensions?: number;
  } = {},
): ModelRouter {
  return new ModelRouter(
    database(),
    'unused',
    'off',
    provider(model, options.dimensions),
    options.space,
    options.fixedDimensions,
  );
}

it('rejects a changed embedding role before calling the provider', async () => {
  const doEmbed = vi.fn(async () => ({ embeddings: [vector()] }));
  await expect(
    router(embeddingModel(doEmbed)).embed(['skill text'], {
      expectedModelId: 'vertex/expected-embedding',
    }),
  ).rejects.toThrow('Embedding model does not match');
  expect(doEmbed).not.toHaveBeenCalled();
});

it('round trips a configured 768-wide operation under its exact space identity', async () => {
  const space = {
    provider: 'openrouter',
    model: 'test/embedding',
    dimensions: 768,
    revision: 'space-r7',
  };
  const doEmbed = vi.fn(async () => ({ embeddings: [vectorOfWidth(768)] }));
  await expect(
    router(embeddingModel(doEmbed), { space, dimensions: 768 }).embed(['query'], {
      expectedSpace: space,
    }),
  ).resolves.toEqual([vectorOfWidth(768)]);
  expect(stubs.reserveCost).toHaveBeenCalledOnce();
  expect(doEmbed).toHaveBeenCalledOnce();
});

it.each([768, 1536])(
  'snapshots a %i-wide receipt identity before an in-flight caller mutation',
  async (dimensions) => {
    const captured = {
      provider: 'openrouter',
      model: 'test/embedding',
      dimensions,
      revision: 'space-r7',
    };
    const mutable = { ...captured };
    const started = deferred<void>();
    const response = deferred<EmbedResult>();
    const doEmbed = vi.fn(async () => {
      started.resolve();
      return response.promise;
    });
    const instance = router(embeddingModel(doEmbed), { space: captured, dimensions });
    const work = instance.embedWithIdentity(['query'], { expectedSpace: mutable });
    await started.promise;
    mutable.revision = 'space-r8';
    mutable.dimensions = dimensions === 768 ? 1536 : 768;
    response.resolve({ embeddings: [vectorOfWidth(dimensions)] });
    const receipt = await work;
    expect(receipt.space).toEqual(captured);
    expect(receipt.spaceKey).toBe(embeddingSpaceIdentityKey(captured));
    expect(receipt.embeddings[0]).toHaveLength(dimensions);
    expect(Object.isFrozen(receipt.space)).toBe(true);
    expect(doEmbed).toHaveBeenCalledOnce();
    expect(stubs.reserveCost).toHaveBeenCalledOnce();
  },
);

it('rejects a same-width revision mismatch before reservation or provider work', async () => {
  const configured = {
    provider: 'openrouter',
    model: 'test/embedding',
    dimensions: 768,
    revision: 'space-r7',
  };
  const doEmbed = vi.fn(async () => ({ embeddings: [vectorOfWidth(768)] }));
  await expect(
    router(embeddingModel(doEmbed), { space: configured, dimensions: 768 }).embed(['query'], {
      expectedSpace: { ...configured, revision: 'space-r8' },
    }),
  ).rejects.toThrow('Embedding space identity does not match');
  expect(stubs.reserveCost).not.toHaveBeenCalled();
  expect(doEmbed).not.toHaveBeenCalled();
});

it('keeps PostgreSQL embedding operations at 1536 when a provider is fixed at 768', async () => {
  const doEmbed = vi.fn(async () => ({ embeddings: [vectorOfWidth(768)] }));
  await expect(
    router(embeddingModel(doEmbed), { dimensions: 768, fixedDimensions: 1536 }).embed(['query']),
  ).rejects.toThrow('Embedding dimensions do not match');
  expect(stubs.reserveCost).not.toHaveBeenCalled();
  expect(doEmbed).not.toHaveBeenCalled();
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for embedding calls');
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.reserveCost.mockResolvedValue({ ok: true, reservationId: 'reservation-1' });
});

describe('ModelRouter embedding accounting around the AI SDK', () => {
  it('meters a provider response before SDK vector-count validation rejects it', async () => {
    const doEmbed = vi.fn<DoEmbed>(async function (this: FakeEmbeddingModel, options) {
      expect(this.modelId).toBe('test/embedding');
      expect(options.values).toEqual(['one']);
      return { embeddings: [], usage: { tokens: 7 }, warnings: [] };
    });

    await expect(router(embeddingModel(doEmbed)).embed(['one'])).rejects.toThrow(
      'Expected 1 embeddings, but received 0',
    );

    expect(stubs.releaseReservation).not.toHaveBeenCalled();
    expect(stubs.reconcileReservation).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      expect.objectContaining({ quantity: 7, usd: 0.01 }),
    );
  });

  it('waits for an already-started chunk before deciding a failed batch was unpaid', async () => {
    const lateChunk = deferred<EmbedResult>();
    const doEmbed = vi.fn<DoEmbed>(async function (this: FakeEmbeddingModel, { values }) {
      expect(this.modelId).toBe('test/embedding');
      if (values[0] === 'reject') throw new Error('provider chunk failed');
      return lateChunk.promise;
    });
    const outcome = router(
      embeddingModel(doEmbed, { maxEmbeddingsPerCall: 1, supportsParallelCalls: true }),
    ).embed(['reject', 'late']);

    await waitFor(() => doEmbed.mock.calls.length === 2);
    await Promise.resolve();
    expect(stubs.releaseReservation).not.toHaveBeenCalled();

    lateChunk.resolve({
      embeddings: [vector()],
      usage: { tokens: 4 },
      providerMetadata: { vertex: { usage: { costUsd: 0.02 } } },
      warnings: [],
    });
    await expect(outcome).rejects.toThrow('provider chunk failed');
    expect(stubs.releaseReservation).not.toHaveBeenCalled();
    expect(stubs.reconcileReservation).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      expect.objectContaining({ quantity: 4, usd: 0.02 }),
    );
  });

  it('sums authoritative cost and usage from every completed SDK chunk', async () => {
    const doEmbed = vi.fn<DoEmbed>(async function (this: FakeEmbeddingModel, { values }) {
      expect(this.modelId).toBe('test/embedding');
      const first = values[0] === 'first';
      return {
        embeddings: [vector()],
        usage: { tokens: first ? 3 : 5 },
        providerMetadata: { vertex: { usage: { costUsd: first ? 0.02 : 0.03 } } },
        warnings: [],
      };
    });

    await expect(
      router(
        embeddingModel(doEmbed, { maxEmbeddingsPerCall: 1, supportsParallelCalls: true }),
      ).embed(['first', 'second']),
    ).resolves.toHaveLength(2);

    expect(stubs.reconcileReservation).toHaveBeenCalledWith(
      expect.anything(),
      'reservation-1',
      expect.objectContaining({ quantity: 8, usd: 0.05 }),
    );
    expect(stubs.releaseReservation).not.toHaveBeenCalled();
  });

  it('releases the reservation when the first provider request is rejected', async () => {
    const doEmbed = vi.fn<DoEmbed>(async function (this: FakeEmbeddingModel) {
      expect(this.modelId).toBe('test/embedding');
      throw new Error('authentication rejected');
    });

    await expect(router(embeddingModel(doEmbed)).embed(['one'])).rejects.toThrow(
      'authentication rejected',
    );

    expect(stubs.reconcileReservation).not.toHaveBeenCalled();
    expect(stubs.releaseReservation).toHaveBeenCalledWith(expect.anything(), 'reservation-1');
  });
});
