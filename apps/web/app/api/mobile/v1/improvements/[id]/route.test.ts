import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ auth: vi.fn(), requestFix: vi.fn(), decide: vi.fn() }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mock.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/proposal-code-fix', async (original) => ({
  ...(await original<typeof import('@/lib/proposal-code-fix')>()),
  requestOwnerProposalCodeFix: mock.requestFix,
}));
vi.mock('@/lib/workspace-reviews', () => ({ decideOwnerImprovement: mock.decide }));

import { POST } from './route';

const id = '00000000-0000-4000-a000-000000000001';
const request = (action: string) =>
  POST(
    new Request(`http://localhost/api/mobile/v1/improvements/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id }) },
  );
beforeEach(() => {
  vi.clearAllMocks();
  mock.auth.mockResolvedValue(true);
  mock.requestFix.mockResolvedValue({ id: 'repair', status: 'reported' });
  mock.decide.mockResolvedValue({
    outcome: 'acknowledged',
    enacted: false,
    detail: 'Suggestion noted. No settings or code were changed.',
  });
});
it('requires owner mobile authentication before conversion', async () => {
  mock.auth.mockResolvedValue(false);
  expect((await request('request_fix')).status).toBe(401);
  expect(mock.requestFix).not.toHaveBeenCalled();
});
it('routes conversion through the shared owned-proposal service and returns the report ID', async () => {
  const response = await request('request_fix');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    repairIssueId: 'repair',
    repairStatus: 'reported',
    outcome: 'code_fix_requested',
    enacted: false,
    detail: 'Code-fix report queued for investigation. No code has changed.',
  });
  expect(mock.requestFix).toHaveBeenCalledWith(id);
  expect(mock.decide).not.toHaveBeenCalled();
});

it('does not claim a repeated code-fix conversion queued a new attempt for a settled report', async () => {
  mock.requestFix.mockResolvedValueOnce({ id: 'repair', status: 'resolved' });
  const response = await request('request_fix');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.repairStatus).toBe('resolved');
  expect(body.detail).toContain('No new coding run was requested');
  expect(body.detail).not.toContain('queued');
});
it('rejects unknown actions and reports conversion conflicts', async () => {
  expect((await request('unknown')).status).toBe(400);
  mock.requestFix.mockRejectedValueOnce(new Error('Open proposal not found'));
  expect((await request('request_fix')).status).toBe(409);
});

it.each([
  ['acknowledged', false],
  ['applied', true],
  ['already_current', false],
  ['already_decided', false],
])(
  'preserves the actual %s decision instead of treating every success as applied',
  async (outcome, enacted) => {
    mock.decide.mockResolvedValueOnce({ outcome, enacted, detail: 'Authoritative receipt' });
    const response = await request('apply');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      outcome,
      enacted,
      detail: 'Authoritative receipt',
    });
  },
);

it('returns an actionable conflict for a refused routing proposal', async () => {
  mock.decide.mockRejectedValueOnce(new Error('Proposed model is not enabled with prices'));
  const response = await request('apply');
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'Proposed model is not enabled with prices' });
});
