import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { createDb } from './client.js';
import { createPostgresPrivacyExportRepository } from './privacy-export-repository.js';
import {
  emailIngest,
  knowledgeGraphAssertionEvidence,
  knowledgeGraphAssertions,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  maintenanceCursors,
  memories,
  memoryEmbeddingRefreshes,
  memoryTombstones,
  missionReports,
  notificationOutbox,
  recallSurfaces,
  securityIncidentAttention,
  securityIncidentSources,
  securityIncidents,
  tasks,
} from './schema.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://assistant@127.0.0.1:55432/assistant_test';

describe('PostgreSQL privacy export repository', () => {
  it('projects owner-visible memory fields without embeddings or internal hashes', async () => {
    const db = createDb(DATABASE_URL);
    try {
      await expect(
        db.transaction(async (tx) => {
          const configured = await tx.query.agents.findMany({ columns: { id: true }, limit: 2 });
          if (configured.length !== 1 || !configured[0])
            throw new Error('Privacy export test requires one seeded agent');
          const id = randomUUID();
          const incidentId = randomUUID();
          const sourceId = randomUUID();
          const attentionId = randomUUID();
          const channelMessageId = `gmail:privacy-export:${randomUUID()}`;
          const deliveryKey = `outbox:privacy-export:${randomUUID()}`;
          const legKey = `push:privacy-export:${randomUUID()}`;
          const surfaceKey = randomUUID().replaceAll('-', '').repeat(2);
          const sourceRevision = randomUUID().replaceAll('-', '').repeat(2);
          const forgottenId = randomUUID();
          const forgottenHash = randomUUID();
          const activeContentHash = randomUUID();
          await tx.insert(memories).values({
            id,
            agentId: configured[0].id,
            category: 'knowledge',
            kind: 'fact',
            content: 'Owner-visible privacy export test fact',
            contentHash: activeContentHash,
            embedding: Array.from({ length: 1536 }, () => 0.25),
            embeddingSpaceKey: 'a'.repeat(64),
          });
          const refreshTarget = 'b'.repeat(64);
          await tx.insert(memoryEmbeddingRefreshes).values({
            id: `refresh-${randomUUID()}`,
            agentId: configured[0].id,
            memoryId: id,
            sourceHash: activeContentHash,
            targetSpaceKey: refreshTarget,
            targetDimensions: 1536,
            observedSpaceKey: 'a'.repeat(64),
            status: 'prepared',
            preparedVector: Array.from({ length: 1536 }, () => 0.125),
            privacyGeneration: 'test-generation',
          });
          await tx.insert(maintenanceCursors).values({
            name: `memory-embedding-refresh:${configured[0].id}:${refreshTarget}`,
            cursor: id,
          });
          await tx.insert(memories).values({
            id: forgottenId,
            agentId: configured[0].id,
            category: 'knowledge',
            kind: 'fact',
            content: 'Forgotten privacy export test fact',
            contentHash: forgottenHash,
          });
          await tx.insert(memoryTombstones).values({ contentHash: forgottenHash });
          await tx.insert(securityIncidents).values({
            id: incidentId,
            agentId: configured[0].id,
            incidentKey: `privacy-export:${incidentId}`,
            confidence: 'provider-reference',
            revision: 2,
            disposition: 'dismissed',
            decisionRevision: 1,
            decisionReason: 'The owner recognized the first alert as expected.',
            materialChangeReason: 'A later event changed the device.',
          });
          await tx.insert(securityIncidentSources).values({
            id: sourceId,
            agentId: configured[0].id,
            incidentId,
            channelMessageId,
            sourceMessageId: '<source@example.test>',
            mailboxHash: 'one-way-mailbox-hash',
            evidenceFingerprint: 'evidence-fingerprint',
            observedAt: new Date(),
          });
          await tx.insert(securityIncidentAttention).values({
            id: attentionId,
            agentId: configured[0].id,
            incidentId,
            revision: 2,
            producer: 'briefing',
            deliveryStatus: 'accepted',
          });
          const reportMissionId = randomUUID();
          await tx.insert(tasks).values({
            id: reportMissionId,
            agentId: configured[0].id,
            type: 'mission',
            status: 'done',
            trust: 'owner',
          });
          await tx.insert(missionReports).values({
            id: `report-${randomUUID()}`,
            agentId: configured[0].id,
            missionId: reportMissionId,
            outcome: 'completed',
            text: 'Owner-visible mission report',
            chatStatus: 'delivered',
            ownerStatus: 'unknown',
            mirrorStatus: 'skipped',
          });
          await tx.insert(notificationOutbox).values({
            id: randomUUID(),
            agentId: configured[0].id,
            deliveryKey,
            legKey,
            adapter: 'push',
            status: 'delivered',
            attempts: 1,
            retryable: false,
            providerMessageId: 'apns-receipt-id',
            destination: { token: 'must-not-export-device-token' },
            payload: { body: 'must-not-export-private-notice' },
            result: { providerError: 'must-not-export-provider-error' },
          });
          const surfacedAt = new Date('2026-10-07T12:00:00.000Z');
          await tx.insert(recallSurfaces).values({
            agentId: configured[0].id,
            sourceKey: surfaceKey,
            sourceRevision,
            kind: 'chat',
            firstSurfacedAt: surfacedAt,
            lastSurfacedAt: surfacedAt,
            lastMessageId: randomUUID(),
            surfaceCount: 2,
            suppressedAt: surfacedAt,
            version: 3,
          });
          await tx.insert(emailIngest).values({
            agentId: configured[0].id,
            channelMessageId,
            fromEmail: 'security@example.test',
            category: 'security',
            importance: 3,
            securityIncidentId: incidentId,
            securityEvidence: {
              eventType: 'sign-in',
              affectedAccount: 'owner@example.test',
              evidenceQuote: 'New sign-in to owner@example.test',
            },
          });
          const subjectId = randomUUID();
          const objectId = randomUUID();
          await tx.insert(knowledgeGraphEntities).values([
            {
              id: subjectId,
              agentId: configured[0].id,
              canonicalKey: `topic:${subjectId}`,
              label: 'Subject',
              kind: 'topic',
            },
            {
              id: objectId,
              agentId: configured[0].id,
              canonicalKey: `topic:${objectId}`,
              label: 'Object',
              kind: 'topic',
            },
          ]);
          await tx.insert(knowledgeGraphRelations).values([
            {
              agentId: configured[0].id,
              subjectEntityId: subjectId,
              predicate: 'knows',
              objectEntityId: objectId,
              sourceMemoryId: id,
              sourceFingerprint: randomUUID(),
              ordinal: 0,
            },
            {
              agentId: configured[0].id,
              subjectEntityId: subjectId,
              predicate: 'knows',
              objectEntityId: objectId,
              sourceMemoryId: forgottenId,
              sourceFingerprint: randomUUID(),
              ordinal: 0,
            },
          ]);
          const assertionId = randomUUID();
          const evidenceId = randomUUID();
          await tx.insert(knowledgeGraphAssertions).values({
            id: assertionId,
            agentId: configured[0].id,
            semanticKey: `privacy-export:${assertionId}`,
            subjectEntityId: subjectId,
            predicate: 'knows',
            objectEntityId: objectId,
            assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
            qualifiers: {},
            semanticRevision: 1,
            evidenceRevision: 1,
            lifecycle: 'current',
            reviewStatus: 'confirmed',
            reviewedRevision: 1,
            reviewedPayloadHash: 'reviewed-payload',
          });
          await tx.insert(knowledgeGraphAssertionEvidence).values({
            id: evidenceId,
            agentId: configured[0].id,
            assertionId,
            sourceMemoryId: id,
            sourceFingerprint: 'privacy-export-source-fingerprint',
            sourceContentHash: activeContentHash,
            evidenceQuote: 'Owner-visible source evidence',
            sourceAuthor: 'owner',
            sourceTrust: 'owner',
            independent: false,
            spanStart: 0,
            spanEnd: 32,
            extractionVersion: 1,
            evidenceRevision: 1,
            observedAt: new Date(),
          });
          const result = await createPostgresPrivacyExportRepository(
            tx as unknown as Db,
          ).exportOwnerData();
          const row = result.memories.find((candidate) => candidate.id === id);
          expect(row).toEqual({
            id,
            category: 'knowledge',
            kind: 'fact',
            content: 'Owner-visible privacy export test fact',
            importance: 3,
            confidence: '0.70',
            originTrust: 'owner',
            quarantined: false,
            domain: null,
            ownerConfirmed: false,
            pinned: false,
            source: null,
            createdAt: expect.any(Date),
            expiresAt: null,
          });
          expect(row).not.toHaveProperty('embedding');
          expect(row).not.toHaveProperty('contentHash');
          expect(result).not.toHaveProperty('memoryEmbeddingRefreshes');
          expect(JSON.stringify(result)).not.toContain('preparedVector');
          expect(JSON.stringify(result)).not.toContain('test-generation');
          expect(result.memories.map((candidate) => candidate.id)).not.toContain(forgottenId);
          expect(result.knowledgeGraph.relations).toEqual(
            expect.arrayContaining([expect.objectContaining({ sourceMemoryId: id })]),
          );
          expect(
            result.knowledgeGraph.relations.some(
              (relation) => relation.sourceMemoryId === forgottenId,
            ),
          ).toBe(false);
          const exportedAssertion = result.knowledgeGraph.assertions.find(
            (assertion) => assertion.id === assertionId,
          );
          expect(exportedAssertion).toEqual(
            expect.objectContaining({ id: assertionId, reviewStatus: 'confirmed' }),
          );
          expect(exportedAssertion).not.toHaveProperty('reviewedPayloadHash');
          expect(result.knowledgeGraph.assertionEvidence).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: evidenceId,
                assertionId,
                sourceMemoryId: id,
                evidenceQuote: 'Owner-visible source evidence',
              }),
            ]),
          );
          expect(
            result.knowledgeGraph.assertionEvidence.some(
              (evidence) => evidence.sourceMemoryId === forgottenId,
            ),
          ).toBe(false);
          expect(result.securityIncidents.incidents).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: incidentId,
                disposition: 'dismissed',
                decisionRevision: 1,
              }),
            ]),
          );
          expect(result.securityIncidents.sources).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: sourceId,
                incidentId,
                mailboxHash: 'one-way-mailbox-hash',
              }),
            ]),
          );
          expect(result.securityIncidents.attention).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: attentionId,
                producer: 'briefing',
                deliveryStatus: 'accepted',
              }),
            ]),
          );
          expect(result.securityIncidents.evidence).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ channelMessageId, securityIncidentId: incidentId }),
            ]),
          );
          expect(result.missionReports).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                missionId: reportMissionId,
                text: 'Owner-visible mission report',
                ownerStatus: 'unknown',
              }),
            ]),
          );
          for (const report of result.missionReports)
            expect(report).not.toHaveProperty('payloadHash');
          expect(result.notificationOutbox.scope).toBe('delivery-receipts-only');
          expect(result.notificationOutbox.rows).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                deliveryKey,
                legKey,
                status: 'delivered',
                providerMessageId: 'apns-receipt-id',
              }),
            ]),
          );
          const receiptFields = [
            'adapter',
            'attempts',
            'createdAt',
            'deliveryKey',
            'finishedAt',
            'id',
            'legKey',
            'providerMessageId',
            'retryable',
            'status',
          ];
          for (const receipt of result.notificationOutbox.rows)
            expect(Object.keys(receipt).sort()).toEqual(receiptFields);
          const exportedReceipt = result.notificationOutbox.rows.find(
            (receipt) => receipt.deliveryKey === deliveryKey,
          );
          expect(exportedReceipt).toBeDefined();
          expect(JSON.stringify(exportedReceipt)).not.toContain('must-not-export');
          expect(result.recallSurfaces.scope).toBe('source-identity-ledger-only');
          expect(result.recallSurfaces.rows).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                sourceKey: surfaceKey,
                sourceRevision,
                kind: 'chat',
                surfaceCount: 2,
                suppressedAt: surfacedAt,
                version: 3,
              }),
            ]),
          );
          expect(JSON.stringify(result.recallSurfaces)).not.toContain('lastMessageId');
          throw new Error('rollback privacy export fixture');
        }),
      ).rejects.toThrow('rollback privacy export fixture');
    } finally {
      await db.$client.end();
    }
  });
});
