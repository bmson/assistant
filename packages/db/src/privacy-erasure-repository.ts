import { createHash, randomUUID } from 'node:crypto';
import type {
  PrivacyErasureAsset,
  PrivacyErasureCounts,
  PrivacyErasureRepository,
} from '@assistant/persistence';
import {
  emailAttachmentCustodyCleanupIntentId,
  notificationDashboardMessageId,
} from '@assistant/persistence';
import { and, asc, eq, gt, inArray, like, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  agents,
  conversations,
  documentChunks,
  documents,
  emailAttachmentCustodies,
  emailIngest,
  emailObserverSources,
  emailObserverWork,
  files,
  importSources,
  knowledgeGraphAssertionEvidence,
  knowledgeGraphAssertions,
  knowledgeGraphEntities,
  knowledgeGraphEntityAliases,
  knowledgeGraphRelations,
  maintenanceCursors,
  memories,
  memoryTombstones,
  messages,
  missionReports,
  notificationOutbox,
  occasions,
  ownerCard,
  recallSurfaces,
  securityIncidentAttention,
  securityIncidentSources,
  securityIncidents,
  selfRepairIssues,
  situationPacks,
  situationPreviews,
  tasks,
  toolCallReceiptKeys,
  toolCallReceipts,
  voiceProfile,
  watchFireEffects,
  watchFires,
  writingSamples,
} from './schema.js';

const assetPrefix = (agentId: string) => `privacy-erasure-asset:${agentId}:`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const resultName = (agentId: string) => `privacy-erasure-result:${agentId}`;
const generationName = (agentId: string) => `privacy-erasure-generation:${agentId}`;
const activeName = (agentId: string) => `privacy-erasure-active:${agentId}`;
const ATTACHMENT_ERASURE_PAGE_SIZE = 32;
const preparedExtractionPrefix = (agentId: string) => `prepared-memory-extraction:${agentId}:%`;
const documentDeletionAssetId = (documentId: string, path: string) =>
  `document-delete:${documentId}:${createHash('sha256').update(path).digest('hex')}`;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

type ActivePrivacyErasure = {
  version: 1;
  generation: string;
  phase: 'attachments' | 'attachments_complete' | 'awaiting_cleanup';
  afterId: string | null;
};

type EmailAttachmentPrivacyAsset = Extract<
  PrivacyErasureAsset,
  { kind: 'email_attachment_custody' }
>;

function emailAttachmentCleanupAsset(
  row: Pick<typeof emailAttachmentCustodies.$inferSelect, 'id' | 'workspacePath'>,
  generation: string,
  objectState: 'marker' | 'content',
): EmailAttachmentPrivacyAsset {
  return {
    kind: 'email_attachment_custody',
    id: emailAttachmentCustodyCleanupIntentId(row.id, generation),
    workspacePath: row.workspacePath,
    custodyId: row.id,
    generation,
    objectState,
  };
}

function parsePrivacyAsset(id: string, cursor: string | null): PrivacyErasureAsset {
  if (!cursor) throw new Error('Privacy erasure asset has no workspace path');
  if (!cursor.startsWith('{')) return { kind: 'workspace_path', id, workspacePath: cursor };
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw new Error('Privacy erasure asset metadata is malformed');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Privacy erasure asset metadata is malformed');
  const asset = value as Record<string, unknown>;
  const allowedKeys = ['kind', 'id', 'workspacePath', 'custodyId', 'generation', 'objectState'];
  if (Object.hasOwn(asset, 'documentId')) allowedKeys.push('documentId');
  if (
    asset.kind !== 'email_attachment_custody' ||
    asset.id !== id ||
    typeof asset.workspacePath !== 'string' ||
    typeof asset.custodyId !== 'string' ||
    typeof asset.generation !== 'string' ||
    !/^[1-9]\d{0,30}$/.test(asset.generation) ||
    !['marker', 'content'].includes(String(asset.objectState)) ||
    Object.keys(asset).some((key) => !allowedKeys.includes(key)) ||
    (Object.hasOwn(asset, 'documentId') &&
      (typeof asset.documentId !== 'string' || !UUID.test(asset.documentId))) ||
    emailAttachmentCustodyCleanupIntentId(asset.custodyId, asset.generation) !== id
  )
    throw new Error('Email attachment cleanup intent identity is malformed');
  return {
    kind: 'email_attachment_custody',
    id,
    workspacePath: asset.workspacePath,
    custodyId: asset.custodyId,
    generation: asset.generation,
    objectState: asset.objectState as 'marker' | 'content',
    ...(typeof asset.documentId === 'string' ? { documentId: asset.documentId } : {}),
  };
}

function serializeEmailAttachmentAsset(
  asset: EmailAttachmentPrivacyAsset,
  documentId?: string | null,
): string {
  return JSON.stringify({
    kind: asset.kind,
    id: asset.id,
    workspacePath: asset.workspacePath,
    custodyId: asset.custodyId,
    generation: asset.generation,
    objectState: asset.objectState,
    ...(documentId ? { documentId } : {}),
  });
}

function storedEmailAttachmentDocumentId(cursor: string | null): string | null {
  if (!cursor?.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(cursor) as { documentId?: unknown };
    return typeof parsed.documentId === 'string' ? parsed.documentId : null;
  } catch {
    return null;
  }
}

