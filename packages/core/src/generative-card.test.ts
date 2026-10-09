import { describe, expect, it } from 'vitest';
import {
  ANSWER_SOURCE_LABEL,
  answerLooksCardShaped,
  GenerativeCardSpecV1Schema,
  generateEvidenceCard,
  generateEvidenceCardOutcome,
  numericFactValue,
  scoreboardCardSpec,
  validateGroundedCard,
} from './generative-card.js';
import type { ModelRouter } from './model-router/index.js';
import type { ActionEvidence } from './workflow/response-contract.js';

const movieCard = {
  version: 1 as const,
  title: 'Movie ticket',
  icon: 'ticket' as const,
  accent: 'violet' as const,
  accessibilityLabel: 'Movie ticket for Dune Part Two',
  sourceLabel: 'Cinema email',
  facts: [
    { id: 'movie', label: 'Movie', value: 'Dune: Part Two', source: 'SOURCE_MESSAGE' },
    { id: 'time', label: 'Showtime', value: '7:30 PM', source: 'SOURCE_MESSAGE' },
    {
      id: 'code',
      label: 'Ticket code',
      value: 'MV-4829-AX',
      source: 'SOURCE_MESSAGE',
      sensitive: true,
    },
  ],
  blocks: [
    { type: 'hero' as const, titleFact: 'movie', subtitleFact: 'time' },
    { type: 'code' as const, valueFact: 'code', format: 'text' as const },
  ],
  actions: [{ id: 'copy', type: 'copy_value' as const, label: 'Copy code', factId: 'code' }],
  refreshable: false,
};

describe('GenerativeCardSpecV1', () => {
  it('accepts a grounded unfamiliar layout', () => {
    const parsed = GenerativeCardSpecV1Schema.parse(movieCard);
    expect(
      validateGroundedCard(
        parsed,
        'Cinema email: Dune: Part Two is booked for 7:30 PM. Ticket code MV-4829-AX.',
      ),
    ).toEqual(parsed);
  });

  it('rejects one fabricated fact even when the rest is grounded', () => {
    const parsed = GenerativeCardSpecV1Schema.parse({
      ...movieCard,
      facts: movieCard.facts.map((fact) =>
        fact.id === 'time' ? { ...fact, value: '9:30 PM' } : fact,
      ),
    });
    expect(
      validateGroundedCard(
        parsed,
        'Cinema email: Dune: Part Two is booked for 7:30 PM. Ticket code MV-4829-AX.',
      ),
    ).toBeNull();
  });

  it('rejects a figure cut out of the middle of a range', () => {
    const sharpened = GenerativeCardSpecV1Schema.parse({
      ...movieCard,
      facts: [{ id: 'eta', label: 'Drive time', value: '1 hour', source: 'ANSWER' }],
      blocks: [{ type: 'facts', factIds: ['eta'] }],
      actions: [],
    });
    const corpus = 'ANSWER: expect the drive to take about 1 hour 15 minutes to 1 hour 30 minutes.';
    // Word for word present, and still a false claim about the estimate.
    expect(corpus).toContain('1 hour');
    expect(validateGroundedCard(sharpened, corpus)).toBeNull();

    const whole = GenerativeCardSpecV1Schema.parse({
      ...sharpened,
      facts: [
        {
          id: 'eta',
          label: 'Drive time',
          value: '1 hour 15 minutes to 1 hour 30 minutes',
          source: 'ANSWER',
        },
      ],
    });
    expect(validateGroundedCard(whole, corpus)).toEqual(whole);
  });

  it('rejects unsafe action URLs and missing fact bindings', () => {
    const unsafe = GenerativeCardSpecV1Schema.parse({
      ...movieCard,
      facts: [
        ...movieCard.facts,
        { id: 'url', value: 'javascript:alert(1)', source: 'SOURCE_MESSAGE' },
      ],
      actions: [{ id: 'open', type: 'open_url', label: 'Open', factId: 'url' }],
    });
    expect(validateGroundedCard(unsafe, JSON.stringify(unsafe))).toBeNull();
    const missing = GenerativeCardSpecV1Schema.parse({
      ...movieCard,
      blocks: [{ type: 'note', factId: 'not-there' }],
    });
    expect(validateGroundedCard(missing, JSON.stringify(missing))).toBeNull();
  });

  it('rejects a card whose own words are in a script the evidence never used', () => {
    // The reminder card as it shipped: every value lifted correctly out of an
    // English turn, under a title and labels nobody in the conversation could
    // read.
    const corpus =
      'SOURCE_MESSAGE\nRemind me in 7 hours, that I need to charge the car before we drive to the game\n\nTOOL_1 scheduler.schedule_task\n{"scheduledFor":"2026-09-13T07:45:00-07:00","taskId":"ccc44ceb-36b9-450d-be1e-ee537a4bd59f"}';
    const drifted = GenerativeCardSpecV1Schema.parse({
      version: 1,
      title: '车辆充电提醒',
      icon: 'calendar',
      accessibilityLabel: '车辆充电提醒',
      sourceLabel: 'Task Scheduler',
      facts: [
        {
          id: 'when',
          label: '计划时间',
          value: '2026-09-13T07:45:00-07:00',
          source: 'scheduler.schedule_task',
        },
      ],
      blocks: [{ type: 'facts', factIds: ['when'] }],
    });
    expect(validateGroundedCard(drifted, corpus)).toBeNull();
    expect(
      validateGroundedCard(
        GenerativeCardSpecV1Schema.parse({
          ...drifted,
          title: 'Charge the car',
          accessibilityLabel: 'Reminder to charge the car',
          facts: [{ ...drifted.facts[0], label: 'Scheduled for' }],
        }),
        corpus,
      ),
    ).not.toBeNull();
  });

  it('keeps a card written in the script its owner wrote in', () => {
    const corpus =
      'SOURCE_MESSAGE\n七小时后提醒我，开车去球场之前要给车充电\n\nTOOL_1 scheduler.schedule_task\n{"scheduledFor":"2026-09-13T07:45:00-07:00"}';
    const inOwnersScript = GenerativeCardSpecV1Schema.parse({
      version: 1,
      title: '车辆充电提醒',
      icon: 'calendar',
      accessibilityLabel: '车辆充电提醒',
      sourceLabel: '任务计划',
      facts: [
        {
          id: 'when',
          label: '计划时间',
          value: '2026-09-13T07:45:00-07:00',
          source: 'scheduler.schedule_task',
        },
      ],
      blocks: [{ type: 'facts', factIds: ['when'] }],
    });
    expect(validateGroundedCard(inOwnersScript, corpus)).toEqual(inOwnersScript);
  });

  it('does not mistake Latin diacritics for a script of their own', () => {
    const corpus =
      'SOURCE_MESSAGE\nWhen does the game start?\n\nTOOL_1 calendar.list\n{"title":"Leikur"}';
    const accented = GenerativeCardSpecV1Schema.parse({
      version: 1,
      title: 'Brynjar’s leikur',
      icon: 'sport',
      accessibilityLabel: 'Leikur í dag',
      sourceLabel: 'Dagatal',
      facts: [{ id: 'title', label: 'Viðburður', value: 'Leikur', source: 'calendar.list' }],
      blocks: [{ type: 'facts', factIds: ['title'] }],
    });
    expect(validateGroundedCard(accented, corpus)).toEqual(accented);
  });
});

