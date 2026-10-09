import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  emailObserverWorkId as canonicalEmailObserverWorkId,
  type EmailAttachmentManifestEntry,
  type EmailObserverEffectFence,
  type EmailObserverWorkRecord,
  emailAttachmentManifestDigest,
  emailObserverMessageBody,
  isValidEmailAttachmentPreparedResult,
  isValidEmailContentProvenanceSnapshot,
  matchesPreparedEmailObserverClaim,
  type Records,
} from '@assistant/persistence';
import { decodeRecord, type InstallationStore } from './store.js';

function emailIngestId(channelMessageId: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['email-ingest', channelMessageId]))
    .digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface CanonicalEmailAttachmentSource {
  ingest: Records['emailIngest'];
  message: Records['messages'];
  conversationId: string;
}

function validFrozenObserverRegistry(value: unknown): value is Array<{
  key: string;
  version: number;
  workClass: 'idempotent_db' | 'paid_ambiguous' | 'external_provider';
}> {
  if (!Array.isArray(value) || value.length > 40) return false;
  const normalized: Array<{
    key: string;
    version: number;
    workClass: 'idempotent_db' | 'paid_ambiguous' | 'external_provider';
  }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const keys = Object.keys(item).sort();
    if (keys.join(',') !== 'key,version,workClass') return false;
    const row = item as Record<string, unknown>;
    if (
      typeof row.key !== 'string' ||
      !row.key.trim() ||
      row.key.length > 160 ||
      !Number.isSafeInteger(row.version) ||
      (row.version as number) < 1 ||
      !['idempotent_db', 'paid_ambiguous', 'external_provider'].includes(String(row.workClass))
    )
      return false;
    normalized.push({
      key: row.key,
      version: row.version as number,
      workClass: row.workClass as 'idempotent_db' | 'paid_ambiguous' | 'external_provider',
    });
  }
  const sorted = [...normalized].sort(
    (left, right) => left.key.localeCompare(right.key) || left.version - right.version,
  );
  if (
    normalized.some(
      (row, index) =>
        index > 0 &&
        row.key === normalized[index - 1]?.key &&
        row.version === normalized[index - 1]?.version,
    ) ||
    JSON.stringify(normalized) !== JSON.stringify(sorted)
  )
    return false;
  return true;
}

