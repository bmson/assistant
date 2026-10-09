import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  createChatLogOrder,
  dayLabel,
  messageText,
  orderChatLog,
  retireProvisionalReplies,
  retireProvisionalUserTurns,
  sameDay,
  stampLabel,
  timeLabel,
} from './message-view';

/** A message as the server sends it: real id, persisted timestamp. */
function durable(id: string, role: 'user' | 'assistant', text: string, at?: string): UIMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    ...(at ? { metadata: { createdAt: at } } : {}),
  } as UIMessage;
}

/** A message the client made itself: local id, no persisted timestamp. */
function provisional(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  durableMessageId?: string,
): UIMessage {
  return { id, role, metadata: { durableMessageId }, parts: [{ type: 'text', text }] } as UIMessage;
}

function order(messages: UIMessage[]): string[] {
  return orderChatLog(messages, createChatLogOrder()).map((message) => message.id);
}

describe('orderChatLog', () => {
  it('orders a late arrival from an earlier task before a turn already on screen', () => {
    expect(
      order([
        durable('b', 'user', 'second', '2026-08-18T10:05:00.000Z'),
        durable('a', 'assistant', 'first', '2026-08-18T10:00:00.000Z'),
      ]),
    ).toEqual(['a', 'b']);
  });

  it('keeps an in-flight local turn at the end, where it is being typed', () => {
    expect(
      order([
        provisional('local', 'user', 'typing'),
        durable('a', 'assistant', 'first', '2026-08-18T10:00:00.000Z'),
      ]),
    ).toEqual(['a', 'local']);
  });

  it('keeps the complete persisted answer when a later identified stream snapshot is partial', () => {
    const channelMessageId = 'chat-reply:task-1';
    const streamed = {
      ...provisional('sdk-stream-id', 'assistant', 'This local chat is working.'),
      metadata: { channelMessageId },
    } as UIMessage;
    const persistedParts = [
      { type: 'text', text: 'This local chat is working.' },
      { type: 'data-card', data: { kind: 'generated-card', title: 'Verified answer' } },
    ];
    const persisted = {
      ...durable(
        'database-message-id',
        'assistant',
        'This local chat is working.',
        '2026-10-08T12:00:00.000Z',
      ),
      parts: persistedParts,
      metadata: {
        channelMessageId,
        createdAt: '2026-10-08T12:00:00.000Z',
        source: 'response-contract',
      },
    } as UIMessage;
    const laterStreamSnapshot = {
      ...streamed,
      parts: [{ type: 'text', text: 'Raw partial stream without the guarded answer.' }],
    } as UIMessage;

    const rows = orderChatLog([streamed, persisted, laterStreamSnapshot], createChatLogOrder());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('database-message-id');
    expect(rows[0]?.parts).toEqual(persistedParts);
    expect(rows[0]?.metadata).toMatchObject({
      channelMessageId,
      createdAt: '2026-10-08T12:00:00.000Z',
      source: 'response-contract',
    });
  });

  it('does not merge identical assistant text without a shared channel identity', () => {
    const body = 'This local chat is working.';
    const first = provisional('stream-a', 'assistant', body);
    const second = durable('stored-b', 'assistant', body, '2026-10-08T12:00:00.000Z');
    expect(order([first, second])).toEqual(['stored-b', 'stream-a']);
  });

  it('breaks a timestamp tie on id so the order is stable across polls', () => {
    const at = '2026-08-18T10:00:00.000Z';
    expect(order([durable('b', 'user', 'x', at), durable('a', 'user', 'y', at)])).toEqual([
      'a',
      'b',
    ]);
    expect(order([durable('a', 'user', 'y', at), durable('b', 'user', 'x', at)])).toEqual([
      'a',
      'b',
    ]);
  });

  it('never floats a streaming reply above the question that prompted it', () => {
    // Both are undated, and the AI SDK's ids are random — sorting them by id
    // put the answer above the question roughly half the time. Arrival order
    // is the only thing that knows which came first.
    const order = createChatLogOrder();
    const question = provisional('zzz-user', 'user', 'what is on today?');
    const reply = provisional('aaa-assistant', 'assistant', 'Two meetings…');
    const log = orderChatLog([question, reply], order);
    expect(log.map((message) => message.id)).toEqual(['zzz-user', 'aaa-assistant']);
    // And it stays put once a durable message from earlier is merged in.
    const withEarlier = orderChatLog(
      [reply, durable('s1', 'assistant', 'earlier', '2026-08-18T09:00:00.000Z'), question],
      order,
    );
    expect(withEarlier.map((message) => message.id)).toEqual(['s1', 'zzz-user', 'aaa-assistant']);
  });

  // Send times are cached per id so a long thread is not re-parsed on every
  // render. An undated message must NOT be cached as undated: it is a local
  // turn whose durable twin arrives later under the same id, carrying the
  // send time that decides where it really belongs.
  it('sorts a message by the send time it gains later, not by the one it lacked', () => {
    const order = createChatLogOrder();
    const local = provisional('m1', 'user', 'book the flight');
    const earlier = durable('s1', 'assistant', 'earlier', '2026-08-18T09:00:00.000Z');
    expect(orderChatLog([local, earlier], order).map((m) => m.id)).toEqual(['s1', 'm1']);

    // The same id comes back persisted, and dated BEFORE the message it had
    // been sorted after.
    const persisted = durable('m1', 'user', 'book the flight', '2026-08-18T08:00:00.000Z');
    expect(orderChatLog([persisted, earlier], order).map((m) => m.id)).toEqual(['m1', 's1']);
  });

  it('renders only the latest SDK snapshot when a stream identity occurs twice', () => {
    const first = provisional('qgz-stream', 'assistant', 'The reply is starting.');
    const latest = provisional('qgz-stream', 'assistant', 'This local chat is working.');
    const log = orderChatLog([first, latest], createChatLogOrder());

    expect(log).toHaveLength(1);
    expect(log[0]?.id).toBe('qgz-stream');
    expect(log[0] ? messageText(log[0]) : '').toBe('This local chat is working.');
  });

  it('gives the same order whether or not the send times are already cached', () => {
    const order = createChatLogOrder();
    const log = [
      durable('b', 'user', 'second', '2026-08-18T10:05:00.000Z'),
      durable('a', 'assistant', 'first', '2026-08-18T10:00:00.000Z'),
    ];
    const first = orderChatLog(log, order).map((m) => m.id);
    expect(orderChatLog(log, order).map((m) => m.id)).toEqual(first);
    expect(first).toEqual(['a', 'b']);
  });
});