/** Captures the corpus the compiler builds, and whether it was consulted at all. */
function stubRouter(): { router: ModelRouter; calls: string[] } {
  const calls: string[] = [];
  const router = {
    object: async (_kind: string, options: { prompt: string }) => {
      calls.push(options.prompt);
      return { ok: true as const, object: { cardable: false } };
    },
  } as unknown as ModelRouter;
  return { router, calls };
}

const hotelLookup: ActionEvidence[] = [
  {
    toolName: 'gmail.search',
    status: 'succeeded',
    args: { query: 'from:Katie hotels.com' },
    result: { results: [{ subject: 'Itinerary # 73535835545212', from: 'Katie Innes' }] },
    // The turn the owner is pointing at with "that" is always an earlier one.
    fromCurrentTask: false,
  },
];

const flightEvidence = [
  'TOOL_1 gmail.read_thread',
  'Icelandair FI 614 from Reykjavik (KEF) to New York (JFK).',
  'Departs 2026-10-02T16:40:00+00:00, arrives 18:25 local. Gate D4, seat 14A, boarding 16:00.',
  'Check-in steps: Checked in, Bag dropped, Security, Boarding. Current: Bag dropped.',
  'Fares: Economy 412 USD, Saga 1,190 USD.',
].join('\n');

const flightFacts = [
  { id: 'from', label: 'From', value: 'Reykjavik (KEF)', source: 'gmail.read_thread' },
  { id: 'to', label: 'To', value: 'New York (JFK)', source: 'gmail.read_thread' },
  { id: 'dep', label: 'Departs', value: '2026-10-02T16:40:00+00:00', source: 'gmail.read_thread' },
  { id: 'arr', label: 'Arrives', value: '18:25 local', source: 'gmail.read_thread' },
  { id: 'gate', label: 'Gate', value: 'D4', source: 'gmail.read_thread' },
  { id: 'seat', label: 'Seat', value: '14A', source: 'gmail.read_thread' },
  { id: 'board', label: 'Boarding', value: '16:00', source: 'gmail.read_thread' },
  { id: 's1', label: 'Step', value: 'Checked in', source: 'gmail.read_thread' },
  { id: 's2', label: 'Step', value: 'Bag dropped', source: 'gmail.read_thread' },
  { id: 's3', label: 'Step', value: 'Security', source: 'gmail.read_thread' },
  { id: 'eco', label: 'Economy', value: '412 USD', source: 'gmail.read_thread' },
  { id: 'saga', label: 'Saga', value: '1,190 USD', source: 'gmail.read_thread' },
  { id: 'eco_name', label: 'Fare', value: 'Economy', source: 'gmail.read_thread' },
  { id: 'saga_name', label: 'Fare', value: 'Saga', source: 'gmail.read_thread' },
];

