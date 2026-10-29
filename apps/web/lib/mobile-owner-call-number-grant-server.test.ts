import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mobile: vi.fn(),
  preview: vi.fn(),
  approve: vi.fn(),
  check: vi.fn(),
  close: vi.fn(),
  withStore: vi.fn(),
}));

vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.mobile,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@assistant/application/approvals', () => ({
  approveAndRememberApproval: vi.fn(),
  decideApproval: vi.fn(),
}));
vi.mock('@assistant/application/phone-call-owner-grants', () => ({
  OWNER_CALL_GRANT_ACKNOWLEDGEMENT: 'owner_call_action_and_limits_any_answerer_v2',
  OWNER_CALL_GRANT_CLOSE_ACKNOWLEDGEMENT: 'close_this_permission_operation_only_v1',
  OwnerCallGrantLimitsSchema: {
    safeParse: (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return { success: false, error: new Error('invalid limits') };
      const row = value as Record<string, unknown>;
      const keys = Object.keys(row).sort().join(',');
      const validKeys = [
        'maxCallsPerDay',
        'maxCallsPerHour',
        'maxCostUsdMicrosPerCall',
        'maxCostUsdMicrosPerDay',
      ]
        .sort()
        .join(',');
      const valid =
        keys === validKeys &&
        Number.isSafeInteger(row.maxCallsPerHour) &&
        Number(row.maxCallsPerHour) >= 1 &&
        Number(row.maxCallsPerHour) <= 100 &&
        Number.isSafeInteger(row.maxCallsPerDay) &&
        Number(row.maxCallsPerDay) >= Number(row.maxCallsPerHour) &&
        Number(row.maxCallsPerDay) <= 100 &&
        Number.isSafeInteger(row.maxCostUsdMicrosPerCall) &&
        Number(row.maxCostUsdMicrosPerCall) > 0 &&
        Number.isSafeInteger(row.maxCostUsdMicrosPerDay) &&
        Number(row.maxCostUsdMicrosPerDay) >= Number(row.maxCostUsdMicrosPerCall);
      return valid
        ? { success: true, data: value }
        : { success: false, error: new Error('invalid limits') };
    },
  },
  previewOwnerCallNumberGrant: mocks.preview,
  approveOwnerCallNumberGrant: mocks.approve,
  checkOwnerCallGrantOperation: mocks.check,
  closeOwnerCallGrantOperation: mocks.close,
}));
vi.mock('@/lib/approval-store', () => ({
  withApprovalDecisionStore: mocks.withStore,
}));

describe('mobile reusable owner-call approval route', () => {
  const approvalId = randomUUID();
  let post: typeof import('../app/api/mobile/v1/approvals/[id]/route.js').POST;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.mobile.mockResolvedValue(true);
    mocks.withStore.mockImplementation(async (run) => run({ agentId: 'owner', approvals: {} }));
    mocks.preview.mockResolvedValue({ ok: true, reviewToken: 'v2.sealed', approvalId });
    mocks.approve.mockResolvedValue({ ok: true, approvalId });
    mocks.check.mockResolvedValue({ ok: true, status: 'registered', closeToken: 'close.sealed' });
    mocks.close.mockResolvedValue({ ok: true, status: 'closed_no_effect' });
    ({ POST: post } = await import('../app/api/mobile/v1/approvals/[id]/route.js'));
  });

  async function request(body: unknown) {
    return post(
      new Request(`http://localhost/api/mobile/v1/approvals/${approvalId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: approvalId }) },
    );
  }

  it('requires mobile owner authentication before looking up an approval', async () => {
    mocks.mobile.mockResolvedValueOnce(false);
    const response = await request({ action: 'preview_reusable_call_v2', validityChoice: '7d' });
    expect(response.status).toBe(401);
    expect(mocks.withStore).not.toHaveBeenCalled();
  });

  it('creates a bounded review only from the supported validity choices', async () => {
    const limits = {
      maxCallsPerHour: 2,
      maxCallsPerDay: 5,
      maxCostUsdMicrosPerCall: 1_250_000,
      maxCostUsdMicrosPerDay: 4_500_000,
    };
    const response = await request({
      action: 'preview_reusable_call_v2',
      validityChoice: '7d',
      limits,
    });
    expect(response.status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith(expect.anything(), approvalId, 7, limits);
    expect(await response.json()).toMatchObject({ reviewToken: 'v2.sealed' });

    const invalid = await request({
      action: 'preview_reusable_call_v2',
      validityChoice: '2d',
      limits,
    });
    expect(invalid.status).toBe(400);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(
      (
        await request({
          action: 'preview_reusable_call_v1',
          validityChoice: '7d',
          limits,
        })
      ).status,
    ).toBe(400);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(
      (
        await request({
          action: 'preview_reusable_call_v2',
          validityChoice: '7d',
          limits: { ...limits, maxCallsPerHour: 101 },
        })
      ).status,
    ).toBe(400);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(
      (
        await request({
          action: 'preview_reusable_call_v2',
          validityChoice: '30d',
          limits,
          unrelated: true,
        })
      ).status,
    ).toBe(400);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly the versioned approval action, review token and acknowledgement', async () => {
    const response = await request({
      action: 'approve_reusable_call_v2',
      reviewToken: 'v2.sealed',
      acknowledgement: 'owner_call_action_and_limits_any_answerer_v2',
    });
    expect(response.status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith(
      expect.anything(),
      approvalId,
      'v2.sealed',
      'owner_call_action_and_limits_any_answerer_v2',
    );

    for (const body of [
      {
        action: 'approve_reusable_call_v2',
        reviewToken: 'v2.sealed',
        acknowledgement: 'owner_call_action_and_limits_any_answerer_v2',
        recipientE164: '+14155550123',
      },
      {
        action: 'approve_reusable_call_v2',
        reviewToken: 'v2.sealed',
        acknowledgement: 'accepted',
      },
      {
        action: 'approve_reusable_call_v2',
        acknowledgement: 'owner_call_action_and_limits_any_answerer_v2',
      },
      {
        action: 'approve_reusable_call_v1',
        reviewToken: 'v1.sealed',
        acknowledgement: 'owner_call_action_and_limits_any_answerer_v2',
      },
    ]) {
      expect((await request(body)).status).toBe(400);
    }
    expect(mocks.approve).toHaveBeenCalledTimes(1);
  });

  it('checks and explicitly closes an operation without retrying a save', async () => {
    const checked = await request({ action: 'check_reusable_call_v2' });
    expect(checked.status).toBe(200);
    expect(mocks.check).toHaveBeenCalledWith(expect.anything(), approvalId);
    expect(mocks.approve).not.toHaveBeenCalled();

    const closed = await request({
      action: 'close_reusable_call_v2',
      closeToken: 'close.sealed',
      acknowledgement: 'close_this_permission_operation_only_v1',
      confirmation: 'confirmed',
    });
    expect(closed.status).toBe(200);
    expect(mocks.close).toHaveBeenCalledWith(
      expect.anything(),
      approvalId,
      'close.sealed',
      'close_this_permission_operation_only_v1',
    );
    expect(mocks.approve).not.toHaveBeenCalled();
  });
});
