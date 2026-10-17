export function shouldGenerateFinalEvidenceCard(input: {
  scoreboard: boolean;
  refreshCardId?: string;
  cardRequested: boolean;
  answerCardPreferred: boolean;
  specializedCardCount: number;
  refreshEvidenceAvailable: boolean;
  blocked: boolean;
  enabled: boolean;
  weeklyCalendarPlan: boolean;
  memoryRead?: boolean;
}): boolean {
  return (
    !input.scoreboard &&
    !input.weeklyCalendarPlan &&
    // Historical recall needs its checked attribution and uncertainty prose.
    // A source-grounded card does not prove that it preserves those distinctions.
    !(input.memoryRead && !input.cardRequested && !input.refreshCardId) &&
    (Boolean(input.refreshCardId) ||
      input.cardRequested ||
      input.answerCardPreferred ||
      input.specializedCardCount === 0) &&
    (!input.refreshCardId || input.refreshEvidenceAvailable) &&
    !input.blocked &&
    input.enabled
  );
}
