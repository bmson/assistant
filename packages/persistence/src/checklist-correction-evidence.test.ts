import { describe, expect, it } from 'vitest';
import {
  completeChecklistCorrectionEvidence,
  MAX_CHECKLIST_CORRECTION_LEDGER_ROWS,
} from './checklist-correction-evidence.js';

const agentId = 'owner-1';
const taskId = 'task-1';

function call(
  input: Partial<
    Parameters<typeof completeChecklistCorrectionEvidence>[0]['toolCalls'][number]
  > = {},
) {
  return {
    id: 'call-1',
    taskId,
    toolName: 'calendar.list_events',
    status: 'succeeded',
    result: { events: [] },
    error: null,
    ...input,
  };
}

function receipt(
  input: Partial<
    Parameters<typeof completeChecklistCorrectionEvidence>[0]['receipts'][number]
  > = {},
) {
  return {
    id: 'call-1',
    agentId,
    taskId,
    toolCallId: 'call-1',
    toolName: 'calendar.list_events',
    effectOutcome: 'completed' as const,
    ...input,
  };
}

describe('complete checklist correction evidence', () => {
  it('joins a complete successful call and its retained receipt once', () => {
    expect(
      completeChecklistCorrectionEvidence({
        agentId,
        taskId,
        toolCalls: [call()],
        receipts: [receipt()],
      }),
    ).toMatchObject({ complete: true, rows: [{ id: 'call-1', effectOutcome: 'completed' }] });
  });

  it('retains a completed compact receipt after the detailed call row is gone', () => {
    expect(
      completeChecklistCorrectionEvidence({
        agentId,
        taskId,
        toolCalls: [],
        receipts: [receipt()],
      }),
    ).toMatchObject({
      complete: true,
      rows: [{ id: 'call-1', status: 'compacted', effectOutcome: 'completed' }],
    });
  });

  it('refuses a pending, executing, or unclassified dispatch rather than calling it no-effect', () => {
    for (const status of ['proposed', 'awaiting_approval', 'approved', 'executing']) {
      expect(
        completeChecklistCorrectionEvidence({
          agentId,
          taskId,
          toolCalls: [call({ status })],
          receipts: [],
        }),
      ).toBeNull();
    }
  });

  it('fails closed on unknown and contradictory outcomes or foreign receipt identity', () => {
    expect(
      completeChecklistCorrectionEvidence({
        agentId,
        taskId,
        toolCalls: [call({ result: { deliveryStatus: 'unknown' } })],
        receipts: [receipt({ effectOutcome: 'completed' })],
      }),
    ).toBeNull();
    expect(
      completeChecklistCorrectionEvidence({
        agentId,
        taskId,
        toolCalls: [],
        receipts: [receipt({ effectOutcome: 'unknown' })],
      }),
    ).toBeNull();
    expect(
      completeChecklistCorrectionEvidence({
        agentId,
        taskId,
        toolCalls: [],
        receipts: [receipt({ agentId: 'foreign-owner' })],
      }),
    ).toBeNull();
  });

  it('rejects incomplete or over-bound snapshots before returning an attested shape', () => {
    const calls = Array.from({ length: MAX_CHECKLIST_CORRECTION_LEDGER_ROWS + 1 }, (_, index) =>
      call({ id: `call-${index}` }),
    );
    expect(
      completeChecklistCorrectionEvidence({ agentId, taskId, toolCalls: calls, receipts: [] }),
    ).toBeNull();
    expect(
      completeChecklistCorrectionEvidence({
        agentId,
        taskId,
        toolCalls: [call({ status: 'failed', error: 'provider outcome is unknown' })],
        receipts: [],
      }),
    ).toBeNull();
  });
});
