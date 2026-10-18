import { describe, expect, it } from 'vitest';
import {
  boundEmailReviewThreads,
  EMAIL_REVIEW_ASSESSMENT_BATCH_SIZE,
  EMAIL_REVIEW_MAX_ASSESSMENT_MODEL_CALLS,
  EMAIL_REVIEW_MAX_RANK_CANDIDATES,
  EMAIL_REVIEW_MAX_RANK_POOL,
  EMAIL_REVIEW_QUERY,
  type EmailReviewEvidenceRow,
  emailReviewAssessmentModelCallBudget,
  emailReviewAssessmentStepReserve,
  emailReviewCandidateIds,
  emailReviewCompleteThread,
  emailReviewCoverage,
  emailReviewNextThreadRead,
  emailReviewOwnerDecisionSummary,
  emailReviewOwnerMailbox,
  emailReviewPendingAssessmentThreads,
  emailReviewPrompt,
  emailReviewRankContext,
  emailReviewRecentMetadataFallback,
  emailReviewSelectionWithinAuthorizedPool,
  emailReviewThreadReadResult,
  emailReviewValidationIssues,
  emailReviewVerifiedNotEligibleThreadIds,
  formatEmailReviewAnswer,
  generateValidatedEmailReview,
  mergeEmailReviewOwnerDecisionFindings,
  revalidateEmailReviewAssessmentBatches,
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
      draftBody: 'Could you clarify what confirmation you need about the renewal date?',
      draftSourceMessageIds: [`old-${threadId}`, `latest-${threadId}`],
    },
  ],
});

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing test fixture value: ${label}`);
  return value;
}

describe('bounded no-send email review', () => {
  it('keeps qualification choices, conditional training timing, stakes and source contact in a no-send review', async () => {
    const id = 'qualification-choice';
    const source = messages(id);
    const body =
      'Are you already a STAR Referee and can we put you down as one for the team? If not please let us know if you are willing to help by becoming one. If a team has no referee the game may be forfeited and the club must pay a fine of $400. Make sure you are done before your Field Training Session. Send proof via email to coach@example.net';
    source[1] = { ...required(source[1], 'latest'), text: body, sourceLength: body.length };
    const thread = required(
      emailReviewCompleteThread(id, 'owner@example.com', [search(id), read(id, source)]),
      'thread',
    );
    const answer = {
      items: [
        {
          ...required(validAnswer(id).items[0], 'answer'),
          disposition: 'no_reply',
          recipient: null,
          draftBody: null,
          draftSourceMessageIds: [],
          whyQuote: 'Are you already a STAR Referee and can we put you down as one for the team?',
          deadline: null,
        },
      ],
    };
    const result = await generateValidatedEmailReview([thread], async () => ({
      ok: true,
      value: answer,
    }));
    const item = required(result.answer?.items[0], 'validated draft');
    expect(item.draftBody).toContain('already a STAR Referee');
    expect(item.draftBody).toContain('not yet a STAR Referee');
    expect(item.draftBody).toContain('If you cannot help:');
    expect(item.deadlineQuote).toBeUndefined();
    expect(item.deadlineNeedsReview).toBeUndefined();
    const summary = emailReviewOwnerDecisionSummary(thread);
    expect(summary.contextQuote).toContain('$400');
    expect(summary.contactQuote).toContain('coach@example.net');
    expect(summary.prerequisiteQuote).toBe(
      'Make sure you are done before your Field Training Session',
    );
    const rendered = formatEmailReviewAnswer(
      [item],
      emailReviewCoverage([id], [thread], [search(id), read(id, source)]),
      false,
    );
    expect(rendered).toContain('Activity prerequisite:');
    expect(rendered).not.toContain('Deadline: “before your');
  });

  it('does not dismiss a wrapped indirect availability request as no-reply', async () => {
    const id = 'indirect-availability';
    const source = messages(id);
    source[1] = {
      ...required(source[1], 'latest message'),
      text: 'If you are back we would love to get your updated availability* here\n<https://schedule.example/owner> and we will set up the interviews.',
      sourceLength: 160,
    };
    source[1].sourceLength = source[1].text.length;
    const thread = required(
      emailReviewCompleteThread(id, 'owner@example.com', [search(id), read(id, source)]),
      'thread',
    );
    const rejected = {
      items: [
        {
          ...required(validAnswer(id).items[0], 'answer item'),
          disposition: 'no_reply',
          recipient: null,
          draftBody: null,
          draftSourceMessageIds: [],
          whyQuote: 'we would love to get your updated availability* here',
          deadline: null,
        },
      ],
    };
    expect(emailReviewValidationIssues(rejected, [thread])).toContain(
      'item_0:direct_latest_request_requires_review_draft',
    );
    let assessmentCalls = 0;
    const result = await generateValidatedEmailReview([thread], async () => {
      assessmentCalls += 1;
      return { ok: true, value: rejected };
    });
    expect(result.answer?.items ?? []).toHaveLength(0);
    expect(result.ownerDecisionThreadIds).toContain(id);
    expect(assessmentCalls).toBe(1);
    expect(emailReviewOwnerDecisionSummary(thread)).toMatchObject({
      requestQuote: 'we would love to get your updated availability* here',
      actionUrl: 'https://schedule.example/owner',
      decisionPrompt: expect.stringContaining('Which times and time zone'),
    });
    expect(emailReviewOwnerDecisionSummary(thread).deadlineQuote).toBeUndefined();
    const backgroundLink = {
      ...thread,
      messages: thread.messages.map((message) =>
        message.messageId === thread.latestMessageId
          ? { ...message, text: 'What is your availability? Background: https://example.com/about' }
          : message,
      ),
    };
    expect(emailReviewOwnerDecisionSummary(backgroundLink).actionUrl).toBeUndefined();
  });
  it('reserves a retry assessment step only for eligible multi-thread reviews', () => {
    expect(emailReviewAssessmentStepReserve({ maxSteps: 12, requestedCount: 5 })).toBe(1);
    expect(emailReviewAssessmentStepReserve({ maxSteps: 14, requestedCount: 5 })).toBe(2);
    expect(
      emailReviewAssessmentStepReserve({ maxSteps: 22, requestedCount: 5, latestUnanswered: true }),
    ).toBe(1);
    expect(
      emailReviewAssessmentStepReserve({
        maxSteps: 22,
        requestedCount: 5,
        scopeIssue: 'Unsupported requested window.',
      }),
    ).toBe(1);
    expect(emailReviewAssessmentStepReserve({ maxSteps: 22, requestedCount: 1 })).toBe(1);
  });

  it('keeps the structured-assessment call budget cumulative across resumed passes', () => {
    expect(emailReviewAssessmentModelCallBudget(undefined, 0)).toEqual({
      used: 0,
      remaining: EMAIL_REVIEW_MAX_ASSESSMENT_MODEL_CALLS,
    });
    expect(emailReviewAssessmentModelCallBudget(2, 1)).toEqual({
      used: 2,
      remaining: EMAIL_REVIEW_MAX_ASSESSMENT_MODEL_CALLS - 2,
    });
    expect(emailReviewAssessmentModelCallBudget(undefined, 1)).toEqual({
      used: EMAIL_REVIEW_MAX_ASSESSMENT_MODEL_CALLS,
      remaining: 0,
    });
    expect(
      emailReviewAssessmentModelCallBudget(EMAIL_REVIEW_MAX_ASSESSMENT_MODEL_CALLS + 1, 0),
    ).toEqual({
      used: EMAIL_REVIEW_MAX_ASSESSMENT_MODEL_CALLS,
      remaining: 0,
    });
  });

  it('retains owner-choice findings only for the same unresolved selected thread revision', () => {
    const threadId = 'owner-choice-thread';
    const thread = emailReviewCompleteThread(threadId, 'owner@example.com', [
      search(threadId),
      read(threadId, messages(threadId)),
    ]);
    const completeThread = required(thread, 'complete owner-choice thread');
    const selectedThreadIds = [threadId];
    const firstFinding = mergeEmailReviewOwnerDecisionFindings({
      prior: undefined,
      currentThreadIds: [threadId],
      resolvedThreadIds: [],
      selectedThreadIds,
      threads: [completeThread],
    });
    expect(firstFinding).toEqual([{ threadId, latestMessageId: `latest-${threadId}` }]);

    expect(
      mergeEmailReviewOwnerDecisionFindings({
        prior: firstFinding,
        currentThreadIds: [],
        resolvedThreadIds: [],
        selectedThreadIds,
        threads: [completeThread],
      }),
    ).toEqual(firstFinding);

    expect(
      mergeEmailReviewOwnerDecisionFindings({
        prior: firstFinding,
        currentThreadIds: [],
        resolvedThreadIds: [threadId],
        selectedThreadIds,
        threads: [completeThread],
      }),
    ).toEqual([]);

    expect(
      mergeEmailReviewOwnerDecisionFindings({
        prior: firstFinding,
        currentThreadIds: [],
        resolvedThreadIds: [],
        selectedThreadIds,
        threads: [{ ...completeThread, latestMessageId: 'latest-revised' }],
      }),
    ).toEqual([]);
  });

  it('preserves a valid model-assessed nuanced reply request outside the positive ask heuristic', async () => {
    const sourceMessages = messages('nuanced-ask');
    const latest = required(sourceMessages.at(-1), 'latest message');
    latest.text =
      'RSVP using the form. It would be helpful if you could send me the revised estimate when you get a chance.';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('nuanced-ask', 'owner@example.com', [
        search('nuanced-ask'),
        read('nuanced-ask', sourceMessages),
      ]),
      'complete thread',
    );
    const answer = validAnswer('nuanced-ask');
    const item = required(answer.items[0], 'assessment');
    item.why = 'The sender would benefit from receiving the revised estimate.';
    item.whyQuote =
      'It would be helpful if you could send me the revised estimate when you get a chance.';
    Object.assign(item, { deadline: null });
    item.draftBody =
      'Could you share any details you would like reflected in the revised estimate?';

    const result = await generateValidatedEmailReview([thread], async () => ({
      ok: true,
      value: answer,
    }));

    expect(result.answer?.items[0]).toMatchObject({
      disposition: 'draft',
      whyQuote: item.whyQuote,
      draftBody: item.draftBody,
    });
    expect(result.attempts).toBe(1);
  });

  it('preserves validated assessments and does not repeatedly assess a rejected complete thread', () => {
    const threads = [
      { threadId: 'already-validated', marker: 'keep' },
      { threadId: 'rejected-once', marker: 'stop' },
      { threadId: 'newly-read', marker: 'assess' },
    ];
    expect(
      emailReviewPendingAssessmentThreads(threads, ['already-validated'], ['rejected-once']),
    ).toEqual([{ threadId: 'newly-read', marker: 'assess' }]);
  });

  it('retries prior unassessed threads only when the executor grants its bounded retry pass', () => {
    const threads = Array.from({ length: 10 }, (_, index) => ({
      threadId: `thread-${index + 1}`,
    }));
    const validated = ['thread-1', 'thread-2'];
    const previouslyUnassessed = [
      'thread-3',
      'thread-4',
      'thread-5',
      'thread-6',
      'thread-7',
      'thread-8',
    ];
    expect(
      emailReviewPendingAssessmentThreads(threads, validated, previouslyUnassessed).map(
        (thread) => thread.threadId,
      ),
    ).toEqual(['thread-9', 'thread-10']);
    expect(
      emailReviewPendingAssessmentThreads(threads, validated, previouslyUnassessed, true).map(
        (thread) => thread.threadId,
      ),
    ).toEqual([
      'thread-3',
      'thread-4',
      'thread-5',
      'thread-6',
      'thread-7',
      'thread-8',
      'thread-9',
      'thread-10',
    ]);
  });

  it('names ranking-context omissions within scanned metadata', () => {
    const coverage = emailReviewCoverage([], [], [search('thread-a'), search('thread-b')]);
    coverage.rankedMetadataThreads = 1;
    expect(formatEmailReviewAnswer([], coverage)).toContain(
      'ranking context included 1 of 2 scanned non-newsletter threads; the others were not ranked',
    );
  });

  it('states that heuristic fallback is not an exhaustive importance ranking', () => {
    const coverage = emailReviewCoverage([], [], [search('thread-a'), search('thread-b')]);
    coverage.metadataFallback = true;
    coverage.rankedMetadataThreads = 115;
    coverage.backfillShortfall = 'rank_pool_exhausted';
    const text = formatEmailReviewAnswer([], coverage);
    expect(text).toContain('automated ranking was unavailable');
    expect(text).toContain('heuristic request cues and recent metadata');
    expect(text).toContain('this is not a complete importance ranking');
    expect(text).toContain('ranked candidate pool had no replacement threads');
  });

  it('keeps metadata fallback to the bounded rank pool when a large scan cannot be ranked', () => {
    const results = Array.from({ length: 115 }, (_, index) => ({
      threadId: `candidate-${String(index).padStart(3, '0')}`,
      messageId: `message-${index}`,
      from: 'sender@example.net',
      to: 'owner@example.com',
      date: new Date(Date.UTC(2026, 9, 15, 0, index)).toISOString(),
      subject: `Request ${index}`,
      snippet: `Could you confirm request ${index}?`,
    }));
    const evidence = [search('candidate-search', { results })];
    const rankingContext = emailReviewRankContext(evidence);
    const fallback = emailReviewRecentMetadataFallback(evidence, rankingContext.candidateIds).slice(
      0,
      EMAIL_REVIEW_MAX_RANK_POOL,
    );
    const coverage = emailReviewCoverage(
      fallback,
      [],
      evidence,
      0,
      [],
      [],
      'rank_pool_exhausted',
      true,
    );
    coverage.rankedMetadataThreads = rankingContext.candidateIds.length;

    expect(rankingContext.candidateIds).toHaveLength(115);
    expect(fallback).toHaveLength(EMAIL_REVIEW_MAX_RANK_POOL);
    expect(formatEmailReviewAnswer([], coverage)).toContain(
      'this is not a complete importance ranking',
    );
  });

  it('assesses eight threads in ordered small batches and retries only missing items', async () => {
    const threadIds = Array.from({ length: 8 }, (_, index) => `thread-${index + 1}`);
    const evidence = threadIds.flatMap((id) => [search(id), read(id, messages(id))]);
    const threads = threadIds.map((id) =>
      required(
        emailReviewCompleteThread(id, 'owner@example.com', [search(id), read(id, messages(id))]),
        'complete thread',
      ),
    );
    const calls: Array<{ ids: string[]; repair: boolean }> = [];
    const result = await generateValidatedEmailReview(threads, async ({ prompt, repair }) => {
      const jsonPrompt = prompt.split('\n\nThe previous assessment could not pass')[0];
      const input = JSON.parse(jsonPrompt as string) as { threads: Array<{ threadId: string }> };
      const ids = input.threads.map((thread) => thread.threadId);
      calls.push({ ids, repair });
      return {
        ok: true,
        value: {
          items: (repair ? ids : ids.slice(0, 1)).map((id) =>
            required(validAnswer(id).items[0], 'source-grounded assessment'),
          ),
        },
      };
    });

    expect(calls.filter((call) => !call.repair).map((call) => call.ids)).toEqual([
      threadIds.slice(0, EMAIL_REVIEW_ASSESSMENT_BATCH_SIZE),
      threadIds.slice(EMAIL_REVIEW_ASSESSMENT_BATCH_SIZE),
    ]);
    expect(calls.filter((call) => call.repair).map((call) => call.ids)).toEqual([
      threadIds.slice(1, EMAIL_REVIEW_ASSESSMENT_BATCH_SIZE),
      threadIds.slice(EMAIL_REVIEW_ASSESSMENT_BATCH_SIZE + 1),
    ]);
    expect(result.attempts).toBe(4);
    expect(result.attempts).toBeLessThanOrEqual(EMAIL_REVIEW_MAX_ASSESSMENT_MODEL_CALLS);
    expect(result.answer?.items.map((item) => item.thread.threadId)).toEqual(threadIds);
    expect(result.sourceBatches?.map((batch) => batch.length)).toEqual([5, 3]);
    expect(
      revalidateEmailReviewAssessmentBatches(
        result.sourceBatches,
        threadIds,
        'owner@example.com',
        evidence,
      )?.items.map((item) => item.thread.threadId),
    ).toEqual(threadIds);
  });

  it('preserves partial validated work and enforces a cumulative assessment call budget', async () => {
    const threadIds = Array.from({ length: 8 }, (_, index) => `thread-${index + 1}`);
    const threads = threadIds.map((id) =>
      required(
        emailReviewCompleteThread(id, 'owner@example.com', [search(id), read(id, messages(id))]),
        'complete thread',
      ),
    );
    const calls: Array<{ ids: string[]; repair: boolean }> = [];
    const result = await generateValidatedEmailReview(
      threads,
      async ({ prompt, repair }) => {
        const jsonPrompt = prompt.split('\n\nThe previous assessment could not pass')[0];
        const input = JSON.parse(jsonPrompt as string) as { threads: Array<{ threadId: string }> };
        const ids = input.threads.map((thread) => thread.threadId);
        calls.push({ ids, repair });
        return calls.length === 1
          ? {
              ok: true,
              value: {
                items: [required(validAnswer(ids[0] as string).items[0], 'valid partial item')],
              },
            }
          : { ok: false };
      },
      2,
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ ids: threadIds.slice(5), repair: false });
    expect(result.attempts).toBe(2);
    expect(result.answer?.items.map((item) => item.thread.threadId)).toEqual([threadIds[0]]);
    expect(result.sourceBatches?.flat().map((item) => item.threadId)).toEqual([threadIds[0]]);
    expect(result.issues).toContain('generation_unavailable');
    expect(result.issues).toContain('assessment_model_call_limit_reached');

    const incomplete = emailReviewCompleteThread('thread-incomplete', 'owner@example.com', [
      search('thread-incomplete'),
      read('thread-incomplete', messages('thread-incomplete'), { complete: false }),
    ]);
    expect(incomplete).toBeUndefined();
  });

  it('assesses later batches before spending the bounded call budget repairing an invalid first batch', async () => {
    const threadIds = Array.from({ length: 8 }, (_, index) => `thread-${index + 1}`);
    const threads = threadIds.map((id) =>
      required(
        emailReviewCompleteThread(id, 'owner@example.com', [search(id), read(id, messages(id))]),
        'complete thread',
      ),
    );
    const calls: Array<{ ids: string[]; repair: boolean }> = [];
    const result = await generateValidatedEmailReview(
      threads,
      async ({ prompt, repair }) => {
        const jsonPrompt = prompt.split('\n\nThe previous assessment could not pass')[0];
        const input = JSON.parse(jsonPrompt as string) as { threads: Array<{ threadId: string }> };
        const ids = input.threads.map((thread) => thread.threadId);
        calls.push({ ids, repair });
        if (ids[0] === threadIds[0])
          return {
            ok: true,
            value: {
              items: ids.map((id) => ({
                ...required(validAnswer(id).items[0], 'assessment'),
                latestMessageId: 'wrong-latest-message',
              })),
            },
          };
        return {
          ok: true,
          value: { items: ids.map((id) => required(validAnswer(id).items[0], 'assessment')) },
        };
      },
      3,
    );

    expect(calls).toEqual([
      { ids: threadIds.slice(0, 5), repair: false },
      { ids: threadIds.slice(5), repair: false },
      { ids: threadIds.slice(0, 5), repair: true },
    ]);
    expect(result.attempts).toBe(3);
    expect(result.answer?.items.map((item) => item.thread.threadId)).toEqual(threadIds.slice(5));
    expect(result.sourceBatches?.map((batch) => batch.map((item) => item.threadId))).toEqual([
      threadIds.slice(5),
    ]);
    expect(result.issues).toContain('assessment_model_call_limit_reached');
  });

  it('revalidates saved no-reply assessments against complete task-local threads before reserve use', () => {
    const item = {
      ...required(validAnswer('thread-a').items[0], 'assessment'),
      disposition: 'no_reply' as const,
      recipient: null,
      deadline: null,
      draftBody: null,
      draftSourceMessageIds: [],
    };
    const source = messages('thread-a');
    const latest = required(source.at(-1), 'latest');
    latest.text = 'The renewal details are attached for your records.';
    latest.sourceLength = latest.text.length;
    const evidence = [search('thread-a'), read('thread-a', source)];
    item.whyQuote = latest.text;
    const checked = revalidateEmailReviewAssessmentBatches(
      [[item]],
      ['thread-a'],
      'owner@example.com',
      evidence,
    );
    expect(checked?.noReplyThreadIds).toEqual(['thread-a']);
    expect(
      formatEmailReviewAnswer(
        checked?.items ?? [],
        emailReviewCoverage(
          ['thread-a'],
          [
            required(
              emailReviewCompleteThread('thread-a', 'owner@example.com', evidence),
              'thread',
            ),
          ],
          evidence,
        ),
      ),
    ).toContain('prepared 0 reply drafts');
    expect(
      revalidateEmailReviewAssessmentBatches([[item]], ['thread-a'], 'owner@example.com', [
        search('thread-a'),
        read('thread-a', messages('thread-a'), { complete: false }),
      ]),
    ).toBeUndefined();
    expect(
      revalidateEmailReviewAssessmentBatches(
        [[{ ...item, whyQuote: 'Invented request' }]],
        ['thread-a'],
        'owner@example.com',
        evidence,
      ),
    ).toBeUndefined();
    expect(
      revalidateEmailReviewAssessmentBatches(
        [[item]],
        ['different-thread'],
        'owner@example.com',
        evidence,
      ),
    ).toBeUndefined();
  });

  it('retains an uncertain no-reply assessment without authorizing a reserve', () => {
    const source = messages('thread-a');
    const latest = required(source.at(-1), 'latest');
    latest.text = 'The discount offer is available through Jun. 6th.';
    latest.sourceLength = latest.text.length;
    const evidence = [search('thread-a'), read('thread-a', source)];
    const noReply = {
      ...required(validAnswer('thread-a').items[0], 'assessment'),
      disposition: 'no_reply' as const,
      recipient: null,
      deadline: null,
      whyQuote: latest.text,
      draftBody: null,
      draftSourceMessageIds: [],
    };
    const checked = revalidateEmailReviewAssessmentBatches(
      [[noReply]],
      ['thread-a'],
      'owner@example.com',
      evidence,
    );
    expect(checked?.items[0]?.deadlineNeedsReview).toBe(true);
    expect(checked?.noReplyThreadIds).toEqual([]);
    const formatted = formatEmailReviewAnswer(
      checked?.items ?? [],
      emailReviewCoverage(
        ['thread-a'],
        [required(emailReviewCompleteThread('thread-a', 'owner@example.com', evidence), 'thread')],
        evidence,
      ),
    );
    expect(formatted).toContain('**Possible deadlines to verify (1)**');
    expect(formatted).toContain('Read 1 of 1 selected threads');
    expect(formatted).not.toContain('Completed verified reply checks');
    expect(formatted).toContain(
      '**Please confirm the renewal date** — No reply draft was prepared',
    );
    expect(formatted).toContain(
      '[Open the source thread](https://mail.google.com/mail/u/0/#all/thread-a)',
    );
    expect(formatted).toContain('No reply draft was prepared; check the source');
    expect(formatted).not.toContain('through Jun. 6th');
  });

  it('marks an explicit dated offer window for review unless its body quote is supplied', () => {
    const thread = required(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        search('thread-a'),
        read('thread-a', messages('thread-a')),
      ]),
      'thread',
    );
    const latest = required(
      thread.messages.find((message) => message.messageId === thread.latestMessageId),
      'latest',
    );
    latest.text += ' The discount offer is available through Jun. 6th.';
    const without = validateEmailReviewAnswer(validAnswer('thread-a'), [thread]);
    expect(without?.items[0]?.deadlineNeedsReview).toBeUndefined();
    const noDeadline = {
      items: [{ ...required(validAnswer('thread-a').items[0], 'assessment'), deadline: null }],
    };
    expect(validateEmailReviewAnswer(noDeadline, [thread])?.items[0]?.deadlineNeedsReview).toBe(
      true,
    );
    const quoted = {
      items: [
        {
          ...required(validAnswer('thread-a').items[0], 'assessment'),
          deadline: { messageId: latest.messageId, quote: 'through Jun. 6th' },
        },
      ],
    };
    expect(validateEmailReviewAnswer(quoted, [thread])?.items[0]?.deadlineQuote).toBe(
      'through Jun. 6th',
    );
  });
  it('keeps independently verified items when another thread fails both assessments', async () => {
    const threads = ['thread-a', 'thread-b'].map((id) =>
      required(
        emailReviewCompleteThread(id, 'owner@example.com', [search(id), read(id, messages(id))]),
        'complete thread',
      ),
    );
    const good = required(validAnswer('thread-a').items[0], 'good item');
    const bad = required(validAnswer('thread-b').items[0], 'bad item');
    bad.draftBody = 'I will approve it tomorrow.';
    const repairThreadIds: string[][] = [];
    const result = await generateValidatedEmailReview(threads, async ({ prompt }) => {
      const jsonPrompt = prompt.split('\n\nThe previous assessment could not pass')[0];
      const input = JSON.parse(jsonPrompt as string) as { threads: Array<{ threadId: string }> };
      repairThreadIds.push(input.threads.map((thread) => thread.threadId));
      return {
        ok: true,
        value: {
          items: input.threads.map((thread) => (thread.threadId === 'thread-a' ? good : bad)),
        },
      };
    });
    expect(result.attempts).toBe(2);
    expect(result.answer?.items.map((item) => item.thread.threadId)).toEqual(['thread-a']);
    expect(result.answer?.items[0]?.draftBody).toBe(
      'Could you clarify what confirmation you need about the renewal date?',
    );
    expect(repairThreadIds).toEqual([['thread-a', 'thread-b'], ['thread-b']]);
    expect(result.issues).toContain('item_0:no_unsupplied_facts_or_owner_commitments');
    const missingThreadAttempts: string[][] = [];
    const wrongCount = await generateValidatedEmailReview(threads, async ({ prompt }) => {
      const jsonPrompt = prompt.split('\n\nThe previous assessment could not pass')[0];
      const input = JSON.parse(jsonPrompt as string) as { threads: Array<{ threadId: string }> };
      missingThreadAttempts.push(input.threads.map((thread) => thread.threadId));
      return {
        ok: true,
        value: {
          items: input.threads.some((thread) => thread.threadId === 'thread-a') ? [good] : [],
        },
      };
    });
    expect(missingThreadAttempts).toEqual([['thread-a', 'thread-b'], ['thread-b']]);
    expect(wrongCount.attempts).toBe(2);
    expect(wrongCount.answer?.items.map((item) => item.thread.threadId)).toEqual(['thread-a']);
    expect(wrongCount.sourceItems?.map((item) => item.threadId)).toEqual(['thread-a']);
    const promptedThreadIds: string[][] = [];
    const completedPartial = await generateValidatedEmailReview(threads, async ({ prompt }) => {
      const jsonPrompt = prompt.split('\n\nThe previous assessment could not pass')[0];
      const input = JSON.parse(jsonPrompt as string) as { threads: Array<{ threadId: string }> };
      promptedThreadIds.push(input.threads.map((thread) => thread.threadId));
      return {
        ok: true,
        value:
          promptedThreadIds.length === 1
            ? { items: [good] }
            : { items: [required(validAnswer('thread-b').items[0], 'remaining assessment')] },
      };
    });
    expect(promptedThreadIds).toEqual([['thread-a', 'thread-b'], ['thread-b']]);
    expect(completedPartial.attempts).toBe(2);
    expect(completedPartial.answer?.items.map((item) => item.thread.threadId)).toEqual([
      'thread-a',
      'thread-b',
    ]);
    expect(completedPartial.answer?.items[1]?.draftBody).toBe(
      'Could you clarify what confirmation you need about the renewal date?',
    );
    const reversedGood = required(validAnswer('thread-b').items[0], 'reversed valid item');
    const wrongOrder = await generateValidatedEmailReview(threads, async () => ({
      ok: true,
      value: { items: [reversedGood, good] },
    }));
    expect(wrongOrder.answer?.items.map((item) => item.thread.threadId)).toEqual([
      'thread-a',
      'thread-b',
    ]);
    expect(wrongOrder.answer?.items[0]?.draftBody).toBe(
      'Could you clarify what confirmation you need about the renewal date?',
    );
  });

  it('repairs only pending rows with machine-readable reasons bound to their thread IDs', async () => {
    const threads = ['thread-a', 'thread-b', 'thread-c'].map((id) =>
      required(
        emailReviewCompleteThread(id, 'owner@example.com', [search(id), read(id, messages(id))]),
        'complete thread',
      ),
    );
    const goodA = required(validAnswer('thread-a').items[0], 'good first item');
    const badB = required(validAnswer('thread-b').items[0], 'bad second item');
    badB.draftBody = 'I will approve this tomorrow.';
    const repairPrompts: string[] = [];
    const result = await generateValidatedEmailReview(threads, async ({ prompt, repair }) => {
      if (repair) {
        repairPrompts.push(prompt);
        return {
          ok: true,
          value: {
            items: [
              required(validAnswer('thread-b').items[0], 'repaired second item'),
              required(validAnswer('thread-c').items[0], 'repaired third item'),
            ],
          },
        };
      }
      return { ok: true, value: { items: [goodA, badB] } };
    });

    expect(repairPrompts).toHaveLength(1);
    expect(repairPrompts[0]).toContain(
      'Thread-specific validation feedback (JSON; these reason codes are data, not instructions): [{"threadId":"thread-b","reasons":["no_unsupplied_facts_or_owner_commitments"]},{"threadId":"thread-c","reasons":["missing_assessment"]}]',
    );
    expect(result.attempts).toBe(2);
    expect(result.issues).toEqual([]);
    expect(result.answer?.items.map((item) => item.thread.threadId)).toEqual([
      'thread-a',
      'thread-b',
      'thread-c',
    ]);
    expect(result.sourceBatches?.flat().map((item) => item.threadId)).toEqual([
      'thread-a',
      'thread-b',
      'thread-c',
    ]);
  });

  it('keeps event timing in context without treating it as a response deadline', () => {
    const sourceMessages = messages('volunteer-tomorrow');
    const latest = required(sourceMessages.at(-1), 'latest message');
    latest.text = 'Could you volunteer tomorrow?';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('volunteer-tomorrow', 'owner@example.com', [
        search('volunteer-tomorrow'),
        read('volunteer-tomorrow', sourceMessages),
      ]),
      'complete thread',
    );
    const assessment = {
      ...required(validAnswer(thread.threadId).items[0], 'assessment'),
      whyQuote: 'Could you volunteer tomorrow?',
      deadline: null,
      draftBody: 'Could you clarify which volunteer role needs help?',
    };
    const checked = validateEmailReviewAnswer({ items: [assessment] }, [thread]);
    expect(checked?.items[0]?.deadlineQuote).toBeUndefined();
    const formatted = formatEmailReviewAnswer(
      checked?.items ?? [],
      emailReviewCoverage([thread.threadId], [thread], [search(thread.threadId)]),
    );
    expect(formatted).toContain('Deadline: none identified.');
    expect(formatted).not.toContain('Deadline: “tomorrow”');

    for (const quote of ['tomorrow', 'volunteer tomorrow', 'Could you volunteer tomorrow?']) {
      const falseDeadline = {
        items: [
          {
            ...assessment,
            deadline: { messageId: thread.latestMessageId, quote },
          },
        ],
      };
      expect(emailReviewValidationIssues(falseDeadline, [thread]), quote).toContain(
        'item_0:literal_explicit_deadline_or_null',
      );
    }
    expect(
      emailReviewValidationIssues({ items: [{ ...assessment, deadline: null }] }, [thread]),
    ).not.toContain('item_0:possible_relevant_deadline_in_thread');
  });

  it('keeps explicit action deadlines visible without turning do-not-reply notices into drafts', async () => {
    const source = messages('action-deadline');
    const latest = required(source.at(-1), 'latest message');
    latest.text =
      'If your points have not been credited, please submit a retroactive claim by 11:00 PM on October 31, 2026 (KST). Do not reply to this email.';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('action-deadline', 'owner@example.com', [
        search('action-deadline'),
        read('action-deadline', source),
      ]),
      'complete thread',
    );
    const modelItem = {
      ...required(validAnswer(thread.threadId).items[0], 'assessment'),
      whyQuote: latest.text,
      deadline: null,
      draftBody: 'I will check my account.',
    };
    const review = await generateValidatedEmailReview([thread], async () => ({
      ok: true,
      value: { items: [modelItem] },
    }));
    expect(review.answer?.items[0]?.disposition).toBe('no_reply');
    expect(review.answer?.items[0]?.deadlineQuote).toContain('11:00 PM on October 31, 2026 (KST)');
    const rendered = formatEmailReviewAnswer(
      review.answer?.items ?? [],
      emailReviewCoverage([thread.threadId], [thread], [search(thread.threadId)]),
    );
    expect(rendered).toContain('Actions with deadlines — no email reply requested');
    expect(rendered).toContain('Source action:');
    expect(rendered).toContain('11:00 PM on October 31, 2026 (KST)');
    expect(rendered).not.toContain('prepared 1 reply draft');
  });

  it('leads with grounded actions and drafts, then gives compact coverage notes', () => {
    const actionMessages = messages('action-first');
    const actionLatest = required(actionMessages.at(-1), 'action message');
    actionLatest.text =
      'Please submit a retroactive claim by 11:00 PM on October 31, 2026 (KST). Do not reply to this email.';
    actionLatest.sourceLength = actionLatest.text.length;
    const actionThread = required(
      emailReviewCompleteThread('action-first', 'owner@example.com', [
        search('action-first'),
        read('action-first', actionMessages),
      ]),
      'action thread',
    );
    const draftThread = required(
      emailReviewCompleteThread('draft-second', 'owner@example.com', [
        search('draft-second'),
        read('draft-second', messages('draft-second')),
      ]),
      'draft thread',
    );
    const draft = required(
      validateEmailReviewAnswer(validAnswer('draft-second'), [draftThread])?.items[0],
      'validated draft',
    );
    const rendered = formatEmailReviewAnswer(
      [
        {
          thread: actionThread,
          disposition: 'no_reply',
          why: 'The source provides a required account action.',
          whyQuote: actionLatest.text,
          deadlineQuote: 'by 11:00 PM on October 31, 2026 (KST)',
        },
        draft,
      ],
      {
        ...emailReviewCoverage(
          ['action-first', 'draft-second'],
          [actionThread, draftThread],
          [search('action-first'), search('draft-second')],
        ),
        searchComplete: false,
        rankedMetadataThreads: 1,
      },
    );
    const actionIndex = rendered.indexOf('**Actions with deadlines');
    const draftIndex = rendered.indexOf('### Please confirm the renewal date');
    const coverageIndex = rendered.indexOf('**Coverage:**');
    expect(actionIndex).toBeGreaterThan(-1);
    expect(draftIndex).toBeGreaterThan(actionIndex);
    expect(coverageIndex).toBeGreaterThan(draftIndex);
    expect(rendered).toContain('11:00 PM on October 31, 2026 (KST)');
    expect(rendered).toContain('by Friday');
    expect(rendered).toContain('Source request: “Could you confirm by Friday?”');
    expect(rendered).toContain('Why it matters: A response is requested by the cited deadline.');
    expect(rendered).toContain(
      '[Open the source thread](https://mail.google.com/mail/u/0/#all/action-first)',
    );
    expect(rendered).toContain(
      '[Open the source thread](https://mail.google.com/mail/u/0/#all/draft-second)',
    );
    expect(rendered).toContain('mail-search metadata coverage was incomplete');
    expect(rendered).toContain('ranking context included 1 of 2 scanned non-newsletter threads');
    expect(rendered).not.toContain('not a guarantee that these are the only');
    expect(rendered).not.toContain('Each candidate was checked against its complete thread');
  });

  it('collapses only strongly identified duplicate RSVP reminders and preserves their source details', () => {
    const makeAssessed = (
      threadId: string,
      subject: string,
      body: string,
      sender = 'vendor@example.net',
    ) => {
      const source = messages(threadId);
      const latest = required(source.at(-1), 'latest message');
      latest.subject = subject;
      latest.from = sender;
      latest.text = body;
      latest.sourceLength = body.length;
      const thread = required(
        emailReviewCompleteThread(threadId, 'owner@example.com', [
          search(threadId),
          read(threadId, source),
        ]),
        'complete thread',
      );
      const deadlineQuote = /\bby\s+(?:October|November)\s+\d{1,2}\b/i.exec(body)?.[0];
      const item = {
        ...required(validAnswer(threadId).items[0], 'assessment'),
        recipient: thread.recipient,
        whyQuote: body,
        deadline: deadlineQuote
          ? { messageId: thread.latestMessageId, quote: deadlineQuote }
          : null,
        draftBody: 'Thanks for the reminder. Could you clarify the RSVP details for this event?',
      };
      return required(
        validateEmailReviewAnswer({ items: [item] }, [thread])?.items[0],
        'validated',
      );
    };
    const first = makeAssessed(
      'pta-one',
      'Reminder to RSVP for: October PTA Meeting In-Person - Wednesday, 10/21',
      'Please RSVP for the October PTA meeting on October 21, 2026 by October 18. The meeting at Cafetorium starts at 6:00 PM. A headcount is needed for food.',
    );
    const duplicate = makeAssessed(
      'pta-two',
      'RSVP Requested: October PTA Meeting In-Person - Wednesday, 10/21',
      'Please RSVP for the October PTA meeting on October 21, 2026 by October 17. The meeting at Cafetorium runs from 6 - 7:30 PM. The school is hosting a separate event at Alamo next week.',
    );
    const differentDate = makeAssessed(
      'pta-three',
      'PTA Family Night RSVP',
      'Please RSVP for the PTA meeting on October 28, 2026 by October 18.',
    );
    const genericOne = makeAssessed(
      'generic-one',
      'Meeting RSVP',
      'Please RSVP for the meeting at Central Hall on October 21, 2026 by October 18.',
    );
    const genericTwo = makeAssessed(
      'generic-two',
      'Meeting RSVP',
      'Please RSVP for the meeting at North Hall on October 21, 2026 by October 18.',
    );
    const otherOrganizer = makeAssessed(
      'pta-other-organizer',
      'PTA Family Night RSVP',
      'Please RSVP for the PTA meeting on October 21, 2026 by October 18.',
      'events@example.net',
    );
    const differentVenueOne = makeAssessed(
      'pta-central-hall',
      'PTA Family Night RSVP',
      'Please RSVP for the PTA meeting at Central Hall on October 21, 2026 by October 18.',
    );
    const differentVenueTwo = makeAssessed(
      'pta-north-hall',
      'PTA Family Night RSVP',
      'Please RSVP for the PTA meeting at North Hall on October 21, 2026 by October 18.',
    );
    const selected = [
      first,
      duplicate,
      differentDate,
      genericOne,
      genericTwo,
      otherOrganizer,
      differentVenueOne,
      differentVenueTwo,
    ];
    const rendered = formatEmailReviewAnswer(selected, {
      ...emailReviewCoverage(
        selected.map((item) => item.thread.threadId),
        selected.map((item) => item.thread),
        selected.map((item) => search(item.thread.threadId)),
      ),
      searchComplete: true,
    });
    expect(rendered).toContain('prepared 7 reply drafts');
    expect(rendered).toContain('A headcount is needed for food.');
    expect(rendered).toContain('Additional request in a duplicate reminder:');
    expect(rendered).toContain('Deadline: “by October 17”');
    expect(rendered).toContain(
      'duplicate reminder thread](https://mail.google.com/mail/u/0/#all/pta-two)',
    );
    expect(
      rendered.match(
        /### Reminder to RSVP for: October PTA Meeting In-Person - Wednesday, 10\/21/g,
      ),
    ).toHaveLength(1);
    expect(rendered).not.toContain('### RSVP Requested: October PTA Meeting In-Person');
    expect(rendered.match(/### PTA Family Night RSVP/g)).toHaveLength(4);
    expect(rendered.match(/### Meeting RSVP/g)).toHaveLength(2);
  });

  it('keeps conflicting RSVP times separate when a detail-free reminder intervenes', () => {
    const makeAssessed = (threadId: string, body: string) => {
      const source = messages(threadId);
      const latest = required(source.at(-1), 'latest message');
      latest.subject = 'Reminder to RSVP for: PTA Meeting - October 21, 2026';
      latest.text = body;
      latest.sourceLength = body.length;
      const thread = required(
        emailReviewCompleteThread(threadId, 'owner@example.com', [
          search(threadId),
          read(threadId, source),
        ]),
        'complete thread',
      );
      const item = {
        ...required(validAnswer(threadId).items[0], 'assessment'),
        recipient: thread.recipient,
        whyQuote: body,
        deadline: { messageId: thread.latestMessageId, quote: 'by October 18' },
        draftBody: 'Thanks for the reminder. Could you clarify the RSVP details for this event?',
      };
      return required(
        validateEmailReviewAnswer({ items: [item] }, [thread])?.items[0],
        'validated',
      );
    };
    const sixPm = makeAssessed(
      'pta-six-pm',
      'Please RSVP for the PTA meeting on October 21, 2026 by October 18. The meeting at Cafetorium starts at 6:00 PM. A headcount is needed for food.',
    );
    const noTime = makeAssessed(
      'pta-no-time',
      'Please RSVP for the PTA meeting on October 21, 2026 by October 18. A headcount is needed for food. Please send your attendance choice so the event team can prepare. Families are welcome to share this request with anyone who may attend.',
    );
    const sevenPm = makeAssessed(
      'pta-seven-pm',
      'Please RSVP for the PTA meeting on October 21, 2026 by October 18. The meeting at Cafetorium starts at 7:00 PM. A headcount is needed for food.',
    );
    const selected = [sixPm, noTime, sevenPm];
    const rendered = formatEmailReviewAnswer(selected, {
      ...emailReviewCoverage(
        selected.map((item) => item.thread.threadId),
        selected.map((item) => item.thread),
        selected.map((item) => search(item.thread.threadId)),
      ),
      searchComplete: true,
    });

    expect(
      rendered.match(/### Reminder to RSVP for: PTA Meeting - October 21, 2026/g),
    ).toHaveLength(2);
    expect(rendered).toContain('starts at 6:00 PM');
    expect(rendered).toContain('starts at 7:00 PM');
    expect(rendered).toContain('Additional request in a duplicate reminder:');
    expect(rendered).toContain('Read 3 of 3 selected threads');
    expect(rendered).toContain('prepared 2 reply drafts');
  });

  it('deduplicates by the event clock rather than RSVP deadline clocks', () => {
    const makeAssessed = (threadId: string, body: string) => {
      const source = messages(threadId);
      const latest = required(source.at(-1), 'latest message');
      latest.subject = 'Reminder to RSVP for: PTA Meeting - October 21, 2026';
      latest.text = body;
      latest.sourceLength = body.length;
      const thread = required(
        emailReviewCompleteThread(threadId, 'owner@example.com', [
          search(threadId),
          read(threadId, source),
        ]),
        'complete thread',
      );
      const item = {
        ...required(validAnswer(threadId).items[0], 'assessment'),
        recipient: thread.recipient,
        whyQuote: body,
        deadline: {
          messageId: thread.latestMessageId,
          quote: body.match(/RSVP by [^.]+/)?.[0] ?? 'RSVP requested',
        },
        draftBody: 'Thanks for the reminder. Could you clarify the RSVP details for this event?',
      };
      return required(
        validateEmailReviewAnswer({ items: [item] }, [thread])?.items[0],
        'validated',
      );
    };
    const rangeAndDeadlineFive = makeAssessed(
      'pta-range-deadline-five',
      'Please RSVP by 5:00 PM for the PTA meeting on October 21, 2026. The meeting at Cafetorium runs from 6:00–7:30 PM.',
    );
    const sameStartDeadlineSix = makeAssessed(
      'pta-start-deadline-six',
      'Please RSVP by 6:00 PM for the PTA meeting on October 21, 2026. The meeting at Cafetorium starts at 6:00 PM.',
    );
    const conflictingStart = makeAssessed(
      'pta-start-seven',
      'Please RSVP by 5:00 PM for the PTA meeting on October 21, 2026. The meeting at Cafetorium starts at 7:00 PM.',
    );
    const selected = [rangeAndDeadlineFive, sameStartDeadlineSix, conflictingStart];
    const rendered = formatEmailReviewAnswer(selected, {
      ...emailReviewCoverage(
        selected.map((item) => item.thread.threadId),
        selected.map((item) => item.thread),
        selected.map((item) => search(item.thread.threadId)),
      ),
      searchComplete: true,
    });

    expect(
      rendered.match(/### Reminder to RSVP for: PTA Meeting - October 21, 2026/g),
    ).toHaveLength(2);
    expect(rendered).toContain('runs from 6:00–7:30 PM');
    expect(rendered).toContain('starts at 7:00 PM');
    expect(rendered).toContain('Additional request in a duplicate reminder:');
    expect(rendered).toContain('prepared 2 reply drafts');

    const ambiguousSelected = [
      makeAssessed(
        'pta-ambiguous-five-six',
        'Please RSVP by 5:00 PM for the PTA meeting on October 21, 2026. We will also discuss the 6:00 PM volunteer briefing and 7:00 PM fundraiser.',
      ),
      makeAssessed(
        'pta-ambiguous-five-seven',
        'Please RSVP by 5:00 PM for the PTA meeting on October 21, 2026. We will also discuss the 6:00 PM volunteer briefing and 8:00 PM fundraiser.',
      ),
    ];
    const ambiguousRendered = formatEmailReviewAnswer(ambiguousSelected, {
      ...emailReviewCoverage(
        ambiguousSelected.map((item) => item.thread.threadId),
        ambiguousSelected.map((item) => item.thread),
        ambiguousSelected.map((item) => search(item.thread.threadId)),
      ),
      searchComplete: true,
    });
    expect(
      ambiguousRendered.match(/### Reminder to RSVP for: PTA Meeting - October 21, 2026/g),
    ).toHaveLength(2);
  });

  it('recognizes a dated removal outcome as an explicit deadline', () => {
    const sourceMessages = messages('donation-deadline');
    const latest = required(sourceMessages.at(-1), 'latest message');
    latest.text =
      'Please let us know whether to collect the clothes; unclaimed clothes will be donated NEXT FRIDAY, 10/23.';
    latest.sourceLength = latest.text.length;
    const evidence = [search('donation-deadline'), read('donation-deadline', sourceMessages)];
    const thread = required(
      emailReviewCompleteThread('donation-deadline', 'owner@example.com', evidence),
      'complete deadline thread',
    );
    const assessment = required(validAnswer(thread.threadId).items[0], 'assessment');
    assessment.whyQuote = 'Please let us know whether to collect the clothes';
    assessment.deadline = {
      messageId: thread.latestMessageId,
      quote: 'NEXT FRIDAY, 10/23',
    };

    expect(validateEmailReviewAnswer({ items: [assessment] }, [thread])?.items[0]).toMatchObject({
      deadlineQuote: 'NEXT FRIDAY, 10/23',
    });
    expect(
      emailReviewValidationIssues({ items: [{ ...assessment, deadline: null }] }, [thread]),
    ).toContain('item_0:possible_relevant_deadline_in_thread');
  });

  it('requires a review draft for a direct volunteer ask without promising availability', async () => {
    const sourceMessages = messages('volunteer-ask');
    const latest = required(sourceMessages.at(-1), 'latest message');
    latest.text =
      "Hey y'all - nobody has signed up for tomorrow. Are you able to? Thanks! Volunteer now!";
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('volunteer-ask', 'owner@example.com', [
        search('volunteer-ask'),
        read('volunteer-ask', sourceMessages),
      ]),
      'complete volunteer thread',
    );
    const base = required(validAnswer(thread.threadId).items[0], 'draft assessment');
    const noReply = {
      ...base,
      disposition: 'no_reply' as const,
      recipient: null,
      deadline: null,
      draftBody: null,
      draftSourceMessageIds: [],
      whyQuote: 'Are you able to?',
    };
    expect(emailReviewValidationIssues({ items: [noReply] }, [thread])).toContain(
      'item_0:direct_latest_request_requires_review_draft',
    );

    const groundedDraft = {
      ...base,
      whyQuote: 'nobody has signed up for tomorrow. Are you able to?',
      deadline: null,
      draftBody: 'Thanks for the reminder. I appreciate you checking with me.',
    };
    expect(validateEmailReviewAnswer({ items: [groundedDraft] }, [thread])).toBeUndefined();
    expect(emailReviewValidationIssues({ items: [groundedDraft] }, [thread])).toContain(
      'item_0:draft_must_address_latest_request',
    );
    expect(
      emailReviewValidationIssues(
        { items: [{ ...groundedDraft, draftBody: 'I can volunteer tomorrow.' }] },
        [thread],
      ),
    ).toContain('item_0:no_unsupplied_facts_or_owner_commitments');

    const answeredMessages = [
      ...messages('already-answered'),
      {
        messageId: 'owner-reply-already-sent',
        from: 'owner@example.com',
        to: 'vendor@example.net',
        date: '2026-10-12T17:00:00Z',
        subject: 'Re: volunteer request',
        text: 'Thanks for asking.',
        sourceLength: 'Thanks for asking.'.length,
        truncated: false,
      },
    ];
    expect(
      emailReviewThreadReadResult('already-answered', 'owner@example.com', [
        search('already-answered'),
        read('already-answered', answeredMessages),
      ]),
    ).toMatchObject({ kind: 'already_answered' });

    const repaired = await generateValidatedEmailReview([thread], async () => ({
      ok: true,
      value: { items: [noReply] },
    }));
    expect(repaired.answer?.items[0]).toMatchObject({
      disposition: 'draft',
      draftBody: [
        'If you can help: “Thanks for checking about the volunteer need tomorrow. I can help.”',
        'If you cannot: “Thanks for checking about the volunteer need tomorrow. I’m not available.”',
        'Owner decision required: choose the accurate option, remove the other, and edit before sending.',
      ].join('\n\n'),
    });
    expect(repaired.answer?.items[0]?.deadlineQuote).toBeUndefined();
    expect(repaired.issues).toEqual([]);
    const formatted = formatEmailReviewAnswer(
      repaired.answer?.items ?? [],
      emailReviewCoverage([thread.threadId], [thread], [search(thread.threadId)]),
    );
    expect(formatted).toContain(
      '**Draft alternatives — choose one and remove the other before sending:**',
    );
  });

  it('marks generic reply-by requests incomplete and does not draft marketing mail', async () => {
    const byFridayMessages = messages('please-reply-by-friday');
    const byFridayLatest = required(byFridayMessages.at(-1), 'latest message');
    byFridayLatest.text = 'Please reply by Friday with your preferred option.';
    byFridayLatest.sourceLength = byFridayLatest.text.length;
    const byFridayThread = required(
      emailReviewCompleteThread('please-reply-by-friday', 'owner@example.com', [
        search('please-reply-by-friday'),
        read('please-reply-by-friday', byFridayMessages),
      ]),
      'complete reply-by deadline thread',
    );
    const byFridayNoReply = {
      ...required(validAnswer(byFridayThread.threadId).items[0], 'by-Friday assessment'),
      disposition: 'no_reply' as const,
      recipient: null,
      whyQuote: byFridayLatest.text,
      deadline: { messageId: byFridayThread.latestMessageId, quote: 'by Friday' },
      draftBody: null,
      draftSourceMessageIds: [],
    };
    const byFridayRepair = await generateValidatedEmailReview([byFridayThread], async () => ({
      ok: true,
      value: { items: [byFridayNoReply] },
    }));
    expect(byFridayRepair.answer).toBeUndefined();
    expect(byFridayRepair.ownerDecisionThreadIds).toEqual([byFridayThread.threadId]);
    expect(byFridayRepair.attempts).toBe(2);
    expect(byFridayRepair.issues).toContain(
      'item_0:owner_decision_scaffolding_not_recipient_draft',
    );

    const byTomorrowMessages = messages('please-reply-by-tomorrow');
    const byTomorrowLatest = required(byTomorrowMessages.at(-1), 'latest message');
    byTomorrowLatest.text = 'Please reply by tomorrow with your preferred option.';
    byTomorrowLatest.sourceLength = byTomorrowLatest.text.length;
    const byTomorrowThread = required(
      emailReviewCompleteThread('please-reply-by-tomorrow', 'owner@example.com', [
        search('please-reply-by-tomorrow'),
        read('please-reply-by-tomorrow', byTomorrowMessages),
      ]),
      'complete reply-by-tomorrow thread',
    );
    const byTomorrowNoReply = {
      ...required(validAnswer(byTomorrowThread.threadId).items[0], 'by-tomorrow assessment'),
      disposition: 'no_reply' as const,
      recipient: null,
      whyQuote: byTomorrowLatest.text,
      deadline: { messageId: byTomorrowThread.latestMessageId, quote: 'by tomorrow' },
      draftBody: null,
      draftSourceMessageIds: [],
    };
    const byTomorrowRepair = await generateValidatedEmailReview([byTomorrowThread], async () => ({
      ok: true,
      value: { items: [byTomorrowNoReply] },
    }));
    expect(byTomorrowRepair.answer).toBeUndefined();
    expect(byTomorrowRepair.ownerDecisionThreadIds).toEqual([byTomorrowThread.threadId]);

    const promotionalMessages = messages('promotional-reply-by-friday');
    const promotionalLatest = required(promotionalMessages.at(-1), 'latest message');
    promotionalLatest.subject = 'Weekly newsletter coupon';
    promotionalLatest.text = 'Please reply by Friday to claim this coupon.';
    promotionalLatest.sourceLength = promotionalLatest.text.length;
    const promotionalThread = required(
      emailReviewCompleteThread('promotional-reply-by-friday', 'owner@example.com', [
        search('promotional-reply-by-friday'),
        read('promotional-reply-by-friday', promotionalMessages),
      ]),
      'complete promotional thread',
    );
    const promotionalNoReply = {
      ...required(validAnswer(promotionalThread.threadId).items[0], 'promotional assessment'),
      disposition: 'no_reply' as const,
      recipient: null,
      whyQuote: promotionalLatest.text,
      deadline: { messageId: promotionalThread.latestMessageId, quote: 'by Friday' },
      draftBody: null,
      draftSourceMessageIds: [],
    };
    expect(
      emailReviewValidationIssues({ items: [promotionalNoReply] }, [promotionalThread]),
    ).not.toContain('item_0:direct_latest_request_requires_review_draft');
  });

  it('offers owner-chosen alternatives for direct help and attendance questions', async () => {
    for (const [id, text, expected] of [
      ['direct-help-question', 'Could you help at the event tomorrow?', 'If you can help:'],
      [
        'confirmed-attendance-question',
        'Please confirm whether you can attend tomorrow.',
        'If you plan to attend:',
      ],
    ] as const) {
      const sourceMessages = messages(id);
      const latest = required(sourceMessages.at(-1), 'latest message');
      latest.text = text;
      latest.sourceLength = text.length;
      const thread = required(
        emailReviewCompleteThread(id, 'owner@example.com', [search(id), read(id, sourceMessages)]),
        `complete ${id} thread`,
      );
      const noReply = {
        ...required(validAnswer(thread.threadId).items[0], `${id} assessment`),
        disposition: 'no_reply' as const,
        recipient: null,
        whyQuote: text,
        deadline: null,
        draftBody: null,
        draftSourceMessageIds: [],
      };
      const repaired = await generateValidatedEmailReview([thread], async () => ({
        ok: true,
        value: { items: [noReply] },
      }));
      expect(repaired.answer?.items[0]?.draftBody).toContain(expected);
      expect(repaired.answer?.items[0]?.draftBody).toContain(
        'Owner decision required: choose the accurate option',
      );
      expect(repaired.answer?.items[0]?.draftBody).not.toContain('[OWNER DECISION REQUIRED:');
    }
  });

  it('does not turn a bare event date into a deadline', () => {
    const sourceMessages = messages('event-date');
    const latest = required(sourceMessages.at(-1), 'latest message');
    latest.text = 'The meeting will be held on October 23.';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('event-date', 'owner@example.com', [
        search('event-date'),
        read('event-date', sourceMessages),
      ]),
      'complete event thread',
    );
    const assessment = required(validAnswer(thread.threadId).items[0], 'assessment');
    assessment.whyQuote = latest.text;
    assessment.deadline = { messageId: thread.latestMessageId, quote: 'October 23' };

    expect(validateEmailReviewAnswer({ items: [assessment] }, [thread])?.items[0]).toMatchObject({
      deadlineNeedsReview: true,
      unverifiedDeadlineQuote: 'October 23',
    });
    expect(emailReviewValidationIssues({ items: [assessment] }, [thread])).toContain(
      'item_0:literal_explicit_deadline_or_null',
    );
  });

  it('reports reviewed assessments separately from complete source reads', () => {
    const threads = ['assessed-a', 'unassessed-b'].map((threadId) =>
      required(
        emailReviewCompleteThread(threadId, 'owner@example.com', [
          search(threadId),
          read(threadId, messages(threadId)),
        ]),
        'complete thread',
      ),
    );
    const first = required(threads[0], 'assessed thread');
    const answer = validateEmailReviewAnswer(validAnswer(first.threadId), [first]);
    const text = formatEmailReviewAnswer(
      answer?.items ?? [],
      emailReviewCoverage(
        threads.map((thread) => thread.threadId),
        threads,
        threads.flatMap((thread) => [
          search(thread.threadId),
          read(thread.threadId, messages(thread.threadId)),
        ]),
      ),
    );
    expect(text).toContain('Read 2 of 2 selected threads');
    expect(text).not.toContain('Completed verified reply checks');
    expect(text).toContain('complete, eligible source reads: 2 of 2 selected threads');
  });

  it('keeps assessed, eligible, ineligible, incomplete, and unassessed counts distinct', () => {
    const eligibleThreads = Array.from({ length: 8 }, (_, index) =>
      required(
        emailReviewCompleteThread(`eligible-${index}`, 'owner@example.com', [
          search(`eligible-${index}`),
          read(`eligible-${index}`, messages(`eligible-${index}`)),
        ]),
        'complete eligible thread',
      ),
    );
    const first = required(eligibleThreads[0], 'first eligible thread');
    const assessment = validateEmailReviewAnswer(validAnswer(first.threadId), [first]);
    const evidence = eligibleThreads.flatMap((thread) => [
      search(thread.threadId),
      read(thread.threadId, thread.messages),
    ]);
    const coverage = emailReviewCoverage(
      [
        ...eligibleThreads.map((thread) => thread.threadId),
        'ineligible-thread',
        'incomplete-thread',
      ],
      eligibleThreads,
      evidence,
      0,
      [],
      ['ineligible-thread'],
      undefined,
      false,
      7,
    );
    coverage.unassessedThreads = eligibleThreads
      .slice(1)
      .map(({ threadId, subject }) => ({ threadId, subject }));
    const text = formatEmailReviewAnswer(assessment?.items ?? [], coverage, false, {
      requestedCount: 5,
    });

    expect(text).toContain(
      'Read 9 of 10 selected threads from a bounded 7-day mail scan; assessed 1 of 8 complete, eligible threads; prepared 1 reply draft (you asked for 5).',
    );
    expect(text).toContain('complete, eligible source reads: 8 of 10 selected threads');
    expect(text).toContain(
      '1 selected thread was reviewed but did not meet the reply-draft criteria',
    );
    expect(text).toContain(
      '1 selected thread lacked enough complete chronology or eligibility evidence to assess',
    );
    expect(text).toContain('7 selected threads could not be fully assessed');
    expect(text).toContain('**Assessment unfinished (7)**');
    for (const thread of eligibleThreads.slice(1))
      expect(text).toContain(`https://mail.google.com/mail/u/0/#all/${thread.threadId}`);
    expect(text).not.toContain('unassessed threads listed above');
  });

  it('discloses mailbox mismatch and complete threads left unassessed without leaking addresses', () => {
    const evidence = [
      search('thread-a', {
        mailboxSearched: 'connected-alias@example.net',
        configuredOwnerMailbox: 'owner@example.com',
      }),
    ];
    const coverage = emailReviewCoverage(
      ['thread-a'],
      [],
      evidence,
      0,
      [],
      [],
      undefined,
      false,
      1,
    );
    expect(coverage).toMatchObject({ searchMailboxMismatch: true, unassessedCompleteThreads: 1 });
    const formatted = formatEmailReviewAnswer([], coverage);
    expect(formatted).toContain('connected mailbox used for search differs');
    expect(formatted).toContain('1 selected thread could not be fully assessed');
    expect(formatted).not.toContain('connected-alias@example.net');
    expect(formatted).not.toContain('owner@example.com');
  });

  it('does not imply that no reply is needed when complete requests could not be assessed', () => {
    const thread = required(
      emailReviewCompleteThread('unassessed-request', 'owner@example.com', [
        search('unassessed-request'),
        read('unassessed-request', messages('unassessed-request')),
      ]),
      'complete unanswered request',
    );
    const coverage = emailReviewCoverage(
      [thread.threadId],
      [thread],
      [search(thread.threadId), read(thread.threadId, thread.messages)],
      0,
      [],
      [],
      undefined,
      false,
      1,
    );
    const text = formatEmailReviewAnswer([], coverage, false, { requestedCount: 5 });
    expect(text).toContain('assessed 0 of 1 complete, eligible threads');
    expect(text).toContain('The reply review is incomplete');
    expect(text).toContain('could not reliably determine all requests needing your response');
    expect(text).not.toContain('No reply-worthy request was confirmed');
  });

  it('repairs a rejected owner commitment using the same complete source threads', async () => {
    const thread = required(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        search('thread-a'),
        read('thread-a', messages('thread-a')),
      ]),
      'complete thread',
    );
    const invalid = validAnswer('thread-a');
    required(invalid.items[0], 'assessment item').draftBody = 'I will approve it tomorrow.';
    const calls: Array<{ prompt: string; repair: boolean }> = [];
    const result = await generateValidatedEmailReview([thread], async (input) => {
      calls.push(input);
      return { ok: true, value: calls.length === 1 ? invalid : validAnswer('thread-a') };
    });
    expect(result.answer?.items[0]?.draftBody).toBe(
      'Could you clarify what confirmation you need about the renewal date?',
    );
    expect(result.attempts).toBe(2);
    const repair = required(calls[1], 'repair call');
    expect(repair.repair).toBe(true);
    expect(repair.prompt).toContain('no_unsupplied_facts_or_owner_commitments');
    expect(repair.prompt).not.toContain('I will approve it tomorrow.');
  });

  it('repairs quotes that appear in the subject but not the named message body', async () => {
    const thread = required(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        search('thread-a'),
        read('thread-a', messages('thread-a')),
      ]),
      'complete thread',
    );
    const latest = required(
      thread.messages.find((message) => message.messageId === thread.latestMessageId),
      'latest inbound message',
    );
    latest.subject = 'Please confirm by October 30';

    const invalid = validAnswer('thread-a');
    const invalidItem = required(invalid.items[0], 'invalid assessment item');
    invalidItem.whyQuote = latest.subject;
    invalidItem.deadline = { messageId: latest.messageId, quote: latest.subject };
    expect(validateEmailReviewAnswer(invalid, [thread])).toBeUndefined();

    const calls: Array<{ prompt: string; repair: boolean }> = [];
    const result = await generateValidatedEmailReview([thread], async (input) => {
      calls.push(input);
      return {
        ok: true,
        value: calls.length === 1 ? invalid : validAnswer('thread-a'),
      };
    });

    expect(result.answer?.items[0]?.whyQuote).toBe('Could you confirm by Friday?');
    expect(result.answer?.items[0]?.deadlineQuote).toBe('by Friday');
    expect(result.attempts).toBe(2);
    const initial = required(calls[0], 'initial call');
    expect(initial.repair).toBe(false);
    expect(initial.prompt).toContain(
      'copy a verbatim, contiguous substring from that exact message body',
    );
    expect(initial.prompt).toContain('set whyMessageId to exactly latestMessageId');
    expect(initial.prompt).toContain(
      'Do not use quoted or forwarded text as the reason for a new reply',
    );
    expect(initial.prompt).toContain(
      'every message ID needed to support its factual details, links, or owner commitments',
    );
    expect(initial.prompt).toContain('use its message ID, or return deadline: null');
    expect(initial.prompt).toContain(
      'Subject lines, snippets, headers, and other messages are not quote sources',
    );
    const repair = required(calls[1], 'repair call');
    expect(repair.repair).toBe(true);
    expect(repair.prompt).toContain('body text of the exact message identified by whyMessageId');
    expect(repair.prompt).toContain(
      'body text of the exact message identified by deadline.messageId',
    );
    expect(repair.prompt).toContain(
      'Subject lines, snippets, headers, and other messages are not quote sources',
    );
  });

  it('uses exact-source alternatives when an assessment fails and keeps event dates out of deadlines', async () => {
    const makeRequestThread = (threadId: string, sender: string, subject: string, text: string) => {
      const sourceMessages = messages(threadId, sender);
      const latest = required(sourceMessages.at(-1), 'latest source message');
      latest.subject = subject;
      latest.text = text;
      latest.sourceLength = text.length;
      return required(
        emailReviewCompleteThread(threadId, 'owner@example.com', [
          search(threadId),
          read(threadId, sourceMessages),
        ]),
        'complete request thread',
      );
    };
    const volunteer = makeRequestThread(
      'volunteer-request',
      'coach@example.org',
      'Volunteers needed tomorrow',
      "Hey y'all — nobody has signed up for tomorrow. Are you able to?",
    );
    const rsvp = makeRequestThread(
      'pta-rsvp',
      'pta@example.org',
      'Please RSVP for October 21',
      "If you have not yet RSVP'd, please click this link to RSVP by October 18 for the October 21 PTA meeting: https://example.org/pta-rsvp",
    );
    const assessment = (
      thread: typeof volunteer,
      whyQuote: string,
      deadlineQuote: string | null,
      draftBody: string,
    ) => ({
      threadId: thread.threadId,
      latestMessageId: thread.latestMessageId,
      disposition: 'draft' as const,
      recipient: thread.recipient,
      why: 'The sender is waiting for a response to this request.',
      whyMessageId: thread.latestMessageId,
      whyQuote,
      deadline: deadlineQuote ? { messageId: thread.latestMessageId, quote: deadlineQuote } : null,
      draftBody,
      draftSourceMessageIds: [thread.latestMessageId],
    });
    const valid = {
      items: [
        assessment(
          volunteer,
          'Are you able to?',
          null,
          'Thanks for thinking of me. I appreciate you asking.',
        ),
        assessment(
          rsvp,
          "If you have not yet RSVP'd, please click this link to RSVP",
          'by October 18',
          'Thanks for the reminder. I appreciate you checking with me.',
        ),
      ],
    };
    const invalid = structuredClone(valid);
    const firstInvalid = required(invalid.items[0], 'invalid volunteer assessment');
    firstInvalid.whyMessageId = required(volunteer.messages[0], 'earlier message').messageId;
    firstInvalid.whyQuote = 'Nobody signed up and you can help tomorrow.';
    firstInvalid.deadline = { messageId: volunteer.latestMessageId, quote: 'by tomorrow' };

    expect(emailReviewValidationIssues(invalid, [volunteer, rsvp])).toEqual(
      expect.arrayContaining([
        'item_0:why_quote_must_be_latest_inbound',
        'item_0:literal_why_quote_from_named_message',
        'item_0:literal_explicit_deadline_or_null',
      ]),
    );
    const calls: Array<{ prompt: string; repair: boolean }> = [];
    const result = await generateValidatedEmailReview([volunteer, rsvp], async (input) => {
      calls.push(input);
      return { ok: true, value: calls.length === 1 ? invalid : valid };
    });

    expect(result.attempts).toBe(1);
    expect(result.answer?.items.map((item) => item.disposition)).toEqual(['draft', 'draft']);
    expect(result.answer?.items.map((item) => item.deadlineQuote)).toEqual([
      undefined,
      'by October 18',
    ]);
    expect(result.answer?.items[0]?.draftBody).toContain('If you can help:');
    expect(result.answer?.items[1]?.draftBody).toContain('If you plan to attend:');
    expect(result.issues).toEqual([]);
    for (const placeholder of [
      'Thanks for checking. [Choose one: available / unavailable].',
      'Thanks. [available / unavailable]',
    ]) {
      const unresolvedChoice = structuredClone(valid);
      const placeholderAssessment = required(unresolvedChoice.items[0], 'placeholder control');
      placeholderAssessment.draftBody = placeholder;
      expect(emailReviewValidationIssues(unresolvedChoice, [volunteer, rsvp])).toContain(
        'item_0:no_unresolved_draft_placeholders',
      );
      expect(validateEmailReviewAnswer(unresolvedChoice, [volunteer, rsvp])).toBeUndefined();
    }
    const linkThread = structuredClone(volunteer);
    const latestLinkMessage = required(
      linkThread.messages.find((message) => message.messageId === linkThread.latestMessageId),
      'latest link source message',
    );
    latestLinkMessage.text += ' Details: https://example.org/details';
    const sourceBackedMarkdownLink = structuredClone(
      required(valid.items[0], 'valid source-bound draft'),
    );
    sourceBackedMarkdownLink.draftBody = '[Event details](https://example.org/details)';
    expect(
      emailReviewValidationIssues({ items: [sourceBackedMarkdownLink] }, [linkThread]),
    ).toContain('item_0:draft_must_address_latest_request');
    const formatted = formatEmailReviewAnswer(
      result.answer?.items ?? [],
      emailReviewCoverage(
        ['volunteer-request', 'pta-rsvp'],
        result.answer?.items.map((item) => item.thread) ?? [],
        [search('volunteer-request'), search('pta-rsvp')],
      ),
    );
    expect(
      formatted.match(/Draft alternatives — choose one and remove the other before sending:/g),
    ).toHaveLength(2);
    expect(formatted).toContain('Response route: Follow the RSVP instructions');
    const parsedPrompt = JSON.parse(required(calls[0], 'first model call').prompt) as {
      threads: Array<{
        messages: Array<{ messageId: string; promptRole: string; text: string }>;
      }>;
      instruction: string;
    };
    expect(parsedPrompt.instruction).toContain(
      'return deadline: null if none is explicitly stated',
    );
    expect(parsedPrompt.instruction).toContain(
      'Keep relative wording such as "tomorrow" exactly as written',
    );
    expect(parsedPrompt.instruction).toContain(
      'Use no_reply only when the complete thread shows no unanswered direct request',
    );
    expect(parsedPrompt.instruction).toContain('do not invent the owner’s answer');
    expect(parsedPrompt.instruction).toContain(
      'generic thank-you or acknowledgement alone does not answer',
    );
    expect(parsedPrompt.instruction).toContain(
      'one concise sentence explaining what response is needed',
    );
    expect(parsedPrompt.instruction).not.toContain('[Choose one: available / unavailable]');
    expect(parsedPrompt.threads[0]?.messages).toHaveLength(2);
    expect(parsedPrompt.threads[0]?.messages[0]?.promptRole).toBe('thread_context');
    expect(parsedPrompt.threads[0]?.messages[1]?.promptRole).toBe('latest_inbound');
    expect(parsedPrompt.threads[0]?.messages[1]?.text).toContain('Are you able to?');
    expect(calls).toHaveLength(1);
  });

  it('rejects no_reply only for a clear unquoted direct ask, not a quoted or incidental RSVP mention', () => {
    const makeThread = (threadId: string, text: string, subject?: string) => {
      const sourceMessages = messages(threadId);
      const latest = required(sourceMessages.at(-1), 'latest source message');
      latest.text = text;
      if (subject) latest.subject = subject;
      latest.sourceLength = text.length;
      return required(
        emailReviewCompleteThread(threadId, 'owner@example.com', [
          search(threadId),
          read(threadId, sourceMessages),
        ]),
        'complete thread',
      );
    };
    const directRequest = makeThread(
      'direct-rsvp',
      "If you have not yet RSVP'd, please click the link below to RSVP.",
    );
    const incidentalMention = makeThread(
      'newsletter-mention',
      'The newsletter includes an RSVP link for families who are interested.',
    );
    const quotedOldAsk = makeThread(
      'quoted-old-ask',
      'Thanks for the update.\n> Are you able to help tomorrow?',
    );
    const availabilityAsk = makeThread(
      'availability-ask',
      'Could you send your availability for next week?',
    );
    const attendanceAsk = makeThread(
      'attendance-ask',
      'Please let me know whether you can attend.',
    );
    const imperativeAvailabilityAsks = [
      'Please send me your availability for next week.',
      'Please share your schedule for next week.',
      'Please provide your availability.',
      'Please reply with your preferred option.',
      'Please confirm which time works for you.',
    ].map((text, index) => makeThread(`imperative-ask-${index}`, text));
    const quotedImperativeAsk = makeThread(
      'quoted-imperative-ask',
      'Thanks for the note.\n> Please send me your availability for next week.',
    );
    const marketingNewsletter = makeThread(
      'marketing-newsletter',
      'Please share our weekly schedule-planning guide with your coworkers; it includes availability tips.',
      'Weekly newsletter: schedule-planning tips',
    );
    const noReplyFor = (thread: typeof directRequest) => ({
      items: [
        {
          ...required(validAnswer(thread.threadId).items[0], 'no-reply base'),
          disposition: 'no_reply' as const,
          recipient: null,
          deadline: null,
          draftBody: null,
          draftSourceMessageIds: [],
          whyMessageId: thread.latestMessageId,
          whyQuote: required(thread.messages.at(-1), 'latest').text,
        },
      ],
    });

    expect(validateEmailReviewAnswer(noReplyFor(directRequest), [directRequest])).toBeUndefined();
    expect(
      validateEmailReviewAnswer(noReplyFor(availabilityAsk), [availabilityAsk]),
    ).toBeUndefined();
    expect(validateEmailReviewAnswer(noReplyFor(attendanceAsk), [attendanceAsk])).toBeUndefined();
    for (const thread of imperativeAvailabilityAsks)
      expect(validateEmailReviewAnswer(noReplyFor(thread), [thread])).toBeUndefined();
    expect(
      validateEmailReviewAnswer(noReplyFor(quotedImperativeAsk), [quotedImperativeAsk]),
    ).toBeDefined();
    expect(
      validateEmailReviewAnswer(noReplyFor(marketingNewsletter), [marketingNewsletter]),
    ).toBeDefined();
    expect(emailReviewValidationIssues(noReplyFor(directRequest), [directRequest])).toContain(
      'item_0:direct_latest_request_requires_review_draft',
    );
    expect(
      validateEmailReviewAnswer(noReplyFor(incidentalMention), [incidentalMention]),
    ).toBeDefined();
    expect(validateEmailReviewAnswer(noReplyFor(quotedOldAsk), [quotedOldAsk])).toBeDefined();
    const proposedDraftForQuotedAsk = {
      ...required(validAnswer(quotedOldAsk.threadId).items[0], 'quoted-ask draft'),
      whyQuote: 'Are you able to help tomorrow?',
      deadline: null,
      draftBody: 'Thanks for checking.',
    };
    expect(
      emailReviewValidationIssues({ items: [proposedDraftForQuotedAsk] }, [quotedOldAsk]),
    ).toContain('item_0:why_quote_must_be_from_unquoted_latest_body');
    expect(
      validateEmailReviewAnswer({ items: [proposedDraftForQuotedAsk] }, [quotedOldAsk]),
    ).toBeUndefined();
  });

  it('reviews a linked earlier response deadline but ignores an unrelated older date', () => {
    const makeThread = (
      threadId: string,
      latestSubject: string,
      latestText: string,
      earlierSubject: string,
      earlierText: string,
    ) => {
      const sourceMessages = messages(threadId, 'pta@example.org');
      const earlier = required(sourceMessages[0], 'earlier message');
      const latest = required(sourceMessages[1], 'latest message');
      earlier.from = 'pta@example.org';
      earlier.to = 'owner@example.com';
      earlier.subject = earlierSubject;
      earlier.text = earlierText;
      earlier.sourceLength = earlierText.length;
      latest.subject = latestSubject;
      latest.text = latestText;
      latest.sourceLength = latestText.length;
      return required(
        emailReviewCompleteThread(threadId, 'owner@example.com', [
          search(threadId),
          read(threadId, sourceMessages),
        ]),
        'complete thread',
      );
    };
    const linked = makeThread(
      'linked-prior-deadline',
      'Re: PTA meeting RSVP',
      'Following up on the PTA meeting RSVP. Could you let me know whether you plan to attend?',
      'PTA meeting RSVP',
      'Please RSVP by October 18 for the PTA meeting.',
    );
    const linkedAssessment = {
      ...required(validAnswer(linked.threadId).items[0], 'linked assessment'),
      deadline: null as { messageId: string; quote: string } | null,
    };
    linkedAssessment.draftBody = 'Could you clarify whether the RSVP is per person?';
    linkedAssessment.whyQuote = required(linked.messages.at(-1), 'latest').text;
    linkedAssessment.recipient = 'pta@example.org';
    expect(
      validateEmailReviewAnswer({ items: [linkedAssessment] }, [linked])?.items[0]
        ?.deadlineNeedsReview,
    ).toBe(true);
    expect(emailReviewValidationIssues({ items: [linkedAssessment] }, [linked])).toContain(
      'item_0:possible_relevant_deadline_in_thread',
    );
    linkedAssessment.deadline = {
      messageId: required(linked.messages[0], 'prior deadline message').messageId,
      quote: 'RSVP by October 18',
    };
    linkedAssessment.draftBody = 'Is October 18 the response deadline for each person?';
    expect(
      validateEmailReviewAnswer({ items: [linkedAssessment] }, [linked])?.items[0]?.deadlineQuote,
    ).toBe('RSVP by October 18');
    expect(validateEmailReviewAnswer({ items: [linkedAssessment] }, [linked])).toBeDefined();
    const missingNamedDeadlineSource = {
      ...linkedAssessment,
      draftSourceMessageIds: [linked.latestMessageId],
    };
    expect(
      emailReviewValidationIssues({ items: [missingNamedDeadlineSource] }, [linked]),
    ).toContain('item_0:no_unsupplied_facts_or_owner_commitments');
    expect(
      validateEmailReviewAnswer({ items: [missingNamedDeadlineSource] }, [linked]),
    ).toBeUndefined();

    const unrelated = makeThread(
      'unrelated-prior-date',
      'Next week availability',
      'Could you send your availability for next week?',
      'PTA meeting RSVP',
      'Please RSVP by October 18 for the PTA meeting.',
    );
    const unrelatedAssessment = {
      ...required(validAnswer(unrelated.threadId).items[0], 'unrelated assessment'),
      deadline: null as { messageId: string; quote: string } | null,
    };
    unrelatedAssessment.whyQuote = required(unrelated.messages.at(-1), 'latest').text;
    unrelatedAssessment.recipient = 'pta@example.org';
    expect(
      validateEmailReviewAnswer({ items: [unrelatedAssessment] }, [unrelated])?.items[0]
        ?.deadlineNeedsReview,
    ).toBeUndefined();
  });

  it('bounds repeated invalid assessments and does not weaken exact source validation', async () => {
    const thread = required(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        search('thread-a'),
        read('thread-a', messages('thread-a')),
      ]),
      'complete thread',
    );
    const invalid = validAnswer('thread-a');
    required(invalid.items[0], 'assessment item').whyQuote = 'Invented source sentence';
    let calls = 0;
    const result = await generateValidatedEmailReview([thread], async () => {
      calls += 1;
      return { ok: true, value: invalid };
    });
    expect(calls).toBe(2);
    expect(result.answer).toBeUndefined();
    expect(result.issues).toContain('item_0:literal_why_quote_from_named_message');
  });

  it('does not repeat a valid assessment and survives a failed first generation', async () => {
    const thread = required(
      emailReviewCompleteThread('thread-a', 'owner@example.com', [
        search('thread-a'),
        read('thread-a', messages('thread-a')),
      ]),
      'complete thread',
    );
    let calls = 0;
    const success = await generateValidatedEmailReview([thread], async () => {
      calls += 1;
      return { ok: true, value: validAnswer('thread-a') };
    });
    expect(calls).toBe(1);
    expect(success.attempts).toBe(1);
    const recovered = await generateValidatedEmailReview([thread], async (input) => {
      if (!input.repair) throw new Error('provider unavailable');
      return { ok: true, value: validAnswer('thread-a') };
    });
    expect(recovered.answer).toBeDefined();
    expect(recovered.attempts).toBe(2);
  });
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

  it('filters local-calendar review metadata to the exact interval before ranking', () => {
    const query = 'after:2026/09/30 before:2026/10/18 -from:me';
    const scope = {
      query,
      requestedCount: 2,
      startAt: '2026-10-02T07:00:00.000Z',
      endAt: '2026-10-16T07:00:00.000Z',
    };
    const rowFor = (threadId: string, date: string): EmailReviewEvidenceRow => ({
      ...search(threadId),
      args: { query, maxResults: 100 },
      result: {
        ...((search(threadId).result as Record<string, unknown>) ?? {}),
        results: [
          {
            threadId,
            date,
            from: 'sender@example.net',
            subject: 'Could you confirm this?',
            snippet: 'Please reply by Friday.',
          },
        ],
      },
    });
    const evidence = [
      rowFor('inside-start', '2026-10-02T07:00:00.000Z'),
      rowFor('inside-end', '2026-10-16T06:59:59.999Z'),
      rowFor('before-window', '2026-10-02T06:59:59.999Z'),
      rowFor('at-exclusive-end', '2026-10-16T07:00:00.000Z'),
      rowFor('unknown-date', 'not-a-date'),
    ];

    expect(emailReviewCandidateIds(evidence, scope)).toEqual(['inside-start', 'inside-end']);
    expect(validEmailReviewSelection(['before-window'], evidence, undefined, scope)).toBe(false);
    expect(emailReviewRankContext(evidence, scope).prompt).toContain(
      'first 2 are the initial review set',
    );
  });

  it('preserves latest-first ordering instead of importance ranking for reply lookup', () => {
    const query = 'in:inbox -from:me';
    const scope = { query, requestedCount: 1, latestUnanswered: true };
    const rowFor = (
      threadId: string,
      date: string,
      subject: string,
      snippet: string,
    ): EmailReviewEvidenceRow => ({
      ...search(threadId),
      args: { query, maxResults: 100 },
      result: {
        ...((search(threadId).result as Record<string, unknown>) ?? {}),
        results: [
          {
            threadId,
            date,
            from: 'sender@example.net',
            subject,
            snippet,
          },
        ],
      },
    });
    const evidence = [
      rowFor(
        'older-important',
        '2026-10-14T10:00:00Z',
        'Please approve the proposal by tomorrow',
        'This approval is important and needed today.',
      ),
      rowFor(
        'newest-message',
        '2026-10-15T10:00:00Z',
        'Quick question',
        'Could you let me know when you have a chance?',
      ),
    ];
    const context = emailReviewRankContext(evidence, scope);
    expect(context.candidateIds).toEqual(['newest-message', 'older-important']);
    expect(emailReviewRecentMetadataFallback(evidence, context.candidateIds, scope)).toEqual([
      'newest-message',
      'older-important',
    ]);
    expect(
      emailReviewSelectionWithinAuthorizedPool(
        ['newest-message'],
        context.candidateIds,
        [],
        ['newest-message'],
        1,
        true,
      ),
    ).toBe(true);
    expect(
      emailReviewSelectionWithinAuthorizedPool(
        ['newest-message', 'older-important'],
        context.candidateIds,
        [],
        ['newest-message'],
        1,
        true,
      ),
    ).toBe(false);
    const answer = formatEmailReviewAnswer(
      [],
      {
        searchPages: 1,
        uniqueThreads: 2,
        searchComplete: true,
        unavailableMetadata: 0,
        selectedThreads: 1,
        completeThreads: 0,
        contextLimitedThreads: 0,
        ownerOrChronologyExcluded: 1,
        alreadyAnsweredThreads: 0,
        notEligibleThreads: 0,
        obviousNewslettersExcluded: 0,
      },
      false,
      scope,
    );
    expect(answer).toContain('bounded newest-first inbox scan');
    expect(answer).not.toMatch(/\b7[- ]day\b|\bseven[- ]day\b/i);
    expect(answer).not.toContain('newest-first order');

    const boundedAnswer = formatEmailReviewAnswer(
      [],
      {
        searchPages: 1,
        uniqueThreads: 2,
        searchComplete: true,
        unavailableMetadata: 0,
        selectedThreads: 1,
        completeThreads: 0,
        contextLimitedThreads: 0,
        ownerOrChronologyExcluded: 1,
        alreadyAnsweredThreads: 0,
        notEligibleThreads: 0,
        obviousNewslettersExcluded: 0,
      },
      false,
      { ...scope, startAt: '2026-10-15T00:00:00Z', endAt: '2026-10-16T00:00:00Z' },
    );
    expect(boundedAnswer).toContain('newest-first inbox scan within the requested time window');
    expect(boundedAnswer).not.toMatch(/\b7[- ]day\b|\bseven[- ]day\b/i);
  });

  it('does not claim complete-thread verification in a bounded latest-mail summary', () => {
    const answer = formatEmailReviewAnswer(
      [],
      {
        searchPages: 1,
        uniqueThreads: 2,
        searchComplete: true,
        unavailableMetadata: 0,
        selectedThreads: 1,
        completeThreads: 0,
        contextLimitedThreads: 1,
        ownerOrChronologyExcluded: 0,
        alreadyAnsweredThreads: 0,
        notEligibleThreads: 0,
        obviousNewslettersExcluded: 0,
      },
      false,
      { query: 'in:inbox -from:me', requestedCount: 1, latestUnanswered: true },
    );

    expect(answer).toContain('Read 0 of 1 selected threads');
    expect(answer).toContain('bounded newest-first inbox scan');
    expect(answer).toContain('complete, eligible source reads: 0 of 1 selected threads');
    expect(answer).not.toContain('checked against its complete thread');
  });

  it('allows a bounded ten-ID reserve pool while keeping final answers capped at five', () => {
    const evidence = Array.from({ length: EMAIL_REVIEW_MAX_RANK_POOL }, (_, index) =>
      search(`request-${index}`),
    );
    const ids = Array.from(
      { length: EMAIL_REVIEW_MAX_RANK_POOL },
      (_, index) => `request-${index}`,
    );
    expect(validEmailReviewSelection(ids, evidence)).toBe(true);
    expect(validEmailReviewSelection([...ids, 'request-8'], evidence)).toBe(false);
    expect(JSON.parse(emailReviewRankContext(evidence).prompt)).toMatchObject({ limit: 10 });
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
    expect(
      emailReviewSelectionWithinAuthorizedPool(ranked.slice(0, 6), ranked, [], ['request-5']),
    ).toBe(true);
    expect(
      emailReviewSelectionWithinAuthorizedPool(ranked.slice(0, 6), ranked, [], ['foreign-failure']),
    ).toBe(false);
    expect(
      emailReviewSelectionWithinAuthorizedPool(ranked.slice(0, 6), ranked, [], ['request-6']),
    ).toBe(false);
    expect(
      emailReviewSelectionWithinAuthorizedPool(
        ranked.slice(0, 6),
        ranked,
        ['request-0'],
        ['request-5'],
      ),
    ).toBe(true);
    expect(
      emailReviewSelectionWithinAuthorizedPool(
        ranked.slice(0, 6),
        ranked,
        ['request-0'],
        ['request-0'],
      ),
    ).toBe(false);
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

  it('keeps a direct personal ask when promotional words appear in the same metadata', () => {
    const availability = search('availability-request');
    const result = availability.result.results as Array<Record<string, unknown>>;
    required(result[0], 'availability metadata').subject = 'Fall sale and volunteer availability';
    required(result[0], 'availability metadata').snippet =
      'We would love to get your updated availability so we can schedule the volunteer shifts.';
    const evidence: EmailReviewEvidenceRow[] = [availability];
    expect(emailReviewRankContext(evidence).candidateIds).toEqual(['availability-request']);
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

  it('keeps a normal 106-thread search inside the compact rank context', () => {
    const evidence = Array.from({ length: 106 }, (_, index) => {
      const row = search(`request-${String(index).padStart(3, '0')}`);
      const result = row.result.results as Array<Record<string, unknown>>;
      required(result[0], 'rank candidate').date =
        `2026-10-${String(13 - Math.floor(index / 24)).padStart(2, '0')}T12:00:00Z`;
      return row;
    });
    const context = emailReviewRankContext(evidence);
    expect(context.prompt.length).toBeLessThanOrEqual(40_000);
    expect(context.candidateIds).toHaveLength(106);
    expect(JSON.parse(context.prompt).additionalMetadataCandidates).toBe(0);
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

  it('prioritizes explicit request cues before newer informational metadata in fallback', () => {
    const request = search('direct-request');
    const requestResult = request.result.results as Array<Record<string, unknown>>;
    required(requestResult[0], 'request metadata').date = '2026-10-08T08:00:00Z';
    required(requestResult[0], 'request metadata').snippet =
      'Nobody has signed up. Are you able to?';
    const informational = search('newer-information');
    const informationalResult = informational.result.results as Array<Record<string, unknown>>;
    required(informationalResult[0], 'informational metadata').date = '2026-10-12T08:00:00Z';
    required(informationalResult[0], 'informational metadata').subject = 'Maintenance alert';
    required(informationalResult[0], 'informational metadata').snippet =
      'Your current mileage indicates maintenance is due.';

    expect(
      emailReviewRecentMetadataFallback(
        [informational, request],
        ['newer-information', 'direct-request'],
      ),
    ).toEqual(['direct-request', 'newer-information']);
  });

  it('ranks genuine requests before security, purchase, news, and well-wishing metadata', () => {
    const rows = [
      ['otp-notice', 'Please confirm your email', 'Use your verification code to sign in'],
      ['purchase-notice', 'Order confirmation', 'Thank you for your purchase'],
      ['news-notice', 'Breaking news update', 'Read today’s news'],
      ['wellwish', 'Happy birthday', 'Have a wonderful day'],
      ['approval-request', 'Contract review', 'Please review the attached proposal and approve it'],
      ['rsvp-request', 'Community dinner', 'Please RSVP so we can get a food headcount'],
      ['availability-request', 'Schedule next week', 'Could you send your availability?'],
    ].map(([threadId, subject, snippet], index) =>
      search(threadId ?? '', {
        results: [
          {
            threadId,
            subject,
            snippet,
            date: `2026-10-${index < 4 ? '12' : '08'}T08:00:00Z`,
            from: 'sender@example.net',
          },
        ],
      }),
    );
    const ids = emailReviewCandidateIds(rows);
    expect(emailReviewRecentMetadataFallback(rows, ids).slice(0, 3)).toEqual([
      'approval-request',
      'availability-request',
      'rsvp-request',
    ]);
    const noise = Array.from({ length: EMAIL_REVIEW_MAX_RANK_CANDIDATES }, (_, index) =>
      search(`noise-${index}`, {
        results: [
          {
            threadId: `noise-${index}`,
            subject: 'Order confirmation',
            snippet: 'Thank you for your purchase',
            date: '2026-10-12T08:00:00Z',
          },
        ],
      }),
    );
    expect(emailReviewRankContext([...noise, ...rows]).candidateIds.slice(0, 3)).toEqual([
      'approval-request',
      'availability-request',
      'rsvp-request',
    ]);
  });

  it('ranks personal availability and volunteer requests above generic action notices and promotions', () => {
    const rowFor = (threadId: string, subject: string, snippet: string, day: string) =>
      search(threadId, {
        results: [
          {
            threadId,
            subject,
            snippet,
            date: `2026-10-${day}T12:00:00Z`,
            from: 'sender@example.net',
          },
        ],
      });
    const rows = [
      rowFor(
        'personal-availability',
        'Interview confirmation',
        'We would love to get your updated availability here so we can set up these interviews.',
        '15',
      ),
      rowFor(
        'volunteer-request',
        'Help needed for Saturday',
        'The club needs parents to help. Could you volunteer for a shift?',
        '15',
      ),
      rowFor(
        'rsvp-reminder',
        'Reminder to RSVP for October PTA Meeting - 10/21',
        'Please RSVP so we can get a food headcount.',
        '15',
      ),
      rowFor(
        'admin-notice',
        '[Action Required] Update workspace OAuth settings',
        'Mark the OAuth clients as agentic before the policy date.',
        '15',
      ),
      rowFor(
        'product-promotion',
        'The truffle burger has returned',
        'Our new seasonal burger is back in stock.',
        '15',
      ),
    ];
    const ids = emailReviewCandidateIds(rows);
    expect(emailReviewRecentMetadataFallback(rows, ids).slice(0, 3)).toEqual([
      'personal-availability',
      'volunteer-request',
      'rsvp-reminder',
    ]);
  });

  it('uses source-established conditional alternatives to fill an omitted direct yes/no assessment only on repair', async () => {
    const sourceMessages = messages('omitted-availability-request');
    const latest = required(sourceMessages.at(-1), 'latest message');
    latest.text = 'Nobody has signed up for tomorrow. Are you able to? Thanks!';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('omitted-availability-request', 'owner@example.com', [
        search('omitted-availability-request'),
        read('omitted-availability-request', sourceMessages),
      ]),
      'complete direct yes/no request',
    );
    let calls = 0;
    const repaired = await generateValidatedEmailReview([thread], async (input) => {
      calls += 1;
      if (!input.repair) return { ok: true, value: { items: [] } };
      return { ok: true, value: { items: [] } };
    });
    expect(calls).toBe(2);
    expect(repaired.attempts).toBe(2);
    expect(repaired.answer?.items[0]).toMatchObject({
      disposition: 'draft',
      whyQuote: 'Are you able to?',
    });
    expect(repaired.sourceItems?.[0]?.whyMessageId).toBe(thread.latestMessageId);
    expect(repaired.answer?.items[0]?.draftBody).toContain('If you can help:');
    expect(repaired.answer?.items[0]?.draftBody).toContain('If you cannot:');
    expect(repaired.ownerDecisionThreadIds).toEqual([]);
    expect(repaired.issues).toEqual([]);
  });

  it('replaces a rejected owner-choice draft only with the exact source-derived alternatives', async () => {
    const sourceMessages = messages('rejected-owner-choice-draft');
    const latest = required(sourceMessages.at(-1), 'latest message');
    latest.text = 'Nobody has signed up for tomorrow. Are you able to? Thanks!';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('rejected-owner-choice-draft', 'owner@example.com', [
        search('rejected-owner-choice-draft'),
        read('rejected-owner-choice-draft', sourceMessages),
      ]),
      'complete direct yes/no request',
    );
    const rejected = required(validAnswer(thread.threadId).items[0], 'assessment item');
    rejected.whyQuote = 'A paraphrase instead of the exact request';
    rejected.draftBody = 'I can help tomorrow [insert shift time].';

    const result = await generateValidatedEmailReview([thread], async () => ({
      ok: true,
      value: { items: [rejected] },
    }));

    expect(result.attempts).toBe(1);
    expect(result.answer?.items[0]).toMatchObject({
      disposition: 'draft',
      whyQuote: 'Are you able to?',
      draftBody: expect.stringContaining('If you can help:'),
    });
    expect(result.answer?.items[0]?.draftBody).toContain('If you cannot:');
    expect(result.answer?.items[0]?.draftBody).not.toContain('insert shift time');
    expect(result.issues).toEqual([]);
  });

  it('supplies only the exact accepted conditional draft and round-trips it through validation and rendering', () => {
    const source = messages('prompt-accepted-alternatives');
    const latest = required(source.at(-1), 'latest');
    latest.text = 'Nobody has signed up for tomorrow. Are you able to help? Thanks!';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('prompt-accepted-alternatives', 'owner@example.com', [
        search('prompt-accepted-alternatives'),
        read('prompt-accepted-alternatives', source),
      ]),
      'complete direct request',
    );
    const prompt = JSON.parse(emailReviewPrompt([thread])) as {
      threads: Array<{ acceptedConditionalDraft: string | null }>;
    };
    const acceptedConditionalDraft = prompt.threads[0]?.acceptedConditionalDraft;
    expect(acceptedConditionalDraft).toBeTruthy();

    const item = {
      ...required(validAnswer(thread.threadId).items[0], 'assessment item'),
      whyQuote: 'Are you able to help?',
      deadline: null,
      draftBody: acceptedConditionalDraft,
      draftSourceMessageIds: [thread.latestMessageId],
    };
    const checked = validateEmailReviewAnswer({ items: [item] }, [thread]);
    expect(checked?.items[0]?.draftBody).toBe(acceptedConditionalDraft);
    const rendered = formatEmailReviewAnswer(
      checked?.items ?? [],
      emailReviewCoverage([thread.threadId], [thread], [search(thread.threadId)]),
    );
    expect(rendered).toContain(
      '**Draft alternatives — choose one and remove the other before sending:**',
    );
    expect(rendered).toContain(acceptedConditionalDraft);
  });

  it('does not supply conditional text for unsupported choices, alternate routes, or non-requests', () => {
    const makeThread = (threadId: string, latestText: string) => {
      const source = messages(threadId);
      const latest = required(source.at(-1), 'latest');
      latest.text = latestText;
      latest.sourceLength = latest.text.length;
      return required(
        emailReviewCompleteThread(threadId, 'owner@example.com', [
          search(threadId),
          read(threadId, source),
        ]),
        'complete thread',
      );
    };
    const threads = [
      makeThread(
        'prompt-unsupported-choice',
        'Could you send me the revised document when you have a chance?',
      ),
      makeThread(
        'prompt-alternate-route',
        'Please RSVP using the ParentSquare button for the event.',
      ),
      makeThread('prompt-no-reply', 'For your records, the office will be closed Monday.'),
    ];
    const prompt = JSON.parse(emailReviewPrompt(threads)) as {
      threads: Array<{ threadId: string; acceptedConditionalDraft: string | null }>;
    };
    expect(prompt.threads.map((thread) => thread.acceptedConditionalDraft)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('counts the supplied conditional draft toward the existing prompt context limit', () => {
    const source = messages('bounded-conditional-template');
    const latest = required(source.at(-1), 'latest');
    latest.text = `${'x'.repeat(49_800)}\nAre you able to help?`;
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('bounded-conditional-template', 'owner@example.com', [
        search('bounded-conditional-template'),
        read('bounded-conditional-template', source),
      ]),
      'complete direct request',
    );

    const bounded = boundEmailReviewThreads([thread]);
    const prompt = JSON.parse(emailReviewPrompt([thread])) as {
      threads: Array<{ acceptedConditionalDraft: string | null }>;
    };

    expect(bounded.omittedThreadIds).toContain(thread.threadId);
    expect(prompt.threads).toEqual([]);
  });

  it('preserves a valid specific owner reply and its older source-backed deadline', async () => {
    const threadId = 'specific-owner-choice';
    const sourceMessages = messages(threadId);
    const deadlineMessage = required(sourceMessages[0], 'prior deadline message');
    deadlineMessage.from = 'vendor@example.net';
    deadlineMessage.text = 'Please confirm your attendance by October 18.';
    deadlineMessage.sourceLength = deadlineMessage.text.length;
    const ownerMessage = {
      messageId: 'owner-choice-specific',
      from: 'owner@example.com',
      to: 'vendor@example.net',
      date: '2026-10-10T12:00:00Z',
      subject: 'Re: Event attendance',
      text: 'I can attend the Saturday event.',
      sourceLength: 'I can attend the Saturday event.'.length,
      truncated: false,
    };
    sourceMessages.splice(1, 0, ownerMessage);
    const latest = required(sourceMessages.at(-1), 'latest message');
    latest.text =
      'Please reply by October 18 to confirm whether you can attend the Saturday event.';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread(threadId, 'owner@example.com', [
        search(threadId),
        read(threadId, sourceMessages),
      ]),
      'complete attendance thread',
    );
    const specific = {
      threadId,
      latestMessageId: thread.latestMessageId,
      disposition: 'draft' as const,
      recipient: thread.recipient,
      why: 'The sender asks you to confirm attendance.',
      whyMessageId: thread.latestMessageId,
      whyQuote: latest.text,
      deadline: { messageId: deadlineMessage.messageId, quote: 'by October 18' },
      draftBody: 'I can attend the Saturday event.',
      draftSourceMessageIds: [ownerMessage.messageId, thread.latestMessageId],
    };

    expect(validateEmailReviewAnswer({ items: [specific] }, [thread])).toBeDefined();
    const result = await generateValidatedEmailReview([thread], async () => ({
      ok: true,
      value: { items: [specific] },
    }));

    expect(result.sourceItems?.[0]).toEqual(specific);
    expect(result.answer?.items[0]?.draftBody).toBe(specific.draftBody);
    expect(result.answer?.items[0]?.deadlineQuote).toBe('by October 18');
    expect(result.answer?.items[0]?.deadlineSourceDate).toBe(deadlineMessage.date);
    expect(result.attempts).toBe(1);

    const missingDeadline = { ...specific, deadline: null };
    const repaired = await generateValidatedEmailReview([thread], async () => ({
      ok: true,
      value: { items: [missingDeadline] },
    }));
    expect(repaired.answer?.items[0]?.draftBody).toBe(specific.draftBody);
    expect(repaired.answer?.items[0]?.whyQuote).toBe(specific.whyQuote);
    expect(repaired.answer?.items[0]?.deadlineQuote).toBe('by October 18');
    expect(repaired.answer?.items[0]?.deadlineSourceDate).toBe(latest.date);
    expect(repaired.attempts).toBe(1);
  });

  it('keeps an older grounded deadline when an unsafe owner-choice draft needs fallback', async () => {
    const threadId = 'fallback-with-prior-deadline';
    const sourceMessages = messages(threadId);
    const deadlineMessage = required(sourceMessages[0], 'prior deadline message');
    deadlineMessage.from = 'vendor@example.net';
    deadlineMessage.subject = 'Volunteer request';
    deadlineMessage.text = 'Please reply by October 18 to let me know whether you can help.';
    deadlineMessage.sourceLength = deadlineMessage.text.length;
    const latest = required(sourceMessages.at(-1), 'latest message');
    latest.subject = 'Re: Volunteer request';
    latest.text = 'Could you help tomorrow? Please reply with your answer.';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread(threadId, 'owner@example.com', [
        search(threadId),
        read(threadId, sourceMessages),
      ]),
      'complete request with older deadline',
    );
    const rejected = {
      ...required(validAnswer(threadId).items[0], 'assessment item'),
      whyQuote: 'A paraphrase instead of the exact request',
      deadline: { messageId: deadlineMessage.messageId, quote: 'by October 18' },
      draftBody: 'I can help tomorrow [insert details].',
    };

    const result = await generateValidatedEmailReview([thread], async () => ({
      ok: true,
      value: { items: [rejected] },
    }));

    expect(result.answer?.items[0]?.deadlineQuote).toBe('by October 18');
    expect(result.answer?.items[0]?.deadlineSourceDate).toBe(deadlineMessage.date);
    expect(result.answer?.items[0]?.draftBody).toContain('If you can help:');
    expect(result.answer?.items[0]?.draftBody).toContain('If you cannot:');
    expect(result.issues).toEqual([]);
  });

  it('does not fabricate alternatives for a direct request without a bounded fallback', async () => {
    const sourceMessages = messages('generic-answer-request');
    const latest = required(sourceMessages.at(-1), 'latest message');
    latest.text = 'Could you send me the revised document when you have a chance?';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('generic-answer-request', 'owner@example.com', [
        search('generic-answer-request'),
        read('generic-answer-request', sourceMessages),
      ]),
      'complete document request',
    );
    const rejected = required(validAnswer(thread.threadId).items[0], 'assessment item');
    rejected.whyQuote = 'A paraphrase instead of the exact request';

    const result = await generateValidatedEmailReview([thread], async ({ repair }) => ({
      ok: true,
      value: repair ? { items: [] } : { items: [rejected] },
    }));

    expect(result.attempts).toBe(2);
    expect(result.answer).toBeUndefined();
    expect(result.issues).toContain('one_item_per_input_thread');
  });

  it('replaces a valid-shape generic RSVP acknowledgement with owner alternatives and source routing', async () => {
    const source = messages('food-rsvp');
    const latest = required(source.at(-1), 'latest');
    latest.text =
      'Please RSVP for our October 21 dinner so we can get a food headcount. Use the RSVP button in ParentSquare.';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('food-rsvp', 'owner@example.com', [
        search('food-rsvp'),
        read('food-rsvp', source),
      ]),
      'complete RSVP thread',
    );
    const item = {
      ...required(validAnswer('food-rsvp').items[0], 'item'),
      whyQuote: 'Please RSVP for our October 21 dinner so we can get a food headcount.',
      deadline: null,
      draftBody: 'Thank you for the invitation. I acknowledge the RSVP request.',
    };
    expect(emailReviewValidationIssues({ items: [item] }, [thread])).toContain(
      'item_0:draft_must_address_latest_request',
    );
    expect(validateEmailReviewAnswer({ items: [item] }, [thread])).toBeUndefined();
    const review = await generateValidatedEmailReview([thread], async () => ({
      ok: true,
      value: { items: [item] },
    }));
    expect(review.attempts).toBe(1);
    expect(review.answer?.items[0]?.draftBody).toContain('If you plan to attend:');
    expect(review.answer?.items[0]?.draftBody).toContain('Owner decision required:');
    expect(review.answer?.items[0]?.deadlineQuote).toBeUndefined();
    const rendered = formatEmailReviewAnswer(
      review.answer?.items ?? [],
      emailReviewCoverage([thread.threadId], [thread], [search(thread.threadId)]),
    );
    expect(rendered).toContain('food or attendance count');
    expect(rendered).toContain('These unsent draft alternatives have not registered attendance.');
    expect(rendered).not.toContain('stated deadline');
    expect(rendered).not.toContain('prepared 5 reply');
  });

  it('preserves a source-authorized email RSVP alternative alongside the platform route', () => {
    const source = messages('email-or-link-rsvp');
    const earlier = required(source[0], 'owner source');
    earlier.text = 'I can attend.';
    earlier.sourceLength = earlier.text.length;
    const latest = required(source.at(-1), 'latest');
    latest.text =
      'Please RSVP using the link or reply to this email to register attendance. RSVP form: https://example.org/rsvp';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('email-or-link-rsvp', 'owner@example.com', [
        search('email-or-link-rsvp'),
        read('email-or-link-rsvp', source),
      ]),
      'complete thread',
    );
    const item = {
      ...required(validAnswer(thread.threadId).items[0], 'item'),
      whyQuote: latest.text,
      deadline: null,
      draftBody: 'I can attend.',
    };
    const checked = validateEmailReviewAnswer({ items: [item] }, [thread]);
    expect(emailReviewValidationIssues({ items: [item] }, [thread])).toEqual([]);
    expect(checked?.items[0]?.draftBody).toBe('I can attend.');
    const rendered = formatEmailReviewAnswer(
      checked?.items ?? [],
      emailReviewCoverage([thread.threadId], [thread], [search(thread.threadId)]),
    );
    expect(rendered).toContain('Follow the RSVP instructions in the source.');
    expect(rendered).toContain('These unsent draft alternatives have not registered attendance.');
    expect(rendered).not.toContain('An email reply does not register');
  });

  it('rejects unsupported positive and negative owner attendance decisions', () => {
    const source = messages('attendance-choice');
    const latest = required(source.at(-1), 'latest');
    latest.text = 'Could you attend the meeting?';
    latest.sourceLength = latest.text.length;
    const thread = required(
      emailReviewCompleteThread('attendance-choice', 'owner@example.com', [
        search('attendance-choice'),
        read('attendance-choice', source),
      ]),
      'thread',
    );
    for (const draftBody of [
      'I plan to attend.',
      'I cannot attend.',
      'I’m available.',
      "I can't attend.",
    ]) {
      const item = {
        ...required(validAnswer(thread.threadId).items[0], 'item'),
        whyQuote: latest.text,
        deadline: null,
        draftBody,
      };
      expect(emailReviewValidationIssues({ items: [item] }, [thread])).toContain(
        'item_0:no_unsupplied_facts_or_owner_commitments',
      );
      expect(validateEmailReviewAnswer({ items: [item] }, [thread])).toBeUndefined();
    }
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
    ).toEqual({ kind: 'not_eligible', threadId: 'thread-a' });
    expect(
      emailReviewVerifiedNotEligibleThreadIds(['thread-a'], 'owner@example.com', [
        search('thread-a'),
        read('thread-a', outboundWithoutMatchingInbound),
      ]),
    ).toEqual(['thread-a']);
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
    const validated = validateEmailReviewAnswer(validAnswer('thread-a'), [thread]);
    expect(validated?.items).toHaveLength(1);
    const formatted = formatEmailReviewAnswer(
      required(validated?.items, 'validated source-bound review'),
      emailReviewCoverage(['thread-a'], [thread], [search('thread-a')]),
    );
    expect(formatted).toContain('Source request: “Could you confirm by Friday?”');
    expect(formatted).toContain('Why it matters: A response is requested by the cited deadline.');
    expect(formatted).toContain('Deadline: “by Friday”');
    for (const unsupportedWhy of [
      'Your account will be closed tomorrow unless you pay.',
      'The sender asks for confirmation, so a delay will cancel your membership.',
    ]) {
      const assessmentWithUnsupportedWhy = {
        items: [
          {
            ...required(validAnswer('thread-a').items[0], 'source-bound assessment'),
            why: unsupportedWhy,
          },
        ],
      };
      const stillValidated = validateEmailReviewAnswer(assessmentWithUnsupportedWhy, [thread]);
      expect(stillValidated).toBeDefined();
      const safeFormatted = formatEmailReviewAnswer(
        required(stillValidated?.items, 'validated assessment with untrusted rationale'),
        emailReviewCoverage(['thread-a'], [thread], [search('thread-a')]),
      );
      expect(safeFormatted).not.toContain(unsupportedWhy);
      expect(safeFormatted).toContain(
        'Why it matters: A response is requested by the cited deadline.',
      );
    }
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

  it('collapses only exact repeated quoted history while keeping unique latest and deadline evidence', () => {
    const thread = required(
      emailReviewCompleteThread('thread-repeat-history', 'owner@example.com', [
        search('thread-repeat-history'),
        read('thread-repeat-history', messages('thread-repeat-history')),
      ]),
      'complete thread',
    );
    const [earlier, latest] = thread.messages;
    if (!earlier || !latest) throw new Error('expected two source messages');
    const repeated = 'The committee vote closes on October 19 at midnight.';
    const uniqueQuoted = 'The application deadline remains November 12.';
    earlier.text = `${repeated}\nEarlier source context is retained here.`;
    latest.text = `Please share your view on the motion.\n${repeated}\n\nOn the earlier message wrote:\n> ${repeated}\n> ${uniqueQuoted}\n`;
    const prompt = emailReviewPrompt([thread]);
    const projected = JSON.parse(prompt) as {
      threads: Array<{ messages: Array<{ messageId: string; text: string }> }>;
    };
    const promptText = projected.threads[0]?.messages.map((message) => message.text).join('\n');

    expect(
      promptText?.match(/The committee vote closes on October 19 at midnight\./g),
    ).toHaveLength(2);
    expect(promptText).toContain('Please share your view on the motion.');
    expect(promptText).toContain(uniqueQuoted);
    expect(projected.threads[0]?.messages.map((message) => message.messageId)).toEqual(
      thread.messages.map((message) => message.messageId),
    );
    expect(thread.messages.at(-1)?.text).toContain(repeated);
  });

  it('retains quoted lines with different case or significant inner spacing', () => {
    const thread = required(
      emailReviewCompleteThread('thread-distinct-quote', 'owner@example.com', [
        search('thread-distinct-quote'),
        read('thread-distinct-quote', messages('thread-distinct-quote')),
      ]),
      'complete thread',
    );
    const [earlier, latest] = thread.messages;
    if (!earlier || !latest) throw new Error('expected two source messages');
    earlier.text =
      'Use the case-sensitive identifier ApprovalCaseA.\nReference spacing remains part  one.';
    latest.text =
      'Please confirm the identifiers.\nOn the earlier message wrote:\n> Use the case-sensitive identifier approvalcasea.\n> Reference spacing remains part one.\n> Use the case-sensitive identifier ApprovalCaseA.';
    const projected = JSON.parse(emailReviewPrompt([thread])) as {
      threads: Array<{ messages: Array<{ text: string }> }>;
    };
    const latestText = projected.threads[0]?.messages.at(-1)?.text;
    expect(latestText).toContain('> Use the case-sensitive identifier approvalcasea.');
    expect(latestText).toContain('> Reference spacing remains part one.');
    expect(latestText).not.toContain('> Use the case-sensitive identifier ApprovalCaseA.');
    expect(latest.text).toContain('> Use the case-sensitive identifier ApprovalCaseA.');
  });

  it('fits multiple large threads when excess context is exact quoted repetition without truncating source threads', () => {
    const repeatedLines = Array.from(
      { length: 300 },
      (_, index) =>
        `Proposal detail ${String(index).padStart(3, '0')} remains under review before the committee closes its vote.`,
    );
    const makeThread = (threadId: string) => {
      const thread = required(
        emailReviewCompleteThread(threadId, 'owner@example.com', [
          search(threadId),
          read(threadId, messages(threadId)),
        ]),
        'complete thread',
      );
      const [earlier, latest] = thread.messages;
      if (!earlier || !latest) throw new Error('expected two source messages');
      earlier.text = repeatedLines.join('\n');
      latest.text = `Please send your recommendation.\n\nOn the earlier message wrote:\n${repeatedLines.map((line) => `> ${line}`).join('\n')}`;
      return thread;
    };
    const threads = [makeThread('large-thread-a'), makeThread('large-thread-b')];
    const before = threads.map((thread) => thread.messages.at(-1)?.text);

    const bounded = boundEmailReviewThreads(threads);

    expect(bounded.threads).toHaveLength(2);
    expect(bounded.omittedThreadIds).toEqual([]);
    expect(bounded.threads.map((thread) => thread.messages.at(-1)?.text)).toEqual(before);
    const prompt = JSON.parse(emailReviewPrompt(bounded.threads)) as {
      threads: Array<{ messages: Array<{ text: string }> }>;
    };
    expect(prompt.threads).toHaveLength(2);
    expect(prompt.threads[0]?.messages.at(-1)?.text).not.toContain('> Proposal detail 000');
    expect(prompt.threads[0]?.messages.at(-1)?.text).toContain('Please send your recommendation.');
  });

  it('authorizes reserve reads only for freshly verified complete exclusions', () => {
    const ranked = ['request-a', 'request-b', 'request-c', 'request-d', 'request-e', 'reserve-f'];
    expect(emailReviewSelectionWithinAuthorizedPool(ranked.slice(0, 5), ranked, [])).toBe(true);
    expect(emailReviewSelectionWithinAuthorizedPool(ranked, ranked, [])).toBe(false);
    expect(emailReviewSelectionWithinAuthorizedPool(ranked, ranked, ['request-b'])).toBe(true);
    expect(
      emailReviewSelectionWithinAuthorizedPool(ranked, ranked, ['request-b', 'request-c']),
    ).toBe(true);
    expect(
      emailReviewSelectionWithinAuthorizedPool(
        ['request-a', 'request-b', 'request-c', 'request-d', 'request-e', 'reserve-f'],
        ranked,
        [],
      ),
    ).toBe(false);
    expect(
      emailReviewSelectionWithinAuthorizedPool(
        [...ranked, 'reserve-g', 'reserve-h', 'reserve-i'],
        [...ranked, 'reserve-g', 'reserve-h', 'reserve-i'],
        ['request-a', 'request-b', 'request-c'],
      ),
    ).toBe(false);

    const completeNotEligible = [
      search('not-eligible'),
      read('not-eligible', [
        {
          messageId: 'owner-message',
          from: 'owner@example.com',
          to: 'other@example.net',
          date: '2026-10-11T16:00:00Z',
          subject: 'Re: Request',
          text: 'Thanks.',
          sourceLength: 'Thanks.'.length,
          truncated: false,
        },
      ]),
    ];
    const failed = [search('failed'), { ...read('failed', messages('failed')), status: 'failed' }];
    const truncated = [
      search('truncated'),
      read('truncated', messages('truncated'), { complete: false }),
    ];
    const malformed = [
      search('malformed'),
      { ...read('malformed', messages('malformed')), result: { threadId: 'wrong-id' } },
    ];
    expect(
      emailReviewVerifiedNotEligibleThreadIds(
        ['not-eligible'],
        'owner@example.com',
        completeNotEligible,
      ),
    ).toEqual(['not-eligible']);
    for (const [threadId, evidence] of [
      ['failed', failed],
      ['truncated', truncated],
      ['malformed', malformed],
    ] as const) {
      expect(
        emailReviewVerifiedNotEligibleThreadIds([threadId], 'owner@example.com', evidence),
      ).toEqual([]);
    }
  });

  it('separates verified exclusions from incomplete reads and budget-omitted reserves', () => {
    const coverage = emailReviewCoverage(
      ['answered', 'not-eligible', 'unverified'],
      [],
      [],
      0,
      ['answered'],
      ['not-eligible'],
      'step_budget',
    );
    const text = formatEmailReviewAnswer([], coverage);
    expect(coverage).toMatchObject({
      alreadyAnsweredThreads: 1,
      notEligibleThreads: 1,
      ownerOrChronologyExcluded: 1,
      backfillShortfall: 'step_budget',
    });
    expect(text).toContain('reviewed but did not meet the reply-draft criteria');
    expect(text).toContain('lacked enough complete chronology or eligibility evidence to assess');
    expect(text).toContain('step limit prevented another replacement-thread read');
    expect(text).not.toContain('no more threads to replace');
  });
});

