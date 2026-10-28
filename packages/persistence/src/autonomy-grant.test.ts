import { describe, expect, it } from 'vitest';
import {
  type AutonomyGrant,
  activeAutonomyGrant,
  ownerAutonomyGrantBindingMatches,
} from './autonomy-grant.js';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const grant: AutonomyGrant = {
  grantedAt: new Date(NOW - 1000).toISOString(),
  grantedVia: 'composer',
  expiresAt: new Date(NOW + 60_000).toISOString(),
  revokedAt: null,
};

describe('shared autonomy grant validation', () => {
  it('preserves the existing owner and assistant trust behavior', () => {
    expect(activeAutonomyGrant({ autonomyGrant: grant, trust: 'owner' }, NOW)).toEqual(grant);
    expect(activeAutonomyGrant({ autonomyGrant: grant, trust: 'assistant' }, NOW)).toEqual(grant);
    expect(activeAutonomyGrant({ autonomyGrant: grant, trust: 'known' }, NOW)).toBeNull();
  });

  it('fails closed for revoked, expired, malformed, future, and overlong grants', () => {
    const cases = [
      { ...grant, revokedAt: new Date(NOW).toISOString() },
      { ...grant, expiresAt: new Date(NOW).toISOString() },
      { ...grant, grantedAt: new Date(NOW + 1).toISOString() },
      { ...grant, expiresAt: new Date(NOW + 24 * 3_600_000 + 1).toISOString() },
      { ...grant, grantedVia: 'invalid' },
    ];
    for (const invalid of cases) {
      expect(activeAutonomyGrant({ autonomyGrant: invalid, trust: 'owner' }, NOW)).toBeNull();
    }
  });

  it('revalidates the identical direct-owner grant at repository time', () => {
    const expected = { trust: 'owner' as const, grant };
    expect(
      ownerAutonomyGrantBindingMatches(
        expected,
        { autonomyGrant: grant, trust: 'owner' },
        new Date(NOW),
      ),
    ).toBe(true);
    expect(
      ownerAutonomyGrantBindingMatches(
        expected,
        { autonomyGrant: { ...grant, revokedAt: new Date(NOW).toISOString() }, trust: 'owner' },
        new Date(NOW),
      ),
    ).toBe(false);
    expect(
      ownerAutonomyGrantBindingMatches(
        expected,
        { autonomyGrant: grant, trust: 'assistant' },
        new Date(NOW),
      ),
    ).toBe(false);
    expect(
      ownerAutonomyGrantBindingMatches(
        expected,
        { autonomyGrant: grant, trust: 'owner' },
        new Date(NOW + 60_000),
      ),
    ).toBe(false);
  });
});
