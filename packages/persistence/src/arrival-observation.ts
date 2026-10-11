const LEGACY_ARRIVAL_INSTRUCTION_PREFIX =
  'Accurate location observations at least three minutes apart suggest the owner has stopped near a new area:';
const LEGACY_ARRIVAL_EVENT_SUFFIX = /^\d{4}-\d{2}-\d{2}:-?\d+\.\d{2},-?\d+\.\d{2}$/;

/** Match only the instruction-only event envelope emitted by the old arrival producer. */
export function isLegacyArrivalTrigger(
  trigger: unknown,
  agentId: string,
  externalEventId: string | null | undefined,
): boolean {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return false;
  const record = trigger as Record<string, unknown>;
  if (
    record.source !== 'internal' ||
    record.agentId !== agentId ||
    record.trust !== 'assistant' ||
    typeof externalEventId !== 'string' ||
    !externalEventId.startsWith(`arrival:${agentId}:`) ||
    !LEGACY_ARRIVAL_EVENT_SUFFIX.test(externalEventId.slice(`arrival:${agentId}:`.length))
  )
    return false;
  if (record.externalEventId !== externalEventId) return false;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const entries = Object.entries(payload as Record<string, unknown>);
  const instruction = entries[0]?.[1];
  return (
    entries.length === 1 &&
    entries[0]?.[0] === 'instruction' &&
    typeof instruction === 'string' &&
    instruction.startsWith(LEGACY_ARRIVAL_INSTRUCTION_PREFIX)
  );
}

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
  if (
    (payload as Record<string, unknown>).kind !== 'arrival' &&
    !isLegacyArrivalTrigger(trigger, agentId, externalEventId)
  )
    return undefined;

  // Keep only the generic kind marker; the once-per-owner-day key is retained
  // when it is in the safe format used by current arrivals. Older place-grid
  // keys are dropped at completion rather than copied into terminal history.
  const safeDedupeKey = new RegExp(`^arrival:${agentId}:\\d{4}-\\d{2}-\\d{2}$`).test(
    externalEventId ?? '',
  );
  const baseTrigger = { ...record };
  delete baseTrigger.externalEventId;
  const safeTrigger = {
    ...baseTrigger,
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
