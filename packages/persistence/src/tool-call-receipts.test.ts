import { describe, expect, it } from 'vitest';
import type { Records } from './records.js';
import {
  compactToolCallReceipt,
  idempotencyIdentityDigest,
  modelToolCallIdentityDigest,
} from './tool-call-receipts.js';

const recordedAt = new Date('2026-10-01T00:00:00.000Z');

describe('compact tool call receipts', () => {
  it('keeps model replay identities task-scoped and idempotency identities global', () => {
    expect(modelToolCallIdentityDigest('owner', 'task-a', 'call-1')).not.toBe(
      modelToolCallIdentityDigest('owner', 'task-b', 'call-1'),
    );
    expect(idempotencyIdentityDigest('effect-1')).toBe(idempotencyIdentityDigest('effect-1'));
  });

  it('retains only bounded replay digests and a truthful terminal outcome', () => {
    const receipt = compactToolCallReceipt(
      {
        id: 'tool-call-1',
        taskId: 'task-1',
        toolName: 'gmail.send',
        status: 'succeeded',
        args: { body: 'private email body' },
        result: { providerMessageId: 'private-provider-id' },
        error: null,
        decision: { modelToolCallId: 'untrusted model id' },
        idempotencyKey: 'global-effect-1',
      } as never,
      { agentId: 'owner', recordedAt },
    );

    expect(receipt).toMatchObject({
      id: 'tool-call-1',
      agentId: 'owner',
      taskId: 'task-1',
      toolCallId: 'tool-call-1',
      effectOutcome: 'completed',
      recordedAt,
    });
    expect(receipt?.modelToolCallIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt?.idempotencyKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain('private email body');
    expect(JSON.stringify(receipt)).not.toContain('providerMessageId');
    expect(JSON.stringify(receipt)).not.toContain('untrusted model id');
  });

  it('refuses to compact ambiguous execution and malformed identity states', () => {
    const base = {
      id: 'tool-call-1',
      taskId: 'task-1',
      toolName: 'gmail.send',
      status: 'executing',
      decision: {},
      idempotencyKey: null,
    } as unknown as Records['toolCalls'];
    expect(compactToolCallReceipt(base, { agentId: 'owner', recordedAt })).toBeNull();
    expect(
      compactToolCallReceipt(
        {
          ...base,
          status: 'succeeded',
          decision: { modelToolCallId: 17 },
        } as Records['toolCalls'],
        { agentId: 'owner', recordedAt },
      ),
    ).toBeNull();
    expect(
      compactToolCallReceipt(
        {
          ...base,
          status: 'succeeded',
          idempotencyKey: '',
        } as Records['toolCalls'],
        { agentId: 'owner', recordedAt },
      ),
    ).toBeNull();
  });

  it('records unknown provider outcomes without claiming completion', () => {
    const receipt = compactToolCallReceipt(
      {
        id: 'tool-call-2',
        taskId: 'task-1',
        toolName: 'twilio.send',
        status: 'failed',
        error: 'the provider outcome is unknown; the call was not retried',
        decision: {},
        idempotencyKey: null,
      } as never,
      { agentId: 'owner', recordedAt },
    );
    expect(receipt?.effectOutcome).toBe('unknown');
    const failed = compactToolCallReceipt(
      {
        id: 'tool-call-3',
        taskId: 'task-1',
        toolName: 'browser.execute',
        status: 'failed',
        error: 'synthetic pre-effect validation failure',
        decision: {},
        idempotencyKey: null,
      } as never,
      { agentId: 'owner', recordedAt },
    );
    expect(failed?.effectOutcome).toBe('failed');
    const denied = compactToolCallReceipt(
      {
        id: 'tool-call-4',
        taskId: 'task-1',
        toolName: 'gmail.send',
        status: 'denied',
        error: 'owner denied before execution',
        decision: {},
        idempotencyKey: null,
      } as never,
      { agentId: 'owner', recordedAt },
    );
    expect(denied?.effectOutcome).toBe('not_executed');
  });
});
