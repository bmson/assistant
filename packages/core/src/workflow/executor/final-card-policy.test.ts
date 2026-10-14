import { describe, expect, it } from 'vitest';
import { shouldGenerateFinalEvidenceCard } from './final-card-policy.js';

const defaultInput = {
  scoreboard: false,
  cardRequested: false,
  answerCardPreferred: false,
  specializedCardCount: 0,
  refreshEvidenceAvailable: false,
  blocked: false,
  enabled: true,
  weeklyCalendarPlan: false,
};

describe('final evidence card composition policy', () => {
  it('keeps the normal fallback for answers without a specialized response card', () => {
    expect(shouldGenerateFinalEvidenceCard(defaultInput)).toBe(true);
  });

  it('does not let raw calendar window bounds become focus slots in a checked weekly plan', () => {
    expect(
      shouldGenerateFinalEvidenceCard({
        ...defaultInput,
        weeklyCalendarPlan: true,
        // Even an explicit card request must not turn query bounds into slots.
        cardRequested: true,
      }),
    ).toBe(false);
  });

  it('keeps the existing blocked, disabled, scoreboard, and refresh-evidence gates', () => {
    expect(shouldGenerateFinalEvidenceCard({ ...defaultInput, blocked: true })).toBe(false);
    expect(shouldGenerateFinalEvidenceCard({ ...defaultInput, enabled: false })).toBe(false);
    expect(shouldGenerateFinalEvidenceCard({ ...defaultInput, scoreboard: true })).toBe(false);
    expect(
      shouldGenerateFinalEvidenceCard({
        ...defaultInput,
        refreshCardId: 'card-1',
        refreshEvidenceAvailable: false,
      }),
    ).toBe(false);
  });
});
