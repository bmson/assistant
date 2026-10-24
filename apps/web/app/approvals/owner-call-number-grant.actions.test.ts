import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  approve: vi.fn(),
  preview: vi.fn(),
  store: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock('@/auth', () => ({ requireOwner: async () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: state.revalidate }));
vi.mock('@/app/settings/actions', () => ({ deletePolicy: vi.fn(), setPolicyEnabled: vi.fn() }));
vi.mock('@/lib/approval-store', () => ({ withApprovalDecisionStore: state.store }));
vi.mock('@assistant/application/approvals', () => ({
  approveAndRememberApproval: vi.fn(),
  decideApproval: vi.fn(),
  decideApprovals: vi.fn(),
}));
vi.mock('@assistant/application/phone-call-owner-grants', () => ({
  OWNER_CALL_GRANT_ACKNOWLEDGEMENT: 'any_direct_owner_topic_any_answerer_v1',
  approveOwnerCallNumberGrant: state.approve,
  previewOwnerCallNumberGrant: state.preview,
}));

import { ownerCallNumberGrantAction } from './actions.js';

const previous = { error: null, preview: null, completed: false };
function finalForm() {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    mode: 'approve',
    action: 'approve_reusable_call_v1',
    reviewToken: 'sealed',
    acknowledgement: 'any_direct_owner_topic_any_answerer_v1',
    confirmation: 'confirmed',
  }))
    form.set(key, value);
  return form;
}
beforeEach(() => {
  vi.resetAllMocks();
  state.store.mockImplementation(async (run) => run({}));
  state.approve.mockResolvedValue({ ok: true });
});
it('requires a durable successful result and forwards only sealed final authority', async () => {
  expect(await ownerCallNumberGrantAction('approval', previous, finalForm())).toMatchObject({
    completed: true,
  });
  expect(state.approve).toHaveBeenCalledWith(
    {},
    'approval',
    'sealed',
    'any_direct_owner_topic_any_answerer_v1',
  );
});
it.each(['transport', 'store-after-write', 'revalidation-after-write', 'unknown-conflict'])(
  'reports ambiguous receipt without retry: %s',
  async (scenario) => {
    if (scenario === 'transport') state.approve.mockRejectedValueOnce(new Error('timeout'));
    if (scenario === 'store-after-write')
      state.store.mockImplementationOnce(async (run) => {
        await run({});
        throw new Error('postwrite fence');
      });
    if (scenario === 'revalidation-after-write')
      state.revalidate.mockImplementationOnce(() => {
        throw new Error('cache');
      });
    if (scenario === 'unknown-conflict')
      state.approve.mockResolvedValueOnce({ ok: false, reason: 'system disabled' });
    expect(await ownerCallNumberGrantAction('approval', previous, finalForm())).toEqual({
      completed: false,
      preview: null,
      error:
        'Could not confirm result. Refresh to check this call and saved permission before trying again.',
    });
    expect(state.approve).toHaveBeenCalledTimes(1);
  },
);
it('maps only a known stale result to fresh-review copy', async () => {
  state.approve.mockResolvedValueOnce({
    ok: false,
    reason: 'This review expired or changed. Review again.',
  });
  expect(await ownerCallNumberGrantAction('approval', previous, finalForm())).toMatchObject({
    completed: false,
    error: 'This review expired or changed. Review again.',
  });
});
it('rejects duplicated final fields without writing', async () => {
  const form = finalForm();
  form.append('reviewToken', 'other');
  expect((await ownerCallNumberGrantAction('approval', previous, form)).completed).toBe(false);
  expect(state.approve).not.toHaveBeenCalled();
  expect(state.store).not.toHaveBeenCalled();
});
