import { describe, expect, it } from 'vitest';
import { FirestoreApprovalRepository } from './approvals.js';
import { documentKey, encodeRecord, type InstallationStore } from './store.js';

// Actual repository projection over encoded snapshots; no Firestore/client/service is created.
function fixture() {
  const agentId = 'owner';
  const taskId = '11111111-1111-4111-8111-111111111111';
  const conversationId = '22222222-2222-4222-8222-222222222222';
  const messageId = '33333333-3333-4333-8333-333333333333';
  const approvalId = '44444444-4444-4444-8444-444444444444';
  const toolCallId = '55555555-5555-4555-8555-555555555555';
  const policyId = '66666666-6666-4666-8666-666666666666';
  const clientOperationId = '77777777-7777-4777-8777-777777777777';
  const now = new Date('2026-10-23T12:00:00.000Z');
  const text = 'Call +14155550123 now.';
  const match = {
    schemaVersion: 1,
    grantId: '88888888-8888-4888-8888-888888888888',
    recipientE164: '+14155550123',
    maxMinutes: 12,
    expiresAt: '2026-10-30T12:00:00.000Z',
  };
  const policy: Record<string, unknown> = {
    id: policyId,
    agentId,
    toolName: 'phone.call',
    templateKey: 'phone.call.to_owner_number.v1',
    match,
    enabled: true,
    effect: 'allow',
  };
  const records: Record<string, Record<string, Record<string, unknown>>> = {
    agents: { [agentId]: { id: agentId, timezone: 'UTC' } },
    conversations: { [conversationId]: { id: conversationId, agentId } },
    tasks: {
      [taskId]: {
        id: taskId,
        agentId,
        conversationId,
        type: 'chat_turn',
        trust: 'owner',
        status: 'waiting_approval',
        externalEventId: `chat-admission:${agentId}:${conversationId}:${clientOperationId}`,
        trigger: {
          source: 'chat',
          agentId,
          conversationId,
          trust: 'owner',
          payload: {
            text,
            triggerMessageId: messageId,
            chatAdmission: {
              protocol: 'owner-chat-v1',
              clientOperationId,
              requestHash: 'a'.repeat(64),
              triggerMessageId: messageId,
              phase: 'queued',
            },
          },
        },
      },
    },
    messages: {
      [messageId]: {
        id: messageId,
        taskId,
        conversationId,
        role: 'user',
        origin: 'owner',
        text,
        hiddenAt: null,
        createdAt: now,
      },
    },
    approvals: {
      [approvalId]: {
        id: approvalId,
        taskId,
        toolCallId,
        status: 'pending',
        requestedAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      },
    },
    toolCalls: {
      [toolCallId]: {
        id: toolCallId,
        taskId,
        status: 'awaiting_approval',
        toolName: 'phone.call',
        args: { brief: { to: match.recipientE164, maxMinutes: 8 } },
      },
    },
  };
  const policyRows = [{ record: policy, physicalId: documentKey(policyId) }];
  const observedFilters: Array<[string, string, unknown]> = [];
  function snapshot(record: Record<string, unknown>, physicalId = documentKey(String(record.id))) {
    return {
      id: physicalId,
      ref: { id: physicalId },
      exists: true,
      data: () => encodeRecord(record),
    };
  }
  const store = {
    now: () => new Date(now),
    doc: (collection: string, id: string) => ({
      get: async () => {
        const record = records[collection]?.[id];
        return record
          ? snapshot(record)
          : { id: documentKey(id), exists: false, data: () => undefined };
      },
    }),
    collection: (collection: string) => {
      const filters: Array<[string, unknown]> = [];
      const query = {
        where: (field: string, operator: string, value: unknown) => {
          expect(operator).toBe('==');
          observedFilters.push([collection, field, value]);
          filters.push([field, value]);
          return query;
        },
        limit: () => query,
        get: async () => {
          const rows =
            collection === 'approvalPolicies'
              ? policyRows
              : Object.values(records[collection] ?? {}).map((record) => ({
                  record,
                  physicalId: documentKey(String(record.id)),
                }));
          const docs = rows
            .filter(({ record }) => filters.every(([field, value]) => record[field] === value))
            .map(({ record, physicalId }) => snapshot(record, physicalId));
          return { size: docs.length, docs };
        },
      };
      return query;
    },
  } as unknown as InstallationStore;
  return {
    review: () =>
      new FirestoreApprovalRepository(store).getOwnerCallNumberGrantReview(agentId, approvalId),
    policy,
    policyRows,
    policyId,
    match,
    now,
    observedFilters,
  };
}

describe('Firestore owner-call review existing grants projection', () => {
  it('includes an existing live grant under its actual encoded UUID document ID', async () => {
    const f = fixture();
    expect(f.policyRows[0]?.physicalId).toBe(documentKey(f.policyId));
    expect(f.policyRows[0]?.physicalId).not.toBe(f.policyId);
    const review = await f.review();
    expect(review).not.toBeNull();
    expect(review?.existingActiveGrants).toEqual([{ policyId: f.policyId, match: f.match }]);
    expect(f.observedFilters).toContainEqual(['approvalPolicies', 'agentId', 'owner']);
    expect(f.observedFilters).toContainEqual(['approvalPolicies', 'toolName', 'phone.call']);
  });

  it.each(['physical mismatch', 'embedded mismatch', 'invalid logical ID'])(
    'does not trust an invalid identity: %s',
    async (change) => {
      const f = fixture();
      if (change === 'physical mismatch') {
        for (const row of f.policyRows) row.physicalId = documentKey('different-policy');
      }
      if (change === 'embedded mismatch') f.policy.id = '99999999-9999-4999-8999-999999999999';
      if (change === 'invalid logical ID') f.policy.id = '';
      const review = await f.review();
      expect(review).not.toBeNull();
      expect(review?.existingActiveGrants).toEqual([]);
    },
  );

  it.each([
    'other owner',
    'other tool',
    'disabled',
    'deny',
    'other template',
    'other recipient',
    'expired',
    'expiry boundary',
    'malformed match',
  ])('preserves existing eligibility filter: %s', async (change) => {
    const f = fixture();
    if (change === 'other owner') f.policy.agentId = 'different-owner';
    if (change === 'other tool') f.policy.toolName = 'sms.send';
    if (change === 'disabled') f.policy.enabled = false;
    if (change === 'deny') f.policy.effect = 'deny';
    if (change === 'other template') f.policy.templateKey = 'phone.call.same_brief';
    if (change === 'other recipient')
      f.policy.match = { ...f.match, recipientE164: '+14155550999' };
    if (change === 'expired')
      f.policy.match = { ...f.match, expiresAt: '2026-10-22T12:00:00.000Z' };
    if (change === 'expiry boundary')
      f.policy.match = { ...f.match, expiresAt: f.now.toISOString() };
    if (change === 'malformed match') f.policy.match = { ...f.match, unexpected: true };
    const review = await f.review();
    expect(review).not.toBeNull();
    expect(review?.existingActiveGrants).toEqual([]);
  });
});
