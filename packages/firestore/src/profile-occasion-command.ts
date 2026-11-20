import { randomUUID } from 'node:crypto';
import type {
  OccasionCorrectionInput,
  OccasionCorrectionResult,
  ProfileOccasionCommandInput,
  ProfileOccasionCommandRepository,
  Records,
} from '@assistant/persistence';
import {
  isOccasionCorrectionDate,
  occasionCorrectionReadback,
  sameOccasionContactName,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { isEmulatorClosedTransaction } from './emulator-transaction.js';
import {
  type OccasionIdentity,
  occasionDateKey,
  occasionDateKeyId,
  resolveOccasionIdentity,
  supersededOccasionDateKey,
} from './occasion-identity.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Occasion = Records['occasions'];
const MAX_CONTACT_OCCASIONS = 100;
const CONTACT_SCAN_LIMIT = 5000;

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
      if (duplicate) throw new Error('Matching occasion records are ambiguous');
      if (!(await this.stageDateChange(tx, old, newIdentity)))
        throw new OccasionDateCorrectionConflictError();
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

  /** Resolve a chat correction and apply it to the canonical document in one transaction. */
  async correct(input: OccasionCorrectionInput): Promise<OccasionCorrectionResult> {
    if (input.agentId !== this.configuredAgentId) throw new Error('Occasion owner mismatch');
    return this.store.db.runTransaction<OccasionCorrectionResult>(async (tx) => {
      await assertWritableOwner(tx, this.store, this.configuredAgentId);
      const contacts = await tx.get(
        this.store.collection('contacts').limit(CONTACT_SCAN_LIMIT + 1),
      );
      if (contacts.size > CONTACT_SCAN_LIMIT)
        throw new Error('Occasion contact lookup exceeded bound');
      const people = contacts.docs.filter((doc) => {
        const name = doc.get('name');
        const owner = doc.get('agentId');
        return (
          (owner === undefined || owner === this.configuredAgentId) &&
          typeof name === 'string' &&
          sameOccasionContactName(name, input.subject)
        );
      });
      if (people.length > 1) return { outcome: 'ambiguous_contact' };
      const person = people[0];
      if (!person) return { outcome: 'contact_not_found' };
      const contactId = person.get('id');
      if (typeof contactId !== 'string' || documentKey(contactId) !== person.id)
        throw new Error('Matching person record is malformed');

      const { expectedDate } = input;
      const identity = {
        contactId,
        kind: input.kind,
        month: expectedDate.month,
        day: expectedDate.day,
      };
      const previous = await resolveOccasionIdentity(
        tx,
        this.store,
        this.configuredAgentId,
        identity,
      );
      if (previous.ambiguous) return { outcome: 'ambiguous_occasion' };
      if (!previous.snapshot) return { outcome: 'occasion_not_found' };
      const old = validExisting(
        previous.snapshot,
        this.configuredAgentId,
        contactId,
        input.kind,
        expectedDate.month,
        expectedDate.day,
      );
      if (
        old.quarantined !== false ||
        (input.label !== undefined && input.label !== old.label) ||
        (expectedDate.year !== undefined && expectedDate.year !== old.year)
      )
        return { outcome: 'occasion_not_found' };

      const date = {
        ...input.date,
        year: input.date.year === undefined ? old.year : input.date.year,
      };
      if (!isOccasionCorrectionDate(date)) return { outcome: 'invalid_date' };
      const name: string = person.get('name');
      if (old.month === date.month && old.day === date.day && old.year === date.year)
        return { outcome: 'unchanged', occasion: occasionCorrectionReadback(old, name) };

      const destination = { contactId, kind: input.kind, month: date.month, day: date.day };
      if (!(await this.stageDateChange(tx, old, destination, previous)))
        return { outcome: 'date_conflict' };
      // The snapshot was read in this transaction. Firestore revalidates it at
      // commit, including the original date, owner, contact and record ID.
      tx.update(previous.snapshot.ref, { ...date, updatedAt: this.store.now() });
      return {
        outcome: 'updated',
        occasion: occasionCorrectionReadback({ ...old, ...date }, name),
      };
    });
  }

  private async stageDateChange(
    tx: Transaction,
    old: Occasion,
    destination: OccasionIdentity,
    previous?: Awaited<ReturnType<typeof resolveOccasionIdentity>>,
  ): Promise<boolean> {
    const { contactId, kind, month, day } = old;
    const oldIdentity = { contactId, kind, month, day };
    const oldMarker =
      previous ??
      (await resolveOccasionIdentity(tx, this.store, this.configuredAgentId, oldIdentity));
    if (
      oldMarker.ambiguous ||
      oldMarker.superseded ||
      (oldMarker.snapshot && oldMarker.snapshot.id !== documentKey(old.id))
    )
      return false;
    const activeKey = occasionDateKey(this.configuredAgentId, destination, old.id);
    if (
      old.kind === destination.kind &&
      old.month === destination.month &&
      old.day === destination.day
    ) {
      if (!oldMarker.markerExists) tx.create(oldMarker.markerRef, activeKey);
      return true;
    }
    const resolved = await resolveOccasionIdentity(
      tx,
      this.store,
      this.configuredAgentId,
      destination,
    );
    if (
      resolved.ambiguous ||
      (resolved.superseded && resolved.supersededOccasionId !== old.id) ||
      (resolved.snapshot && resolved.snapshot.id !== documentKey(old.id))
    )
      return false;
    tx.set(
      oldMarker.markerRef,
      supersededOccasionDateKey(this.configuredAgentId, oldIdentity, old.id),
    );
    if (resolved.markerExists) tx.set(resolved.markerRef, activeKey);
    else tx.create(resolved.markerRef, activeKey);
    return true;
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
