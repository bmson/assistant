import {
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  memoryContextAnchorRefs,
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
  sourceRevision: conversationMessageSourceRevision(id, text),
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
    expect(text).toContain('](/chat/historic-chat#message-owner-correction)');
    expect(text).not.toContain('message owner-correction');
    expect(text).toContain('not a fresh check');
    expect(text).not.toContain('job applications');
  });
  it('does not deduplicate identical wording across different speakers', () => {
    const shared = 'The Berlin flight is at 13:45.';
    const sources: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: [
            message('owner-shared', shared, 'user', 'owner'),
            message('assistant-shared', shared, 'assistant', 'assistant'),
          ],
        },
      },
    ];
    const rendered = renderMemoryReadAnswer(
      {
        version: 1,
        status: 'complete',
        selections: [
          { sourceKey: 'message:owner-shared', quote: shared },
          { sourceKey: 'message:assistant-shared', quote: shared },
        ],
      },
      sources,
    );

    expect(rendered.split(`“${shared}”`).length - 1).toBe(2);
    expect(rendered).toContain('Recorded owner message');
    expect(rendered).toContain('Earlier assistant claim (not verified fact)');
    expect(rendered).toContain('](/chat/');
    expect(rendered).not.toContain('message owner-shared');
    expect(rendered).toContain('#message-assistant-shared)');
  });
  it('does not promote legacy or forged speaker metadata to owner authorship', () => {
    const row = message('legacy', 'The UI is minimal.', 'user', 'owner');
    row.speakerRevision = 'forged';
    const sources = memoryReadSources([
      { toolName: 'conversations.search', status: 'succeeded', result: { matches: [row] } },
    ]);
    expect(sources[0]?.speaker).toBe('Historical message (authorship not confirmed)');
  });
  it('adds context neighbors only from a revision-bound receipt anchored in a current search', () => {
    const assistant = message(
      'context-assistant',
      'For the fictional Cobalt exercise, use a $400 budget.',
      'assistant',
      'assistant',
    );
    const owner = message(
      'context-owner',
      'My original budget for the fictional Cobalt exercise was $250.',
      'user',
      'owner',
    );
    const anchor = {
      messageId: assistant.messageId,
      conversationId: assistant.conversationId,
      sourceRevision: conversationMessageSourceRevision(assistant.messageId, assistant.text),
      speakerRevision: assistant.speakerRevision,
    };
    const rows: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { query: 'Cobalt' },
        result: { matches: [assistant] },
      },
      {
        toolName: 'conversations.context',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { anchors: [anchor] },
        result: {
          mode: 'context',
          anchors: [anchor],
          matches: [owner, assistant],
          window: { before: 3, after: 1 },
          observationGeneration: 'generation-1',
        },
      },
    ];
    const request =
      "Compare the fictional Cobalt exercise: my original budget from the assistant's earlier recommendation.";
    expect(memoryReadSources(rows, request).map((source) => source.key)).toEqual([
      'message:context-owner',
      'message:context-assistant',
    ]);
    const forged = structuredClone(rows);
    const context = forged[1];
    if (!context?.result || typeof context.result !== 'object')
      throw new Error('Missing context receipt');
    const firstAnchor = (context.result as { anchors: Array<{ speakerRevision: string }> })
      .anchors[0];
    if (!firstAnchor) throw new Error('Missing context anchor');
    firstAnchor.speakerRevision = 'stale';
    expect(memoryReadSources(forged, request).map((source) => source.key)).toEqual([
      'message:context-assistant',
    ]);
    const missingCurrentMarker = structuredClone(rows);
    const historicalSearch = missingCurrentMarker[0];
    if (!historicalSearch) throw new Error('Missing search receipt');
    delete historicalSearch.fromCurrentTask;
    expect(memoryReadSources(missingCurrentMarker, request).map((source) => source.key)).toEqual([
      'message:context-assistant',
    ]);
    const unmarkedContext = structuredClone(rows);
    const contextWithoutMarker = unmarkedContext[1];
    if (!contextWithoutMarker) throw new Error('Missing context receipt');
    delete contextWithoutMarker.fromCurrentTask;
    expect(memoryReadSources(unmarkedContext, request).map((source) => source.key)).toEqual([
      'message:context-assistant',
    ]);
  });
  it('chooses exact context anchors from later relevant search results without hardcoded positions', () => {
    const matches = Array.from({ length: 20 }, (_, index) => {
      const id = `search-${index}`;
      const body =
        index === 12 || index === 14
          ? `For the fictional Cobalt exercise, I recommend a $${index === 12 ? '400' : '350'} budget.`
          : `Unrelated note ${index} about an ordinary meeting.`;
      return {
        ...message(id, body, 'assistant', 'assistant'),
        conversationId: `chat-${index === 14 ? 14 : index === 12 ? 12 : 'other'}`,
      };
    });
    const request =
      "Compare the fictional Cobalt exercise: my original budget from the assistant's earlier recommendation.";
    const refs = memoryContextAnchorRefs(request, [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { query: 'Cobalt', limit: 20 },
        result: { matches },
      },
    ]);
    expect(refs.map((ref) => ref.messageId)).toEqual(['search-12', 'search-14']);
    expect(refs.every((ref) => ref.speakerRevision && ref.sourceRevision)).toBe(true);
    expect(memoryContextAnchorRefs(request, [])).toEqual([]);
    expect(
      memoryContextAnchorRefs('Compare real Cobalt project statements from my original budget.', [
        {
          toolName: 'conversations.search',
          status: 'succeeded',
          fromCurrentTask: true,
          result: { matches },
        },
      ]),
    ).toEqual([]);
  });
  it('does not request context when current search already returned a complete comparison pair', () => {
    const request =
      "Compare the fictional Cobalt exercise: my original budget from the assistant's earlier recommendation.";
    const rows: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { query: 'Cobalt' },
        result: {
          matches: [
            message(
              'cobalt-owner',
              'My original budget for the fictional Cobalt exercise was $250.',
              'user',
              'owner',
            ),
            message(
              'cobalt-assistant',
              'For the fictional Cobalt exercise, I recommend a $400 budget.',
              'assistant',
              'assistant',
            ),
          ],
        },
      },
    ];

    expect(memoryContextAnchorRefs(request, rows)).toEqual([]);
    expect(memoryContextAnchorRefs(request, rows, false)).toEqual([]);
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
    expect(text).toContain('does not establish that it was never discussed');
    expect(text).toContain('returned 2 conversation result rows across 1 successful search');
    expect(text).toContain('saved-memory lookup returned 2 candidate rows');
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
  it('does not require an assistant-side quote for an owner preference contrasted only with inference', async () => {
    const request =
      'What preferences have I previously told you about the Assistant’s UI and how its replies should look? Use saved memory or our earlier conversations. Distinguish what I actually said from your inference, mention your sources, and do not guess or save new memories.';
    const object = vi.fn(async () => ({
      ok: true,
      object: {
        selections: [
          {
            sourceKey: 'memory:ui',
            quote: 'Owner prefers minimal UI with careful typography.',
          },
        ],
      },
    }));
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence,
    });
    expect(result.status).toBe('complete');
    expect(result.selections).toHaveLength(1);
    expect(object).toHaveBeenCalledTimes(1);
    expect(validMemoryReadSelection(result, evidence, request)).toBe(true);
    expect(renderMemoryReadAnswer(result, evidence, request)).toContain('careful typography');
  });
  it('rechecks bounded owner-authored sources when a history question gets an empty selection', async () => {
    const request = 'What UI and accessibility preferences have I told you about?';
    const candidates: ActionEvidence[] = [
      {
        toolName: 'memory.recall',
        status: 'succeeded',
        result: {
          memories: [
            {
              id: 'confirmed-ui',
              content: 'I prefer a minimal interface, clear typography, and accessible controls.',
              source: 'extraction',
              ownerConfirmed: true,
            },
            {
              id: 'assistant-guess',
              content: 'The owner likes dense dashboards.',
              source: 'dream',
              ownerConfirmed: false,
            },
          ],
        },
      },
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: [
            message('pref', 'I like readable type and accessible controls.', 'user', 'owner'),
            message('neighbor', 'Unrelated conversation about a job application.', 'user', 'owner'),
          ],
        },
      },
    ];
    const object = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, object: { selections: [] } })
      .mockImplementationOnce(async (_role: string, options: Record<string, unknown>) => {
        const prompt = JSON.parse(String(options.prompt)) as {
          recovery?: string;
          sources: Array<{ key: string; body: string; speaker: string }>;
        };
        expect(prompt.recovery).toContain('owner-authored and owner-confirmed');
        expect(
          prompt.sources.every((source) =>
            ['Recorded owner message', 'Saved fact marked owner-confirmed'].includes(
              source.speaker,
            ),
          ),
        ).toBe(true);
        expect(prompt.sources.some((source) => source.key === 'memory:assistant-guess')).toBe(
          false,
        );
        return {
          ok: true,
          object: {
            selections: [
              {
                sourceKey: 'message:pref',
                quote: 'I like readable type and accessible controls.',
              },
              {
                sourceKey: 'memory:confirmed-ui',
                quote: 'I prefer a minimal interface, clear typography, and accessible controls.',
              },
            ],
          },
        };
      });

    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: candidates,
    });
    expect(result.status).toBe('complete');
    expect(result.selections).toHaveLength(2);
    expect(object).toHaveBeenCalledTimes(2);
    const answer = renderMemoryReadAnswer(result, candidates, request);
    expect(answer).toContain('accessible controls');
    expect(answer).toContain('clear typography');
    expect(answer).not.toContain('dense dashboards');
    expect(answer).not.toContain('job application');
  });
  it('accepts an assistant-only historical answer when asked what the assistant previously said', async () => {
    const request = 'What did you say about my UI preferences?';
    const assistantText = 'I previously recommended a minimal UI with clear typography.';
    const assistantEvidence: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: [message('assistant-ui', assistantText, 'assistant', 'assistant')],
        },
      },
    ];
    const object = vi.fn(async () => ({
      ok: true,
      object: {
        selections: [{ sourceKey: 'message:assistant-ui', quote: assistantText }],
      },
    }));
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: assistantEvidence,
    });
    expect(result).toMatchObject({
      status: 'complete',
      selections: [{ sourceKey: 'message:assistant-ui' }],
    });
    expect(object).toHaveBeenCalledTimes(1);
    expect(validMemoryReadSelection(result, assistantEvidence, request)).toBe(true);
    expect(renderMemoryReadAnswer(result, assistantEvidence, request)).toContain(
      'Earlier assistant claim (not verified fact)',
    );
  });
  it.each([
    'What did I previously tell you about accessible controls?',
    'What did I say about accessible controls?',
  ])('does not claim owner-history coverage with unselected sources: %s', async (request) => {
    const object = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, object: { selections: [] } })
      .mockResolvedValueOnce({ ok: true, object: { selections: [] } });
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence,
    });
    expect(result).toMatchObject({ status: 'unavailable', failureReason: 'incomplete_selection' });
    expect(renderMemoryReadAnswer(result, evidence, request)).toContain(
      'candidate owner-authored records',
    );
  });
  it('requires both speaker sides for an explicit owner-versus-assistant history comparison', async () => {
    const request = 'Separate my correction from your earlier claim about the flight time.';
    let recoveryPrompt = '';
    const object = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        object: {
          selections: [
            {
              sourceKey: 'message:owner-correction',
              quote: 'My Berlin flight is actually at 13:45, not 09:15.',
            },
          ],
        },
      })
      .mockImplementationOnce(async (_role: string, options: Record<string, unknown>) => {
        recoveryPrompt = String(options.prompt);
        return { ok: true, object: { selections: selection.selections } };
      });
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence,
    });
    expect(object).toHaveBeenCalledTimes(2);
    const prompt = JSON.parse(recoveryPrompt) as {
      recovery?: string;
      sources: Array<{ key: string }>;
    };
    expect(prompt.recovery).toContain('from both speakers');
    expect(prompt.sources.map((source) => source.key)).toContain('message:owner-correction');
    expect(prompt.sources.map((source) => source.key)).toContain('message:assistant-claim');
    expect(result).toMatchObject({ status: 'complete' });
    expect(result.selections).toHaveLength(2);
    expect(validMemoryReadSelection(result, evidence, request)).toBe(true);
    const answer = renderMemoryReadAnswer(result, evidence, request);
    expect(answer).toContain('Recorded owner message');
    expect(answer).toContain('Earlier assistant claim (not verified fact)');
    expect(answer).toContain('not evidence of owner intent');
    expect(answer).toContain('“My Berlin flight is actually at 13:45, not 09:15.”');
    expect(answer).toContain('“Your flight departs at 09:15.”');
  });
  it('recovers an owner fact and assistant suggestion from a fictional exercise when selection is empty', async () => {
    const request =
      'Look back at the earlier hypothetical Mosaic exercise. Did I earmark its project budget for public transport, or was that an Assistant inference? Separate my original budget and travel constraint from the Assistant’s suggested next step, citing the relevant conversation messages. Keep the fictional exercise separate from my real plans, and do not save new memories.';
    const ownerText =
      'For this hypothetical exercise only, the project is named Mosaic, the budget is $500, and we must avoid taxi travel.';
    const assistantText =
      'Project Mosaic has a $500 budget and a rule to avoid taxi travel. Next step: map public transit options that fit the budget.';
    const conversationEvidence: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: [
            ...Array.from({ length: 8 }, (_, index) =>
              message(
                `unrelated-assistant-${index}`,
                `A next step for another exercise is to review option ${index}.`,
                'assistant',
                'assistant',
              ),
            ),
            message('mosaic-owner', ownerText, 'user', 'owner'),
            message('mosaic-assistant', assistantText, 'assistant', 'assistant'),
          ],
        },
      },
    ];
    const object = vi.fn(async () => ({ ok: true, object: { selections: [] } }));

    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: conversationEvidence,
    });

    expect(result.status).toBe('complete');
    expect(result.selections.map((item) => item.sourceKey)).toEqual([
      'message:mosaic-owner',
      'message:mosaic-assistant',
    ]);
    expect(validMemoryReadSelection(result, conversationEvidence, request)).toBe(true);
    const answer = renderMemoryReadAnswer(result, conversationEvidence, request);
    expect(answer).toContain('Recorded owner message');
    expect(answer).toContain('Earlier assistant claim (not verified fact)');
    expect(answer).toContain('#message-mosaic-owner)');
    expect(answer).toContain('#message-mosaic-assistant)');
    expect(answer).toContain('That wording appears in the assistant’s suggestion.');
    expect(object).toHaveBeenCalledTimes(2);
  });
  it('matches a same-thread recommendation by its topic when request wording is absent', async () => {
    const request =
      'For the earlier fictional Kestrel scenario, compare my original budget and travel constraint with the Assistant’s suggested next step.';
    const ownerText =
      'For the fictional Kestrel scenario, my original budget is $500 and my travel constraint is to avoid taxis.';
    const assistantText =
      'The Kestrel scenario remains under review. Two options were considered for the travel details. Public transport is the best option for travel.';
    const conversationEvidence: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: [
            message('kestrel-owner', ownerText, 'user', 'owner'),
            message('kestrel-assistant', assistantText, 'assistant', 'assistant'),
          ],
        },
      },
    ];
    const object = vi.fn(async () => ({ ok: true, object: { selections: [] } }));

    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: conversationEvidence,
    });

    expect(result.status).toBe('complete');
    expect(result.selections.map((item) => item.sourceKey)).toEqual([
      'message:kestrel-owner',
      'message:kestrel-assistant',
    ]);
    expect(validMemoryReadSelection(result, conversationEvidence, request)).toBe(true);
    expect(renderMemoryReadAnswer(result, conversationEvidence, request)).toContain(
      'fictional exercise, not facts about you',
    );
  });
  it('does not carry a project anchor into an explicitly unrelated recommendation', async () => {
    const request =
      'For the earlier fictional Kestrel scenario, compare my original budget and travel constraint with the Assistant’s suggested next step.';
    const ownerText =
      'For the fictional Kestrel exercise, my original budget is $500 and my travel constraint is to avoid taxis.';
    const assistantText =
      'The Kestrel scenario remains under review. Separately, in an unrelated travel note, the next step is public transport.';
    const conversationEvidence: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: [
            message('kestrel-owner', ownerText, 'user', 'owner'),
            message('kestrel-unrelated-assistant', assistantText, 'assistant', 'assistant'),
          ],
        },
      },
    ];
    const object = vi.fn(async () => ({
      ok: true,
      object: {
        selections: [
          { sourceKey: 'message:kestrel-owner', quote: ownerText },
          { sourceKey: 'message:kestrel-unrelated-assistant', quote: assistantText },
        ],
      },
    }));

    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: conversationEvidence,
    });

    expect(result).toMatchObject({ status: 'unavailable', failureReason: 'incomplete_selection' });
    expect(result.selections).toEqual([]);
    expect(validMemoryReadSelection(result, conversationEvidence, request)).toBe(false);
  });
  it('does not carry an explicitly unrelated prior sentence as the recommendation scope', async () => {
    const request =
      'For the earlier fictional Kestrel scenario, compare my original budget and travel constraint with the Assistant’s suggested next step.';
    const ownerText =
      'For the fictional Kestrel exercise, my original budget is $500 and my travel constraint is to avoid taxis.';
    const assistantText =
      'The Kestrel scenario is unrelated to this travel note. The best travel option is public transport.';
    const conversationEvidence: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: [
            message('kestrel-owner', ownerText, 'user', 'owner'),
            message('kestrel-unrelated-anchor-assistant', assistantText, 'assistant', 'assistant'),
          ],
        },
      },
    ];
    const object = vi.fn(async () => ({
      ok: true,
      object: {
        selections: [
          { sourceKey: 'message:kestrel-owner', quote: ownerText },
          { sourceKey: 'message:kestrel-unrelated-anchor-assistant', quote: assistantText },
        ],
      },
    }));

    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: conversationEvidence,
    });

    expect(result).toMatchObject({ status: 'unavailable', failureReason: 'incomplete_selection' });
    expect(result.selections).toEqual([]);
    expect(validMemoryReadSelection(result, conversationEvidence, request)).toBe(false);
  });
  it.each([
    [
      'cross-project switch',
      'For Kestrel, travel is relevant. For the separate Orion scenario, public transport is the best travel option.',
    ],
    [
      'negated recommendation',
      'For Kestrel, the travel option is not public transport; I would not recommend it.',
    ],
    [
      'unrelated recommendation in the same thread',
      'For Kestrel, travel is under review. The next step is to upgrade database configuration.',
    ],
  ])(
    'does not select a %s as the same-thread assistant recommendation',
    async (_case, assistantText) => {
      const request =
        'For the earlier fictional Kestrel scenario, compare my original budget and travel constraint with the Assistant’s suggested next step.';
      const ownerText =
        'For the fictional Kestrel scenario, my original budget is $500 and my travel constraint is to avoid taxis.';
      const conversationEvidence: ActionEvidence[] = [
        {
          toolName: 'conversations.search',
          status: 'succeeded',
          result: {
            matches: [
              message('kestrel-owner', ownerText, 'user', 'owner'),
              message('kestrel-assistant', assistantText, 'assistant', 'assistant'),
            ],
          },
        },
      ];
      const result = await selectMemoryReadAnswer({
        router: {
          object: vi.fn().mockResolvedValue({ ok: true, object: { selections: [] } }),
        } as never,
        taskId: 'qa',
        request,
        evidence: conversationEvidence,
      });

      expect(result).toMatchObject({
        status: 'unavailable',
        failureReason: 'incomplete_selection',
      });
      expect(validMemoryReadSelection(result, conversationEvidence, request)).toBe(false);
    },
  );
  it('does not carry an Aurora anchor into a separate Borealis suggestion in the same message', async () => {
    const request =
      'Look back at the earlier hypothetical Aurora exercise. Separate my original project budget from the Assistant’s suggested next step, citing the messages.';
    const ownerText =
      'For this hypothetical exercise, the Aurora project budget is $240 and must avoid taxi travel.';
    const assistantText =
      'For Aurora, the budget is $240. For the separate Borealis exercise, a next step is public transport.';
    const owner = message('aurora-owner', ownerText, 'user', 'owner');
    const assistant = message('borealis-assistant', assistantText, 'assistant', 'assistant');
    const conversationEvidence: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: { matches: [owner, assistant] },
      },
    ];
    const object = vi.fn(async () => ({ ok: true, object: { selections: [] } }));

    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: conversationEvidence,
    });

    expect(result.selections).toEqual([]);
    expect(validMemoryReadSelection(result, conversationEvidence, request)).toBe(false);
    expect(
      validMemoryReadSelection(
        {
          version: 1,
          status: 'complete',
          selections: [
            { sourceKey: 'message:aurora-owner', quote: ownerText },
            { sourceKey: 'message:borealis-assistant', quote: assistantText },
          ],
        },
        conversationEvidence,
        request,
      ),
    ).toBe(false);
  });
  it('fails closed and reports omitted contexts when equally strong pairs exceed the candidate cap', () => {
    const request =
      'Look back at the earlier hypothetical Aurora exercise. Separate my original project budget from the Assistant’s suggested next step, citing the messages.';
    const matches = Array.from({ length: 14 }, (_, index) => {
      const conversationId = `aurora-context-${index}`;
      const owner = {
        ...message(
          `aurora-owner-${index}`,
          'For Aurora, the project budget is $240.',
          'user',
          'owner',
        ),
        conversationId,
      };
      const assistant = {
        ...message(
          `aurora-assistant-${index}`,
          'For Aurora, the next step is to reduce the project budget by using public transport.',
          'assistant',
          'assistant',
        ),
        conversationId,
      };
      return [owner, assistant];
    }).flat();
    const omitted = vi.fn();

    const sources = memoryReadSources(
      [{ toolName: 'conversations.search', status: 'succeeded', result: { matches } }],
      request,
      omitted,
    );

    expect(sources).toEqual([]);
    expect(omitted).toHaveBeenCalledOnce();
  });
  it('does not pair matching fictional facts across separate conversations', async () => {
    const request =
      'Look back at the earlier hypothetical Mosaic exercise. Did I earmark its project budget for public transport, or was that an Assistant inference? Separate my original budget and travel constraint from the Assistant’s suggested next step, citing the relevant conversation messages.';
    const ownerText =
      'For this hypothetical exercise only, the project is named Mosaic, the budget is $500, and we must avoid taxi travel.';
    const assistantText =
      'Project Mosaic has a $500 budget and a rule to avoid taxi travel. Next step: map public transit options that fit the budget.';
    const owner = {
      ...message('mosaic-owner-separate-chat', ownerText, 'user', 'owner'),
      conversationId: 'owner-chat',
    };
    const assistant = {
      ...message('mosaic-assistant-separate-chat', assistantText, 'assistant', 'assistant'),
      conversationId: 'assistant-chat',
    };
    const conversationEvidence: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: { matches: [owner, assistant] },
      },
    ];
    const object = vi.fn(async () => ({ ok: true, object: { selections: [] } }));

    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: conversationEvidence,
    });

    expect(result).toMatchObject({ status: 'unavailable', failureReason: 'incomplete_selection' });
    expect(validMemoryReadSelection(result, conversationEvidence, request)).toBe(false);
    expect(object).toHaveBeenCalledTimes(2);
  });
  it('fails closed when the model chooses one of equally strong conflicting conversations', async () => {
    const request =
      'For the earlier fictional Kestrel scenario, compare my original budget and travel constraint with the Assistant’s suggested next step.';
    const ownerText =
      'For the fictional Kestrel exercise, my original budget is $500 and my travel constraint is to avoid taxis.';
    const publicTransport = 'For Kestrel, public transport is the best option for travel.';
    const taxis = 'For Kestrel, taxis are the best option for travel.';
    const ownerChatOne = {
      ...message('owner-one', ownerText, 'user', 'owner'),
      conversationId: 'kestrel-chat-one',
    };
    const assistantChatOne = {
      ...message('assistant-one', publicTransport, 'assistant', 'assistant'),
      conversationId: 'kestrel-chat-one',
    };
    const ownerChatTwo = {
      ...message('owner-two', ownerText, 'user', 'owner'),
      conversationId: 'kestrel-chat-two',
    };
    const assistantChatTwo = {
      ...message('assistant-two', taxis, 'assistant', 'assistant'),
      conversationId: 'kestrel-chat-two',
    };
    const conversationEvidence: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: [ownerChatOne, assistantChatOne, ownerChatTwo, assistantChatTwo],
        },
      },
    ];
    const object = vi.fn(async () => ({
      ok: true,
      object: {
        selections: [
          { sourceKey: 'message:owner-one', quote: ownerText },
          { sourceKey: 'message:assistant-one', quote: publicTransport },
        ],
      },
    }));

    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: conversationEvidence,
    });

    expect(result).toMatchObject({ status: 'unavailable', failureReason: 'incomplete_selection' });
    expect(result.selections).toEqual([]);
    expect(validMemoryReadSelection(result, conversationEvidence, request)).toBe(false);
    expect(object).toHaveBeenCalledTimes(1);
  });
  it('fails closed on equally strong conflicting recommendations within one conversation', async () => {
    const request =
      'For the earlier fictional Kestrel scenario, compare my original budget and travel constraint with the Assistant’s suggested next step.';
    const ownerText =
      'For the fictional Kestrel exercise, my original budget is $500 and my travel constraint is to minimize cost.';
    const publicTransport = 'For Kestrel, public transport is the best option for travel.';
    const taxis = 'For Kestrel, taxis are the best option for travel.';
    const conversationEvidence: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: [
            message('owner-one-chat', ownerText, 'user', 'owner'),
            message('assistant-one-chat', publicTransport, 'assistant', 'assistant'),
            message('assistant-conflicting-chat', taxis, 'assistant', 'assistant'),
          ],
        },
      },
    ];
    const object = vi.fn(async () => ({
      ok: true,
      object: {
        selections: [
          { sourceKey: 'message:owner-one-chat', quote: ownerText },
          { sourceKey: 'message:assistant-one-chat', quote: publicTransport },
        ],
      },
    }));

    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: conversationEvidence,
    });

    expect(result).toMatchObject({ status: 'unavailable', failureReason: 'incomplete_selection' });
    expect(result.selections).toEqual([]);
    expect(validMemoryReadSelection(result, conversationEvidence, request)).toBe(false);
    expect(object).toHaveBeenCalledTimes(1);
  });
  it('reserves bounded evidence for both speakers when a long history search has many owner messages', () => {
    const matches = [
      ...Array.from({ length: 22 }, (_, index) =>
        message(`owner-${index}`, `Owner message ${index}.`, 'user', 'owner'),
      ),
      message(
        'old-assistant-claim',
        'You previously claimed the time was 09:15.',
        'assistant',
        'assistant',
      ),
    ];
    const sources = memoryReadSources(
      [{ toolName: 'conversations.search', status: 'succeeded', result: { matches } }],
      'Separate what I said from your earlier claim about the time.',
    );
    expect(sources).toHaveLength(13);
    expect(sources.some((source) => source.key === 'message:owner-0')).toBe(true);
    expect(sources.some((source) => source.key === 'message:old-assistant-claim')).toBe(true);
  });
  it('keeps a later-pass owner correction and earlier assistant claim selectable across noisy search passes', async () => {
    const request = 'Separate my correction from your earlier claim about the flight time.';
    const claimText = 'I previously claimed the flight was at 09:15.';
    const correctionText = 'I corrected the flight time to 13:45.';
    const claim = {
      ...message('earlier-claim', claimText, 'assistant', 'assistant'),
      sourceRevision: conversationMessageSourceRevision('earlier-claim', claimText),
    };
    const correction = {
      ...message('later-correction', correctionText, 'user', 'owner'),
      sourceRevision: conversationMessageSourceRevision('later-correction', correctionText),
    };
    const passes: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: [
            ...Array.from({ length: 12 }, (_, index) =>
              message(`first-owner-${index}`, `Unrelated owner note ${index}.`, 'user', 'owner'),
            ),
            claim,
          ],
        },
      },
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: Array.from({ length: 12 }, (_, index) =>
            message(
              `second-owner-${index}`,
              `Another unrelated owner note ${index}.`,
              'user',
              'owner',
            ),
          ),
        },
      },
      { toolName: 'conversations.search', status: 'succeeded', result: { matches: [correction] } },
    ];
    const sources = memoryReadSources(passes, request);
    expect(sources.filter((source) => source.speaker === 'Recorded owner message')).toHaveLength(
      12,
    );
    expect(sources.map((source) => source.key)).toContain('message:later-correction');
    expect(sources.map((source) => source.key)).toContain('message:earlier-claim');
    expect(correction.speakerRevision).toBe(
      conversationMessageSpeakerRevision('later-correction', correctionText, 'user', 'owner'),
    );
    expect(correction.sourceRevision).toBe(
      conversationMessageSourceRevision('later-correction', correctionText),
    );
    const object = vi.fn(async (_role: string, options: { prompt: string }) => {
      const prompt = JSON.parse(options.prompt) as { sources: Array<{ key: string }> };
      expect(prompt.sources.map((source) => source.key)).toContain('message:later-correction');
      expect(prompt.sources.map((source) => source.key)).toContain('message:earlier-claim');
      return {
        ok: true,
        object: {
          selections: [
            { sourceKey: 'message:later-correction', quote: correctionText },
            { sourceKey: 'message:earlier-claim', quote: claimText },
          ],
        },
      };
    });
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: passes,
    });
    expect(result.status).toBe('complete');
    expect(result.selections).toHaveLength(2);
    expect(validMemoryReadSelection(result, passes, request)).toBe(true);
    expect(object).toHaveBeenCalledTimes(1);
  });
  it('fails closed when the bounded comparison cannot select both speaker sides', async () => {
    const request = 'Compare what I told you with your earlier claim about the flight time.';
    const object = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        object: {
          selections: [
            {
              sourceKey: 'message:owner-correction',
              quote: 'My Berlin flight is actually at 13:45, not 09:15.',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        object: {
          selections: [
            {
              sourceKey: 'message:owner-correction',
              quote: 'My Berlin flight is actually at 13:45, not 09:15.',
            },
          ],
        },
      });
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence,
    });
    expect(result).toMatchObject({ status: 'unavailable', failureReason: 'incomplete_selection' });
    expect(object).toHaveBeenCalledTimes(2);
    expect(validMemoryReadSelection(result, evidence, request)).toBe(false);
    expect(renderMemoryReadAnswer(result, evidence, request)).toContain(
      'could not reliably select both',
    );
  });
  it('cites assistant-reported correction evidence as assistant-only when the owner source is absent', async () => {
    const request = 'Separate my correction from your earlier claim about the launch time.';
    const ownerCorrectionReport =
      'You corrected the earlier time and said the departure was 13:45.';
    const earlierAssistantClaim = 'I previously said the departure was 09:15.';
    const candidates: ActionEvidence[] = [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        result: {
          matches: [
            message('unrelated-owner', 'I like clear labels.', 'user', 'owner'),
            message('assistant-report', ownerCorrectionReport, 'assistant', 'assistant'),
            message('assistant-old-claim', earlierAssistantClaim, 'assistant', 'assistant'),
          ],
        },
      },
    ];
    const assistantSelections = {
      selections: [
        { sourceKey: 'message:assistant-report', quote: ownerCorrectionReport },
        { sourceKey: 'message:assistant-old-claim', quote: earlierAssistantClaim },
      ],
    };
    const object = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, object: { selections: [] } })
      .mockImplementationOnce(async (_role: string, options: Record<string, unknown>) => {
        const prompt = JSON.parse(String(options.prompt)) as {
          recovery?: string;
          sources: Array<{ key: string }>;
        };
        expect(prompt.recovery).toContain('If no supplied owner passage is relevant');
        expect(prompt.sources).toHaveLength(3);
        expect(prompt.sources.map((source) => source.key)).toContain('message:unrelated-owner');
        return { ok: true, object: assistantSelections };
      });

    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'qa',
      request,
      evidence: candidates,
    });
    expect(object).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'complete', coverage: 'assistant_only' });
    expect(validMemoryReadSelection(result, candidates, request)).toBe(true);
    const answer = renderMemoryReadAnswer(result, candidates, request);
    expect(answer).toContain('Assistant records only');
    expect(answer).toContain('not the owner’s original words');
    expect(answer).toContain(ownerCorrectionReport);
    expect(answer).toContain(earlierAssistantClaim);
    expect(answer).not.toContain('Recorded owner message');

    expect(
      validMemoryReadSelection(
        {
          ...result,
          selections: [{ sourceKey: 'message:unrelated-owner', quote: 'I like clear labels.' }],
        },
        candidates,
        request,
      ),
    ).toBe(false);
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
