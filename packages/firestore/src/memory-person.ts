import { randomUUID } from 'node:crypto';
import {
  attributeMemoryPerson,
  type GroundedPersonEvidence,
  MAX_RECONCILED_PERSON_MEMORIES,
  normalizeMemoryRelationship,
  type Records,
} from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import { contactNameRef, stageNewContact } from './contact-lookup.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Contact = Records['contacts'];
const MAX_CONTACTS = 5000;
// Reserve capacity for memory documents, hashes, new subjects, occasions, and checkpoints.
const MAX_RECONCILIATION_WRITES = 350;

export async function readFirestoreMemoryPeople(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
): Promise<Contact[]> {
  const page = await tx.get(store.collection('contacts').limit(MAX_CONTACTS + 1));
  if (page.size > MAX_CONTACTS) throw new Error('Memory contact scan exceeded bound');
  return page.docs.flatMap((doc) => {
    const row = decodeRecord<Contact & { agentId?: unknown }>(doc.data());
    if (
      typeof row.id !== 'string' ||
      documentKey(row.id) !== doc.id ||
      typeof row.name !== 'string' ||
      (row.agentId !== undefined && row.agentId !== agentId)
    )
      return [];
    return [row];
  });
}

/** Prepare mutations among the transaction's reads, then stage them after the final read. */
export class FirestoreMemoryPeople {
  private readonly writes: Array<() => void> = [];
  private readonly redirects = new Map<string, string>();
  private singleOwner?: boolean;
  private reconciledWrites = 0;
  created = 0;

  constructor(
    private readonly tx: Transaction,
    private readonly store: InstallationStore,
    private readonly agentId: string,
    readonly contacts: Contact[],
  ) {}

  resolveRedirect(id: string): string {
    return this.redirects.get(id) ?? id;
  }

  async resolve(input: {
    subject: string;
    content: string;
    evidence?: GroundedPersonEvidence | null;
    knownContactId?: string | null;
    relationship?: string;
    pendingContactIds?: ReadonlySet<string>;
  }): Promise<string | null> {
    if (!input.subject || input.evidence === null) return null;
    if (input.evidence) {
      if (this.singleOwner === undefined) {
        const owners = await this.tx.get(this.store.collection('agents').limit(2));
        this.singleOwner =
          owners.size === 1 &&
          owners.docs[0]?.id === documentKey(this.agentId) &&
          owners.docs[0]?.get('id') === this.agentId;
      }
      if (!this.singleOwner) return null;
    }
    const decision = attributeMemoryPerson(this.contacts, {
      ...input,
      knownContactId: input.knownContactId ? this.resolveRedirect(input.knownContactId) : null,
    });
    if (decision.kind === 'unattributed') return null;
    const now = this.store.now();
    if (decision.kind === 'create') {
      const marker = await this.tx.get(contactNameRef(this.store, decision.name));
      const id = randomUUID();
      const relationship = normalizeMemoryRelationship(input.relationship);
      this.writes.push(() =>
        stageNewContact(this.tx, this.store, {
          id,
          name: decision.name,
          now,
          relationship,
          replaceMarker: marker.exists,
        }),
      );
      this.contacts.push({
        id,
        name: decision.name,
        createdAt: now,
        updatedAt: now,
        trust: 'unknown',
        identityAuthority: 'inferred',
        aliases: [],
        emails: [],
        phones: [],
        notes: '',
        relationship,
      });
      this.created += 1;
      return id;
    }
    if (!decision.update) return decision.contactId;
    const { duplicateId, ...changes } = decision.update;
    if (
      duplicateId &&
      (input.pendingContactIds?.has(duplicateId) ||
        !(await this.planDuplicate(duplicateId, decision.contactId, changes.aliases)))
    )
      return decision.contactId;

    const index = this.contacts.findIndex((row) => row.id === decision.contactId);
    const target = this.contacts[index];
    if (!target) throw new Error('Memory contact attribution target is missing');
    this.contacts[index] = { ...target, ...changes, updatedAt: now };
    this.writes.push(() =>
      this.tx.update(
        this.store.doc('contacts', decision.contactId),
        encodeRecord({ ...changes, updatedAt: now }),
      ),
    );
    return decision.contactId;
  }

  private async planDuplicate(
    sourceId: string,
    targetId: string,
    aliases: string[],
  ): Promise<boolean> {
    const [memories, graphEntities, graphSources, occasions, markers] = await Promise.all([
      this.tx.get(
        this.store
          .collection('memories')
          .where('subjectContactId', '==', sourceId)
          .select('agentId', 'ownerConfirmed')
          .limit(MAX_RECONCILED_PERSON_MEMORIES + 1),
      ),
      this.tx.get(
        this.store
          .collection('knowledgeGraphEntities')
          .where('contactId', '==', sourceId)
          .select()
          .limit(1),
      ),
      this.tx.get(
        this.store
          .collection('knowledgeGraphSources')
          .where('subjectContactId', '==', sourceId)
          .select()
          .limit(1),
      ),
      this.tx.get(
        this.store.collection('occasions').where('contactId', '==', sourceId).select().limit(1),
      ),
      this.tx.get(
        this.store.collection('contactNames').where('contactId', '==', sourceId).select().limit(21),
      ),
    ]);
    const aliasMarkers = new Set(aliases.map((alias) => contactNameRef(this.store, alias).id));
    if (
      this.reconciledWrites + memories.size + markers.size + 3 > MAX_RECONCILIATION_WRITES ||
      !graphEntities.empty ||
      !graphSources.empty ||
      !occasions.empty ||
      markers.docs.some((doc) => !aliasMarkers.has(doc.id)) ||
      memories.size > MAX_RECONCILED_PERSON_MEMORIES ||
      memories.docs.some(
        (doc) => doc.get('agentId') !== this.agentId || doc.get('ownerConfirmed') === true,
      )
    )
      return false;

    this.reconciledWrites += memories.size + markers.size + 3;
    this.contacts.splice(
      this.contacts.findIndex((row) => row.id === sourceId),
      1,
    );
    this.redirects.set(sourceId, targetId);
    this.writes.push(() => {
      for (const memory of memories.docs)
        this.tx.update(memory.ref, { subjectContactId: targetId });
      for (const marker of markers.docs) this.tx.update(marker.ref, { contactId: targetId });
      this.tx.delete(this.store.doc('contacts', sourceId));
      if (!memories.empty)
        this.tx.set(
          this.store.doc('ownerCards', this.agentId),
          { agentId: this.agentId, content: '', compiledAt: this.store.now() },
          { merge: true },
        );
    });
    return true;
  }

  stageWrites(): void {
    for (const write of this.writes) write();
  }
}
