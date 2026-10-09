import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  list: vi.fn(),
  listClosed: vi.fn(),
  resolve: vi.fn(),
  snooze: vi.fn(),
  dismiss: vi.fn(),
  correct: vi.fn(),
  reopen: vi.fn(),
}));
vi.mock('@/lib/server', () => ({
  getApplication: () => ({
    listCommitments: mocks.list,
    listClosedCommitments: mocks.listClosed,
    resolveCommitment: mocks.resolve,
    snoozeCommitment: mocks.snooze,
    dismissCommitment: mocks.dismiss,
    correctCommitment: mocks.correct,
    reopenCommitment: mocks.reopen,
  }),
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { GET, POST } from './route';

const url = 'https://example.com/api/mobile/v1/memory/commitments';
const post = (body: unknown) =>
  POST(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(true);
  mocks.list.mockResolvedValue([]);
  mocks.listClosed.mockResolvedValue([]);
  // Each mutation reports whether it actually changed a row.
  mocks.resolve.mockResolvedValue(true);
  mocks.snooze.mockResolvedValue(true);
  mocks.dismiss.mockResolvedValue(true);
  mocks.correct.mockResolvedValue(true);
  mocks.reopen.mockResolvedValue({ commitmentId: 'new-id', replay: false });
});

describe('native open loops', () => {
  it('requires authentication to read or change anything', async () => {
    mocks.auth.mockResolvedValue(false);
    expect((await GET(new Request(url))).status).toBe(401);
    expect((await post({ action: 'dismiss', id: 'c1' })).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });

  /** Every other date in this API is a string; a Date would serialize inconsistently. */
  it('sends dueAt as a string and keeps a missing one null', async () => {
    mocks.list.mockResolvedValue([
      {
        id: 'c1',
        kind: 'promise',
        title: 'Send the deck',
        details: '',
        nextAction: '',
        dueAt: new Date('2026-03-14T09:00:00Z'),
        status: 'open',
      },
      {
        id: 'c2',
        kind: 'promise',
        title: 'Call back',
        details: '',
        nextAction: '',
        dueAt: null,
        status: 'open',
      },
    ]);
    const body = (await (await GET(new Request(url))).json()) as {
      commitments: Array<{ id: string; dueAt: string | null }>;
    };
    expect(body.commitments[0]?.dueAt).toBe('2026-03-14T09:00:00.000Z');
    expect(body.commitments[1]?.dueAt).toBeNull();
  });

  it('resolves, dismisses and snoozes the named loop', async () => {
    expect((await post({ action: 'resolve', id: 'c1' })).status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith('c1', expect.any(String));
    expect((await post({ action: 'dismiss', id: 'c2' })).status).toBe(200);
    expect(mocks.dismiss).toHaveBeenCalledWith('c2');
    expect((await post({ action: 'snooze', id: 'c3' })).status).toBe(200);
    expect(mocks.snooze).toHaveBeenCalledWith('c3', expect.any(Date));
  });

  it('snoozes a day out, matching the web hub', async () => {
    const before = Date.now();
    await post({ action: 'snooze', id: 'c1' });
    const until = mocks.snooze.mock.calls[0]?.[1] as Date;
    expect(until.getTime() - before).toBeGreaterThanOrEqual(24 * 3600 * 1000 - 1000);
    expect(until.getTime() - before).toBeLessThanOrEqual(24 * 3600 * 1000 + 5000);
  });

  it('refuses a correction that would blank the loop title', async () => {
    const response = await post({ action: 'correct', id: 'c1', title: '   ', details: 'x' });
    expect(response.status).toBe(400);
    expect(mocks.correct).not.toHaveBeenCalled();
  });

  it('applies a correction with its details and next action', async () => {
    expect(
      (
        await post({
          action: 'correct',
          id: 'c1',
          title: 'Send the deck',
          details: 'By Friday',
          nextAction: 'Email it',
        })
      ).status,
    ).toBe(200);
    expect(mocks.correct).toHaveBeenCalledWith('c1', {
      title: 'Send the deck',
      details: 'By Friday',
      nextAction: 'Email it',
    });
  });

  it('needs an id, and names the actions it accepts', async () => {
    expect((await post({ action: 'resolve' })).status).toBe(400);
    const unknown = await post({ action: 'bogus', id: 'c1' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain('snooze');
  });

  it('reopens only with a fresh timestamp and UUID idempotency key', async () => {
    const operationId = '2c4a4e77-5887-4c5f-9a7d-839b6ee0844e';
    const expectedUpdatedAt = '2026-10-07T12:00:00.000Z';
    const response = await post({
      action: 'reopen',
      id: 'closed-id',
      expectedUpdatedAt,
      operationId,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, commitmentId: 'new-id', replay: false });
    expect(mocks.reopen).toHaveBeenCalledWith(
      'closed-id',
      new Date(expectedUpdatedAt),
      operationId,
    );
    expect(
      (await post({ action: 'reopen', id: 'closed-id', expectedUpdatedAt, operationId: 'bad' }))
        .status,
    ).toBe(400);
    mocks.reopen.mockResolvedValue(null);
    expect(
      (await post({ action: 'reopen', id: 'closed-id', expectedUpdatedAt, operationId })).status,
    ).toBe(409);
  });

  /**
   * These report "nothing matched" by returning false rather than throwing: the
   * loop was closed elsewhere, or the id is stale. Reporting that as success
   * told a phone editor its correction had saved when no row had changed.
   */
  it('reports a conflict when the loop is no longer open', async () => {
    mocks.correct.mockResolvedValue(false);
    const response = await post({ action: 'correct', id: 'c1', title: 'Send the deck' });
    expect(response.status).toBe(409);
    expect(mocks.correct).toHaveBeenCalledOnce();

    mocks.resolve.mockResolvedValue(false);
    expect((await post({ action: 'resolve', id: 'c1' })).status).toBe(409);
    mocks.snooze.mockResolvedValue(false);
    expect((await post({ action: 'snooze', id: 'c1' })).status).toBe(409);
    mocks.dismiss.mockResolvedValue(false);
    expect((await post({ action: 'dismiss', id: 'c1' })).status).toBe(409);
  });

  it('reports a failure from the application layer instead of throwing', async () => {
    mocks.dismiss.mockRejectedValue(new Error('Loop already closed.'));
    const response = await post({ action: 'dismiss', id: 'c1' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('Loop already closed.');
  });
});
