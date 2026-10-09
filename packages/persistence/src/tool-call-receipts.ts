import { createHash } from 'node:crypto';
import type { Records } from './records.js';

export type ToolCallEffectOutcome = 'completed' | 'failed' | 'unknown' | 'not_executed';
export type ToolCallReceiptKeyKind = 'model_tool_call' | 'idempotency';

const MAX_REPLAY_IDENTITY_BYTES = 1000;
const SHA256 = /^[a-f0-9]{64}$/;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validIdentity(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_REPLAY_IDENTITY_BYTES;
}

/** Owner/task-bound digest of an untrusted model call id; never persist its raw value in a key. */
export function modelToolCallIdentityDigest(
  agentId: string,
  taskId: string,
  modelToolCallId: string,
): string | null {
  if (!agentId || !taskId || !validIdentity(modelToolCallId)) return null;
  return digest(
    JSON.stringify(['assistant-tool-replay-v1', 'model', agentId, taskId, modelToolCallId]),
  );
}

/** Global digest preserves the installation-wide uniqueness of idempotency keys. */
export function idempotencyIdentityDigest(idempotencyKey: string): string | null {
  if (!validIdentity(idempotencyKey)) return null;
  return digest(JSON.stringify(['assistant-tool-replay-v1', 'idempotency', idempotencyKey]));
}

export function toolCallReceiptKeyId(kind: ToolCallReceiptKeyKind, digestValue: string): string {
  if (!SHA256.test(digestValue)) throw new Error('Invalid tool call receipt digest');
  return digest(JSON.stringify(['assistant-tool-receipt-key-v1', kind, digestValue]));
}

export function toolCallReceiptKey(input: {
  agentId: string;
  taskId: string;
  receiptId: string;
  kind: ToolCallReceiptKeyKind;
  digest: string;
}): Records['toolCallReceiptKeys'] {
  return { ...input, id: toolCallReceiptKeyId(input.kind, input.digest) };
}

export function toolCallReplayKeysForStart(input: {
  agentId: string;
  taskId: string;
  toolCallId: string;
  modelToolCallId?: unknown;
  idempotencyKey?: string | null;
}): Records['toolCallReceiptKeys'][] | null {
  const keys: Records['toolCallReceiptKeys'][] = [];
  if (typeof input.modelToolCallId === 'string') {
    const value = modelToolCallIdentityDigest(input.agentId, input.taskId, input.modelToolCallId);
    if (!value) return null;
    keys.push(
      toolCallReceiptKey({
        agentId: input.agentId,
        taskId: input.taskId,
        receiptId: input.toolCallId,
        kind: 'model_tool_call',
        digest: value,
      }),
    );
  }
  if (input.idempotencyKey !== null && input.idempotencyKey !== undefined) {
    const value = idempotencyIdentityDigest(input.idempotencyKey);
    if (!value) return null;
    keys.push(
      toolCallReceiptKey({
        agentId: input.agentId,
        taskId: input.taskId,
        receiptId: input.toolCallId,
        kind: 'idempotency',
        digest: value,
      }),
    );
  }
  return keys;
}

export function classifyToolCallEffectOutcome(
  toolCall: Pick<Records['toolCalls'], 'status' | 'result' | 'error'>,
): ToolCallEffectOutcome | null {
  if (toolCall.status === 'succeeded') {
    const result = toolCall.result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const receipt = result as Record<string, unknown>;
      if (
        receipt.deliveryStatus === 'unknown' ||
        receipt.retrySuppressed === true ||
        receipt.effectStatus === 'unknown'
      )
        return 'unknown';
    }
    return 'completed';
  }
  if (toolCall.status === 'denied') return 'not_executed';
  if (toolCall.status === 'failed') {
    return toolCall.error?.toLowerCase().includes('provider outcome is unknown')
      ? 'unknown'
      : 'failed';
  }
  return null;
}

export function compactToolCallReceipt(
  toolCall: Records['toolCalls'],
  input: { agentId: string; recordedAt: Date },
): Records['toolCallReceipts'] | null {
  const effectOutcome = classifyToolCallEffectOutcome(toolCall);
  if (!effectOutcome || !toolCall.id || !toolCall.taskId || !input.agentId) return null;
  const decision =
    toolCall.decision && typeof toolCall.decision === 'object' && !Array.isArray(toolCall.decision)
      ? (toolCall.decision as Record<string, unknown>)
      : null;
  const modelToolCallId = decision?.modelToolCallId;
  const idempotencyKey = toolCall.idempotencyKey;
  const hasModelToolCallId = Boolean(decision && Object.hasOwn(decision, 'modelToolCallId'));
  const hasIdempotencyKey = idempotencyKey !== null && idempotencyKey !== undefined;
  if (
    (hasModelToolCallId && typeof modelToolCallId !== 'string') ||
    (hasIdempotencyKey && typeof idempotencyKey !== 'string')
  )
    return null;
  const modelToolCallIdHash =
    typeof modelToolCallId === 'string'
      ? modelToolCallIdentityDigest(input.agentId, toolCall.taskId, modelToolCallId)
      : null;
  const idempotencyKeyHash =
    typeof idempotencyKey === 'string' ? idempotencyIdentityDigest(idempotencyKey) : null;
  // If any existing replay identity is malformed/oversized, keep the full row. It is safer to
  // retain the private payload than to erase the only durable anti-replay key.
  if ((hasModelToolCallId && !modelToolCallIdHash) || (hasIdempotencyKey && !idempotencyKeyHash))
    return null;
  return {
    id: toolCall.id,
    agentId: input.agentId,
    taskId: toolCall.taskId,
    toolCallId: toolCall.id,
    modelToolCallIdHash,
    idempotencyKeyHash,
    toolName: toolCall.toolName,
    effectOutcome,
    recordedAt: input.recordedAt,
  };
}

export function toolCallReceiptKeysForReceipt(
  receipt: Records['toolCallReceipts'],
): Records['toolCallReceiptKeys'][] {
  const keys: Records['toolCallReceiptKeys'][] = [];
  if (receipt.modelToolCallIdHash)
    keys.push(
      toolCallReceiptKey({
        agentId: receipt.agentId,
        taskId: receipt.taskId,
        receiptId: receipt.id,
        kind: 'model_tool_call',
        digest: receipt.modelToolCallIdHash,
      }),
    );
  if (receipt.idempotencyKeyHash)
    keys.push(
      toolCallReceiptKey({
        agentId: receipt.agentId,
        taskId: receipt.taskId,
        receiptId: receipt.id,
        kind: 'idempotency',
        digest: receipt.idempotencyKeyHash,
      }),
    );
  return keys;
}
