import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  cardsReplaceProse,
  generatedFactRevealKey,
  ResponseCards,
  rendersAllCards,
  rendersSomeCards,
  responseCardPayloads,
} from './response-card.js';

describe('generated card icon fallback', () => {
  it.each(['future-icon', '__proto__', 'constructor', 'toString'])(
    'keeps the answer readable for an unrecognized icon %s',
    (icon) => {
      const markup = renderToStaticMarkup(
        <ResponseCards
          timeZone="UTC"
          cards={[
            {
              kind: 'generated-card',
              spec: {
                version: 1,
                title: 'Train platform',
                icon,
                facts: [{ id: 'platform', value: 'Platform four' }],
                blocks: [{ type: 'note', factId: 'platform' }],
                actions: [],
              },
            },
          ]}
        />,
      );
      expect(markup).toContain('Train platform');
      expect(markup).toContain('Platform four');
      expect(markup).toContain('lucide-sparkles');
    },
  );
});

describe('responseCardPayloads', () => {
  it('collects data-card payloads in order and ignores everything else', () => {
    const parts: unknown[] = [
      { type: 'text', text: 'Your day:' },
      { type: 'data-card', data: { kind: 'weather', id: 'w1', temperature: '11°C' } },
      { type: 'recall', sources: [] },
      { type: 'data-card', data: { kind: 'status', id: 's1', title: 'Email sent' } },
      { type: 'data-card' }, // no data — dropped
      'junk',
      null,
    ];
    expect(responseCardPayloads(parts).map((card) => card.id)).toEqual(['w1', 's1']);
  });

  it('drops zero-result Drive cards so they cannot become an empty out-of-context surface', () => {
    expect(
      responseCardPayloads([
        { type: 'data-card', data: { kind: 'drive-results', id: 'empty', files: [] } },
      ]),
    ).toEqual([]);
    expect(
      responseCardPayloads([
        {
          type: 'data-card',
          data: { kind: 'drive-results', id: 'found', files: [{ id: 'f1', name: 'Real.jpg' }] },
        },
      ]).map((card) => card.id),
    ).toEqual(['found']);
  });
});

describe('rendersAllCards', () => {
  it('uses an explicit capability matrix and requires meaningful specialized payloads', () => {
    const fact = { id: 'a', label: 'A', value: 'One' };
    const generated = (block: Record<string, unknown>) => ({
      kind: 'generated-card',
      spec: { version: 1, title: 'Ticket', facts: [fact], blocks: [block] },
    });
    for (const block of [
      { type: 'hero', titleFact: 'a' },
      { type: 'facts', factIds: ['a'] },
      { type: 'timeline', factIds: ['a'] },
      { type: 'note', factId: 'a' },
      { type: 'code', valueFact: 'a', format: 'text' },
    ])
      expect(rendersAllCards([generated(block)])).toBe(true);
    expect(
      rendersAllCards([
        { kind: 'weather', temperature: '18°C' },
        { kind: 'calendar-event', title: 'Lunch', start: '2026-10-07T12:00:00Z' },
        {
          kind: 'knowledge-graph',
          nodes: [
            { id: 'a', label: 'Person' },
            { id: 'b', label: 'Company' },
          ],
          edges: [{ from: 'a', to: 'b', label: 'works at' }],
        },
        {
          kind: 'calendar-conflicts',
          conflicts: [
            {
              overlapStart: '2026-10-07T12:00:00Z',
              overlapEnd: '2026-10-07T13:00:00Z',
              groups: [
                { events: [{ title: 'Lunch', start: '2026-10-07T12:00:00Z' }] },
                { events: [{ title: 'Call', start: '2026-10-07T12:30:00Z' }] },
              ],
            },
          ],
        },
        { kind: 'proactive-alert', title: 'Package arriving' },
      ]),
    ).toBe(true);
    expect(
      rendersAllCards([
        {
          kind: 'email-thread',
          messages: [{ id: 'm1', sender: 'Mira', excerpt: 'Plans attached' }],
        },
        { kind: 'sheet-rows', rows: [['a', 1]] },
        { kind: 'resource', title: 'Guide' },
      ]),
    ).toBe(true);
    expect(
      rendersAllCards([
        { kind: 'weather' },
        { kind: 'email-thread', messages: [] },
        { kind: 'route' },
      ]),
    ).toBe(false);
    expect(rendersAllCards([{ kind: 'something-newer' }])).toBe(false);
  });

  it('keeps prose and partial generated cards for unsupported v1 content and missing references', () => {
    const base = {
      kind: 'generated-card',
      spec: {
        version: 1,
        title: 'Mixed result',
        facts: [{ id: 'title', value: 'Train' }],
        blocks: [
          { type: 'hero', titleFact: 'title' },
          { type: 'metrics', factIds: ['title', 'missing'] },
        ],
      },
    };
    expect(rendersAllCards([base])).toBe(false);
    expect(rendersSomeCards([base])).toBe(true);
    expect(
      rendersAllCards([
        {
          kind: 'generated-card',
          spec: {
            version: 1,
            title: 'Section card',
            facts: [{ id: 'title', value: 'Train' }],
            blocks: [
              { type: 'section', title: 'Details', blocks: [{ type: 'hero', titleFact: 'title' }] },
            ],
          },
        },
      ]),
    ).toBe(true);
    expect(
      rendersSomeCards([
        { ...base, spec: { ...base.spec, blocks: [{ type: 'hero', titleFact: 'missing' }] } },
      ]),
    ).toBe(false);
  });

  it('records support for every current generated v1 block and rejects invalid references', () => {
    const facts = ['a', 'b', 'c', 'd'].map((id) => ({ id, value: id.toUpperCase() }));
    const sampleBlocks: Array<[string, Record<string, unknown>, boolean]> = [
      ['hero', { type: 'hero', titleFact: 'a' }, true],
      ['facts', { type: 'facts', factIds: ['a', 'b'] }, true],
      ['timeline', { type: 'timeline', factIds: ['a', 'b'] }, true],
      [
        'score',
        {
          type: 'score',
          leftLabelFact: 'a',
          leftValueFact: 'b',
          rightLabelFact: 'c',
          rightValueFact: 'd',
        },
        true,
      ],
      ['code', { type: 'code', valueFact: 'a', format: 'text' }, true],
      ['image', { type: 'image', urlFact: 'url', altFact: 'a' }, true],
      ['note', { type: 'note', factId: 'a' }, true],
      ['metrics', { type: 'metrics', factIds: ['a', 'b'] }, true],
      ['journey', { type: 'journey', mode: 'train', fromFact: 'a', toFact: 'b' }, true],
      ['progress', { type: 'progress', valueFact: 'a' }, true],
      ['stages', { type: 'stages', factIds: ['a', 'b'], currentFact: 'a' }, true],
      ['countdown', { type: 'countdown', dateFact: 'a' }, true],
      ['table', { type: 'table', columns: ['Name', 'Value'], rows: [['a', 'b']] }, true],
      [
        'chart',
        {
          type: 'chart',
          kind: 'bar',
          points: [
            { labelFact: 'a', valueFact: 'b' },
            { labelFact: 'c', valueFact: 'd' },
          ],
        },
        true,
      ],
      ['checklist', { type: 'checklist', factIds: ['a'] }, true],
      ['map', { type: 'map', placeFactIds: ['a'] }, false],
      [
        'section',
        { type: 'section', title: 'Details', blocks: [{ type: 'hero', titleFact: 'a' }] },
        true,
      ],
    ];
    for (const [type, block, supported] of sampleBlocks) {
      const extraFacts =
        type === 'image' ? [{ id: 'url', value: 'https://images.example/a.jpg' }] : [];
      const card = {
        kind: 'generated-card',
        spec: { version: 1, title: type, facts: [...facts, ...extraFacts], blocks: [block] },
      };
      expect(rendersAllCards([card]), type).toBe(supported);
    }
    const missingOptionalReference = {
      kind: 'generated-card',
      spec: {
        version: 1,
        title: 'No alt',
        facts: [{ id: 'url', value: 'https://images.example/a.jpg' }],
        blocks: [{ type: 'image', urlFact: 'url', altFact: 'missing' }],
      },
    };
    expect(rendersAllCards([missingOptionalReference])).toBe(false);
  });

  it('renders valid section blocks recursively while leaving unsupported section children prose-backed', () => {
    const supported = {
      kind: 'generated-card',
      spec: {
        version: 1,
        title: 'Journey',
        facts: [{ id: 'stop', label: 'Next stop', value: 'Oakland' }],
        blocks: [
          { type: 'section', title: 'Route', blocks: [{ type: 'facts', factIds: ['stop'] }] },
        ],
      },
    };
    expect(rendersAllCards([supported])).toBe(true);
    expect(renderToStaticMarkup(<ResponseCards cards={[supported]} timeZone="UTC" />)).toContain(
      'Oakland',
    );

    const partial = {
      ...supported,
      spec: {
        ...supported.spec,
        blocks: [
          {
            type: 'section',
            title: 'Route',
            blocks: [
              { type: 'facts', factIds: ['stop'] },
              { type: 'chart', kind: 'line', points: [] },
            ],
          },
        ],
      },
    };
    expect(rendersAllCards([partial])).toBe(false);
    expect(rendersSomeCards([partial])).toBe(true);
  });

  it('keeps cards with assistant actions prose-backed when submission is unavailable', () => {
    const card = {
      kind: 'generated-card',
      spec: {
        version: 1,
        title: 'Options',
        facts: [{ id: 'title', value: 'Train' }],
        blocks: [{ type: 'hero', titleFact: 'title' }],
        actions: [{ type: 'ask_assistant', prompt: 'Book this', label: 'Book' }],
      },
    };
    expect(rendersAllCards([card])).toBe(false);
    expect(rendersAllCards([card], { onSendAvailable: false })).toBe(false);
    expect(rendersAllCards([card], { onSendAvailable: true })).toBe(true);
  });

  it('keeps prose when lookup cards are mixed with answer-derived or accompanying cards', () => {
    expect(
      cardsReplaceProse([
        { kind: 'status', grounding: 'answer' },
        { kind: 'status', grounding: 'evidence' },
      ]),
    ).toBe(false);
    expect(
      cardsReplaceProse([
        { kind: 'scoreboard', accompaniesProse: true },
        { kind: 'status', grounding: 'evidence' },
      ]),
    ).toBe(false);
  });
});

