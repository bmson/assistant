import {
  type EmailAttachmentCustodyIntentInput,
  type EmailAttachmentCustodyRecord,
  type EmailAttachmentCustodyRepository,
  type EmailObserverEffectFence,
  emailAttachmentCustodyCleanupIntentId,
  type PrivacyErasureAsset,
  type Records,
} from '@assistant/persistence';
import { FirestoreDocumentCatalogRepository } from './document-catalog.js';
import {
  emailAttachmentCustodySourceIndexId,
  exactPreparedEntry,
  readCanonicalEmailAttachmentSource,
} from './email-attachment-source.js';
import { assertPrivacyErasureGenerationInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

// Deterministic observer work IDs use UUIDv8; random custody/task IDs remain v4.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function cleanupAsset(
  agentId: string,
  workspacePath: string,
  custodyId: string,
  generation: string | null,
  objectState: 'marker' | 'content',
  createdAt: Date,
  documentId: string | null,
) {
  if (!generation) return null;
  const id = emailAttachmentCustodyCleanupIntentId(custodyId, generation);
  return {
    refId: id,
    row: {
      id,
      sourceId: id,
      kind: 'email_attachment_custody',
      agentId,
      workspacePath,
      custodyId,
      generation,
      objectState,
      ...(documentId ? { documentId } : {}),
      createdAt,
    },
  };
}

function assertFenceIdentity(fence: EmailObserverEffectFence, agentId: string): void {
  if (
    fence.agentId !== agentId ||
    !UUID.test(fence.id) ||
    !fence.claimToken ||
    !Number.isSafeInteger(fence.claimGeneration) ||
    fence.claimGeneration < 1 ||
    (fence.expectedPrivacyGeneration !== null &&
      (typeof fence.expectedPrivacyGeneration !== 'string' || !fence.expectedPrivacyGeneration))
  )
    throw new Error('Email attachment observer fence is malformed');
}

function sameIntent(row: EmailAttachmentCustodyRecord, input: EmailAttachmentCustodyIntentInput) {
  return (
    row.agentId === input.fence.agentId &&
    row.observerWorkId === input.observerWorkId &&
    row.channelMessageId === input.channelMessageId &&
    row.providerMessageId === input.providerMessageId &&
    row.manifestDigest === input.manifestDigest &&
    row.providerAttachmentId === input.entry.providerAttachmentId &&
    row.attachmentOrdinal === input.entry.ordinal &&
    row.filename === input.entry.filename &&
    row.mime === input.entry.mime &&
    row.advertisedBytes === input.entry.advertisedBytes &&
    row.actualBytes === input.actualBytes &&
    row.sha256 === input.sha256
  );
}

/** Firestore custody ledger; all publication gates are transaction-local. */
export class FirestoreEmailAttachmentCustodyRepository implements EmailAttachmentCustodyRepository {
  readonly kind = 'email-attachment-custody-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async beginEmailAttachmentCustody(input: EmailAttachmentCustodyIntentInput) {
    assertFenceIdentity(input.fence, this.configuredAgentId);
    if (
      !UUID.test(input.custodyId) ||
      input.workspacePath !== `email-attachments/custody/${input.custodyId}` ||
      input.observerWorkId !== input.fence.id ||
      !input.channelMessageId ||
      !input.providerMessageId ||
      !/^[a-f0-9]{64}$/.test(input.manifestDigest) ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !Number.isSafeInteger(input.actualBytes) ||
      input.actualBytes < 1 ||
      input.actualBytes > 25 * 1024 * 1024
    )
      throw new Error('Email attachment custody intent is malformed');

