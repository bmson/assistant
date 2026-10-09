import type { Db } from '@assistant/db';
import type { LanguageModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  streamText: vi.fn(),
  releaseReservation: vi.fn(async () => {}),
  reserveCost: vi.fn(async () => ({ ok: true as const, reservationId: 'reservation-1' })),
  beginCostAttempt: vi.fn(async () => true),
  markCostAttemptUnknown: vi.fn(async () => {}),
}));

vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => ({ chat: vi.fn(), textEmbeddingModel: vi.fn() }),
}));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: stubs.streamText,
}));

vi.mock('../cost.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cost.js')>()),
  reserveCost: stubs.reserveCost,
  releaseReservation: stubs.releaseReservation,
  beginCostAttempt: stubs.beginCostAttempt,
  markCostAttemptUnknown: stubs.markCostAttemptUnknown,
}));

import { ModelRouter } from './router.js';

function makeRouter({ thinking = false }: { thinking?: boolean } = {}) {
  const router = new ModelRouter({} as Db, 'test-key');
  vi.spyOn(router, 'route').mockResolvedValue({
    ok: true,
    model: {} as LanguageModel,
    modelId: 'test/model',
    degraded: false,
    thinking,
    decision: { mode: 'primary' },
    params: {},
    promptCostPerMTok: 1,
    completionCostPerMTok: 1,
  });
  const meter = vi.fn(async () => {});
  (
    router as unknown as {
      meterWithoutRepeatingProviderWork: typeof meter;
    }
  ).meterWithoutRepeatingProviderWork = meter;
  return { router, meter };
}

function fakeStreamResult() {
  return {
    text: Promise.resolve('answer'),
    toUIMessageStreamResponse: () => new Response(),
  };
}

describe('ModelRouter streaming finalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.reserveCost.mockResolvedValue({ ok: true, reservationId: 'reservation-1' });
    stubs.streamText.mockReturnValue(fakeStreamResult());
  });

  it('releases the reservation and reports asynchronous stream errors', async () => {
    const { router } = makeRouter();
    const onError = vi.fn(async () => {});
    const outcome = await router.stream('draft', { prompt: 'hello', onError });
    expect(outcome.ok).toBe(true);

    const options = stubs.streamText.mock.calls[0]?.[0] as {
      onError: (event: { error: unknown }) => Promise<void>;
    };
    const error = new Error('provider stream failed');
    await options.onError({ error });
    expect(stubs.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cost-repository' }),
      'reservation-1',
    );
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('waits for durable completion and propagates persistence failures', async () => {
    const { router, meter } = makeRouter();
    const failure = new Error('database unavailable');
    const onComplete = vi.fn(async () => {
      throw failure;
    });
    await router.stream('draft', { prompt: 'hello', onComplete });
    const options = stubs.streamText.mock.calls[0]?.[0] as {
      onFinish: (event: { text: string }) => Promise<void>;
    };

    await expect(options.onFinish({ text: 'answer' })).rejects.toBe(failure);
    expect(meter).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith('answer');
  });

  it('runs only the first terminal path when finish, error, and abort race', async () => {
    const { router, meter } = makeRouter();
    const onComplete = vi.fn(async () => {});
    const onError = vi.fn(async () => {});
    await router.stream('draft', { prompt: 'hello', onComplete, onError });
    const options = stubs.streamText.mock.calls[0]?.[0] as {
      onFinish: (event: { text: string }) => Promise<void>;
      onError: (event: { error: unknown }) => Promise<void>;
      onAbort: () => Promise<void>;
    };

    await Promise.all([
      options.onFinish({ text: 'answer' }),
      options.onError({ error: new Error('late error') }),
      options.onAbort(),
    ]);

    expect(meter).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(stubs.releaseReservation).not.toHaveBeenCalled();
  });

  it('keeps error terminal when finish and abort arrive afterward', async () => {
    const { router, meter } = makeRouter();
    const onComplete = vi.fn(async () => {});
    const onError = vi.fn(async () => {});
    await router.stream('draft', { prompt: 'hello', onComplete, onError });
    const options = stubs.streamText.mock.calls[0]?.[0] as {
      onFinish: (event: { text: string }) => Promise<void>;
      onError: (event: { error: unknown }) => Promise<void>;
      onAbort: () => Promise<void>;
    };
    const error = new Error('provider stream failed');

    await options.onError({ error });
    await Promise.all([options.onFinish({ text: 'late' }), options.onAbort()]);

    expect(meter).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error);
    expect(stubs.releaseReservation).toHaveBeenCalledOnce();
  });

  it('does not complete when the SDK reports an error finish reason', async () => {
    const { router, meter } = makeRouter();
    const onComplete = vi.fn(async () => {});
    const onError = vi.fn(async () => {});
    await router.stream('draft', { prompt: 'hello', onComplete, onError });
    const options = stubs.streamText.mock.calls[0]?.[0] as {
      onFinish: (event: { text: string; finishReason: string }) => Promise<void>;
    };

    await options.onFinish({ text: '', finishReason: 'error' });

    expect(meter).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('error') }),
    );
  });

  it('releases a reservation when stream setup throws synchronously', async () => {
    const { router } = makeRouter();
    stubs.streamText.mockImplementationOnce(() => {
      throw new Error('setup failed');
    });
    await expect(router.stream('draft', { prompt: 'hello' })).rejects.toThrow('setup failed');
    expect(stubs.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cost-repository' }),
      'reservation-1',
    );
  });

  it('keeps reasoning and answer headroom when a model is not known to allow disabling it', async () => {
    const { router } = makeRouter({ thinking: true });
    await router.stream('draft', { prompt: 'hello' });
    const args = stubs.streamText.mock.calls[0]?.[0] as {
      maxOutputTokens: number;
      providerOptions?: { openrouter?: { reasoning?: { max_tokens?: number; enabled?: boolean } } };
    };
    expect(args.maxOutputTokens).toBe(2048 + 4096);
    expect(args.providerOptions?.openrouter?.reasoning).toEqual({ max_tokens: 4096 });
  });

  it('leaves a plain model at its visible budget with no reasoning options', async () => {
    const { router } = makeRouter({ thinking: false });
    await router.stream('draft', { prompt: 'hello' });
    const args = stubs.streamText.mock.calls[0]?.[0] as {
      maxOutputTokens: number;
      providerOptions?: unknown;
    };
    expect(args.maxOutputTokens).toBe(2048);
    expect(args.providerOptions).toBeUndefined();
  });
});
