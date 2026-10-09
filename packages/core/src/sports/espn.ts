import { ownerDateTime } from '../owner-text.js';
import type { League } from './leagues.js';

/**
 * Scores from ESPN's public scoreboard JSON.
 *
 * It is unofficial and undocumented — the reason everything provider-shaped
 * stays in this file, behind `ScoreboardGame`, so a replacement provider is a
 * new file rather than a change to the tool, the cards, or the clients.
 *
 * Every string that leaves here is clipped and stripped of control characters:
 * team names reach the model and the owner's screen, and a provider is not a
 * trusted author even when its payload is structured.
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const TIMEOUT_MS = 8_000;
const SCOREBOARD_TTL_MS = 20_000;
const SCHEDULE_TTL_MS = 10 * 60_000;
const TEAMS_TTL_MS = 24 * 3600_000;
const CACHE_LIMIT = 200;

export type FetchImpl = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface TeamLine {
  id: string;
  name: string;
  shortName: string;
  abbreviation: string;
  logo?: string;
  score?: string;
  winner?: boolean;
  record?: string;
}

export interface ScoreboardGame {
  id: string;
  /** The league key from LEAGUES ("mlb"), which the live refresh accepts back. */
  league: string;
  leagueLabel: string;
  state: 'pre' | 'in' | 'post';
  /** "Top 9th", "Final", "HT", or the owner-local start ("Tomorrow 6:45 PM"). */
  statusText: string;
  startsAt: string;
  venue?: string;
  broadcast?: string;
  link?: string;
  home: TeamLine;
  away: TeamLine;
  /**
   * One plain line the answer is grounded against: "Minnesota Twins at San
   * Francisco Giants: 2-5, Final". The scoreline sits after both names so a
   * digit in a team name ("49ers") never separates the two scores.
   */
  line: string;
}

export interface Team {
  id: string;
  league: string;
  name: string;
  shortName: string;
  nickname: string;
  location: string;
  abbreviation: string;
}

type Raw = Record<string, unknown>;

const cache = new Map<string, { at: number; value: unknown }>();

/** Clipped, control-character-free, single-spaced provider text. */
export function clean(value: unknown, max = 80): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return (
    String(value)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

function rec(value: unknown): Raw | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : undefined;
}

function recs(value: unknown): Raw[] {
  return Array.isArray(value) ? value.map(rec).filter((item): item is Raw => !!item) : [];
}

/** Logos only from ESPN's own image CDN, over https. */
function logoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.hostname === 'espncdn.com' || url.hostname.endsWith('.espncdn.com')) &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /\.(?:png|svg)$/i.test(url.pathname)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function espnLink(value: unknown): string | undefined {
  const url = typeof value === 'string' ? value : '';
  return /^https:\/\/www\.espn\.com\/[\w./?=&%-]+$/i.test(url) ? url : undefined;
}

async function getJson(
  url: string,
  ttl: number,
  fetchImpl: FetchImpl,
  signal?: AbortSignal,
): Promise<Raw> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.value as Raw;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetchImpl(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`Scores provider returned HTTP ${response.status}`);
  const value = (await response.json()) as Raw;
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(url, { at: Date.now(), value });
  return value;
}

/** Test seam: forget cached provider responses. */
export function clearSportsCache(): void {
  cache.clear();
}

function score(value: unknown): string | undefined {
  // The scoreboard sends "5"; the team schedule sends { value, displayValue }.
  const text = clean(rec(value)?.displayValue ?? value, 8);
  return /^\d{1,3}(?:\s*\(\d{1,2}\))?$/.test(text) ? text : undefined;
}

function teamLine(competitor: Raw): TeamLine {
  const team = rec(competitor.team) ?? {};
  const logos = recs(team.logos);
  const record =
    recs(competitor.records).find((entry) => entry.type === 'total') ?? recs(competitor.record)[0];
  const scored = score(competitor.score);
  const summary = clean(record?.summary ?? record?.displayValue, 12);
  const logo = logoUrl(team.logo) ?? logoUrl(logos[0]?.href);
  return {
    id: clean(team.id, 12),
    name: clean(team.displayName) || clean(team.name) || 'Unknown team',
    shortName: clean(team.shortDisplayName, 40) || clean(team.name, 40),
    abbreviation: clean(team.abbreviation, 6),
    ...(logo ? { logo } : {}),
    ...(scored !== undefined ? { score: scored } : {}),
    ...(typeof competitor.winner === 'boolean' ? { winner: competitor.winner } : {}),
    ...(summary ? { record: summary } : {}),
  };
}

