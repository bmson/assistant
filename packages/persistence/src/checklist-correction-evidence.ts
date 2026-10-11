import type { Records } from './records.js';
import { classifyToolCallEffectOutcome } from './tool-call-receipts.js';

/** Per-collection read bound; both adapters query limit + 1 in the same transaction. */
export const MAX_CHECKLIST_CORRECTION_LEDGER_ROWS = 128;

export type ChecklistCorrectionLedgerCall = Pick<
  Records['toolCalls'],
  'id' | 'taskId' | 'toolName' | 'status' | 'result' | 'error'
>;

export type ChecklistCorrectionLedgerReceipt = Pick<
  Records['toolCallReceipts'],
  'id' | 'agentId' | 'taskId' | 'toolCallId' | 'toolName' | 'effectOutcome'
>;

export interface CompleteChecklistCorrectionEvidence {
  complete: true;
  rows: Array<{
    id: string;
    toolName: string;
    status: string;
    effectOutcome: Records['toolCallReceipts']['effectOutcome'];
    args?: unknown;
    result?: unknown;
  }>;
}

/**
 * Join the complete bounded transactional tool-call and retained-receipt reads.
 * Pending dispatches, inconsistent identities, malformed rows, and unknown
 * effect outcomes fail closed. A retained receipt may outlive its tool-call row.
 */
export function completeChecklistCorrectionEvidence(input: {
  agentId: string;
  taskId: string;
  toolCalls: readonly ChecklistCorrectionLedgerCall[];
  receipts: readonly ChecklistCorrectionLedgerReceipt[];
}): CompleteChecklistCorrectionEvidence | null {
  const { agentId, taskId, toolCalls, receipts } = input;
  if (
    !agentId ||
    !taskId ||
    toolCalls.length > MAX_CHECKLIST_CORRECTION_LEDGER_ROWS ||
    receipts.length > MAX_CHECKLIST_CORRECTION_LEDGER_ROWS
  )
    return null;

  const calls = new Map<string, ChecklistCorrectionLedgerCall>();
  for (const call of toolCalls) {
    if (
      !call.id ||
      call.id.length > 128 ||
      call.taskId !== taskId ||
      !call.toolName ||
      call.toolName.length > 128 ||
      calls.has(call.id) ||
      !['succeeded', 'failed', 'denied'].includes(call.status)
    )
      return null;
    calls.set(call.id, call);
  }

  const receiptByCall = new Map<string, ChecklistCorrectionLedgerReceipt>();
  for (const receipt of receipts) {
    if (
      !receipt.id ||
      receipt.id.length > 128 ||
      receipt.agentId !== agentId ||
      receipt.taskId !== taskId ||
      !receipt.toolCallId ||
      receipt.toolCallId.length > 128 ||
      receipt.id !== receipt.toolCallId ||
      !receipt.toolName ||
      receipt.toolName.length > 128 ||
      receiptByCall.has(receipt.toolCallId)
    )
      return null;
    const call = calls.get(receipt.toolCallId);
    if (call && call.toolName !== receipt.toolName) return null;
    receiptByCall.set(receipt.toolCallId, receipt);
  }

  const rows: CompleteChecklistCorrectionEvidence['rows'] = [];
  for (const call of toolCalls) {
    const receipt = receiptByCall.get(call.id);
    const classified = classifyToolCallEffectOutcome(call);
    if (receipt && classified && receipt.effectOutcome !== 'unknown') {
      const failedBeforeEffect =
        (call.status === 'failed' || call.status === 'denied') &&
        receipt.effectOutcome === 'not_executed';
      if (receipt.effectOutcome !== classified && !failedBeforeEffect) return null;
    }
    const effectOutcome = receipt?.effectOutcome ?? classified;
    if (!effectOutcome || effectOutcome === 'unknown') return null;
    rows.push({
      id: call.id,
      toolName: call.toolName,
      status: call.status,
      effectOutcome,
      result: call.result,
    });
  }

  for (const receipt of receipts) {
    if (calls.has(receipt.toolCallId)) continue;
    if (receipt.effectOutcome === 'unknown') return null;
    rows.push({
      id: receipt.toolCallId,
      toolName: receipt.toolName,
      status: 'compacted',
      effectOutcome: receipt.effectOutcome,
    });
  }

  return rows.length <= MAX_CHECKLIST_CORRECTION_LEDGER_ROWS * 2 ? { complete: true, rows } : null;
}
