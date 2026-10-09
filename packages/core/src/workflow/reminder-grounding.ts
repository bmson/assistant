/** Whether this task is a durable owner reminder rather than deferred agent work. */
export function isOrdinaryReminderRequest(text: string): boolean {
  return /\b(?:remind me|(?:set|create|add|make|put|schedule) (?:me )?a reminder|reminder to)\b/i.test(
    text,
  );
}

export function shouldUseTaskScheduleDirective(
  action: 'reply' | 'workflow' | 'mission' | 'schedule' | 'clarify' | null,
  text: string,
): boolean {
  return action === 'schedule' && !isOrdinaryReminderRequest(text);
}

/**
 * An event-relative reminder depends on a real occurrence and on its actual
 * completion, not merely a guessed or scheduled end time.
 */
export function isCompletionDependentReminderRequest(text: string): boolean {
  if (!isOrdinaryReminderRequest(text)) return false;
  return /\b(?:after|when|once|as soon as|following)\b[\s\S]{0,100}\b(?:game|match|fixture|event|meeting|appointment|class|practice|flight|call|dinner|lunch|interview|show|concert|race|session)\b/i.test(
    text,
  );
}

export const EVENT_COMPLETION_REMINDER_BLOCK =
  'No reminder was created. Bind the exact event occurrence from a successful sports.scores result in this task. If the event cannot be identified uniquely, ask the owner. The assistant must wait for provider-confirmed completion; a scheduled end time is not completion.';

type Message = { role: string; content?: unknown };

function localDate(instant: string, timeZone: string): string | undefined {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function resultValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function currentSportsResults(window: readonly Message[]): Record<string, unknown>[] {
  const lastUser = window.findLastIndex((message) => message.role === 'user');
  if (lastUser < 0) return [];
  const rows: Record<string, unknown>[] = [];
  for (const message of window.slice(lastUser + 1)) {
    if (!Array.isArray(message.content)) continue;
    for (const partValue of message.content) {
      const part = resultValue(partValue);
      if (part?.type !== 'tool-result' || part.toolName !== 'sports.scores') continue;
      const output = resultValue(part.output);
      const result = resultValue(output?.value);
      if (!result || result.error || result.ok === false || result.truncated === true) continue;
      rows.push(result);
    }
  }
  return rows;
}

function requestedTeamAppears(text: string, game: Record<string, unknown>): boolean {
  const request = text.toLocaleLowerCase();
  const teams = [resultValue(game.home), resultValue(game.away)].filter(
    (team): team is Record<string, unknown> => Boolean(team),
  );
  return teams.some((team) => {
    const name = typeof team.name === 'string' ? team.name.toLocaleLowerCase() : '';
    const shortName = typeof team.shortName === 'string' ? team.shortName.toLocaleLowerCase() : '';
    const distinctive = [...new Set(`${name} ${shortName}`.match(/[a-z0-9]{4,}/g) ?? [])].filter(
      (word) => !['united', 'state', 'team', 'club'].includes(word),
    );
    return distinctive.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(request));
  });
}

/** Bind a model-selected ID to one exact, current-task score result and owner request. */
export function bindReminderEventDependency(input: {
  eventId: unknown;
  window: readonly Message[];
  requestText: string;
  requestAt: Date;
  timeZone: string;
}): { dependency: ReminderEventDependency } | { reason: string } {
  if (typeof input.eventId !== 'string' || !input.eventId.trim())
    return { reason: 'The reminder needs the event ID returned by a current sports lookup.' };
  const results = currentSportsResults(input.window);
  const games = results.flatMap((result) =>
    Array.isArray(result.games)
      ? result.games.filter((game): game is Record<string, unknown> => Boolean(resultValue(game)))
      : [],
  );
  const matches = games.filter((game) => game.id === input.eventId);
  if (matches.length !== 1)
    return {
      reason:
        'No unique event with that ID was returned by a successful sports lookup in this task. Identify the exact game or ask the owner.',
    };
  const game = matches[0];
  if (!game || !requestedTeamAppears(input.requestText, game))
    return {
      reason:
        'The selected game does not match a team named in the owner request. Ask which game they mean.',
    };
  if (
    typeof game.league !== 'string' ||
    typeof game.startsAt !== 'string' ||
    !localDate(game.startsAt, input.timeZone)
  )
    return { reason: 'The current sports result is missing a stable league or start time.' };
  const home = resultValue(game.home);
  const away = resultValue(game.away);
  if (
    typeof home?.id !== 'string' ||
    typeof home.name !== 'string' ||
    typeof away?.id !== 'string' ||
    typeof away.name !== 'string'
  )
    return { reason: 'The current sports result is missing stable team identities.' };
  const requestDate = resolveTimeWindow(input.requestText, 'calendar', false, {
    now: input.requestAt,
    timeZone: input.timeZone,
  });
  const expectedDate = requestDate ? localDate(requestDate.timeMin, input.timeZone) : undefined;
  const eventDate = localDate(game.startsAt, input.timeZone);
  const candidates = games.filter(
    (candidate) =>
      requestedTeamAppears(input.requestText, candidate) &&
      (!expectedDate ||
        localDate(String(candidate.startsAt ?? ''), input.timeZone) === expectedDate),
  );
  if (candidates.length !== 1)
    return {
      reason:
        'The owner request does not identify one unique game occurrence in the current lookup. Ask which game they mean.',
    };
  if (candidates[0]?.id !== game.id)
    return { reason: 'The selected fixture is not the unique game matching the owner request.' };
  if (expectedDate && eventDate !== expectedDate)
    return {
      reason:
        'The selected game does not occur on the date the owner requested. Verify the intended occurrence or ask the owner.',
    };
  const source = results.find(
    (result) =>
      Array.isArray(result.games) &&
      result.games.some((candidate) => resultValue(candidate)?.id === input.eventId),
  );
  const fetchedAt = typeof source?.fetchedAt === 'string' ? source.fetchedAt : '';
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt)))
    return { reason: 'The sports result has no verifiable retrieval time.' };
  return {
    dependency: {
      provider: 'sports',
      eventId: input.eventId,
      league: game.league,
      startsAt: game.startsAt,
      eventDate: eventDate as string,
      timezone: input.timeZone,
      homeTeamId: home.id,
      awayTeamId: away.id,
      homeTeam: home.name,
      awayTeam: away.name,
      verifiedAt: fetchedAt,
    },
  };
}

import type { ReminderEventDependency } from '@assistant/persistence';
import { resolveTimeWindow } from './read-intent.js';
