import { isHistoricalMorningBriefDefault, type ScheduleRecord } from '@assistant/persistence';

const rhythms = new Map([
  ['daily-briefing', 'Morning brief'],
  ['tomorrow-check', 'Evening look-ahead'],
  ['weekly-review', 'Weekly review'],
]);

export function mobileAutomations(schedules: readonly ScheduleRecord[]) {
  return schedules.flatMap((row) => {
    const label = rhythms.get(row.name);
    if (!label) {
      const template = row.taskTemplate as { job?: unknown; instruction?: unknown } | null;
      if (
        row.seedTemplateKey ||
        row.name === 'life-awareness' ||
        row.name.startsWith('reminder:') ||
        row.name.startsWith('goal:') ||
        typeof template?.instruction !== 'string' ||
        !template.instruction.trim() ||
        template.job ||
        (row.name === 'morning-brief' && isHistoricalMorningBriefDefault(row))
      )
        return [];
    }
    return [
      {
        id: row.id,
        name: row.name,
        label: label ?? null,
        visibleInAutomations: true,
        cron: row.cron,
        enabled: row.enabled,
        nextRunAt: row.nextRunAt,
        lastRunAt: row.lastRunAt,
      },
    ];
  });
}
