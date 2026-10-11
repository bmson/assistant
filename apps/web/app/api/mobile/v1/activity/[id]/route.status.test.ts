import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  auth: vi.fn(),
  status: vi.fn(),
}));

vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: stubs.auth,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/task-activity', () => ({ getTaskActivityStatus: stubs.status }));

import { GET } from './route.js';

const id = '11000000-0000-0000-0000-000000000001';
const request = new Request(`http://localhost/api/mobile/v1/activity/${id}`);
const context = (value: string) => ({ params: Promise.resolve({ id: value }) });

describe('mobile Activity status route', () => {
  beforeEach(() => {
    stubs.auth.mockReset().mockResolvedValue(true);
    stubs.status.mockReset();
  });

  it('requires mobile authentication and validates the task identity', async () => {
    stubs.auth.mockResolvedValueOnce(false);
    expect((await GET(request, context(id))).status).toBe(401);
    expect(stubs.status).not.toHaveBeenCalled();
    expect((await GET(request, context('not-a-uuid'))).status).toBe(400);
    expect(stubs.status).not.toHaveBeenCalled();
  });

  it('returns the compact volatile projection or a non-enumerating 404', async () => {
    const projection = {
      id,
      status: 'running',
      progress: 'Working',
      spentUsd: '0.01',
      budgetUsdLimit: '0.50',
      updatedAt: '2026-10-11T12:00:00.000Z',
      archivedAt: null,
      hasPendingApproval: false,
      hasActiveAutonomy: false,
      stuckWaiting: false,
    };
    stubs.status.mockResolvedValueOnce(projection);
    const response = await GET(request, context(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(projection);
    expect(stubs.status).toHaveBeenCalledWith(id);

    stubs.status.mockResolvedValueOnce(null);
    expect((await GET(request, context(id))).status).toBe(404);
  });
});
