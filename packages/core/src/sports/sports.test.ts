import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearSportsCache, normalizeEvent } from './espn.js';
import { leagueByKey, leagueNamedIn } from './leagues.js';
import { lookupScores, teamMatches } from './lookup.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), 'utf8'));
const timeZone = 'America/Los_Angeles';
const mlb = leagueByKey('mlb');
const nfl = leagueByKey('nfl');
if (!mlb || !nfl) throw new Error('leagues missing');

/** Serves recorded provider bodies by URL; anything unrecorded is an empty league. */
function fakeFetch(routes: Record<string, unknown>) {
  const requested: string[] = [];
  const impl = async (url: string) => {
    requested.push(url);
    const hit = Object.entries(routes).find(([pattern]) => url.includes(pattern));
    return new Response(JSON.stringify(hit?.[1] ?? { events: [], sports: [] }), { status: 200 });
  };
  return { impl, requested };
}

beforeEach(() => clearSportsCache());

describe('normalizeEvent', () => {
  it('reads a final with scores, winner, record, and a grounding line', () => {
    const [event] = fixture('mlb-scoreboard').events;
    const game = normalizeEvent(event, mlb, timeZone);
    expect(game).toMatchObject({
      league: 'mlb',
      leagueLabel: 'MLB',
      state: 'post',
      statusText: 'Final',
      home: { name: 'New York Yankees', abbreviation: 'NYY', score: '2', winner: true },
      away: { name: 'Tampa Bay Rays', score: '0', winner: false },
    });
    expect(game?.home.logo).toMatch(/^https:\/\/a\.espncdn\.com\//);
    expect(game?.line).toBe('Tampa Bay Rays at New York Yankees: 0-2, Final');
  });

  it('shows a scheduled game at its owner-local start and no scoreline', () => {
    const [event] = fixture('nfl-scoreboard-pre').events;
    const game = normalizeEvent(event, nfl, timeZone, new Date('2026-09-22T19:00:00Z'));
    expect(game?.state).toBe('pre');
    expect(game?.statusText).toMatch(/^Sun, Sep 27 10:00 AM$/);
    expect(game?.line).not.toMatch(/\d-\d/);
    expect(game?.broadcast).toBeTruthy();
  });

  it('keeps a live game live and reports a goalless draw as 0-0', () => {
    const [event] = fixture('epl-scoreboard').events;
    const live = structuredClone(event);
    live.competitions[0].status.type = { state: 'in', shortDetail: "67'" };
    expect(normalizeEvent(live, leagueByKey('epl') as never, timeZone)).toMatchObject({
      state: 'in',
      statusText: "67'",
    });
    const draw = normalizeEvent(
      fixture('epl-scoreboard').events[1],
      leagueByKey('epl') as never,
      timeZone,
    );
    expect(draw?.line).toMatch(/: 0-0, FT$/);
  });

  it('drops logos from any host but the provider CDN and strips control characters', () => {
    const [event] = fixture('mlb-scoreboard').events;
    const hostile = structuredClone(event);
    const team = hostile.competitions[0].competitors[0].team;
    team.logo = 'https://attacker.example/pixel.png';
    team.logos = [];
    team.displayName = 'New York\u0000 Yankees\u202e';
    const game = normalizeEvent(hostile, mlb, timeZone);
    const side = game?.home.id === team.id ? game?.home : game?.away;
    expect(side?.logo).toBeUndefined();
    expect(side?.name).toBe('New York Yankees');
  });
});

describe('team and league names', () => {
  const teams = [
    ...fixture('mlb-teams').sports[0].leagues[0].teams,
    ...fixture('nfl-teams').sports[0].leagues[0].teams,
  ].map(({ team }: { team: Record<string, string> }, index: number) => ({
    id: team.id,
    league: index < 3 ? 'mlb' : 'nfl',
    name: team.displayName,
    shortName: team.shortDisplayName,
    nickname: team.name,
    location: team.location,
    abbreviation: team.abbreviation,
  }));
  const named = (query: string) =>
    teams
      .filter((team) => teamMatches(team as Parameters<typeof teamMatches>[0], query))
      .map((t) => t.name);

  it('matches nicknames, places, codes, and owner shorthand', () => {
    expect(named('Giants')).toEqual(['San Francisco Giants', 'New York Giants']);
    expect(named('SF Giants')).toEqual(['San Francisco Giants']);
    expect(named('giants baseball')).toEqual(['San Francisco Giants']);
    expect(named('niners')).toEqual(['San Francisco 49ers']);
    expect(named('NYY')).toEqual(['New York Yankees']);
    expect(named('the yankees')).toEqual(['New York Yankees']);
    expect(named('Dodgers')).toEqual([]);
  });

  it('finds a league named in a request', () => {
    expect(leagueNamedIn('any Premier League scores today?')?.key).toBe('epl');
    expect(leagueNamedIn("what's on in the NFL")?.key).toBe('nfl');
    expect(leagueNamedIn('how was the game')).toBeUndefined();
  });
});

describe('lookupScores', () => {
  const routes = {
    'baseball/mlb/teams/': fixture('sf-schedule'),
    'baseball/mlb/teams': fixture('mlb-teams'),
    'football/nfl/teams': fixture('nfl-teams'),
    'football/nfl/scoreboard?dates=20260927': fixture('nfl-scoreboard-pre'),
    'baseball/mlb/scoreboard?dates=20260922': fixture('mlb-scoreboard'),
  };

  it("returns the team's games on the day across every league the name fits", async () => {
    const { impl } = fakeFetch(routes);
    const result = await lookupScores({
      team: 'Giants',
      date: '2026-09-27',
      timeZone,
      fetchImpl: impl,
    });
    expect(result.selection).toBe('today');
    expect(result.games.map((game) => game.line)).toEqual([
      expect.stringContaining('Tennessee Titans at New York Giants'),
    ]);
  });

  it('asks which team when a shared name has no game that day', async () => {
    const { impl } = fakeFetch(routes);
    const result = await lookupScores({
      team: 'Giants',
      date: '2026-09-30',
      timeZone,
      fetchImpl: impl,
    });
    expect(result.games).toEqual([]);
    expect(result.candidates?.map((c) => c.leagueLabel)).toEqual(['MLB', 'NFL']);
  });

  it("falls back to one team's last result and next game", async () => {
    const { impl, requested } = fakeFetch({
      ...routes,
      'baseball/mlb/scoreboard?dates=20260922': { events: [] },
    });
    const result = await lookupScores({
      team: 'SF Giants',
      timeZone,
      now: new Date('2026-09-22T19:00:00Z'),
      fetchImpl: impl,
    });
    expect(result.selection).toBe('last-and-next');
    expect(result.games.map((game) => game.state)).toEqual(['post', 'pre']);
    expect(requested.some((url) => /teams\/\d+\/schedule$/.test(url))).toBe(true);
  });

  it('lists a league slate and caches repeat reads', async () => {
    const { impl, requested } = fakeFetch(routes);
    const first = await lookupScores({
      league: 'mlb',
      date: '2026-09-22',
      timeZone,
      fetchImpl: impl,
    });
    await lookupScores({ league: 'mlb', date: '2026-09-22', timeZone, fetchImpl: impl });
    expect(first.games).toHaveLength(2);
    expect(requested.filter((url) => url.includes('mlb/scoreboard'))).toHaveLength(1);
  });

  it('flags an unknown team so the caller can fall back to the web', async () => {
    const { impl } = fakeFetch(routes);
    const result = await lookupScores({ team: 'Reykjavik Vikings', timeZone, fetchImpl: impl });
    expect(result).toMatchObject({ unsupported: true, games: [] });
  });
});

it('does not substitute current season fixtures for an explicit historical date', async () => {
  const { impl, requested } = fakeFetch({
    'baseball/mlb/teams': fixture('mlb-teams'),
    'baseball/mlb/teams/': fixture('sf-schedule'),
  });
  const result = await lookupScores({
    team: 'SF Giants',
    league: 'mlb',
    date: '2020-02-29',
    timeZone,
    fetchImpl: impl,
  });
  expect(result.games).toEqual([]);
  expect(result.date).toBe('2020-02-29');
  expect(result.evidenceNote).toContain('not substituted');
  expect(requested.some((url) => url.endsWith('/schedule'))).toBe(false);
});
it('does not claim unsupported or no-game results after unavailable source reads', async () => {
  const failing = async () => new Response('{}', { status: 503 });
  const unknown = await lookupScores({
    team: 'Giants',
    league: 'mlb',
    timeZone,
    fetchImpl: failing,
  });
  expect(unknown.unsupported).toBe(false);
  expect(unknown.coverage).toMatchObject({ complete: false, unavailableRosters: ['mlb'] });
  clearSportsCache();
  const { impl } = fakeFetch({ 'baseball/mlb/teams': fixture('mlb-teams') });
  const partial = await lookupScores({
    team: 'SF Giants',
    league: 'mlb',
    timeZone,
    fetchImpl: async (url) => (url.includes('/scoreboard') ? failing() : impl(url)),
  });
  expect(partial.games).toEqual([]);
  expect(partial.coverage).toMatchObject({ complete: false, unavailableScoreboards: ['mlb'] });
  expect(partial.evidenceNote).toContain('unavailable');
});
it.each([
  'https://evil-espncdn.com/pixel.png',
  'https://espncdn.com.evil.test/pixel.png',
  'https://owner@a.espncdn.com/pixel.png',
])('rejects lookalike image host %s', (logo) => {
  const event = structuredClone(fixture('mlb-scoreboard').events[0]);
  for (const competitor of event.competitions[0].competitors) {
    competitor.team.logo = logo;
    competitor.team.logos = [];
  }
  const game = normalizeEvent(event, mlb, timeZone);
  expect(game?.home.logo).toBeUndefined();
  expect(game?.away.logo).toBeUndefined();
});
it('rejects impossible requested civil dates', async () => {
  await expect(lookupScores({ league: 'mlb', date: '2026-02-30', timeZone })).rejects.toThrow(
    'valid civil date',
  );
});