/** Re-read the exact admitted owner message and provenance inside the caller's transaction. */
export async function readCanonicalEmailAttachmentSource(
  tx: FirebaseFirestore.Transaction,
  store: InstallationStore,
  agentId: string,
  channelMessageId: string,
  providerMessageId: string,
  observerWorkId: string,
): Promise<CanonicalEmailAttachmentSource | null> {
  if (
    !agentId ||
    !observerWorkId ||
    channelMessageId !== `gmail:${providerMessageId}` ||
    !providerMessageId
  )
    return null;
  const ingestRef = store.doc('emailIngest', emailIngestId(channelMessageId));
  const ingestSnapshot = await tx.get(ingestRef);
  if (!ingestSnapshot.exists) return null;
  const ingest = decodeRecord<Records['emailIngest']>(ingestSnapshot.data());
  const registry = ingest.observerRegistrySnapshot;
  if (
    ingest.agentId !== agentId ||
    ingest.providerMessageId !== providerMessageId ||
    ingest.channelMessageId !== channelMessageId ||
    ingest.admittedSourceKind !== 'message' ||
    typeof ingest.admittedSourceId !== 'string' ||
    !ingest.admittedSourceId ||
    !['direct', 'forwarded'].includes(ingest.ingestMode) ||
    !validFrozenObserverRegistry(registry) ||
    registry.length === 0 ||
    !registry.some((item) => item.key === 'google.email-attachments' && item.version === 3) ||
    !registry.some(
      (item) =>
        item.key === 'google.email-attachments' &&
        item.version === 3 &&
        item.workClass === 'idempotent_db',
    ) ||
    ingest.observerRegistryHash !==
      createHash('sha256').update(JSON.stringify(registry)).digest('hex') ||
    !isValidEmailContentProvenanceSnapshot(ingest.emailContentProvenance) ||
    ingest.emailContentProvenance.mode !== ingest.ingestMode ||
    ingest.emailContentProvenance.authenticated !== ingest.authenticated ||
    ingest.emailContentProvenance.hasExternalOrUnknown !== ingest.hasExternalOrUnknown
  )
    return null;
  if (
    canonicalEmailObserverWorkId(agentId, channelMessageId, 'google.email-attachments', 3) !==
    observerWorkId
  )
    return null;

  const channelRef = store.doc('messageChannelIds', channelMessageId);
  const channelSnapshot = await tx.get(channelRef);
  if (
    !channelSnapshot.exists ||
    channelSnapshot.get('messageId') !== ingest.admittedSourceId ||
    channelSnapshot.get('conversationId') !== ingest.conversationId
  )
    return null;
  const messageSnapshot = await tx.get(store.doc('messages', ingest.admittedSourceId));
  if (!messageSnapshot.exists) return null;
  const message = decodeRecord<Records['messages']>(messageSnapshot.data());
  if (
    message.id !== ingest.admittedSourceId ||
    message.role !== 'user' ||
    message.channelMessageId !== channelMessageId ||
    message.origin !== ingest.contentTrust ||
    message.hiddenAt ||
    message.conversationId !== ingest.conversationId
  )
    return null;
  const body = emailObserverMessageBody(message.parts);
  if (body === null || !body.trim()) return null;
  const prefix = `From: ${ingest.fromEmail}\nSubject: ${ingest.subject}\n\n`;
  if (
    !Array.isArray(message.parts) ||
    message.parts.length !== 1 ||
    message.parts[0]?.type !== 'text' ||
    message.parts[0].text !== body ||
    message.text !== prefix + body
  )
    return null;
  const provenance = ingest.emailContentProvenance;
  const hash = (value: string) =>
    createHash('sha256').update('assistant-email-content-v1\0').update(value).digest('hex');
  if (
    provenance.storedLength !== body.length ||
    provenance.prefixLength !== prefix.length ||
    provenance.sourceLength < provenance.storedLength ||
    (provenance.sourceLength === provenance.storedLength &&
      provenance.sourceHash !== provenance.bodyHash) ||
    !/^[a-f0-9]{64}$/.test(provenance.sourceHash) ||
    !Array.isArray(provenance.spans) ||
    provenance.spans.some(
      (span, index, spans) =>
        span.start < 0 ||
        span.end <= span.start ||
        span.end > body.length ||
        (index > 0 && spans[index - 1]?.end !== span.start),
    ) ||
    (body.length > 0 &&
      (provenance.spans[0]?.start !== 0 || provenance.spans.at(-1)?.end !== body.length)) ||
    provenance.bodyHash !== hash(body) ||
    provenance.messageHash !== hash(message.text)
  )
    return null;
  if (!ingest.conversationId) return null;
  const conversationSnapshot = await tx.get(store.doc('conversations', ingest.conversationId));
  if (
    !conversationSnapshot.exists ||
    conversationSnapshot.get('agentId') !== agentId ||
    conversationSnapshot.get('id') !== ingest.conversationId
  )
    return null;
  return { ingest, message, conversationId: ingest.conversationId };
}

export function emailAttachmentCustodySourceIndexId(
  agentId: string,
  observerWorkId: string,
  providerAttachmentId: string,
): string {
  return `email-attachment-source:${createHash('sha256')
    .update(JSON.stringify([agentId, observerWorkId, providerAttachmentId]))
    .digest('hex')}`;
}

export function exactPreparedEntry(
  fence: EmailObserverEffectFence,
  entry: EmailAttachmentManifestEntry,
  manifestDigest: string,
  channelMessageId: string,
  providerMessageId: string,
  work: EmailObserverWorkRecord,
  now: Date,
): boolean {
  const result: unknown = work.preparedResult;
  return (
    matchesPreparedEmailObserverClaim(work, fence, now) &&
    work.observerKey === 'google.email-attachments' &&
    work.observerVersion === 3 &&
    work.workClass === 'idempotent_db' &&
    work.sourceKind === 'message' &&
    work.sourceKey === `gmail:${providerMessageId}` &&
    work.channelMessageId === channelMessageId &&
    channelMessageId === `gmail:${providerMessageId}` &&
    isValidEmailAttachmentPreparedResult(result) &&
    result.messageId === providerMessageId &&
    result.manifestDigest === manifestDigest &&
    emailAttachmentManifestDigest(result.entries) === manifestDigest &&
    isDeepStrictEqual(result.entries[entry.ordinal], entry)
  );
}
