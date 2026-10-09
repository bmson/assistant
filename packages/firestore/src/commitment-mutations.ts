import { createHash, createHash as hashBytes } from 'node:crypto';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

type Commitment = {
  id: string;
  agentId: string;
  kind: string;
  title: string;
  details: string;
  nextAction: string;
  status: string;
  snoozedUntil: Date | null;
  resolvedAt: Date | null;
  resolution: string | null;
  confidence: string;
  contentHash: string;
  updatedAt: Date;
  conversationId?: string;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
  sourceOccurrenceKey?: string | null;
  dueAt?: Date | null;
  reopenedFromId?: string | null;
  reopenOperationId?: string | null;
};

type Correction = { title: string; details: string; nextAction: string };

function validCommitment(snapshot: DocumentSnapshot, agentId: string): Commitment | null {
  if (!snapshot.exists) return null;
  const row = decodeRecord<Commitment>(snapshot.data());
  if (row.agentId !== agentId) return null;
  if (
    typeof row.id !== 'string' ||
    !row.id ||
    documentKey(row.id) !== snapshot.id ||
    typeof row.kind !== 'string' ||
    typeof row.title !== 'string' ||
    typeof row.details !== 'string' ||
    typeof row.nextAction !== 'string' ||
    !['open', 'snoozed', 'resolved', 'dismissed', 'stale'].includes(row.status)
  )
    throw new Error('Commitment mutation found a malformed owner row');
  return row;
}

function contentHash(kind: string, title: string, details: string): string {
  return createHash('sha256')
    .update(`${kind}\n${title.trim().toLowerCase()}\n${details.trim().toLowerCase()}`)
    .digest('hex');
}

