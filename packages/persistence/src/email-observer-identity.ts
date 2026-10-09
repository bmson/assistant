import { createHash } from 'node:crypto';

function stableUuid(namespace: string, parts: readonly string[]): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([namespace, ...parts]))
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function emailObserverSourceKey(providerMessageId: string): string {
  return `gmail:${providerMessageId}`;
}

export function emailObserverWorkId(
  agentId: string,
  sourceKey: string,
  observerKey: string,
  observerVersion: number,
): string {
  return stableUuid('assistant:email-observer-work:v1', [
    agentId,
    sourceKey,
    observerKey,
    String(observerVersion),
  ]);
}

export function emailObserverSourceId(agentId: string, sourceKey: string): string {
  return stableUuid('assistant:email-observer-source:v1', [agentId, sourceKey]);
}

export function emailObserverBudgetId(
  agentId: string,
  observerKey: string,
  utcWindowStart: Date,
): string {
  return stableUuid('assistant:email-observer-budget:v1', [
    agentId,
    observerKey,
    utcWindowStart.toISOString(),
  ]);
}

export function emailObserverDeliveryKey(
  agentId: string,
  sourceKey: string,
  observerKey: string,
  observerVersion: number,
): string {
  return `email-observer:${stableUuid('assistant:email-observer-delivery:v1', [
    agentId,
    sourceKey,
    observerKey,
    String(observerVersion),
  ])}`;
}
