import { describe, expect, it } from 'vitest';
import { type ReplayCase, type ReplayTick, scoreReplayCase } from './proactive-replay-score.js';

const fixture: ReplayCase = {
  id: 'CONTROL-SCORER',
  ticks: {
    arrival: { deliveries: 1, kind: 'mail-action', earliestMinutes: 5, latestMinutes: 10 },
    retry: { deliveries: 0, phase: 'suppressed', reason: 'no-candidates' },
  },
};
const moment = {
  kind: 'mail-action',
  exactSource: true,
  elapsedMinutes: 8,
  durableCard: true,
  groundedCard: true,
};
const arrival: ReplayTick = {
  name: 'arrival',
  elapsedMinutes: 8,
  candidates: 1,
  selected: 'mail-action',
  reason: null,
  moments: [moment],
  ownerNotices: 1,
  pushSinkCalls: 1,
  pushAcknowledged: true,
};
const retry: ReplayTick = {
  name: 'retry',
  elapsedMinutes: 90,
  candidates: 0,
  selected: null,
  reason: 'no-candidates',
  moments: [],
  ownerNotices: 0,
  pushSinkCalls: 0,
  pushAcknowledged: false,
};

describe('proactive replay scorer', () => {
  it('credits one evidenced delivery within the window and quiet retry', () => {
    expect(scoreReplayCase(fixture, [arrival, retry], {})).toMatchObject({
      passed: true,
      delivered: 1,
      expected: 1,
      matched: 1,
      quietViolations: 0,
    });
  });

  it.each([
    { ...moment, elapsedMinutes: 11 },
    { ...moment, exactSource: false },
    { ...moment, durableCard: false },
    { ...moment, groundedCard: false },
  ])('denies credit for unsupported, off-window, or non-durable delivery', (mutated) => {
    expect(scoreReplayCase(fixture, [{ ...arrival, moments: [mutated] }, retry], {})).toMatchObject(
      { passed: false, matched: 0 },
    );
  });

  it('counts a duplicate generic moment against quiet and precision', () => {
    expect(
      scoreReplayCase(fixture, [arrival, { ...retry, moments: [moment], pushSinkCalls: 1 }], {}),
    ).toMatchObject({ passed: false, matched: 1, delivered: 2, quietViolations: 1 });
  });

  it('scores a duplicate durable notice without a ledger entry against quiet', () => {
    expect(scoreReplayCase(fixture, [arrival, { ...retry, ownerNotices: 1 }], {})).toMatchObject({
      passed: false,
      matched: 1,
      delivered: 2,
      quietViolations: 1,
    });
  });

  it('keeps logical coverage independent from push acknowledgment', () => {
    expect(
      scoreReplayCase(fixture, [{ ...arrival, pushAcknowledged: false }, retry], {}),
    ).toMatchObject({ passed: false, matched: 0.5, delivered: 1 });
  });
});
