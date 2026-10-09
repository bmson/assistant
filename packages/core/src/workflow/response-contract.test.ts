import { describe, expect, it } from 'vitest';
import { evidenceClaimFacts } from './claim-facts.js';
import { correctFlightWriteClaims } from './flight-write-contract.js';
import {
  type ActionEvidence,
  activeWatchReceipt,
  enforceResponseContract,
  enforceUrlProvenance,
  groundReadDraft,
  verifiedReadResponse,
  withMissingFutureWatchNotice,
} from './response-contract.js';

describe('future watch response receipts', () => {
  const expiry = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const invalidReceiptCases: Array<{
    label: string;
    status: string;
    expiresAt: string;
    fromCurrentTask?: boolean;
    evidenceStatus?: string;
  }> = [
    {
      label: 'expired',
      status: 'active',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    },
    { label: 'cancelled', status: 'cancelled', expiresAt: expiry },
    { label: 'previous-task', status: 'active', expiresAt: expiry, fromCurrentTask: false },
    { label: 'failed', status: 'active', expiresAt: expiry, evidenceStatus: 'failed' },
  ];

  it('accepts a matching current-task email watch with active unexpired receipt', () => {
    const requestText = 'Tell me if alex@example.com emails me';
    const evidence: ActionEvidence[] = [
      {
        toolName: 'watch.create',
        status: 'succeeded',
        result: {
          watchId: 'watch-1',
          status: 'active',
          expiresAt: expiry,
          expectedSenderEmails: ['alex@example.com'],
          keywords: [],
        },
      },
    ];
    const result = enforceResponseContract(
      "The email watch is active, and I'll notify you when Alex emails you.",
      evidence,
      { requestText },
    );
    expect(activeWatchReceipt(evidence[0] as ActionEvidence)).toMatchObject({
      channel: 'email',
      watchId: 'watch-1',
      expiresAt: expiry,
    });
    expect(result).toMatchObject({ blocked: false, text: expect.any(String) });
  });

  it('accepts a matching current-task web watch and rejects a wrong URL', () => {
    const requestText = 'Tell me if https://example.com/status changes';
    const evidence: ActionEvidence[] = [
      {
        toolName: 'watch.web',
        status: 'succeeded',
        result: {
          watchId: 'watch-web',
          status: 'active',
          expiresAt: expiry,
          url: 'https://example.com/status',
          mode: 'change',
        },
      },
    ];
    expect(
      enforceResponseContract("I'll notify you if that page changes.", evidence, { requestText }),
    ).toMatchObject({ blocked: false });

    const webReceipt = evidence[0];
    if (!webReceipt) throw new Error('expected web watch receipt');
    const wrong: ActionEvidence[] = [
      {
        ...webReceipt,
        result: { ...(webReceipt.result as object), url: 'https://other.example/status' },
      },
    ];
    const blocked = enforceResponseContract("I'll notify you if that page changes.", wrong, {
      requestText,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.unsupported).toContain('background');
  });

  it('accepts a named email watch only when a complete current Gmail read resolves its sender', () => {
    const requestText = 'Tell me if Alex emails me';
    const receipt: ActionEvidence = {
      toolName: 'watch.create',
      status: 'succeeded',
      result: {
        watchId: 'watch-alex',
        status: 'active',
        expiresAt: expiry,
        expectedSenderEmails: ['alex@example.com'],
        keywords: [],
      },
    };
    const search: ActionEvidence = {
      toolName: 'gmail.search',
      status: 'succeeded',
      result: {
        complete: true,
        results: [{ from: 'Alex Rivera <alex@example.com>', subject: 'Project update' }],
      },
    };
    expect(
      enforceResponseContract("I'll notify you when Alex emails you.", [search, receipt], {
        requestText,
      }),
    ).toMatchObject({ blocked: false });

    const wrongReceipt: ActionEvidence = {
      ...receipt,
      result: {
        ...(receipt.result as Record<string, unknown>),
        expectedSenderEmails: ['other@example.com'],
      },
    };
    const wrong = enforceResponseContract(
      "I'll notify you when Alex emails you.",
      [search, wrongReceipt],
      { requestText },
    );
    expect(wrong.blocked).toBe(true);
  });

  it('preserves a verified current result while replacing an unsupported watch promise', () => {
    const result = enforceResponseContract(
      "The complete search found no matching reply. I'll notify you if one arrives.",
      [
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          result: { complete: true, results: [] },
        },
      ],
      { requestText: 'Tell me if alex@example.com emails me' },
    );
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('The complete search found no matching reply.');
    expect(result.text).toContain('No active watch has been confirmed');
    expect(result.text).not.toMatch(/I'll notify you/i);
  });

  it('keeps a useful final lookup result and states when bounded recovery found no watch receipt', () => {
    const text = withMissingFutureWatchNotice('The complete search found one reply from Alex.');
    expect(text).toContain('The complete search found one reply from Alex.');
    expect(text).toContain('No active watch has been confirmed');
    expect(withMissingFutureWatchNotice("I couldn't confirm whether the watch was created.")).toBe(
      "I couldn't confirm whether the watch was created.",
    );
  });

  it.each(invalidReceiptCases)('does not treat $label as an active watch receipt', (values) => {
    const evidence: ActionEvidence = {
      toolName: 'watch.create',
      status: values.evidenceStatus ?? 'succeeded',
      ...(values.fromCurrentTask === false ? { fromCurrentTask: false } : {}),
      result: {
        watchId: 'watch-stale',
        status: values.status,
        expiresAt: values.expiresAt,
        expectedSenderEmails: ['alex@example.com'],
      },
    };
    expect(activeWatchReceipt(evidence)).toBeUndefined();
    const response = enforceResponseContract("I'll notify you when Alex emails you.", [evidence], {
      requestText: 'Tell me if alex@example.com emails me',
    });
    expect(response.blocked).toBe(true);
    expect(response.text).toMatch(/No active watch has been confirmed/);
  });
});

describe('response execution contract', () => {
  it('does not treat an explicit no-new-send status as a fresh outbound action', () => {
    const text = 'The previous invitation was accepted; no new email was sent.';
    expect(enforceResponseContract(text, [])).toMatchObject({
      blocked: false,
      text,
      unsupported: [],
    });
  });

  it('still validates an affirmative send clause beside a no-new-send status', () => {
    const text = 'No new email was sent, but I sent the original invitation today.';
    const checked = enforceResponseContract(text, []);
    expect(checked.blocked).toBe(true);
    expect(checked.unsupported).toContain('outbound');
  });

  it.each([
    'No email was queued; another email was sent.',
    'No email was sent, but another message was sent.',
    'Not only was an email sent, but a message was sent too.',
    "I'm not sure whether a new email was sent.",
  ])('does not let a no-send phrase hide another or uncertain outbound claim: %s', (text) => {
    const checked = enforceResponseContract(text, []);
    expect(checked.blocked).toBe(true);
    expect(checked.unsupported).toContain('outbound');
  });

  it.each([
    ['drive', 'drive.search', 'files'],
    ['memory', 'memory.recall', 'memories'],
    ['knowledge_graph', 'memory.graph_snapshot', 'relationships'],
  ] as const)(
    'does not turn an empty incomplete %s lookup into an absence claim',
    (kind, toolName, key) => {
      const response = verifiedReadResponse(
        { kind, firstToolName: toolName, queryTerms: [], requiresThreadRead: false },
        [{ toolName, status: 'succeeded', result: { complete: false, [key]: [] } }],
      );
      expect(response).toMatch(/bounded lookup/);
      expect(response).toMatch(/does not establish/);
    },
  );
  it('answers sender and subject questions from complete metadata without opening bodies', () => {
    const response = verifiedReadResponse(
      {
        kind: 'email',
        firstToolName: 'gmail.search',
        queryTerms: ['clay'],
        requiresThreadRead: false,
      },
      [
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          args: { query: 'clay' },
          result: {
            complete: true,
            mailboxSearched: 'assistant@example.com',
            matchingMessagesEstimate: 1,
            results: [
              {
                messageId: 'message-1',
                threadId: 'thread-1',
                from: 'recruiter@example.com',
                subject: 'Clay interview',
                date: 'Oct 1, 2026',
              },
            ],
          },
        },
      ],
    );
    expect(response).toContain('recruiter@example.com');
    expect(response).toContain(
      'Thread bodies were not opened because the requested sender/subject metadata was sufficient.',
    );
    expect(response).toContain('0 of 1 matching threads opened');
  });

  it('does not claim a complete negative result when a bounded Gmail page remains', () => {
    const response = verifiedReadResponse(
      {
        kind: 'email',
        firstToolName: 'gmail.search',
        queryTerms: ['clay'],
        requiresThreadRead: false,
      },
      [
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          args: { query: 'clay' },
          result: {
            complete: false,
            hasMore: true,
            mailboxSearched: 'assistant@example.com',
            matchingMessagesEstimate: 8,
            coverage: { requested: 20, discovered: 8, returned: 0, hasMore: true },
            results: [],
          },
        },
      ],
    );
    expect(response).toContain('checked subset');
    expect(response).toContain('more metadata pages remain');
    expect(response).not.toMatch(/no matching messages were returned\.$/);
  });
  it('renders every returned calendar event in a complete deterministic agenda', () => {
    const events = Array.from({ length: 50 }, (_, index) => ({
      eventId: `event-${index}`,
      summary: `Appointment ${index + 1}`,
      start: '2026-10-07T09:00:00-07:00',
      end: '2026-10-07T09:30:00-07:00',
    }));
    const response = verifiedReadResponse(
      {
        kind: 'calendar',
        firstToolName: 'calendar.list_events',
        queryTerms: [],
        requiresThreadRead: false,
      },
      [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          result: { complete: true, calendarsSearched: ['Primary'], events },
        },
      ],
    );
    for (const event of events) expect(response).toContain(event.summary);
    expect(response).toContain('Appointment 50');
  });
  it.each([
    'Mira has an appointment scheduled for January 12.',
    'Her appointment was scheduled for January 12.',
    'The appointment was scheduled by Mira.',
  ])('preserves explicit third-party history without a write receipt: %s', (text) => {
    expect(
      enforceResponseContract(text, [], { requestText: 'Describe Mira’s background.' }),
    ).toMatchObject({ text, blocked: false, unsupported: [] });
  });
  it('preserves a focused grounded relationship without dumping unrelated edges', () => {
    const readRequest = {
      kind: 'knowledge_graph' as const,
      queryTerms: ['Mira', 'Cedar'],
      firstToolName: 'memory.graph_snapshot' as const,
      requiresThreadRead: false,
    };
    const evidence = [
      {
        toolName: 'memory.graph_snapshot',
        status: 'succeeded',
        args: { query: 'Mira Cedar' },
        result: {
          complete: false,
          relationships: [
            {
              id: 'relevant',
              subjectLabel: 'Mira',
              predicate: 'works_for',
              objectLabel: 'Cedar',
              ownerConfirmed: true,
            },
            ...Array.from({ length: 20 }, (_, index) => ({
              id: String(index),
              subjectLabel: `Other${index}`,
              predicate: 'knows',
              objectLabel: 'Jordan',
              ownerConfirmed: true,
            })),
          ],
        },
      },
    ];
    expect(
      enforceResponseContract('Mira works for Cedar.', evidence, { readRequest }),
    ).toMatchObject({ text: 'Mira works for Cedar.', blocked: false });
    const reversed = enforceResponseContract('Cedar works for Mira.', evidence, { readRequest });
    expect(reversed.text).not.toBe('Cedar works for Mira.');
    expect(reversed.groundingFallback).toBeDefined();
  });
  it('replaces an obvious generation loop with a bounded failure reply', () => {
    const malformed = 'not-a-word'.repeat(30);
    const result = enforceResponseContract(malformed, []);
    expect(result).toMatchObject({
      text: "I couldn't produce a reliable answer just now. Please try again.",
      blocked: true,
      unsupported: [],
      qualityFallback: true,
    });
    // The same deterministic contract runs after an optional verifier rewrite.
    expect(enforceResponseContract(malformed, []).qualityFallback).toBe(true);
  });

  it('preserves a long repetition when the owner explicitly asks for it', () => {
    const repeated = 'bad-token-'.repeat(30);
    expect(
      enforceResponseContract(repeated, [], {
        requestText: 'Repeat this exactly: bad-token-',
      }),
    ).toMatchObject({ text: repeated, blocked: false });
  });

  it('rejects malformed verifier wording on the same post-rewrite contract path', () => {
    const verifierRevision = 'The reported temperature is 12°Chare.';
    expect(enforceResponseContract(verifierRevision, [])).toMatchObject({
      text: "I couldn't produce a reliable answer just now. Please try again.",
      qualityFallback: true,
    });
  });

  it('blocks a fabricated spreadsheet and silent background-work claim', () => {
    const result = enforceResponseContract(
      "I created a shared spreadsheet and I'll keep researching silently.",
      [],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toEqual(expect.arrayContaining(['spreadsheet', 'background']));
    expect(result.text).toContain("I couldn't complete this because");
  });

  it('blocks tracker status reports that have no durable work behind them', () => {
    const result = enforceResponseContract(
      'Mission update: the live tracker is active and 22 target companies are ready.',
      [],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toEqual(
      expect.arrayContaining(['spreadsheet', 'research', 'background']),
    );
  });

  it('blocks a fabricated approval notice that has no dispatcher record', () => {
    const result = enforceResponseContract(
      'This needs your approval before I act:\n- **[A12]** Browse Indeed\nApprove or deny it on the Approvals page — I will pick up from there.',
      [],
    );
    expect(result).toMatchObject({ blocked: true, unsupported: ['approval'] });
    expect(result.text).toContain('nothing is waiting on the Approvals page');
    expect(result.text).not.toContain('A12');
  });

  it('blocks application-submission claims even after a generic browser run', () => {
    const result = enforceResponseContract(
      'I submitted your application and saved the confirmation.',
      [
        {
          toolName: 'browser.execute',
          status: 'succeeded',
          result: { ok: true },
        },
      ],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('application');
  });

  it('allows an application claim after an approved browser run submits and extracts a portal confirmation', () => {
    const text = 'I submitted the application. The portal confirmed it received your application.';
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'browser.execute',
          status: 'succeeded',
          result: {
            ok: true,
            outputs: [
              { action: 'type', ok: true },
              { action: 'click', ok: true },
              {
                action: 'extract',
                text: 'Thank you for applying. We have received your application.',
              },
            ],
          },
        },
      ]),
    ).toMatchObject({ blocked: false, text });
  });

  it('does not accept a read-only extract of confirmation-looking page text as a submission', () => {
    // The page text is attacker-influenceable; without an actual form
    // interaction in the run it must not authorise a submission claim.
    const result = enforceResponseContract(
      'I submitted your application — the portal confirmed it received your application.',
      [
        {
          toolName: 'browser.execute',
          status: 'succeeded',
          result: {
            ok: true,
            outputs: [
              { action: 'goto', ok: true, url: 'https://careers.example/jobs' },
              {
                action: 'extract',
                text: 'Careers at Acme. Thank you for applying! Browse more open roles below.',
              },
            ],
          },
        },
      ],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('application');
  });

  it('allows a document claim only after a successful workspace tool', () => {
    const result = enforceResponseContract('I created the shared document.', [
      {
        toolName: 'docs.create',
        status: 'succeeded',
        result: { documentId: 'doc-1' },
      },
    ]);
    expect(result).toMatchObject({
      blocked: false,
      text: 'I created the shared document.',
    });
  });

  it('does not treat an HTTP error as completed research', () => {
    const result = enforceResponseContract('I researched 22 target companies.', [
      {
        toolName: 'web.fetch',
        status: 'succeeded',
        result: { status: 429, text: '' },
      },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('research');
  });

  it('keeps an explicit capability limitation and an in-chat draft intact', () => {
    const text =
      "I can't submit an application without a successful portal action. Here is a draft cover letter.";
    expect(enforceResponseContract(text, [])).toMatchObject({
      blocked: false,
      text,
    });
  });

  it('does not rewrite a future-tense plan as if it were a failed action', () => {
    const text =
      "I'll research senior frontend roles at AI companies, compile a shortlist, and share it for your approval. No tool action has happened yet.";
    expect(enforceResponseContract(text, [])).toMatchObject({
      blocked: false,
      text,
    });
  });

  it.each([
    "I've completed the review of the three finalists — here are my notes.",
    'I confirmed the two salary figures match.',
    "I've completed my analysis of the two offers.",
  ])('does not treat generic "completed"/"confirmed" as an application claim: %s', (text) => {
    // These verbs are ordinary English, not application submissions; without an
    // application object they must not be rewritten into failure boilerplate.
    expect(enforceResponseContract(text, [])).toMatchObject({
      blocked: false,
      text,
    });
  });

  // Reporting what a SENDER did is not a claim that the assistant sent anything.
  // This used to throw away correct answers: an honest "TripIt sent you an
  // email" was rewritten to "Still needed: the requested outbound message".
  it.each([
    'TripIt sent you an email confirming the hotel for Saturday.',
    'Hotels.com emailed your travel confirmation on Sep 2.',
    'Yes — TripIt sent an email on Wed, Sep 2 with the Hotels.com itinerary.',
    'They replied to your message yesterday.',
  ])('publishes a mailbox answer that narrates what a sender did: %s', (text) => {
    const result = enforceResponseContract(text, [
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        result: {
          results: [{ threadId: 't1' }],
          mailboxSearched: 'assistant@example.com',
          complete: true,
        },
      },
    ]);
    expect(result.blocked).toBe(false);
    expect(result.unsupported).not.toContain('outbound');
    expect(result.text).toBe(text);
  });

  // A model that never ran a read asserting emptiness is the same fabrication
  // as a fake "I checked" — and it reaches for the negated form far more often
  // than for "nothing in your inbox".
  it.each([
    ["I don't see any emails in your inbox about a hotel this weekend.", 'inbox_read'],
    ["I didn't find any emails in your inbox.", 'inbox_read'],
    ["I'm not seeing any messages from them.", 'inbox_read'],
    ["I don't see any conflicts on your calendar.", 'calendar_read'],
  ] as const)('flags a negated-any empty read with no evidence: %s', (text, kind) => {
    const result = enforceResponseContract(text, []);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain(kind);
  });

  it.each([
    'The hiring manager has been emailed with your follow-up.',
    'They have been notified about the schedule change.',
    'The client has been contacted.',
  ])('blocks passive-voice outbound claims with no send evidence: %s', (text) => {
    const result = enforceResponseContract(text, []);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('outbound');
  });

  it.each([
    [
      'Your spreadsheet is ready. The tracker now has 18 companies.',
      ['spreadsheet', 'research', 'background'],
    ],
    ['Sent outreach to eight engineers, and the email has been delivered.', ['outbound']],
    ['Your Vercel application is confirmed and complete.', ['application']],
    ['Application received — I saved the confirmation PDF.', ['application']],
    ['The job application went through. Applied to four additional roles.', ['application']],
    ['Your interview is booked for Tuesday and the calendar event is ready.', ['calendar']],
    ['I put it on your calendar. The meeting is set.', ['calendar']],
    ['I found and recorded 12 target companies from job boards.', ['research']],
    ['I researched the industry and browsed the competitors.', ['research']],
    ["I've emailed the hiring manager a follow-up.", ['outbound']],
    ["I'll keep handling this while you're away.", ['background']],
    ["I'll keep applying to more roles while you're away.", ['application', 'background']],
    ['Your task is running and the monitoring mission is active.', ['background']],
    [
      'Created a tracker, sent outreach to the first eight people, and submitted their applications.',
      ['spreadsheet', 'outbound', 'application'],
    ],
  ])('blocks a plausible but unevidenced status update: %s', (text, expected) => {
    const result = enforceResponseContract(text, []);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toEqual(expect.arrayContaining(expected));
  });

  it('does not let a successful document action justify a fabricated spreadsheet or email', () => {
    const result = enforceResponseContract(
      'I created the project document, updated the spreadsheet, and sent the client email.',
      [
        {
          toolName: 'docs.create',
          status: 'succeeded',
          result: { documentId: 'doc-1' },
        },
      ],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toEqual(expect.arrayContaining(['spreadsheet', 'outbound']));
    expect(result.text).toContain('Completed: the Google Doc action completed');
    expect(result.text).toContain('Still needed:');
    expect(result.text).not.toContain("I couldn't complete this because");
  });

  it('preserves a verified submission when a later document claim is unsupported', () => {
    const result = enforceResponseContract(
      'I submitted the application and updated the Google Doc.',
      [
        {
          toolName: 'browser.execute',
          status: 'succeeded',
          result: {
            outputs: [
              { action: 'click', ok: true },
              {
                action: 'extract',
                text: 'Thank you for applying. We have received your application.',
              },
            ],
          },
        },
      ],
    );
    expect(result).toMatchObject({ blocked: true, unsupported: ['workspace'] });
    expect(result.text).toContain('portal returned an explicit application confirmation');
    expect(result.text).toContain('Still needed: the requested document or file action');
    expect(result.text).not.toContain('I have not submitted');
  });

  it('accepts a Sheet-backed tracker update and a durable confirmation watch', () => {
    const text =
      "I updated the application tracker. The confirmation watcher is active, and I'll keep monitoring for the receipt.";
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'sheets.write_rows',
          status: 'succeeded',
          result: { writtenRows: 1 },
        },
        {
          toolName: 'applications.watch_confirmation',
          status: 'succeeded',
          result: { applicationId: 'app-1', status: 'awaiting_confirmation' },
        },
      ]),
    ).toMatchObject({ blocked: false, text });
  });

  it.each([
    ['I updated the Google Doc.', 'docs.get', { documentId: 'doc-1', text: 'existing' }],
    ['I updated the tracker.', 'sheets.get_rows', { values: [['existing']] }],
    ['I scheduled the interview.', 'calendar.list_events', { events: [] }],
  ])('does not let a read-only tool justify a mutation claim: %s', (text, toolName, result) => {
    const guarded = enforceResponseContract(text, [{ toolName, status: 'succeeded', result }]);
    expect(guarded.blocked).toBe(true);
  });

  it('accepts a verified calendar cancellation', () => {
    const text = 'I cancelled the calendar event.';
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'calendar.cancel_event',
          status: 'succeeded',
          result: { eventId: 'event-1', status: 'cancelled' },
        },
      ]),
    ).toMatchObject({ blocked: false, text });
  });

  it('does not let a send to one person prove a send claim about another', () => {
    const result = enforceResponseContract('I sent the email to Bob.', [
      {
        toolName: 'gmail.send',
        status: 'succeeded',
        args: { to: ['alice@example.com'] },
        result: { messageId: 'sent-alice', to: ['alice@example.com'] },
      },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('outbound');
  });

  it('does not let a cancellation receipt prove that an event was created', () => {
    const result = enforceResponseContract('I created the calendar event.', [
      {
        toolName: 'calendar.cancel_event',
        status: 'succeeded',
        args: { summary: 'Dentist appointment' },
        result: { eventId: 'event-1', status: 'cancelled', summary: 'Dentist appointment' },
      },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('calendar');
  });

  it('does not let one successful send justify a three-message claim', () => {
    const result = enforceResponseContract('I sent three emails.', [
      {
        toolName: 'gmail.send',
        status: 'succeeded',
        result: { messageId: 'sent-once', to: ['recipient@example.com'] },
      },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('outbound');
  });

  it('accepts a verified Google Doc text replacement', () => {
    const text = 'I updated the Google Doc.';
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'docs.replace_text',
          status: 'succeeded',
          result: { documentId: 'doc-1', updated: true },
        },
      ]),
    ).toMatchObject({ blocked: false, text });
  });

  it('allows a complex report only when every claimed action has matching success evidence', () => {
    const text =
      'I created the spreadsheet, sent the email, scheduled the interview, and submitted the application.';
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'sheets.create',
          status: 'succeeded',
          result: { spreadsheetId: 'sheet-1' },
        },
        {
          toolName: 'gmail.send',
          status: 'succeeded',
          result: { messageId: 'gmail-accepted-1', to: ['recipient@example.com'] },
        },
        {
          toolName: 'calendar.create',
          status: 'succeeded',
          result: { eventId: 'event-1' },
        },
        {
          toolName: 'application.submit',
          status: 'succeeded',
          result: { confirmationId: 'app-1' },
        },
      ]),
    ).toMatchObject({ blocked: false, text });
  });

  it('treats a bare Workspace link as a reference, not a creation claim', () => {
    // Regression: linking a doc built in an earlier turn was rewritten into a
    // flat denial that anything had been created.
    const text =
      "Got it! I'll continue adding the itinerary details to the Google Doc as I work on them. You can track updates here:\n[Itinerary Doc](https://docs.google.com/document/d/doc-1/edit)";
    // The unbacked "I'll continue" is still caught; the link alone is not.
    expect(enforceResponseContract(text, [])).toMatchObject({
      unsupported: ['background'],
    });
  });

  it('still catches a mutation claim made alongside a Workspace link', () => {
    const result = enforceResponseContract(
      'Created the requested Google Doc: https://docs.google.com/document/d/doc-1/edit',
      [],
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('workspace');
  });

  it('types a Workspace link claim by its URL path', () => {
    const result = enforceResponseContract(
      'I updated your sheet: https://docs.google.com/spreadsheets/d/sheet-1/edit',
      [],
    );
    expect(result.unsupported).toContain('spreadsheet');
    expect(result.unsupported).not.toContain('workspace');
  });

  it('accepts an artifact reference backed by an earlier turn in the conversation', () => {
    const text = 'I created the itinerary document.';
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'docs.create',
          status: 'succeeded',
          result: { documentId: 'doc-1' },
          fromCurrentTask: false,
        },
      ]),
    ).toMatchObject({ blocked: false, text });
  });

  it('does not let an earlier artifact action justify a fresh edit claim', () => {
    const guarded = enforceResponseContract('I updated the Google Doc.', [
      {
        toolName: 'docs.create',
        status: 'succeeded',
        result: { documentId: 'doc-1' },
        fromCurrentTask: false,
      },
    ]);
    expect(guarded.blocked).toBe(true);
    expect(guarded.unsupported).toContain('workspace');
  });

  it.each([
    ['I sent the follow-up email.', 'gmail.send', { deliveryStatus: 'sent' }],
    ['I submitted the application.', 'application.submit', { confirmationId: 'app-1' }],
    ['I booked the interview on your calendar.', 'calendar.create', { eventId: 'event-1' }],
  ])(
    'does not let an earlier turn authorise a fresh outward-facing action: %s',
    (text, toolName, result) => {
      const guarded = enforceResponseContract(text, [
        { toolName, status: 'succeeded', result, fromCurrentTask: false },
      ]);
      expect(guarded.blocked).toBe(true);
    },
  );

  it('says when the verified action actually happened', () => {
    const result = enforceResponseContract('I updated the doc and sent the client an email.', [
      {
        toolName: 'docs.create',
        status: 'succeeded',
        result: { documentId: 'doc-1' },
        fromCurrentTask: false,
      },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('outbound');
    expect(result.text).toContain('the Google Doc action completed earlier in this conversation');
    expect(result.text).not.toContain('I have not created');
  });

  it('blocks a memory write the model only narrated (no memory.save)', () => {
    const result = enforceResponseContract("Got it — I've corrected the birthdate in memory.", []);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('memory');
    expect(result.text).not.toContain('saved to memory');
  });

  it('confirms a memory write backed by a memory.save result', () => {
    const result = enforceResponseContract('Saved that correction to memory.', [
      { toolName: 'memory.save', status: 'succeeded', result: { saved: true } },
    ]);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe('Saved that correction to memory.');
  });

  it('does not reprint unrelated prior-turn artifacts for an off-topic claim', () => {
    // The "update the memory" incident: a turn that claims one thing (calendar,
    // here) must not list every earlier Drive/Doc action as "confirmed".
    const result = enforceResponseContract('Added it to your calendar.', [
      {
        toolName: 'drive.download',
        status: 'succeeded',
        result: { ok: true },
        fromCurrentTask: false,
      },
      {
        toolName: 'docs.create',
        status: 'succeeded',
        result: { documentId: 'd1' },
        fromCurrentTask: false,
      },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('calendar');
    expect(result.text).not.toContain('Drive file');
    expect(result.text).not.toContain('Google Doc');
  });

  it('does not report an earlier turn failure as this attempt failing', () => {
    const result = enforceResponseContract('I emailed the client.', [
      {
        toolName: 'gmail.send',
        status: 'failed',
        result: null,
        error: 'quota',
        fromCurrentTask: false,
      },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('quota');
  });

  it('fails closed when a claimed email has a success status but an unknown delivery result', () => {
    const result = enforceResponseContract('The email has been delivered.', [
      {
        toolName: 'gmail.send',
        status: 'succeeded',
        result: { deliveryStatus: 'unknown' },
      },
    ]);
    expect(result.blocked).toBe(true);
    // Said in the owner's words: the step that failed, not the tool's name.
    expect(result.text).toContain("sending the message didn't go through");
    expect(result.text).not.toContain('gmail.send');
  });

  it('keeps a short human cause but never repeats a provider body, a URL or a tool name', () => {
    const failing = (error: string) =>
      enforceResponseContract('I sent the text.', [
        { toolName: 'sms.send', status: 'failed', result: null, error },
      ]).text;
    expect(failing('SMS provider rejected the request.')).toContain(
      "sending the message didn't go through (SMS provider rejected the request)",
    );
    const noisy = failing(
      'Upstream error from DeepInfra: {"error":{"message":"The request was rejected as invalid."}} https://x.test',
    );
    expect(noisy).toContain("sending the message didn't go through.");
    expect(noisy).not.toMatch(/DeepInfra|\{|https?:|sms\.send/u);
  });

  it('blocks a claimed saved Gmail draft without a create-draft result', () => {
    for (const text of [
      'I saved the reply draft in Gmail.',
      'I created a Gmail draft.',
      'I drafted the reply in Gmail.',
      'The Gmail draft is ready.',
      'The draft is now in Gmail.',
      "You'll find the draft in the Gmail drafts folder.",
    ]) {
      const result = enforceResponseContract(text, []);
      expect(result.blocked, text).toBe(true);
      expect(result.unsupported, text).toContain('email_draft');
    }
  });

  it('allows a saved Gmail draft only when this task created it', () => {
    const text = 'I saved the reply draft in Gmail.';
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'gmail.create_draft',
          status: 'succeeded',
          result: { draftId: 'draft-1' },
        },
      ]),
    ).toMatchObject({ blocked: false, text });

    const stale = enforceResponseContract(text, [
      {
        toolName: 'gmail.create_draft',
        status: 'succeeded',
        result: { draftId: 'old-draft' },
        fromCurrentTask: false,
      },
    ]);
    expect(stale.blocked).toBe(true);
    expect(stale.unsupported).toContain('email_draft');
  });

  it.each([
    'Here is a draft email you can edit before sending.',
    'I drafted the email below; nothing was saved to Gmail.',
    'These messages were already marked as important when I found them.',
  ])('does not mistake in-chat or descriptive email text for an external action: %s', (text) => {
    expect(enforceResponseContract(text, [])).toMatchObject({ blocked: false, text });
  });

  it.each([
    'I archived the three messages.',
    "I've marked those emails as read.",
    'The threads were labeled Important.',
    'Archived 10 emails from the inbox.',
  ])('blocks a claimed inbox mutation without gmail.modify: %s', (text) => {
    const result = enforceResponseContract(text, []);
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('inbox_write');
  });

  it('allows a verified inbox mutation', () => {
    const text = "I've marked those emails as read.";
    expect(
      enforceResponseContract(text, [
        {
          toolName: 'gmail.modify',
          status: 'succeeded',
          result: { id: 'thread-1', removedLabels: ['UNREAD'] },
        },
      ]),
    ).toMatchObject({ blocked: false, text });
  });

  it('does not accept empty Gmail success rows as proof of a draft or inbox change', () => {
    const emptyDraft = enforceResponseContract('I created a Gmail draft.', [
      { toolName: 'gmail.create_draft', status: 'succeeded', result: {} },
    ]);
    expect(emptyDraft).toMatchObject({ blocked: true, unsupported: ['email_draft'] });
    expect(emptyDraft.text).not.toContain('Gmail draft was created');
    expect(
      enforceResponseContract('I archived the messages.', [
        {
          toolName: 'gmail.modify',
          status: 'succeeded',
          result: { addedLabels: [], removedLabels: [] },
        },
      ]),
    ).toMatchObject({ blocked: true, unsupported: ['inbox_write'] });
  });

  describe('read claims', () => {
    // The prod incident: a tool-less draft narrated a calendar check that
    // never ran and reported the calendar empty of flights.
    const calendarCheck =
      'I checked your primary calendar and the shared "Family" calendar — no flights in the next 3 weeks.';

    it('blocks a calendar-check claim with no calendar tool behind it', () => {
      const result = enforceResponseContract(calendarCheck, []);
      expect(result.blocked).toBe(true);
      expect(result.unsupported).toContain('calendar_read');
      expect(result.text).toContain("I couldn't complete this because");
    });

    it('blocks an inbox-check claim with no gmail tool behind it', () => {
      const result = enforceResponseContract(
        'I went through your inbox and found nothing urgent.',
        [],
      );
      expect(result.blocked).toBe(true);
      expect(result.unsupported).toContain('inbox_read');
    });

    it('blocks a bare emptiness assertion about the calendar', () => {
      const result = enforceResponseContract(
        'There are no flight events on your calendar for the next three weeks.',
        [],
      );
      expect(result.blocked).toBe(true);
      expect(result.unsupported).toContain('calendar_read');
    });

    it('allows a calendar-check claim backed by a calendar read this task', () => {
      expect(
        enforceResponseContract(calendarCheck, [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            result: { events: [] },
          },
        ]),
      ).toMatchObject({ blocked: false, text: calendarCheck });
    });

    it('does not let a calendar write masquerade as a calendar read', () => {
      const result = enforceResponseContract(calendarCheck, [
        {
          toolName: 'calendar.create_event',
          status: 'succeeded',
          result: { eventId: 'created-1' },
        },
      ]);
      expect(result.blocked).toBe(true);
      expect(result.unsupported).toContain('calendar_read');
    });

    it('does not let sending mail masquerade as searching the inbox', () => {
      const result = enforceResponseContract('I searched your inbox and found no Clay email.', [
        {
          toolName: 'gmail.send',
          status: 'succeeded',
          result: { messageId: 'sent-1' },
        },
      ]);
      expect(result.blocked).toBe(true);
      expect(result.unsupported).toContain('inbox_read');
    });

    it('does not accept empty success rows as proof that a private source was read', () => {
      expect(
        enforceResponseContract(calendarCheck, [
          { toolName: 'calendar.list_events', status: 'succeeded', result: {} },
        ]),
      ).toMatchObject({ blocked: true, unsupported: ['calendar_read'] });
      expect(
        enforceResponseContract('I searched your inbox.', [
          { toolName: 'gmail.search', status: 'succeeded', result: {} },
        ]),
      ).toMatchObject({ blocked: true, unsupported: ['inbox_read'] });
    });

    it('does not misclassify a verified inbox search as unrelated web research', () => {
      const text = 'I searched your inbox.';
      expect(
        enforceResponseContract(text, [
          {
            toolName: 'gmail.search',
            status: 'succeeded',
            result: { results: [] },
          },
        ]),
      ).toMatchObject({ blocked: false, unsupported: [], text });
    });

    it('does not let a prior-turn read authorise a fresh check claim', () => {
      const result = enforceResponseContract(calendarCheck, [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          result: { events: [] },
          fromCurrentTask: false,
        },
      ]);
      expect(result.blocked).toBe(true);
      expect(result.unsupported).toContain('calendar_read');
    });

    it('leaves advice, questions, and promises about checking untouched', () => {
      for (const text of [
        'You should check your calendar before booking.',
        'Want me to check your calendar?',
        "I'll check your calendar now.",
      ]) {
        expect(enforceResponseContract(text, []), text).toMatchObject({
          blocked: false,
          text,
        });
      }
    });

    it('replaces fabricated timed events with the literal returned all-day event', () => {
      const draft = [
        'Let me check your calendar for upcoming events. One moment.',
        '',
        '**(Confirmation: This is a live lookup—not an assumption or cached data.)**',
        '',
        '*(Running tool: calendar.list_events for the next 7 days...)*',
        '',
        'Stand by for verified results.',
        '',
        '**Update**:',
        '',
        'Here’s what’s on your calendar for **Monday, August 17, 2026**:',
        '',
        '**Confirmed Events:**',
        '**Freyja’s Back-to-School Prep**',
        '3:00 PM - 4:30 PM (PDT)',
        'Location: Home',
        '',
        '**Open Time Slots:**',
        '**Morning:** Free (7:00 AM - 3:00 PM)',
        '**Evening:** Free (after 4:30 PM)',
      ].join('\n');
      const result = enforceResponseContract(
        draft,
        [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: {
              timeMin: '2026-08-17T00:00:00-07:00',
              timeMax: '2026-08-18T00:00:00-07:00',
            },
            result: {
              complete: true,
              calendarsSearched: ['Assistant', 'Family'],
              events: [
                {
                  eventId: 'evt-first-day',
                  calendar: 'Family',
                  summary: 'FIRST DAY OF SCHOOL',
                  start: '2026-08-17',
                  end: '2026-08-18',
                },
              ],
            },
          },
        ],
        {
          readRequest: {
            kind: 'calendar',
            queryTerms: [],
            firstToolName: 'calendar.list_events',
            requiresThreadRead: false,
          },
        },
      );
      expect(result).toMatchObject({ blocked: false, unsupported: [] });
      expect(result.text).toContain('**Mon 17 Aug · All day** — FIRST DAY OF SCHOOL');
      expect(result.text).not.toContain('Freyja');
      expect(result.text).not.toContain('3:00 PM');
      expect(result.text).not.toContain('Home');
      expect(result.text).not.toContain('Open Time Slots');
      expect(result.text).not.toContain('Stand by');
    });

    it('requires both calendar and Gmail before answering a named interview lookup', () => {
      const result = enforceResponseContract('Your Clay interview is Monday at 9:30 AM.', [], {
        readRequest: {
          kind: 'calendar_email',
          queryTerms: ['clay', 'interview'],
          firstToolName: 'calendar.search_events',
          requiresThreadRead: true,
        },
      });
      expect(result.blocked).toBe(true);
      expect(result.unsupported).toEqual(expect.arrayContaining(['calendar_read', 'inbox_read']));
      expect(result.text).toMatch(/rather tell you that than fill it in/i);
    });

    it('allows interview details only when the searches and thread contain them', () => {
      const text = 'Your Clay interview is Monday, August 17, 2026 at 9:30 AM.';
      const readRequest = {
        kind: 'calendar_email' as const,
        queryTerms: ['clay', 'interview'],
        firstToolName: 'calendar.search_events' as const,
        requiresThreadRead: true,
      };
      const evidence = [
        {
          toolName: 'calendar.search_events',
          status: 'succeeded',
          args: { query: 'clay interview' },
          result: {
            complete: true,
            calendarsSearched: ['Assistant'],
            events: [],
          },
        },
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          args: { query: 'clay interview' },
          result: {
            complete: true,
            mailboxSearched: 'assistant@example.com',
            results: [
              {
                threadId: 'thread-1',
                subject: 'Clay interview details',
                date: 'Aug 10, 2026',
              },
            ],
          },
        },
        {
          toolName: 'gmail.read_thread',
          status: 'succeeded',
          args: { threadId: 'thread-1' },
          result: {
            complete: true,
            messages: [
              {
                subject: 'Clay interview details',
                text: 'Your Clay interview is Monday, August 17, 2026 at 9:30 AM.',
              },
            ],
          },
        },
      ];
      const result = enforceResponseContract(text, evidence, { readRequest });
      expect(result.blocked).toBe(false);
      // The time it states is written verbatim in the thread that was read, so
      // the answer goes out in the assistant's own words rather than as a
      // rendering of the ledger it came from.
      expect(result.text).toBe(text);
      expect(result.groundingFallback).toBeUndefined();
    });

    it('falls back to the ledger when the draft moves a time the thread gave it', () => {
      const readRequest = {
        kind: 'calendar_email' as const,
        queryTerms: ['clay', 'interview'],
        firstToolName: 'calendar.search_events' as const,
        requiresThreadRead: true,
      };
      const evidence = [
        {
          toolName: 'calendar.search_events',
          status: 'succeeded',
          args: { query: 'clay interview' },
          result: { complete: true, calendarsSearched: ['Assistant'], events: [] },
        },
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          args: { query: 'clay interview' },
          result: {
            complete: true,
            mailboxSearched: 'assistant@example.com',
            results: [{ threadId: 'thread-1', subject: 'Clay interview details' }],
          },
        },
        {
          toolName: 'gmail.read_thread',
          status: 'succeeded',
          args: { threadId: 'thread-1' },
          result: {
            complete: true,
            messages: [
              {
                subject: 'Clay interview details',
                text: 'Your Clay interview is Monday, August 17, 2026 at 9:30 AM.',
              },
            ],
          },
        },
      ];
      const result = enforceResponseContract(
        'Your Clay interview is Monday, August 17, 2026 at 10:30 AM.',
        evidence,
        { readRequest },
      );
      expect(result.blocked).toBe(false);
      expect(result.text).toContain('Clay interview details');
      expect(result.text).not.toContain('10:30 AM');
      expect(result.groundingFallback?.join(' ')).toMatch(/10:30/);
    });

    it('does not let an unrelated Gmail thread satisfy the lookup', () => {
      const readRequest = {
        kind: 'calendar_email' as const,
        queryTerms: ['clay', 'interview'],
        firstToolName: 'calendar.search_events' as const,
        requiresThreadRead: true,
      };
      const result = enforceResponseContract(
        'The interview is Monday.',
        [
          {
            toolName: 'calendar.search_events',
            status: 'succeeded',
            args: { query: 'clay interview' },
            result: { complete: true, calendarsSearched: ['Assistant'], events: [] },
          },
          {
            toolName: 'gmail.search',
            status: 'succeeded',
            args: { query: 'clay interview' },
            result: {
              complete: true,
              mailboxSearched: 'assistant@example.com',
              results: [{ threadId: 'thread-clay' }],
            },
          },
          {
            toolName: 'gmail.read_thread',
            status: 'succeeded',
            args: { threadId: 'thread-unrelated' },
            result: { complete: true, messages: [{ text: 'Monday at 9:30 AM' }] },
          },
        ],
        { readRequest },
      );

      expect(result.blocked).toBe(true);
      expect(result.text).toMatch(/matching Gmail thread/i);
    });

    it('does not let a generic list-events read satisfy a named event search', () => {
      const result = enforceResponseContract(
        'The Clay interview is Monday.',
        [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: { query: 'clay' },
            result: {
              complete: true,
              calendarsSearched: ['Assistant'],
              events: [{ eventId: 'event-1', summary: 'Clay interview' }],
            },
          },
        ],
        {
          readRequest: {
            kind: 'calendar',
            queryTerms: ['clay'],
            firstToolName: 'calendar.search_events',
            requiresThreadRead: false,
          },
        },
      );
      expect(result.blocked).toBe(true);
      expect(result.unsupported).toContain('calendar_read');
    });

    it('requires each of the first matching Gmail threads before reporting details', () => {
      const readRequest = {
        kind: 'calendar_email' as const,
        queryTerms: ['clay'],
        firstToolName: 'calendar.search_events' as const,
        requiresThreadRead: true,
      };
      const result = enforceResponseContract(
        'The interview is Monday at 9:30 AM.',
        [
          {
            toolName: 'calendar.search_events',
            status: 'succeeded',
            args: { query: 'clay' },
            result: { complete: true, calendarsSearched: ['Assistant'], events: [] },
          },
          {
            toolName: 'gmail.search',
            status: 'succeeded',
            args: { query: 'clay' },
            result: {
              complete: true,
              mailboxSearched: 'assistant@example.com',
              results: [
                { threadId: 'thread-1', subject: 'Clay intro' },
                { threadId: 'thread-2', subject: 'Clay interview details' },
              ],
            },
          },
          {
            toolName: 'gmail.read_thread',
            status: 'succeeded',
            args: { threadId: 'thread-1' },
            result: {
              complete: true,
              messages: [{ subject: 'Clay intro', text: 'Intro call completed.' }],
            },
          },
        ],
        { readRequest },
      );

      expect(result.blocked).toBe(true);
      expect(result.text).toContain('Clay intro');
      expect(result.text).toMatch(/1 matching Gmail thread/i);
      expect(result.text).not.toContain('Monday at 9:30 AM');
    });

    it('does not use an unread fourth hit as trip evidence and reports the unread scope', () => {
      const readRequest = {
        kind: 'email' as const,
        queryTerms: ['trip'],
        firstToolName: 'gmail.search' as const,
        requiresThreadRead: true,
      };
      const evidence = [
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          args: { query: 'trip' },
          result: {
            complete: true,
            mailboxSearched: 'assistant@example.com',
            matchingMessagesEstimate: 5,
            results: ['one', 'two', 'three', 'four', 'five'].map((threadId) => ({
              threadId,
              subject: 'Trip update',
              date: 'Oct 1, 2026',
            })),
          },
        },
        ...['one', 'two', 'three'].map((threadId) => ({
          toolName: 'gmail.read_thread',
          status: 'succeeded',
          args: { threadId },
          result: {
            complete: true,
            messages: [{ subject: 'Trip update', text: 'A previous trip record.' }],
          },
        })),
      ];
      const result = enforceResponseContract('The latest trip is to Oslo.', evidence, {
        readRequest,
      });

      expect(result.blocked).toBe(true);
      expect(result.text).toContain('3 of 5 matching threads opened (2 remain unopened)');
      expect(result.text).toMatch(/successful reads of 2 matching Gmail threads/i);
      expect(result.text).not.toContain('Oslo');
    });

    it('renders returned calendar times in the configured owner timezone', () => {
      const result = enforceResponseContract(
        'The event is at 3 PM.',
        [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: {
              timeMin: '2026-08-17T07:00:00.000Z',
              timeMax: '2026-08-18T07:00:00.000Z',
            },
            result: {
              complete: true,
              calendarsSearched: ['Family'],
              events: [
                {
                  eventId: 'event-1',
                  calendar: 'Family',
                  summary: 'School prep',
                  start: '2026-08-17T22:00:00.000Z',
                  end: '2026-08-17T23:30:00.000Z',
                },
              ],
            },
          },
        ],
        {
          readRequest: {
            kind: 'calendar',
            queryTerms: [],
            firstToolName: 'calendar.list_events',
            requiresThreadRead: false,
            timeZone: 'America/Los_Angeles',
            timeWindow: {
              label: 'monday',
              timeMin: '2026-08-17T07:00:00.000Z',
              timeMax: '2026-08-18T07:00:00.000Z',
            },
          },
        },
      );
      // 22:00Z rendered in the owner's zone, not echoed back as UTC.
      expect(result.text).toContain('**15:00–16:30** — School prep');
      expect(result.text).not.toContain('22:00');
      expect(result.text).not.toContain('The event is at 3 PM.');
    });

    it('renders all-day end dates using Google Calendar exclusive-end semantics', () => {
      // A fabricated second event forces the ledger rendering, which is where
      // the exclusive-end date math lives.
      const result = enforceResponseContract(
        'School holiday is August 17, and Parent Evening runs Tuesday.',
        [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: {
              timeMin: '2026-08-17T07:00:00.000Z',
              timeMax: '2026-08-18T07:00:00.000Z',
            },
            result: {
              complete: true,
              calendarsSearched: ['Family'],
              events: [
                {
                  eventId: 'holiday-1',
                  calendar: 'Family',
                  summary: 'School holiday',
                  start: '2026-08-17',
                  end: '2026-08-18',
                },
              ],
            },
          },
        ],
        {
          readRequest: {
            kind: 'calendar',
            queryTerms: [],
            firstToolName: 'calendar.list_events',
            requiresThreadRead: false,
            timeZone: 'America/Los_Angeles',
            timeWindow: {
              label: 'monday',
              timeMin: '2026-08-17T07:00:00.000Z',
              timeMax: '2026-08-18T07:00:00.000Z',
            },
          },
        },
      );
      expect(result.text).toContain('**All day** — School holiday');
      expect(result.text).not.toContain('Tuesday, August 18');
      expect(result.text).not.toContain('Parent Evening');
    });

    it('treats an empty all-source search as a factual result', () => {
      const text = 'I found no Clay interview in the calendars or Gmail.';
      const readRequest = {
        kind: 'calendar_email' as const,
        queryTerms: ['clay', 'interview'],
        firstToolName: 'calendar.search_events' as const,
        requiresThreadRead: true,
      };
      const evidence = [
        {
          toolName: 'calendar.search_events',
          status: 'succeeded',
          args: { query: 'clay interview' },
          result: {
            complete: true,
            calendarsSearched: ['Assistant'],
            events: [],
          },
        },
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          args: { query: 'clay interview' },
          result: {
            complete: true,
            mailboxSearched: 'assistant@example.com',
            results: [],
          },
        },
      ];
      const result = enforceResponseContract(text, evidence, { readRequest });
      expect(result.blocked).toBe(false);
      expect(result.text).toBe(text);
    });

    it('renders the empty result from the ledger when the draft invents one', () => {
      const readRequest = {
        kind: 'calendar_email' as const,
        queryTerms: ['clay', 'interview'],
        firstToolName: 'calendar.search_events' as const,
        requiresThreadRead: true,
      };
      const result = enforceResponseContract(
        'Your Clay interview is with Marcus Webb on Thursday.',
        [
          {
            toolName: 'calendar.search_events',
            status: 'succeeded',
            args: { query: 'clay interview' },
            result: { complete: true, calendarsSearched: ['Assistant'], events: [] },
          },
          {
            toolName: 'gmail.search',
            status: 'succeeded',
            args: { query: 'clay interview' },
            result: {
              complete: true,
              mailboxSearched: 'assistant@example.com',
              results: [],
            },
          },
        ],
        { readRequest },
      );
      expect(result.blocked).toBe(false);
      expect(result.text).not.toContain('Marcus Webb');
      expect(result.text).toContain('no matching events');
      expect(result.text).toContain('no matching messages');
    });

    it('does not allow list-events output to masquerade as a free/busy check', () => {
      const result = enforceResponseContract(
        'You are free after 4:30 PM with no conflicts.',
        [
          {
            toolName: 'calendar.list_events',
            status: 'succeeded',
            args: {
              timeMin: '2026-08-17T00:00:00-07:00',
              timeMax: '2026-08-18T00:00:00-07:00',
            },
            result: {
              complete: true,
              calendarsSearched: ['Assistant'],
              events: [],
            },
          },
        ],
        {
          readRequest: {
            kind: 'calendar',
            queryTerms: [],
            firstToolName: 'calendar.list_events',
            requiresThreadRead: false,
          },
        },
      );
      expect(result.blocked).toBe(false);
      expect(result.text).not.toContain('free after');
    });

    it('renders availability only from the exact all-calendar free/busy result', () => {
      const readRequest = {
        kind: 'calendar' as const,
        queryTerms: [],
        firstToolName: 'calendar.availability' as const,
        requiresThreadRead: false,
        timeZone: 'America/Los_Angeles',
        timeWindow: {
          label: 'monday',
          timeMin: '2026-08-17T07:00:00.000Z',
          timeMax: '2026-08-18T07:00:00.000Z',
        },
      };
      const result = enforceResponseContract(
        'You are free all morning.',
        [
          {
            toolName: 'calendar.availability',
            status: 'succeeded',
            args: {
              timeMin: '2026-08-17T07:00:00.000Z',
              timeMax: '2026-08-18T07:00:00.000Z',
            },
            result: {
              complete: true,
              calendarsChecked: ['Assistant', 'Family'],
              busy: [
                {
                  calendar: 'Family',
                  start: '2026-08-17T16:30:00.000Z',
                  end: '2026-08-17T17:00:00.000Z',
                },
              ],
            },
          },
        ],
        { readRequest },
      );
      expect(result).toMatchObject({ blocked: false, unsupported: [] });
      expect(result.text).toContain('Busy (Family)');
      expect(result.text).toContain('9:30 AM to 10:00 AM');
      expect(result.text).toContain('Open according to the checked calendars');
      expect(result.text).not.toContain('free all morning');
    });

    it('reports partial availability instead of inferring that missing calendars are free', () => {
      const readRequest = {
        kind: 'calendar' as const,
        queryTerms: [],
        firstToolName: 'calendar.availability' as const,
        requiresThreadRead: false,
        timeWindow: {
          label: 'monday',
          timeMin: '2026-08-17T07:00:00.000Z',
          timeMax: '2026-08-18T07:00:00.000Z',
        },
      };
      const result = enforceResponseContract(
        'No conflicts.',
        [
          {
            toolName: 'calendar.availability',
            status: 'succeeded',
            args: {
              timeMin: '2026-08-17T07:00:00.000Z',
              timeMax: '2026-08-18T07:00:00.000Z',
            },
            result: {
              complete: false,
              calendarsChecked: ['Assistant'],
              unavailable: ['Work'],
              busy: [],
            },
          },
        ],
        { readRequest },
      );
      expect(result.text).toContain('returned no busy blocks');
      expect(result.text).toContain('coverage was incomplete; unavailable: Work');
      expect(result.text).not.toContain('Open according to the checked calendars');
      expect(result.text).not.toContain('No conflicts');
    });

    const availabilityRequest = (
      timeMin: string,
      timeMax: string,
      timeZone = 'America/Los_Angeles',
    ) => ({
      kind: 'calendar' as const,
      queryTerms: [],
      firstToolName: 'calendar.availability' as const,
      requiresThreadRead: false,
      timeZone,
      timeWindow: { label: 'tomorrow', timeMin, timeMax },
    });
    const availabilityEvidence = (
      request: ReturnType<typeof availabilityRequest>,
      patch: Record<string, unknown> = {},
    ): ActionEvidence => ({
      toolName: 'calendar.availability',
      status: 'succeeded',
      args: { timeMin: request.timeWindow.timeMin, timeMax: request.timeWindow.timeMax },
      result: { complete: true, calendarsChecked: ['Family', 'Work'], busy: [], ...patch },
    });

    it('answers a clear local day directly without UTC ranges or redundant midnight boundaries', () => {
      const readRequest = availabilityRequest(
        '2026-09-08T07:00:00.000Z',
        '2026-09-09T07:00:00.000Z',
      );
      const result = enforceResponseContract(
        'Tomorrow looks busy.',
        [availabilityEvidence(readRequest)],
        { readRequest },
      );
      expect(result).toMatchObject({ blocked: false, unsupported: [] });
      expect(result.text).toBe('Tomorrow is clear on the Family and Work calendars I checked.');
      expect(result.text).not.toMatch(/2026-09|00:00|12:00 AM|range checked/);
    });

    it.each([
      ['2026-09-07T15:00:00.000Z', '2026-09-08T15:00:00.000Z', 'Asia/Tokyo'],
      ['2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z', 'America/Los_Angeles'],
      ['2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z', 'America/Los_Angeles'],
    ])('recognizes the owner-local civil day across UTC dates and DST: %s', (start, end, zone) => {
      const readRequest = availabilityRequest(start, end, zone);
      const result = enforceResponseContract('Unknown.', [availabilityEvidence(readRequest)], {
        readRequest,
      });
      expect(result.text).toBe('Tomorrow is clear on the Family and Work calendars I checked.');
    });

    it.each([false, true])(
      'cannot promise a clear day with an unavailable calendar even when complete is %s',
      (complete) => {
        const readRequest = availabilityRequest(
          '2026-09-08T07:00:00.000Z',
          '2026-09-09T07:00:00.000Z',
        );
        const result = enforceResponseContract(
          'Tomorrow is completely free.',
          [
            availabilityEvidence(readRequest, {
              complete,
              calendarsChecked: ['Family'],
              unavailable: ['Work'],
            }),
          ],
          { readRequest },
        );
        expect(result.text.startsWith('I can’t confirm that tomorrow is clear yet.')).toBe(true);
        expect(result.text).toContain('Family calendar I checked returned no busy blocks');
        expect(result.text).toContain('coverage was incomplete; unavailable: Work');
        expect(result.text).not.toMatch(/Open according|Tomorrow is clear|completely free|2026-09/);
      },
    );

    it('keeps a partial time window explicit instead of calling the whole day clear', () => {
      const readRequest = availabilityRequest(
        '2026-09-08T16:00:00.000Z',
        '2026-09-08T18:00:00.000Z',
      );
      const result = enforceResponseContract(
        'Tomorrow is clear.',
        [availabilityEvidence(readRequest)],
        { readRequest },
      );
      expect(result.text).toContain(
        'The checked time range is clear on the Family and Work calendars I checked.',
      );
      expect(result.text).toContain('September 8 at 9:00 AM PDT');
      expect(result.text).toContain('September 8 at 11:00 AM PDT');
      expect(result.text).not.toContain('Tomorrow is clear');
      expect(result.text).not.toMatch(/2026-09-08T|\.000Z/);
    });

    it('names the actual checked subset and makes no complete claim when none were checked', () => {
      const readRequest = availabilityRequest(
        '2026-09-08T07:00:00.000Z',
        '2026-09-09T07:00:00.000Z',
      );
      const subset = enforceResponseContract(
        'All calendars are clear.',
        [availabilityEvidence(readRequest, { calendarsChecked: ['Work'] })],
        { readRequest },
      );
      expect(subset.text).toBe('Tomorrow is clear on the Work calendar I checked.');
      const empty = enforceResponseContract(
        'All calendars are clear.',
        [availabilityEvidence(readRequest, { calendarsChecked: [] })],
        { readRequest },
      );
      expect(empty.text).toContain('I can’t confirm');
      expect(empty.text).toContain('No calendars were listed as successfully checked');
      expect(empty.text).not.toContain('Tomorrow is clear');
    });

    it('keeps incomplete busy coverage honest without manufacturing free intervals', () => {
      const readRequest = availabilityRequest(
        '2026-09-08T07:00:00.000Z',
        '2026-09-09T07:00:00.000Z',
      );
      const result = enforceResponseContract(
        'You are free after ten.',
        [
          availabilityEvidence(readRequest, {
            complete: false,
            calendarsChecked: ['Family'],
            unavailable: ['Work'],
            busy: [
              {
                calendar: 'Family',
                start: '2026-09-08T16:30:00.000Z',
                end: '2026-09-08T17:00:00.000Z',
              },
            ],
          }),
        ],
        { readRequest },
      );
      expect(
        result.text.startsWith(
          'I found busy time tomorrow on the Family calendar I checked, but I can’t confirm your full availability.',
        ),
      ).toBe(true);
      expect(result.text).toContain('Busy (Family): 9:30 AM to 10:00 AM');
      expect(result.text).toContain('unavailable: Work');
      expect(result.text).not.toContain('Open according');
    });

    it('disambiguates repeated local clock times when availability crosses a daylight-saving change', () => {
      const readRequest = availabilityRequest(
        '2026-11-01T07:00:00.000Z',
        '2026-11-02T08:00:00.000Z',
      );
      const result = enforceResponseContract(
        'You are free.',
        [
          availabilityEvidence(readRequest, {
            busy: [
              {
                calendar: 'Work',
                start: '2026-11-01T08:30:00.000Z',
                end: '2026-11-01T09:30:00.000Z',
              },
            ],
          }),
        ],
        { readRequest },
      );
      expect(result.text).toContain('Busy (Work): 1:30 AM PDT to 1:30 AM PST');
      expect(result.text).not.toContain('1:30 AM to 1:30 AM');
    });

    it('does not accept a different date window or prior-task read as proof of a clear day', () => {
      const readRequest = availabilityRequest(
        '2026-09-08T07:00:00.000Z',
        '2026-09-09T07:00:00.000Z',
      );
      for (const evidence of [
        {
          ...availabilityEvidence(readRequest),
          args: { timeMin: '2026-09-07T07:00:00.000Z', timeMax: '2026-09-08T07:00:00.000Z' },
        },
        { ...availabilityEvidence(readRequest), fromCurrentTask: false },
      ]) {
        const result = enforceResponseContract('Tomorrow is clear.', [evidence], { readRequest });
        expect(result.blocked).toBe(true);
        expect(result.text).not.toContain('Tomorrow is clear');
      }
    });

    it('does not promote a window starting after midnight into a clear whole day', () => {
      const readRequest = availabilityRequest(
        '2026-09-08T07:00:01.000Z',
        '2026-09-09T07:00:00.000Z',
      );
      const result = enforceResponseContract(
        'Tomorrow is clear.',
        [availabilityEvidence(readRequest)],
        { readRequest },
      );
      expect(result.text).toContain('The checked time range is clear');
      expect(result.text).not.toContain('Tomorrow is clear');
    });

    it('intersects returned busy blocks with the checked day and labels full-day occupancy correctly', () => {
      const readRequest = availabilityRequest(
        '2026-09-08T07:00:00.000Z',
        '2026-09-09T07:00:00.000Z',
      );
      const outside = enforceResponseContract(
        'Tomorrow is busy.',
        [
          availabilityEvidence(readRequest, {
            busy: [
              {
                calendar: 'Family',
                start: '2026-09-09T08:00:00.000Z',
                end: '2026-09-09T09:00:00.000Z',
              },
            ],
          }),
        ],
        { readRequest },
      );
      expect(outside.text).toBe('Tomorrow is clear on the Family and Work calendars I checked.');
      const allDay = enforceResponseContract(
        'Tomorrow is clear.',
        [
          availabilityEvidence(readRequest, {
            busy: [
              {
                calendar: 'Family',
                start: '2026-09-07T07:00:00.000Z',
                end: '2026-09-10T07:00:00.000Z',
              },
            ],
          }),
        ],
        { readRequest },
      );
      expect(allDay.text).toContain('Busy (Family): all day');
      expect(allDay.text).not.toMatch(/12:00 AM|Open according|2026-09/);
    });
  });
});

