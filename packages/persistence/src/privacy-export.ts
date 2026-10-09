import type { Records } from './records.js';

type MemoryExportRow = Pick<
  Records['memories'],
  | 'id'
  | 'category'
  | 'kind'
  | 'content'
  | 'importance'
  | 'confidence'
  | 'originTrust'
  | 'quarantined'
  | 'domain'
  | 'ownerConfirmed'
  | 'pinned'
  | 'source'
  | 'createdAt'
  | 'expiresAt'
>;

type GraphEntityExportRow = Pick<
  Records['knowledgeGraphEntities'],
  | 'id'
  | 'canonicalKey'
  | 'label'
  | 'preferredLabel'
  | 'kind'
  | 'contactId'
  | 'createdAt'
  | 'updatedAt'
>;

type GraphAliasExportRow = Pick<
  Records['knowledgeGraphEntityAliases'],
  'canonicalKey' | 'entityId' | 'createdAt'
>;

type GraphRelationExportRow = Pick<
  Records['knowledgeGraphRelations'],
  | 'id'
  | 'subjectEntityId'
  | 'predicate'
  | 'objectEntityId'
  | 'sourceMemoryId'
  | 'evidenceQuote'
  | 'confidence'
  | 'validFrom'
  | 'validUntil'
  | 'reviewStatus'
  | 'createdAt'
>;
type GraphAssertionExportRow = Pick<
  Records['knowledgeGraphAssertions'],
  | 'id'
  | 'subjectEntityId'
  | 'predicate'
  | 'objectEntityId'
  | 'assertion'
  | 'qualifiers'
  | 'validFrom'
  | 'validUntil'
  | 'semanticRevision'
  | 'evidenceRevision'
  | 'lifecycle'
  | 'reviewStatus'
  | 'reviewedRevision'
  | 'ownerAuthored'
  | 'supersededById'
  | 'createdAt'
  | 'updatedAt'
>;
type GraphAssertionEvidenceExportRow = Pick<
  Records['knowledgeGraphAssertionEvidence'],
  | 'id'
  | 'assertionId'
  | 'sourceMemoryId'
  | 'sourceFingerprint'
  | 'sourceContentHash'
  | 'evidenceQuote'
  | 'sourceAuthor'
  | 'sourceTrust'
  | 'independent'
  | 'spanStart'
  | 'spanEnd'
  | 'extractionVersion'
  | 'evidenceRevision'
  | 'observedAt'
  | 'createdAt'
>;

export interface LongTermMemoryExportData {
  memories: MemoryExportRow[];
  knowledgeGraph: {
    entities: GraphEntityExportRow[];
    aliases: GraphAliasExportRow[];
    relations: GraphRelationExportRow[];
    assertions: GraphAssertionExportRow[];
    assertionEvidence: GraphAssertionEvidenceExportRow[];
  };
  people: Array<
    Pick<
      Records['contacts'],
      | 'id'
      | 'name'
      | 'aliases'
      | 'emails'
      | 'phones'
      | 'relationship'
      | 'trust'
      | 'notes'
      | 'createdAt'
      | 'updatedAt'
    >
  >;
  writingVoice: {
    samples: Array<
      Pick<Records['writingSamples'], 'id' | 'register' | 'text' | 'context' | 'createdAt'>
    >;
    profile: Omit<Records['voiceProfile'], 'id'> | null;
  };
  compiledOwnerCard: Records['ownerCard'] | null;
  situationPacks: Records['situationPacks'][];
  /** Work metadata only; source identity, source body, prepared result, and delivery data stay private. */
  emailObservers: {
    scope: 'observer-work-metadata-only';
    rows: Array<
      Pick<
        Records['emailObserverWork'],
        | 'observerKey'
        | 'observerVersion'
        | 'workClass'
        | 'status'
        | 'attemptCount'
        | 'budgetReserved'
        | 'budgetWindowStart'
        | 'createdAt'
        | 'completedAt'
      >
    >;
  };
  missionReports: Array<
    Pick<
      Records['missionReports'],
      | 'id'
      | 'missionId'
      | 'goalId'
      | 'conversationId'
      | 'outcome'
      | 'text'
      | 'chatStatus'
      | 'ownerStatus'
      | 'mirrorStatus'
      | 'createdAt'
      | 'chatDeliveredAt'
      | 'ownerDeliveredAt'
      | 'mirrorDeliveredAt'
    >
  >;
  /** Receipts only; routing targets, frozen bodies, errors, and lease data stay private. */
  notificationOutbox: {
    scope: 'delivery-receipts-only';
    rows: Array<
      Pick<
        Records['notificationOutbox'],
        | 'id'
        | 'deliveryKey'
        | 'legKey'
        | 'adapter'
        | 'status'
        | 'attempts'
        | 'retryable'
        | 'providerMessageId'
        | 'createdAt'
        | 'finishedAt'
      >
    >;
  };
  /** Opaque source identities and owner visibility controls; no source text or query. */
  recallSurfaces: {
    scope: 'source-identity-ledger-only';
    rows: Array<
      Pick<
        Records['recallSurfaces'],
        | 'sourceKey'
        | 'sourceRevision'
        | 'kind'
        | 'firstSurfacedAt'
        | 'lastSurfacedAt'
        | 'surfaceCount'
        | 'suppressedAt'
        | 'version'
      >
    >;
  };
  directEmailRecovery: {
    scope: 'direct-ingest-routing-and-body-free-content-provenance';
    rows: Array<
      Pick<
        Records['emailIngest'],
        'channelMessageId' | 'directRouting' | 'directRecoveryReason' | 'emailContentProvenance'
      >
    >;
  };
  securityIncidents: {
    incidents: Array<
      Pick<
        Records['securityIncidents'],
        | 'id'
        | 'confidence'
        | 'revision'
        | 'disposition'
        | 'decisionRevision'
        | 'decisionReason'
        | 'materialChangeReason'
        | 'createdAt'
        | 'updatedAt'
      >
    >;
    sources: Array<
      Pick<
        Records['securityIncidentSources'],
        | 'id'
        | 'incidentId'
        | 'channelMessageId'
        | 'sourceMessageId'
        | 'mailboxHash'
        | 'evidenceFingerprint'
        | 'observedAt'
      >
    >;
    attention: Array<
      Pick<
        Records['securityIncidentAttention'],
        'id' | 'incidentId' | 'revision' | 'producer' | 'deliveryStatus' | 'createdAt' | 'updatedAt'
      >
    >;
    evidence: Array<
      Pick<Records['emailIngest'], 'channelMessageId' | 'securityIncidentId' | 'securityEvidence'>
    >;
  };
}

export interface PrivacyExportRepository {
  readonly kind: 'privacy-export-repository';
  exportOwnerData(): Promise<LongTermMemoryExportData>;
}
