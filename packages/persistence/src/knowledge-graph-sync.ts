export type KnowledgeGraphEntityKind =
  | 'person'
  | 'organization'
  | 'project'
  | 'place'
  | 'event'
  | 'date'
  | 'topic';

export interface KnowledgeGraphAssertion {
  tense: 'present' | 'past' | 'future' | 'unspecified';
  polarity: 'positive' | 'negative';
  modality: 'asserted' | 'possible' | 'conditional' | 'reported' | 'hypothetical' | 'unverified';
}

export interface KnowledgeGraphSyncSource {
  id: string;
  agentId: string;
  content: string;
  contentHash: string;
  /** Fences changes that retain a content hash, including embedding rewrites. */
  retrievalRevision: string;
  confidence: string;
  originTrust?: string;
  ownerConfirmed?: boolean;
  subjectContactId: string | null;
  createdAt: Date;
  validFrom?: Date | null;
  validUntil?: Date | null;
}

export interface KnowledgeGraphSyncClaim {
  /** Opaque ownership token. Only the current token may publish or fail a source. */
  token: string;
  attempts: number;
}

export interface KnowledgeGraphSyncContact {
  id: string;
  name: string;
  aliases: string[];
}

export interface KnowledgeGraphSyncContext {
  agentId: string;
  timeZone: string;
  locale: string;
  contacts: KnowledgeGraphSyncContact[];
}

export interface KnowledgeGraphProjectionEntity {
  canonicalKey: string;
  label: string;
  kind: KnowledgeGraphEntityKind;
  contactId: string | null;
  /** Contacts and canonical dates overwrite labels; other spellings only improve them. */
  authoritativeLabel: boolean;
}

export interface KnowledgeGraphProjectionRelation {
  subject: KnowledgeGraphProjectionEntity;
  predicate: string;
  assertion: KnowledgeGraphAssertion;
  object: KnowledgeGraphProjectionEntity;
  evidenceQuote: string;
  sourceFingerprint: string;
  ordinal: number;
  confidence: string;
  validFrom: string | null;
  validUntil: string | null;
  evidenceSpanStart?: number | null;
  evidenceSpanEnd?: number | null;
}

export interface KnowledgeGraphSyncRepository {
  readonly kind: 'knowledge-graph-sync-repository';
  now(): Date;
  hydrateContactLabels(agentId?: string): Promise<void>;
  candidates(input: {
    agentId?: string;
    limit: number;
    extractionVersion: number;
    leaseMs: number;
    now: Date;
  }): Promise<KnowledgeGraphSyncSource[]>;
  context(agentId: string): Promise<KnowledgeGraphSyncContext>;
  claim(input: {
    source: KnowledgeGraphSyncSource;
    extractionVersion: number;
    leaseMs: number;
    now: Date;
  }): Promise<KnowledgeGraphSyncClaim | null>;
  fail(input: {
    source: KnowledgeGraphSyncSource;
    claim: KnowledgeGraphSyncClaim;
    extractionVersion: number;
    status: 'failed' | 'quarantined';
    lastError: string;
    nextRetryAt: Date | null;
    now: Date;
  }): Promise<boolean>;
  replaceProjection(input: {
    source: KnowledgeGraphSyncSource;
    claim: KnowledgeGraphSyncClaim;
    extractionVersion: number;
    relations: KnowledgeGraphProjectionRelation[];
    /** Deterministic rejection summary; null means a valid empty or accepted projection. */
    lastError?: string | null;
    now: Date;
  }): Promise<{ relationships: number; entities: number } | null>;
  removeOrphanedEntities(agentId?: string): Promise<number>;
  pendingCount(input: {
    agentId?: string;
    extractionVersion: number;
    leaseMs: number;
    now: Date;
  }): Promise<number>;
  taskSpendUsd(taskId: string): Promise<number>;
}

export function isKnowledgeGraphSyncRepository(
  value: unknown,
): value is KnowledgeGraphSyncRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'knowledge-graph-sync-repository'
  );
}

/** A graph assertion cannot claim a wider truth interval than its source memory. */
export function boundGraphRelationToSource(
  relation: KnowledgeGraphProjectionRelation,
  source: Pick<KnowledgeGraphSyncSource, 'validFrom' | 'validUntil'> &
    Partial<Pick<KnowledgeGraphSyncSource, 'content'>>,
): KnowledgeGraphProjectionRelation | null {
  const period = (value: string | null, end: boolean): Date | null => {
    if (!value) return null;
    const partial = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
    if (partial) {
      const year = Number(partial[1]),
        month = Number(partial[2] ?? 1),
        day = Number(partial[3] ?? 1);
      return new Date(
        Date.UTC(
          year + (end && !partial[2] ? 1 : 0),
          month - 1 + (end && partial[2] && !partial[3] ? 1 : 0),
          day + (end && partial[3] ? 1 : 0),
        ),
      );
    }
    const at = new Date(value);
    if (!Number.isFinite(at.getTime())) throw new Error('Graph validity must be canonical');
    return at;
  };
  const quotedFrom = period(relation.validFrom, false);
  const quotedUntil = period(relation.validUntil, true);
  const from =
    source.validFrom && (!quotedFrom || source.validFrom > quotedFrom)
      ? source.validFrom
      : quotedFrom;
  const until =
    source.validUntil && (!quotedUntil || source.validUntil < quotedUntil)
      ? source.validUntil
      : quotedUntil;
  if (from && until && from >= until) return null;
  const quoteStart = source.content?.indexOf(relation.evidenceQuote) ?? -1;
  return {
    ...relation,
    validFrom: from === source.validFrom ? (from?.toISOString() ?? null) : relation.validFrom,
    validUntil: until === source.validUntil ? (until?.toISOString() ?? null) : relation.validUntil,
    evidenceSpanStart: quoteStart >= 0 ? quoteStart : (relation.evidenceSpanStart ?? null),
    evidenceSpanEnd:
      quoteStart >= 0
        ? quoteStart + relation.evidenceQuote.length
        : (relation.evidenceSpanEnd ?? null),
  };
}
