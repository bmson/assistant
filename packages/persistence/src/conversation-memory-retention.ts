/** Marker stored on the owner task that carried an ephemeral/fictional prompt. */
export const OWNER_TASK_MEMORY_RETENTION = 'ephemeral-v1' as const;

/**
 * Treat an owner turn as ephemeral only when it directly opts out of memory
 * retention, or clearly labels the supplied material as fictional/non-personal.
 * Quoted, blockquoted and fenced text is data, not a retention instruction.
 */
export function ownerTurnRequestsEphemeralMemory(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  const visible = text
    .slice(0, 32_000)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/(?:^|[\s([{])'[^'\n]{1,4000}'(?=$|[\s)\]},.!?])/g, ' ')
    .replace(/[“"][^”"]{0,4000}[”"]/g, ' ')
    .replace(/‘[^’]{0,4000}’/g, ' ')
    .replace(/’/g, "'")
    .replace(
      /\b(?:the|this)\s+(?:document|email|message|assistant|text|article)\s+(?:says|states|reads)\b[^.!?]{0,500}(?:[.!?]|$)/gi,
      ' ',
    )
    .toLowerCase()
    .replace(/\s+/g, ' ');

  const explicitOptOut =
    /\b(?:do not|don't|dont|never|please don't|please do not)\s+(?:save|store|remember|retain|keep)\b.{0,180}\b(?:memory|memories|personal facts?|personal information|anything from this conversation|this conversation)\b/.test(
      visible,
    ) ||
    /\b(?:do not|don't|dont|never|please don't|please do not)\s+(?:save|store|remember|retain|keep)\s+(?:anything|any of this|these details)\b.{0,100}\b(?:conversation|chat|memory|memories|personal)\b/.test(
      visible,
    );

  const contextualOptOut =
    /\b(?:do not|don't|dont|never|please don't|please do not)\s+(?:save|store|remember|retain|keep)\s+(?:anything|any of this|these details)\b/.test(
      visible,
    ) && ownerTurnReferencesEphemeralContext(visible);
  const scopedSaveOptOut =
    ownerTurnReferencesEphemeralContext(visible) &&
    /\b(?:do not|don't|dont|please don't|please do not)\b.{0,120}\b(?:or|and)\s+(?:save|store|remember|retain|keep)\s+anything\b/.test(
      visible,
    );
  if (explicitOptOut || contextualOptOut || scopedSaveOptOut) return true;

  const fictionalContext =
    /\b(?:fictional|hypothetical|made[- ]up|imaginary)\b.{0,100}\b(?:exercise|scenario|example|test|document|project|details|story|case)\b/.test(
      visible,
    ) ||
    /\b(?:exercise|scenario|example|test|document|project|details|story|case)\b.{0,100}\b(?:fictional|hypothetical|made[- ]up|imaginary)\b/.test(
      visible,
    );
  const explicitlyNonPersonal =
    /\bnot\s+(?:my\s+)?(?:personal|real)\s+(?:information|facts?|details)\b/.test(visible) ||
    /\b(?:not|isn't|aren't)\s+(?:about\s+)?(?:me|my\s+life|a real person)\b/.test(visible);
  const explicitExerciseFrame =
    /\b(?:for|in|during)\s+(?:this\s+)?(?:hypothetical|fictional)\s+(?:exercise|scenario|test|example)\b/.test(
      visible,
    ) ||
    /\b(?:fictional|hypothetical)\s+exercise\b/.test(visible) ||
    /\bthis\s+is\s+a\s+(?:hypothetical|fictional)\s+(?:exercise|scenario|test|example)\b/.test(
      visible,
    );

  return explicitExerciseFrame || (fictionalContext && explicitlyNonPersonal);
}

/** A tightly bounded same-chat reference may inherit only an ephemeral task. */
export function ownerTurnReferencesEphemeralContext(text: string): boolean {
  if (typeof text !== 'string' || text.length > 4000) return false;
  const visible = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/(?:^|[\s([{])'[^'\n]{1,1000}'(?=$|[\s)\]},.!?])/g, ' ')
    .replace(/[“"][^”"]{0,1000}[”"]/g, ' ')
    .replace(/‘[^’]{0,1000}’/g, ' ')
    .replace(/’/g, "'")
    .replace(
      /\b(?:the|this)\s+(?:document|email|message|assistant|text|article)\s+(?:says|states|reads)\b[^.!?]{0,500}(?:[.!?]|$)/gi,
      ' ',
    )
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return (
    /\b(?:using|based on|from)\s+(?:the\s+)?(?:fictional\s+)?project\s+details\s+(?:that\s+)?i\s+(?:just\s+)?gave\s+you\s+(?:in|during)\s+(?:this|our)\s+(?:conversation|chat)\b/.test(
      visible,
    ) ||
    /\b(?:using|based on|from)\s+(?:the\s+)?project\s+details\s+(?:from|in)\s+(?:this|our)\s+(?:conversation|chat)\b/.test(
      visible,
    ) ||
    /\b(?:using|based on|from)\s+(?:the\s+)?fictional\s+project\s+details\s+(?:from|in)\s+(?:this|our)\s+(?:conversation|chat)\b/.test(
      visible,
    ) ||
    /\b(?:using|based on|from)\s+(?:the\s+)?(?:fictional|hypothetical|project|scenario|exercise)\s+(?:details|facts|information|context)\s+(?:from|in)\s+(?:this|our)\s+(?:conversation|chat|exercise)\b/.test(
      visible,
    ) ||
    /\b(?:continue|use|apply|summarize)\s+(?:that|those|the same)\s+(?:fictional|hypothetical|project|scenario|exercise)\s+(?:details|facts|context)\b/.test(
      visible,
    )
  );
}

export function isOwnerTaskMemoryEphemeral(trigger: unknown): boolean {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return false;
  const row = trigger as Record<string, unknown>;
  const payload = row.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const payloadRow = payload as Record<string, unknown>;
  return (
    row.source === 'chat' &&
    row.trust === 'owner' &&
    typeof row.agentId === 'string' &&
    typeof row.conversationId === 'string' &&
    (payloadRow.memoryRetention === OWNER_TASK_MEMORY_RETENTION ||
      (typeof payloadRow.text === 'string' && ownerTurnRequestsEphemeralMemory(payloadRow.text)))
  );
}