function storedEmailAttachmentAssetMatches(
  cursor: string | null,
  asset: EmailAttachmentPrivacyAsset,
): boolean {
  try {
    const parsed = parsePrivacyAsset(asset.id, cursor);
    return (
      parsed.kind === 'email_attachment_custody' &&
      parsed.workspacePath === asset.workspacePath &&
      parsed.custodyId === asset.custodyId &&
      parsed.generation === asset.generation &&
      parsed.objectState === asset.objectState &&
      parsed.documentId === asset.documentId
    );
  } catch {
    return false;
  }
}

async function scrubDocumentDeletedCustody(
  tx: Tx,
  row: typeof emailAttachmentCustodies.$inferSelect,
  documentId: string,
): Promise<void> {
  if (row.status !== 'cleanup_pending' || row.fileId !== null || row.documentId !== documentId)
    throw new Error('Document deletion custody linkage changed before final cleanup');
  await tx
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
        eq(emailAttachmentCustodies.status, 'cleanup_pending'),
        eq(emailAttachmentCustodies.documentId, documentId),
      ),
    );
}

async function insertPrivacyAsset(
  tx: Pick<Db, 'select' | 'insert'>,
  agentId: string,
  id: string,
  workspacePath: string,
): Promise<void> {
  const name = `${assetPrefix(agentId)}${id}`;
  const [existing] = await tx
    .select({ cursor: maintenanceCursors.cursor })
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, name))
    .limit(1);
  if (existing) {
    if (existing.cursor !== workspacePath) throw new Error('Privacy asset cleanup path changed');
    return;
  }
  await tx.insert(maintenanceCursors).values({ name, cursor: workspacePath });
}

function parseActiveErasure(cursor: string | null): ActivePrivacyErasure {
  if (!cursor) throw new Error('Active privacy erasure state is missing');
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw new Error('Active privacy erasure state is malformed');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Active privacy erasure state is malformed');
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    typeof state.generation !== 'string' ||
    !UUID.test(state.generation) ||
    !['attachments', 'attachments_complete', 'awaiting_cleanup'].includes(String(state.phase)) ||
    (state.afterId !== null && (typeof state.afterId !== 'string' || !UUID.test(state.afterId))) ||
    Object.keys(state).some((key) => !['version', 'generation', 'phase', 'afterId'].includes(key))
  )
    throw new Error('Active privacy erasure state is malformed');
  return state as ActivePrivacyErasure;
}

async function readActiveErasure(tx: Tx, agentId: string): Promise<ActivePrivacyErasure> {
  const [row] = await tx
    .select({ cursor: maintenanceCursors.cursor })
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, activeName(agentId)))
    .for('update')
    .limit(1);
  return parseActiveErasure(row?.cursor ?? null);
}

async function ensureActiveErasure(db: Db, agentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for('update')
      .limit(1);
    if (!owner) throw new Error('Privacy erasure owner is unavailable');
    const [current] = await tx
      .select({ cursor: maintenanceCursors.cursor })
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, activeName(agentId)))
      .for('update')
      .limit(1);
    if (current) {
      parseActiveErasure(current.cursor);
      return;
    }
    const state: ActivePrivacyErasure = {
      version: 1,
      generation: randomUUID(),
      phase: 'attachments',
      afterId: null,
    };
    await tx.insert(maintenanceCursors).values({
      name: activeName(agentId),
      cursor: JSON.stringify(state),
    });
  });
}

