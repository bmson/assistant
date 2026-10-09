import {
  graphSyncTaskInput,
  type ProfileMemoryMaintenance,
  type Records,
} from '@assistant/persistence';
import type { DocumentSnapshot } from '@google-cloud/firestore';
import { decodeMemoryRecord } from './memory-record.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';
import { createTask } from './task-creation.js';

const MAX_ALIAS_WRITES_PER_RELATION = 450;

/**
 * Purging an import source deletes its memories without tombstoning them, so
 * re-running the import can learn them again. Its deletion intent is the proof.
 */
function untombstonedDeletion(intent: DocumentSnapshot): boolean {
  return intent.get('reason') === 'import_purge';
}

export class FirestoreProfileMemoryMaintenance implements ProfileMemoryMaintenance {
  readonly kind = 'profile-memory-maintenance' as const;

  constructor(
    readonly store: InstallationStore,
    private readonly testFault?: { failAfterRelationDeletes: number },
  ) {}

  async queueGraphSync(input: { agentId: string; memoryId: string }): Promise<void> {
    const active = await this.store
      .collection('tasks')
      .where('agentId', '==', input.agentId)
      .where('status', 'in', ['pending', 'running'])
      .where('trigger.payload.job', '==', 'memory.graph_sync')
      .limit(1)
      .get();
    if (!active.empty) return;
    await createTask(
      this.store,
      graphSyncTaskInput(input.agentId, input.memoryId, this.store.now()),
    );
  }

  async retryBlockedGraphSource(input: { agentId: string; memoryId: string }): Promise<void> {
    const memoryRef = this.store.doc('memories', input.memoryId);
    const sourceRef = this.store.doc('knowledgeGraphSources', input.memoryId);
    await this.store.db.runTransaction(async (tx) => {
      const [memoryDoc, sourceDoc] = await tx.getAll(memoryRef, sourceRef);
      if (!memoryDoc?.exists || !sourceDoc?.exists) return;
      const memory = decodeMemoryRecord(memoryDoc.data());
      const source = decodeRecord<Records['knowledgeGraphSources']>(sourceDoc.data());
      if (
        documentKey(memory.id) !== memoryDoc.id ||
        memory.agentId !== input.agentId ||
        source.memoryId !== input.memoryId ||
        !['failed', 'quarantined'].includes(source.status)
      )
        return;
      const now = this.store.now();
      tx.update(sourceRef, {
        attempts: 0,
        lastError: null,
        nextRetryAt: now,
        status: 'failed',
        updatedAt: now,
      });
    });
  }

  private async removeDeletedSourceAssertionEvidence(input: {
    agentId: string;
    memoryId: string;
  }): Promise<void> {
    for (;;) {
      const deleted = await this.store.db.runTransaction(async (tx) => {
        const [memory, intent, evidence] = await Promise.all([
          tx.get(this.store.doc('memories', input.memoryId)),
          tx.get(this.store.doc('graphDeletionIntents', input.memoryId)),
          tx.get(
            this.store
              .collection('knowledgeGraphAssertionEvidence')
              .where('sourceMemoryId', '==', input.memoryId)
              .limit(20),
          ),
        ]);
        if (memory.exists)
          throw new Error('Graph source cleanup requires the memory deletion fence');
        const intentOwned =
          intent.exists &&
          intent.get('memoryId') === input.memoryId &&
          intent.get('agentId') === input.agentId &&
          typeof intent.get('contentHash') === 'string';
        if (!intentOwned) throw new Error('Cannot prove graph source deletion ownership');
        if (!untombstonedDeletion(intent)) {
          const tombstone = await tx.get(
            this.store.doc('memoryTombstones', String(intent.get('contentHash'))),
          );
          if (!tombstone.exists) throw new Error('Graph source deletion tombstone is missing');
        }
        for (const row of evidence.docs) {
          if (
            row.get('agentId') !== input.agentId ||
            row.get('sourceMemoryId') !== input.memoryId ||
            typeof row.get('id') !== 'string' ||
            documentKey(row.get('id')) !== row.id
          )
            throw new Error('Graph source evidence belongs to another agent or record');
        }
        for (const row of evidence.docs) tx.delete(row.ref);
        return evidence.size;
      });
      if (deleted === 0) return;
    }
  }

