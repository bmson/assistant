import { describe, expect, it } from 'vitest';
import {
  approvalHeadline,
  approvalPrompt,
  clarifyingQuestion,
  classifyFailure,
  collapseWhitespace,
  failureNotice,
  isOwnerFacingTask,
  ownerDate,
  ownerDateTime,
  ownerEventWhen,
  ownerTaskLabel,
  ownerTime,
  readableSender,
  sentenceCase,
  shortPlace,
  truncateAtBoundary,
} from './owner-text.js';

const PACIFIC = 'America/Los_Angeles';
/** 2026-09-15T10:00 Pacific — the morning the reviewed digest went out. */
const NOW = new Date('2026-09-15T17:00:00Z');

describe('collapseWhitespace', () => {
  it('flattens the newline a calendar location carries', () => {
    expect(collapseWhitespace('Crocker Amazon\n1669 Geneva Avenue, San Francisco, CA 94134')).toBe(
      'Crocker Amazon 1669 Geneva Avenue, San Francisco, CA 94134',
    );
  });

  it('collapses runs and trims the ends', () => {
    expect(collapseWhitespace('  a \t\n  b  ')).toBe('a b');
  });

  it('leaves already-flat text alone', () => {
    expect(collapseWhitespace('Anniversary Lunch')).toBe('Anniversary Lunch');
  });
});

describe('truncateAtBoundary', () => {
  it('returns text that already fits', () => {
    expect(truncateAtBoundary('short enough', 40)).toBe('short enough');
  });

  it('cuts on a word boundary and marks the cut', () => {
    const cut = truncateAtBoundary('a routine reminder with a clear deadline in the future', 30);
    expect(cut).toBe('a routine reminder with a…');
    expect(cut.length).toBeLessThanOrEqual(30);
  });

  it('never ends mid-word, which is what the hard slices used to do', () => {
    const source = 'Payment reminder for a car loan with a specific due date and amount.';
    // Below this budget there is no whole word to keep and the documented hard
    // cut is the only option, so the property does not apply.
    const firstWord = source.slice(0, source.indexOf(' '));
    for (let max = firstWord.length + 2; max <= source.length; max += 1) {
      const cut = truncateAtBoundary(source, max);
      expect(cut.length).toBeLessThanOrEqual(max);
      if (!cut.endsWith('…')) continue;
      const tail = cut.slice(0, -1);
      expect(source.startsWith(tail)).toBe(true);
      // Whatever follows the kept text in the original must not be a word
      // character: that is what distinguishes a whole word from a severed one.
      // It may be a space, or punctuation the cut deliberately stripped.
      expect(source.slice(tail.length, tail.length + 1)).not.toMatch(/[A-Za-z0-9]/);
    }
  });

  it('drops trailing punctuation left dangling by the cut', () => {
    expect(truncateAtBoundary('one, two, three, four', 12)).toBe('one, two…');
  });

  it('falls back to a hard cut when one word exceeds the budget', () => {
    expect(truncateAtBoundary('supercalifragilistic', 10)).toBe('supercali…');
  });

  it('handles a budget too small for the mark', () => {
    expect(truncateAtBoundary('anything', 0)).toBe('');
    expect(truncateAtBoundary('anything', 1)).toBe('…');
  });
});

describe('ownerTime', () => {
  it('renders a UTC instant in the owner zone', () => {
    // The digest showed this as "2026-09-17T00:15:00Z"; it is a Wednesday
    // afternoon swim, not a small-hours one.
    expect(ownerTime('2026-09-17T00:15:00Z', PACIFIC)).toBe('5:15 PM');
  });

  it('renders an offset instant the same way as its UTC equivalent', () => {
    expect(ownerTime('2026-09-15T18:30:00-07:00', PACIFIC)).toBe(
      ownerTime('2026-09-16T01:30:00Z', PACIFIC),
    );
  });

  it('passes an unparseable value through rather than showing Invalid Date', () => {
    expect(ownerTime('not a date', PACIFIC)).toBe('not a date');
  });
});

describe('ownerDate', () => {
  it('says Today for the current local day', () => {
    expect(ownerDate('2026-09-15T18:30:00-07:00', PACIFIC, NOW)).toBe('Today');
  });

  it('says Tomorrow for the next local day', () => {
    expect(ownerDate('2026-09-16T11:45:00-07:00', PACIFIC, NOW)).toBe('Tomorrow');
  });

  it('names the weekday further out', () => {
    expect(ownerDate('2026-09-18T11:45:00-07:00', PACIFIC, NOW)).toBe('Fri, Sep 18');
  });

  it('resolves relative labels in the owner zone, not UTC', () => {
    // 2026-09-16T01:30Z is still the 15th in Pacific: "Today", not "Tomorrow".
    expect(ownerDate('2026-09-16T01:30:00Z', PACIFIC, NOW)).toBe('Today');
  });
});

