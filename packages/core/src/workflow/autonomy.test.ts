import { describe, expect, it } from 'vitest';
import {
  activeAutonomyGrant,
  autonomyFloorBlocks,
  buildAutonomyGrant,
  looksLikeAutonomyRequest,
} from './autonomy.js';

const NOW = 1_784_000_000_000;

describe('looksLikeAutonomyRequest', () => {
  it('matches explicit free-range instructions', () => {
    for (const text of [
      'Book the flight and do it autonomously, don’t ask me',
      'Handle the rescheduling — free range, no need to check with me',
      'Just do it, without asking',
      'Go ahead and send the replies, no need to ask',
      'You have my permission to book everything',
      'approve everything and get it done',
    ]) {
      expect(looksLikeAutonomyRequest(text)).toBe(true);
    }
  });

  it('does not match ordinary requests', () => {
    for (const text of [
      'Can you draft a reply to Anna?',
      'What time is my meeting tomorrow?',
      'Please ask them what time works',
      'I approved the budget last week',
    ]) {
      expect(looksLikeAutonomyRequest(text)).toBe(false);
    }
  });
});

describe('activeAutonomyGrant', () => {
  const grant = buildAutonomyGrant({ grantedVia: 'composer', nowMs: NOW });

  it('returns the grant when in force on an owner task', () => {
    expect(activeAutonomyGrant({ autonomyGrant: grant, trust: 'owner' }, NOW + 1000)).toEqual(
      grant,
    );
  });

  it('fails closed for malformed, future, reversed, oversized and unproven grants', () => {
    for (const invalid of [
      { ...grant, expiresAt: '' },
      { ...grant, expiresAt: 'invalid' },
      { ...grant, expiresAt: 'Infinity' },
      { ...grant, grantedAt: new Date(NOW + 1000).toISOString() },
      { ...grant, expiresAt: grant.grantedAt },
      { ...grant, expiresAt: new Date(NOW + 25 * 3_600_000).toISOString() },
      { ...grant, grantedVia: 'card' },
      { ...grant, revokedAt: '' },
    ])
      expect(activeAutonomyGrant({ autonomyGrant: invalid, trust: 'owner' }, NOW)).toBeNull();
    expect(activeAutonomyGrant({ autonomyGrant: grant, trust: 'owner' }, Number.NaN)).toBeNull();
    expect(
      activeAutonomyGrant({ autonomyGrant: grant, trust: 'owner' }, Date.parse(grant.expiresAt)),
    ).toBeNull();
    expect(() =>
      buildAutonomyGrant({ grantedVia: 'composer', nowMs: NOW, ttlHours: Infinity }),
    ).toThrow();
    expect(
      activeAutonomyGrant(
        {
          autonomyGrant: { ...grant, grantedVia: 'card', approvalId: 'approved-owner-card' },
          trust: 'owner',
        },
        NOW,
      ),
    ).not.toBeNull();
  });

  it('is null once expired, revoked, or on a non-owner task', () => {
    expect(
      activeAutonomyGrant({ autonomyGrant: grant, trust: 'owner' }, NOW + 25 * 3_600_000),
    ).toBeNull();
    expect(
      activeAutonomyGrant(
        { autonomyGrant: { ...grant, revokedAt: new Date(NOW).toISOString() }, trust: 'owner' },
        NOW + 1000,
      ),
    ).toBeNull();
    expect(activeAutonomyGrant({ autonomyGrant: grant, trust: 'known' }, NOW + 1000)).toBeNull();
    expect(activeAutonomyGrant({ autonomyGrant: null, trust: 'owner' }, NOW)).toBeNull();
    expect(activeAutonomyGrant({ autonomyGrant: { bogus: true }, trust: 'owner' }, NOW)).toBeNull();
  });
});

describe('autonomyFloorBlocks', () => {
  it('never lets a grant cross the hard floor', () => {
    // floor-flagged tool (interactive browser / networked code)
    expect(
      autonomyFloorBlocks({
        flags: { autonomyFloor: true },
        tainted: false,
        recipientUnverified: false,
      }),
    ).toBe(true);
    // memory write while tainted
    expect(
      autonomyFloorBlocks({
        flags: { writesMemory: true },
        tainted: true,
        recipientUnverified: false,
      }),
    ).toBe(true);
    // unverified recipient
    expect(autonomyFloorBlocks({ flags: {}, tainted: false, recipientUnverified: true })).toBe(
      true,
    );
  });

  it('allows an ordinary outward call (e.g. email to a known contact)', () => {
    expect(
      autonomyFloorBlocks({
        flags: { outwardFacing: true },
        tainted: false,
        recipientUnverified: false,
      } as never),
    ).toBe(false);
    // A memory write is fine when the session is NOT tainted.
    expect(
      autonomyFloorBlocks({
        flags: { writesMemory: true },
        tainted: false,
        recipientUnverified: false,
      }),
    ).toBe(false);
  });
});
