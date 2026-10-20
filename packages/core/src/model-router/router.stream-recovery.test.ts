import type { CostRepository, ModelRoutingRepository } from '@assistant/persistence';
import { type LanguageModel, StreamProviderError } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const costs = vi.hoisted(() => ({
  releaseReservation: vi.fn(async () => {}),
  reserveCost: vi.fn(async () => ({ ok: true as const, reservationId: 'r' })),
  beginCostAttempt: vi.fn(async () => true),
  markCostAttemptUnknown: vi.fn(async () => {}),
}));
vi.mock('../cost.js', async (original) => ({
  ...(await original<typeof import('../cost.js')>()),
  ...costs,
}));

import { ModelRouter } from './router.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const rejected = (statusCode = 429) =>
  new StreamProviderError({ message: 'Provider returned error', statusCode });
const success = [
  { type: 'stream-start' as const, warnings: [] },
  { type: 'response-metadata' as const, id: 'provider-answer', modelId: 'configured/model' },
  { type: 'text-start' as const, id: 'text' },
  { type: 'text-delta' as const, id: 'text', delta: 'Recovered answer' },
  { type: 'text-end' as const, id: 'text' },
  { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
];
type Part = Parameters<typeof simulateReadableStream>[0]['chunks'][number];
function fixture(sequences: Part[][]) {
  const recordAudit = vi.fn(async () => {});
  const repository = {
    kind: 'model-routing-repository',
    costs: {} as CostRepository,
    taskBudget: vi.fn(async () => null),
    recordAudit,
  } as unknown as ModelRoutingRepository;
  let index = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: sequences[index++] as typeof success }),
    }),
  });
  const router = new ModelRouter(repository, 'test', 'redacted');
  vi.spyOn(router, 'route').mockResolvedValue({
    ok: true,
    model: model as unknown as LanguageModel,
    modelId: 'configured/model',
    degraded: false,
    thinking: false,
    decision: { mode: 'primary' },
    params: {},
    promptCostPerMTok: 1,
    completionCostPerMTok: 1,
  });
  const meter = vi.fn(async () => {});
  (
    router as unknown as { meterWithoutRepeatingProviderWork: typeof meter }
  ).meterWithoutRepeatingProviderWork = meter;
  const onError = vi.fn(async () => {});
  const onComplete = vi.fn(async () => {});
  const recoverBeforeOutput = vi.fn(async () => true);
  return { router, model, recordAudit, meter, onError, onComplete, recoverBeforeOutput };
}
async function drain(result: Awaited<ReturnType<ModelRouter['stream']>>) {
  if (!result.ok) throw new Error('unexpected budget rejection');
  const parts = [];
  for await (const part of result.toUIMessageStream()) parts.push(part);
  return parts;
}
beforeEach(() => {
  vi.clearAllMocks();
  let reservation = 0;
  costs.reserveCost.mockImplementation(async () => ({
    ok: true,
    reservationId: `r${++reservation}`,
  }));
});

