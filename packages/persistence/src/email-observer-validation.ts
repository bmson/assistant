import { Buffer } from 'node:buffer';
import {
  type EmailAttachmentPreparedResult,
  emailAttachmentManifestDigest,
} from './email-attachment-custody.js';

const MAX_RESULT_BYTES = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODES = new Set([
  'observer_error',
  'email_source_missing',
  'observer_handler_missing',
  'observer_threw',
  'attachment_client_missing',
  'attachment_ingest_retryable',
  'email_card_effect_unknown',
  'voice_embedding_unavailable',
  'voice_embedding_unknown',
  'voice_result_invalid',
  'voice_sample_write_unknown',
  'email_observer_budget_blocked',
]);

export function isValidEmailAttachmentPreparedResult(
  value: unknown,
): value is EmailAttachmentPreparedResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 3 &&
    Object.hasOwn(row, 'messageId') &&
    Object.hasOwn(row, 'manifestDigest') &&
    Object.hasOwn(row, 'entries') &&
    typeof row.messageId === 'string' &&
    row.messageId.length > 0 &&
    row.messageId.length <= 512 &&
    !Array.from(row.messageId).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    }) &&
    typeof row.manifestDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(row.manifestDigest) &&
    emailAttachmentManifestDigest(row.entries) === row.manifestDigest
  );
}

function boundedJson(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 20_000;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.length <= 2048 && value.every((item) => boundedJson(item, depth + 1));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 100 &&
    entries.every(([key, item]) => key.length <= 100 && boundedJson(item, depth + 1))
  );
}

/** Validate the bounded, replayable preparation shape for the registered observer. */
export function isValidEmailObserverPreparedResult(observerKey: string, value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value);
    if (
      !encoded ||
      Buffer.byteLength(encoded, 'utf8') > MAX_RESULT_BYTES ||
      !boundedJson(value) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      return false;
    const row = value as Record<string, unknown>;
    switch (observerKey) {
      case 'google.email-card':
        return (
          row.kind === 'generated-card' &&
          typeof row.id === 'string' &&
          UUID.test(row.id) &&
          typeof row.revisionId === 'string' &&
          UUID.test(row.revisionId) &&
          typeof row.sourceFingerprint === 'string' &&
          /^[a-f0-9]{64}$/.test(row.sourceFingerprint) &&
          ['evidence', 'answer', 'message'].includes(String(row.grounding)) &&
          !!row.spec &&
          typeof row.spec === 'object' &&
          !Array.isArray(row.spec) &&
          Array.isArray((row.spec as Record<string, unknown>).actions) &&
          !Object.hasOwn(row.spec as Record<string, unknown>, '_runtime')
        );
      case 'google.direct-email-routing':
        return (
          Object.keys(row).length === 1 &&
          ['application_confirmation', 'email_triage'].includes(String(row.route))
        );
      case 'google.application-confirmation':
      case 'watches.email-match':
        return Object.keys(row).length === 0;
      case 'google.email-attachments':
        return isValidEmailAttachmentPreparedResult(row);
      case 'google.owner-voice-sample':
        return (
          row.register === 'email_casual' &&
          row.context === 'inbound-email' &&
          (row.observedGeneration === null ||
            (typeof row.observedGeneration === 'string' && row.observedGeneration.length <= 128)) &&
          typeof row.embeddingSpaceKey === 'string' &&
          row.embeddingSpaceKey.length > 0 &&
          row.embeddingSpaceKey.length <= 512 &&
          Array.isArray(row.embedding) &&
          row.embedding.length > 0 &&
          row.embedding.length <= 2048 &&
          row.embedding.every((part) => typeof part === 'number' && Number.isFinite(part))
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

/** Prepared observer outputs are immutable once stored, including after retryable apply failure. */
export function sameEmailObserverPreparedResult(
  observerKey: string,
  left: unknown,
  right: unknown,
): boolean {
  if (
    !isValidEmailObserverPreparedResult(observerKey, left) ||
    !isValidEmailObserverPreparedResult(observerKey, right)
  )
    return false;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function emailObserverPreparedCardMatches(
  value: unknown,
  identity: {
    id: string;
    revisionId: string;
    sourceFingerprint: string;
    sourceLabel: string;
    spec: unknown;
  },
): boolean {
  if (
    !isValidEmailObserverPreparedResult('google.email-card', value) ||
    !identity.spec ||
    typeof identity.spec !== 'object' ||
    Array.isArray(identity.spec)
  )
    return false;
  const row = value as Record<string, unknown>;
  const preparedSpec = row.spec as Record<string, unknown>;
  const storedSpec = identity.spec as Record<string, unknown>;
  const actions = preparedSpec.actions;
  if (
    !Array.isArray(actions) ||
    storedSpec.refreshable !== false ||
    Object.hasOwn(storedSpec, '_runtime')
  )
    return false;
  const expectedSpec = {
    ...preparedSpec,
    refreshable: false,
    actions: actions.filter(
      (action) =>
        !action || typeof action !== 'object' || !('type' in action) || action.type !== 'refresh',
    ),
  };
  return (
    row.id === identity.id &&
    row.revisionId === identity.revisionId &&
    row.sourceFingerprint === identity.sourceFingerprint &&
    preparedSpec.sourceLabel === identity.sourceLabel &&
    JSON.stringify(canonical(expectedSpec)) === JSON.stringify(canonical(storedSpec))
  );
}

export function safeEmailObserverErrorCode(value: string | undefined): string | null {
  if (value === undefined) return null;
  return ERROR_CODES.has(value) ? value : 'observer_error';
}