  async removeOrphanedGraphEntities(input: { agentId: string; memoryId: string }): Promise<void> {
    // Canonical evidence has its own lifecycle; deleting legacy source edges
    // must also remove copied quotes, while retaining semantic owner reviews.
    await this.removeDeletedSourceAssertionEvidence(input);
    let deletedRelations = 0;
    const pageSize = this.testFault ? 1 : 20;
    for (;;) {
      const deleted = await this.store.db.runTransaction(async (tx) => {
        const [memory, intent, relations] = await Promise.all([
          tx.get(this.store.doc('memories', input.memoryId)),
          tx.get(this.store.doc('graphDeletionIntents', input.memoryId)),
          tx.get(
            this.store
              .collection('knowledgeGraphRelations')
              .where('sourceMemoryId', '==', input.memoryId)
              .limit(pageSize),
          ),
        ]);
        const intentOwned =
          intent.exists &&
          intent.get('memoryId') === input.memoryId &&
          intent.get('agentId') === input.agentId &&
          typeof intent.get('contentHash') === 'string';
        if (memory.exists)
          throw new Error('Graph source cleanup requires the memory deletion fence');
        if (!intentOwned) throw new Error('Cannot prove graph source deletion ownership');
        if (!untombstonedDeletion(intent)) {
          const tombstone = await tx.get(
            this.store.doc('memoryTombstones', String(intent.get('contentHash'))),
          );
          if (!tombstone.exists) throw new Error('Graph source deletion tombstone is missing');
        }
        if (relations.empty) return 0;
        const deletingIds = new Set(relations.docs.map((relation) => relation.id));
        const endpointIds: string[] = [];
        for (const relation of relations.docs) {
          if (relation.get('agentId') !== input.agentId)
            throw new Error('Graph source belongs to another agent');
          for (const id of [relation.get('subjectEntityId'), relation.get('objectEntityId')]) {
            if (typeof id !== 'string' || !id) throw new Error('Invalid graph relation endpoint');
            endpointIds.push(id);
          }
        }
        const uniqueEndpointIds = [...new Set(endpointIds)];
        const endpointReads = await Promise.all(
          uniqueEndpointIds.map(async (entityId) => {
            const entityRef = this.store.doc('knowledgeGraphEntities', entityId);
            const [entity, subjects, objects, assertionsAsSubject, assertionsAsObject, aliases] =
              await Promise.all([
                tx.get(entityRef),
                tx.get(
                  this.store
                    .collection('knowledgeGraphRelations')
                    .where('subjectEntityId', '==', entityId)
                    .limit(pageSize + 1),
                ),
                tx.get(
                  this.store
                    .collection('knowledgeGraphRelations')
                    .where('objectEntityId', '==', entityId)
                    .limit(pageSize + 1),
                ),
                tx.get(
                  this.store
                    .collection('knowledgeGraphAssertions')
                    .where('subjectEntityId', '==', entityId)
                    .limit(1),
                ),
                tx.get(
                  this.store
                    .collection('knowledgeGraphAssertions')
                    .where('objectEntityId', '==', entityId)
                    .limit(1),
                ),
                tx.get(
                  this.store
                    .collection('knowledgeGraphEntityAliases')
                    .where('entityId', '==', entityId)
                    .limit(MAX_ALIAS_WRITES_PER_RELATION + 1),
                ),
              ]);
            const referenced =
              !assertionsAsSubject.empty ||
              !assertionsAsObject.empty ||
              [...subjects.docs, ...objects.docs].some(
                (candidate) => !deletingIds.has(candidate.id),
              );
            return { entityId, entityRef, entity, aliases, referenced };
          }),
        );
        const orphaned = endpointReads.filter((endpoint) => !endpoint.referenced);
        const aliasCount = orphaned.reduce((count, endpoint) => count + endpoint.aliases.size, 0);
        if (
          aliasCount >
          Math.min(MAX_ALIAS_WRITES_PER_RELATION, 490 - relations.size - orphaned.length)
        )
          throw new Error('Graph entity alias transaction bound reached');
        for (const endpoint of orphaned) {
          if (endpoint.entity.exists && endpoint.entity.get('agentId') !== input.agentId)
            throw new Error('Graph entity belongs to another agent');
          if (endpoint.aliases.docs.some((alias) => alias.get('agentId') !== input.agentId))
            throw new Error('Graph entity alias belongs to another agent');
        }
        for (const endpoint of orphaned) {
          for (const alias of endpoint.aliases.docs) tx.delete(alias.ref);
          if (endpoint.entity.exists) tx.delete(endpoint.entityRef);
        }
        for (const relation of relations.docs) tx.delete(relation.ref);
        return relations.size;
      });
      if (!deleted) break;
      deletedRelations += deleted;
      if (this.testFault && deletedRelations >= this.testFault.failAfterRelationDeletes)
        throw new Error('Injected graph cleanup failure');
    }

    await this.store.db.runTransaction(async (tx) => {
      const intentRef = this.store.doc('graphDeletionIntents', input.memoryId);
      const [memory, intent, source, relation] = await Promise.all([
        tx.get(this.store.doc('memories', input.memoryId)),
        tx.get(intentRef),
        tx.get(this.store.doc('knowledgeGraphSources', input.memoryId)),
        tx.get(
          this.store
            .collection('knowledgeGraphRelations')
            .where('sourceMemoryId', '==', input.memoryId)
            .limit(1),
        ),
      ]);
      if (!relation.empty) throw new Error('Graph cleanup cursor advanced concurrently');
      const intentOwned =
        intent.exists &&
        intent.get('memoryId') === input.memoryId &&
        intent.get('agentId') === input.agentId &&
        typeof intent.get('contentHash') === 'string';
      const tombstone =
        intentOwned && !untombstonedDeletion(intent)
          ? await tx.get(this.store.doc('memoryTombstones', String(intent.get('contentHash'))))
          : null;
      if (memory.exists) throw new Error('Graph source cleanup requires the memory deletion fence');
      if (!intentOwned || (!untombstonedDeletion(intent) && !tombstone?.exists))
        throw new Error('Cannot prove graph source deletion ownership');
      if (
        source.exists &&
        typeof source.get('agentId') === 'string' &&
        source.get('agentId') !== input.agentId
      )
        throw new Error('Graph source belongs to another agent');
      if (source.exists) tx.delete(source.ref);
      if (intentOwned) tx.update(intentRef, { cleanupCompletedAt: this.store.now() });
    });
  }
}