describe('ownerDateTime', () => {
  it('joins the relative day and the clock time', () => {
    expect(ownerDateTime('2026-09-16T11:45:00-07:00', PACIFIC, NOW)).toBe('Tomorrow 11:45 AM');
  });
});

describe('ownerEventWhen', () => {
  it('renders a same-day range once', () => {
    expect(
      ownerEventWhen(
        { start: '2026-09-15T18:30:00-07:00', end: '2026-09-15T20:00:00-07:00' },
        PACIFIC,
        NOW,
      ),
    ).toBe('Today 6:30 PM – 8:00 PM');
  });

  it('normalizes a UTC-stamped event into the owner zone', () => {
    expect(
      ownerEventWhen({ start: '2026-09-16T22:45:00Z', end: '2026-09-16T23:30:00Z' }, PACIFIC, NOW),
    ).toBe('Tomorrow 3:45 PM – 4:30 PM');
  });

  it('spells out both ends when an event crosses local midnight', () => {
    expect(
      ownerEventWhen(
        { start: '2026-09-16T22:00:00-07:00', end: '2026-09-17T01:00:00-07:00' },
        PACIFIC,
        NOW,
      ),
    ).toBe('Tomorrow 10:00 PM → Thu, Sep 17 1:00 AM');
  });

  it('keeps an all-day event on its own date', () => {
    expect(ownerEventWhen({ start: '2026-09-16', allDay: true }, PACIFIC, NOW)).toBe(
      'Tomorrow (all day)',
    );
  });

  it('renders a start with no end', () => {
    expect(ownerEventWhen({ start: '2026-09-16T19:30:00-07:00' }, PACIFIC, NOW)).toBe(
      'Tomorrow 7:30 PM',
    );
  });

  it('passes an unparseable start through', () => {
    expect(ownerEventWhen({ start: 'sometime' }, PACIFIC, NOW)).toBe('sometime');
  });
});

describe('approvalHeadline', () => {
  it('drops a call brief down to who and for how long', () => {
    const summary =
      'Call Baldvin (+14152319793) for up to 5 min: Stay on the line with Baldvin. Identify yourself as an AI assistant. · May agree to: Any reasonable request the owner makes during the call. · Never: Do not hang up on voicemail. · May share: Baldvin is the owner. · Leaves a voicemail if no one answers';
    expect(approvalHeadline(summary)).toBe('Call Baldvin for up to 5 minutes');
  });

  it('keeps a bare number when the call has no name', () => {
    expect(approvalHeadline('Call +14155550123 for up to 1 min: ask about opening hours')).toBe(
      'Call +14155550123 for up to 1 minute',
    );
  });

  it('shows a page by its address, not as a URL with a verb', () => {
    expect(
      approvalHeadline(
        'Fetch the public web page https://github.com/bmson/assistant-repair-worker',
      ),
    ).toBe('Open github.com/bmson/assistant-repair-worker');
    expect(approvalHeadline('Open “https://www.example.com/a/b”')).toBe('Open example.com/a/b');
  });

  it('cuts fine print and long text, and strips markdown', () => {
    expect(approvalHeadline('Send SMS to +14152319793: "Test" · extra')).toBe(
      'Send SMS to +14152319793: "Test"',
    );
    const long = `Remember: “${'KLM flights '.repeat(30)}”`;
    const out = approvalHeadline(long);
    expect(out.length).toBeLessThanOrEqual(110);
    expect(out.endsWith('…')).toBe(true);
    expect(approvalHeadline('**Create** the `Berlin` list')).toBe('Create the Berlin list');
  });
});

describe('approvalPrompt', () => {
  it('asks one question for one thing and lists several', () => {
    expect(approvalPrompt(['Call Baldvin for up to 5 minutes'])).toBe(
      'Call Baldvin for up to 5 minutes — okay to go ahead?',
    );
    expect(approvalPrompt(['Open a.com', 'Open b.com'])).toBe(
      'A few things need your okay:\n- Open a.com\n- Open b.com',
    );
    expect(approvalPrompt([])).toBe('I need your okay on something.');
  });
});