describe('real SDK pre-output stream recovery', () => {
  it.each([false, true])(
    'recovers a typed429 before content (nested=%s), with one UI prelude',
    async (nested) => {
      const failure = nested
        ? Object.assign(new Error('wrapper'), { cause: rejected() })
        : rejected();
      const f = fixture([
        [
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: failure },
        ],
        success,
      ]);
      const outcome = await f.router.stream('draft', { prompt: 'hello', ...f });
      const parts = (await drain(outcome)) as { type: string; delta?: string }[];
      expect(f.model.doStreamCalls).toHaveLength(2);
      expect(parts.filter((p) => p.type === 'start')).toHaveLength(1);
      expect(
        parts
          .filter((p) => p.type === 'text-delta')
          .map((p) => p.delta)
          .join(''),
      ).toBe('Recovered answer');
      expect(f.onError).not.toHaveBeenCalled();
      expect(f.onComplete).toHaveBeenCalledExactlyOnceWith('Recovered answer');
      expect(costs.markCostAttemptUnknown).toHaveBeenCalledTimes(1);
      expect(costs.releaseReservation).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'r1');
      expect(f.recordAudit).toHaveBeenCalledOnce();
      expect(outcome.attempts?.map((p) => p.outcome)).toEqual(['failed', 'succeeded']);
    },
  );
  it.each([400, 401, 403])('does not retry status%s', async (status) => {
    const f = fixture([[{ type: 'error', error: rejected(status) }]]);
    await drain(await f.router.stream('draft', { prompt: 'hello', ...f }));
    expect(f.model.doStreamCalls).toHaveLength(1);
    expect(f.onError).toHaveBeenCalledTimes(1);
    expect(f.recoverBeforeOutput).not.toHaveBeenCalled();
  });
  it('bounds permanent429 to two application attempts and one terminal callback', async () => {
    const f = fixture([
      [{ type: 'error', error: rejected() }],
      [{ type: 'error', error: rejected() }],
    ]);
    await drain(await f.router.stream('draft', { prompt: 'hello', ...f }));
    expect(f.model.doStreamCalls).toHaveLength(2);
    expect(f.onError).toHaveBeenCalledTimes(1);
    expect(f.onComplete).not.toHaveBeenCalled();
    expect(costs.releaseReservation).toHaveBeenCalledTimes(2);
    expect(costs.markCostAttemptUnknown).toHaveBeenCalledTimes(2);
    expect(f.recordAudit).toHaveBeenCalledTimes(2);
  });
  it.each([
    [
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Partial' },
    ],
    [{ type: 'reasoning-start', id: 'r' }],
    [{ type: 'source', sourceType: 'url', id: 's', url: 'https://example.test' }],
    [{ type: 'tool-input-start', id: 'tool', toolName: 'doSomething' }],
  ])('never retries after model output%j', async (...prefix) => {
    const f = fixture([[...prefix, { type: 'error', error: rejected() }]]);
    await drain(await f.router.stream('draft', { prompt: 'hello', ...f }));
    expect(f.model.doStreamCalls).toHaveLength(1);
    expect(f.onError).toHaveBeenCalledTimes(1);
  });
  it('respects a lost lease and singleAttempt', async () => {
    for (const singleAttempt of [false, true]) {
      const f = fixture([[{ type: 'error', error: rejected() }]]);
      f.recoverBeforeOutput.mockResolvedValue(false);
      await drain(await f.router.stream('draft', { prompt: 'hello', ...f, singleAttempt }));
      expect(f.model.doStreamCalls).toHaveLength(1);
      expect(f.onError).toHaveBeenCalledTimes(1);
    }
  });
  it('waits for error audit and reservation release before the next provider attempt', async () => {
    const f = fixture([[{ type: 'error', error: rejected() }], success]);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    costs.releaseReservation.mockImplementationOnce(() => blocked);
    const pending = f.router.stream('draft', { prompt: 'hello', ...f });
    await vi.waitFor(() => expect(costs.releaseReservation).toHaveBeenCalledOnce());
    expect(f.model.doStreamCalls).toHaveLength(1);
    expect(costs.reserveCost).toHaveBeenCalledOnce();
    release();
    await drain(await pending);
    expect(f.model.doStreamCalls).toHaveLength(2);
  });
  it('does not repeat provider work when durable completion throws', async () => {
    const f = fixture([success]);
    f.onComplete.mockRejectedValueOnce(new Error('completion persistence failed'));
    const outcome = await f.router.stream('draft', { prompt: 'hello', ...f });
    await drain(outcome);
    expect(f.onComplete).toHaveBeenCalledOnce();
    expect(f.model.doStreamCalls).toHaveLength(1);
    expect(f.recoverBeforeOutput).not.toHaveBeenCalled();
  });
  it('does not retry an unknown error or an empty successful finish', async () => {
    for (const sequence of [
      [{ type: 'error', error: new Error('untyped failure') }],
      [{ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }],
    ]) {
      const f = fixture([sequence]);
      await drain(await f.router.stream('draft', { prompt: 'hello', ...f }));
      expect(f.model.doStreamCalls).toHaveLength(1);
      expect(f.recoverBeforeOutput).not.toHaveBeenCalled();
    }
  });
  it('does not start work after cancellation, including cancellation during lease recheck', async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fixture([success]);
    await expect(
      f.router.stream('draft', { prompt: 'hello', ...f, abortSignal: controller.signal }),
    ).rejects.toThrow();
    expect(f.model.doStreamCalls).toHaveLength(0);
    const later = new AbortController();
    const g = fixture([[{ type: 'error', error: rejected() }], success]);
    g.recoverBeforeOutput.mockImplementation(async () => {
      later.abort();
      return true;
    });
    await expect(
      g.router.stream('draft', { prompt: 'hello', ...g, abortSignal: later.signal }),
    ).rejects.toThrow();
    expect(g.model.doStreamCalls).toHaveLength(1);
    expect(costs.releaseReservation).toHaveBeenCalled();
  });
  it('aborts a pending preflight and releases the reservation without retrying', async () => {
    const f = fixture([]);
    const controller = new AbortController();
    const invoke = vi.spyOn(f.model, 'doStream').mockImplementation(async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(stream) {
          stream.enqueue({ type: 'stream-start', warnings: [] });
          abortSignal?.addEventListener('abort', () => stream.close(), {
            once: true,
          });
        },
      }),
    }));
    const pending = f.router.stream('draft', {
      prompt: 'hello',
      ...f,
      abortSignal: controller.signal,
    });
    // Attach rejection handling before triggering cancellation.
    const result = pending.catch((error) => error);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    controller.abort(new DOMException('stopped', 'AbortError'));
    await result;
    await vi.waitFor(() => expect(costs.releaseReservation).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledOnce();
    expect(f.recoverBeforeOutput).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledOnce();
  });
  it('does not reset the total deadline when the first attempt fails', async () => {
    const total = new AbortController();
    const deadline = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal);
    deadline.mockImplementationOnce(() => total.signal);
    const f = fixture([[{ type: 'error', error: rejected() }], success]);
    f.recoverBeforeOutput.mockImplementation(async () => {
      total.abort(new DOMException('total deadline', 'TimeoutError'));
      return true;
    });
    try {
      await expect(f.router.stream('draft', { prompt: 'hello', ...f })).rejects.toThrow(
        'total deadline',
      );
      expect(f.model.doStreamCalls).toHaveLength(1);
      expect(costs.reserveCost).toHaveBeenCalledOnce();
      expect(costs.releaseReservation).toHaveBeenCalledOnce();
    } finally {
      deadline.mockRestore();
    }
  });
  it('does not retry sooner than Retry-After or wait past its total deadline', async () => {
    const f = fixture([
      [
        {
          type: 'error',
          error: Object.assign(rejected(), { responseHeaders: { 'retry-after': '120' } }),
        },
      ],
    ]);
    await drain(await f.router.stream('draft', { prompt: 'hello', ...f }));
    expect(f.model.doStreamCalls).toHaveLength(1);
    expect(f.recoverBeforeOutput).not.toHaveBeenCalled();
    const retryAt = new Date(Date.now() + 2000).toUTCString();
    const g = fixture([
      [
        {
          type: 'error',
          error: Object.assign(rejected(), { responseHeaders: { 'Retry-After': retryAt } }),
        },
      ],
      success,
    ]);
    const pending = g.router.stream('draft', { prompt: 'hello', ...g });
    await vi.waitFor(() => expect(costs.releaseReservation).toHaveBeenCalledTimes(2));
    expect(g.model.doStreamCalls).toHaveLength(1);
    expect(g.recoverBeforeOutput).not.toHaveBeenCalled();
    await drain(await pending);
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(retryAt));
    expect(g.model.doStreamCalls).toHaveLength(2);
  });
  it('rechecks budget before retry without leaking a second reservation', async () => {
    const f = fixture([[{ type: 'error', error: rejected() }]]);
    const route = await f.router.route('draft');
    vi.mocked(f.router.route)
      .mockResolvedValueOnce(route)
      .mockResolvedValueOnce({ ok: false, decision: { mode: 'block', reason: 'cap reached' } });
    const outcome = await f.router.stream('draft', { prompt: 'hello', ...f });
    expect(outcome.ok).toBe(false);
    expect(f.model.doStreamCalls).toHaveLength(1);
    expect(costs.reserveCost).toHaveBeenCalledOnce();
    expect(costs.releaseReservation).toHaveBeenCalledOnce();
  });
  it('does not switch to another model if routing changes during recovery', async () => {
    const f = fixture([[{ type: 'error', error: rejected() }]]);
    const route = await f.router.route('draft');
    if (!route.ok) throw new Error('fixture route unavailable');
    vi.mocked(f.router.route)
      .mockResolvedValueOnce(route)
      .mockResolvedValueOnce({ ...route, modelId: 'configured/new-model' });
    await expect(f.router.stream('draft', { prompt: 'hello', ...f })).rejects.toThrow(
      'Model route changed',
    );
    expect(f.model.doStreamCalls).toHaveLength(1);
    expect(costs.reserveCost).toHaveBeenCalledTimes(2);
    expect(costs.releaseReservation).toHaveBeenCalledTimes(2);
    expect(costs.beginCostAttempt).toHaveBeenCalledOnce();
    expect(costs.markCostAttemptUnknown).toHaveBeenCalledOnce();
  });
  it('does not retry an authorization denial nested below a transient wrapper', async () => {
    const error = new StreamProviderError({
      message: 'gateway',
      statusCode: 429,
      cause: rejected(403),
    });
    const f = fixture([[{ type: 'error', error }]]);
    await drain(await f.router.stream('draft', { prompt: 'hello', ...f }));
    expect(f.model.doStreamCalls).toHaveLength(1);
    expect(f.onError).toHaveBeenCalledOnce();
  });
  it.each(['outer', 'inner'])('honors a non-retryable %s provider error', async (position) => {
    const denied = new StreamProviderError({
      message: 'Do not retry this provider failure',
      statusCode: 429,
      isRetryable: false,
      ...(position === 'outer' ? { cause: rejected() } : {}),
    });
    const error =
      position === 'outer'
        ? denied
        : new StreamProviderError({ message: 'gateway', statusCode: 429, cause: denied });
    const f = fixture([[{ type: 'error', error }], success]);
    await drain(await f.router.stream('draft', { prompt: 'hello', ...f }));
    expect(f.model.doStreamCalls).toHaveLength(1);
    expect(f.recoverBeforeOutput).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledOnce();
  });
  it.each(['TimeoutError', 'Error'])(
    'honors non-retryable %s wrappers and causes',
    async (name) => {
      for (const nested of [false, true]) {
        const denied = Object.assign(new Error('Do not retry'), {
          name,
          isRetryable: false,
          ...(!nested ? { cause: rejected() } : {}),
        });
        const error = nested
          ? new StreamProviderError({ message: 'gateway', statusCode: 429, cause: denied })
          : denied;
        const f = fixture([[{ type: 'error', error }], success]);
        await drain(await f.router.stream('draft', { prompt: 'hello', ...f }));
        expect(f.model.doStreamCalls).toHaveLength(1);
        expect(f.recoverBeforeOutput).not.toHaveBeenCalled();
        expect(f.onError).toHaveBeenCalledOnce();
      }
    },
  );
});
