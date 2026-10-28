import { describe, expect, it } from 'vitest';
import {
  directOwnerCallRequestBinding,
  parsePhoneCallToOwnerNumberGrantMatch,
  phoneCallOwnerNumberGrantBindingMatches,
  phoneCallOwnerNumberGrantFinalizationMatches,
  phoneCallOwnerNumberReviewSourceFingerprint,
  phoneCallToOwnerNumberGrantIsLive,
  phoneCallToOwnerNumberGrantMatches,
  sameDirectOwnerCallRequestBinding,
} from './phone-call-owner-number-grant.js';

const valid = {
  schemaVersion: 1 as const,
  grantId: 'd42d54a2-83f4-4aa0-900d-1f3e67ae3a18',
  recipientE164: '+14155550123',
  maxMinutes: 12,
  expiresAt: '2026-10-23T18:00:00.000Z',
};

describe('phone.call.to_owner_number.v1 stored match', () => {
  it('accepts only the strict versioned owner-number scope', () => {
    expect(parsePhoneCallToOwnerNumberGrantMatch(valid)).toEqual(valid);
    expect(
      parsePhoneCallToOwnerNumberGrantMatch({ ...valid, scope: 'all-direct-owner-topics' }),
    ).toBeNull();
    expect(parsePhoneCallToOwnerNumberGrantMatch({ ...valid, schemaVersion: 2 })).toBeNull();
  });

  it.each([
    ['missing grant id', { ...valid, grantId: undefined }],
    ['non-UUID grant id', { ...valid, grantId: 'server-generated' }],
    ['noncanonical phone', { ...valid, recipientE164: '+1 (415) 555-0123' }],
    ['zero duration', { ...valid, maxMinutes: 0 }],
    ['fractional duration', { ...valid, maxMinutes: 1.5 }],
    ['non-numeric duration', { ...valid, maxMinutes: '12' }],
    ['offset timestamp', { ...valid, expiresAt: '2026-10-23T11:00:00-07:00' }],
    ['invalid date', { ...valid, expiresAt: '2026-02-30T18:00:00.000Z' }],
  ])('rejects %s', (_label, value) => {
    expect(parsePhoneCallToOwnerNumberGrantMatch(value)).toBeNull();
  });

  it('matches only the exact recipient and a positive duration within the grant', () => {
    const grant = parsePhoneCallToOwnerNumberGrantMatch(valid);
    expect(grant).not.toBeNull();
    if (!grant) return;
    expect(
      phoneCallToOwnerNumberGrantMatches(grant, { to: valid.recipientE164, maxMinutes: 12 }),
    ).toBe(true);
    expect(
      phoneCallToOwnerNumberGrantMatches(grant, { to: valid.recipientE164, maxMinutes: 13 }),
    ).toBe(false);
    expect(phoneCallToOwnerNumberGrantMatches(grant, { to: '+14155550124', maxMinutes: 1 })).toBe(
      false,
    );
    expect(
      phoneCallToOwnerNumberGrantMatches(grant, { to: valid.recipientE164, maxMinutes: 0 }),
    ).toBe(false);
  });

  it('treats equality as expired and rejects an invalid repository clock', () => {
    const grant = parsePhoneCallToOwnerNumberGrantMatch(valid);
    expect(grant).not.toBeNull();
    if (!grant) return;
    expect(phoneCallToOwnerNumberGrantIsLive(grant, new Date('2026-10-23T17:59:59.999Z'))).toBe(
      true,
    );
    expect(phoneCallToOwnerNumberGrantIsLive(grant, new Date(valid.expiresAt))).toBe(false);
    expect(phoneCallToOwnerNumberGrantIsLive(grant, new Date(Number.NaN))).toBe(false);
  });

  it('binds the exact selected enabled policy row at the atomic execution boundary', () => {
    const binding = {
      policyId: 'owner-policy-1',
      recipientAuthority: { kind: 'explicit_number' as const, recipientE164: valid.recipientE164 },
      match: valid,
      directOwnerRequest: {
        agentId: 'owner-1',
        taskId: 'task-1',
        conversationId: 'chat-1',
        ownerMessageId: 'message-1',
        requestHash: 'a'.repeat(64),
        clientOperationId: '11111111-1111-4111-8111-111111111111',
        taskTriggerFingerprint: 'b'.repeat(64),
        recipientRequest: { kind: 'explicit_number' as const, recipientE164: '+14155550123' },
        ownerMessageFingerprint: 'c'.repeat(64),
      },
    };
    const row = {
      id: 'owner-policy-1',
      agentId: 'owner-1',
      toolName: 'phone.call',
      templateKey: 'phone.call.to_owner_number.v1',
      effect: 'allow',
      enabled: true,
      match: valid,
    };
    const brief = { to: valid.recipientE164, maxMinutes: 8 };
    const now = new Date('2026-10-23T12:00:00.000Z');
    expect(phoneCallOwnerNumberGrantBindingMatches(binding, row, 'owner-1', brief, now)).toBe(true);
    expect(
      phoneCallOwnerNumberGrantBindingMatches(
        binding,
        { ...row, id: 'another-policy' },
        'owner-1',
        brief,
        now,
      ),
    ).toBe(false);
    expect(
      phoneCallOwnerNumberGrantBindingMatches(
        binding,
        { ...row, enabled: false },
        'owner-1',
        brief,
        now,
      ),
    ).toBe(false);
    expect(
      phoneCallOwnerNumberGrantBindingMatches(
        binding,
        { ...row, match: { ...valid, maxMinutes: 9 } },
        'owner-1',
        brief,
        now,
      ),
    ).toBe(false);
  });

  it('finalizes only the same direct-owner pending call, exact brief and unexpired review', () => {
    const args = { brief: { to: valid.recipientE164, maxMinutes: valid.maxMinutes } };
    const sourceArgsFingerprint = phoneCallOwnerNumberReviewSourceFingerprint(args);
    expect(sourceArgsFingerprint).not.toBeNull();
    if (!sourceArgsFingerprint) return;
    const expected = {
      expectedApprovalId: 'f22d54a2-83f4-4aa0-900d-1f3e67ae3a18',
      expectedAgentId: 'owner-1',
      expectedTaskId: 'a22d54a2-83f4-4aa0-900d-1f3e67ae3a18',
      expectedToolCallId: 'b22d54a2-83f4-4aa0-900d-1f3e67ae3a18',
      sourceArgsFingerprint,
      reviewIssuedAt: '2026-10-23T12:00:00.000Z',
      reviewExpiresAt: '2026-10-23T12:10:00.000Z',
      validityDays: 7 as const,
      directOwnerRequest: {
        agentId: 'owner-1',
        taskId: 'task-1',
        conversationId: 'chat-1',
        ownerMessageId: 'message-1',
        requestHash: 'a'.repeat(64),
        clientOperationId: '11111111-1111-4111-8111-111111111111',
        taskTriggerFingerprint: 'b'.repeat(64),
        recipientRequest: { kind: 'explicit_number' as const, recipientE164: '+14155550123' },
        ownerMessageFingerprint: 'c'.repeat(64),
      },
      match: { ...valid, expiresAt: '2026-10-30T12:00:00.000Z' },
    };
    const current = {
      approvalId: expected.expectedApprovalId,
      approvalStatus: 'pending',
      approvalExpiresAt: new Date('2026-10-24T12:00:00.000Z'),
      agentId: 'owner-1',
      approvalTaskId: expected.expectedTaskId,
      approvalToolCallId: expected.expectedToolCallId,
      taskId: expected.expectedTaskId,
      taskAgentId: 'owner-1',
      taskTrust: 'owner',
      taskStatus: 'waiting_approval',
      toolCallId: expected.expectedToolCallId,
      toolTaskId: expected.expectedTaskId,
      toolApprovalId: expected.expectedApprovalId,
      toolName: 'phone.call',
      toolStatus: 'awaiting_approval',
      toolArgs: args,
      approvalPayload: args,
      directOwnerRequest: expected.directOwnerRequest,
    };
    const now = new Date('2026-10-23T12:05:00.000Z');
    expect(phoneCallOwnerNumberGrantFinalizationMatches(expected, current, now)).toBe(true);
    for (const [label, changes] of [
      ['wrong approval', { approvalId: 'different' }],
      ['wrong owner', { agentId: 'other' }],
      ['untrusted task', { taskTrust: 'assistant' }],
      ['task no longer waiting', { taskStatus: 'pending' }],
      ['approval already resolved', { approvalStatus: 'approved' }],
      ['tool args changed', { toolArgs: { brief: { ...args.brief, goal: 'changed' } } }],
      [
        'approval payload changed',
        { approvalPayload: { brief: { ...args.brief, goal: 'changed' } } },
      ],
      ['tool link changed', { toolApprovalId: null }],
    ] as const) {
      expect(
        phoneCallOwnerNumberGrantFinalizationMatches(expected, { ...current, ...changes }, now),
        label,
      ).toBe(false);
    }
    expect(
      phoneCallOwnerNumberGrantFinalizationMatches(
        expected,
        current,
        new Date(expected.reviewExpiresAt),
      ),
    ).toBe(false);
    expect(
      phoneCallOwnerNumberGrantFinalizationMatches(expected, current, new Date(Number.NaN)),
    ).toBe(false);
  });
});

