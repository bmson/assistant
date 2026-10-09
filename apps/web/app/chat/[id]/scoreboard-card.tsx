'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

type Raw = Record<string, unknown>;

interface Side {
  name: string;
  shortName: string;
  abbreviation: string;
  logo?: string;
  score?: string;
  winner?: boolean;
  record?: string;
}

export interface ScoreGame {
  id: string;
  league: string;
  leagueLabel: string;
  state: 'pre' | 'in' | 'post';
  statusText: string;
  startsAt: string;
  venue?: string;
  broadcast?: string;
  link?: string;
  home: Side;
  away: Side;
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function side(value: unknown): Side | undefined {
  const raw = value && typeof value === 'object' ? (value as Raw) : undefined;
  const name = str(raw?.name);
  if (!raw || !name) return undefined;
  return {
    name,
    shortName: str(raw.shortName) || name,
    abbreviation: str(raw.abbreviation),
    ...(str(raw.logo) ? { logo: str(raw.logo) } : {}),
    ...(str(raw.score) ? { score: str(raw.score) } : {}),
    ...(typeof raw.winner === 'boolean' ? { winner: raw.winner } : {}),
    ...(str(raw.record) ? { record: str(raw.record) } : {}),
  };
}

export function scoreGames(value: unknown): ScoreGame[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const raw = entry && typeof entry === 'object' ? (entry as Raw) : undefined;
    const home = side(raw?.home);
    const away = side(raw?.away);
    const state = str(raw?.state);
    if (!raw || !home || !away || !str(raw.id)) return [];
    return [
      {
        id: str(raw.id),
        league: str(raw.league),
        leagueLabel: str(raw.leagueLabel),
        state: state === 'in' || state === 'post' ? state : 'pre',
        statusText: str(raw.statusText),
        startsAt: str(raw.startsAt),
        ...(str(raw.venue) ? { venue: str(raw.venue) } : {}),
        ...(str(raw.broadcast) ? { broadcast: str(raw.broadcast) } : {}),
        ...(/^https:\/\/www\.espn\.com\//.test(str(raw.link)) ? { link: str(raw.link) } : {}),
        home,
        away,
      },
    ];
  });
}

/** Within this long of kickoff a scheduled game is polled, so it goes live on its own. */
const STARTING_SOON_MS = 10 * 60_000;

/** Whether any game can still change: it is on, or it is about to start. */
export function scoreboardShouldPoll(games: ScoreGame[], now: number): boolean {
  return games.some((game) => {
    if (game.state === 'post') return false;
    const start = Date.parse(game.startsAt);
    if (game.state === 'in') return !Number.isFinite(start) || now - start < 4 * 3600_000;
    if (game.state !== 'pre' || !Number.isFinite(start)) return false;
    return Number.isFinite(start) && start - now <= STARTING_SOON_MS && now - start < 4 * 3600_000;
  });
}

/** The next time a pregame card can become eligible, or any game must stop polling. */
export function nextScoreboardEligibilityBoundary(
  games: ScoreGame[],
  now: number,
): number | undefined {
  const boundaries: number[] = [];
  for (const game of games) {
    if (game.state === 'post') continue;
    const start = Date.parse(game.startsAt);
    if (!Number.isFinite(start)) continue;
    const stopAt = start + 4 * 3600_000;
    if (now < stopAt) boundaries.push(stopAt);
    const beginAt = start - STARTING_SOON_MS;
    if (game.state === 'pre' && now < beginAt) boundaries.push(beginAt);
  }
  return boundaries.length ? Math.min(...boundaries) : undefined;
}

export interface ScoreboardRefreshTicket {
  revision: string;
  generation: number;
  signal: AbortSignal;
}

/** Aborts superseded requests and prevents late responses from crossing snapshots. */
export class ScoreboardRefreshFence {
  private generation = 0;
  private controller: AbortController | null = null;

  begin(revision: string): ScoreboardRefreshTicket {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.generation += 1;
    return { revision, generation: this.generation, signal: controller.signal };
  }

  isCurrent(ticket: ScoreboardRefreshTicket, revision: string): boolean {
    return (
      ticket.generation === this.generation &&
      ticket.revision === revision &&
      !ticket.signal.aborted
    );
  }

  finish(ticket: ScoreboardRefreshTicket): void {
    if (ticket.generation === this.generation) this.controller = null;
  }

  cancel(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }
}

/** `mlb:401,402;nfl:77` for the games that can still change. */
export function liveScoreQuery(games: ScoreGame[]): string {
  const byLeague = new Map<string, string[]>();
  for (const game of games) {
    if (game.state === 'post' || !game.league) continue;
    byLeague.set(game.league, [...(byLeague.get(game.league) ?? []), game.id]);
  }
  return [...byLeague].map(([league, ids]) => `${league}:${ids.join(',')}`).join(';');
}

type RefreshState = 'idle' | 'refreshing' | 'error';

interface ScoreboardSnapshot {
  games: ScoreGame[];
  revision: string;
  lastSuccessAt: string;
  refreshState: RefreshState;
}

