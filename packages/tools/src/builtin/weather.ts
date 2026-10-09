import {
  fetchWeather,
  geocodePlace,
  latestLocation,
  loadConfig,
  placeQueryCandidates,
  type WeatherHour,
  type WeatherNow,
  weekdayName,
} from '@assistant/core';
import type { Db } from '@assistant/db';
import type { OwnerContextRepository } from '@assistant/persistence';
import { z } from 'zod';
import { canUseOwnerCurrentLocation } from '../current-location-access.js';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

/**
 * The `weather.lookup` machinery. The ambient block (Phase 25) already carries
 * conditions where the owner is standing, but it can only ever answer about
 * here-and-now: it needs a fresh location ping to exist at all, and it knows one
 * place. "What's the weather in San Francisco?" from an owner sitting in Oslo —
 * or from any install with no location sharing — had no source behind it, so the
 * model could only apologise for having no data. Triage already routes those
 * questions to the tools path (see looksLikeWeatherLookup); this is the tool
 * that answers them.
 *
 * Open-Meteo needs no API key, so this is a platform builtin rather than a
 * module: every install can answer a weather question, with or without search
 * configured.
 */

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface WeatherForecastRow {
  date: string;
  /** "Sat" — the response contract requires every forecast row to name its day. */
  weekday: string;
  description: string;
  lowC: number;
  highC: number;
  precipProbabilityMax: number;
}

/** Parts of the day a question can name without giving an hour. */
export const TIME_OF_DAY_BANDS = {
  'early-morning': [5, 8],
  morning: [8, 11],
  midday: [11, 14],
  afternoon: [14, 17],
  evening: [17, 21],
  // Stops at midnight rather than wrapping: a wrapped row would carry the next
  // day's hours under this day's weekday, and every row must name its own day.
  night: [21, 24],
} as const satisfies Record<string, readonly [number, number]>;

export type TimeOfDayBand = keyof typeof TIME_OF_DAY_BANDS;

/** Aggregate of the hours inside one requested window. */
export interface WeatherWindowRow {
  date: string;
  /** "Mon" — same contract as a forecast row: every row names its day. */
  weekday: string;
  /** "11:00–14:00", local to the place. */
  window: string;
  label?: TimeOfDayBand;
  description: string;
  lowC: number;
  highC: number;
  feelsLikeLowC?: number;
  feelsLikeHighC?: number;
  precipProbabilityMax: number;
  windKmhMax: number;
}

export interface WeatherTarget {
  date: string;
  weekday: string;
  /** The PLACE's zone — these hours are local to it, not to the owner. */
  timezone?: string;
  windows: WeatherWindowRow[];
  /** Hour rows for the requested window only; empty when the whole day was asked for. */
  hours: WeatherHour[];
  /** The day's own forecast row, so a window can be read against its day. */
  day?: WeatherForecastRow;
  /** The provider returned no hourly block; `day` is still real. */
  hourlyUnavailable?: boolean;
  /** The requested window has already elapsed. */
  inThePast?: boolean;
}

export interface WeatherLookupResult {
  /** Where this answer is actually about, as resolved — never the raw query. */
  place: string;
  /** True when the place came from the owner's current location, not the query. */
  usedCurrentLocation: boolean;
  /** The raw string as asked, when the tool had to broaden it to a town. */
  resolvedFrom?: string;
  /** True when `place` is a town standing in for a venue or address. Say so. */
  broadened?: boolean;
  current: {
    tempC: number;
    description: string;
    highC: number;
    lowC: number;
    precipProbabilityMax: number;
    windKmh: number;
    humidity?: number;
  };
  forecast: WeatherForecastRow[];
  /** Present only when a date or time was asked for. */
  target?: WeatherTarget;
}

/** Shape the raw reading into the day-named rows the response contract expects. */
export function toLookupResult(
  place: string,
  usedCurrentLocation: boolean,
  weather: WeatherNow,
  days: number,
): WeatherLookupResult {
  return {
    place,
    usedCurrentLocation,
    current: {
      tempC: weather.tempC,
      description: weather.description,
      highC: weather.highC,
      lowC: weather.lowC,
      precipProbabilityMax: weather.precipProbabilityMax,
      windKmh: weather.windKmh,
      ...(weather.humidity === undefined ? {} : { humidity: weather.humidity }),
    },
    forecast: weather.forecast.slice(0, days).map((day) => ({
      date: day.date,
      weekday: weekdayName(day.date),
      description: day.description,
      lowC: day.lowC,
      highC: day.highC,
      precipProbabilityMax: day.precipProbabilityMax,
    })),
  };
}

/** Cap on hour rows returned, so the result stays inside the 8 KB tool clip. */
const MAX_TARGET_HOURS = 12;