const flightCard = {
  version: 1 as const,
  title: 'FI 614 to New York',
  icon: 'plane' as const,
  accessibilityLabel: 'Flight FI 614 from Reykjavik to New York, gate D4, seat 14A',
  sourceLabel: 'Icelandair email',
  facts: flightFacts,
  blocks: [
    {
      type: 'journey' as const,
      mode: 'flight' as const,
      fromFact: 'from',
      toFact: 'to',
      departFact: 'dep',
      arriveFact: 'arr',
    },
    { type: 'metrics' as const, factIds: ['gate', 'seat', 'board'] },
    { type: 'countdown' as const, dateFact: 'dep' },
    {
      type: 'section' as const,
      title: 'Before you fly',
      blocks: [{ type: 'stages' as const, factIds: ['s1', 's2', 's3'], currentFact: 's2' }],
    },
    {
      type: 'table' as const,
      columns: ['Fare', 'Price'],
      rows: [
        ['eco_name', 'eco'],
        ['saga_name', 'saga'],
      ],
    },
    {
      type: 'chart' as const,
      kind: 'bar' as const,
      points: [
        { labelFact: 'eco_name', valueFact: 'eco' },
        { labelFact: 'saga_name', valueFact: 'saga' },
      ],
    },
  ],
  actions: [],
};

