import { describe, expect, it } from 'vitest';
import {
  boundEmailReviewThreads,
  EMAIL_REVIEW_MAX_RANK_CANDIDATES,
  EMAIL_REVIEW_MAX_RANK_POOL,
  EMAIL_REVIEW_QUERY,
  type EmailReviewEvidenceRow,
  emailReviewCandidateIds,
  emailReviewCompleteThread,
  emailReviewCoverage,
  emailReviewNextThreadRead,
  emailReviewOwnerMailbox,
  emailReviewRankContext,
  emailReviewRecentMetadataFallback,
  emailReviewSelectionWithinAuthorizedPool,
  emailReviewThreadReadResult,
  formatEmailReviewAnswer,
  validateEmailReviewAnswer,
  validEmailReviewSelection,
} from './email-review.js';
import { buildReadToolInput, nextRequiredReadTool, type ReadToolEvidence } from './read-intent.js';

const search = (threadId: string, overrides: Record<string, unknown> = {}) => ({
  id: `search-${threadId}`,
  toolName: 'gmail.search',
  status: 'succeeded',
  args: { query: EMAIL_REVIEW_QUERY, maxResults: 20 },
  result: {
    ok: true,
    query: EMAIL_REVIEW_QUERY,
    mailboxSearched: 'assistant-bot@example.com',
    configuredOwnerMailbox: 'owner@example.com',
    complete: true,
    hasMore: false,
    unavailable: [],
    results: [
      {
        threadId,
        messageId: `search-message-${threadId}`,
        from: 'sender@example.net',
        to: 'owner@example.com',
        date: '2026-10-11T16:00:00Z',
        subject: 'Please confirm the renewal date',
        snippet: 'Could you confirm by Friday?',
      },
    ],
    ...overrides,
  },
});

const read = (
  threadId: string,
  messages: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
  startMessageIndex = 0,
  startMessageOffset = 0,
  sourceTotal?: number,
) => ({
  id: `read-${threadId}`,
  toolName: 'gmail.read_thread',
  status: 'succeeded',
  args: { threadId, startMessageIndex, startMessageOffset },
  result: (() => {
    const continuation = overrides.continuation ?? null;
    const continuationInput =
      continuation && typeof continuation === 'object'
        ? (continuation as { input?: { startMessageIndex?: number } }).input
        : undefined;
    const total =
      sourceTotal ??
      Math.max(
        startMessageIndex + messages.length,
        (continuationInput?.startMessageIndex ?? 0) +
          (continuationInput?.startMessageIndex === startMessageIndex ? 1 : 0),
      );
    const complete = overrides.complete ?? true;
    const hasMore = !complete;
    const result = {
      complete,
      hasMore,
      messages,
      threadId,
      coverage: { discovered: total, returned: messages.length, complete },
      ...overrides,
    };
    const pageContinuation = overrides.continuation ?? null;
    const receipt = {
      version: 1,
      source: { kind: 'gmail-thread', id: threadId },
      requested: {
        start: startMessageIndex,
        offset: startMessageOffset,
        limit: 20,
        scope: 'thread-messages',
      },
      covered: {
        start: startMessageIndex,
        offset: startMessageOffset,
        end: startMessageIndex + messages.length,
        count: messages.length,
        total,
        unavailable: 0,
      },
      complete,
      losses: complete ? [] : ['provider-page'],
      continuation: pageContinuation,
    };
    return { ...result, receipt };
  })(),
});

const messages = (
  threadId: string,
  latestFrom = 'vendor@example.net',
  latestTo = 'owner@example.com',
) => [
  {
    messageId: `old-${threadId}`,
    from: 'owner@example.com',
    to: 'vendor@example.net',
    date: '2026-10-10T10:00:00Z',
    subject: 'Question',
    text: 'Could you send the current terms?',
    sourceLength: 'Could you send the current terms?'.length,
    truncated: false,
  },
  {
    messageId: `latest-${threadId}`,
    from: latestFrom,
    to: latestTo,
    date: '2026-10-11T16:00:00Z',
    subject: 'Please confirm the renewal date',
    text: 'Could you confirm by Friday? The renewal is still available.',
    sourceLength: 'Could you confirm by Friday? The renewal is still available.'.length,
    truncated: false,
  },
];

