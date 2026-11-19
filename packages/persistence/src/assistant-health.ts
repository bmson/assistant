import type { MailHealthCounts, MailHealthWindow } from './proactive-health.js';

export const ASSISTANT_HEALTH_MONITOR_SCHEDULE = {
  name: 'assistant-health-monitor',
  cron: '15 * * * *',
  previousCron: '15 1 * * *',
  revision: 2,
  taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.02', job: 'health.monitor' },
} as const;

/** Operational counts the deterministic health monitor turns into owner alerts. */
export interface AssistantHealthObservations {
  /** GraphRAG sources quarantined after bounded retries. */
  graphQuarantined: number;
  /** GraphRAG sources still pending with a lease older than `staleBefore`. */
  graphStalePending: number;
  graphRecallFailures: number;
  historyRecallFailures: number;
  verifierUnavailable: number;
  contractBlocks: number;
  mustActRetries: number;
  degradedSteps: number;
}

export interface AssistantHealthSignal {
  kind: string;
  detail: string;
  /** Overrides the default reminder threshold and also applies after a reopen. */
  notificationDueBefore?: Date;
}

/**
 * Persistence for `health.monitor`. Thresholds and wording stay in core.
 * `claim` records every observed signal, resolves open alerts that are no
 * longer observed, and returns only the signals whose owner notification this
 * caller now owns: new, reopened, or due for the weekly reminder. `release`
 * undoes a claim whose notification could not be written, so a retry reports
 * it again.
 */
export interface AssistantHealthRepository {
  readonly kind: 'assistant-health-repository';
  observe(input: {
    agentId: string;
    staleBefore: Date;
    qualitySince: Date;
  }): Promise<AssistantHealthObservations>;
  observeMail?(agentId: string, window: MailHealthWindow): Promise<MailHealthCounts>;
  claim(input: {
    agentId: string;
    signals: readonly AssistantHealthSignal[];
    now: Date;
    renotifyBefore: Date;
  }): Promise<AssistantHealthSignal[]>;
  release(input: { agentId: string; kinds: readonly string[]; claimedAt: Date }): Promise<void>;
  /** Durable owner message in the Notifications conversation. */
  notify(input: { agentId: string; text: string; taskId?: string }): Promise<void>;
}