/** One provider event as a game, or undefined when it lacks two sides. */
export function normalizeEvent(
  event: Raw,
  league: League,
  timeZone: string,
  now: Date = new Date(),
): ScoreboardGame | undefined {
  const competition = recs(event.competitions)[0];
  if (!competition) return undefined;
  const competitors = recs(competition.competitors);
  const home = competitors.find((entry) => entry.homeAway === 'home');
  const away = competitors.find((entry) => entry.homeAway === 'away');
  if (!home || !away) return undefined;
  const status = rec(competition.status) ?? rec(event.status) ?? {};
  const type = rec(status.type) ?? {};
  const state = type.state === 'in' || type.state === 'post' ? type.state : 'pre';
  const startsAt = clean(competition.date ?? event.date, 40);
  const statusText =
    state === 'pre'
      ? ownerDateTime(startsAt, timeZone, now)
      : clean(type.shortDetail ?? type.detail ?? type.description, 40);
  const broadcast = recs(competition.broadcasts)
    .flatMap((entry) => (Array.isArray(entry.names) ? entry.names : []))
    .map((name) => clean(name, 30))
    .filter(Boolean)
    .slice(0, 2)
    .join(', ');
  const homeLine = teamLine(home);
  const awayLine = teamLine(away);
  const link = espnLink(recs(event.links)[0]?.href);
  const venue = clean(rec(competition.venue)?.fullName);
  const scoreline =
    homeLine.score !== undefined && awayLine.score !== undefined && state !== 'pre'
      ? `: ${awayLine.score}-${homeLine.score}`
      : '';
  return {
    id: clean(event.id, 20),
    league: league.key,
    leagueLabel: league.label,
    state,
    statusText,
    startsAt,
    ...(venue ? { venue } : {}),
    ...(broadcast ? { broadcast } : {}),
    ...(link ? { link } : {}),
    home: homeLine,
    away: awayLine,
    line: `${awayLine.name} at ${homeLine.name}${scoreline}, ${statusText}`,
  };
}

/** YYYYMMDD for the provider, from a YYYY-MM-DD date. */
function providerDate(date: string): string {
  return date.replaceAll('-', '');
}

export async function fetchScoreboard(input: {
  league: League;
  timeZone: string;
  /** YYYY-MM-DD; the provider's current slate when omitted. */
  date?: string;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  now?: Date;
}): Promise<ScoreboardGame[]> {
  const { league } = input;
  const query = input.date ? `?dates=${providerDate(input.date)}` : '';
  const body = await getJson(
    `${BASE}/${league.sport}/${league.league}/scoreboard${query}`,
    SCOREBOARD_TTL_MS,
    input.fetchImpl ?? fetch,
    input.signal,
  );
  return recs(body.events)
    .map((event) => normalizeEvent(event, league, input.timeZone, input.now))
    .filter((game): game is ScoreboardGame => !!game);
}

/** A team's season: used for "last game" and "next game" when today has none. */
export async function fetchTeamSchedule(input: {
  league: League;
  teamId: string;
  timeZone: string;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  now?: Date;
}): Promise<ScoreboardGame[]> {
  if (!/^\d{1,8}$/.test(input.teamId)) return [];
  const { league } = input;
  const body = await getJson(
    `${BASE}/${league.sport}/${league.league}/teams/${input.teamId}/schedule`,
    SCHEDULE_TTL_MS,
    input.fetchImpl ?? fetch,
    input.signal,
  );
  return recs(body.events)
    .map((event) => normalizeEvent(event, league, input.timeZone, input.now))
    .filter((game): game is ScoreboardGame => !!game);
}

export async function fetchTeams(input: {
  league: League;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}): Promise<Team[]> {
  const { league } = input;
  const body = await getJson(
    `${BASE}/${league.sport}/${league.league}/teams`,
    TEAMS_TTL_MS,
    input.fetchImpl ?? fetch,
    input.signal,
  );
  const teams = recs(rec(recs(rec(recs(body.sports)[0])?.leagues)[0])?.teams);
  return teams.flatMap((entry) => {
    const team = rec(entry.team);
    const id = clean(team?.id, 12);
    if (!team || !/^\d+$/.test(id)) return [];
    return [
      {
        id,
        league: league.key,
        name: clean(team.displayName),
        shortName: clean(team.shortDisplayName, 40),
        nickname: clean(team.name, 40),
        location: clean(team.location, 40),
        abbreviation: clean(team.abbreviation, 6),
      },
    ];
  });
}
