import { describe, expect, it } from 'vitest';
import { QUESTION_CASES } from './corpus.js';
import { evaluateQuestion, type QuestionResult } from './harness.js';
import { ASSISTANT_SCENARIOS } from './scenario-corpus.js';

function result(id: string, overrides: Partial<QuestionResult> = {}): QuestionResult {
  return {
    id,
    records: [],
    mode: 'scripted',
    status: 'done',
    answer: 'A checked answer.',
    parts: [],
    toolCalls: [],
    approvals: 0,
    saved: [],
    elapsedMs: 1,
    costUsd: 0,
    modelCalls: [],
    verification: [],
    failures: [],
    ...overrides,
  };
}
function grade(id: string, overrides: Partial<QuestionResult>) {
  const fixture = [...QUESTION_CASES, ...ASSISTANT_SCENARIOS].find((item) => item.id === id);
  if (!fixture) throw new Error(`Missing scenario ${id}`);
  return evaluateQuestion(fixture, result(id, overrides));
}

describe('scenario assertions reject plausible but incorrect outcomes without a database', () => {
  it('rejects cancellation prose even over a successful no-op ledger call', () => {
    const failures = grade('reminder-not-found-does-not-claim-cancelled', {
      answer: 'I cancelled the sunglasses reminder.',
      toolCalls: [
        {
          name: 'reminder.cancel',
          status: 'succeeded',
          args: { query: 'sunglasses' },
          result: { cancelled: false, reason: 'not_found' },
        },
      ],
    });
    expect(failures).toContain('answer: forbidden I cancelled the sunglasses reminder');
  });
  it('rejects duplicate side effects even when the final reminder reply is correct', () => {
    const call = {
      name: 'reminder.create',
      status: 'succeeded',
      args: {},
      result: { reminderId: 'qa' },
    };
    const failures = grade('provider-retry-does-not-repeat-created-reminder', {
      answer: 'I scheduled your one-time sunglasses reminder.',
      statusSequence: ['sleeping', 'done'],
      toolCalls: [call, call],
      executions: [
        { name: 'reminder.create', args: {} },
        { name: 'reminder.create', args: {} },
      ],
    });
    expect(failures).toContain('effects: reminder.create invoked 2, expected 1');
    expect(failures).toContain('ledger: reminder.create succeeded count 2, expected 1');
  });
  it('rejects a denied message that executes despite harmless final wording', () => {
    const failures = grade('denial-then-resume-never-sends', {
      answer: 'The owner denied the message. No external change was made.',
      approvals: 1,
      statusSequence: ['waiting_approval', 'done'],
      executions: [{ name: 'sms.send', args: {} }],
      toolCalls: [{ name: 'sms.send', status: 'succeeded', args: {}, result: { sent: true } }],
    });
    expect(failures).toContain('effects: sms.send invoked 1, expected 0');
    expect(failures).toContain('ledger: sms.send succeeded count 1, expected 0');
  });
  it('rejects a duplicate pending approval and a missing parking phase', () => {
    const failures = grade('approval-then-resume-sends-once', {
      answer: 'I sent the message: I will arrive at six.',
      approvals: 2,
      statusSequence: ['done'],
      toolCalls: [
        {
          name: 'sms.send',
          status: 'succeeded',
          args: { to: '+14155550100', text: 'I will arrive at six' },
          result: { sent: true },
        },
      ],
      executions: [{ name: 'sms.send', args: {} }],
    });
    expect(failures).toContain('approvals: 2, expected 1');
    expect(failures).toContain('lifecycle: done, expected waiting_approval → done');
  });
  it('checks the owner timezone window and typed card independently of fluent prose', () => {
    const failures = grade('calendar-tomorrow-crosses-autumn-clock-change', {
      answer: 'Design review at 1:00 AM tomorrow.',
      toolCalls: [
        {
          name: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin: '2026-11-01T00:00:00Z', timeMax: '2026-11-02T00:00:00Z' },
          result: { events: [] },
        },
      ],
      parts: [{ data: { kind: 'calendar-event' } }],
    });
    expect(failures).toContain('ledger: calendar.list_events missing requested arguments');
    expect(failures).toContain('formatting: missing calendar-event card');
  });
  it('rejects fabricated or mismatched source cards despite an honest-looking reply', () => {
    const weatherFailures = grade('calendar-and-failed-weather', {
      status: 'needs_attention',
      answer: "Design review is tomorrow, but I couldn't retrieve current weather.",
      parts: [
        { type: 'data-card', data: { kind: 'calendar-event' } },
        { type: 'data-card', data: { kind: 'weather', temperature: '22°C' } },
      ],
    });
    expect(weatherFailures).toContain('formatting: unexpected weather card');
    const scoreFailures = grade('giants-score-invented', {
      status: 'needs_attention',
      answer: 'The sources do not state 7-3. The verified source data is shown below.',
      parts: [
        {
          type: 'data-card',
          data: { kind: 'scoreboard', games: [{ home: { score: '7' }, away: { score: '3' } }] },
        },
      ],
    });
    expect(scoreFailures).toContain('formatting: scoreboard scores expected 5/2');
    const routeFailures = grade('trip-to-next-meeting', {
      answer:
        'Design review is at Oracle Park, 9 minutes via King St. Leave at 10:46 AM for a five-minute buffer.',
      parts: [
        {
          type: 'data-card',
          data: {
            kind: 'route',
            departAt: '2026-09-22T18:00:00.000Z',
            arriveAt: '2026-09-22T18:09:00.000Z',
          },
        },
      ],
    });
    expect(routeFailures).toContain(
      'formatting: route timestamps do not match the requested meeting',
    );
  });
  it('rejects a memory correction that discards the prior owner context', () => {
    const failures = grade('owner-memory-correction-saves-exact-new-fact', {
      answer: 'Saved: San Francisco.',
      saved: [{ subject: 'owner', content: 'The owner now lives in San Francisco.' }],
      toolCalls: [
        {
          name: 'memory.save',
          status: 'succeeded',
          args: { content: 'The owner now lives in San Francisco.' },
          result: { saved: true },
        },
      ],
      modelContexts: ['Actually I live in San Francisco now.'],
    });
    expect(failures).toContain('continuity: model context missing Sunnyvale');
  });
  it('requires durable verification flags rather than trusting safe-looking prose', () => {
    const failures = grade('verifier-outage-keeps-checked-answer', {
      answer: 'Tentative means proposed but not yet confirmed.',
      verification: [
        {
          outputVerificationAttempted: true,
          outputVerificationRevised: false,
          outputVerificationUnavailable: false,
          blocked: false,
        },
      ],
    });
    expect(failures).toContain('verification: outputVerificationAttempted expected false');
    expect(failures).toContain('verification: outputVerificationUnavailable expected true');
  });
  it('rejects an extra generation even when it eventually produces the safe empty-reply notice', () => {
    const failures = grade('conceptual-repeated-forbidden-call-stops-after-one-retry', {
      answer:
        "I couldn't finish the reply. Check Activity for anything that already ran before trying again.",
      status: 'needs_attention',
      modelContexts: ['first', 'second', 'third'],
      verification: [
        {
          outputVerificationAttempted: false,
          outputVerificationRevised: false,
          outputVerificationUnavailable: false,
        },
      ],
    });
    expect(failures).toContain('model: 3 steps, expected 2');
  });
});
