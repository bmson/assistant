import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHAT_ADMISSION_PROTOCOL,
  chatAdmissionCancellationPayload,
  chatAdmissionCancellationTrigger,
  chatAdmissionExternalEventId,
  chatAdmissionPayload,
  isChatAdmissionCancellationProjection,
} from './chat-admission.js';
import type { Records } from './records.js';
import { newTaskRecord } from './task-creation.js';

function tombstone() {
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const clientOperationId = randomUUID();
  const externalEventId = chatAdmissionExternalEventId({
    agentId,
    conversationId,
    clientOperationId,
  });
  const task = {
    ...newTaskRecord(
      {
        agentId,
        conversationId,
        type: 'chat_turn',
        trust: 'owner',
        trigger: chatAdmissionCancellationTrigger({ agentId, conversationId, clientOperationId }),
        externalEventId,
      },
      randomUUID(),
      new Date('2026-10-08T12:00:00.000Z'),
    ),
    status: 'cancelled',
  } as Records['tasks'];
  return { task, agentId, conversationId, clientOperationId };
}

describe('chat admission cancellation marker', () => {
  it('recognizes only the exact content-free terminal task marker', () => {
    const { task, clientOperationId } = tombstone();
    expect(chatAdmissionCancellationPayload(task)).toEqual({
      protocol: CHAT_ADMISSION_PROTOCOL,
      clientOperationId,
    });
    expect(isChatAdmissionCancellationProjection(task)).toBe(true);
    expect(chatAdmissionPayload(task)).toBeNull();
    expect(task.title).toBeNull();
    expect(task.plan).toBeNull();
    expect(task.state).toEqual({});
    expect(task.queueGeneration).toBe(0);
    expect(task.budgetUsdLimit).toBe('0.5000');
  });

  it.each([
    ['nonterminal status', { status: 'running' }],
    ['content-bearing title', { title: 'owner prompt' }],
    ['content-bearing payload', { trigger: { source: 'chat', payload: { text: 'owner prompt' } } }],
    ['wrong operation key', { externalEventId: 'chat-admission:other' }],
    ['wrong trust', { trust: 'assistant' }],
    ['nonempty deadline', { deadline: new Date('2026-10-08T12:00:00.000Z') }],
    ['nondefault budget', { budgetUsdLimit: '1.00' }],
  ])('rejects malformed %s rows', (_label, patch) => {
    const { task } = tombstone();
    expect(chatAdmissionCancellationPayload({ ...task, ...patch } as Records['tasks'])).toBeNull();
    if (
      _label !== 'content-bearing title' &&
      _label !== 'content-bearing payload' &&
      _label !== 'nonempty deadline' &&
      _label !== 'nondefault budget'
    )
      expect(isChatAdmissionCancellationProjection({ ...task, ...patch })).toBe(false);
  });

  it('rejects additional fields beside an otherwise valid cancellation marker', () => {
    const { task } = tombstone();
    const trigger = task.trigger as Record<string, unknown>;
    const payload = trigger.payload as Record<string, unknown>;
    expect(
      chatAdmissionCancellationPayload({
        ...task,
        trigger: { ...trigger, payload: { ...payload, text: 'must not be stored' } },
      } as Records['tasks']),
    ).toBeNull();
  });

  it.each([null, 123, 'owner text that must never become an operation key'])(
    'requires a string UUID operation identity',
    (clientOperationId) => {
      expect(() =>
        chatAdmissionCancellationTrigger({
          agentId: randomUUID(),
          conversationId: randomUUID(),
          clientOperationId: clientOperationId as string,
        }),
      ).toThrow('Invalid chat admission cancellation identity');
    },
  );
});
