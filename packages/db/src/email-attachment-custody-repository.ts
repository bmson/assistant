import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  EmailAttachmentCustodyRepository,
  EmailAttachmentManifestEntry,
  EmailObserverEffectFence,
  PrivacyErasureAsset,
} from '@assistant/persistence';
import {
  EmailObserverEffectFenceRejectedError,
  emailAttachmentCustodyCleanupIntentId,
  emailAttachmentManifestDigest,
  emailObserverWorkId,
  extractorFor,
  isValidEmailAttachmentPreparedResult,
  isValidEmailContentProvenanceSnapshot,
  matchesPreparedEmailObserverClaim,
} from '@assistant/persistence';
import { and, asc, eq, gt, inArray, like, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  lockPostgresPrivacyCleanupFence,
  lockPostgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import {
  conversations,
  documents,
  emailAttachmentCustodies,
  emailIngest,
  emailObserverWork,
  files,
  maintenanceCursors,
  messages,
} from './schema.js';
import { createTask } from './task-creation-repository.js';

const MAX_BYTES = 25 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const GENERATION = /^[1-9]\d{0,30}$/;
const MIME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function textHash(value: string): string {
  return createHash('sha256').update('assistant-email-content-v1\0').update(value).digest('hex');
}

function matchesFrozenAttachmentAdmission(
  ingest: typeof emailIngest.$inferSelect,
  work: typeof emailObserverWork.$inferSelect,
  agentId: string,
  channelMessageId: string,
): boolean {
  const raw = ingest.observerRegistrySnapshot;
  if (!Array.isArray(raw) || raw.length > 40 || !HASH.test(ingest.observerRegistryHash ?? ''))
    return false;
  const snapshot = raw.map((item) => ({
    key: item.key,
    version: item.version,
    workClass: item.workClass,
  }));
  if (
    snapshot.some(
      (item, index) =>
        typeof item.key !== 'string' ||
        item.key.trim().length === 0 ||
        !Number.isSafeInteger(item.version) ||
        item.version < 1 ||
        typeof item.workClass !== 'string' ||
        Object.keys(raw[index] ?? {}).some((key) => !['key', 'version', 'workClass'].includes(key)),
    )
  )
    return false;
  const canonical = [...snapshot].sort(
    (left, right) => left.key.localeCompare(right.key) || left.version - right.version,
  );
  if (
    !isDeepStrictEqual(snapshot, canonical) ||
    canonical.some(
      (item, index) =>
        index > 0 &&
        item.key === canonical[index - 1]?.key &&
        item.version === canonical[index - 1]?.version,
    ) ||
    createHash('sha256').update(JSON.stringify(canonical)).digest('hex') !==
      ingest.observerRegistryHash
  )
    return false;
  const expectedWorkId = emailObserverWorkId(
    agentId,
    channelMessageId,
    'google.email-attachments',
    3,
  );
  return (
    canonical.some(
      (item) =>
        item.key === 'google.email-attachments' &&
        item.version === 3 &&
        item.workClass === 'idempotent_db',
    ) &&
    work.id === expectedWorkId &&
    work.agentId === agentId &&
    work.sourceKey === channelMessageId &&
    work.channelMessageId === channelMessageId &&
    work.sourceKind === 'message' &&
    work.observerKey === 'google.email-attachments' &&
    work.observerVersion === 3 &&
    work.workClass === 'idempotent_db'
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

async function freshNow(tx: Tx): Promise<Date> {
  const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
  if (!clock) throw new Error('Missing database clock');
  const now = new Date(clock.now);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid database clock');
  return now;
}

function validateEntry(entry: EmailAttachmentManifestEntry): void {
  if (
    !entry ||
    typeof entry.providerAttachmentId !== 'string' ||
    entry.providerAttachmentId.length < 1 ||
    entry.providerAttachmentId.length > 512 ||
    !Number.isSafeInteger(entry.ordinal) ||
    entry.ordinal < 0 ||
    entry.ordinal > 7 ||
    typeof entry.filename !== 'string' ||
    entry.filename.length > 300 ||
    hasControlCharacters(entry.filename) ||
    typeof entry.mime !== 'string' ||
    entry.mime.length > 200 ||
    !MIME.test(entry.mime) ||
    !Number.isSafeInteger(entry.advertisedBytes) ||
    entry.advertisedBytes < 0 ||
    entry.advertisedBytes > MAX_BYTES
  )
    throw new Error('Invalid email attachment manifest entry');
}

function validObjectPath(value: string, custodyId: string): boolean {
  return value === `email-attachments/custody/${custodyId}`;
}

function parseCleanupAsset(
  agentId: string,
  name: string,
  cursor: string | null,
): Extract<PrivacyErasureAsset, { kind: 'email_attachment_custody' }> {
  const prefix = `privacy-erasure-asset:${agentId}:`;
  if (!name.startsWith(prefix) || !cursor)
    throw new Error('Email attachment cleanup asset is malformed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    throw new Error('Email attachment cleanup asset is malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Email attachment cleanup asset is malformed');
  const value = parsed as Record<string, unknown>;
  const id = name.slice(prefix.length);
  const allowed = [
    'kind',
    'id',
    'custodyId',
    'workspacePath',
    'generation',
    'objectState',
    'documentId',
  ];
  if (
    value.kind !== 'email_attachment_custody' ||
    value.id !== id ||
    typeof value.custodyId !== 'string' ||
    !UUID.test(value.custodyId) ||
    typeof value.workspacePath !== 'string' ||
    !validObjectPath(value.workspacePath, value.custodyId) ||
    typeof value.generation !== 'string' ||
    !GENERATION.test(value.generation) ||
    (value.objectState !== 'marker' && value.objectState !== 'content') ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    (value.documentId !== undefined &&
      (typeof value.documentId !== 'string' || !UUID.test(value.documentId))) ||
    emailAttachmentCustodyCleanupIntentId(value.custodyId, value.generation) !== id
  )
    throw new Error('Email attachment cleanup asset is malformed');
  return {
    kind: 'email_attachment_custody',
    id,
    custodyId: value.custodyId,
    workspacePath: value.workspacePath,
    generation: value.generation,
    objectState: value.objectState,
  };
}

async function pendingCleanupAssets(tx: Tx, agentId: string, custodyId: string) {
  const prefix = `privacy-erasure-asset:${agentId}:email-attachment-custody:`;
  const rows = await tx
    .select({ name: maintenanceCursors.name, cursor: maintenanceCursors.cursor })
    .from(maintenanceCursors)
    .where(like(maintenanceCursors.name, `${prefix}%`));
  return rows
    .map((row) => parseCleanupAsset(agentId, row.name, row.cursor))
    .filter((asset) => asset.custodyId === custodyId);
}

async function insertEmailAttachmentCleanupIntent(
  tx: Tx,
  agentId: string,
  custodyId: string,
  workspacePath: string,
  generation: string,
  objectState: 'marker' | 'content',
  documentId?: string | null,
): Promise<void> {
  const id = emailAttachmentCustodyCleanupIntentId(custodyId, generation);
  const name = `privacy-erasure-asset:${agentId}:${id}`;
  const cursor = JSON.stringify({
    kind: 'email_attachment_custody',
    id,
    custodyId,
    workspacePath,
    generation,
    objectState,
    ...(documentId ? { documentId } : {}),
  });
  const [existing] = await tx
    .select({ cursor: maintenanceCursors.cursor })
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, name))
    .for('update')
    .limit(1);
  if (existing) {
    let storedDocumentId: unknown;
    try {
      const stored = JSON.parse(existing.cursor ?? '') as Record<string, unknown>;
      if (
        stored.kind !== 'email_attachment_custody' ||
        stored.id !== id ||
        stored.custodyId !== custodyId ||
        stored.workspacePath !== workspacePath ||
        stored.generation !== generation ||
        stored.objectState !== objectState
      )
        throw new Error('Email attachment cleanup intent changed');
      storedDocumentId = stored.documentId;
    } catch {
      throw new Error('Email attachment cleanup intent changed');
    }
    if (
      (storedDocumentId !== undefined && typeof storedDocumentId !== 'string') ||
      (documentId && storedDocumentId && documentId !== storedDocumentId)
    )
      throw new Error('Email attachment cleanup document link changed');
    if (documentId && storedDocumentId === undefined)
      await tx
        .update(maintenanceCursors)
        .set({ cursor, updatedAt: new Date() })
        .where(eq(maintenanceCursors.name, name));
    return;
  }
  await tx.insert(maintenanceCursors).values({ name, cursor });
}

async function lockPreparedAttachmentClaim(
  tx: Tx,
  fence: EmailObserverEffectFence,
  expectedPrivacyGeneration: string | null,
): Promise<{
  work: typeof emailObserverWork.$inferSelect;
  prepared: { messageId: string; manifestDigest: string; entries: EmailAttachmentManifestEntry[] };
} | null> {
  const generation = await lockPostgresPrivacyObservationFence(tx as unknown as Db, fence.agentId);
  if (generation !== expectedPrivacyGeneration) return null;
  const [work] = await tx
    .select()
    .from(emailObserverWork)
    .where(and(eq(emailObserverWork.id, fence.id), eq(emailObserverWork.agentId, fence.agentId)))
    .for('update')
    .limit(1);
  const now = await freshNow(tx);
  if (
    !work ||
    !matchesPreparedEmailObserverClaim(work, fence, now) ||
    work.observerKey !== 'google.email-attachments' ||
    work.observerVersion !== 3 ||
    work.workClass !== 'idempotent_db' ||
    work.sourceKind !== 'message' ||
    work.channelMessageId !==
      `gmail:${(work.preparedResult as { messageId?: unknown } | null)?.messageId ?? ''}` ||
    !isValidEmailAttachmentPreparedResult(work.preparedResult)
  )
    return null;
  return { work, prepared: work.preparedResult };
}

function manifestEntryForCustody(
  prepared: { entries: EmailAttachmentManifestEntry[] },
  row: typeof emailAttachmentCustodies.$inferSelect,
): EmailAttachmentManifestEntry | null {
  const entry = prepared.entries[row.attachmentOrdinal];
  if (
    !entry ||
    entry.ordinal !== row.attachmentOrdinal ||
    entry.providerAttachmentId !== row.providerAttachmentId ||
    entry.filename !== row.filename ||
    entry.mime !== row.mime ||
    entry.advertisedBytes !== row.advertisedBytes
  )
    return null;
  return entry;
}

async function lockCustodyForReceipt(tx: Tx, input: { agentId: string; custodyId: string }) {
  const where = and(
    eq(emailAttachmentCustodies.id, input.custodyId),
    eq(emailAttachmentCustodies.agentId, input.agentId),
  );
  const [snapshot] = await tx.select().from(emailAttachmentCustodies).where(where).limit(1);
  if (!snapshot) return null;
  let work: typeof emailObserverWork.$inferSelect | null = null;
  if (snapshot.observerWorkId) {
    const [lockedWork] = await tx
      .select()
      .from(emailObserverWork)
      .where(
        and(
          eq(emailObserverWork.id, snapshot.observerWorkId),
          eq(emailObserverWork.agentId, input.agentId),
        ),
      )
      .for('update')
      .limit(1);
    work = lockedWork ?? null;
  }
  const [row] = await tx
    .select()
    .from(emailAttachmentCustodies)
    .where(where)
    .for('update')
    .limit(1);
  if (!row) return null;
  const now = await freshNow(tx);
  const fence: EmailObserverEffectFence | null = row.claimToken
    ? {
        id: row.observerWorkId ?? '',
        agentId: row.agentId,
        claimToken: row.claimToken,
        claimGeneration: row.claimGeneration,
        expectedPrivacyGeneration: row.privacyGeneration,
      }
    : null;
  const canonicalSource =
    work && isValidEmailAttachmentPreparedResult(work.preparedResult)
      ? await validateCanonicalSource(tx, {
          agentId: input.agentId,
          channelMessageId: row.channelMessageId ?? '',
          providerMessageId: row.providerMessageId ?? '',
          preparedMessageId: work.preparedResult.messageId,
          work,
        })
      : null;
  const claimIsCurrent = Boolean(
    canonicalSource &&
      work &&
      fence &&
      work.observerKey === 'google.email-attachments' &&
      work.observerVersion === 3 &&
      work.workClass === 'idempotent_db' &&
      work.sourceKind === 'message' &&
      work.channelMessageId === row.channelMessageId &&
      isValidEmailAttachmentPreparedResult(work.preparedResult) &&
      work.preparedResult.messageId === row.providerMessageId &&
      work.preparedResult.manifestDigest === row.manifestDigest &&
      manifestEntryForCustody(work.preparedResult, row) !== null &&
      matchesPreparedEmailObserverClaim(work, fence, now),
  );
  return { row, work, now, claimIsCurrent };
}

async function validateCanonicalSource(
  tx: Tx,
  input: {
    agentId: string;
    channelMessageId: string;
    providerMessageId: string;
    preparedMessageId: string;
    work: typeof emailObserverWork.$inferSelect;
  },
) {
  if (
    input.providerMessageId !== input.preparedMessageId ||
    input.channelMessageId !== `gmail:${input.providerMessageId}`
  )
    return null;
  const [ingest] = await tx
    .select()
    .from(emailIngest)
    .where(
      and(
        eq(emailIngest.agentId, input.agentId),
        eq(emailIngest.channelMessageId, input.channelMessageId),
      ),
    )
    .for('share')
    .limit(1);
  if (
    !ingest ||
    ingest.providerMessageId !== input.providerMessageId ||
    ingest.channelMessageId !== input.channelMessageId ||
    ingest.messagePersisted !== true ||
    ingest.admittedSourceKind !== 'message' ||
    !ingest.admittedSourceId ||
    !ingest.conversationId ||
    !matchesFrozenAttachmentAdmission(ingest, input.work, input.agentId, input.channelMessageId) ||
    !['direct', 'forwarded'].includes(ingest.ingestMode) ||
    !['owner', 'known', 'unknown'].includes(ingest.contentTrust) ||
    (ingest.ingestMode === 'direct' && ingest.authenticated !== true)
  )
    return null;
  const [conversation] = await tx
    .select({
      id: conversations.id,
      agentId: conversations.agentId,
      channel: conversations.channel,
    })
    .from(conversations)
    .where(eq(conversations.id, ingest.conversationId))
    .for('share')
    .limit(1);
  const [message] = await tx
    .select()
    .from(messages)
    .where(eq(messages.id, ingest.admittedSourceId))
    .for('share')
    .limit(1);
  const expectedOrigin =
    ingest.contentTrust === 'owner'
      ? 'owner'
      : ingest.contentTrust === 'known'
        ? 'known_contact'
        : 'unknown';
  const expectedPrefix = `From: ${ingest.fromEmail}\nSubject: ${ingest.subject}\n\n`;
  if (
    !conversation ||
    conversation.agentId !== input.agentId ||
    conversation.channel !== 'email' ||
    !message ||
    message.id !== ingest.admittedSourceId ||
    message.conversationId !== ingest.conversationId ||
    message.channelMessageId !== input.channelMessageId ||
    message.role !== 'user' ||
    message.hiddenAt !== null ||
    message.origin !== expectedOrigin ||
    message.text.length < expectedPrefix.length ||
    !message.text.startsWith(expectedPrefix) ||
    !Array.isArray(message.parts) ||
    message.parts.length !== 1 ||
    (message.parts[0] as { type?: unknown; text?: unknown } | undefined)?.type !== 'text' ||
    (message.parts[0] as { type?: unknown; text?: unknown } | undefined)?.text !==
      message.text.slice(expectedPrefix.length)
  )
    return null;
  const provenance = ingest.emailContentProvenance;
  const storedBody = message.text.slice(expectedPrefix.length);
  const storedPart = (message.parts[0] as { type: 'text'; text: string }).text;
  if (
    !isValidEmailContentProvenanceSnapshot(provenance) ||
    provenance.version !== 1 ||
    provenance.mode !== ingest.ingestMode ||
    provenance.authenticated !== ingest.authenticated ||
    provenance.hasExternalOrUnknown !== ingest.hasExternalOrUnknown ||
    provenance.storedLength !== storedBody.length ||
    provenance.prefixLength !== expectedPrefix.length ||
    provenance.sourceLength < provenance.storedLength ||
    (provenance.sourceLength === provenance.storedLength &&
      provenance.sourceHash !== provenance.bodyHash) ||
    provenance.bodyHash !== textHash(storedBody) ||
    provenance.messageHash !== textHash(message.text) ||
    storedPart !== storedBody ||
    !HASH.test(provenance.sourceHash) ||
    !Array.isArray(provenance.spans) ||
    provenance.spans.some(
      (span, index, spans) =>
        span.start < 0 ||
        span.end <= span.start ||
        span.end > storedBody.length ||
        (index > 0 && spans[index - 1]?.end !== span.start),
    ) ||
    (storedBody.length > 0 &&
      (provenance.spans[0]?.start !== 0 || provenance.spans.at(-1)?.end !== storedBody.length))
  )
    return null;
  return { ingest, conversation, message };
}

async function eraseCustodyRow(
  tx: Tx,
  row: typeof emailAttachmentCustodies.$inferSelect,
  markerGeneration?: string | null,
  objectGeneration?: string | null,
) {
  const latestMarker = markerGeneration === undefined ? row.markerGeneration : markerGeneration;
  const latestObject = objectGeneration === undefined ? row.objectGeneration : objectGeneration;
  return tx
    .update(emailAttachmentCustodies)
    .set({
      observerWorkId: null,
      claimToken: null,
      privacyGeneration: null,
      channelMessageId: null,
      providerMessageId: null,
      providerAttachmentId: null,
      manifestDigest: null,
      filename: null,
      mime: null,
      advertisedBytes: 0,
      actualBytes: null,
      sha256: null,
      markerGeneration: latestMarker,
      objectGeneration: latestObject,
      status: 'erased',
      fileId: null,
      documentId: null,
      duplicateDocumentId: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(emailAttachmentCustodies.id, row.id),
        eq(emailAttachmentCustodies.agentId, row.agentId),
      ),
    )
    .returning({
      id: emailAttachmentCustodies.id,
      generation: emailAttachmentCustodies.privacyGeneration,
    });
}

export function createPostgresEmailAttachmentCustodyRepository(
  db: Db,
): EmailAttachmentCustodyRepository {
  return {
    async beginEmailAttachmentCustody(input) {
      if (
        !UUID.test(input.custodyId) ||
        !validObjectPath(input.workspacePath, input.custodyId) ||
        !HASH.test(input.manifestDigest) ||
        !HASH.test(input.sha256) ||
        !Number.isSafeInteger(input.actualBytes) ||
        input.actualBytes < 1 ||
        input.actualBytes > MAX_BYTES
      )
        throw new Error('Invalid email attachment custody intent');
      validateEntry(input.entry);
      return db.transaction(async (tx) => {
        const claim = await lockPreparedAttachmentClaim(
          tx,
          input.fence,
          input.fence.expectedPrivacyGeneration,
        );
        if (
          !claim ||
          claim.work.id !== input.observerWorkId ||
          claim.work.channelMessageId !== input.channelMessageId
        )
          throw new EmailObserverEffectFenceRejectedError();
        if (
          claim.prepared.messageId !== input.providerMessageId ||
          claim.prepared.manifestDigest !== input.manifestDigest ||
          emailAttachmentManifestDigest(claim.prepared.entries) !== input.manifestDigest ||
          !isDeepStrictEqual(claim.prepared.entries[input.entry.ordinal], input.entry)
        )
          throw new EmailObserverEffectFenceRejectedError();
        const source = await validateCanonicalSource(tx, {
          agentId: input.fence.agentId,
          channelMessageId: input.channelMessageId,
          providerMessageId: input.providerMessageId,
          preparedMessageId: claim.prepared.messageId,
          work: claim.work,
        });
        if (!source) throw new EmailObserverEffectFenceRejectedError();
        const now = await freshNow(tx);
        if (!matchesPreparedEmailObserverClaim(claim.work, input.fence, now))
          throw new EmailObserverEffectFenceRejectedError();
        const [inserted] = await tx
          .insert(emailAttachmentCustodies)
          .values({
            id: input.custodyId,
            agentId: input.fence.agentId,
            observerWorkId: input.observerWorkId,
            claimToken: input.fence.claimToken,
            claimGeneration: input.fence.claimGeneration,
            privacyGeneration: input.fence.expectedPrivacyGeneration,
            channelMessageId: input.channelMessageId,
            providerMessageId: input.providerMessageId,
            providerAttachmentId: input.entry.providerAttachmentId,
            manifestDigest: input.manifestDigest,
            attachmentOrdinal: input.entry.ordinal,
            workspacePath: input.workspacePath,
            filename: input.entry.filename,
            mime: input.entry.mime,
            advertisedBytes: input.entry.advertisedBytes,
            actualBytes: input.actualBytes,
            sha256: input.sha256,
            status: 'marker_pending',
            leaseExpiresAt: claim.work.leaseExpiresAt,
          })
          .onConflictDoNothing({
            target: [
              emailAttachmentCustodies.agentId,
              emailAttachmentCustodies.observerWorkId,
              emailAttachmentCustodies.providerAttachmentId,
            ],
          })
          .returning();
        const row =
          inserted ??
          (
            await tx
              .select()
              .from(emailAttachmentCustodies)
              .where(
                and(
                  eq(emailAttachmentCustodies.agentId, input.fence.agentId),
                  eq(emailAttachmentCustodies.observerWorkId, input.observerWorkId),
                  eq(
                    emailAttachmentCustodies.providerAttachmentId,
                    input.entry.providerAttachmentId,
                  ),
                ),
              )
              .for('update')
              .limit(1)
          )[0];
        if (!row) throw new Error('Email attachment custody intent conflict');
        const expected = {
          agentId: input.fence.agentId,
          observerWorkId: input.observerWorkId,
          privacyGeneration: input.fence.expectedPrivacyGeneration,
          channelMessageId: input.channelMessageId,
          providerMessageId: input.providerMessageId,
          providerAttachmentId: input.entry.providerAttachmentId,
          manifestDigest: input.manifestDigest,
          attachmentOrdinal: input.entry.ordinal,
          filename: input.entry.filename,
          mime: input.entry.mime,
          advertisedBytes: input.entry.advertisedBytes,
          actualBytes: input.actualBytes,
          sha256: input.sha256,
        };
        if (row.status === 'erased') return row;
        if (
          !Object.entries(expected).every(
            ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
          ) ||
          row.workspacePath !== `email-attachments/custody/${row.id}` ||
          !UUID.test(row.id)
        )
          throw new Error('Email attachment custody replay changed its frozen intent');
        if (
          row.duplicateDocumentId &&
          ['cleanup_pending', 'duplicate_cleaned'].includes(row.status)
        ) {
          const [duplicate] = await tx
            .select()
            .from(documents)
            .where(
              and(
                eq(documents.id, row.duplicateDocumentId),
                eq(documents.agentId, row.agentId),
                eq(documents.sha256, row.sha256 ?? ''),
              ),
            )
            .limit(1);
          if (!duplicate) throw new Error('Duplicate email attachment receipt target changed');
          const [duplicateFile] = await tx
            .select()
            .from(files)
            .where(
              and(
                eq(files.id, duplicate.fileId),
                eq(files.agentId, row.agentId),
                eq(files.sha256, row.sha256 ?? ''),
              ),
            )
            .limit(1);
          if (!duplicateFile) throw new Error('Duplicate email attachment receipt file changed');
        }
        if (
          row.status === 'catalogued' ||
          row.status === 'cleanup_pending' ||
          row.status === 'duplicate_cleaned'
        )
          return row;
        const [rebound] = await tx
          .update(emailAttachmentCustodies)
          .set({
            claimToken: input.fence.claimToken,
            claimGeneration: input.fence.claimGeneration,
            privacyGeneration: input.fence.expectedPrivacyGeneration,
            leaseExpiresAt: claim.work.leaseExpiresAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(emailAttachmentCustodies.id, row.id),
              eq(emailAttachmentCustodies.agentId, row.agentId),
              eq(emailAttachmentCustodies.status, row.status),
            ),
          )
          .returning();
        if (!rebound) throw new Error('Email attachment custody replay lost its claim');
        return rebound;
      });
    },

    async recordEmailAttachmentMarker(input) {
      if (!UUID.test(input.custodyId) || !GENERATION.test(input.generation)) return false;
      return db.transaction(async (tx) => {
        const currentPrivacy = await lockPostgresPrivacyCleanupFence(
          tx as unknown as Db,
          input.agentId,
        );
        const context = await lockCustodyForReceipt(tx, input);
        if (!context) return false;
        const { row, now } = context;
        if (row.status === 'erased' || row.privacyGeneration !== currentPrivacy) {
          if (row.status !== 'erased')
            await eraseCustodyRow(tx, row, input.generation, row.objectGeneration);
          else
            await tx
              .update(emailAttachmentCustodies)
              .set({ markerGeneration: input.generation, updatedAt: now })
              .where(eq(emailAttachmentCustodies.id, row.id));
          await insertEmailAttachmentCleanupIntent(
            tx,
            row.agentId,
            row.id,
            row.workspacePath,
            input.generation,
            'marker',
            row.documentId,
          );
          return false;
        }
        if (row.status === 'duplicate_cleaned') {
          await tx
            .update(emailAttachmentCustodies)
            .set({ markerGeneration: input.generation, updatedAt: now })
            .where(eq(emailAttachmentCustodies.id, row.id));
          await insertEmailAttachmentCleanupIntent(
            tx,
            row.agentId,
            row.id,
            row.workspacePath,
            input.generation,
            'marker',
          );
          return false;
        }
        if (row.markerGeneration && row.markerGeneration !== input.generation)
          throw new Error('Email attachment marker generation changed');
        if (!['marker_pending', 'marker_ready'].includes(row.status))
          return row.markerGeneration === input.generation;
        await tx
          .update(emailAttachmentCustodies)
          .set({ status: 'marker_ready', markerGeneration: input.generation, updatedAt: now })
          .where(eq(emailAttachmentCustodies.id, row.id));
        return context.claimIsCurrent;
      });
    },

    async authorizeEmailAttachmentContent(input) {
      if (
        !UUID.test(input.custodyId) ||
        !GENERATION.test(input.markerGeneration) ||
        !HASH.test(input.sha256) ||
        !MIME.test(input.mime) ||
        !Number.isSafeInteger(input.actualBytes) ||
        input.actualBytes < 1 ||
        input.actualBytes > MAX_BYTES
      )
        return false;
      return db.transaction(async (tx) => {
        const claim = await lockPreparedAttachmentClaim(
          tx,
          input.fence,
          input.fence.expectedPrivacyGeneration,
        );
        if (!claim) return false;
        const [row] = await tx
          .select()
          .from(emailAttachmentCustodies)
          .where(
            and(
              eq(emailAttachmentCustodies.id, input.custodyId),
              eq(emailAttachmentCustodies.agentId, input.fence.agentId),
            ),
          )
          .for('update')
          .limit(1);
        if (!row) return false;
        const now = await freshNow(tx);
        if (!matchesPreparedEmailObserverClaim(claim.work, input.fence, now)) return false;
        const entry = manifestEntryForCustody(claim.prepared, row);
        if (
          row.status !== 'marker_ready' ||
          row.observerWorkId !== claim.work.id ||
          row.claimToken !== input.fence.claimToken ||
          row.claimGeneration !== input.fence.claimGeneration ||
          row.privacyGeneration !== input.fence.expectedPrivacyGeneration ||
          row.channelMessageId !== claim.work.channelMessageId ||
          row.providerMessageId !== claim.prepared.messageId ||
          row.manifestDigest !== claim.prepared.manifestDigest ||
          row.markerGeneration !== input.markerGeneration ||
          !entry ||
          row.actualBytes !== input.actualBytes ||
          row.sha256 !== input.sha256 ||
          row.mime !== input.mime
        )
          return false;
        await tx
          .update(emailAttachmentCustodies)
          .set({ status: 'content_authorized', updatedAt: now })
          .where(eq(emailAttachmentCustodies.id, row.id));
        return true;
      });
    },

    async recordEmailAttachmentObject(input) {
      if (
        !UUID.test(input.custodyId) ||
        !GENERATION.test(input.generation) ||
        (input.sha256 !== undefined && !HASH.test(input.sha256)) ||
        (input.bytes !== undefined &&
          (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_BYTES))
      )
        return false;
      return db.transaction(async (tx) => {
        const currentPrivacy = await lockPostgresPrivacyCleanupFence(
          tx as unknown as Db,
          input.agentId,
        );
        const context = await lockCustodyForReceipt(tx, input);
        if (!context) return false;
        const { row, now } = context;
        if (row.status === 'erased' || row.privacyGeneration !== currentPrivacy) {
          if (row.status !== 'erased')
            await eraseCustodyRow(tx, row, row.markerGeneration, input.generation);
          else
            await tx
              .update(emailAttachmentCustodies)
              .set({ objectGeneration: input.generation, updatedAt: now })
              .where(eq(emailAttachmentCustodies.id, row.id));
          await insertEmailAttachmentCleanupIntent(
            tx,
            row.agentId,
            row.id,
            row.workspacePath,
            input.generation,
            'content',
            row.documentId,
          );
          return false;
        }
        if (row.status === 'duplicate_cleaned') {
          await tx
            .update(emailAttachmentCustodies)
            .set({ objectGeneration: input.generation, updatedAt: now })
            .where(eq(emailAttachmentCustodies.id, row.id));
          await insertEmailAttachmentCleanupIntent(
            tx,
            row.agentId,
            row.id,
            row.workspacePath,
            input.generation,
            'content',
          );
          return false;
        }
        if (
          (input.bytes !== undefined && row.actualBytes !== input.bytes) ||
          (input.sha256 !== undefined && row.sha256 !== input.sha256)
        ) {
          await tx
            .update(emailAttachmentCustodies)
            .set({ status: 'cleanup_pending', objectGeneration: input.generation, updatedAt: now })
            .where(eq(emailAttachmentCustodies.id, row.id));
          await insertEmailAttachmentCleanupIntent(
            tx,
            row.agentId,
            row.id,
            row.workspacePath,
            input.generation,
            'content',
            row.documentId,
          );
          return false;
        }
        if (row.objectGeneration && row.objectGeneration !== input.generation)
          throw new Error('Email attachment object generation changed');
        if (!['content_authorized', 'object_written'].includes(row.status))
          return row.objectGeneration === input.generation;
        await tx
          .update(emailAttachmentCustodies)
          .set({ status: 'object_written', objectGeneration: input.generation, updatedAt: now })
          .where(eq(emailAttachmentCustodies.id, row.id));
        return context.claimIsCurrent;
      });
    },

    async finalizeEmailAttachmentCatalog(input) {
      return db.transaction(async (tx) => {
        const claim = await lockPreparedAttachmentClaim(
          tx,
          input.fence,
          input.fence.expectedPrivacyGeneration,
        );
        if (!claim) throw new EmailObserverEffectFenceRejectedError();
        const [row] = await tx
          .select()
          .from(emailAttachmentCustodies)
          .where(
            and(
              eq(emailAttachmentCustodies.id, input.custodyId),
              eq(emailAttachmentCustodies.agentId, input.fence.agentId),
            ),
          )
          .for('update')
          .limit(1);
        if (!row) throw new EmailObserverEffectFenceRejectedError();
        const source = await validateCanonicalSource(tx, {
          agentId: input.fence.agentId,
          channelMessageId: row.channelMessageId ?? '',
          providerMessageId: row.providerMessageId ?? '',
          preparedMessageId: claim.prepared.messageId,
          work: claim.work,
        });
        if (!source) throw new EmailObserverEffectFenceRejectedError();
        if (
          row.duplicateDocumentId &&
          ['cleanup_pending', 'duplicate_cleaned'].includes(row.status)
        ) {
          const now = await freshNow(tx);
          if (
            !matchesPreparedEmailObserverClaim(claim.work, input.fence, now) ||
            row.observerWorkId !== claim.work.id ||
            row.claimToken !== input.fence.claimToken ||
            row.claimGeneration !== input.fence.claimGeneration ||
            row.privacyGeneration !== input.fence.expectedPrivacyGeneration ||
            row.manifestDigest !== claim.prepared.manifestDigest ||
            row.channelMessageId !== claim.work.channelMessageId
          )
            throw new EmailObserverEffectFenceRejectedError();
          const [duplicate] = await tx
            .select()
            .from(documents)
            .where(
              and(
                eq(documents.id, row.duplicateDocumentId),
                eq(documents.agentId, row.agentId),
                eq(documents.sha256, row.sha256 ?? ''),
              ),
            )
            .limit(1);
          if (!duplicate) throw new Error('Duplicate email attachment receipt target changed');
          const [duplicateFile] = await tx
            .select()
            .from(files)
            .where(
              and(
                eq(files.id, duplicate.fileId),
                eq(files.agentId, row.agentId),
                eq(files.sha256, row.sha256 ?? ''),
              ),
            )
            .limit(1);
          if (!duplicateFile) throw new Error('Duplicate email attachment receipt file changed');
          return { document: duplicate, duplicate: true, task: null, published: false };
        }
        if (row.status === 'catalogued' && row.fileId && row.documentId) {
          const now = await freshNow(tx);
          if (
            !matchesPreparedEmailObserverClaim(claim.work, input.fence, now) ||
            row.observerWorkId !== claim.work.id ||
            row.claimToken !== input.fence.claimToken ||
            row.claimGeneration !== input.fence.claimGeneration ||
            row.privacyGeneration !== input.fence.expectedPrivacyGeneration
          )
            throw new EmailObserverEffectFenceRejectedError();
          const [existingDocument] = await tx
            .select()
            .from(documents)
            .where(and(eq(documents.id, row.documentId), eq(documents.agentId, row.agentId)))
            .limit(1);
          if (!existingDocument) throw new Error('Catalogued email attachment lost its document');
          return { document: existingDocument, duplicate: false, task: null, published: true };
        }
        if (
          row.status !== 'object_written' ||
          row.observerWorkId !== claim.work.id ||
          row.claimToken !== input.fence.claimToken ||
          row.claimGeneration !== input.fence.claimGeneration ||
          row.privacyGeneration !== input.fence.expectedPrivacyGeneration ||
          row.manifestDigest !== claim.prepared.manifestDigest
        )
          throw new EmailObserverEffectFenceRejectedError();
        const entry = claim.prepared.entries[row.attachmentOrdinal];
        if (
          !entry ||
          !isDeepStrictEqual(entry, {
            providerAttachmentId: row.providerAttachmentId,
            ordinal: row.attachmentOrdinal,
            filename: row.filename,
            mime: row.mime,
            advertisedBytes: row.advertisedBytes,
          })
        )
          throw new EmailObserverEffectFenceRejectedError();
        const trust =
          source.ingest.ingestMode === 'forwarded' ? 'unknown' : source.ingest.contentTrust;
        const expectedExtractor = extractorFor(row.mime ?? '', row.filename ?? '');
        const file = input.file;
        const document = input.document;
        if (
          file.agentId !== row.agentId ||
          file.workspacePath !== row.workspacePath ||
          file.emailAttachmentCustodyId !== row.id ||
          file.mime !== row.mime ||
          file.bytes !== row.actualBytes ||
          file.sha256 !== row.sha256 ||
          file.objectGeneration !== row.objectGeneration ||
          !file.objectGeneration ||
          !GENERATION.test(file.objectGeneration) ||
          document.agentId !== row.agentId ||
          document.fileId !== file.id ||
          document.title !== row.filename ||
          document.mime !== row.mime ||
          document.source !== 'email' ||
          document.sourceRef !== `gmail:${row.providerMessageId}` ||
          document.trust !== trust ||
          document.sha256 !== row.sha256 ||
          document.extractor !== expectedExtractor ||
          (expectedExtractor === 'unsupported'
            ? document.status !== 'unsupported'
            : document.status !== 'pending')
        )
          throw new Error('Email attachment catalog input differs from verified custody metadata');
        const [prior] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.agentId, row.agentId), eq(documents.sha256, row.sha256)))
          .for('update')
          .limit(1);
        if (prior) {
          const now = await freshNow(tx);
          if (!matchesPreparedEmailObserverClaim(claim.work, input.fence, now))
            throw new EmailObserverEffectFenceRejectedError();
          const duplicateGeneration = row.objectGeneration;
          if (!duplicateGeneration || !GENERATION.test(duplicateGeneration))
            throw new Error('Duplicate email attachment has no verified object generation');
          const [quarantined] = await tx
            .update(emailAttachmentCustodies)
            .set({
              status: 'cleanup_pending',
              duplicateDocumentId: prior.id,
              updatedAt: now,
            })
            .where(
              and(
                eq(emailAttachmentCustodies.id, row.id),
                eq(emailAttachmentCustodies.agentId, row.agentId),
                eq(emailAttachmentCustodies.status, 'object_written'),
                eq(emailAttachmentCustodies.objectGeneration, duplicateGeneration),
              ),
            )
            .returning({ id: emailAttachmentCustodies.id });
          if (!quarantined) throw new Error('Duplicate email attachment lost its custody row');
          await insertEmailAttachmentCleanupIntent(
            tx,
            row.agentId,
            row.id,
            row.workspacePath,
            duplicateGeneration,
            'content',
          );
          if (row.markerGeneration && row.markerGeneration !== duplicateGeneration)
            await insertEmailAttachmentCleanupIntent(
              tx,
              row.agentId,
              row.id,
              row.workspacePath,
              row.markerGeneration,
              'marker',
            );
          return { document: prior, duplicate: true, task: null, published: false };
        }
        const job =
          document.extractor === 'text' || document.extractor === 'pdf'
            ? 'documents.extract'
            : document.extractor === 'pending_processor'
              ? 'documents.process'
              : null;
        let task: { id: string; queueGeneration: number } | null = null;
        let taskId: string | null = null;
        if (job) {
          const created = await createTask(
            tx as unknown as Db,
            {
              agentId: row.agentId,
              type: 'adhoc',
              trust: 'assistant',
              title: `${job === 'documents.process' ? 'Process' : 'Extract'} ${document.title}`,
              externalEventId: `email-attachment:${row.id}:${job}`,
              budgetUsdLimit: job === 'documents.process' ? '0.05' : '0.50',
              trigger: { source: 'internal', payload: { job, documentId: document.id } },
            },
            tx,
          );
          task = { id: created.task.id, queueGeneration: created.task.queueGeneration };
          taskId = created.task.id;
        }
        const [createdFile] = await tx
          .insert(files)
          .values({ ...file, taskId })
          .onConflictDoNothing({ target: files.id })
          .returning();
        if (!createdFile) throw new Error('Email attachment file ID already exists');
        const [createdDocument] = await tx
          .insert(documents)
          .values(document)
          .onConflictDoNothing({ target: documents.id })
          .returning();
        if (!createdDocument) throw new Error('Email attachment document ID already exists');
        const now = await freshNow(tx);
        if (!matchesPreparedEmailObserverClaim(claim.work, input.fence, now))
          throw new EmailObserverEffectFenceRejectedError();
        await tx
          .update(emailAttachmentCustodies)
          .set({
            status: 'catalogued',
            fileId: createdFile.id,
            documentId: createdDocument.id,
            updatedAt: now,
          })
          .where(eq(emailAttachmentCustodies.id, row.id));
        return { document: createdDocument, duplicate: false, task, published: true };
      });
    },

    async listEmailAttachmentCustodyCleanup(input) {
      const limit = Math.min(Math.max(input.limit, 1), 100);
      const ownerPrefix = `privacy-erasure-asset:${input.agentId}:`;
      const assetPrefix = `${ownerPrefix}email-attachment-custody:`;
      if (input.cursor && !input.cursor.startsWith('email-attachment-custody:'))
        throw new Error('Email attachment cleanup cursor is invalid');
      const rows = await db
        .select({ name: maintenanceCursors.name, cursor: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(
          and(
            like(maintenanceCursors.name, `${assetPrefix}%`),
            ...(input.cursor ? [gt(maintenanceCursors.name, `${ownerPrefix}${input.cursor}`)] : []),
          ),
        )
        .orderBy(asc(maintenanceCursors.name))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const assets = page.map((row) => parseCleanupAsset(input.agentId, row.name, row.cursor));
      const custodyIds = [...new Set(assets.map((asset) => asset.custodyId))];
      const custodyRows = custodyIds.length
        ? await db
            .select()
            .from(emailAttachmentCustodies)
            .where(
              and(
                eq(emailAttachmentCustodies.agentId, input.agentId),
                inArray(emailAttachmentCustodies.id, custodyIds),
              ),
            )
        : [];
      const custodyById = new Map(custodyRows.map((row) => [row.id, row]));
      const items = assets.map((asset) => {
        const custody = custodyById.get(asset.custodyId);
        if (
          !custody ||
          !['erased', 'cleanup_pending', 'duplicate_cleaned'].includes(custody.status) ||
          custody.workspacePath !== asset.workspacePath
        )
          throw new Error('Email attachment cleanup tombstone is invalid');
        return { custody, asset };
      });
      return {
        items,
        nextCursor: rows.length > limit ? (items.at(-1)?.asset.id ?? null) : null,
      };
    },

    async markEmailAttachmentCustodyErased(input) {
      return db.transaction(async (tx) => {
        await lockPostgresPrivacyCleanupFence(tx as unknown as Db, input.agentId);
        const [row] = await tx
          .select()
          .from(emailAttachmentCustodies)
          .where(
            and(
              eq(emailAttachmentCustodies.id, input.custodyId),
              eq(emailAttachmentCustodies.agentId, input.agentId),
            ),
          )
          .for('update')
          .limit(1);
        if (!row) return false;
        if (input.deletedGeneration) {
          if (!GENERATION.test(input.deletedGeneration)) return false;
          const cleanupId = emailAttachmentCustodyCleanupIntentId(row.id, input.deletedGeneration);
          const name = `privacy-erasure-asset:${input.agentId}:${cleanupId}`;
          const [stored] = await tx
            .select({ name: maintenanceCursors.name, cursor: maintenanceCursors.cursor })
            .from(maintenanceCursors)
            .where(eq(maintenanceCursors.name, name))
            .for('update')
            .limit(1);
          if (!stored) return false;
          const asset = parseCleanupAsset(input.agentId, stored.name, stored.cursor);
          if (asset.custodyId !== row.id || asset.workspacePath !== row.workspacePath)
            throw new Error('Email attachment cleanup intent changed before acknowledgement');
          if (row.status === 'erased' || row.status === 'duplicate_cleaned') {
            await tx.delete(maintenanceCursors).where(eq(maintenanceCursors.name, name));
            return true;
          }
          if (row.status !== 'cleanup_pending') return false;
          if (row.duplicateDocumentId || (row.fileId === null && row.documentId !== null)) {
            await tx.delete(maintenanceCursors).where(eq(maintenanceCursors.name, name));
            const remaining = await pendingCleanupAssets(tx, input.agentId, row.id);
            if (remaining.length === 0) {
              if (row.duplicateDocumentId) {
                await tx
                  .update(emailAttachmentCustodies)
                  .set({ status: 'duplicate_cleaned', updatedAt: new Date() })
                  .where(eq(emailAttachmentCustodies.id, row.id));
              } else {
                await eraseCustodyRow(tx, row);
              }
            }
            return true;
          }
          const currentGeneration = row.objectGeneration ?? row.markerGeneration;
          const currentState = row.objectGeneration ? 'content' : 'marker';
          if (currentGeneration !== input.deletedGeneration || currentState !== asset.objectState)
            return false;
          await tx.delete(maintenanceCursors).where(eq(maintenanceCursors.name, name));
          await eraseCustodyRow(tx, row);
          return true;
        }
        if (row.status === 'erased') return false;
        if (row.markerGeneration)
          await insertEmailAttachmentCleanupIntent(
            tx,
            row.agentId,
            row.id,
            row.workspacePath,
            row.markerGeneration,
            'marker',
            row.documentId,
          );
        if (row.objectGeneration)
          await insertEmailAttachmentCleanupIntent(
            tx,
            row.agentId,
            row.id,
            row.workspacePath,
            row.objectGeneration,
            'content',
            row.documentId,
          );
        await eraseCustodyRow(tx, row);
        return true;
      });
    },
  };
}
