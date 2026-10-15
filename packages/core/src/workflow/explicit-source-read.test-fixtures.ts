import { conversationMessageSpeakerRevision } from '@assistant/persistence';
import { gmailSearchReceiptSourceId } from '@assistant/persistence/gmail-search-identity';
import {
  buildReadToolInput,
  detectPersonalReadRequest,
  nextRequiredReadTool,
  type ReadToolEvidence,
} from './read-intent.js';
export const germany =
  'When did I go to Germany last time? Check my booking emails/calendar and point out any conflicting records.';
export const countries =
  'How many countries have I actually visited? Build a source-linked ledger from authorized Assistant history, travel emails and calendars; deduplicate countries and separate supported completed visits from future bookings, cancellations and airport-only connections. State the count confirmed within the searched corpus and whether an all-time total is knowable. List disputed entries separately, explain coverage/date scope and ask the most useful missing question. Do not equate booking/layover with a visit, infer nationality/residence, import Codex facts or save memory.';
export const options = { now: new Date('2026-10-15T19:00:00Z'), timeZone: 'America/Los_Angeles' };
export function request(text = countries) {
  const result = detectPersonalReadRequest([{ role: 'user', content: text }], options);
  if (!result?.sourceReads) throw new Error('Missing explicit source bundle');
  return result;
}
export function searchResult(query: string, maxResults = 20, ids = ['thread-1']) {
  return {
    query,
    results: ids.map((threadId) => ({ threadId, subject: 'Synthetic record' })),
    complete: true,
    hasMore: false,
    unavailable: [],
    receipt: {
      version: 1,
      source: { kind: 'gmail-search', id: gmailSearchReceiptSourceId(query) },
      requested: { limit: maxResults, scope: 'query-page' },
      covered: { count: ids.length, total: ids.length, unavailable: 0 },
      complete: true,
      losses: [],
      continuation: null,
    },
  };
}
export function threadResult(body = 'Germany booking for 2025-10-10. Confirmation ABC-123.') {
  return {
    threadId: 'thread-1',
    complete: true,
    hasMore: false,
    messages: [
      {
        messageId: 'mail-1',
        subject: 'Synthetic booking',
        text: body,
        truncated: false,
        sourceLength: body.length,
      },
    ],
    receipt: {
      version: 1,
      source: { kind: 'gmail-thread', id: 'thread-1' },
      requested: { start: 0, offset: 0, limit: 20, scope: 'thread-messages' },
      covered: { start: 0, offset: 0, end: 1, count: 1, total: 1, unavailable: 0 },
      complete: true,
      losses: [],
      continuation: null,
    },
  };
}
export function resultFor(toolName: string, args: Record<string, unknown>) {
  if (toolName === 'conversations.search') {
    const text = 'I visited Germany in 2024.';
    return {
      matches: [
        {
          messageId: 'owner-1',
          conversationId: 'old-chat',
          text,
          role: 'user',
          origin: 'owner',
          speakerRevision: conversationMessageSpeakerRevision('owner-1', text, 'user', 'owner'),
          createdAt: '2024-10-20T12:00:00Z',
        },
      ],
    };
  }
  if (toolName === 'memory.recall') return { memories: [] };
  if (toolName === 'gmail.search') return searchResult(String(args.query), Number(args.maxResults));
  if (toolName === 'gmail.read_thread') return threadResult();
  return {
    events: [
      {
        eventId: 'event-1',
        calendarId: 'owner',
        summary: 'Germany booking',
        start: '2025-10-11T07:00:00Z',
        end: '2025-10-12T07:00:00Z',
      },
    ],
    complete: true,
    calendarRosterComplete: true,
    unavailable: [],
  };
}
export function completedEvidence(read = request()) {
  const rows: Array<ReadToolEvidence & { result: unknown }> = [];
  for (let index = 0; index < 12; index++) {
    const toolName = nextRequiredReadTool(read, rows);
    if (!toolName) break;
    const args = buildReadToolInput(read, toolName, rows);
    if (!args) throw new Error(`Missing input ${toolName}`);
    rows.push({
      toolName,
      args,
      result: resultFor(toolName, args),
      status: 'succeeded',
      fromCurrentTask: true,
    });
  }
  return rows;
}
