import type {
  LongTermMemoryExportData,
  PrivacyExportRepository,
  Records,
} from '@assistant/persistence';
import { FieldPath, type Query } from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 200;

async function allRows<T>(query: Query): Promise<T[]> {
  const rows: T[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let pageQuery = query.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) pageQuery = pageQuery.startAfter(cursor);
    const page = await pageQuery.get();
    for (const doc of page.docs) rows.push(decodeRecord<T>(doc.data()));
    cursor = page.docs.at(-1);
    if (page.size < PAGE_SIZE) return rows;
  }
}

async function ownerWritingSamples(store: InstallationStore, agentId: string) {
  const rows: Records['writingSamples'][] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query: Query = store
      .collection('writingSamples')
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      const row = decodeRecord<Records['writingSamples'] & { agentId?: unknown }>(doc.data());
      if (
        typeof row.id !== 'string' ||
        !row.id ||
        documentKey(row.id) !== doc.id ||
        typeof row.agentId !== 'string' ||
        !row.agentId
      )
        throw new Error('Privacy export found a writing sample without valid owner identity');
      if (row.agentId === agentId) rows.push(row);
    }
    if (page.size < PAGE_SIZE) return rows;
    cursor = page.docs.at(-1);
  }
}

function pick<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as Pick<T, K>;
}

