import type { ModelRouter } from '@assistant/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type DiagnosticModelTrace, traceDiagnosticRouter } from './calendar-diagnostic-trace.js';

describe('calendar diagnostic model trace', () => {
  it('records actual method outputs and roles without extra calls or argument changes', async () => {
    const trace: DiagnosticModelTrace[] = [];
    const calls: string[] = [];
    const controller = new AbortController();
    const stepOptions = {
      prompt: 'synthetic calendar question',
      system: 'synthetic system prompt',
      messages: [{ role: 'user' as const, content: 'synthetic message' }],
      tools: { 'calendar.list_events': { description: 'synthetic tool' } },
      abortSignal: controller.signal,
    };
    const callOptions = { ...stepOptions, tools: {} };
    const stepOutput = {
      ok: true,
      modelId: 'synthetic-step-model',
      degraded: false,
      text: 'Checking the calendar.',
      toolCalls: [{ toolCallId: 'call-1', toolName: 'calendar.list_events', input: {} }],
    };
    const objectOutput = {
      ok: true,
      modelId: 'synthetic-object-model',
      degraded: false,
      object: { answer: 'synthetic' },
    };
    const generateOutput = {
      ok: true,
      modelId: 'synthetic-generate-model',
      degraded: false,
      text: 'synthetic final answer',
    };
    const embedOutput = [[0.25, 0.5]];
    const fake = {
      async step(role: string, options: typeof stepOptions) {
        expect(this).toBe(fake);
        calls.push(`step:${role}`);
        expect(options).toBe(callOptions);
        expect(options.abortSignal).toBe(controller.signal);
        return stepOutput;
      },
      async object(role: string, options: { prompt: string; schema: unknown }) {
        expect(this).toBe(fake);
        calls.push(`object:${role}`);
        expect(options.schema).toBe(schema);
        return objectOutput;
      },
      async generate(role: string, _options: { prompt: string }) {
        expect(this).toBe(fake);
        calls.push(`generate:${role}`);
        return generateOutput;
      },
      async embed(values: string[]) {
        expect(this).toBe(fake);
        calls.push('embed');
        expect(values).toBe(queries);
        return embedOutput;
      },
    };
    const schema = z.object({ answer: z.string() });
    const queries = ['synthetic query'];
    const router = traceDiagnosticRouter(fake as unknown as ModelRouter, trace);

    await expect(router.step('reason', callOptions)).resolves.toBe(stepOutput);
    await expect(
      router.object('classify', { prompt: 'synthetic object prompt', schema }),
    ).resolves.toBe(objectOutput);
    await expect(router.generate('draft', { prompt: 'synthetic final prompt' })).resolves.toBe(
      generateOutput,
    );
    await expect(router.embed(queries)).resolves.toBe(embedOutput);

    expect(calls).toEqual(['step:reason', 'object:classify', 'generate:draft', 'embed']);
    expect(trace.map(({ method, role, outcome }) => [method, role, outcome])).toEqual([
      ['step', 'reason', 'returned'],
      ['object', 'classify', 'returned'],
      ['generate', 'draft', 'returned'],
      ['embed', 'embed', 'returned'],
    ]);
    expect(trace[0]?.input).toEqual({
      system: 'synthetic system prompt',
      messages: [{ role: 'user', content: 'synthetic message' }],
      prompt: 'synthetic calendar question',
    });
    expect(trace[0]?.output).toEqual(stepOutput);
    expect(trace[0]?.output).toMatchObject({
      text: 'Checking the calendar.',
      toolCalls: [{ toolName: 'calendar.list_events' }],
    });
    expect(trace[1]?.output).toMatchObject({ object: { answer: 'synthetic' } });
    expect(trace[3]?.input).toEqual({ query: queries });
    expect(trace.every((entry) => Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= 0)).toBe(
      true,
    );
    expect(trace.every((entry) => !entry.truncated)).toBe(true);

    const capturedInput = trace[0]?.input as Record<string, unknown>;
    expect(capturedInput).not.toHaveProperty('tools');
    expect(capturedInput).not.toHaveProperty('schema');
    expect(capturedInput).not.toHaveProperty('abortSignal');
  });

  it('hashes oversized synthetic input and output with bounded UTF-8 previews', async () => {
    const trace: DiagnosticModelTrace[] = [];
    const oversized = '🗓️'.repeat(20_000);
    const output = { ok: true, modelId: 'synthetic', degraded: false, text: oversized };
    const fake = {
      async generate() {
        return output;
      },
    };
    const router = traceDiagnosticRouter(fake as unknown as ModelRouter, trace);
    await expect(router.generate('draft', { prompt: oversized })).resolves.toBe(output);

    const entry = trace[0];
    expect(entry).toBeDefined();
    if (!entry) throw new Error('Expected one captured model call');
    expect(entry.truncated).toBe(true);
    expect(entry.input).toMatchObject({
      truncated: true,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(entry.output).toMatchObject({
      truncated: true,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Buffer.byteLength(JSON.stringify(entry.input), 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(entry.output), 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect((entry.input as { preview: string }).preview).not.toMatch(/\uFFFD/);
  });

  it('records a single thrown attempt and rethrows the exact error without retrying', async () => {
    const trace: DiagnosticModelTrace[] = [];
    const error = Object.assign(new Error('synthetic provider failure'), {
      name: 'SyntheticProviderError',
    });
    let calls = 0;
    const fake = {
      async step() {
        calls += 1;
        throw error;
      },
    };
    const router = traceDiagnosticRouter(fake as unknown as ModelRouter, trace);

    await expect(
      router.step('reason', { prompt: 'synthetic failure prompt', tools: {} }),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      method: 'step',
      role: 'reason',
      outcome: 'threw',
      output: null,
      errorName: 'SyntheticProviderError',
      truncated: false,
    });
    expect(trace[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
