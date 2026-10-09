export interface CuriosityQuestionInput {
  agentId: string;
  key: string;
  question: string;
  taskId?: string;
  now: Date;
  observationFence: string | null;
}
export type CuriosityPushAdmission =
  | { status: 'queued'; destinations: number }
  | { status: 'held'; reason: 'quiet-hours' | 'daily-cap' }
  | { status: 'skipped'; reason: 'no-active-devices' }
  | { status: 'unknown'; reason: 'device-list-overflow' | 'malformed-device-registry' };
export type CuriosityQuestionOutcome =
  | {
      status: 'posted';
      conversationId: string;
      messageId: string;
      pushAdmission: CuriosityPushAdmission;
    }
  | { status: 'already-posted'; conversationId: string; messageId: string }
  | { status: 'legacy-unknown' };

/** A well-connected entity of the active graph, with its active outgoing degree. */
export interface GraphGapEntity {
  id: string;
  /** The preferred label when set, otherwise the extracted label. */
  label: string;
  kind: string;
  contactId: string | null;
  degree: number;
}

/** An active relation whose subject is one of the gap candidates. */
export interface GraphGapRelation {
  id: string;
  subjectEntityId: string;
  predicate: string;
  reviewStatus: string;
  confidence: string;
  /** The stated end of the fact's validity, as stored (a date or timestamp string). */
  validUntil: string | null;
  objectLabel: string;
}

/**
 * The `graph.curiosity` job's graph reads. Which gaps exist and how they are
 * phrased stay in core; the asked-gap ledger is the owner's suggestions.
 */
export interface GraphCuriosityRepository {
  readonly kind: 'graph-curiosity-repository';
  observationFence(agentId: string): Promise<string | null>;
  /** Commit the inert asked-gap marker and the visible question together. */
  admitQuestion(input: CuriosityQuestionInput): Promise<CuriosityQuestionOutcome>;
  /**
   * Entities with at least `minRelations` active outgoing relations, by label,
   * at most `maxCandidates`; and every active relation those entities head.
   * Active means what graph recall trusts: a live, unquarantined,
   * unsuperseded, embedded knowledge memory whose source is ready at
   * `extractionVersion` or later, and an unrejected relation with evidence.
   */
  gapInputs(
    agentId: string,
    input: { now: Date; minRelations: number; maxCandidates: number; extractionVersion: number },
  ): Promise<{ connected: GraphGapEntity[]; held: GraphGapRelation[] }>;
  /** The subset of gap `keys` already recorded in the asked-gap ledger. */
  askedKeys(agentId: string, keys: string[]): Promise<string[]>;
}
