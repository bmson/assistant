import type {
  CuriosityPushAdmission,
  CuriosityQuestionInput,
  CuriosityQuestionOutcome,
  GraphCuriosityRepository,
  GraphGapEntity,
  GraphGapRelation,
  Records,
  SuggestionRecord,
} from '@assistant/persistence';
import {
  curiosityDeliveryKey,
  curiosityMessageId,
  curiosityNudgeChannel,
  curiosityNudgePingId,
  insideQuietHours,
  notificationDeliveryKey,
  notificationOutboxLegId,
  ownerLocalMidnightUtc,
  ownerLocalMinutes,
  pushDeviceKey,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { decodeMemoryRecord } from './memory-record.js';
import { FirestoreOwnerNoticeRepository } from './owner-notices.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';
import { suggestionIdFor } from './suggestions.js';

type Entity = Records['knowledgeGraphEntities'];
type Relation = Records['knowledgeGraphRelations'];
type Assertion = Records['knowledgeGraphAssertions'];
type Memory = Records['memories'] & { supersededById?: string | null };
type Source = Records['knowledgeGraphSources'];

const PAGE = 400;
/** Owner graph rows read per run; the curiosity job runs once a day. */
const SCAN_LIMIT = 100_000;
const GETALL_CHUNK = 300;
const IN_LIMIT = 30;
const MAX_PUSH_DESTINATIONS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalMinutes(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) throw new Error('Notification preferences are malformed');
  return value as number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * The curiosity job's graph reads on Firestore. The joins PostgreSQL does in
 * SQL are done here over the owner's rows, with the same definition of an
 * active relation that graph recall uses, including superseded memories.
 */
export class FirestoreGraphCuriosityRepository implements GraphCuriosityRepository {
  readonly kind = 'graph-curiosity-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private fence(snapshot: FirebaseFirestore.DocumentSnapshot): string | null {
    if (!snapshot.exists) return null;
    if (
      snapshot.get('agentId') !== this.agentId ||
      privacyErasureIsActive(snapshot.get('status')) ||
      typeof snapshot.get('generation') !== 'string'
    )
      throw new Error('Privacy erasure is in progress or malformed');
    return snapshot.get('generation');
  }

  async observationFence(agentId: string): Promise<string | null> {
    this.owned(agentId);
    return this.fence(await this.store.doc('privacyErasureJobs', agentId).get());
  }

  async admitQuestion(input: CuriosityQuestionInput): Promise<CuriosityQuestionOutcome> {
    this.owned(input.agentId);
    const messageId = curiosityMessageId(input.agentId, input.key);
    const id = suggestionIdFor(input.agentId, input.key);
    const notices = new FirestoreOwnerNoticeRepository(this.store, input.agentId);
    return this.store.db.runTransaction(async (tx) => {
      const fence = await tx.get(this.store.doc('privacyErasureJobs', input.agentId));
      if (this.fence(fence) !== input.observationFence)
        throw new Error('Privacy erasure changed during curiosity observation');
      const owner = await tx.get(this.store.doc('agents', input.agentId));
      if (
        !owner.exists ||
        owner.get('id') !== input.agentId ||
        owner.id !== documentKey(input.agentId) ||
        typeof owner.get('name') !== 'string' ||
        typeof owner.get('timezone') !== 'string'
      )
        throw new Error('Curiosity owner profile is unavailable or malformed');
      const midnight = ownerLocalMidnightUtc(owner.get('timezone') as string, input.now);
      const coordinationRef = this.store.doc('coordination', `ambient-pings:${input.agentId}`);
      // Firestore retries this transaction if another producer commits its
      // owner/day reservation after this read. Read before checking the gap so
      // concurrent workers cannot both prepare a phone fan-out.
      await tx.get(coordinationRef);
      const marker = await tx.get(this.store.doc('suggestions', id));
      const imported = await tx.get(
        this.store
          .collection('suggestions')
          .where('agentId', '==', input.agentId)
          .where('sourceRef', '==', input.key)
          .limit(1),
      );
      const message = await tx.get(this.store.doc('messages', messageId));
      if (
        marker.exists &&
        (marker.get('agentId') !== input.agentId || marker.get('sourceRef') !== input.key)
      )
        throw new Error('Curiosity marker ownership mismatch');
      if (marker.exists || !imported.empty) {
        if (!message.exists) return { status: 'legacy-unknown' };
        const conversationId = message.get('conversationId');
        if (typeof conversationId !== 'string') throw new Error('Curiosity notice is malformed');
        const destination = await tx.get(this.store.doc('conversations', conversationId));
        if (!destination.exists || destination.get('agentId') !== input.agentId)
          throw new Error('Curiosity notice ownership mismatch');
        return { status: 'already-posted', conversationId, messageId };
      }
      const deviceSnapshot = await tx.get(
        this.store
          .collection('deviceTokens')
          .where('agentId', '==', input.agentId)
          .where('invalidatedAt', '==', null)
          .limit(MAX_PUSH_DESTINATIONS + 1),
      );
      const deviceOverflow = deviceSnapshot.size > MAX_PUSH_DESTINATIONS;
      const devices: Array<{ token: string; environment: 'sandbox' | 'production' }> = [];
      let malformedDevices = false;
      if (!deviceOverflow) {
        for (const doc of deviceSnapshot.docs) {
          const row = decodeRecord<{
            id?: unknown;
            agentId?: unknown;
            token?: unknown;
            environment?: unknown;
            invalidatedAt?: unknown;
          }>(doc.data());
          if (
            typeof row.id !== 'string' ||
            documentKey(row.id) !== doc.id ||
            row.agentId !== input.agentId ||
            typeof row.token !== 'string' ||
            !row.token ||
            (row.environment !== 'sandbox' && row.environment !== 'production') ||
            row.invalidatedAt !== null
          ) {
            malformedDevices = true;
            continue;
          }
          devices.push({
            token: row.token,
            environment: row.environment,
          });
        }
      }

      const noticeKey = curiosityDeliveryKey(input.key);
      const policyChannel = curiosityNudgeChannel(noticeKey);
      const policyId = curiosityNudgePingId(input.agentId, policyChannel);
      const policyRef = this.store.doc('proactivePings', policyId);
      const priorPolicy = await tx.get(policyRef);
      const prefsSnapshot = await tx.get(this.store.doc('notificationPrefs', input.agentId));
      const prefsRow = prefsSnapshot.exists
        ? decodeRecord<Records['notificationPrefs']>(prefsSnapshot.data())
        : null;
      if (prefsRow && prefsRow.agentId !== input.agentId)
        throw new Error('Notification preferences belong to another agent');
      const prefs = prefsRow
        ? {
            quietStartMin: optionalMinutes(prefsRow.quietStartMin),
            quietEndMin: optionalMinutes(prefsRow.quietEndMin),
            ambientDailyCap: optionalMinutes(prefsRow.ambientDailyCap),
          }
        : null;
      let used = 0;
      if (!priorPolicy.exists && prefs?.ambientDailyCap != null && prefs.ambientDailyCap > 0) {
        used = (
          await tx.get(
            this.store
              .collection('proactivePings')
              .where('agentId', '==', input.agentId)
              .where('urgency', '==', 'ambient')
              .where('delivered', '==', true)
              .where('createdAt', '>=', midnight)
              .limit(prefs.ambientDailyCap)
              .count(),
          )
        ).data().count;
      }
      let decision: { deliver: boolean; reason?: 'quiet-hours' | 'daily-cap' };
      if (priorPolicy.exists) {
        const prior = decodeRecord<Records['proactivePings']>(priorPolicy.data());
        if (prior.agentId !== input.agentId || prior.channel !== policyChannel)
          throw new Error('Curiosity nudge reservation ownership mismatch');
        decision = {
          deliver: prior.delivered,
          ...(!prior.delivered && (prior.reason === 'quiet-hours' || prior.reason === 'daily-cap')
            ? { reason: prior.reason }
            : {}),
        };
      } else if (
        prefs &&
        insideQuietHours(prefs, ownerLocalMinutes(owner.get('timezone') as string, input.now))
      ) {
        decision = { deliver: false, reason: 'quiet-hours' };
      } else if (prefs?.ambientDailyCap != null && used >= prefs.ambientDailyCap) {
        decision = { deliver: false, reason: 'daily-cap' };
      } else {
        decision = { deliver: true };
      }

      const destination = await notices.prepareNoticeInTransaction(tx, input.taskId);
      let pushAdmission: CuriosityPushAdmission;
      if (deviceOverflow) {
        pushAdmission = { status: 'unknown', reason: 'device-list-overflow' };
      } else if (malformedDevices) {
        pushAdmission = { status: 'unknown', reason: 'malformed-device-registry' };
      } else if (!decision.deliver) {
        pushAdmission = { status: 'held', reason: decision.reason ?? 'daily-cap' };
      } else if (devices.length === 0) {
        pushAdmission = { status: 'skipped', reason: 'no-active-devices' };
      } else {
        const outboxDeliveryKey = notificationDeliveryKey('outbox', input.agentId, noticeKey);
        const payload = {
          title: owner.get('name') as string,
          body: input.question.slice(0, 200),
          category: 'ASSISTANT_UPDATE',
          data: {
            route: 'chat',
            agentId: input.agentId,
            ...(UUID.test(destination.row.id) ? { conversationId: destination.row.id } : {}),
            ...(input.taskId && UUID.test(input.taskId) ? { taskId: input.taskId } : {}),
          },
        };
        const outboxRows = devices.map((device) => {
          const target = {
            deviceKey: pushDeviceKey(device.token),
            environment: device.environment,
          };
          const legKey = `push:${target.deviceKey}`;
          const row: Records['notificationOutbox'] = {
            id: notificationOutboxLegId(input.agentId, outboxDeliveryKey, legKey),
            agentId: input.agentId,
            deliveryKey: outboxDeliveryKey,
            legKey,
            adapter: 'push',
            status: 'pending',
            destination: target,
            payload,
            attempts: 0,
            retryable: false,
            availableAt: input.now,
            leaseToken: null,
            leaseUntil: null,
            providerMessageId: null,
            result: null,
            finishedAt: null,
            createdAt: input.now,
            updatedAt: input.now,
          };
          return { ref: this.store.doc('notificationOutbox', row.id), row };
        });
        const existingRows = await Promise.all(outboxRows.map(({ ref }) => tx.get(ref)));
        for (const [index, item] of outboxRows.entries()) {
          const existing = existingRows[index];
          if (existing?.exists) {
            const row = decodeRecord<Records['notificationOutbox']>(existing.data());
            if (
              row.agentId !== input.agentId ||
              row.id !== item.row.id ||
              row.adapter !== item.row.adapter ||
              (row.destination !== null &&
                canonical(row.destination) !== canonical(item.row.destination)) ||
              (row.payload !== null && canonical(row.payload) !== canonical(item.row.payload))
            )
              throw new Error('Curiosity push intent conflicts with a different frozen delivery');
          }
        }
        pushAdmission = { status: 'queued', destinations: outboxRows.length };
        for (const [index, item] of outboxRows.entries())
          if (!existingRows[index]?.exists) tx.create(item.ref, encodeRecord(item.row));
      }

      if (!priorPolicy.exists) {
        tx.set(coordinationRef, {
          agentId: input.agentId,
          dayStart: midnight,
          lastPingId: policyId,
          updatedAt: input.now,
        });
        tx.create(
          policyRef,
          encodeRecord({
            id: policyId,
            agentId: input.agentId,
            urgency: 'ambient',
            channel: policyChannel,
            delivered: decision.deliver,
            reason: decision.reason ?? null,
            createdAt: input.now,
          } satisfies Records['proactivePings']),
        );
      }
      const row: SuggestionRecord = {
        id,
        agentId: input.agentId,
        summary: input.question.slice(0, 500),
        proposedAction: 'Answered in conversation; nothing to run.',
        origin: 'curiosity',
        bookingKey: null,
        bookingVersion: null,
        bookingCancellation: null,
        sourceRef: input.key,
        status: 'dismissed',
        expiresAt: new Date(input.now.getTime() + 3650 * 86_400_000),
        conversationId: destination.row.id,
        acceptedTaskId: null,
        snoozedUntil: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      tx.create(this.store.doc('suggestions', id), encodeRecord(row));
      notices.appendNoticeInTransaction(tx, destination, {
        id: messageId,
        text: input.question,
        taskId: input.taskId,
        extraParts: [],
        now: input.now,
      });
      return {
        status: 'posted',
        conversationId: destination.row.id,
        messageId,
        pushAdmission,
      };
    });
  }

  private owned(agentId: string): void {
    if (agentId !== this.agentId) throw new Error('Curiosity is outside the configured owner');
  }

  private async byAgent<T extends { id: string; agentId: string }>(
    collection: string,
    fields?: string[],
    decode: (value: unknown) => T = (value) => decodeRecord<T>(value),
  ): Promise<T[]> {
    const rows: T[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store.collection(collection).where('agentId', '==', this.agentId);
      if (fields) query = query.select(...fields);
      query = query.limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = decode(doc.data());
        if (
          row.agentId === this.agentId &&
          typeof row.id === 'string' &&
          documentKey(row.id) === doc.id
        )
          rows.push(row);
      }
      if (rows.length > SCAN_LIMIT)
        throw new Error(`Curiosity ${collection} scan exceeds its limit`);
      cursor = page.docs.at(-1);
      if (page.size < PAGE) return rows;
    }
  }

  private async sources(memoryIds: string[]): Promise<Map<string, Source>> {
    const result = new Map<string, Source>();
    for (let index = 0; index < memoryIds.length; index += GETALL_CHUNK) {
      const batch = memoryIds.slice(index, index + GETALL_CHUNK);
      if (batch.length === 0) continue;
      const docs = await this.store.db.getAll(
        ...batch.map((id) => this.store.doc('knowledgeGraphSources', id)),
      );
      batch.forEach((id, position) => {
        const doc = docs[position];
        if (!doc?.exists) return;
        const row = decodeRecord<Source>(doc.data());
        // Imported source checkpoints can lack agentId; the memory id is the join.
        if (row.memoryId === id) result.set(id, row);
      });
    }
    return result;
  }

  async gapInputs(
    agentId: string,
    input: { now: Date; minRelations: number; maxCandidates: number; extractionVersion: number },
  ): Promise<{ connected: GraphGapEntity[]; held: GraphGapRelation[] }> {
    this.owned(agentId);
    const [entities, relations, memories, assertions] = await Promise.all([
      this.byAgent<Entity>('knowledgeGraphEntities'),
      this.byAgent<Relation>('knowledgeGraphRelations'),
      this.byAgent<Memory>(
        'memories',
        [
          'id',
          'agentId',
          'category',
          'quarantined',
          'supersededById',
          'expiresAt',
          'embedding',
          'embeddingSpaceKey',
          'embeddingSpace',
          'contentHash',
        ],
        decodeMemoryRecord,
      ),
      this.byAgent<Assertion>('knowledgeGraphAssertions'),
    ]);
    const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
    const assertionById = new Map(assertions.map((assertion) => [assertion.id, assertion]));
    const sources = await this.sources(
      [...new Set(relations.map((relation) => relation.sourceMemoryId))].filter((id) =>
        memoryById.has(id),
      ),
    );
    const active = relations.filter((relation) => {
      const memory = memoryById.get(relation.sourceMemoryId);
      const source = sources.get(relation.sourceMemoryId);
      return (
        !!memory &&
        !!source &&
        memory.category === 'knowledge' &&
        memory.quarantined === false &&
        !memory.supersededById &&
        (memory.expiresAt === null ||
          memory.expiresAt === undefined ||
          (memory.expiresAt instanceof Date && memory.expiresAt > input.now)) &&
        memory.embedding !== null &&
        memory.embedding !== undefined &&
        source.status === 'ready' &&
        source.contentHash === memory.contentHash &&
        source.extractionVersion >= input.extractionVersion &&
        relation.reviewStatus !== 'rejected' &&
        (relation.assertionId == null ||
          (assertionById.get(relation.assertionId)?.agentId === this.agentId &&
            assertionById.get(relation.assertionId)?.lifecycle === 'current' &&
            assertionById.get(relation.assertionId)?.reviewStatus !== 'rejected')) &&
        relation.evidenceQuote !== null &&
        relation.evidenceQuote !== undefined
      );
    });

    const entityById = new Map(entities.map((entity) => [entity.id, entity]));
    const label = (entity: Entity) => entity.preferredLabel || entity.label;
    const degree = new Map<string, number>();
    for (const relation of active)
      degree.set(relation.subjectEntityId, (degree.get(relation.subjectEntityId) ?? 0) + 1);
    const connected = [...degree.entries()]
      .filter(([, count]) => count >= input.minRelations)
      .flatMap(([id, count]) => {
        const entity = entityById.get(id);
        return entity
          ? [
              {
                id,
                label: label(entity),
                kind: entity.kind,
                contactId: entity.contactId ?? null,
                degree: count,
                sortLabel: entity.label,
              },
            ]
          : [];
      })
      // PostgreSQL orders by the extracted label, in byte order.
      .sort((a, b) =>
        a.sortLabel < b.sortLabel ? -1 : a.sortLabel > b.sortLabel ? 1 : a.id < b.id ? -1 : 1,
      )
      .slice(0, input.maxCandidates)
      .map(({ sortLabel: _sortLabel, ...entity }) => entity);

    const candidates = new Set(connected.map((entity) => entity.id));
    const held = active.flatMap((relation) => {
      const object = entityById.get(relation.objectEntityId);
      if (!candidates.has(relation.subjectEntityId) || !object) return [];
      return [
        {
          id: relation.id,
          subjectEntityId: relation.subjectEntityId,
          predicate: relation.predicate,
          reviewStatus: relation.reviewStatus,
          confidence: String(relation.confidence),
          validUntil: relation.validUntil ?? null,
          objectLabel: label(object),
        },
      ];
    });
    return { connected, held };
  }

  async askedKeys(agentId: string, keys: string[]): Promise<string[]> {
    this.owned(agentId);
    const asked: string[] = [];
    for (let index = 0; index < keys.length; index += IN_LIMIT) {
      const snapshot = await this.store
        .collection('suggestions')
        .where('agentId', '==', agentId)
        .where('sourceRef', 'in', keys.slice(index, index + IN_LIMIT))
        .select('sourceRef')
        .get();
      for (const doc of snapshot.docs) asked.push(String(doc.get('sourceRef')));
    }
    return asked;
  }
}
