import { createHash } from 'node:crypto';
import type { SituationDecisionContext, SituationPackView } from './situations-schema.js';

/** Stable, opaque revision for one exact persisted conversation message body. */
export function conversationMessageSourceRevision(messageId: string, text: string): string {
  return createHash('sha256').update(messageId).update('\0').update(text).digest('hex');
}

/** Occasion fields the `occasions.save` tool records for one named person. */
export interface OccasionToolSaveInput {
  agentId: string;
  /** The person's name as the model gave it; the adapter resolves or creates the contact. */
  subject: string;
  kind: 'birthday' | 'anniversary' | 'custom';
  label: string;
  month: number;
  day: number;
  year: number | null;
  leadDays: number;
  notes: string;
  originTrust: string;
  quarantined: boolean;
  source: string;
}

/** A non-quarantined occasion joined to its person's current name. */
export interface OccasionToolRow {
  id: string;
  contactId: string;
  contactName: string;
  kind: string;
  label: string;
  month: number;
  day: number;
  year: number | null;
  recurrence: string;
  leadDays: number;
  notes: string;
}

/** Storage behind `occasions.save` and `occasions.list`. */
export interface OccasionToolRepository {
  /** Null when the subject resolves to no person. `saved` is false when an existing date merged. */
  save(input: OccasionToolSaveInput): Promise<{ saved: boolean } | null>;
  list(agentId: string): Promise<OccasionToolRow[]>;
}

export interface ContactLookupRow {
  name: string;
  emails: string[];
  phones: string[];
  relationship: string;
}

/** Read-only name lookup behind `contacts.lookup`. It never creates a contact. */
export interface ContactLookupRepository {
  findByName(input: { agentId: string; query: string }): Promise<ContactLookupRow[]>;
}

export interface ConversationSearchMatch {
  messageId: string;
  /** Revision of this exact message body, suitable for stale-source checks. */
  sourceRevision: string;
  conversationId: string;
  text: string;
  createdAt: Date;
}

/** Owner-scoped message search behind `conversations.search`. */
export interface ConversationSearchSourceRef {
  messageId: string;
  conversationId: string;
  sourceRevision: string;
}

export interface ConversationSearchRefreshResult {
  /** Whether each supplied reference still names the same visible owner source. */
  unchangedSourceRefs: boolean[];
  /** Bounded literal substring results, never represented as semantic ranking. */
  matches: ConversationSearchMatch[];
  mode: 'text';
  /** Exact erasure generation observed while validating references and reading matches. */
  observationGeneration: string | null;
}

export interface ConversationSearchRepository {
  /** Validate exact stored search source identities without rerunning a query. */
  validateSources?(input: {
    agentId: string;
    currentConversationId?: string;
    sourceRefs: ConversationSearchSourceRef[];
  }): Promise<{ unchangedSourceRefs: boolean[]; observationGeneration: string | null }>;
  refreshForResume(input: {
    agentId: string;
    currentConversationId?: string;
    query: string;
    limit: number;
    sourceRefs: ConversationSearchSourceRef[];
  }): Promise<ConversationSearchRefreshResult>;
  semantic(input: {
    agentId: string;
    embedding: number[];
    /** Identity reported by the model router for this exact query vector. */
    embeddingSpaceKey: string;
    /** Authenticated current task conversation; only this thread bypasses an erase cutoff. */
    currentConversationId?: string;
    limit: number;
  }): Promise<Array<ConversationSearchMatch & { similarity: number }>>;
  /** Case-insensitive substring match, newest first. */
  text(input: {
    agentId: string;
    query: string;
    limit: number;
    /** Authenticated current task conversation; only this thread bypasses an erase cutoff. */
    currentConversationId?: string;
  }): Promise<ConversationSearchMatch[]>;
}

export interface SituationPackSource {
  kind: 'card' | 'commitment';
  id: string;
  title: string;
  lane: 'plan' | 'i_owe' | 'waiting_on';
}

export interface SituationDecisionMatch {
  id: string;
  option: string;
  outcome: 'chosen' | 'rejected';
  reason: string;
  scope: 'situation' | 'preference';
  confirmed: boolean;
  packId: string;
  packTitle: string;
}

export type SituationCommandResult =
  | {
      ok: true;
      packId: string;
      preview?: {
        id: string;
        packId: string;
        baseVersion: number;
        before: unknown;
        after: unknown;
        affectedIds: string[];
        unknowns: string[];
        expiresAt: string;
      };
    }
  | { ok: false; error: string };

/** Owner-scoped situation packs behind the `situations.*` tools. */
export interface SituationToolRepository {
  list(agentId: string): Promise<SituationPackView[]>;
  get(agentId: string, packId: string): Promise<SituationPackView | null>;
  sources(agentId: string): Promise<SituationPackSource[]>;
  decisions(agentId: string, query: string, packId?: string): Promise<SituationDecisionMatch[]>;
  /** Tool commands never carry owner confirmation. */
  command(agentId: string, input: unknown): Promise<SituationCommandResult>;
}

/** Read-only situation choices used to ground owner chat before planning. */
export interface SituationDecisionContextRepository {
  readonly kind: 'situation-decision-context-repository';
  retrieve(input: {
    agentId: string;
    discussionFrame: string;
    limit?: number;
  }): Promise<SituationDecisionContext[]>;
}
