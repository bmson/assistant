import { describe, expect, it } from 'vitest';
import { morningBriefRecoveryReport } from './schedule-retirement-report.js';

describe('morning-brief retirement report', () => {
  it('identifies the exact retired default without restoring or printing owner text', () => {
    const report = morningBriefRecoveryReport([
      {
        id: 'row-1',
        agentId: 'agent-1',
        enabled: false,
        cron: '30 7 * * *',
        taskTemplate: {
          type: 'scheduled',
          budgetUsdLimit: '0.10',
          instruction:
            "Prepare the owner's morning brief. Check: (1) today's events on your calendar and the owner's free/busy, (2) recent email in your inbox needing attention (gmail.search newer_than:1d), (3) goals list — anything slipping, (4) upcoming occasions in the next several days (occasions.list) — birthdays or anniversaries to prepare for, (5) your own progress notes. Then send ONE concise brief via owner.notify: schedule, needs-attention items, any upcoming occasion, and what you plan to do today. No fluff.",
        },
      },
    ]);
    expect(report).toMatchObject({
      automaticChanges: false,
      rows: [
        {
          classification: 'known-retired-default',
          currentEnabled: false,
          ownerPauseBefore0076Known: false,
          requiresOwnerReview: true,
          automaticAction: 'none',
          instructionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain('upcoming occasions');
  });

  it('flags customized cadence or instructions for owner review', () => {
    const [row] = morningBriefRecoveryReport([
      {
        id: 'row-2',
        agentId: 'agent-1',
        enabled: false,
        cron: '0 9 * * 1-5',
        taskTemplate: {
          type: 'scheduled',
          budgetUsdLimit: '0.10',
          instruction: 'Owner private text',
        },
        seedReviewRequired: true,
      },
    ]).rows;
    expect(row).toMatchObject({
      classification: 'custom-or-unrecognized',
      currentCron: '0 9 * * 1-5',
      requiresOwnerReview: true,
      ownerPauseBefore0076Known: false,
      automaticAction: 'none',
    });
    expect(JSON.stringify(row)).not.toContain('Owner private text');
  });
});
