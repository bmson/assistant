import { describe, expect, it } from 'vitest';
import {
  type PhoneCalendarSharingState,
  parsePhoneCalendarSharingState,
  phoneCalendarSharingErasureTombstone,
  transitionPhoneCalendarSharing,
} from './phone-calendar-sharing.js';

const now = new Date('2026-10-22T12:00:00.000Z');
const ownerId = 'owner-id';
const oldState: PhoneCalendarSharingState = {
  version: 1,
  ownerId,
  publisherId: 'old-device',
  generation: 4,
  enabled: true,
  consentVersion: 1,
  calendars: [{ id: 'work', name: 'Private Work', purpose: 'commitments' }],
  mutationId: 'old-enable',
  capturedAt: '2026-10-21T12:00:00.000Z',
  receivedAt: '2026-10-21T12:01:00.000Z',
  timeMin: '2026-10-20T00:00:00.000Z',
  timeMax: '2026-10-29T00:00:00.000Z',
  complete: true,
  truncated: false,
  updatedAt: '2026-10-21T12:01:00.000Z',
};

describe('phone calendar sharing erasure tombstone', () => {
  it('increments the generation and removes publisher, labels, and snapshot metadata', () => {
    const tombstone = phoneCalendarSharingErasureTombstone(ownerId, oldState, now);

    expect(tombstone).toEqual({
      version: 1,
      ownerId,
      publisherId: null,
      generation: 5,
      enabled: false,
      consentVersion: 0,
      calendars: [],
      updatedAt: now.toISOString(),
    });
  });

  it('starts a minimal generation-one tombstone when no sharing row existed', () => {
    expect(phoneCalendarSharingErasureTombstone(ownerId, null, now)).toEqual({
      version: 1,
      ownerId,
      publisherId: null,
      generation: 1,
      enabled: false,
      consentVersion: 0,
      calendars: [],
      updatedAt: now.toISOString(),
    });
  });

  it('is idempotent for a scrubbed tombstone and rejects a delayed initial enable', () => {
    const tombstone = phoneCalendarSharingErasureTombstone(ownerId, oldState, now);
    expect(phoneCalendarSharingErasureTombstone(ownerId, tombstone, new Date('2026-10-23'))).toBe(
      tombstone,
    );

    const delayed = transitionPhoneCalendarSharing(ownerId, tombstone, {
      command: 'enable',
      publisherId: 'old-device',
      expectedGeneration: 0,
      mutationId: 'old-enable',
      consentVersion: 1,
      calendars: [{ id: 'work', name: 'Private Work', purpose: 'commitments' }],
    });
    expect(delayed.result).toMatchObject({ ok: false, error: 'stale_generation' });
    expect(delayed.result.state).toBe(tombstone);
  });

  it('does not inherit a foreign owner counter or malformed generation', () => {
    const foreign = phoneCalendarSharingErasureTombstone(
      ownerId,
      { ...oldState, ownerId: 'another-owner', generation: 90 },
      now,
    );
    const malformed = phoneCalendarSharingErasureTombstone(
      ownerId,
      { ...oldState, generation: 4.5 },
      now,
    );

    expect(foreign.generation).toBe(1);
    expect(malformed.generation).toBe(1);
    expect(foreign.ownerId).toBe(ownerId);
    expect(malformed.calendars).toEqual([]);
  });

  it('refuses to wrap an exhausted safe generation counter', () => {
    expect(() =>
      phoneCalendarSharingErasureTombstone(
        ownerId,
        { ...oldState, generation: Number.MAX_SAFE_INTEGER },
        now,
      ),
    ).toThrow('generation is exhausted');
  });
});

describe('phone calendar sharing persisted v1 parser', () => {
  it('accepts only owner-matched v1 states with a safe integer generation and known fields', () => {
    const tombstone = phoneCalendarSharingErasureTombstone(ownerId, oldState, now);
    expect(parsePhoneCalendarSharingState(tombstone, ownerId)).toEqual(tombstone);
    expect(parsePhoneCalendarSharingState(tombstone, 'another-owner')).toBeNull();
    expect(parsePhoneCalendarSharingState({ ...tombstone, generation: 1.5 }, ownerId)).toBeNull();
    expect(parsePhoneCalendarSharingState({ ...tombstone, privateLabel: 'secret' }, ownerId)).toBe(
      null,
    );
  });
});
