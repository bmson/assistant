import { describe, expect, it } from 'vitest';
import { modelRoutingReviewReport } from './model-routing-review.js';

describe('model routing review report', () => {
  it('does not claim the pre-0019 extract choice is known and avoids printing raw params', () => {
    const report = modelRoutingReviewReport([
      {
        id: 'revision-1',
        role: 'extract',
        beforeState: {
          primaryModel: 'deepseek/deepseek-chat',
          fallbackModel: 'custom',
          params: { temperature: 0.1 },
        },
        afterState: {
          primaryModel: 'current-default',
          fallbackModel: 'custom',
          params: { temperature: 0.1 },
        },
        source: 'retired-route-repair',
        baselineKnown: true,
        requiresOwnerReview: true,
        createdAt: new Date('2026-10-07T00:00:00Z'),
      },
    ]);
    expect(report).toMatchObject({
      automaticChanges: false,
      rows: [
        {
          historicalPre0019ExtractChoiceKnown: false,
          baselineCaptured: true,
          rollbackEligibility: 'conditional_on_current_models_being_enabled_and_priced',
          before: { primaryModel: 'deepseek/deepseek-chat', fallbackModel: 'custom' },
          after: { primaryModel: 'current-default', fallbackModel: 'custom' },
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain('temperature');
  });
});
