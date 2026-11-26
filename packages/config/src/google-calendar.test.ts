import { describe, expect, it } from 'vitest';
import { googleHouseholdExtendedPurposesReady } from './google-calendar.js';

describe('Extended household calendar purposes', () => {
  const disabled = {
    GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_ENABLED: false,
    GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_COMPATIBILITY_CONFIRMED: false,
  };
  const enabled = { ...disabled, GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_ENABLED: true };
  const qualified = {
    ...enabled,
    GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_COMPATIBILITY_CONFIRMED: true,
  };

  it('requires opt-in in development and test', () => {
    expect(googleHouseholdExtendedPurposesReady(disabled, 'test')).toBe(false);
    expect(googleHouseholdExtendedPurposesReady(enabled, 'test')).toBe(true);
    expect(googleHouseholdExtendedPurposesReady(enabled, 'development')).toBe(true);
  });

  it('requires both installation qualification and opt-in in production', () => {
    expect(googleHouseholdExtendedPurposesReady(disabled, 'production')).toBe(false);
    expect(googleHouseholdExtendedPurposesReady(enabled, 'production')).toBe(false);
    expect(googleHouseholdExtendedPurposesReady(qualified, 'production')).toBe(true);
    expect(
      googleHouseholdExtendedPurposesReady(
        { ...qualified, GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_ENABLED: false },
        'production',
      ),
    ).toBe(false);
    expect(googleHouseholdExtendedPurposesReady(qualified, '')).toBe(false);
  });
});
