import { conversationMessageSpeakerRevision } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  renderMemoryReadAnswer,
  selectMemoryReadAnswer,
  validMemoryReadSelection,
} from './memory-read-answer.js';
import type { ActionEvidence } from './response-contract.js';

const ownerBody =
  'For this fictional exercise, the project is Nimbus, the budget is €310, the deadline is Thursday, and we must avoid taxi travel. Acknowledge only; do not save personal memories.';
const assistantBody =
  'For Nimbus, a sensible next step is to map public transport options within the €310 travel limit.';
const evidence: ActionEvidence[] = [
  {
    toolName: 'conversations.search',
    status: 'succeeded',
    fromCurrentTask: true,
    result: {
      matches: [
        {
          messageId: 'owner-nimbus',
          conversationId: 'exercise-chat',
          text: ownerBody,
          role: 'user',
          origin: 'owner',
          speakerRevision: conversationMessageSpeakerRevision(
            'owner-nimbus',
            ownerBody,
            'user',
            'owner',
          ),
        },
        {
          messageId: 'assistant-nimbus',
          conversationId: 'exercise-chat',
          text: assistantBody,
          role: 'assistant',
          origin: 'assistant',
          speakerRevision: conversationMessageSpeakerRevision(
            'assistant-nimbus',
            assistantBody,
            'assistant',
            'assistant',
          ),
        },
      ],
    },
  },
];
const ownerSelection = { sourceKey: 'message:owner-nimbus', quote: ownerBody };
const assistantSelection = { sourceKey: 'message:assistant-nimbus', quote: assistantBody };

