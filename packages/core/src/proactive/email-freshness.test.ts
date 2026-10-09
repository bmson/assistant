import type { PulseMail } from '@assistant/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshPulseMail } from './pulse.js';

const row: PulseMail = {
  channelMessageId: 'gmail:one',
  providerMessageId: 'one',
  providerThreadId: 'thread1',
  obligationVersion: 2,
  fromEmail: 'sender@example.test',
  fromName: null,
  subject: 'A request',
  category: 'personal',
  importance: 5,
};
const head = { threadId: 'thread1', latestMessageId: 'one', latestReceivedAt: new Date(1000) };
afterEach(() => vi.useRealTimers());
describe('pulse email freshness', () => {
  it('keeps only a candidate matching the current provider thread head', async () => {
    expect(await refreshPulseMail([row], async () => head)).toEqual([row]);
    expect(
      await refreshPulseMail([row], async () => ({ ...head, latestMessageId: 'reply' })),
    ).toEqual([]);
    expect(await refreshPulseMail([row], async () => ({ ...head, threadId: 'foreign' }))).toEqual(
      [],
    );
  });
  it('holds absent provider identity, missing readers and failed reads', async () => {
    const read = vi.fn(async () => head);
    expect(await refreshPulseMail([{ ...row, providerThreadId: null }], read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(await refreshPulseMail([row])).toEqual([]);
    expect(
      await refreshPulseMail([row], async () => {
        throw new Error('unavailable');
      }),
    ).toEqual([]);
  });
  it('bounds an uncooperative reader and aborts it without holding unrelated work forever', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = refreshPulseMail([row], async (input) => {
      signal = input.signal;
      return new Promise(() => {});
    });
    await vi.advanceTimersByTimeAsync(3001);
    expect(await result).toEqual([]);
    expect(signal?.aborted).toBe(true);
  });
  it('reads at most five candidates and rejects invalid or future timestamps', async () => {
    const read = vi.fn(async () => head);
    expect(
      await refreshPulseMail(
        Array.from({ length: 8 }, () => row),
        read,
      ),
    ).toHaveLength(5);
    expect(read).toHaveBeenCalledTimes(5);
    expect(
      await refreshPulseMail([row], async () => ({ ...head, latestReceivedAt: new Date(NaN) })),
    ).toEqual([]);
    expect(
      await refreshPulseMail([row], async () => ({
        ...head,
        latestReceivedAt: new Date(Date.now() + 120000),
      })),
    ).toEqual([]);
  });
});