export interface WeatherLookupInput {
  /** Where the owner's latest location ping is read from when no place is named. */
  db: Db | OwnerContextRepository;
  agentId: string;
  /** A named place; omitted/empty means "where the owner is now". */
  place?: string;
  days: number;
  /** Local date to focus on, YYYY-MM-DD, in the PLACE's timezone. */
  date?: string;
  /** A named part of the day, when no exact hour is known. */
  timeOfDay?: TimeOfDayBand;
  /** Local start hour, 0-23, when the time is known exactly. */
  startHour?: number;
  /** Local end hour, inclusive. Defaults to `startHour` + 2. */
  endHour?: number;
  fetchImpl?: FetchLike;
}

function pad(hour: number): string {
  return `${hour}`.padStart(2, '0');
}

/** Roll a set of hours into the one row an owner reads. */
function summariseWindow(
  hours: WeatherHour[],
  date: string,
  from: number,
  to: number,
  label?: TimeOfDayBand,
): WeatherWindowRow | null {
  if (hours.length === 0) return null;
  const temps = hours.map((hour) => hour.tempC);
  const feels = hours
    .map((hour) => hour.feelsLikeC)
    .filter((value): value is number => typeof value === 'number');
  // The description is the one an owner plans around: whichever hour is wettest
  // when rain is a real prospect, otherwise the hour that typifies the window.
  const wettest = hours.reduce((worst, hour) =>
    hour.precipProbability > worst.precipProbability ? hour : worst,
  );
  const counts = new Map<number, number>();
  for (const hour of hours) counts.set(hour.code, (counts.get(hour.code) ?? 0) + 1);
  const modal = [...counts.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  const typical = hours.find((hour) => hour.code === modal[0]) ?? hours[0];
  const chosen = wettest.precipProbability >= 30 ? wettest : (typical ?? wettest);
  return {
    date,
    weekday: weekdayName(date),
    window: `${pad(from)}:00–${pad(to)}:00`,
    ...(label ? { label } : {}),
    description: chosen.description,
    lowC: Math.min(...temps),
    highC: Math.max(...temps),
    ...(feels.length > 0
      ? { feelsLikeLowC: Math.min(...feels), feelsLikeHighC: Math.max(...feels) }
      : {}),
    precipProbabilityMax: Math.max(...hours.map((hour) => hour.precipProbability)),
    windKmhMax: Math.max(...hours.map((hour) => hour.windKmh)),
  };
}

/**
 * `now` as a "YYYY-MM-DDTHH:MM" wall clock in the given zone, so it can be
 * compared to Open-Meteo's local timestamps by plain string ordering. Returns
 * undefined when the zone is unknown or unusable, and the caller then skips the
 * comparison rather than guessing with the server's clock.
 */
function localStamp(now: Date, timeZone: string | undefined): string | undefined {
  if (!timeZone) return undefined;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .formatToParts(now)
        .map((part) => [part.type, part.value]),
    );
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
  } catch {
    return undefined;
  }
}

export interface WeatherTargetSpec {
  date: string;
  timeOfDay?: TimeOfDayBand;
  startHour?: number;
  endHour?: number;
}

/**
 * Build the time-of-day view for one date. Hours are selected by matching the
 * local date string, never by arithmetic on the index: a DST day has 23 or 25
 * entries and every index after the change is off by one.
 */
