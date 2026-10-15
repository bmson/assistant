import { conversationMessageSpeakerRevision } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { stripNegativePrivateWriteConstraints } from './conversation-local-context.js';
import {
  type ExplicitSourceSelection,
  explicitReadSources,
  explicitSourceCoverage,
  explicitSourceResponse,
  selectExplicitSourceAnswer,
} from './explicit-source-read.js';
import {
  completedEvidence,
  germany,
  options,
  request,
  searchResult,
  threadResult,
} from './explicit-source-read.test-fixtures.js';
import {
  buildReadToolInput,
  detectPersonalReadRequest,
  nextRequiredReadTool,
} from './read-intent.js';
import { enforcePersonalReadResponse, enforceResponseContract } from './response-contract.js';

const selected = {
  conflicts: [],
  remaining: [],
  addressed: ['country_count', 'conflicts'] as Array<'country_count' | 'conflicts'>,
  claims: [{ text: 'Your Germany booking is for 2025-10-10.', evidence: [1] }],
  status: 'complete' as const,
  selections: [
    {
      sourceKey: 'message:owner-1',
      quote: 'I visited Germany in 2024.',
      country: 'Germany',
      classification: 'completed_visit' as const,
      date: '2024',
    },
    {
      sourceKey: 'mail:thread-1:mail-1',
      quote: 'Germany booking for 2025-10-10. Confirmation ABC-123.',
      country: 'Germany',
      classification: 'booking' as const,
      date: '2025-10-10',
    },
  ],
};

