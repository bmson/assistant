import type { ZodType } from 'zod';
import type { RiskTier, ToolFlags } from '../types.js';

/** Local evidence fixtures; no live adapter or arbitrary network implementation. */
export interface QuestionToolFixture {
  name: string;
  schema: ZodType;
  risk?: RiskTier;
  flags?: ToolFlags;
  acceptsUntrustedInput?: boolean;
  summary?: string;
  /** Consume results in order, retaining the last result for a bounded retry. */
  outcomes: Array<{ result: unknown } | { error: string }>;
}

/** Sanitized scenarios from the September 7 home audit; record numbers preserve coverage. */
export interface QuestionCase {
  id: string;
  records: number[];
  request: string;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  source?: { url: string; text: string; snippet?: string; failed?: boolean };
  weather?: 'current' | 'failed';
  /** Stub `sports.scores` with a live Twins at Giants game. */
  sports?: 'live';
  /** Stub `maps.directions` with a drive to Oracle Park. */
  maps?: 'route';
  /** Stub `calendar.list_events` with one upcoming event, with or without a location. */
  calendar?: 'next-meeting' | 'no-location';
  mailbox?: 'hotel' | 'empty';
  memory?: boolean;
  plan?: 'reply' | 'workflow' | 'clarify';
  missingInfo?: string[];
  /** Override only inside the rolled-back transaction, never the real owner profile. */
  timeZone?: string;
  at?: string;
  localTools?: QuestionToolFixture[];
  /** A previous task's captured ledger, scoped to this synthetic conversation. */
  priorEvidence?: Array<{
    name: string;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>;
  approvalDecision?: 'approved' | 'denied';
  /** Resume retryable task failures without waiting for real time to elapse. */
  retryFailures?: number;
  verification?:
    | { decision: 'publish' | 'revise'; revisedText?: string; reasons?: string[] }
    | { unavailable: true };
  script: Array<{
    text?: string;
    toolCalls?: Array<{ toolName: string; input: Record<string, unknown> }>;
    failure?: 'provider' | 'task-budget' | 'daily-budget';
  }>;
  expect: {
    matches: string[];
    excludes?: string[];
    tools?: string[];
    failedTools?: string[];
    noTools?: boolean;
    savedCount?: number;
    savedContent?: string[];
    statuses?: string[];
    maxApprovals?: number;
    card?: boolean;
    /** A scoreboard card rides the reply. */
    scoreboard?: boolean;
    /** A route card rides the reply. */
    route?: boolean;
    cardValues?: string[];
    responseCardKinds?: string[];
    forbiddenResponseCardKinds?: string[];
    scoreboardScores?: { home: string; away: string };
    routeTimes?: { departAt: string; arriveAt: string };
    approvalCount?: number;
    statusSequence?: string[];
    /** Exact durable calls prove both bounded retries and lack of duplicate writes. */
    calls?: Array<{ name: string; status: string; count: number; args?: Record<string, unknown> }>;
    /** Local tool bodies invoked, independently of a waiting/denied ledger row. */
    executionCounts?: Record<string, number>;
    contextMatches?: string[];
    modelStepCount?: number;
    verification?: {
      attempted: boolean;
      revised: boolean;
      unavailable: boolean;
      blocked?: boolean;
    };
  };
}

const presidentSource = {
  url: 'https://www.forseti.is/forseti/halla-tomasdottir',
  text: 'Halla Tómasdóttir is President of Iceland. She took office on August 1, 2024. Verified snapshot: September 7, 2026.',
};
const scoreSource = {
  url: 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=137&date=2026-09-07&hydrate=linescore',
  snippet: 'Ground Balls - Fly Balls: 7-3. Read the box score for the actual game result.',
  text: 'MLB official final result, September 7, 2026: San Francisco Giants 5, St. Louis Cardinals 4. Final in 11 innings. The 7-3 figure in the search snippet is a batted-ball statistic, not the score.',
};
const birthdayList = `${Array.from(
  { length: 54 },
  (_, i) =>
    `Person ${i + 1}${i === 0 ? ' (d)' : ''}\tApril ${(i % 28) + 1}, ${1950 + i}\tOwner note ${i + 1}`,
).join('\n')}\nTwin A & Twin B\tAugust 2, 2001\tShared date\nUndated Person`;
const birthdayRequest = `Here are birthdays for family members, update their information for me. Family Birthdays\n${birthdayList}`;
const memoryCall = (content: string, subject = 'owner') => ({
  toolName: 'memory.save',
  input: { content, subject, category: 'knowledge', kind: 'fact' },
});
const hotelAnswer =
  'Harbor Hotel, Sunnyvale. Check-in: September 5, 2026 at 4:00 PM. Check-out: September 6 at 11:00 AM. Total: $105.85. The reservation is September 5, not tomorrow (September 4).';
const hotelHistory: QuestionCase['history'] = [
  { role: 'user', text: 'Find my hotel reservation in my mailbox under QA-BOOKING-123.' },
  { role: 'assistant', text: 'You are probably staying in Morgan Hill tomorrow.' },
];

export const QUESTION_CASES: QuestionCase[] = [
  {
    id: 'javascript-background-notice',
    plan: 'reply',
    records: [666],
    request: 'How do I write hello world in JavaScript',
    history: [
      {
        role: 'assistant',
        text: '[Background notice — not a reply to your message]\nA birthday reminder fired.',
      },
    ],
    script: [{ text: '```javascript\nconsole.log("Hello, world!");\n```' }],
    expect: { matches: ['console\\.log\\('], excludes: ['birthday'], noTools: true },
  },
  ...[
    { id: 'president-current', records: [668], request: 'Who is the current president of Iceland' },
    {
      id: 'president-correction',
      records: [670],
      request: 'Look it up, don’t think this is correct',
    },
    { id: 'president-terse-retry', records: [672], request: 'Rub it' },
    { id: 'president-explicit-search', records: [674], request: 'Search the web' },
  ].map(
    (item): QuestionCase => ({
      ...item,
      source: presidentSource,
      history: [
        { role: 'user', text: 'Who is the current president of Iceland?' },
        { role: 'assistant', text: 'Guðni Th. Jóhannesson was re-elected in 2024.' },
      ],
      script: [
        { text: 'Halla Tómasdóttir is president of Iceland; she took office on August 1, 2024.' },
      ],
      expect: {
        matches: ['Halla', 'T[oó]masd[oó]ttir'],
        excludes: ['Guðni.{0,30}(?:is|re.elected)'],
        tools: ['web.search', 'web.fetch'],
      },
    }),
  ),
  ...[
    {
      id: 'giants-score',
      records: [744, 748, 750],
      request: 'What is the current SF giants score',
    },
    { id: 'giants-score-typo', records: [746], request: 'Check the wcore' },
  ].map(
    (item): QuestionCase => ({
      ...item,
      source: scoreSource,
      history: [
        { role: 'user', text: 'What is the current SF Giants score?' },
        { role: 'assistant', text: 'The Giants are ahead 7–3.' },
      ],
      script: [{ text: 'Final: Giants 5, Cardinals 4, in 11 innings (September 7, 2026).' }],
      expect: {
        matches: ['Giants', '5', 'Cardinals', '4', 'final|finished|won|beat', '11'],
        excludes: ['(?:Giants|score|ahead|lead).{0,20}7\\s*[–−-]\\s*3'],
        tools: ['web.search', 'web.fetch'],
      },
    }),
  ),
  // The scores tool answers directly; the September web path stays covered
  // above for registries without it.
  {
    id: 'giants-score-live',
    records: [744],
    request: "What's the Giants score?",
    sports: 'live',
    script: [
      { toolCalls: [{ toolName: 'sports.scores', input: { team: 'Giants' } }] },
      { text: 'The Giants lead the Twins 5-2 in the top of the 7th.' },
    ],
    expect: {
      matches: ['Giants', '5', '2', 'Twins'],
      tools: ['sports.scores'],
      scoreboard: true,
    },
  },
  {
    id: 'giants-score-invented',
    records: [748],
    request: "What's the Giants score?",
    sports: 'live',
    script: [
      { toolCalls: [{ toolName: 'sports.scores', input: { team: 'Giants' } }] },
      { text: 'The Giants are ahead 7-3.' },
    ],
    expect: {
      matches: ['do not state 7-3', 'verified source data'],
      excludes: ['ahead 7-3', 'needs to be retried'],
      tools: ['sports.scores'],
      statuses: ['needs_attention'],
      responseCardKinds: ['scoreboard'],
      scoreboardScores: { home: '5', away: '2' },
      verification: { attempted: false, revised: false, unavailable: false, blocked: true },
    },
  },
  {
    id: 'directions-drive-time',
    // Not from the September audit: the trip path did not exist then.
    records: [],
    request: "What's the drive time to Oracle Park?",
    maps: 'route',
    script: [
      { toolCalls: [{ toolName: 'maps.directions', input: { destination: 'Oracle Park' } }] },
      { text: 'About 9 minutes by car via King St, so you would arrive at 11:09.' },
    ],
    expect: {
      matches: ['9 min', 'King St'],
      tools: ['maps.directions'],
      route: true,
    },
  },
  {
    id: 'score-and-drive-time',
    // Phase 4: two live lookups in one question, answered in the order asked.
    records: [],
    request: "What's the Giants score and the drive time to Oracle Park?",
    sports: 'live',
    maps: 'route',
    script: [
      { toolCalls: [{ toolName: 'sports.scores', input: { team: 'Giants' } }] },
      { toolCalls: [{ toolName: 'maps.directions', input: { destination: 'Oracle Park' } }] },
      {
        text: 'The Giants lead the Twins 5-2 in the top of the 7th. Oracle Park is about 9 minutes by car via King St.',
      },
    ],
    expect: {
      matches: ['Giants', '5', '2', 'Twins', '9 min', 'King St'],
      tools: ['sports.scores', 'maps.directions'],
      scoreboard: true,
      route: true,
    },
  },
  {
    id: 'trip-to-next-meeting',
    // Phase 4: the destination comes from the calendar, then the route.
    records: [],
    request: 'When should I leave for my next meeting?',
    at: '2026-09-22T16:00:00Z',
    timeZone: 'America/Los_Angeles',
    calendar: 'next-meeting',
    maps: 'route',
    script: [
      {
        text: 'Design review starts at 11:00 AM Pacific at Oracle Park. The drive is about 9 minutes via King St. Leave by 10:46 AM for a five-minute buffer before the meeting.',
      },
    ],
    expect: {
      matches: [
        'Design review',
        'Oracle Park',
        '9 min',
        'King St',
        '10:46 AM',
        'five.minute buffer',
      ],
      excludes: ['leave a few minutes'],
      tools: ['calendar.list_events', 'maps.directions'],
      route: true,
      responseCardKinds: ['route'],
      calls: [
        {
          name: 'maps.directions',
          status: 'succeeded',
          count: 1,
          args: { destination: 'Oracle Park', arriveBy: '2026-09-22T18:00:00.000Z' },
        },
      ],
      routeTimes: {
        departAt: '2026-09-22T17:51:00.000Z',
        arriveAt: '2026-09-22T18:00:00.000Z',
      },
    },
  },
  {
    id: 'trip-to-meeting-without-location',
    records: [],
    request: 'How long will it take me to get to my next meeting?',
    calendar: 'no-location',
    maps: 'route',
    script: [{ text: 'It should take about 20 minutes.' }],
    expect: {
      matches: ['Design review', 'no location'],
      excludes: ['20 minutes'],
      tools: ['calendar.list_events'],
      statuses: ['needs_attention'],
    },
  },
  {
    id: 'calendar-and-weather',
    // Phase 4: a private read and a live lookup in one question.
    records: [],
    request: "What's on my calendar tomorrow and what's the weather?",
    calendar: 'next-meeting',
    weather: 'current',
    script: [
      { toolCalls: [{ toolName: 'weather.lookup', input: { place: 'San Francisco' } }] },
      {
        text: 'Tomorrow you have Design review at Oracle Park. In San Francisco it is 18°C and cloudy.',
      },
    ],
    expect: {
      matches: ['Design review', '18°C', 'cloudy'],
      tools: ['calendar.list_events', 'weather.lookup'],
    },
  },
  {
    id: 'calendar-and-failed-weather',
    records: [],
    request: "What's on my calendar tomorrow and what's the weather?",
    calendar: 'next-meeting',
    weather: 'failed',
    script: [
      { toolCalls: [{ toolName: 'weather.lookup', input: { place: 'San Francisco' } }] },
      { text: 'Tomorrow you have Design review. It will be 22°C and sunny.' },
    ],
    expect: {
      matches: ['Design review', "couldn't retrieve current weather"],
      excludes: ['22°C', 'sunny'],
      tools: ['calendar.list_events'],
      failedTools: ['weather.lookup'],
      statuses: ['needs_attention'],
      responseCardKinds: ['calendar-event'],
      forbiddenResponseCardKinds: ['weather'],
    },
  },
  {
    id: 'score-card-request',
    records: [750],
    request: 'Create a card for the Giants game',
    sports: 'live',
    script: [
      { toolCalls: [{ toolName: 'sports.scores', input: { team: 'Giants' } }] },
      { text: 'The Giants lead the Twins 5-2 in the top of the 7th.' },
    ],
    expect: {
      matches: ['5-2', 'Saved “Twins at Giants”'],
      tools: ['sports.scores'],
      scoreboard: true,
    },
  },
  ...[
    {
      id: 'weather-work',
      records: [738],
      request:
        'How is the weather going to be by work tomorrow? I work at 181 Fremont Street, San Francisco.',
    },
    {
      id: 'weather-address-followup',
      records: [740],
      request: 'I work at 181 Fremont street San Francisco',
    },
    {
      id: 'weather-current',
      records: [742],
      request: 'How is the weather currently in San Francisco?',
    },
  ].map(
    (item): QuestionCase => ({
      ...item,
      weather: 'current',
      history: [
        { role: 'user', text: 'How is the weather going to be by work tomorrow?' },
        { role: 'assistant', text: 'Which location should I use for the weather forecast?' },
      ],
      script: [
        { toolCalls: [{ toolName: 'weather.lookup', input: { place: 'San Francisco' } }] },
        {
          text: 'San Francisco: 18°C and cloudy now. Tue, September 8: low 14°C, high 20°C; rain chance 10%.',
        },
      ],
      expect: {
        matches: [item.id === 'weather-current' ? '18|64' : '20|68', 'cloud|Tue'],
        tools: ['weather.lookup'],
      },
    }),
  ),
  {
    id: 'weather-provider-failure',
    records: [738, 742],
    request: 'How is the weather currently in San Francisco?',
    weather: 'failed',
    history: [{ role: 'assistant', text: 'It is 24°C and sunny.' }],
    script: [
      { toolCalls: [{ toolName: 'weather.lookup', input: { place: 'San Francisco' } }] },
      { text: 'It is 24°C and sunny.' },
    ],
    expect: {
      matches: ['couldn.t|unable|unavailable|can.t'],
      excludes: ['24|sunny|forecast is'],
      failedTools: ['weather.lookup'],
      statuses: ['needs_attention'],
    },
  },
  {
    id: 'birthdays-all-56',
    records: [703, 707],
    request: birthdayRequest,
    memory: true,
    script: [
      { toolCalls: [memoryCall('Undated Person birthday: January 1, 2000.', 'Undated Person')] },
    ],
    expect: {
      matches: ['Saved 56 of 56'],
      savedCount: 56,
      savedContent: ['deceased', 'Twin A', 'Twin B'],
      tools: ['memory.save'],
    },
  },
  {
    id: 'birthdays-graph-incomplete',
    records: [709],
    request: 'Can you attach these birthdays to the people in my graph and memory',
    memory: true,
    history: [{ role: 'user', text: birthdayRequest }],
    script: [{ text: 'Everything is saved and attached to your graph.' }],
    expect: {
      matches: ['Saved 56 of 56', 'Graph attachments are not yet verified'],
      savedCount: 56,
      statuses: ['needs_attention'],
    },
  },
  {
    id: 'order-missing-details',
    plan: 'reply',
    records: [695, 697],
    request: 'I want you to remember our order, next time I ask you',
    memory: true,
    history: [{ role: 'user', text: 'This is our regular order for Neighborhood Pupuseria.' }],
    script: [{ text: 'Please share the dishes and quantities so I can remember your order.' }],
    expect: {
      matches: [
        '(?:share|send|what|which|provide|need|tell).*(?:order|dish|item|detail|quantit|get|remember)|(?:don.t (?:see|have)|missing).*(?:order|detail)',
      ],
      excludes: ['(?:I(?:.ve| have)? saved|saved your|I(?:.ve| have)? remembered)|shrimp'],
      savedCount: 0,
    },
  },
  {
    id: 'order-save',
    records: [699],
    request:
      'This is our order for you to remember: Neighborhood Pupuseria. Alex: two bean and cheese pupusas and one cheese pupusa. Sam: one zucchini and one mushroom pupusa.',
    memory: true,
    script: [
      {
        toolCalls: [
          memoryCall(
            'Neighborhood Pupuseria order: Alex: two bean and cheese pupusas and one cheese pupusa. Sam: one zucchini and one mushroom pupusa.',
          ),
        ],
      },
      { text: 'Saved your Neighborhood Pupuseria order to long-term memory.' },
    ],
    expect: {
      matches: ['saved|remember'],
      savedContent: ['Alex', 'bean', 'Sam', 'zucchini', 'mushroom'],
      tools: ['memory.save'],
    },
  },
  {
    id: 'save-status-unverified',
    records: [701, 705],
    request: 'Was it save to long term memory',
    memory: true,
    history: [
      { role: 'user', text: 'Remember our restaurant order.' },
      { role: 'assistant', text: 'Everything is saved.' },
    ],
    script: [{ text: 'I cannot verify a long-term memory save for that request.' }],
    expect: {
      matches: [
        '(?:no|not|can.t|cannot|couldn.t|unable|unverified).*(?:sav|memor|verif|confirm)|(?:sav|memor).*(?:not|unverified)',
      ],
      excludes: ['yes.{0,20}saved'],
    },
  },
  {
    id: 'hotel-mailbox-dates',
    records: [658],
    request:
      'What are the details of my hotel reservation tomorrow? It is in my mailbox under QA-BOOKING-123.',
    mailbox: 'hotel',
    script: [{ text: 'You are staying in Morgan Hill tomorrow.' }],
    expect: {
      matches: [
        'Harbor Hotel',
        'September 5|Sep(?:t)?\\.? 5|2026-09-05',
        '4:00|4 ?PM|16:00',
        '105\\.85',
      ],
      excludes: ['Morgan Hill'],
      tools: ['gmail.search', 'gmail.read_thread'],
    },
  },
  {
    id: 'hotel-reservation-card',
    records: [658],
    request: 'Create a card for my hotel reservation in my mailbox under QA-BOOKING-123.',
    mailbox: 'hotel',
    script: [
      { toolCalls: [{ toolName: 'gmail.search', input: { query: 'QA-BOOKING-123' } }] },
      { toolCalls: [{ toolName: 'gmail.read_thread', input: { threadId: 'hotel-1' } }] },
      { text: hotelAnswer },
    ],
    expect: {
      matches: ['Saved'],
      excludes: ['couldn.t.*card|nothing was saved'],
      tools: ['gmail.search', 'gmail.read_thread'],
      card: true,
      cardValues: ['Harbor Hotel', '105.85'],
    },
  },
  {
    id: 'hotel-card-unavailable',
    records: [658],
    request: 'Create a card for my hotel reservation in my mailbox under QA-MISSING.',
    mailbox: 'empty',
    script: [
      { toolCalls: [{ toolName: 'gmail.search', input: { query: 'QA-MISSING' } }] },
      { text: 'The card has been created.' },
    ],
    expect: {
      matches: ['couldn.t create.*card|not fully completed'],
      excludes: ['card has been created'],
      statuses: ['needs_attention'],
    },
  },
  {
    id: 'hotel-short-followup',
    records: [717],
    request: 'Where are we staying',
    mailbox: 'hotel',
    history: hotelHistory,
    script: [{ text: 'Harbor Hotel in Sunnyvale. You check in Friday September 5, 2026.' }],
    expect: {
      matches: ['Harbor Hotel', 'Sunnyvale'],
      excludes: ['Morgan Hill', 'Friday', 'checked in'],
      tools: ['gmail.search', 'gmail.read_thread'],
      responseCardKinds: ['email-thread'],
      forbiddenResponseCardKinds: ['email-results'],
    },
  },
  {
    id: 'applications-empty-evidence',
    records: [688],
    request: 'what companies have I applied for?',
    mailbox: 'empty',
    script: [
      {
        text: 'I found no application confirmations in the mailbox search, so I cannot confirm which companies you applied to.',
      },
    ],
    expect: {
      matches: ['no|not|cannot|couldn.t'],
      excludes: ['Applied to:|Google|Stripe'],
      tools: ['gmail.search'],
    },
  },
  {
    id: 'job-recommendations',
    records: [683, 685, 690],
    request:
      'I was rejected from ExampleCo. I need to find other companies to apply for. Where should I try?',
    source: {
      url: 'https://careers.example.org/design',
      text: 'Example Design Studio has an open Senior Product Designer role in San Francisco. Published September 7, 2026. Applications are open. Salary and referral availability are not listed.',
    },
    script: [
      {
        text: 'Example Design Studio lists an open Senior Product Designer role in San Francisco. Salary and referral availability are not listed.',
      },
    ],
    expect: {
      matches: ['Example Design Studio', 'Product Designer'],
      excludes: ['guaranteed|already applied'],
      tools: ['web.search', 'web.fetch'],
    },
  },
  {
    id: 'restaurant-on-route',
    records: [693],
    request:
      'We are leaving San Francisco tomorrow around 10am and driving to San Jose for soccer. Can you find a place to eat along the way?',
    source: {
      url: 'https://restaurant.example.org/menu',
      text: 'Peninsula Lunch Cafe, San Mateo, opens daily at 11:00 AM. Pupusas and vegetarian lunch options. Reservations, traffic and detour times were not provided.',
    },
    script: [
      {
        text: 'Peninsula Lunch Cafe in San Mateo opens at 11 AM and has vegetarian lunch options. I have not verified the detour or traffic.',
      },
    ],
    expect: {
      matches: ['Peninsula Lunch Cafe', '11'],
      excludes: ['zero detour|guaranteed'],
      tools: ['web.search', 'web.fetch'],
    },
  },
  {
    id: 'scouting-source-failure',
    records: [720],
    request:
      'My child is playing against Example FC U13 boys. Can you investigate the team, their uniform, and tactics?',
    source: { url: 'https://club.example.org/u13', text: '', failed: true },
    script: [{ text: 'They wear red and use a 4-3-3; target number 7.' }],
    expect: {
      matches: ['couldn.t retrieve live sources|not verified|haven.t verified'],
      excludes: ['4-3-3|number 7|wear red'],
      tools: ['web.search'],
      failedTools: ['web.fetch'],
      statuses: ['needs_attention'],
    },
  },
  {
    id: 'arrival-reminder-is-not-memory',
    records: [727],
    request: 'Next time we are down in San Jose remind me about Example Brunch place',
    memory: true,
    script: [
      {
        toolCalls: [
          memoryCall(
            'The owner wants a reminder about Example Brunch on a future visit to San Jose.',
          ),
        ],
      },
      { text: "I'll remind you next time you are in San Jose." },
    ],
    expect: {
      statuses: ['needs_attention'],
      matches: ['not|cannot|can.t|unable|unconfirmed|no '],
      excludes: ['I.ll remind you|I will remind you'],
      tools: ['memory.save'],
    },
  },
  {
    id: 'family-split-coverage',
    records: [653, 712],
    request:
      'I am taking Alex to soccer while Sam is taking Robin roller skating. Remember that each event has a different parent covering it.',
    memory: true,
    script: [
      {
        toolCalls: [
          memoryCall(
            'The owner takes Alex to soccer; Sam takes Robin roller skating. Each event has a different parent covering it.',
          ),
        ],
      },
      { text: 'Saved: you cover soccer with Alex; Sam covers roller skating with Robin.' },
    ],
    expect: {
      matches: ['Alex', 'Sam', 'Robin'],
      excludes: ['unresolved conflict|you cannot attend both'],
      savedContent: ['Alex', 'Sam', 'Robin'],
      tools: ['memory.save'],
    },
  },
  {
    id: 'interview-no-false-mutation',
    plan: 'reply',
    records: [664],
    request: 'The interview happened already',
    script: [{ text: 'Understood—the interview has already happened.' }],
    expect: {
      matches: ['interview|happened|understood'],
      excludes: ['marking.{0,30}complete|marked.{0,30}complete|cancelled.{0,30}reminder'],
    },
  },
];

// These owner turns invoke the application approval handler before the executor.
// Keep them explicit instead of inflating executor coverage with a fabricated task.
export const APPLICATION_CASES = [
  {
    records: [678, 736],
    suite: 'packages/application/src/chat-budget-reply.test.ts',
    description:
      'Bare budget approval binds only to one immediately preceding pending card; atomic wake tests verify the actual mutation.',
  },
];