it('rejects a deadline-only draft for an availability request and retains the source form and owner decision', async () => {
  const id = 'availability-deadline-only';
  const source = messages(id);
  const body =
    'We would love to get your updated availability here: https://schedule.example.test/availability/abc so we can set up these interviews.';
  source[1] = {
    ...required(source[1], 'latest'),
    subject: 'Interview availability',
    text: body,
    sourceLength: body.length,
  };
  const thread = required(
    emailReviewCompleteThread(id, 'owner@example.com', [search(id), read(id, source)]),
    'thread',
  );
  const value = {
    items: [
      {
        ...required(validAnswer(id).items[0], 'answer'),
        whyQuote: 'We would love to get your updated availability here',
        deadline: null,
        draftBody:
          'Could you let me know if there is a preferred deadline for submitting my updated availability?',
      },
    ],
  };
  expect(validateEmailReviewAnswer(value, [thread])).toBeUndefined();
  const result = await generateValidatedEmailReview([thread], async () => ({ ok: true, value }));
  expect(result.answer?.items ?? []).toHaveLength(0);
  expect(result.ownerDecisionThreadIds).toContain(id);
  const summary = emailReviewOwnerDecisionSummary(thread);
  expect(summary.actionUrl).toBe('https://schedule.example.test/availability/abc');
  expect(summary.decisionPrompt).toContain('Which times and time zone');
});