describe('failureNotice', () => {
  const raw = [
    'AI_RetryError: Failed after 3 attempts. Last error: AI_APICallError: [Mara] minimax/minimax-m2.7 is temporarily rate-limited upstream. https://openrouter.ai/settings/integrations',
    'AI_APICallError: [SambaNova] The requested model (MiniMax-M2.7) is not available on SambaNova Cloud.',
    'AI_APICallError: Upstream error from DeepInfra: {"error":{"message":"The request was rejected as invalid."}}',
    'AI_APICallError: error code: 502',
  ];

  it('never carries the raw error, a provider, a URL or JSON', () => {
    for (const error of raw) {
      const text = failureNotice(new Error(error));
      expect(text).not.toMatch(/AI_|Mara|SambaNova|DeepInfra|https?:|\{|Last error/u);
      expect(text.length).toBeLessThan(140);
    }
  });

  it('tells a provider hiccup from a billing problem from a bug of ours', () => {
    expect(classifyFailure(raw[0])).toBe('provider');
    expect(classifyFailure('AI_APICallError: [Mara] A payment method is required.')).toBe(
      'billing',
    );
    expect(classifyFailure('OpenAI coding credits are exhausted')).toBe('billing');
    expect(
      classifyFailure('Error: Field "createdAt" is missing in the provided DocumentSnapshot'),
    ).toBe('internal');
    expect(failureNotice('Execution evidence exceeds the 500-row bound')).toContain(
      'snag on my side',
    );
    expect(failureNotice(raw[3])).toContain('Want me to try again');
  });

  it('classifies a failed configured fallback from its bounded primary cause', () => {
    const wrapped = (cause: unknown) =>
      Object.assign(new Error('configured model fallback attempt failed'), {
        name: 'ModelCallFallbackAttemptError',
        fallbackAttempted: true,
        cause,
      });

    expect(classifyFailure(wrapped(new Error('AI_APICallError: HTTP 404 no endpoints')))).toBe(
      'provider',
    );
    expect(classifyFailure(wrapped(new Error('payment method is required')))).toBe('billing');
    expect(classifyFailure(wrapped(new Error('invalid internal tool state')))).toBe('internal');

    const cyclic = wrapped(new Error('temporary upstream failure'));
    Object.defineProperty(cyclic, 'cause', { value: cyclic });
    expect(classifyFailure(cyclic)).toBe('internal');
  });
});

describe('ownerTaskLabel', () => {
  it('quotes a short human title and refuses a leaked instruction', () => {
    expect(ownerTaskLabel('Berlin packing list')).toBe('“Berlin packing list”');
    expect(
      ownerTaskLabel(
        "Prepare the owner's morning brief. Check: (1) today's events on your calendar a…",
      ),
    ).toBe('');
    expect(
      ownerTaskLabel(
        'Do a short look-ahead at TOMORROW for the owner while there is still time to re…',
      ),
    ).toBe('');
    expect(ownerTaskLabel(undefined)).toBe('');
  });
});

describe('shortPlace', () => {
  it('keeps the venue and drops the postal address', () => {
    expect(shortPlace('Crocker Amazon\n1669 Geneva Avenue, San Francisco, CA 94134')).toBe(
      'Crocker Amazon',
    );
    expect(
      shortPlace('Exploratorium, Pier 15 Embarcadero at, Green St, San Francisco, CA 94111, USA'),
    ).toBe('Exploratorium');
    expect(shortPlace('Laugavegur 12, Reykjavik')).toBe('Laugavegur 12');
    expect(shortPlace('')).toBe('');
  });
});

describe('sentenceCase', () => {
  it('capitalises the first letter and leaves the rest alone', () => {
    expect(sentenceCase('it falls outside your usual hours')).toBe(
      'It falls outside your usual hours',
    );
    expect(sentenceCase('Already fine')).toBe('Already fine');
  });
});

describe('isOwnerFacingTask', () => {
  it("hides scheduled instructions and the assistant's own housekeeping", () => {
    expect(isOwnerFacingTask('Berlin packing list')).toBe(true);
    expect(
      isOwnerFacingTask(
        "Prepare the owner's morning brief. Check: (1) today's events on your calen…",
      ),
    ).toBe(false);
    expect(isOwnerFacingTask('self-improve')).toBe(false);
    expect(isOwnerFacingTask('Self maintain')).toBe(false);
    expect(isOwnerFacingTask(null)).toBe(false);
  });
});

describe('readableSender', () => {
  it('prefers the display name, then a clean local part, then the brand', () => {
    expect(readableSender('SF United F.C.', 'noreply@sf-united.com')).toBe('SF United F.C.');
    expect(
      readableSender(null, 'donotreply+701544cc-b163-520c-8336-0ab0fb968a0d@parentsquare.com'),
    ).toBe('Parentsquare');
    expect(readableSender('', 'noreply@sf-united.com')).toBe('Sf-united');
    expect(readableSender(null, 'miguel.c@plaid.com')).toBe('miguel.c');
  });
});

describe('clarifyingQuestion', () => {
  it('asks one question as a question and several as a short list', () => {
    expect(clarifyingQuestion(["Which of your kids is in Ms. Ichiyasu's class?"])).toBe(
      "Quick question: Which of your kids is in Ms. Ichiyasu's class?",
    );
    expect(clarifyingQuestion(['what dates work for you'])).toBe(
      'I need one thing from you: What dates work for you',
    );
    expect(clarifyingQuestion(['Which kid?', 'Do they have a library card?'])).toBe(
      'A few quick questions:\n- Which kid?\n- Do they have a library card?',
    );
    expect(clarifyingQuestion([])).toContain('what exactly would you like me to do?');
  });

  it('never uses the form-rejection phrasing', () => {
    expect(clarifyingQuestion(['A', 'B'])).not.toContain('Before I proceed');
  });
});