    return this.store.db.runTransaction(async (tx) => {
      const indexId = emailAttachmentCustodySourceIndexId(
        this.configuredAgentId,
        input.observerWorkId,
        input.entry.providerAttachmentId,
      );
      const indexRef = this.store.doc('emailAttachmentCustodyKeys', indexId);
      const indexSnapshot = await tx.get(indexRef);
      const indexedCustodyId = indexSnapshot.exists ? indexSnapshot.get('custodyId') : null;
      if (
        indexSnapshot.exists &&
        (typeof indexedCustodyId !== 'string' || !UUID.test(indexedCustodyId))
      )
        throw new Error('Email attachment source index is malformed');
      const selectedCustodyId =
        typeof indexedCustodyId === 'string' ? indexedCustodyId : input.custodyId;
      const pathRef = this.store.doc('emailAttachmentCustodies', selectedCustodyId);
      const workRef = this.store.doc('emailObserverWork', input.fence.id);
      const [workSnapshot, pathSnapshot] = await tx.getAll(workRef, pathRef);
      if (!workSnapshot?.exists)
        throw new Error('Email attachment source or erasure fence is missing');
      const work = decodeRecord<Records['emailObserverWork']>(workSnapshot.data());
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        this.configuredAgentId,
        input.fence.expectedPrivacyGeneration,
      );
      if (
        !exactPreparedEntry(
          input.fence,
          input.entry,
          input.manifestDigest,
          input.channelMessageId,
          input.providerMessageId,
          work,
          this.store.now(),
        )
      )
        throw new Error('Email attachment is outside the prepared observer manifest');
      const source = await readCanonicalEmailAttachmentSource(
        tx,
        this.store,
        this.configuredAgentId,
        input.channelMessageId,
        input.providerMessageId,
        input.observerWorkId,
      );
      if (!source) throw new Error('Email attachment canonical source is missing or changed');
      if (pathSnapshot?.exists) {
        const row = decodeRecord<EmailAttachmentCustodyRecord>(pathSnapshot.data());
        if (
          documentKey(row.id) !== pathSnapshot.id ||
          row.workspacePath !== `email-attachments/custody/${row.id}` ||
          !indexSnapshot.exists ||
          indexSnapshot.get('custodyId') !== row.id
        )
          throw new Error('Email attachment custody source index changed');
        if (!sameIntent(row, { ...input, custodyId: row.id }))
          throw new Error('Email attachment custody replay changed its immutable source');
        if (
          row.duplicateDocumentId &&
          ['cleanup_pending', 'duplicate_cleaned'].includes(row.status)
        ) {
          const targetRef = this.store.doc('documents', row.duplicateDocumentId);
          const targetSnapshot = await tx.get(targetRef);
          if (!targetSnapshot.exists)
            throw new Error('Email attachment duplicate receipt target is missing');
          const target = decodeRecord<Records['documents']>(targetSnapshot.data());
          if (
            target.id !== row.duplicateDocumentId ||
            target.agentId !== this.configuredAgentId ||
            target.sha256 !== row.sha256
          )
            throw new Error('Email attachment duplicate receipt target changed');
          const targetFileSnapshot = await tx.get(this.store.doc('files', target.fileId));
          if (!targetFileSnapshot.exists)
            throw new Error('Email attachment duplicate receipt file is missing');
          const targetFile = decodeRecord<Records['files']>(targetFileSnapshot.data());
          if (
            targetFile.id !== target.fileId ||
            targetFile.agentId !== this.configuredAgentId ||
            !targetFile.workspacePath ||
            targetFile.sha256 !== row.sha256
          )
            throw new Error('Email attachment duplicate receipt file changed');
          return row;
        }
        if (row.status === 'erased') throw new Error('Email attachment custody is erased');
        const updated = {
          ...row,
          claimToken: input.fence.claimToken,
          claimGeneration: input.fence.claimGeneration,
          privacyGeneration: input.fence.expectedPrivacyGeneration,
          leaseExpiresAt: work.leaseExpiresAt,
          updatedAt: this.store.now(),
        };
        tx.update(pathRef, encodeRecord(updated));
        return updated;
      }
      if (indexSnapshot.exists) throw new Error('Email attachment custody index is dangling');
      if (pathSnapshot?.exists) throw new Error('Email attachment custody identifier collision');
      const row: EmailAttachmentCustodyRecord = {
        id: input.custodyId,
        agentId: this.configuredAgentId,
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
        markerGeneration: null,
        objectGeneration: null,
        status: 'marker_pending',
        fileId: null,
        documentId: null,
        duplicateDocumentId: null,
        leaseExpiresAt: work.leaseExpiresAt,
        createdAt: this.store.now(),
        updatedAt: this.store.now(),
      };
      tx.create(pathRef, encodeRecord(row));
      tx.create(
        indexRef,
        encodeRecord({
          id: indexId,
          agentId: this.configuredAgentId,
          observerWorkId: input.observerWorkId,
          providerAttachmentId: input.entry.providerAttachmentId,
          custodyId: input.custodyId,
          createdAt: this.store.now(),
        }),
      );
      return row;
    });
  }

  async recordEmailAttachmentMarker(input: {
    agentId: string;
    custodyId: string;
    generation: string;
  }) {
    return this.recordExternalGeneration(input, 'marker');
  }

  async authorizeEmailAttachmentContent(input: {
    fence: EmailObserverEffectFence;
    custodyId: string;
    markerGeneration: string;
    actualBytes: number;
    sha256: string;
    mime: string;
  }) {
    assertFenceIdentity(input.fence, this.configuredAgentId);
    const rowRef = this.store.doc('emailAttachmentCustodies', input.custodyId);
    const workRef = this.store.doc('emailObserverWork', input.fence.id);
    return this.store.db.runTransaction(async (tx) => {
      const [rowSnapshot, workSnapshot] = await tx.getAll(rowRef, workRef);
      if (!rowSnapshot?.exists || !workSnapshot?.exists) return false;
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        this.configuredAgentId,
        input.fence.expectedPrivacyGeneration,
      );
      const row = decodeRecord<EmailAttachmentCustodyRecord>(rowSnapshot.data());
      const work = decodeRecord<Records['emailObserverWork']>(workSnapshot.data());
      const source = await readCanonicalEmailAttachmentSource(
        tx,
        this.store,
        this.configuredAgentId,
        row.channelMessageId as string,
        row.providerMessageId as string,
        row.observerWorkId as string,
      );
      if (
        row.agentId !== this.configuredAgentId ||
        row.id !== input.custodyId ||
        row.status !== 'marker_ready' ||
        row.markerGeneration !== input.markerGeneration ||
        row.actualBytes !== input.actualBytes ||
        row.sha256 !== input.sha256 ||
        row.mime !== input.mime ||
        row.observerWorkId !== input.fence.id ||
        row.claimToken !== input.fence.claimToken ||
        row.claimGeneration !== input.fence.claimGeneration ||
        row.privacyGeneration !== input.fence.expectedPrivacyGeneration ||
        !source ||
        !exactPreparedEntry(
          input.fence,
          {
            providerAttachmentId: row.providerAttachmentId as string,
            ordinal: row.attachmentOrdinal,
            filename: row.filename as string,
            mime: row.mime as string,
            advertisedBytes: row.advertisedBytes,
          },
          row.manifestDigest as string,
          row.channelMessageId as string,
          row.providerMessageId as string,
          work,
          this.store.now(),
        )
      )
        return false;
      tx.update(rowRef, { status: 'content_authorized', updatedAt: this.store.now() });
      return true;
    });
  }

  async recordEmailAttachmentObject(input: {
    agentId: string;
    custodyId: string;
    generation: string;
    bytes?: number;
    sha256?: string;
  }) {
    return this.recordExternalGeneration(input, 'content', input.bytes, input.sha256);
  }

  async finalizeEmailAttachmentCatalog(input: {
    fence: EmailObserverEffectFence;
    custodyId: string;
    file: Records['files'];
    document: Records['documents'];
  }): Promise<{
    document: Records['documents'];
    duplicate: boolean;
    task: { id: string; queueGeneration: number } | null;
    published: boolean;
  }> {
    assertFenceIdentity(input.fence, this.configuredAgentId);
    const result = await new FirestoreDocumentCatalogRepository(
      this.store,
      this.configuredAgentId,
    ).createEmailAttachmentCatalog({
      file: input.file,
      document: input.document,
      custodyId: input.custodyId,
      fence: input.fence,
    });
    return result;
  }

  async listEmailAttachmentCustodyCleanup(input: {
    agentId: string;
    cursor: string | null;
    limit: number;
  }) {
    if (input.agentId !== this.configuredAgentId)
      throw new Error('Custody cleanup is outside the configured owner');
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error('Custody cleanup page size is invalid');
    let query = this.store
      .collection('privacyErasureAssets')
      .where('agentId', '==', input.agentId)
      .where('kind', '==', 'email_attachment_custody')
      .orderBy('__name__')
      .limit(input.limit);
    if (input.cursor) query = query.startAfter(input.cursor);
    const page = await query.get();
    const assets = page.docs.map((doc) => decodeRecord<PrivacyErasureAsset>(doc.data()));
    if (assets.some((asset) => asset.kind !== 'email_attachment_custody'))
      throw new Error('Email attachment cleanup page contains a non-custody asset');
    const refs = assets.map((asset) =>
      this.store.doc(
        'emailAttachmentCustodies',
        asset.kind === 'email_attachment_custody' ? asset.custodyId : '',
      ),
    );
    const rows = refs.length ? await this.store.db.getAll(...refs) : [];
    const items = rows.map((snapshot, index) => {
      if (!snapshot.exists) throw new Error('Email attachment cleanup tombstone is missing');
      const row = decodeRecord<EmailAttachmentCustodyRecord>(snapshot.data());
      const asset = assets[index];
      const assetDocument = page.docs[index];
      if (
        asset?.kind !== 'email_attachment_custody' ||
        !assetDocument ||
        documentKey(asset.id) !== assetDocument.id ||
        asset.id !== emailAttachmentCustodyCleanupIntentId(asset.custodyId, asset.generation) ||
        assetDocument.get('sourceId') !== asset.id ||
        row.agentId !== input.agentId ||
        !['cleanup_pending', 'duplicate_cleaned', 'erased'].includes(row.status) ||
        documentKey(row.id) !== snapshot.id ||
        asset.custodyId !== row.id ||
        asset.workspacePath !== row.workspacePath ||
        !asset.generation ||
        !['marker', 'content'].includes(asset.objectState)
      )
        throw new Error('Email attachment cleanup tombstone is malformed');
      return { custody: row, asset };
    });
    return { items, nextCursor: page.size === input.limit ? (page.docs.at(-1)?.id ?? null) : null };
  }

  async markEmailAttachmentCustodyErased(input: {
    agentId: string;
    custodyId: string;
    deletedGeneration?: string;
  }) {
    if (input.agentId !== this.configuredAgentId)
      throw new Error('Custody erase is outside the configured owner');
    const ref = this.store.doc('emailAttachmentCustodies', input.custodyId);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== input.agentId) return false;
      const row = decodeRecord<EmailAttachmentCustodyRecord>(snapshot.data());
      if (!['cleanup_pending', 'duplicate_cleaned', 'erased'].includes(row.status)) return false;
      if (row.status === 'erased' || row.status === 'duplicate_cleaned') {
        if (!input.deletedGeneration) return false;
        const cleanupId = emailAttachmentCustodyCleanupIntentId(row.id, input.deletedGeneration);
        const cleanupRef = this.store.doc('privacyErasureAssets', cleanupId);
        const cleanupSnapshot = await tx.get(cleanupRef);
        if (!cleanupSnapshot?.exists) return false;
        if (
          cleanupSnapshot.get('agentId') !== input.agentId ||
          cleanupSnapshot.get('sourceId') !== cleanupId ||
          cleanupSnapshot.get('custodyId') !== input.custodyId ||
          cleanupSnapshot.get('generation') !== input.deletedGeneration ||
          cleanupSnapshot.get('workspacePath') !== row.workspacePath
        )
          throw new Error('Email attachment cleanup intent changed before acknowledgment');
        tx.delete(cleanupRef);
        return true;
      }
      if (row.duplicateDocumentId) {
        if (!input.deletedGeneration) return false;
        const cleanupId = emailAttachmentCustodyCleanupIntentId(row.id, input.deletedGeneration);
        const cleanupRef = this.store.doc('privacyErasureAssets', cleanupId);
        const cleanupSnapshot = await tx.get(cleanupRef);
        if (
          cleanupSnapshot?.exists &&
          (cleanupSnapshot.get('agentId') !== input.agentId ||
            cleanupSnapshot.get('sourceId') !== cleanupId ||
            cleanupSnapshot.get('custodyId') !== input.custodyId ||
            cleanupSnapshot.get('generation') !== input.deletedGeneration ||
            cleanupSnapshot.get('workspacePath') !== row.workspacePath)
        )
          throw new Error('Email attachment cleanup intent changed before acknowledgment');
        const remaining = await tx.get(
          this.store
            .collection('privacyErasureAssets')
            .where('kind', '==', 'email_attachment_custody')
            .where('custodyId', '==', row.id)
            .limit(1000),
        );
        if (cleanupSnapshot?.exists) tx.delete(cleanupRef);
        const hasOtherPending = remaining.docs.some((doc) => doc.id !== cleanupRef.id);
        tx.update(ref, {
          status: hasOtherPending ? 'cleanup_pending' : 'duplicate_cleaned',
          updatedAt: this.store.now(),
        });
        return true;
      }
      const generation = row.objectGeneration ?? row.markerGeneration;
      if (input.deletedGeneration && generation !== input.deletedGeneration) return false;
      const now = this.store.now();
      const cleanup = cleanupAsset(
        input.agentId,
        row.workspacePath,
        row.id,
        generation,
        row.objectGeneration ? 'content' : 'marker',
        now,
        row.status === 'cleanup_pending' ? row.documentId : null,
      );
      const cleanupRef = cleanup ? this.store.doc('privacyErasureAssets', cleanup.refId) : null;
      const cleanupSnapshot = cleanupRef ? await tx.get(cleanupRef) : null;
      if (input.deletedGeneration && cleanupSnapshot?.exists) {
        if (
          cleanupSnapshot.get('agentId') !== input.agentId ||
          cleanupSnapshot.get('sourceId') !== cleanup?.refId ||
          cleanupSnapshot.get('custodyId') !== input.custodyId ||
          cleanupSnapshot.get('generation') !== input.deletedGeneration
        )
          throw new Error('Email attachment cleanup intent changed before acknowledgment');
        if (cleanupRef) tx.delete(cleanupRef);
      }
      tx.update(ref, this.erasedPatch(row, now));
      if (!input.deletedGeneration && cleanup) this.createCleanupIntent(tx, cleanup);
      return true;
    });
  }

  private async recordExternalGeneration(
    input: { agentId: string; custodyId: string; generation: string },
    state: 'marker' | 'content',
    bytes?: number,
    sha256?: string,
  ) {
    if (
      input.agentId !== this.configuredAgentId ||
      !UUID.test(input.custodyId) ||
      !input.generation ||
      input.generation.length > 128
    )
      throw new Error('Email attachment external receipt is malformed');
    const ref = this.store.doc('emailAttachmentCustodies', input.custodyId);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== input.agentId) return false;
      const row = decodeRecord<EmailAttachmentCustodyRecord>(snapshot.data());
      const nonPublishable =
        row.status === 'erased' ||
        row.status === 'cleanup_pending' ||
        row.status === 'duplicate_cleaned';
      if (
        !nonPublishable &&
        state === 'content' &&
        (bytes !== row.actualBytes || sha256 !== row.sha256)
      )
        throw new Error('Email attachment object receipt changed the frozen content');
      if (
        !nonPublishable &&
        state === 'marker' &&
        !['marker_pending', 'marker_ready'].includes(row.status)
      )
        return false;
      if (
        !nonPublishable &&
        state === 'content' &&
        !['content_authorized', 'object_written'].includes(row.status)
      )
        return false;
      const now = this.store.now();
      const patch: Record<string, unknown> = nonPublishable
        ? { updatedAt: now }
        : state === 'marker'
          ? { markerGeneration: input.generation, status: 'marker_ready', updatedAt: now }
          : { objectGeneration: input.generation, status: 'object_written', updatedAt: now };
      if (state === 'marker') patch.markerGeneration = input.generation;
      else patch.objectGeneration = input.generation;
      tx.update(ref, patch);
      if (nonPublishable) {
        const cleanup = cleanupAsset(
          input.agentId,
          row.workspacePath,
          row.id,
          input.generation,
          state,
          now,
          row.status === 'cleanup_pending' ? row.documentId : null,
        );
        if (cleanup) this.createCleanupIntent(tx, cleanup);
      }
      return !nonPublishable;
    });
  }

  private erasedPatch(row: EmailAttachmentCustodyRecord, now: Date) {
    return {
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
      updatedAt: now,
      id: row.id,
      agentId: row.agentId,
      workspacePath: row.workspacePath,
      markerGeneration: row.markerGeneration,
      objectGeneration: row.objectGeneration,
    };
  }

  private createCleanupIntent(
    tx: FirebaseFirestore.Transaction,
    cleanup: NonNullable<ReturnType<typeof cleanupAsset>>,
  ) {
    tx.set(this.store.doc('privacyErasureAssets', cleanup.refId), cleanup.row, { merge: true });
  }
}
