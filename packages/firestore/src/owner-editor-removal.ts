import type {
  OwnerEditorClaim,
  OwnerEditorPersonRemovalImpact,
  OwnerEditorReply,
} from '@assistant/persistence';
import { ownerEditorCommitRevision } from '@assistant/persistence';
import { decodeMemoryRecord } from './memory-record.js';
import {
  type FirestoreOwnerEditorPersonRemovalSnapshot,
  readFirestoreOwnerEditorPersonRemovalSnapshot,
} from './owner-editor-graph.js';
import {
  beginFirestoreOwnerEditorWrite,
  completeFirestoreOwnerEditorWrite,
} from './owner-editor-repository.js';
import { encodeRecord, type InstallationStore } from './store.js';

function personRemovalWriteCount(snapshot: FirestoreOwnerEditorPersonRemovalSnapshot): number {
  return (
    snapshot.facts.length * 4 +
    snapshot.occasions.length * 2 +
    snapshot.entities.length +
    snapshot.sources.length +
    4
  );
}

/**
 * Delete one person through a single bounded transaction. Facts use the same
 * tombstone and graph-deletion intent fences as profile-memory `forget`; if
 * the complete impact cannot fit the preview bounds, the operation stays
 * unavailable rather than becoming a partially staged deletion.
 */
export async function commitFirestoreOwnerEditorPersonRemoval(input: {
  store: InstallationStore;
  configuredOwnerId: string;
  claim: OwnerEditorClaim;
  request: Extract<import('@assistant/persistence').OwnerEditorApply, { command: 'remove_person' }>;
  reviewedImpact: OwnerEditorPersonRemovalImpact;
  now: Date;
}): Promise<OwnerEditorReply> {
  const { store, configuredOwnerId, claim, request, reviewedImpact, now } = input;
  if (
    configuredOwnerId !== claim.scope.ownerId ||
    claim.scope.command !== 'remove_person' ||
    claim.scope.operationId !== request.operationId ||
    claim.scope.targetId !== request.contactId ||
    reviewedImpact.contactId !== request.contactId ||
    reviewedImpact.revision !== request.expectedImpactRevision
  )
    throw new Error('Person removal does not match its editor claim');

  return store.db.runTransaction(async (tx) => {
    const admitted = await beginFirestoreOwnerEditorWrite(store, tx, claim, now);
    if (admitted.kind === 'reply') return admitted.reply;

    let current: FirestoreOwnerEditorPersonRemovalSnapshot;
    try {
      current = await readFirestoreOwnerEditorPersonRemovalSnapshot(
        store,
        configuredOwnerId,
        request.contactId,
        tx,
      );
    } catch {
      return completeFirestoreOwnerEditorWrite(
        store,
        tx,
        admitted,
        { outcome: 'unavailable', reason: 'person_removal_impact_unavailable' },
        now,
      );
    }
    if (
      current.contactRevision !== request.expectedContactRevision ||
      current.impact.contactId !== request.contactId ||
      current.impact.revision !== request.expectedImpactRevision ||
      current.impact.revision !== reviewedImpact.revision
    )
      return completeFirestoreOwnerEditorWrite(
        store,
        tx,
        admitted,
        { outcome: 'conflict', reason: 'person_removal_impact_changed' },
        now,
      );

    if (personRemovalWriteCount(current) > 250)
      return completeFirestoreOwnerEditorWrite(
        store,
        tx,
        admitted,
        { outcome: 'unavailable', reason: 'person_removal_write_bound' },
        now,
      );

    // All reads are complete before the first write. Each removed fact is
    // tombstoned and fenced before its source row disappears.
    for (let index = 0; index < current.facts.length; index += 1) {
      const memorySnapshot = current.facts[index];
      const support = current.factSupport[index];
      if (!memorySnapshot || !support) throw new Error('Person removal fact proof is incomplete');
      const memory = decodeMemoryRecord(memorySnapshot.data());
      const tombstoneRef = support.tombstone.ref;
      if (!support.tombstone.exists)
        tx.create(
          tombstoneRef,
          encodeRecord({
            id: memory.contentHash,
            contentHash: memory.contentHash,
            reason: 'owner_delete_contact',
            createdAt: now,
          }),
        );
      if (support.hash.exists && support.hash.get('memoryId') === memory.id)
        tx.delete(support.hash.ref);
      tx.set(
        support.intent.ref,
        encodeRecord({
          memoryId: memory.id,
          agentId: configuredOwnerId,
          contentHash: memory.contentHash,
          reason: 'owner_delete_contact',
          createdAt: now,
          cleanupCompletedAt: null,
        }),
      );
      tx.delete(memorySnapshot.ref);
    }
    for (let index = 0; index < current.occasions.length; index += 1) {
      const occasion = current.occasions[index];
      const marker = current.occasionKeys[index];
      if (!occasion || !marker) throw new Error('Person removal occasion proof is incomplete');
      tx.delete(occasion.ref);
      if (marker.exists && marker.get('occasionId') === occasion.get('id')) tx.delete(marker.ref);
    }
    for (const entity of current.entities) tx.update(entity.ref, { contactId: null });
    for (const source of current.sources) tx.update(source.ref, { subjectContactId: null });
    tx.delete(current.contact.ref);
    tx.set(
      store.doc('ownerCards', configuredOwnerId),
      encodeRecord({
        agentId: configuredOwnerId,
        content: '',
        compiledAt: now,
        invalidatedAt: now,
      }),
    );
    const ids = { contactId: request.contactId };
    return completeFirestoreOwnerEditorWrite(
      store,
      tx,
      admitted,
      {
        outcome: 'saved',
        ids,
        revision: ownerEditorCommitRevision(claim, ids),
        refreshPending: true,
      },
      now,
    );
  });
}
