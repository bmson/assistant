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
}): boolean {
  return (
    !input.scoreboard &&
    !input.weeklyCalendarPlan &&
    (Boolean(input.refreshCardId) ||
      input.cardRequested ||
      input.answerCardPreferred ||
      input.specializedCardCount === 0) &&
    (!input.refreshCardId || input.refreshEvidenceAvailable) &&
    !input.blocked &&
    input.enabled
  );
}
