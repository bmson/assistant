import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mobile: vi.fn(),
  preview: vi.fn(),
  approve: vi.fn(),
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
  OWNER_CALL_GRANT_ACKNOWLEDGEMENT: 'any_direct_owner_topic_any_answerer_v1',
  previewOwnerCallNumberGrant: mocks.preview,
  approveOwnerCallNumberGrant: mocks.approve,
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
    const response = await request({ action: 'preview_reusable_call_v1', validityChoice: '7d' });
    expect(response.status).toBe(401);
    expect(mocks.withStore).not.toHaveBeenCalled();
  });

  it('creates a bounded review only from the supported validity choices', async () => {
    const response = await request({ action: 'preview_reusable_call_v1', validityChoice: '7d' });
    expect(response.status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith(expect.anything(), approvalId, 7);
    expect(await response.json()).toMatchObject({ reviewToken: 'v2.sealed' });

    const invalid = await request({ action: 'preview_reusable_call_v1', validityChoice: '2d' });
    expect(invalid.status).toBe(400);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(
      (
        await request({
          action: 'preview_reusable_call_v1',
          validityChoice: '30d',
          unrelated: true,
        })
      ).status,
    ).toBe(400);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly the versioned approval action, review token and acknowledgement', async () => {
    const response = await request({
      action: 'approve_reusable_call_v1',
      reviewToken: 'v2.sealed',
      acknowledgement: 'any_direct_owner_topic_any_answerer_v1',
    });
    expect(response.status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith(
      expect.anything(),
      approvalId,
      'v2.sealed',
      'any_direct_owner_topic_any_answerer_v1',
    );

    for (const body of [
      {
        action: 'approve_reusable_call_v1',
        reviewToken: 'v2.sealed',
        acknowledgement: 'any_direct_owner_topic_any_answerer_v1',
        recipientE164: '+14155550123',
      },
      {
        action: 'approve_reusable_call_v1',
        reviewToken: 'v2.sealed',
        acknowledgement: 'accepted',
      },
      {
        action: 'approve_reusable_call_v1',
        acknowledgement: 'any_direct_owner_topic_any_answerer_v1',
      },
    ]) {
      expect((await request(body)).status).toBe(400);
    }
    expect(mocks.approve).toHaveBeenCalledTimes(1);
  });
});
