import { describe, expect, it } from 'vitest';
import { getOwnerCallNumberGrantReview } from './approval-repository.js';
import type { Db } from './client.js';
import { approvalPolicies, approvals, conversations, messages, tasks } from './schema.js';

// Raw SQL results mimic postgres-js's transparent timestamptz parser. No DB client/query is created.
function fixture(rawClock: unknown, expiresAt = '2026-10-23T12:01:00.123Z') {
  const agentId = 'owner';
  const taskId = '11111111-1111-4111-8111-111111111111';
  const conversationId = '22222222-2222-4222-8222-222222222222';
  const messageId = '33333333-3333-4333-8333-333333333333';
  const approvalId = '44444444-4444-4444-8444-444444444444';
  const toolCallId = '55555555-5555-4555-8555-555555555555';
  const clientOperationId = '66666666-6666-4666-8666-666666666666';
  const policyId = '77777777-7777-4777-8777-777777777777';
  const text = 'Call +14155550123 now.';
  const task = {
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
  };
  const match = {
    schemaVersion: 1,
    grantId: '88888888-8888-4888-8888-888888888888',
    recipientE164: '+14155550123',
    maxMinutes: 12,
    expiresAt,
  };
  const row = {
    approval: {
      id: approvalId,
      taskId,
      toolCallId,
      status: 'pending',
      expiresAt: new Date('2026-10-24T12:00:00.000Z'),
    },
    toolCall: {
      id: toolCallId,
      taskId,
      toolName: 'phone.call',
      args: { brief: { to: match.recipientE164, maxMinutes: 8 } },
      status: 'awaiting_approval',
    },
    task: { id: taskId, agentId, trust: 'owner', status: 'waiting_approval' },
    ownerTimeZone: 'UTC',
    repositoryNow: rawClock,
  };
  const readTables: unknown[] = [];
  const db = {
    select: () => {
      let table: unknown;
      const query = {
        from: (selected: unknown) => {
          table = selected;
          readTables.push(table);
          return query;
        },
        innerJoin: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async () => {
          if (table === approvals) return [row];
          if (table === tasks) return [task];
          if (table === conversations) return [{ id: conversationId, agentId }];
          if (table === messages)
            return [
              {
                id: messageId,
                taskId,
                conversationId,
                role: 'user',
                origin: 'owner',
                text,
                hiddenAt: null,
              },
            ];
          if (table === approvalPolicies)
            return [
              {
                id: policyId,
                agentId,
                toolName: 'phone.call',
                templateKey: 'phone.call.to_owner_number.v1',
                enabled: true,
                effect: 'allow',
                match,
              },
            ];
          throw new Error('Unexpected fixture query');
        },
      };
      return query;
    },
  } as unknown as Db;
  return {
    review: () => getOwnerCallNumberGrantReview(db, agentId, approvalId),
    policyId,
    match,
    readTables,
    taskId,
    messageId,
  };
}

const instant = '2026-10-23T12:00:00.123Z';

describe('PostgreSQL owner-call preview database-clock boundary', () => {
  it.each([
    ['postgres-js UTC microseconds', '2026-10-23 12:00:00.123456+00'],
    ['postgres-js nonzero offset', '2026-10-23 17:30:00.123456+05:30'],
    ['decoded Date', new Date(instant)],
  ])('returns the trusted Date and live grant from %s', async (_label, rawClock) => {
    const f = fixture(rawClock);
    const review = await f.review();
    expect(review?.repositoryNow).toBeInstanceOf(Date);
    expect(review?.repositoryNow.getTime()).toBe(Date.parse(instant));
    expect(review?.repositoryNow.toISOString()).toBe(instant);
    expect(review?.existingActiveGrants).toEqual([{ policyId: f.policyId, match: f.match }]);
    expect(review?.directOwnerRequest).toMatchObject({
      taskId: f.taskId,
      ownerMessageId: f.messageId,
      recipientRequest: { kind: 'explicit_number', recipientE164: '+14155550123' },
    });
  });

  it('excludes a grant expiring at the normalized instant, including a nonzero-offset raw clock', async () => {
    const f = fixture('2026-10-23 17:30:00.123456+05:30', instant);
    const review = await f.review();
    expect(review?.repositoryNow.toISOString()).toBe(instant);
    expect(review?.existingActiveGrants).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['number', Date.parse(instant)],
    ['nonfinite number', Infinity],
    ['object', { toString: () => instant }],
    ['empty string', ''],
    ['invalid string', 'not-a-database-timestamp'],
    ['infinite timestamp', 'infinity'],
    ['invalid Date', new Date(NaN)],
  ])('fails closed without a process-clock fallback for %s', async (_label, rawClock) => {
    const f = fixture(rawClock);
    expect(await f.review()).toBeNull();
    expect(f.readTables).toEqual([approvals]);
  });
});
