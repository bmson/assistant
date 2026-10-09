import type {
  LongTermMemoryExportData,
  PrivacyExportRepository,
  Records,
} from '@assistant/persistence';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  agents,
  contacts,
  emailIngest,
  emailObserverWork,
  knowledgeGraphAssertionEvidence,
  knowledgeGraphAssertions,
  knowledgeGraphEntities,
  knowledgeGraphEntityAliases,
  knowledgeGraphRelations,
  memories,
  memoryTombstones,
  missionReports,
  notificationOutbox,
  ownerCard,
  recallSurfaces,
  securityIncidentAttention,
  securityIncidentSources,
  securityIncidents,
  situationPacks,
  voiceProfile,
  writingSamples,
} from './schema.js';

export function createPostgresPrivacyExportRepository(db: Db): PrivacyExportRepository {
  return {
    kind: 'privacy-export-repository',
    async exportOwnerData(): Promise<LongTermMemoryExportData> {
      const configured = await db.select({ id: agents.id }).from(agents).limit(2);
      if (configured.length !== 1 || !configured[0])
        throw new Error('Privacy export requires exactly one configured agent');
      const agentId = configured[0].id;
      const [
        memoryRows,
        tombstones,
        entities,
        aliases,
        relations,
        assertions,
        assertionEvidence,
        people,
        samples,
        profile,
        card,
        packs,
        incidents,
        incidentSources,
        incidentAttention,
        incidentEvidence,
        emailDirectRecoveryRows,
        emailObserverRows,
        reports,
        outboxRows,
        recallSurfaceRows,
      ] = await Promise.all([
        db
          .select({
            id: memories.id,
            contentHash: memories.contentHash,
            category: memories.category,
            kind: memories.kind,
            content: memories.content,
            importance: memories.importance,
            confidence: memories.confidence,
            originTrust: memories.originTrust,
            quarantined: memories.quarantined,
            domain: memories.domain,
            ownerConfirmed: memories.ownerConfirmed,
            pinned: memories.pinned,
            source: memories.source,
            createdAt: memories.createdAt,
            expiresAt: memories.expiresAt,
          })
          .from(memories)
          .where(eq(memories.agentId, agentId)),
        db.select({ contentHash: memoryTombstones.contentHash }).from(memoryTombstones),
        db
          .select({
            id: knowledgeGraphEntities.id,
            canonicalKey: knowledgeGraphEntities.canonicalKey,
            label: knowledgeGraphEntities.label,
            preferredLabel: knowledgeGraphEntities.preferredLabel,
            kind: knowledgeGraphEntities.kind,
            contactId: knowledgeGraphEntities.contactId,
            createdAt: knowledgeGraphEntities.createdAt,
            updatedAt: knowledgeGraphEntities.updatedAt,
          })
          .from(knowledgeGraphEntities)
          .where(eq(knowledgeGraphEntities.agentId, agentId)),
        db
          .select({
            canonicalKey: knowledgeGraphEntityAliases.canonicalKey,
            entityId: knowledgeGraphEntityAliases.entityId,
            createdAt: knowledgeGraphEntityAliases.createdAt,
          })
          .from(knowledgeGraphEntityAliases)
          .where(eq(knowledgeGraphEntityAliases.agentId, agentId)),
        db
          .select({
            id: knowledgeGraphRelations.id,
            subjectEntityId: knowledgeGraphRelations.subjectEntityId,
            predicate: knowledgeGraphRelations.predicate,
            objectEntityId: knowledgeGraphRelations.objectEntityId,
            sourceMemoryId: knowledgeGraphRelations.sourceMemoryId,
            evidenceQuote: knowledgeGraphRelations.evidenceQuote,
            confidence: knowledgeGraphRelations.confidence,
            validFrom: knowledgeGraphRelations.validFrom,
            validUntil: knowledgeGraphRelations.validUntil,
            reviewStatus: knowledgeGraphRelations.reviewStatus,
            createdAt: knowledgeGraphRelations.createdAt,
          })
          .from(knowledgeGraphRelations)
          .where(eq(knowledgeGraphRelations.agentId, agentId)),
        db
          .select({
            id: knowledgeGraphAssertions.id,
            subjectEntityId: knowledgeGraphAssertions.subjectEntityId,
            predicate: knowledgeGraphAssertions.predicate,
            objectEntityId: knowledgeGraphAssertions.objectEntityId,
            assertion: knowledgeGraphAssertions.assertion,
            qualifiers: knowledgeGraphAssertions.qualifiers,
            validFrom: knowledgeGraphAssertions.validFrom,
            validUntil: knowledgeGraphAssertions.validUntil,
            semanticRevision: knowledgeGraphAssertions.semanticRevision,
            evidenceRevision: knowledgeGraphAssertions.evidenceRevision,
            lifecycle: knowledgeGraphAssertions.lifecycle,
            reviewStatus: knowledgeGraphAssertions.reviewStatus,
            reviewedRevision: knowledgeGraphAssertions.reviewedRevision,
            ownerAuthored: knowledgeGraphAssertions.ownerAuthored,
            supersededById: knowledgeGraphAssertions.supersededById,
            createdAt: knowledgeGraphAssertions.createdAt,
            updatedAt: knowledgeGraphAssertions.updatedAt,
          })
          .from(knowledgeGraphAssertions)
          .where(eq(knowledgeGraphAssertions.agentId, agentId)),
        db
          .select({
            id: knowledgeGraphAssertionEvidence.id,
            assertionId: knowledgeGraphAssertionEvidence.assertionId,
            sourceMemoryId: knowledgeGraphAssertionEvidence.sourceMemoryId,
            sourceFingerprint: knowledgeGraphAssertionEvidence.sourceFingerprint,
            sourceContentHash: knowledgeGraphAssertionEvidence.sourceContentHash,
            evidenceQuote: knowledgeGraphAssertionEvidence.evidenceQuote,
            sourceAuthor: knowledgeGraphAssertionEvidence.sourceAuthor,
            sourceTrust: knowledgeGraphAssertionEvidence.sourceTrust,
            independent: knowledgeGraphAssertionEvidence.independent,
            spanStart: knowledgeGraphAssertionEvidence.spanStart,
            spanEnd: knowledgeGraphAssertionEvidence.spanEnd,
            extractionVersion: knowledgeGraphAssertionEvidence.extractionVersion,
            evidenceRevision: knowledgeGraphAssertionEvidence.evidenceRevision,
            observedAt: knowledgeGraphAssertionEvidence.observedAt,
            createdAt: knowledgeGraphAssertionEvidence.createdAt,
          })
          .from(knowledgeGraphAssertionEvidence)
          .where(eq(knowledgeGraphAssertionEvidence.agentId, agentId)),
        db
          .select({
            id: contacts.id,
            name: contacts.name,
            aliases: contacts.aliases,
            emails: contacts.emails,
            phones: contacts.phones,
            relationship: contacts.relationship,
            trust: contacts.trust,
            notes: contacts.notes,
            createdAt: contacts.createdAt,
            updatedAt: contacts.updatedAt,
          })
          .from(contacts),
        db
          .select({
            id: writingSamples.id,
            register: writingSamples.register,
            text: writingSamples.text,
            context: writingSamples.context,
            createdAt: writingSamples.createdAt,
          })
          .from(writingSamples),
        db
          .select({
            description: voiceProfile.description,
            dos: voiceProfile.dos,
            donts: voiceProfile.donts,
            signature: voiceProfile.signature,
            updatedAt: voiceProfile.updatedAt,
          })
          .from(voiceProfile)
          .where(eq(voiceProfile.id, 1))
          .limit(1),
        db.select().from(ownerCard).where(eq(ownerCard.id, 1)).limit(1),
        db.select().from(situationPacks).where(eq(situationPacks.agentId, agentId)),
        db
          .select({
            id: securityIncidents.id,
            confidence: securityIncidents.confidence,
            revision: securityIncidents.revision,
            disposition: securityIncidents.disposition,
            decisionRevision: securityIncidents.decisionRevision,
            decisionReason: securityIncidents.decisionReason,
            materialChangeReason: securityIncidents.materialChangeReason,
            createdAt: securityIncidents.createdAt,
            updatedAt: securityIncidents.updatedAt,
          })
          .from(securityIncidents)
          .where(eq(securityIncidents.agentId, agentId)),
        db
          .select({
            id: securityIncidentSources.id,
            incidentId: securityIncidentSources.incidentId,
            channelMessageId: securityIncidentSources.channelMessageId,
            sourceMessageId: securityIncidentSources.sourceMessageId,
            mailboxHash: securityIncidentSources.mailboxHash,
            evidenceFingerprint: securityIncidentSources.evidenceFingerprint,
            observedAt: securityIncidentSources.observedAt,
          })
          .from(securityIncidentSources)
          .where(eq(securityIncidentSources.agentId, agentId)),
        db
          .select({
            id: securityIncidentAttention.id,
            incidentId: securityIncidentAttention.incidentId,
            revision: securityIncidentAttention.revision,
            producer: securityIncidentAttention.producer,
            deliveryStatus: securityIncidentAttention.deliveryStatus,
            createdAt: securityIncidentAttention.createdAt,
            updatedAt: securityIncidentAttention.updatedAt,
          })
          .from(securityIncidentAttention)
          .where(eq(securityIncidentAttention.agentId, agentId)),
        db
          .select({
            channelMessageId: emailIngest.channelMessageId,
            securityIncidentId: emailIngest.securityIncidentId,
            securityEvidence: emailIngest.securityEvidence,
          })
          .from(emailIngest)
          .where(and(eq(emailIngest.agentId, agentId), isNotNull(emailIngest.securityIncidentId))),
        db
          .select({
            channelMessageId: emailIngest.channelMessageId,
            directRouting: emailIngest.directRouting,
            directRecoveryReason: emailIngest.directRecoveryReason,
            emailContentProvenance: emailIngest.emailContentProvenance,
          })
          .from(emailIngest)
          .where(
            and(
              eq(emailIngest.agentId, agentId),
              sql`${emailIngest.ingestMode} = 'direct' AND (${emailIngest.directRouting} IS NOT NULL OR ${emailIngest.directRecoveryReason} IS NOT NULL OR ${emailIngest.emailContentProvenance} IS NOT NULL)`,
            ),
          ),
        db
          .select({
            observerKey: emailObserverWork.observerKey,
            observerVersion: emailObserverWork.observerVersion,
            workClass: emailObserverWork.workClass,
            status: emailObserverWork.status,
            attemptCount: emailObserverWork.attemptCount,
            budgetReserved: emailObserverWork.budgetReserved,
            budgetWindowStart: emailObserverWork.budgetWindowStart,
            createdAt: emailObserverWork.createdAt,
            completedAt: emailObserverWork.completedAt,
          })
          .from(emailObserverWork)
          .where(eq(emailObserverWork.agentId, agentId)),
        db
          .select({
            id: missionReports.id,
            missionId: missionReports.missionId,
            goalId: missionReports.goalId,
            conversationId: missionReports.conversationId,
            outcome: missionReports.outcome,
            text: missionReports.text,
            chatStatus: missionReports.chatStatus,
            ownerStatus: missionReports.ownerStatus,
            mirrorStatus: missionReports.mirrorStatus,
            createdAt: missionReports.createdAt,
            chatDeliveredAt: missionReports.chatDeliveredAt,
            ownerDeliveredAt: missionReports.ownerDeliveredAt,
            mirrorDeliveredAt: missionReports.mirrorDeliveredAt,
          })
          .from(missionReports)
          .where(eq(missionReports.agentId, agentId)),
        db
          .select({
            id: notificationOutbox.id,
            deliveryKey: notificationOutbox.deliveryKey,
            legKey: notificationOutbox.legKey,
            adapter: notificationOutbox.adapter,
            status: notificationOutbox.status,
            attempts: notificationOutbox.attempts,
            retryable: notificationOutbox.retryable,
            providerMessageId: notificationOutbox.providerMessageId,
            createdAt: notificationOutbox.createdAt,
            finishedAt: notificationOutbox.finishedAt,
          })
          .from(notificationOutbox)
          .where(eq(notificationOutbox.agentId, agentId)),
        db
          .select({
            sourceKey: recallSurfaces.sourceKey,
            sourceRevision: recallSurfaces.sourceRevision,
            kind: recallSurfaces.kind,
            firstSurfacedAt: recallSurfaces.firstSurfacedAt,
            lastSurfacedAt: recallSurfaces.lastSurfacedAt,
            surfaceCount: recallSurfaces.surfaceCount,
            suppressedAt: recallSurfaces.suppressedAt,
            version: recallSurfaces.version,
          })
          .from(recallSurfaces)
          .where(eq(recallSurfaces.agentId, agentId)),
      ]);
      const tombstonedHashes = new Set(tombstones.map((row) => row.contentHash));
      const activeRows = memoryRows.filter((row) => !tombstonedHashes.has(row.contentHash));
      const activeMemoryIds = new Set(activeRows.map((row) => row.id));
      return {
        memories: activeRows.map(({ contentHash: _contentHash, ...row }) => row),
        knowledgeGraph: {
          entities,
          aliases,
          relations: relations.filter((row) => activeMemoryIds.has(row.sourceMemoryId)),
          assertions,
          assertionEvidence: assertionEvidence.filter((row) =>
            activeMemoryIds.has(row.sourceMemoryId),
          ),
        },
        people,
        writingVoice: { samples, profile: profile[0] ?? null },
        compiledOwnerCard: card[0] ?? null,
        situationPacks: packs,
        emailObservers: {
          scope: 'observer-work-metadata-only',
          rows: emailObserverRows.map((row) => ({
            ...row,
            workClass: row.workClass as Records['emailObserverWork']['workClass'],
            status: row.status as Records['emailObserverWork']['status'],
          })),
        },
        missionReports: reports as LongTermMemoryExportData['missionReports'],
        notificationOutbox: {
          scope: 'delivery-receipts-only',
          rows: outboxRows,
        },
        recallSurfaces: {
          scope: 'source-identity-ledger-only',
          rows: recallSurfaceRows,
        },
        directEmailRecovery: {
          scope: 'direct-ingest-routing-and-body-free-content-provenance',
          rows: emailDirectRecoveryRows,
        },
        securityIncidents: {
          incidents,
          sources: incidentSources,
          attention: incidentAttention,
          evidence: incidentEvidence,
        },
      };
    },
  };
}
