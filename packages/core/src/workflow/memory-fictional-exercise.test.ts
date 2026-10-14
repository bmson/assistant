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
const assistantBody = 'Next, map public transport options within the €310 travel limit.';
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
    expect(rendered).toContain('Earlier assistant claim (not verified fact)');
    expect(rendered).toContain('message assistant-nimbus');
    expect(rendered).toContain('message owner-nimbus');
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