describe('the layout vocabulary', () => {
  it('retains sanitation inside a section even when the outer block count is unchanged', () => {
    const parsed = GenerativeCardSpecV1Schema.parse({
      ...flightCard,
      blocks: [
        {
          type: 'section',
          title: 'Before boarding',
          blocks: [
            { type: 'countdown', dateFact: 'board' },
            { type: 'metrics', factIds: ['gate', 'seat'] },
          ],
        },
      ],
    });
    expect(validateGroundedCard(parsed, flightEvidence)?.blocks).toEqual([
      {
        type: 'section',
        title: 'Before boarding',
        blocks: [{ type: 'metrics', factIds: ['gate', 'seat'] }],
      },
    ]);
  });
  it('accepts a grounded card built from the richer blocks', () => {
    const parsed = GenerativeCardSpecV1Schema.parse(flightCard);
    expect(validateGroundedCard(parsed, flightEvidence)).toEqual(parsed);
  });

  it('follows fact references into sections and table cells', () => {
    const dangling = GenerativeCardSpecV1Schema.parse({
      ...flightCard,
      blocks: [
        {
          type: 'section',
          title: 'Fares',
          blocks: [{ type: 'table', columns: ['Fare', 'Price'], rows: [['eco_name', 'missing']] }],
        },
      ],
    });
    expect(validateGroundedCard(dangling, flightEvidence)).toBeNull();
  });

  it('holds section headings and column labels to the script rule', () => {
    const drifted = GenerativeCardSpecV1Schema.parse({
      ...flightCard,
      blocks: [
        {
          type: 'section',
          title: '出発前',
          blocks: [{ type: 'metrics', factIds: ['gate', 'seat'] }],
        },
      ],
    });
    expect(validateGroundedCard(drifted, flightEvidence)).toBeNull();
  });

  it('drops a countdown to a time with no zone and keeps the rest of the card', () => {
    const parsed = GenerativeCardSpecV1Schema.parse({
      ...flightCard,
      blocks: [
        { type: 'countdown', dateFact: 'board' },
        { type: 'metrics', factIds: ['gate', 'seat'] },
      ],
    });
    expect(validateGroundedCard(parsed, flightEvidence)?.blocks).toEqual([
      { type: 'metrics', factIds: ['gate', 'seat'] },
    ]);
  });

  it('refuses a card when no block can be drawn', () => {
    const parsed = GenerativeCardSpecV1Schema.parse({
      ...flightCard,
      blocks: [
        {
          type: 'chart',
          kind: 'line',
          points: [
            { labelFact: 'gate', valueFact: 'from' },
            { labelFact: 'seat', valueFact: 'to' },
          ],
        },
        { type: 'stages', factIds: ['s1', 's2'], currentFact: 's3' },
      ],
    });
    expect(validateGroundedCard(parsed, flightEvidence)).toBeNull();
  });

  it('draws progress only over a real fraction', () => {
    const corpus = 'Delivery: stop 3 of 5 stops. Battery 76%. Upload 140%.';
    const card = (block: object) =>
      GenerativeCardSpecV1Schema.parse({
        ...flightCard,
        facts: [
          { id: 'done', label: 'Stop', value: '3', source: 'x' },
          { id: 'total', label: 'Stops', value: '5', source: 'x' },
          { id: 'pct', label: 'Battery', value: '76%', source: 'x' },
          { id: 'over', label: 'Upload', value: '140%', source: 'x' },
        ],
        blocks: [block, { type: 'metrics', factIds: ['done', 'total'] }],
      });
    const kept = (block: object) => validateGroundedCard(card(block), corpus)?.blocks.length;
    expect(kept({ type: 'progress', valueFact: 'done', totalFact: 'total' })).toBe(2);
    expect(kept({ type: 'progress', valueFact: 'pct' })).toBe(2);
    expect(kept({ type: 'progress', valueFact: 'over' })).toBe(1);
    expect(kept({ type: 'progress', valueFact: 'total', totalFact: 'done' })).toBe(1);
  });

  it('reads the figure out of a formatted value', () => {
    expect(numericFactValue('1,190 USD')).toBe(1190);
    expect(numericFactValue('$38.50')).toBe(38.5);
    expect(numericFactValue('-3 °C')).toBe(-3);
    expect(numericFactValue('76%')).toBe(76);
    expect(numericFactValue('Gate D4')).toBeUndefined();
    expect(numericFactValue('1 hour 15 minutes')).toBeUndefined();
  });
});

describe('actions the phone performs', () => {
  const withActions = (actions: object[]) =>
    GenerativeCardSpecV1Schema.parse({
      ...flightCard,
      blocks: [{ type: 'metrics', factIds: ['gate', 'seat'] }],
      actions,
    });

  it('keeps a calendar entry on zoned instants and directions to a place', () => {
    const card = withActions([
      {
        id: 'cal',
        type: 'add_to_calendar',
        label: 'Add to Calendar',
        startFact: 'dep',
        locationFact: 'from',
      },
      { id: 'go', type: 'directions', label: 'Directions', factId: 'from' },
    ]);
    expect(
      validateGroundedCard(card, flightEvidence)?.actions.map((action) => action.type),
    ).toEqual(['add_to_calendar', 'directions']);
  });

  it('drops a calendar entry on a wall-clock time, and keeps the card', () => {
    const card = withActions([
      { id: 'cal', type: 'add_to_calendar', label: 'Add to Calendar', startFact: 'board' },
    ]);
    const validated = validateGroundedCard(card, flightEvidence);
    expect(validated?.actions).toEqual([]);
    expect(validated?.blocks).toHaveLength(1);
  });

  it('never routes to a secret, and still refuses an invented reference', () => {
    const secret = GenerativeCardSpecV1Schema.parse({
      ...withActions([{ id: 'go', type: 'directions', label: 'Directions', factId: 'from' }]),
      facts: flightFacts.map((fact) => (fact.id === 'from' ? { ...fact, sensitive: true } : fact)),
    });
    expect(validateGroundedCard(secret, flightEvidence)?.actions).toEqual([]);
    const dangling = withActions([
      { id: 'cal', type: 'add_to_calendar', label: 'Add to Calendar', startFact: 'missing' },
    ]);
    expect(validateGroundedCard(dangling, flightEvidence)).toBeNull();
  });
});

