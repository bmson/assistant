import type { Records } from './records.js';

export type WatchRecord = Records['watches'];
export type WatchSuggestionContext = {
  watch: WatchRecord;
  fire: Records['watchFires'];
};
export type WatchFireEffectKind =
  | 'dashboard_notice'
  | 'owner_notification'
  | 'suggestion_enqueue'
  | 'suggestion_message';
export type WatchFireEffectStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'unknown'
  | 'skipped';
export type WatchFireEffect = Records['watchFireEffects'];
export type PreparedWatchSuggestion = {
  suggestion: Records['suggestions'];
  effect: WatchFireEffect;
};

export interface WatchCreateInput {
  agentId: string;
  conversationId?: string | null;
  kind: 'email' | 'web';
  tier: 'notify' | 'suggest';
  name: string;
  match: unknown;
  maxFires: number | null;
  expiresAt: Date;
  nextPollAt?: Date | null;
  pollIntervalSeconds?: number | null;
  state?: unknown;
}

export interface WatchRepository {
  readonly kind: 'watch-repository';
  create(input: WatchCreateInput): Promise<WatchRecord>;
  list(agentId: string, status?: string, limit?: number): Promise<WatchRecord[]>;
  cancel(
    agentId: string,
    watchId: string,
    now: Date,
  ): Promise<{ status: string; cancelled: boolean } | null>;
  expire(agentId: string | null, now: Date): Promise<number>;
  emailCandidates(agentId: string, now: Date): Promise<WatchRecord[]>;
  claimDueWeb(now: Date, batch: number, defaultIntervalSeconds: number): Promise<WatchRecord[]>;
  updateWeb(input: {
    watchId: string;
    state: unknown;
    now: Date;
    expire?: boolean;
    expectedNextPollAt: Date;
  }): Promise<boolean>;
  recordFire(input: {
    watchId: string;
    agentId: string;
    triggerRef: string;
    summary: string;
    excerpt: string;
    now: Date;
    state?: unknown;
    expectedNextPollAt?: Date;
  }): Promise<{ recorded: boolean; watch: WatchRecord | null; fireId?: string }>;
  pendingFireEffects(agentId: string, limit?: number): Promise<WatchFireEffect[]>;
  fireEffectsForFire(agentId: string, fireId: string): Promise<WatchFireEffect[]>;
  claimFireEffect(input: {
    agentId: string;
    effectId: string;
    now: Date;
    leaseMs: number;
  }): Promise<boolean>;
  finishFireEffect(input: {
    agentId: string;
    effectId: string;
    status: Exclude<WatchFireEffectStatus, 'pending' | 'sending'>;
    result?: unknown;
    now: Date;
  }): Promise<boolean>;
  recoverExpiredFireEffectClaims(agentId: string, now: Date): Promise<number>;
  getSuggestionContext(input: {
    agentId: string;
    watchId: string;
    triggerRef: string;
  }): Promise<WatchSuggestionContext | null>;
  getPreparedSuggestion(input: {
    agentId: string;
    watchId: string;
    triggerRef: string;
  }): Promise<PreparedWatchSuggestion | null>;
  commitSuggestion(input: {
    agentId: string;
    watchId: string;
    triggerRef: string;
    summary: string;
    proposedAction: string;
    now?: Date;
  }): Promise<{
    suggestion: Records['suggestions'];
    conversationId: string;
    fireId: string;
    watchName: string;
  } | null>;
}
