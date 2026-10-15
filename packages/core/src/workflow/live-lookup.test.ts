import { describe, expect, it } from 'vitest';
import {
  attributeLookupEvidence,
  detectLiveLookup,
  detectLiveLookups,
  liveLookupDirective,
  liveLookupFailure,
  liveLookupFailures,
  nextLiveLookup,
  nextLiveLookups,
  tripEvent,
  ungroundedLiveFigure,
} from './live-lookup.js';

describe('live lookup routing from home-screen regressions', () => {
  it('keeps artifact privacy verification and readback out of public search', () => {
    const request =
      'Create one owner-private Google Doc titled "Fictional Workshop Brief", only if you can verify it will be accessible solely to my owner account. Use only these fictional facts: a workshop on 12 April 2030, budget US$120. Read it back and give the link. Do not share it.';
    expect(detectLiveLookups([{ role: 'user', content: request }])).toEqual([]);
  });
  it.each([
    'Create a private Google Doc titled "Budget notes" with my private draft. Look it up to verify access.',
    'Create a private Google Doc titled "Budget notes" with my private draft. Search for that exact title first.',
  ])('keeps ambiguous artifact lookup language authenticated: %s', (content) => {
    expect(detectLiveLookups([{ role: 'user', content }])).toEqual([]);
  });
  it('preserves explicitly requested public research alongside artifact creation', () => {
    expect(
      detectLiveLookup([
        {
          role: 'user',
          content: 'Search the web for official transit fares and create a Google Doc.',
        },
      ]),
    ).toMatchObject({ kind: 'web' });
  });
  it('asks for a focused search query rather than repeatedly dispatching an over-limit request', () => {
    const request = `Search the web for official transit fares. ${'Explain the current options and cite official sources. '.repeat(8)}`;
    expect(request.length).toBeGreaterThan(256);
    expect(nextLiveLookup({ kind: 'web', request }, [])).toEqual({ toolName: 'web.search' });
  });
  it('leaves an explicit Google Doc read with the authenticated document reader', () => {
    expect(
      detectLiveLookup([
        {
          role: 'user',
          content: 'Please read https://docs.google.com/document/d/doc-1234567890/edit',
        },
      ]),
    ).toBeUndefined();
  });
  it.each([
    'Read https://example.com/transit and summarize in three bullets. Do not use my email, calendar, or memories.',
    'Please summarize https://example.com/transit. Keep source links.',
    'Review the page at https://example.com/transit.',
  ])('reads the explicitly requested page directly: %s', (request) => {
    const lookup = detectLiveLookup([{ role: 'user', content: request }]);
    expect(lookup).toMatchObject({ kind: 'web' });
    if (!lookup) throw new Error('Expected a public page lookup');
    expect(nextLiveLookup(lookup, [])).toEqual({
      toolName: 'web.fetch',
      input: { url: 'https://example.com/transit' },
    });
    expect(
      nextLiveLookup(lookup, [
        {
          toolName: 'web.fetch',
          status: 'succeeded',
          result: { text: 'Official transit information' },
        },
      ]),
    ).toBeUndefined();
    expect(
      nextLiveLookup(lookup, [{ toolName: 'web.fetch', status: 'failed', result: null }]),
    ).toBeUndefined();
  });
  it.each([
    'Do not read https://example.com/transit.',
    'The reference is https://example.com/transit, but just rewrite my sentence.',
    'Read https://user:password@example.com/transit.',
  ])('does not force a page read from contextual or prohibited links: %s', (content) => {
    expect(detectLiveLookup([{ role: 'user', content }])).toBeUndefined();
  });

  it('forces a team fixture lookup before creating an event-completion reminder', () => {
    const request = 'Remind me after the Giants game tomorrow to check the score.';
    const lookup = detectLiveLookup([{ role: 'user', content: request }]);
    if (!lookup) throw new Error('Expected a sports lookup for a team event reminder');
    expect(lookup).toMatchObject({ kind: 'sports', reminderTeam: 'Giants' });
    expect(
      nextLiveLookup(lookup, [], {
        now: new Date('2026-10-07T06:30:00.000Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({
      toolName: 'sports.scores',
      input: { team: 'Giants', date: '2026-10-07' },
    });
  });

  it.each([
    ['What is the current score in the SF Giants game?', 'SF Giants', '2026-10-15'],
    ['What was the Arsenal score yesterday?', 'Arsenal', '2026-10-14'],
    ['Who won the Valur match last Saturday?', 'Valur', '2026-10-10'],
  ])('preserves the named team and owner-local date for %s', (request, team, date) => {
    const lookup = detectLiveLookup([{ role: 'user', content: request }]);
    expect(lookup?.kind).toBe('sports');
    if (!lookup) throw new Error('Expected a sports lookup');
    expect(
      nextLiveLookup(lookup, [], {
        now: new Date('2026-10-15T08:11:00Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toEqual({ toolName: 'sports.scores', input: { team, date } });
  });

  it('extracts a multiword team from a natural score request without inferring its league', () => {
    const lookup = detectLiveLookup([
      { role: 'user', content: 'Can you check the New York Yankees score tonight?' },
    ]);
    if (!lookup) throw new Error('Expected a sports lookup');
    expect(
      nextLiveLookup(lookup, [], {
        now: new Date('2026-10-15T08:11:00Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toEqual({
      toolName: 'sports.scores',
      input: { team: 'New York Yankees', date: '2026-10-15' },
    });
  });

  it('extracts a team named after the score phrase', () => {
    const lookup = detectLiveLookup([
      { role: 'user', content: 'What is the score for the Los Angeles Lakers tonight?' },
    ]);
    if (!lookup) throw new Error('Expected a sports lookup');
    expect(
      nextLiveLookup(lookup, [], {
        now: new Date('2026-10-15T08:11:00Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toEqual({
      toolName: 'sports.scores',
      input: { team: 'Los Angeles Lakers', date: '2026-10-15' },
    });
  });

  it.each(['Do not check the SF Giants score.', "Don't look up the New York Yankees score."])(
    'does not route an explicitly prohibited sports lookup: %s',
    (request) => {
      expect(detectLiveLookup([{ role: 'user', content: request }])).toBeUndefined();
    },
  );

  it('does not infer a team from other tool evidence when the request names none', () => {
    const lookup = detectLiveLookup([{ role: 'user', content: 'What is the current game score?' }]);
    if (!lookup) throw new Error('Expected a sports lookup');
    expect(
      nextLiveLookup(lookup, [
        {
          toolName: 'web.search',
          status: 'succeeded',
          result: { results: [{ title: 'San Francisco Giants score' }] },
        },
      ]),
    ).toEqual({ toolName: 'sports.scores' });
  });

  it('retains a complete league identity with the owner-local date', () => {
    const lookup = detectLiveLookup([{ role: 'user', content: 'Any MLB scores yesterday?' }]);
    if (!lookup) throw new Error('Expected a sports lookup');
    expect(
      nextLiveLookup(lookup, [], {
        now: new Date('2026-10-15T08:11:00Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toEqual({ toolName: 'sports.scores', input: { league: 'mlb', date: '2026-10-14' } });
  });

  it.each([
    ['What are the NBA scores today?', { league: 'nba', date: '2026-10-15' }],
    ['What is the score in the Premier League game today?', { league: 'epl', date: '2026-10-15' }],
    [
      'What is the MLB SF Giants score today?',
      { team: 'SF Giants', league: 'mlb', date: '2026-10-15' },
    ],
  ])('keeps league and team scope separate: %s', (request, input) => {
    const lookup = detectLiveLookup([{ role: 'user', content: request }]);
    if (!lookup) throw new Error('Expected sports lookup');
    expect(
      nextLiveLookup(lookup, [], {
        now: new Date('2026-10-15T08:11:00Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toEqual({ toolName: 'sports.scores', input });
  });

  it.each([
    'Who is the current president of Iceland',
    'Search the web',
    'Look it up, don’t think this is correct',
    'Can you find a place somewhere along the way to eat',
    'I need to find other companies to apply for. Where should I try?',
  ])('requires public evidence for %s', (content) => {
    expect(detectLiveLookup([{ role: 'user', content }])?.kind).toBe('web');
  });
  it.each(['How is the weather currently', 'How is the weather going to by work tomorrow'])(
    'checks %s',
    (content) => {
      expect(detectLiveLookup([{ role: 'user', content }])?.kind).toBe('weather');
    },
  );
  it.each([
    'How do I write hello world in JavaScript',
    'I love the rain',
    'Approved',
    'What does a president do?',
    'Do not search the web',
    'Look up the wifi password',
    'Search for my emails',
    'Investigate my calendar',
  ])('does not turn %s into a public lookup', (content) => {
    expect(detectLiveLookup([{ role: 'user', content }])).toBeUndefined();
  });
  it.each([
    'What is the current SF giants score',
    "What's the Giants score?",
    'Who won the Arsenal match?',
    'Any Premier League results today?',
    'Is there an NFL game tonight?',
    'Create a dynamic card that shows live sport scores',
  ])('answers %s from the scores tool', (content) => {
    expect(detectLiveLookup([{ role: 'user', content }])?.kind).toBe('sports');
  });
  it.each([
    "What's my credit score?",
    'When is my soccer game on Saturday?',
    'I love this game',
    'Explain how a match works in tennis scoring history',
  ])('does not treat %s as a sports lookup', (content) => {
    expect(detectLiveLookup([{ role: 'user', content }])?.kind).not.toBe('sports');
  });
  it('asks the scores tool first, then falls back to the web for an uncovered team', () => {
    const lookup = { kind: 'sports' as const, request: 'What was the Valur score?' };
    expect(nextLiveLookup(lookup, [])).toEqual({
      toolName: 'sports.scores',
      input: { team: 'Valur' },
    });
    const answered = {
      toolName: 'sports.scores',
      status: 'succeeded' as const,
      result: { games: [{ line: 'Valur at KR: 2-1, FT' }] },
    };
    expect(nextLiveLookup(lookup, [answered])).toBeUndefined();
    expect(liveLookupFailure(lookup, [answered])).toBeUndefined();
    const uncovered = {
      toolName: 'sports.scores',
      status: 'succeeded' as const,
      result: { games: [], unsupported: true, error: 'No team matched' },
    };
    expect(nextLiveLookup(lookup, [uncovered])).toEqual({
      toolName: 'web.search',
      input: { query: 'What was the Valur score?', count: 5 },
    });
  });
  it('grounds a score against the game lines the scores tool returned', () => {
    const lookup = { kind: 'sports' as const, request: "What's the Giants score?" };
    const evidence = [
      {
        toolName: 'sports.scores',
        status: 'succeeded' as const,
        result: { games: [{ line: 'Minnesota Twins at San Francisco Giants: 2-5, Final' }] },
      },
    ];
    expect(ungroundedLiveFigure(lookup, 'The Giants won 5-2.', evidence)).toBeUndefined();
    expect(ungroundedLiveFigure(lookup, 'The Giants won 7-3.', evidence)).toMatch(
      /do not state 7-3/,
    );
  });
  it.each([
    'Directions to Oracle Park',
    'How long will it take me to drive to SFO?',
    'How far is Palo Alto from here?',
    'When should I leave for the airport to be there by 3?',
    "What's the drive time to Napa?",
    'Can you give me directions from work to the dentist?',
  ])('routes %s to the maps tool', (content) => {
    expect(detectLiveLookup([{ role: 'user', content }])?.kind).toBe('directions');
  });
  it.each([
    'How long to cook rice?',
    'How far along is the project?',
    'How long did it take to get the visa?',
    'Give me directions for assembling the desk',
  ])('does not treat %s as a trip', (content) => {
    expect(detectLiveLookup([{ role: 'user', content }])?.kind).not.toBe('directions');
  });
  it('asks for one route and reports a failed route instead of guessing a time', () => {
    const lookup = { kind: 'directions' as const, request: 'Directions to Oracle Park' };
    expect(nextLiveLookup(lookup, [])).toEqual({ toolName: 'maps.directions' });
    const routed = {
      toolName: 'maps.directions',
      status: 'succeeded' as const,
      result: { durationSeconds: 540, distanceMeters: 1850 },
    };
    expect(nextLiveLookup(lookup, [routed])).toBeUndefined();
    expect(liveLookupFailure(lookup, [routed])).toBeUndefined();
    expect(liveLookupFailure(lookup, [{ ...routed, result: { error: 'No route found' } }])).toMatch(
      /couldn't get a route/,
    );
  });
  it.each([
    "What's the cheapest Muni option next weekend for three rides and one cable-car ride?",
    'How much does a BART ticket to the airport cost?',
    'Compare the best value train passes for a weekend in London.',
    'Are bus fares cheaper with a day pass?',
  ])('requires current operator evidence for public fare decisions: %s', (content) => {
    const lookup = detectLiveLookup([{ role: 'user', content }]);
    expect(lookup).toMatchObject({ kind: 'web', request: content });
    expect(lookup && nextLiveLookup(lookup, [])?.toolName).toBe('web.search');
  });
  it.each([
    'For a hypothetical bus, tickets cost $3 and a day pass costs $8. What is cheapest for four rides?',
    'Given a $2 bus fare and a $7 day pass, which is cheaper for three rides?',
    'Using only these supplied train prices, compare tickets at $4 and a pass at $12.',
    'Do not search the web. Calculate the cheapest bus pass from these prices.',
  ])('does not turn supplied pricing exercises into public research: %s', (content) => {
    expect(detectLiveLookup([{ role: 'user', content }])).toBeUndefined();
  });
  it('resolves a typo follow-up without querying the previous assistant guess', () => {
    expect(
      detectLiveLookup([
        { role: 'user', content: 'What is the current SF giants score' },
        { role: 'assistant', content: 'I think they won 7-3.' },
        { role: 'user', content: 'Check the wcore' },
      ]),
    ).toEqual({ kind: 'sports', request: 'What is the current SF giants score' });
  });
  it('continues a weather question after its missing address arrives', () => {
    expect(
      detectLiveLookup([
        { role: 'user', content: 'How is the weather by work tomorrow' },
        {
          role: 'assistant',
          content: 'Please provide your work location so I can check the weather.',
        },
        { role: 'user', content: 'I work at Zendesk 181 Fremont street San Francisco' },
      ])?.kind,
    ).toBe('weather');
  });
  it('reads a discovered source after a search and bounds automatic reads', () => {
    const lookup = { kind: 'web' as const, request: 'What is the current SF giants score' };
    const search = {
      toolName: 'web.search',
      status: 'succeeded',
      result: { results: [{ url: 'https://example.com/score' }] },
    };
    expect(nextLiveLookup(lookup, [])?.toolName).toBe('web.search');
    expect(nextLiveLookup(lookup, [search])).toEqual({
      toolName: 'web.fetch',
      input: { url: 'https://example.com/score' },
    });
    expect(
      nextLiveLookup(lookup, [search, { toolName: 'web.fetch', status: 'failed', result: null }]),
    ).toBeUndefined();
  });
  it('does not send a private lookup follow-up to public search', () => {
    expect(
      detectLiveLookup([
        { role: 'user', content: 'Find my hotel reservation in my mailbox' },
        { role: 'user', content: 'Look it up' },
      ]),
    ).toBeUndefined();
  });
  it('does not allow failed or old weather evidence to authorize a forecast', () => {
    const lookup = { kind: 'weather' as const, request: 'Weather tomorrow' };
    expect(
      liveLookupFailure(lookup, [
        { toolName: 'weather.lookup', status: 'failed', result: null },
        {
          toolName: 'weather.lookup',
          status: 'succeeded',
          result: { current: { tempC: 14 } },
          fromCurrentTask: false,
        },
      ]),
    ).toContain("can't confirm temperatures");
    expect(
      liveLookupFailure(lookup, [
        { toolName: 'weather.lookup', status: 'succeeded', result: { current: { tempC: 14 } } },
      ]),
    ).toBeUndefined();
  });
  it('treats HTTP errors embedded in tool results as failures', () => {
    expect(
      liveLookupFailure({ kind: 'web', request: 'Check the score' }, [
        {
          toolName: 'web.fetch',
          status: 'succeeded',
          result: { status: 403, text: 'AccessDenied' },
        },
      ]),
    ).toContain("haven't verified");
  });
});

describe('ungroundedLiveFigure', () => {
  const webLookup = { kind: 'web', request: 'What was the final score last night?' } as const;
  const weatherLookup = { kind: 'weather', request: 'what is the weather today' } as const;
  const fetched = (text: string) => [
    { toolName: 'web.fetch', status: 'succeeded', result: { text } } as never,
  ];

  it('blocks a score the retrieved sources never stated', () => {
    // The September failure: a batted-ball stat in a snippet reported as the score.
    const evidence = fetched('Final: San Francisco Giants 5, St. Louis Cardinals 4.');
    expect(ungroundedLiveFigure(webLookup, 'The Giants led 7-3.', evidence)).toMatch(
      /do not state 7-3/,
    );
  });

  it('accepts a score the sources do state', () => {
    const evidence = fetched('Final: San Francisco Giants 5, St. Louis Cardinals 4.');
    expect(ungroundedLiveFigure(webLookup, 'Giants won 5-4.', evidence)).toBeUndefined();
  });

  it('accepts the same score stated in the other order', () => {
    const evidence = fetched('Cardinals 4, Giants 5 (F/11)');
    expect(
      ungroundedLiveFigure(webLookup, 'It finished 5-4 to the Giants.', evidence),
    ).toBeUndefined();
  });

  it('accepts a figure that only appeared in a search snippet', () => {
    const evidence = [
      {
        toolName: 'web.search',
        status: 'succeeded',
        result: { results: [{ snippet: 'Giants 5, Cardinals 4 final' }] },
      } as never,
    ];
    expect(ungroundedLiveFigure(webLookup, 'Giants 5-4.', evidence)).toBeUndefined();
  });

  it('reads a range followed by a degree sign as a temperature, not a scoreline', () => {
    const evidence = fetched('Final: Giants 5, Dodgers 2.');
    expect(
      ungroundedLiveFigure(webLookup, 'Giants won 5-2, and it will be 15-20°C.', evidence),
    ).toBeUndefined();
  });

  it('ignores ranges and dates that are not scorelines', () => {
    // These are the false positives that would make the rule unusable: a
    // computed range and a date are not claims about a retrieved figure.
    const evidence = fetched('The game is on.');
    expect(
      ungroundedLiveFigure(webLookup, 'Expect 10-15 minutes of delay.', evidence),
    ).toBeUndefined();
    expect(ungroundedLiveFigure(webLookup, 'Played on 2026-09-07.', evidence)).toBeUndefined();
  });

  it('stays out of requests that are not about a result', () => {
    const lookup = { kind: 'web', request: 'who is the president of Iceland' } as const;
    const evidence = fetched('Halla Tomasdottir is President.');
    expect(ungroundedLiveFigure(lookup, 'She won 34-2 in the vote.', evidence)).toBeUndefined();
  });

  it('blocks a temperature the weather data never returned', () => {
    const evidence = [
      { toolName: 'weather.lookup', status: 'succeeded', result: { tempF: 61, high: 66 } } as never,
    ];
    expect(ungroundedLiveFigure(weatherLookup, 'It is 72°F right now.', evidence)).toMatch(
      /does not contain 72/,
    );
  });

  it('accepts a temperature the weather data did return', () => {
    const evidence = [
      { toolName: 'weather.lookup', status: 'succeeded', result: { tempF: 61, high: 66 } } as never,
    ];
    expect(
      ungroundedLiveFigure(weatherLookup, 'It is 61°F, rising to 66 degrees.', evidence),
    ).toBeUndefined();
  });

  it('says nothing when no lookup succeeded, leaving that to the failure check', () => {
    const evidence = [{ toolName: 'web.fetch', status: 'failed', result: null } as never];
    expect(ungroundedLiveFigure(webLookup, 'Giants 7-3.', evidence)).toBeUndefined();
  });

  it('ignores evidence from an earlier task', () => {
    const evidence = [
      {
        toolName: 'web.fetch',
        status: 'succeeded',
        fromCurrentTask: false,
        result: { text: 'Giants 7, Cardinals 3' },
      } as never,
    ];
    expect(ungroundedLiveFigure(webLookup, 'Giants 7-3.', evidence)).toBeUndefined();
  });
});

describe('several live lookups in one request', () => {
  const ask = (content: string) => detectLiveLookups([{ role: 'user', content }]);
  const kinds = (content: string) => ask(content).map((lookup) => lookup.kind);

  it.each([
    ["What's the Giants score and the drive time to Oracle Park?", ['sports', 'directions']],
    [
      "What's the weather in Reykjavik tomorrow? Also, who won the Arsenal match?",
      ['weather', 'sports'],
    ],
    ['How long to drive to SFO, and what is the weather there tonight?', ['directions', 'weather']],
    ["What's the Giants score and the weather in San Francisco", ['sports', 'weather']],
  ])('finds every lookup in %s, in the order asked', (content, expected) => {
    expect(kinds(content)).toEqual(expected);
  });

  it('keeps each lookup scoped to its own clause', () => {
    expect(ask("What's the Giants score and the drive time to Oracle Park?")).toEqual([
      { kind: 'sports', request: "What's the Giants score?" },
      { kind: 'directions', request: 'the drive time to Oracle Park?' },
    ]);
  });

  it.each([
    "What's the Giants score?",
    'What is the Giants and Dodgers score?',
    'How is the weather today and should I bring a jacket?',
  ])('leaves a single-lookup request as the single lookup: %s', (content) => {
    const single = detectLiveLookup([{ role: 'user', content }]);
    expect(ask(content)).toEqual(single ? [single] : []);
  });

  it('does not read context in a second sentence as a second lookup', () => {
    const history = [
      { role: 'user', content: 'How is the weather going to be by work tomorrow?' },
      { role: 'assistant', content: 'Which address should I check the weather for?' },
      {
        role: 'user',
        content:
          'How is the weather going to be by work tomorrow? I work at 181 Fremont Street, San Francisco.',
      },
    ];
    expect(detectLiveLookups(history)).toEqual([detectLiveLookup(history)]);
  });

  it.each([
    "Don't look up the score and the weather",
    'Tell me a joke and then a story',
    "What's on my calendar tomorrow and do I have any emails from Sam?",
  ])('finds no live lookups in %s', (content) => {
    expect(ask(content)).toEqual([]);
  });

  it('keeps the public half of a question that is otherwise a private read', () => {
    expect(ask("What's on my calendar tomorrow and the Giants score?")).toEqual([
      { kind: 'sports', request: 'the Giants score?' },
    ]);
    expect(kinds("What's on my calendar tomorrow and what's the weather?")).toEqual(['weather']);
  });

  it('never turns a bare "look it up" clause into a search for those words', () => {
    expect(ask('Check my email from Sam and look it up')).toEqual([]);
  });

  it('does not treat a long list as questions to answer live', () => {
    expect(
      kinds('Weather in Paris? Weather in Rome? Weather in Oslo? Weather in Bern? Weather in Riga?')
        .length,
    ).toBeLessThanOrEqual(1);
  });

  const sports = { kind: 'sports', request: "What's the Giants score?" } as const;
  const directions = { kind: 'directions', request: 'the drive time to Oracle Park?' } as const;
  const scores = {
    toolName: 'sports.scores',
    status: 'succeeded' as const,
    result: { games: [{ line: 'Dodgers at Giants: 2-5, Final' }] },
  };
  const route = {
    toolName: 'maps.directions',
    status: 'succeeded' as const,
    result: { durationSeconds: 900, distanceMeters: 5200 },
  };

  it('runs each lookup in order until all are answered', () => {
    expect(nextLiveLookups([sports, directions], [])).toEqual({
      toolName: 'sports.scores',
      input: { team: 'Giants' },
      lookup: sports,
    });
    expect(nextLiveLookups([sports, directions], [scores])).toEqual({
      toolName: 'maps.directions',
      lookup: directions,
    });
    expect(nextLiveLookups([sports, directions], [scores, route])).toBeUndefined();
    expect(liveLookupFailures([sports, directions], [scores, route])).toEqual([]);
  });

  it('asks twice for two lookups of the same kind', () => {
    const paris = { kind: 'weather', request: 'weather in Paris?' } as const;
    const rome = { kind: 'weather', request: 'weather in Rome?' } as const;
    const reading = {
      toolName: 'weather.lookup',
      status: 'succeeded' as const,
      result: { tempC: 21 },
    };
    expect(nextLiveLookups([paris, rome], [reading])).toEqual({
      toolName: 'weather.lookup',
      lookup: rome,
    });
    expect(nextLiveLookups([paris, rome], [reading, reading])).toBeUndefined();
  });

  it("sends an unanswered sports lookup to the web without stealing the next lookup's evidence", () => {
    const empty = { ...scores, result: { games: [], error: 'No team matched' } };
    expect(nextLiveLookups([sports, directions], [empty])).toEqual({
      toolName: 'web.search',
      input: { query: sports.request, count: 5 },
      lookup: sports,
    });
    const search = {
      toolName: 'web.search',
      status: 'succeeded' as const,
      result: { results: [{ url: 'https://example.com/giants' }] },
    };
    const read = {
      toolName: 'web.fetch',
      status: 'succeeded' as const,
      result: { text: 'Giants 5, Dodgers 2' },
    };
    expect(attributeLookupEvidence([sports, directions], [empty, search, read, route])).toEqual([
      [empty, search, read],
      [route],
    ]);
    expect(nextLiveLookups([sports, directions], [empty, search, read, route])).toBeUndefined();
  });

  it('reports only the part whose lookup failed', () => {
    const noRoute = { ...route, result: { error: 'No route found' } };
    const failures = liveLookupFailures([sports, directions], [scores, noRoute]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.lookup).toBe(directions);
    expect(failures[0]?.failure).toMatch(/couldn't get a route/);
  });

  it('ignores evidence from an earlier task when attributing', () => {
    const stale = { ...scores, fromCurrentTask: false };
    expect(nextLiveLookups([sports, directions], [stale])).toEqual({
      toolName: 'sports.scores',
      input: { team: 'Giants' },
      lookup: sports,
    });
  });

  it('keeps a single lookup on the original path', () => {
    const uncovered = { ...scores, result: { games: [], error: 'No team matched' } };
    expect(nextLiveLookups([sports], [uncovered])).toEqual({
      ...nextLiveLookup(sports, [uncovered]),
      lookup: sports,
    });
    expect(liveLookupFailures([sports], [scores])).toEqual([]);
    expect(liveLookupFailure(sports, [scores])).toBeUndefined();
  });
});

describe('liveLookupDirective', () => {
  const context = { requestAt: new Date('2026-09-22T19:00:00Z'), timeZone: 'America/Los_Angeles' };
  const sports = { kind: 'sports', request: "What's the Giants score?" } as const;
  const directions = { kind: 'directions', request: 'the drive time to Oracle Park?' } as const;

  it('keeps the single-lookup wording unchanged', () => {
    expect(liveLookupDirective([sports], context)).toBe(
      `This request needs fresh sports evidence: What's the Giants score?\nUse a successful lookup from this task. Earlier assistant answers and recalled conversations are not current evidence. If a provider fails, report the gap; never invent measurements, scores, office holders, opening hours, player traits, or verified job openings. Search snippets locate sources; read the source before concluding. Resolve relative dates using the owner's request time 2026-09-22T19:00:00.000Z and timezone America/Los_Angeles.`,
    );
    expect(liveLookupDirective([], context)).toBe('');
  });

  it('tells the model a calendar trip already chose its event', () => {
    const trip = {
      kind: 'directions',
      request: 'How long to get to my 3pm?',
      destination: 'calendar',
    } as const;
    expect(liveLookupDirective([trip], context)).toContain(
      'never route to or suggest a different event',
    );
    expect(liveLookupDirective([sports, trip], context)).toContain('chose that event');
    expect(liveLookupDirective([sports, directions], context)).not.toContain('chose that event');
  });

  it('names every part, the one being fetched, and the ones that failed', () => {
    const text = liveLookupDirective([sports, directions], {
      ...context,
      next: directions,
      failures: [{ lookup: sports, failure: 'no scores' }],
    });
    expect(text).toContain('This request has 2 parts');
    expect(text).toContain("1. sports: What's the Giants score?");
    expect(text).toContain('2. directions: the drive time to Oracle Park?');
    expect(text).toContain('Look up this part now: the drive time to Oracle Park?');
    expect(text).toMatch(/sports lookup for "What's the Giants score\?" failed/);
    expect(text).toContain('never invent measurements, scores');
  });
});

describe('a trip to an event on the calendar', () => {
  const context = { now: new Date('2026-09-23T17:00:00Z'), timeZone: 'America/Los_Angeles' };
  const trip = (request: string) =>
    ({ kind: 'directions', request, destination: 'calendar' }) as const;
  const calendar = (events: Array<Record<string, unknown>>) => ({
    toolName: 'calendar.list_events',
    status: 'succeeded' as const,
    result: { events },
  });
  // 10:00 local is 17:00Z; 15:00 local is 22:00Z.
  const dentist = {
    summary: 'Dentist — Dr. Park',
    start: '2026-09-23T15:00:00-07:00',
    location: '450 Sutter St, San Francisco',
  };
  const standup = { summary: 'Team standup', start: '2026-09-23T11:30:00-07:00', location: '' };
  const lunch = {
    summary: 'Lunch with Sam',
    start: '2026-09-23T12:30:00-07:00',
    location: 'Tartine Manufactory',
  };
  const allDay = { summary: 'Offsite', start: '2026-09-23', location: 'Napa' };

  it.each([
    'How long to get to my 3pm?',
    'Directions to my 3pm',
    'When should I leave for my next meeting?',
    'How long will it take me to drive to my dentist appointment tomorrow?',
  ])('reads %s as a trip to a calendar event', (content) => {
    expect(detectLiveLookup([{ role: 'user', content }])).toEqual({
      kind: 'directions',
      request: content,
      destination: 'calendar',
    });
  });

  it.each(['Directions to Oracle Park', 'How long to drive to my 3 favorite bakeries?'])(
    'leaves %s as an ordinary trip',
    (content) => {
      expect(detectLiveLookup([{ role: 'user', content }])?.destination).toBeUndefined();
    },
  );

  it('reads the calendar first, then routes to the event, arriving by its start', () => {
    const lookup = trip('How long to get to my 3pm?');
    expect(nextLiveLookup(lookup, [], context)).toEqual({
      toolName: 'calendar.list_events',
      input: {
        timeMin: '2026-09-23T17:00:00.000Z',
        timeMax: '2026-09-25T05:00:00.000Z',
        maxResults: 50,
      },
    });
    const read = calendar([standup, lunch, dentist]);
    expect(nextLiveLookup(lookup, [read], context)).toEqual({
      toolName: 'maps.directions',
      input: { destination: '450 Sutter St, San Francisco', arriveBy: '2026-09-23T22:00:00.000Z' },
    });
    const route = {
      toolName: 'maps.directions',
      status: 'succeeded' as const,
      result: { durationSeconds: 1200 },
    };
    expect(nextLiveLookup(lookup, [read, route], context)).toBeUndefined();
    expect(liveLookupFailure(lookup, [read, route], context)).toBeUndefined();
  });

  it('does not turn an unsupported historical trip period into the default future window', () => {
    const lookup = trip('Directions to my dentist appointment 3 years ago');
    expect(nextLiveLookup(lookup, [], context)).toBeUndefined();
    expect(tripEvent(lookup, [calendar([dentist])], context)).toMatchObject({
      problem: expect.stringMatching(/can’t safely search that calendar period/i),
    });
  });

  it('binds the requested day before selecting a same-time appointment', () => {
    const tomorrow = {
      ...dentist,
      start: '2026-09-24T15:00:00-07:00',
      location: 'Tomorrow address',
    };
    const lookup = trip('Directions to my dentist appointment tomorrow');
    expect(nextLiveLookup(lookup, [], context)).toMatchObject({
      input: { timeMin: '2026-09-24T07:00:00.000Z', timeMax: '2026-09-25T07:00:00.000Z' },
    });
    expect(tripEvent(lookup, [calendar([dentist, tomorrow])], context).event?.location).toBe(
      'Tomorrow address',
    );
    expect(
      tripEvent(
        trip('Directions to my dentist appointment on 2026-09-26'),
        [calendar([dentist, { ...dentist, start: '2026-09-26T15:00:00-07:00' }])],
        context,
      ).event?.start,
    ).toBe('2026-09-26T15:00:00-07:00');
  });

  it('binds a weekday beyond the default 36-hour trip window', () => {
    const lookup = trip('Directions to my dentist appointment next Monday');
    const nextMonday = {
      ...dentist,
      start: '2026-09-28T15:00:00-07:00',
      location: 'Monday clinic',
    };
    const today = { ...dentist, location: 'Today clinic' };
    expect(nextLiveLookup(lookup, [], context)).toMatchObject({
      input: { timeMin: '2026-09-28T07:00:00.000Z', timeMax: '2026-09-29T07:00:00.000Z' },
    });
    expect(
      tripEvent(lookup, [calendar([today]), calendar([nextMonday])], context).event?.location,
    ).toBe('Monday clinic');
  });

  it('requires every significant word in a multiword event reference', () => {
    const lookup = trip('Directions to my annual dentist appointment');
    const unrelated = { ...dentist, summary: 'Annual review', location: 'Review room' };
    const partialToken = { ...dentist, summary: 'Annual dentisty review', location: 'Review room' };
    expect(tripEvent(lookup, [calendar([unrelated, partialToken])], context)).toMatchObject({
      problem: expect.stringMatching(/couldn't find your annual dentist appointment/i),
    });

    const actual = { ...dentist, summary: 'Annual dentist visit' };
    expect(tripEvent(lookup, [calendar([unrelated, actual])], context).event?.summary).toBe(
      'Annual dentist visit',
    );
  });

  it('binds same-title events on separate calendars to the requested civil day', () => {
    const lookup = trip('Directions to my dentist appointment tomorrow');
    const todayCopy = {
      ...dentist,
      start: '2026-09-23T09:00:00-07:00',
      end: '2026-09-23T11:00:00-07:00',
      location: 'Today clinic',
    };
    const tomorrowCopy = {
      ...dentist,
      start: '2026-09-24T15:00:00-07:00',
      location: 'Tomorrow clinic',
    };
    expect(
      tripEvent(lookup, [calendar([todayCopy]), calendar([tomorrowCopy])], context).event?.location,
    ).toBe('Tomorrow clinic');
  });

  it('chooses the later match when the owner explicitly asks for the next named event', () => {
    const lookup = trip('Directions to my next dentist appointment');
    const underway = {
      ...dentist,
      start: '2026-09-23T09:00:00-07:00',
      end: '2026-09-23T11:00:00-07:00',
    };
    const next = { ...dentist, start: '2026-09-23T15:00:00-07:00', location: 'Later clinic' };
    expect(
      tripEvent(lookup, [calendar([underway]), calendar([next])], context).event,
    ).toMatchObject({
      location: 'Later clinic',
    });
  });

  it('does not route to a later duplicate when the requested event is already underway', () => {
    const lookup = trip('Directions to my dentist appointment');
    const underway = {
      ...dentist,
      start: '2026-09-23T09:00:00-07:00',
      end: '2026-09-23T11:00:00-07:00',
    };
    const laterSameName = { ...dentist, start: '2026-09-23T15:00:00-07:00' };
    const evidence = [calendar([underway]), calendar([laterSameName])];

    expect(tripEvent(lookup, evidence, context)).toMatchObject({
      problem: expect.stringMatching(/already underway/i),
    });
    expect(nextLiveLookup(lookup, evidence, context)).toBeUndefined();
    expect(liveLookupFailure(lookup, evidence, context)).toMatch(/already underway/i);
  });

  it('selects the earliest next meeting across calendars after finished events', () => {
    const lookup = trip('When should I leave for my next meeting?');
    const finished = {
      ...dentist,
      summary: 'Planning meeting',
      start: '2026-09-23T09:00:00-07:00',
      end: '2026-09-23T09:30:00-07:00',
    };
    const later = {
      ...dentist,
      summary: 'Review meeting',
      start: '2026-09-23T13:00:00-07:00',
      location: 'Later office',
    };
    const earliest = {
      ...dentist,
      summary: 'Team meeting',
      start: '2026-09-23T11:00:00-07:00',
      location: 'First office',
    };

    const evidence = [calendar([finished, later]), calendar([earliest])];
    expect(tripEvent(lookup, evidence, context).event).toMatchObject({
      summary: 'Team meeting',
      location: 'First office',
    });
    expect(nextLiveLookup(lookup, evidence, context)).toMatchObject({
      toolName: 'maps.directions',
      input: { destination: 'First office', arriveBy: '2026-09-23T18:00:00.000Z' },
    });
  });

  it.each(['February 30', 'April 31'])(
    'does not replace an invalid named trip date %s with the default upcoming window',
    (date) => {
      const lookup = trip(`Directions to my dentist appointment on ${date}`);
      expect(nextLiveLookup(lookup, [], context)).toBeUndefined();
      expect(tripEvent(lookup, [calendar([dentist])], context)).toMatchObject({
        problem: expect.stringMatching(/calendar date is not valid/i),
      });
    },
  );

  it('does not route when multiple matching calendar events make the destination ambiguous', () => {
    const otherDentist = {
      ...dentist,
      summary: 'Dentist — Dr. Nguyen',
      location: 'Different clinic, San Francisco',
    };
    const lookup = trip('How long will it take to drive to my dentist appointment?');
    const evidence = [calendar([dentist, otherDentist])];

    expect(tripEvent(lookup, evidence, context)).toMatchObject({
      problem: expect.stringMatching(/more than one matching event/i),
    });
    expect(nextLiveLookup(lookup, evidence, context)).toBeUndefined();
  });

  it('does not choose a destination from incomplete calendar coverage', () => {
    const lookup = trip('How long will it take to drive to my dentist appointment?');
    const incomplete = {
      ...calendar([dentist]),
      result: { events: [dentist], complete: false, note: 'additional matching events exist' },
    };

    expect(tripEvent(lookup, [incomplete], context)).toMatchObject({
      problem: expect.stringMatching(/calendar coverage is incomplete/i),
    });
    expect(nextLiveLookup(lookup, [incomplete], context)).toBeUndefined();
  });

  it('rejects malformed explicit dates before reading or routing', () => {
    const lookup = trip('Directions to my dentist appointment on 2026-02-30');
    expect(nextLiveLookup(lookup, [], context)).toBeUndefined();
    expect(liveLookupFailure(lookup, [], context)).toMatch(/requested calendar date is not valid/i);
  });

  it('picks the event the request names', () => {
    const read = [calendar([allDay, standup, lunch, dentist])];
    const pick = (request: string) => tripEvent(trip(request), read, context);
    expect(pick('How long will it take to drive to my dentist appointment?').event?.summary).toBe(
      dentist.summary,
    );
    expect(pick('When should I leave for my lunch?').event?.summary).toBe(lunch.summary);
    expect(pick('Directions to my 12:30pm').event?.summary).toBe(lunch.summary);
    expect(pick('When should I leave for my next meeting?').problem).toMatch(
      /"Team standup" at 11:30\sAM has no location/,
    );
  });

  it('never routes to a different event than the one asked about', () => {
    const read = [calendar([lunch])];
    expect(tripEvent(trip('When should I leave for my flight?'), read, context).problem).toMatch(
      /couldn't find your flight on your calendar/,
    );
    expect(tripEvent(trip('How long to get to my 3pm?'), read, context).problem).toMatch(
      /couldn't find your 3pm/,
    );
    expect(nextLiveLookup(trip('How long to get to my 3pm?'), read, context)).toBeUndefined();
    expect(liveLookupFailure(trip('How long to get to my 3pm?'), read, context)).toMatch(
      /couldn't find your 3pm/,
    );
  });

  it('ignores events that already started or are beyond the window', () => {
    const past = { ...dentist, start: '2026-09-23T08:00:00-07:00' };
    const far = { ...dentist, start: '2026-09-26T15:00:00-07:00' };
    expect(
      tripEvent(
        trip('How long to get to my dentist appointment?'),
        [calendar([past, far])],
        context,
      ).problem,
    ).toMatch(/couldn't find/);
  });

  it('says so when the calendar could not be read', () => {
    const failed = { toolName: 'calendar.list_events', status: 'failed' as const, result: null };
    expect(liveLookupFailure(trip('How long to get to my 3pm?'), [failed], context)).toMatch(
      /couldn't read your calendar/,
    );
  });

  it("chains inside a compound question without taking the other part's evidence", () => {
    const lookups = detectLiveLookups([
      { role: 'user', content: "What's the Giants score and how long to get to my 3pm?" },
    ]);
    expect(lookups.map((lookup) => [lookup.kind, lookup.destination])).toEqual([
      ['sports', undefined],
      ['directions', 'calendar'],
    ]);
    const scores = {
      toolName: 'sports.scores',
      status: 'succeeded' as const,
      result: { games: [{ line: 'Dodgers at Giants: 2-5, Final' }] },
    };
    expect(nextLiveLookups(lookups, [scores], context)?.toolName).toBe('calendar.list_events');
    expect(nextLiveLookups(lookups, [scores, calendar([dentist])], context)?.input).toEqual({
      destination: '450 Sutter St, San Francisco',
      arriveBy: '2026-09-23T22:00:00.000Z',
    });
  });
});

describe('a trip to a generic airport', () => {
  const context = { now: new Date('2026-10-15T16:00:00Z'), timeZone: 'America/Los_Angeles' };
  const request = 'How long will it take me to get to the airport tomorrow?';
  const airportLookup = () => {
    const lookup = detectLiveLookup([{ role: 'user', content: request }]);
    if (!lookup) throw new Error('Expected a generic airport lookup');
    return lookup;
  };
  const range = {
    timeMin: '2026-10-16T07:00:00.000Z',
    timeMax: '2026-10-17T07:00:00.000Z',
  };
  const calendar = (
    events: Array<Record<string, unknown>>,
    options: {
      complete?: boolean;
      calendarRosterComplete?: boolean;
      pageToken?: string;
      nextPageToken?: string;
      extra?: Record<string, unknown>;
    } = {},
  ) => ({
    toolName: 'calendar.list_events',
    status: 'succeeded' as const,
    args: { ...range, ...(options.pageToken ? { pageToken: options.pageToken } : {}) },
    result: {
      events,
      complete: options.complete ?? true,
      calendarRosterComplete: options.calendarRosterComplete ?? true,
      ...(options.nextPageToken ? { nextPageToken: options.nextPageToken } : {}),
      ...options.extra,
    },
  });
  const returnFlight = {
    summary: 'Return flight to Europe',
    start: '2026-10-16T10:00:00+02:00',
    location: 'Berlin Brandenburg Airport',
  };

  it('reads the requested day before choosing a candidate and never routes on flight time alone', () => {
    const lookup = airportLookup();
    expect(lookup).toEqual({ kind: 'directions', request, airportIntent: true });
    expect(nextLiveLookup(lookup, [], context)).toEqual({
      toolName: 'calendar.list_events',
      input: {
        timeMin: '2026-10-16T07:00:00.000Z',
        timeMax: '2026-10-17T07:00:00.000Z',
        maxResults: 50,
      },
    });
    const read = calendar([returnFlight]);
    expect(nextLiveLookup(lookup, [read], context)).toBeUndefined();
    expect(liveLookupFailure(lookup, [read], context)).toBeUndefined();
  });

  it('does not select an airport from a flight title or from a multi-airport location', () => {
    const lookup = airportLookup();
    const titleOnly = { ...returnFlight, location: 'Berlin' };
    const multiAirport = {
      ...returnFlight,
      location: 'San Francisco International Airport to Berlin Brandenburg Airport',
    };
    for (const evidence of [calendar([titleOnly]), calendar([multiAirport])]) {
      const failure = liveLookupFailure(lookup, [evidence], context);
      expect(failure).toBeUndefined();
      expect(nextLiveLookup(lookup, [evidence], context)).toBeUndefined();
    }
  });

  it('fails closed when calendar coverage is incomplete or unavailable', () => {
    const lookup = airportLookup();
    expect(
      liveLookupFailure(lookup, [calendar([returnFlight], { complete: false })], context),
    ).toMatch(/coverage is incomplete/i);
    expect(liveLookupFailure(lookup, [], context)).toMatch(
      /couldn't read the requested calendar window/i,
    );
    expect(
      liveLookupFailure(
        lookup,
        [calendar([returnFlight], { calendarRosterComplete: false })],
        context,
      ),
    ).toMatch(/coverage is incomplete/i);
    expect(
      liveLookupFailure(
        lookup,
        [calendar([returnFlight], { extra: { paginationUnavailable: true } })],
        context,
      ),
    ).toMatch(/coverage is incomplete/i);
  });

  it('routes only with a unique explicit airport and the owner supplied origin and departure time', () => {
    for (const [content, origin] of [
      [
        'How long to get to the airport tomorrow from 123 Market Street, San Francisco, CA 94103, leaving at 8am?',
        '123 Market Street, San Francisco, CA 94103',
      ],
      [
        "How long to get to the airport tomorrow? I'm at 123 Market Street, San Francisco, CA 94103, leaving at 8am.",
        '123 Market Street, San Francisco, CA 94103',
      ],
    ]) {
      const lookup = detectLiveLookup([{ role: 'user', content }]);
      expect(lookup?.airportIntent).toBe(true);
      if (!lookup) throw new Error('Expected airport lookup');
      const candidate = {
        ...returnFlight,
        location: 'San Francisco International Airport, San Francisco, CA 94128, USA',
      };
      const result = nextLiveLookup(lookup, [calendar([candidate])], context);
      expect(result?.toolName).toBe('maps.directions');
      expect(result?.input).toMatchObject({
        origin,
        destination: candidate.location,
        departAt: '2026-10-16T15:00:00.000Z',
      });
      expect(result?.input).not.toHaveProperty('arriveBy');
    }
  });

  it.each([
    'How long to get to the airport tomorrow from home, leaving at 8am?',
    'How long to get to the airport tomorrow from my hotel, leaving at 8am?',
    'How long to get to the airport tomorrow from my hotel in Berlin, leaving at 8am?',
    'How long to get to the airport tomorrow from my home in Palo Alto, leaving at 8am?',
    'How long to get to the airport tomorrow from my apartment at 123 Main Street, leaving at 8am?',
    "How long to get to the airport tomorrow? I'm here, leaving at 8am.",
    'How long to get to the airport tomorrow from my current location, leaving at 8am?',
  ])('does not route from an unresolved deictic origin: %s', (content) => {
    const lookup = detectLiveLookup([{ role: 'user', content }]);
    if (!lookup) throw new Error('Expected airport lookup');
    const page = calendar([
      {
        ...returnFlight,
        location: 'San Francisco International Airport, San Francisco, CA 94128, USA',
      },
    ]);
    expect(nextLiveLookup(lookup, [page], context)).toBeUndefined();
    expect(liveLookupFailure(lookup, [page], context)).toBeUndefined();
  });

  it.each(['succeeded', 'failed', 'denied', 'proposed'])(
    'consumes one exact route attempt without silently retrying: %s',
    (status) => {
      const lookup = detectLiveLookup([
        {
          role: 'user',
          content:
            'How long to get to the airport tomorrow from 123 Market Street, leaving at 8am?',
        },
      ]);
      if (!lookup) throw new Error('Expected lookup');
      const pages = [calendar([returnFlight])];
      const input = nextLiveLookup(lookup, pages, context)?.input;
      if (!input) throw new Error('Expected grounded route input');
      const route = {
        toolName: 'maps.directions',
        status,
        args: { ...input, mode: 'driving' },
        result:
          status === 'succeeded' ? { durationSeconds: 1800 } : { error: 'Synthetic unavailable' },
      };
      expect(nextLiveLookup(lookup, [...pages, route], context)).toBeUndefined();
      const failure = liveLookupFailure(lookup, [...pages, route], context);
      if (status === 'succeeded') expect(failure).toBeUndefined();
      else expect(failure).toContain('confirmed airport, origin, and departure time');
    },
  );

  it.each(['origin', 'destination', 'departAt', 'arriveBy', 'mode', 'stale'])(
    'does not consume another route as the requested airport trip: %s',
    (mismatch) => {
      const lookup = detectLiveLookup([
        {
          role: 'user',
          content:
            'How long to get to the airport tomorrow from 123 Market Street, leaving at 8am?',
        },
      ]);
      if (!lookup) throw new Error('Expected lookup');
      const pages = [calendar([returnFlight])];
      const input = nextLiveLookup(lookup, pages, context)?.input;
      if (!input) throw new Error('Expected route');
      const args = {
        ...input,
        ...(mismatch === 'stale'
          ? {}
          : { [mismatch]: mismatch === 'mode' ? 'walking' : 'another value' }),
      };
      const route = {
        toolName: 'maps.directions',
        status: 'succeeded',
        args,
        result: { durationSeconds: 1800 },
        ...(mismatch === 'stale' ? { fromCurrentTask: false } : {}),
      };
      expect(nextLiveLookup(lookup, [...pages, route], context)).toMatchObject({
        toolName: 'maps.directions',
        input,
      });
    },
  );

  it('attributes every exact airport page fairly beside weather, retaining failure bounds and rejecting unrelated calendar scope', () => {
    const lookups = detectLiveLookups([
      {
        role: 'user',
        content:
          "What's the weather tomorrow and how long to get to the airport tomorrow from 123 Market Street, leaving at 8am?",
      },
    ]);
    expect(lookups.map((lookup) => lookup.kind)).toEqual(['weather', 'directions']);
    const weather = {
      toolName: 'weather.lookup',
      status: 'succeeded',
      result: { place: 'Harbor', current: { tempC: 20 } },
    };
    const first = calendar([], { complete: false, nextPageToken: 'second' });
    const second = calendar([returnFlight], { pageToken: 'second' });
    expect(nextLiveLookups(lookups, [weather, first], context)?.input?.pageToken).toBe('second');
    const next = nextLiveLookups(lookups, [weather, first, second], context);
    expect(next?.toolName).toBe('maps.directions');
    const route = {
      toolName: 'maps.directions',
      status: 'succeeded',
      args: next?.input,
      result: { durationSeconds: 1800 },
    };
    const unrelated = {
      ...calendar([returnFlight]),
      args: { ...range, timeMin: '2026-10-01T00:00:00Z' },
    };
    const shares = attributeLookupEvidence(
      lookups,
      [weather, first, unrelated, second, route],
      context,
    );
    expect(shares).toEqual([[weather], [first, second, route]]);
    expect(nextLiveLookups(lookups, [weather, first, second, route], context)).toBeUndefined();
    expect(liveLookupFailures(lookups, [weather, first, second, route], context)).toEqual([]);
    const failed = { ...first, status: 'failed', result: { error: 'Synthetic unavailable' } };
    expect(nextLiveLookups(lookups, [weather, failed, failed], context)).toBeUndefined();
    expect(liveLookupFailures(lookups, [weather, failed, failed], context)[0]?.failure).toContain(
      "couldn't read",
    );
    const incomplete = calendar([returnFlight], { calendarRosterComplete: false });
    expect(nextLiveLookups(lookups, [weather, incomplete, route], context)).toBeUndefined();
    expect(
      liveLookupFailures(lookups, [weather, incomplete, route], context)[0]?.failure,
    ).toContain('coverage is incomplete');
  });

  it.each([
    {
      now: '2026-10-31T16:00:00Z',
      start: '2026-11-01T07:00:00.000Z',
      end: '2026-11-02T08:00:00.000Z',
      event: '2026-11-01T18:00:00Z',
      clock: '1:30am',
    },
    {
      now: '2026-03-07T16:00:00Z',
      start: '2026-03-08T08:00:00.000Z',
      end: '2026-03-09T07:00:00.000Z',
      event: '2026-03-08T18:00:00Z',
      clock: '2:30am',
    },
  ])(
    'does not replace an ambiguous or nonexistent owner departure clock with a guessed instant: $clock',
    ({ now, start, end, event, clock }) => {
      const lookup = detectLiveLookup([
        {
          role: 'user',
          content: `How long to get to the airport tomorrow from 123 Market Street, leaving at ${clock}?`,
        },
      ]);
      if (!lookup) throw new Error('Expected lookup');
      const row = {
        ...calendar([{ ...returnFlight, start: event }]),
        args: { timeMin: start, timeMax: end },
      };
      const time = { now: new Date(now), timeZone: 'America/Los_Angeles' };
      expect(nextLiveLookup(lookup, [row], time)).toBeUndefined();
      expect(liveLookupFailure(lookup, [row], time)).toBeUndefined();
    },
  );

  it.each([
    'How long to get to the airport tomorrow from Home?',
    'How long to get to the airport tomorrow, leaving at 8am?',
  ])('does not broaden missing owner route details using another route: %s', (content) => {
    const lookup = detectLiveLookup([{ role: 'user', content }]);
    if (!lookup) throw new Error('Expected lookup');
    const other = {
      toolName: 'maps.directions',
      status: 'succeeded',
      args: {
        origin: 'Home',
        destination: 'Berlin Brandenburg Airport',
        departAt: '2026-10-16T15:00:00Z',
      },
      result: { durationSeconds: 1800 },
    };
    expect(nextLiveLookup(lookup, [calendar([returnFlight]), other], context)).toBeUndefined();
    expect(liveLookupFailure(lookup, [calendar([returnFlight]), other], context)).toBeUndefined();
  });

  it('does not choose between two explicit flight airports even when owner route details are complete', () => {
    const lookup = detectLiveLookup([
      {
        role: 'user',
        content: 'How long to get to the airport tomorrow from 123 Market Street, leaving at 8am?',
      },
    ]);
    if (!lookup) throw new Error('Expected lookup');
    const page = calendar([
      returnFlight,
      { ...returnFlight, location: 'Other International Airport' },
    ]);
    expect(nextLiveLookup(lookup, [page], context)).toBeUndefined();
  });

  it('carries details supplied after a clarification into the route request', () => {
    const lookup = detectLiveLookup([
      { role: 'user', content: request },
      {
        role: 'assistant',
        content:
          'Which airport are you going to, where will you start, and what time will you leave?',
      },
      { role: 'user', content: '123 Market Street, 8am.' },
    ]);
    expect(lookup?.airportIntent).toBe(true);
    if (!lookup) throw new Error('Expected continued airport lookup');
    const result = nextLiveLookup(lookup, [calendar([returnFlight])], context);
    expect(result?.toolName).toBe('maps.directions');
    expect(result?.input).toMatchObject({
      origin: '123 Market Street',
      departAt: '2026-10-16T15:00:00.000Z',
    });
  });

  it('waits for every page and rejects partial, stale, wrong-range, or restricted-calendar evidence', () => {
    const content =
      'How long to get to the airport tomorrow from 123 Market Street, leaving at 8am?';
    const lookup = detectLiveLookup([{ role: 'user', content }]);
    if (!lookup) throw new Error('Expected airport lookup');
    const first = calendar([], { complete: false, nextPageToken: 'page-2' });
    expect(nextLiveLookup(lookup, [first], context)).toEqual({
      toolName: 'calendar.list_events',
      input: { ...range, maxResults: 50, pageToken: 'page-2' },
    });
    const second = calendar([returnFlight], { pageToken: 'page-2' });
    const result = nextLiveLookup(lookup, [first, second], context);
    expect(result?.toolName).toBe('maps.directions');

    for (const incompleteFirstPage of [
      calendar([], { complete: false, calendarRosterComplete: false, nextPageToken: 'page-2' }),
      calendar([], {
        complete: false,
        nextPageToken: 'page-2',
        extra: { unavailable: ['Shared calendar'] },
      }),
      calendar([], {
        complete: false,
        nextPageToken: 'page-2',
        extra: { paginationUnavailable: true },
      }),
    ]) {
      expect(nextLiveLookup(lookup, [incompleteFirstPage, second], context)).toBeUndefined();
      expect(liveLookupFailure(lookup, [incompleteFirstPage, second], context)).toMatch(
        /coverage is incomplete/i,
      );
    }

    const wrongRange = {
      ...calendar([returnFlight]),
      args: { ...range, timeMin: '2026-10-15T07:00:00.000Z' },
    };
    const restricted = {
      ...calendar([returnFlight]),
      args: { ...range, calendarIds: ['primary'] },
    };
    const stale = { ...calendar([returnFlight]), fromCurrentTask: false };
    for (const evidence of [wrongRange, restricted, stale]) {
      expect(nextLiveLookup(lookup, [evidence], context)?.toolName).toBe('calendar.list_events');
    }
  });

  it.each([
    'How long to get to my airport tomorrow?',
    'How long to get to our airport tomorrow?',
    'How long to get to the airport tomorrow?',
  ])('keeps generic possessive airport references in the guarded path: %s', (content) => {
    expect(detectLiveLookup([{ role: 'user', content }])).toMatchObject({ airportIntent: true });
  });

  it('does not treat a terminal-only location or joined airport names as a unique route destination', () => {
    const lookup = airportLookup();
    for (const location of [
      'Terminal 2',
      'San Francisco Airport - Berlin Airport',
      'SFO Airport & Berlin Airport',
    ]) {
      expect(
        nextLiveLookup(lookup, [calendar([{ ...returnFlight, location }])], context),
      ).toBeUndefined();
    }
    expect(
      nextLiveLookup(
        lookup,
        [
          calendar([
            returnFlight,
            { ...returnFlight, summary: 'Outbound flight', start: '2026-10-16T15:00:00Z' },
          ]),
        ],
        context,
      ),
    ).toBeUndefined();
  });

  it.each([
    'Directions to SFO',
    'How long to get to SFO Airport tomorrow?',
    'Directions to the airport in Berlin tomorrow',
  ])('keeps explicitly named destinations on ordinary Maps routing: %s', (content) => {
    const namedLookup = detectLiveLookup([{ role: 'user', content }]);
    expect(namedLookup).toMatchObject({ kind: 'directions' });
    expect(namedLookup?.airportIntent).toBeUndefined();
    if (!namedLookup) throw new Error('Expected a directions lookup');
    expect(nextLiveLookup(namedLookup, [], context)).toEqual({
      toolName: 'maps.directions',
    });
  });

  it('leaves an event-bound trip unchanged', () => {
    expect(
      detectLiveLookup([{ role: 'user', content: 'How long to get to my 3pm tomorrow?' }]),
    ).toEqual({
      kind: 'directions',
      request: 'How long to get to my 3pm tomorrow?',
      destination: 'calendar',
    });
    expect(
      detectLiveLookup([{ role: 'user', content: 'How long to get to my flight tomorrow?' }]),
    ).toEqual({
      kind: 'directions',
      request: 'How long to get to my flight tomorrow?',
      airportIntent: true,
    });
  });
});
