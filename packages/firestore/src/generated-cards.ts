import { createHash } from 'node:crypto';
import type {
  GeneratedCardPersistInput,
  GeneratedCardPersistResult,
  GeneratedCardRecord,
  GeneratedCardRepository,
  Records,
} from '@assistant/persistence';
import { emailObserverPreparedCardMatches } from '@assistant/persistence';
import { Filter } from '@google-cloud/firestore';
import {
  assertPrivacyErasureGenerationInTransaction,
  privacyErasureIsActive,
} from './privacy-erasure.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

type Card = Records['generatedCards'];
type Revision = Records['generatedCardRevisions'];

const MAX_LISTED_CARDS = 200;
const MAX_SELECTED_CARDS = 100;

function keyFor(agentId: string, sourceFingerprint: string): string {
  return createHash('sha256')
    .update(JSON.stringify([agentId, sourceFingerprint]))
    .digest('hex');
}

function validateInput(input: GeneratedCardPersistInput): void {
  if (
    !input.agentId ||
    !input.id ||
    !input.revisionId ||
    !input.sourceFingerprint ||
    !input.sourceLabel ||
    input.spec === null ||
    input.spec === undefined
  )
    throw new Error('Invalid generated card');
  if (input.expiresAt && !Number.isFinite(input.expiresAt.getTime()))
    throw new Error('Invalid generated card expiry');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

function sameSpec(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function decodeCard(value: unknown): Card {
  return decodeRecord<Card>(value);
}

function decodeRevision(value: unknown): Revision {
  return decodeRecord<Revision>(value);
}

export class FirestoreGeneratedCardRepository implements GeneratedCardRepository {
  readonly kind = 'generated-card-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async createOrRevise(input: GeneratedCardPersistInput): Promise<GeneratedCardPersistResult> {
    validateInput(input);
    const keyRef = this.store.doc(
      'generatedCardKeys',
      keyFor(input.agentId, input.sourceFingerprint),
    );
    const cardRef = this.store.doc('generatedCards', input.id);
    const revisionRef = this.store.doc('generatedCardRevisions', input.revisionId);
    return this.store.db.runTransaction(async (tx) => {
      const keySnapshot = await tx.get(keyRef);
      const matches = input.targetCardId
        ? null
        : await tx.get(
            this.store
              .collection('generatedCards')
              .where('agentId', '==', input.agentId)
              .where('sourceFingerprint', '==', input.sourceFingerprint)
              .limit(2),
          );
      const targetSnapshot = input.targetCardId
        ? await tx.get(this.store.doc('generatedCards', input.targetCardId))
        : null;
      if (matches && matches.size > 1) throw new Error('Ambiguous generated card source');
      const conversation = input.conversationId
        ? await tx.get(this.store.doc('conversations', input.conversationId))
        : null;
      if (
        input.conversationId &&
        (!conversation?.exists || conversation.get('agentId') !== input.agentId)
      )
        throw new Error('Conversation does not belong to this agent');

      let effectWork: Records['emailObserverWork'] | null = null;
      if (input.emailObserverEffectFence) {
        const fence = input.emailObserverEffectFence;
        if (fence.agentId !== input.agentId)
          throw new Error('Email observer card effect owner mismatch');
        await assertPrivacyErasureGenerationInTransaction(
          tx,
          this.store,
          fence.agentId,
          fence.expectedPrivacyGeneration,
        );
        const workSnapshot = await tx.get(this.store.doc('emailObserverWork', fence.id));
        if (workSnapshot.exists)
          effectWork = decodeRecord<Records['emailObserverWork']>(workSnapshot.data());
        const effectNow = this.store.now();
        if (
          !effectWork ||
          effectWork.agentId !== fence.agentId ||
          effectWork.claimToken !== fence.claimToken ||
          effectWork.claimGeneration !== fence.claimGeneration ||
          effectWork.privacyGeneration !== fence.expectedPrivacyGeneration ||
          effectWork.status !== 'prepared' ||
          !effectWork.leaseExpiresAt ||
          effectWork.leaseExpiresAt <= effectNow ||
          effectWork.observerKey !== 'google.email-card' ||
          !emailObserverPreparedCardMatches(effectWork.preparedResult, input)
        )
          throw new Error('Email observer card effect claim is no longer current');
      }

      const keyCardId = keySnapshot.exists ? String(keySnapshot.get('cardId') ?? '') : '';
      const matchedCard = targetSnapshot?.exists
        ? decodeCard(targetSnapshot.data())
        : matches?.docs[0]
          ? decodeCard(matches.docs[0].data())
          : null;
      if (keyCardId && matchedCard && keyCardId !== matchedCard.id)
        throw new Error('Generated card key points to another card');
      let card = matchedCard;
      if (!card && keyCardId) {
        const pointed = await tx.get(this.store.doc('generatedCards', keyCardId));
        if (pointed.exists) card = decodeCard(pointed.data());
      }
      if (
        card &&
        (card.agentId !== input.agentId || card.sourceFingerprint !== input.sourceFingerprint)
      )
        throw new Error('Generated card source belongs to another agent');
      if (input.targetCardId && (card?.status !== 'active' || card.dismissedAt))
        throw new Error('Generated card refresh target is unavailable');
      if (input.targetRevisionId && card?.currentRevisionId !== input.targetRevisionId)
        throw new Error('Generated card refresh revision is stale');

      const now = this.store.now();
      if (
        input.emailObserverEffectFence &&
        (!effectWork?.leaseExpiresAt ||
          effectWork.leaseExpiresAt <= now ||
          effectWork.status !== 'prepared')
      )
        throw new Error('Email observer card effect claim expired before card write');
      if (!card) {
        const sameId = await tx.get(cardRef);
        const sameRevision = await tx.get(revisionRef);
        if (sameId.exists) throw new Error('Generated card ID belongs to another card');
        if (sameRevision.exists) throw new Error('Generated card revision belongs to another card');
        card = {
          id: input.id,
          createdAt: now,
          updatedAt: now,
          agentId: input.agentId,
          status: 'active',
          expiresAt: input.expiresAt,
          conversationId: input.conversationId ?? null,
          messageId: null,
          sourceLabel: input.sourceLabel,
          sourceFingerprint: input.sourceFingerprint,
          currentRevisionId: input.revisionId,
          dismissedAt: null,
        };
        const revision: Revision = {
          id: input.revisionId,
          createdAt: now,
          version: 1,
          cardId: card.id,
          spec: input.spec,
        };
        tx.set(keyRef, {
          agentId: input.agentId,
          sourceFingerprint: input.sourceFingerprint,
          cardId: card.id,
          createdAt: now,
        });
        tx.create(cardRef, encodeRecord(card));
        tx.create(revisionRef, encodeRecord(revision));
        return { card, revision };
      }

      const currentSnapshot = await tx.get(
        this.store.doc('generatedCardRevisions', card.currentRevisionId),
      );
      if (!currentSnapshot.exists) throw new Error('Generated card current revision is missing');
      const current = decodeRevision(currentSnapshot.data());
      if (current.cardId !== card.id)
        throw new Error('Generated card current revision does not belong to the card');
      const incomingSnapshot = await tx.get(revisionRef);
      if (incomingSnapshot.exists && decodeRevision(incomingSnapshot.data()).cardId !== card.id)
        throw new Error('Generated card revision belongs to another card');
      if (sameSpec(current.spec, input.spec)) {
        if (!keySnapshot.exists)
          tx.set(keyRef, {
            agentId: input.agentId,
            sourceFingerprint: input.sourceFingerprint,
            cardId: card.id,
            createdAt: now,
          });
        if (!input.touch) return { card, revision: current };
        const updated: Card = {
          ...card,
          updatedAt: now,
          status: 'active',
          dismissedAt: null,
          sourceLabel: input.sourceLabel,
          expiresAt: input.expiresAt,
        };
        tx.update(this.store.doc('generatedCards', card.id), encodeRecord(updated));
        return { card: updated, revision: current };
      }
      if (input.revisionId === current.id || incomingSnapshot.exists)
        throw new Error('Generated card revision ID is already in use');
      const revision: Revision = {
        id: input.revisionId,
        createdAt: now,
        version: current.version + 1,
        cardId: card.id,
        spec: input.spec,
      };
      const updated: Card = {
        ...card,
        updatedAt: now,
        status: 'active',
        dismissedAt: null,
        sourceLabel: input.sourceLabel,
        expiresAt: input.expiresAt,
        currentRevisionId: revision.id,
      };
      tx.set(keyRef, {
        agentId: input.agentId,
        sourceFingerprint: input.sourceFingerprint,
        cardId: card.id,
        createdAt: keySnapshot.exists ? keySnapshot.get('createdAt') : now,
      });
      tx.create(revisionRef, encodeRecord(revision));
      tx.update(this.store.doc('generatedCards', card.id), encodeRecord(updated));
      return { card: updated, revision };
    });
  }

  async get(agentId: string, cardId: string): Promise<GeneratedCardRecord | null> {
    if (!agentId || !cardId) return null;
    const cardSnapshot = await this.store.doc('generatedCards', cardId).get();
    if (!cardSnapshot.exists) return null;
    const card = decodeCard(cardSnapshot.data());
    if (card.agentId !== agentId || card.status !== 'active' || card.dismissedAt) return null;
    const revisionSnapshot = await this.store
      .doc('generatedCardRevisions', card.currentRevisionId)
      .get();
    if (!revisionSnapshot.exists) return null;
    const revision = decodeRevision(revisionSnapshot.data());
    return revision.cardId === card.id ? { card, revision } : null;
  }

  async list(
    agentId: string,
    now = this.store.now(),
    ids?: string[],
  ): Promise<GeneratedCardRecord[]> {
    if (!agentId || !Number.isFinite(now.getTime())) throw new Error('Invalid card listing');
    const selectedIds = ids ? [...new Set(ids)] : undefined;
    if (selectedIds && selectedIds.length > MAX_SELECTED_CARDS)
      throw new Error(`Cannot list more than ${MAX_SELECTED_CARDS} selected cards`);
    if (selectedIds?.length === 0) return [];
    const snapshots = selectedIds
      ? await this.store.db.getAll(...selectedIds.map((id) => this.store.doc('generatedCards', id)))
      : (
          await this.store
            .collection('generatedCards')
            .where('agentId', '==', agentId)
            .where('status', '==', 'active')
            .where(
              Filter.or(
                Filter.where('expiresAt', '==', null),
                Filter.where('expiresAt', '>=', now),
              ),
            )
            .limit(MAX_LISTED_CARDS + 1)
            .get()
        ).docs;
    if (!selectedIds && snapshots.length > MAX_LISTED_CARDS)
      throw new Error(`Active generated card list exceeds ${MAX_LISTED_CARDS}`);
    const cards = snapshots.flatMap((snapshot) => {
      if (!snapshot.exists) return [];
      const card = decodeCard(snapshot.data());
      if (
        card.agentId !== agentId ||
        card.status !== 'active' ||
        card.dismissedAt ||
        (!selectedIds && card.expiresAt && card.expiresAt < now)
      )
        return [];
      return [card];
    });
    if (cards.length === 0) return [];
    const revisionSnapshots = await this.store.db.getAll(
      ...cards.map((card) => this.store.doc('generatedCardRevisions', card.currentRevisionId)),
    );
    return cards
      .flatMap((card, index) => {
        const snapshot = revisionSnapshots[index];
        if (!snapshot?.exists) return [];
        const revision = decodeRevision(snapshot.data());
        return revision.cardId === card.id ? [{ card, revision }] : [];
      })
      .sort((a, b) => b.card.updatedAt.getTime() - a.card.updatedAt.getTime());
  }

  async listRefreshes(agentId: string, cardIds: string[]) {
    if (!agentId || cardIds.length === 0) return [];
    const ids = [...new Set(cardIds)];
    if (ids.length > MAX_SELECTED_CARDS)
      throw new Error(`Cannot list refreshes for more than ${MAX_SELECTED_CARDS} cards`);
    const snapshots = await Promise.all(
      ids.map((cardId) =>
        this.store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .where('trigger.payload.refreshCardId', '==', cardId)
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get(),
      ),
    );
    return snapshots
      .flatMap((snapshot) =>
        snapshot.docs.map((doc) => {
          const task = decodeRecord<Records['tasks']>(doc.data());
          const trigger = task.trigger as { payload?: { refreshCardId?: unknown } } | null;
          return {
            id: task.id,
            cardId: String(trigger?.payload?.refreshCardId ?? ''),
            status: task.status,
            createdAt: task.createdAt,
          };
        }),
      )
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
      );
  }

  async dismiss(agentId: string, cardId: string, now = this.store.now()): Promise<boolean> {
    if (!agentId || !cardId || !Number.isFinite(now.getTime())) return false;
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('generatedCards', cardId);
      const [snapshot, erasure] = await tx.getAll(
        ref,
        this.store.doc('privacyErasureJobs', agentId),
      );
      if (!snapshot || !erasure) throw new Error('Generated card dismissal read failed');
      if (
        erasure?.exists &&
        (erasure.get('agentId') !== agentId || privacyErasureIsActive(erasure.get('status')))
      )
        return false;
      if (!snapshot.exists) return false;
      const card = decodeCard(snapshot.data());
      if (card.agentId !== agentId) return false;
      tx.update(ref, encodeRecord({ status: 'dismissed', dismissedAt: now, updatedAt: now }));
      return true;
    });
  }
}