describe('WEB14 specialized card admission', () => {
  const event = (title = 'Lunch') => ({ title, start: '2026-10-07T12:00:00Z' });
  const game = {
    id: 'game-1',
    league: 'mlb',
    state: 'post',
    statusText: 'Final',
    home: { name: 'Giants', score: '3' },
    away: { name: 'Dodgers', score: '2' },
  };
  const validCards: Array<[string, Record<string, unknown>]> = [
    [
      'route',
      {
        kind: 'route',
        origin: { label: 'Oakland' },
        destination: { label: 'Sacramento' },
        durationSeconds: 3600,
        distanceMeters: 120000,
        mode: 'driving',
      },
    ],
    ['scoreboard', { kind: 'scoreboard', games: [game] }],
    ['weather', { kind: 'weather', location: 'Oakland', temperature: '18°C', condition: 'Clear' }],
    ['calendar', { kind: 'calendar', items: [{ day: 'Today', time: '12 PM', title: 'Lunch' }] }],
    ['agenda', { kind: 'agenda', items: [{ time: '12 PM', title: 'Lunch' }] }],
    ['calendar-day', { kind: 'calendar-day', events: [event()] }],
    [
      'briefing',
      {
        kind: 'briefing',
        lead: 'A clear day ahead.',
        sections: [
          {
            type: 'agenda',
            title: 'Schedule',
            items: [{ day: 'Today', time: '12 PM', title: 'Lunch' }],
          },
          { type: 'weather', title: 'Weather', temperature: '18°C', condition: 'Clear' },
          { type: 'mail', title: 'Inbox', items: [{ title: 'Reply to Mira' }] },
        ],
      },
    ],
    ['calendar-event', { kind: 'calendar-event', ...event() }],
    ['email-results', { kind: 'email-results', messages: [{ sender: 'Mira', subject: 'Plans' }] }],
    [
      'email-thread',
      {
        kind: 'email-thread',
        subject: 'Plans',
        messages: [{ sender: 'Mira', excerpt: 'Attached' }],
      },
    ],
    ['sheet-rows', { kind: 'sheet-rows', sheetName: 'Budget', rows: [['Rent', 1200]] }],
    ['resource', { kind: 'resource', resourceType: 'document', title: 'Trip notes' }],
    [
      'web-search-results',
      { kind: 'web-search-results', results: [{ title: 'Source', url: 'https://example.com' }] },
    ],
    [
      'availability',
      { kind: 'availability', complete: true, calendarsChecked: ['Work'], busy: [] },
    ],
    ['status', { kind: 'status', title: 'Saved', detail: 'Changes are ready.' }],
    ['reminder', { kind: 'reminder', title: 'Call Mira' }],
    [
      'drive-results',
      {
        kind: 'drive-results',
        files: [{ name: 'Notes', url: 'https://drive.google.com/file/d/1' }],
      },
    ],
    [
      'document-results',
      {
        kind: 'document-results',
        passages: [{ document: 'Trip notes', snippet: 'Train leaves at noon.' }],
      },
    ],
    [
      'knowledge-graph',
      {
        kind: 'knowledge-graph',
        nodes: [
          { id: 'a', label: 'Mira' },
          { id: 'b', label: 'Acme' },
        ],
        edges: [{ from: 'a', to: 'b', label: 'works at' }],
      },
    ],
    [
      'calendar-conflicts',
      {
        kind: 'calendar-conflicts',
        conflicts: [
          {
            overlapStart: '2026-10-07T12:00:00Z',
            overlapEnd: '2026-10-07T13:00:00Z',
            groups: [{ events: [event('Lunch')] }, { events: [event('Call')] }],
          },
        ],
      },
    ],
    ['proactive-alert', { kind: 'proactive-alert', title: 'Package arriving', summary: 'Today' }],
  ];

  it.each(validCards)('admits complete %s cards only from their rendered fields', (_kind, card) => {
    expect(rendersAllCards([card])).toBe(true);
    expect(rendersSomeCards([card])).toBe(true);
  });

  const invalidCards: Array<[string, Record<string, unknown>, boolean]> = [
    [
      'route',
      {
        kind: 'route',
        origin: { label: 'Oakland' },
        destination: { label: 'Sacramento' },
        durationSeconds: 'unknown',
        distanceMeters: null,
      },
      true,
    ],
    ['scoreboard', { kind: 'scoreboard', games: [{}] }, false],
    ['weather', { kind: 'weather', summary: 'Sunny later' }, false],
    ['calendar', { kind: 'calendar', items: [{}] }, false],
    ['agenda', { kind: 'agenda', items: [{ title: 'Lunch' }] }, false],
    [
      'calendar-day',
      { kind: 'calendar-day', events: [{ title: 'Lunch', start: 'not-a-date' }] },
      false,
    ],
    [
      'briefing',
      { kind: 'briefing', sections: [{ type: 'future', title: 'Later', items: [{}] }] },
      true,
    ],
    ['calendar-event', { kind: 'calendar-event', title: 'Lunch', start: 'not-a-date' }, false],
    ['email-results', { kind: 'email-results', messages: [{}] }, false],
    ['email-thread', { kind: 'email-thread', messages: [{ id: 'm1' }] }, false],
    ['sheet-rows', { kind: 'sheet-rows', rows: [[]] }, false],
    ['resource', { kind: 'resource', content: 'This legacy field is not rendered.' }, false],
    ['web-search-results', { kind: 'web-search-results', results: [{}] }, false],
    [
      'availability',
      {
        kind: 'availability',
        complete: true,
        calendarsChecked: [],
        busy: [{ start: 'bad', end: 'also bad' }],
      },
      true,
    ],
    ['status', { kind: 'status', details: [{}] }, false],
    ['reminder', { kind: 'reminder', message: 'This field is not rendered.' }, false],
    ['drive-results', { kind: 'drive-results', files: [{}] }, false],
    [
      'document-results',
      { kind: 'document-results', documents: [{ title: 'Ignored alias' }] },
      false,
    ],
    [
      'knowledge-graph',
      { kind: 'knowledge-graph', relationships: [{ subject: 'Mira', predicate: 'works at' }] },
      false,
    ],
    [
      'calendar-conflicts',
      { kind: 'calendar-conflicts', conflicts: [{ title: 'Overlap' }] },
      false,
    ],
    ['proactive-alert', { kind: 'proactive-alert', message: 'This field is not rendered.' }, false],
  ];

  it.each(invalidCards)(
    'keeps prose for empty, malformed, or unrendered %s data',
    (_kind, card, partialVisible) => {
      expect(rendersAllCards([card])).toBe(false);
      expect(rendersSomeCards([card])).toBe(partialVisible);
    },
  );

  it('preserves visible valid rows and the prose answer when a sibling row is malformed', () => {
    const partial = {
      kind: 'email-results',
      messages: [{ sender: 'Mira', subject: 'Plans for Friday' }, { id: 'empty-row' }],
    };
    const cards = [partial];
    expect(rendersSomeCards(cards)).toBe(true);
    expect(rendersAllCards(cards)).toBe(false);
    // This is the same two-gate decision chat-log uses: a drawable partial
    // preview does not become a replacement answer.
    const richAnswer = rendersAllCards(cards) && cardsReplaceProse(cards);
    expect(richAnswer).toBe(false);
    const html = renderToStaticMarkup(<ResponseCards cards={cards} timeZone="UTC" />);
    expect(html).toContain('Plans for Friday');
    expect(html).not.toContain('Unknown sender');
  });

  it('keeps supported cards in a mixed message and omits an empty specialized sibling', () => {
    const cards = [
      { kind: 'weather', temperature: '18°C', condition: 'Clear' },
      { kind: 'drive-results', files: [{}] },
    ];
    expect(rendersSomeCards(cards)).toBe(true);
    expect(rendersAllCards(cards)).toBe(false);
    const html = renderToStaticMarkup(<ResponseCards cards={cards} timeZone="UTC" />);
    expect(html).toContain('18°C');
    expect(html).not.toContain('Drive files');
  });

  it('rejects malformed child rows across list-backed kinds while retaining good siblings', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        'weather details',
        {
          kind: 'weather',
          temperature: '18°C',
          details: [{ label: 'Wind', value: '10 km/h' }, null],
        },
      ],
      ['agenda items', { kind: 'agenda', items: [{ time: '12 PM', title: 'Lunch' }, {}] }],
      [
        'calendar events',
        { kind: 'calendar-day', events: [event(), { title: 'Broken', start: 'bad' }] },
      ],
      ['search results', { kind: 'web-search-results', results: [{ title: 'Source' }, {}] }],
      ['sheet rows', { kind: 'sheet-rows', rows: [['Rent', 1200], []] }],
      [
        'graph edges',
        {
          kind: 'knowledge-graph',
          nodes: [
            { id: 'a', label: 'Mira' },
            { id: 'b', label: 'Acme' },
          ],
          edges: [{ from: 'a', to: 'b', label: 'works at' }, {}],
        },
      ],
      [
        'conflict rows',
        {
          kind: 'calendar-conflicts',
          conflicts: [
            {
              overlapStart: '2026-10-07T12:00:00Z',
              overlapEnd: '2026-10-07T13:00:00Z',
              groups: [{ events: [event()] }, { events: [event('Call')] }],
            },
            {},
          ],
        },
      ],
    ];
    for (const [label, card] of cases) {
      expect(rendersAllCards([card]), label).toBe(false);
      expect(rendersSomeCards([card]), label).toBe(true);
    }
  });
});

