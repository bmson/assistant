import { describe, expect, it } from 'vitest';
import { googleHouseholdExtendedPurposesReady } from './google-calendar.js';

describe('Extended household calendar purposes', () => {
  it('admits only explicit local qualification', () => {
    expect(
      googleHouseholdExtendedPurposesReady(
        { GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_ENABLED: false },
        'test',
      ),
    ).toBe(false);
    const enabled = { GOOGLE_HOUSEHOLD_EXTENDED_PURPOSES_ENABLED: true };
    expect(googleHouseholdExtendedPurposesReady(enabled, 'test')).toBe(true);
    expect(googleHouseholdExtendedPurposesReady(enabled, 'development')).toBe(true);
    expect(googleHouseholdExtendedPurposesReady(enabled, 'production')).toBe(false);
    expect(googleHouseholdExtendedPurposesReady(enabled, '')).toBe(false);
  });
});
