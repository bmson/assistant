import type { ScheduleRecord } from '@assistant/persistence';
import { expect, it } from 'vitest';
import { mobileAutomations } from './mobile-automations';

function schedule(name: string, template: Record<string, unknown>, seed = false): ScheduleRecord {
  return {
    id: name,
    name,
    agentId: 'owner',
    taskTemplate: template,
    enabled: false,
    cron: '0 8 * * *',
    nextRunAt: null,
    lastRunAt: null,
    seedTemplateKey: seed ? `assistant.schedule.${name}` : null,
    seedTemplateRevision: null,
    seedDefinition: null,
    seedReviewRequired: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

it('lists configured briefings and custom instructions while preserving pauses and dedicated destinations', () => {
  const rows = [
    schedule('daily-briefing', { job: 'briefing.compose' }, true),
    schedule('tomorrow-check', { instruction: 'Review tomorrow' }, true),
    schedule('self-repair', { job: 'self.repair' }),
    schedule('garden-check', { instruction: 'Review the garden' }),
    schedule('life-awareness', { instruction: 'Review' }),
    schedule('goal:1', { instruction: 'Review' }),
    schedule('reminder:1', { instruction: 'Review' }),
  ];
  const visible = mobileAutomations(rows);
  expect(visible.map((r) => [r.name, r.label])).toEqual([
    ['daily-briefing', 'Morning brief'],
    ['tomorrow-check', 'Evening look-ahead'],
    ['garden-check', null],
  ]);
  expect(visible.every((row) => row.visibleInAutomations && !row.enabled)).toBe(true);
  expect(mobileAutomations([schedule('weekly-review', {}, true)])[0]?.label).toBe('Weekly review');
});