describe('ResponseCards', () => {
  it('separates calendar coverage from attendance and preserves occurrence evidence', () => {
    const html = renderToStaticMarkup(
      <ResponseCards
        cards={[
          {
            kind: 'calendar-conflicts',
            title: 'Possible schedule conflict',
            complete: false,
            conflicts: [
              {
                id: 'one',
                overlapStart: '2026-10-07T19:00:00Z',
                overlapEnd: '2026-10-07T20:00:00Z',
                evidenceNote: 'Keep the earlier arrival time; source identity is unverified.',
                groups: [
                  {
                    events: [
                      {
                        id: 'a',
                        title: 'Arrival',
                        start: '2026-10-07T18:15:00Z',
                        end: '2026-10-07T20:00:00Z',
                        calendar: 'Family',
                      },
                      {
                        id: 'b',
                        title: 'Kickoff',
                        start: '2026-10-07T19:00:00Z',
                        end: '2026-10-07T20:00:00Z',
                        calendar: 'Team',
                      },
                    ],
                  },
                  {
                    events: [
                      {
                        id: 'c',
                        title: 'Other event',
                        start: '2026-10-07T19:30:00Z',
                        end: '2026-10-07T20:30:00Z',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ]}
        timeZone="UTC"
      />,
    );
    expect(html).toContain('Keep the earlier arrival time');
    expect(html).toContain('Some calendars could not be checked');
    expect(html).toContain('Arrival');
    expect(html).toContain('Kickoff');
  });
  const render = (card: Record<string, unknown>) =>
    renderToStaticMarkup(<ResponseCards cards={[card]} timeZone="UTC" />);

  it('does not describe incomplete or malformed calendar coverage as free', () => {
    for (const complete of [false, undefined]) {
      const html = render({ kind: 'availability', complete, busy: [], calendarsChecked: [] });
      expect(html).toContain('incomplete or unknown');
      expect(html).not.toContain('the remaining time in this window is free');
      expect(html).not.toContain('Nothing on the calendar');
    }
    expect(rendersSomeCards([{ kind: 'availability', complete: false, busy: [] }])).toBe(true);
    expect(rendersAllCards([{ kind: 'availability', complete: false, busy: [] }])).toBe(false);
    const full = render({
      kind: 'availability',
      complete: true,
      busy: [],
      calendarsChecked: ['Work'],
    });
    expect(full).toContain('No busy blocks were found in this checked window');
    expect(full).toContain('the remaining time in this window is free');
    const partial = render({
      kind: 'availability',
      complete: false,
      calendarsChecked: ['Work', 'Family'],
      busy: [{ start: '2026-10-07T09:00:00Z', end: '2026-10-07T10:00:00Z', calendar: 'Work' }],
    });
    expect(partial).toContain('incomplete');
    expect(partial).toContain('role="status"');
    expect(partial).toContain('aria-live="polite"');
    expect(partial).not.toContain('remaining time in this window is free');
    expect(partial).toContain('Oct 7, 2026');
    const completeBusy = render({
      kind: 'availability',
      complete: true,
      calendarsChecked: ['Work'],
      busy: [{ start: '2026-10-07T09:00:00Z', end: '2026-10-07T10:00:00Z' }],
    });
    expect(completeBusy).toContain('remaining time in this window is free');
    for (const calendarsChecked of [[], ['  ', '']]) {
      const unsubstantiated = render({
        kind: 'availability',
        complete: true,
        calendarsChecked,
        busy: [],
      });
      expect(unsubstantiated).toContain('incomplete or unknown');
      expect(unsubstantiated).not.toContain('the remaining time in this window is free');
    }
    const unknownBusy = render({
      kind: 'availability',
      busy: [{ start: '2026-10-07T09:00:00Z', end: '2026-10-07T10:00:00Z' }],
    });
    expect(unknownBusy).toContain('incomplete');
    expect(unknownBusy).not.toContain('remaining time in this window is free');
    const malformed = render({
      kind: 'availability',
      complete: true,
      calendarsChecked: ['Work'],
      busy: [
        'discarded-row',
        { start: 'not-a-date', end: '2026-10-07T10:00:00Z' },
        { start: '2026-10-07T09:00:00Z', end: '2026-10-07T08:00:00Z' },
      ],
    });
    expect(malformed).toContain('incomplete');
    expect(malformed).toContain('malformed');
    expect(malformed).not.toContain('the remaining time in this window is free');

    for (const malformedBusy of [null, 'none', { start: '2026-10-07T09:00:00Z' }]) {
      const unknownShape = render({
        kind: 'availability',
        complete: true,
        calendarsChecked: ['Work'],
        busy: malformedBusy,
      });
      expect(unknownShape).toContain('incomplete or unknown');
      expect(unknownShape).toContain('Unlisted time is unknown');
      expect(unknownShape).not.toContain('remaining time in this window is free');
    }
  });

  it('qualifies availability intervals with dates across multiple days', () => {
    const html = render({
      kind: 'availability',
      complete: true,
      busy: [{ start: '2026-10-07T23:30:00Z', end: '2026-10-08T00:30:00Z' }],
    });
    expect(html).toContain('Oct 7, 2026');
    expect(html).toContain('Oct 8, 2026');
  });

  it('projects sensitive facts consistently across chrome, image requests, links and copy actions', () => {
    const secret = 'BOOKING-SECRET-4821';
    const html = render({
      kind: 'generated-card',
      revisionId: 'rev-1',
      spec: {
        version: 1,
        title: `Booking ${secret}`,
        subtitle: secret,
        sourceLabel: `Reference ${secret}`,
        accessibilityLabel: `Card ${secret}`,
        facts: [
          { id: 'code', label: 'Booking reference', value: secret, sensitive: true },
          {
            id: 'image-url',
            label: 'Private image URL',
            value: `https://images.example/photo.jpg?token=${secret}`,
          },
        ],
        blocks: [
          { type: 'hero', titleFact: 'code' },
          { type: 'image', urlFact: 'image-url', altFact: 'code' },
          { type: 'code', valueFact: 'code', format: 'text' },
        ],
        actions: [
          { id: 'open', type: 'open_url', factId: 'image-url', label: 'Open private link' },
          { id: 'copy', type: 'copy_value', factId: 'code', label: 'Copy booking reference' },
        ],
      },
    });
    expect(html).not.toContain(secret);
    expect(html).not.toContain('token=');
    expect(html).not.toContain('/api/card-image');
    expect(html).toContain('Image withheld because its source or description is private');
    expect(html).toContain('Reveal Open private link');
    expect(html).toContain('Reveal to copy Booking reference');
    expect(html).toContain('Tap to reveal');
  });

  it('resets a revealed fact key when a refresh changes the value under the same ID', () => {
    expect(generatedFactRevealKey('r1', 'pin', '1234')).not.toBe(
      generatedFactRevealKey('r2', 'pin', '5678'),
    );
    expect(generatedFactRevealKey('r1', 'pin', '1234')).not.toBe(
      generatedFactRevealKey('r1', 'pin', '5678'),
    );
  });

  it('renders historical UTC and offset calendar timestamps in one owner timezone', () => {
    const html = renderToStaticMarkup(
      <ResponseCards
        timeZone="America/Los_Angeles"
        cards={[
          {
            kind: 'calendar-event',
            id: 'utc',
            title: 'Family game',
            start: '2026-09-19T22:00:00Z',
            end: '2026-09-20T00:20:00Z',
            time: '10:00 PM–12:20 AM',
          },
          {
            kind: 'calendar-event',
            id: 'offset',
            title: 'Team game',
            start: '2026-09-19T15:45:00-07:00',
            end: '2026-09-19T17:00:00-07:00',
            time: '3:45 PM–5:00 PM',
          },
        ]}
      />,
    );
    expect(html).toContain('Saturday, Sep 19');
    expect(html).toContain('3:00 PM–5:20 PM');
    expect(html).toContain('3:45 PM–5:00 PM');
    expect(html).not.toContain('10:00 PM');
  });

  it('keeps all-day calendar dates on their actual day west of UTC', () => {
    const html = renderToStaticMarkup(
      <ResponseCards
        timeZone="America/Los_Angeles"
        cards={[
          {
            kind: 'calendar-event',
            id: 'birthday',
            title: 'Birthday',
            start: '2026-09-18',
            end: '2026-09-19',
            allDay: true,
          },
        ]}
      />,
    );
    expect(html).toContain('Friday, Sep 18');
    expect(html).toContain('All day');
    expect(html).not.toContain('Thursday, Sep 17');
  });

  it('preserves the date and label of an explicit all-day timestamp card', () => {
    const html = renderToStaticMarkup(
      <ResponseCards
        timeZone="America/Los_Angeles"
        cards={[
          {
            kind: 'calendar-event',
            id: 'day',
            title: 'Day off',
            allDay: true,
            start: '2026-09-18T00:00:00Z',
            end: '2026-09-19T00:00:00Z',
            time: '5:00 PM',
          },
        ]}
      />,
    );
    expect(html).toContain('Friday, Sep 18');
    expect(html).toContain('All day');
    expect(html).not.toContain('Thursday, Sep 17');
    expect(html).not.toContain('5:00 PM');
  });

  it('groups a weather card by day and keeps the current metrics above them', () => {
    const html = render({
      kind: 'weather',
      id: 'w1',
      location: 'Reykjavík',
      condition: 'overcast',
      temperature: '14–17°C',
      symbol: 'cloudy',
      details: [
        { label: 'Day', value: 'Thu' },
        { label: 'Rain chance', value: '1%', symbol: 'cloudy' },
        { label: 'Thu Morning', value: '08:00–11:00 · 9–11°C, fog', symbol: 'fog' },
        { label: 'Thu Evening', value: '17:00–21:00 · 10–12°C, clear', symbol: 'clear' },
        { label: 'Fri', value: '11–15°C, light rain, 80% chance of rain', symbol: 'rain' },
      ],
    });

    // Each band reads under its day, with the day named once.
    expect(html).toContain('Morning');
    expect(html).toContain('Evening');
    expect(html).toContain('08:00–11:00 · 9–11°C, fog');
    expect(html).toContain('11–15°C, light rain, 80% chance of rain');
    // The day the card is about is its caption, never a metric row.
    expect(html).toContain('Thu');
    expect(html).not.toContain('>Day<');
    // Both bands hang off one Thu heading rather than repeating the day per
    // row, and Fri opens its own.
    const headings = html.match(/capitalize">([^<]+)</g) ?? [];
    expect(headings).toEqual(['capitalize">Thu<', 'capitalize">Fri<']);
  });

  it('draws numeric forecast days as single-line rows instead of text rows', () => {
    const html = render({
      kind: 'weather',
      id: 'w5',
      location: 'San Francisco',
      condition: 'partly cloudy',
      temperature: '18°C',
      current: { tempC: 18, windKmh: 18, humidity: 70, precipPct: 40 },
      days: [
        {
          weekday: 'Today',
          lowC: 14,
          highC: 21,
          precipPct: 40,
          description: 'partly cloudy',
          symbol: 'partly-cloudy',
        },
        {
          weekday: 'Wed',
          lowC: 12,
          highC: 17,
          precipPct: 80,
          description: 'light rain',
          symbol: 'rain',
        },
        { weekday: 'Thu', lowC: 11, highC: 19, description: 'overcast', symbol: 'cloudy' },
      ],
      details: [
        { label: 'Today', value: '14–21°C' },
        { label: 'Wind', value: '18 km/h' },
        { label: 'Wed', value: '12–17°C, light rain, 80% chance of rain', symbol: 'rain' },
      ],
    });
    expect(html.match(/whitespace-nowrap tabular-nums/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Wed, light rain, low 12°, high 17°, 80% chance of rain"');
    // Under 30% the rain column stays empty rather than printing noise.
    expect(html).toContain('aria-label="Thu, overcast, low 11°, high 19°"');
    // The text copy of the same days is not drawn a second time.
    expect(html).not.toContain('12–17°C, light rain, 80% chance of rain');
    expect(html).toContain('18 km/h');
  });

  it('renders the briefing as a lead and labelled sections, not a wall of text', () => {
    const card = {
      kind: 'briefing',
      id: 'b1',
      date: 'Tuesday, Sep 22',
      timeZone: 'America/Los_Angeles',
      lead: 'Two overlapping events this morning; one approval waiting.',
      sections: [
        {
          type: 'agenda',
          title: 'Schedule',
          complete: true,
          items: [
            {
              day: 'Today',
              time: '9:30 AM – 10:30 AM',
              title: 'Dentist',
              flag: 'conflict',
              note: 'Overlaps another event',
            },
            { day: 'Tomorrow', time: 'All day', title: 'Offsite' },
          ],
        },
        {
          type: 'weather',
          title: 'Weather',
          location: 'SF',
          temperature: '18°C',
          condition: 'overcast',
          range: '14–21°C',
        },
        {
          type: 'attention',
          title: 'Needs you',
          items: [{ title: 'Fetch public web page', meta: 'A128DY' }],
        },
      ],
    };
    expect(rendersAllCards([card])).toBe(true);
    const html = render(card);
    expect(html).toContain('Briefing · Tuesday, Sep 22');
    expect(html).toContain('Two overlapping events this morning');
    expect(html.match(/<h3[^>]*>(Today|Tomorrow|Weather|Needs you)<\/h3>/g)).toHaveLength(4);
    expect(html).toContain('Overlaps another event');
    expect(html).toContain('A128DY');
    expect(html).toContain('14–21°C');
  });

  it('draws each sky with its own icon and falls back for an unknown one', () => {
    const svgs = (html: string) => html.match(/class="lucide[^"]*"/g) ?? [];
    const rain = svgs(
      render({
        kind: 'weather',
        id: 'w2',
        temperature: '9°C',
        symbol: 'rain',
        details: [{ label: 'Sat', value: '2–4°C, heavy snow', symbol: 'snow' }],
      }),
    ).join(' ');
    expect(rain).toContain('cloud-rain');
    expect(rain).toContain('cloud-snow');

    // A payload from before symbols existed, and one naming a sky this build
    // does not know, both keep the glyph this card has always used.
    for (const card of [
      { kind: 'weather', id: 'w3', temperature: '9°C', details: [{ label: 'Sat', value: 'mild' }] },
      { kind: 'weather', id: 'w4', temperature: '9°C', symbol: 'meteor-shower', details: [] },
    ]) {
      expect(svgs(render(card)).join(' ')).toContain('cloud-sun');
    }
  });

  it('reformats the historical inline numbered calendar reply as an agenda', () => {
    const cards = responseCardPayloads([
      {
        type: 'text',
        text: 'Tomorrow has two upcoming events: 1) Coffee with Tine at 9:00 AM at Home Coffee Roasters. 2) Technical interviews with Clay from 1:00-2:00 PM.',
      },
    ]);
    expect(cards).toMatchObject([
      {
        kind: 'agenda',
        title: 'Tomorrow',
        items: [
          { time: '9:00 AM', title: 'Coffee with Tine', detail: 'Home Coffee Roasters' },
          { time: '1:00-2:00 PM', title: 'Technical interviews with Clay' },
        ],
      },
    ]);
    const html = renderToStaticMarkup(<ResponseCards cards={cards} timeZone="UTC" />);
    expect(html).toContain('2 upcoming events');
    expect(html).not.toContain('Tomorrow has two');
  });

  it('reformats the historical starts-in notice without exposing salience diagnostics', () => {
    const cards = responseCardPayloads([
      {
        type: 'text',
        text: '"Annual Physical" starts in 30 minutes at One Medical, 559 Clay St. it is at One Medical, 559 Clay St; family@example.com called it.',
      },
    ]);
    expect(cards).toMatchObject([
      {
        kind: 'proactive-alert',
        urgencyLabel: 'Starts in 30 min',
        title: 'Annual Physical',
        details: [{ label: 'Location', value: 'One Medical, 559 Clay St' }],
      },
    ]);
    expect(JSON.stringify(cards)).not.toContain('called it');
  });

  it('keeps ordinary numbered prose as prose', () => {
    expect(
      responseCardPayloads([
        { type: 'text', text: 'Try these: 1) Bring water. 2) Leave a little early.' },
      ]),
    ).toEqual([]);
  });

  it('groups calendar event payloads into one day schedule', () => {
    const html = renderToStaticMarkup(
      <ResponseCards
        timeZone="America/Los_Angeles"
        cards={[
          {
            kind: 'calendar-event',
            id: 'e1',
            start: '2026-09-02T09:00:00-07:00',
            time: '9:00 AM–10:00 AM',
            title: 'Coffee with Tine',
          },
          {
            kind: 'calendar-event',
            id: 'e2',
            start: '2026-09-02T13:00:00-07:00',
            time: '1:00 PM–2:00 PM',
            title: 'Technical interviews',
          },
        ]}
      />,
    );
    expect(html).toContain('Wednesday, Sep 2 · 2 events');
    expect(html.match(/paper/g)?.length).toBe(1);
    expect(html).toContain('data-response-card="true"');
    expect(html).toContain('<header');
    expect(html).toContain('Coffee with Tine');
    expect(html).toContain('Technical interviews');
  });

  it('omits confidence entirely when the payload carries none', () => {
    // NaN in the producer serialises to null, and Number(null) is 0 — a
    // provenance card must not report an unknown confidence as a measured 0%.
    const html = render({
      kind: 'knowledge-graph',
      id: 'k1',
      edges: [{ id: 'e1', fromLabel: 'Owner', toLabel: 'Carnival', label: 'attended' }],
    });
    expect(html).not.toContain('Confidence');
  });

  it('renders a confidence that is present, including one arriving as a string', () => {
    expect(
      render({
        kind: 'knowledge-graph',
        id: 'k2',
        edges: [{ id: 'e1', fromLabel: 'A', toLabel: 'B', label: 'knows', confidence: 0.6 }],
      }),
    ).toContain('Confidence: 60%');
    expect(
      render({
        kind: 'knowledge-graph',
        id: 'k3',
        edges: [{ id: 'e1', fromLabel: 'A', toLabel: 'B', label: 'knows', confidence: '0.85' }],
      }),
    ).toContain('Confidence: 85%');
  });

  it('will not put a non-http scheme in an href', () => {
    // Card URLs come from tool results, so they reach as far as any other
    // model-adjacent input. React only warns on these; the card has to refuse.
    const html = render({
      kind: 'web-search-results',
      id: 'w1',
      results: [
        { url: 'javascript:alert(1)', title: 'Trust me' },
        { url: 'https://example.com/real', title: 'Real result' },
      ],
    });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Trust me');
    expect(html).toContain('href="https://example.com/real"');
  });

  it('drops an unsafe Drive link but keeps the file name readable', () => {
    const html = render({
      kind: 'drive-results',
      id: 'd1',
      files: [{ id: 'f1', name: 'Photos.zip', url: 'data:text/html,<script>x</script>' }],
    });
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('Photos.zip');
  });

  it('shows three result rows at first glance and discloses the rest', () => {
    const html = render({
      kind: 'web-search-results',
      id: 'search-1',
      results: Array.from({ length: 5 }, (_, index) => ({
        id: `r${index}`,
        title: `Result ${index + 1}`,
        url: `https://example.com/${index}`,
        snippet: `Snippet ${index + 1}`,
      })),
    });
    expect(html).toContain('2 more');
    expect(html.indexOf('Result 3')).toBeLessThan(html.indexOf('2 more'));
    expect(html.indexOf('2 more')).toBeLessThan(html.indexOf('Result 4'));
  });

  it('shows three cards before grouping additional cards', () => {
    const cards = Array.from({ length: 5 }, (_, index) => ({
      kind: 'status',
      id: `status-${index}`,
      title: `Status ${index + 1}`,
      detail: `Detail ${index + 1}`,
    }));
    const html = renderToStaticMarkup(<ResponseCards cards={cards} timeZone="UTC" />);
    expect(html).toContain('2 more results');
    expect(html.indexOf('Status 3')).toBeLessThan(html.indexOf('2 more results'));
    expect(html.indexOf('2 more results')).toBeLessThan(html.indexOf('Status 4'));
  });

  it('renders a generated ticket from native blocks and conceals its bearer code', () => {
    const html = render({
      kind: 'generated-card',
      id: 'ticket-1',
      spec: {
        version: 1,
        title: 'Movie ticket',
        sourceLabel: 'Cinema email',
        icon: 'ticket',
        accent: 'violet',
        accessibilityLabel: 'Movie ticket for Dune',
        facts: [
          { id: 'movie', label: 'Movie', value: 'Dune: Part Two', source: 'mail' },
          {
            id: 'code',
            label: 'Ticket code',
            value: 'MV-4829-AX',
            source: 'mail',
            sensitive: true,
          },
        ],
        blocks: [
          { type: 'hero', titleFact: 'movie' },
          { type: 'code', valueFact: 'code', format: 'text' },
        ],
        actions: [],
      },
    });
    expect(html).toContain('Dune: Part Two');
    expect(html).toContain('Tap to reveal');
    expect(html).not.toContain('MV-4829-AX');
  });

  it('masks a sensitive fact as a named button, one asterisk per character', () => {
    const html = render({
      kind: 'generated-card',
      id: 'hotel-1',
      spec: {
        version: 1,
        title: 'Hotel Kabuki',
        sourceLabel: 'Hotel',
        accessibilityLabel: 'Hotel Kabuki reservation',
        facts: [
          {
            id: 'ref',
            label: 'Booking reference',
            value: '73535845212',
            source: 'mail',
            sensitive: true,
          },
        ],
        blocks: [{ type: 'facts', factIds: ['ref'] }],
        actions: [],
      },
    });
    expect(html).not.toContain('73535845212');
    expect(html).toContain('***********');
    expect(html).toContain('aria-label="Show booking reference"');
    expect(html).toContain('aria-pressed="false"');
    // Same face and character count on both sides of the toggle, so revealing
    // rewrites the line instead of reflowing it.
    expect(html).toContain('font-mono');
  });

  it('folds the work behind an answer card into one closed row', () => {
    const html = render({
      kind: 'generated-card',
      id: 'hotel-2',
      steps: [
        { tool: 'gmail.search', count: '1 result', detail: 'from:Katie hotels.com 73535845212' },
        { tool: 'gmail.read_thread', count: '1 message', detail: 'Fwd: travel confirmation' },
        { tool: 'nowhere.at_all', count: '1 record' },
      ],
      spec: {
        version: 1,
        title: 'Hotel Kabuki',
        sourceLabel: 'Hotel',
        accessibilityLabel: 'Hotel Kabuki reservation',
        facts: [{ id: 'name', label: 'Hotel', value: 'Hotel Kabuki', source: 'mail' }],
        blocks: [{ type: 'hero', titleFact: 'name' }],
        actions: [],
      },
    });
    expect(html).toContain('Found in 3 steps');
    expect(html).toContain('aria-expanded="false"');
    // Closed, and out of the accessibility tree until it is opened.
    expect(/<ul id="[^"]+" hidden/.test(html)).toBe(true);
    // User-facing language, never the dotted call the runtime made.
    expect(html).toContain('Searched email');
    expect(html).toContain('Checked nowhere');
    expect(html).not.toContain('gmail.search');
  });

  it('counts one step as one step and says which of them failed', () => {
    const card = (steps: Array<Record<string, unknown>>) => ({
      kind: 'generated-card',
      id: 'steps',
      steps,
      spec: {
        version: 1,
        title: 'Card',
        sourceLabel: 'Mail',
        accessibilityLabel: 'Card',
        facts: [{ id: 'a', label: 'A', value: 'One', source: 'mail' }],
        blocks: [{ type: 'hero', titleFact: 'a' }],
        actions: [],
      },
    });
    expect(render(card([{ tool: 'gmail.search' }]))).toContain('Found in 1 step');
    const withFailure = render(
      card([
        { tool: 'gmail.search', count: '1 result' },
        { tool: 'gmail.read_thread', count: '1 message' },
        { tool: 'web.fetch', failed: true, error: 'Upstream returned 503' },
      ]),
    );
    expect(withFailure).toContain('Found in 3 steps, 1 failed');
    expect(withFailure).toContain('Upstream returned 503');
  });

  it('offers no steps affordance when the answer took no tool calls', () => {
    const html = render({
      kind: 'generated-card',
      id: 'no-steps',
      steps: [],
      spec: {
        version: 1,
        title: 'Card',
        sourceLabel: 'Mail',
        accessibilityLabel: 'Card',
        facts: [{ id: 'a', label: 'A', value: 'One', source: 'mail' }],
        blocks: [{ type: 'hero', titleFact: 'a' }],
        actions: [],
      },
    });
    expect(html).not.toContain('Found in');
    expect(html).not.toContain('aria-expanded');
  });

  it('keeps prose fallback for an unsupported generated-card schema version', () => {
    expect(
      rendersAllCards([
        { kind: 'generated-card', id: 'future', spec: { version: 2, title: 'Future' } },
      ]),
    ).toBe(false);
  });
});

describe('a card read out of the reply', () => {
  it('heads the answer instead of replacing it', () => {
    const fromAnswer = {
      kind: 'generated-card',
      id: 'card-1',
      grounding: 'answer',
      spec: {
        version: 1,
        title: 'Drive to Bernal Intermediate',
        sourceLabel: 'This answer',
        facts: [
          { id: 'eta', label: 'Drive time', value: '1 hour 15 minutes to 1 hour 30 minutes' },
        ],
        blocks: [{ type: 'facts', factIds: ['eta'] }],
      },
    };
    // The surface can draw it, and the prose beside it still has the route
    // and the latest departure time to carry.
    expect(rendersAllCards([fromAnswer])).toBe(true);
    expect(cardsReplaceProse([fromAnswer])).toBe(false);

    const fromLookup = { ...fromAnswer, grounding: 'evidence' };
    expect(cardsReplaceProse([fromLookup])).toBe(true);
    // An older build sends no grounding: a lookup card, the previous contract.
    expect(cardsReplaceProse([{ ...fromAnswer, grounding: undefined }])).toBe(true);
    expect(cardsReplaceProse([])).toBe(false);
  });
});

describe('rich result previews', () => {
  const render = (card: Record<string, unknown>) =>
    renderToStaticMarkup(<ResponseCards cards={[card]} timeZone="UTC" />);
  it('renders email threads as readable excerpts with remaining messages disclosed', () => {
    const html = render({
      kind: 'email-thread',
      subject: 'Travel plans',
      messageCount: 7,
      messages: Array.from({ length: 5 }, (_, index) => ({
        id: `mail-${index}`,
        sender: `Person ${index}`,
        date: '2026-09-19T12:00:00Z',
        excerpt: index
          ? `Message ${index}`
          : `<script>alert(1)</script> ${'Long email text. '.repeat(30)}`,
      })),
    });
    expect(html).toContain('Email thread · 7 messages');
    expect(html).toContain('Travel plans');
    expect(html).toContain('Read more');
    expect(html).toContain('5 of 7 messages included');
    expect(html).not.toContain('<script>');
    expect(html.indexOf('Person 2')).toBeLessThan(html.indexOf('2 more'));
    expect(html.indexOf('2 more')).toBeLessThan(html.indexOf('Person 3'));
  });
  it('preserves typed sheet values in a semantic, scrollable preview without assuming a header row', () => {
    const html = render({
      kind: 'sheet-rows',
      sheetName: 'Budget',
      totalRows: 12,
      rows: [
        ['Rent', 0, false],
        ['Utilities', 30],
        ['Travel', 250],
        ['Food', 180],
      ],
      link: { label: 'Open spreadsheet', url: 'https://docs.google.com/spreadsheets/d/test' },
    });
    expect(html).toContain('<table');
    expect(html).toContain('scope="col"');
    expect(html).toContain('Column 1');
    expect(html).toContain('>0</td>');
    expect(html).toContain('>false</td>');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('Showing 4 of 12 rows');
    expect(html.indexOf('1 more')).toBeLessThan(html.indexOf('Food'));
    expect(html).toContain('href="https://docs.google.com/spreadsheets/d/test"');
  });
  it('keeps resource metadata and refuses unsafe open links', () => {
    const html = render({
      kind: 'resource',
      resourceType: 'document',
      title: 'Trip notes',
      subtitle: 'Google Doc created',
      details: [{ label: 'Shared with', value: 'me@example.com' }],
      link: { label: 'Open document', url: 'javascript:alert(1)' },
    });
    expect(html).toContain('Trip notes');
    expect(html).toContain('Shared with');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('href=');
  });
});

describe('generated card hierarchy and freshness', () => {
  const card = {
    kind: 'generated-card',
    id: 'card-1',
    revisionId: 'revision-1',
    updatedAt: '2026-09-18T10:00:00Z',
    spec: {
      version: 1,
      title: 'Journey',
      sourceLabel: 'Itinerary',
      refreshable: true,
      facts: Array.from({ length: 6 }, (_, index) => ({
        id: `f${index}`,
        label: `Stop ${index + 1}`,
        value: `Place ${index + 1}`,
      })),
      blocks: [{ type: 'timeline', factIds: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'] }],
      actions: [{ id: 'refresh', type: 'refresh', label: 'Refresh' }],
    },
  };
  const render = (overrides: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <ResponseCards
        cards={[{ ...card, ...overrides }]}
        timeZone="UTC"
        onRefresh={async () => ({ ok: true, taskId: 'task' })}
      />,
    );
  it('shows a semantic timeline with four facts before a closed details disclosure', () => {
    const html = render();
    expect(html).toContain('<ol aria-label="Timeline"');
    expect(html).toContain('start="5"');
    expect(html.indexOf('Place 4')).toBeLessThan(html.indexOf('More details'));
    expect(html.indexOf('More details')).toBeLessThan(html.indexOf('Place 5'));
    expect(html).not.toContain('<details open');
  });
  it('shows source update time and stale state without claiming a fresh read', () => {
    const html = render({ stale: true, refreshState: 'idle' });
    expect(html).toContain('Updated Sep 18');
    expect(html).toContain('May be out of date');
    expect(html.match(/>Refresh</g)).toHaveLength(1);
  });
  it('disables refresh while the server is working and retains facts on failure', () => {
    const loading = render({ refreshState: 'refreshing' });
    expect(loading).toContain('disabled=""');
    expect(loading).toContain('Refreshing…');
    const failed = render({ refreshState: 'failed', refreshError: 'Internal provider diagnostic' });
    expect(failed).toContain('Refresh failed. Showing the saved version.');
    expect(failed).toContain('Place 1');
    expect(failed).toContain('Updated Sep 18');
    expect(failed).not.toContain('Internal provider diagnostic');
    expect(failed).not.toContain('disabled=""');
  });
});

describe('WEB14 generated card compatibility and privacy', () => {
  const facts = [
    { id: 'a', label: 'Start', value: 'Oakland' },
    { id: 'b', label: 'End', value: 'Sacramento' },
    { id: 'n', label: 'Completed', value: '3' },
    { id: 'total', label: 'Total', value: '5' },
    { id: 'date', label: 'Departure', value: '2026-12-10T17:00:00Z' },
  ];
  const card = (blocks: unknown[], extraFacts: unknown[] = []) => ({
    kind: 'generated-card',
    id: 'web14',
    revisionId: 'revision-one',
    spec: { version: 1, title: 'Journey details', facts: [...facts, ...extraFacts], blocks },
  });
  const html = (value: ReturnType<typeof card>) =>
    renderToStaticMarkup(<ResponseCards cards={[value]} timeZone="UTC" />);

  it.each([0, 1, 2, 3])(
    'renders a section at position %i, including the details disclosure',
    (position) => {
      const blocks = Array.from({ length: position }, (_, n) => ({
        type: 'note',
        factId: n % 2 ? 'a' : 'b',
      }));
      blocks.push({
        type: 'section',
        title: 'Connection details',
        blocks: [{ type: 'facts', factIds: ['a'] }],
      } as never);
      const value = card(blocks);
      expect(rendersAllCards([value])).toBe(true);
      expect(html(value)).toContain('Connection details');
      expect(html(value)).toContain('Oakland');
    },
  );

  it('draws every additional leaf as content, with explicit map fallback', () => {
    const samples: Array<[Record<string, unknown>, string]> = [
      [{ type: 'metrics', factIds: ['n', 'total'] }, 'Completed'],
      [
        {
          type: 'journey',
          mode: 'train',
          fromFact: 'a',
          toFact: 'b',
          departFact: 'date',
          durationFact: 'n',
          statusFact: 'a',
        },
        'Sacramento',
      ],
      [{ type: 'progress', valueFact: 'n', totalFact: 'total', labelFact: 'a' }, '<progress'],
      [{ type: 'stages', factIds: ['a', 'b'], currentFact: 'a' }, 'Current stage'],
      [{ type: 'countdown', dateFact: 'date', labelFact: 'a' }, '2026-12-10T17:00:00Z'],
      [{ type: 'table', columns: ['Origin', 'Destination'], rows: [['a', 'b']] }, '<table'],
      [
        {
          type: 'chart',
          kind: 'bar',
          points: [
            { labelFact: 'a', valueFact: 'n' },
            { labelFact: 'b', valueFact: 'total' },
          ],
        },
        '<rect',
      ],
      [
        {
          type: 'chart',
          kind: 'line',
          points: [
            { labelFact: 'a', valueFact: 'n' },
            { labelFact: 'b', valueFact: 'total' },
          ],
        },
        '<circle',
      ],
      [{ type: 'checklist', factIds: ['a', 'b'] }, 'type="checkbox"'],
      [{ type: 'map', placeFactIds: ['a', 'b'] }, 'Open map'],
    ];
    for (const [block, expected] of samples) {
      const value = card([block]);
      expect(rendersSomeCards([value]), String(block.type)).toBe(true);
      expect(rendersAllCards([value]), String(block.type)).toBe(block.type !== 'map');
      expect(html(value), String(block.type)).toContain(expected);
    }
  });

  it.each([
    null,
    'future block',
    { type: 'future-block', factId: 'a' },
    { type: 'constructor' },
    { type: '__proto__' },
    { type: 'toString' },
    { type: 'section', title: 'Group', blocks: [null, { type: 'note', factId: 'a' }] },
    {
      type: 'section',
      title: 'Group',
      blocks: [{ type: 'section', title: 'Nested', blocks: [{ type: 'note', factId: 'a' }] }],
    },
    { type: 'table', columns: ['A', 'B'], rows: [['a', 'missing']] },
    { type: 'table', columns: ['A', 'B'], rows: [['a']] },
    { type: 'chart', kind: 'bar', points: [null, { labelFact: 'a', valueFact: 'n' }] },
    { type: 'journey', mode: 'teleport', fromFact: 'a', toFact: 'b' },
    { type: 'journey', mode: 'train', fromFact: 'a', toFact: 'b', arriveFact: 'missing' },
    { type: 'metrics', factIds: ['a', null] },
    { type: 'countdown', dateFact: 'date', labelFact: 'missing' },
  ])('keeps prose for malformed or unresolved material content %#', (block) => {
    const value = card([{ type: 'hero', titleFact: 'a' }, block]);
    expect(rendersAllCards([value])).toBe(false);
    expect(rendersSomeCards([value])).toBe(true);
    expect(html(value)).toContain('Oakland');
  });

  it('keeps scannable codes prose-backed instead of claiming the printed value is a QR code', () => {
    const value = card([{ type: 'code', format: 'qr', valueFact: 'a' }]);
    expect(rendersAllCards([value])).toBe(false);
    expect(html(value)).toContain('scannable code is available in the mobile app');
  });

  it('does not interpret missing, malformed, negative or over-total progress as measured progress', () => {
    for (const amount of ['?', '-1', '6', 'NaN', 'Infinity', '1e2']) {
      const value = card(
        [{ type: 'progress', valueFact: 'amount', totalFact: 'total' }],
        [{ id: 'amount', value: amount }],
      );
      expect(html(value)).toContain('Progress unknown');
      expect(html(value)).not.toContain('<progress');
    }
    expect(html(card([{ type: 'progress', valueFact: 'n' }]))).toContain('Progress unknown');
  });

  it('keeps secret values out of text, attributes, URLs and numeric geometry in every new leaf', () => {
    const secret = { id: 'private', label: 'Booking code', value: '72', sensitive: true };
    const samples = [
      { type: 'metrics', factIds: ['private', 'total'] },
      { type: 'journey', mode: 'train', fromFact: 'private', toFact: 'b' },
      { type: 'progress', valueFact: 'private', totalFact: 'total' },
      { type: 'stages', factIds: ['private', 'b'], currentFact: 'private' },
      { type: 'countdown', dateFact: 'private' },
      { type: 'table', columns: ['Private 72', 'Destination'], rows: [['private', 'b']] },
      {
        type: 'chart',
        kind: 'line',
        points: [
          { labelFact: 'private', valueFact: 'private' },
          { labelFact: 'b', valueFact: 'total' },
        ],
      },
      { type: 'checklist', factIds: ['private'] },
      { type: 'map', placeFactIds: ['private'] },
    ];
    for (const block of samples) {
      const markup = html(card([block], [secret]));
      expect(markup, block.type).not.toContain('72');
      expect(markup, block.type).not.toContain('query=72');
      expect(markup, block.type).not.toContain('aria-current="step"');
      expect(markup, block.type).toContain('Show booking code');
    }
  });

  it('does not silently normalize malformed arrays or duplicate fact identities into a complete card', () => {
    const value = card([{ type: 'hero', titleFact: 'a' }]);
    expect(rendersAllCards([{ ...value, spec: { ...value.spec, version: '1' } }])).toBe(false);
    expect(rendersAllCards([{ ...value, spec: { ...value.spec, actions: [null] } }])).toBe(false);
    expect(
      rendersAllCards([
        {
          ...value,
          spec: { ...value.spec, facts: [...facts, { id: 'a', value: 'Conflicting stop' }] },
        },
      ]),
    ).toBe(false);
  });
});