describe('source-backed fictional history', () => {
  it('recovers a named fictional exercise from exact owner evidence after empty selector passes', async () => {
    const request =
      'Find the earlier hypothetical planning exercise called Nimbus in our past chats. Recall its project name, budget, deadline, and travel constraint, citing the conversation source. Clearly distinguish the fictional exercise from facts about me. Do not use email or calendar, and do not save new memories.';
    const object = vi.fn().mockResolvedValue({ ok: true, object: { selections: [] } });
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'read-task',
      request,
      evidence,
    });

    expect(object).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('complete');
    expect(result.selections).toEqual([
      {
        sourceKey: 'message:owner-nimbus',
        quote:
          'For this fictional exercise, the project is Nimbus, the budget is €310, the deadline is Thursday, and we must avoid taxi travel.',
      },
    ]);
    expect(validMemoryReadSelection(result, evidence, request)).toBe(true);
    const rendered = renderMemoryReadAnswer(result, evidence, request);
    expect(rendered).toContain('fictional exercise, not facts about you');
    expect(rendered).toContain('€310');
    expect(rendered).toContain('Thursday');
    expect(rendered).toContain('avoid taxi travel');
    expect(rendered).toContain('conversation exercise-chat; message owner-nimbus');
    expect(rendered).not.toContain('public transport options');
  });

  it('does not recover fictional recall from a question or conflicting owner assertions', async () => {
    const request =
      'Find the earlier hypothetical planning exercise called Nimbus. Recall its project name, budget, deadline, and travel constraint.';
    const searchEvidence = evidence[0];
    if (!searchEvidence) throw new Error('Expected fixture search evidence');
    const questionOnly =
      'For the hypothetical Nimbus exercise, I wondered what was the budget and deadline, and which travel constraint applied';
    const conflict =
      'For the hypothetical exercise, the project is Nimbus, the budget is €410, the deadline is Friday, and we must avoid taxi travel.';
    const makeOwner = (messageId: string, body: string) => ({
      messageId,
      conversationId: 'exercise-chat',
      text: body,
      role: 'user',
      origin: 'owner',
      speakerRevision: conversationMessageSpeakerRevision(messageId, body, 'user', 'owner'),
    });
    const object = vi.fn().mockResolvedValue({ ok: true, object: { selections: [] } });
    const run = (ownerRows: unknown[]) =>
      selectMemoryReadAnswer({
        router: { object } as never,
        taskId: 'read-task',
        request,
        evidence: [{ ...searchEvidence, result: { matches: ownerRows } }],
      });
    const questionResult = await run([makeOwner('owner-question', questionOnly)]);
    expect(questionResult.status).toBe('unavailable');
    expect(questionResult.selections).toEqual([]);

    const conflictResult = await run([
      makeOwner('owner-original', ownerBody),
      makeOwner('owner-conflict', conflict),
    ]);
    expect(conflictResult.status).toBe('unavailable');
    expect(conflictResult.selections).toEqual([]);
  });

  it('recovers a supplied declarative exercise from an empty first selection without treating it as personal memory', async () => {
    const request =
      'Find our earlier fictional Nimbus exercise and recall its budget, deadline and constraint.';
    const object = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, object: { selections: [] } })
      .mockResolvedValueOnce({ ok: true, object: { selections: [ownerSelection] } });
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'read-task',
      request,
      evidence,
    });
    expect(object).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(object.mock.calls[1]?.[1].prompt);
    expect(retry.recovery).toContain('owner-authored');
    expect(retry.sources).toHaveLength(1);
    expect(result.selections).toEqual([ownerSelection]);
    expect(validMemoryReadSelection(result, evidence, request)).toBe(true);
    const rendered = renderMemoryReadAnswer(result, evidence, request);
    expect(rendered).toContain('fictional exercise, not facts about you');
    expect(rendered).toContain('€310');
    expect(rendered).toContain('conversation exercise-chat; message owner-nimbus');
    expect(rendered).not.toContain('saved your');
  });

  it('requires both original owner words and the separate assistant inference for attribution', async () => {
    const request =
      'Look back at the earlier hypothetical Nimbus exercise. Separate my original budget and travel constraint from the Assistant inference and suggested next step.';
    const object = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, object: { selections: [ownerSelection] } })
      .mockResolvedValueOnce({
        ok: true,
        object: { selections: [ownerSelection, assistantSelection] },
      });
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'read-task',
      request,
      evidence,
    });
    expect(object).toHaveBeenCalledTimes(2);
    expect(JSON.parse(object.mock.calls[1]?.[1].prompt).recovery).toContain('both speakers');
    expect(validMemoryReadSelection(result, evidence, request)).toBe(true);
    expect(
      validMemoryReadSelection({ ...result, selections: [ownerSelection] }, evidence, request),
    ).toBe(false);
    const rendered = renderMemoryReadAnswer(result, evidence, request);
    expect(rendered.startsWith('The owner-authored passage records the original statement;')).toBe(
      true,
    );
    expect(rendered).toContain('For this fictional exercise, the project is Nimbus');
    expect(rendered).toContain('a sensible next step is to map public transport options');
    expect(rendered).not.toContain('These are historical records, not a fresh check');
    expect(rendered).toContain('Earlier assistant claim (not verified fact)');
    expect(rendered).toContain('message assistant-nimbus');
    expect(rendered).toContain('message owner-nimbus');
  });

  it('uses exact source passages for the budget-versus-transit answer when selection fails', async () => {
    const request =
      'Look back at the earlier hypothetical Nimbus exercise. Did I earmark its budget for public transport, or was that the Assistant inference? Separate my original budget and travel constraint from the Assistant’s suggested next step.';
    const object = vi.fn().mockResolvedValue({ ok: true, object: { selections: [] } });
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'read-task',
      request,
      evidence,
    });

    expect(result.status).toBe('complete');
    expect(result.selections).toEqual([ownerSelection, assistantSelection]);
    expect(validMemoryReadSelection(result, evidence, request)).toBe(true);
    const rendered = renderMemoryReadAnswer(result, evidence, request);
    expect(rendered).toContain(
      'In the selected passages, the owner-authored message does not mention “public transport”; the related suggestion appears in the separate assistant-authored message.',
    );

    const sourceEvidence = evidence[0];
    if (!sourceEvidence) throw new Error('Expected source evidence');
    const sourceRows = (sourceEvidence.result as { matches: Array<Record<string, unknown>> })
      .matches;
    const ownerRow = sourceRows[0];
    const assistantRow = sourceRows[1];
    if (!ownerRow) throw new Error('Expected owner source row');
    if (!assistantRow) throw new Error('Expected assistant source row');
    const conflictingOwnerBody = `${ownerBody} I did not earmark the budget for public transport.`;
    const conflictEvidence: ActionEvidence[] = [
      {
        ...sourceEvidence,
        result: {
          matches: [
            {
              ...ownerRow,
              text: conflictingOwnerBody,
              speakerRevision: conversationMessageSpeakerRevision(
                String(ownerRow.messageId),
                conflictingOwnerBody,
                'user',
                'owner',
              ),
            },
            assistantRow,
          ],
        },
      },
    ];
    const conflictSelection = {
      ...result,
      selections: [
        { sourceKey: 'message:owner-nimbus', quote: conflictingOwnerBody },
        assistantSelection,
      ],
    };
    expect(validMemoryReadSelection(conflictSelection, conflictEvidence, request)).toBe(true);
    expect(renderMemoryReadAnswer(conflictSelection, conflictEvidence, request)).not.toContain(
      'does not mention “public transport”',
    );
    expect(rendered).toContain('Recorded owner message');
    expect(rendered).toContain('Earlier assistant claim (not verified fact)');
    expect(rendered).toContain('conversation exercise-chat; message owner-nimbus');
    expect(rendered).toContain('conversation exercise-chat; message assistant-nimbus');
    expect(rendered).not.toContain('These are facts about you');
  });

  it('keeps consistent duplicate citations omitted by a successful selector', async () => {
    const ownerText =
      'For the fictional Solstice scenario, my original venue choice was a room near the station.';
    const assistantText =
      'For Solstice, the suggested next step was to reserve the venue and email participants.';
    const search = (matches: unknown[]): ActionEvidence[] => [
      {
        toolName: 'conversations.search',
        status: 'succeeded',
        fromCurrentTask: true,
        result: { matches },
      },
    ];
    const makeOwner = (messageId: string, body: string) => ({
      messageId,
      conversationId: 'solstice-chat',
      text: body,
      role: 'user',
      origin: 'owner',
      speakerRevision: conversationMessageSpeakerRevision(messageId, body, 'user', 'owner'),
    });
    const makeAssistant = (messageId: string, body: string) => ({
      messageId,
      conversationId: 'solstice-chat',
      text: body,
      role: 'assistant',
      origin: 'assistant',
      speakerRevision: conversationMessageSpeakerRevision(
        messageId,
        body,
        'assistant',
        'assistant',
      ),
    });
    const rows = [
      makeOwner('owner-solstice-1', ownerText),
      makeOwner('owner-solstice-2', ownerText),
      makeOwner('owner-solstice-3', ownerText),
      makeAssistant('assistant-solstice', assistantText),
    ];
    const request =
      'For the earlier fictional Solstice scenario, compare my original venue choice with the Assistant’s suggested next step. Cite one relevant message from each speaker.';
    const selector = vi.fn().mockResolvedValue({
      ok: true,
      object: {
        selections: [
          { sourceKey: 'message:owner-solstice-1', quote: ownerText },
          { sourceKey: 'message:assistant-solstice', quote: assistantText },
        ],
      },
    });
    const result = await selectMemoryReadAnswer({
      router: { object: selector } as never,
      taskId: 'read-task',
      request,
      evidence: search(rows),
    });

    expect(result.status).toBe('complete');
    expect(result.selections.map((selection) => selection.sourceKey)).toEqual([
      'message:owner-solstice-1',
      'message:owner-solstice-2',
      'message:owner-solstice-3',
      'message:assistant-solstice',
    ]);
    const rendered = renderMemoryReadAnswer(result, search(rows), request);
    expect(rendered.split(`“${ownerText}”`).length - 1).toBe(1);
    expect(rendered).toContain('message owner-solstice-1');
    expect(rendered).toContain('message owner-solstice-2');
    expect(rendered).toContain('message owner-solstice-3');
    expect(rendered).toContain('message assistant-solstice');
  });

  it('preserves a successful bounded quote from a longer source record', async () => {
    const ownerQuote =
      'For the fictional Nimbus exercise, my original budget was €310 and the travel constraint was to avoid taxis.';
    const longOwnerBody = `${ownerQuote}\n\n${'Additional unrelated exercise context. '.repeat(35)}`;
    const assistantQuote = 'For Nimbus, the suggested next step was to map public transit options.';
    const searchEvidence = evidence[0];
    if (!searchEvidence) throw new Error('Expected fixture search evidence');
    const longEvidence: ActionEvidence[] = [
      {
        ...searchEvidence,
        result: {
          matches: [
            {
              messageId: 'owner-nimbus-long',
              conversationId: 'exercise-chat',
              text: longOwnerBody,
              role: 'user',
              origin: 'owner',
              speakerRevision: conversationMessageSpeakerRevision(
                'owner-nimbus-long',
                longOwnerBody,
                'user',
                'owner',
              ),
            },
            {
              messageId: 'assistant-nimbus-long',
              conversationId: 'exercise-chat',
              text: assistantQuote,
              role: 'assistant',
              origin: 'assistant',
              speakerRevision: conversationMessageSpeakerRevision(
                'assistant-nimbus-long',
                assistantQuote,
                'assistant',
                'assistant',
              ),
            },
          ],
        },
      },
    ];
    const request =
      'For the earlier fictional Nimbus exercise, compare my original budget and travel constraint with the Assistant’s suggested next step.';
    const result = await selectMemoryReadAnswer({
      router: {
        object: vi.fn().mockResolvedValue({
          ok: true,
          object: {
            selections: [
              { sourceKey: 'message:owner-nimbus-long', quote: ownerQuote },
              { sourceKey: 'message:assistant-nimbus-long', quote: assistantQuote },
            ],
          },
        }),
      } as never,
      taskId: 'read-task',
      request,
      evidence: longEvidence,
    });

    expect(longOwnerBody.length).toBeGreaterThan(800);
    expect(result.status).toBe('complete');
    expect(result.selections).toEqual([
      { sourceKey: 'message:owner-nimbus-long', quote: ownerQuote },
      { sourceKey: 'message:assistant-nimbus-long', quote: assistantQuote },
    ]);
  });

  it('does not treat a question-only owner passage as an authored answer', async () => {
    const questionOnly =
      'For the fictional Nimbus exercise, I wondered: what was my budget for travel and which constraint applied?';
    const searchEvidence = evidence[0];
    if (!searchEvidence) throw new Error('Expected fixture search evidence');
    const questionEvidence: ActionEvidence[] = [
      {
        ...searchEvidence,
        result: {
          matches: [
            {
              messageId: 'owner-nimbus-question',
              conversationId: 'exercise-chat',
              text: questionOnly,
              role: 'user',
              origin: 'owner',
              speakerRevision: conversationMessageSpeakerRevision(
                'owner-nimbus-question',
                questionOnly,
                'user',
                'owner',
              ),
            },
            {
              messageId: 'assistant-nimbus',
              conversationId: 'exercise-chat',
              text: assistantBody,
              role: 'assistant',
              origin: 'assistant',
              speakerRevision: conversationMessageSpeakerRevision(
                'assistant-nimbus',
                assistantBody,
                'assistant',
                'assistant',
              ),
            },
          ],
        },
      },
    ];
    const request =
      'For the earlier fictional Nimbus exercise, compare my original budget and travel constraint with the Assistant’s suggested next step.';
    const result = await selectMemoryReadAnswer({
      router: {
        object: vi.fn().mockResolvedValue({ ok: true, object: { selections: [] } }),
      } as never,
      taskId: 'read-task',
      request,
      evidence: questionEvidence,
    });

    expect(result.status).toBe('unavailable');
    expect(result.selections).toEqual([]);
  });

  it('refuses conflicting tied statements from the same named exercise', async () => {
    const request =
      'For the earlier fictional Solstice scenario, compare my original venue choice with the Assistant’s suggested next step.';
    const searchEvidence = evidence[0];
    if (!searchEvidence) throw new Error('Expected fixture search evidence');
    const north = 'For the fictional Solstice scenario, my original venue choice was North Hall.';
    const south = 'For the fictional Solstice scenario, my original venue choice was South Hall.';
    const assistant = 'For Solstice, the suggested next step is to reserve the venue.';
    const evidenceWithConflict: ActionEvidence[] = [
      {
        ...searchEvidence,
        result: {
          matches: [
            {
              messageId: 'owner-north',
              conversationId: 'solstice-chat',
              text: north,
              role: 'user',
              origin: 'owner',
              speakerRevision: conversationMessageSpeakerRevision(
                'owner-north',
                north,
                'user',
                'owner',
              ),
            },
            {
              messageId: 'owner-south',
              conversationId: 'solstice-chat',
              text: south,
              role: 'user',
              origin: 'owner',
              speakerRevision: conversationMessageSpeakerRevision(
                'owner-south',
                south,
                'user',
                'owner',
              ),
            },
            {
              messageId: 'assistant-solstice',
              conversationId: 'solstice-chat',
              text: assistant,
              role: 'assistant',
              origin: 'assistant',
              speakerRevision: conversationMessageSpeakerRevision(
                'assistant-solstice',
                assistant,
                'assistant',
                'assistant',
              ),
            },
          ],
        },
      },
    ];
    const result = await selectMemoryReadAnswer({
      router: { object: vi.fn().mockRejectedValue(new Error('selector unavailable')) } as never,
      taskId: 'read-task',
      request,
      evidence: evidenceWithConflict,
    });

    expect(result.status).toBe('unavailable');
    expect(result.selections).toEqual([]);
  });

  it('refuses a successful selector that omits an equally relevant conflicting owner record', async () => {
    const request =
      'For the earlier fictional Solstice scenario, compare my original venue choice with the Assistant’s suggested next step.';
    const searchEvidence = evidence[0];
    if (!searchEvidence) throw new Error('Expected fixture search evidence');
    const north = 'For the fictional Solstice scenario, my original venue choice was North Hall.';
    const south = 'For the fictional Solstice scenario, my original venue choice was South Hall.';
    const assistant = 'For Solstice, the suggested next step is to reserve the venue.';
    const makeOwner = (messageId: string, text: string) => ({
      messageId,
      conversationId: 'solstice-chat',
      text,
      role: 'user',
      origin: 'owner',
      speakerRevision: conversationMessageSpeakerRevision(messageId, text, 'user', 'owner'),
    });
    const assistantRow = {
      messageId: 'assistant-solstice',
      conversationId: 'solstice-chat',
      text: assistant,
      role: 'assistant',
      origin: 'assistant',
      speakerRevision: conversationMessageSpeakerRevision(
        'assistant-solstice',
        assistant,
        'assistant',
        'assistant',
      ),
    };
    const conflictedEvidence: ActionEvidence[] = [
      {
        ...searchEvidence,
        result: {
          matches: [makeOwner('owner-north', north), makeOwner('owner-south', south), assistantRow],
        },
      },
    ];
    const result = await selectMemoryReadAnswer({
      router: {
        object: vi.fn().mockResolvedValue({
          ok: true,
          object: {
            selections: [
              { sourceKey: 'message:owner-north', quote: north },
              { sourceKey: 'message:assistant-solstice', quote: assistant },
            ],
          },
        }),
      } as never,
      taskId: 'read-task',
      request,
      evidence: conflictedEvidence,
    });

    expect(result.status).toBe('unavailable');
    expect(result.selections).toEqual([]);
  });

  it('does not pair assistant suggestions with foreign or unverified owner records', async () => {
    const request =
      'Look back at the earlier hypothetical Nimbus exercise. Did I earmark its budget for public transport, or was that the Assistant inference? Separate my original budget and travel constraint from the Assistant’s suggested next step.';
    const searchEvidence = evidence[0];
    if (!searchEvidence) throw new Error('Expected fixture search evidence');
    const originalMatches = (searchEvidence.result as { matches: unknown[] }).matches;
    const foreignOwnerBody = ownerBody.replace('Nimbus', 'Orion');
    const foreignOwnerEvidence: ActionEvidence[] = [
      {
        ...searchEvidence,
        result: {
          matches: [
            {
              messageId: 'owner-orion',
              conversationId: 'exercise-chat',
              text: foreignOwnerBody,
              role: 'user',
              origin: 'owner',
              speakerRevision: conversationMessageSpeakerRevision(
                'owner-orion',
                foreignOwnerBody,
                'user',
                'owner',
              ),
            },
            {
              messageId: 'assistant-nimbus',
              conversationId: 'exercise-chat',
              text: assistantBody,
              role: 'assistant',
              origin: 'assistant',
              speakerRevision: conversationMessageSpeakerRevision(
                'assistant-nimbus',
                assistantBody,
                'assistant',
                'assistant',
              ),
            },
          ],
        },
      },
    ];
    const splitContextEvidence: ActionEvidence[] = [
      {
        ...searchEvidence,
        result: {
          matches: [
            {
              messageId: 'owner-split',
              conversationId: 'owner-context',
              text: ownerBody,
              role: 'user',
              origin: 'owner',
              speakerRevision: conversationMessageSpeakerRevision(
                'owner-split',
                ownerBody,
                'user',
                'owner',
              ),
            },
            {
              messageId: 'assistant-split',
              conversationId: 'assistant-context',
              text: assistantBody,
              role: 'assistant',
              origin: 'assistant',
              speakerRevision: conversationMessageSpeakerRevision(
                'assistant-split',
                assistantBody,
                'assistant',
                'assistant',
              ),
            },
          ],
        },
      },
    ];
    const noOwnerEvidence: ActionEvidence[] = [
      {
        ...searchEvidence,
        result: {
          matches: originalMatches.filter(
            (match) => (match as { role?: string }).role === 'assistant',
          ),
        },
      },
    ];
    const invalidOwnerEvidence: ActionEvidence[] = [
      {
        ...searchEvidence,
        result: {
          matches: [
            {
              messageId: 'owner-ambiguous',
              conversationId: 'exercise-chat',
              text: ownerBody,
              role: 'user',
              origin: 'unknown',
            },
            originalMatches[1],
          ],
        },
      },
    ];
    for (const candidate of [
      foreignOwnerEvidence,
      splitContextEvidence,
      noOwnerEvidence,
      invalidOwnerEvidence,
    ]) {
      const object = vi.fn().mockRejectedValue(new Error('selector unavailable'));
      const result = await selectMemoryReadAnswer({
        router: { object } as never,
        taskId: 'read-task',
        request,
        evidence: candidate,
      });
      expect(result.status).toBe('unavailable');
      expect(result.selections).toEqual([]);
    }
  });

  it('rejects a repaired quote with facts absent from the original exercise', async () => {
    const object = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, object: { selections: [] } })
      .mockResolvedValueOnce({
        ok: true,
        object: {
          selections: [
            {
              sourceKey: 'message:owner-nimbus',
              quote: 'The transport budget is €310.',
            },
          ],
        },
      });
    const result = await selectMemoryReadAnswer({
      router: { object } as never,
      taskId: 'read-task',
      request: 'Recall our earlier fictional Nimbus exercise budget.',
      evidence,
    });
    expect(result.status).toBe('unavailable');
    expect(result.failureReason).toBe('invalid_quote');
    expect(renderMemoryReadAnswer(result, evidence)).not.toContain('transport budget');
  });
});
