/** Strip an arrival capability and source wording after the task is terminal. */
export function redactTerminalArrivalTask(
  trigger: unknown,
  agentId: string,
  externalEventId: string | null,
) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return undefined;
  const record = trigger as Record<string, unknown>;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  if ((payload as Record<string, unknown>).kind !== 'arrival') return undefined;

  // Keep only the generic kind marker; the once-per-owner-day key is retained
  // when it is in the safe format used by current arrivals. Older place-grid
  // keys are dropped at completion rather than copied into terminal history.
  const safeDedupeKey = new RegExp(`^arrival:${agentId}:\\d{4}-\\d{2}-\\d{2}$`).test(
    externalEventId ?? '',
  );
  const safeTrigger = {
    ...record,
    ...(safeDedupeKey ? { externalEventId } : {}),
    payload: { kind: 'arrival' },
  };
  return {
    trigger: safeTrigger,
    externalEventId: safeDedupeKey ? externalEventId : null,
    title: null,
    // Arrival tasks use no model-authored memory. Clearing a terminal state's
    // checkpoint also removes any stale pre-hardening context from legacy rows.
    state: {},
  };
}
