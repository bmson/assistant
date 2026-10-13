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
    expect(object).toHaveBeenCalledTimes(1);
    expect(object.mock.calls[0]?.[1]).toMatchObject({
      maxRetries: 0,
      singleAttempt: true,
      requestProfile: { tools: 'none' },
    });
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
});
