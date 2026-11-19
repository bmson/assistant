import { describe, expect, it } from 'vitest';
import {
  type ReplayCase,
  type ReplayTick,
  scoreReplayCase,
  scoreReplayKinds,
} from './proactive-replay-score.js';

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
  durablePushAcknowledged: true,
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

  it('counts a push-only false alarm towards delivered notices and quiet violations', () => {
    expect(
      scoreReplayCase(
        fixture,
        [arrival, { ...retry, pushSinkCalls: 1, pushAcknowledged: true }],
        {},
      ),
    ).toMatchObject({ passed: false, matched: 1, delivered: 2, quietViolations: 1 });
  });

  it('keeps a failed setup delivery outside the benchmark denominator', () => {
    const setup: ReplayCase = {
      id: 'S14',
      ticks: {
        arrival: {
          deliveries: 1,
          kind: 'mail-action',
          earliestMinutes: 5,
          latestMinutes: 10,
          setup: true,
        },
      },
    };
    expect(
      scoreReplayCase(setup, [{ ...arrival, moments: [{ ...moment, exactSource: false }] }], {}),
    ).toMatchObject({ passed: false, delivered: 1, setupDeliveries: 1, setupMatches: 0 });
  });

  it.each([
    { ...arrival, pushAcknowledged: false },
    { ...arrival, moments: [{ ...moment, durablePushAcknowledged: false }] },
  ])('keeps logical coverage independent from missing push acknowledgment', (incomplete) => {
    expect(scoreReplayCase(fixture, [incomplete, retry], {})).toMatchObject({
      passed: false,
      matched: 0.5,
      delivered: 1,
    });
  });
});

describe('per-kind replay score', () => {
  const score = (ticks: ReplayTick[]) => scoreReplayKinds([scoreReplayCase(fixture, ticks, {})]);

  it.each([
    { ...moment, elapsedMinutes: 11 },
    { ...moment, elapsedMinutes: 4 },
    { ...moment, exactSource: false },
    { ...moment, durableCard: false },
    { ...moment, groundedCard: false },
  ])('records timing without awarding credit for invalid delivery', (invalid) => {
    expect(score([{ ...arrival, moments: [invalid] }, retry])).toMatchObject([
      {
        kind: 'mail-action',
        expected: 1,
        delivered: 1,
        matched: 0,
        recall: 0,
        precision: 0,
        misses: 1,
        falsePositives: 1,
        expectations: [{ earliestMinutes: 5, latestMinutes: 10, credit: 0 }],
        observedTiming: [{ tick: 'arrival', elapsedMinutes: invalid.elapsedMinutes }],
      },
    ]);
  });

  it('retains missed deliveries and missing quiet observations', () => {
    const result = scoreReplayCase(fixture, [], {});
    expect(scoreReplayKinds([result])).toMatchObject([
      { kind: 'mail-action', expected: 1, delivered: 0, recall: 0, precision: null, misses: 1 },
    ]);
    expect(result.quietChecks).toMatchObject([{ tick: 'retry', observations: 0, violations: 0 }]);
    expect(result.passed).toBe(false);
  });

  it('charges wrong kinds and unexpected deliveries to their observed kind', () => {
    const bill = { ...moment, kind: 'bill-due' };
    expect(
      score([
        { ...arrival, selected: bill.kind, moments: [bill] },
        retry,
        { ...arrival, name: 'unexpected tick' },
      ]),
    ).toMatchObject([
      {
        kind: 'bill-due',
        expected: 0,
        delivered: 1,
        recall: null,
        precision: 0,
        falsePositives: 1,
      },
      { kind: 'mail-action', expected: 1, delivered: 1, matched: 0, misses: 1, falsePositives: 1 },
    ]);
  });

  it('credits a single match and charges known and unattributed duplicates to precision', () => {
    const duplicate = { ...moment, exactSource: false };
    const overDelivery = { ...arrival, moments: [duplicate, moment], ownerNotices: 3 };
    expect(score([overDelivery, retry])).toMatchObject([
      { kind: null, expected: 0, delivered: 1, matched: 0, falsePositives: 1, precision: 0 },
      {
        kind: 'mail-action',
        expected: 1,
        delivered: 2,
        matched: 1,
        falsePositives: 1,
        precision: 0.5,
      },
    ]);
  });

  it('applies half credit at the inclusive boundary with incomplete push evidence', () => {
    const incomplete = { ...moment, elapsedMinutes: 10, durablePushAcknowledged: false };
    expect(
      score([{ ...arrival, moments: [incomplete], pushAcknowledged: false }, retry]),
    ).toMatchObject([
      {
        kind: 'mail-action',
        matched: 0.5,
        recall: 0.5,
        precision: 0.5,
        misses: 0,
        falsePositives: 0,
      },
    ]);
  });

  it('excludes repeated setup observations while retaining delivery violations during silence', () => {
    const setup: ReplayCase = {
      id: 'S14',
      ticks: {
        ...fixture.ticks,
        arrival: {
          deliveries: 1,
          kind: 'mail-action',
          earliestMinutes: 5,
          latestMinutes: 10,
          setup: true,
        },
      },
    };
    const result = scoreReplayCase(
      setup,
      [
        arrival,
        arrival,
        { ...retry, selected: 'bill-due', ownerNotices: 1 },
        { ...retry, pushSinkCalls: 1 },
      ],
      {},
    );
    expect(result).toMatchObject({
      expected: 1,
      setupExpected: 1,
      delivered: 4,
      setupDeliveries: 2,
      quietViolations: 2,
    });
    expect(result.quietChecks).toMatchObject([{ tick: 'retry', observations: 2, violations: 2 }]);
    expect(scoreReplayKinds([result])).toMatchObject([
      { kind: null, expected: 0, delivered: 2, falsePositives: 2 },
    ]);
  });
});
