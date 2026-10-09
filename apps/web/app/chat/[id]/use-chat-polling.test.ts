import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { mergeChatLog, nextPollDelayMs, unresolvedDecisionIds } from './use-chat-polling';

const NOT_STREAMING = { streaming: false, retracted: new Set<string>() };

it('refreshes saved cards in place and prioritizes an explicitly refreshed old card beyond the cap', () => {
  const log = Array.from(
    { length: 14 },
    (_, index) =>
      ({
        id: `message-${index}`,
        role: 'assistant',
        parts: [
          {
            type: 'data-card',
            data: {
              kind: 'generated-card',
              id: `card-${index}`,
              spec: { refreshable: true },
              refreshState: 'idle',
            },
          },
        ],
      }) as unknown as UIMessage,
  );
  expect(unresolvedDecisionIds(log)).toHaveLength(10);
  expect(unresolvedDecisionIds(log)).not.toContain('message-0');
  const requested = unresolvedDecisionIds(log, new Set(['card-0']));
  expect(requested).toContain('message-0');
  expect(requested).toHaveLength(10);
  expect(new Set(requested).size).toBe(10);
  expect(
    unresolvedDecisionIds([
      {
        id: 'plain',
        role: 'assistant',
        parts: [
          {
            type: 'data-card',
            data: { kind: 'generated-card', spec: { refreshable: false }, refreshState: 'idle' },
          },
        ],
      } as unknown as UIMessage,
    ]),
  ).toEqual([]);
});

/** A message as the server sends it: real id, persisted timestamp. */
function durable(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  at = '2026-08-18T10:00:00.000Z',
): UIMessage {
  return { id, role, parts: [{ type: 'text', text }], metadata: { createdAt: at } } as UIMessage;
}

/** An unanswered approval card — the thing `refresh` re-reads on every tick. */
function card(id: string, status: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'approval', approvalId: 'a1', status }],
    metadata: { createdAt: '2026-08-18T10:00:00.000Z' },
  } as unknown as UIMessage;
}

describe('mergeChatLog', () => {
  it('adds rows the log has not seen', () => {
    const current = [durable('a', 'user', 'hello')];
    const merged = mergeChatLog(current, [durable('b', 'assistant', 'hi')], {
      ...NOT_STREAMING,
      serverIds: new Set(['a', 'b']),
    });
    expect(merged.map((message) => message.id)).toEqual(['a', 'b']);
  });

  it('normalizes same-id SDK snapshots across a polling interleave, then retires the stream twin', () => {
    const channelMessageId = 'chat-reply:task-1';
    const firstStreamSnapshot = {
      ...durable('qgz-stream', 'assistant', 'The reply is starting.'),
      metadata: { channelMessageId },
    } as UIMessage;
    const persistedReply = {
      ...durable('persisted-reply', 'assistant', 'This local chat is working.'),
      metadata: { channelMessageId },
    } as UIMessage;
    const latestStreamSnapshot = {
      ...durable('qgz-stream', 'assistant', 'This local chat is working.'),
      metadata: { channelMessageId },
    } as UIMessage;
    const user = durable('owner-turn', 'user', 'Hello');
    const current = [user, firstStreamSnapshot, persistedReply, latestStreamSnapshot];
    const serverIds = new Set(['owner-turn', 'persisted-reply']);

    const duringStream = mergeChatLog(current, [], {
      streaming: true,
      serverIds,
      retracted: new Set(),
    });
    expect(duringStream.map((message) => message.id)).toEqual([
      'owner-turn',
      'persisted-reply',
      'qgz-stream',
    ]);
    expect(duringStream.filter((message) => message.id === 'qgz-stream')).toHaveLength(1);
    expect(duringStream.at(-1)?.parts).toEqual([
      { type: 'text', text: 'This local chat is working.' },
    ]);

    const afterStream = mergeChatLog(duringStream, [], {
      streaming: false,
      serverIds,
      retracted: new Set(),
    });
    expect(afterStream.map((message) => message.id)).toEqual(['owner-turn', 'persisted-reply']);
    expect(afterStream.filter((message) => message.role === 'assistant')).toHaveLength(1);
  });

  it('replaces a row whose content actually changed', () => {
    const current = [card('c1', 'pending')];
    const merged = mergeChatLog(current, [card('c1', 'approved')], {
      ...NOT_STREAMING,
      serverIds: new Set(['c1']),
    });
    expect(merged).not.toBe(current);
    const parts = merged[0]?.parts as Array<{ status?: string }> | undefined;
    expect(parts?.[0]?.status).toBe('approved');
  });

  // The finding this function exists for: `refresh` re-reads every open
  // decision card on EVERY tick, so an idle thread with one unanswered
  // approval was handing React a new array every twelve seconds.
  it('hands back the same array when a re-read changed nothing', () => {
    const current = [durable('a', 'user', 'hello'), card('c1', 'pending')];
    const merged = mergeChatLog(current, [card('c1', 'pending')], {
      ...NOT_STREAMING,
      serverIds: new Set(['a', 'c1']),
    });
    expect(merged).toBe(current);
  });

  it('still retires a provisional turn on a tick that brought nothing new', () => {
    const provisional = {
      id: 'local',
      role: 'user',
      metadata: { durableMessageId: 's1' },
      parts: [{ type: 'text', text: 'go' }],
    } as UIMessage;
    const current = [durable('s1', 'user', 'go'), provisional];
    const merged = mergeChatLog(current, [], {
      ...NOT_STREAMING,
      serverIds: new Set(['s1']),
    });
    expect(merged.map((message) => message.id)).toEqual(['s1']);
  });

  it('removes a row the server superseded', () => {
    const current = [
      durable('old', 'assistant', 'stopped'),
      durable('new', 'assistant', 'stopped'),
    ];
    const merged = mergeChatLog(current, [], {
      streaming: false,
      serverIds: new Set(['old', 'new']),
      retracted: new Set(['old']),
    });
    expect(merged.map((message) => message.id)).toEqual(['new']);
  });

  it('leaves a streaming reply alone until it finishes', () => {
    const streamed = {
      id: 'stream-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'partial' }],
    } as UIMessage;
    const current = [streamed];
    const merged = mergeChatLog(current, [durable('s1', 'assistant', 'partial')], {
      streaming: true,
      serverIds: new Set(['s1']),
      retracted: new Set<string>(),
    });
    expect(merged.map((message) => message.id)).toEqual(['stream-1', 's1']);
  });
});

describe('nextPollDelayMs', () => {
  it('asks again immediately when the server held the connection', () => {
    // The hold was the wait. Sleeping again here is exactly the dead time
    // between a reply being written and the client noticing.
    expect(nextPollDelayMs({ elapsedMs: 20_000, carriedNews: false, turnActive: true })).toBe(0);
    expect(nextPollDelayMs({ elapsedMs: 20_000, carriedNews: false, turnActive: false })).toBe(0);
  });

  it('falls back to the timed cadence when the server answered at once', () => {
    // A deployment that predates `wait` answers instantly and reports nothing.
    // Without this the loop would spin as fast as the network allows.
    expect(nextPollDelayMs({ elapsedMs: 30, carriedNews: false, turnActive: true })).toBe(2_500);
    expect(nextPollDelayMs({ elapsedMs: 30, carriedNews: false, turnActive: false })).toBe(12_000);
  });

  it('comes back promptly after news, but never in a tight loop', () => {
    expect(nextPollDelayMs({ elapsedMs: 30, carriedNews: true, turnActive: true })).toBe(250);
  });
});
