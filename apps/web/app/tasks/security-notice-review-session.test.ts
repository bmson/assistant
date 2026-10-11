import type { OwnerSecurityReviewItem } from '@assistant/application/security-incidents';
import { describe, expect, it, vi } from 'vitest';
import {
  SecurityReviewSession,
  type SecurityReviewTransport,
} from './security-notice-review-session';

const item: OwnerSecurityReviewItem = {
  incidentId: '4e95ac7f-d623-5c12-9c65-74b492a13e12',
  revision: 3,
  confidence: 'high',
  disposition: 'unreviewed',
  category: 'sign_in',
  importance: 8,
  subject: 'New sign-in',
  fromName: 'Account security',
  observedAt: '2026-10-11T12:00:00.000Z',
  materialChangeReason: null,
  evidence: { evidenceQuote: 'A sign-in was reported.' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function transport(overrides: Partial<SecurityReviewTransport> = {}): SecurityReviewTransport {
  return {
    list: vi.fn(async () => [item]),
    decide: vi.fn(async () => 'saved' as const),
    ...overrides,
  };
}

describe('SecurityReviewSession', () => {
  it('discards a delayed owner response after the owning Activity session is replaced or disposed', async () => {
    const response = deferred<OwnerSecurityReviewItem[]>();
    const service = transport({ list: vi.fn(() => response.promise) });
    const oldOwner = new SecurityReviewSession('owner-old', service);
    oldOwner.start();
    oldOwner.dispose();
    const newOwner = new SecurityReviewSession('owner-new', transport());
    newOwner.start();
    response.resolve([item]);
    await Promise.resolve();

    expect(oldOwner.getSnapshot().items).toEqual([]);
    expect(oldOwner.getSnapshot().loadState).toBe('loading');
    expect(newOwner.getSnapshot().items).toEqual([item]);
  });

  it('does not fetch again for unrelated Activity refreshes unless explicitly requested', async () => {
    const service = transport();
    const session = new SecurityReviewSession('owner-one', service);
    session.start();
    session.start();
    await Promise.resolve();
    expect(service.list).toHaveBeenCalledTimes(1);

    // An RSC refresh preserves this keyed client session and its effect does
    // not restart; only the explicit Refresh control calls refresh again.
    await session.refresh();
    expect(service.list).toHaveBeenCalledTimes(2);
    session.dispose();
    session.start();
    await Promise.resolve();
    expect(service.list).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['stale', 'This review changed. The latest version is now loaded.'],
    [
      'uncertain',
      'The decision response was unclear. The current review list has been reloaded; check its state before trying again.',
    ],
  ] as const)(
    'reconciles a %s response with exactly one GET and never repeats the POST',
    async (result, expectedMessage) => {
      const service = transport({ decide: vi.fn(async () => result) });
      const session = new SecurityReviewSession('owner-one', service);
      session.start();
      await Promise.resolve();
      await session.decide(item, 'dismissed');

      expect(service.decide).toHaveBeenCalledTimes(1);
      expect(service.list).toHaveBeenCalledTimes(2);
      expect(session.getSnapshot().message).toBe(expectedMessage);
    },
  );

  it('retains a confirmed decision receipt and labels rows stale when its follow-up GET fails', async () => {
    const service = transport({
      list: vi.fn().mockResolvedValueOnce([item]).mockRejectedValueOnce(new Error('offline')),
    });
    const session = new SecurityReviewSession('owner-one', service);
    session.start();
    await Promise.resolve();
    await session.decide(item, 'expected');

    expect(session.getSnapshot().items).toEqual([item]);
    expect(session.getSnapshot().message).toContain('Decision saved.');
    expect(session.getSnapshot().staleList).toBe(true);
    expect(service.decide).toHaveBeenCalledTimes(1);
  });

  it('does not confirm a stale reconciliation until the follow-up GET settles', async () => {
    const reconciliation = deferred<OwnerSecurityReviewItem[]>();
    const service = transport({
      list: vi.fn().mockResolvedValueOnce([item]).mockReturnValueOnce(reconciliation.promise),
      decide: vi.fn(async () => 'stale' as const),
    });
    const session = new SecurityReviewSession('owner-one', service);
    session.start();
    await Promise.resolve();
    const decision = session.decide(item, 'dismissed');
    await Promise.resolve();
    await Promise.resolve();

    expect(session.getSnapshot().message).toBe('Checking the latest review…');
    reconciliation.resolve([item]);
    await decision;
    expect(session.getSnapshot().message).toBe(
      'This review changed. The latest version is now loaded.',
    );
  });

  it('allows a new decision after disposal while ignoring the old held POST response', async () => {
    const oldPost = deferred<'saved'>();
    const service = transport({
      decide: vi.fn().mockReturnValueOnce(oldPost.promise).mockResolvedValueOnce('saved'),
    });
    const session = new SecurityReviewSession('owner-one', service);
    session.start();
    await Promise.resolve();
    const oldDecision = session.decide(item, 'expected');
    session.dispose();
    expect(session.getSnapshot().pendingId).toBeNull();
    session.start();
    await Promise.resolve();

    await session.decide(item, 'dismissed');
    expect(service.decide).toHaveBeenCalledTimes(2);
    oldPost.resolve('saved');
    await oldDecision;
    expect(session.getSnapshot().message).toBe('Decision saved.');
    expect(session.getSnapshot().pendingId).toBeNull();
  });

  it('does not claim an empty ready list is current after a failed refresh', async () => {
    const service = transport({
      list: vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('offline')),
    });
    const session = new SecurityReviewSession('owner-one', service);
    session.start();
    await Promise.resolve();
    await session.refresh();
    expect(session.getSnapshot().loadState).toBe('ready');
    expect(session.getSnapshot().items).toEqual([]);
    expect(session.getSnapshot().staleList).toBe(true);
  });

  it('locks a second activation synchronously while the first decision is pending', async () => {
    const response = deferred<'saved'>();
    const service = transport({ decide: vi.fn(() => response.promise) });
    const session = new SecurityReviewSession('owner-one', service);
    session.start();
    await Promise.resolve();
    const first = session.decide(item, 'expected');
    const second = session.decide(item, 'dismissed');
    expect(service.decide).toHaveBeenCalledTimes(1);
    response.resolve('saved');
    await Promise.all([first, second]);
  });
});
