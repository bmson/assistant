import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { QuestionCase } from '../packages/tools/src/question-regression/corpus.js';
import { buildQuestionPreparation } from './question-regression-preparation.js';

function fixture(overrides: Partial<QuestionCase> = {}): QuestionCase {
  return {
    id: 'calendar-diagnostic-synthetic',
    records: [41],
    request: 'What is on my calendar tomorrow?',
    history: [{ role: 'user', text: 'Use the Work calendar.' }],
    executionPath: 'production-routing',
    at: '2026-10-23T12:00:00.000Z',
    timeZone: 'America/Los_Angeles',
    localTools: [
      {
        name: 'calendar.list_events',
        description: 'List synthetic calendar events.',
        schema: z.object({
          timeMin: z.string(),
          timeMax: z.string(),
          pageToken: z.string().optional(),
        }),
        risk: 'autonomous',
        flags: { confidentialRead: true, writesWorkspace: false },
        outcomes: [
          {
            result: {
              events: [
                {
                  summary: 'Synthetic review',
                  startsAt: '2026-10-24T09:00:00.000-07:00',
                  description:
                    'PRIVATE_CALENDAR_DIAGNOSTIC_SYNTHETIC. Preserve this causal marker.',
                },
              ],
              nextPageToken: 'synthetic-calendar-page-2',
              apiKey: 'synthetic-must-not-be-captured',
              nested: { refreshToken: 'synthetic-refresh-must-not-be-captured', retained: true },
              authorization: 'Bearer synthetic-bearer-must-not-be-captured',
              note: 'Bearer synthetic-inline-bearer-must-not-be-captured',
            },
          },
        ],
      },
    ],
    script: [],
    expect: { matches: ['Synthetic review'], tools: ['calendar.list_events'] },
    independentRubric: ['Preserve the requested date and calendar scope.'],
    ...overrides,
  };
}

function preparation(fixtures: QuestionCase[], blockers: string[] = []) {
  return buildQuestionPreparation({
    fixtures,
    suite: 'calendar-diagnostic',
    partition: 'development',
    version: 'calendar-diagnostic-v1',
    sourceCommit: 'abc123',
    workingTreeDirty: true,
    sourceHashes: { 'b.ts': 'hash-b', 'a.ts': 'hash-a' },
    configSha256: 'config-hash',
    blockers,
  });
}

