import { describe, expect, it, vi } from 'vitest';
import type { GoogleClient } from './client.js';
import { gmailThreadHeadReader } from './thread-head.js';

const message = (id: string, time: string, labels = ['INBOX']) => ({
  id,
  threadId: 'thread1',
  internalDate: time,
  labelIds: labels,
});
function fixture(body: unknown, configured = true) {
  const api = vi.fn(async () => body);
  const client = { configured: () => configured, api } as unknown as GoogleClient;
  return { read: gmailThreadHeadReader(client), api };
}
const input = () => ({ threadId: 'thread1', signal: new AbortController().signal });

describe('bounded Gmail thread head', () => {
  it('reads only metadata and includes a newer sent reply in the authoritative ordering', async () => {
    const f = fixture({
      id: 'thread1',
      messages: [message('a', '1000'), message('b', '2000', ['SENT'])],
    });
    expect(await f.read(input())).toEqual({
      threadId: 'thread1',
      latestMessageId: 'b',
      latestReceivedAt: new Date(2000),
    });
    const [url, init] = f.api.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get('format')).toBe('metadata');
    expect(new URL(url).searchParams.get('fields')).toBe(
      'id,messages(id,threadId,internalDate,labelIds)',
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([
    { id: 'foreign', messages: [message('a', '1000')] },
    { id: 'thread1', messages: [] },
    { id: 'thread1', messages: Array.from({ length: 201 }, () => message('a', '1000')) },
    { id: 'thread1', messages: [message('a', 'invalid')] },
    { id: 'thread1', messages: [{ ...message('a', '1000'), threadId: 'foreign' }] },
    { id: 'thread1', messages: [message('a', '1000', ['TRASH'])] },
    { id: 'thread1', messages: [message('a', '1000', ['SPAM'])] },
    { id: 'thread1', messages: [message('a', '1000'), message('b', '1000')] },
  ])('holds incomplete, foreign, oversized or removed threads: %#', async (body) => {
    expect(await fixture(body).read(input())).toBeNull();
  });
  it('does not read when credentials are unavailable or the identifier is invalid', async () => {
    const f = fixture({}, false);
    expect(await f.read(input())).toBeNull();
    expect(f.api).not.toHaveBeenCalled();
    const configured = fixture({});
    expect(await configured.read({ ...input(), threadId: '../other' })).toBeNull();
    expect(configured.api).not.toHaveBeenCalled();
  });
});
