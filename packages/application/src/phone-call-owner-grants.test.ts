import { randomUUID } from 'node:crypto';
import { decryptStoredCredential, encryptStoredCredential } from '@assistant/core';
import type {
  ApprovalRepository,
  OwnerCallGrantOperation,
  OwnerCallNumberGrantReview,
} from '@assistant/persistence';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveOwnerCallNumberGrant,
  checkOwnerCallGrantOperation,
  closeOwnerCallGrantOperation,
  OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
  OWNER_CALL_GRANT_CLOSE_ACKNOWLEDGEMENT,
  previewOwnerCallNumberGrant,
} from './phone-call-owner-grants.js';

/** Actual application service and resolve wrapper, with no datastore/provider ports. */
describe('durable reviewed owner-call permission flow', () => {
  const agentId = randomUUID(),
    approvalId = randomUUID(),
    taskId = randomUUID(),
    toolCallId = randomUUID();
  let review: OwnerCallNumberGrantReview;
  let operation: OwnerCallGrantOperation | null;
  let repository: ApprovalRepository;
  let generation: number;
  let saved: number;
  let held: Promise<void> | null;
  const store = () => ({ agentId, approvals: repository });
  beforeEach(() => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    vi.stubEnv('MCP_ENC_KEY', 'a7'.repeat(32));
    operation = null;
    generation = 0;
    saved = 0;
    held = null;
    const now = new Date();
    const args = {
      brief: { to: '+14155550123', goal: 'Discuss dinner', maxMinutes: 5, onVoicemail: 'hang_up' },
    };
    review = {
      approval: {
        id: approvalId,
        taskId,
        toolCallId,
        shortCode: 'ABCD',
        summary: 'Call',
        payload: args,
        resolutionPayload: null,
        notifiedChannels: [],
        createdPolicyId: null,
        status: 'pending',
        requestedAt: now,
        resolvedAt: null,
        resolvedVia: null,
        expiresAt: new Date(now.getTime() + 3_600_000),
      },
      toolCall: {
        id: toolCallId,
        taskId,
        toolName: 'phone.call',
        args,
        status: 'awaiting_approval',
      },
      task: { id: taskId, agentId, trust: 'owner', status: 'waiting_approval' },
      ownerTimeZone: 'America/Los_Angeles',
      repositoryNow: now,
      existingActiveGrants: [],
      directOwnerRequest: {
        agentId,
        taskId,
        conversationId: randomUUID(),
        ownerMessageId: randomUUID(),
        requestHash: 'a'.repeat(64),
        clientOperationId: randomUUID(),
        taskTriggerFingerprint: 'b'.repeat(64),
        ownerMessageFingerprint: 'c'.repeat(64),
        recipientRequest: { kind: 'owner_self' },
      },
    };
    repository = {
      kind: 'approval-repository',
      getOwnerCallNumberGrantReview: vi.fn(async () => review),
      ownerCallOperations: {
        discover: vi.fn(async (owner, approval) =>
          owner !== agentId || approval !== approvalId
            ? { kind: 'unavailable' as const }
            : operation
              ? {
                  kind: 'current' as const,
                  slot: {
                    purpose: 'owner-call-grant-operation.v1' as const,
                    schemaVersion: 1 as const,
                    ownerId: agentId,
                    approvalId,
                    generation,
                    currentGrantId: operation.grantId,
                    updatedAt: now,
                  },
                  operation: structuredClone(operation),
                }
              : { kind: 'empty' as const, generation: 0 as const },
        ),
        register: vi.fn(async (input) => {
          if (
            input.expectedSlotGeneration !== generation ||
            (operation && ['registered', 'admitted'].includes(operation.phase))
          )
            return { ok: false as const, reason: 'busy' };
          generation++;
          operation = {
            purpose: 'owner-call-grant-operation.v1',
            schemaVersion: 1,
            operationVersion: 1,
            ownerId: input.ownerId,
            approvalId,
            taskId,
            toolCallId,
            grantId: input.grantId,
            slotGeneration: generation,
            requestFingerprint: input.requestFingerprint,
            grantScopeFingerprint: input.grantScopeFingerprint,
            phase: 'registered',
            registeredAt: now,
            reviewExpiresAt: input.reviewExpiresAt,
            grantExpiresAt: input.grantExpiresAt,
            admittedAt: null,
            committedAt: null,
            closedAt: null,
            rejectedAt: null,
            createdPolicyId: null,
            wakeGeneration: null,
            updatedAt: now,
          };
          return { ok: true as const, operation: structuredClone(operation) };
        }),
        admit: vi.fn(async (binding) => {
          if (
            !operation ||
            operation.grantId !== binding.grantId ||
            operation.phase !== 'registered'
          )
            return { ok: false as const, reason: 'not_registered' };
          operation.phase = 'admitted';
          operation.admittedAt = new Date();
          return { ok: true as const, operation: structuredClone(operation) };
        }),
        close: vi.fn(async (binding) => {
          if (!operation || operation.grantId !== binding.grantId)
            return { ok: false as const, reason: 'changed' };
          if (operation.phase !== 'committed') {
            operation.phase = 'closed_no_effect';
            operation.closedAt = new Date();
          }
          return { ok: true as const, operation: structuredClone(operation) };
        }),
      },
      resolve: vi.fn(async (input) => {
        if (held) await held;
        if (
          !operation ||
          operation.phase !== 'admitted' ||
          input.ownerCallActionGrant?.operation.grantId !== operation.grantId
        )
          return { ok: false as const, reason: 'closed' };
        saved++;
        operation.phase = 'committed';
        operation.committedAt = new Date();
        operation.createdPolicyId = randomUUID();
        operation.wakeGeneration = 1;
        return {
          ok: true as const,
          approvalId,
          taskId,
          toolCallId,
          ownerCallNumberGrant: {
            policyId: operation.createdPolicyId,
            grantId: operation.grantId,
            expiresAt: operation.grantExpiresAt.toISOString(),
          },
        };
      }),
    } as unknown as ApprovalRepository;
  });
  async function preview() {
    const result = await previewOwnerCallNumberGrant(store(), approvalId, 7);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    return result;
  }
  it('registers before returning a distinct versioned review and never stores prompt wording in scope', async () => {
    const result = await preview();
    const token = JSON.parse(decryptStoredCredential(result.reviewToken));
    expect(token.purpose).toBe('phone.call.owner_action.review.v2');
    expect(token.grant).toMatchObject({
      schemaVersion: 2,
      action: 'phone.call',
      recipientE164: '+14155550123',
      maxCallsPerHour: 1,
      maxCallsPerDay: 3,
    });
    expect(JSON.stringify(token.grant)).not.toContain('dinner');
    expect(operation?.phase).toBe('registered');
    expect(saved).toBe(0);
    expect(token.operation.grantId).toBe(result.grant.grantId);
  });
  it('fails closed without durable storage and validates rate/budget selections before registration', async () => {
    await expect(
      previewOwnerCallNumberGrant(store(), approvalId, 7, {
        maxCallsPerHour: 4,
        maxCallsPerDay: 1,
        maxCostUsdMicrosPerCall: 1,
        maxCostUsdMicrosPerDay: 1,
      }),
    ).resolves.toMatchObject({ ok: false });
    const { ownerCallOperations, ...withoutDurableStorage } = repository;
    expect(ownerCallOperations?.register).not.toHaveBeenCalled();
    repository = withoutDurableStorage;
    await expect(previewOwnerCallNumberGrant(store(), approvalId, 7)).resolves.toMatchObject({
      ok: false,
    });
    expect(repository.resolve).not.toHaveBeenCalled();
  });
  it('blocks a second review across fresh client state while an operation is registered', async () => {
    await preview();
    await expect(previewOwnerCallNumberGrant(store(), approvalId, 7)).resolves.toMatchObject({
      ok: false,
    });
    expect(repository.ownerCallOperations?.register).toHaveBeenCalledTimes(1);
    expect(await checkOwnerCallGrantOperation(store(), approvalId)).toMatchObject({
      ok: true,
      status: 'registered',
      permission: 'unconfirmed',
    });
  });
  it('rejects legacy-purpose tokens and wrong acknowledgement before admission', async () => {
    const p = await preview(),
      token = JSON.parse(decryptStoredCredential(p.reviewToken));
    const legacy = encryptStoredCredential(
      JSON.stringify({ ...token, purpose: 'phone.call.to_owner_number.review.v1' }),
    );
    await expect(
      approveOwnerCallNumberGrant(store(), approvalId, legacy, OWNER_CALL_GRANT_ACKNOWLEDGEMENT),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      approveOwnerCallNumberGrant(store(), approvalId, p.reviewToken, 'old acknowledgement'),
    ).resolves.toMatchObject({ ok: false });
    expect(repository.ownerCallOperations?.admit).not.toHaveBeenCalled();
  });
  it('keeps a held finalize unknown and blocks duplicate application and fresh review', async () => {
    const p = await preview();
    let release!: () => void;
    held = new Promise<void>((r) => {
      release = r;
    });
    const attempt = approveOwnerCallNumberGrant(
      store(),
      approvalId,
      p.reviewToken,
      OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
    );
    await vi.waitFor(() => expect(repository.resolve).toHaveBeenCalledTimes(1));
    expect(await checkOwnerCallGrantOperation(store(), approvalId)).toMatchObject({
      ok: true,
      status: 'admitted',
      permission: 'unconfirmed',
    });
    await expect(previewOwnerCallNumberGrant(store(), approvalId, 7)).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      approveOwnerCallNumberGrant(
        store(),
        approvalId,
        p.reviewToken,
        OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
      ),
    ).resolves.toMatchObject({ ok: false });
    release();
    expect((await attempt).ok).toBe(true);
    expect(saved).toBe(1);
    expect(repository.resolve).toHaveBeenCalledTimes(1);
  });
  it('recovers a committed save after a dropped response without replaying resolution', async () => {
    const p = await preview(),
      resolve = repository.resolve;
    repository.resolve = vi.fn(async (input) => {
      await resolve(input);
      throw new Error('response dropped');
    });
    expect(
      (
        await approveOwnerCallNumberGrant(
          store(),
          approvalId,
          p.reviewToken,
          OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
        )
      ).ok,
    ).toBe(false);
    expect(await checkOwnerCallGrantOperation(store(), approvalId, p.grant.grantId)).toMatchObject({
      ok: true,
      status: 'committed',
      permission: 'saved',
      availability: 'unchecked',
    });
    expect(saved).toBe(1);
    expect(repository.resolve).toHaveBeenCalledTimes(1);
  });
  it('explicit close wins against a held finalize without denying the call or creating a grant', async () => {
    const p = await preview();
    let release!: () => void;
    held = new Promise<void>((r) => {
      release = r;
    });
    const attempt = approveOwnerCallNumberGrant(
      store(),
      approvalId,
      p.reviewToken,
      OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
    );
    await vi.waitFor(() => expect(repository.resolve).toHaveBeenCalledTimes(1));
    const checked = await checkOwnerCallGrantOperation(store(), approvalId);
    if (!checked.ok || checked.status === 'none' || !checked.closeToken)
      throw new Error('close handle absent');
    expect(
      (await closeOwnerCallGrantOperation(store(), approvalId, checked.closeToken, 'not consent'))
        .ok,
    ).toBe(false);
    const closed = await closeOwnerCallGrantOperation(
      store(),
      approvalId,
      checked.closeToken,
      OWNER_CALL_GRANT_CLOSE_ACKNOWLEDGEMENT,
    );
    expect(closed).toMatchObject({ ok: true, status: 'closed_no_effect', permission: 'not_saved' });
    release();
    expect((await attempt).ok).toBe(false);
    expect(saved).toBe(0);
    expect(review.approval.status).toBe('pending');
  });
  it('a committed outcome wins a later close and missing state never proves expected operation failure', async () => {
    const p = await preview(),
      checked = await checkOwnerCallGrantOperation(store(), approvalId);
    if (!checked.ok || checked.status === 'none' || !checked.closeToken)
      throw new Error('close handle absent');
    await approveOwnerCallNumberGrant(
      store(),
      approvalId,
      p.reviewToken,
      OWNER_CALL_GRANT_ACKNOWLEDGEMENT,
    );
    expect(
      await closeOwnerCallGrantOperation(
        store(),
        approvalId,
        checked.closeToken,
        OWNER_CALL_GRANT_CLOSE_ACKNOWLEDGEMENT,
      ),
    ).toMatchObject({ ok: true, status: 'committed', permission: 'saved' });
    operation = null;
    expect(await checkOwnerCallGrantOperation(store(), approvalId, p.grant.grantId)).toMatchObject({
      ok: false,
    });
    expect(saved).toBe(1);
  });
});
