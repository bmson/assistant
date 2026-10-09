import { createHash } from 'node:crypto';
import type { EmailObserverEffectFence } from './generated-cards.js';
import type { PrivacyErasureAsset } from './privacy-erasure.js';
import type { Records } from './records.js';

export const MAX_EMAIL_ATTACHMENT_MANIFEST_ENTRIES = 8;
export const MAX_EMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MIME_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type EmailAttachmentCustodyStatus =
  | 'marker_pending'
  | 'marker_ready'
  | 'content_authorized'
  | 'object_written'
  | 'catalogued'
  | 'cleanup_pending'
  | 'duplicate_cleaned'
  | 'erased';

/**
 * Private attachment metadata is kept only while it is needed to finish filing.
 * After erase, implementations retain an opaque path/id tombstone and exact
 * generations so a late marker-create result can still be swept safely.
 */
export type EmailAttachmentCustodyRecord = Records['emailAttachmentCustodies'];

/** Opaque, stable privacy-asset ID bound to exactly one GCS generation. */
export function emailAttachmentCustodyCleanupIntentId(
  custodyId: string,
  generation: string,
): string {
  return `email-attachment-custody:${createHash('sha256')
    .update(custodyId)
    .update('\0')
    .update(generation)
    .digest('hex')}`;
}

export type EmailAttachmentManifestEntry = {
  providerAttachmentId: string;
  ordinal: number;
  filename: string;
  mime: string;
  advertisedBytes: number;
};

export type EmailAttachmentPreparedResult = {
  messageId: string;
  manifestDigest: string;
  entries: EmailAttachmentManifestEntry[];
};

/** Validate exact provider metadata and calculate its stable ordered digest. */
export function emailAttachmentManifestDigest(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > MAX_EMAIL_ATTACHMENT_MANIFEST_ENTRIES) return null;
  const ids = new Set<string>();
  const entries: EmailAttachmentManifestEntry[] = [];
  for (let ordinal = 0; ordinal < value.length; ordinal += 1) {
    const raw = value[ordinal];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (
      Object.keys(row).length !== 5 ||
      !Object.hasOwn(row, 'providerAttachmentId') ||
      !Object.hasOwn(row, 'ordinal') ||
      !Object.hasOwn(row, 'filename') ||
      !Object.hasOwn(row, 'mime') ||
      !Object.hasOwn(row, 'advertisedBytes') ||
      typeof row.providerAttachmentId !== 'string' ||
      row.providerAttachmentId.length < 1 ||
      row.providerAttachmentId.length > 512 ||
      hasControlCharacters(row.providerAttachmentId) ||
      ids.has(row.providerAttachmentId) ||
      row.ordinal !== ordinal ||
      typeof row.filename !== 'string' ||
      row.filename.length > 300 ||
      hasControlCharacters(row.filename) ||
      typeof row.mime !== 'string' ||
      row.mime.length > 200 ||
      !MIME_TOKEN.test(row.mime) ||
      !Number.isSafeInteger(row.advertisedBytes) ||
      (row.advertisedBytes as number) < 0 ||
      (row.advertisedBytes as number) > MAX_EMAIL_ATTACHMENT_BYTES
    )
      return null;
    ids.add(row.providerAttachmentId);
    entries.push({
      providerAttachmentId: row.providerAttachmentId,
      ordinal,
      filename: row.filename,
      mime: row.mime,
      advertisedBytes: row.advertisedBytes as number,
    });
  }
  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
}

export type EmailAttachmentCustodyIntentInput = {
  fence: EmailObserverEffectFence;
  observerWorkId: string;
  channelMessageId: string;
  providerMessageId: string;
  manifestDigest: string;
  entry: EmailAttachmentManifestEntry;
  actualBytes: number;
  sha256: string;
  custodyId: string;
  workspacePath: string;
};

export type EmailAttachmentCustodyRepository = {
  /**
   * Atomically verifies the current prepared observer claim/privacy generation
   * and stores an immutable attachment intent before any object-store request.
   * Replays return the same intent only when the complete source/manifest binding
   * matches.
   */
  beginEmailAttachmentCustody(
    input: EmailAttachmentCustodyIntentInput,
  ): Promise<EmailAttachmentCustodyRecord>;
  /** Record an exact marker result even after erasure; this is cleanup metadata, not publication. */
  recordEmailAttachmentMarker(input: {
    agentId: string;
    custodyId: string;
    generation: string;
  }): Promise<boolean>;
  /** Recheck claim, lease, owner and privacy fence immediately before content bytes are sent. */
  authorizeEmailAttachmentContent(input: {
    fence: EmailObserverEffectFence;
    custodyId: string;
    markerGeneration: string;
    actualBytes: number;
    sha256: string;
    mime: string;
  }): Promise<boolean>;
  /** Record an external write outcome even if a concurrent erase invalidated publication. */
  recordEmailAttachmentObject(input: {
    agentId: string;
    custodyId: string;
    generation: string;
    bytes?: number;
    sha256?: string;
  }): Promise<boolean>;
  /**
   * Atomically revalidates the observer fence and creates file/document/task
   * inventory. The file row retains object generation and custody identity for
   * later exact deletion. Stale results remain in custody for cleanup.
   */
  finalizeEmailAttachmentCatalog(input: {
    fence: EmailObserverEffectFence;
    custodyId: string;
    file: Records['files'];
    document: Records['documents'];
  }): Promise<{
    document: Records['documents'];
    duplicate: boolean;
    task: { id: string; queueGeneration: number } | null;
    published: boolean;
  }>;
  /** Bounded owner-scoped cleanup list; includes retained erased tombstones. */
  listEmailAttachmentCustodyCleanup(input: {
    agentId: string;
    cursor: string | null;
    limit: number;
  }): Promise<{
    items: Array<{
      custody: EmailAttachmentCustodyRecord;
      asset: Extract<PrivacyErasureAsset, { kind: 'email_attachment_custody' }>;
    }>;
    nextCursor: string | null;
  }>;
  /** Retain the opaque tombstone; never physically remove a possibly-late marker intent. */
  markEmailAttachmentCustodyErased(input: {
    agentId: string;
    custodyId: string;
    /** Exact generation already conditionally deleted; omitted means enqueue it for cleanup. */
    deletedGeneration?: string;
  }): Promise<boolean>;
};
