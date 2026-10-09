import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  decide: vi.fn(),
  snooze: vi.fn(),
  db: { marker: 'db' },
}));
vi.mock('@assistant/application/suggestions', () => ({
  decideSuggestion: mocks.decide,
  snoozeSuggestionUntil: mocks.snooze,
}));
vi.mock('@/lib/server', () => ({
  getDb: () => mocks.db,
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { POST } from './route';

const SUGGESTION_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';

const post = (id: string, body: unknown) =>
  POST(
    new Request(`https://example.com/api/mobile/v1/suggestions/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(true);
  mocks.decide.mockResolvedValue({ ok: true });
  mocks.snooze.mockResolvedValue({ ok: true });
});

describe('native suggestion answers', () => {
  it('requires authentication before touching anything', async () => {
    mocks.auth.mockResolvedValue(false);
    const response = await post(SUGGESTION_ID, { decision: 'accepted' });
    expect(response.status).toBe(401);
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.snooze).not.toHaveBeenCalled();
  });

  it('rejects a malformed suggestion id', async () => {
    const response = await post('not-a-uuid', { decision: 'accepted' });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('invalid suggestion id');
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown decision', { decision: 'approved' }],
    ['a missing decision', {}],
    ['a body that is not JSON', 'not json'],
  ])('rejects %s', async (_label, body) => {
    const response = await post(SUGGESTION_ID, body);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe(
      typeof body === 'string'
        ? 'Request body must be valid JSON.'
        : 'decision must be accepted, dismissed, or snoozed',
    );
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.snooze).not.toHaveBeenCalled();
  });

  it('accepts, and names the task the acceptance created', async () => {
    mocks.decide.mockResolvedValue({ ok: true, taskId: TASK_ID });
    const response = await post(SUGGESTION_ID, { decision: 'accepted' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, taskId: TASK_ID });
    expect(mocks.decide).toHaveBeenCalledWith(mocks.db, SUGGESTION_ID, 'accepted');
    expect(mocks.snooze).not.toHaveBeenCalled();
  });

  it('dismisses without inventing a task id', async () => {
    const response = await post(SUGGESTION_ID, { decision: 'dismissed' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.decide).toHaveBeenCalledWith(mocks.db, SUGGESTION_ID, 'dismissed');
    expect(mocks.snooze).not.toHaveBeenCalled();
  });

  /** "Later" on the web: the core default of this time tomorrow, not a phone-chosen time. */
  it('snoozes through the same use case as the web "Later"', async () => {
    const snoozedUntil = '2026-09-20T12:00:00.000Z';
    mocks.snooze.mockResolvedValue({ ok: true, snoozedUntil });
    const response = await post(SUGGESTION_ID, { decision: 'snoozed' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, snoozedUntil });
    expect(mocks.snooze).toHaveBeenCalledWith(mocks.db, SUGGESTION_ID);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it.each([
    ['accepted', 'This suggestion has expired.'],
    ['dismissed', 'This suggestion is no longer open.'],
  ])('reports 409 with the core reason when %s is refused', async (decision, reason) => {
    mocks.decide.mockResolvedValue({ ok: false, reason });
    const response = await post(SUGGESTION_ID, { decision });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe(reason);
  });

  it('reports 409 with the core reason when a snooze is refused', async () => {
    mocks.snooze.mockResolvedValue({ ok: false, reason: 'This suggestion is no longer open.' });
    const response = await post(SUGGESTION_ID, { decision: 'snoozed' });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('This suggestion is no longer open.');
  });
});