describe('question regression preparation manifest', () => {
  it('is deterministic and records synthetic prompt, schema, setup, evidence, and unrun state separately', () => {
    const input = fixture();
    const before = JSON.stringify({
      id: input.id,
      request: input.request,
      history: input.history,
      records: input.records,
      outcomes: input.localTools?.[0]?.outcomes,
    });
    const first = preparation([input]);
    const second = preparation([input]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      manifestVersion: 1,
      mode: 'prepare',
      status: 'not_run',
      suite: 'calendar-diagnostic',
      partition: 'development',
      sourceCommit: 'abc123',
      workingTreeDirty: true,
      sourceHashes: { 'a.ts': 'hash-a', 'b.ts': 'hash-b' },
      configSha256: 'config-hash',
    });
    const preparedCase = first.cases[0];
    expect(preparedCase).toMatchObject({
      id: input.id,
      request: input.request,
      history: input.history,
      timeZone: 'America/Los_Angeles',
      frozenAt: '2026-10-23T12:00:00.000Z',
      run: {
        status: 'not_run',
        modelCalls: null,
        toolCalls: null,
        latencyMs: null,
        tokens: null,
        costUsd: null,
        quality: 'not_evaluated',
      },
    });
    const tools = preparedCase?.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools?.[0]).toMatchObject({
      name: 'calendar.list_events',
      description: 'List synthetic calendar events.',
      risk: 'autonomous',
      flags: { confidentialRead: true, writesWorkspace: false },
      schema: {
        type: 'object',
        properties: {
          timeMin: { type: 'string' },
          timeMax: { type: 'string' },
          pageToken: { type: 'string' },
        },
      },
    });
    const expected = preparedCase?.evidenceExpected as Record<string, unknown>;
    expect(expected).toMatchObject({
      records: [41],
      expected: { matches: ['Synthetic review'], tools: ['calendar.list_events'] },
      rubric: ['Preserve the requested date and calendar scope.'],
    });
    expect(preparedCase).not.toHaveProperty('plan');
    expect(preparedCase).not.toHaveProperty('script');
    expect(JSON.stringify(preparedCase)).not.toContain('synthetic-must-not-be-captured');
    expect(JSON.stringify(preparedCase)).not.toContain('synthetic-refresh-must-not-be-captured');
    expect(JSON.stringify(preparedCase)).not.toContain('synthetic-bearer-must-not-be-captured');
    expect(JSON.stringify(preparedCase)).not.toContain(
      'synthetic-inline-bearer-must-not-be-captured',
    );
    expect(JSON.stringify(preparedCase)).toContain('PRIVATE_CALENDAR_DIAGNOSTIC_SYNTHETIC');
    expect(JSON.stringify(preparedCase)).toContain('synthetic-calendar-page-2');
    expect(
      JSON.stringify({
        id: input.id,
        request: input.request,
        history: input.history,
        records: input.records,
        outcomes: input.localTools?.[0]?.outcomes,
      }),
    ).toBe(before);
    expect(first.corpusSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.schemaManifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes the schema manifest hash when the actual Zod schema changes', () => {
    const first = preparation([fixture()]);
    const baseTool = fixture().localTools?.[0];
    if (!baseTool) throw new Error('Expected one synthetic local tool');
    const changed = preparation([
      fixture({
        localTools: [
          {
            ...baseTool,
            schema: z.object({ timeMin: z.string(), calendarId: z.string() }),
          },
        ],
      }),
    ]);
    expect(changed.schemaManifestSha256).not.toBe(first.schemaManifestSha256);
  });

  it('retains opaque pagination cursors and changes the corpus hash when cursor evidence changes', () => {
    const original = fixture();
    const originalTool = original.localTools?.[0];
    if (!originalTool) throw new Error('Expected one synthetic local tool');
    const first = preparation([original]);
    const outcome = originalTool.outcomes[0];
    if (!outcome || !('result' in outcome))
      throw new Error('Expected one synthetic result outcome');
    const changed = preparation([
      fixture({
        localTools: [
          {
            ...originalTool,
            outcomes: [
              {
                result: {
                  ...(outcome.result as Record<string, unknown>),
                  nextPageToken: 'synthetic-calendar-page-3',
                  pageToken: 'synthetic-calendar-page-2',
                },
              },
            ],
          },
        ],
      }),
    ]);

    expect(changed.schemaManifestSha256).toBe(first.schemaManifestSha256);
    expect(changed.corpusSha256).not.toBe(first.corpusSha256);
    expect(JSON.stringify(changed.cases[0]?.tools)).toContain('synthetic-calendar-page-3');
    expect(JSON.stringify(changed.cases[0]?.tools)).toContain('synthetic-calendar-page-2');
  });

  it('rejects duplicate IDs and unsupported non-production fixture modes', () => {
    expect(() => preparation([fixture(), fixture()])).toThrow(/Duplicate question fixture ID/);
    expect(() => preparation([fixture({ executionPath: undefined })])).toThrow(
      /production-routing/,
    );
    expect(() => preparation([fixture({ script: [{ text: 'scripted answer' }] })])).toThrow(
      /scripted answers/,
    );
    expect(() => preparation([fixture({ plan: 'clarify' })])).toThrow(/preset plans/);
  });

  it('keeps explicit blockers in a not-run manifest without claiming zero metrics or a pass', () => {
    const manifest = preparation([fixture()], ['Review config capture before any execution.']);
    expect(manifest.status).toBe('not_run');
    expect(manifest.blockers).toEqual(['Review config capture before any execution.']);
    expect(manifest.cases[0]?.run).toEqual({
      status: 'not_run',
      modelCalls: null,
      toolCalls: null,
      latencyMs: null,
      tokens: null,
      costUsd: null,
      quality: 'not_evaluated',
    });
  });
});
