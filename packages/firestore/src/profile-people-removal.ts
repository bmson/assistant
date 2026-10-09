import type { ProfilePeopleRemovalRepository, Records } from '@assistant/persistence';
import { normalizeContactAliases } from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { occasionDateKey, occasionDateKeyId } from './occasion-identity.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Contact = Records['contacts'];

/** Per-transaction bounds; exceeding them fails loudly instead of half-merging. */
const MAX_OCCASIONS = 100;
const MAX_GRAPH_LINKS = 200;

/**
 * Firestore twin of the PostgreSQL `deleteContact` and `mergeContacts`
 * transactions. Facts move in bounded batches first; the finishing
 * transaction proves none remain before the contact goes, mirroring the
 * PostgreSQL foreign keys (graph entity and source links are cleared, the
 * way `ON DELETE SET NULL` clears them).
 */
export class FirestoreProfilePeopleRemovalRepository implements ProfilePeopleRemovalRepository {
  readonly kind = 'profile-people-removal-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async assertRemovable(contactId: string): Promise<void> {
    await this.store.db.runTransaction(async (tx) => {
      await this.assertWritableOwner(tx);
      const contact = await this.readPerson(tx, contactId);
      if (contact.trust === 'owner') throw new Error('The owner profile cannot be deleted.');
    });
  }

  async subjectMemoryIds(contactId: string, limit: number): Promise<string[]> {
    const snapshot = await this.store
      .collection('memories')
      .where('agentId', '==', this.configuredAgentId)
      .where('subjectContactId', '==', contactId)
      .select('id')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => {
      const id = doc.get('id');
      if (typeof id !== 'string' || documentKey(id) !== doc.id)
        throw new Error('Person fact record is malformed');
      return id;
    });
  }

  async reassignSubjectMemories(
    sourceId: string,
    targetId: string,
    limit: number,
  ): Promise<number> {
    if (sourceId === targetId) throw new Error('cannot merge a contact into itself');
    return this.store.db.runTransaction(async (tx) => {
      await this.assertWritableOwner(tx);
      const [source, target] = await Promise.all([
        this.readPerson(tx, sourceId, 'merge: contact not found'),
        this.readPerson(tx, targetId, 'merge: contact not found'),
      ]);
      if (source.trust === 'owner') throw new Error('cannot merge the owner away');
      if (target.id !== targetId) throw new Error('merge: contact not found');
      const facts = await tx.get(
        this.store
          .collection('memories')
          .where('agentId', '==', this.configuredAgentId)
          .where('subjectContactId', '==', sourceId)
          .limit(limit),
      );
      for (const fact of facts.docs) tx.update(fact.ref, { subjectContactId: targetId });
      if (facts.size > 0) this.invalidateOwnerCard(tx);
      return facts.size;
    });
  }

  async finishDelete(contactId: string): Promise<{ deletedOccasions: number }> {
    return this.store.db.runTransaction(async (tx) => {
      await this.assertWritableOwner(tx);
      const contact = await this.readPerson(tx, contactId);
      if (contact.trust === 'owner') throw new Error('The owner profile cannot be deleted.');
      await this.assertNoFacts(tx, contactId, 'Person could not be deleted.');
      const [occasions, links] = await Promise.all([
        this.occasionsOf(tx, contactId),
        this.graphLinksOf(tx, contactId),
      ]);
      const markers = occasions.length
        ? await tx.getAll(
            ...occasions.map((occasion) =>
              this.store.doc(
                'occasionDateKeys',
                occasionDateKeyId(this.configuredAgentId, {
                  contactId: String(occasion.get('contactId')),
                  kind: String(occasion.get('kind')),
                  month: Number(occasion.get('month')),
                  day: Number(occasion.get('day')),
                }),
              ),
            ),
          )
        : [];
      occasions.forEach((occasion, index) => {
        const marker = markers[index];
        tx.delete(occasion.ref);
        if (marker?.exists && marker.get('occasionId') === occasion.get('id'))
          tx.delete(marker.ref);
      });
      this.clearGraphLinks(tx, links);
      tx.delete(this.store.doc('contacts', contactId));
      return { deletedOccasions: occasions.length };
    });
  }

  async finishMerge(sourceId: string, targetId: string): Promise<{ movedOccasions: number }> {
    if (sourceId === targetId) throw new Error('cannot merge a contact into itself');
    return this.store.db.runTransaction(async (tx) => {
      await this.assertWritableOwner(tx);
      const [source, target] = await Promise.all([
        this.readPerson(tx, sourceId, 'merge: contact not found'),
        this.readPerson(tx, targetId, 'merge: contact not found'),
      ]);
      if (source.trust === 'owner') throw new Error('cannot merge the owner away');
      await this.assertNoFacts(tx, sourceId, 'These people could not be merged. Please try again.');
      const [sourceOccasions, targetOccasions, links] = await Promise.all([
        this.occasionsOf(tx, sourceId),
        this.occasionsOf(tx, targetId),
        this.graphLinksOf(tx, sourceId),
      ]);
      const markerRefs = [
        ...sourceOccasions.map((occasion) =>
          this.store.doc(
            'occasionDateKeys',
            occasionDateKeyId(this.configuredAgentId, {
              contactId: sourceId,
              kind: String(occasion.get('kind')),
              month: Number(occasion.get('month')),
              day: Number(occasion.get('day')),
            }),
          ),
        ),
        ...targetOccasions.map((occasion) =>
          this.store.doc(
            'occasionDateKeys',
            occasionDateKeyId(this.configuredAgentId, {
              contactId: targetId,
              kind: String(occasion.get('kind')),
              month: Number(occasion.get('month')),
              day: Number(occasion.get('day')),
            }),
          ),
        ),
      ];
      const markers = markerRefs.length ? await tx.getAll(...markerRefs) : [];
      // One row per (agent, kind, month, day), as saveOccasion and the
      // PostgreSQL dedup index keep it: the target's row wins a collision.
      const key = (doc: DocumentSnapshot) =>
        [doc.get('agentId'), doc.get('kind'), doc.get('month'), doc.get('day')].join('|');
      const taken = new Set(targetOccasions.map(key));
      const targetByKey = new Map(targetOccasions.map((occasion) => [key(occasion), occasion]));
      const now = this.store.now();
      let movedOccasions = 0;
      for (const [index, occasion] of sourceOccasions.entries()) {
        const sourceMarker = markers[index];
        const identity = {
          contactId: targetId,
          kind: String(occasion.get('kind')),
          month: Number(occasion.get('month')),
          day: Number(occasion.get('day')),
        };
        const targetMarkerIndex =
          sourceOccasions.length + targetOccasions.findIndex((row) => key(row) === key(occasion));
        const targetMarker =
          targetMarkerIndex >= sourceOccasions.length ? markers[targetMarkerIndex] : null;
        if (sourceMarker?.exists && sourceMarker.get('occasionId') !== occasion.get('id'))
          throw new Error('Source occasion date marker conflicts with its record');
        if (taken.has(key(occasion))) {
          tx.delete(occasion.ref);
          if (sourceMarker?.exists) tx.delete(sourceMarker.ref);
        } else {
          tx.update(occasion.ref, encodeRecord({ contactId: targetId, updatedAt: now }));
          if (targetMarker?.exists) {
            const targetRow = targetByKey.get(key(occasion));
            if (!targetRow || targetMarker.get('occasionId') !== targetRow.get('id'))
              throw new Error('Target occasion date marker conflicts with its record');
          } else {
            tx.create(
              this.store.doc(
                'occasionDateKeys',
                occasionDateKeyId(this.configuredAgentId, identity),
              ),
              occasionDateKey(this.configuredAgentId, identity, String(occasion.get('id'))),
            );
          }
          if (sourceMarker?.exists) tx.delete(sourceMarker.ref);
          movedOccasions += 1;
        }
      }
      this.clearGraphLinks(tx, links);
      tx.update(
        this.store.doc('contacts', targetId),
        encodeRecord({
          aliases: normalizeContactAliases(
            [...target.aliases, ...source.aliases, source.name],
            target.name,
          ),
          emails: [...new Set([...target.emails, ...source.emails])],
          phones: [...new Set([...target.phones, ...source.phones])],
          relationship: target.relationship || source.relationship,
          notes: [target.notes, source.notes].filter(Boolean).join('\n'),
          updatedAt: now,
        }),
      );
      tx.delete(this.store.doc('contacts', sourceId));
      this.invalidateOwnerCard(tx);
      return { movedOccasions };
    });
  }

  private async assertWritableOwner(tx: Transaction): Promise<void> {
    const agentId = this.configuredAgentId;
    const owners = await tx.get(this.store.collection('agents').limit(2));
    const owner = owners.docs[0];
    if (
      owners.size !== 1 ||
      !owner ||
      owner.get('id') !== agentId ||
      owner.id !== documentKey(agentId)
    )
      throw new Error('Profile mutation requires exactly one configured owner');
    const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
    if (
      erasure.exists &&
      (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
    )
      throw new Error('Privacy erasure is in progress');
  }

  private async readPerson(
    tx: Transaction,
    contactId: string,
    missing = 'Person not found.',
  ): Promise<Contact> {
    if (!contactId) throw new Error(missing);
    const snapshot = await tx.get(this.store.doc('contacts', contactId));
    if (!snapshot.exists) throw new Error(missing);
    const ownerId = snapshot.get('agentId');
    if (ownerId !== undefined && ownerId !== this.configuredAgentId) throw new Error(missing);
    const row = decodeRecord<Contact>(snapshot.data());
    if (
      row.id !== contactId ||
      typeof row.name !== 'string' ||
      typeof row.trust !== 'string' ||
      !Array.isArray(row.aliases)
    )
      throw new Error('Person record is malformed');
    return {
      ...row,
      emails: Array.isArray(row.emails) ? row.emails : [],
      phones: Array.isArray(row.phones) ? row.phones : [],
      notes: typeof row.notes === 'string' ? row.notes : '',
      relationship: typeof row.relationship === 'string' ? row.relationship : '',
    };
  }

  /** Any agent's fact still naming this person blocks removal, as the PostgreSQL FK does. */
  private async assertNoFacts(tx: Transaction, contactId: string, message: string) {
    const remaining = await tx.get(
      this.store.collection('memories').where('subjectContactId', '==', contactId).limit(1),
    );
    if (!remaining.empty) throw new Error(message);
  }

  private async occasionsOf(tx: Transaction, contactId: string) {
    const page = await tx.get(
      this.store
        .collection('occasions')
        .where('contactId', '==', contactId)
        .limit(MAX_OCCASIONS + 1),
    );
    if (page.size > MAX_OCCASIONS)
      throw new Error('Person has too many occasions to update safely.');
    return page.docs;
  }

  private async graphLinksOf(tx: Transaction, contactId: string) {
    const [entities, sources] = await Promise.all([
      tx.get(
        this.store
          .collection('knowledgeGraphEntities')
          .where('contactId', '==', contactId)
          .limit(MAX_GRAPH_LINKS + 1),
      ),
      tx.get(
        this.store
          .collection('knowledgeGraphSources')
          .where('subjectContactId', '==', contactId)
          .limit(MAX_GRAPH_LINKS + 1),
      ),
    ]);
    if (entities.size > MAX_GRAPH_LINKS || sources.size > MAX_GRAPH_LINKS)
      throw new Error('Person has too many knowledge links to update safely.');
    return { entities: entities.docs, sources: sources.docs };
  }

  private clearGraphLinks(
    tx: Transaction,
    links: { entities: DocumentSnapshot[]; sources: DocumentSnapshot[] },
  ) {
    for (const entity of links.entities) tx.update(entity.ref, { contactId: null });
    for (const source of links.sources) tx.update(source.ref, { subjectContactId: null });
  }

  /** The compiled card may quote moved or removed facts; clear it until recompiled. */
  private invalidateOwnerCard(tx: Transaction) {
    tx.set(
      this.store.doc('ownerCards', this.configuredAgentId),
      { agentId: this.configuredAgentId, content: '', compiledAt: this.store.now() },
      { merge: true },
    );
  }
}
