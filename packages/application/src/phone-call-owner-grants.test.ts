import { randomUUID } from 'node:crypto';
import { decryptStoredCredential } from '@assistant/core';
import type { ApprovalRepository, OwnerCallNumberGrantReview } from '@assistant/persistence';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@assistant/core/workflow/approvals', () => ({ resolveApproval: mock.resolve }));

import {
  approveOwnerCallNumberGrant,
  OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
  previewOwnerCallNumberGrant,
} from './phone-call-owner-grants.js';

describe('reusable owner-number call review', () => {
  const approvalId = randomUUID();
  const taskId = randomUUID();
  const toolCallId = randomUUID();
  const agentId = 'owner-agent';
  const args = {
    brief: {
      to: '+14155550123',
      contactName: 'Nopa',
      goal: 'Ask for a table for two tonight.',
      context: 'The owner prefers a quiet table.',
      mayAgreeTo: 'Any table between 7 and 8pm.',
      mustNot: 'Do not leave a deposit.',
      maxMinutes: 12,
      onVoicemail: 'leave_message',
      voicemailMessage: 'Please call back.',
    },
  };
  let review: OwnerCallNumberGrantReview;
  let repository: ApprovalRepository;
  const store = () => ({ agentId, approvals: repository });

  beforeEach(() => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    vi.stubEnv('MCP_ENC_KEY', 'a7'.repeat(32));
    mock.resolve.mockReset().mockResolvedValue({
      ok: true,
      approvalId,
      taskId,
      toolCallId,
    });
    review = {
      approval: {
        id: approvalId,
        taskId,
        toolCallId,
        shortCode: 'A1AA',
        summary: 'Call Nopa',
        payload: structuredClone(args),
        resolutionPayload: null,
        notifiedChannels: [],
        createdPolicyId: null,
        status: 'pending',
        requestedAt: new Date('2026-10-23T12:00:00.000Z'),
        resolvedAt: null,
        resolvedVia: null,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
      toolCall: {
        id: toolCallId,
        taskId,
        toolName: 'phone.call',
        args: structuredClone(args),
        status: 'awaiting_approval',
      },
      task: { id: taskId, agentId, trust: 'owner', status: 'waiting_approval' },
      ownerTimeZone: 'America/Los_Angeles',
      directOwnerRequest: {
        agentId,
        taskId,
        conversationId: randomUUID(),
        ownerMessageId: randomUUID(),
        requestHash: 'a'.repeat(64),
        clientOperationId: randomUUID(),
        taskTriggerFingerprint: 'b'.repeat(64),
        recipientRequest: { kind: 'explicit_number' as const, recipientE164: '+14155550123' },
        ownerMessageFingerprint: 'c'.repeat(64),
      },
      repositoryNow: new Date(),
      existingActiveGrants: [],
    };
    repository = {
      kind: 'approval-repository',
      getRememberable: vi.fn(),
      getOwnerCallNumberGrantReview: vi.fn().mockImplementation(async () => review),
      listInbox: vi.fn(),
      listStalledNotices: vi.fn(),
      markNotified: vi.fn(),
      resolve: vi.fn().mockImplementation(async (input) => mock.resolve(input)),
      create: vi.fn(),
      expireStale: vi.fn(),
      resumeResolved: vi.fn(),
    } as unknown as ApprovalRepository;
  });

  it('seals a server-derived exact number, duration and absolute expiry for an owner task', async () => {
    const result = await previewOwnerCallNumberGrant(store(), approvalId, 7);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const token = JSON.parse(decryptStoredCredential(result.reviewToken));
    expect(token).toMatchObject({
      ownerId: agentId,
      approvalId,
      taskId,
      toolCallId,
      taskTrust: 'owner',
      validityDays: 7,
      grant: {
        schemaVersion: 1,
        recipientE164: '+14155550123',
        maxMinutes: 12,
      },
    });
    expect(Date.parse(token.grant.expiresAt) - Date.parse(token.issuedAt)).toBe(
      7 * 24 * 60 * 60_000,
    );
    expect(result.grant.expiresAt).toBe(token.grant.expiresAt);
    expect(result.brief.context).toBe(args.brief.context);
    expect(result.ownerTimeZone).toBe('America/Los_Angeles');
    expect(result.reviewToken).not.toContain('+14155550123');
  });

  it('fails closed for disabled, foreign, stale, mismatched or unsupported reviews', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'false');
    await expect(previewOwnerCallNumberGrant(store(), approvalId, 7)).resolves.toMatchObject({
      ok: false,
    });
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    await expect(previewOwnerCallNumberGrant(store(), approvalId, 2)).resolves.toMatchObject({
      ok: false,
    });
    review.task = { ...review.task, trust: 'assistant' };
    await expect(previewOwnerCallNumberGrant(store(), approvalId, 7)).resolves.toMatchObject({
      ok: false,
    });
    review.task = { ...review.task, trust: 'owner' };
    review.approval = {
      ...review.approval,
      payload: { brief: { ...args.brief, goal: 'changed' } },
    };
    await expect(previewOwnerCallNumberGrant(store(), approvalId, 7)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('finalizes only with the versioned explicit acknowledgement and passes immutable fences', async () => {
    const preview = await previewOwnerCallNumberGrant(store(), approvalId, 1);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    await expect(
      approveOwnerCallNumberGrant(store(), approvalId, preview.reviewToken, 'accepted'),
    ).resolves.toMatchObject({ ok: false });
    expect(mock.resolve).not.toHaveBeenCalled();

    mock.resolve.mockImplementation(async (_repository, input) => ({
      ok: true,
      approvalId,
      taskId,
      toolCallId,
      ownerCallNumberGrant: {
        policyId: randomUUID(),
        grantId: input.ownerCallNumberGrant.match.grantId,
        expiresAt: input.ownerCallNumberGrant.match.expiresAt,
      },
    }));
    await expect(
      approveOwnerCallNumberGrant(
        store(),
        approvalId,
        preview.reviewToken,
        OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(mock.resolve).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({
        approvalId,
        expectedAgentId: agentId,
        decision: 'approved',
        via: 'web',
        policy: expect.objectContaining({
          toolName: 'phone.call',
          templateKey: 'phone.call.to_owner_number.v1',
          effect: 'allow',
        }),
        ownerCallNumberGrant: expect.objectContaining({
          expectedApprovalId: approvalId,
          expectedAgentId: agentId,
          expectedTaskId: taskId,
          expectedToolCallId: toolCallId,
          validityDays: 1,
          match: preview.grant,
        }),
      }),
    );
  });
});
