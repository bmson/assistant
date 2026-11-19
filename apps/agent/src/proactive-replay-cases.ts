import type { ReplayCase } from './proactive-replay-score.js';

export const replayCases = {
  practice: {
    id: 'S16',
    facts: {
      eligible: true,
      pipelineStage: 'message_persisted',
      field: 'North Field',
      replayAdmission: 'skipped',
    },
    ticks: {
      'change received': {
        deliveries: 1,
        kind: 'practice-change',
        earliestMinutes: 0,
        latestMinutes: 60,
      },
      'source replay': { deliveries: 0, phase: 'suppressed', reason: 'no-candidates' },
      'morning briefing': { deliveries: 0, phase: 'suppressed', reason: 'quiet-briefing' },
    },
  },
  cancellation: {
    id: 'S17',
    facts: { providerStatus: 'cancelled' },
    ticks: {
      'explicit calendar cancellation': {
        deliveries: 1,
        kind: 'calendar-cancelled',
        earliestMinutes: 0,
        latestMinutes: 20,
      },
    },
  },
  bill: {
    id: 'S14',
    facts: {
      beforePayment: 'due',
      afterWrongReceipt: 'due',
      afterPayment: 'paid',
      exactReceipt: true,
    },
    ticks: {
      'bill due': {
        deliveries: 1,
        kind: 'bill-due',
        earliestMinutes: 180,
        latestMinutes: 300,
        setup: true,
      },
      'paid pulse': { deliveries: 0, phase: 'suppressed', reason: 'no-candidates' },
      'out-of-order paid pulse': { deliveries: 0, phase: 'suppressed', reason: 'no-candidates' },
      'paid morning briefing': { deliveries: 0, phase: 'suppressed', reason: 'quiet-briefing' },
      'payment wins admission race': { deliveries: 0, phase: 'suppressed', reason: 'stale-source' },
    },
  },
  control: {
    id: 'CONTROL-GENERIC-MAIL',
    facts: { eligible: true, scriptedScores: 1, wrongHeadReads: 1 },
    ticks: {
      'before minimum source age': { deliveries: 0, phase: 'pending', reason: 'no-candidates' },
      'wrong thread head': { deliveries: 0, phase: 'suppressed', reason: 'no-candidates' },
      'matching thread head': {
        deliveries: 1,
        kind: 'mail-action',
        earliestMinutes: 180,
        latestMinutes: 300,
      },
      'generic source replay': { deliveries: 0, phase: 'suppressed', reason: 'no-candidates' },
    },
  },
} satisfies Record<string, ReplayCase>;

interface ReplayCard {
  id?: string;
  kind?: string;
  title?: string;
  summary?: string;
  urgencyLabel?: string;
  startsAt?: string;
  details?: Array<{ label: string; value: string }>;
}

/** Check owner-visible fixture facts, independently of ledger kind and key. */
export function replayCardGrounded(caseId: string, card: ReplayCard): boolean {
  switch (caseId) {
    case replayCases.practice.id:
      return (
        card.startsAt === '2026-11-20T01:30:00.000Z' &&
        card.summary ===
          'Was Tomorrow 4:30 PM at South Field, now Tomorrow 5:30 PM at North Field.' &&
        card.details?.some(
          (detail) =>
            detail.label === 'Source' &&
            detail.value === 'coach@example.test · Thursday practice update',
        ) === true &&
        card.details?.some(
          (detail) => detail.label === 'Next step' && detail.value.trim() !== '',
        ) === true
      );
    case replayCases.cancellation.id:
      return card.title === 'Thursday skills session' && card.urgencyLabel === 'Cancelled';
    case replayCases.bill.id:
      return (
        card.title === 'Invoice SYN-104' && card.summary === '$42.15 due on November 20, 2026.'
      );
    case replayCases.control.id:
      return card.title === 'Confirm volunteer roster';
    default:
      return false;
  }
}
