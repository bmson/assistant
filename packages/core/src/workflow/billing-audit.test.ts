import { gmailSearchReceiptSourceId } from '@assistant/persistence/gmail-search-identity';
import { describe, expect, it } from 'vitest';
import {
  billingAuditProjection,
  extractBillingAuditRows,
  isBillingAuditIntent,
  renderBillingAudit,
  requestedBillingAuditMonths,
  resolveBillingAuditScope,
} from './billing-audit.js';
import { detectPersonalReadRequest } from './read-intent.js';

const prompt =
  'Audit recurring subscriptions evidenced in authorized billing messages over the last 3 complete local calendar months. Separate actual charges, trials, refunds, cancellation notices and uncertain recurring purchases.';

function resolvedScope(months: number, timeZone: string) {
  const value = resolveBillingAuditScope(months, new Date('2026-10-15T12:00:00Z'), timeZone);
  if (!value) throw new Error('Expected a valid billing window');
  return value;
}

describe('bounded billing mail audit', () => {
  function readEvidence(includeThread = true, receivedAt?: string) {
    const request = detectPersonalReadRequest([{ role: 'user', content: prompt }], {
      now: new Date('2026-10-15T12:00:00Z'),
      timeZone: 'UTC',
    });
    if (!request?.billingAudit || !request.mailQuery) throw new Error('Billing scope missing');
    const query = request.mailQuery;
    const body = 'Your card was charged $12.00 for the monthly Acme subscription.';
    const evidence = [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: { query, maxResults: 20 },
        result: {
          query,
          complete: true,
          hasMore: false,
          results: [{ threadId: 'thread-1', subject: 'Acme subscription receipt' }],
          unavailable: [],
          receipt: {
            version: 1,
            source: { kind: 'gmail-search', id: gmailSearchReceiptSourceId(query) },
            requested: { limit: 20, scope: 'query-page' },
            covered: { count: 1, total: 1, unavailable: 0 },
            complete: true,
            losses: [],
            continuation: null,
          },
        },
      },
      ...(includeThread
        ? [
            {
              toolName: 'gmail.read_thread',
              status: 'succeeded',
              fromCurrentTask: true,
              args: {
                threadId: 'thread-1',
                startMessageIndex: 0,
                startMessageOffset: 0,
                maxMessages: 20,
                maxChars: 20_000,
              },
              result: {
                threadId: 'thread-1',
                complete: true,
                hasMore: false,
                messages: [
                  {
                    messageId: 'message-1',
                    subject: 'Acme subscription receipt',
                    from: 'Acme Billing <billing@example.test>',
                    date: 'Mon, 01 Jan 2001 00:00:00 +0000',
                    ...(receivedAt ? { receivedAt } : {}),
                    text: body,
                    sourceLength: body.length,
                    truncated: false,
                  },
                ],
                receipt: {
                  version: 1,
                  source: { kind: 'gmail-thread', id: 'thread-1' },
                  requested: { start: 0, offset: 0, limit: 20, scope: 'thread-messages' },
                  covered: { start: 0, offset: 0, end: 1, count: 1, total: 1, unavailable: 0 },
                  complete: true,
                  losses: [],
                  continuation: null,
                },
              },
            },
          ]
        : []),
    ];
    return { request, evidence };
  }

  it('requires current exact-query search receipts, full thread reads and provider receive timestamps', () => {
    const valid = readEvidence(true, '2026-08-12T12:00:00Z');
    const projection = billingAuditProjection(valid.request, valid.evidence);
    expect(projection.coverage.complete).toBe(true);
    expect(projection.rows[0]).toMatchObject({
      merchant: 'Acme Billing',
      classification: 'charge',
      amount: { value: '12.00', currency: 'USD' },
      period: 'month',
    });

    const missingThread = readEvidence(false);
    expect(
      billingAuditProjection(missingThread.request, missingThread.evidence).coverage,
    ).toMatchObject({
      complete: false,
      issue: expect.stringContaining('not fully read'),
    });

    const headerOnlyDate = readEvidence(true);
    expect(
      billingAuditProjection(headerOnlyDate.request, headerOnlyDate.evidence).coverage,
    ).toMatchObject({
      complete: false,
      issue: expect.stringContaining('received timestamp'),
    });

    const wrongTask = readEvidence(true, '2026-08-12T12:00:00Z');
    const search = wrongTask.evidence[0];
    if (!search) throw new Error('Expected Gmail search receipt');
    search.fromCurrentTask = false;
    expect(billingAuditProjection(wrongTask.request, wrongTask.evidence).coverage.complete).toBe(
      false,
    );

    const malformedHit = readEvidence(false);
    const malformedSearch = malformedHit.evidence[0];
    if (!malformedSearch) throw new Error('Expected Gmail search receipt');
    malformedSearch.result = {
      ...(malformedSearch.result as Record<string, unknown>),
      results: [{ subject: 'Thread identity missing' }],
    } as typeof malformedSearch.result;
    expect(
      billingAuditProjection(malformedHit.request, malformedHit.evidence).coverage,
    ).toMatchObject({
      complete: false,
      issue: expect.stringContaining('valid Gmail thread identity'),
    });

    const wrongQuery = readEvidence(false);
    const querySearch = wrongQuery.evidence[0];
    if (!querySearch) throw new Error('Expected Gmail search receipt');
    querySearch.args = {
      ...(querySearch.args as Record<string, unknown>),
      query: 'unrelated',
    } as typeof querySearch.args;
    expect(billingAuditProjection(wrongQuery.request, wrongQuery.evidence).coverage.complete).toBe(
      false,
    );
  });

  it('routes billing-month wording without treating calendar months as a calendar read', () => {
    expect(isBillingAuditIntent(prompt)).toBe(true);
    expect(requestedBillingAuditMonths(prompt)).toBe(3);
    expect(
      requestedBillingAuditMonths(
        'Review subscription receipts in Gmail over the past two complete months.',
      ),
    ).toBe(2);
    expect(isBillingAuditIntent('What is on my calendar over the next three months?')).toBe(false);
    expect(requestedBillingAuditMonths('Audit billing emails from the past 13 months.')).toBe(
      undefined,
    );
    expect(requestedBillingAuditMonths('Audit billing emails over complete months.')).toBe(
      undefined,
    );
  });

  it.each([
    [
      '2026-10-15T12:00:00.000Z',
      'America/Los_Angeles',
      3,
      '2026-07-01T07:00:00.000Z',
      '2026-10-01T07:00:00.000Z',
    ],
    [
      '2026-04-15T12:00:00.000Z',
      'America/Los_Angeles',
      3,
      '2026-01-01T08:00:00.000Z',
      '2026-04-01T07:00:00.000Z',
    ],
    [
      '2026-02-15T12:00:00.000Z',
      'America/New_York',
      3,
      '2025-11-01T04:00:00.000Z',
      '2026-02-01T05:00:00.000Z',
    ],
    ['2025-03-01T12:00:00.000Z', 'UTC', 3, '2024-12-01T00:00:00.000Z', '2025-03-01T00:00:00.000Z'],
    ['2024-03-01T12:00:00.000Z', 'UTC', 1, '2024-02-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'],
  ])(
    'resolves month starts across DST and year/leap boundaries',
    (now, zone, count, start, end) => {
      const scope = resolveBillingAuditScope(count, new Date(now), zone);
      expect(scope).toMatchObject({ startAt: start, endAt: end });
      expect(scope?.query).toContain('after:');
      expect(scope?.query).toContain('before:');
    },
  );

  it('fails closed for a missing or invalid local time zone', () => {
    expect(resolveBillingAuditScope(3, new Date('2026-10-15T12:00:00Z'), '')).toBeUndefined();
    expect(resolveBillingAuditScope(3, new Date('2026-10-15T12:00:00Z'), 'Mars/Olympus')).toBe(
      undefined,
    );
  });

  it('uses provider received timestamps and keeps charges, trials, refunds, cancels, and uncertainty distinct', () => {
    const scope = resolvedScope(3, 'America/Los_Angeles');
    const messages = [
      {
        threadId: 't-charge',
        messageId: 'm-charge',
        subject: 'Acme payment receipt',
        sender: 'Acme Billing <billing@acme.example>',
        receivedAt: '2026-08-12T12:00:00.000Z',
        text: 'Your card was charged USD 12.00 for the monthly Acme subscription.',
      },
      {
        threadId: 't-trial',
        messageId: 'm-trial',
        subject: 'Beta free trial started',
        receivedAt: '2026-08-20T12:00:00.000Z',
        text: 'Your free trial starts today and ends next month.',
      },
      {
        threadId: 't-refund',
        messageId: 'm-refund',
        subject: 'Gamma refund processed',
        receivedAt: '2026-09-01T12:00:00.000Z',
        text: 'We refunded $8.00 to your account.',
      },
      {
        threadId: 't-cancel',
        messageId: 'm-cancel',
        subject: 'Delta cancellation confirmed',
        receivedAt: '2026-09-05T12:00:00.000Z',
        text: 'Your subscription has been cancelled.',
      },
      {
        threadId: 't-uncertain',
        messageId: 'm-uncertain',
        subject: 'Epsilon invoice',
        receivedAt: '2026-09-08T12:00:00.000Z',
        text: 'Invoice USD 25.00 is ready. No payment status is included.',
      },
      {
        threadId: 't-boundary',
        messageId: 'm-boundary',
        subject: 'October receipt',
        receivedAt: scope.endAt,
        text: 'Your card was charged $9.00.',
      },
      {
        threadId: 't-duplicate',
        messageId: 'm-charge',
        subject: 'Forwarded copy of Acme payment receipt',
        receivedAt: '2026-08-12T12:00:00.000Z',
        text: 'Duplicate provider message identity.',
      },
    ];
    const extracted = extractBillingAuditRows(messages, scope);
    expect(extracted.rows.map((row) => row.classification)).toEqual([
      'charge',
      'trial',
      'refund',
      'cancellation',
      'uncertain',
    ]);
    expect(extracted.rows[0]).toMatchObject({
      merchant: 'Acme Billing',
      amount: { value: '12.00', currency: 'USD' },
      period: 'month',
      recurringEvidence: true,
    });
    expect(extracted.rows[1]?.recurringEvidence).toBe(false);
    expect(extracted.outOfRange).toBe(1);
    expect(extracted.rows.filter((row) => row.message.messageId === 'm-charge')).toHaveLength(1);
  });

  it('does not infer recurrence from a receipt, sum currencies, or turn a cancellation into no later charge', () => {
    const scope = resolvedScope(3, 'UTC');
    const rows = extractBillingAuditRows(
      [
        {
          threadId: 't1',
          messageId: 'm1',
          subject: 'Store receipt',
          receivedAt: '2026-08-01T00:00:00Z',
          text: 'Payment received: $8.00.',
        },
        {
          threadId: 't2',
          messageId: 'm2',
          subject: 'Plan charge',
          receivedAt: '2026-08-02T00:00:00Z',
          text: 'Charged €8.00 for your subscription; renews monthly.',
        },
        {
          threadId: 't3',
          messageId: 'm3',
          subject: 'Cancellation notice',
          receivedAt: '2026-08-03T00:00:00Z',
          text: 'Your subscription is cancelled.',
        },
        {
          threadId: 't4',
          messageId: 'm4',
          subject: 'Later charge',
          receivedAt: '2026-09-03T00:00:00Z',
          text: 'Your card was charged $8.00.',
        },
      ],
      scope,
    );
    expect(rows.rows[0]?.recurringEvidence).toBe(false);
    expect(rows.rows[1]).toMatchObject({
      classification: 'charge',
      recurringEvidence: true,
      amount: { currency: 'EUR' },
      period: 'month',
    });
    expect(rows.rows[2]?.classification).toBe('cancellation');
    expect(rows.rows[3]?.classification).toBe('charge');
    const text = renderBillingAudit({
      scope,
      rows: rows.rows,
      coverage: { complete: true, assessedMessages: rows.rows.length, omittedMessages: 0 },
    });
    expect(text).toContain('EUR');
    expect(text).not.toContain('USD total');
    expect(text).toContain('not bank-confirmed transactions');
    expect(text).toContain('Review decisions (chat only)');
    expect(text).toContain('https://mail.google.com/mail/u/0/#all/t2');
    expect(text).not.toContain('cancelled, so no later charge');
  });

  it('keeps charge and refund facts clause-local and labels them as mail-reported', () => {
    const scope = resolvedScope(3, 'UTC');
    const rows = extractBillingAuditRows(
      [
        {
          threadId: 't-mixed',
          messageId: 'm-mixed',
          subject: 'Acme billing activity',
          receivedAt: '2026-09-10T12:00:00Z',
          text: 'Your card was charged USD 12.00 for the monthly plan on September 1. We refunded EUR 99.00 on September 4. Unsubscribe from emails about your subscription renewing monthly.',
        },
      ],
      scope,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      classification: 'charge',
      amount: { value: '12.00', currency: 'USD' },
      period: 'month',
      recurringEvidence: true,
    });
    expect(rows.rows[0]?.quote).toContain('September 1');
    expect(rows.rows[0]?.quote).not.toContain('EUR 99.00');
    expect(rows.rows[1]).toMatchObject({
      classification: 'refund',
      amount: { value: '99.00', currency: 'EUR' },
      recurringEvidence: false,
    });
    expect(rows.rows[1]?.quote).toContain('September 4');
    const rendered = renderBillingAudit({
      scope,
      rows: rows.rows,
      coverage: { complete: true, assessedMessages: 1, omittedMessages: 0 },
    });
    expect(rendered).toContain('mail-reported charge');
    expect(rendered).toContain('mail-reported refund');
    expect(rendered).toContain('not bank-confirmed transactions');
    expect(rendered).not.toContain('mail-reported uncertain');
  });

  it('does not call a future charge a paid charge or treat an unsubscribe footer as recurrence', () => {
    const scope = resolvedScope(3, 'UTC');
    const rows = extractBillingAuditRows(
      [
        {
          threadId: 't-future',
          messageId: 'm-future',
          subject: 'Trial ending',
          receivedAt: '2026-09-10T12:00:00Z',
          text: 'Your free trial ends September 20. You will be charged USD 25.00 monthly after the trial. Unsubscribe from subscription renewal emails.',
        },
      ],
      scope,
    );
    expect(rows.rows.map((row) => row.classification)).toEqual(['trial', 'uncertain']);
    expect(rows.rows.some((row) => row.classification === 'charge')).toBe(false);
    expect(rows.rows.every((row) => row.recurringEvidence === false)).toBe(true);
    expect(rows.rows[1]).toMatchObject({
      amount: { value: '25.00', currency: 'USD' },
      period: 'month',
    });
  });

  it('marks content and date omissions instead of claiming a complete assessment', () => {
    const scope = resolvedScope(3, 'UTC');
    const messages = Array.from({ length: 14 }, (_, index) => ({
      threadId: 'thread-cap',
      messageId: `message-${index}`,
      subject: 'Subscription receipt',
      text: 'A receipt does not by itself prove recurring spend.',
      ...(index === 0 ? {} : { receivedAt: '2026-08-12T12:00:00Z' }),
    }));
    const extracted = extractBillingAuditRows(messages, scope);
    expect(extracted.missingReceivedAt).toBe(1);
    expect(extracted.omitted).toBe(2);
    expect(extracted.rows).toHaveLength(11);
  });
});
