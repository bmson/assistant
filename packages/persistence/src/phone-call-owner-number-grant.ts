import { createHash } from 'node:crypto';
import { chatAdmissionExternalEventId, chatAdmissionPayload } from './chat-admission.js';
import { parseExactTimestamp } from './exact-timestamp.js';
import {
  type OwnerPhoneRecipientRequest,
  ownerPhoneRecipientRequest,
} from './phone-call-owner-intent.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_REVIEW_SOURCE_BYTES = 16 * 1024;

/** Exact stored authorization for calls to the exact number explicitly reviewed by the owner. */
export interface PhoneCallToOwnerNumberGrantMatch {
  schemaVersion: 1;
  grantId: string;
  recipientE164: string;
  maxMinutes: number;
  expiresAt: string;
}

export interface ExpectedPhoneCallOwnerNumberGrantBinding {
  policyId: string;
  match: PhoneCallToOwnerNumberGrantMatch;
  directOwnerRequest: DirectOwnerCallRequestBinding;
  recipientAuthority:
    | { kind: 'explicit_number'; recipientE164: string }
    | { kind: 'configured_owner_phone'; recipientE164: string; fingerprint: string };
}

export interface PhoneCallOwnerNumberGrantFinalizationBinding {
  expectedApprovalId: string;
  expectedAgentId: string;
  expectedTaskId: string;
  expectedToolCallId: string;
  sourceArgsFingerprint: string;
  reviewIssuedAt: string;
  reviewExpiresAt: string;
  validityDays: 1 | 7 | 30;
  directOwnerRequest: DirectOwnerCallRequestBinding;
  match: PhoneCallToOwnerNumberGrantMatch;
}

function canonicalReviewSource(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error('Call review source is too deeply nested');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error('Call review source is too large');
    return value.map((item) => canonicalReviewSource(item, depth + 1));
  }
  if (typeof value !== 'object') throw new Error('Call review source is not JSON');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Call review source is not a plain object');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw new Error('Call review source is too large');
  return Object.fromEntries(
    entries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalReviewSource(child, depth + 1)]),
  );
}

/** Bounded, property-order-independent fingerprint for the reviewed tool args. */
export function phoneCallOwnerNumberReviewSourceFingerprint(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(canonicalReviewSource(value));
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REVIEW_SOURCE_BYTES) return null;
    return createHash('sha256').update(serialized, 'utf8').digest('hex');
  } catch {
    return null;
  }
}

/** Shared repository-side validation for the one-time review token. */
export function phoneCallOwnerNumberGrantFinalizationMatches(
  expected: PhoneCallOwnerNumberGrantFinalizationBinding,
  current: {
    approvalId: string;
    approvalStatus: string;
    approvalExpiresAt: Date;
    agentId: string;
    approvalTaskId: string;
    approvalToolCallId: string;
    taskId: string;
    taskAgentId: string;
    taskTrust: string;
    taskStatus: string;
    toolCallId: string;
    toolTaskId: string;
    toolApprovalId: string | null;
    toolName: string;
    toolStatus: string;
    toolArgs: unknown;
    approvalPayload: unknown;
    directOwnerRequest: DirectOwnerCallRequestBinding | null;
  },
  repositoryNow: Date,
): boolean {
  if (
    !expected ||
    !(repositoryNow instanceof Date) ||
    !Number.isFinite(repositoryNow.getTime()) ||
    current.agentId !== current.taskAgentId ||
    current.approvalId !== expected.expectedApprovalId ||
    current.approvalStatus !== 'pending' ||
    !(current.approvalExpiresAt instanceof Date) ||
    !Number.isFinite(current.approvalExpiresAt.getTime()) ||
    current.approvalExpiresAt <= repositoryNow ||
    current.agentId !== expected.expectedAgentId ||
    current.approvalTaskId !== expected.expectedTaskId ||
    current.approvalToolCallId !== expected.expectedToolCallId ||
    current.taskId !== expected.expectedTaskId ||
    !sameDirectOwnerCallRequestBinding(expected.directOwnerRequest, current.directOwnerRequest) ||
    current.taskTrust !== 'owner' ||
    current.taskStatus !== 'waiting_approval' ||
    current.toolCallId !== expected.expectedToolCallId ||
    current.toolTaskId !== expected.expectedTaskId ||
    current.toolApprovalId !== expected.expectedApprovalId ||
    current.toolName !== 'phone.call' ||
    current.toolStatus !== 'awaiting_approval' ||
    !/^[a-f0-9]{64}$/.test(expected.sourceArgsFingerprint)
  )
    return false;
  const issuedAt = Date.parse(expected.reviewIssuedAt);
  const reviewExpiresAt = Date.parse(expected.reviewExpiresAt);
  const match = parsePhoneCallToOwnerNumberGrantMatch(expected.match);
  const sourceFingerprint = phoneCallOwnerNumberReviewSourceFingerprint(current.toolArgs);
  const approvalFingerprint = phoneCallOwnerNumberReviewSourceFingerprint(current.approvalPayload);
  const args = current.toolArgs;
  const brief =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { brief?: unknown }).brief
      : null;
  if (
    !match ||
    ![1, 7, 30].includes(expected.validityDays) ||
    !Number.isFinite(issuedAt) ||
    issuedAt > repositoryNow.getTime() ||
    !Number.isFinite(reviewExpiresAt) ||
    reviewExpiresAt !== issuedAt + 10 * 60_000 ||
    match.expiresAt !==
      new Date(issuedAt + expected.validityDays * 24 * 60 * 60_000).toISOString() ||
    reviewExpiresAt <= repositoryNow.getTime() ||
    !phoneCallToOwnerNumberGrantIsLive(match, repositoryNow) ||
    sourceFingerprint !== expected.sourceArgsFingerprint ||
    approvalFingerprint !== expected.sourceArgsFingerprint ||
    !brief ||
    !phoneCallToOwnerNumberGrantMatches(match, brief as { to: unknown; maxMinutes: unknown }) ||
    (brief as { maxMinutes?: unknown }).maxMinutes !== match.maxMinutes
  )
    return false;
  return true;
}

