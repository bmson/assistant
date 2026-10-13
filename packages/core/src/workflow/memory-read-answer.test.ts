import { conversationMessageSpeakerRevision } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  memoryReadSources,
  renderMemoryReadAnswer,
  selectMemoryReadAnswer,
  validMemoryReadSelection,
} from './memory-read-answer.js';
import type { ActionEvidence } from './response-contract.js';

const message = (id: string, text: string, role: string, origin: string) => ({
  messageId: id,
  conversationId: 'historic-chat',
  text,
  role,
  origin,
  speakerRevision: conversationMessageSpeakerRevision(id, text, role, origin),
  createdAt: '2026-10-10T12:00:00.000Z',
});
const evidence: ActionEvidence[] = [
  {
    toolName: 'conversations.search',
    status: 'succeeded',
    result: {
      matches: [
        message(
          'owner-correction',
          'My Berlin flight is actually at 13:45, not 09:15.',
          'user',
          'owner',
        ),
        message('assistant-claim', 'Your flight departs at 09:15.', 'assistant', 'assistant'),
      ],
    },
  },
  {
    toolName: 'memory.recall',
    status: 'succeeded',
    result: {
      memories: [
        {
          id: 'ui',
          content: 'Owner prefers minimal UI with careful typography.',
          source: 'extraction',
          ownerConfirmed: true,
          confidence: '0.9',
        },
        {
          id: 'jobs',
          content: 'Owner authorized job applications.',
          source: 'dream',
          originTrust: 'assistant',
          ownerConfirmed: false,
          unconfirmed: true,
          confidence: '0.4',
        },
      ],
    },
  },
];
const selection = {
  version: 1 as const,
  status: 'complete' as const,
  selections: [
    {
      sourceKey: 'message:owner-correction',
      quote: 'My Berlin flight is actually at 13:45, not 09:15.',
    },
    { sourceKey: 'message:assistant-claim', quote: 'Your flight departs at 09:15.' },
  ],
};
describe('exact historical source projection', () => {
  it('keeps owner correction and assistant claim separate, with actual source identities and historical limits', () => {
    const text = renderMemoryReadAnswer(selection, evidence);
    expect(text).toContain('Recorded owner message');
    expect(text).toContain('Earlier assistant claim (not verified fact)');
    expect(text).toContain('13:45');
    expect(text).toContain('message owner-correction');
    expect(text).toContain('not a fresh check');
    expect(text).not.toContain('job applications');
  });
  it('does not promote legacy or forged speaker metadata to owner authorship', () => {
    const row = message('legacy', 'The UI is minimal.', 'user', 'owner');
    row.speakerRevision = 'forged';
    const sources = memoryReadSources([
      { toolName: 'conversations.search', status: 'succeeded', result: { matches: [row] } },
    ]);
    expect(sources[0]?.speaker).toBe('Historical message (authorship not confirmed)');
  });
  it('rejects invented quotes, changed source bodies, and duplicate selections', () => {
    const originalEvidence = evidence[0];
    const firstSelection = selection.selections[0];
    if (!originalEvidence || !firstSelection) throw new Error('Missing test sources');
    expect(
      validMemoryReadSelection(
        {
          ...selection,
          selections: [
            { sourceKey: 'message:owner-correction', quote: 'The flight departs at 14:00.' },
          ],
        },
        evidence,
      ),
    ).toBe(false);
    expect(
      validMemoryReadSelection(selection, [
        {
          ...originalEvidence,
          result: {
            matches: [message('owner-correction', 'Correction withdrawn.', 'user', 'owner')],
          },
        },
      ]),
    ).toBe(false);
    expect(
      validMemoryReadSelection(
        { ...selection, selections: [firstSelection, firstSelection] },
        evidence,
      ),
    ).toBe(false);
  });
  it('ignores failed and earlier-task evidence', () => {
    expect(memoryReadSources(evidence.map((row) => ({ ...row, fromCurrentTask: false })))).toEqual(
      [],
    );
    expect(memoryReadSources(evidence.map((row) => ({ ...row, status: 'failed' })))).toEqual([]);
  });
  it('keeps an empty relevance selection bounded and does not dump unrelated neighbors', () => {
    const text = renderMemoryReadAnswer({ ...selection, selections: [] }, evidence);
    expect(text).toContain('bounded historical lookup');
    expect(text).not.toContain('applications');
    expect(text).toContain('does not establish that we never discussed it');
  });
  it('preserves saved inference and confidence without pretending it is an owner quote', () => {
    const text = renderMemoryReadAnswer(
      {
        ...selection,
        selections: [{ sourceKey: 'memory:jobs', quote: 'Owner authorized job applications.' }],
      },
      evidence,
    );
    expect(text).toContain('Saved assistant inference');
    expect(text).toContain('confidence 40%');
    expect(text).not.toContain('Recorded owner message');
  });
  it('bounds the selection call and rejects a generative fabricated passage', async () => {
    const object = vi.fn(async (_role: string, _options: Record<string, unknown>) => ({
      ok: true,
      object: { selections: [{ sourceKey: 'memory:ui', quote: 'Owner wants a busy dashboard.' }] },
    }));
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request: 'What are my UI preferences?',
      evidence,
    });
    expect(result.status).toBe('unavailable');
    expect(result.failureReason).toBe('invalid_quote');
    expect(object).toHaveBeenCalledTimes(1);
    expect(object.mock.calls[0]?.[1]).toMatchObject({
      maxRetries: 0,
      singleAttempt: true,
      requestProfile: { tools: 'none' },
    });
  });
  it('rejects a valid quote from a source omitted by the selector prompt budget', async () => {
    const matches = Array.from({ length: 8 }, (_, index) =>
      message(
        `owner-${index}`,
        `Owner note ${index}: ${'x'.repeat(3_900)} distinctive end phrase ${index}.`,
        'user',
        'owner',
      ),
    );
    const inputEvidence: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: { matches },
      },
    ];
    const object = vi.fn(async (_role: string, options: Record<string, unknown>) => {
      const prompt = JSON.parse(String(options.prompt)) as {
        sources: Array<{ key: string; body: string }>;
      };
      expect(prompt.sources.length).toBeLessThan(matches.length);
      const hidden = matches.at(-1);
      if (!hidden) throw new Error('Expected hidden source');
      return {
        ok: true,
        object: {
          selections: [
            { sourceKey: `message:${hidden.messageId}`, quote: 'distinctive end phrase 7' },
          ],
        },
      };
    });
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request: 'What did I tell you?',
      evidence: inputEvidence,
    });
    expect(result).toMatchObject({ status: 'unavailable', failureReason: 'invalid_quote' });
    expect(
      renderMemoryReadAnswer(
        {
          version: 1,
          status: 'complete',
          selections: [
            {
              sourceKey: `message:${matches.at(-1)?.messageId}`,
              quote: 'distinctive end phrase 7',
            },
          ],
        },
        inputEvidence,
      ),
    ).toContain('could not reliably select passages');
  });
  it('accepts only existing source IDs and exact relevant quotations', async () => {
    const object = vi.fn(async (_role: string, _options: Record<string, unknown>) => ({
      ok: true,
      object: {
        selections: [
          { sourceKey: 'memory:ui', quote: 'Owner prefers minimal UI with careful typography.' },
        ],
      },
    }));
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request: 'What are my UI preferences?',
      evidence,
    });
    expect(result.status).toBe('complete');
    const text = renderMemoryReadAnswer(result, evidence);
    expect(text).toContain('careful typography');
    expect(text).not.toContain('job applications');
  });
  it('removes an exact repeated current question and gives verified owner sources priority', async () => {
    const request = 'What did I previously tell you about my meeting-summary format?';
    const ownerText = 'I prefer concise meeting summaries with decisions at the top.';
    const candidates: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: [
            message(
              'assistant-neighbor',
              'A long unrelated assistant statement.',
              'assistant',
              'assistant',
            ),
            message('repeated-question', request, 'user', 'owner'),
            message('owner-preference', ownerText, 'user', 'owner'),
          ],
        },
      },
    ];
    const object = vi.fn(async (_role: string, _options: Record<string, unknown>) => ({
      ok: true,
      object: {
        selections: [{ sourceKey: 'message:owner-preference', quote: ownerText }],
      },
    }));

    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: candidates,
    });
    expect(result).toMatchObject({
      status: 'complete',
      selections: [{ sourceKey: 'message:owner-preference' }],
    });
    const call = object.mock.calls[0]?.[1];
    if (!call || typeof call.prompt !== 'string')
      throw new Error('Expected bounded selector prompt');
    const prompt = JSON.parse(call.prompt) as { sources: Array<{ key: string; speaker: string }> };
    expect(prompt.sources.map((source) => source.key)).toEqual([
      'message:owner-preference',
      'message:assistant-neighbor',
    ]);
    expect(prompt.sources.map((source) => source.key)).not.toContain('message:repeated-question');
    expect(prompt.sources.some((source) => source.speaker === 'Recorded owner message')).toBe(true);
    expect(validMemoryReadSelection(result, candidates, request)).toBe(true);
    const rendered = renderMemoryReadAnswer(result, candidates, request);
    expect(rendered).toContain(ownerText);
    expect(rendered).not.toContain('repeated-question');
  });
  it('records selector failure classes without exposing provider diagnostics', async () => {
    const providerFailure = await selectMemoryReadAnswer({
      router: {
        object: vi.fn(async () => ({ ok: false, error: new Error('private provider detail') })),
      } as never,
      taskId: 'qa',
      request: 'What did I tell you about meeting summaries?',
      evidence,
    });
    expect(providerFailure).toMatchObject({
      status: 'unavailable',
      failureReason: 'provider_unavailable',
      selections: [],
    });
    expect(JSON.stringify(providerFailure)).not.toContain('private provider detail');

    const invalidResult = await selectMemoryReadAnswer({
      router: {
        object: vi.fn(async () => ({ ok: true, object: { selections: 'not-an-array' } })),
      } as never,
      taskId: 'qa',
      request: 'What did I tell you about meeting summaries?',
      evidence,
    });
    expect(invalidResult).toMatchObject({ status: 'unavailable', failureReason: 'invalid_result' });
  });
});
