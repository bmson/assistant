import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  approve: vi.fn(),
  preview: vi.fn(),
  check: vi.fn(),
  close: vi.fn(),
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
  OWNER_CALL_GRANT_ACKNOWLEDGEMENT: 'owner_call_action_and_limits_any_answerer_v2',
  OWNER_CALL_GRANT_CLOSE_ACKNOWLEDGEMENT: 'close_this_permission_operation_only_v1',
  OwnerCallGrantLimitsSchema: {
    safeParse: (value: unknown) => ({ success: true, data: value }),
  },
  approveOwnerCallNumberGrant: state.approve,
  previewOwnerCallNumberGrant: state.preview,
  checkOwnerCallGrantOperation: state.check,
  closeOwnerCallGrantOperation: state.close,
}));

import { ownerCallNumberGrantAction } from './actions.js';

const previous = { error: null, preview: null, completed: false, operation: null };
function finalForm() {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    mode: 'approve',
    action: 'approve_reusable_call_v2',
    reviewToken: 'sealed',
    acknowledgement: 'owner_call_action_and_limits_any_answerer_v2',
    confirmation: 'confirmed',
  }))
    form.set(key, value);
  return form;
}
beforeEach(() => {
  vi.resetAllMocks();
  state.store.mockImplementation(async (run) => run({}));
  state.approve.mockResolvedValue({ ok: true });
  state.preview.mockResolvedValue({ ok: true, reviewToken: 'sealed' });
  state.check.mockResolvedValue({ ok: true, status: 'admitted', closeToken: 'close-sealed' });
  state.close.mockResolvedValue({ ok: true, status: 'closed_no_effect' });
});
it('requires a durable successful result and forwards only sealed final authority', async () => {
  expect(await ownerCallNumberGrantAction('approval', previous, finalForm())).toMatchObject({
    completed: true,
  });
  expect(state.approve).toHaveBeenCalledWith(
    {},
    'approval',
    'sealed',
    'owner_call_action_and_limits_any_answerer_v2',
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
      state.approve.mockResolvedValueOnce({
        ok: false,
        reason:
          'The result is not confirmed. Check this permission operation before reviewing again.',
      });
    expect(await ownerCallNumberGrantAction('approval', previous, finalForm())).toEqual({
      completed: false,
      preview: null,
      error: 'The result is not confirmed. Check this permission operation before reviewing again.',
    });
    expect(state.approve).toHaveBeenCalledTimes(1);
  },
);
it('maps only a known stale result to fresh-review copy', async () => {
  state.approve.mockResolvedValueOnce({
    ok: false,
    reason: 'This review expired or changed. Check the permission operation.',
  });
  expect(await ownerCallNumberGrantAction('approval', previous, finalForm())).toMatchObject({
    completed: false,
    error: 'This review expired or changed. Check the permission operation.',
  });
});
it('rejects duplicated final fields without writing', async () => {
  const form = finalForm();
  form.append('reviewToken', 'other');
  expect((await ownerCallNumberGrantAction('approval', previous, form)).completed).toBe(false);
  expect(state.approve).not.toHaveBeenCalled();
  expect(state.store).not.toHaveBeenCalled();
});

it('forwards explicit duration, rolling counts and cost limits into review', async () => {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    mode: 'review',
    action: 'preview_reusable_call_v2',
    validityChoice: '7d',
    callsPerHour: '2',
    callsPerDay: '5',
    usdPerCall: '1.25',
    usdPerDay: '4.50',
  }))
    form.set(key, value);
  await ownerCallNumberGrantAction('approval', previous, form);
  expect(state.preview).toHaveBeenCalledWith({}, 'approval', 7, {
    maxCallsPerHour: 2,
    maxCallsPerDay: 5,
    maxCostUsdMicrosPerCall: 1_250_000,
    maxCostUsdMicrosPerDay: 4_500_000,
  });
});

it('checks an ambiguous operation and closes only after a separate explicit confirmation', async () => {
  const check = new FormData();
  check.set('mode', 'check');
  check.set('action', 'check_reusable_call_v2');
  expect(await ownerCallNumberGrantAction('approval', previous, check)).toMatchObject({
    operation: { ok: true, status: 'admitted', closeToken: 'close-sealed' },
  });
  expect(state.approve).not.toHaveBeenCalled();

  const close = new FormData();
  close.set('mode', 'close');
  close.set('action', 'close_reusable_call_v2');
  close.set('closeToken', 'close-sealed');
  close.set('confirmation', 'confirmed');
  await ownerCallNumberGrantAction('approval', previous, close);
  expect(state.close).toHaveBeenCalledWith(
    {},
    'approval',
    'close-sealed',
    'close_this_permission_operation_only_v1',
  );
  expect(state.approve).not.toHaveBeenCalled();
});

it('rejects the old v1 save action without invoking the service', async () => {
  const form = finalForm();
  form.set('action', 'approve_reusable_call_v1');
  expect((await ownerCallNumberGrantAction('approval', previous, form)).completed).toBe(false);
  expect(state.approve).not.toHaveBeenCalled();

  const preview = new FormData();
  preview.set('mode', 'review');
  preview.set('action', 'preview_reusable_call_v1');
  preview.set('validityChoice', '7d');
  preview.set('callsPerHour', '2');
  preview.set('callsPerDay', '5');
  preview.set('usdPerCall', '1.25');
  preview.set('usdPerDay', '4.50');
  expect((await ownerCallNumberGrantAction('approval', previous, preview)).preview).toBeNull();
  expect(state.preview).not.toHaveBeenCalled();
});
