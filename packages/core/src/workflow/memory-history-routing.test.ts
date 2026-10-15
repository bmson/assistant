import { describe, expect, it } from 'vitest';
import {
  buildReadToolInput,
  detectPersonalReadRequest,
  groundReadToolInput,
  nextRequiredReadTool,
  type PersonalReadRequest,
  type ReadToolEvidence,
} from './read-intent.js';

const turn = (text: string) => [{ role: 'user', content: text }];
function history(text: string): PersonalReadRequest {
  const request = detectPersonalReadRequest(turn(text));
  if (!request) throw new Error('Expected a historical read');
  return request;
}
function result(args: Record<string, unknown>, status = 'succeeded'): ReadToolEvidence {
  return {
    toolName: 'conversations.search',
    status,
    fromCurrentTask: true,
    args,
    result: { matches: [] },
  };
}
function finishSearches(request: PersonalReadRequest): ReadToolEvidence[] {
  const rows: ReadToolEvidence[] = [];
  for (
    let index = 0;
    index < 6 && nextRequiredReadTool(request, rows) === 'conversations.search';
    index += 1
  ) {
    const args = buildReadToolInput(request, 'conversations.search', rows);
    if (!args) throw new Error('Missing required search input');
    rows.push(result(args));
  }
  return rows;
}

