import { describe, expect, it } from 'vitest';
import { decideScheduleSeed } from './schedule-seed.js';

const desired = {
  key: 'assistant.schedule.daily-briefing',
  revision: 2,
  definition: { cron: '45 7 * * *', taskTemplate: { job: 'briefing.compose' } },
};

describe('schedule seed ownership', () => {
  it('inserts a new schedule with a versioned template identity', () => {
    expect(decideScheduleSeed(null, desired)).toMatchObject({
      kind: 'insert',
      seedTemplateKey: desired.key,
      seedTemplateRevision: 2,
    });
  });

  it('updates a known untouched seed definition', () => {
    expect(
      decideScheduleSeed(
        {
          cron: '45 7 * * *',
          taskTemplate: { job: 'briefing.compose' },
          seedTemplateKey: desired.key,
          seedTemplateRevision: 1,
          seedDefinition: { cron: '45 7 * * *', taskTemplate: { job: 'briefing.compose' } },
          seedReviewRequired: false,
        },
        desired,
      ),
    ).toMatchObject({ kind: 'update', seedTemplateRevision: 2 });
  });

  it('preserves owner cadence/instructions and paused state by requiring review', () => {
    expect(
      decideScheduleSeed(
        {
          cron: '0 9 * * 1-5',
          taskTemplate: { job: 'briefing.compose', instruction: 'My custom briefing' },
          seedTemplateKey: desired.key,
          seedTemplateRevision: 1,
          seedDefinition: { cron: '45 7 * * *', taskTemplate: { job: 'briefing.compose' } },
          seedReviewRequired: false,
        },
        desired,
      ),
    ).toEqual({ kind: 'review' });
  });

  it('adopts only a legacy row whose behavior exactly matches the supported default', () => {
    expect(
      decideScheduleSeed(
        {
          cron: '45 7 * * *',
          taskTemplate: { job: 'briefing.compose' },
          seedTemplateKey: null,
          seedTemplateRevision: null,
          seedDefinition: null,
          seedReviewRequired: false,
        },
        desired,
      ),
    ).toMatchObject({ kind: 'adopt', seedTemplateKey: desired.key });
  });

  it('does not guess ownership for customized legacy rows or repeat a revision', () => {
    expect(
      decideScheduleSeed(
        {
          cron: '30 7 * * *',
          taskTemplate: { job: 'briefing.compose', instruction: 'Owner version' },
          seedTemplateKey: null,
          seedTemplateRevision: null,
          seedDefinition: null,
          seedReviewRequired: false,
        },
        desired,
      ),
    ).toEqual({ kind: 'review' });
    expect(
      decideScheduleSeed(
        {
          cron: desired.definition.cron,
          taskTemplate: desired.definition.taskTemplate,
          seedTemplateKey: desired.key,
          seedTemplateRevision: 2,
          seedDefinition: desired.definition,
          seedReviewRequired: false,
        },
        desired,
      ),
    ).toEqual({ kind: 'keep' });
  });
});