export class FirestorePrivacyExportRepository implements PrivacyExportRepository {
  readonly kind = 'privacy-export-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId?: string,
  ) {}

  async exportOwnerData(): Promise<LongTermMemoryExportData> {
    const agentPage = await this.store
      .collection('agents')
      .orderBy(FieldPath.documentId())
      .limit(2)
      .get();
    const agentDoc = agentPage.docs[0];
    const agent = agentDoc ? decodeRecord<Records['agents']>(agentDoc.data()) : undefined;
    if (
      agentPage.size !== 1 ||
      !agent ||
      typeof agent.id !== 'string' ||
      documentKey(agent.id) !== agentDoc?.id ||
      (this.configuredAgentId !== undefined && agent.id !== this.configuredAgentId)
    )
      throw new Error('Privacy export requires exactly one configured agent');
    const agentId = agent.id;
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const owned = (collection: string) =>
      allRows<Record<string, unknown>>(
        this.store.collection(collection).where('agentId', '==', agentId),
      );
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
      profiles,
      card,
      packs,
      securityIncidents,
      securityIncidentSources,
      securityIncidentAttention,
      emailIngestRows,
      emailObserverRows,
      missionReports,
      notificationOutboxRows,
      recallSurfaceRows,
    ] = await Promise.all([
      owned('memories'),
      allRows<Records['memoryTombstones']>(this.store.collection('memoryTombstones')),
      owned('knowledgeGraphEntities'),
      owned('knowledgeGraphEntityAliases'),
      owned('knowledgeGraphRelations'),
      owned('knowledgeGraphAssertions'),
      owned('knowledgeGraphAssertionEvidence'),
      allRows<Records['contacts']>(this.store.collection('contacts')),
      ownerWritingSamples(this.store, agentId),
      allRows<Records['voiceProfile']>(this.store.collection('voiceProfile')),
      this.store.doc('ownerCards', agentId).get(),
      owned('situationPacks'),
      owned('securityIncidents'),
      owned('securityIncidentSources'),
      owned('securityIncidentAttention'),
      owned('emailIngest'),
      owned('emailObserverWork'),
      owned('missionReports'),
      owned('notificationOutbox'),
      owned('recallSurfaces'),
    ]);
    const profile = profiles.find((row) => row.id === 1);
    const tombstonedHashes = new Set(tombstones.map((row) => row.contentHash));
    const activeMemories = memoryRows.filter(
      (row) =>
        typeof row.id === 'string' &&
        typeof row.contentHash === 'string' &&
        !tombstonedHashes.has(row.contentHash),
    );
    const activeMemoryIds = new Set(activeMemories.map((row) => row.id));
    const cardRow = card.exists
      ? decodeRecord<{ agentId?: unknown; content?: unknown; compiledAt?: unknown }>(card.data())
      : null;
    const result: LongTermMemoryExportData = {
      memories: activeMemories.map((row) =>
        pick(row, [
          'id',
          'category',
          'kind',
          'content',
          'importance',
          'confidence',
          'originTrust',
          'quarantined',
          'domain',
          'ownerConfirmed',
          'pinned',
          'source',
          'createdAt',
          'expiresAt',
        ]),
      ) as LongTermMemoryExportData['memories'],
      knowledgeGraph: {
        entities: entities.map((row) =>
          pick(row, [
            'id',
            'canonicalKey',
            'label',
            'preferredLabel',
            'kind',
            'contactId',
            'createdAt',
            'updatedAt',
          ]),
        ) as LongTermMemoryExportData['knowledgeGraph']['entities'],
        aliases: aliases.map((row) =>
          pick(row, ['canonicalKey', 'entityId', 'createdAt']),
        ) as LongTermMemoryExportData['knowledgeGraph']['aliases'],
        relations: relations
          .filter(
            (row) =>
              typeof row.sourceMemoryId === 'string' && activeMemoryIds.has(row.sourceMemoryId),
          )
          .map((row) =>
            pick(row, [
              'id',
              'subjectEntityId',
              'predicate',
              'objectEntityId',
              'sourceMemoryId',
              'evidenceQuote',
              'confidence',
              'validFrom',
              'validUntil',
              'reviewStatus',
              'createdAt',
            ]),
          ) as LongTermMemoryExportData['knowledgeGraph']['relations'],
        assertions: assertions.map((row) =>
          pick(row, [
            'id',
            'subjectEntityId',
            'predicate',
            'objectEntityId',
            'assertion',
            'qualifiers',
            'validFrom',
            'validUntil',
            'semanticRevision',
            'evidenceRevision',
            'lifecycle',
            'reviewStatus',
            'reviewedRevision',
            'ownerAuthored',
            'supersededById',
            'createdAt',
            'updatedAt',
          ]),
        ) as LongTermMemoryExportData['knowledgeGraph']['assertions'],
        assertionEvidence: assertionEvidence
          .filter(
            (row) =>
              typeof row.sourceMemoryId === 'string' && activeMemoryIds.has(row.sourceMemoryId),
          )
          .map((row) =>
            pick(row, [
              'id',
              'assertionId',
              'sourceMemoryId',
              'sourceFingerprint',
              'sourceContentHash',
              'evidenceQuote',
              'sourceAuthor',
              'sourceTrust',
              'independent',
              'spanStart',
              'spanEnd',
              'extractionVersion',
              'evidenceRevision',
              'observedAt',
              'createdAt',
            ]),
          ) as LongTermMemoryExportData['knowledgeGraph']['assertionEvidence'],
      },
      people: people.map((row) =>
        pick(row, [
          'id',
          'name',
          'aliases',
          'emails',
          'phones',
          'relationship',
          'trust',
          'notes',
          'createdAt',
          'updatedAt',
        ]),
      ),
      writingVoice: {
        samples: samples.map((row) =>
          pick(row, ['id', 'register', 'text', 'context', 'createdAt']),
        ),
        profile: profile
          ? pick(profile, ['description', 'dos', 'donts', 'signature', 'updatedAt'])
          : null,
      },
      compiledOwnerCard:
        cardRow?.agentId === agentId &&
        typeof cardRow.content === 'string' &&
        cardRow.compiledAt instanceof Date
          ? { id: 1, content: cardRow.content, compiledAt: cardRow.compiledAt }
          : null,
      situationPacks: packs.map((row) =>
        pick(row, [
          'id',
          'agentId',
          'creationKey',
          'title',
          'version',
          'archived',
          'data',
          'createdAt',
          'updatedAt',
        ]),
      ) as Records['situationPacks'][],
      emailObservers: {
        scope: 'observer-work-metadata-only',
        rows: emailObserverRows.map((row) => {
          if (typeof row.id !== 'string' || !row.id || row.agentId !== agentId)
            throw new Error('Privacy export found a malformed email observer identity');
          return pick(row as Records['emailObserverWork'], [
            'observerKey',
            'observerVersion',
            'workClass',
            'status',
            'attemptCount',
            'budgetReserved',
            'budgetWindowStart',
            'createdAt',
            'completedAt',
          ]);
        }),
      },
      missionReports: missionReports.map((row) => {
        if (typeof row.id !== 'string' || !row.id || row.agentId !== agentId)
          throw new Error('Privacy export found a malformed mission report identity');
        return pick(row as Records['missionReports'], [
          'id',
          'missionId',
          'goalId',
          'conversationId',
          'outcome',
          'text',
          'chatStatus',
          'ownerStatus',
          'mirrorStatus',
          'createdAt',
          'chatDeliveredAt',
          'ownerDeliveredAt',
          'mirrorDeliveredAt',
        ]);
      }),
      notificationOutbox: {
        scope: 'delivery-receipts-only',
        rows: notificationOutboxRows.map((row) => {
          if (typeof row.id !== 'string' || !row.id || row.agentId !== agentId)
            throw new Error('Privacy export found a malformed notification receipt identity');
          return pick(row as Records['notificationOutbox'], [
            'id',
            'deliveryKey',
            'legKey',
            'adapter',
            'status',
            'attempts',
            'retryable',
            'providerMessageId',
            'createdAt',
            'finishedAt',
          ]);
        }),
      },
      recallSurfaces: {
        scope: 'source-identity-ledger-only',
        rows: recallSurfaceRows.map((row) => {
          if (typeof row.id !== 'string' || !row.id || row.agentId !== agentId)
            throw new Error('Privacy export found a malformed recall surface identity');
          return pick(row as Records['recallSurfaces'], [
            'sourceKey',
            'sourceRevision',
            'kind',
            'firstSurfacedAt',
            'lastSurfacedAt',
            'surfaceCount',
            'suppressedAt',
            'version',
          ]);
        }),
      },
      directEmailRecovery: {
        scope: 'direct-ingest-routing-and-body-free-content-provenance',
        rows: emailIngestRows.flatMap((row) =>
          row.ingestMode === 'direct' &&
          (row.directRouting != null ||
            row.directRecoveryReason != null ||
            row.emailContentProvenance != null)
            ? [
                pick(row as Records['emailIngest'], [
                  'channelMessageId',
                  'directRouting',
                  'directRecoveryReason',
                  'emailContentProvenance',
                ]),
              ]
            : [],
        ),
      },
      securityIncidents: {
        incidents: securityIncidents.map((row) => {
          if (typeof row.id !== 'string' || !row.id)
            throw new Error('Privacy export found a malformed security incident identity');
          return pick(row as Records['securityIncidents'], [
            'id',
            'confidence',
            'revision',
            'disposition',
            'decisionRevision',
            'decisionReason',
            'materialChangeReason',
            'createdAt',
            'updatedAt',
          ]);
        }),
        sources: securityIncidentSources.map((row) => {
          if (typeof row.id !== 'string' || !row.id)
            throw new Error('Privacy export found a malformed security source identity');
          return pick(row as Records['securityIncidentSources'], [
            'id',
            'incidentId',
            'channelMessageId',
            'sourceMessageId',
            'mailboxHash',
            'evidenceFingerprint',
            'observedAt',
          ]);
        }),
        attention: securityIncidentAttention.map((row) => {
          if (typeof row.id !== 'string' || !row.id)
            throw new Error('Privacy export found a malformed security attention identity');
          return pick(row as Records['securityIncidentAttention'], [
            'id',
            'incidentId',
            'revision',
            'producer',
            'deliveryStatus',
            'createdAt',
            'updatedAt',
          ]);
        }),
        evidence: emailIngestRows.flatMap((row) => {
          if (row.securityIncidentId == null) return [];
          return [
            pick(row as Records['emailIngest'], [
              'channelMessageId',
              'securityIncidentId',
              'securityEvidence',
            ]),
          ];
        }),
      },
    };
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }
}
