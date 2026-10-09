import { beforeEach, describe, expect, it, vi } from 'vitest';

const { decide, list, repository, authed } = vi.hoisted(() => ({
  decide: vi.fn(),
  list: vi.fn(),
  repository: {},
  authed: vi.fn(),
}));

vi.mock('@assistant/application/email-obligations', () => ({
  decideOwnerEmailObligation: decide,
  listOwnerEmailObligations: list,
}));
vi.mock('@/lib/server', () => ({ getEmailObligationRepository: () => repository }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: authed,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { GET, POST } from './route';

describe('mobile email obligation controls', () => {
  beforeEach(() => {
    authed.mockReset().mockResolvedValue(true);
    decide.mockReset();
    list.mockReset().mockResolvedValue([]);
  });

  it('lists current owner decisions', async () => {
    list.mockResolvedValue([{ channelMessageId: 'gmail:current', obligationStatus: 'unknown' }]);
    const response = await GET(new Request('https://example.test/api/mobile/v1/email-obligations'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      obligations: [{ channelMessageId: 'gmail:current' }],
    });
  });

  it('requires owner confirmation and reports a stale source without claiming success', async () => {
    decide.mockResolvedValue(false);
    const response = await POST(
      new Request('https://example.test/api/mobile/v1/email-obligations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channelMessageId: 'gmail:old',
          expectedVersion: 0,
          decision: 'resolve',
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('stale') });
    expect(decide).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({
        channelMessageId: 'gmail:old',
        expectedVersion: 0,
        decision: 'resolve',
      }),
    );
  });
});
