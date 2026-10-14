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
  emailReviewValidationIssues,
  emailReviewVerifiedNotEligibleThreadIds,
  formatEmailReviewAnswer,
  generateValidatedEmailReview,
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
  it('names ranking-context omissions within scanned metadata', () => {
    const coverage = emailReviewCoverage([], [], [search('thread-a'), search('thread-b')]);
    coverage.rankedMetadataThreads = 1;
    expect(formatEmailReviewAnswer([], coverage)).toContain(
      'included 1 of 2 scanned non-newsletter threads; the others were not ranked',
    );
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
    expect(formatted).toContain('unresolved possible deadline');
    expect(formatted).toContain('**Deadline needs review — Please confirm the renewal date**');
    expect(formatted).toContain(
      '[Open the source thread](https://mail.google.com/mail/u/0/#all/thread-a)',
    );
    expect(formatted).toContain('No reply draft was prepared for it');
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
    expect(result.answer?.items[0]?.draftBody).toBe('Thanks for your note.');
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
    expect(wrongCount.answer?.items.map((item) => item.thread.threadId)).toEqual(['thread-a']);
    expect(wrongCount.sourceItems?.map((item) => item.threadId)).toEqual(['thread-a']);
    expect(wrongCount.issues).toContain('one_item_per_input_thread');
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
    expect(completedPartial.answer?.items.map((item) => item.thread.threadId)).toEqual([
      'thread-a',
      'thread-b',
    ]);
    const wrongIdentity = await generateValidatedEmailReview(threads, async () => ({
      ok: true,
      value: { items: [bad, good] },
    }));
    expect(wrongIdentity.answer).toBeUndefined();
  });

  it('reports source-relative deadlines without converting them to guessed dates', () => {
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
      deadline: { messageId: thread.latestMessageId, quote: 'tomorrow' },
      draftBody: 'Thanks for asking. [Choose one: available / unavailable] to volunteer tomorrow.',
    };
    const checked = validateEmailReviewAnswer({ items: [assessment] }, [thread]);
    expect(checked?.items[0]?.deadlineQuote).toBe('tomorrow');
    const formatted = formatEmailReviewAnswer(
      checked?.items ?? [],
      emailReviewCoverage([thread.threadId], [thread], [search(thread.threadId)]),
    );
    expect(formatted).toContain(
      '“tomorrow” (source message dated 2026-10-11T16:00:00Z; wording is relative)',
    );
    expect(formatted).not.toContain('October 11');

    const missing = {
      items: [{ ...assessment, deadline: null }],
    };
    expect(emailReviewValidationIssues(missing, [thread])).toContain(
      'item_0:possible_relevant_deadline_in_thread',
    );
  });

  it('counts completed source assessments separately from complete thread reads', () => {
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
    expect(text).toContain('verified reply checks for 1 of 2 selected threads');
    expect(text).toContain('Complete reads are not the same as completed assessments.');
    expect(text).not.toContain('2 of 2 selected threads');
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
    expect(result.answer?.items[0]?.draftBody).toBe('Thanks for your note.');
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

  it('repairs exact-source failures and prepares owner-choice placeholders for direct volunteer and RSVP asks', async () => {
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
      deadlineQuote: string,
      draftBody: string,
    ) => ({
      threadId: thread.threadId,
      latestMessageId: thread.latestMessageId,
      disposition: 'draft' as const,
      recipient: thread.recipient,
      why: 'The latest inbound message asks for a response.',
      whyMessageId: thread.latestMessageId,
      whyQuote,
      deadline: { messageId: thread.latestMessageId, quote: deadlineQuote },
      draftBody,
      draftSourceMessageIds: [thread.latestMessageId],
    });
    const valid = {
      items: [
        assessment(
          volunteer,
          'Are you able to?',
          'tomorrow',
          'Thanks for checking. [Choose one: available / unavailable] to help tomorrow.',
        ),
        assessment(
          rsvp,
          "If you have not yet RSVP'd, please click this link to RSVP",
          'by October 18',
          'Thanks for the reminder. [Add your RSVP choice here] for the October 21 PTA meeting.',
        ),
      ],
    };
    const invalid = structuredClone(valid);
    const firstInvalid = required(invalid.items[0], 'invalid volunteer assessment');
    firstInvalid.whyMessageId = required(volunteer.messages[0], 'earlier message').messageId;
    firstInvalid.whyQuote = 'Nobody signed up and you can help tomorrow.';
    if (!firstInvalid.deadline) throw new Error('missing invalid deadline fixture');
    firstInvalid.deadline.quote = 'by tomorrow';

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

    expect(result.attempts).toBe(2);
    expect(result.answer?.items.map((item) => item.disposition)).toEqual(['draft', 'draft']);
    expect(result.answer?.items.map((item) => item.deadlineQuote)).toEqual([
      'tomorrow',
      'by October 18',
    ]);
    expect(result.answer?.items.map((item) => item.draftBody)).toEqual([
      'Thanks for checking. [Choose one: available / unavailable] to help tomorrow.',
      'Thanks for the reminder. [Add your RSVP choice here] for the October 21 PTA meeting.',
    ]);
    const formatted = formatEmailReviewAnswer(
      result.answer?.items ?? [],
      emailReviewCoverage(
        ['volunteer-request', 'pta-rsvp'],
        result.answer?.items.map((item) => item.thread) ?? [],
        [search('volunteer-request'), search('pta-rsvp')],
      ),
    );
    expect(formatted.match(/Draft for review — not saved or sent:/g)).toHaveLength(2);
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
    expect(parsedPrompt.threads[0]?.messages).toHaveLength(2);
    expect(parsedPrompt.threads[0]?.messages[0]?.promptRole).toBe('thread_context');
    expect(parsedPrompt.threads[0]?.messages[1]?.promptRole).toBe('latest_inbound');
    expect(parsedPrompt.threads[0]?.messages[1]?.text).toContain('Are you able to?');
    expect(required(calls[1], 'repair model call').prompt).toContain(
      'item_0:literal_why_quote_from_named_message',
    );
  });

  it('rejects no_reply only for a clear unquoted direct ask, not a quoted or incidental RSVP mention', () => {
    const makeThread = (threadId: string, text: string) => {
      const sourceMessages = messages(threadId);
      const latest = required(sourceMessages.at(-1), 'latest source message');
      latest.text = text;
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
    linkedAssessment.draftBody = 'Thanks for the reminder about October 18.';
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
        ['request-a', 'request-b', 'request-c', 'request-d'],
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
    expect(text).toContain('fully checked but did not meet the criteria');
    expect(text).toContain('complete, valid read did not establish whether it qualified');
    expect(text).toContain('step limit before another replacement thread could be read');
    expect(text).not.toContain('no more threads to replace');
  });
});