describe('durable generated-card composition outcomes', () => {
  it('returns a typed card for a validated deterministic confirmation', async () => {
    const outcome = await generateEvidenceCardOutcome({
      router: {
        object: async () => {
          throw new Error('deterministic hotel confirmation must not call the router');
        },
      } as unknown as ModelRouter,
      sourceText: 'Make a hotel card',
      explicitRequest: true,
      sourceKey: 'gmail:synthetic-hotel',
      evidence: [
        {
          toolName: 'gmail.read_thread',
          status: 'succeeded',
          result: { messages: [{ text: 'Check-in begins at 3 PM.' }] },
        },
      ],
    });
    expect(outcome.kind).toBe('card');
    if (outcome.kind === 'card') {
      expect(outcome.payload.kind).toBe('generated-card');
      expect(outcome.payload.spec.title).toBe('Hotel reservation');
    }
  });

  it('distinguishes prefilter no-op, thrown provider failure, and returned failure', async () => {
    let prefilterCalls = 0;
    const skipped = await generateEvidenceCardOutcome({
      router: {
        object: async () => {
          prefilterCalls += 1;
          throw new Error('must not be called');
        },
      } as unknown as ModelRouter,
      sourceText: 'A routine note with no saved object.',
      evidence: [],
    });
    expect(skipped).toEqual({ kind: 'no_op' });
    expect(prefilterCalls).toBe(0);

    let thrownCalls = 0;
    const thrown = await generateEvidenceCardOutcome({
      router: {
        object: async () => {
          thrownCalls += 1;
          throw new Error('bounded synthetic router failure');
        },
      } as unknown as ModelRouter,
      sourceText: 'routine note',
      evidence: [],
      explicitRequest: true,
    });
    expect(thrown).toEqual({ kind: 'unknown' });
    expect(thrownCalls).toBe(1);

    let returnedCalls = 0;
    const budgetBlocked = await generateEvidenceCardOutcome({
      router: {
        object: async () => {
          returnedCalls += 1;
          return {
            ok: false as const,
            decision: { mode: 'park' as const, reason: 'synthetic budget park' },
            attempts: [],
          };
        },
      } as unknown as ModelRouter,
      sourceText: 'routine note',
      evidence: [],
      explicitRequest: true,
    });
    expect(budgetBlocked).toEqual({ kind: 'budget_blocked', mode: 'park' });
    expect(returnedCalls).toBe(1);

    const ambiguousReturnedFailure = await generateEvidenceCardOutcome({
      router: {
        object: async () => {
          returnedCalls += 1;
          return {
            ok: false as const,
            decision: { mode: 'block' as const, reason: 'synthetic fallback budget block' },
            attempts: [{ provider: 'synthetic', outcome: 'failed' }],
          };
        },
      } as unknown as ModelRouter,
      sourceText: 'routine note',
      evidence: [],
      explicitRequest: true,
    });
    expect(ambiguousReturnedFailure).toEqual({ kind: 'unknown' });
    expect(returnedCalls).toBe(2);
  });

  it('keeps budget blocking nullable for legacy callers', async () => {
    await expect(
      generateEvidenceCard({
        router: {
          object: async () => ({
            ok: false as const,
            decision: { mode: 'block' as const, reason: 'synthetic budget block' },
            attempts: [],
          }),
        } as unknown as ModelRouter,
        sourceText: 'routine note',
        evidence: [],
        explicitRequest: true,
      }),
    ).resolves.toBeNull();
  });

  it('keeps the legacy nullable facade while exposing returned non-card as no-op', async () => {
    let calls = 0;
    const router = {
      object: async () => {
        calls += 1;
        return { ok: true as const, object: { cardable: false } };
      },
    } as unknown as ModelRouter;
    await expect(
      generateEvidenceCardOutcome({
        router,
        sourceText: 'routine note',
        evidence: [],
        explicitRequest: true,
        sourceKey: 'gmail:synthetic-event',
      }),
    ).resolves.toEqual({ kind: 'no_op' });
    await expect(
      generateEvidenceCard({
        router,
        sourceText: 'routine note',
        evidence: [],
        explicitRequest: true,
        sourceKey: 'gmail:synthetic-event',
      }),
    ).resolves.toBeNull();
    expect(calls).toBe(2);
  });
});

