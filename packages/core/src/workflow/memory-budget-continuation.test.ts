import { conversationMessageSpeakerRevision } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { renderMemoryReadAnswer, selectMemoryReadAnswer } from './memory-read-answer.js';
import { detectPersonalReadRequest, matchesHistoricalMemorySearch } from './read-intent.js';
import { type ActionEvidence, enforceResponseContract } from './response-contract.js';

const body =
  'For this hypothetical exercise only, the project is named Nimbus, the budget is €310, the deadline is Thursday, and we must avoid taxi travel. Acknowledge only.';
const suggestion =
  'For Nimbus, a sensible next step is to map public transport options within the €310 travel limit.';
const prompts = [
  'Find the earlier hypothetical planning exercise called Nimbus in our past chats. Recall its project name, budget, deadline, and travel constraint, citing the conversation source. Clearly distinguish the fictional exercise from facts about me. Do not use email or calendar, and do not save new memories.',
  'Look back at the earlier hypothetical Nimbus exercise. Did I earmark its project budget for public transport, or was that an Assistant inference? Separate my original budget and travel constraint from the Assistant’s suggested next step, citing the relevant conversation messages. Keep the fictional exercise separate from my real plans, and do not save new memories.',
] as const;
function history(): ActionEvidence {
  return {
    toolName: 'conversations.search',
    status: 'succeeded',
    fromCurrentTask: true,
    args: { query: 'Nimbus', mode: 'text', limit: 20 },
    result: {
      matches: (
        [
          ['owner-source', 'user', 'owner', body],
          ['assistant-source', 'assistant', 'assistant', suggestion],
        ] as const
      ).map(([messageId, role, origin, text]) => ({
        messageId,
        role,
        origin,
        text,
        conversationId: 'nimbus-source-chat',
        speakerRevision: conversationMessageSpeakerRevision(messageId, text, role, origin),
      })),
    },
  };
}

describe('successful historical evidence after a later budget failure', () => {
  it('accepts the exact owner question for unanchored history without relaxing named anchors', () => {
    const question = 'What did I tell you in an earlier conversation about my return date?';
    const request = detectPersonalReadRequest([{ role: 'user', content: question }]);
    const named = detectPersonalReadRequest([{ role: 'user', content: prompts[0] }]);
    if (!request || !named) throw new Error('Expected historical reads');
    const row = { ...history(), args: { query: question, limit: 5 } };
    expect(matchesHistoricalMemorySearch(request, row)).toBe(true);
    expect(matchesHistoricalMemorySearch(request, { ...row, fromCurrentTask: false })).toBe(false);
    expect(matchesHistoricalMemorySearch(request, { ...row, status: 'failed' })).toBe(false);
    expect(
      matchesHistoricalMemorySearch(request, { ...row, args: { query: `${question} unrelated` } }),
    ).toBe(false);
    expect(
      matchesHistoricalMemorySearch(named, {
        ...row,
        args: { query: prompts[0], mode: 'semantic' },
      }),
    ).toBe(false);
  });

  it.each(prompts)('preserves exact attributed source passages: %s', async (requestText) => {
    const request = detectPersonalReadRequest([{ role: 'user', content: requestText }]);
    if (!request) throw new Error('Expected historical read');
    const evidence: ActionEvidence[] = [
      history(),
      {
        toolName: 'conversations.search',
        status: 'failed',
        args: { query: request.conversationFollowupQuery },
        result: null,
        error: 'BudgetReservationError: daily budget cannot cover this reservation',
      },
    ];
    const selection = await selectMemoryReadAnswer({
      router: {
        object: vi.fn().mockRejectedValue(new Error('budget reservation rejected')),
      } as never,
      taskId: 'read-task',
      request: requestText,
      evidence,
    });
    const answer = enforceResponseContract('The lookup failed.', evidence, {
      readRequest: request,
      requestText,
      memoryReadSelection: selection,
    });
    expect(answer.blocked).toBe(false);
    expect(answer.text).toBe(renderMemoryReadAnswer(selection, evidence, requestText));
    expect(answer.text).toContain('€310');
    expect(answer.text).toContain('avoid taxi travel');
    expect(answer.text).toContain('conversation nimbus-source-chat; message owner-source');
    expect(answer.text).toContain('fictional exercise, not facts about you');
    expect(answer.text).not.toContain('No matching saved memories');
    expect(answer.text).not.toContain('BudgetReservationError');
    expect(answer.text).toContain('coverage is limited to the returned sources');
    if (requestText === prompts[1]) {
      expect(answer.text).toContain('Earlier assistant claim (not verified fact)');
      expect(answer.text).toContain('message assistant-source');
    }
  });

  it('keeps one complete source pair when repeated exercises agree exactly', async () => {
    const row = history();
    const result = row.result as { matches: Array<Record<string, unknown>> };
    const repeated = result.matches.map((source) => {
      const messageId = `repeat-${source.messageId}`;
      return {
        ...source,
        messageId,
        conversationId: 'repeat-exercise-chat',
        speakerRevision: conversationMessageSpeakerRevision(
          messageId,
          String(source.text),
          String(source.role),
          String(source.origin),
        ),
      };
    });
    const selection = await selectMemoryReadAnswer({
      router: { object: vi.fn().mockRejectedValue(new Error('budget unavailable')) } as never,
      taskId: 'read-task',
      request: prompts[1],
      evidence: [{ ...row, result: { matches: [...result.matches, ...repeated] } }],
    });
    expect(selection.status).toBe('complete');
    expect(selection.selections.map((item) => item.sourceKey)).toEqual([
      'message:owner-source',
      'message:assistant-source',
    ]);
  });

  it('explains an empty lookup without raw or repeated budget exceptions', () => {
    const request = detectPersonalReadRequest([{ role: 'user', content: prompts[0] }]);
    if (!request) throw new Error('Expected historical read');
    const failed = {
      toolName: 'conversations.search',
      status: 'failed',
      result: null,
      error: 'BudgetReservationError: daily budget cannot cover this reservation',
    };
    const answer = enforceResponseContract('Found the facts.', [failed, failed], {
      readRequest: request,
      requestText: prompts[0],
    });
    expect(answer.blocked).toBe(true);
    expect(answer.text.match(/daily spending limit/g)).toHaveLength(1);
    expect(answer.text).not.toMatch(/BudgetReservationError|conversations\.search/);
  });

  it('binds coverage to exact runtime query, source shape, task and literal mode', () => {
    const request = detectPersonalReadRequest([{ role: 'user', content: prompts[0] }]);
    if (!request) throw new Error('Expected historical read');
    expect(matchesHistoricalMemorySearch(request, history())).toBe(true);
    for (const row of [
      { ...history(), fromCurrentTask: false },
      { ...history(), status: 'failed' },
      { ...history(), args: { query: 'Nimbus', mode: 'semantic' } },
      { ...history(), args: { query: 'Nimbus marketing', mode: 'text' } },
      { ...history(), result: { memories: [] } },
    ]) {
      expect(matchesHistoricalMemorySearch(request, row)).toBe(false);
      expect(enforceResponseContract('Found it.', [row], { readRequest: request }).blocked).toBe(
        true,
      );
    }
    expect(
      enforceResponseContract('No results.', [{ ...history(), result: { matches: [] } }], {
        readRequest: request,
      }).text,
    ).not.toContain('What stopped the lookup');
  });
});
