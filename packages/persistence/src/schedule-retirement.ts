// These two texts are the seed baseline and the exact 0026 forward edit. 0076
// changed only `enabled`; it did not record whether the owner had paused a row.
const DEFAULT_INSTRUCTIONS = new Set([
  "Prepare the owner's morning brief. Check: (1) today's events on your calendar and the owner's free/busy, (2) recent email in your inbox needing attention (gmail.search newer_than:1d), (3) goals list — anything slipping, (4) your own progress notes. Then send ONE concise brief via owner.notify: schedule, needs-attention items, and what you plan to do today. No fluff.",
  "Prepare the owner's morning brief. Check: (1) today's events on your calendar and the owner's free/busy, (2) recent email in your inbox needing attention (gmail.search newer_than:1d), (3) goals list — anything slipping, (4) upcoming occasions in the next several days (occasions.list) — birthdays or anniversaries to prepare for, (5) your own progress notes. Then send ONE concise brief via owner.notify: schedule, needs-attention items, any upcoming occasion, and what you plan to do today. No fluff.",
]);

/** Legacy portable schedules sometimes predate seed provenance. Only the two exact history signatures qualify. */
export function isHistoricalMorningBriefDefault(row: {
  cron: string;
  taskTemplate: unknown;
}): boolean {
  if (!row.taskTemplate || typeof row.taskTemplate !== 'object' || Array.isArray(row.taskTemplate))
    return false;
  const template = row.taskTemplate as Record<string, unknown>;
  return (
    row.cron === '30 7 * * *' &&
    template.type === 'scheduled' &&
    template.budgetUsdLimit === '0.10' &&
    typeof template.instruction === 'string' &&
    DEFAULT_INSTRUCTIONS.has(template.instruction) &&
    Object.keys(template).every((key) => ['type', 'budgetUsdLimit', 'instruction'].includes(key))
  );
}
