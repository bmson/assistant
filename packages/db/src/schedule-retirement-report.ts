import { createHash } from 'node:crypto';

import { isHistoricalMorningBriefDefault } from '@assistant/persistence';

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
      const knownDefault = isHistoricalMorningBriefDefault(row);
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