export function buildTarget(
  weather: WeatherNow,
  spec: WeatherTargetSpec,
  now: Date = new Date(),
): WeatherTarget {
  const day = weather.forecast.find((entry) => entry.date === spec.date);
  const dayRow: WeatherForecastRow | undefined = day
    ? {
        date: day.date,
        weekday: weekdayName(day.date),
        description: day.description,
        lowC: day.lowC,
        highC: day.highC,
        precipProbabilityMax: day.precipProbabilityMax,
      }
    : undefined;
  const base: WeatherTarget = {
    date: spec.date,
    weekday: weekdayName(spec.date),
    ...(weather.timezone ? { timezone: weather.timezone } : {}),
    windows: [],
    hours: [],
    ...(dayRow ? { day: dayRow } : {}),
  };
  const onDate = (weather.hourly ?? []).filter((hour) => hour.date === spec.date);
  if (onDate.length === 0) return { ...base, hourlyUnavailable: true };

  // A band is half-open — "midday" 11–14 means 11, 12 and 13 — while an explicit
  // startHour/endHour pair names two real hours the owner will be standing
  // outside for, so its end is inclusive. Both label the window the same way.
  const explicit = spec.startHour !== undefined;
  const band = spec.timeOfDay ? TIME_OF_DAY_BANDS[spec.timeOfDay] : undefined;
  const from = explicit ? (spec.startHour as number) : band?.[0];
  const to = explicit ? (spec.endHour ?? Math.min(23, (spec.startHour as number) + 2)) : band?.[1];
  const endIsInclusive = explicit;

  if (from === undefined || to === undefined) {
    // A date with no time: summarise each named band so the model can pick.
    const windows = Object.entries(TIME_OF_DAY_BANDS)
      .map(([label, [start, end]]) =>
        summariseWindow(
          onDate.filter((hour) => hour.hour >= start && hour.hour < end),
          spec.date,
          start,
          end,
          label as TimeOfDayBand,
        ),
      )
      .filter((row): row is WeatherWindowRow => row !== null);
    return { ...base, windows };
  }

  const hours = onDate.filter(
    (hour) => hour.hour >= from && (endIsInclusive ? hour.hour <= to : hour.hour < to),
  );
  if (hours.length === 0) return { ...base, hourlyUnavailable: true };
  const window = summariseWindow(hours, spec.date, from, to, spec.timeOfDay);
  // "Already happened" is worth saying rather than quietly reporting the past.
  // Compared as local wall-clock strings, for the same reason the hours are
  // matched that way: parsing "2026-08-29T13:00" through Date would read the
  // place's clock as the server's, which is wrong by however far apart they are.
  const last = hours[hours.length - 1];
  const nowThere = localStamp(now, weather.timezone);
  const inThePast = Boolean(last && nowThere && last.time < nowThere);
  return {
    ...base,
    windows: window ? [window] : [],
    hours: hours.slice(0, MAX_TARGET_HOURS),
    ...(inThePast ? { inThePast: true } : {}),
  };
}

/**
 * Resolve a place (named, or the owner's latest location ping) and read the
 * weather there. Returns a `{ error }` shape rather than throwing for the
 * ordinary misses — an unknown place name, no location on file, a date outside
 * the forecast — because each is an answer the model should act on, not a
 * failure worth a retry of the same call.
 */
export async function lookupWeather(
  input: WeatherLookupInput,
): Promise<WeatherLookupResult | { error: string; retryWith?: string; tried?: string[] }> {
  const { db, agentId, days, fetchImpl } = input;
  const named = input.place?.trim().slice(0, 200);

  let place: string;
  let lat: number;
  let lng: number;
  let broadenedFrom: string | undefined;

  if (named) {
    const found = await geocodePlace(named, fetchImpl);
    if (!found) {
      const { candidates } = placeQueryCandidates(named);
      return {
        // The old copy said "ask which place is meant", and the model duly
        // asked the owner to go and check a weather service. Name the next
        // move instead: this source knows towns, so come back with the town.
        error:
          `"${named.slice(0, 120)}" is not a town or city this weather source knows — it holds ` +
          'towns, cities and regions, not venues, parks, stadiums or street addresses. Call ' +
          'weather.lookup again with the town or city it is in, taking it from the address or ' +
          'the calendar event you already have. Only ask the owner if no town can be determined.',
        retryWith: 'city',
        tried: candidates,
      };
    }
    place = found.label;
    lat = found.lat;
    lng = found.lng;
    if (found.broadened) broadenedFrom = named;
  } else {
    const ping = await latestLocation(db, agentId, loadConfig().LOCATION_RETENTION_DAYS);
    if (!ping) {
      return {
        error:
          'no place was given and no recent location is on file — ask which place the weather is for',
      };
    }
    place = ping.label || 'your current location';
    lat = Number(ping.lat);
    lng = Number(ping.lng);
  }

  // Only pay for hourly rows when the question is actually about a time.
  const wantsTarget =
    input.date !== undefined || input.timeOfDay !== undefined || input.startHour !== undefined;
  const weather = await fetchWeather(lat, lng, fetchImpl, { hourly: wantsTarget });
  if (!weather) return { error: `no weather reading is available for ${place} right now` };

  const result = toLookupResult(place, !named, weather, days);
  const withPlace = broadenedFrom
    ? { ...result, resolvedFrom: broadenedFrom, broadened: true }
    : result;
  if (!wantsTarget) return withPlace;

  // Without an explicit date the target is the soonest day we hold: today when
  // an hour is still ahead of us, otherwise tomorrow.
  const date = input.date ?? weather.hourly?.[0]?.date ?? weather.forecast[0]?.date;
  if (!date) return withPlace;
  const covered = weather.hourly?.map((hour) => hour.date) ?? [];
  const known = new Set([...covered, ...weather.forecast.map((entry) => entry.date)]);
  if (input.date && known.size > 0 && !known.has(input.date)) {
    const dates = [...known].sort();
    return {
      error: `the forecast covers ${dates[0]} through ${dates[dates.length - 1]}; ${input.date} is outside it`,
    };
  }
  return {
    ...withPlace,
    target: buildTarget(weather, {
      date,
      ...(input.timeOfDay ? { timeOfDay: input.timeOfDay } : {}),
      ...(input.startHour === undefined ? {} : { startHour: input.startHour }),
      ...(input.endHour === undefined ? {} : { endHour: input.endHour }),
    }),
  };
}