/**
 * Validate the persisted `match` as a protocol record. Unknown keys and values
 * are rejected so later/template-specific fields cannot silently widen scope.
 */
export function parsePhoneCallToOwnerNumberGrantMatch(
  value: unknown,
): PhoneCallToOwnerNumberGrantMatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== 'expiresAt' ||
    keys[1] !== 'grantId' ||
    keys[2] !== 'maxMinutes' ||
    keys[3] !== 'recipientE164' ||
    keys[4] !== 'schemaVersion' ||
    row.schemaVersion !== 1 ||
    typeof row.grantId !== 'string' ||
    !UUID.test(row.grantId) ||
    typeof row.recipientE164 !== 'string' ||
    !E164.test(row.recipientE164) ||
    typeof row.maxMinutes !== 'number' ||
    !Number.isSafeInteger(row.maxMinutes) ||
    row.maxMinutes <= 0 ||
    typeof row.expiresAt !== 'string'
  )
    return null;
  try {
    parseExactTimestamp(row.expiresAt);
  } catch {
    return null;
  }
  return {
    schemaVersion: 1,
    grantId: row.grantId,
    recipientE164: row.recipientE164,
    maxMinutes: row.maxMinutes,
    expiresAt: row.expiresAt,
  };
}

/** The stored scope covers only this exact number and no longer call. */
export function phoneCallToOwnerNumberGrantMatches(
  grant: PhoneCallToOwnerNumberGrantMatch,
  brief: { to?: unknown; maxMinutes?: unknown },
): boolean {
  return (
    brief.to === grant.recipientE164 &&
    typeof brief.maxMinutes === 'number' &&
    Number.isSafeInteger(brief.maxMinutes) &&
    brief.maxMinutes > 0 &&
    brief.maxMinutes <= grant.maxMinutes
  );
}

/** Equality with expiry is expired; call sites supply the repository clock. */
export function phoneCallToOwnerNumberGrantIsLive(
  grant: PhoneCallToOwnerNumberGrantMatch,
  repositoryNow: Date,
): boolean {
  return (
    repositoryNow instanceof Date &&
    Number.isFinite(repositoryNow.getTime()) &&
    Date.parse(grant.expiresAt) > repositoryNow.getTime()
  );
}

/** Confirm the exact selected C policy row is still active and covers this call. */
export function phoneCallOwnerNumberGrantBindingMatches(
  expected: ExpectedPhoneCallOwnerNumberGrantBinding,
  row: {
    id: string;
    agentId: string;
    toolName: string;
    templateKey: string;
    effect: string;
    enabled: boolean;
    match: unknown;
  } | null,
  agentId: string,
  brief: { to?: unknown; maxMinutes?: unknown },
  repositoryNow: Date,
  configuredOwnerPhoneFingerprint: string | null = null,
): boolean {
  const recipientAuthority = expected.recipientAuthority;
  if (!recipientAuthority || recipientAuthority.recipientE164 !== expected.match.recipientE164)
    return false;
  const authorityKeys = Object.keys(recipientAuthority).sort().join(',');
  if (recipientAuthority.kind === 'explicit_number') {
    if (
      authorityKeys !== 'kind,recipientE164' ||
      expected.directOwnerRequest.recipientRequest?.kind !== 'explicit_number' ||
      expected.directOwnerRequest.recipientRequest.recipientE164 !==
        recipientAuthority.recipientE164
    )
      return false;
  } else if (recipientAuthority.kind === 'configured_owner_phone') {
    if (
      expected.directOwnerRequest.recipientRequest?.kind !== 'owner_self' ||
      authorityKeys !== 'fingerprint,kind,recipientE164' ||
      !/^[a-f0-9]{64}$/.test(recipientAuthority.fingerprint) ||
      configuredOwnerPhoneFingerprint !== recipientAuthority.fingerprint
    )
      return false;
  } else return false;
  if (!row || row.id !== expected.policyId || row.agentId !== agentId) return false;
  if (
    row.toolName !== 'phone.call' ||
    row.templateKey !== 'phone.call.to_owner_number.v1' ||
    row.effect !== 'allow' ||
    row.enabled !== true
  )
    return false;
  const persisted = parsePhoneCallToOwnerNumberGrantMatch(row.match);
  const captured = parsePhoneCallToOwnerNumberGrantMatch(expected.match);
  if (
    !persisted ||
    !captured ||
    persisted.grantId !== captured.grantId ||
    persisted.recipientE164 !== captured.recipientE164 ||
    persisted.maxMinutes !== captured.maxMinutes ||
    persisted.expiresAt !== captured.expiresAt
  )
    return false;
  return (
    phoneCallToOwnerNumberGrantIsLive(persisted, repositoryNow) &&
    phoneCallToOwnerNumberGrantMatches(persisted, brief)
  );
}

