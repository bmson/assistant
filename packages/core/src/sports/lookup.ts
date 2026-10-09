import {
  type FetchImpl,
  fetchScoreboard,
  fetchTeamSchedule,
  fetchTeams,
  type ScoreboardGame,
  type Team,
} from './espn.js';
import { LEAGUES, type League, leagueByKey } from './leagues.js';

/**
 * "What's the Giants score?" as structured games: today's game for the team,
 * or its last result and next fixture when it has none today. A name that
 * fits several teams ("Giants", "Spurs") returns every one that plays on the
 * day; with none playing, it returns the candidates so the model can ask.
 */

export interface SportsCandidate {
  name: string;
  league: string;
  leagueLabel: string;
}

export interface SportsLookupResult {
  timeZone: string;
  /** Owner-local YYYY-MM-DD the lookup was about. */
  date: string;
  fetchedAt: string;
  games: ScoreboardGame[];
  /** Why these games: today's slate, or a team's last and next when it has none today. */
  selection?: 'today' | 'last-and-next';
  requestedDate?: string;
  explicitDate?: boolean;
  coverage?: {
    complete: boolean;
    rosterLeagues: string[];
    unavailableRosters: string[];
    scoreboardLeagues: string[];
    unavailableScoreboards: string[];
    omittedCandidates: number;
    omittedGames: number;
  };
  evidenceNote?: string;
  candidates?: SportsCandidate[];
  /** No covered team or league matched; a web search is the fallback. */
  unsupported?: boolean;
  error?: string;
}

const MAX_GAMES = 16;
const MAX_CANDIDATES = 4;

/** Nicknames owners use that the provider does not carry. */
const ALIASES: Record<string, string> = {
  niners: '49ers',
  dubs: 'warriors',
  yanks: 'yankees',
  'man united': 'manchester united',
  'man utd': 'manchester united',
  'man city': 'manchester city',
  barca: 'barcelona',
  'real madrid': 'real madrid',
  bayern: 'bayern munich',
  psg: 'paris saint-germain',
  habs: 'canadiens',
  sixers: '76ers',
  cavs: 'cavaliers',
  mavs: 'mavericks',
  wolves: 'timberwolves',
};