async function eraseAttachmentCustodyPage(db: Db, agentId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for('update')
      .limit(1);
    if (!owner) throw new Error('Privacy erasure owner is unavailable');
    const state = await readActiveErasure(tx, agentId);
    if (state.phase !== 'attachments') return true;
    const page = await tx
      .select()
      .from(emailAttachmentCustodies)
      .where(
        and(
          eq(emailAttachmentCustodies.agentId, agentId),
          state.afterId ? gt(emailAttachmentCustodies.id, state.afterId) : undefined,
        ),
      )
      .orderBy(asc(emailAttachmentCustodies.id))
      .limit(ATTACHMENT_ERASURE_PAGE_SIZE)
      .for('update');
    if (page.length === 0) {
      const completed = { ...state, phase: 'attachments_complete' as const };
      await tx
        .update(maintenanceCursors)
        .set({ cursor: JSON.stringify(completed), updatedAt: new Date() })
        .where(eq(maintenanceCursors.name, activeName(agentId)));
      return true;
    }

    for (const custody of page) {
      const cleanup = [
        ...(custody.markerGeneration && custody.markerGeneration !== custody.objectGeneration
          ? [{ generation: custody.markerGeneration, objectState: 'marker' as const }]
          : []),
        ...(custody.objectGeneration
          ? [{ generation: custody.objectGeneration, objectState: 'content' as const }]
          : custody.markerGeneration
            ? [{ generation: custody.markerGeneration, objectState: 'marker' as const }]
            : []),
      ];
      for (const { generation, objectState } of cleanup) {
        const asset = emailAttachmentCleanupAsset(custody, generation, objectState);
        await tx
          .insert(maintenanceCursors)
          .values({
            name: `${assetPrefix(agentId)}${asset.id}`,
            cursor: serializeEmailAttachmentAsset(asset),
          })
          .onConflictDoUpdate({
            target: maintenanceCursors.name,
            set: {
              cursor: serializeEmailAttachmentAsset(asset),
              updatedAt: new Date(),
            },
          });
      }
    }
    const documentIds = page.map((row) => row.documentId).filter((id): id is string => !!id);
    const fileIds = page.map((row) => row.fileId).filter((id): id is string => !!id);
    const attachmentDocuments = documentIds.length
      ? await tx
          .select()
          .from(documents)
          .where(and(eq(documents.agentId, agentId), inArray(documents.id, documentIds)))
          .for('update')
      : [];
    for (const document of attachmentDocuments) {
      const outputPath = `documents/${document.id}/extracted.txt`;
      const paths = [document.processedTextPath, outputPath].filter(
        (path): path is string => typeof path === 'string' && path.length > 0,
      );
      for (const path of new Set(paths))
        await insertPrivacyAsset(tx, agentId, documentDeletionAssetId(document.id, path), path);
      if (document.processorTokenHash) {
        const tombstone = {
          agentId,
          documentId: document.id,
          processorTokenHash: document.processorTokenHash,
          outputPath,
        };
        await tx
          .insert(maintenanceCursors)
          .values({
            name: `document-delete-tombstone:${document.id}`,
            cursor: JSON.stringify(tombstone),
          })
          .onConflictDoUpdate({
            target: maintenanceCursors.name,
            set: { cursor: JSON.stringify(tombstone), updatedAt: new Date() },
          });
        await insertPrivacyAsset(tx, agentId, `document-delete-worker:${document.id}`, outputPath);
      }
      await tx
        .update(tasks)
        .set({
          status: 'cancelled',
          lockedUntil: null,
          runAfter: null,
          leaseToken: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(tasks.agentId, agentId),
            inArray(tasks.status, ['pending', 'sleeping', 'running', 'needs_attention']),
            sql`${tasks.trigger}->'payload'->>'job' IN ('documents.extract','documents.process')`,
            sql`${tasks.trigger}->'payload'->>'documentId' = ${document.id}`,
          ),
        );
    }
    if (documentIds.length)
      await tx
        .delete(documentChunks)
        .where(
          and(eq(documentChunks.agentId, agentId), inArray(documentChunks.documentId, documentIds)),
        );
    if (documentIds.length)
      await tx
        .delete(documents)
        .where(and(eq(documents.agentId, agentId), inArray(documents.id, documentIds)));
    if (fileIds.length)
      await tx.delete(files).where(and(eq(files.agentId, agentId), inArray(files.id, fileIds)));
    const pageIds = page.map((row) => row.id);
    await tx
      .update(emailAttachmentCustodies)
      .set({
        status: 'erased',
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
        fileId: null,
        documentId: null,
        duplicateDocumentId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(emailAttachmentCustodies.agentId, agentId),
          inArray(emailAttachmentCustodies.id, pageIds),
        ),
      );
    const next: ActivePrivacyErasure = {
      ...state,
      afterId: page.at(-1)?.id ?? state.afterId,
    };
    await tx
      .update(maintenanceCursors)
      .set({ cursor: JSON.stringify(next), updatedAt: new Date() })
      .where(eq(maintenanceCursors.name, activeName(agentId)));
    return false;
  });
}

/** A completed erase still invalidates source reads begun before it. */
export async function postgresPrivacyObservationFence(
  db: Pick<Db, 'select'>,
  agentId: string,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(maintenanceCursors)
    .where(
      inArray(maintenanceCursors.name, [
        resultName(agentId),
        generationName(agentId),
        activeName(agentId),
      ]),
    );
  if (rows.some((row) => row.name === resultName(agentId) || row.name === activeName(agentId)))
    throw new Error('Privacy erasure is in progress');
  const generation = rows.find((row) => row.name === generationName(agentId));
  if (!generation) return null;
  if (!generation.cursor || generation.cursor.length > 100)
    throw new Error('Privacy erasure generation is malformed');
  return generation.cursor;
}

/**
 * Acquire the owner-side serialization lock used by privacy erasure and
 * return the generation that applies to source observations made afterwards.
 * Call this as the first statement in the writer transaction, before reading
 * any private source rows. The NO KEY UPDATE lock conflicts with erasure's
 * FOR UPDATE lock but remains compatible with ordinary foreign-key checks.
 */
export async function lockPostgresPrivacyObservationFence(
  tx: Pick<Db, 'select'>,
  agentId: string,
): Promise<string | null> {
  const [owner] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, agentId))
    .for('no key update');
  if (!owner) throw new Error('Privacy owner row is unavailable');
  return postgresPrivacyObservationFence(tx, agentId);
}

/**
 * Serialize metadata-only late object receipts with erasure pages. This fence
 * deliberately permits the active erase marker: callers may only add exact
 * opaque cleanup generations to a custody tombstone, never restore source data.
 */