describe('direct owner call admission provenance', () => {
  const agentId = 'owner-1',
    taskId = 'task-1',
    conversationId = 'chat-1';
  const clientOperationId = '11111111-1111-4111-8111-111111111111';
  const message = {
    id: 'message-1',
    conversationId,
    taskId,
    role: 'user',
    origin: 'owner',
    text: 'Call my number to discuss my appointment.',
    hiddenAt: null,
  };
  const conversation = { id: conversationId, agentId };
  const task = {
    id: taskId,
    agentId,
    conversationId,
    trust: 'owner',
    type: 'chat_turn',
    status: 'running',
    externalEventId: `chat-admission:${agentId}:${conversationId}:${clientOperationId}`,
    trigger: {
      source: 'chat',
      agentId,
      conversationId,
      trust: 'owner',
      payload: {
        text: message.text,
        triggerMessageId: message.id,
        chatAdmission: {
          protocol: 'owner-chat-v1',
          clientOperationId,
          triggerMessageId: message.id,
          requestHash: 'a'.repeat(64),
          phase: 'streaming',
        },
      },
    },
  };
  it('captures canonical fingerprints and rejects legacy, scheduled, foreign, hidden and changed records', () => {
    const waiting = { ...task, status: 'waiting_approval' };
    expect(directOwnerCallRequestBinding(waiting, conversation, message)).toBeNull();
    expect(
      directOwnerCallRequestBinding(waiting, conversation, message, 'waiting_approval'),
    ).not.toBeNull();
    expect(
      directOwnerCallRequestBinding(task, conversation, message, 'waiting_approval'),
    ).toBeNull();
    const binding = directOwnerCallRequestBinding(task, conversation, message);
    expect(binding).toMatchObject({ agentId, taskId, conversationId, ownerMessageId: message.id });
    expect(JSON.stringify(binding)).not.toContain(message.text);
    for (const changed of [
      { ...task, type: 'mission' },
      { ...task, status: 'pending' },
      { ...task, trust: 'assistant' },
      { ...task, trigger: { source: 'chat' } },
      { ...task, externalEventId: 'scheduled' },
    ])
      expect(directOwnerCallRequestBinding(changed, conversation, message)).toBeNull();
    for (const changed of [
      { ...message, hiddenAt: new Date() },
      { ...message, origin: 'assistant' },
      { ...message, role: 'assistant' },
      { ...message, taskId: 'other' },
      { ...message, id: 'newer-owner-message' },
      { ...message, text: 'changed' },
    ])
      expect(directOwnerCallRequestBinding(task, conversation, changed)).toBeNull();
    expect(
      directOwnerCallRequestBinding(task, { ...conversation, agentId: 'foreign' }, message),
    ).toBeNull();
    expect(
      binding &&
        sameDirectOwnerCallRequestBinding(binding, {
          ...binding,
          taskTriggerFingerprint: 'd'.repeat(64),
        }),
    ).toBe(false);
    expect(binding && sameDirectOwnerCallRequestBinding(binding, binding)).toBe(true);
  });
});
