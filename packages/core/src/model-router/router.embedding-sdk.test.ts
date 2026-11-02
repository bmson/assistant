import { type Db, modelCalls, modelRoles, models } from '@assistant/db';
import { embeddingModelId, embeddingSpaceIdentityKey, type Records } from '@assistant/persistence';
import type { EmbeddingModel } from 'ai';
import { getTableName, type Table } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASIC5_FIXTURE_CONNECTION_ID,
  BASIC5_FIXTURE_MODEL_ID,
  basic5EmbeddingResponse,
} from '../../../../scripts/basic5-browser-acceptance-support.js';
import { prepareOwnerKnowledgeGraphFactWithRepository } from '../memory/knowledge-graph.js';
import { createConnectedModelProviders } from './connections.js';
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
afterEach(() => vi.unstubAllGlobals());

it('prepares a BASIC5 family source through the connected gateway SDK before fake ledger commit', async () => {
  const events: string[] = [];
  const connection: Records['modelConnections'] = {
    id: BASIC5_FIXTURE_CONNECTION_ID,
    kind: 'openai_compatible',
    label: 'Local BASIC5 acceptance embedding fixture',
    baseUrl: 'http://127.0.0.1:3108/v1',
    apiKeyEncrypted: null,
    vertexProject: null,
    vertexLocation: null,
    enabled: true,
    lastTestedAt: null,
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(1_000),
  };
  const decrypt = vi.fn(() => {
    throw new Error('The credential-free fixture must not decrypt a provider credential');
  });
  const loadConnections = vi.fn(async () => [connection]);
  const providers = createConnectedModelProviders(
    {
      LLM_PROVIDER: 'vertex',
      OPENROUTER_API_KEY: '',
      VERTEX_PROJECT: '',
      VERTEX_LOCATION: '',
    },
    loadConnections,
    { decrypt },
  );
  const resolve = vi.spyOn(providers, 'resolve');
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (getTableName(table as Table) === getTableName(modelRoles))
            return [
              {
                role: 'embed',
                primaryModel: BASIC5_FIXTURE_MODEL_ID,
                fallbackModel: BASIC5_FIXTURE_MODEL_ID,
              },
            ];
          if (getTableName(table as Table) === getTableName(models))
            return [
              {
                id: BASIC5_FIXTURE_MODEL_ID,
                promptCostPerMTok: '0.0100',
                completionCostPerMTok: '0.0000',
                enabled: true,
                capabilities: { embedding: true },
                updatedAt: new Date(1_000),
              },
            ];
          throw new Error('Unexpected offline model-routing read');
        },
      }),
    }),
    insert: (table: unknown) => {
      expect(getTableName(table as Table)).toBe(getTableName(modelCalls));
      return {
        values: (value: Record<string, unknown>) => {
          events.push('model-call-ledger');
          expect(value.model).toBe(BASIC5_FIXTURE_MODEL_ID);
          return { returning: async () => [{ id: 'offline-model-call' }] };
        },
      };
    },
  } as unknown as Db;
  const response = deferred<Response>();
  const dispatched = deferred<void>();
  let fixtureResponse: Response | undefined;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    events.push('sdk-dispatch');
    dispatched.resolve();
    const request = input instanceof Request ? input : null;
    expect(request?.url ?? String(input)).toBe('http://127.0.0.1:3108/v1/embeddings');
    expect(init?.method ?? request?.method).toBe('POST');
    const headers = new Headers(init?.headers ?? request?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-api-key')).toBeNull();
    const body = typeof init?.body === 'string' ? init.body : await request?.text();
    expect(typeof body).toBe('string');
    const wire: unknown = JSON.parse(body as string);
    expect(wire).toMatchObject({
      model: 'embedding',
      input: [expect.stringContaining('Alex Rivera Updated')],
    });
    // The real fixture decoder must accept the real SDK payload without a waiver.
    const payload = basic5EmbeddingResponse(wire);
    expect(payload.data[0]?.embedding).toHaveLength(1_536);
    fixtureResponse = Response.json(payload);
    const result = await response.promise;
    events.push('sdk-response');
    return result;
  });
  vi.stubGlobal('fetch', fetcher);
  stubs.reconcileReservation.mockImplementationOnce(async () => {
    events.push('reconcile-ledger');
  });
  // Match the actual PostgreSQL web-router composition's fixed vector width.
  const instance = new ModelRouter(db, '', 'off', providers, undefined, 1_536);
  const space = await instance.embeddingSpace();
  expect(space).toMatchObject({
    provider: BASIC5_FIXTURE_CONNECTION_ID,
    model: BASIC5_FIXTURE_MODEL_ID,
    dimensions: 1_536,
  });
  expect(embeddingModelId(space)).toBe(BASIC5_FIXTURE_MODEL_ID);
  expect(providers.resolve(BASIC5_FIXTURE_MODEL_ID).kind).toBe('openai_compatible');

  await expect(
    instance.embed(['not dispatched'], {
      expectedSpace: { ...space, model: 'gw:other-connection:embedding' },
    }),
  ).rejects.toThrow('Gateway basic5-fixture cannot serve model identity');
  await expect(
    instance.embed(['not dispatched'], { expectedSpace: { ...space, provider: 'openrouter' } }),
  ).rejects.toThrow('Gateway openrouter cannot serve model identity');
  await expect(
    instance.embed(['not dispatched'], { expectedSpace: { ...space, dimensions: 768 } }),
  ).rejects.toThrow('fixed PostgreSQL vector width');
  expect(fetcher).not.toHaveBeenCalled();
  expect(stubs.reserveCost).not.toHaveBeenCalled();
  expect(events).toEqual([]);

  const embed = vi.spyOn(instance, 'embed');
  const spaceRead = vi.spyOn(instance, 'embeddingSpace');
  const createAtomic = vi.fn(async () => ({}));
  const context = vi.fn(async () => {
    throw new Error('An unbounded context scan is not part of this preparation');
  });
  const personId = '11111111-1111-4111-8111-111111111111';
  const relativeId = '22222222-2222-4222-8222-222222222222';
  const work = prepareOwnerKnowledgeGraphFactWithRepository(
    {
      repository: {
        kind: 'owner-knowledge-graph-fact-repository',
        context,
        entity: async () => null,
        correctionTarget: async () => null,
        createAtomic,
      },
      router: instance,
      agentId: 'synthetic-owner',
      context: {
        agentId: 'synthetic-owner',
        timeZone: 'America/Los_Angeles',
        locale: 'en',
        contacts: [
          { id: personId, name: 'Alex Rivera Updated', aliases: ['Alex Rivera'] },
          { id: relativeId, name: 'Robin Rivera', aliases: [] },
        ],
      },
    },
    {
      subject: { kind: 'person', label: 'Alex Rivera Updated', contactId: personId },
      object: { kind: 'person', label: 'Robin Rivera', contactId: relativeId },
      predicate: 'sibling_of',
      timing: 'unspecified',
      validity: { validFrom: null, validUntil: null },
      note: 'Synthetic family statement one.',
    },
  );
  const outcome = work.then(
    (prepared) => ({ ok: true as const, prepared }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await Promise.race([
    dispatched.promise,
    outcome.then((result) => {
      if (!result.ok) throw result.error;
      throw new Error('Embedding returned without dispatching the fixture SDK request');
    }),
  ]);
  expect(events).toEqual(['sdk-dispatch']);
  expect(stubs.reconcileReservation).not.toHaveBeenCalled();
  if (!fixtureResponse) throw new Error('The actual SDK request did not match the local fixture');
  response.resolve(fixtureResponse);
  const result = await outcome;
  if (!result.ok) throw result.error;
  if (!('prepared' in result.prepared)) throw new Error(result.prepared.error);
  const prepared = result.prepared.prepared;

  expect(prepared.embedding).toEqual(
    Array.from({ length: 1_536 }, (_, index) => (index === 0 ? 1 : 0)),
  );
  expect(prepared.embeddingSpaceKey).toBe(embeddingSpaceIdentityKey(space));
  expect(prepared.subject.canonicalKey).toBe(`contact:${personId}`);
  expect(prepared.object.canonicalKey).toBe(`contact:${relativeId}`);
  expect(prepared.predicate).toBe('sibling_of');
  expect(prepared.validity).toEqual({ validFrom: null, validUntil: null });
  expect(embed).toHaveBeenCalledExactlyOnceWith([prepared.content], { expectedSpace: space });
  expect(spaceRead).toHaveBeenCalledOnce();
  expect(context).not.toHaveBeenCalled();
  expect(createAtomic).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(loadConnections).toHaveBeenCalledOnce();
  expect(decrypt).not.toHaveBeenCalled();
  expect(resolve.mock.calls.every(([model]) => model === BASIC5_FIXTURE_MODEL_ID)).toBe(true);
  expect(stubs.reserveCost).toHaveBeenCalledOnce();
  expect(stubs.beginCostAttempt).toHaveBeenCalledOnce();
  expect(stubs.releaseReservation).not.toHaveBeenCalled();
  expect(stubs.markCostAttemptUnknown).not.toHaveBeenCalled();
  expect(events).toEqual(['sdk-dispatch', 'sdk-response', 'reconcile-ledger', 'model-call-ledger']);
  // This is an SDK/wire and fake-ledger ordering proof, not PostgreSQL locking,
  // a real HTTP/provider request, or an explanation of the retained CI failure.
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
