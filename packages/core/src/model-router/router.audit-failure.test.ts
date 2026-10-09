import type { CostRepository, ModelRoutingRepository } from '@assistant/persistence';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const stubs = vi.hoisted(() => ({
  reserveCost: vi.fn(async () => ({ ok: true, reservationId: 'hold' })),
  releaseReservation: vi.fn(async () => {}),
  beginCostAttempt: vi.fn(async () => true),
  markCostAttemptUnknown: vi.fn(async () => {}),
}));
vi.mock('../cost.js', async (original) => ({
  ...(await original<typeof import('../cost.js')>()),
  ...stubs,
}));

import { ModelRouter } from './router.js';

afterEach(() => vi.restoreAllMocks());
function fixture(mode: 'off' | 'redacted' = 'redacted', failWrite = false) {
  const failure = Object.assign(new Error('Upstream invalid request'), {
    statusCode: 400,
    isRetryable: false,
  });
  const recordAudit = failWrite
    ? vi.fn(async () => {
        throw new Error('telemetry unavailable');
      })
    : vi.fn(async () => {});
  const repository = {
    kind: 'model-routing-repository',
    costs: {} as CostRepository,
    taskBudget: vi.fn(async () => null),
    recordAudit,
  } as unknown as ModelRoutingRepository;
  const router = new ModelRouter(repository, 'test', mode);
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw failure;
    },
  });
  vi.spyOn(router, 'route').mockResolvedValue({
    ok: true,
    model: model as unknown as LanguageModel,
    modelId: 'test/provider',
    thinking: false,
    degraded: false,
    decision: { mode: 'primary' },
    params: {},
    promptCostPerMTok: 1,
    completionCostPerMTok: 1,
  });
  return { router, recordAudit, failure };
}
describe('failed model attempt capture', () => {
  it.each(['generate', 'step', 'object'] as const)(
    'keeps %s input, provider error and privacy treatment',
    async (method) => {
      const { router, recordAudit } = fixture();
      const options = {
        taskId: '00000000-0000-4000-8000-000000000001',
        system: 'Owner user@example.com',
        prompt: 'Investigate broken email',
      };
      if (method === 'generate')
        await expect(router.generate('draft', options)).rejects.toThrow('Upstream invalid request');
      else if (method === 'step')
        await expect(router.step('reason', { ...options, tools: {} })).rejects.toThrow(
          'Upstream invalid request',
        );
      else
        await router
          .object('plan', { ...options, schema: z.object({ answer: z.string() }) })
          .catch(() => {});
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: options.taskId,
          method,
          finishReason: 'error',
          capture: 'redacted',
          systemPrompt: 'Owner [email]',
          input: options.prompt,
          output: expect.stringContaining('Upstream invalid request'),
        }),
      );
      expect(JSON.stringify(recordAudit.mock.calls)).toContain('statusCode');
    },
  );
  it('honors disabled capture', async () => {
    const { router, recordAudit } = fixture('off');
    await router.generate('draft', { prompt: 'private input' }).catch(() => {});
    expect(recordAudit).not.toHaveBeenCalled();
  });
  it('preserves the actual provider failure when audit storage fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { router, failure } = fixture('redacted', true);
    await expect(router.generate('draft', { prompt: 'input' })).rejects.toBe(failure);
    expect(stubs.releaseReservation).toHaveBeenCalled();
  });
});
