import { createHash, randomUUID } from 'node:crypto';
import {
  type CodeJobLease,
  type CommitmentExtractionApplied,
  type EmbeddingSpace,
  type ExtractionConversation,
  type ExtractionMessage,
  type MemoryExtractionApplied,
  type MemoryExtractionRepository,
  type PreparedMemoryExtraction,
  type Records,
  snapshotEmbeddingSpace,
  validateEmbedding,
} from '@assistant/persistence';
import { canMergeOccasionObservation } from '@assistant/persistence/occasion-trust';
import type {
  DocumentReference,
  DocumentSnapshot,
  QueryDocumentSnapshot,
  Transaction,
} from '@google-cloud/firestore';
import {
  assertCodeJobLeaseInTransaction,
  codeJobCheckpointKeys,
  codeJobCheckpointRef,
  readCodeJobSteps,
  recordCodeJobStep,
} from './code-job-checkpoints.js';
import { contactNameRef, matchSubjectContact, stageNewContact } from './contact-lookup.js';
import { embeddingSpaceKey as exactEmbeddingSpaceKey, memoryDocument } from './memory.js';
import { occasionDateKey, resolveOccasionIdentity } from './occasion-identity.js';
import { FirestoreOwnerContextRepository } from './owner-context.js';
import {
  assertPrivacyErasureFenceUnchanged,
  assertPrivacyErasureInactiveInTransaction,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const JOB = 'memory.extract';
const PAGE = 200;
const ACTIVE_COMMITMENT_PAGE_SIZE = 100;
const MAX_ACTIVE_COMMITMENT_SCAN = 10_000;
/**
 * Messages read while looking for the most recently active conversations. The
 * scan runs newest first, so stopping here still yields the most recent
 * conversations; it only shortens the list on an extraordinarily busy day.
 */
const ACTIVITY_SCAN_LIMIT = 5000;
/** Contacts are the attribution vocabulary; beyond this the read fails loudly. */
const CONTACT_LIMIT = 5000;
const ACTIVE_STATUSES = ['open', 'snoozed'];
const PREPARED_VERSION = 'memory-extraction-v3';

type Contact = Records['contacts'];
type Occasion = Records['occasions'];
type Commitment = Records['commitments'];
type SubjectMatch = ReturnType<typeof matchSubjectContact>;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function commitmentHash(kind: string, title: string, details: string): string {
  return sha256(`${kind}\n${title.trim().toLowerCase()}\n${details.trim().toLowerCase()}`);
}

function preparedId(agentId: string, conversationId: string): string {
  return sha256(`${agentId}\n${conversationId}`);
}

function timestampToken(value: { seconds: number; nanoseconds: number } | null): string | null {
  return value ? `${value.seconds}:${value.nanoseconds}` : null;
}

/** Storage for `memory.extract` on Firestore. Model calls stay in core. */
export class FirestoreMemoryExtractionRepository implements MemoryExtractionRepository {
  readonly kind = 'memory-extraction-repository' as const;
  readonly space: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    space: EmbeddingSpace,
  ) {
    this.space = snapshotEmbeddingSpace(space);
  }

  private async owner(agentId: string): Promise<void> {
    if (!agentId) throw new Error('Memory extraction requires an agent');
    const owner = await this.store.doc('agents', agentId).get();
    if (!owner.exists || owner.get('id') !== agentId || documentKey(agentId) !== owner.id)
      throw new Error('Memory extraction agent is missing');
  }

  private async contacts(): Promise<Contact[]> {
    const page = await this.store
      .collection('contacts')
      .limit(CONTACT_LIMIT + 1)
      .get();
    if (page.size > CONTACT_LIMIT) throw new Error('Contact list exceeds the extraction bound');
    return page.docs.map((doc) => decodeRecord<Contact>(doc.data()));
  }

  /** Read the checkpoint and fences, returning the committed keys. */
  private async begin(tx: Transaction, agentId: string, lease: CodeJobLease): Promise<string[]> {
    await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
    await assertCodeJobLeaseInTransaction(tx, this.store, agentId, lease);
    return codeJobCheckpointKeys(
      await tx.get(codeJobCheckpointRef(this.store, lease.taskId)),
      agentId,
      lease.taskId,
    );
  }

  async recentConversations(input: {
    agentId: string;
    since: Date;
    maxConversations: number;
    maxMessages: number;
    minTextLength: number;
  }): Promise<ExtractionConversation[]> {
    if (
      !Number.isInteger(input.maxConversations) ||
      input.maxConversations < 1 ||
      input.maxConversations > 50 ||
      !Number.isInteger(input.maxMessages) ||
      input.maxMessages < 1 ||
      input.maxMessages > 200 ||
      !Number.isFinite(input.since.getTime())
    )
      throw new Error('Invalid extraction window');
    await this.owner(input.agentId);
    const fence = await readPrivacyErasureFence(this.store, input.agentId);
    const privacyGeneration = timestampToken(fence);
    const qualifies = (row: Records['messages']) =>
      (row.role === 'user' || row.role === 'assistant') &&
      !(
        typeof row.channelMessageId === 'string' &&
        (row.channelMessageId.startsWith('visual-qa:') ||
          row.channelMessageId.startsWith('readability-'))
      ) &&
      typeof row.text === 'string' &&
      row.text.length >= input.minTextLength;

    // Most recently active first: walk messages newest first and keep each
    // owned conversation the first time one of its messages qualifies.
    const selected: Records['conversations'][] = [];
    const decided = new Set<string>();
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    while (selected.length < input.maxConversations && scanned < ACTIVITY_SCAN_LIMIT) {
      let query = this.store
        .collection('messages')
        .where('createdAt', '>=', input.since)
        .orderBy('createdAt', 'desc')
        .limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      scanned += page.size;
      const order: string[] = [];
      for (const doc of page.docs) {
        const row = decodeRecord<Records['messages']>(doc.data());
        if (!qualifies(row) || decided.has(row.conversationId)) continue;
        decided.add(row.conversationId);
        order.push(row.conversationId);
      }
      const conversations = order.length
        ? await this.store.db.getAll(...order.map((id) => this.store.doc('conversations', id)))
        : [];
      for (const snapshot of conversations) {
        if (!snapshot.exists || selected.length >= input.maxConversations) continue;
        const row = decodeRecord<Records['conversations']>(snapshot.data());
        if (row.agentId === input.agentId && documentKey(row.id) === snapshot.id)
          selected.push(row);
      }
      if (page.size < PAGE) break;
      cursor = page.docs.at(-1);
    }

    const result: ExtractionConversation[] = [];
    for (const conversation of selected) {
      const messages: ExtractionMessage[] = [];
      let read = 0;
      let after: QueryDocumentSnapshot | undefined;
      // Newest first, skipping short lines, until the transcript is full. The
      // read is capped so a thread of one-word replies cannot turn into a scan.
      while (messages.length < input.maxMessages && read < input.maxMessages * 4) {
        let query = this.store
          .collection('messages')
          .where('conversationId', '==', conversation.id)
          .where('role', 'in', ['user', 'assistant'])
          .where('createdAt', '>=', input.since)
          .orderBy('createdAt', 'desc')
          .orderBy('id', 'desc')
          .limit(input.maxMessages);
        if (after) query = query.startAfter(after);
        const page = await query.get();
        read += page.size;
        for (const doc of page.docs) {
          const row = decodeRecord<Records['messages']>(doc.data());
          if (row.conversationId !== conversation.id || !qualifies(row)) continue;
          if (messages.length < input.maxMessages)
            messages.push({
              id: row.id,
              role: row.role as ExtractionMessage['role'],
              text: row.text,
              createdAt: row.createdAt,
            });
        }
        if (page.size < input.maxMessages) break;
        after = page.docs.at(-1);
      }
      result.push({
        conversationId: conversation.id,
        trust: conversation.trust,
        messages: messages.reverse(),
        privacyGeneration,
      });
    }
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, fence);
    return result;
  }

  async knownContactNames(agentId: string): Promise<string[]> {
    await this.owner(agentId);
    return (await this.contacts()).map((row) => row.name);
  }

  async knownContacts(agentId: string) {
    await this.owner(agentId);
    return (await this.contacts()).map((row) => ({ id: row.id, name: row.name }));
  }

  async getPrepared(input: {
    agentId: string;
    conversationId: string;
    sourceHash: string;
    extractionVersion: string;
    privacyGeneration: string | null;
  }): Promise<PreparedMemoryExtraction | null> {
    await this.owner(input.agentId);
    const ref = this.store.doc(
      'preparedMemoryExtractions',
      preparedId(input.agentId, input.conversationId),
    );
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const [snapshot, erasure] = await tx.getAll(
        ref,
        this.store.doc('privacyErasureJobs', input.agentId),
      );
      if (!snapshot || !erasure) throw new Error('Prepared extraction fence read is incomplete');
      const currentGeneration = timestampToken(
        erasure.exists ? (erasure.updateTime ?? null) : null,
      );
      if (currentGeneration !== input.privacyGeneration)
        throw new Error('Privacy erasure changed since extraction source was read');
      if (!snapshot.exists) return null;
      if (
        snapshot.get('id') !== ref.id ||
        snapshot.get('agentId') !== input.agentId ||
        snapshot.get('conversationId') !== input.conversationId
      )
        throw new Error('Prepared extraction ownership or identity mismatch');
      if (
        snapshot.get('sourceHash') !== input.sourceHash ||
        snapshot.get('extractionVersion') !== input.extractionVersion ||
        snapshot.get('privacyGeneration') !== input.privacyGeneration
      ) {
        tx.delete(ref);
        return null;
      }
      return {
        agentId: input.agentId,
        conversationId: input.conversationId,
        sourceHash: input.sourceHash,
        extractionVersion: input.extractionVersion,
        privacyGeneration: input.privacyGeneration,
        payload: snapshot.get('payload'),
      };
    });
  }

  async savePrepared(input: PreparedMemoryExtraction & { lease: CodeJobLease }): Promise<void> {
    if (
      !/^[a-f0-9]{64}$/.test(input.sourceHash) ||
      input.extractionVersion !== PREPARED_VERSION ||
      input.payload === null ||
      typeof input.payload !== 'object'
    )
      throw new Error('Invalid prepared extraction payload');
    await this.owner(input.agentId);
    const ref = this.store.doc(
      'preparedMemoryExtractions',
      preparedId(input.agentId, input.conversationId),
    );
    await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      await assertCodeJobLeaseInTransaction(tx, this.store, input.agentId, input.lease);
      const [erasure, conversation] = await Promise.all([
        tx.get(this.store.doc('privacyErasureJobs', input.agentId)),
        tx.get(this.store.doc('conversations', input.conversationId)),
      ]);
      const currentGeneration = timestampToken(
        erasure.exists ? (erasure.updateTime ?? null) : null,
      );
      if (currentGeneration !== input.privacyGeneration)
        throw new Error('Privacy erasure changed before prepared extraction was saved');
      if (!conversation.exists || conversation.get('agentId') !== input.agentId)
        throw new Error('Prepared extraction conversation is not owned');
      const existing = await tx.get(ref);
      if (
        existing.exists &&
        (existing.get('agentId') !== input.agentId ||
          existing.get('conversationId') !== input.conversationId ||
          existing.get('id') !== ref.id)
      )
        throw new Error('Prepared extraction collision');
      tx.set(
        ref,
        encodeRecord({
          id: ref.id,
          agentId: input.agentId,
          conversationId: input.conversationId,
          sourceHash: input.sourceHash,
          extractionVersion: input.extractionVersion,
          privacyGeneration: input.privacyGeneration,
          payload: input.payload,
          updatedAt: this.store.now(),
        }),
      );
    });
  }

  async completedSteps(agentId: string, lease: CodeJobLease): Promise<string[]> {
    return readCodeJobSteps(this.store, agentId, lease.taskId);
  }

  async applyMemories(
    input: Parameters<MemoryExtractionRepository['applyMemories']>[0],
  ): Promise<MemoryExtractionApplied | null> {
    if (!input.checkpointKey || input.facts.length > 25 || input.occasions.length > 10)
      throw new Error('Invalid memory extraction batch');
    // Dream hypotheses hash under their own prefix, so they never collide with facts.
    const hashPrefix = input.source === 'dream' ? 'dream:' : '';
    for (const fact of input.facts) {
      if (!fact.content || fact.contentHash !== sha256(`${hashPrefix}${fact.content}`))
        throw new Error('Invalid extracted memory content hash');
      validateEmbedding(this.space, fact.embedding);
      if (fact.embeddingSpaceKey !== exactEmbeddingSpaceKey(this.space))
        throw new Error('Extracted memory embedding space changed');
    }
    await this.owner(input.agentId);
    // Attribution is decided against the contact list outside the transaction,
    // as the memory tool does; new names converge through their marker below.
    const contacts = await this.contacts();
    const factMatches = input.facts.map((fact) => {
      if (fact.subjectContactId)
        return contacts.some((contact) => contact.id === fact.subjectContactId)
          ? { contactId: fact.subjectContactId }
          : null;
      return matchSubjectContact(contacts, fact.subject);
    });
    const occasionMatches = input.occasions.map((occasion) => {
      if (occasion.contactId)
        return contacts.some((contact) => contact.id === occasion.contactId)
          ? { contactId: occasion.contactId }
          : null;
      return matchSubjectContact(contacts, occasion.subject);
    });
    const hashes = [...new Set(input.facts.map((fact) => fact.contentHash))];
    const preparedRef = input.prepared
      ? this.store.doc(
          'preparedMemoryExtractions',
          preparedId(input.agentId, input.prepared.conversationId),
        )
      : null;

    return this.store.db.runTransaction(async (tx) => {
      const keys = await this.begin(tx, input.agentId, input.lease);
      const preparedSnapshot = preparedRef ? await tx.get(preparedRef) : null;
      const erasure = input.prepared
        ? await tx.get(this.store.doc('privacyErasureJobs', input.agentId))
        : null;
      const currentGeneration = timestampToken(
        erasure?.exists ? (erasure.updateTime ?? null) : null,
      );
      if (input.prepared && currentGeneration !== input.prepared.privacyGeneration)
        throw new Error('Privacy erasure changed before prepared extraction was applied');
      if (preparedSnapshot?.exists && input.prepared) {
        if (
          preparedSnapshot.get('id') !== preparedRef?.id ||
          preparedSnapshot.get('agentId') !== input.agentId ||
          preparedSnapshot.get('sourceHash') !== input.prepared.sourceHash ||
          preparedSnapshot.get('extractionVersion') !== input.prepared.extractionVersion ||
          preparedSnapshot.get('privacyGeneration') !== input.prepared.privacyGeneration
        )
          throw new Error('Prepared extraction changed before application');
      }
      if (input.prepared && !preparedSnapshot?.exists)
        throw new Error('Prepared extraction is missing before application');
      if (keys.includes(input.checkpointKey)) {
        if (preparedSnapshot?.exists && input.prepared) tx.delete(preparedRef as DocumentReference);
        return null;
      }

      const referencedContactIds = [
        ...new Set(
          [...factMatches, ...occasionMatches].flatMap((match) =>
            match && 'contactId' in match ? [match.contactId] : [],
          ),
        ),
      ];
      const contactSnapshots = referencedContactIds.length
        ? await tx.getAll(...referencedContactIds.map((id) => this.store.doc('contacts', id)))
        : [];
      const verifiedContactIds = new Set<string>();
      referencedContactIds.forEach((id, index) => {
        const snapshot = contactSnapshots[index];
        if (
          snapshot?.exists &&
          snapshot.get('id') === id &&
          (snapshot.get('agentId') === undefined || snapshot.get('agentId') === input.agentId)
        )
          verifiedContactIds.add(id);
      });

      const hashChecks = hashes.length
        ? await tx.getAll(
            ...hashes.flatMap((hash) => [
              this.store.doc('memoryContentHashes', hash),
              this.store.doc('memoryTombstones', hash),
            ]),
          )
        : [];
      const existingHash = new Set<string>();
      const tombstoned = new Set<string>();
      hashes.forEach((hash, index) => {
        if (hashChecks[index * 2]?.exists) existingHash.add(hash);
        if (hashChecks[index * 2 + 1]?.exists) tombstoned.add(hash);
      });

      // A tombstoned fact names nobody: PostgreSQL checks the tombstone before
      // it resolves (and possibly creates) the fact's subject.
      const newNames = new Map<string, { name: string; relationship?: string }>();
      const want = (match: SubjectMatch, relationship?: string) => {
        if (!match || !('create' in match)) return;
        const key = match.create.toLowerCase();
        if (!newNames.has(key)) newNames.set(key, { name: match.create, relationship });
      };
      const acceptedFactHashes = new Set<string>();
      input.facts.forEach((fact, index) => {
        if (
          tombstoned.has(fact.contentHash) ||
          existingHash.has(fact.contentHash) ||
          acceptedFactHashes.has(fact.contentHash)
        )
          return;
        acceptedFactHashes.add(fact.contentHash);
        want(factMatches[index] ?? null, fact.relationship);
      });
      input.occasions.forEach((occasion, index) => {
        if (
          Number.isInteger(occasion.month) &&
          occasion.month >= 1 &&
          occasion.month <= 12 &&
          Number.isInteger(occasion.day) &&
          occasion.day >= 1 &&
          occasion.day <= 31
        )
          want(occasionMatches[index] ?? null);
      });
      const names = [...newNames.entries()];
      const markers = names.length
        ? await tx.getAll(...names.map(([, entry]) => contactNameRef(this.store, entry.name)))
        : [];
      const marked = new Map<string, string>();
      const pendingContacts = new Map<
        string,
        { name: string; relationship?: string; id: string }
      >();
      names.forEach(([key], index) => {
        const marker = markers[index];
        if (marker?.exists) marked.set(key, String(marker.get('contactId')));
        else {
          const entry = newNames.get(key);
          if (!entry) return;
          const id = randomUUID();
          marked.set(key, id);
          pendingContacts.set(key, { ...entry, id });
        }
      });

      // Query only proposed occasion identities. A 2-row bound detects legacy
      // random-ID duplicates without scanning or rejecting a person's history.
      const occasionIdentity = (input: {
        contactId: string;
        kind: string;
        month: number;
        day: number;
      }) => [input.contactId, input.kind, input.month, input.day].join('\u0000');
      const proposedOccasions = new Map<
        string,
        { contactId: string; kind: string; month: number; day: number }
      >();
      input.occasions.forEach((occasion, index) => {
        const match = occasionMatches[index];
        const contactId =
          match && 'contactId' in match
            ? match.contactId
            : match && 'create' in match
              ? marked.get(match.create.toLowerCase())
              : undefined;
        if (
          !contactId ||
          !Number.isInteger(occasion.month) ||
          occasion.month < 1 ||
          occasion.month > 12 ||
          !Number.isInteger(occasion.day) ||
          occasion.day < 1 ||
          occasion.day > 31
        )
          return;
        const key = occasionIdentity({
          contactId,
          kind: occasion.kind,
          month: occasion.month,
          day: occasion.day,
        });
        proposedOccasions.set(key, {
          contactId,
          kind: occasion.kind,
          month: occasion.month,
          day: occasion.day,
        });
      });
      const occasionsByIdentity = new Map<
        string,
        Awaited<ReturnType<typeof resolveOccasionIdentity>>
      >();
      for (const [key, proposed] of proposedOccasions) {
        occasionsByIdentity.set(
          key,
          await resolveOccasionIdentity(tx, this.store, input.agentId, proposed),
        );
      }

      // Every read is done; stage the writes.
      const now = this.store.now();
      const result: MemoryExtractionApplied = {
        saved: 0,
        quarantined: 0,
        duplicates: 0,
        tombstoned: 0,
        contactsCreated: 0,
        occasionsSaved: 0,
        occasionsRejected: 0,
      };
      for (const pending of pendingContacts.values()) {
        stageNewContact(tx, this.store, { ...pending, now });
        result.contactsCreated += 1;
      }
      const contactIdFor = (match: SubjectMatch): string | null => {
        if (!match) return null;
        if ('contactId' in match)
          return verifiedContactIds.has(match.contactId) ? match.contactId : null;
        const key = match.create.toLowerCase();
        const known = marked.get(key);
        if (known) return known;
        return null;
      };

      const written = new Set<string>();
      input.facts.forEach((fact, index) => {
        if (tombstoned.has(fact.contentHash)) {
          result.tombstoned += 1;
          return;
        }
        if (existingHash.has(fact.contentHash) || written.has(fact.contentHash)) {
          result.duplicates += 1;
          return;
        }
        written.add(fact.contentHash);
        const subjectContactId = contactIdFor(factMatches[index] ?? null);
        const id = randomUUID();
        const memory: Records['memories'] = {
          id,
          createdAt: now,
          agentId: input.agentId,
          expiresAt: fact.expiresAt,
          embedding: fact.embedding,
          embeddingSpaceKey: fact.embeddingSpaceKey ?? null,
          sourceTaskId: input.lease.taskId,
          kind: fact.kind,
          confidence: fact.confidence,
          contentHash: fact.contentHash,
          goalId: null,
          originTrust: input.originTrust,
          category: fact.category,
          content: fact.content,
          importance: fact.importance,
          quarantined: input.quarantined,
          subjectContactId,
          domain: fact.domain,
          validFrom: fact.validFrom,
          validUntil: null,
          supersededById: null,
          ownerConfirmed: false,
          pinned: false,
          source: input.source ?? 'extraction',
          lastAccessedAt: null,
          lastConsolidatedAt: null,
        };
        tx.create(this.store.doc('memories', id), memoryDocument(this.space, memory));
        tx.create(this.store.doc('memoryContentHashes', fact.contentHash), { memoryId: id });
        result.saved += 1;
        if (input.quarantined) result.quarantined += 1;
      });

      // The PostgreSQL upsert on (owner, person, kind, month, day): fill an
      // unknown year and append new notes, never downgrading trust or
      // re-quarantining an occasion that was already reviewed.
      const staged = new Map<
        string,
        {
          ref: DocumentReference;
          row: Occasion;
          isNew: boolean;
          markerRef: DocumentReference;
          writeMarker: boolean;
        }
      >();
      input.occasions.forEach((occasion, index) => {
        if (
          !Number.isInteger(occasion.month) ||
          occasion.month < 1 ||
          occasion.month > 12 ||
          !Number.isInteger(occasion.day) ||
          occasion.day < 1 ||
          occasion.day > 31
        ) {
          result.occasionsRejected += 1;
          return;
        }
        const contactId = contactIdFor(occasionMatches[index] ?? null);
        if (!contactId) {
          result.occasionsRejected += 1;
          return;
        }
        const notes = occasion.notes.trim().slice(0, 2000);
        const identity = occasionIdentity({
          contactId,
          kind: occasion.kind,
          month: occasion.month,
          day: occasion.day,
        });
        const matches = occasionsByIdentity.get(identity);
        if (!matches || matches.ambiguous || matches.superseded) {
          result.occasionsRejected += 1;
          if (matches?.ambiguous || matches?.superseded)
            console.error(`memory extraction: blocked occasion identity ${identity}`);
          return;
        }
        let entry = staged.get(identity);
        if (!entry) {
          const existing = matches.snapshot;
          if (existing) {
            entry = {
              ref: existing.ref,
              row: decodeRecord<Occasion>(existing.data()),
              isNew: false,
              markerRef: matches.markerRef,
              writeMarker: !matches.markerExists,
            };
          } else {
            const id = randomUUID();
            entry = {
              ref: this.store.doc('occasions', id),
              isNew: true,
              markerRef: matches.markerRef,
              writeMarker: true,
              row: {
                id,
                agentId: input.agentId,
                contactId,
                kind: occasion.kind,
                label: occasion.label.slice(0, 120),
                month: occasion.month,
                day: occasion.day,
                year: occasion.year,
                recurrence: 'annual',
                leadDays: 7,
                notes,
                originTrust: input.originTrust,
                quarantined: input.quarantined,
                ownerConfirmed: false,
                source: 'extraction',
                createdAt: now,
                updatedAt: now,
              },
            };
            staged.set(identity, entry);
            result.occasionsSaved += 1;
            return;
          }
          staged.set(identity, entry);
        }
        const current = entry.row;
        if (!canMergeOccasionObservation(current, input)) return;
        entry.row = {
          ...current,
          year: current.year ?? occasion.year,
          notes:
            current.notes === ''
              ? notes
              : notes === '' || current.notes.includes(notes)
                ? current.notes
                : `${current.notes}; ${notes}`,
          updatedAt: now,
        };
      });
      for (const entry of staged.values()) {
        if (entry.isNew) tx.create(entry.ref, encodeRecord(entry.row));
        else
          tx.update(
            entry.ref,
            encodeRecord({ year: entry.row.year, notes: entry.row.notes, updatedAt: now }),
          );
        if (entry.writeMarker)
          tx.create(entry.markerRef, occasionDateKey(input.agentId, entry.row, entry.row.id));
      }

      if (!input.prepared || result.occasionsRejected === 0) {
        recordCodeJobStep(tx, this.store, {
          agentId: input.agentId,
          taskId: input.lease.taskId,
          job: JOB,
          keys,
          key: input.checkpointKey,
          now,
        });
        if (preparedSnapshot?.exists && input.prepared) tx.delete(preparedRef as DocumentReference);
      }
      return result;
    });
  }

  async activeCommitments(
    agentId: string,
    limit: number,
  ): Promise<Array<{ id: string; title: string; reopenedFromId: string | null }>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid active commitment limit');
    await this.owner(agentId);
    const base = this.store
      .collection('commitments')
      .where('agentId', '==', agentId)
      .where('status', 'in', ACTIVE_STATUSES)
      .orderBy('updatedAt', 'desc');
    const eligible: Commitment[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    let scanned = 0;
    const provenance = new FirestoreOwnerContextRepository(this.store);
    while (eligible.length < limit && scanned < MAX_ACTIVE_COMMITMENT_SCAN) {
      const pageLimit = Math.min(ACTIVE_COMMITMENT_PAGE_SIZE, MAX_ACTIVE_COMMITMENT_SCAN - scanned);
      let query = base.limit(pageLimit);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      scanned += page.size;
      const candidates = page.docs.flatMap((doc) => {
        const row = decodeRecord<Commitment>(doc.data());
        return row.agentId === agentId && documentKey(row.id) === doc.id ? [row] : [];
      });
      eligible.push(...(await provenance.filterEligibleCommitmentProvenance(candidates, agentId)));
      cursor = page.docs.at(-1);
      if (page.size < pageLimit) break;
    }
    if (eligible.length < limit && scanned >= MAX_ACTIVE_COMMITMENT_SCAN && cursor) {
      const overflow = await base.startAfter(cursor).limit(1).get();
      if (!overflow.empty) {
        throw new Error(`Active commitment provenance scan exceeded ${MAX_ACTIVE_COMMITMENT_SCAN}`);
      }
    }
    return eligible.slice(0, limit).map((row) => ({
      id: row.id,
      title: row.title,
      reopenedFromId: row.reopenedFromId ?? null,
    }));
  }

  async applyCommitments(
    input: Parameters<MemoryExtractionRepository['applyCommitments']>[0],
  ): Promise<CommitmentExtractionApplied | null> {
    if (!input.checkpointKey || input.commitments.length > 12 || input.resolveIds.length > 12)
      throw new Error('Invalid commitment extraction batch');
    for (const item of input.commitments) {
      if (item.contentHash !== commitmentHash(item.kind, item.title, item.details))
        throw new Error('Invalid extracted commitment content hash');
      if (
        !item.sourceMessageId ||
        !item.sourceMessageIds.includes(item.sourceMessageId) ||
        !item.sourceOccurrenceKey.startsWith(
          `v1:${input.agentId}:${input.conversationId}:${item.kind}:`,
        )
      )
        throw new Error('Invalid extracted commitment source occurrence');
    }
    await this.owner(input.agentId);

    return this.store.db.runTransaction(async (tx) => {
      const keys = await this.begin(tx, input.agentId, input.lease);
      if (keys.includes(input.checkpointKey)) return null;
      const conversation = await tx.get(this.store.doc('conversations', input.conversationId));
      if (
        !conversation.exists ||
        conversation.get('agentId') !== input.agentId ||
        conversation.get('trust') !== 'owner'
      )
        throw new Error('Commitment extraction conversation is not an owner thread');

      const resolveDocs = input.resolveIds.length
        ? await tx.getAll(...input.resolveIds.map((id) => this.store.doc('commitments', id)))
        : [];
      const occurrences = new Map<
        string,
        {
          ref: DocumentReference;
          id: string;
          deterministic: DocumentSnapshot;
          legacy?: QueryDocumentSnapshot;
        }
      >();
      for (const item of input.commitments) {
        if (occurrences.has(item.sourceOccurrenceKey)) continue;
        const digest = sha256(
          `commitment-occurrence\0${input.agentId}\0${item.sourceOccurrenceKey}`,
        );
        const deterministicId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        const ref = this.store.doc('commitments', deterministicId);
        const deterministic = await tx.get(ref);
        let legacy: QueryDocumentSnapshot | undefined;
        if (!deterministic.exists) {
          const byOccurrence = await tx.get(
            this.store
              .collection('commitments')
              .where('agentId', '==', input.agentId)
              .where('sourceOccurrenceKey', '==', item.sourceOccurrenceKey)
              .limit(2),
          );
          if (byOccurrence.size > 1) throw new Error('Commitment occurrence identity is ambiguous');
          legacy = byOccurrence.docs[0];
          if (!legacy) {
            // Read only this occurrence's source pointers, never its lifetime
            // content-hash history. A closed matching pointer is a replay fence.
            const bySource = await tx.get(
              this.store
                .collection('commitments')
                .where('conversationId', '==', input.conversationId)
                .where('kind', '==', item.kind)
                .where('sourceMessageId', 'in', item.sourceMessageIds),
            );
            legacy = bySource.docs.find(
              (doc) => doc.get('agentId') === input.agentId && !doc.get('sourceOccurrenceKey'),
            );
          }
        }
        occurrences.set(item.sourceOccurrenceKey, {
          ref,
          id: deterministicId,
          deterministic,
          legacy,
        });
      }
      const now = this.store.now();
      const result: CommitmentExtractionApplied = { saved: 0, duplicates: 0, resolved: 0 };
      const resolvedIds = new Set<string>();
      for (const snapshot of resolveDocs) {
        if (!snapshot.exists) continue;
        const row = decodeRecord<Commitment>(snapshot.data());
        if (
          row.agentId !== input.agentId ||
          documentKey(row.id) !== snapshot.id ||
          !ACTIVE_STATUSES.includes(row.status)
        )
          continue;
        tx.update(snapshot.ref, {
          status: 'resolved',
          resolvedAt: now,
          snoozedUntil: null,
          resolution: input.resolution,
          updatedAt: now,
        });
        resolvedIds.add(row.id);
        result.resolved += 1;
      }

      const stagedOccurrences = new Set<string>();
      for (const item of input.commitments) {
        if (stagedOccurrences.has(item.sourceOccurrenceKey)) {
          result.duplicates += 1;
          continue;
        }
        stagedOccurrences.add(item.sourceOccurrenceKey);
        const occurrence = occurrences.get(item.sourceOccurrenceKey);
        if (!occurrence) throw new Error('Commitment occurrence was not pre-read');
        const prior = occurrence.deterministic.exists
          ? occurrence.deterministic
          : occurrence.legacy;
        if (prior?.exists) {
          const row = decodeRecord<Commitment>(prior.data());
          if (
            row.agentId !== input.agentId ||
            row.conversationId !== input.conversationId ||
            row.kind !== item.kind ||
            (row.sourceOccurrenceKey && row.sourceOccurrenceKey !== item.sourceOccurrenceKey)
          )
            throw new Error('Commitment occurrence identity is ambiguous');
          if (!row.sourceOccurrenceKey)
            tx.update(prior.ref, { sourceOccurrenceKey: item.sourceOccurrenceKey });
          if (ACTIVE_STATUSES.includes(row.status) && !resolvedIds.has(row.id)) {
            // Do not touch title/details: those are editable semantics, not identity.
            tx.update(prior.ref, {
              nextAction: item.nextAction,
              dueAt: item.dueAt,
              confidence: item.confidence,
            });
          }
          result.duplicates += 1;
          continue;
        }
        const refresh = {
          conversationId: input.conversationId,
          sourceMessageId: item.sourceMessageId,
          sourceTaskId: input.lease.taskId,
          sourceOccurrenceKey: item.sourceOccurrenceKey,
          reopenedFromId: null,
          reopenOperationId: null,
          nextAction: item.nextAction,
          dueAt: item.dueAt,
          confidence: item.confidence,
        };
        const id = occurrence.id;
        const row: Commitment = {
          id,
          createdAt: now,
          updatedAt: now,
          agentId: input.agentId,
          title: item.title,
          status: 'open',
          kind: item.kind,
          details: item.details,
          snoozedUntil: null,
          resolvedAt: null,
          resolution: null,
          contentHash: item.contentHash,
          ...refresh,
        };
        tx.create(occurrence.ref, encodeRecord(row));
        result.saved += 1;
      }

      recordCodeJobStep(tx, this.store, {
        agentId: input.agentId,
        taskId: input.lease.taskId,
        job: JOB,
        keys,
        key: input.checkpointKey,
        now,
      });
      return result;
    });
  }
}
