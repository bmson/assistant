import { describe, expect, it } from 'vitest';
import {
  detectFutureWatchIntent,
  futureWatchRecoveryCallMatches,
  futureWatchRequestGuidance,
  futureWatchTargetIsResolved,
  normalizeFutureWatchPlan,
  shouldAttemptFutureWatchRecovery,
} from './future-watch-intent.js';

describe('future watch intent', () => {
  it('separates future email notification from a present mailbox question', () => {
    expect(detectFutureWatchIntent('Tell me if Alex emails me')).toMatchObject({
      channel: 'email',
      checkCurrentFirst: false,
      targetTerms: ['alex'],
    });
    expect(detectFutureWatchIntent('Has Alex emailed me?')).toBeNull();
    expect(detectFutureWatchIntent("I don't want you to monitor Alex's inbox")).toBeNull();
  });

  it('marks a conditional reply lookup before future monitoring', () => {
    expect(
      detectFutureWatchIntent('Check whether Alex replied; if not, notify me when they do.'),
    ).toMatchObject({ channel: 'email', checkCurrentFirst: true });
  });

  it('routes exact public page monitoring to a web watch', () => {
    expect(detectFutureWatchIntent('Tell me if https://example.com/status changes')).toMatchObject({
      channel: 'web',
      explicitUrls: ['https://example.com/status'],
    });
    expect(detectFutureWatchIntent('Did the status page change?')).toBeNull();
  });

  it('ignores quoted examples and does not call an underspecified plan complete', () => {
    expect(detectFutureWatchIntent('Explain “Tell me if Alex emails me”')).toBeNull();
    const intent = detectFutureWatchIntent('Tell me if Alex emails me');
    if (!intent) throw new Error('expected a watch intent');
    const plan = normalizeFutureWatchPlan(
      { action: 'reply' as const, reasoning: '', steps: [], missingInfo: [] },
      intent,
    );
    expect(plan.action).toBe('workflow');
    expect(plan.steps.join(' ')).toMatch(/configured Gmail reads/i);
    expect(futureWatchRequestGuidance(intent).join(' ')).toMatch(/exact sender/i);
  });

  it('preserves a clarification instead of forcing a guessed watch', () => {
    const intent = detectFutureWatchIntent('Tell me when the email arrives');
    if (!intent) throw new Error('expected a watch intent');
    const plan = normalizeFutureWatchPlan(
      { action: 'clarify' as const, reasoning: '', steps: [], missingInfo: ['Which interview?'] },
      intent,
    );
    expect(plan).toMatchObject({ action: 'clarify', missingInfo: ['Which interview?'] });
  });

  it('uses mailbox reads before asking about a named but unresolved sender', () => {
    const intent = detectFutureWatchIntent('Tell me when the interview outcome email arrives');
    if (!intent) throw new Error('expected a watch intent');
    const plan = normalizeFutureWatchPlan(
      { action: 'clarify' as const, reasoning: '', steps: [], missingInfo: ['Which sender?'] },
      intent,
    );
    expect(plan.action).toBe('workflow');
    expect(plan.steps.join(' ')).toMatch(/configured Gmail reads/i);
  });

  it('allows late recovery only for a direct or uniquely resolved target', () => {
    const emailIntent = detectFutureWatchIntent('Tell me when the interview outcome email arrives');
    if (!emailIntent) throw new Error('expected an email watch intent');
    const search = {
      toolName: 'gmail.search',
      status: 'succeeded',
      result: {
        complete: true,
        results: [
          { from: 'Recruiting <jobs@acme.example>', subject: 'Interview outcome' },
          { from: 'jobs@acme.example', subject: 'Interview outcome follow-up' },
        ],
      },
    };
    expect(futureWatchTargetIsResolved(emailIntent, [search])).toBe(true);
    expect(
      futureWatchTargetIsResolved(emailIntent, [
        { ...search, result: { ...search.result, complete: false } },
      ]),
    ).toBe(false);
    expect(
      futureWatchTargetIsResolved(emailIntent, [
        search,
        {
          ...search,
          result: {
            complete: true,
            results: [{ from: 'other@acme.example', subject: 'Interview outcome' }],
          },
        },
      ]),
    ).toBe(false);
    const explicit = detectFutureWatchIntent('Tell me if jobs@acme.example emails me');
    if (!explicit) throw new Error('expected an explicit email watch intent');
    expect(futureWatchTargetIsResolved(explicit, [])).toBe(true);
    expect(
      futureWatchRecoveryCallMatches(explicit, [], {
        toolName: 'watch.create',
        input: { expectedSenderEmails: ['jobs@acme.example'] },
      }),
    ).toBe(true);
    expect(
      futureWatchRecoveryCallMatches(explicit, [], {
        toolName: 'watch.create',
        input: { expectedSenderEmails: ['other@acme.example'] },
      }),
    ).toBe(false);
    const web = detectFutureWatchIntent('Tell me if https://example.com/status changes');
    if (!web) throw new Error('expected a web watch intent');
    expect(futureWatchTargetIsResolved(web, [])).toBe(true);
    expect(
      futureWatchRecoveryCallMatches(web, [], {
        toolName: 'watch.web',
        input: { url: 'https://example.com/status/' },
      }),
    ).toBe(false);
  });

  it('does not recover conditional, ambiguous, exhausted, or previously attempted watches', () => {
    const conditional = detectFutureWatchIntent(
      'Check whether jobs@acme.example replied; if not, notify me when they do.',
    );
    const ambiguous = detectFutureWatchIntent('Tell me when the interview outcome email arrives');
    const explicit = detectFutureWatchIntent('Tell me if jobs@acme.example emails me');
    if (!conditional || !ambiguous || !explicit) throw new Error('expected watch intents');
    const input = { evidence: [], attempts: 0, step: 1, maxSteps: 4 };
    expect(shouldAttemptFutureWatchRecovery({ ...input, intent: explicit })).toBe(true);
    expect(shouldAttemptFutureWatchRecovery({ ...input, intent: conditional })).toBe(false);
    expect(shouldAttemptFutureWatchRecovery({ ...input, intent: ambiguous })).toBe(false);
    expect(
      shouldAttemptFutureWatchRecovery({
        ...input,
        intent: explicit,
        evidence: [{ toolName: 'watch.create', status: 'failed' }],
      }),
    ).toBe(false);
    expect(shouldAttemptFutureWatchRecovery({ ...input, intent: explicit, attempts: 1 })).toBe(
      false,
    );
    expect(shouldAttemptFutureWatchRecovery({ ...input, intent: explicit, step: 4 })).toBe(false);
  });
});
