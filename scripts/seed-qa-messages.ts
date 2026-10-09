/**
 * Deterministic visual-QA fixture: injects a markdown-rich assistant reply and
 * a user message into the primary conversation so rendering can be eyeballed
 * without spending model credit. Each run is isolated and explicitly cleanable.
 *
 *   DATABASE_URL=<allocated URL> ASSISTANT_TEST_TARGET_TOKEN=<token> pnpm tsx scripts/seed-qa-messages.ts
 * Cleanup: pnpm visual-qa:cleanup <printed-run-id> with the same allocated target.
 */
import { randomUUID } from 'node:crypto';
import { conversations, createDb, messages } from '@assistant/db';
import { eq } from 'drizzle-orm';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from './test-target.js';
import {
  cleanupVisualQaRuns,
  markVisualQaRun,
  newVisualQaRunId,
  writeVisualQaManifest,
} from './visual-qa/fixture-runs.js';

const target = assertAllocatedTestTargetMarker({
  databaseUrl: process.env.DATABASE_URL,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
});
const db = createDb(target.databaseUrl);
await assertAllocatedTestDatabaseOwnership(db, target);

const cleanupIndex = process.argv.indexOf('--cleanup');
if (cleanupIndex >= 0) {
  const runId = process.argv[cleanupIndex + 1] ?? '';
  try {
    const result = await cleanupVisualQaRuns({ db, target, runId, fixtureKind: 'qa-messages' });
    if (!result.cleaned && !result.skipped) throw new Error(`No fixture run found for ${runId}`);
    console.log(JSON.stringify(result));
  } finally {
    await db.$client.end({ timeout: 5 });
  }
} else {
  const runId = newVisualQaRunId();
  const FIXTURE_TAG = `visual-qa:${runId}`;

  const markdown = [
    '## Trip plan',
    '',
    'Here is the breakdown for **Lisbon** in October:',
    '',
    '- Flights from KEF, direct',
    '  - Depart Oct 12, return Oct 19',
    '  - Around $420 with one checked bag',
    '- Stay near *Alfama*, not Bairro Alto',
    '- Day trip to Sintra if the weather holds',
    '',
    'Ordered priorities:',
    '',
    '1. Book flights this week — prices move on Fridays',
    '2. Reserve the apartment after flights are confirmed',
    '3. Check passport validity (> 6 months)',
    '',
    '- [x] Decide the dates',
    '- [ ] Book the flights',
    '- [ ] Tell the landlord',
    '',
    '> The last two Octobers were warm enough for the beach until mid-month.',
    '',
    '```ts',
    'const budget = { flights: 420, stay: 680, food: 350 };',
    'const total = Object.values(budget).reduce((a, b) => a + b, 0);',
    'console.log(`about $${total}`);',
    '```',
    '',
    '```mermaid',
    'graph LR',
    '  A[Saved memory] -->|supports| B[Knowledge connection]',
    '```',
    '',
    '| Item | Estimate | Booked |',
    '| --- | --- | --- |',
    '| Flights | $420 | no |',
    '| Apartment (7 nights) | $680 | no |',
    '| Food & transit | $350 | — |',
    '',
    'Inline `code`, **bold**, *italic*, ~~struck~~, and a [link](https://example.com).',
  ].join('\n');

  const longReply =
    'Waiting probably makes sense unless your current rate is well above today’s. Refinancing costs money up front, usually two to five percent of the loan, so the savings need time to pay that back. If rates fall another half point in the next year, refinancing then saves more than refinancing now. On the other hand, nobody can promise rates will fall, and a lower payment starting today is a certain benefit. The break-even point is the number that decides it: divide the closing costs by the monthly saving. If you plan to stay in the house longer than that many months, refinancing now is reasonable. If you might move sooner, waiting costs you nothing.';

  const briefingText = [
    'Two events overlap this morning, and one approval is waiting on you.',
    '**Today**\n- **9:30 AM – 10:30 AM** — Dentist — Laugavegur 12 · Overlaps another event\n- **10:00 AM – 11:00 AM** — Interview with Linear · Overlaps another event',
    '**Tomorrow**\n- **All day** — Team offsite',
    '**Weather**\n- 18°C, overcast · 14–21°C — San Francisco',
    '**Needs you**\n- **A128DY** — Fetch public web page en.wikipedia.org/wiki/Berlin',
    '**Mail worth reading**\n- Delta — Your itinerary changed for Friday',
  ].join('\n\n');

  const primary = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.isPrimary, true))
    .limit(1);
  if (!primary[0]) throw new Error('no primary conversation — run pnpm seed first');
  const conversationId = primary[0].id;
  const suffixes = [
    'user',
    'reply',
    'answer-user',
    'answer',
    'cards',
    'reflow-user',
    'reflow',
    'weather-user',
    'weather',
    'briefing',
    'scores-user',
    'scores',
    'route-user',
    'route',
  ];
  const messageUuidBySuffix = new Map(suffixes.map((suffix) => [suffix, randomUUID()]));
  const channelIdBySuffix = new Map(suffixes.map((suffix) => [suffix, `${FIXTURE_TAG}:${suffix}`]));
  const messageId = (suffix: string): string => {
    const id = messageUuidBySuffix.get(suffix);
    if (!id) throw new Error(`Missing manifest message ID for ${suffix}`);
    return id;
  };
  const channelMessageId = (suffix: string): string => {
    const id = channelIdBySuffix.get(suffix);
    if (!id) throw new Error(`Missing manifest channel ID for ${suffix}`);
    return id;
  };
  const [agent] = await db
    .select({ id: conversations.agentId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!agent) throw new Error('primary conversation has no owner');
  let manifest: Awaited<ReturnType<typeof writeVisualQaManifest>> | undefined;
  try {
    manifest = await writeVisualQaManifest({
      fixtureKind: 'qa-messages',
      runId,
      targetDatabaseName: target.databaseName,
      targetToken: target.token,
      agentId: agent.id,
      ids: {
        conversationId,
        conversationCreated: false,
        messageIds: [...messageUuidBySuffix.values()],
      },
      provenance: {
        marker: FIXTURE_TAG,
        channelMessageIds: [...channelIdBySuffix.values()],
      },
    });

    await db.insert(messages).values([
      {
        id: messageId('user'),
        conversationId,
        role: 'user',
        origin: 'owner',
        text: 'Can you put together the Lisbon trip plan?',
        parts: [{ type: 'text', text: 'Can you put together the Lisbon trip plan?' }],
        channelMessageId: channelMessageId('user'),
      },
      {
        id: messageId('reply'),
        conversationId,
        role: 'assistant',
        origin: 'assistant',
        text: markdown,
        parts: [{ type: 'text', text: markdown }],
        channelMessageId: channelMessageId('reply'),
      },
      // One request, one card: the mailbox search and the thread behind this
      // answer are the collapsed step trail at the bottom of it, and the booking
      // reference is masked until it is tapped.
      {
        id: messageId('answer-user'),
        conversationId,
        role: 'user',
        origin: 'owner',
        text: 'Make a card for my hotel reservation, it’s in my mailbox under 73535835545212.',
        parts: [
          {
            type: 'text',
            text: 'Make a card for my hotel reservation, it’s in my mailbox under 73535835545212.',
          },
        ],
        channelMessageId: channelMessageId('answer-user'),
      },
      {
        id: messageId('answer'),
        conversationId,
        role: 'assistant',
        origin: 'assistant',
        text: 'Your Hotel Kabuki reservation is saved as a card.',
        parts: [
          { type: 'text', text: 'Your Hotel Kabuki reservation is saved as a card.' },
          {
            type: 'data-card',
            data: {
              kind: 'generated-card',
              id: `${FIXTURE_TAG}-hotel`,
              steps: [
                {
                  tool: 'gmail.search',
                  count: '1 result',
                  detail: 'from:Katie hotels.com 73535835545212',
                },
                {
                  tool: 'gmail.read_thread',
                  count: '1 message',
                  detail: 'Fwd: Hotels.com travel confirmation — Hotel Kabuki, Sep 4–5',
                },
                { tool: 'calendar.search_events', failed: true, error: 'Calendar timed out' },
              ],
              spec: {
                version: 1,
                title: 'Hotel Kabuki',
                subtitle: 'Tomorrow, 3:00 PM check-in',
                sourceLabel: 'Hotel',
                icon: 'star',
                accent: 'violet',
                accessibilityLabel: 'Hotel Kabuki reservation',
                facts: [
                  { id: 'nights', label: 'Nights', value: 'Sep 4 – Sep 5', source: 'mail' },
                  { id: 'room', label: 'Room', value: 'King, garden view', source: 'mail' },
                  { id: 'address', label: 'Address', value: '1625 Post St, SF', source: 'mail' },
                  {
                    id: 'reference',
                    label: 'Booking reference',
                    value: '73535835545212',
                    source: 'mail',
                    sensitive: true,
                  },
                ],
                blocks: [
                  { type: 'facts', factIds: ['nights', 'room', 'address'] },
                  { type: 'code', valueFact: 'reference', format: 'text' },
                ],
                actions: [],
              },
            },
          },
        ],
        channelMessageId: channelMessageId('answer'),
      },
      {
        id: messageId('cards'),
        conversationId,
        role: 'assistant',
        origin: 'assistant',
        text: 'Structured grounding and calendar-conflict QA fallback.',
        parts: [
          { type: 'text', text: 'Structured grounding and calendar-conflict QA fallback.' },
          {
            type: 'data-card',
            data: {
              kind: 'knowledge-graph',
              id: `${FIXTURE_TAG}-graph`,
              title: 'Source-backed connection',
              complete: true,
              nodes: [
                { id: 'owner', label: 'Owner' },
                { id: 'parade', label: 'Carnival Parade' },
              ],
              edges: [
                {
                  id: 'edge-1',
                  from: 'owner',
                  to: 'parade',
                  label: 'attended',
                  evidenceQuote: 'Owner attended the Carnival Parade',
                  source: 'Calendar import · May 25, 2014',
                  confidence: 0.6,
                  ownerConfirmed: false,
                },
              ],
            },
          },
          {
            type: 'data-card',
            data: {
              kind: 'calendar-conflicts',
              id: `${FIXTURE_TAG}-conflicts`,
              title: 'Schedule conflict',
              timeZone: 'America/Los_Angeles',
              complete: true,
              conflicts: [
                {
                  id: 'conflict-1',
                  overlapStart: '2026-08-29T19:00:00.000Z',
                  overlapEnd: '2026-08-29T19:30:00.000Z',
                  groups: [
                    {
                      events: [
                        {
                          id: 'event-1',
                          title: 'Team practice',
                          start: '2026-08-29T18:30:00.000Z',
                          end: '2026-08-29T19:30:00.000Z',
                          calendar: 'Family',
                        },
                      ],
                    },
                    {
                      events: [
                        {
                          id: 'event-2',
                          title: 'School pickup',
                          start: '2026-08-29T19:00:00.000Z',
                          end: '2026-08-29T20:00:00.000Z',
                          calendar: 'Personal',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
        channelMessageId: channelMessageId('cards'),
      },
      // A model reply that ignored the short-paragraph rule: both clients split
      // it at sentence boundaries when they render it.
      {
        id: messageId('reflow-user'),
        conversationId,
        role: 'user',
        origin: 'owner',
        text: 'Should I refinance now or wait?',
        parts: [{ type: 'text', text: 'Should I refinance now or wait?' }],
        channelMessageId: channelMessageId('reflow-user'),
      },
      {
        id: messageId('reflow'),
        conversationId,
        role: 'assistant',
        origin: 'assistant',
        text: longReply,
        parts: [{ type: 'text', text: longReply }],
        channelMessageId: channelMessageId('reflow'),
      },
      {
        id: messageId('weather-user'),
        conversationId,
        role: 'user',
        origin: 'owner',
        text: "What's the weather this week?",
        parts: [{ type: 'text', text: "What's the weather this week?" }],
        channelMessageId: channelMessageId('weather-user'),
      },
      {
        id: messageId('weather'),
        conversationId,
        role: 'assistant',
        origin: 'assistant',
        text: 'Mild and mostly dry in San Francisco; Wednesday is the wet day.',
        parts: [
          { type: 'text', text: 'Mild and mostly dry in San Francisco; Wednesday is the wet day.' },
          {
            type: 'data-card',
            data: {
              kind: 'weather',
              id: `${FIXTURE_TAG}-weather-card`,
              location: 'San Francisco',
              condition: 'partly cloudy',
              temperature: '18°C',
              symbol: 'partly-cloudy',
              current: { tempC: 18, lowC: 14, highC: 21, precipPct: 40, windKmh: 18, humidity: 70 },
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
                {
                  weekday: 'Thu',
                  lowC: 11,
                  highC: 19,
                  precipPct: 10,
                  description: 'overcast',
                  symbol: 'cloudy',
                },
                {
                  weekday: 'Fri',
                  lowC: 13,
                  highC: 24,
                  precipPct: 0,
                  description: 'clear',
                  symbol: 'clear',
                },
              ],
              details: [
                { label: 'Today', value: '14–21°C' },
                { label: 'Wind', value: '18 km/h' },
                { label: 'Wed', value: '12–17°C, light rain, 80% chance of rain', symbol: 'rain' },
              ],
            },
          },
        ],
        channelMessageId: channelMessageId('weather'),
      },
      {
        id: messageId('briefing'),
        conversationId,
        role: 'assistant',
        origin: 'assistant',
        text: briefingText,
        parts: [
          { type: 'text', text: briefingText },
          {
            type: 'data-card',
            data: {
              kind: 'briefing',
              id: `${FIXTURE_TAG}-briefing-card`,
              date: 'Tuesday, Sep 22',
              timeZone: 'America/Los_Angeles',
              lead: 'Two events overlap this morning, and one approval is waiting on you.',
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
                      location: 'Laugavegur 12',
                      flag: 'conflict',
                      note: 'Overlaps another event',
                    },
                    {
                      day: 'Today',
                      time: '10:00 AM – 11:00 AM',
                      title: 'Interview with Linear',
                      flag: 'conflict',
                      note: 'Overlaps another event',
                    },
                    { day: 'Tomorrow', time: 'All day', title: 'Team offsite' },
                  ],
                },
                {
                  type: 'weather',
                  title: 'Weather',
                  location: 'San Francisco',
                  temperature: '18°C',
                  condition: 'overcast',
                  symbol: 'cloudy',
                  range: '14–21°C',
                },
                {
                  type: 'attention',
                  title: 'Needs you',
                  items: [
                    { title: 'Fetch public web page en.wikipedia.org/wiki/Berlin', meta: 'A128DY' },
                  ],
                },
                {
                  type: 'mail',
                  title: 'Mail worth reading',
                  items: [{ title: 'Delta', detail: 'Your itinerary changed for Friday' }],
                },
              ],
            },
          },
        ],
        channelMessageId: channelMessageId('briefing'),
      },
      {
        id: messageId('scores-user'),
        conversationId,
        role: 'user',
        origin: 'owner',
        text: "What's the Giants score?",
        parts: [{ type: 'text', text: "What's the Giants score?" }],
        channelMessageId: channelMessageId('scores-user'),
      },
      {
        id: messageId('scores'),
        conversationId,
        role: 'assistant',
        origin: 'assistant',
        text: 'The Giants lead the Twins 5-2 in the top of the 7th.',
        parts: [
          { type: 'text', text: 'The Giants lead the Twins 5-2 in the top of the 7th.' },
          {
            type: 'data-card',
            data: {
              kind: 'scoreboard',
              id: `${FIXTURE_TAG}-scoreboard`,
              title: 'MLB',
              fetchedAt: new Date().toISOString(),
              timeZone: 'America/Los_Angeles',
              accompaniesProse: true,
              games: [
                {
                  id: '401873650',
                  league: 'mlb',
                  leagueLabel: 'MLB',
                  state: 'in',
                  statusText: 'Top 7th',
                  startsAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
                  venue: 'Oracle Park',
                  broadcast: 'NBC Sports Bay Area',
                  link: 'https://www.espn.com/mlb/game/_/gameId/401873650',
                  home: {
                    id: '26',
                    name: 'San Francisco Giants',
                    shortName: 'Giants',
                    abbreviation: 'SF',
                    logo: 'https://a.espncdn.com/i/teamlogos/mlb/500/scoreboard/sf.png',
                    score: '5',
                    record: '78-78',
                  },
                  away: {
                    id: '9',
                    name: 'Minnesota Twins',
                    shortName: 'Twins',
                    abbreviation: 'MIN',
                    logo: 'https://a.espncdn.com/i/teamlogos/mlb/500/scoreboard/min.png',
                    score: '2',
                    record: '69-87',
                  },
                },
              ],
            },
          },
        ],
        channelMessageId: channelMessageId('scores'),
      },
      {
        id: messageId('route-user'),
        conversationId,
        role: 'user',
        origin: 'owner',
        text: 'How long to drive to Oracle Park?',
        parts: [{ type: 'text', text: 'How long to drive to Oracle Park?' }],
        channelMessageId: channelMessageId('route-user'),
      },
      {
        id: messageId('route'),
        conversationId,
        role: 'assistant',
        origin: 'assistant',
        text: 'About 9 minutes by car via King St.',
        parts: [
          { type: 'text', text: 'About 9 minutes by car via King St.' },
          {
            type: 'data-card',
            data: {
              kind: 'route',
              id: `${FIXTURE_TAG}-route-card`,
              mode: 'driving',
              accompaniesProse: true,
              origin: { label: 'Current Location', lat: 37.7898, lng: -122.3942, current: true },
              destination: {
                label: 'Oracle Park',
                address: '24 Willie Mays Plaza, San Francisco, CA 94107',
                lat: 37.7786,
                lng: -122.3893,
              },
              durationSeconds: 540,
              distanceMeters: 1850,
              departAt: new Date().toISOString(),
              arriveAt: new Date(Date.now() + 540_000).toISOString(),
              routeName: 'King St',
              steps: [
                { instruction: 'Head south on Fremont St', distanceMeters: 400 },
                { instruction: 'Turn left onto Harrison St', distanceMeters: 350 },
                { instruction: 'Turn right onto 2nd St', distanceMeters: 800 },
                { instruction: 'Turn left onto King St', distanceMeters: 300 },
              ],
              // Fremont St → Harrison → 2nd St → King St, encoded.
              polyline: 'gyseFvb`jVbQcQrIfJjMcQzJ_N~MjH',
              mapsUrl:
                'https://maps.apple.com/?saddr=37.7898%2C-122.3942&daddr=37.7786%2C-122.3893&dirflg=d',
            },
          },
        ],
        channelMessageId: channelMessageId('route'),
      },
    ]);

    console.log(`fixture inserted into conversation ${conversationId}; cleanup run ${runId}`);
    await markVisualQaRun(manifest, 'seeded');
    await markVisualQaRun(manifest, 'complete');
  } catch (error) {
    if (manifest) await markVisualQaRun(manifest, 'failed', { error: 'fixture writer failed' });
    throw error;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}