export async function lockPostgresPrivacyCleanupFence(
  tx: Pick<Db, 'select'>,
  agentId: string,
): Promise<string | null> {
  const [owner] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, agentId))
    .for('update');
  if (!owner) throw new Error('Privacy owner row is unavailable');
  const [active] = await tx
    .select({ cursor: maintenanceCursors.cursor })
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, activeName(agentId)))
    .for('update')
    .limit(1);
  if (active) return parseActiveErasure(active.cursor).generation;
  const [generation] = await tx
    .select({ cursor: maintenanceCursors.cursor })
    .from(maintenanceCursors)
    .where(eq(maintenanceCursors.name, generationName(agentId)))
    .limit(1);
  if (!generation) return null;
  if (!generation.cursor || generation.cursor.length > 100)
    throw new Error('Privacy erasure generation is malformed');
  return generation.cursor;
}

/** Fail a writer if its source observation predates an erase committed later. */
export async function assertPostgresPrivacyObservationFence(
  tx: Pick<Db, 'select'>,
  agentId: string,
  observed: string | null,
): Promise<void> {
  const current = await postgresPrivacyObservationFence(tx, agentId);
  if (current !== observed) throw new Error('Privacy erasure changed during observation');
}

/**
 * Keep an owner-scoped read composition ordered against privacy erasure. The
 * owner row lock serializes this read with the erasure transaction, and the
 * generation check catches a completed erase between an earlier discovery
 * step and acquiring the lock. The callback may use the same pool for its
 * ordinary reads; it must remain bounded so the lock is short lived.
 */
export async function withPostgresPrivacyObservationFence<T>(
  db: Db,
  agentId: string,
  read: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const observed = await lockPostgresPrivacyObservationFence(tx, agentId);
    const value = await read();
    await assertPostgresPrivacyObservationFence(tx, agentId, observed);
    return value;
  });
}

function savedCounts(value: string | null): PrivacyErasureCounts {
  if (!value) return { memories: 0, graphRelations: 0, writingSamples: 0, securityIncidents: 0 };
  const parsed = JSON.parse(value) as Partial<PrivacyErasureCounts>;
  const counts: PrivacyErasureCounts = {
    ...parsed,
    securityIncidents: parsed.securityIncidents ?? 0,
  } as PrivacyErasureCounts;
  if (
    [counts.memories, counts.graphRelations, counts.writingSamples, counts.securityIncidents].some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    )
  )
    throw new Error('Invalid saved privacy erasure counts');
  return counts;
}

async function soleOwner(db: Db) {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .orderBy(asc(agents.createdAt), asc(agents.id))
    .limit(2);
  if (rows.length !== 1 || !rows[0])
    throw new Error('Privacy erasure requires exactly one configured owner');
  return rows[0].id;
}

