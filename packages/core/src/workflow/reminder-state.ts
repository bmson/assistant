interface ReminderEvidence {
  toolName: string;
  status: string;
  result?: unknown;
  fromCurrentTask?: boolean;
}
export interface EffectiveReminder {
  id: string;
  value: Record<string, unknown>;
  created: boolean;
  enabled: boolean;
  cancelled: boolean;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function reminderIdentity(value: unknown): string | undefined {
  const row = record(value);
  const id = row.reminderId ?? row.scheduleId;
  return typeof id === 'string' && id.trim() ? id : undefined;
}
/** Reduce the current task's chronological ledger. A cancelled identity cannot be resurrected by a stale read/replay. */
export function effectiveReminders(
  evidence: readonly ReminderEvidence[],
): Map<string, EffectiveReminder> {
  const states = new Map<string, EffectiveReminder>();
  const upsert = (value: unknown, created: boolean) => {
    const row = record(value),
      id = reminderIdentity(row);
    if (!id) return;
    const previous = states.get(id);
    const cancelled = previous?.cancelled === true;
    states.set(id, {
      id,
      value: {
        ...previous?.value,
        ...row,
        reminderId: id,
        ...(cancelled ? { enabled: false, nextFires: null } : {}),
      },
      created: created || previous?.created === true,
      enabled: !cancelled && row.enabled !== false,
      cancelled,
    });
  };
  for (const event of evidence) {
    const result = record(event.result);
    if (
      event.fromCurrentTask === false ||
      event.status !== 'succeeded' ||
      result.ok === false ||
      (typeof result.status === 'number' && result.status >= 400) ||
      (result.deliveryStatus !== undefined && result.deliveryStatus !== 'accepted')
    )
      continue;
    if (event.toolName === 'reminder.create' && result.created !== false) upsert(result, true);
    if (event.toolName === 'reminder.list' && Array.isArray(result.reminders))
      for (const row of result.reminders) upsert(row, false);
    if (event.toolName === 'reminder.cancel' && result.cancelled === true) {
      const id = reminderIdentity(result);
      if (!id) continue;
      const previous = states.get(id);
      states.set(id, {
        id,
        value: { ...previous?.value, ...result, reminderId: id, enabled: false, nextFires: null },
        created: previous?.created === true,
        enabled: false,
        cancelled: true,
      });
    }
  }
  return states;
}
