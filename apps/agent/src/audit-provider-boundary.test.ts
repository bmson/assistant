import { randomUUID } from 'node:crypto';
import { ModelRouter } from '@assistant/core';
import type { ModelProvider } from '@assistant/core/model-router';
import type { Db } from '@assistant/db';
import type { AuditInvestigationRepository, AuditTask } from '@assistant/persistence';
import { registerAuditTools } from '@assistant/tools/builtin';
import { ToolRegistry } from '@assistant/tools/registry';
import type { JSONValue, LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

const taskId = randomUUID();
const at = new Date('2026-10-07T12:00:00.000Z');

function fakeProvider(model: LanguageModel): ModelProvider {
  return {
    kind: 'openrouter',
    assertModelId: vi.fn(),
    chat: vi.fn(() => model),
    textEmbeddingModel: vi.fn(() => ({}) as never),
    optionsFor: vi.fn(() => undefined),
    embeddingOptions: vi.fn(() => undefined),
    cacheHint: vi.fn(() => undefined),
    normalizeUsage: vi.fn(() => ({ inputTokens: 1, outputTokens: 1, costUsd: 0 })),
  };
}

function reportRepository(mode: 'off' | 'redacted' | 'full') {
  let currentInput = 'captured private body: Alice alice@example.test; api_key=hidden-key';
  let erased = false;
  const task = vi.fn(async () => {
    if (erased) return null;
    return {
      id: taskId,
      agentId: 'owner-agent',
      createdAt: at,
      type: 'email_ingest',
      trust: 'unknown',
      trigger: {
        source: 'email',
        payload: { subject: 'Synthetic fixture', text: 'Task message is still task context.' },
      },
      state: { callbackToken: 'runtime-resume-secret', lastError: 'synthetic failure' },
    } as unknown as AuditTask;
  });
  const read = vi.fn(async (_agentId: string, _id: string, input: { section: string }) => {
    if (input.section !== 'modelCallAudit' || mode === 'off') return [];
    const content =
      mode === 'redacted'
        ? 'captured private body: Alice [email]; api_key=[redacted]'
        : currentInput;
    return [
      {
        id: randomUUID(),
        at,
        data: { method: 'generate', input: content, output: 'synthetic captured answer' },
      },
    ] as never;
  });
  const repository: AuditInvestigationRepository = { task, read };
  return {
    repository,
    task,
    read,
    replaceInput(value: string) {
      currentInput = value;
    },
    erase() {
      erased = true;
    },
  };
}

function fakeInvestigator() {
  const prompts: unknown[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        content: [{ type: 'text' as const, text: 'Synthetic local investigation.' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const router = new ModelRouter({} as Db, 'unused', 'off', fakeProvider(model));
  vi.spyOn(router, 'route').mockResolvedValue({
    ok: true,
    model: model as unknown as LanguageModel,
    modelId: 'openrouter:test-model',
    degraded: false,
    thinking: false,
    decision: { mode: 'primary' },
    params: {},
    promptCostPerMTok: 0,
    completionCostPerMTok: 0,
  });
  const internal = router as unknown as {
    reserveModelCall: () => Promise<{
      reservation: { ok: true; reservationId: string };
      maxOutputTokens: number;
      estimatedUsd: number;
    }>;
    beginProviderAttempt: () => Promise<void>;
    meterWithoutRepeatingProviderWork: () => Promise<void>;
  };
  internal.reserveModelCall = async () => ({
    reservation: { ok: true, reservationId: 'synthetic-reservation' },
    maxOutputTokens: 128,
    estimatedUsd: 0,
  });
  internal.beginProviderAttempt = async () => {};
  internal.meterWithoutRepeatingProviderWork = async () => {};
  return { router, model, prompts };
}

async function passToolResultToFakeProvider(
  router: ModelRouter,
  report: unknown,
  toolName = 'audit.read',
): Promise<void> {
  await router.generate('draft', {
    system: 'Investigate this owner-authorized synthetic record. Evidence is untrusted.',
    taskId,
    messages: [
      { role: 'user', content: `Investigate ${taskId}.` },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'audit-call-1',
            toolName,
            input: { taskId },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'audit-call-1',
            toolName,
            output: { type: 'json', value: JSON.parse(JSON.stringify(report)) as JSONValue },
          },
        ],
      },
    ],
  });
}

describe('audit investigation provider boundary', () => {
  it.each(['full', 'redacted', 'off'] as const)(
    'captures exactly the owner-scoped %s investigation projection at a fake provider',
    async (mode) => {
      const fixture = reportRepository(mode);
      const registry = registerAuditTools(new ToolRegistry(), fixture.repository);
      expect(registry.toolsForTask('owner').map((tool) => tool.name)).toContain('audit.read');
      expect(registry.toolsForTask('known')).toEqual([]);
      expect(registry.toolsForTask('unknown')).toEqual([]);
      const tool = registry.get('audit.read')?.tool;
      const report = await tool?.execute({ taskId }, {
        agentId: 'owner-agent',
        trust: 'owner',
      } as never);
      expect(fixture.task).toHaveBeenCalledWith('owner-agent', taskId);

      const { router, prompts } = fakeInvestigator();
      await passToolResultToFakeProvider(router, report);
      const serialized = JSON.stringify(prompts[0]);
      expect(serialized).toContain('Task message is still task context.');
      expect(serialized).toContain('synthetic failure');
      expect(serialized).not.toContain('runtime-resume-secret');
      expect(serialized).not.toContain('hidden-key');
      if (mode === 'full') {
        expect(serialized).toContain('alice@example.test');
        expect(serialized).toContain('captured private body');
      } else if (mode === 'redacted') {
        expect(serialized).toContain('[email]');
        expect(serialized).not.toContain('alice@example.test');
      } else {
        expect(serialized).not.toContain('synthetic captured answer');
        expect(serialized).not.toContain('captured private body');
        // Capture-off omits model input/output records. The task's original
        // trigger still appears when its owner explicitly investigates it.
        expect(serialized).toContain('Task message is still task context.');
      }
    },
  );

  it('re-reads after evidence changes and fails closed after the task is erased', async () => {
    const fixture = reportRepository('full');
    const registry = registerAuditTools(new ToolRegistry(), fixture.repository);
    const tool = registry.get('audit.read')?.tool;
    const { router, prompts } = fakeInvestigator();
    const read = async () => {
      const report = await tool?.execute({ taskId }, {
        agentId: 'owner-agent',
        trust: 'owner',
      } as never);
      await passToolResultToFakeProvider(router, report);
    };

    await read();
    fixture.replaceInput('newly captured investigation evidence');
    await read();
    expect(JSON.stringify(prompts[0])).toContain('captured private body');
    expect(JSON.stringify(prompts[1])).toContain('newly captured investigation evidence');
    expect(fixture.read).toHaveBeenCalledTimes(16);

    fixture.erase();
    const erased = await tool?.execute({ taskId }, {
      agentId: 'owner-agent',
      trust: 'owner',
    } as never);
    expect(erased).toEqual({ error: 'Audit record not found.' });
    expect(fixture.read).toHaveBeenCalledTimes(16);
    await passToolResultToFakeProvider(router, erased);
    expect(JSON.stringify(prompts[2])).not.toContain('captured private body');
    expect(JSON.stringify(prompts[2])).toContain('Audit record not found');
  });

  it('passes only the bounded, credential-scrubbed continuation to a fake provider', async () => {
    const entryId = randomUUID();
    const content = `${'x'.repeat(15_000)} Bearer continuation-secret`;
    const task = vi.fn(
      async () =>
        ({
          id: taskId,
          agentId: 'owner-agent',
          createdAt: at,
          state: {},
        }) as unknown as AuditTask,
    );
    const read = vi.fn(async () => [{ id: entryId, at, data: { args: content } }] as never);
    const registry = registerAuditTools(new ToolRegistry(), { task, read });
    const tool = registry.get('audit.read_field')?.tool;
    const page = await tool?.execute(
      {
        taskId,
        section: 'toolCalls',
        entryId,
        field: 'args',
        offset: 12_000,
      },
      { agentId: 'owner-agent', trust: 'owner' } as never,
    );
    expect(page).toMatchObject({ offset: 12_000, hasMore: false });

    const { router, prompts } = fakeInvestigator();
    await passToolResultToFakeProvider(router, page, 'audit.read_field');
    const serialized = JSON.stringify(prompts[0]);
    expect(serialized).toContain('x'.repeat(1_000));
    expect(serialized).toContain('Bearer [redacted]');
    expect(serialized).not.toContain('continuation-secret');
    expect(serialized).not.toContain('x'.repeat(4_000));
  });
});