export function createPostgresPrivacyErasureRepository(db: Db): PrivacyErasureRepository {
  return {
    kind: 'privacy-erasure-repository',
    async erase() {
      const agentId = await soleOwner(db);
      await ensureActiveErasure(db, agentId);
      while (!(await eraseAttachmentCustodyPage(db, agentId))) {
        // Each page commits its tombstones and cursor independently. A later
        // call resumes from that cursor while the active owner fence remains.
      }
      return db.transaction(async (tx) => {
        const owners = await tx
          .select({ id: agents.id })
          .from(agents)
          .orderBy(asc(agents.createdAt), asc(agents.id))
          .limit(2)
          .for('update');
        if (owners.length !== 1 || !owners[0])
          throw new Error('Privacy erasure requires exactly one configured owner');
        const agentId = owners[0].id;
        const active = await readActiveErasure(tx, agentId);
        if (!['attachments_complete', 'awaiting_cleanup'].includes(active.phase))
          throw new Error('Attachment privacy erasure is not complete');
        const generation = active.generation;
        // Import snapshot writers hold this lock across blob publication. Wait
        // for them before fencing tasks and copying their durable asset list.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('assistant:import-snapshot'))`);
        // Watch outbox payloads can contain private notice/proposal text. Clear
        // them and source-fire rows under the same owner erasure transaction,
        // so a retried suggestion job cannot reconstruct a cleared message.
        await tx.delete(watchFireEffects).where(eq(watchFireEffects.agentId, agentId));
        await tx.delete(watchFires).where(eq(watchFires.agentId, agentId));
        await tx
          .update(emailIngest)
          .set({
            securityEvidence: null,
            securityIncidentId: null,
            preparedExtraction: null,
            emailContentProvenance: null,
            directRouting: null,
            directRecoveryReason: null,
          })
          .where(eq(emailIngest.agentId, agentId));
        await tx
          .delete(securityIncidentAttention)
          .where(eq(securityIncidentAttention.agentId, agentId));
        await tx
          .delete(securityIncidentSources)
          .where(eq(securityIncidentSources.agentId, agentId));
        const erasedSecurityIncidents = await tx
          .delete(securityIncidents)
          .where(eq(securityIncidents.agentId, agentId))
          .returning({ id: securityIncidents.id });
        const erasedObserverWork = await tx
          .update(emailObserverWork)
          .set({
            status: sql`case when ${emailObserverWork.status} in ('pending','retryable_failed') then 'skipped_erased' when ${emailObserverWork.status} in ('claimed','prepared') then 'unknown' else ${emailObserverWork.status} end`,
            privacyGeneration: generation,
            preparedResult: null,
            deliveryKey: null,
            claimToken: null,
            leaseExpiresAt: null,
            lastErrorCode: 'privacy_erased',
            updatedAt: new Date(),
          })
          .where(eq(emailObserverWork.agentId, agentId))
          .returning({ id: emailObserverWork.id });
        // Dashboard notice text is persisted as a normal message. Remove it
        // through the stable owner + producer-work + delivery identity while
        // this transaction still holds the owner's privacy-erasure lock.
        // External deliveries are handled below as unknown/no-retry and are
        // never called or replayed from erasure.
        const observerWorkIds = erasedObserverWork.map(({ id }) => id);
        if (observerWorkIds.length > 0) {
          const dashboardLegs = await tx
            .select({
              deliveryKey: notificationOutbox.deliveryKey,
              legKey: notificationOutbox.legKey,
            })
            .from(notificationOutbox)
            .where(
              and(
                eq(notificationOutbox.agentId, agentId),
                inArray(notificationOutbox.producerWorkId, observerWorkIds),
                eq(notificationOutbox.adapter, 'dashboard'),
              ),
            );
          const dashboardChannelIds = dashboardLegs.map(({ deliveryKey, legKey }) =>
            notificationDashboardMessageId(agentId, deliveryKey, legKey),
          );
          if (dashboardChannelIds.length > 0) {
            const deliveredMessages = await tx
              .select({ id: messages.id, ownerId: conversations.agentId })
              .from(messages)
              .innerJoin(conversations, eq(messages.conversationId, conversations.id))
              .where(inArray(messages.channelMessageId, dashboardChannelIds));
            if (deliveredMessages.some((message) => message.ownerId !== agentId))
              throw new Error('Email observer notice points to another owner message');
            const deliveredMessageIds = deliveredMessages.map(({ id }) => id);
            if (deliveredMessageIds.length > 0)
              await tx.delete(messages).where(inArray(messages.id, deliveredMessageIds));
          }
        }
        await tx.delete(emailObserverSources).where(eq(emailObserverSources.agentId, agentId));
        await tx
          .update(emailIngest)
          .set({
            classificationStatus: sql`case when ${emailIngest.classificationStatus} = 'in_progress' then 'unknown' else ${emailIngest.classificationStatus} end`,
            classificationClaimToken: null,
            preparedClassification: null,
          })
          .where(eq(emailIngest.agentId, agentId));
        await tx
          .insert(maintenanceCursors)
          .values({
            name: generationName(agentId),
            cursor: generation,
          })
          .onConflictDoUpdate({
            target: maintenanceCursors.name,
            set: { cursor: generation, updatedAt: new Date() },
          });
        await tx.delete(selfRepairIssues).where(eq(selfRepairIssues.agentId, agentId));
        await tx.delete(recallSurfaces).where(eq(recallSurfaces.agentId, agentId));
        await tx.delete(toolCallReceipts).where(eq(toolCallReceipts.agentId, agentId));
        await tx.delete(toolCallReceiptKeys).where(eq(toolCallReceiptKeys.agentId, agentId));
        // Drop resumable source-deletion progress with the owner source rows.
        // Raw/snapshot asset intents use a separate privacy-erasure prefix and
        // deliberately survive until their physical deletes are acknowledged.
        await tx
          .delete(maintenanceCursors)
          .where(like(maintenanceCursors.name, `import-source-delete-job:${agentId}:%`));
        await tx
          .delete(maintenanceCursors)
          .where(like(maintenanceCursors.name, `import-source-delete-node:${agentId}:%`));
        await tx
          .delete(maintenanceCursors)
          .where(like(maintenanceCursors.name, `import-source-delete-result:${agentId}:%`));
        await tx
          .delete(maintenanceCursors)
          .where(like(maintenanceCursors.name, `import-source-purge-job:${agentId}:%`));
        await tx
          .delete(maintenanceCursors)
          .where(like(maintenanceCursors.name, `import-source-purge-node:${agentId}:%`));
        await tx
          .delete(maintenanceCursors)
          .where(like(maintenanceCursors.name, `import-source-purge-result:${agentId}:%`));
        await tx
          .delete(maintenanceCursors)
          .where(like(maintenanceCursors.name, `memory-embedding-refresh:${agentId}:%`));
        // Retain report identities and settled receipts so maintenance cannot rebuild
        // an erased report or replay an already accepted/ambiguous delivery.
        await tx
          .update(missionReports)
          .set({
            text: '',
            chatStatus: sql`case when ${missionReports.chatStatus} in ('pending', 'failed') then 'skipped' else ${missionReports.chatStatus} end`,
            ownerStatus: sql`case when ${missionReports.ownerStatus} in ('pending', 'failed') then 'skipped' else ${missionReports.ownerStatus} end`,
            mirrorStatus: sql`case when ${missionReports.mirrorStatus} in ('pending', 'failed') then 'skipped' else ${missionReports.mirrorStatus} end`,
          })
          .where(eq(missionReports.agentId, agentId));
        await tx
          .update(notificationOutbox)
          .set({
            destination: null,
            payload: null,
            status: sql`case when ${notificationOutbox.status} in ('pending','failed') then 'skipped' when ${notificationOutbox.status} = 'sending' then 'unknown' else ${notificationOutbox.status} end`,
            retryable: false,
            leaseToken: null,
            leaseUntil: null,
            result: null,
            finishedAt: sql`coalesce(${notificationOutbox.finishedAt}, now())`,
            updatedAt: new Date(),
          })
          .where(eq(notificationOutbox.agentId, agentId));
        const [memoryRows, sourceImports, packs] = await Promise.all([
          tx
            .select({ id: memories.id, contentHash: memories.contentHash })
            .from(memories)
            .where(eq(memories.agentId, agentId)),
          tx
            .select({
              id: importSources.id,
              taskId: importSources.taskId,
              workspacePath: importSources.workspacePath,
              source: importSources.source,
            })
            .from(importSources)
            .where(eq(importSources.agentId, agentId))
            .for('update'),
          tx
            .select({ id: situationPacks.id })
            .from(situationPacks)
            .where(eq(situationPacks.agentId, agentId))
            .for('update'),
        ]);
        if (packs.length)
          await tx.delete(situationPreviews).where(
            inArray(
              situationPreviews.packId,
              packs.map((pack) => pack.id),
            ),
          );
        await tx
          .update(situationPacks)
          .set({
            data: sql`jsonb_set(${situationPacks.data}, '{decisions}', '[]'::jsonb)`,
            version: sql`${situationPacks.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(situationPacks.agentId, agentId),
              sql`coalesce(${situationPacks.data}->'decisions', 'null'::jsonb) <> '[]'::jsonb`,
            ),
          );
        if (memoryRows.length)
          await tx
            .insert(memoryTombstones)
            .values(
              memoryRows.map((row) => ({ contentHash: row.contentHash, reason: 'owner_forget' })),
            )
            .onConflictDoNothing({ target: memoryTombstones.contentHash });
        const taskIds = sourceImports.map((row) => row.taskId).filter((id): id is string => !!id);
        if (taskIds.length)
          await tx
            .update(tasks)
            .set({ status: 'cancelled', lockedUntil: null, runAfter: null, updatedAt: sql`now()` })
            .where(
              and(
                eq(tasks.agentId, agentId),
                inArray(tasks.id, taskIds),
                inArray(tasks.status, ['pending', 'sleeping', 'running', 'needs_attention']),
              ),
            );
        for (const source of sourceImports) {
          const snapshotPrefix = `import-snapshot-asset:${source.id}:%`;
          const snapshotAssets = await tx
            .select({ path: maintenanceCursors.cursor })
            .from(maintenanceCursors)
            .where(like(maintenanceCursors.name, snapshotPrefix));
          const assets = [
            source.workspacePath,
            ...snapshotAssets.map((asset) => asset.path),
          ].filter((path): path is string => !!path);
          for (const [index, path] of [...new Set(assets)].entries()) {
            const suffix =
              index === 0
                ? source.id
                : `${source.id}:${createHash('sha256').update(path).digest('hex')}`;
            const name = `${assetPrefix(agentId)}${suffix}`;
            const [existing] = await tx
              .select({ path: maintenanceCursors.cursor })
              .from(maintenanceCursors)
              .where(eq(maintenanceCursors.name, name))
              .limit(1);
            if (existing && existing.path !== path)
              throw new Error('Privacy asset cleanup path changed');
            await tx
              .insert(maintenanceCursors)
              .values({ name, cursor: path })
              .onConflictDoNothing({ target: maintenanceCursors.name });
          }
          await tx.delete(maintenanceCursors).where(like(maintenanceCursors.name, snapshotPrefix));
        }
        if (sourceImports.length)
          await tx.delete(importSources).where(
            and(
              eq(importSources.agentId, agentId),
              inArray(
                importSources.id,
                sourceImports.map((row) => row.id),
              ),
            ),
          );
        const relations = await tx
          .delete(knowledgeGraphRelations)
          .where(eq(knowledgeGraphRelations.agentId, agentId))
          .returning({ id: knowledgeGraphRelations.id });
        await tx
          .delete(knowledgeGraphAssertionEvidence)
          .where(eq(knowledgeGraphAssertionEvidence.agentId, agentId));
        await tx
          .delete(knowledgeGraphAssertions)
          .where(eq(knowledgeGraphAssertions.agentId, agentId));
        await tx
          .delete(knowledgeGraphEntityAliases)
          .where(eq(knowledgeGraphEntityAliases.agentId, agentId));
        await tx.delete(knowledgeGraphEntities).where(eq(knowledgeGraphEntities.agentId, agentId));
        await tx
          .delete(maintenanceCursors)
          .where(like(maintenanceCursors.name, preparedExtractionPrefix(agentId)));
        await tx.delete(memories).where(eq(memories.agentId, agentId));
        await tx.delete(occasions).where(eq(occasions.agentId, agentId));
        const samples = await tx.delete(writingSamples).returning({ id: writingSamples.id });
        const now = new Date();
        await tx
          .insert(ownerCard)
          .values({ id: 1, content: '', compiledAt: now })
          .onConflictDoUpdate({
            target: ownerCard.id,
            set: { content: '', compiledAt: now },
          });
        await tx
          .insert(voiceProfile)
          .values({ id: 1, description: '', dos: [], donts: [], signature: '', updatedAt: now })
          .onConflictDoUpdate({
            target: voiceProfile.id,
            set: { description: '', dos: [], donts: [], signature: '', updatedAt: now },
          });
        const [previous] = await tx
          .select({ cursor: maintenanceCursors.cursor })
          .from(maintenanceCursors)
          .where(eq(maintenanceCursors.name, resultName(agentId)))
          .limit(1);
        const before = savedCounts(previous?.cursor ?? null);
        const counts = {
          memories: before.memories + memoryRows.length,
          graphRelations: before.graphRelations + relations.length,
          writingSamples: before.writingSamples + samples.length,
          securityIncidents: before.securityIncidents + erasedSecurityIncidents.length,
        };
        await tx
          .insert(maintenanceCursors)
          .values({ name: resultName(agentId), cursor: JSON.stringify(counts) })
          .onConflictDoUpdate({
            target: maintenanceCursors.name,
            set: { cursor: JSON.stringify(counts), updatedAt: new Date() },
          });
        await tx
          .update(maintenanceCursors)
          .set({
            cursor: JSON.stringify({ ...active, phase: 'awaiting_cleanup' }),
            updatedAt: new Date(),
          })
          .where(eq(maintenanceCursors.name, activeName(agentId)));
        return counts;
      });
    },
    async pendingAssets() {
      const agentId = await soleOwner(db);
      const prefix = assetPrefix(agentId);
      const rows = await db
        .select({ name: maintenanceCursors.name, path: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(like(maintenanceCursors.name, `${prefix}%`))
        .limit(100);
      return rows.map((row) => parsePrivacyAsset(row.name.slice(prefix.length), row.path));
    },
    async assetDeleted(assetOrId) {
      const agentId = await soleOwner(db);
      const asset = typeof assetOrId === 'string' ? null : assetOrId;
      const id = typeof assetOrId === 'string' ? assetOrId : assetOrId.id;
      await db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, agentId))
          .for('update');
        if (!owner) throw new Error('Privacy erasure owner is unavailable');
        if (id.startsWith('document-delete-worker:')) {
          const documentId = id.slice('document-delete-worker:'.length);
          const [tombstone] = await tx
            .select({ name: maintenanceCursors.name })
            .from(maintenanceCursors)
            .where(eq(maintenanceCursors.name, `document-delete-tombstone:${documentId}`))
            .for('update');
          if (tombstone) throw new Error('Document processor callback remains unresolved');
        }
        const name = `${assetPrefix(agentId)}${id}`;
        const [stored] = await tx
          .select({ cursor: maintenanceCursors.cursor })
          .from(maintenanceCursors)
          .where(eq(maintenanceCursors.name, name))
          .for('update');
        if (!stored) return;
        if (!asset && stored.cursor?.startsWith('{')) {
          const storedAsset = parsePrivacyAsset(id, stored.cursor);
          if (storedAsset.kind === 'email_attachment_custody')
            throw new Error('Email attachment cleanup acknowledgement requires the exact asset');
        }
        if (asset?.kind === 'email_attachment_custody') {
          if (!storedEmailAttachmentAssetMatches(stored.cursor, asset))
            throw new Error('Email attachment cleanup intent changed before acknowledgement');
          const [custody] = await tx
            .select()
            .from(emailAttachmentCustodies)
            .where(
              and(
                eq(emailAttachmentCustodies.id, asset.custodyId),
                eq(emailAttachmentCustodies.agentId, agentId),
              ),
            )
            .for('update');
          const documentDeleteCleanup =
            custody?.status === 'cleanup_pending' &&
            custody.fileId === null &&
            !!asset.documentId &&
            custody.documentId === asset.documentId &&
            storedEmailAttachmentDocumentId(stored.cursor) === asset.documentId;
          if (
            !custody ||
            custody.workspacePath !== asset.workspacePath ||
            (custody.status !== 'erased' && !documentDeleteCleanup)
          )
            throw new Error('Email attachment cleanup custody tombstone is invalid');
          if (documentDeleteCleanup) {
            await tx.delete(maintenanceCursors).where(eq(maintenanceCursors.name, name));
            const remaining = await tx
              .select({ name: maintenanceCursors.name })
              .from(maintenanceCursors)
              .where(
                like(
                  maintenanceCursors.name,
                  `${assetPrefix(agentId)}email-attachment-custody:${asset.custodyId}:%`,
                ),
              );
            if (remaining.length === 0 && asset.documentId)
              await scrubDocumentDeletedCustody(tx, custody, asset.documentId);
            return;
          }
        } else if (asset && stored.cursor !== asset.workspacePath) {
          throw new Error('Privacy asset changed before acknowledgement');
        }
        await tx.delete(maintenanceCursors).where(eq(maintenanceCursors.name, name));
      });
    },
    async refreshEmailAttachmentCustodyCleanupIntent(asset, observed) {
      if (
        asset.kind !== 'email_attachment_custody' ||
        asset.id !== emailAttachmentCustodyCleanupIntentId(asset.custodyId, asset.generation) ||
        !/^[1-9]\d{0,30}$/.test(observed.generation) ||
        !['marker', 'content'].includes(observed.objectState)
      )
        throw new Error('Email attachment cleanup refresh identity is malformed');
      const agentId = await soleOwner(db);
      await db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, agentId))
          .for('update');
        if (!owner) throw new Error('Privacy erasure owner is unavailable');
        const oldName = `${assetPrefix(agentId)}${asset.id}`;
        const [stored] = await tx
          .select({ cursor: maintenanceCursors.cursor })
          .from(maintenanceCursors)
          .where(eq(maintenanceCursors.name, oldName))
          .for('update');
        if (!stored || !storedEmailAttachmentAssetMatches(stored.cursor, asset))
          throw new Error('Email attachment cleanup intent changed before refresh');
        const linkedDocumentId = storedEmailAttachmentDocumentId(stored.cursor);
        const [custody] = await tx
          .select()
          .from(emailAttachmentCustodies)
          .where(
            and(
              eq(emailAttachmentCustodies.id, asset.custodyId),
              eq(emailAttachmentCustodies.agentId, agentId),
            ),
          )
          .for('update');
        const documentDeleteCleanup =
          custody?.status === 'cleanup_pending' &&
          custody.fileId === null &&
          !!asset.documentId &&
          custody.documentId === asset.documentId &&
          linkedDocumentId === asset.documentId;
        if (
          !custody ||
          custody.workspacePath !== asset.workspacePath ||
          (custody.status !== 'erased' && !documentDeleteCleanup)
        )
          throw new Error('Email attachment cleanup custody tombstone is invalid');
        const replacement = emailAttachmentCleanupAsset(
          custody,
          observed.generation,
          observed.objectState,
        );
        const replacementName = `${assetPrefix(agentId)}${replacement.id}`;
        const replacementCursor = serializeEmailAttachmentAsset(replacement, linkedDocumentId);
        if (replacementName === oldName) {
          await tx
            .update(maintenanceCursors)
            .set({ cursor: replacementCursor, updatedAt: new Date() })
            .where(eq(maintenanceCursors.name, oldName));
        } else {
          const [existing] = await tx
            .select({ cursor: maintenanceCursors.cursor })
            .from(maintenanceCursors)
            .where(eq(maintenanceCursors.name, replacementName))
            .for('update');
          if (existing && existing.cursor !== replacementCursor)
            throw new Error('Email attachment replacement cleanup intent changed');
          if (!existing)
            await tx
              .insert(maintenanceCursors)
              .values({ name: replacementName, cursor: replacementCursor });
          await tx.delete(maintenanceCursors).where(eq(maintenanceCursors.name, oldName));
        }
        await tx
          .update(emailAttachmentCustodies)
          .set({
            markerGeneration:
              observed.objectState === 'marker' ? observed.generation : custody.markerGeneration,
            objectGeneration:
              observed.objectState === 'content' ? observed.generation : custody.objectGeneration,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(emailAttachmentCustodies.id, asset.custodyId),
              eq(emailAttachmentCustodies.agentId, agentId),
              inArray(emailAttachmentCustodies.status, ['erased', 'cleanup_pending']),
            ),
          );
      });
    },
    async complete() {
      await db.transaction(async (tx) => {
        const owners = await tx.select({ id: agents.id }).from(agents).limit(2).for('update');
        if (owners.length !== 1 || !owners[0])
          throw new Error('Privacy erasure requires exactly one configured owner');
        const agentId = owners[0].id;
        const active = await readActiveErasure(tx, agentId);
        if (active.phase !== 'awaiting_cleanup')
          throw new Error('Privacy erasure is not ready to complete');
        await tx.delete(selfRepairIssues).where(eq(selfRepairIssues.agentId, agentId));
        // Retain report identities and settled receipts so maintenance cannot rebuild
        // an erased report or replay an already accepted/ambiguous delivery.
        await tx
          .update(missionReports)
          .set({
            text: '',
            chatStatus: sql`case when ${missionReports.chatStatus} in ('pending', 'failed') then 'skipped' else ${missionReports.chatStatus} end`,
            ownerStatus: sql`case when ${missionReports.ownerStatus} in ('pending', 'failed') then 'skipped' else ${missionReports.ownerStatus} end`,
            mirrorStatus: sql`case when ${missionReports.mirrorStatus} in ('pending', 'failed') then 'skipped' else ${missionReports.mirrorStatus} end`,
          })
          .where(eq(missionReports.agentId, agentId));
        await tx
          .update(notificationOutbox)
          .set({
            destination: null,
            payload: null,
            status: sql`case when ${notificationOutbox.status} in ('pending','failed') then 'skipped' when ${notificationOutbox.status} = 'sending' then 'unknown' else ${notificationOutbox.status} end`,
            retryable: false,
            leaseToken: null,
            leaseUntil: null,
            result: null,
            finishedAt: sql`coalesce(${notificationOutbox.finishedAt}, now())`,
            updatedAt: new Date(),
          })
          .where(eq(notificationOutbox.agentId, agentId));
        const [asset] = await tx
          .select({ name: maintenanceCursors.name })
          .from(maintenanceCursors)
          .where(like(maintenanceCursors.name, `${assetPrefix(agentId)}%`))
          .limit(1);
        if (asset) throw new Error('Privacy erasure assets remain');
        await tx
          .delete(maintenanceCursors)
          .where(inArray(maintenanceCursors.name, [resultName(agentId), activeName(agentId)]));
      });
    },
  };
}
