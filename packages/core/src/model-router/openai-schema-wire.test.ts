import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { describe, expect, it } from 'vitest';
import { PlanSchema } from '../events.js';

function fakeCompletion(content: unknown) {
  return {
    id: 'chatcmpl-synthetic',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4.1-mini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(content) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function offlineOpenAI(responseValue: unknown) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const provider = createOpenAI({
    apiKey: 'synthetic-test-key',
    fetch: async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api.openai.com/v1/chat/completions')) {
        throw new Error(`Unexpected synthetic request URL: ${url}`);
      }
      requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify(fakeCompletion(responseValue)), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { model: provider.chat('gpt-4.1-mini'), requests };
}

describe('OpenAI structured output schema compatibility', () => {
  it('sends the optional PlanSchema as non-strict schema and still applies Zod defaults', async () => {
    const { model, requests } = offlineOpenAI({ action: 'reply' });
    const result = await generateObject({
      model,
      schema: PlanSchema,
      providerOptions: { openai: { strictJsonSchema: false } },
      prompt: 'Return a plan.',
    });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error('Expected one captured request');
    expect(request.url).toBe('https://api.openai.com/v1/chat/completions');
    const format = (
      request.body.response_format as {
        json_schema: { strict: boolean; schema: Record<string, unknown> };
      }
    ).json_schema;
    expect(format.strict).toBe(false);
    expect(format.schema.required).toEqual(['action']);
    expect(format.schema.oneOf).toBeUndefined();
    expect(
      (format.schema.properties as Record<string, { anyOf?: unknown[] }>).cadence?.anyOf,
    ).toHaveLength(2);
    expect(result.object).toMatchObject({
      action: 'reply',
      reasoning: '',
      steps: [],
      missingInfo: [],
    });
  });

  it('keeps local Zod validation fail-closed when the provider returns an invalid plan', async () => {
    const { model, requests } = offlineOpenAI({
      action: 'reply',
      cadence: { kind: 'interval', everyMinutes: 5 },
    });

    await expect(
      generateObject({
        model,
        schema: PlanSchema,
        providerOptions: { openai: { strictJsonSchema: false } },
        prompt: 'Return a plan.',
      }),
    ).rejects.toThrow('No object generated: response did not match schema.');
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error('Expected one captured request');
    const format = request.body.response_format as {
      json_schema: { strict: boolean };
    };
    expect(format.json_schema.strict).toBe(false);
  });
});