describe('enforceUrlProvenance', () => {
  it.each([
    ['https://example.com/DocAbC', 'https://example.com/docabc'],
    ['https://example.com/report/42', 'https://example.com/report/4'],
    ['https://example.com/report', 'https://example.com:8443/report'],
    ['https://example.com/report?id=42', 'https://example.com/report?id=43'],
    ['https://example.com/report#part-a', 'https://example.com/report#part-b'],
    [
      'https://docs.google.com/document/d/DocAbC/edit',
      'https://docs.google.com/document/d/docabc/edit',
    ],
  ])('does not let source %s license distinct resource %s', (source, candidate) => {
    expect(enforceUrlProvenance(`[Report](${candidate})`, source).strippedUrls).toEqual([
      candidate,
    ]);
  });
  it('binds a constructed short Google ID exactly', () => {
    expect(
      enforceUrlProvenance('https://docs.google.com/document/d/AbC/edit', '{"documentId":"AbC"}')
        .strippedUrls,
    ).toEqual([]);
    expect(
      enforceUrlProvenance('https://docs.google.com/document/d/Ab/edit', '{"documentId":"AbC"}')
        .strippedUrls,
    ).toHaveLength(1);
  });
  it('strips a fabricated bare URL and appends one note', () => {
    const { text, strippedUrls } = enforceUrlProvenance(
      'All set — confirmation here: https://acme.example/booking/9f3a',
      'the corpus mentions nothing relevant',
    );
    expect(strippedUrls).toEqual(['https://acme.example/booking/9f3a']);
    expect(text).not.toContain('acme.example');
    expect(text).toContain("couldn't trace");
  });

  it('keeps a URL that appears in the corpus (and its query-stripped form)', () => {
    const corpus = 'web.fetch finalUrl https://news.example/article/42';
    const kept = enforceUrlProvenance(
      'See https://news.example/article/42?utm=x for details.',
      corpus,
    );
    expect(kept.strippedUrls).toEqual([]);
    expect(kept.text).toContain('https://news.example/article/42?utm=x');
  });

  it('preserves the label of a stripped markdown link', () => {
    const { text, strippedUrls } = enforceUrlProvenance(
      'Read the [full report](https://fake.example/r/xyz) now.',
      'no evidence here',
    );
    expect(strippedUrls).toHaveLength(1);
    expect(text).toContain('full report');
    expect(text).not.toContain('fake.example');
  });

  it('allows a Google Doc link only when its id is in the corpus', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    const evidenced = enforceUrlProvenance(
      `Doc: https://docs.google.com/document/d/${id}/edit`,
      `docs.create returned {"documentId":"${id}"}`,
    );
    expect(evidenced.strippedUrls).toEqual([]);

    const fabricated = enforceUrlProvenance(
      'Doc: https://docs.google.com/document/d/9zzzzzzzzzzzzzzzzzzzzzzzzz999999/edit',
      'no such id anywhere',
    );
    expect(fabricated.strippedUrls).toHaveLength(1);
  });

  it('allows a composed Google Maps link', () => {
    const { strippedUrls } = enforceUrlProvenance(
      'Directions: https://www.google.com/maps/search/?api=1&query=1600+Amphitheatre+Pkwy',
      'the owner asked for directions to 1600 Amphitheatre Pkwy',
    );
    expect(strippedUrls).toEqual([]);
  });

  it('emits a single note for multiple strips', () => {
    const { text } = enforceUrlProvenance('A https://a.example/x and B https://b.example/y', '');
    expect(text.match(/couldn't trace/g)).toHaveLength(1);
  });

  it('is skipped by enforceResponseContract when no corpus is provided', () => {
    const result = enforceResponseContract('Link: https://fabricated.example/z', []);
    expect(result.text).toContain('https://fabricated.example/z');
  });

  it('runs inside enforceResponseContract on an otherwise-clean answer with a corpus', () => {
    const result = enforceResponseContract('Here you go: https://fabricated.example/z', [], {
      urlCorpus: 'nothing matching',
    });
    expect(result.blocked).toBe(false);
    expect(result.text).not.toContain('fabricated.example');
  });
});

describe('a grounded lookup answer still meets every other rule', () => {
  const readRequest = {
    kind: 'calendar' as const,
    queryTerms: [],
    firstToolName: 'calendar.list_events' as const,
    requiresThreadRead: false,
    timeZone: 'America/Los_Angeles',
    timeWindow: {
      label: 'today',
      timeMin: '2026-08-23T07:00:00.000Z',
      timeMax: '2026-08-24T07:00:00.000Z',
    },
  };
  const evidence = [
    {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      args: { timeMin: '2026-08-23T07:00:00.000Z', timeMax: '2026-08-24T07:00:00.000Z' },
      result: {
        complete: true,
        calendarsSearched: ['Family'],
        events: [
          {
            eventId: 'e1',
            calendar: 'Family',
            summary: 'Dentist',
            location: 'Laugavegur 12',
            start: '2026-08-23T13:00:00-07:00',
            end: '2026-08-23T14:00:00-07:00',
          },
        ],
      },
    },
  ];

  it('blocks a send the agenda tacked on, however true the agenda is', () => {
    const result = enforceResponseContract(
      'One thing today:\n- **13:00–14:00** — Dentist — Laugavegur 12\n\nI emailed them to confirm.',
      evidence,
      { readRequest },
    );
    expect(result.blocked).toBe(true);
    expect(result.unsupported).toContain('outbound');
  });

  it('keeps the answer and strips a link it cannot trace', () => {
    const result = enforceResponseContract(
      'One thing today:\n- **13:00–14:00** — [Dentist](https://fabricated.example/x) — Laugavegur 12',
      evidence,
      { readRequest, urlCorpus: JSON.stringify(evidence) },
    );
    expect(result.blocked).toBe(false);
    expect(result.text).toContain('Dentist');
    expect(result.text).not.toContain('fabricated.example');
  });
});

describe('groundReadDraft', () => {
  const dayRequest = {
    kind: 'calendar' as const,
    queryTerms: [],
    firstToolName: 'calendar.list_events' as const,
    requiresThreadRead: false,
    timeZone: 'America/Los_Angeles',
    timeWindow: {
      label: 'today',
      timeMin: '2026-08-23T07:00:00.000Z',
      timeMax: '2026-08-24T07:00:00.000Z',
    },
  };

  const event = (over: Record<string, unknown>) => ({
    eventId: 'e1',
    calendarId: 'fam',
    calendar: 'Family',
    summary: 'Stagecoach Greens with Eva & Jordan’s Family',
    location: 'Stagecoach Greens, 1379 4th St, San Francisco, CA 94158, USA',
    organizer: 'family09996249469363640469@group.calendar.google.com',
    start: '2026-08-23T11:15:00-07:00',
    end: '2026-08-23T13:00:00-07:00',
    ...over,
  });

  const dayEvidence = (events: Record<string, unknown>[], result: Record<string, unknown> = {}) => [
    {
      toolName: 'calendar.list_events',
      status: 'succeeded',
      args: {
        timeMin: '2026-08-23T07:00:00.000Z',
        timeMax: '2026-08-24T07:00:00.000Z',
      },
      result: { complete: true, calendarsSearched: ['Family'], events, ...result },
    },
  ];

  it('accepts an agenda that reformats the ledger’s times into the owner’s clock', () => {
    const result = groundReadDraft(
      'One thing today:\n- **11:15–13:00** — Stagecoach Greens with Eva & Jordan’s Family',
      dayRequest,
      dayEvidence([event({})]),
    );
    expect(result).toEqual({ grounded: true, reasons: [] });
  });

  it('accepts the same times written as 12-hour wall clock', () => {
    const result = groundReadDraft(
      'One thing today:\n- **11:15 AM – 1:00 PM** — Stagecoach Greens with Eva & Jordan',
      dayRequest,
      dayEvidence([event({})]),
    );
    expect(result.grounded).toBe(true);
  });

  it('rejects an event that no read returned', () => {
    const result = groundReadDraft(
      [
        'Two things today:',
        '- **11:15–13:00** — Stagecoach Greens with Eva & Jordan',
        '- **19:00–21:00** — Dinner at Zuni Cafe',
      ].join('\n'),
      dayRequest,
      dayEvidence([event({})]),
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/Zuni Cafe/);
  });

  it('licenses the live half of a mixed answer only from what the lookup returned', () => {
    const draft = [
      'One thing today:',
      '- **11:15–13:00** — Stagecoach Greens with Eva & Jordan',
      '',
      'The Giants beat the Dodgers 5-2 at Oracle Park; tonight’s first pitch is 7:05 PM.',
    ].join('\n');
    const live = JSON.stringify({
      games: [
        {
          line: 'Los Angeles Dodgers at San Francisco Giants: 2-5, Final',
          venue: 'Oracle Park',
          startsAt: '2026-08-24T02:05:00Z',
        },
      ],
    });
    // Without the lookup's own text, "Dodgers" and 7:05 PM read as inventions.
    expect(groundReadDraft(draft, dayRequest, dayEvidence([event({})])).grounded).toBe(false);
    expect(groundReadDraft(draft, dayRequest, dayEvidence([event({})]), '', live)).toEqual({
      grounded: true,
      reasons: [],
    });
    // The calendar half is still held to the calendar.
    const invented = `${draft}\n- **19:00–21:00** — Dinner at Zuni Cafe`;
    const checked = groundReadDraft(invented, dayRequest, dayEvidence([event({})]), '', live);
    expect(checked.grounded).toBe(false);
    expect(checked.reasons.join(' ')).toMatch(/Zuni Cafe/);
  });

  it('rejects a time the ledger never carried', () => {
    const result = groundReadDraft(
      'One thing today:\n- **11:45–13:00** — Stagecoach Greens with Eva & Jordan',
      dayRequest,
      dayEvidence([event({})]),
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/11:45/);
  });

  it('rejects an answer that silently drops a returned event', () => {
    const result = groundReadDraft(
      'One thing today:\n- **11:15–13:00** — Stagecoach Greens with Eva & Jordan',
      dayRequest,
      dayEvidence([
        event({}),
        event({
          eventId: 'e2',
          summary: 'Bay FC vs. Houston Dash',
          location: 'PayPal Park',
          start: '2026-08-23T14:00:00-07:00',
          end: '2026-08-23T17:00:00-07:00',
        }),
      ]),
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/Bay FC.*missing from the answer/);
  });

  it('accepts a shortened title — trimming is writing, not dropping', () => {
    const result = groundReadDraft(
      'Just the golf outing today, **11:15–13:00** at Stagecoach Greens.',
      dayRequest,
      dayEvidence([event({})]),
    );
    expect(result.grounded).toBe(true);
  });

  it('rejects an empty day claimed over a non-empty ledger', () => {
    const result = groundReadDraft(
      'Nothing on today — your calendar is clear.',
      dayRequest,
      dayEvidence([event({})]),
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/empty day/);
  });

  it('rejects a count larger than the ledger holds', () => {
    const result = groundReadDraft(
      'Three things today:\n- **11:15–13:00** — Stagecoach Greens with Eva & Jordan',
      dayRequest,
      dayEvidence([event({})]),
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/claims 3 items from 1/);
  });

  it('falls back when a calendar did not answer, however good the draft is', () => {
    const result = groundReadDraft(
      'One thing today:\n- **11:15–13:00** — Stagecoach Greens with Eva & Jordan',
      dayRequest,
      dayEvidence([event({})], { complete: false }),
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/incomplete or failed/);
  });

  it('falls back when a read in this turn failed outright', () => {
    const result = groundReadDraft(
      'One thing today:\n- **11:15–13:00** — Stagecoach Greens with Eva & Jordan',
      dayRequest,
      [
        ...dayEvidence([event({})]),
        { toolName: 'gmail.search', status: 'failed', args: {}, result: {}, error: 'quota' },
      ],
    );
    expect(result.grounded).toBe(false);
  });

  it('hands a verification challenge back to the ledger', () => {
    const result = groundReadDraft(
      'One thing today:\n- **11:15–13:00** — Stagecoach Greens with Eva & Jordan',
      { ...dayRequest, verification: true },
      dayEvidence([event({})]),
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons).toContain('verification request');
  });

  it('exempts availability phrasing from the event-boundary check', () => {
    const result = groundReadDraft(
      'One thing today, and you are clear from 16:00:\n- **11:15–13:00** — Stagecoach Greens with Eva & Jordan',
      dayRequest,
      dayEvidence([event({})]),
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/free-time boundary/);
  });

  it('keeps each calendar time and venue bound to the event that supplied it', () => {
    const dentist = event({
      eventId: 'dentist',
      summary: 'Dentist appointment',
      location: 'North Clinic',
      start: '2026-08-23T09:00:00-07:00',
      end: '2026-08-23T10:00:00-07:00',
    });
    const interview = event({
      eventId: 'interview',
      summary: 'Interview with Morgan',
      location: 'South Office',
      start: '2026-08-23T15:00:00-07:00',
      end: '2026-08-23T16:00:00-07:00',
    });
    const swapped = groundReadDraft(
      'Dentist appointment at South Office, 15:00–16:00. Interview with Morgan at North Clinic, 09:00–10:00.',
      dayRequest,
      dayEvidence([dentist, interview]),
    );
    expect(swapped.grounded).toBe(false);
    expect(swapped.reasons.join(' ')).toMatch(/matching calendar event|same calendar event/);
  });

  it('binds weekdays and civil dates to the named event, even when clocks repeat', () => {
    const tuesdayDentist = event({
      eventId: 'tuesday',
      summary: 'Dentist appointment',
      start: '2026-08-25T09:00:00-07:00',
      end: '2026-08-25T10:00:00-07:00',
    });
    const wednesdayInterview = event({
      eventId: 'wednesday',
      summary: 'Interview with Morgan',
      start: '2026-08-26T09:00:00-07:00',
      end: '2026-08-26T10:00:00-07:00',
    });
    const request = {
      ...dayRequest,
      timeWindow: {
        label: 'the week',
        timeMin: '2026-08-24T07:00:00.000Z',
        timeMax: '2026-08-31T07:00:00.000Z',
      },
    };
    const result = groundReadDraft(
      'Dentist appointment on Wednesday, August 26 at 09:00. Interview with Morgan on Tuesday, August 25 at 09:00.',
      request,
      [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          args: { timeMin: request.timeWindow.timeMin, timeMax: request.timeWindow.timeMax },
          result: {
            complete: true,
            calendarsSearched: ['Family'],
            events: [tuesdayDentist, wednesdayInterview],
          },
        },
      ],
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/date does not belong/);
  });

  it('does not turn a complete named search into proof of free time', () => {
    const request = {
      ...dayRequest,
      firstToolName: 'calendar.search_events' as const,
      queryTerms: ['dentist'],
    };
    const result = groundReadDraft(
      'You are free after 10:00; Dentist appointment at 09:00.',
      request,
      [
        {
          toolName: 'calendar.search_events',
          status: 'succeeded',
          args: {
            query: 'dentist',
            timeMin: request.timeWindow?.timeMin,
            timeMax: request.timeWindow?.timeMax,
          },
          result: {
            complete: true,
            calendarsSearched: ['Family'],
            events: [
              event({
                summary: 'Dentist appointment',
                start: '2026-08-23T09:00:00-07:00',
                end: '2026-08-23T10:00:00-07:00',
              }),
            ],
          },
        },
      ],
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/free-time boundary/);
  });

  it('does not let an earlier availability phrase exempt a later event time', () => {
    const result = groundReadDraft(
      'You are clear from 16:00. Dentist appointment at 12:00–13:00.',
      dayRequest,
      dayEvidence([
        event({
          summary: 'Dentist appointment',
          start: '2026-08-23T09:00:00-07:00',
          end: '2026-08-23T10:00:00-07:00',
        }),
      ]),
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/clock time does not belong/);
  });

  it('binds a scoreboard result to the team ordering and scores', () => {
    const scoreEvidence = [
      ...dayEvidence([event({})]),
      {
        toolName: 'sports.scores',
        status: 'succeeded',
        result: { games: [{ line: 'Los Angeles Dodgers at San Francisco Giants: 2-5, Final' }] },
      },
    ];
    const wrongWinner = groundReadDraft(
      'One thing today: 11:15–13:00 — Stagecoach Greens. The Dodgers beat the Giants 5-2.',
      dayRequest,
      scoreEvidence,
      '',
      JSON.stringify({
        games: [{ line: 'Los Angeles Dodgers at San Francisco Giants: 2-5, Final' }],
      }),
    );
    expect(wrongWinner.grounded).toBe(false);
    expect(wrongWinner.reasons.join(' ')).toMatch(/score and the teams/);
  });

  it('binds temperature sign, unit, current/high qualifier, and place to one reading', () => {
    const weather = {
      toolName: 'weather.lookup',
      status: 'succeeded',
      result: {
        location: 'Potrero Hill',
        current: { temperature: 19, unit: 'C' },
        high: { temperature: 26, unit: 'C' },
      },
    };
    const result = groundReadDraft(
      'One thing today: 11:15–13:00 — Stagecoach Greens. The high in Potrero Hill is -19°F.',
      dayRequest,
      [...dayEvidence([event({})]), weather],
      '',
      JSON.stringify(weather.result),
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/temperature value, unit, qualifier, or place/);
  });

  it('does not relabel the reported daily high as the current temperature', () => {
    const weather = {
      toolName: 'weather.lookup',
      status: 'succeeded',
      result: {
        location: 'Potrero Hill',
        current: { temperature: 19, unit: 'C' },
        high: { temperature: 26, unit: 'C' },
      },
    };
    const result = groundReadDraft(
      'One thing today: 11:15–13:00 — Stagecoach Greens. The current temperature in Potrero Hill is 26°C.',
      dayRequest,
      [...dayEvidence([event({})]), weather],
      '',
      JSON.stringify(weather.result),
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/temperature value, unit, qualifier, or place/);
  });

  it('does not borrow a temperature from a different location', () => {
    const weather = {
      toolName: 'weather.lookup',
      status: 'succeeded',
      result: { location: 'Potrero Hill', current: { temperature: 19, unit: 'C' } },
    };
    const result = groundReadDraft(
      'One thing today: 11:15–13:00 — Stagecoach Greens. It is 19°C in Mission District.',
      dayRequest,
      [...dayEvidence([event({})]), weather],
      '',
      JSON.stringify(weather.result),
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/temperature value, unit, qualifier, or place/);
  });

  it('binds the shipped weather result shape to current and forecast readings', () => {
    const result = {
      place: 'San Francisco',
      usedCurrentLocation: false,
      current: { tempC: 18, highC: 21, lowC: 13, description: 'clear' },
      forecast: [{ date: '2026-10-08', weekday: 'Thu', lowC: 12, highC: 20 }],
    };
    const evidence: ActionEvidence[] = [
      { toolName: 'weather.lookup', status: 'succeeded', result },
    ];
    const current = enforceResponseContract('It is 18°C in San Francisco right now.', evidence, {
      liveCorpus: JSON.stringify(result),
    });
    expect(current.blocked).toBe(false);
    expect(current.groundingFallback).toBeUndefined();

    const forecast = enforceResponseContract(
      'Thursday’s high in San Francisco will be 20°C.',
      evidence,
      { liveCorpus: JSON.stringify(result) },
    );
    expect(forecast.blocked).toBe(false);
    expect(forecast.groundingFallback).toBeUndefined();

    const wrong = enforceResponseContract(
      'The current temperature in San Francisco is 20°C.',
      evidence,
      { liveCorpus: JSON.stringify(result) },
    );
    expect(wrong.blocked).toBe(false);
    expect(wrong.groundingFallback).toEqual(
      expect.arrayContaining([expect.stringMatching(/temperature/)]),
    );
    expect(wrong.text).not.toContain('current temperature in San Francisco is 20°C');
  });

  it('binds weather claims to front-loaded and lowercase place names and local metrics', () => {
    const result = {
      place: 'London',
      current: { tempC: 20, highC: 27, lowC: 12 },
      forecast: [],
    };
    const evidence: ActionEvidence[] = [
      { toolName: 'weather.lookup', status: 'succeeded', result },
    ];
    const corpus = JSON.stringify(result);

    for (const wrongPlace of ['Paris is currently 20°C.', 'It is currently 20°C in paris.']) {
      const checked = enforceResponseContract(wrongPlace, evidence, { liveCorpus: corpus });
      expect(checked.groundingFallback, wrongPlace).toEqual(
        expect.arrayContaining([expect.stringMatching(/temperature/)]),
      );
      expect(checked.text).not.toContain(wrongPlace);
    }

    for (const correct of [
      'It is currently 20°C in london.',
      'London is currently 20°C, with a high of 27°C.',
    ]) {
      const checked = enforceResponseContract(correct, evidence, { liveCorpus: corpus });
      expect(checked.blocked, correct).toBe(false);
      expect(checked.groundingFallback, correct).toBeUndefined();
    }
  });

  it('does not skip a temperature claim when a live weather result has no recognized reading', () => {
    const result = {
      place: 'San Francisco',
      current: { description: 'clear', humidity: 50 },
      forecast: [],
    };
    const checked = enforceResponseContract(
      'It is 30°C in San Francisco.',
      [{ toolName: 'weather.lookup', status: 'succeeded', result }],
      { liveCorpus: JSON.stringify(result) },
    );
    expect(checked.blocked).toBe(false);
    expect(checked.groundingFallback).toEqual(
      expect.arrayContaining([expect.stringMatching(/temperature/)]),
    );
    expect(checked.text).not.toContain('It is 30°C');
  });

  it('keeps target-hour, day, place, and temperature metric attached to one weather reading', () => {
    const result = {
      place: 'San Francisco',
      current: { tempC: 18, highC: 21, lowC: 13 },
      target: {
        date: '2026-10-08',
        weekday: 'Thu',
        timezone: 'America/Los_Angeles',
        windows: [
          {
            date: '2026-10-08',
            weekday: 'Thu',
            window: '14:00–17:00',
            label: 'afternoon',
            lowC: 17,
            highC: 20,
          },
        ],
        hours: [
          {
            time: '2026-10-08T15:00',
            date: '2026-10-08',
            hour: 15,
            tempC: 19,
            feelsLikeC: 18,
          },
        ],
      },
    };
    const evidence: ActionEvidence[] = [
      {
        toolName: 'weather.lookup',
        status: 'succeeded',
        args: { date: '2026-10-08' },
        result,
      },
    ];
    const corpus = JSON.stringify(result);
    expect(
      enforceResponseContract('Thursday at 3pm, it will be 19°C in San Francisco.', evidence, {
        liveCorpus: corpus,
      }).groundingFallback,
    ).toBeUndefined();
    for (const draft of [
      'Thursday at 4pm, it will be 19°C in San Francisco.',
      'Wednesday at 3pm, it will be 19°C in San Francisco.',
      'Thursday at 3pm, it will be 19°C in Oakland.',
      'Thursday at 3pm, it will feel like 19°C in San Francisco.',
      'The current temperature in San Francisco is 19°C.',
    ]) {
      const checked = enforceResponseContract(draft, evidence, { liveCorpus: corpus });
      expect(checked.groundingFallback, draft).toEqual(
        expect.arrayContaining([expect.stringMatching(/temperature/)]),
      );
    }
  });

  it('checks a pure sports lookup and accepts an away-team win in team order', () => {
    const result = {
      games: [{ line: 'Los Angeles Dodgers at San Francisco Giants: 2-5, Final' }],
    };
    const evidence: ActionEvidence[] = [{ toolName: 'sports.scores', status: 'succeeded', result }];
    const awayWon = {
      games: [{ line: 'Los Angeles Dodgers at San Francisco Giants: 7-5, Final' }],
    };
    const awayEvidence: ActionEvidence[] = [
      { toolName: 'sports.scores', status: 'succeeded', result: awayWon },
    ];
    const correct = enforceResponseContract(
      'The Los Angeles Dodgers beat the San Francisco Giants 7-5.',
      awayEvidence,
      { liveCorpus: JSON.stringify(awayWon) },
    );
    expect(correct.blocked).toBe(false);
    expect(correct.groundingFallback).toBeUndefined();
    const semanticallyWrong = enforceResponseContract(
      'The Los Angeles Dodgers lost to the San Francisco Giants 7-5.',
      awayEvidence,
      { liveCorpus: JSON.stringify(awayWon) },
    );
    expect(semanticallyWrong.groundingFallback).toEqual(
      expect.arrayContaining([expect.stringMatching(/score/)]),
    );
    const wrong = enforceResponseContract(
      'The San Francisco Giants beat the Los Angeles Dodgers 2-5.',
      evidence,
      { liveCorpus: JSON.stringify(result) },
    );
    expect(wrong.groundingFallback).toEqual(
      expect.arrayContaining([expect.stringMatching(/score/)]),
    );
    expect(wrong.text).not.toContain('Giants beat');
  });

  it('uses returned send recipients, handles email-address and direct-name claims, and deduplicates message identity', () => {
    const sent: ActionEvidence = {
      toolName: 'gmail.send',
      status: 'succeeded',
      args: { to: ['alice@example.com'], subject: 'Update', body: 'Done' },
      result: { messageId: 'gmail-1', to: ['bob@example.com'], deliveryStatus: 'accepted' },
    };
    expect(enforceResponseContract('I emailed Bob.', [sent])).toMatchObject({ blocked: false });
    expect(enforceResponseContract('I sent an email to bob@example.com.', [sent])).toMatchObject({
      blocked: false,
    });
    expect(enforceResponseContract('I emailed Alice.', [sent]).unsupported).toContain('outbound');

    const expiredDetails: ActionEvidence = {
      ...sent,
      result: { recorded: true, effectOutcome: 'completed', requestedArgumentsVerified: false },
    };
    expect(enforceResponseContract('I emailed Alice.', [expiredDetails]).unsupported).toContain(
      'outbound',
    );

    const twiceProjected = enforceResponseContract('I sent two emails.', [sent, sent]);
    expect(twiceProjected.unsupported).toContain('outbound');
  });

  it.each(['rejected', 'unknown'] as const)(
    'does not count a %s communication receipt as an accepted send',
    (state) => {
      const result = enforceResponseContract('I sent one email to bob@example.test.', [
        {
          toolName: 'gmail.send',
          status: 'succeeded',
          args: { to: ['bob@example.test'], subject: 'Hello', body: 'Hello.' },
          result: {
            messageId: `message-${state}`,
            to: ['bob@example.test'],
            deliveryStatus: state,
            communicationReceipt: {
              version: 1,
              channel: 'email',
              provider: 'gmail',
              providerMessageId: `message-${state}`,
              state,
              recipients: ['bob@example.test'],
              contentDigest: '0'.repeat(64),
            },
          },
        },
      ]);
      expect(result.unsupported).toContain('outbound');
      expect(result.blocked).toBe(true);
    },
  );

  it('bounds recursive structured fact extraction on deep and cyclic provider-shaped data', () => {
    const result: Record<string, unknown> = {
      place: 'San Francisco',
      current: { tempC: 18 },
    };
    result.self = result;
    let nested: Record<string, unknown> = {};
    result.deep = nested;
    for (let index = 0; index < 200; index += 1) {
      const child: Record<string, unknown> = {};
      nested.next = child;
      nested = child;
    }
    nested.tempC = 999;
    const facts = evidenceClaimFacts([{ toolName: 'weather.lookup', status: 'succeeded', result }]);
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'temperature', value: 18, place: 'San Francisco' }),
      ]),
    );
    expect(facts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'temperature', value: 999 })]),
    );
  });

  it('licenses words the owner’s own context supplied', () => {
    const draft =
      'One thing today:\n- **11:15–13:00** — Stagecoach Greens with Eva & Jordan\n\nIt is 19°C in Potrero Hill, so no jacket needed.';
    expect(groundReadDraft(draft, dayRequest, dayEvidence([event({})])).grounded).toBe(false);
    expect(
      groundReadDraft(
        draft,
        dayRequest,
        dayEvidence([event({})]),
        "Owner's current location: near Potrero Hill (37.7587, -122.4001).",
      ).grounded,
    ).toBe(true);
  });

  const mailRequest = {
    kind: 'email' as const,
    queryTerms: [],
    firstToolName: 'gmail.search' as const,
    requiresThreadRead: false,
    mailQuery: 'newer_than:7d',
  };
  const mailEvidence = [
    {
      toolName: 'gmail.search',
      status: 'succeeded',
      args: { query: 'newer_than:7d' },
      result: {
        complete: true,
        mailboxSearched: 'assistant@example.com',
        results: [
          { messageId: 'm1', threadId: 't1', from: 'Alice Berg', subject: 'Q3 invoice' },
          { messageId: 'm2', threadId: 't2', from: 'Delta', subject: 'Booking confirmed' },
          { messageId: 'm3', threadId: 't3', from: 'Substack', subject: 'Your weekly digest' },
        ],
      },
    },
  ];

  const flightRequest = {
    kind: 'calendar_email' as const,
    queryTerms: ['berlin'],
    firstToolName: 'calendar.search_events' as const,
    requiresThreadRead: true,
    answerFocus: 'flight' as const,
    timeZone: 'America/Los_Angeles',
    mailQuery: 'berlin',
    timeWindow: {
      label: 'tomorrow',
      timeMin: '2026-10-09T07:00:00.000Z',
      timeMax: '2026-10-10T07:00:00.000Z',
    },
  };

  function flightEvidence(
    messages: Array<{ threadId: string; messageId: string; subject: string; text: string }>,
    calendarEvents: Record<string, unknown>[] = [],
  ) {
    const threadIds = [...new Set(messages.map((message) => message.threadId))];
    return [
      {
        toolName: 'calendar.search_events',
        status: 'succeeded',
        args: {
          query: 'berlin',
          timeMin: flightRequest.timeWindow.timeMin,
          timeMax: flightRequest.timeWindow.timeMax,
        },
        result: { complete: true, calendarsSearched: ['Personal'], events: calendarEvents },
      },
      {
        toolName: 'gmail.search',
        status: 'succeeded',
        args: { query: flightRequest.mailQuery },
        result: {
          complete: true,
          mailboxSearched: 'owner@example.com',
          results: threadIds.map((threadId) => ({
            threadId,
            messageId: messages.find((message) => message.threadId === threadId)?.messageId,
            subject: messages.find((message) => message.threadId === threadId)?.subject,
          })),
        },
      },
      ...threadIds.map((threadId) => ({
        toolName: 'gmail.read_thread',
        status: 'succeeded',
        args: { threadId },
        result: {
          complete: true,
          messages: messages.filter((message) => message.threadId === threadId),
        },
      })),
    ] satisfies ActionEvidence[];
  }

  it('binds the departure clock to the requested date and matching Berlin source', () => {
    const evidence = flightEvidence([
      {
        threadId: 'current-confirmation',
        messageId: 'current-message',
        subject: 'Berlin flight confirmation',
        text: 'Berlin itinerary for October 9, 2026. Boarding is at 09:15 AM; departure is at 1:45 PM.',
      },
      {
        threadId: 'older-itinerary',
        messageId: 'older-message',
        subject: 'Previous Berlin itinerary',
        text: 'Berlin flight itinerary for October 3, 2026. Departure is at 09:15 AM.',
      },
    ]);

    expect(
      groundReadDraft('Your Berlin flight departs at 1:45 PM.', flightRequest, evidence),
    ).toEqual({
      grounded: true,
      reasons: [],
    });
    expect(
      groundReadDraft('Your flight departs at 1:45 PM.', flightRequest, evidence).grounded,
    ).toBe(true);
    expect(
      groundReadDraft('Your Berlin flight departs at 9:15 AM.', flightRequest, evidence).grounded,
    ).toBe(false);
    expect(verifiedReadResponse(flightRequest, evidence)).toContain('departure at 1:45 PM');
  });

  it('binds a multiline booking confirmation departure, not arrival or onward-leg times', () => {
    const evidence = flightEvidence([
      {
        threadId: 'berlin-confirmation',
        messageId: 'berlin-message',
        subject: 'Berlin itinerary details',
        text: [
          'Berlin itinerary',
          'KLM KL606',
          'DEPARTURE',
          'Oct 9, 2026 at 1:45 pm',
          'San Francisco SFO',
          'ARRIVAL +1',
          'Oct 10, 2026 at 9:05 am',
          'Amsterdam AMS',
          'KLM KL1777',
          'DEPARTURE',
          'Oct 10, 2026 at 12:15 pm',
          'Amsterdam AMS',
        ].join('\n'),
      },
    ]);

    expect(
      groundReadDraft('Your Berlin flight departs at 1:45 PM.', flightRequest, evidence),
    ).toEqual({
      grounded: true,
      reasons: [],
    });
    expect(
      groundReadDraft('Your Berlin flight departs at 9:05 AM.', flightRequest, evidence).grounded,
    ).toBe(false);
    expect(
      groundReadDraft('Your Berlin flight departs at 12:15 PM.', flightRequest, evidence).grounded,
    ).toBe(false);
    expect(verifiedReadResponse(flightRequest, evidence)).toContain('departure at 1:45 PM');
  });

  it('does not borrow a same-clock carrier from a stale calendar event', () => {
    const itinerary = [
      'Berlin itinerary',
      'KLM KL606',
      'DEPARTURE',
      'Oct 9, 2026 at 1:45 pm',
      'San Francisco SFO',
      'ARRIVAL +1',
      'Oct 10, 2026 at 9:05 am',
      'Amsterdam AMS',
      'KLM KL1777',
      'DEPARTURE',
      'Oct 10, 2026 at 12:15 pm',
      'Amsterdam AMS',
      'ARRIVAL',
      'Oct 10, 2026 at 4:30 pm',
      'Berlin BER',
    ].join('\n');
    const sameClockCalendar = flightEvidence(
      [
        {
          threadId: 'berlin-confirmation',
          messageId: 'berlin-message',
          subject: 'Berlin itinerary details',
          text: itinerary,
        },
      ],
      [
        {
          eventId: 'calendar-flight',
          calendarId: 'Personal',
          summary: 'United flight from SFO to BER',
          start: '2026-10-09T13:45:00-07:00',
          end: '2026-10-10T09:05:00+02:00',
        },
      ],
    );

    expect(
      groundReadDraft(
        'Your United flight from SFO to BER departs at 1:45 PM.',
        flightRequest,
        sameClockCalendar,
      ).grounded,
    ).toBe(false);
    const fallback = verifiedReadResponse(flightRequest, sameClockCalendar);
    expect(fallback).toContain('departure at 1:45 PM');
    expect(fallback).not.toContain('United');
    expect(fallback).not.toContain('SFO');
    expect(fallback).not.toContain('BER');

    const published = enforceResponseContract(
      'Your United flight from SFO to BER departs at 1:45 PM.',
      sameClockCalendar,
      { requestText: 'When does my flight to Berlin leave tomorrow?', readRequest: flightRequest },
    );
    expect(published.text).toContain('departure at 1:45 PM');
    expect(published.text).not.toContain('United');
    expect(published.text).not.toContain('SFO');
    expect(published.text).not.toContain('BER');
  });

  it('does not call a connected itinerary a direct flight when the clock matches', () => {
    const evidence = flightEvidence([
      {
        threadId: 'berlin-confirmation',
        messageId: 'berlin-message',
        subject: 'Berlin itinerary details',
        text: [
          'Berlin itinerary',
          'KLM KL606',
          'DEPARTURE',
          'Oct 9, 2026 at 1:45 pm',
          'San Francisco SFO',
          'ARRIVAL +1',
          'Oct 10, 2026 at 9:05 am',
          'Amsterdam AMS',
          'KLM KL1777',
          'DEPARTURE',
          'Oct 10, 2026 at 12:15 pm',
          'Amsterdam AMS',
          'ARRIVAL',
          'Oct 10, 2026 at 4:30 pm',
          'Berlin BER',
        ].join('\n'),
      },
    ]);

    expect(
      groundReadDraft(
        'Your KLM flight departs directly from SFO to BER at 1:45 PM.',
        flightRequest,
        evidence,
      ).grounded,
    ).toBe(false);
    expect(
      groundReadDraft(
        'Your KLM flight from SFO to Berlin via Amsterdam departs at 1:45 PM.',
        flightRequest,
        evidence,
      ).grounded,
    ).toBe(true);
    expect(verifiedReadResponse(flightRequest, evidence)).not.toContain('direct');
  });

  it('does not substitute an old departure or a same-day boarding time when no departure is stated', () => {
    const evidence = flightEvidence([
      {
        threadId: 'current-boarding-only',
        messageId: 'current-boarding-message',
        subject: 'Berlin flight details',
        text: 'Berlin itinerary for October 9, 2026. Boarding begins at 09:15 AM.',
      },
      {
        threadId: 'older-itinerary-only',
        messageId: 'older-itinerary-message',
        subject: 'Previous Berlin itinerary',
        text: 'Berlin flight itinerary for October 3, 2026. Departure is at 09:15 AM.',
      },
    ]);

    expect(
      groundReadDraft('Your Berlin flight departs at 9:15 AM.', flightRequest, evidence).grounded,
    ).toBe(false);
    expect(verifiedReadResponse(flightRequest, evidence)).toMatch(
      /couldn't confirm a departure time/i,
    );
    expect(
      groundReadDraft(
        "I couldn't confirm the departure time for your Berlin flight.",
        flightRequest,
        evidence,
      ).grounded,
    ).toBe(true);
  });

  it('reports a conflict when the requested-day calendar flight time differs from the booked departure', () => {
    const evidence = flightEvidence(
      [
        {
          threadId: 'current-confirmation',
          messageId: 'current-message',
          subject: 'Berlin flight confirmation',
          text: 'Berlin itinerary for October 9, 2026. Departure is at 1:45 PM.',
        },
      ],
      [
        {
          eventId: 'flight-calendar-entry',
          calendarId: 'Personal',
          summary: 'Berlin flight',
          start: '2026-10-09T09:15:00-07:00',
          end: '2026-10-10T20:15:00-07:00',
        },
      ],
    );

    expect(
      groundReadDraft('Your Berlin flight departs at 1:45 PM.', flightRequest, evidence).grounded,
    ).toBe(false);
    expect(verifiedReadResponse(flightRequest, evidence)).toMatch(
      /booking message lists departure at 1:45 PM.*calendar flight entry shows 9:15 AM.*conflict/i,
    );
  });

  it('does not borrow an outbound clock from another dated leg in the same message', () => {
    const evidence = flightEvidence([
      {
        threadId: 'multi-leg-itinerary',
        messageId: 'multi-leg-message',
        subject: 'Berlin outbound and return itinerary',
        text: 'Outbound Berlin flight on October 9, 2026 departs at 1:45 PM; return Berlin flight on October 12, 2026 departs at 9:15 AM.',
      },
    ]);

    expect(
      groundReadDraft('Your Berlin flight departs at 1:45 PM.', flightRequest, evidence).grounded,
    ).toBe(true);
    expect(
      groundReadDraft('Your Berlin flight departs at 9:15 AM.', flightRequest, evidence).grounded,
    ).toBe(false);
  });

  it('does not choose between conflicting departures for the requested date', () => {
    const evidence = flightEvidence([
      {
        threadId: 'confirmation-a',
        messageId: 'message-a',
        subject: 'Berlin flight confirmation',
        text: 'Berlin itinerary for October 9, 2026. Departure is at 1:45 PM.',
      },
      {
        threadId: 'confirmation-b',
        messageId: 'message-b',
        subject: 'Updated Berlin flight information',
        text: 'Berlin itinerary for October 9, 2026. Departure is at 2:15 PM.',
      },
    ]);

    expect(
      groundReadDraft('Your Berlin flight departs at 1:45 PM.', flightRequest, evidence).grounded,
    ).toBe(false);
    expect(verifiedReadResponse(flightRequest, evidence)).toMatch(/conflicting departure times/i);
  });

  it('lets a mail rundown select — triage is the job', () => {
    const result = groundReadDraft(
      'Two worth reading:\n- **Alice Berg** — Q3 invoice\n- **Delta** — Booking confirmed',
      mailRequest,
      mailEvidence,
    );
    expect(result.grounded).toBe(true);
  });

  it('rejects a sender the mailbox never returned', () => {
    const result = groundReadDraft(
      'Two worth reading:\n- **Alice Berg** — Q3 invoice\n- **Wells Fargo** — Statement ready',
      mailRequest,
      mailEvidence,
    );
    expect(result.grounded).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/Wells Fargo/);
  });

  it('renders an empty Drive search from the ledger and drops fabricated links', () => {
    const result = enforceResponseContract(
      'I found 2023 Carnaval Costumes.jpg at https://drive.google.com/file/d/fake/view',
      [
        {
          toolName: 'drive.search',
          status: 'succeeded',
          args: { query: 'carnival parade' },
          result: { files: [] },
        },
      ],
      {
        readRequest: {
          kind: 'drive',
          queryTerms: ['carnival', 'parade'],
          firstToolName: 'drive.search',
          requiresThreadRead: false,
        },
      },
    );

    expect(result.blocked).toBe(false);
    expect(result.text).toContain(
      'No matching Drive files were returned for “carnival parade” in this bounded lookup',
    );
    expect(result.text).toContain('does not establish that none exist');
    expect(result.text).not.toContain('drive.google.com');
  });

  it('keeps uncertainty and provenance in a durable-memory answer', () => {
    const result = enforceResponseContract(
      'You definitely went in 2023.',
      [
        {
          toolName: 'memory.recall',
          status: 'succeeded',
          args: { query: 'carnival parade san francisco' },
          result: {
            memories: [
              {
                id: 'm1',
                content: 'Owner attended the Carnival Parade on May 25, 2014.',
                source: 'baldvin-and-katie-calendar',
                confidence: '0.60',
                ownerConfirmed: false,
                unconfirmed: true,
              },
            ],
          },
        },
      ],
      {
        readRequest: {
          kind: 'memory',
          queryTerms: ['carnival', 'parade', 'san', 'francisco'],
          firstToolName: 'memory.recall',
          requiresThreadRead: false,
        },
      },
    );

    expect(result.text).toContain('May 25, 2014');
    expect(result.text).toContain('confidence: 60%');
    expect(result.text).toContain('not owner-confirmed');
    expect(result.text).not.toContain('2023');
  });
});

