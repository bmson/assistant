import { createHash, randomUUID } from 'node:crypto';
import type { Records, SmsChannelRepository } from '@assistant/persistence';
import { conversationDocument } from './conversation-document.js';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { claimFirestoreSmsUsage, settleFirestoreSmsUsage } from './sms-usage-reconciliation.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const HOUR_MS = 3_600_000;

/** A stable id per `(channel, externalId)`: the PostgreSQL unique key on bindings. */
function bindingIdFor(channel: string, externalId: string): string {
  return `channel-binding:${createHash('sha256')
    .update(JSON.stringify([channel, externalId]))
    .digest('hex')}`;
}

/**
 * The SMS channel's state on Firestore. New peer bindings use a stable id so
 * concurrent first messages from one number converge on one conversation;
 * imported bindings keep their random ids and are found by query.
 */
export class FirestoreSmsChannelRepository implements SmsChannelRepository {
  readonly kind = 'sms-channel-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  async underChannelLimit(now: Date): Promise<boolean> {
    const policy = await this.store.doc('rateLimits', 'channel:sms').get();
    if (!policy.exists) return true;
    const limit = decodeRecord<Partial<Records['rateLimits']>>(policy.data());
    const countSince = async (ms: number) =>
      (
        await this.store
          .collection('costEvents')
          .where('source', '==', 'twilio_sms')
          .where('createdAt', '>=', new Date(now.getTime() - ms))
          .count()
          .get()
      ).data().count;
    if (typeof limit.maxPerHour === 'number' && (await countSince(HOUR_MS)) >= limit.maxPerHour)
      return false;
    if (typeof limit.maxPerDay === 'number' && (await countSince(24 * HOUR_MS)) >= limit.maxPerDay)
      return false;
    return true;
  }

  async conversationForPeer(
    agentId: string,
    peer: string,
    trust: 'owner' | 'unknown',
  ): Promise<string> {
    if (agentId !== this.agentId) throw new Error('SMS peer is outside the configured owner');
    if (!peer) throw new Error('SMS peer is required');
    const bindingRef = this.store.doc('channelBindings', bindingIdFor('sms', peer));
    const imported = this.store
      .collection('channelBindings')
      .where('channel', '==', 'sms')
      .where('externalId', '==', peer)
      .limit(1);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const [byId, byPeer] = await Promise.all([tx.get(bindingRef), tx.get(imported)]);
      const existing = byId.exists ? byId : byPeer.docs[0];
      if (existing) {
        const conversationId = existing.get('conversationId');
        if (typeof conversationId !== 'string') throw new Error('SMS binding is malformed');
        const conversation = await tx.get(this.store.doc('conversations', conversationId));
        if (
          !conversation.exists ||
          conversation.get('id') !== conversationId ||
          conversation.get('agentId') !== agentId ||
          conversation.get('channel') !== 'sms'
        )
          throw new Error('SMS binding is missing or outside the owner scope');
        return conversationId;
      }
      const now = this.store.now();
      const conversation: Records['conversations'] = {
        id: randomUUID(),
        agentId,
        channel: 'sms',
        trust,
        title: `SMS ${peer}`,
        isPrimary: false,
        metadata: {},
        archivedAt: null,
        modelOverride: null,
        lastReadAt: null,
        messageSequence: 0,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(
        this.store.doc('conversations', conversation.id),
        conversationDocument(conversation),
      );
      const binding: Records['channelBindings'] = {
        id: bindingIdFor('sms', peer),
        createdAt: now,
        updatedAt: now,
        channel: 'sms',
        conversationId: conversation.id,
        externalId: peer,
      };
      tx.create(bindingRef, encodeRecord(binding));
      return conversation.id;
    });
  }

  async finalDestination(conversationId: string) {
    const [conversation, bindings] = await Promise.all([
      this.store.doc('conversations', conversationId).get(),
      this.store
        .collection('channelBindings')
        .where('conversationId', '==', conversationId)
        .where('channel', '==', 'sms')
        .limit(1)
        .get(),
    ]);
    if (!conversation.exists || conversation.get('agentId') !== this.agentId) return null;
    const row = decodeRecord<Records['conversations']>(conversation.data());
    if (documentKey(row.id) !== conversation.id) return null;
    const externalId = bindings.docs[0]?.get('externalId');
    return {
      channel: row.channel,
      trust: row.trust,
      externalId: typeof externalId === 'string' ? externalId : null,
    };
  }

  async pendingApprovalTool(shortCode: string): Promise<string | null> {
    const pending = await this.store
      .collection('approvals')
      .where('shortCode', '==', shortCode)
      .where('status', '==', 'pending')
      .limit(1)
      .get();
    const toolCallId = pending.docs[0]?.get('toolCallId');
    if (typeof toolCallId !== 'string') return null;
    const toolCall = await this.store.doc('toolCalls', toolCallId).get();
    const toolName = toolCall.exists ? toolCall.get('toolName') : null;
    return typeof toolName === 'string' ? toolName : null;
  }

  claimSmsUsageReconciliation(now: Date, limit: number) {
    return claimFirestoreSmsUsage(this.store, now, limit);
  }

  settleSmsUsageReconciliation(
    claim: Parameters<SmsChannelRepository['settleSmsUsageReconciliation']>[0],
    outcome: Parameters<SmsChannelRepository['settleSmsUsageReconciliation']>[1],
  ) {
    return settleFirestoreSmsUsage(this.store, claim, outcome);
  }
}
