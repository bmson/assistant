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
          mailboxSearched: 'assistant-alias@example.test',
          configuredOwnerMailbox: 'owner@example.test',
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
    expect(projection.mailbox).toEqual({
      searched: 'assistant-alias@example.test',
      configuredOwner: 'owner@example.test',
      consistent: true,
    });
    expect(projection.rows[0]).toMatchObject({
      merchant: 'Acme',
      classification: 'charge',
      amount: { value: '12.00' },
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

  it('reassembles receipt-validated message fragments before billing clause extraction', () => {
    const valid = readEvidence(true, '2026-08-12T12:00:00Z');
    const thread = valid.evidence[1];
    if (!thread) throw new Error('Expected complete thread read');
    const result = thread.result as Record<string, unknown>;
    const receipt = result.receipt as Record<string, unknown>;
    const original = (result.messages as Array<Record<string, unknown>>)[0];
    if (!original || typeof original.text !== 'string') throw new Error('Expected source message');
    const body = `${original.text} This subscription was a one-time exception and will not renew.`;
    const split = Math.floor(original.text.length / 2);
    const firstText = body.slice(0, split);
    const secondText = body.slice(split);
    const nextInput = {
      threadId: 'thread-1',
      startMessageIndex: 0,
      startMessageOffset: split,
      maxMessages: 20,
      maxChars: 20_000,
    };
    thread.result = {
      ...result,
      complete: false,
      hasMore: true,
      messages: [{ ...original, text: firstText, sourceLength: body.length, truncated: true }],
      continuation: { tool: 'gmail.read_thread', input: nextInput },
      receipt: {
        ...receipt,
        complete: false,
        losses: ['provider-page'],
        continuation: { tool: 'gmail.read_thread', input: nextInput },
      },
    } as unknown as typeof thread.result;
    const second = structuredClone(thread);
    second.args = nextInput as unknown as typeof second.args;
    second.result = {
      ...result,
      complete: true,
      hasMore: false,
      messages: [{ ...original, text: secondText, sourceLength: body.length, truncated: false }],
      continuation: null,
      receipt: {
        ...receipt,
        requested: { start: 0, offset: split, limit: 20, scope: 'thread-messages' },
        covered: { start: 0, offset: split, end: 1, count: 1, total: 1, unavailable: 0 },
        complete: true,
        losses: [],
        continuation: null,
      },
    } as unknown as typeof second.result;
    const projection = billingAuditProjection(valid.request, [...valid.evidence, second]);
    expect(projection.coverage.complete).toBe(true);
    expect(projection.rows.map((row) => row.quote)).toEqual([
      expect.stringContaining('Your card was charged $12.00'),
      expect.stringContaining('one-time exception'),
    ]);
    expect(projection.rows.every((row) => row.receivedAt === '2026-08-12T12:00:00.000Z')).toBe(
      true,
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
    expect(
      requestedBillingAuditMonths(
        'Review recurring subscriptions in billing emails for the last three months.',
      ),
    ).toBeUndefined();
    expect(
      isBillingAuditIntent(
        'Review recurring subscriptions in billing emails over the last three complete calendar months.',
      ),
    ).toBe(true);
    expect(
      detectPersonalReadRequest(
        [
          {
            role: 'user',
            content: 'Review recurring subscriptions in billing emails for the last three months.',
          },
        ],
        { now: new Date('2026-10-15T12:00:00Z'), timeZone: 'UTC' },
      ),
    ).toMatchObject({
      kind: 'email',
      billingAuditIssue: expect.stringContaining('last 3 complete local calendar months'),
    });
  });

  it('keeps billing results but marks requested non-mail companions unassessed', () => {
    const valid = readEvidence(true, '2026-08-12T12:00:00Z');
    valid.request.billingAuditCompanionGap =
      'The requested calendar source check was not run; only the bounded billing mailbox was reviewed.';
    const scope = valid.request.billingAudit;
    if (!scope) throw new Error('Expected bounded billing scope');
    const projection = billingAuditProjection(valid.request, valid.evidence);
    expect(projection.rows).toHaveLength(1);
    expect(projection.coverage.complete).toBe(false);
    expect(projection.coverage.issue).toContain('calendar source check was not run');
    expect(
      renderBillingAudit({
        scope,
        rows: projection.rows,
        coverage: projection.coverage,
        mailbox: projection.mailbox,
      }),
    ).toContain('only the bounded billing mailbox was reviewed');
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
      merchant: 'Acme',
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
          text: 'Charged EUR 8.00 for your subscription; renews monthly.',
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

  it('keeps unsupported currency and payment-state claims uncertain', () => {
    const scope = resolvedScope(3, 'UTC');
    const messages = [
      {
        threadId: 't-bare-dollar',
        messageId: 'm-bare-dollar',
        subject: 'Acme subscription receipt',
        sender: 'Owner Forwarder <owner@example.test>',
        receivedAt: '2026-08-02T00:00:00Z',
        text: 'Your card was charged $15.00 monthly.',
      },
      {
        threadId: 't-negated',
        messageId: 'm-negated',
        subject: 'Payment notice',
        receivedAt: '2026-08-03T00:00:00Z',
        text: 'You were not charged USD 15.00.',
      },
      {
        threadId: 't-due',
        messageId: 'm-due',
        subject: 'Payment due',
        receivedAt: '2026-08-04T00:00:00Z',
        text: 'Payment of USD 16.00 is due next week.',
      },
      {
        threadId: 't-requested',
        messageId: 'm-requested',
        subject: 'Refund request',
        receivedAt: '2026-08-05T00:00:00Z',
        text: 'Refund requested for USD 8.00 but not processed.',
      },
      {
        threadId: 't-completed',
        messageId: 'm-completed',
        subject: 'Acme charge',
        receivedAt: '2026-08-06T00:00:00Z',
        text: 'Charged 17 US dollars monthly for the plan.',
      },
      {
        threadId: 't-yen',
        messageId: 'm-yen',
        subject: 'Payment receipt',
        receivedAt: '2026-08-07T00:00:00Z',
        text: 'Your card was charged ¥900 monthly.',
      },
      {
        threadId: 't-forwarded-owner',
        messageId: 'm-forwarded-owner',
        subject: 'Fwd: Subscription receipt',
        sender: 'Owner Name <owner@example.test>',
        receivedAt: '2026-08-08T00:00:00Z',
        text: 'Your card was charged USD 18.00.',
      },
      {
        threadId: 't-generic-dollar-word',
        messageId: 'm-generic-dollar-word',
        subject: 'Payment receipt',
        receivedAt: '2026-08-09T00:00:00Z',
        text: 'Charged 19 dollars.',
      },
      {
        threadId: 't-no-refund',
        messageId: 'm-no-refund',
        subject: 'Refund update',
        receivedAt: '2026-08-10T00:00:00Z',
        text: 'No refund issued for USD 5.00.',
      },
    ];
    const rows = extractBillingAuditRows(messages, scope).rows;
    expect(rows.map((row) => row.classification)).toEqual([
      'charge',
      'uncertain',
      'uncertain',
      'uncertain',
      'charge',
      'charge',
      'charge',
      'charge',
      'uncertain',
    ]);
    expect(rows[0]?.amount).toEqual({ value: '15.00' });
    expect(rows[0]?.confidence).toBe('limited');
    expect(rows[0]?.recurringEvidence).toBe(true);
    expect(rows[0]?.merchant).toBe('Acme');
    expect(rows[0]?.message.sender).toContain('Owner Forwarder');
    expect(rows[4]?.amount).toEqual({ value: '17', currency: 'USD' });
    expect(rows[5]?.amount).toEqual({ value: '900' });
    expect(rows[6]?.merchant).toBe('Merchant not stated');
    expect(rows[6]?.message.sender).toContain('Owner Name');
    expect(rows[7]?.amount).toEqual({ value: '19' });
    const rendered = renderBillingAudit({
      scope,
      rows,
      coverage: { complete: true, assessedMessages: messages.length, omittedMessages: 0 },
    });
    expect(rendered).toContain('15.00 (currency unstated)');
    const unknownCurrencyOnly = renderBillingAudit({
      scope,
      rows: [rows[0], rows[5]].filter((row): row is NonNullable<typeof row> => Boolean(row)),
      coverage: { complete: true, assessedMessages: 2, omittedMessages: 0 },
    });
    expect(unknownCurrencyOnly).not.toContain('Supported recurring amounts');
    expect(rendered).toContain('17 USD per month');
    expect(rendered).toContain('Mail-stated merchant');
    expect(rendered).toContain('Owner Forwarder');
  });

  it('keeps negative and future charge notices uncertain without discarding valid completed charges', () => {
    const rows = extractBillingAuditRows(
      [
        ...[
          'You will not be charged USD 12.00 monthly.',
          'You won’t be charged USD 12.00 monthly.',
          'Your account has not yet been charged USD 12.00 monthly.',
          'You will be charged USD 12.00 monthly next month.',
        ].map((text, index) => ({
          threadId: `negative-${index}`,
          messageId: `negative-message-${index}`,
          subject: 'Acme subscription payment notice',
          receivedAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
          text,
        })),
        {
          threadId: 'positive',
          messageId: 'positive-message',
          subject: 'Acme subscription payment receipt',
          receivedAt: '2026-08-10T00:00:00Z',
          text: 'Your card was charged USD 12.00 monthly.',
        },
      ],
      resolvedScope(3, 'UTC'),
    ).rows;
    expect(rows.map((row) => row.classification)).toEqual([
      'uncertain',
      'uncertain',
      'uncertain',
      'uncertain',
      'charge',
    ]);
    expect(rows.slice(0, 4).every((row) => !row.recurringEvidence)).toBe(true);
    expect(rows[4]).toMatchObject({ classification: 'charge', recurringEvidence: true });
  });

  it('does not treat arbitrary subject labels as merchant names while preserving a provider name', () => {
    const rows = extractBillingAuditRows(
      [
        {
          threadId: 'label',
          messageId: 'label-message',
          subject: 'Important: Subscription payment receipt',
          receivedAt: '2026-08-01T00:00:00Z',
          text: 'Your card was charged USD 12.00.',
        },
        {
          threadId: 'provider',
          messageId: 'provider-message',
          subject: 'Acme: Subscription payment receipt',
          receivedAt: '2026-08-02T00:00:00Z',
          text: 'Your card was charged USD 12.00.',
        },
      ],
      resolvedScope(3, 'UTC'),
    ).rows;
    expect(rows.map((row) => row.merchant)).toEqual(['Merchant not stated', 'Acme']);
  });

  it('requires complete page-chain evidence and consistent connected-mailbox receipts', () => {
    const valid = readEvidence(true, '2026-08-12T12:00:00Z');
    const first = valid.evidence[0];
    if (!first) throw new Error('Expected first search page');
    const query = valid.request.mailQuery;
    if (!query) throw new Error('Expected bounded query');
    const firstResult = first.result as Record<string, unknown>;
    const firstReceipt = firstResult.receipt as Record<string, unknown>;
    const second = structuredClone(first);
    second.args = {
      ...(first.args as Record<string, unknown>),
      pageToken: 'next-page',
    } as unknown as typeof second.args;
    second.result = {
      ...firstResult,
      complete: true,
      hasMore: false,
      nextPageToken: undefined,
      continuation: null,
      results: [{ threadId: 'thread-2', subject: 'Other subscription receipt' }],
      receipt: {
        ...firstReceipt,
        requested: { limit: 20, cursor: 'next-page', scope: 'query-page' },
        covered: { count: 1, total: 2, unavailable: 0 },
        complete: true,
        losses: [],
        continuation: null,
      },
    } as unknown as typeof second.result;
    first.args = {
      ...(first.args as Record<string, unknown>),
      pageToken: undefined,
    } as unknown as typeof first.args;
    first.result = {
      ...firstResult,
      complete: false,
      hasMore: true,
      nextPageToken: 'next-page',
      continuation: {
        tool: 'gmail.search',
        input: { query, maxResults: 20, pageToken: 'next-page' },
      },
      receipt: {
        ...firstReceipt,
        complete: false,
        losses: ['provider-page'],
        continuation: {
          tool: 'gmail.search',
          input: { query, maxResults: 20, pageToken: 'next-page' },
        },
      },
    } as unknown as typeof first.result;
    const paged = { ...valid, evidence: [...valid.evidence, second] };
    const completeChainWithUnreadThread = billingAuditProjection(paged.request, paged.evidence);
    expect(completeChainWithUnreadThread.coverage.issue).toContain('not fully read');
    expect(completeChainWithUnreadThread.coverage.issue).not.toContain('pagination');

    const inconsistentMailbox = structuredClone(paged);
    const secondPage = inconsistentMailbox.evidence[2];
    if (!secondPage) throw new Error('Expected second search page');
    const secondResult = secondPage.result as Record<string, unknown>;
    secondPage.result = {
      ...secondResult,
      mailboxSearched: 'different-mailbox@example.test',
    } as unknown as typeof secondPage.result;
    const inconsistent = billingAuditProjection(
      inconsistentMailbox.request,
      inconsistentMailbox.evidence,
    );
    expect(inconsistent.mailbox.consistent).toBe(false);
    expect(inconsistent.coverage.issue).toContain('mailbox');

    const uncertainTerminalPage = structuredClone(paged);
    const terminal = uncertainTerminalPage.evidence[2];
    if (!terminal) throw new Error('Expected terminal search page');
    const terminalResult = terminal.result as Record<string, unknown>;
    const terminalReceipt = terminalResult.receipt as Record<string, unknown>;
    terminal.result = {
      ...terminalResult,
      complete: false,
      receipt: { ...terminalReceipt, complete: false, losses: ['coverage-unknown'] },
    } as typeof terminal.result;
    const uncertain = billingAuditProjection(
      uncertainTerminalPage.request,
      uncertainTerminalPage.evidence,
    );
    expect(uncertain.coverage.issue).toContain('pagination');
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

  it('keeps displayed evidence compact, labels omitted clauses and removes quoted URLs', () => {
    const scope = resolvedScope(3, 'UTC');
    const messages = Array.from({ length: 12 }, (_, index) => ({
      threadId: `thread-${index + 1}`,
      messageId: `message-${index + 1}`,
      subject: `Provider ${index + 1} subscription receipt`,
      sender: `Forwarder ${index + 1} <forwarder${index + 1}@example.test>`,
      receivedAt: '2026-08-12T12:00:00Z',
      text:
        index === 0
          ? 'Your card was charged USD 12.00 monthly; manage billing at http://owner:secret@billing/manage?token=private. Refund processed USD 3.00.'
          : 'Your card was charged USD 12.00 monthly. Refund processed USD 3.00.',
    }));
    const rows = extractBillingAuditRows(messages, scope).rows;
    expect(rows).toHaveLength(24);
    const rendered = renderBillingAudit({
      scope,
      rows,
      coverage: { complete: true, assessedMessages: 12, omittedMessages: 0 },
    });
    expect(rendered).toContain('Evidence clauses: 12 shown of 24 assessed.');
    expect(rendered).toContain('Additional assessed clauses not shown (12)');
    expect(rendered).toContain('Mail-stated merchant');
    expect(rendered).toContain('Sender');
    expect(rendered).not.toContain('secret');
    expect(rendered).not.toContain('token=private');
    expect(rendered).toContain('manage billing at link omitted');
    expect(rendered).toContain('thread-12');
    expect(rows[0]?.quote.length).toBeLessThanOrEqual(141);
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