function normal(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(?:the|fc|cf|sc|afc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether `query` names `team`: a full name, a nickname, a place + nickname, or a code. */
export function teamMatches(team: Team, query: string): boolean {
  const q = normal(ALIASES[normal(query)] ?? query);
  if (!q) return false;
  const names = [team.name, team.shortName, team.nickname, `${team.location} ${team.nickname}`]
    .map(normal)
    .filter(Boolean);
  if (names.includes(q)) return true;
  if (q.length <= 4 && normal(team.abbreviation) === q) return true;
  // "sf giants", "giants baseball": the nickname plus words that each name
  // this team's place, code, or league — so "sf giants" is not New York's.
  const words = q.split(' ');
  const nickname = normal(team.nickname).split(' ').filter(Boolean);
  if (nickname.length && q.length >= 4 && nickname.every((word) => words.includes(word))) {
    const context = new Set(
      [team.location, team.abbreviation, ...(leagueByKey(team.league)?.aliases ?? [])]
        .flatMap((value) => normal(value).split(' '))
        .filter(Boolean),
    );
    if (words.filter((word) => !nickname.includes(word)).every((word) => context.has(word)))
      return true;
  }
  // "manchester united" inside "manchester united football club": only a full
  // name counts here, or "sf giants" would contain New York's nickname.
  const full = [team.name, `${team.location} ${team.nickname}`].map(normal);
  return full.some((name) => name.length >= 5 && q.includes(name));
}

function ownerToday(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function involves(game: ScoreboardGame, team: Team): boolean {
  return game.home.id === team.id || game.away.id === team.id;
}

export async function lookupScores(input: {
  team?: string;
  league?: string;
  date?: string;
  timeZone: string;
  now?: Date;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}): Promise<SportsLookupResult> {
  const now = input.now ?? new Date();
  const date = input.date ?? ownerToday(input.timeZone, now);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  )
    throw new Error('Sports date must be a valid civil date.');
  const coverage = {
    complete: true,
    rosterLeagues: [] as string[],
    unavailableRosters: [] as string[],
    scoreboardLeagues: [] as string[],
    unavailableScoreboards: [] as string[],
    omittedCandidates: 0,
    omittedGames: 0,
  };
  const base = {
    timeZone: input.timeZone,
    date,
    requestedDate: date,
    explicitDate: Boolean(input.date),
    fetchedAt: now.toISOString(),
    coverage,
  };
  const shared = {
    timeZone: input.timeZone,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    now,
  };
  const named = input.league ? leagueByKey(input.league) : undefined;
  const team = input.team?.trim();

  if (!team) {
    if (!named) return { ...base, games: [], error: 'Name a team or a league.' };
    try {
      const games = await fetchScoreboard({ league: named, date, ...shared });
      coverage.scoreboardLeagues.push(named.key);
      coverage.omittedGames = Math.max(0, games.length - MAX_GAMES);
      coverage.complete = !coverage.omittedGames;
      return { ...base, games: games.slice(0, MAX_GAMES), selection: 'today' };
    } catch {
      coverage.complete = false;
      coverage.unavailableScoreboards.push(named.key);
      return {
        ...base,
        games: [],
        error: 'The requested date scoreboard is unavailable; no scoped negative is established.',
      };
    }
  }

  const leagues: readonly League[] = named ? [named] : LEAGUES;
  const rosters = await Promise.allSettled(
    leagues.map((league) =>
      fetchTeams({ league, fetchImpl: input.fetchImpl, signal: input.signal }),
    ),
  );
  rosters.forEach((roster, index) => {
    const key = leagues[index]?.key ?? 'unknown';
    (roster.status === 'fulfilled' ? coverage.rosterLeagues : coverage.unavailableRosters).push(
      key,
    );
  });
  coverage.complete = coverage.unavailableRosters.length === 0;
  const allMatches = rosters
    .flatMap((roster) => (roster.status === 'fulfilled' ? roster.value : []))
    .filter((candidate) => teamMatches(candidate, team));
  const matches = allMatches.slice(0, MAX_CANDIDATES);
  coverage.omittedCandidates = allMatches.length - matches.length;
  if (coverage.omittedCandidates) coverage.complete = false;
  if (!matches.length) {
    return {
      ...base,
      games: [],
      unsupported: coverage.complete,
      error: coverage.complete
        ? `No team in the covered leagues matched "${team.slice(0, 60)}".`
        : 'Some team rosters are unavailable; an unsupported team is not established.',
    };
  }

  const todays = await Promise.all(
    matches.map(async (match) => {
      const league = leagueByKey(match.league) as League;
      let games: ScoreboardGame[];
      try {
        games = await fetchScoreboard({ league, date, ...shared });
        coverage.scoreboardLeagues.push(league.key);
      } catch {
        coverage.unavailableScoreboards.push(league.key);
        coverage.complete = false;
        return [];
      }
      return games.filter((game) => involves(game, match));
    }),
  );
  const playing = todays.flat();
  if (playing.length) return { ...base, games: playing, selection: 'today' };

  if (matches.length > 1) {
    return {
      ...base,
      games: [],
      candidates: matches.map((match) => ({
        name: match.name,
        league: match.league,
        leagueLabel: leagueByKey(match.league)?.label ?? match.league,
      })),
    };
  }

  if (input.date || coverage.unavailableScoreboards.length)
    return {
      ...base,
      games: [],
      selection: 'today',
      evidenceNote: coverage.unavailableScoreboards.length
        ? 'The requested date scoreboard was unavailable. No unrelated current-season result was substituted.'
        : 'No matching game was found in the inspected requested-date scoreboard. Current last/next fixtures were not substituted for that date.',
    };
  const [match] = matches as [Team];
  const league = leagueByKey(match.league) as League;
  const season = await fetchTeamSchedule({ league, teamId: match.id, ...shared });
  const last = season.filter((game) => game.state !== 'pre').at(-1);
  const next = season.find(
    (game) => game.state === 'pre' && Date.parse(game.startsAt) > now.getTime(),
  );
  const games = [last, next].filter((game): game is ScoreboardGame => !!game);
  return {
    ...base,
    games,
    selection: 'last-and-next',
    evidenceNote: 'These are current-season last/next fixtures, not games on the requested day.',
  };
}
