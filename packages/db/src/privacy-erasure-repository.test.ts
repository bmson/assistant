import { randomUUID } from 'node:crypto';
import {
  emailAttachmentCustodyCleanupIntentId,
  notificationDashboardMessageId,
} from '@assistant/persistence';
import { asc, eq, like, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { createDb } from './client.js';
import { createPostgresEmailAttachmentCustodyRepository } from './email-attachment-custody-repository.js';
import {
  assertPostgresPrivacyObservationFence,
  createPostgresPrivacyErasureRepository,
  lockPostgresPrivacyObservationFence,
  postgresPrivacyObservationFence,
  withPostgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import {
  agents,
  contacts,
  conversations,
  documentChunks,
  documents,
  emailAttachmentCustodies,
  emailIngest,
  emailObserverSources,
  emailObserverWork,
  files,
  importSources,
  knowledgeGraphAssertionEvidence,
  knowledgeGraphAssertions,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  maintenanceCursors,
  memories,
  memoryEmbeddingRefreshes,
  memoryTombstones,
  messages,
  missionReports,
  notificationOutbox,
  occasions,
  ownerCard,
  recallSurfaces,
  securityIncidentAttention,
  securityIncidentSources,
  securityIncidents,
  situationPacks,
  situationPreviews,
  tasks,
  toolCallReceiptKeys,
  toolCallReceipts,
  voiceProfile,
  watches,
  watchFireEffects,
  watchFires,
  writingSamples,
} from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe('PostgreSQL privacy erasure repository', () => {
  it('matches all erasure domains and keeps assets recoverable until acknowledged', async () => {
    if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    const db = createDb(DATABASE_URL);
    try {
      await expect(
        db.transaction(async (tx) => {
          const owners = await tx.select({ id: agents.id }).from(agents).limit(2);
          if (owners.length !== 1 || !owners[0]) throw new Error('Test requires one owner');
          const agentId = owners[0].id;
          const memoryId = randomUUID();
          const hash = `privacy-${randomUUID()}`;
          const left = randomUUID();
          const right = randomUUID();
          const relationId = randomUUID();
          const assertionId = randomUUID();
          const assertionEvidenceId = randomUUID();
          const packId = randomUUID();
          const previewId = randomUUID();
          const taskId = randomUUID();
          const toolReceiptId = randomUUID();
          const toolCallId = randomUUID();
          const sourceId = randomUUID();
          const preparedConversationId = randomUUID();
          const sampleId = randomUUID();
          const contactId = randomUUID();
          const incidentId = randomUUID();
          const incidentSourceId = randomUUID();
          const incidentAttentionId = randomUUID();
          const securityChannelMessageId = `privacy-security:${randomUUID()}`;
          const watchId = randomUUID();
          const watchFireId = randomUUID();
          const refreshTarget = randomUUID().replaceAll('-', '').repeat(2);
          const refreshId = `refresh-${randomUUID()}`;
          await tx.insert(memories).values({
            id: memoryId,
            agentId,
            category: 'knowledge',
            kind: 'fact',
            content: 'private',
            contentHash: hash,
            embedding: Array.from({ length: 1536 }, () => 0.125),
            embeddingSpaceKey: 'a'.repeat(64),
          });
          await tx.insert(memoryEmbeddingRefreshes).values({
            id: refreshId,
            agentId,
            memoryId,
            sourceHash: hash,
            targetSpaceKey: refreshTarget,
            targetDimensions: 1536,
            observedSpaceKey: 'a'.repeat(64),
            status: 'prepared',
            preparedVector: Array.from({ length: 1536 }, () => 0.25),
            privacyGeneration: 'private-refresh-generation',
          });
          await tx.insert(maintenanceCursors).values({
            name: `memory-embedding-refresh:${agentId}:${refreshTarget}`,
            cursor: memoryId,
          });
          await tx.insert(knowledgeGraphEntities).values([
            { id: left, agentId, canonicalKey: `left:${left}`, label: 'Left', kind: 'topic' },
            { id: right, agentId, canonicalKey: `right:${right}`, label: 'Right', kind: 'topic' },
          ]);
          await tx.insert(knowledgeGraphRelations).values({
            id: relationId,
            agentId,
            subjectEntityId: left,
            objectEntityId: right,
            sourceMemoryId: memoryId,
            predicate: 'relates_to',
            sourceFingerprint: hash,
            ordinal: 0,
          });
          await tx.insert(knowledgeGraphAssertions).values({
            id: assertionId,
            agentId,
            semanticKey: `privacy:${assertionId}`,
            subjectEntityId: left,
            predicate: 'knows',
            objectEntityId: right,
            assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
            qualifiers: {},
          });
          await tx.insert(knowledgeGraphAssertionEvidence).values({
            id: assertionEvidenceId,
            agentId,
            assertionId,
            sourceMemoryId: memoryId,
            sourceFingerprint: `privacy:${assertionEvidenceId}`,
            sourceContentHash: hash,
            evidenceQuote: 'private graph evidence',
            extractionVersion: 1,
            observedAt: new Date(),
          });
          await tx.insert(situationPacks).values({
            id: packId,
            agentId,
            creationKey: `privacy-${packId}`,
            title: 'Plan',
            data: { title: 'Plan', decisions: [{ reason: 'private' }] },
          });
          await tx.insert(situationPreviews).values({
            id: previewId,
            packId,
            baseVersion: 1,
            sourceHash: hash,
            data: { reason: 'private' },
            expiresAt: new Date('2027-01-01'),
          });
          await tx
            .insert(tasks)
            .values({ id: taskId, agentId, type: 'scheduled', status: 'running' });
          await tx.insert(toolCallReceipts).values({
            id: toolReceiptId,
            agentId,
            taskId,
            toolCallId,
            modelToolCallIdHash: 'a'.repeat(64),
            idempotencyKeyHash: 'b'.repeat(64),
            toolName: 'calendar.create_event',
            effectOutcome: 'completed',
            recordedAt: new Date(),
          });
          await tx.insert(toolCallReceiptKeys).values([
            {
              id: 'c'.repeat(64),
              agentId,
              taskId,
              receiptId: toolReceiptId,
              kind: 'model_tool_call',
              digest: 'a'.repeat(64),
            },
            {
              id: 'd'.repeat(64),
              agentId,
              taskId,
              receiptId: toolReceiptId,
              kind: 'idempotency',
              digest: 'b'.repeat(64),
            },
          ]);
          await tx.insert(importSources).values({
            id: sourceId,
            agentId,
            taskId,
            source: `voice-samples-${sourceId}`,
            workspacePath: 'import/voice.txt',
            kind: 'text',
          });
          await tx.insert(maintenanceCursors).values({
            name: `import-snapshot-asset:${sourceId}:manifest`,
            cursor: '.assistant/imports/private/task/manifest.json',
          });
          await tx.insert(maintenanceCursors).values({
            name: `prepared-memory-extraction:${agentId}:${preparedConversationId}`,
            cursor: '{"sourceHash":"private","payload":"private"}',
          });
          const purgeHash = 'e'.repeat(64);
          await tx.insert(maintenanceCursors).values([
            {
              name: `import-source-purge-job:${agentId}:${purgeHash}`,
              cursor: '{"phase":"discover"}',
            },
            { name: `import-source-purge-node:${agentId}:${purgeHash}:node`, cursor: 'queued' },
            {
              name: `import-source-purge-result:${agentId}:${purgeHash}`,
              cursor: '{"purgedMemories":4}',
            },
          ]);
          await tx
            .insert(writingSamples)
            .values({ id: sampleId, register: 'chat', text: 'private' });
          const fireEffectId = randomUUID();
          await tx.insert(watchFireEffects).values({
            id: fireEffectId,
            agentId,
            watchId,
            fireId: watchFireId,
            kind: 'owner_notification',
            status: 'pending',
            idempotencyKey: `privacy-${fireEffectId}`,
            payload: { text: 'private notice' },
          });
          await tx.insert(watches).values({
            id: watchId,
            agentId,
            kind: 'email',
            tier: 'notify',
            name: 'privacy fixture',
            match: {},
            expiresAt: new Date('2027-01-01T00:00:00Z'),
          });
          await tx.insert(watchFires).values({
            id: watchFireId,
            agentId,
            watchId,
            triggerRef: `privacy:${watchFireId}`,
            summary: 'private notice',
            excerpt: 'private email excerpt',
          });
          await tx
            .insert(contacts)
            .values({ id: contactId, name: 'Private person', trust: 'owner' });
          await tx.insert(securityIncidents).values({
            id: incidentId,
            agentId,
            incidentKey: `privacy:${incidentId}`,
            confidence: 'provider-reference',
            revision: 1,
          });
          await tx.insert(securityIncidentSources).values({
            id: incidentSourceId,
            agentId,
            incidentId,
            channelMessageId: securityChannelMessageId,
            sourceMessageId: '<security@example.test>',
            mailboxHash: 'hashed-mailbox',
            evidenceFingerprint: 'evidence-fingerprint',
            observedAt: new Date(),
          });
          await tx.insert(securityIncidentAttention).values({
            id: incidentAttentionId,
            agentId,
            incidentId,
            revision: 1,
            producer: 'arrival',
            deliveryStatus: 'accepted',
          });
          await tx.insert(emailIngest).values({
            agentId,
            channelMessageId: securityChannelMessageId,
            fromEmail: 'security@example.test',
            category: 'security',
            importance: 3,
            securityEvidence: {
              providerIncidentRef: 'incident-1',
              evidenceQuote: 'New sign-in detected',
            },
            securityIncidentId: incidentId,
            directRouting: 'needs_attention',
            directRecoveryReason: 'provider_message_missing',
            emailContentProvenance: {
              version: 1,
              mode: 'direct',
              authenticated: true,
              sourceLength: 0,
              storedLength: 0,
              sourceHash: 'a'.repeat(64),
              bodyHash: 'b'.repeat(64),
              messageHash: 'c'.repeat(64),
              prefixLength: 0,
              hasExternalOrUnknown: false,
              spans: [],
              parts: [],
            },
          });
          await tx.insert(occasions).values({
            agentId,
            contactId,
            kind: 'birthday',
            month: 3,
            day: 12,
            notes: 'private occasion',
          });
          const reportId = `privacy-report-${randomUUID()}`;
          await tx.insert(missionReports).values({
            id: reportId,
            agentId,
            missionId: taskId,
            outcome: 'completed',
            text: 'Private report details',
            chatStatus: 'delivered',
            ownerStatus: 'unknown',
            mirrorStatus: 'pending',
          });
          const outboxIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
          const sourceKey = randomUUID().replaceAll('-', '').repeat(2);
          const sourceRevision = randomUUID().replaceAll('-', '').repeat(2);
          const recallSurfaceId = randomUUID();
          await tx.insert(recallSurfaces).values({
            id: recallSurfaceId,
            agentId,
            sourceKey,
            sourceRevision,
            kind: 'chat',
            surfaceCount: 1,
          });
          await tx.insert(notificationOutbox).values(
            (['pending', 'failed', 'sending', 'delivered'] as const).map((status, index) => ({
              id: outboxIds[index],
              agentId,
              deliveryKey: `privacy-outbox-${index}-${randomUUID()}`,
              legKey: 'dashboard',
              adapter: 'dashboard',
              status,
              destination: { conversationId: 'private-conversation' },
              payload: { text: 'Private notice text' },
              retryable: status === 'failed',
              leaseToken: status === 'sending' ? randomUUID() : null,
              leaseUntil: status === 'sending' ? new Date(Date.now() + 60_000) : null,
              providerMessageId: status === 'delivered' ? 'provider-receipt-1' : null,
              result: { detail: 'private provider body' },
            })),
          );
          const noticeWorkId = randomUUID();
          const noticeDeliveryKey = `email-card:${randomUUID()}`;
          const noticeLegKey = 'dashboard';
          const noticeChannelMessageId = notificationDashboardMessageId(
            agentId,
            noticeDeliveryKey,
            noticeLegKey,
          );
          const noticeConversationId = randomUUID();
          const noticeMessageId = randomUUID();
          const externalLegId = randomUUID();
          await tx.insert(conversations).values({
            id: noticeConversationId,
            agentId,
            channel: 'chat',
            title: 'Notice erasure fixture',
          });
          await tx.insert(messages).values({
            id: noticeMessageId,
            conversationId: noticeConversationId,
            role: 'assistant',
            parts: [{ type: 'text', text: 'Private email-card notice' }],
            text: 'Private email-card notice',
            origin: 'assistant',
            channelMessageId: noticeChannelMessageId,
          });
          await tx.insert(emailObserverWork).values({
            id: noticeWorkId,
            agentId,
            sourceKey: `gmail:${randomUUID()}`,
            channelMessageId: `gmail:${randomUUID()}`,
            sourceKind: 'message',
            observerKey: 'google.email-card',
            observerVersion: 1,
            workClass: 'idempotent_db',
            status: 'complete',
            attemptCount: 1,
            claimGeneration: 1,
            privacyGeneration: null,
            budgetReserved: false,
          });
          await tx.insert(notificationOutbox).values([
            {
              id: randomUUID(),
              agentId,
              deliveryKey: noticeDeliveryKey,
              legKey: noticeLegKey,
              adapter: 'dashboard',
              status: 'delivered',
              destination: { conversationId: noticeConversationId },
              payload: { text: 'Private email-card notice' },
              producerWorkId: noticeWorkId,
              producerPrivacyGeneration: null,
            },
            {
              id: externalLegId,
              agentId,
              deliveryKey: noticeDeliveryKey,
              legKey: 'email',
              adapter: 'email',
              status: 'sending',
              destination: { address: 'private@example.test' },
              payload: { text: 'Private external notice' },
              providerMessageId: 'provider-receipt-while-sending',
              producerWorkId: noticeWorkId,
              producerPrivacyGeneration: null,
            },
          ]);
          // Other integration suites can legitimately leave records for this sole
          // owner. Measure all rows being erased instead of assuming an empty DB.
          const expectedCounts = {
            memories: (await tx.select().from(memories).where(eq(memories.agentId, agentId)))
              .length,
            graphRelations: (
              await tx
                .select()
                .from(knowledgeGraphRelations)
                .where(eq(knowledgeGraphRelations.agentId, agentId))
            ).length,
            writingSamples: (await tx.select().from(writingSamples)).length,
            securityIncidents: (
              await tx
                .select()
                .from(securityIncidents)
                .where(eq(securityIncidents.agentId, agentId))
            ).length,
          };
          const repository = createPostgresPrivacyErasureRepository(tx as unknown as Db);
          const beforeErasure = await postgresPrivacyObservationFence(tx as unknown as Db, agentId);
          await expect(repository.erase()).resolves.toEqual(expectedCounts);
          expect(
            await tx
              .select()
              .from(memoryEmbeddingRefreshes)
              .where(eq(memoryEmbeddingRefreshes.id, refreshId)),
          ).toHaveLength(0);
          expect(
            await tx
              .select()
              .from(maintenanceCursors)
              .where(
                eq(maintenanceCursors.name, `memory-embedding-refresh:${agentId}:${refreshTarget}`),
              ),
          ).toHaveLength(0);
          expect(
            (await tx.select().from(missionReports).where(eq(missionReports.id, reportId)))[0],
          ).toMatchObject({
            text: '',
            chatStatus: 'delivered',
            ownerStatus: 'unknown',
            mirrorStatus: 'skipped',
          });
          const erasedOutbox = await tx
            .select()
            .from(notificationOutbox)
            .where(eq(notificationOutbox.agentId, agentId));
          for (const row of erasedOutbox) {
            expect(row.destination).toBeNull();
            expect(row.payload).toBeNull();
            expect(row.result).toBeNull();
            expect(row.retryable).toBe(false);
            expect(row.leaseToken).toBeNull();
            expect(row.leaseUntil).toBeNull();
          }
          expect(erasedOutbox.find((row) => row.id === outboxIds[0])?.status).toBe('skipped');
          expect(erasedOutbox.find((row) => row.id === outboxIds[1])?.status).toBe('skipped');
          expect(erasedOutbox.find((row) => row.id === outboxIds[2])?.status).toBe('unknown');
          expect(erasedOutbox.find((row) => row.id === outboxIds[3])).toMatchObject({
            status: 'delivered',
            providerMessageId: 'provider-receipt-1',
          });
          expect(
            await tx.select().from(messages).where(eq(messages.id, noticeMessageId)),
          ).toHaveLength(0);
          expect(
            erasedOutbox.find(
              (row) => row.deliveryKey === noticeDeliveryKey && row.legKey === 'dashboard',
            ),
          ).toMatchObject({ status: 'delivered', payload: null, destination: null });
          expect(erasedOutbox.find((row) => row.id === externalLegId)).toMatchObject({
            status: 'unknown',
            retryable: false,
            payload: null,
            destination: null,
            providerMessageId: 'provider-receipt-while-sending',
          });
          const erasedEmail = await tx
            .select({
              securityEvidence: emailIngest.securityEvidence,
              securityIncidentId: emailIngest.securityIncidentId,
              directRouting: emailIngest.directRouting,
              directRecoveryReason: emailIngest.directRecoveryReason,
              emailContentProvenance: emailIngest.emailContentProvenance,
            })
            .from(emailIngest)
            .where(eq(emailIngest.channelMessageId, securityChannelMessageId));
          expect(erasedEmail[0]).toEqual({
            securityEvidence: null,
            securityIncidentId: null,
            directRouting: null,
            directRecoveryReason: null,
            emailContentProvenance: null,
          });
          expect(
            await tx.select().from(securityIncidents).where(eq(securityIncidents.agentId, agentId)),
          ).toHaveLength(0);
          expect(
            await tx
              .select()
              .from(securityIncidentSources)
              .where(eq(securityIncidentSources.agentId, agentId)),
          ).toHaveLength(0);
          expect(
            await tx
              .select()
              .from(securityIncidentAttention)
              .where(eq(securityIncidentAttention.agentId, agentId)),
          ).toHaveLength(0);
          expect(
            await tx.select().from(recallSurfaces).where(eq(recallSurfaces.id, recallSurfaceId)),
          ).toHaveLength(0);
          const pendingAssets = await repository.pendingAssets();
          expect(pendingAssets).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: 'workspace_path',
                id: sourceId,
                workspacePath: 'import/voice.txt',
              }),
              expect.objectContaining({
                workspacePath: '.assistant/imports/private/task/manifest.json',
              }),
            ]),
          );
          await expect(repository.erase()).resolves.toEqual(expectedCounts);
          expect(
            (await tx.select().from(missionReports).where(eq(missionReports.id, reportId)))[0],
          ).toMatchObject({
            text: '',
            chatStatus: 'delivered',
            ownerStatus: 'unknown',
            mirrorStatus: 'skipped',
          });
          expect(
            (await tx.select().from(memoryTombstones).where(eq(memoryTombstones.contentHash, hash)))
              .length,
          ).toBe(1);
          expect((await tx.select().from(memories).where(eq(memories.id, memoryId))).length).toBe(
            0,
          );
          expect(
            (
              await tx
                .select()
                .from(knowledgeGraphAssertions)
                .where(eq(knowledgeGraphAssertions.agentId, agentId))
            ).length,
          ).toBe(0);
          expect(
            (
              await tx
                .select()
                .from(knowledgeGraphAssertionEvidence)
                .where(eq(knowledgeGraphAssertionEvidence.agentId, agentId))
            ).length,
          ).toBe(0);
          expect(
            (await tx.select().from(watchFireEffects).where(eq(watchFireEffects.agentId, agentId)))
              .length,
          ).toBe(0);
          expect(
            (await tx.select().from(watchFires).where(eq(watchFires.agentId, agentId))).length,
          ).toBe(0);
          expect(
            (
              await tx
                .select()
                .from(knowledgeGraphRelations)
                .where(eq(knowledgeGraphRelations.id, relationId))
            ).length,
          ).toBe(0);
          expect(
            (await tx.select().from(situationPreviews).where(eq(situationPreviews.id, previewId)))
              .length,
          ).toBe(0);
          expect(
            (await tx.select().from(situationPacks).where(eq(situationPacks.id, packId)))[0],
          ).toMatchObject({
            version: 2,
            data: { title: 'Plan', decisions: [] },
          });
          expect((await tx.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
            'cancelled',
          );
          expect(
            await tx.select().from(toolCallReceipts).where(eq(toolCallReceipts.agentId, agentId)),
          ).toHaveLength(0);
          expect(
            await tx
              .select()
              .from(toolCallReceiptKeys)
              .where(eq(toolCallReceiptKeys.agentId, agentId)),
          ).toHaveLength(0);
          expect((await tx.select().from(ownerCard))[0]?.content).toBe('');
          expect(
            (await tx.select().from(occasions).where(eq(occasions.contactId, contactId))).length,
          ).toBe(0);
          expect((await tx.select().from(voiceProfile))[0]?.description).toBe('');
          await expect(repository.complete()).rejects.toThrow('assets remain');
          for (const asset of pendingAssets) await repository.assetDeleted(asset.id);
          await repository.complete();
          const afterErasure = await postgresPrivacyObservationFence(tx as unknown as Db, agentId);
          expect(afterErasure).toEqual(expect.any(String));
          expect(afterErasure).not.toBe(beforeErasure);
          expect(
            (
              await tx
                .select()
                .from(maintenanceCursors)
                .where(eq(maintenanceCursors.name, `privacy-erasure-asset:${agentId}:${sourceId}`))
            ).length,
          ).toBe(0);
          expect(
            (
              await tx
                .select()
                .from(maintenanceCursors)
                .where(
                  eq(
                    maintenanceCursors.name,
                    `prepared-memory-extraction:${agentId}:${preparedConversationId}`,
                  ),
                )
            ).length,
          ).toBe(0);
          for (const prefix of [
            'import-source-purge-job',
            'import-source-purge-node',
            'import-source-purge-result',
          ]) {
            expect(
              await tx
                .select()
                .from(maintenanceCursors)
                .where(like(maintenanceCursors.name, `${prefix}:${agentId}:%`)),
            ).toHaveLength(0);
          }
          throw new Error('rollback privacy erasure fixture');
        }),
      ).rejects.toThrow('rollback privacy erasure fixture');
    } finally {
      await db.$client.end();
    }
  });

  it('rejects a writer that resumes with a generation observed before erasure', async () => {
    if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    const db = createDb(DATABASE_URL);
    try {
      await expect(
        db.transaction(async (tx) => {
          const [owner] = await tx.select({ id: agents.id }).from(agents).limit(1);
          if (!owner) throw new Error('Test requires one owner');
          const txDb = tx as unknown as Db;
          const observed = await lockPostgresPrivacyObservationFence(txDb, owner.id);
          await tx
            .insert(maintenanceCursors)
            .values({ name: `privacy-erasure-generation:${owner.id}`, cursor: randomUUID() })
            .onConflictDoUpdate({
              target: maintenanceCursors.name,
              set: { cursor: randomUUID(), updatedAt: new Date() },
            });
          await lockPostgresPrivacyObservationFence(txDb, owner.id);
          await assertPostgresPrivacyObservationFence(txDb, owner.id, observed);
          throw new Error('rollback stale generation fixture');
        }),
      ).rejects.toThrow('Privacy erasure changed during observation');
    } finally {
      await db.$client.end();
    }
  });

  it('serializes a composed owner read before a concurrent erasure transaction', async () => {
    if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    const db = createDb(DATABASE_URL);
    let entered!: () => void;
    let release!: () => void;
    const readEntered = new Promise<void>((resolve) => (entered = resolve));
    const continueRead = new Promise<void>((resolve) => (release = resolve));
    try {
      const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
      if (!owner) throw new Error('Test requires one owner');
      const read = withPostgresPrivacyObservationFence(db, owner.id, async () => {
        entered();
        await continueRead;
        return 'read-complete';
      });
      await readEntered;

      let acquired!: () => void;
      const erasureLockAcquired = new Promise<void>((resolve) => (acquired = resolve));
      const erasure = db.transaction(async (tx) => {
        await tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, owner.id))
          .for('update');
        acquired();
      });
      const earlyAcquire = await Promise.race([
        erasureLockAcquired.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 40)),
      ]);
      expect(earlyAcquire).toBe(false);
      release();
      await expect(read).resolves.toBe('read-complete');
      await erasure;
      expect(await erasureLockAcquired.then(() => true)).toBe(true);
    } finally {
      await db.$client.end();
    }
  });

  it('refuses installation-wide erasure with a second configured owner', async () => {
    if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    const db = createDb(DATABASE_URL);
    try {
      await expect(
        db.transaction(async (tx) => {
          const id = randomUUID();
          await tx.insert(agents).values({
            id,
            name: 'Second owner',
            email: `second-${id}@example.test`,
            workspacePrefix: id,
          });
          await expect(
            createPostgresPrivacyErasureRepository(tx as unknown as Db).erase(),
          ).rejects.toThrow('exactly one configured owner');
          throw new Error('rollback second owner fixture');
        }),
      ).rejects.toThrow('rollback second owner fixture');
    } finally {
      await db.$client.end();
    }
  });

  it('erases attachment catalog data in the owner transaction and reconciles exact-generation cleanup', async () => {
    if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    const db = createDb(DATABASE_URL);
    try {
      try {
        await db.transaction(async (tx) => {
          const [owner] = await tx.select({ id: agents.id }).from(agents).limit(1);
          if (!owner) throw new Error('Test requires one owner');
          const agentId = owner.id;
          const custodyId = randomUUID();
          const fileId = randomUUID();
          const documentId = randomUUID();
          const taskId = randomUUID();
          const path = `email-attachments/custody/${custodyId}`;
          const processedPath = `documents/processed/${documentId}.txt`;
          const digest = 'a'.repeat(64);
          await tx.insert(emailAttachmentCustodies).values({
            id: custodyId,
            agentId,
            claimGeneration: 4,
            privacyGeneration: 'before-erase',
            channelMessageId: `gmail:${randomUUID()}`,
            providerMessageId: randomUUID(),
            providerAttachmentId: `attachment-${randomUUID()}`,
            manifestDigest: digest,
            attachmentOrdinal: 0,
            workspacePath: path,
            filename: 'private-statement.pdf',
            mime: 'application/pdf',
            advertisedBytes: 19,
            actualBytes: 19,
            sha256: digest,
            markerGeneration: '101',
            objectGeneration: '102',
            status: 'catalogued',
            fileId,
            documentId,
          });
          await tx.insert(files).values({
            id: fileId,
            agentId,
            workspacePath: path,
            mime: 'application/pdf',
            bytes: 19,
            sha256: digest,
            objectGeneration: '102',
            emailAttachmentCustodyId: custodyId,
          });
          await tx.insert(documents).values({
            id: documentId,
            agentId,
            fileId,
            title: 'private-statement.pdf',
            mime: 'application/pdf',
            source: 'email',
            sourceRef: `gmail:${randomUUID()}`,
            trust: 'unknown',
            sha256: digest,
            status: 'pending',
            extractor: 'pending_processor',
            chunkCount: 0,
            charCount: 0,
            error: null,
            processorTokenHash: 'processor-token-hash',
            processorStartedAt: new Date(),
            processorAttempts: 1,
            processedTextPath: processedPath,
            extractionMetadata: null,
          });
          await tx.insert(documentChunks).values({
            id: randomUUID(),
            documentId,
            agentId,
            chunkIndex: 0,
            text: 'private extracted text',
          });
          await tx.insert(tasks).values({
            id: taskId,
            agentId,
            type: 'adhoc',
            status: 'pending',
            trigger: { source: 'internal', payload: { job: 'documents.process', documentId } },
          });

          const repository = createPostgresPrivacyErasureRepository(tx as unknown as Db);
          await repository.erase();
          const [erased] = await tx
            .select()
            .from(emailAttachmentCustodies)
            .where(eq(emailAttachmentCustodies.id, custodyId));
          expect(erased).toMatchObject({
            status: 'erased',
            workspacePath: path,
            markerGeneration: '101',
            objectGeneration: '102',
            manifestDigest: null,
            filename: null,
            mime: null,
            sha256: null,
            actualBytes: null,
            fileId: null,
            documentId: null,
            duplicateDocumentId: null,
            observerWorkId: null,
            providerAttachmentId: null,
          });
          expect(await tx.select().from(files).where(eq(files.id, fileId))).toHaveLength(0);
          expect(
            await tx.select().from(documents).where(eq(documents.id, documentId)),
          ).toHaveLength(0);
          expect(
            await tx.select().from(documentChunks).where(eq(documentChunks.documentId, documentId)),
          ).toHaveLength(0);
          expect((await tx.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
            'cancelled',
          );

          const initialAssetId = emailAttachmentCustodyCleanupIntentId(custodyId, '102');
          const assets = await repository.pendingAssets();
          const initialAsset = assets.find((asset) => asset.id === initialAssetId);
          if (initialAsset?.kind !== 'email_attachment_custody')
            throw new Error('Expected exact email attachment cleanup asset');
          expect(initialAsset).toEqual({
            kind: 'email_attachment_custody',
            id: initialAssetId,
            workspacePath: path,
            custodyId,
            generation: '102',
            objectState: 'content',
          });
          const initialMarkerAsset = assets.find(
            (asset) =>
              asset.kind === 'email_attachment_custody' &&
              asset.id === emailAttachmentCustodyCleanupIntentId(custodyId, '101'),
          );
          expect(initialMarkerAsset).toMatchObject({
            kind: 'email_attachment_custody',
            generation: '101',
            objectState: 'marker',
          });
          expect(assets).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ workspacePath: processedPath }),
              expect.objectContaining({ id: `document-delete-worker:${documentId}` }),
            ]),
          );

          await expect(
            repository.assetDeleted({ ...initialAsset, objectState: 'marker' }),
          ).rejects.toThrow('intent changed');
          await repository.refreshEmailAttachmentCustodyCleanupIntent(initialAsset, {
            generation: '103',
            objectState: 'content',
          });
          const refreshedId = emailAttachmentCustodyCleanupIntentId(custodyId, '103');
          const refreshedAsset = (await repository.pendingAssets()).find(
            (asset) => asset.id === refreshedId,
          );
          expect(refreshedAsset).toEqual({
            kind: 'email_attachment_custody',
            id: refreshedId,
            workspacePath: path,
            custodyId,
            generation: '103',
            objectState: 'content',
          });
          const refreshedIntent = await tx
            .select({ cursor: maintenanceCursors.cursor })
            .from(maintenanceCursors)
            .where(eq(maintenanceCursors.name, `privacy-erasure-asset:${agentId}:${refreshedId}`));
          expect(JSON.parse(refreshedIntent[0]?.cursor ?? '{}')).toMatchObject({
            generation: '103',
          });
          expect(JSON.parse(refreshedIntent[0]?.cursor ?? '{}')).not.toHaveProperty('documentId');
          if (refreshedAsset?.kind !== 'email_attachment_custody')
            throw new Error('Expected refreshed email attachment cleanup asset');
          await repository.assetDeleted(refreshedAsset);
          expect((await repository.pendingAssets()).some((asset) => asset.id === refreshedId)).toBe(
            false,
          );
          const stillErased = (
            await tx
              .select()
              .from(emailAttachmentCustodies)
              .where(eq(emailAttachmentCustodies.id, custodyId))
          )[0];
          expect(stillErased).toMatchObject({ status: 'erased', workspacePath: path });
          throw new Error('rollback attachment erasure fixture');
        });
        throw new Error('Expected attachment erasure fixture rollback');
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'rollback attachment erasure fixture')
          throw error;
      }
    } finally {
      await db.$client.end();
    }
  });

  it('resumes bounded custody erasure pages under one active owner fence', async () => {
    if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    const db = createDb(DATABASE_URL);
    const triggerSuffix = randomUUID().replaceAll('-', '');
    const triggerName = `fail_attachment_page_${triggerSuffix}`;
    const functionName = `fail_attachment_page_fn_${triggerSuffix}`;
    try {
      const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
      if (!owner) throw new Error('Test requires a seeded owner');
      const agentId = owner.id;
      const ids = Array.from({ length: 33 }, () => randomUUID()).sort();
      await db.insert(emailAttachmentCustodies).values(
        ids.map((id) => ({
          id,
          agentId,
          claimGeneration: 1,
          attachmentOrdinal: 0,
          workspacePath: `email-attachments/custody/${id}`,
          filename: 'private-attachment.pdf',
          mime: 'application/pdf',
          advertisedBytes: 12,
          actualBytes: 12,
          sha256: 'a'.repeat(64),
          manifestDigest: 'b'.repeat(64),
          markerGeneration: '71',
          objectGeneration: '72',
          status: 'object_written',
        })),
      );
      const sourceId = randomUUID();
      const sourceKey = `gmail:${randomUUID()}`;
      await db.insert(emailObserverSources).values({
        id: sourceId,
        agentId,
        sourceKey,
        channelMessageId: sourceKey,
        body: 'private source retained until custody paths are inventoried',
        privacyGeneration: null,
      });
      const lastId = ids.at(-1);
      if (!lastId) throw new Error('Fixture must contain a final page row');
      await db.execute(
        sql.raw(`
          CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.id = '${lastId}'::uuid THEN
              RAISE EXCEPTION 'simulated process interruption during custody page';
            END IF;
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER ${triggerName}
          BEFORE UPDATE ON email_attachment_custodies
          FOR EACH ROW EXECUTE FUNCTION ${functionName}();
        `),
      );

      const repository = createPostgresPrivacyErasureRepository(db);
      await expect(repository.erase()).rejects.toThrow();
      const rowsAfterInterruption = await db
        .select({ id: emailAttachmentCustodies.id, status: emailAttachmentCustodies.status })
        .from(emailAttachmentCustodies)
        .where(eq(emailAttachmentCustodies.agentId, agentId))
        .orderBy(asc(emailAttachmentCustodies.id));
      expect(rowsAfterInterruption.slice(0, 32).every((row) => row.status === 'erased')).toBe(true);
      expect(rowsAfterInterruption.at(-1)).toMatchObject({ id: lastId, status: 'object_written' });
      const [activeCursor] = await db
        .select({ cursor: maintenanceCursors.cursor })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, `privacy-erasure-active:${agentId}`));
      expect(JSON.parse(activeCursor?.cursor ?? '{}')).toMatchObject({
        version: 1,
        phase: 'attachments',
        afterId: ids[31],
      });
      await expect(postgresPrivacyObservationFence(db, agentId)).rejects.toThrow('in progress');
      expect(
        await db
          .select({ id: emailObserverSources.id })
          .from(emailObserverSources)
          .where(eq(emailObserverSources.id, sourceId)),
      ).toHaveLength(1);

      await db.execute(sql.raw(`DROP TRIGGER ${triggerName} ON email_attachment_custodies`));
      await db.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
      const firstCompletedCounts = await repository.erase();
      expect(await repository.erase()).toEqual(firstCompletedCounts);
      const erasedRows = await db
        .select({ id: emailAttachmentCustodies.id, status: emailAttachmentCustodies.status })
        .from(emailAttachmentCustodies)
        .where(eq(emailAttachmentCustodies.agentId, agentId));
      expect(erasedRows).toHaveLength(33);
      expect(erasedRows.every((row) => row.status === 'erased')).toBe(true);
      expect(
        await db
          .select({ id: emailObserverSources.id })
          .from(emailObserverSources)
          .where(eq(emailObserverSources.id, sourceId)),
      ).toHaveLength(0);
      const assets = await repository.pendingAssets();
      const custodyAssets = assets.filter((asset) => asset.kind === 'email_attachment_custody');
      expect(custodyAssets).toHaveLength(66);
      await expect(repository.complete()).rejects.toThrow('assets remain');
      const firstContentAsset = custodyAssets.find(
        (asset) => asset.kind === 'email_attachment_custody' && asset.custodyId === ids[0],
      );
      if (firstContentAsset?.kind !== 'email_attachment_custody')
        throw new Error('Expected first attachment content cleanup intent');
      await repository.assetDeleted(firstContentAsset);
      const custodyRepository = createPostgresEmailAttachmentCustodyRepository(db);
      expect(
        await custodyRepository.recordEmailAttachmentMarker({
          agentId,
          custodyId: ids[0] ?? '',
          generation: '71',
        }),
      ).toBe(false);
      const lateMarkerAssetId = emailAttachmentCustodyCleanupIntentId(ids[0] ?? '', '71');
      const lateAssets = await repository.pendingAssets();
      const lateMarkerAsset = lateAssets.find((asset) => asset.id === lateMarkerAssetId);
      expect(lateMarkerAsset).toMatchObject({
        kind: 'email_attachment_custody',
        custodyId: ids[0],
        generation: '71',
        objectState: 'marker',
      });
      const [lateTombstone] = await db
        .select({
          status: emailAttachmentCustodies.status,
          markerGeneration: emailAttachmentCustodies.markerGeneration,
          objectGeneration: emailAttachmentCustodies.objectGeneration,
        })
        .from(emailAttachmentCustodies)
        .where(eq(emailAttachmentCustodies.id, ids[0] ?? ''));
      expect(lateTombstone).toMatchObject({
        status: 'erased',
        markerGeneration: '71',
        objectGeneration: '72',
      });
      if (!lateMarkerAsset) throw new Error('Expected a late marker cleanup intent');
      await repository.assetDeleted(lateMarkerAsset);
      const [afterLateMarkerAck] = await db
        .select({
          status: emailAttachmentCustodies.status,
          markerGeneration: emailAttachmentCustodies.markerGeneration,
          objectGeneration: emailAttachmentCustodies.objectGeneration,
        })
        .from(emailAttachmentCustodies)
        .where(eq(emailAttachmentCustodies.id, ids[0] ?? ''));
      expect(afterLateMarkerAck).toMatchObject({
        status: 'erased',
        markerGeneration: '71',
        objectGeneration: '72',
      });
      await expect(postgresPrivacyObservationFence(db, agentId)).rejects.toThrow('in progress');
      for (const asset of lateAssets) await repository.assetDeleted(asset);
      await repository.complete();
      const generation = await postgresPrivacyObservationFence(db, agentId);
      expect(generation).toEqual(expect.any(String));
      await db.transaction(async (tx) => {
        await expect(
          lockPostgresPrivacyObservationFence(tx as unknown as Db, agentId),
        ).resolves.toBe(generation);
      });
      const [activeAfterCompletion] = await db
        .select({ name: maintenanceCursors.name })
        .from(maintenanceCursors)
        .where(eq(maintenanceCursors.name, `privacy-erasure-active:${agentId}`));
      expect(activeAfterCompletion).toBeUndefined();
    } finally {
      await db.$client.end();
    }
  });
});