describe('named historical exercises and retention constraints', () => {
  it.each([
    ['hypothetical Cobalt exercise', 'Cobalt'],
    ['fictional Bramble-7 scenario', 'Bramble-7'],
    ['fictional exercise called "Silver Finch"', 'Silver Finch'],
    ['hypothetical scenario named “Þruma”', 'Þruma'],
    ["fictional exercise called 'Juniper Ridge'", 'Juniper Ridge'],
  ])('routes an earlier %s to literal conversation evidence first', (description, anchor) => {
    const request = history(
      `Review our earlier ${description}. What did I actually say? Do not save this to memory.`,
    );
    expect(request).toMatchObject({
      kind: 'memory',
      firstToolName: 'conversations.search',
      conversationAnchorQuery: anchor,
      searchSavedMemory: false,
    });
    expect(buildReadToolInput(request, 'conversations.search', [])).toEqual({
      query: anchor,
      limit: 20,
      mode: 'text',
    });
    expect(
      groundReadToolInput(
        request,
        'conversations.search',
        { query: 'model substitute', mode: 'semantic' },
        [],
      ),
    ).toEqual({ query: anchor, limit: 20, mode: 'text' });
    const rows = finishSearches(request);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.args).toMatchObject({ query: request.conversationFollowupQuery });
    expect(rows[1]?.args).not.toHaveProperty('mode');
    expect(nextRequiredReadTool(request, rows)).toBeUndefined();
  });

  it.each([
    'Do not save this to long-term memory.',
    "Don't write this into saved memories.",
    'Never retain this in personal memory.',
    'Don’t update my saved memory.',
  ])('does not turn a retention restriction into saved-memory recall: %s', (restriction) => {
    const request = history(
      `Review the earlier fictional Cobalt exercise and show what I said. ${restriction}`,
    );
    expect(request.searchSavedMemory).toBe(false);
    expect(nextRequiredReadTool(request, finishSearches(request))).toBeUndefined();
  });

  it('keeps a current fictional task with only a retention restriction out of private reads', () => {
    expect(
      detectPersonalReadRequest(
        turn('Explain a fictional telescope design. Do not save this to long-term memory.'),
      ),
    ).toBeNull();
  });

  it.each([
    'For this fictional two-zone planning exercise, compare the supplied times. No memory writes.',
    'Audit the subscription list I supplied for duplicate charges; no memory writes.',
    'Review the fictional subscription scenario and tell me which plan is cheaper. Do not write anything to memory.',
    'Audit my pasted subscription list and report duplicate charges. No login/account change/cancel/unsubscribe/purchase/hold/send/Gmail draft/document/calendar/memory writes.',
    'Review these supplied times and report any overlap. No login/account change/cancel/unsubscribe/purchase/hold/send/Gmail draft/document/calendar writes and no writes to memory.',
  ])('does not treat a retention-only mention as a private read: %s', (text) => {
    expect(detectPersonalReadRequest(turn(text))).toBeNull();
  });

  it('keeps an explicit personal-source request inside a fictional scenario routed', () => {
    expect(
      detectPersonalReadRequest(
        turn('For a hypothetical schedule, check my actual calendar for tomorrow.'),
      ),
    ).toMatchObject({ kind: 'calendar', firstToolName: 'calendar.list_events' });
    expect(
      detectPersonalReadRequest(
        turn('For a fictional audit, search my real inbox for the subscription receipts.'),
      ),
    ).toMatchObject({ kind: 'email', firstToolName: 'gmail.search' });
  });

  it('permits explicitly requested saved-memory recall alongside conversation history', () => {
    const request = history(
      'Review the earlier fictional Cobalt exercise and compare it with my saved memories.',
    );
    expect(request.searchSavedMemory).toBe(true);
    expect(nextRequiredReadTool(request, finishSearches(request))).toBe('memory.recall');
  });

  it('keeps an explicitly requested history read when another source or saved-memory lookup is prohibited', () => {
    const noSave = history(
      'Find the earlier hypothetical planning exercise called Nimbus in our past chats. Recall its budget and travel constraint. Do not use email or calendar, and do not save new memories.',
    );
    expect(noSave).toMatchObject({
      kind: 'memory',
      firstToolName: 'conversations.search',
      searchSavedMemory: false,
    });

    const historyOnly = history(
      'What did I tell you earlier about meeting summaries? Use conversation history, but do not use saved personal memory.',
    );
    expect(historyOnly).toMatchObject({
      kind: 'memory',
      firstToolName: 'conversations.search',
      searchSavedMemory: false,
    });

    const noEmail = history(
      'Find my earlier conversations about a telescope. Do not use email; use history.',
    );
    expect(noEmail).toMatchObject({
      kind: 'memory',
      firstToolName: 'conversations.search',
      searchSavedMemory: false,
    });
  });

  it('still blocks each history source explicitly prohibited by the owner', () => {
    expect(
      detectPersonalReadRequest(
        turn('What did I say earlier about a telescope? Do not use conversation history.'),
      ),
    ).toBeNull();
    expect(
      detectPersonalReadRequest(
        turn(
          'What do my saved personal memories say about telescope preferences? Do not use saved personal memory.',
        ),
      ),
    ).toBeNull();

    expect(
      detectPersonalReadRequest(
        turn(
          'What do my saved personal memories say about telescope preferences? Do not use conversation history.',
        ),
      ),
    ).toMatchObject({
      kind: 'memory',
      firstToolName: 'memory.recall',
      searchSavedMemory: true,
    });
  });

  it('keeps separately stated lookup prohibitions scoped to their own clauses', () => {
    expect(
      detectPersonalReadRequest(
        turn('What is on my calendar tomorrow? Do not use email and do not use calendar.'),
      ),
    ).toBeNull();

    expect(
      detectPersonalReadRequest(
        turn('What is on my calendar tomorrow? Do not use email or calendar.'),
      ),
    ).toBeNull();

    expect(
      detectPersonalReadRequest(
        turn('What is on my calendar tomorrow? Do not use email, but check the calendar.'),
      ),
    ).toMatchObject({ kind: 'calendar' });

    expect(
      detectPersonalReadRequest(
        turn('What is on my calendar tomorrow? Without using my calendar.'),
      ),
    ).toBeNull();

    expect(
      detectPersonalReadRequest(
        turn(
          'What do my saved memories say about telescope preferences? Without reading my earlier chats, use saved memory.',
        ),
      ),
    ).toMatchObject({ kind: 'memory', firstToolName: 'memory.recall', searchSavedMemory: true });

    expect(
      detectPersonalReadRequest(
        turn(
          'What do my saved memories say about telescope preferences? Without reading history, use saved memory.',
        ),
      ),
    ).toMatchObject({
      kind: 'memory',
      firstToolName: 'memory.recall',
      searchSavedMemory: true,
    });
  });

  it('preserves a saved-memory read after a same-sentence retention restriction', () => {
    const request = detectPersonalReadRequest(
      turn(
        'Do not save this to memory, but show what my saved memories say about telescope preferences.',
      ),
    );
    expect(request).toMatchObject({
      kind: 'memory',
      firstToolName: 'memory.recall',
      searchSavedMemory: true,
    });
  });

  it('preserves a positive saved-memory request after a long action-prohibition list', () => {
    const request = detectPersonalReadRequest(
      turn(
        'No login/account change/cancel/unsubscribe/purchase/hold/send/Gmail draft/document/calendar/memory writes, but show what my saved memories say about budgeting.',
      ),
    );
    expect(request).toMatchObject({
      kind: 'memory',
      firstToolName: 'memory.recall',
      searchSavedMemory: true,
    });
  });

  it('keeps both owner evidence and explicit correction comparison within the three-query cap', () => {
    const request = history(
      'Review our earlier fictional Cobalt exercise. Separate my correction from your earlier claim and cite what I actually said.',
    );
    const rows = finishSearches(request);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => (row.args as Record<string, unknown>).query)).toEqual([
      'Cobalt',
      request.conversationFollowupQuery,
      request.conversationCorrectionQuery,
    ]);
    expect(request.conversationCorrectionQuery).toBeTruthy();
    expect(nextRequiredReadTool(request, rows)).toBeUndefined();
  });

  it('cannot satisfy the mandatory literal pass with semantic or earlier-task evidence', () => {
    const request = history('What did I say in our earlier fictional Cobalt exercise?');
    const wrongMode = result({ query: 'Cobalt', mode: 'semantic', limit: 20 });
    const priorTask = {
      ...result({ query: 'Cobalt', mode: 'text', limit: 20 }),
      fromCurrentTask: false,
    };
    expect(buildReadToolInput(request, 'conversations.search', [wrongMode, priorTask])).toEqual({
      query: 'Cobalt',
      mode: 'text',
      limit: 20,
    });
    expect(nextRequiredReadTool(request, [wrongMode, priorTask])).toBe('conversations.search');
    const truncatedWrongMode = {
      ...wrongMode,
      id: '56a09ec4-c495-4d96-966f-8e8e66476cef',
      result: { matches: [{ text: 'generic semantic result '.repeat(600) }] },
    };
    expect(nextRequiredReadTool(request, [truncatedWrongMode])).toBe('conversations.search');
    expect(buildReadToolInput(request, 'tools.read_result', [truncatedWrongMode])).toEqual({});
  });

  it('bounds failed literal and follow-up queries without opening saved memory', () => {
    const request = history(
      'Review our earlier fictional Cobalt exercise. Do not store this in personal memory.',
    );
    const rows: ReadToolEvidence[] = [];
    for (let index = 0; index < 4; index += 1) {
      const args = buildReadToolInput(request, 'conversations.search', rows);
      if (!args) throw new Error('Expected a bounded retry');
      rows.push(result(args, 'failed'));
    }
    expect(rows[0]?.args).toMatchObject({ mode: 'text' });
    expect(rows[0]?.args).toEqual(rows[1]?.args);
    expect(rows[2]?.args).toEqual(rows[3]?.args);
    expect(nextRequiredReadTool(request, rows)).toBeUndefined();
  });

  it('preserves semantic history retrieval when no name is supplied', () => {
    const request = history('What did I tell you earlier about telescope preferences?');
    expect(request.conversationAnchorQuery).toBeUndefined();
    expect(buildReadToolInput(request, 'conversations.search', [])).toEqual({
      query: request.conversationQuery,
      limit: 20,
    });
    expect(finishSearches(request)).toHaveLength(2);
  });
});

describe('compact calendar read presentation routing', () => {
  it.each(['compact', 'concise', 'short answer'])(
    'uses briefing presentation for an explicitly %s local-day agenda',
    (format) => {
      const request = detectPersonalReadRequest(
        turn(
          `Show my calendar for tomorrow in local time with event times, calendar names, source links, and overlaps. Keep it ${format}. Do not edit anything.`,
        ),
        { now: new Date('2026-10-14T18:00:00Z'), timeZone: 'America/Los_Angeles' },
      );
      expect(request).toMatchObject({
        kind: 'calendar',
        includeCalendarBriefing: true,
        includeCalendarOverlapSummary: true,
        firstToolName: 'calendar.list_events',
        timeWindow: { timeMin: '2026-10-15T07:00:00.000Z', timeMax: '2026-10-16T07:00:00.000Z' },
      });
    },
  );
});
