import { beforeEach, expect, it, vi } from 'vitest';
import {
  applyProposalAction,
  dismissProposalAction,
  requestProposalCodeFixAction,
} from './actions';

const mock = vi.hoisted(() => ({
  owner: vi.fn(),
  decide: vi.fn(),
  requestFix: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock('@/auth', () => ({ requireOwner: mock.owner }));
vi.mock('next/cache', () => ({ revalidatePath: mock.revalidate }));
vi.mock('@/lib/workspace-reviews', () => ({ decideOwnerImprovement: mock.decide }));
vi.mock('@/lib/proposal-code-fix', async (original) => ({
  ...(await original<typeof import('@/lib/proposal-code-fix')>()),
  requestOwnerProposalCodeFix: mock.requestFix,
}));

const id = '00000000-0000-4000-a000-000000000001';
beforeEach(() => {
  vi.clearAllMocks();
  mock.owner.mockResolvedValue(undefined);
  mock.decide.mockResolvedValue({
    outcome: 'acknowledged',
    enacted: false,
    detail: 'Suggestion noted.',
  });
  mock.requestFix.mockResolvedValue({ id: 'repair', status: 'reported' });
});

it('returns actual review outcomes through authenticated web actions', async () => {
  expect(await applyProposalAction(id)).toEqual({
    outcome: 'acknowledged',
    enacted: false,
    detail: 'Suggestion noted.',
  });
  mock.decide.mockResolvedValueOnce({
    outcome: 'already_decided',
    enacted: false,
    detail: 'Already reviewed.',
  });
  expect(await dismissProposalAction(id)).toMatchObject({
    outcome: 'already_decided',
    enacted: false,
  });
  expect(mock.decide.mock.calls).toEqual([
    [id, 'apply'],
    [id, 'dismiss'],
  ]);
});

it('propagates failed validation and leaves the open card available for recovery', async () => {
  mock.decide.mockRejectedValueOnce(new Error('Model is not enabled with prices'));
  await expect(applyProposalAction(id)).rejects.toThrow('not enabled with prices');
  expect(mock.revalidate).not.toHaveBeenCalled();
});

it('requires owner authority before both valid and malformed decisions', async () => {
  mock.owner.mockRejectedValueOnce(new Error('Unauthorized'));
  await expect(applyProposalAction(id)).rejects.toThrow('Unauthorized');
  await expect(dismissProposalAction('invalid')).rejects.toThrow('Invalid proposal id');
  expect(mock.decide).not.toHaveBeenCalled();
});

it('returns existing repair progress without a false queued receipt', async () => {
  mock.requestFix.mockResolvedValueOnce({ id: 'repair', status: 'failed' });
  const receipt = await requestProposalCodeFixAction(id);
  expect(receipt).toMatchObject({
    outcome: 'code_fix_requested',
    repairIssueId: 'repair',
    repairStatus: 'failed',
    enacted: false,
  });
  expect(receipt.detail).toContain('No new coding run');
});