describe('production home audit regressions', () => {
  it.each([
    { cancelled: false, reason: 'not_found' },
    { cancelled: false, reason: 'ambiguous', matches: [{ text: 'Take sunglasses' }] },
    {},
    { cancelled: 'true' },
  ])('rejects a reminder removal claim without a true cancellation receipt: %j', (result) => {
    const checked = enforceResponseContract('I cancelled the sunglasses reminder.', [
      { toolName: 'reminder.cancel', status: 'succeeded', result },
    ]);
    expect(checked).toMatchObject({ blocked: true, unsupported: ['reminder_cancel'] });
    expect(checked.text).not.toMatch(/^I cancelled|^The reminder was removed/);
  });

  it('asks which reminder to remove on an ambiguous match', () => {
    const checked = enforceResponseContract(
      'Done.',
      [
        {
          toolName: 'reminder.cancel',
          status: 'succeeded',
          result: { cancelled: false, reason: 'ambiguous' },
        },
      ],
      { requestText: 'Cancel the sunglasses reminder.' },
    );
    expect(checked.text).toContain('Which reminder');
    expect(checked.text).toContain('not removed any');
  });

  it('names bounded reminder choices instead of making the owner guess', () => {
    const checked = enforceResponseContract('I cancelled the reminder.', [
      {
        toolName: 'reminder.cancel',
        status: 'succeeded',
        result: {
          cancelled: false,
          reason: 'ambiguous',
          matches: [{ text: 'Sunglasses for home' }, { text: 'Sunglasses for travel' }],
        },
      },
    ]);
    expect(checked.text).toContain('- Sunglasses for home');
    expect(checked.text).toContain('- Sunglasses for travel');
    expect(checked.text).toContain('not removed any');
  });

  it.each(['I removed it.', 'Done.', 'The reminder was cancelled.'])(
    'requires a current cancellation for %s',
    (text) => {
      const receipt = {
        toolName: 'reminder.cancel',
        status: 'succeeded',
        result: { cancelled: true },
      };
      expect(
        enforceResponseContract(text, [receipt], {
          requestText: 'Cancel the sunglasses reminder.',
        }),
      ).toMatchObject({ blocked: false, text });
      expect(
        enforceResponseContract(text, [{ ...receipt, fromCurrentTask: false }], {
          requestText: 'Cancel the sunglasses reminder.',
        }).blocked,
      ).toBe(true);
      expect(
        enforceResponseContract(text, [{ ...receipt, toolName: 'reminder.create' }], {
          requestText: 'Cancel the sunglasses reminder.',
        }).blocked,
      ).toBe(true);
    },
  );

  it.each([
    {},
    { created: false, reminderId: 'r1' },
    { reminderId: '' },
    { reminderId: '   ' },
    { ok: false, reminderId: 'r1' },
  ])('does not treat a completed function as a scheduled reminder: %j', (result) => {
    const checked = enforceResponseContract('I scheduled the reminder.', [
      { toolName: 'reminder.create', status: 'succeeded', result },
    ]);
    expect(checked).toMatchObject({ blocked: true, unsupported: ['reminder_create'] });
    expect(checked.text).toContain('not confirmed');
    expect(
      enforceResponseContract("I'll remind you tomorrow.", [
        { toolName: 'reminder.create', status: 'succeeded', result },
      ]).blocked,
    ).toBe(true);
  });

  it('keeps real one-time and recurring reminder receipts', () => {
    for (const kind of ['once', 'recurring']) {
      const text = 'I scheduled the reminder.';
      expect(
        enforceResponseContract(text, [
          { toolName: 'reminder.create', status: 'succeeded', result: { reminderId: 'r1', kind } },
        ]),
      ).toMatchObject({ blocked: false, text });
    }
  });

  it.each([
    'You can cancel the reminder in Settings.',
    "I haven't removed any reminders.",
    'Should I create a reminder?',
    "I'll check which reminder matches.",
  ])('preserves advice and truthful incomplete reminder replies: %s', (text) => {
    expect(enforceResponseContract(text, [])).toMatchObject({ blocked: false, text });
  });

  it('does not claim an interview was marked complete without a status mutation', () => {
    const result = enforceResponseContract('Got it — marking the Clay interview as complete.', []);
    expect(result.blocked).toBe(true);
    expect(result.text).toContain("haven't changed the saved completion status");
  });
  it('removes an echoed model-only background notice', () => {
    const checked = enforceResponseContract(
      'Use console.log("Hello world");\n\n[Background notice already delivered to the owner — context only, never restate it:]\nUnrelated old approval',
      [],
    );
    expect(checked.text).toBe('Use console.log("Hello world");');
  });
  it('does not turn a saved place into an arrival alert', () => {
    const result = enforceResponseContract("I'll notify you when you arrive at the restaurant.", [
      {
        toolName: 'memory.save',
        status: 'succeeded',
        args: { subject: 'Restaurant', content: 'Saved place' },
        result: { saved: true, memoryId: 'm1' },
      },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('No reminder has been scheduled');
  });
  it.each([
    {
      toolName: 'reminder.create',
      status: 'succeeded',
      result: { reminderId: 'r1', nextFires: '2026-09-10T10:00:00Z' },
    },
    { toolName: 'task.schedule', status: 'succeeded', result: { scheduled: true, taskId: 't1' } },
  ])('accepts a current durable schedule receipt', (row) => {
    expect(enforceResponseContract("I'll remind you tomorrow.", [row]).text).not.toContain(
      'No reminder has been scheduled',
    );
    expect(
      enforceResponseContract("I'll remind you tomorrow.", [{ ...row, fromCurrentTask: false }])
        .blocked,
    ).toBe(true);
  });
});

it('acknowledges an owner-supplied completed event without inventing a status mutation', () => {
  const result = enforceResponseContract('Got it—marking the interview as complete.', [], {
    requestText: 'The interview happened already',
  });
  expect(result.text).toBe('Understood—the interview has already happened.');
  expect(result.text).not.toMatch(/updated|cancelled|marked/);
  const action = enforceResponseContract('Got it—marking the interview as complete.', [], {
    requestText: 'Mark the interview complete and cancel its reminder.',
  });
  expect(action.blocked).toBe(true);
});

describe('presentation repair before publish', () => {
  it('closes an unclosed code fence in an otherwise honest answer', () => {
    // The regression suite has graded this since the September audit; until
    // now nothing enforced it, so the suite promised a guarantee that the
    // runtime did not keep.
    const result = enforceResponseContract('Here you go:\n```js\nconsole.log(1);', []);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe('Here you go:\n```js\nconsole.log(1);\n```');
  });

  it('strips a forbidden theme tag', () => {
    const result = enforceResponseContract('[theme: sunset] Two things today.', []);
    expect(result).toMatchObject({ blocked: false, text: 'Two things today.' });
  });

  it('leaves a well-formed answer untouched', () => {
    const text = 'Two things today: dentist at 09:00, review at 14:00.';
    expect(enforceResponseContract(text, [])).toMatchObject({ blocked: false, text });
  });

  it('does not rescue a dishonest answer by repairing its formatting', () => {
    // Repair is for the success path only: a claim with no evidence behind it
    // must still be blocked, fence or no fence.
    const result = enforceResponseContract('I emailed Alice.\n```', []);
    expect(result.blocked).toBe(true);
  });
});

describe('flight write response grounding', () => {
  const outboundWrite = {
    toolName: 'calendar.create_event',
    status: 'succeeded',
    args: {
      summary: 'United outbound flight from SFO to BER',
      location: 'SFO to BER',
      start: '2026-10-09T09:15:00-07:00',
      end: '2026-10-11T05:15:00+02:00',
    },
    result: { eventId: 'evt-flight-1' },
  };
  const returnWrite = {
    toolName: 'calendar.create_event',
    status: 'succeeded',
    args: {
      summary: 'United return flight from BER to SFO',
      location: 'BER to SFO',
      start: '2026-10-20T10:30:00+02:00',
      end: '2026-10-20T13:00:00-07:00',
    },
    result: { eventId: 'evt-flight-2' },
  };
  const writeEvidence = [outboundWrite, returnWrite];

  it('parses an undotted PM clock as a supported 24-hour flight update', () => {
    const checked = correctFlightWriteClaims(
      'Your flight departure is at 1:45 PM.',
      [
        {
          toolName: 'calendar.create_event',
          status: 'succeeded',
          args: {
            summary: 'KLM flight from SFO to BER via AMS',
            start: '2026-10-09T13:45:00-07:00',
            end: '2026-10-10T09:05:00+02:00',
          },
          result: { eventId: 'evt-flight-pm' },
        },
      ],
      'Add my flight to the calendar.',
    );
    expect(checked.changed).toBe(false);
    expect(checked.text).toBe('Your flight departure is at 1:45 PM.');
  });

  it('uses the successful flight update instead of stale search evidence', () => {
    const checked = enforceResponseContract(
      'I updated your United flight from SFO to BER, but it still shows a 9:15 AM departure.',
      [
        {
          toolName: 'calendar.search_events',
          status: 'succeeded',
          args: {
            query: 'berlin',
            timeMin: '2026-10-09T07:00:00.000Z',
            timeMax: '2026-10-10T07:00:00.000Z',
          },
          result: {
            complete: true,
            calendarsSearched: ['Personal'],
            events: [
              {
                eventId: 'evt-flight-update',
                calendarId: 'primary',
                summary: 'Sample Air flight SFO to BER via AMS',
                start: '2026-10-09T09:15:00-07:00',
                end: '2026-10-10T20:15:00-07:00',
              },
            ],
          },
        },
        {
          toolName: 'gmail.search',
          status: 'succeeded',
          args: { query: 'berlin' },
          result: {
            complete: true,
            mailboxSearched: 'owner@example.com',
            results: [
              {
                messageId: 'confirmation',
                threadId: 'berlin-confirmation',
                subject: 'Berlin flight confirmation',
              },
            ],
          },
        },
        {
          toolName: 'gmail.read_thread',
          status: 'succeeded',
          args: { threadId: 'berlin-confirmation' },
          result: {
            complete: true,
            messages: [
              {
                messageId: 'confirmation',
                threadId: 'berlin-confirmation',
                subject: 'Berlin flight confirmation',
                text: 'Berlin itinerary for October 9, 2026. Boarding is at 09:15 AM; departure is at 1:45 PM.',
              },
            ],
          },
        },
        {
          toolName: 'calendar.update_event',
          status: 'succeeded',
          args: {
            eventId: 'evt-flight-update',
            summary: 'Sample Air flight SFO to BER via AMS',
            start: '2026-10-09T13:45:00-07:00',
            end: '2026-10-10T20:15:00-07:00',
          },
          result: {
            eventId: 'evt-flight-update',
            updated: true,
            summary: 'Sample Air flight SFO to BER via AMS',
            start: '2026-10-09T13:45:00-07:00',
            end: '2026-10-10T09:05:00+02:00',
          },
        },
      ],
      {
        requestText: 'My flight to BER is at 13:45. Update the calendar event.',
        readRequest: {
          kind: 'calendar_email',
          queryTerms: ['berlin'],
          firstToolName: 'calendar.search_events',
          requiresThreadRead: true,
          answerFocus: 'flight',
          timeZone: 'America/Los_Angeles',
          mailQuery: 'berlin',
          timeWindow: {
            label: 'tomorrow',
            timeMin: '2026-10-09T07:00:00.000Z',
            timeMax: '2026-10-10T07:00:00.000Z',
          },
        },
      },
    );

    expect(checked.text).toContain('Updated the calendar flight departure');
    expect(checked.text).toContain('2026-10-09T13:45:00-07:00');
    expect(checked.text).not.toContain('2026-10-10T09:05:00+02:00');
    expect(checked.text).not.toContain('9:15 AM');
    expect(checked.text).not.toContain('09:15');
    expect(checked.text).not.toContain('United');
    expect(checked.text).not.toContain('SFO');
    expect(checked.text).not.toContain('BER');
    expect(checked.text).not.toContain('09:05');
    expect(checked.blocked).toBe(true);
  });

  it('prefers a successful canonical flight update over stale reads even when the draft already matches', () => {
    const readRequest = {
      kind: 'calendar' as const,
      queryTerms: ['berlin'],
      firstToolName: 'calendar.search_events' as const,
      requiresThreadRead: false,
      answerFocus: 'flight' as const,
      timeZone: 'America/Los_Angeles',
      timeWindow: {
        label: 'tomorrow',
        timeMin: '2026-10-09T07:00:00.000Z',
        timeMax: '2026-10-10T07:00:00.000Z',
      },
    };
    const evidence = [
      {
        toolName: 'calendar.search_events',
        status: 'succeeded',
        args: {
          query: 'berlin',
          timeMin: readRequest.timeWindow.timeMin,
          timeMax: readRequest.timeWindow.timeMax,
        },
        result: {
          complete: true,
          calendarsSearched: ['Personal'],
          events: [
            {
              eventId: 'evt-flight-update',
              calendarId: 'primary',
              summary: 'Sample Air flight from SFO to BER via AMS',
              start: '2026-10-09T09:15:00-07:00',
              end: '2026-10-10T09:05:00+02:00',
            },
          ],
        },
      },
      {
        toolName: 'calendar.update_event',
        status: 'succeeded',
        args: {
          eventId: 'evt-flight-update',
          summary: 'Sample Air flight from SFO to BER via AMS',
          start: '2026-10-09T13:45:00-07:00',
        },
        result: {
          eventId: 'evt-flight-update',
          updated: true,
          summary: 'Sample Air flight from SFO to BER via AMS',
          start: '2026-10-09T13:45:00-07:00',
        },
      },
    ];
    const checked = enforceResponseContract(
      'Updated the calendar flight departure to 1:45 PM.',
      evidence,
      {
        requestText: 'It says my flight is at 1:45 PM.',
        readRequest,
      },
    );
    expect(checked.text).toBe(
      'Updated the calendar flight departure to 2026-10-09T13:45:00-07:00.',
    );
    expect(checked.text).not.toContain('9:15 AM');
    expect(checked.blocked).toBe(true);
  });

  it('does not let an unrelated calendar update override missing flight-read coverage', () => {
    const checked = enforceResponseContract(
      'Your flight departs at 9:15 AM.',
      [
        {
          toolName: 'calendar.update_event',
          status: 'succeeded',
          args: {
            eventId: 'evt-doctor',
            summary: 'Doctor appointment',
            start: '2026-10-09T13:45:00-07:00',
          },
          result: { eventId: 'evt-doctor', updated: true, start: '2026-10-09T13:45:00-07:00' },
        },
      ],
      {
        requestText: 'When does my flight to Berlin leave tomorrow? Update my doctor appointment.',
        readRequest: {
          kind: 'calendar' as const,
          queryTerms: ['berlin'],
          firstToolName: 'calendar.search_events' as const,
          requiresThreadRead: false,
          answerFocus: 'flight' as const,
          timeZone: 'America/Los_Angeles',
          timeWindow: {
            label: 'tomorrow',
            timeMin: '2026-10-09T07:00:00.000Z',
            timeMax: '2026-10-10T07:00:00.000Z',
          },
        },
      },
    );
    expect(checked.text).not.toContain('Updated the calendar flight departure');
    expect(checked.text).toContain("I couldn't confirm a departure time");
  });

  it('replaces a post-update “didn’t stick” claim with the verified canonical update receipt', () => {
    const checked = enforceResponseContract(
      "I changed the calendar, but the flight still didn't stick.",
      [
        {
          toolName: 'calendar.update_event',
          status: 'succeeded',
          args: {
            eventId: 'evt-flight-update',
            summary: 'Berlin flight',
            start: '2026-10-09T13:45:00-07:00',
          },
          result: {
            eventId: 'evt-flight-update',
            updated: true,
            summary: 'Berlin flight',
            start: '2026-10-09T13:45:00-07:00',
          },
        },
      ],
      {
        requestText: 'It says my flight is at 13:45.',
        readRequest: {
          kind: 'calendar' as const,
          queryTerms: ['berlin'],
          firstToolName: 'calendar.search_events' as const,
          requiresThreadRead: false,
          answerFocus: 'flight' as const,
          timeZone: 'America/Los_Angeles',
        },
      },
    );
    expect(checked.text).toBe(
      'Updated the calendar flight departure to 2026-10-09T13:45:00-07:00.',
    );
    expect(checked.text).not.toContain("didn't stick");
    expect(checked.blocked).toBe(true);
  });

  it('withholds the stale time when the successful update receipt omits the canonical time', () => {
    const checked = enforceResponseContract(
      'Your flight still departs at 9:15 AM.',
      [
        {
          toolName: 'calendar.update_event',
          status: 'succeeded',
          args: {
            eventId: 'evt-flight-update',
            summary: 'Sample Air flight SFO to BER via AMS',
            start: '2026-10-09T13:45:00-07:00',
          },
          result: {
            eventId: 'evt-flight-update',
            updated: true,
            summary: 'Sample Air flight SFO to BER via AMS',
          },
        },
      ],
      {
        requestText: 'My flight to BER is at 13:45. Update the calendar event.',
        readRequest: {
          kind: 'calendar_email',
          queryTerms: ['berlin'],
          firstToolName: 'calendar.search_events',
          requiresThreadRead: true,
          answerFocus: 'flight',
          timeZone: 'America/Los_Angeles',
          mailQuery: 'berlin',
          timeWindow: {
            label: 'tomorrow',
            timeMin: '2026-10-09T07:00:00.000Z',
            timeMax: '2026-10-10T07:00:00.000Z',
          },
        },
      },
    );

    expect(checked.text).toContain("I couldn't confirm the final schedule");
    expect(checked.text).not.toContain('9:15 AM');
    expect(checked.text).not.toContain('United');
    expect(checked.text).not.toContain('SFO');
    expect(checked.text).not.toContain('BER');
  });

  it('does not treat a failed flight update as a fresh source of truth', () => {
    const original = 'The flight still leaves at 9:15 AM.';
    const checked = enforceResponseContract(
      original,
      [
        {
          toolName: 'calendar.update_event',
          status: 'failed',
          args: {
            eventId: 'evt-flight-update',
            summary: 'United flight SFO to BER',
            start: '2026-10-09T13:45:00-07:00',
          },
          result: { updated: false },
          error: 'conflict',
        },
      ],
      { requestText: 'My flight to BER is at 13:45. Update the calendar event.' },
    );

    expect(checked.text).toBe(original);
  });

  it('replaces a KLM route and missing-return claim with the successful write receipt', () => {
    const result = enforceResponseContract(
      'Your KLM flight via Amsterdam is on the calendar. The return time is unavailable. The hotel is still on your list.',
      writeEvidence,
      {
        requestText: 'Add my United flight from SFO to BER to the calendar.',
      },
    );

    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('KLM');
    expect(result.text).not.toContain('Amsterdam');
    expect(result.text).not.toContain('return time is unavailable');
    expect(result.text).toContain('2026-10-09T09:15:00-07:00');
    expect(result.text).toContain('2026-10-11T05:15:00+02:00');
    expect(result.text).toContain('2026-10-20T10:30:00+02:00');
    expect(result.text).toContain('The hotel is still on your list.');
  });

  it('does not treat an outbound arrival as a scheduled return', () => {
    const text = 'The return time is unavailable.';
    const result = enforceResponseContract(text, [outboundWrite], {
      requestText: 'Add my United flight from SFO to BER to the calendar.',
    });

    expect(result).toMatchObject({ blocked: false, text });
  });

  it('does not infer a return from an outbound description about missing return details', () => {
    const text = 'The return time is unavailable.';
    const evidence = {
      ...outboundWrite,
      args: {
        ...outboundWrite.args,
        description: 'Return flight not booked; return time unavailable.',
      },
    };
    expect(
      enforceResponseContract(text, [evidence], {
        requestText: 'Add my United flight from SFO to BER to the calendar.',
      }),
    ).toMatchObject({ blocked: false, text });
  });

  it('corrects a different explicitly zoned flight time while preserving the valid arrival', () => {
    const result = enforceResponseContract(
      'Your United flight departs at 10:15 AM PDT and arrives at 5:15 AM CEST.',
      writeEvidence,
      { requestText: 'Add my United flight to the calendar.' },
    );

    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('10:15 AM PDT');
    expect(result.text).toContain('2026-10-09T09:15:00-07:00');
  });

  it('preserves matching airline, airports, dates, and zoned times from the write', () => {
    const text =
      'Your United flight from SFO to BER departs at 9:15 AM PDT on Oct 9, 2026 and arrives at 5:15 AM CEST on Oct 11, 2026.';
    const result = enforceResponseContract(text, [outboundWrite], {
      requestText: 'Add my United flight from SFO to BER to the calendar.',
    });

    expect(result).toMatchObject({ blocked: false, text });
  });

  it('does not misread unrelated uppercase acronyms as airport codes', () => {
    const text = 'Your United flight from SFO to BER is saved; the CEO will join.';
    const result = enforceResponseContract(text, [outboundWrite], {
      requestText: 'Add my United flight from SFO to BER to the calendar.',
    });

    expect(result).toMatchObject({ blocked: false, text });
  });

  it('rejects a flight date that differs even when the clock time matches', () => {
    const result = enforceResponseContract(
      'Your United flight from SFO to BER departs at 9:15 AM PDT on Oct 10, 2026.',
      [outboundWrite],
      { requestText: 'Add my United flight from SFO to BER to the calendar.' },
    );

    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('Oct 10, 2026');
    expect(result.text).toContain('2026-10-09T09:15:00-07:00');
  });

  it('checks a combined private-read reply against the successful writes', () => {
    const text = 'Your KLM flight via Amsterdam is on the calendar.';
    const result = enforceResponseContract(
      text,
      [
        {
          toolName: 'drive.search',
          status: 'succeeded',
          args: { query: 'flight confirmation' },
          result: { files: [{ fileId: 'f1', name: 'KLM flight confirmation' }] },
        },
        ...writeEvidence,
      ],
      {
        requestText: 'Find my flight confirmation in Drive and add both flights to the calendar.',
        readRequest: {
          kind: 'drive',
          queryTerms: ['flight', 'confirmation'],
          firstToolName: 'drive.search',
          requiresThreadRead: false,
        },
      },
    );

    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('KLM');
    expect(result.text).toContain('Saved to your calendar:');
  });

  it('preserves flight wording when the owner explicitly asks for exact repetition', () => {
    const text = 'Your KLM flight via Amsterdam has no return time.';
    const result = enforceResponseContract(text, writeEvidence, {
      requestText: `Repeat this exactly: ${text}`,
    });

    expect(result).toMatchObject({ blocked: false, text });
  });
});