function snapshotRevision(data: Raw, games: ScoreGame[]): string {
  return JSON.stringify([
    str(data.id),
    str(data.revisionId) || str(data.fetchedAt),
    data.live,
    games,
  ]);
}

export function refreshedGames(
  body: Raw,
  expectedKeys: string[],
): Map<string, ScoreGame> | undefined {
  if (body.ok !== true || !Number.isFinite(Date.parse(str(body.fetchedAt)))) return undefined;
  const games = scoreGames(body.games);
  const result = new Map(games.map((game) => [`${game.league}:${game.id}`, game]));
  if (expectedKeys.some((key) => !result.has(key))) return undefined;
  return result;
}

function TeamRow({ team, state }: { team: Side; state: ScoreGame['state'] }) {
  const lost = state === 'post' && team.winner === false;
  return (
    <div className="flex items-center gap-2.5">
      {team.logo ? (
        <Image
          src={`/api/card-image?url=${encodeURIComponent(team.logo)}`}
          alt=""
          width={24}
          height={24}
          className="size-6 shrink-0 object-contain"
          unoptimized
        />
      ) : (
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-[0.625rem] font-semibold text-muted">
          {team.abbreviation.slice(0, 3)}
        </span>
      )}
      <span
        className={`min-w-0 flex-1 truncate ${lost ? 'text-muted' : 'font-medium text-strong'}`}
      >
        {team.shortName}
        {team.record ? (
          <span className="ml-1.5 text-xs font-normal text-muted">{team.record}</span>
        ) : null}
      </span>
      {state !== 'pre' && team.score !== undefined ? (
        <span
          className={`text-lg tabular-nums ${lost ? 'text-muted' : 'font-semibold text-strong'}`}
        >
          {team.score}
        </span>
      ) : null}
    </div>
  );
}

