import type { Records } from './records.js';

/** Rows removed by one expiry pass, per data class. Reservations are the cost ledger's own. */
export interface ExpiredDataCounts {
  cache: number;
  memories: number;
  locations: number;
  dreamNotes: number;
  proactivePings: number;
  modelCallAudit: number;
}

export interface AgedHistoryCounts {
  messages: number;
  toolCalls: number;
  modelCalls: number;
  costEvents: number;
}

/**
 * The recurring maintenance sweep's portable steps. Each scan is bounded; a
 * scan that can skip rows it must keep (anchored history, a task whose notice
 * failed) advances a durable cursor so those rows cannot starve later ones.
 */
export interface MaintenanceRepository {
  readonly kind: 'maintenance-repository';
  /** Retire pending or snoozed suggestions whose TTL has passed. */
  expireSuggestions(now?: Date): Promise<number>;
  /** Waiting-on-owner tasks never stamped as notified. May be empty while the cursor has more pages. */
  listStalledAttention(input: {
    olderThanMinutes: number;
    batch: number;
    now?: Date;
  }): Promise<Records['tasks'][]>;
  /**
   * Post the notice to the task's own conversation, or to Notifications for a
   * conversation-less assistant task. False when there is nowhere to post.
   */
  postAttentionNotice(input: { taskId: string; text: string; parts: unknown[] }): Promise<boolean>;
  /** Post a budget threshold notice to Notifications once per key. False when already sent. */
  postBudgetNotice(input: {
    cacheKey: string;
    pct: number;
    expiresAt: Date;
    text: string;
  }): Promise<boolean>;
  /**
   * Embed user/assistant messages longer than 20 characters that lack a vector
   * in the configured embedding space, and store each vector with that space.
   * A message changed since it was read is skipped. Returns messages embedded.
   */
  embedMissingMessages(input: {
    batch: number;
    embeddingSpaceKey: string;
    embed: (texts: string[]) => Promise<number[][]>;
  }): Promise<number>;
  purgeExpired(input: {
    now?: Date;
    batch: number;
    locationRetentionDays: number;
    proactivePingRetentionDays: number;
    auditRetentionDays: number;
  }): Promise<ExpiredDataCounts>;
  /** A zero retention window keeps that class forever. */
  purgeAgedHistory(input: {
    now?: Date;
    historyDays: number;
    costDays: number;
    batch: number;
  }): Promise<AgedHistoryCounts>;
}