describe('explicit provisional identity', () => {
  it('keeps repeated identical user requests and replies with no acknowledgement', () => {
    for (const role of ['user', 'assistant'] as const) {
      const log = [durable('old', role, 'Same words'), provisional('new', role, 'Same words')];
      const retire = role === 'user' ? retireProvisionalUserTurns : retireProvisionalReplies;
      expect(retire(log, new Set(['old']))).toEqual(log);
      expect(retire(retire(log, new Set(['old'])), new Set(['old']))).toEqual(log);
    }
  });
  it('uses the acknowledged reply identity even when the contract replaces the text', () => {
    const local = {
      ...provisional('stream', 'assistant', 'Old draft'),
      metadata: { channelMessageId: 'chat-reply:task-B' },
    };
    const old = {
      ...durable('A', 'assistant', 'Same'),
      metadata: { channelMessageId: 'chat-reply:task-A' },
    };
    const current = {
      ...durable('B', 'assistant', 'Corrected'),
      metadata: { channelMessageId: 'chat-reply:task-B' },
    };
    expect(retireProvisionalReplies([old, local, current], new Set(['A', 'B']))).toEqual([
      old,
      current,
    ]);
  });
});

describe('retireProvisionalUserTurns', () => {
  it('retires the optimistic turn when its persisted twin is in the log', () => {
    const log = [
      durable('s1', 'assistant', 'earlier', '2026-08-18T09:00:00.000Z'),
      provisional('local-user', 'user', 'book the flight', 's2'),
      durable('s2', 'user', 'book the flight', '2026-08-18T10:00:00.000Z'),
    ];
    const kept = retireProvisionalUserTurns(log, new Set(['s1', 's2']));
    expect(kept.map((message) => message.id)).toEqual(['s1', 's2']);
  });

  it('shows the same question twice when it was genuinely asked twice', () => {
    // One durable copy must retire exactly one local copy, not both.
    const log = [
      provisional('local-1', 'user', 'status?', 's2'),
      provisional('local-2', 'user', 'status?'),
      durable('s2', 'user', 'status?', '2026-08-18T10:00:00.000Z'),
    ];
    const kept = retireProvisionalUserTurns(log, new Set(['s2']));
    expect(kept.map((message) => message.id)).toEqual(['local-2', 's2']);
  });
});

