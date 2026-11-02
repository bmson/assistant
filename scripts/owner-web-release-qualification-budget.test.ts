import { afterEach, describe, expect, it, vi } from 'vitest';
import { qualificationBudget } from './owner-web-release-qualification-budget.js';

const r = { kind: 'github' as const, url: 'https://example.invalid/', method: 'GET' as const };
const json = () => new Response('{}', { headers: { 'content-type': 'application/json' } });
afterEach(() => vi.useRealTimers());
describe('offline shared qualification transport', () => {
  it('counts all kinds in one twenty-request budget with no retry', async () => {
    const request = vi.fn<typeof fetch>(async () => json());
    const b = qualificationBudget(request, { now: () => 0, monotonic: () => 0 }, () => true);
    for (let i = 0; i < 20; i++) await b.json({ ...r, kind: i % 2 ? 'oidc' : 'github' });
    await expect(b.json(r)).rejects.toThrow('budget');
    expect(request).toHaveBeenCalledTimes(20);
    expect(b.summary()).toMatchObject({ requests: 20, counts: { oidc: 10, github: 10 } });
  });
  it('caps native reads at three inside the shared budget', async () => {
    const request = vi.fn<typeof fetch>(async () => json());
    const b = qualificationBudget(request, { now: () => 0, monotonic: () => 0 }, () => true);
    for (let i = 0; i < 3; i++) await b.json({ ...r, kind: 'native' });
    await expect(b.json({ ...r, kind: 'native' })).rejects.toThrow('budget');
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('refuses an unapproved destination or verb before any request', async () => {
    const request = vi.fn<typeof fetch>();
    const b = qualificationBudget(request, { now: () => 0, monotonic: () => 0 }, () => false);
    await expect(b.json({ ...r, method: 'POST' })).rejects.toThrow('context');
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['headers', 'stream', 'cancellation'])(
    'bounds stalled %s including abort-ignoring transports',
    async (kind) => {
      vi.useFakeTimers();
      const request = vi.fn<typeof fetch>(async () =>
        kind === 'headers'
          ? new Promise<Response>(() => {})
          : new Response(
              new ReadableStream({
                start(c) {
                  if (kind === 'cancellation') c.enqueue(new TextEncoder().encode('PRIVATE'));
                },
                cancel() {
                  return new Promise(() => {});
                },
              }),
            ),
      );
      const b = qualificationBudget(request, { now: () => 0, monotonic: () => 0 }, () => true);
      const result = expect(b.bytes(r, kind === 'cancellation' ? 1 : 100)).rejects.toThrow(
        'budget',
      );
      await vi.advanceTimersByTimeAsync(15000);
      await result;
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it('uses the remaining whole-probe deadline and rejects clock rollback', async () => {
    vi.useFakeTimers();
    let at = 0;
    const request = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}));
    const b = qualificationBudget(request, { now: () => 0, monotonic: () => at }, () => true);
    at = 119999;
    const result = expect(b.json(r)).rejects.toThrow('budget');
    await vi.advanceTimersByTimeAsync(1);
    await result;
    at = 119998;
    expect(() => b.assertWithin()).toThrow('budget');
    at = 120000;
    expect(() => b.assertWithin()).toThrow('budget');
  });
  it.each([
    () => new Response('PRIVATE', { status: 403 }),
    () => new Response('{}'),
    () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    () => new Response('PRIVATE', { headers: { 'content-type': 'application/json' } }),
  ])('redacts transport/format errors and never retries', async (response) => {
    const request = vi.fn<typeof fetch>(async () => response());
    const b = qualificationBudget(request, { now: () => 0, monotonic: () => 0 }, () => true);
    await expect(b.json(r)).rejects.toThrow('Read-only qualification held: transport');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]?.redirect).toBe('error');
  });
  it('treats only an explicitly requested 302 as a manual artifact redirect', async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://example.invalid/PRIVATE' },
        }),
    );
    const b = qualificationBudget(request, { now: () => 0, monotonic: () => 0 }, () => true);
    await b.bytes({ ...r, manualRedirect: true }, 1);
    expect(request.mock.calls[0]?.[1]?.redirect).toBe('manual');
    await expect(b.bytes(r, 1)).rejects.toThrow('transport');
  });
});