/**
 * Register `weather.lookup`. The PostgreSQL built-ins read the current-location
 * fallback through the tool context's database. A portable composition passes
 * its owner-context repository instead, so the tool never needs SQL.
 */
export function registerWeatherTool(
  registry: ToolRegistry,
  deps: { fetchImpl?: FetchLike; ownerContext?: OwnerContextRepository } = {},
): ToolRegistry {
  register(
    registry,
    {
      name: 'weather.lookup',
      description:
        'Current conditions, the coming days, and — when you ask for a date or a time — the weather at that hour. Give `place` for anywhere named ("San Francisco", "Tokyo"); omit it only for where the owner is right now. This source knows towns, cities and regions, NOT venues, parks or street addresses: a full location string works because the tool falls back to the town inside it and tells you it did, but a bare venue name ("Crocker Amazon Soccer Fields") does not resolve — pass the town it is in. If this returns a not-found error, call again with the town rather than telling the owner to check a weather service. Use this for any weather question the ambient "right now" block does not already answer — another town, or a day past today.',
      inputSchema: z.object({
        place: z
          .string()
          // 200, not 120: a calendar location carries the venue AND the address,
          // and that whole string is exactly what the town fallback needs. A
          // shorter cap rejects the call outright instead of clipping it.
          .max(200)
          .default('')
          .describe(
            "Town, city, or region — or a full location string, whose town will be used. Leave empty to use the owner's current location.",
          ),
        // Six, not seven: the provider is asked for 7 days and today is
        // reported as current conditions, so tomorrow onward is all there is.
        days: z
          .number()
          .int()
          .min(1)
          .max(6)
          .default(6)
          .describe('How many days of forecast to return, starting tomorrow (up to 6).'),
        // None of these carry a default: a default would make every weather
        // question fetch hourly data it does not need, and would change the
        // cached-result key for calls that mean the same thing.
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            "Local date to focus on (YYYY-MM-DD), resolved from the current-date line. Read in the PLACE's own timezone. Omit for a general forecast.",
          ),
        timeOfDay: z
          .enum(['early-morning', 'morning', 'midday', 'afternoon', 'evening', 'night'])
          .optional()
          .describe('The part of the day the owner named ("around midday", "after work").'),
        startHour: z
          .number()
          .int()
          .min(0)
          .max(23)
          .optional()
          .describe('Local start hour when the time is known exactly — an event at 13:00 is 13.'),
        endHour: z
          .number()
          .int()
          .min(0)
          .max(23)
          .optional()
          .describe('Local end hour, inclusive. Defaults to startHour + 2.'),
      }),
      risk: (args, ctx) =>
        !args.place?.trim() && !canUseOwnerCurrentLocation(ctx) ? 'forbidden' : 'autonomous',
      acceptsUntrustedInput: true,
      cacheTtlSeconds: 900,
      execute: async (args, ctx) => {
        if (!args.place?.trim() && !canUseOwnerCurrentLocation(ctx))
          return { error: 'An explicit place is required for this request.' };
        return lookupWeather({
          db: deps.ownerContext ?? ctx.db,
          agentId: ctx.agentId,
          place: args.place,
          ...(args.date === undefined ? {} : { date: args.date }),
          ...(args.timeOfDay === undefined ? {} : { timeOfDay: args.timeOfDay }),
          ...(args.startHour === undefined ? {} : { startHour: args.startHour }),
          ...(args.endHour === undefined ? {} : { endHour: args.endHour }),
          days: args.days,
          // Honor task cancellation without losing the helpers' own 10s cap.
          fetchImpl: (url, init) =>
            (deps.fetchImpl ?? fetch)(url, {
              signal: init?.signal ? AbortSignal.any([ctx.signal, init.signal]) : ctx.signal,
            }),
        });
      },
    },
    // Deliberately neither networkEgress nor returnsUntrustedContent, unlike
    // web.fetch/web.search. The destination is hardwired to Open-Meteo — no
    // argument names a host — so a tainted session cannot use this to reach an
    // attacker-observable URL, and the reading that comes back is numbers plus a
    // clipped gazetteer label, not third-party prose. Flagging it either way
    // would gate "will it rain in Boston tomorrow?" behind an approval card and
    // strip the owner card from the rest of the turn, for a keyless read-only
    // lookup that discloses nothing.
    {},
  );

  return registry;
}
