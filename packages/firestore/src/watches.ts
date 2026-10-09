import { createHash, randomUUID } from 'node:crypto';
import type { Records, WatchCreateInput, WatchRepository } from '@assistant/persistence';
import type { DocumentSnapshot, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { conversationDocument } from './conversation-document.js';
import { isEmulatorClosedTransaction } from './emulator-transaction.js';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';
import { suggestionIdFor } from './suggestions.js';

type Watch = Records['watches'];
type FireEffect = Records['watchFireEffects'];

function fireEffectDocumentId(fireId: string, kind: string): string {
  return createHash('sha256').update(`${fireId}:${kind}`).digest('hex');
}

function sourceEventId(triggerRef: string): string {
  const separator = triggerRef.indexOf(':');
  return separator < 0 ? triggerRef : triggerRef.slice(separator + 1);
}

function fireEffectRecord(
  watch: Watch,
  fire: Records['watchFires'],
  kind: FireEffect['kind'],
  payload: unknown,
  now: Date,
  status: string = 'pending',
): FireEffect {
  return {
    id: fireEffectDocumentId(fire.id, kind),
    agentId: watch.agentId,
    watchId: watch.id,
    fireId: fire.id,
    kind,
    status,
    idempotencyKey: `watch-fire:${watch.id}:${fire.triggerRef}:${kind}`,
    payload,
    attempts: 0,
    claimedAt: null,
    leaseUntil: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
}

function effectsForFire(watch: Watch, fire: Records['watchFires'], now: Date): FireEffect[] {
  const effects = [
    fireEffectRecord(
      watch,
      fire,
      'dashboard_notice',
      watch.conversationId
        ? {
            conversationId: watch.conversationId,
            text: fire.summary,
            channelMessageId: `watch-fire:${watch.id}:${sourceEventId(fire.triggerRef)}`,
          }
        : { reason: 'watch has no conversation' },
      now,
      watch.conversationId ? 'pending' : 'skipped',
    ),
    fireEffectRecord(
      watch,
      fire,
      'owner_notification',
      { text: fire.summary, urgency: 'ambient' },
      now,
    ),
  ];
  if (watch.tier === 'suggest')
    effects.push(
      fireEffectRecord(
        watch,
        fire,
        'suggestion_enqueue',
        {
          agentId: watch.agentId,
          watchId: watch.id,
          triggerRef: fire.triggerRef,
          externalEventId: `watch-suggest:${watch.id}:${sourceEventId(fire.triggerRef)}`,
        },
        now,
      ),
    );
  return effects;
}

function notificationsConversationId(agentId: string): string {
  return `watch-notifications:${createHash('sha256').update(agentId).digest('hex')}`;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 6;
}

function isPreconditionFailed(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 9;
}

function watchRecord(
  input: WatchCreateInput,
  id: string,
  conversationId: string,
  now: Date,
): Watch {
  return {
    id,
    agentId: input.agentId,
    conversationId,
    kind: input.kind,
    tier: input.tier,
    name: input.name,
    match: input.match,
    status: 'active',
    fireCount: 0,
    maxFires: input.maxFires,
    lastFiredAt: null,
    nextPollAt: input.nextPollAt ?? null,
    pollIntervalSeconds: input.pollIntervalSeconds ?? null,
    state: input.state ?? {},
    expiresAt: input.expiresAt,
    createdAt: now,
    updatedAt: now,
  };
}

export class FirestoreWatchRepository implements WatchRepository {
  readonly kind = 'watch-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async create(input: WatchCreateInput): Promise<Watch> {
    const id = randomUUID();
    const conversationId = input.conversationId ?? randomUUID();
    return this.store.db.runTransaction(async (tx) => {
      const conversation = this.store.doc('conversations', conversationId);
      const existing = await tx.get(conversation);
      const now = this.store.now();
      if (existing.exists) {
        if (existing.get('agentId') !== input.agentId)
          throw new Error('watch chat belongs to another agent');
      } else if (input.conversationId) {
        throw new Error('watch chat does not exist');
      } else {
        tx.create(
          conversation,
          conversationDocument({
            id: conversationId,
            agentId: input.agentId,
            channel: 'chat',
            trust: 'owner',
            title: `Watch: ${input.name}`.slice(0, 80),
            isPrimary: false,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            modelOverride: null,
            metadata: {},
            lastReadAt: null,
          }),
        );
      }
      const row = watchRecord(input, id, conversationId, now);
      tx.create(this.store.doc('watches', id), encodeRecord(row));
      return row;
    });
  }

  async list(agentId: string, status?: string, limit = 100) {
    let query = this.store.collection('watches').where('agentId', '==', agentId);
    if (status) query = query.where('status', '==', status);
    const snapshots = await query.orderBy('createdAt', 'desc').limit(limit).get();
    return snapshots.docs.map((doc) => decodeRecord<Watch>(doc.data()));
  }

  async cancel(agentId: string, watchId: string, now: Date) {
    const ref = this.store.doc('watches', watchId);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return null;
      const row = decodeRecord<Watch>(snapshot.data());
      if (row.agentId !== agentId || documentKey(row.id) !== snapshot.id) return null;
      if (row.status !== 'active') return { status: row.status, cancelled: false };
      tx.update(ref, { status: 'cancelled', updatedAt: now });
      return { status: 'cancelled', cancelled: true };
    });
  }

  async expire(agentId: string | null, now: Date) {
    let total = 0;
    while (true) {
      const count = await this.store.db.runTransaction(async (tx) => {
        let query = this.store
          .collection('watches')
          .where('status', '==', 'active')
          .where('expiresAt', '<=', now);
        if (agentId) query = query.where('agentId', '==', agentId);
        const snapshots = await tx.get(query.limit(400));
        for (const snapshot of snapshots.docs)
          tx.update(snapshot.ref, { status: 'expired', updatedAt: now });
        return snapshots.size;
      });
      total += count;
      if (count < 400) return total;
    }
  }

  async emailCandidates(agentId: string, now: Date) {
    const rows: Watch[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    while (true) {
      let query = this.store
        .collection('watches')
        .where('agentId', '==', agentId)
        .where('status', '==', 'active')
        .where('kind', '==', 'email')
        .where('expiresAt', '>', now)
        .orderBy('expiresAt')
        .limit(400);
      if (cursor) query = query.startAfter(cursor);
      const snapshots = await query.get();
      rows.push(...snapshots.docs.map((doc) => decodeRecord<Watch>(doc.data())));
      cursor = snapshots.docs.at(-1);
      if (snapshots.size < 400) return rows;
    }
  }

  async claimDueWeb(now: Date, batch: number, defaultIntervalSeconds: number) {
    if (!Number.isFinite(defaultIntervalSeconds) || defaultIntervalSeconds <= 0)
      throw new Error('default web watch poll interval must be positive');
    return this.store.db.runTransaction(async (tx) => {
      const snapshots = await tx.get(
        this.store
          .collection('watches')
          .where('status', '==', 'active')
          .where('kind', '==', 'web')
          .where('nextPollAt', '<=', now)
          .orderBy('nextPollAt')
          .limit(batch),
      );
      const claimed: Watch[] = [];
      for (const snapshot of snapshots.docs) {
        const row = decodeRecord<Watch>(snapshot.data());
        if (row.expiresAt <= now) {
          tx.update(snapshot.ref, { status: 'expired', updatedAt: now });
          continue;
        }
        const configured = row.pollIntervalSeconds;
        const intervalSeconds =
          configured != null && Number.isFinite(configured) && configured > 0
            ? configured
            : defaultIntervalSeconds;
        const nextPollAt = new Date(now.getTime() + intervalSeconds * 1000);
        tx.update(snapshot.ref, { nextPollAt, updatedAt: now });
        claimed.push({ ...row, nextPollAt, updatedAt: now });
      }
      return claimed;
    });
  }

  async updateWeb(input: Parameters<WatchRepository['updateWeb']>[0]) {
    const ref = this.store.doc('watches', input.watchId);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (
        !snapshot.exists ||
        snapshot.get('status') !== 'active' ||
        decodeRecord<Date>(snapshot.get('nextPollAt')).getTime() !==
          input.expectedNextPollAt.getTime()
      )
        return false;
      tx.update(
        ref,
        encodeRecord({
          state: input.state,
          status: input.expire ? 'expired' : 'active',
          updatedAt: input.now,
        }),
      );
      return true;
    });
  }

  async recordFire(input: Parameters<WatchRepository['recordFire']>[0]) {
    const watchRef = this.store.doc('watches', input.watchId);
    // The emulator occasionally reports a contended transaction as code 3
    // instead of retryable ABORTED. The operation is idempotent by triggerRef,
    // so retry that emulator-only response after the competing commit settles.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.store.db.runTransaction(async (tx) => {
          await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
          const watchSnapshot = await tx.get(watchRef);
          if (!watchSnapshot.exists) return { recorded: false, watch: null };
          const watch = decodeRecord<Watch>(watchSnapshot.data());
          if (watch.agentId !== input.agentId || documentKey(watch.id) !== watchSnapshot.id)
            return { recorded: false, watch: null };
          const duplicate = await tx.get(
            this.store
              .collection('watchFires')
              .where('agentId', '==', input.agentId)
              .where('watchId', '==', watch.id)
              .where('triggerRef', '==', input.triggerRef)
              .limit(1),
          );
          if (!duplicate.empty) {
            const fireDoc = duplicate.docs[0];
            if (!fireDoc) return { recorded: false, watch };
            const fire = decodeRecord<Records['watchFires']>(fireDoc.data());
            const effects = effectsForFire(watch, fire, input.now);
            const refs = effects.map((effect) => this.store.doc('watchFireEffects', effect.id));
            const snapshots: DocumentSnapshot[] = [];
            for (const ref of refs) snapshots.push(await tx.get(ref));
            effects.forEach((effect, index) => {
              if (!snapshots[index]?.exists) {
                const ref = refs[index];
                if (ref) tx.create(ref, encodeRecord(effect));
              }
            });
            if (input.state !== undefined)
              tx.update(watchRef, encodeRecord({ state: input.state, updatedAt: input.now }));
            return { recorded: false, watch, fireId: fire.id };
          }
          if (
            watch.status !== 'active' ||
            watch.expiresAt <= input.now ||
            (input.expectedNextPollAt &&
              watch.nextPollAt?.getTime() !== input.expectedNextPollAt.getTime()) ||
            (watch.maxFires != null && watch.fireCount >= watch.maxFires)
          )
            return { recorded: false, watch };
          const fireCount = watch.fireCount + 1;
          const updated: Watch = {
            ...watch,
            fireCount,
            lastFiredAt: input.now,
            updatedAt: input.now,
            state: input.state ?? watch.state,
            status: watch.maxFires != null && fireCount >= watch.maxFires ? 'fired' : 'active',
          };
          const fireId = randomUUID();
          const fire = {
            id: fireId,
            watchId: watch.id,
            agentId: input.agentId,
            triggerRef: input.triggerRef,
            summary: input.summary,
            excerpt: input.excerpt.slice(0, 2048),
            createdAt: input.now,
          };
          tx.create(this.store.doc('watchFires', fireId), encodeRecord(fire));
          for (const effect of effectsForFire(updated, fire, input.now))
            tx.create(this.store.doc('watchFireEffects', effect.id), encodeRecord(effect));
          tx.set(watchRef, encodeRecord(updated));
          return { recorded: true, watch: updated, fireId };
        });
      } catch (error) {
        if (!isEmulatorClosedTransaction(error) || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }

  async pendingFireEffects(agentId: string, limit = 100): Promise<FireEffect[]> {
    const cap = Math.max(1, Math.min(500, limit));
    const [pending, failed] = await Promise.all([
      this.store
        .collection('watchFireEffects')
        .where('agentId', '==', agentId)
        .where('status', '==', 'pending')
        .orderBy('updatedAt')
        .limit(cap)
        .get(),
      this.store
        .collection('watchFireEffects')
        .where('agentId', '==', agentId)
        .where('status', '==', 'failed')
        .orderBy('updatedAt')
        .limit(cap)
        .get(),
    ]);
    return [...pending.docs, ...failed.docs]
      .map((doc) => decodeRecord<FireEffect>(doc.data()))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, cap);
  }

  async fireEffectsForFire(agentId: string, fireId: string): Promise<FireEffect[]> {
    const snapshots = await this.store
      .collection('watchFireEffects')
      .where('agentId', '==', agentId)
      .where('fireId', '==', fireId)
      .get();
    return snapshots.docs.map((doc) => decodeRecord<FireEffect>(doc.data()));
  }

  async claimFireEffect(input: Parameters<WatchRepository['claimFireEffect']>[0]) {
    const ref = this.store.doc('watchFireEffects', input.effectId);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const row = decodeRecord<FireEffect>(snapshot.data());
      if (
        row.agentId !== input.agentId ||
        documentKey(row.id) !== snapshot.id ||
        (row.status !== 'pending' && row.status !== 'failed')
      )
        return false;
      tx.update(ref, {
        status: 'sending',
        attempts: row.attempts + 1,
        claimedAt: input.now,
        leaseUntil: new Date(input.now.getTime() + Math.max(1000, input.leaseMs)),
        updatedAt: input.now,
      });
      return true;
    });
  }

  async finishFireEffect(input: Parameters<WatchRepository['finishFireEffect']>[0]) {
    const ref = this.store.doc('watchFireEffects', input.effectId);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const row = decodeRecord<FireEffect>(snapshot.data());
      if (
        row.agentId !== input.agentId ||
        documentKey(row.id) !== snapshot.id ||
        row.status !== 'sending'
      )
        return false;
      tx.update(
        ref,
        encodeRecord({
          status: input.status,
          result: input.result ?? null,
          claimedAt: null,
          leaseUntil: null,
          updatedAt: input.now,
        }),
      );
      return true;
    });
  }

  async recoverExpiredFireEffectClaims(agentId: string, now: Date): Promise<number> {
    const expired = await this.store
      .collection('watchFireEffects')
      .where('agentId', '==', agentId)
      .where('status', '==', 'sending')
      .where('leaseUntil', '<=', now)
      .limit(400)
      .get();
    let recovered = 0;
    for (const snapshot of expired.docs) {
      const ref = snapshot.ref;
      const didRecover = await this.store.db.runTransaction(async (tx) => {
        const current = await tx.get(ref);
        if (!current.exists) return false;
        const row = decodeRecord<FireEffect>(current.data());
        if (row.status !== 'sending' || !row.leaseUntil || row.leaseUntil > now) return false;
        tx.update(
          ref,
          encodeRecord({
            status: row.kind === 'owner_notification' ? 'unknown' : 'pending',
            result:
              row.kind === 'owner_notification'
                ? { reason: 'claim expired after notification may have started' }
                : null,
            claimedAt: null,
            leaseUntil: null,
            updatedAt: now,
          }),
        );
        return true;
      });
      if (didRecover) recovered += 1;
    }
    return recovered;
  }

  async getSuggestionContext(input: Parameters<WatchRepository['getSuggestionContext']>[0]) {
    const fires = await this.store
      .collection('watchFires')
      .where('agentId', '==', input.agentId)
      .where('watchId', '==', input.watchId)
      .where('triggerRef', '==', input.triggerRef)
      .limit(1)
      .get();
    const fireDoc = fires.docs[0];
    if (!fireDoc) return null;
    const fire = decodeRecord<Records['watchFires']>(fireDoc.data());
    if (documentKey(fire.id) !== fireDoc.id) return null;
    const watchDoc = await this.store.doc('watches', fire.watchId).get();
    if (!watchDoc.exists) return null;
    const watch = decodeRecord<Watch>(watchDoc.data());
    if (
      watch.agentId !== input.agentId ||
      documentKey(watch.id) !== watchDoc.id ||
      watch.id !== input.watchId
    )
      return null;
    return { watch, fire };
  }

  async getPreparedSuggestion(input: Parameters<WatchRepository['getPreparedSuggestion']>[0]) {
    const [fires, suggestions] = await Promise.all([
      this.store
        .collection('watchFires')
        .where('agentId', '==', input.agentId)
        .where('watchId', '==', input.watchId)
        .where('triggerRef', '==', input.triggerRef)
        .limit(1)
        .get(),
      this.store
        .collection('suggestions')
        .where('agentId', '==', input.agentId)
        .where('sourceRef', '==', `watch:${input.watchId}:${input.triggerRef}`)
        .limit(1)
        .get(),
    ]);
    const fireDoc = fires.docs[0];
    const suggestionDoc = suggestions.docs[0];
    if (!fireDoc || !suggestionDoc) return null;
    const fire = decodeRecord<Records['watchFires']>(fireDoc.data());
    const suggestion = decodeRecord<Records['suggestions']>(suggestionDoc.data());
    const watchDoc = await this.store.doc('watches', input.watchId).get();
    if (
      fire.agentId !== input.agentId ||
      fire.watchId !== input.watchId ||
      fire.triggerRef !== input.triggerRef ||
      suggestion.agentId !== input.agentId ||
      suggestion.sourceRef !== `watch:${input.watchId}:${input.triggerRef}`
    )
      return null;
    const watch = watchDoc.exists ? decodeRecord<Watch>(watchDoc.data()) : null;
    if (watch && (watch.agentId !== input.agentId || watch.tier !== 'suggest')) return null;
    const effectId = fireEffectDocumentId(fire.id, 'suggestion_message');
    const effectRef = this.store.doc('watchFireEffects', effectId);
    await this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const snapshot = await tx.get(effectRef);
      if (snapshot.exists) return;
      const now = this.store.now();
      const text = `One more thing from your "${watch?.name ?? 'watch'}" watch:`;
      const effect: FireEffect = {
        id: effectId,
        agentId: input.agentId,
        watchId: input.watchId,
        fireId: fire.id,
        kind: 'suggestion_message',
        status: suggestion.status === 'pending' ? 'pending' : 'skipped',
        idempotencyKey: `watch-fire:${input.watchId}:${input.triggerRef}:suggestion_message`,
        payload: {
          watchId: input.watchId,
          triggerRef: fire.triggerRef,
          conversationId: suggestion.conversationId,
          suggestionId: suggestion.id,
          summary: suggestion.summary,
          proposedAction: suggestion.proposedAction,
          text,
          channelMessageId: `watch-suggest:${fire.id}`,
        },
        attempts: 0,
        claimedAt: null,
        leaseUntil: null,
        result: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(effectRef, encodeRecord(effect));
    });
    const effectSnapshot = await effectRef.get();
    if (!effectSnapshot.exists) return null;
    return { suggestion, effect: decodeRecord<FireEffect>(effectSnapshot.data()) };
  }

  async commitSuggestion(input: Parameters<WatchRepository['commitSuggestion']>[0]) {
    const sourceRef = `watch:${input.watchId}:${input.triggerRef}`;
    // Imported records have random IDs. Locate them by query, while new records
    // use stable IDs so concurrent commits can converge through create/get.
    const [fires, suggestions, notifications] = await Promise.all([
      this.store
        .collection('watchFires')
        .where('agentId', '==', input.agentId)
        .where('watchId', '==', input.watchId)
        .where('triggerRef', '==', input.triggerRef)
        .limit(1)
        .get(),
      this.store
        .collection('suggestions')
        .where('agentId', '==', input.agentId)
        .where('sourceRef', '==', sourceRef)
        .limit(1)
        .get(),
      this.store
        .collection('conversations')
        .where('agentId', '==', input.agentId)
        .where('title', '==', 'Notifications')
        .limit(1)
        .get(),
    ]);
    const fireDoc = fires.docs[0];
    if (!fireDoc) return null;
    const legacySuggestion = suggestions.docs[0];
    const legacyNotifications = notifications.docs[0];
    const suggestionRef =
      legacySuggestion?.ref ??
      this.store.doc('suggestions', suggestionIdFor(input.agentId, sourceRef));
    const notificationsRef =
      legacyNotifications?.ref ??
      this.store.doc('conversations', notificationsConversationId(input.agentId));
    const fireSnapshot = await fireDoc.ref.get();
    if (!fireSnapshot.exists) return null;
    const fire = decodeRecord<Records['watchFires']>(fireSnapshot.data());
    if (
      documentKey(fire.id) !== fireSnapshot.id ||
      fire.agentId !== input.agentId ||
      fire.watchId !== input.watchId ||
      fire.triggerRef !== input.triggerRef
    )
      return null;
    const watchDoc = await this.store.doc('watches', fire.watchId).get();
    if (!watchDoc.exists) return null;
    const watch = decodeRecord<Watch>(watchDoc.data());
    if (
      watch.agentId !== input.agentId ||
      documentKey(watch.id) !== watchDoc.id ||
      watch.id !== input.watchId ||
      watch.tier !== 'suggest'
    )
      return null;

    let suggestionSnapshot = await suggestionRef.get();
    if (legacySuggestion && !suggestionSnapshot.exists) return null;
    let suggestion = suggestionSnapshot.exists
      ? decodeRecord<Records['suggestions']>(suggestionSnapshot.data())
      : null;
    if (
      suggestion &&
      (documentKey(suggestion.id) !== suggestionSnapshot.id ||
        suggestion.agentId !== input.agentId ||
        suggestion.sourceRef !== sourceRef)
    )
      return null;

    let conversationId: string | null = null;
    const candidateIds = [suggestion?.conversationId, watch.conversationId].filter(
      (id, index, all): id is string => Boolean(id) && all.indexOf(id) === index,
    );
    for (const candidateId of candidateIds) {
      const conversationDoc = await this.store.doc('conversations', candidateId).get();
      if (!conversationDoc.exists) continue;
      const conversation = decodeRecord<Records['conversations']>(conversationDoc.data());
      if (
        documentKey(conversation.id) === conversationDoc.id &&
        conversation.agentId === input.agentId
      ) {
        conversationId = conversation.id;
        break;
      }
    }
    const now = input.now ?? this.store.now();
    const ensureNotifications = async (): Promise<string | null> => {
      let notificationsSnapshot = await notificationsRef.get();
      if (legacyNotifications && !notificationsSnapshot.exists) return null;
      if (!notificationsSnapshot.exists) {
        const id = notificationsConversationId(input.agentId);
        try {
          await notificationsRef.create(
            conversationDocument({
              id,
              agentId: input.agentId,
              channel: 'chat',
              trust: 'assistant',
              title: 'Notifications',
              isPrimary: false,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              modelOverride: null,
              metadata: {},
              lastReadAt: null,
            }),
          );
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
        }
        notificationsSnapshot = await notificationsRef.get();
      }
      if (!notificationsSnapshot.exists) return null;
      const conversation = decodeRecord<Records['conversations']>(notificationsSnapshot.data());
      if (
        documentKey(conversation.id) !== notificationsSnapshot.id ||
        conversation.agentId !== input.agentId ||
        conversation.title !== 'Notifications'
      )
        return null;
      return conversation.id;
    };
    if (!conversationId) {
      conversationId = await ensureNotifications();
      if (!conversationId) return null;
    }

    if (!suggestion) {
      const id = suggestionIdFor(input.agentId, sourceRef);
      try {
        await suggestionRef.create(
          encodeRecord({
            id,
            agentId: input.agentId,
            conversationId,
            summary: input.summary.slice(0, 500),
            proposedAction: input.proposedAction.slice(0, 2000),
            origin: 'watch',
            sourceRef,
            status: 'pending',
            acceptedTaskId: null,
            snoozedUntil: null,
            expiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
            createdAt: now,
            updatedAt: now,
          }),
        );
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      suggestionSnapshot = await suggestionRef.get();
      if (!suggestionSnapshot.exists) return null;
      suggestion = decodeRecord<Records['suggestions']>(suggestionSnapshot.data());
      if (
        documentKey(suggestion.id) !== suggestionSnapshot.id ||
        suggestion.agentId !== input.agentId ||
        suggestion.sourceRef !== sourceRef
      )
        return null;
    }
    // A competing commit may have linked the suggestion after our first read.
    // Preserve any current owner-scoped destination and repair stale links with
    // a compare-and-swap so a later caller cannot overwrite that decision.
    for (let attempt = 0; attempt < 5; attempt++) {
      suggestionSnapshot = await suggestionRef.get();
      if (!suggestionSnapshot.exists) return null;
      suggestion = decodeRecord<Records['suggestions']>(suggestionSnapshot.data());
      if (
        documentKey(suggestion.id) !== suggestionSnapshot.id ||
        suggestion.agentId !== input.agentId ||
        suggestion.sourceRef !== sourceRef
      )
        return null;
      let selectedId: string | null = null;
      const currentCandidates = [suggestion.conversationId, watch.conversationId].filter(
        (id, index, all): id is string => Boolean(id) && all.indexOf(id) === index,
      );
      for (const candidateId of currentCandidates) {
        const candidate = await this.store.doc('conversations', candidateId).get();
        if (!candidate.exists) continue;
        const row = decodeRecord<Records['conversations']>(candidate.data());
        if (documentKey(row.id) === candidate.id && row.agentId === input.agentId) {
          selectedId = row.id;
          break;
        }
      }
      if (!selectedId) selectedId = await ensureNotifications();
      if (!selectedId) return null;
      const priorUpdateTime = suggestionSnapshot.updateTime;
      if (!priorUpdateTime) return null;
      if (suggestion.conversationId !== selectedId) {
        try {
          await suggestionRef.update(encodeRecord({ conversationId: selectedId, updatedAt: now }), {
            lastUpdateTime: priorUpdateTime,
          });
        } catch (error) {
          if (isPreconditionFailed(error)) continue;
          throw error;
        }
        continue;
      }
      const destination = await this.store.doc('conversations', selectedId).get();
      if (!destination.exists) continue;
      const row = decodeRecord<Records['conversations']>(destination.data());
      if (documentKey(row.id) !== destination.id || row.agentId !== input.agentId) continue;
      const latestSuggestion = await suggestionRef.get();
      if (!latestSuggestion.exists) return null;
      if (!latestSuggestion.updateTime?.isEqual(priorUpdateTime)) continue;
      await this.getPreparedSuggestion(input);
      return { suggestion, conversationId: selectedId, fireId: fire.id, watchName: watch.name };
    }
    throw new Error('Watch suggestion destination changed during concurrent commits');
  }
}