const validAnswer = (threadId: string) => ({
  items: [
    {
      threadId,
      latestMessageId: `latest-${threadId}`,
      disposition: 'draft',
      recipient: 'vendor@example.net',
      why: 'The sender asks for confirmation.',
      whyMessageId: `latest-${threadId}`,
      whyQuote: 'Could you confirm by Friday?',
      deadline: { messageId: `latest-${threadId}`, quote: 'by Friday' },
      draftBody: 'Thanks for your note.',
      draftSourceMessageIds: [`old-${threadId}`, `latest-${threadId}`],
    },
  ],
});

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing test fixture value: ${label}`);
  return value;
}

describe('bounded no-send email review', () => {
  it('ranks only IDs present in successful exact-query metadata and rejects duplicates or invented IDs', () => {
    const evidence: EmailReviewEvidenceRow[] = [
      search('thread-a'),
      { ...search('thread-b'), status: 'failed' },
      { ...search('thread-c'), args: { query: 'in:inbox' } },
    ];
    expect(emailReviewCandidateIds(evidence)).toEqual(['thread-a']);
    expect(validEmailReviewSelection(['thread-a'], evidence)).toBe(true);
    expect(validEmailReviewSelection(['thread-a', 'thread-a'], evidence)).toBe(false);
    expect(validEmailReviewSelection(['invented'], evidence)).toBe(false);
  });

  it('allows a bounded eight-ID reserve pool while keeping final answers capped at five', () => {
    const evidence = Array.from({ length: EMAIL_REVIEW_MAX_RANK_POOL }, (_, index) =>
      search(`request-${index}`),
    );
    const ids = Array.from(
      { length: EMAIL_REVIEW_MAX_RANK_POOL },
      (_, index) => `request-${index}`,
    );
    expect(validEmailReviewSelection(ids, evidence)).toBe(true);
    expect(validEmailReviewSelection([...ids, 'request-8'], evidence)).toBe(false);
    expect(JSON.parse(emailReviewRankContext(evidence).prompt)).toMatchObject({ limit: 8 });
  });

  it('rejects resumed selected IDs beyond the verified backfill authorization', () => {
    const ranked = Array.from(
      { length: EMAIL_REVIEW_MAX_RANK_POOL },
      (_, index) => `request-${index}`,
    );
    expect(emailReviewSelectionWithinAuthorizedPool(ranked.slice(0, 5), ranked, [])).toBe(true);
    expect(
      emailReviewSelectionWithinAuthorizedPool(ranked.slice(0, 6), ranked, ['request-0']),
    ).toBe(true);
    expect(emailReviewSelectionWithinAuthorizedPool(ranked, ranked, [])).toBe(false);
    expect(emailReviewSelectionWithinAuthorizedPool(ranked.slice(0, 6), ranked, [])).toBe(false);
    expect(emailReviewSelectionWithinAuthorizedPool(ranked.slice(0, 6), undefined, [])).toBe(false);
  });

  it('excludes obvious newsletters from the rank input while retaining an honest exclusion count', () => {
    const newsletter = search('newsletter-a');
    const newsletterResults = newsletter.result.results as Array<Record<string, unknown>>;
    required(newsletterResults[0], 'newsletter result').subject = 'Weekly product newsletter';
    required(newsletterResults[0], 'newsletter result').snippet = 'This week in product news.';
    const evidence: EmailReviewEvidenceRow[] = [newsletter, search('request-a')];
    const rankContext = emailReviewRankContext(evidence);
    expect(rankContext.candidateIds).toEqual(['request-a']);
    expect(JSON.parse(rankContext.prompt)).toMatchObject({
      candidates: [{ threadId: 'request-a' }],
    });
    expect(emailReviewCandidateIds(evidence)).toEqual(['newsletter-a', 'request-a']);
    expect(emailReviewCoverage(['request-a'], [], evidence).obviousNewslettersExcluded).toBe(1);
  });

  it('keeps a clear approval request even when newsletter metadata is present', () => {
    const approval = search('approval-request');
    const result = approval.result.results as Array<Record<string, unknown>>;
    required(result[0], 'approval request metadata').subject =
      'Weekly newsletter: approval needed Friday';
    required(result[0], 'approval request metadata').snippet =
      'Please approve the attached renewal by Friday.';
    const evidence: EmailReviewEvidenceRow[] = [approval];
    expect(emailReviewRankContext(evidence).candidateIds).toEqual(['approval-request']);
    expect(emailReviewCoverage([], [], evidence).obviousNewslettersExcluded).toBe(0);
  });

  it('bounds metadata shown to ranking even when search fields are unusually large', () => {
    const evidence = Array.from({ length: 90 }, (_, index) => {
      const row = search(`request-${String(index).padStart(2, '0')}`);
      const results = row.result.results as Array<Record<string, unknown>>;
      const metadata = required(results[0], `search metadata ${index}`);
      metadata.subject = 'S'.repeat(300);
      metadata.snippet = 'N'.repeat(400);
      metadata.from = 'sender@example.net';
      return row;
    });
    const context = emailReviewRankContext(evidence);
    expect(context.prompt.length).toBeLessThanOrEqual(40_000);
    expect(context.candidateIds.length).toBeGreaterThan(0);
    expect(context.candidateIds.length).toBeLessThanOrEqual(EMAIL_REVIEW_MAX_RANK_CANDIDATES);
  });

  it('falls back only to recent non-newsletter IDs in the supplied candidate set', () => {
    const old = search('request-old');
    const recent = search('request-new');
    const oldResult = old.result.results as Array<Record<string, unknown>>;
    const newResult = recent.result.results as Array<Record<string, unknown>>;
    required(oldResult[0], 'old metadata').date = '2026-10-08T08:00:00Z';
    required(newResult[0], 'recent metadata').date = '2026-10-12T08:00:00Z';
    const newsletter = search('newsletter-new');
    const newsletterResult = newsletter.result.results as Array<Record<string, unknown>>;
    required(newsletterResult[0], 'newsletter metadata').subject = 'Weekly newsletter';
    const evidence = [old, recent, newsletter, search('outside-prompt')];
    expect(emailReviewRecentMetadataFallback(evidence, ['request-old', 'request-new'])).toEqual([
      'request-new',
      'request-old',
    ]);
  });

  it('reads only ranked threads and allows at most two exact continuation pages', () => {
    const evidence: EmailReviewEvidenceRow[] = [
      search('thread-a'),
      search('thread-b'),
      read('thread-a', [], {
        complete: false,
        continuation: {
          tool: 'gmail.read_thread',
          input: { threadId: 'thread-a', startMessageIndex: 2, startMessageOffset: 0 },
        },
      }),
    ];
    expect(emailReviewNextThreadRead(['thread-a', 'thread-b'], evidence)).toMatchObject({
      threadId: 'thread-a',
      continuation: true,
      input: { threadId: 'thread-a', startMessageIndex: 2 },
    });
    evidence.push(
      read(
        'thread-a',
        [],
        {
          complete: false,
          continuation: {
            tool: 'gmail.read_thread',
            input: { threadId: 'thread-a', startMessageIndex: 4, startMessageOffset: 0 },
          },
        },
        2,
      ),
      read(
        'thread-a',
        [],
        {
          complete: false,
          continuation: {
            tool: 'gmail.read_thread',
            input: { threadId: 'thread-a', startMessageIndex: 6, startMessageOffset: 0 },
          },
        },
        4,
      ),
    );
    expect(emailReviewNextThreadRead(['thread-a', 'thread-b'], evidence)).toMatchObject({
      threadId: 'thread-b',
      continuation: false,
    });
  });

  it('builds the validated continuation input for an already-open selected thread', () => {
    const request = {
      kind: 'email' as const,
      queryTerms: [],
      firstToolName: 'gmail.search' as const,
      requiresThreadRead: true,
      mailQuery: EMAIL_REVIEW_QUERY,
      emailReview: {
        windowDays: 7 as const,
        requestedCount: 5 as const,
        selectedThreadIds: ['thread-a'],
        rankedCandidateIds: ['thread-a'],
      },
    };
    const evidence: ReadToolEvidence[] = [
      search('thread-a'),
      read('thread-a', [], {
        complete: false,
        continuation: {
          tool: 'gmail.read_thread',
          input: { threadId: 'thread-a', startMessageIndex: 2, startMessageOffset: 0 },
        },
      }),
    ];
    expect(nextRequiredReadTool(request, evidence)).toBe('gmail.read_thread');
    expect(buildReadToolInput(request, 'gmail.read_thread', evidence)).toMatchObject({
      threadId: 'thread-a',
      startMessageIndex: 2,
      startMessageOffset: 0,
    });
  });

  it('uses the configured owner identity, not the Gmail bot mailbox or forwarded headers', () => {
    const base: EmailReviewEvidenceRow[] = [search('thread-a')];
    expect(emailReviewOwnerMailbox(base)).toBe('owner@example.com');
    expect(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        ...base,
        read('thread-a', messages('thread-a')),
      ]),
    ).toMatchObject({
      latestMessageId: 'latest-thread-a',
      recipient: 'vendor@example.net',
    });
    expect(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        ...base,
        read('thread-a', messages('thread-a', 'owner@example.com', 'vendor@example.net')),
      ]),
    ).toBeUndefined();
    expect(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        ...base,
        read('thread-a', messages('thread-a', 'vendor@example.net', 'other@example.com')),
      ]),
    ).toBeUndefined();
    expect(
      emailReviewOwnerMailbox([
        ...base,
        {
          ...search('thread-b'),
          result: {
            ...search('thread-b').result,
            configuredOwnerMailbox: 'other@example.com',
          },
        },
      ]),
    ).toBeUndefined();
    expect(
      emailReviewOwnerMailbox([
        {
          ...search('thread-a'),
          result: {
            ...search('thread-a').result,
            configuredOwnerMailbox: undefined,
            mailboxSearched: 'assistant-bot@example.com',
          },
        },
      ]),
    ).toBeUndefined();
    expect(
      emailReviewOwnerMailbox([
        ...base,
        {
          ...search('thread-b'),
          result: {
            ...search('thread-b').result,
            configuredOwnerMailbox: undefined,
          },
        },
      ]),
    ).toBeUndefined();
  });

  it('requires a contiguous full-thread receipt and stitches exact body continuations', () => {
    const base: EmailReviewEvidenceRow[] = [search('thread-a')];
    const [oldMessage, latestMessage] = messages('thread-a');
    const old = required(oldMessage, 'old thread message');
    const latest = required(latestMessage, 'latest thread message');
    const fullBody = `${old.text} This is the remaining source text.`;
    const splitAt = 20;
    const firstPart = fullBody.slice(0, splitAt);
    const firstPage = read(
      'thread-a',
      [
        {
          ...old,
          text: firstPart,
          sourceLength: fullBody.length,
          truncated: true,
        },
      ],
      {
        complete: false,
        continuation: {
          tool: 'gmail.read_thread',
          input: {
            threadId: 'thread-a',
            startMessageIndex: 0,
            startMessageOffset: splitAt,
            maxMessages: 20,
            maxChars: 20_000,
          },
        },
      },
      0,
      0,
      2,
    );
    const finalPage = read(
      'thread-a',
      [
        {
          ...old,
          text: fullBody.slice(splitAt),
          sourceLength: fullBody.length,
          truncated: false,
        },
        latest,
      ],
      {},
      0,
      splitAt,
      2,
    );
    const completed = emailReviewCompleteThread('thread-a', 'owner@example.com', [
      ...base,
      firstPage,
      finalPage,
    ]);
    expect(completed?.messages[0]?.text).toBe(fullBody);
    expect(completed?.latestMessageId).toBe('latest-thread-a');

    const terminalOnly = read('thread-a', [latest], {}, 1, 0, 2);
    expect(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [...base, terminalOnly]),
    ).toBeUndefined();

    const skippedRange = read('thread-a', [latest], {}, 1, 0, 2);
    expect(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        ...base,
        firstPage,
        skippedRange,
      ]),
    ).toBeUndefined();
  });

  it('rejects incomplete, duplicate-ID, truncated, and same-timestamp latest messages', () => {
    const base: EmailReviewEvidenceRow[] = [search('thread-a')];
    expect(emailReviewCompleteThread('thread-a', 'owner@example.com', base)).toBeUndefined();
    expect(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        ...base,
        read('thread-a', messages('thread-a'), { complete: false }),
      ]),
    ).toBeUndefined();
    const duplicate = messages('thread-a');
    required(duplicate[1], 'duplicate latest message').messageId = required(
      duplicate[0],
      'duplicate first message',
    ).messageId;
    expect(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        ...base,
        read('thread-a', duplicate),
      ]),
    ).toBeUndefined();
    const tied = messages('thread-a');
    required(tied[0], 'tied first message').date = required(tied[1], 'tied latest message').date;
    expect(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [...base, read('thread-a', tied)]),
    ).toBeUndefined();
    const truncated: Array<Record<string, unknown>> = messages('thread-a');
    truncated[1] = { ...required(truncated[1], 'truncated latest message'), truncated: true };
    expect(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        ...base,
        read('thread-a', truncated),
      ]),
    ).toBeUndefined();
  });

  it('distinguishes a fully verified later owner reply from incomplete or ambiguous direction', () => {
    const ownerAnswered = [
      {
        messageId: 'incoming-request',
        from: 'vendor@example.net',
        to: 'owner@example.com',
        date: '2026-10-10T10:00:00Z',
        subject: 'Request',
        text: 'Could you confirm?',
        sourceLength: 'Could you confirm?'.length,
        truncated: false,
      },
      {
        messageId: 'owner-reply',
        from: 'owner@example.com',
        to: 'vendor@example.net',
        date: '2026-10-11T10:00:00Z',
        subject: 'Re: Request',
        text: 'I have confirmed.',
        sourceLength: 'I have confirmed.'.length,
        truncated: false,
      },
    ];
    const ownerAnsweredEvidence = [search('thread-a'), read('thread-a', ownerAnswered)];
    expect(
      emailReviewThreadReadResult('thread-a', 'owner@example.com', ownerAnsweredEvidence),
    ).toEqual({
      kind: 'already_answered',
      threadId: 'thread-a',
      latestMessageId: 'owner-reply',
    });
    expect(emailReviewCompleteThread('thread-a', 'owner@example.com', ownerAnsweredEvidence)).toBe(
      undefined,
    );

    const outboundWithoutMatchingInbound = [
      { ...required(ownerAnswered[0], 'prior inbound message'), to: 'other@example.net' },
      required(ownerAnswered[1], 'owner reply'),
    ];
    expect(
      emailReviewThreadReadResult('thread-a', 'owner@example.com', [
        search('thread-a'),
        read('thread-a', outboundWithoutMatchingInbound),
      ]),
    ).toEqual({ kind: 'not_eligible' });
    expect(
      emailReviewThreadReadResult('thread-a', 'owner@example.com', [
        search('thread-a'),
        read('thread-a', ownerAnswered, { complete: false }),
      ]),
    ).toBeUndefined();
  });

  it('accepts only source-bound latest-thread drafts, quotes, deadline, and recipient', () => {
    const evidence: EmailReviewEvidenceRow[] = [
      search('thread-a'),
      read('thread-a', messages('thread-a')),
    ];
    const thread = required(
      emailReviewCompleteThread('thread-a', 'owner@example.com', evidence),
      'complete review thread',
    );
    const validated = validateEmailReviewAnswer(
      {
        items: [
          {
            ...validAnswer('thread-a').items[0],
            why: 'Your account will be closed tomorrow unless you pay.',
          },
        ],
      },
      [thread],
    );
    expect(validated?.items).toHaveLength(1);
    const formatted = formatEmailReviewAnswer(
      required(validated?.items, 'validated source-bound review'),
      emailReviewCoverage(['thread-a'], [thread], [search('thread-a')]),
    );
    expect(formatted).toContain('The latest message says: “Could you confirm by Friday?”');
    expect(formatted).not.toContain('Your account will be closed tomorrow');
    expect(
      validateEmailReviewAnswer(
        { items: [{ ...validAnswer('thread-a').items[0], latestMessageId: 'old-thread-a' }] },
        [thread],
      ),
    ).toBeUndefined();
    expect(
      validateEmailReviewAnswer(
        { items: [{ ...validAnswer('thread-a').items[0], recipient: 'attacker@example.org' }] },
        [thread],
      ),
    ).toBeUndefined();
    expect(
      validateEmailReviewAnswer(
        { items: [{ ...validAnswer('thread-a').items[0], whyQuote: 'Please wire the funds.' }] },
        [thread],
      ),
    ).toBeUndefined();
    const unverifiedOptionalDeadline = validateEmailReviewAnswer(
      {
        items: [
          {
            ...validAnswer('thread-a').items[0],
            deadline: { messageId: 'missing-message', quote: 'Friday is nice' },
          },
        ],
      },
      [thread],
    );
    expect(unverifiedOptionalDeadline?.deadlineGaps).toBe(1);
    expect(unverifiedOptionalDeadline?.items[0]).toMatchObject({
      disposition: 'draft',
      deadlineNeedsReview: true,
    });
    expect(unverifiedOptionalDeadline?.items[0]?.unverifiedDeadlineQuote).toBeUndefined();
    expect(
      formatEmailReviewAnswer(
        required(unverifiedOptionalDeadline?.items, 'draft preserved with missing deadline quote'),
        emailReviewCoverage(['thread-a'], [thread], [search('thread-a')]),
      ),
    ).toContain('A deadline could not be verified against the thread');

    const deadlinePhrases = [
      'Applications close November 3.',
      'Registration closes on November 3.',
      'The last day to apply is November 3.',
      'Please submit by November 3.',
      'The payment is due on November 3.',
    ];
    for (const phrase of deadlinePhrases) {
      const phraseThread = {
        ...thread,
        messages: thread.messages.map((message, index) =>
          index === thread.messages.length - 1
            ? { ...message, text: `${message.text} ${phrase}` }
            : message,
        ),
      };
      const validatedDeadline = validateEmailReviewAnswer(
        {
          items: [
            {
              ...validAnswer('thread-a').items[0],
              deadline: { messageId: 'latest-thread-a', quote: phrase },
            },
          ],
        },
        [phraseThread],
      );
      expect(validatedDeadline?.deadlineGaps, phrase).toBe(0);
      expect(validatedDeadline?.items[0]?.deadlineQuote, phrase).toBe(phrase);
    }

    const nonDeadlinePhrase = 'The review meeting is on November 3.';
    const nonDeadlineThread = {
      ...thread,
      messages: thread.messages.map((message, index) =>
        index === thread.messages.length - 1
          ? { ...message, text: `${message.text} ${nonDeadlinePhrase}` }
          : message,
      ),
    };
    const nonDeadlineAssessment = validateEmailReviewAnswer(
      {
        items: [
          {
            ...validAnswer('thread-a').items[0],
            deadline: { messageId: 'latest-thread-a', quote: nonDeadlinePhrase },
          },
        ],
      },
      [nonDeadlineThread],
    );
    expect(nonDeadlineAssessment?.deadlineGaps).toBe(1);
    expect(nonDeadlineAssessment?.items[0]).toMatchObject({
      disposition: 'draft',
      deadlineNeedsReview: true,
      unverifiedDeadlineQuote: nonDeadlinePhrase,
    });
    expect(nonDeadlineAssessment?.items[0]?.deadlineQuote).toBeUndefined();
    expect(
      validateEmailReviewAnswer(
        {
          items: [
            { ...validAnswer('thread-a').items[0], draftBody: 'See https://attacker.example/' },
          ],
        },
        [thread],
      ),
    ).toBeUndefined();
    expect(
      validateEmailReviewAnswer(
        { items: [{ ...validAnswer('thread-a').items[0], draftBody: 'Friday works for me.' }] },
        [thread],
      ),
    ).toBeUndefined();
  });

  it('bounds thread context and discloses selected, excluded, and limited coverage separately', () => {
    const thread = required(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        search('thread-a'),
        read('thread-a', messages('thread-a')),
      ]),
      'complete bounded thread',
    );
    const large = {
      ...thread,
      messages: [
        { ...required(thread.messages[0], 'bounded thread message'), text: 'x'.repeat(60_000) },
      ],
    };
    expect(boundEmailReviewThreads([thread, large])).toMatchObject({
      threads: [thread],
      omittedThreadIds: ['thread-a'],
    });
    const coverage = emailReviewCoverage(
      ['thread-a', 'thread-b'],
      [thread],
      [search('thread-a'), search('thread-b')],
      1,
    );
    expect(coverage).toMatchObject({
      selectedThreads: 2,
      completeThreads: 1,
      contextLimitedThreads: 1,
    });
  });
});