function reopenDocumentId(agentId: string, parentId: string): string {
  const hex = hashBytes('sha256').update(`${agentId}\0${parentId}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Atomic owner-fenced commitment mutations used by the mobile memory desk. */
export class FirestoreCommitmentMutationRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  private async ownerFence(tx: Transaction): Promise<void> {
    const agents = await tx.get(this.store.collection('agents').limit(2));
    const owner = agents.docs[0];
    if (
      !this.configuredAgentId ||
      agents.size !== 1 ||
      !owner ||
      owner.id !== documentKey(this.configuredAgentId) ||
      owner.get('id') !== this.configuredAgentId
    )
      throw new Error('Commitment mutation requires one matching configured owner');
    const erasure = await tx.get(this.store.doc('privacyErasureJobs', this.configuredAgentId));
    if (
      erasure.exists &&
      (erasure.get('agentId') !== this.configuredAgentId ||
        privacyErasureIsActive(erasure.get('status')) ||
        !erasure.updateTime)
    )
      throw new Error('Privacy erasure is in progress');
  }

  private async mutate(
    id: string,
    apply: (row: Commitment, now: Date) => Record<string, unknown>,
  ): Promise<boolean> {
    if (!id) return false;
    const ref = this.store.doc('commitments', id);
    return this.store.db.runTransaction(async (tx) => {
      await this.ownerFence(tx);
      const snapshot = await tx.get(ref);
      const row = validCommitment(snapshot, this.configuredAgentId);
      if (!row || !['open', 'snoozed', 'stale'].includes(row.status) || row.resolvedAt)
        return false;
      tx.update(ref, apply(row, this.store.now()));
      return true;
    });
  }

  resolve(id: string, resolution: string): Promise<boolean> {
    return this.mutate(id, (_row, now) => ({
      status: 'resolved',
      resolvedAt: now,
      snoozedUntil: null,
      resolution,
      updatedAt: now,
    }));
  }

  snooze(id: string, until: Date): Promise<boolean> {
    if (!Number.isFinite(until.getTime()) || until <= this.store.now())
      throw new Error('A commitment can only be snoozed until a valid future date.');
    return this.mutate(id, (_row, now) => ({
      status: 'snoozed',
      snoozedUntil: until,
      updatedAt: now,
    }));
  }

  dismiss(id: string): Promise<boolean> {
    return this.mutate(id, (_row, now) => ({
      status: 'dismissed',
      resolvedAt: now,
      snoozedUntil: null,
      resolution: 'Dismissed by owner',
      updatedAt: now,
    }));
  }

  correct(id: string, patch: Correction): Promise<boolean> {
    const title = patch.title.trim().replace(/\s+/g, ' ').slice(0, 180);
    if (!title) throw new Error('A commitment title is required.');
    const details = patch.details.trim().slice(0, 500);
    const nextAction = patch.nextAction.trim().slice(0, 240);
    if (!id) return Promise.resolve(false);
    const ref = this.store.doc('commitments', id);
    return this.store.db.runTransaction(async (tx) => {
      await this.ownerFence(tx);
      const snapshot = await tx.get(ref);
      const row = validCommitment(snapshot, this.configuredAgentId);
      if (!row || !['open', 'snoozed', 'stale'].includes(row.status) || row.resolvedAt)
        return false;
      const hash = contentHash(row.kind, title, details);
      const duplicates = await tx.get(
        this.store
          .collection('commitments')
          .where('agentId', '==', this.configuredAgentId)
          .where('contentHash', '==', hash)
          .where('status', 'in', ['open', 'snoozed', 'stale'])
          .where('resolvedAt', '==', null)
          .limit(2),
      );
      if (duplicates.docs.some((doc) => doc.id !== snapshot.id))
        throw new Error('A matching active commitment already exists.');
      const now = this.store.now();
      tx.update(ref, {
        title,
        details,
        nextAction,
        confidence: '1.00',
        contentHash: hash,
        updatedAt: now,
      });
      return true;
    });
  }

  async reopen(
    id: string,
    expectedUpdatedAt: Date,
    operationId: string,
  ): Promise<{ commitmentId: string; replay: boolean } | null> {
    if (
      !id ||
      !(expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(expectedUpdatedAt.getTime()) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        operationId,
      )
    )
      return null;
    const childId = reopenDocumentId(this.configuredAgentId, id);
    const originalRef = this.store.doc('commitments', id);
    const childRef = this.store.doc('commitments', childId);
    return this.store.db.runTransaction(async (tx) => {
      await this.ownerFence(tx);
      const snapshots = await tx.getAll(originalRef, childRef);
      const originalSnapshot = snapshots[0];
      const childSnapshot = snapshots[1];
      if (!originalSnapshot) return null;
      if (childSnapshot?.exists) {
        const existing = validCommitment(childSnapshot, this.configuredAgentId);
        return existing?.reopenOperationId === operationId && existing.reopenedFromId === id
          ? { commitmentId: existing.id, replay: true }
          : null;
      }
      const closed = validCommitment(originalSnapshot, this.configuredAgentId);
      if (
        !closed ||
        !['resolved', 'dismissed'].includes(closed.status) ||
        !(closed.resolvedAt instanceof Date) ||
        !(closed.updatedAt instanceof Date) ||
        closed.updatedAt.getTime() !== expectedUpdatedAt.getTime()
      )
        return null;

      const existingChildren = await tx.get(
        this.store
          .collection('commitments')
          .where('agentId', '==', this.configuredAgentId)
          .where('reopenedFromId', '==', id)
          .limit(1),
      );
      if (!existingChildren.empty) return null;
      const candidates = await tx.get(
        this.store
          .collection('commitments')
          .where('agentId', '==', this.configuredAgentId)
          .where('contentHash', '==', closed.contentHash)
          .where('status', 'in', ['open', 'snoozed', 'stale'])
          .where('resolvedAt', '==', null)
          .limit(100),
      );
      if (candidates.docs.some((doc) => doc.id !== originalSnapshot.id)) return null;

      const now = this.store.now();
      tx.create(childRef, {
        id: childId,
        agentId: this.configuredAgentId,
        kind: closed.kind,
        title: closed.title,
        details: closed.details,
        nextAction: closed.nextAction,
        status: 'open',
        snoozedUntil: null,
        resolvedAt: null,
        resolution: null,
        confidence: closed.confidence,
        contentHash: closed.contentHash,
        conversationId: closed.conversationId ?? null,
        sourceMessageId: closed.sourceMessageId ?? null,
        sourceTaskId: null,
        sourceOccurrenceKey: `manual-reopen:v1:${this.configuredAgentId}:${operationId}`,
        reopenedFromId: id,
        reopenOperationId: operationId,
        dueAt: closed.dueAt ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { commitmentId: childId, replay: false };
    });
  }
}
