import { randomUUID } from 'node:crypto';
import type {
  ProfileContactIdentityMutation,
  ProfilePeopleCommandRepository,
  Records,
} from '@assistant/persistence';
import {
  isContactIdentityRevision,
  normalizeContactAliases,
  normalizeContactName,
  type OwnerEditorApply,
  type OwnerEditorClaim,
  type OwnerEditorReply,
  ownerEditorCommitRevision,
  ownerEditorSnapshotRevision,
  parseContactIdentityAuthority,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { assertConfiguredOwner } from './knowledge-graph-read.js';
import {
  beginFirestoreOwnerEditorWrite,
  completeFirestoreOwnerEditorWrite,
} from './owner-editor-repository.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const CONTACT_SCAN_LIMIT = 500;
type Contact = Records['contacts'];

async function assertWritableOwner(
  tx: Transaction,
  store: InstallationStore,
  agentId: string,
): Promise<void> {
  const owners = await tx.get(store.collection('agents').limit(2));
  const owner = owners.docs[0];
  if (
    owners.size !== 1 ||
    !owner ||
    owner.get('id') !== agentId ||
    owner.id !== documentKey(agentId)
  )
    throw new Error('Profile mutation requires exactly one configured owner');
  const erasure = await tx.get(store.doc('privacyErasureJobs', agentId));
  if (
    erasure.exists &&
    (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
  )
    throw new Error('Privacy erasure is in progress');
}

function readContact(snapshot: DocumentSnapshot): Contact {
  const row = decodeRecord<Contact>(snapshot.data());
  parseContactIdentityAuthority(row.identityAuthority);
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== snapshot.id ||
    typeof row.name !== 'string' ||
    typeof row.relationship !== 'string' ||
    typeof row.trust !== 'string' ||
    !Array.isArray(row.aliases) ||
    !Array.isArray(row.emails) ||
    !Array.isArray(row.phones) ||
    typeof row.notes !== 'string'
  )
    throw new Error('Person record is malformed');
  return row;
}

/** Owner-scoped Firestore writes for non-destructive person profile edits. */
export class FirestoreProfilePeopleCommandRepository implements ProfilePeopleCommandRepository {
  readonly kind = 'profile-people-command-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async create(input: { name: string; relationship: string; aliases: string[] }): Promise<string> {
    const id = randomUUID();
    const ref = this.store.doc('contacts', id);
    const rows = this.store.collection('contacts').limit(CONTACT_SCAN_LIMIT + 1);
    await this.store.db.runTransaction(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const existing = await tx.get(rows);
      if (existing.size > CONTACT_SCAN_LIMIT)
        throw new Error('Contact directory is too large to update safely');
      const contacts = existing.docs.map((snapshot) => {
        const ownerId = snapshot.get('agentId');
        if (ownerId !== undefined && ownerId !== this.configuredAgentId) return null;
        return readContact(snapshot);
      });
      if (contacts.some((row) => row?.name.toLocaleLowerCase() === input.name.toLocaleLowerCase()))
        throw new Error('A person with that name already exists.');
      const now = this.store.now();
      const contact: Contact & { agentId: string } = {
        id,
        agentId: this.configuredAgentId,
        name: input.name,
        relationship: input.relationship,
        aliases: input.aliases,
        emails: [],
        phones: [],
        notes: '',
        trust: 'known',
        identityAuthority: 'owner',
        createdAt: now,
        updatedAt: now,
      };
      tx.create(ref, encodeRecord(contact));
    });
    return id;
  }

  async updateRelationship(contactId: string, relationship: string): Promise<void> {
    const ref = this.store.doc('contacts', contactId);
    await this.store.db.runTransaction(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return;
      const contact = readContact(snapshot);
      const ownerId = snapshot.get('agentId');
      if (ownerId !== undefined && ownerId !== this.configuredAgentId)
        throw new Error('Person not found.');
      tx.update(ref, {
        relationship,
        ...(relationship && contact.trust === 'unknown' ? { trust: 'known' } : {}),
        updatedAt: this.store.now(),
      });
    });
  }

  async updateIdentity(
    contactId: string,
    name: string,
    aliases: string[],
    expectedContactRevision?: string,
    relationship?: string,
  ): Promise<ProfileContactIdentityMutation> {
    if (!isContactIdentityRevision(expectedContactRevision)) return { status: 'review_required' };
    const ref = this.store.doc('contacts', contactId);
    const contactsQuery = this.store.collection('contacts').limit(CONTACT_SCAN_LIMIT + 1);
    return this.store.db.runTransaction(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const [snapshot, existing] = await Promise.all([tx.get(ref), tx.get(contactsQuery)]);
      if (!snapshot.exists) return { status: 'not_found' };
      const contact = readContact(snapshot);
      const ownerId = snapshot.get('agentId');
      if (
        (ownerId !== undefined && ownerId !== this.configuredAgentId) ||
        contact.trust === 'owner'
      )
        return { status: 'not_found' };
      if (this.editorContactRevision(snapshot) !== expectedContactRevision)
        return { status: 'conflict' };
      if (existing.size > CONTACT_SCAN_LIMIT) return { status: 'review_required' };
      const duplicate = existing.docs.some((candidate) => {
        if (candidate.id === snapshot.id) return false;
        const ownerId = candidate.get('agentId');
        if (ownerId !== undefined && ownerId !== this.configuredAgentId) return false;
        const row = readContact(candidate);
        return row.name.toLocaleLowerCase() === name.toLocaleLowerCase();
      });
      if (duplicate) return { status: 'conflict' };
      const renamed = contact.name.toLocaleLowerCase() !== name.toLocaleLowerCase();
      const normalizedAliases = new Map<string, string>();
      for (const alias of [...aliases, ...(renamed ? [contact.name] : [])]) {
        const key = alias.toLocaleLowerCase();
        if (key !== name.toLocaleLowerCase() && !normalizedAliases.has(key))
          normalizedAliases.set(key, alias);
      }
      if (normalizedAliases.size > 20) throw new Error('A person can have at most 20 aliases.');
      tx.update(ref, {
        name,
        aliases: [...normalizedAliases.values()],
        identityAuthority: 'owner',
        ...(relationship !== undefined ? { relationship } : {}),
        updatedAt: this.store.now(),
      });
      return { status: 'updated', name, aliases: [...normalizedAliases.values()] };
    });
  }

  async editorContact(contactId: string) {
    await assertConfiguredOwner(this.store, this.configuredAgentId);
    const snapshot = await this.store.doc('contacts', contactId).get();
    if (!snapshot.exists) return null;
    const contact = readContact(snapshot);
    const ownerId = snapshot.get('agentId');
    if ((ownerId !== undefined && ownerId !== this.configuredAgentId) || !snapshot.updateTime)
      return null;
    return { ...contact, revision: this.editorContactRevision(snapshot) };
  }

  private editorContactRevision(snapshot: DocumentSnapshot) {
    if (!snapshot.updateTime) throw new Error('Person update time is unavailable');
    return ownerEditorSnapshotRevision({
      driver: 'firestore',
      ownerId: this.configuredAgentId,
      id: snapshot.id,
      updateTime: {
        seconds: snapshot.updateTime.seconds,
        nanoseconds: snapshot.updateTime.nanoseconds,
      },
    });
  }

  async commitEditor(
    claim: OwnerEditorClaim,
    prepared: {
      request: Extract<OwnerEditorApply, { command: 'create_person' | 'update_person_identity' }>;
      name: string;
      aliases: string[];
    },
    now: Date,
  ): Promise<OwnerEditorReply> {
    return this.store.db.runTransaction(async (tx) => {
      const admitted = await beginFirestoreOwnerEditorWrite(this.store, tx, claim, now);
      if (admitted.kind === 'reply') return admitted.reply;
      if (claim.scope.ownerId !== this.configuredAgentId) throw new Error('Owner changed');
      const request = prepared.request;
      if (
        claim.scope.command !== request.command ||
        claim.scope.operationId !== request.operationId ||
        (request.command === 'update_person_identity'
          ? claim.scope.targetId !== request.contactId
          : claim.scope.targetId !== null)
      )
        throw new Error('Prepared person operation does not match its claim');
      const name = normalizeContactName(prepared.name);
      const logicalId =
        request.command === 'update_person_identity' ? request.contactId : randomUUID();
      const ref = this.store.doc('contacts', logicalId);
      const currentSnapshot =
        request.command === 'update_person_identity' ? await tx.get(ref) : null;
      const current = currentSnapshot?.exists ? readContact(currentSnapshot) : null;
      if (
        request.command === 'update_person_identity' &&
        (!currentSnapshot ||
          !current ||
          current.trust === 'owner' ||
          (currentSnapshot?.get('agentId') !== undefined &&
            currentSnapshot.get('agentId') !== this.configuredAgentId) ||
          this.editorContactRevision(currentSnapshot) !== request.expectedContactRevision)
      )
        return completeFirestoreOwnerEditorWrite(
          this.store,
          tx,
          admitted,
          { outcome: 'conflict', reason: 'contact_changed' },
          now,
        );
      const existing = await tx.get(
        this.store.collection('contacts').limit(CONTACT_SCAN_LIMIT + 1),
      );
      if (existing.size > CONTACT_SCAN_LIMIT)
        return completeFirestoreOwnerEditorWrite(
          this.store,
          tx,
          admitted,
          { outcome: 'unavailable', reason: 'contact_read_limit' },
          now,
        );
      for (const snapshot of existing.docs) {
        const ownerId = snapshot.get('agentId');
        if (ownerId !== undefined && ownerId !== this.configuredAgentId) continue;
        const row = readContact(snapshot);
        if (row.id !== current?.id && row.name.toLocaleLowerCase() === name.toLocaleLowerCase())
          return completeFirestoreOwnerEditorWrite(
            this.store,
            tx,
            admitted,
            { outcome: 'conflict', reason: 'duplicate_contact' },
            now,
          );
      }
      const aliases = normalizeContactAliases(
        [
          ...prepared.aliases,
          ...(current && current.name.toLocaleLowerCase() !== name.toLocaleLowerCase()
            ? [current.name]
            : []),
        ],
        name,
      );
      if (
        current &&
        current.name === name &&
        JSON.stringify(current.aliases) === JSON.stringify(aliases)
      ) {
        if (current.identityAuthority !== 'owner')
          tx.update(ref, { identityAuthority: 'owner', updatedAt: now });
        const ids = { contactId: current.id };
        return completeFirestoreOwnerEditorWrite(
          this.store,
          tx,
          admitted,
          { outcome: 'unchanged', ids, revision: ownerEditorCommitRevision(claim, ids) },
          now,
        );
      }
      if (current) tx.update(ref, { name, aliases, identityAuthority: 'owner', updatedAt: now });
      else
        tx.create(
          ref,
          encodeRecord({
            id: logicalId,
            agentId: this.configuredAgentId,
            name,
            aliases,
            relationship: '',
            trust: 'known',
            identityAuthority: 'owner',
            emails: [],
            phones: [],
            notes: '',
            createdAt: now,
            updatedAt: now,
          }),
        );
      const ids = { contactId: logicalId };
      return completeFirestoreOwnerEditorWrite(
        this.store,
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
}