describe('an explicitly requested card', () => {
  it('reaches the compiler even though the request carries no cardable keyword', async () => {
    const asked = stubRouter();
    await generateEvidenceCard({
      router: asked.router,
      taskId: 'task-1',
      sourceText: 'Make that into a card for me',
      evidence: hotelLookup,
      explicitRequest: true,
    });
    expect(asked.calls).toHaveLength(1);

    // Same turn without the request: no current-task evidence and no keyword, so
    // the compiler is never worth a model call.
    const unasked = stubRouter();
    await generateEvidenceCard({
      router: unasked.router,
      taskId: 'task-1',
      sourceText: 'Make that into a card for me',
      evidence: hotelLookup,
    });
    expect(unasked.calls).toHaveLength(0);
  });

  it('grounds on the prior turn the owner is pointing at', async () => {
    const asked = stubRouter();
    await generateEvidenceCard({
      router: asked.router,
      taskId: 'task-1',
      sourceText: 'Make that into a card for me',
      evidence: [...hotelLookup, { toolName: 'docs.create', status: 'succeeded', result: {} }],
      explicitRequest: true,
    });
    expect(asked.calls[0]).toContain('PRIOR_TOOL_1 gmail.search');
    expect(asked.calls[0]).toContain('73535835545212');

    // Unrequested turns keep the current-task-only corpus: a prior result must
    // not silently become groundable evidence for an unasked card.
    const ambient = stubRouter();
    await generateEvidenceCard({
      router: ambient.router,
      taskId: 'task-1',
      sourceText: 'Make that into a card for me',
      evidence: [...hotelLookup, { toolName: 'docs.create', status: 'succeeded', result: {} }],
    });
    expect(ambient.calls[0]).not.toContain('73535835545212');
  });
});

it('omits a booking PIN from a deterministic hotel card while preserving safe check-in information', async () => {
  const result = await generateEvidenceCard({
    router: {
      object: async () => {
        throw new Error('not needed');
      },
    } as unknown as ModelRouter,
    sourceText: 'Create a card for my hotel reservation',
    explicitRequest: true,
    evidence: [
      {
        toolName: 'gmail.read_thread',
        status: 'succeeded',
        result: {
          messages: [{ text: 'Harbor Hotel. Check-in October 12 at 3 PM. Booking PIN: 892174.' }],
        },
      },
    ],
  });
  expect(result).not.toBeNull();
  expect(JSON.stringify(result?.spec)).not.toContain('892174');
  expect(JSON.stringify(result?.spec)).toContain('Check-in October 12 at 3 PM');
});

it.each([
  ['Account identifier: ACCT-77031.', 'ACCT-77031'],
  [
    'Bearer link: https://hotel.example/claim/eyJhbGciOiJIUzI1NiJ9.secret.',
    'https://hotel.example/claim/eyJhbGciOiJIUzI1NiJ9.secret',
  ],
])(
  'omits accepted alternate hotel secrets from a deterministic card: %s',
  async (secretSentence, secret) => {
    const result = await generateEvidenceCard({
      router: {
        object: async () => {
          throw new Error('not needed');
        },
      } as unknown as ModelRouter,
      sourceText: 'Create a card for my hotel reservation',
      explicitRequest: true,
      evidence: [
        {
          toolName: 'gmail.read_thread',
          status: 'succeeded',
          result: {
            messages: [{ text: `Harbor Hotel. Check-in October 12 at 3 PM. ${secretSentence}` }],
          },
        },
      ],
    });
    expect(result).not.toBeNull();
    expect(JSON.stringify(result?.spec)).not.toContain(secret);
    expect(JSON.stringify(result?.spec)).toContain('Check-in October 12 at 3 PM');
  },
);

it('creates a short hotel confirmation card directly from literal email evidence', async () => {
  const details = 'Harbor Hotel. Check-in September 5, 2026 at 4 PM. Total $105.85.';
  const router = {
    object: async () => {
      throw new Error('A model must not rewrite this short confirmation');
    },
  } as unknown as ModelRouter;
  const card = await generateEvidenceCard({
    router,
    taskId: 'test',
    sourceText: 'Create a card for my hotel reservation',
    explicitRequest: true,
    evidence: [
      {
        toolName: 'gmail.read_thread',
        status: 'succeeded',
        result: { messages: [{ text: details }] },
      },
    ],
  });
  expect(card?.kind).toBe('generated-card');
  expect(card?.grounding).toBe('evidence');
  expect(card?.spec.facts[0]?.value).toBe(details);
  expect(card?.spec.actions).toEqual([]);
});

it('does not create a hotel card from a booking reference when the mailbox lookup found nothing', async () => {
  const router = {
    object: async () => {
      throw new Error('No source exists to compose');
    },
  } as unknown as ModelRouter;
  expect(
    await generateEvidenceCard({
      router,
      taskId: 'empty',
      sourceText: 'Create a hotel reservation card from my mailbox under QA-MISSING',
      explicitRequest: true,
      evidence: [{ toolName: 'gmail.search', status: 'succeeded', result: { results: [] } }],
    }),
  ).toBeNull();
});

