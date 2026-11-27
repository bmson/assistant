import type { ReplayCase } from './proactive-replay-score.js';

const phoneAndTollWindow = {
  deliveries: 1,
  kind: 'bill-due',
  earliestMinutes: 11 * 24 * 60 - 4 * 60,
  latestMinutes: 11 * 24 * 60 + 4 * 60,
} as const;

const teacherMailWindow = {
  deliveries: 1,
  kind: 'mail-action',
  earliestMinutes: 8 * 60,
  latestMinutes: 12 * 60 - 1,
} as const;

export const teacherMessages = [
  { tick: 'next morning library message', subject: 'Return the library permission slip' },
  { tick: 'next morning science fair message', subject: 'Confirm the science fair table' },
  { tick: 'next morning photo message', subject: 'Send the class photo selection' },
] as const;

const originalDeliveryDate = '2026-12-09';
const revisedDeliveryDate = '2026-12-10';
const shipmentRef = 'SYN-DELIVERY-08';
export const deliveryMail = {
  threadId: 'synthetic-store-delivery',
  from: 'dispatch@example.test',
  original: {
    date: originalDeliveryDate,
    receivedAt: '2026-12-09T02:00:00.000Z',
    subject: 'Original store delivery date',
    body: `Store delivery ${shipmentRef} is scheduled for ${originalDeliveryDate}.`,
    sweepAt: '2026-12-09T16:05:00.000Z',
  },
  replacement: {
    date: revisedDeliveryDate,
    receivedAt: '2026-12-09T15:30:00.000Z',
    subject: 'Revised store delivery date',
    body: `Store delivery ${shipmentRef} was moved from ${originalDeliveryDate}. The current delivery date is ${revisedDeliveryDate}.`,
    sweepAt: '2026-12-10T16:05:00.000Z',
  },
};

const replacementAge = (ownerLocalTime: string) =>
  (Date.parse(`${revisedDeliveryDate}T${ownerLocalTime}:00-08:00`) -
    Date.parse(deliveryMail.replacement.receivedAt)) /
  60_000;

export const replayCases = {
  delivery: {
    id: 'S08',
    facts: {
      originalReceivedAt: deliveryMail.original.receivedAt,
      replacementReceivedAt: deliveryMail.replacement.receivedAt,
      originalSweepAt: deliveryMail.original.sweepAt,
      revisedSweepAt: deliveryMail.replacement.sweepAt,
      originalMailScanned: 2,
      revisedMailScanned: 1,
      authenticatedReplacement: true,
      shipmentThread: deliveryMail.threadId,
      originalSourceText: deliveryMail.original.body,
      replacementSourceText: deliveryMail.replacement.body,
    },
    ticks: {
      'original delivery date morning': {
        deliveries: 0,
        phase: 'suppressed',
        reason: 'quiet-briefing',
      },
      'revised delivery date morning': {
        deliveries: 1,
        kind: 'delivery-today',
        channel: 'stack',
        earliestMinutes: replacementAge('08:00'),
        latestMinutes: replacementAge('11:59'),
      },
    },
  },
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
  billLeadTime: {
    id: 'S13',
    facts: {
      phoneInvoiceSource: true,
      tollInvoiceSource: true,
      phoneDueAtWindow: true,
      tollDueAtWindow: true,
      sameDayInvoiceSource: true,
    },
    ticks: {
      'phone bill before the reminder day': {
        deliveries: 0,
        phase: 'pending',
        reason: 'no-candidates',
      },
      'toll bill before the reminder day': {
        deliveries: 0,
        phase: 'pending',
        reason: 'no-candidates',
      },
      'phone bill reminder at T-3': phoneAndTollWindow,
      'toll bill reminder at T-3': phoneAndTollWindow,
      'late-arriving bill due today': {
        deliveries: 1,
        kind: 'bill-due',
        earliestMinutes: 180,
        latestMinutes: 300,
        setup: true,
      },
    },
  },
  teachers: {
    id: 'S24',
    facts: { unreadSourceCount: 3, scriptedScores: 3 },
    ticks: {
      'before the next morning': { deliveries: 0, phase: 'pending', reason: 'no-candidates' },
      'next morning library message': teacherMailWindow,
      'next morning science fair message': teacherMailWindow,
      'next morning photo message': teacherMailWindow,
      'teacher mail replay': { deliveries: 0, phase: 'suppressed', reason: 'no-candidates' },
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
export function replayCardGrounded(caseId: string, card: ReplayCard, tick: string): boolean {
  switch (caseId) {
    case replayCases.delivery.id: {
      const text = [
        card.title,
        card.summary,
        ...(card.details ?? []).map(({ value }) => value),
      ].join(' ');
      const startsAt = card.startsAt;
      const revisedDate =
        startsAt === undefined
          ? text.includes(revisedDeliveryDate)
          : startsAt === revisedDeliveryDate ||
            (Number.isFinite(Date.parse(startsAt)) &&
              new Intl.DateTimeFormat('en-CA', {
                timeZone: 'America/Los_Angeles',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
              }).format(new Date(startsAt)) === revisedDeliveryDate);
      return (
        text.includes(shipmentRef) &&
        revisedDate &&
        /\b(?:is|will) (?:anyone|someone|somebody) (?:be )?(?:at )?home\b|\b(?:check|confirm) (?:if|whether) (?:anyone|someone|somebody) (?:is|will be) (?:at )?home\b/i.test(
          text,
        )
      );
    }
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
    case replayCases.billLeadTime.id:
      if (tick.startsWith('phone bill'))
        return (
          card.title === 'Invoice SYN-PHONE' && card.summary === '$39.00 due on December 6, 2026.'
        );
      if (tick.startsWith('toll bill'))
        return (
          card.title === 'Invoice SYN-TOLL' && card.summary === '$11.00 due on December 7, 2026.'
        );
      return (
        card.title === 'Invoice SYN-TODAY' && card.summary === '$28.00 due on December 6, 2026.'
      );
    case replayCases.teachers.id:
      return teacherMessages.some(
        (message) => message.tick === tick && message.subject === card.title,
      );
    case replayCases.control.id:
      return card.title === 'Confirm volunteer roster';
    default:
      return false;
  }
}