function GameRow({ game }: { game: ScoreGame }) {
  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 text-muted">
          {game.state === 'in' ? (
            <span className="inline-flex items-center gap-1 font-semibold text-red-700 dark:text-red-400">
              <span
                className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
                aria-hidden="true"
              />
              Live
            </span>
          ) : null}
          <span className={game.state === 'in' ? 'font-medium text-strong' : ''}>
            {game.statusText}
          </span>
        </span>
        {game.link ? (
          <a
            href={game.link}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-accent underline-offset-2 hover:underline"
          >
            Game details
          </a>
        ) : null}
      </div>
      <span className="sr-only">{`${game.away.name} at ${game.home.name}, ${game.statusText}`}</span>
      <div className="flex flex-col gap-1.5">
        <TeamRow team={game.away} state={game.state} />
        <TeamRow team={game.home} state={game.state} />
      </div>
      {game.venue || game.broadcast ? (
        <p className="mt-1.5 truncate text-xs text-muted">
          {[game.venue, game.broadcast].filter(Boolean).join(' · ')}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Games from the scores tool, re-read from the live endpoint while one is on.
 * Polling stops when every game is final, the tab is hidden, or the card has
 * scrolled away — a transcript full of old scoreboards costs nothing.
 */
export function ScoreboardCard({ data }: { data: Raw }) {
  const initialGames = scoreGames(data.games);
  const initialRevision = snapshotRevision(data, initialGames);
  const [snapshot, setSnapshot] = useState<ScoreboardSnapshot>(() => ({
    games: initialGames,
    revision: initialRevision,
    lastSuccessAt: str(data.fetchedAt),
    refreshState: 'idle',
  }));
  const [clockNow, setClockNow] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const [refreshFence] = useState(() => new ScoreboardRefreshFence());
  const currentRevision = useRef(initialRevision);
  const lastSuccessAt = useRef(str(data.fetchedAt));
  const appliedPropRevision = useRef(initialRevision);
  const games = snapshot.games;
  const live = clockNow !== null && Boolean(data.live) && scoreboardShouldPoll(games, clockNow);
  const query = liveScoreQuery(games);
  const liveData = data.live && typeof data.live === 'object' ? (data.live as Raw) : {};
  const pollSeconds = Math.min(300, Math.max(15, Number(liveData.pollSeconds) || 30));
  const staleAfterMs = Math.max(60_000, pollSeconds * 3_000);
  const updated = Date.parse(snapshot.lastSuccessAt);

  useEffect(() => {
    setClockNow(Date.now());
  }, []);

  useEffect(() => {
    const nextGames = scoreGames(data.games);
    const revision = snapshotRevision(data, nextGames);
    if (revision === appliedPropRevision.current) return;
    appliedPropRevision.current = revision;

    const incomingAt = str(data.fetchedAt);
    const incomingMs = Date.parse(incomingAt);
    const lastSuccessMs = Date.parse(lastSuccessAt.current);
    if (Number.isFinite(incomingMs) && Number.isFinite(lastSuccessMs) && incomingMs < lastSuccessMs)
      return;

    refreshFence.cancel();
    currentRevision.current = revision;
    lastSuccessAt.current = Number.isFinite(incomingMs) ? incomingAt : '';
    setSnapshot({
      games: nextGames,
      revision,
      lastSuccessAt: lastSuccessAt.current,
      refreshState: 'idle',
    });
    setClockNow(Date.now());
  }, [data, refreshFence]);

  useEffect(() => {
    const syncVisibility = () => {
      const nextVisible = document.visibilityState === 'visible';
      setDocumentVisible(nextVisible);
      if (nextVisible) setClockNow(Date.now());
    };
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => document.removeEventListener('visibilitychange', syncVisibility);
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(Boolean(entry?.isIntersecting)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (clockNow === null) return;
    const candidates = [nextScoreboardEligibilityBoundary(games, clockNow)].filter(
      (value): value is number => value !== undefined,
    );
    const staleAt = Number.isFinite(updated) ? updated + staleAfterMs : undefined;
    if (staleAt !== undefined && staleAt > clockNow) candidates.push(staleAt);
    if (candidates.length === 0) return;
    const boundary = Math.min(...candidates);
    const delay = Math.min(2_147_000_000, Math.max(0, boundary - Date.now()));
    const timer = window.setTimeout(() => setClockNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [clockNow, games, updated, staleAfterMs]);

  useEffect(() => {
    if (!live || !visible || !documentVisible || !query) return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      const revision = currentRevision.current;
      const expectedKeys = query.split(';').flatMap((part) => {
        const [league, ids = ''] = part.split(':');
        return ids
          .split(',')
          .filter(Boolean)
          .map((id) => `${league}:${id}`);
      });
      const ticket = refreshFence.begin(revision);
      setSnapshot((current) =>
        current.revision === revision ? { ...current, refreshState: 'refreshing' } : current,
      );
      try {
        const response = await fetch(`/api/live/scoreboard?leagues=${encodeURIComponent(query)}`, {
          signal: ticket.signal,
          cache: 'no-store',
        });
        const body = (await response.json().catch(() => null)) as Raw | null;
        if (!response.ok || !body) throw new Error('refresh failed');
        const fresh = refreshedGames(body, expectedKeys);
        if (!fresh) throw new Error('incomplete refresh');
        if (cancelled || !refreshFence.isCurrent(ticket, currentRevision.current)) return;
        const fetchedAt = str(body.fetchedAt);
        const fetchedMs = Date.parse(fetchedAt);
        const priorMs = Date.parse(lastSuccessAt.current);
        if (Number.isFinite(priorMs) && fetchedMs < priorMs) throw new Error('stale refresh');
        lastSuccessAt.current = fetchedAt;
        setSnapshot((current) => {
          if (current.revision !== ticket.revision) return current;
          return {
            ...current,
            games: current.games.map((game) => fresh.get(`${game.league}:${game.id}`) ?? game),
            lastSuccessAt: fetchedAt,
            refreshState: 'idle',
          };
        });
        setClockNow(Date.now());
      } catch {
        if (cancelled || !refreshFence.isCurrent(ticket, currentRevision.current)) return;
        setSnapshot((current) =>
          current.revision === ticket.revision ? { ...current, refreshState: 'error' } : current,
        );
      } finally {
        refreshFence.finish(ticket);
      }
    };
    void tick();
    const timer = window.setInterval(tick, pollSeconds * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      refreshFence.cancel();
    };
  }, [live, visible, documentVisible, query, pollSeconds, refreshFence]);

  const updatedLabel = Number.isFinite(updated)
    ? new Date(updated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
  const stale =
    snapshot.refreshState === 'error' ||
    (clockNow !== null && Number.isFinite(updated) && clockNow - updated >= staleAfterMs);
  const awaitingKickoff =
    clockNow !== null &&
    Boolean(data.live) &&
    games.some((game) => {
      const start = Date.parse(game.startsAt);
      return game.state === 'pre' && Number.isFinite(start) && start - clockNow > STARTING_SOON_MS;
    });
  return (
    <div ref={ref}>
      <ul className="divide-y divide-edge/50 text-sm">
        {games.map((game) => (
          <GameRow key={`${game.league}-${game.id}`} game={game} />
        ))}
      </ul>
      <p
        className="mt-2.5 border-t border-edge/60 pt-2 text-[0.6875rem] text-muted"
        role="status"
        aria-live="polite"
      >
        {clockNow === null
          ? 'Score updates start when this card is visible. '
          : snapshot.refreshState === 'refreshing'
            ? 'Refreshing live scores. '
            : snapshot.refreshState === 'error'
              ? 'Live score refresh failed. Showing the last confirmed scores. '
              : stale
                ? 'Scores may be out of date. '
                : awaitingKickoff
                  ? 'Live refresh starts shortly before kickoff. '
                  : live
                    ? 'Live scores. '
                    : 'Score updates stopped. '}
        {updatedLabel
          ? `Last confirmed update at ${updatedLabel} · ESPN`
          : 'No confirmed update yet.'}
      </p>
    </div>
  );
}
