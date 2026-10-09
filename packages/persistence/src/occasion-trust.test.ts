import { describe, expect, it } from 'vitest';
import { canMergeOccasionObservation } from './occasion-trust.js';

describe('occasion observation trust', () => {
  it('does not launder a quarantined or lower-trust observation into a reviewed field', () => {
    const accepted = { originTrust: 'owner', quarantined: false, ownerConfirmed: true };
    expect(
      canMergeOccasionObservation(accepted, { originTrust: 'unknown', quarantined: true }),
    ).toBe(false);
    expect(
      canMergeOccasionObservation(accepted, { originTrust: 'assistant', quarantined: false }),
    ).toBe(false);
    expect(
      canMergeOccasionObservation(accepted, { originTrust: 'owner', quarantined: false }),
    ).toBe(true);
    expect(
      canMergeOccasionObservation(
        { originTrust: 'unknown', quarantined: false, ownerConfirmed: false },
        { originTrust: 'unknown', quarantined: true },
      ),
    ).toBe(false);
  });
});
