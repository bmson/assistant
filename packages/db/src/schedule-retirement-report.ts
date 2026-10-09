import { createHash } from 'node:crypto';

// These two texts are the seed baseline and the exact 0026 forward edit. 0076
// changed only `enabled`; it did not record whether the owner had paused a row.
const DEFAULT_INSTRUCTIONS = new Set([
  "Prepare the owner's morning brief. Check: (1) today's events on your calendar and the owner's free/busy, (2) recent email in your inbox needing attention (gmail.search newer_than:1d), (3) goals list — anything slipping, (4) your own progress notes. Then send ONE concise brief via owner.notify: schedule, needs-attention items, and what you plan to do today. No fluff.",
  "Prepare the owner's morning brief. Check: (1) today's events on your calendar and the owner's free/busy, (2) recent email in your inbox needing attention (gmail.search newer_than:1d), (3) goals list — anything slipping, (4) upcoming occasions in the next several days (occasions.list) — birthdays or anniversaries to prepare for, (5) your own progress notes. Then send ONE concise brief via owner.notify: schedule, needs-attention items, any upcoming occasion, and what you plan to do today. No fluff.",
]);

export interface MorningBriefRow {
  id: string;
  agentId: string;
  enabled: boolean;
  cron: string;
  taskTemplate: unknown;
  seedReviewRequired?: boolean;
}

export function morningBriefRecoveryReport(rows: readonly MorningBriefRow[]) {
  return {
    generatedAt: new Date().toISOString(),
    automaticChanges: false,
    rows: rows.map((row) => {
      const template = row.taskTemplate as Record<string, unknown> | null;
      const instruction = typeof template?.instruction === 'string' ? template.instruction : '';
      const knownDefault =
        row.cron === '30 7 * * *' &&
        template?.type === 'scheduled' &&
        template?.budgetUsdLimit === '0.10' &&
        DEFAULT_INSTRUCTIONS.has(instruction) &&
        Object.keys(template ?? {}).every((key) =>
          ['type', 'budgetUsdLimit', 'instruction'].includes(key),
        );
      return {
        scheduleId: row.id,
        agentId: row.agentId,
        classification: knownDefault ? 'known-retired-default' : 'custom-or-unrecognized',
        currentEnabled: row.enabled,
        currentCron: row.cron,
        instructionSha256: instruction
          ? createHash('sha256').update(instruction).digest('hex')
          : null,
        seedReviewRequired: row.seedReviewRequired === true,
        ownerPauseBefore0076Known: false,
        requiresOwnerReview: !knownDefault || !row.enabled || row.seedReviewRequired === true,
        automaticAction: 'none',
      };
    }),
  };
}