export interface DirectOwnerCallRequestBinding {
  recipientRequest: OwnerPhoneRecipientRequest | null;
  agentId: string;
  taskId: string;
  conversationId: string;
  ownerMessageId: string;
  requestHash: string;
  clientOperationId: string;
  taskTriggerFingerprint: string;
  ownerMessageFingerprint: string;
}

/** Derive provenance only from the server's admitted task and owner message. */
export function directOwnerCallRequestBinding(
  task: {
    id: string;
    agentId: string;
    conversationId: string | null;
    trust: string;
    type: string;
    status: string;
    externalEventId: string | null;
    trigger: unknown;
  },
  conversation: { id: string; agentId: string } | null,
  message: {
    id: string;
    conversationId: string;
    taskId: string | null;
    role: string;
    origin: string;
    text: string;
    hiddenAt: unknown;
  } | null,
  requiredStatus: 'running' | 'waiting_approval' = 'running',
): DirectOwnerCallRequestBinding | null {
  const trigger = task.trigger as {
    source?: unknown;
    agentId?: unknown;
    conversationId?: unknown;
    trust?: unknown;
    payload?: {
      text?: unknown;
      triggerMessageId?: unknown;
      chatAdmission?: {
        protocol?: unknown;
        triggerMessageId?: unknown;
        clientOperationId?: unknown;
        requestHash?: unknown;
      };
    };
  } | null;
  const admission = chatAdmissionPayload(task);
  if (
    task.type !== 'chat_turn' ||
    (requiredStatus !== 'running' && requiredStatus !== 'waiting_approval') ||
    task.status !== requiredStatus ||
    task.trust !== 'owner' ||
    !conversation ||
    !message ||
    conversation.agentId !== task.agentId ||
    conversation.id !== task.conversationId ||
    trigger?.source !== 'chat' ||
    trigger.agentId !== task.agentId ||
    trigger.conversationId !== conversation.id ||
    trigger.trust !== 'owner' ||
    !admission ||
    typeof admission.clientOperationId !== 'string' ||
    !UUID.test(admission.clientOperationId) ||
    task.externalEventId !==
      chatAdmissionExternalEventId({
        agentId: task.agentId,
        conversationId: conversation.id,
        clientOperationId: admission.clientOperationId,
      }) ||
    typeof admission.requestHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(admission.requestHash) ||
    admission.triggerMessageId !== message.id ||
    trigger.payload?.triggerMessageId !== message.id ||
    message.taskId !== task.id ||
    message.conversationId !== conversation.id ||
    message.role !== 'user' ||
    message.origin !== 'owner' ||
    message.hiddenAt != null ||
    typeof message.text !== 'string' ||
    !message.text.trim() ||
    trigger.payload.text !== message.text
  )
    return null;
  const taskTriggerFingerprint = phoneCallOwnerNumberReviewSourceFingerprint(task.trigger);
  const ownerMessageFingerprint = phoneCallOwnerNumberReviewSourceFingerprint({
    id: message.id,
    text: message.text,
  });
  if (!taskTriggerFingerprint || !ownerMessageFingerprint) return null;
  return {
    agentId: task.agentId,
    taskId: task.id,
    conversationId: conversation.id,
    ownerMessageId: message.id,
    requestHash: admission.requestHash,
    clientOperationId: admission.clientOperationId,
    taskTriggerFingerprint,
    ownerMessageFingerprint,
    recipientRequest: ownerPhoneRecipientRequest(message.text),
  };
}

export function sameDirectOwnerCallRequestBinding(
  expected: DirectOwnerCallRequestBinding,
  actual: DirectOwnerCallRequestBinding | null,
): boolean {
  return Boolean(
    actual &&
      phoneCallOwnerNumberReviewSourceFingerprint(expected) ===
        phoneCallOwnerNumberReviewSourceFingerprint(actual),
  );
}