describe('explicit private-source orchestration', () => {
  it('preserves both explicit Germany sources instead of forcing saved memory', () => {
    const read = request(germany);
    expect(read.sourceReads?.map((child) => child.explicitSource)).toEqual(['mail', 'calendar']);
    const rows = completedEvidence(read);
    expect(rows.map((row) => row.toolName)).toEqual([
      'gmail.search',
      'calendar.search_events',
      'gmail.read_thread',
    ]);
    expect(rows[0]?.args).toMatchObject({ query: 'germany' });
    expect(rows[1]?.args).toEqual({
      query: 'germany',
      maxResults: 50,
      timeMax: options.now.toISOString(),
    });
    expect(explicitSourceCoverage(read, rows).every((row) => row.complete)).toBe(true);
  });
  it('preserves all countries sources, never adds saved memory from the negative tail', () => {
    const read = request();
    expect(read.sourceReads?.map((child) => child.explicitSource)).toEqual([
      'history',
      'mail',
      'calendar',
    ]);
    const rows = completedEvidence(read);
    expect(rows.map((row) => row.toolName)).toEqual([
      'conversations.search',
      'gmail.search',
      'calendar.search_events',
      'gmail.read_thread',
    ]);
    expect(rows.some((row) => row.toolName === 'memory.recall')).toBe(false);
    expect(explicitReadSources(read, rows).map((row) => row.key)).toEqual([
      'message:owner-1',
      'mail:thread-1:mail-1',
      'calendar:owner:event-1',
    ]);
  });
  it.each([
    'Do not infer personal facts or save memory. Read my booking emails/calendar.',
    'Do not save memory; search my earlier conversations and emails.',
    'Do not save memory, but read my emails and calendar tomorrow.',
  ])('preserves affirmative reads after retention constraints: %s', (text) => {
    expect(stripNegativePrivateWriteConstraints(text)).not.toContain('save memory');
    expect(request(text).sourceReads).toHaveLength(2);
  });
  it('keeps negated private reads prohibited', () => {
    const read = detectPersonalReadRequest(
      [
        {
          role: 'user',
          content: 'Do not read my emails or calendar. Use the details in this conversation.',
        },
      ],
      options,
    );
    expect(read?.sourceReads).toBeUndefined();
  });
  it('does not force a travel ledger on unrelated compound reads and resolves owner civil dates', () => {
    const read = request(
      'Compare Cedar from earlier conversations, my emails and calendar tomorrow.',
    );
    expect(read.travelHistory).toBe(false);
    expect(
      read.sourceReads?.find((child) => child.explicitSource === 'calendar')?.timeWindow,
    ).toMatchObject({ timeMin: '2026-10-16T07:00:00.000Z', timeMax: '2026-10-17T07:00:00.000Z' });
    const response = explicitSourceResponse(read, completedEvidence(read), {
      status: 'complete',
      selections: [],
    });
    expect(response.text).not.toContain('Confirmed within');
  });
  it('retains ambiguous calendar scope instead of assuming an upcoming week', () => {
    const read = request('Compare Cedar from my emails and calendars.');
    expect(
      read.sourceReads?.find((child) => child.explicitSource === 'calendar')?.scopeIssue,
    ).toContain('date range');
    expect(enforcePersonalReadResponse(read, completedEvidence(read)).blocked).toBe(true);
  });
  it('preserves legacy exclusive recall routing', () => {
    const read = detectPersonalReadRequest(
      [{ role: 'user', content: 'What did I tell you about Cedar in our earlier conversations?' }],
      options,
    );
    expect(read?.kind).toBe('memory');
    expect(read?.sourceReads).toBeUndefined();
  });
  it('uses successful exact quotes, separates booking dates and counts only owner-supported visits', () => {
    const read = request();
    const rows = completedEvidence(read);
    const response = enforceResponseContract('You last visited Germany in 2025.', rows, {
      readRequest: read,
      explicitSourceSelection: selected,
    });
    expect(response.text).toContain(
      '| Germany | completed visit | 2024 | [Earlier conversation](/chat/old-chat)',
    );
    expect(response.text).toContain('Your Germany booking is for 2025-10-10.');
    expect(response.text).toContain('At least **1 supported country/territory name**');
    expect(response.text).toContain('| Place | Evidence status | Date in record | Source |\n| ---');
    expect(response.text).not.toContain('You last visited');
    expect(response.blocked).toBe(false);
  });
  it.each([
    'wrong-key',
    'forged-quote',
    'booking-as-visit',
    'assistant-as-owner',
    'city-as-country',
  ])('rejects unsupported synthesis: %s', (mutation) => {
    const read = request();
    const rows = completedEvidence(read);
    const selection = structuredClone(selected);
    const item = selection.selections[0];
    if (!item) throw new Error('fixture');
    if (mutation === 'wrong-key') item.sourceKey = 'message:other';
    if (mutation === 'forged-quote') item.quote = 'I visited France.';
    if (mutation === 'booking-as-visit') {
      item.sourceKey = 'mail:thread-1:mail-1';
      item.quote = 'Germany booking for 2025-10-10. Confirmation ABC-123.';
    }
    if (mutation === 'assistant-as-owner') {
      const match = ((rows[0]?.result ?? {}) as { matches: Array<Record<string, unknown>> })
        .matches[0];
      if (match) match.speakerRevision = 'forged';
    }
    if (mutation === 'city-as-country') {
      item.country = 'Berlin';
      item.quote = 'I visited Berlin in 2024.';
      const match = ((rows[0]?.result ?? {}) as { matches: Array<Record<string, unknown>> })
        .matches[0];
      if (match) {
        match.text = item.quote;
        match.speakerRevision = conversationMessageSpeakerRevision(
          'owner-1',
          item.quote,
          'user',
          'owner',
        );
      }
    }
    expect(explicitSourceResponse(read, rows, selection).blocked).toBe(true);
  });
  it.each([
    'missing-calendar',
    'failed-history',
    'unread-thread',
    'partial-search',
    'broken-receipt',
    'old-task',
    'wrong-window',
    'missing-calendar-roster',
  ])('retains incomplete sources as gaps: %s', (mutation) => {
    const read = request();
    let rows = completedEvidence(read);
    if (mutation === 'missing-calendar')
      rows = rows.filter((row) => row.toolName !== 'calendar.search_events');
    if (mutation === 'failed-history' && rows[0]) rows[0].status = 'failed';
    if (mutation === 'unread-thread')
      rows = rows.filter((row) => row.toolName !== 'gmail.read_thread');
    if (mutation === 'partial-search') (rows[1]?.result as Record<string, unknown>).hasMore = true;
    if (mutation === 'broken-receipt') (rows[1]?.result as Record<string, unknown>).receipt = null;
    if (mutation === 'old-task') for (const row of rows) row.fromCurrentTask = false;
    if (mutation === 'wrong-window')
      (rows[2]?.args as Record<string, unknown>).timeMax = '2030-01-01T00:00:00Z';
    if (mutation === 'missing-calendar-roster')
      ((rows[2]?.result ?? {}) as Record<string, unknown>).calendarRosterComplete = false;
    const response = explicitSourceResponse(read, rows, selected);
    expect(response.blocked).toBe(true);
    expect(response.text).toContain('coverage incomplete');
    expect(enforcePersonalReadResponse(read, rows).blocked).toBe(true);
  });
  it('cannot publish a partial thread body or an out-of-window calendar event', () => {
    const read = request();
    const rows = completedEvidence(read);
    (rows[3]?.result as Record<string, unknown>).complete = false;
    (
      ((rows[2]?.result ?? {}) as { events: Array<Record<string, unknown>> }).events[0] as Record<
        string,
        unknown
      >
    ).start = '2030-01-01T00:00:00Z';
    expect(explicitReadSources(read, rows).map((row) => row.key)).toEqual(['message:owner-1']);
  });
  it('makes at most one tool-free selector call and fails closed on provider or quote failure', async () => {
    const read = request();
    const rows = completedEvidence(read);
    const router = {
      object: vi.fn(async () => ({
        ok: true,
        object: {
          selections: selected.selections,
          claims: selected.claims,
          addressed: selected.addressed,
        },
      })),
    };
    expect(
      await selectExplicitSourceAnswer({
        router: router as never,
        taskId: 'task',
        request: read,
        evidence: rows,
      }),
    ).toMatchObject(selected);
    expect(router.object).toHaveBeenCalledTimes(1);
    router.object.mockRejectedValueOnce(new Error('private provider payload'));
    expect(
      await selectExplicitSourceAnswer({
        router: router as never,
        taskId: 'task',
        request: read,
        evidence: rows,
      }),
    ).toEqual({ status: 'unavailable', selections: [] });
  });
  it('never promotes a quoted report inside an owner message into owner attendance', () => {
    const read = request();
    const rows = completedEvidence(read);
    const quote = 'I visited Germany in 2024.';
    const text = `Alex said: “${quote}”`;
    const result = rows[0]?.result as { matches: Array<Record<string, unknown>> };
    const match = result.matches[0];
    if (!match) throw new Error('fixture');
    match.text = text;
    match.speakerRevision = conversationMessageSpeakerRevision('owner-1', text, 'user', 'owner');
    const response = explicitSourceResponse(read, rows, selected);
    expect(response.blocked).toBe(true);
    expect(response.text).toContain('could not reliably complete');
    expect(response.text).not.toContain('0 distinct');
  });
  it('honors positive saved-memory reads without substituting them for requested conversation history', () => {
    const read = request('Compare Cedar from Assistant history, saved memories and my emails.');
    expect(
      read.sourceReads?.find((child) => child.explicitSource === 'history')?.searchSavedMemory,
    ).toBe(true);
    const allRows = completedEvidence(read);
    expect(allRows.map((row) => row.toolName)).toContain('memory.recall');
    expect(explicitSourceCoverage(read, allRows).every((row) => row.complete)).toBe(true);
    const rows = allRows.filter((row) => row.toolName !== 'conversations.search');
    expect(
      explicitSourceCoverage(read, rows).find((row) => row.source === 'history')?.complete,
    ).toBe(false);
  });
  it('does not let wrong-query or old-task evidence consume a first read', () => {
    const read = request();
    const rows = completedEvidence(read).map((row) => ({
      ...row,
      args: { ...(row.args as Record<string, unknown>), query: 'unrelated' },
    }));
    expect(nextRequiredReadTool(read, rows)).toBe('conversations.search');
    expect(buildReadToolInput(read, 'conversations.search', rows)).toMatchObject({
      query: read.sourceReads?.[0]?.conversationQuery,
    });
  });
  it('keeps unread matches incomplete when the bounded three-thread sample is exhausted', () => {
    const read = request(germany);
    const rows = completedEvidence(read);
    const search = rows.find((row) => row.toolName === 'gmail.search');
    if (!search) throw new Error('fixture');
    const args = search.args as Record<string, unknown>;
    search.result = searchResult(String(args.query), Number(args.maxResults), [
      'thread-1',
      'thread-2',
      'thread-3',
      'thread-4',
    ]);
    expect(explicitSourceCoverage(read, rows).find((row) => row.source === 'mail')?.complete).toBe(
      false,
    );
  });
  it('binds full-body continuation offsets before selecting a mail passage', () => {
    const read = request(germany);
    const rows = completedEvidence(read);
    const row = rows.find((row) => row.toolName === 'gmail.read_thread');
    if (!row) throw new Error('fixture');
    const body = 'Germany booking for 2025-10-10. Confirmation ABC-123.';
    const result = threadResult(body);
    const first = {
      ...result,
      complete: false,
      hasMore: true,
      continuation: {
        tool: 'gmail.read_thread',
        input: {
          threadId: 'thread-1',
          startMessageIndex: 0,
          startMessageOffset: 20,
          maxMessages: 20,
          maxChars: 20000,
        },
      },
      messages: result.messages.map((message) => ({
        ...message,
        text: body.slice(0, 20),
        truncated: true,
      })),
      receipt: {
        ...result.receipt,
        complete: false,
        losses: ['message-body'] as string[],
        continuation: null as unknown,
      },
    };
    first.receipt.continuation = structuredClone(first.continuation);
    row.result = first;
    expect(nextRequiredReadTool(read, rows)).toBe('gmail.read_thread');
    const args = buildReadToolInput(read, 'gmail.read_thread', rows);
    expect(args).toMatchObject({ threadId: 'thread-1', startMessageOffset: 20 });
    expect(explicitReadSources(read, rows).some((source) => source.key.startsWith('mail:'))).toBe(
      false,
    );
    rows.push({
      toolName: 'gmail.read_thread',
      status: 'succeeded',
      fromCurrentTask: true,
      args,
      result: {
        ...result,
        messages: result.messages.map((message) => ({ ...message, text: body.slice(20) })),
        receipt: {
          ...result.receipt,
          requested: { ...result.receipt.requested, offset: 20 },
          covered: { ...result.receipt.covered, offset: 20 },
        },
      },
    });
    expect(
      explicitReadSources(read, rows).find((source) => source.key.startsWith('mail:'))?.body,
    ).toBe(body);
    expect(
      explicitSourceCoverage(read, rows).find((source) => source.source === 'mail')?.complete,
    ).toBe(true);
  });
  it('excludes the exact current owner request even when it contains a chained retention constraint', () => {
    const read = request();
    const rows = completedEvidence(read);
    const text = read.sourceReadText ?? '';
    const result = rows[0]?.result as { matches: Array<Record<string, unknown>> };
    result.matches.push({
      messageId: 'current-request',
      conversationId: 'current-chat',
      text,
      role: 'user',
      origin: 'owner',
      speakerRevision: conversationMessageSpeakerRevision('current-request', text, 'user', 'owner'),
    });
    expect(
      explicitReadSources(read, rows).some((source) => source.key === 'message:current-request'),
    ).toBe(false);
  });
  it('leads a last-trip answer with the unresolved visit and linked dated booking, without a country-count paragraph', () => {
    const read = request(germany);
    const rows = completedEvidence(read);
    const projection = explicitSourceResponse(read, rows, {
      status: 'complete',
      selections: selected.selections.slice(1),
      claims: [{ text: 'Your Germany booking is for 2025-10-10.', evidence: [0] }],
      addressed: ['chronology', 'conflicts'],
    });
    expect(projection.text.startsWith('I cannot confirm when you last completed this trip')).toBe(
      true,
    );
    expect(projection.text).toContain('latest dated record returned');
    expect(projection.text).toContain('2025-10-10');
    expect(projection.text).toContain(
      '[Synthetic booking](https://mail.google.com/mail/u/0/#all/thread-1)',
    );
    expect(projection.text).not.toContain('country/territory');
    expect(projection.text).not.toContain('mail-1');
    expect(projection.text.indexOf('Coverage:')).toBeGreaterThan(
      projection.text.indexOf('Your Germany booking'),
    );
    expect(projection.blocked).toBe(true);
  });
  it('shows a latest completed-visit date only from dated owner evidence and retains conflicting booking dates separately', () => {
    const read = request(
      'When did I go to Germany last time? Check Assistant history, booking emails/calendar and point out conflicting records.',
    );
    const rows = completedEvidence(read);
    const projection = explicitSourceResponse(read, rows, {
      ...selected,
      addressed: ['chronology', 'conflicts'],
    });
    expect(
      projection.text.startsWith(
        'Your latest supported completed visit **within these returned records** was in **2024**',
      ),
    ).toBe(true);
    expect(projection.text).toContain('[Earlier conversation](/chat/old-chat)');
    expect(projection.text).toContain('Their trip/occurrence identity has not been reconciled');
    expect(projection.text).not.toContain('At least');
    expect(projection.blocked).toBe(true);
  });
  it('binds a reported date conflict to a literal shared booking reference and links both records', () => {
    const read = request(germany);
    const rows = completedEvidence(read);
    const calendar = rows.find((row) => row.toolName === 'calendar.search_events');
    if (!calendar) throw new Error('fixture');
    const event = (calendar.result as { events: Array<Record<string, unknown>> }).events[0];
    if (!event) throw new Error('fixture');
    event.description = 'Germany booking for 2025-10-11. Confirmation ABC-123.';
    const projection = explicitSourceResponse(read, rows, {
      status: 'complete',
      addressed: ['chronology', 'conflicts'],
      selections: [
        ...selected.selections.slice(1),
        {
          sourceKey: 'calendar:owner:event-1',
          quote: String(event.description),
          country: 'Germany',
          classification: 'booking',
          date: '2025-10-11',
        },
      ],
      conflicts: [{ left: 0, right: 1, identity: 'ABC-123' }],
    });
    expect(projection.text).toContain('Unresolved record conflict');
    expect(projection.text).toContain('reference ABC-123 has 2025-10-10 versus 2025-10-11');
    expect(projection.text).toContain(
      'https://calendar.google.com/calendar/event?eid=synthetic-event',
    );
    expect(projection.blocked).toBe(true);
  });
  it('enumerates an exact general calendar window and answers with linked useful claims, not task-prose keywords', () => {
    const read = request(
      'Review the next seven local calendar days and relevant authorized messages, with a preparation checklist.',
    );
    const calendar = read.sourceReads?.find((child) => child.explicitSource === 'calendar');
    expect(calendar?.firstToolName).toBe('calendar.list_events');
    expect(calendar?.timeWindow).toMatchObject({
      timeMin: '2026-10-15T07:00:00.000Z',
      timeMax: '2026-10-22T07:00:00.000Z',
    });
    expect(nextRequiredReadTool(read, [])).toBe('calendar.list_events');
    const args = buildReadToolInput(read, 'calendar.list_events', []);
    expect(args).not.toHaveProperty('query');
    expect(args).not.toHaveProperty('calendarIds');
    const rows = [
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        fromCurrentTask: true,
        args,
        result: {
          complete: true,
          calendarRosterComplete: true,
          unavailable: [],
          events: [
            {
              eventId: 'cedar-event',
              calendarId: 'work',
              summary: 'Cedar review',
              start: '2026-10-16T19:00:00Z',
              end: '2026-10-16T20:00:00Z',
              links: [
                { type: 'calendar', url: 'https://calendar.google.com/calendar/event?eid=cedar' },
              ],
            },
          ],
        },
      },
    ] as ReturnType<typeof completedEvidence>;
    const search = buildReadToolInput(read, 'gmail.search', rows);
    expect(search?.query).toBe('{"Cedar review"}');
    rows.push({
      toolName: 'gmail.search',
      status: 'succeeded',
      fromCurrentTask: true,
      args: search,
      result: searchResult(String(search?.query), 20),
    });
    const threadArgs = buildReadToolInput(read, 'gmail.read_thread', rows);
    rows.push({
      toolName: 'gmail.read_thread',
      status: 'succeeded',
      fromCurrentTask: true,
      args: threadArgs,
      result: threadResult('Cedar review requires budget notes.'),
    });
    const synthesis: ExplicitSourceSelection = {
      status: 'complete',
      addressed: ['summary'],
      selections: [
        {
          sourceKey: 'calendar:work:cedar-event',
          quote:
            'Cedar review\nOwner local time: Oct 16, 2026, 12:00 PM–Oct 16, 2026, 1:00 PM (America/Los_Angeles)\n2026-10-16T19:00:00Z',
          country: null,
          classification: 'record',
          date: '2026-10-16',
        },
        {
          sourceKey: 'mail:thread-1:mail-1',
          quote: 'Cedar review requires budget notes.',
          country: null,
          classification: 'record',
        },
      ],
      claims: [
        { text: 'Cedar review is scheduled for 2026-10-16.', evidence: [0] },
        { text: 'Cedar review requires budget notes.', evidence: [1] },
        { kind: 'suggestion', text: 'Prepare budget notes before Cedar review.', evidence: [1] },
      ],
    };
    const projection = explicitSourceResponse(read, rows, synthesis);
    expect(projection.text.startsWith('Cedar review is scheduled for 2026-10-16.')).toBe(true);
    expect(projection.text).toContain('Cedar review requires budget notes.');
    expect(projection.text).toContain('- [ ] Prepare budget notes before Cedar review.');
    expect(projection.text).toContain('Suggested preparation (not performed)');
    expect(projection.text).toContain(
      '[Cedar review](https://calendar.google.com/calendar/event?eid=cedar)',
    );
    expect(projection.text).not.toContain('cedar-event');
    expect(projection.text).not.toContain('country');
    expect(projection.blocked).toBe(false);
    const reversed = structuredClone(synthesis);
    const scheduled = reversed.claims?.[0];
    if (!scheduled) throw new Error('fixture');
    scheduled.text = 'Cedar review is not scheduled for 2026-10-16.';
    const reversedProjection = explicitSourceResponse(read, rows, reversed);
    expect(reversedProjection.blocked).toBe(true);
    expect(reversedProjection.text).not.toContain('Cedar review is not scheduled');
    const noPlan = explicitSourceResponse(read, rows, {
      ...synthesis,
      claims: synthesis.claims?.filter((claim) => claim.kind !== 'suggestion'),
    });
    expect(noPlan.blocked).toBe(true);
    expect(noPlan.text).toContain('preparation plan/checklist is still incomplete');
    const omittedEvent = explicitSourceResponse(read, rows, {
      ...synthesis,
      claims: synthesis.claims?.filter((claim) => !claim.evidence.includes(0)),
    });
    expect(omittedEvent.blocked).toBe(true);
    expect(omittedEvent.text).toContain('Some events in the requested calendar window are absent');
  });
  it('does not mark quote selection alone or an omitted requested deliverable complete', () => {
    const read = request();
    const rows = completedEvidence(read);
    expect(
      explicitSourceResponse(read, rows, { status: 'complete', selections: selected.selections })
        .blocked,
    ).toBe(true);
    const incomplete = explicitSourceResponse(read, rows, {
      ...selected,
      remaining: ['ask the most useful missing question'],
    });
    expect(incomplete.blocked).toBe(true);
    expect(incomplete.text).toContain('Still unanswered');
  });
  it('treats a refreshed unavailable history result as a source gap even when its durable tool status succeeded', () => {
    const read = request();
    const rows = completedEvidence(read);
    if (!rows[0]) throw new Error('fixture');
    rows[0].result = { mode: 'unavailable', matches: [], note: 'Source refresh unavailable' };
    expect(
      explicitSourceCoverage(read, rows).find((row) => row.source === 'history')?.complete,
    ).toBe(false);
    expect(explicitSourceResponse(read, rows, selected).blocked).toBe(true);
  });
  it.each(['wrong-number', 'negation-loss', 'borrowed-source-fact', 'false-visit'])(
    'rejects an unsupported synthesized assertion: %s',
    (mutation) => {
      const read = request();
      const rows = completedEvidence(read);
      const answer = structuredClone(selected);
      const claim = answer.claims[0];
      if (!claim) throw new Error('fixture');
      if (mutation === 'wrong-number') claim.text = 'Your Germany booking is for 2030-10-10.';
      if (mutation === 'negation-loss') {
        const mail = rows.find((row) => row.toolName === 'gmail.read_thread');
        if (!mail) throw new Error('fixture');
        mail.result = threadResult(
          'Germany booking is not confirmed for 2025-10-10. Confirmation ABC-123.',
        );
        const item = answer.selections[1];
        if (!item) throw new Error('fixture');
        item.quote = 'Germany booking is not confirmed for 2025-10-10. Confirmation ABC-123.';
        claim.text = 'Germany booking is confirmed for 2025-10-10.';
      }
      if (mutation === 'borrowed-source-fact') claim.evidence = [0, 1];
      if (mutation === 'false-visit') claim.text = 'Your Germany visit is for 2025-10-10.';
      expect(explicitSourceResponse(read, rows, answer).blocked).toBe(true);
    },
  );
  it.each([
    { body: 'No booking for Germany on 2025-10-10.', classification: 'booking' as const },
    {
      body: 'Germany booking is not cancelled for 2025-10-10.',
      classification: 'cancellation' as const,
    },
  ])(
    'does not turn a negated status into a positive $classification label',
    ({ body, classification }) => {
      const read = request(germany);
      const rows = completedEvidence(read);
      const mail = rows.find((row) => row.toolName === 'gmail.read_thread');
      if (!mail) throw new Error('fixture');
      mail.result = threadResult(body);
      const projection = explicitSourceResponse(read, rows, {
        status: 'complete',
        addressed: ['chronology', 'conflicts'],
        selections: [
          {
            sourceKey: 'mail:thread-1:mail-1',
            quote: body,
            classification,
            country: 'Germany',
            date: '2025-10-10',
          },
        ],
      });
      expect(projection.blocked).toBe(true);
      expect(projection.text).toContain('could not reliably complete');
    },
  );
  it('preserves a sourced negative assertion and rejects replacing it with a positive claim', () => {
    const read = request('Compare Cedar from Assistant history and my emails.');
    const rows = completedEvidence(read);
    const mail = rows.find((row) => row.toolName === 'gmail.read_thread');
    if (!mail) throw new Error('fixture');
    const quote = 'Cedar review is not scheduled for 2026-10-16.';
    mail.result = threadResult(quote);
    const answer: ExplicitSourceSelection = {
      status: 'complete',
      addressed: ['summary'],
      selections: [
        {
          sourceKey: 'mail:thread-1:mail-1',
          quote,
          classification: 'record',
          country: null,
          date: '2026-10-16',
        },
      ],
      claims: [{ text: quote, evidence: [0] }],
    };
    expect(explicitSourceResponse(read, rows, answer).blocked).toBe(false);
    const claim = answer.claims?.[0];
    if (!claim) throw new Error('fixture');
    claim.text = 'Cedar review is scheduled for 2026-10-16.';
    const reversed = explicitSourceResponse(read, rows, answer);
    expect(reversed.blocked).toBe(true);
    expect(reversed.text).not.toContain('Cedar review is scheduled');
  });
});
