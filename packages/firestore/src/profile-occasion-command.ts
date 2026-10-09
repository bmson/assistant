import { randomUUID } from 'node:crypto';
import type {
  ProfileOccasionCommandInput,
  ProfileOccasionCommandRepository,
  Records,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { isEmulatorClosedTransaction } from './emulator-transaction.js';
import {
  occasionDateKey,
  occasionDateKeyId,
  resolveOccasionIdentity,
  supersededOccasionDateKey,
} from './occasion-identity.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Occasion = Records['occasions'];
const MAX_CONTACT_OCCASIONS = 100;

export class OccasionDateCorrectionConflictError extends Error {
  constructor() {
    super('This occasion date was explicitly corrected by the owner');
    this.name = 'OccasionDateCorrectionConflictError';
  }
}

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

function validExisting(
  snapshot: DocumentSnapshot,
  agentId: string,
  contactId: string,
  kind: string,
  month: number,
  day: number,
): Occasion {
  const row = decodeRecord<Occasion>(snapshot.data());
  if (
    !row.id ||
    documentKey(row.id) !== snapshot.id ||
    row.agentId !== agentId ||
    row.contactId !== contactId ||
    row.kind !== kind ||
    row.month !== month ||
    row.day !== day ||
    typeof row.notes !== 'string' ||
    (row.year !== null && !Number.isInteger(row.year))
  )
    throw new Error('Existing occasion record is malformed');
  return row;
}

/** Transactional Firestore writer for owner-entered occasions. */
export class FirestoreProfileOccasionCommandRepository implements ProfileOccasionCommandRepository {
  readonly kind = 'profile-occasion-command-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async create(input: Parameters<ProfileOccasionCommandRepository['create']>[0]): Promise<void> {
    await this.record(input, {
      originTrust: 'owner',
      quarantined: false,
      ownerConfirmed: true,
      source: 'profile',
    });
  }

  /**
   * Create an occasion with the given provenance, or merge notes and a missing
   * year into the existing one for the same person and date. Returns whether a
   * new occasion was created. A merge never changes the existing provenance.
   */
  async record(
    input: ProfileOccasionCommandInput,
    provenance: Pick<Occasion, 'originTrust' | 'quarantined' | 'ownerConfirmed' | 'source'>,
  ): Promise<{ created: boolean }> {
    const id = randomUUID();
    const ownerQuery = this.store.collection('agents').limit(2);
    const contactRef = this.store.doc('contacts', input.contactId);
    const erasureRef = this.store.doc('privacyErasureJobs', this.configuredAgentId);
    const contactOccasions = this.store
      .collection('occasions')
      .where('agentId', '==', this.configuredAgentId)
      .where('contactId', '==', input.contactId)
      .limit(MAX_CONTACT_OCCASIONS + 1);

    // Concurrent creates dedupe by owner/person/date, so a retry resolves to the winner.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.store.db.runTransaction(async (tx) => {
          const owners = await tx.get(ownerQuery);
          const owner = owners.docs[0];
          if (
            owners.size !== 1 ||
            !owner ||
            owner.get('id') !== this.configuredAgentId ||
            owner.id !== documentKey(this.configuredAgentId)
          )
            throw new Error('Occasion creation requires exactly one configured owner');
          const [contact, erasure, contactOccasionPage, identity] = await Promise.all([
            tx.get(contactRef),
            tx.get(erasureRef),
            tx.get(contactOccasions),
            resolveOccasionIdentity(tx, this.store, this.configuredAgentId, input),
          ]);
          if (!contact?.exists) throw new Error('Person not found.');
          const person = decodeRecord<Records['contacts']>(contact.data());
          if (person.id !== input.contactId || documentKey(person.id) !== contact.id)
            throw new Error('Person record is malformed');
          const contactAgentId = contact.get('agentId');
          if (contactAgentId !== undefined && contactAgentId !== this.configuredAgentId)
            throw new Error('Person not found.');

          if (
            erasure?.exists &&
            (erasure.get('agentId') !== this.configuredAgentId ||
              privacyErasureIsActive(erasure.get('status')))
          )
            throw new Error('Privacy erasure is in progress');

          if (contactOccasionPage.size > MAX_CONTACT_OCCASIONS)
            throw new Error('Person has too many occasions to update safely.');
          if (identity.ambiguous) throw new Error('Matching occasion records are ambiguous');
          if (identity.superseded && provenance.source !== 'profile')
            throw new OccasionDateCorrectionConflictError();

          const now = this.store.now();
          const existing = identity.snapshot;
          if (existing) {
            const row = validExisting(
              existing,
              this.configuredAgentId,
              input.contactId,
              input.kind,
              input.month,
              input.day,
            );
            const notes =
              !input.notes || row.notes.includes(input.notes)
                ? row.notes
                : row.notes
                  ? `${row.notes}; ${input.notes}`
                  : input.notes;
            tx.update(existing.ref, {
              year: row.year ?? input.year,
              notes,
              updatedAt: now,
            });
            if (!identity.markerExists)
              tx.create(identity.markerRef, occasionDateKey(this.configuredAgentId, input, row.id));
            return { created: false };
          }

          const row: Occasion = {
            id,
            agentId: this.configuredAgentId,
            contactId: input.contactId,
            kind: input.kind,
            label: input.label,
            month: input.month,
            day: input.day,
            year: input.year,
            recurrence: 'annual',
            leadDays: input.leadDays,
            notes: input.notes,
            ...provenance,
            createdAt: now,
            updatedAt: now,
          };
          const occasionRef = this.store.doc('occasions', id);
          tx.create(occasionRef, encodeRecord(row));
          if (identity.superseded) tx.delete(identity.markerRef);
          tx.create(identity.markerRef, occasionDateKey(this.configuredAgentId, input, id));
          return { created: true };
        });
      } catch (error) {
        if (!isEmulatorClosedTransaction(error) || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }

  async update(
    occasionId: string,
    input: Omit<ProfileOccasionCommandInput, 'contactId'>,
    expectedContactId?: string,
  ): Promise<boolean> {
    const occasionRef = this.store.doc('occasions', occasionId);
    const rowQuery = this.store
      .collection('occasions')
      .where('agentId', '==', this.configuredAgentId);
    return this.store.db.runTransaction(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const [snapshot, page] = await Promise.all([
        tx.get(occasionRef),
        tx.get(rowQuery.limit(500)),
      ]);
      if (!snapshot.exists || snapshot.get('agentId') !== this.configuredAgentId) return false;
      const old = validExisting(
        snapshot,
        this.configuredAgentId,
        snapshot.get('contactId'),
        snapshot.get('kind'),
        snapshot.get('month'),
        snapshot.get('day'),
      );
      const contact = await tx.get(this.store.doc('contacts', old.contactId));
      if (!contact.exists) throw new Error('Person not found.');
      const person = decodeRecord<Records['contacts']>(contact.data());
      const contactAgentId = contact.get('agentId');
      if (
        (expectedContactId !== undefined && expectedContactId !== old.contactId) ||
        person.id !== old.contactId ||
        documentKey(person.id) !== contact.id ||
        (contactAgentId !== undefined && contactAgentId !== this.configuredAgentId)
      )
        throw new Error('Person not found.');
      if (page.size >= 500) throw new Error('Occasion update scan exceeds its safe limit');
      const newIdentity = {
        contactId: old.contactId,
        kind: input.kind,
        month: input.month,
        day: input.day,
      };
      const resolved = await resolveOccasionIdentity(
        tx,
        this.store,
        this.configuredAgentId,
        newIdentity,
      );
      if (resolved.ambiguous) throw new Error('Matching occasion records are ambiguous');
      if (resolved.superseded && resolved.supersededOccasionId !== occasionId)
        throw new OccasionDateCorrectionConflictError();
      const duplicate = page.docs.some((doc) => {
        if (doc.id === snapshot.id) return false;
        const row = decodeRecord<Partial<Occasion>>(doc.data());
        return (
          row.agentId === this.configuredAgentId &&
          row.contactId === old.contactId &&
          row.kind === input.kind &&
          row.month === input.month &&
          row.day === input.day
        );
      });
      if (duplicate || (resolved.snapshot && resolved.snapshot.id !== snapshot.id))
        throw new Error('Matching occasion records are ambiguous');
      const oldIdentity = {
        contactId: old.contactId,
        kind: old.kind,
        month: old.month,
        day: old.day,
      };
      const oldMarker = await resolveOccasionIdentity(
        tx,
        this.store,
        this.configuredAgentId,
        oldIdentity,
      );
      if (oldMarker.ambiguous) throw new Error('Matching occasion records are ambiguous');
      if (oldMarker.snapshot && oldMarker.snapshot.id !== snapshot.id)
        throw new Error('Occasion date marker conflicts with its record');
      if (
        oldIdentity.kind !== newIdentity.kind ||
        oldIdentity.month !== newIdentity.month ||
        oldIdentity.day !== newIdentity.day
      ) {
        tx.set(
          oldMarker.markerRef,
          supersededOccasionDateKey(this.configuredAgentId, oldIdentity, occasionId),
        );
        if (resolved.superseded)
          tx.set(
            resolved.markerRef,
            occasionDateKey(this.configuredAgentId, newIdentity, occasionId),
          );
        else if (resolved.markerExists)
          tx.set(
            resolved.markerRef,
            occasionDateKey(this.configuredAgentId, newIdentity, occasionId),
          );
        else
          tx.create(
            resolved.markerRef,
            occasionDateKey(this.configuredAgentId, newIdentity, occasionId),
          );
      } else if (!oldMarker.markerExists) {
        tx.create(
          oldMarker.markerRef,
          occasionDateKey(this.configuredAgentId, oldIdentity, occasionId),
        );
      }
      tx.update(occasionRef, {
        kind: input.kind,
        label: input.label,
        month: input.month,
        day: input.day,
        year: input.year,
        leadDays: input.leadDays,
        notes: input.notes,
        originTrust: 'owner',
        ownerConfirmed: true,
        quarantined: false,
        updatedAt: this.store.now(),
      });
      return true;
    });
  }

  async forget(occasionId: string): Promise<void> {
    const ref = this.store.doc('occasions', occasionId);
    await this.store.db.runTransaction(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== this.configuredAgentId) return;
      const row = decodeRecord<Partial<Occasion>>(snapshot.data());
      if (row.id !== occasionId || documentKey(row.id) !== snapshot.id)
        throw new Error('Occasion record is malformed');
      const marker = await tx.get(
        this.store.doc(
          'occasionDateKeys',
          occasionDateKeyId(this.configuredAgentId, row as Occasion),
        ),
      );
      tx.delete(ref);
      if (marker.exists && marker.get('occasionId') === occasionId) tx.delete(marker.ref);
    });
  }

  async review(occasionId: string, verdict: 'approve' | 'reject'): Promise<void> {
    const ref = this.store.doc('occasions', occasionId);
    await this.store.db.runTransaction(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== this.configuredAgentId) return;
      const row = decodeRecord<Partial<Occasion>>(snapshot.data());
      if (row.id !== occasionId || documentKey(row.id) !== snapshot.id)
        throw new Error('Occasion record is malformed');
      if (verdict === 'reject') {
        const marker = await tx.get(
          this.store.doc(
            'occasionDateKeys',
            occasionDateKeyId(this.configuredAgentId, row as Occasion),
          ),
        );
        tx.delete(ref);
        if (marker.exists && marker.get('occasionId') === occasionId) tx.delete(marker.ref);
      } else
        tx.update(ref, {
          quarantined: false,
          ownerConfirmed: true,
          updatedAt: this.store.now(),
        });
    });
  }
}
