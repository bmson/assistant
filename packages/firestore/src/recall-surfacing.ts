import type {
  RecallSurfaceRecord,
  RecallSurfaceRef,
  RecallSurfacingRepository,
  Records,
} from '@assistant/persistence';
import {
  assertPrivacyErasureFenceUnchanged,
  assertPrivacyErasureInactiveInTransaction,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { deterministicUuid } from './stable-id.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

function surfaceId(agentId: string, sourceKey: string): string {
  return deterministicUuid('assistant:recall-surface', agentId, sourceKey);
}

function validRef(value: RecallSurfaceRef): boolean {
  return /^[a-f0-9]{64}$/.test(value.sourceKey);
}

function validStoredSurface(row: Records['recallSurfaces']): boolean {
  return Boolean(
    row.agentId &&
      /^[a-f0-9]{64}$/.test(row.sourceKey) &&
      (row.sourceRevision === null || /^[a-f0-9]{64}$/.test(row.sourceRevision)) &&
      typeof row.kind === 'string' &&
      row.kind.length > 0 &&
      row.firstSurfacedAt instanceof Date &&
      Number.isFinite(row.firstSurfacedAt.getTime()) &&
      row.lastSurfacedAt instanceof Date &&
      Number.isFinite(row.lastSurfacedAt.getTime()) &&
      (row.lastMessageId === null || typeof row.lastMessageId === 'string') &&
      Number.isSafeInteger(row.surfaceCount) &&
      row.surfaceCount >= 1 &&
      (row.suppressedAt === null ||
        (row.suppressedAt instanceof Date && Number.isFinite(row.suppressedAt.getTime()))) &&
      Number.isSafeInteger(row.version) &&
      row.version >= 1,
  );
}

export class FirestoreRecallSurfacingRepository implements RecallSurfacingRepository {
  readonly kind = 'recall-surfacing-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async suppressed(
    agentId: string,
    sourceKeys: string[],
    currentRevisions?: Readonly<Record<string, string | null>>,
  ): Promise<Set<string>> {
    if (!agentId || sourceKeys.some((key) => !/^[a-f0-9]{64}$/.test(key)))
      throw new Error('Invalid recall surface identity');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const requestedKeys = [...new Set(sourceKeys)];
    const refs = requestedKeys.map((key) =>
      this.store.doc('recallSurfaces', surfaceId(agentId, key)),
    );
    if (!refs.length) return new Set();
    const docs = await this.store.db.getAll(...refs);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    const result = new Set<string>();
    for (const [index, doc] of docs.entries()) {
      if (!doc.exists) continue;
      const row = decodeRecord<Records['recallSurfaces']>(doc.data());
      const requestedKey = requestedKeys[index];
      if (
        row.agentId !== agentId ||
        row.sourceKey !== requestedKey ||
        documentKey(row.id) !== doc.id ||
        !validStoredSurface(row) ||
        (row.suppressedAt !== null && row.sourceRevision === null)
      )
        throw new Error('Recall surface ownership mismatch');
      if (
        row.suppressedAt &&
        (!currentRevisions || row.sourceRevision === (currentRevisions[requestedKey ?? ''] ?? null))
      )
        result.add(requestedKey ?? '');
    }
    return result;
  }

  async recordSurfaced(input: {
    agentId: string;
    messageId: string;
    refs: RecallSurfaceRef[];
    now?: Date;
  }): Promise<void> {
    const { agentId, messageId, now = this.store.now() } = input;
    const refs = [
      ...new Map(input.refs.filter(validRef).map((row) => [row.sourceKey, row])).values(),
    ];
    if (!agentId || !messageId || !refs.length) return;
    await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const targets = refs.map((ref) => ({
        ref,
        doc: this.store.doc('recallSurfaces', surfaceId(agentId, ref.sourceKey)),
      }));
      const existing = await tx.getAll(...targets.map((target) => target.doc));
      targets.forEach(({ ref, doc }, index) => {
        const prior = existing[index];
        if (prior?.exists) {
          const row = decodeRecord<Records['recallSurfaces']>(prior.data());
          if (
            row.agentId !== agentId ||
            row.sourceKey !== ref.sourceKey ||
            doc.id !== documentKey(row.id)
          )
            throw new Error('Recall surface ownership mismatch');
          const revised = row.sourceRevision !== ref.sourceRevision;
          tx.update(
            doc,
            encodeRecord({
              suppressedAt: revised ? null : row.suppressedAt,
              sourceRevision: ref.sourceRevision,
              kind: ref.kind,
              lastSurfacedAt: now,
              lastMessageId: messageId,
              surfaceCount: row.surfaceCount + 1,
              version: row.version + (revised ? 1 : 0),
            }),
          );
          return;
        }
        const id = surfaceId(agentId, ref.sourceKey);
        const row: RecallSurfaceRecord = {
          id,
          agentId,
          sourceKey: ref.sourceKey,
          sourceRevision: ref.sourceRevision,
          kind: ref.kind,
          firstSurfacedAt: now,
          lastSurfacedAt: now,
          lastMessageId: messageId,
          surfaceCount: 1,
          suppressedAt: null,
          version: 1,
        };
        tx.create(doc, encodeRecord(row));
      });
    });
  }

  async setSuppressed(input: {
    agentId: string;
    sourceKey: string;
    suppressed: boolean;
    expectedSourceRevision?: string | null;
    expectedVersion?: number;
    now?: Date;
  }): Promise<{ ok: boolean; version?: number }> {
    const {
      agentId,
      sourceKey,
      suppressed,
      expectedSourceRevision,
      expectedVersion,
      now = this.store.now(),
    } = input;
    if (!agentId || !/^[a-f0-9]{64}$/.test(sourceKey)) return { ok: false };
    const ref = this.store.doc('recallSurfaces', surfaceId(agentId, sourceKey));
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const doc = await tx.get(ref);
      if (!doc.exists) return { ok: false };
      const row = decodeRecord<Records['recallSurfaces']>(doc.data());
      if (row.agentId !== agentId || row.sourceKey !== sourceKey || documentKey(row.id) !== doc.id)
        return { ok: false };
      if (expectedSourceRevision !== undefined && row.sourceRevision !== expectedSourceRevision)
        return { ok: false };
      if (expectedVersion !== undefined && row.version !== expectedVersion) return { ok: false };
      if (Boolean(row.suppressedAt) === suppressed) return { ok: true, version: row.version };
      const version = row.version + 1;
      tx.update(ref, encodeRecord({ suppressedAt: suppressed ? now : null, version }));
      return { ok: true, version };
    });
  }

  async list(agentId: string, limit = 100): Promise<RecallSurfaceRecord[]> {
    if (!agentId || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid recall surface query');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store
      .collection('recallSurfaces')
      .where('agentId', '==', agentId)
      .limit(limit)
      .get();
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return snapshot.docs
      .map((doc) => ({ id: doc.id, row: decodeRecord<Records['recallSurfaces']>(doc.data()) }))
      .filter(({ id, row }) => row.agentId === agentId && documentKey(row.id) === id)
      .map(({ row }) => row)
      .sort((a, b) => b.lastSurfacedAt.getTime() - a.lastSurfacedAt.getTime())
      .slice(0, limit);
  }
}