const travelAnswer = `From your place in the Richmond down to Bernal Intermediate School in South San Jose is roughly 60 to 65 miles.

On a Sunday afternoon, expect the drive to take about 1 hour 15 minutes to 1 hour 30 minutes, factoring in getting through town down 19th Avenue before hopping on I-280 South.

To make the 4:15 PM arrival time without rushing, plan to head out around 2:45 PM (3:00 PM at the absolute latest).`;

describe('an answer with no tool behind it', () => {
  it('is gated on its own shape, not on a list of card words', () => {
    expect(answerLooksCardShaped(travelAnswer)).toBe(true);
    // A weather answer in prose: a temperature and labelled fields.
    expect(
      answerLooksCardShaped(
        `Here is the forecast for San Francisco today, which should hold through the evening.
- **Temperature:** 19°C
- **Conditions:** Partly cloudy
- **Wind:** 15 km/h`,
      ),
    ).toBe(true);

    // Conversation, at length, carrying one figure and nothing to lay out.
    expect(
      answerLooksCardShaped(
        'I have sent that note over to Katie, and I let her know you would follow up about the rest of it later this week once you have had a chance to think it through properly.',
      ),
    ).toBe(false);
    // A single signal is ordinary prose: "I will have it by 5pm."
    expect(
      answerLooksCardShaped(
        'I will have the draft finished and sent over to you by 5pm, once the last section is rewritten and the numbers in the appendix have been checked against the source.',
      ),
    ).toBe(false);
    // Nothing to frame.
    expect(answerLooksCardShaped('Done — sent at 4:15 PM.')).toBe(false);
  });

  it('reaches the composer with the reply as its evidence', async () => {
    const stub = stubRouter();
    await generateEvidenceCard({
      router: stub.router,
      taskId: 'task-1',
      sourceText: 'How long will it take us to get there?',
      evidence: [],
      answerText: travelAnswer,
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toContain('ANSWER');
    expect(stub.calls[0]).toContain('1 hour 15 minutes to 1 hour 30 minutes');
  });

  it('keeps the reply out of the corpus when the turn has tool results', async () => {
    const stub = stubRouter();
    await generateEvidenceCard({
      router: stub.router,
      taskId: 'task-1',
      sourceText: 'What is on my calendar?',
      evidence: [
        { toolName: 'calendar.list', status: 'succeeded', result: { events: [{ title: 'Game' }] } },
      ],
      answerText: travelAnswer,
    });
    // Tool rows are the better ground; prose beside them could outrank the row
    // it paraphrased.
    expect(stub.calls[0]).toContain('TOOL_1 calendar.list');
    expect(stub.calls[0]).not.toContain('ANSWER');
  });

  it('files a booking the owner pasted in, as theirs', async () => {
    const pasted =
      'Here is my dinner booking. Restaurant: Dill. Date: Friday, October 9. Time: 7:30 PM. Party size: 4. Reference: DL-4471.';
    const router = {
      object: async () => ({
        ok: true as const,
        object: {
          cardable: true,
          card: {
            version: 1,
            title: 'Dinner at Dill',
            icon: 'food',
            accessibilityLabel: 'Dinner at Dill, Friday at 7:30 PM for 4',
            sourceLabel: 'SOURCE_MESSAGE',
            facts: [
              { id: 'place', label: 'Restaurant', value: 'Dill', source: 'SOURCE_MESSAGE' },
              { id: 'day', label: 'Date', value: 'Friday, October 9', source: 'SOURCE_MESSAGE' },
              { id: 'time', label: 'Time', value: '7:30 PM', source: 'SOURCE_MESSAGE' },
              { id: 'ref', label: 'Reference', value: 'DL-4471', source: 'SOURCE_MESSAGE' },
            ],
            blocks: [
              { type: 'metrics', factIds: ['day', 'time'] },
              { type: 'facts', factIds: ['place', 'ref'] },
            ],
          },
        },
      }),
    } as unknown as ModelRouter;
    const card = await generateEvidenceCard({
      router,
      sourceText: pasted,
      evidence: [],
      answerText:
        'Got it — dinner at Dill on Friday, October 9 at 7:30 PM for 4, reference DL-4471. I will remind you that afternoon.',
    });
    expect(card?.grounding).toBe('message');
    expect(card?.spec.sourceLabel).toBe('Your message');
  });

  it('stamps the card as a view of the answer rather than a lookup', async () => {
    const router = {
      object: async () => ({
        ok: true as const,
        object: {
          cardable: true,
          card: {
            version: 1,
            title: 'Drive to Bernal Intermediate',
            icon: 'map',
            accessibilityLabel: 'Estimated drive time and departure',
            sourceLabel: 'ANSWER',
            refreshable: true,
            facts: [
              {
                id: 'eta',
                label: 'Drive time',
                value: 'about 1 hour 15 minutes to 1 hour 30 minutes',
                source: 'ANSWER',
              },
              { id: 'leave', label: 'Leave', value: 'around 2:45 PM', source: 'ANSWER' },
            ],
            blocks: [{ type: 'facts', factIds: ['eta', 'leave'] }],
            actions: [{ id: 'again', type: 'refresh', label: 'Refresh' }],
          },
        },
      }),
    } as unknown as ModelRouter;

    const card = await generateEvidenceCard({
      router,
      taskId: 'task-1',
      sourceText: 'How long will it take us to get there?',
      evidence: [],
      answerText: travelAnswer,
    });
    expect(card?.spec.sourceLabel).toBe(ANSWER_SOURCE_LABEL);
    expect(card?.spec.facts.map((fact) => fact.source)).toEqual([
      ANSWER_SOURCE_LABEL,
      ANSWER_SOURCE_LABEL,
    ]);
    // The range survives with its hedge, and there is nothing to refresh from.
    expect(card?.spec.facts[0]?.value).toBe('about 1 hour 15 minutes to 1 hour 30 minutes');
    expect(card?.spec.refreshable).toBe(false);
    expect(card?.spec.actions).toEqual([]);
    // The client reads this to know the card heads the reply, not replaces it.
    expect(card?.grounding).toBe('answer');
  });

  it('refuses a figure the answer never stated', async () => {
    const router = {
      object: async () => ({
        ok: true as const,
        object: {
          cardable: true,
          card: {
            version: 1,
            title: 'Drive to Bernal Intermediate',
            accessibilityLabel: 'Estimated drive time',
            sourceLabel: 'ANSWER',
            // The sharpened single figure the old regex produced.
            facts: [{ id: 'eta', label: 'Drive time', value: '1 hour', source: 'ANSWER' }],
            blocks: [{ type: 'facts', factIds: ['eta'] }],
          },
        },
      }),
    } as unknown as ModelRouter;
    expect(
      await generateEvidenceCard({
        router,
        taskId: 'task-1',
        sourceText: 'How long will it take us to get there?',
        evidence: [],
        answerText: travelAnswer,
      }),
    ).toBeNull();
  });
});

describe('scoreboardCardSpec', () => {
  const side = (name: string, shortName: string, score?: string) => ({
    id: shortName,
    name,
    shortName,
    abbreviation: shortName.slice(0, 3).toUpperCase(),
    ...(score === undefined ? {} : { score }),
  });
  const scores = (games: unknown[]) => ({
    toolName: 'sports.scores',
    status: 'succeeded',
    args: { team: 'Giants' },
    result: { games },
  });

  it('compiles a grounded score card without a model', () => {
    const card = scoreboardCardSpec([
      scores([
        {
          id: '401',
          league: 'mlb',
          leagueLabel: 'MLB',
          state: 'in',
          statusText: 'Top 7th',
          home: side('San Francisco Giants', 'Giants', '5'),
          away: side('Minnesota Twins', 'Twins', '2'),
        },
      ]),
    ]);
    expect(card?.spec).toMatchObject({
      title: 'Twins at Giants',
      subtitle: 'MLB',
      icon: 'sport',
      blocks: [{ type: 'score', leftValueFact: 'g0_away_score', statusFact: 'g0_status' }],
    });
    expect(card?.spec.facts.map((fact) => fact.value)).toEqual(
      expect.arrayContaining(['Minnesota Twins', '2', 'San Francisco Giants', '5', 'Top 7th']),
    );
    expect(card?.grounding).toBe('evidence');
  });

  it('lists a fixture without inventing a score, and needs a scores row at all', () => {
    const card = scoreboardCardSpec([
      scores([
        {
          id: '402',
          leagueLabel: 'NFL',
          state: 'pre',
          statusText: 'Sun, Sep 27 10:00 AM',
          home: side('New York Giants', 'Giants'),
          away: side('Tennessee Titans', 'Titans'),
        },
      ]),
    ]);
    expect(card?.spec.blocks).toEqual([
      { type: 'facts', factIds: ['g0_away', 'g0_home', 'g0_status'] },
    ]);
    expect(
      scoreboardCardSpec([{ toolName: 'web.search', status: 'succeeded', result: {} }]),
    ).toBeNull();
  });
});