describe('retireProvisionalReplies', () => {
  it('retires the streamed reply once its persisted twin is in the log', () => {
    const log = [
      provisional('streamed', 'assistant', 'Booked it.', 's2'),
      durable('s2', 'assistant', 'Booked it.', '2026-08-18T10:00:00.000Z'),
    ];
    const kept = retireProvisionalReplies(log, new Set(['s2']));
    expect(kept.map((message) => message.id)).toEqual(['s2']);
  });

  it('does not let an unrelated durable message delete a reply', () => {
    // A scheduled brief, a watch firing, or inbound mail mirrored into chat all
    // arrive as durable assistant messages. None of them is the twin of the
    // reply being streamed, and the old rule deleted it for every one of them.
    const log = [
      provisional('streamed', 'assistant', 'Two meetings, both after lunch.'),
      durable('s2', 'assistant', 'Your 3pm moved to 4pm.', '2026-08-18T10:00:00.000Z'),
    ];
    const kept = retireProvisionalReplies(log, new Set(['s2']));
    expect(kept.map((message) => message.id)).toEqual(['streamed', 's2']);
  });

  it('reconciles against the whole log, not just the newest page', () => {
    // The twin arrived on a tick that ran mid-stream, when replies are left
    // alone. Nothing new comes in afterwards, so matching only against a poll's
    // own page would leave the duplicate on screen forever.
    const log = [
      durable('s2', 'assistant', 'Booked it.', '2026-08-18T10:00:00.000Z'),
      provisional('streamed', 'assistant', 'Booked it.', 's2'),
    ];
    expect(retireProvisionalReplies(log, new Set(['s2'])).map((m) => m.id)).toEqual(['s2']);
  });

  it('never drops a message the server has already vouched for', () => {
    const log = [durable('s1', 'assistant', 'kept', '2026-08-18T09:00:00.000Z')];
    expect(retireProvisionalReplies(log, new Set(['s1'])).map((m) => m.id)).toEqual(['s1']);
  });

  it('retires a corrected reply against the replacement it streamed', () => {
    // chat-turn persists the response contract's replacement and streams that
    // same text on the off-course part. Comparing the raw draft instead would
    // leave the unsupported wording on screen beside its correction.
    const streamed = {
      id: 'streamed',
      role: 'assistant',
      metadata: { durableMessageId: 's2' },
      parts: [
        { type: 'text', text: 'I checked your calendar — nothing today.' },
        { type: 'data-off-course', data: { text: "That's everything I could actually see." } },
      ],
    } as unknown as UIMessage;
    const log = [
      streamed,
      durable(
        's2',
        'assistant',
        "That's everything I could actually see.",
        '2026-08-18T10:00:00.000Z',
      ),
    ];
    expect(retireProvisionalReplies(log, new Set(['s2'])).map((m) => m.id)).toEqual(['s2']);
  });
});

describe('date labels', () => {
  // Formatting in the agent's zone is what lets the server render the dividers
  // into the first paint: the browser must reach the same strings whatever its
  // own zone is, or React would report a hydration mismatch.
  const at = new Date('2026-08-18T02:30:00.000Z');
  const now = new Date('2026-08-19T12:00:00.000Z');

  it('answers from the zone it is given, never from the machine clock', () => {
    // Same instant, two zones, two different calendar days — which is exactly
    // why the zone has to be an argument rather than ambient: the server and
    // the browser must be able to reach the same string on purpose.
    expect(dayLabel(at, now, 'America/Los_Angeles')).toBe('Aug 17');
    expect(timeLabel(at, 'America/Los_Angeles')).toBe('7:30 PM');
    expect(dayLabel(at, now, 'Atlantic/Reykjavik')).toBe('Yesterday');
    expect(timeLabel(at, 'Atlantic/Reykjavik')).toBe('2:30 AM');
  });

  it('reads the calendar day in the given zone, not UTC', () => {
    // 02:30Z on the 18th is still the evening of the 17th in Los Angeles.
    const alsoThe17th = new Date('2026-08-18T04:00:00.000Z');
    expect(sameDay(at, alsoThe17th, 'America/Los_Angeles')).toBe(true);
    expect(sameDay(at, alsoThe17th, 'Atlantic/Reykjavik')).toBe(true);
    const the18thInReykjavik = new Date('2026-08-18T09:00:00.000Z');
    expect(sameDay(at, the18thInReykjavik, 'Atlantic/Reykjavik')).toBe(true);
    expect(sameDay(at, the18thInReykjavik, 'America/Los_Angeles')).toBe(false);
  });

  it('names the day in the stamp only when the message is not from today', () => {
    // The common case is a chat you are having now, and a day label on every
    // line of it would be noise — that is the whole reason the dividers went.
    expect(stampLabel(new Date('2026-08-19T20:30:00.000Z'), now, 'Atlantic/Reykjavik')).toBe(
      '8:30 PM',
    );
    expect(stampLabel(at, now, 'Atlantic/Reykjavik')).toBe('Yesterday · 2:30 AM');
    expect(stampLabel(at, now, 'America/Los_Angeles')).toBe('Aug 17 · 7:30 PM');
  });

  it('names an older day, adding the year only when it is not this one', () => {
    expect(dayLabel(new Date('2026-03-04T12:00:00.000Z'), now, 'Atlantic/Reykjavik')).toBe('Mar 4');
    expect(dayLabel(new Date('2025-03-04T12:00:00.000Z'), now, 'Atlantic/Reykjavik')).toBe(
      'Mar 4, 2025',
    );
  });
});
