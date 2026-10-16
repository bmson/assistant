import { type AmbientSnapshotRow, ambientSnapshots, type Db } from '@assistant/db';
import {
  type AmbientSnapshotRepository,
  isOwnerContextRepository,
  type OwnerContextRepository,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { withSpan } from '../otel.js';
import { formatLocationLine, latestLocation } from './location.js';

/**
 * Ambient "right now" context (Phase 25). A cheap refresh job fuses the transient
 * sources — the owner's current location (Phase 15) and the local weather — into
 * ONE compiled block plus derived flags, cached in `ambient_snapshots` so every
 * planning step reads it once (the same computed-once pattern as the owner card)
 * instead of calling a weather/location tool mid-task. The block is ephemeral
 * operational state, never memory: it is superseded by the next refresh and never
 * enters extraction. Calendar-pressure and health (Phase 16) are future sources;
 * missing sources degrade gracefully rather than serving stale data.
 */

/** Minutes a compiled snapshot stays authoritative before we fall back to location-only. */
const AMBIENT_TTL_MINUTES = 90;
const WEATHER_TIMEOUT_MS = 10_000;
/**
 * One budget for the whole geocode ladder rather than per leg: three rungs at
 * WEATHER_TIMEOUT_MS each would turn a miss into a 30-second wait before the
 * forecast call even starts.
 */
const GEOCODE_TOTAL_BUDGET_MS = 12_000;
/** Rungs tried before giving up. Candidate 0 is the verbatim query. */
const MAX_GEOCODE_ATTEMPTS = 3;
const RAIN_SOON_PROBABILITY = 60;

/** Subset of WMO weather codes → short description; rainy/snowy codes drive flags. */
const WMO: Record<number, string> = {
  0: 'clear',
  1: 'mostly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'freezing fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'rain showers',
  81: 'rain showers',
  82: 'violent rain showers',
  85: 'snow showers',
  86: 'snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with hail',
  99: 'thunderstorm with hail',
};

function describeWeather(code: number): string {
  return WMO[code] ?? 'unsettled';
}
function isWet(code: number): boolean {
  return (code >= 51 && code <= 86) || code >= 95;
}

export interface WeatherDay {
  /** YYYY-MM-DD in the location's own timezone (Open-Meteo `daily.time`). */
  date: string;
  code: number;
  description: string;
  lowC: number;
  highC: number;
  precipProbabilityMax: number;
}

/**
 * One hour of the forecast, in the PLACE's own local time. `time` is exactly
 * what Open-Meteo returns under `timezone=auto` — a wall-clock string with no
 * offset ("2026-08-31T12:00") — so it is matched by string prefix and never
 * parsed through `Date`, which would read it as the server's zone.
 */
export interface WeatherHour {
  /** Local wall clock, "YYYY-MM-DDTHH:MM". */
  time: string;
  /** Local date, split from `time` — never derived through Date. */
  date: string;
  /** Local hour, 0–23. */
  hour: number;
  tempC: number;
  feelsLikeC?: number;
  code: number;
  description: string;
  precipProbability: number;
  windKmh: number;
}

export interface WeatherNow {
  tempC: number;
  code: number;
  description: string;
  windKmh: number;
  humidity?: number;
  highC: number;
  lowC: number;
  precipProbabilityMax: number;
  /** Tomorrow onward — a "this weekend" question needs more than today. */
  forecast: WeatherDay[];
  /** IANA zone the local times above are in (Open-Meteo `timezone`). */
  timezone?: string;
  /** Absent unless `fetchWeather` was asked for it — see the ambient note there. */
  hourly?: WeatherHour[];
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** Short weekday for a local-date string, pinned to UTC so the server's zone never shifts it. */
export function weekdayName(date: string): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parsed) return date;
  return new Date(
    Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3])),
  ).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

/** One abort signal from the caller's plus our own deadline, so both still cancel. */
function mergeSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/**
 * Zip the hourly columns into rows, skipping any the provider left incomplete —
 * the same defensive shape the daily block uses. `date` and `hour` are SPLIT
 * from the local wall-clock string rather than computed, because a DST day has
 * 23 or 25 entries and any arithmetic over the index drifts after the change.
 */
function parseHourly(hourly?: {
  time?: string[];
  temperature_2m?: number[];
  apparent_temperature?: number[];
  weather_code?: number[];
  precipitation_probability?: number[];
  wind_speed_10m?: number[];
}): WeatherHour[] {
  return (hourly?.time ?? [])
    .map((time, index): WeatherHour | null => {
      const temp = hourly?.temperature_2m?.[index];
      const parsed = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(time ?? '');
      if (typeof temp !== 'number' || !parsed?.[1] || !parsed[2]) return null;
      const code = hourly?.weather_code?.[index] ?? 0;
      const feels = hourly?.apparent_temperature?.[index];
      return {
        time,
        date: parsed[1],
        hour: Number(parsed[2]),
        tempC: Math.round(temp),
        ...(typeof feels === 'number' ? { feelsLikeC: Math.round(feels) } : {}),
        code,
        description: describeWeather(code),
        precipProbability: hourly?.precipitation_probability?.[index] ?? 0,
        windKmh: Math.round(hourly?.wind_speed_10m?.[index] ?? 0),
      };
    })
    .filter((entry): entry is WeatherHour => entry !== null);
}

/**
 * Current conditions + the week's forecast from the free Open-Meteo API (no key).
 *
 * `opts.hourly` is opt-in on purpose. The ambient snapshot reads only `current`
 * and `daily`, and asking for seven days of hourly rows would roughly triple a
 * payload it refreshes every half hour and persists into `ambient_snapshots`.
 * Only `weather.lookup` — answering about a specific hour — pays for it.
 */
export async function fetchWeather(
  lat: number,
  lng: number,
  fetchImpl: FetchLike = fetch,
  opts: { hourly?: boolean; forecastDays?: number; signal?: AbortSignal } = {},
): Promise<WeatherNow | null> {
  const forecastDays = opts.forecastDays ?? 7;
  if (!Number.isInteger(forecastDays) || forecastDays < 7 || forecastDays > 16)
    throw new RangeError('forecastDays must be an integer from 7 through 16');
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    (opts.hourly
      ? '&hourly=temperature_2m,apparent_temperature,weather_code,precipitation_probability,wind_speed_10m'
      : '') +
    `&forecast_days=${forecastDays}&timezone=auto`;
  const res = await fetchImpl(url, { signal: mergeSignals(opts.signal, WEATHER_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`weather fetch failed: ${res.status}`);
  const data = (await res.json()) as {
    current?: {
      temperature_2m?: number;
      weather_code?: number;
      wind_speed_10m?: number;
      relative_humidity_2m?: number;
    };
    daily?: {
      time?: string[];
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: number[];
    };
    hourly?: {
      time?: string[];
      temperature_2m?: number[];
      apparent_temperature?: number[];
      weather_code?: number[];
      precipitation_probability?: number[];
      wind_speed_10m?: number[];
    };
    timezone?: string;
  };
  const cur = data.current;
  const day = data.daily;
  if (!cur || typeof cur.temperature_2m !== 'number') return null;
  const forecast = (day?.time ?? [])
    .slice(1)
    .map((date, offset): WeatherDay | null => {
      const index = offset + 1;
      const low = day?.temperature_2m_min?.[index];
      const high = day?.temperature_2m_max?.[index];
      if (typeof low !== 'number' || typeof high !== 'number') return null;
      const code = day?.weather_code?.[index] ?? 0;
      return {
        date,
        code,
        description: describeWeather(code),
        lowC: Math.round(low),
        highC: Math.round(high),
        precipProbabilityMax: day?.precipitation_probability_max?.[index] ?? 0,
      };
    })
    .filter((entry): entry is WeatherDay => entry !== null);
  const hourly = opts.hourly ? parseHourly(data.hourly) : undefined;
  return {
    tempC: Math.round(cur.temperature_2m),
    code: cur.weather_code ?? day?.weather_code?.[0] ?? 0,
    description: describeWeather(cur.weather_code ?? day?.weather_code?.[0] ?? 0),
    windKmh: Math.round(cur.wind_speed_10m ?? 0),
    humidity:
      typeof cur.relative_humidity_2m === 'number'
        ? Math.round(cur.relative_humidity_2m)
        : undefined,
    highC: Math.round(day?.temperature_2m_max?.[0] ?? cur.temperature_2m),
    lowC: Math.round(day?.temperature_2m_min?.[0] ?? cur.temperature_2m),
    precipProbabilityMax: day?.precipitation_probability_max?.[0] ?? 0,
    forecast,
    ...(typeof data.timezone === 'string' ? { timezone: data.timezone } : {}),
    ...(hourly === undefined ? {} : { hourly }),
  };
}

export interface GeocodedPlace {
  /** Display label: "San Francisco, California, United States". */
  label: string;
  lat: number;
  lng: number;
  timezone?: string;
  /**
   * The candidate that actually resolved, when it was not the query as asked.
   * Only ever set alongside `broadened`, so a caller reading the object as it
   * was before this existed sees exactly what it saw then.
   */
  matchedQuery?: string;
  /** True when a venue or address fell back to the town it sits in. */
  broadened?: boolean;
}

/** Clip a gazetteer string to a sane length so a long entry cannot pad a result. */
function clipPlacePart(value: unknown, max = 80): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Lowercase, unaccented, punctuation-free — for comparing a query to a hit's name. */
function normalizePlaceName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A house number, or a number next to a street word: never a settlement. */
const STREET_LIKE =
  /^\d|\d.*\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|way|ct|court|hwy|highway|pkwy|parkway|suite|ste|apt|unit|floor|fl)\b|^#/i;
/** "94112", "94112-1234", or a UK outcode+incode. */
const POSTCODE_LIKE = /^(?:\d{3,10}(?:-\d{4})?|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})$/i;
/** "CA 94112" — the state is a useful hint, the digits are not. */
const REGION_AND_POSTCODE = /^([A-Za-z][A-Za-z.\s]{0,24}?)\s+\d{3,10}(?:-\d{4})?$/;

/**
 * Query candidates for the gazetteer, most specific first, plus admin hints
 * pulled from the components that are not worth querying.
 *
 * Open-Meteo's `name=` searches settlement NAMES, so a comma-joined string like
 * "San Francisco, CA" may match nothing where "San Francisco" matches. The
 * ladder is therefore over single components. Candidate 0 is always the
 * verbatim query, which keeps today's behaviour exactly for the ordinary
 * "San Francisco" / "Paris, France" case and costs nothing extra when it hits.
 *
 * Ordering is left to right. "Reykjavík, Iceland" yields Reykjavík before
 * Iceland; the other way round would answer a city question with a country
 * centroid — for Iceland, a glacier.
 *
 * A string with no comma has nothing to broaden to. That is the bare-venue case
 * ("Crocker Amazon Soccer Fields"), and no gazetteer strategy rescues it: the
 * caller has to come back with a town. That is what the miss error asks for.
 */
export function placeQueryCandidates(place: string): { candidates: string[]; hints: string[] } {
  const whole = place
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,;]+$/, '')
    .slice(0, 200);
  if (!whole) return { candidates: [], hints: [] };

  const hints: string[] = [];
  const parts = whole
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const derived: string[] = [];
  for (const part of parts.slice(1)) {
    const regionAndPostcode = REGION_AND_POSTCODE.exec(part);
    if (regionAndPostcode?.[1]) {
      hints.push(regionAndPostcode[1].trim());
      continue;
    }
    if (POSTCODE_LIKE.test(part)) continue;
    if (STREET_LIKE.test(part)) continue;
    derived.push(part);
    // A trailing component is both a place worth querying on its own AND the
    // qualifier for the ones before it: "Portland, Oregon" has to prefer the
    // Portland in Oregon over the one in Maine.
    hints.push(part);
  }
  // The leading component is a candidate too, but only when it is not itself a
  // street line — "1580 Geneva Ave, San Francisco" should ask about the city.
  const first = parts[0];
  const lead = first && !STREET_LIKE.test(first) && !POSTCODE_LIKE.test(first) ? [first] : [];

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of [whole, ...lead, ...derived]) {
    const key = normalizePlaceName(candidate);
    if (!key || key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= MAX_GEOCODE_ATTEMPTS) break;
  }
  return { candidates, hints: [...new Set(hints)] };
}

interface GeocodeHit {
  name?: string;
  latitude?: number;
  longitude?: number;
  admin1?: string;
  country?: string;
  timezone?: string;
}

function toGeocodedPlace(hit: GeocodeHit, fallbackLabel: string): GeocodedPlace | null {
  if (typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') return null;
  const label = [clipPlacePart(hit.name), clipPlacePart(hit.admin1), clipPlacePart(hit.country)]
    .filter(Boolean)
    .join(', ');
  return {
    label: label || fallbackLabel.slice(0, 120),
    lat: hit.latitude,
    lng: hit.longitude,
    timezone: clipPlacePart(hit.timezone, 60) || undefined,
  };
}

/** Prefer a hit whose region or country matches a hint ("Portland, Oregon" → OR, not ME). */
function pickHit(hits: GeocodeHit[], hints: string[]): GeocodeHit | undefined {
  if (hints.length === 0) return hits[0];
  const wanted = hints.map(normalizePlaceName).filter(Boolean);
  const matched = hits.find((hit) => {
    const region = normalizePlaceName(clipPlacePart(hit.admin1));
    const country = normalizePlaceName(clipPlacePart(hit.country));
    return wanted.some(
      (hint) =>
        (region && (region === hint || region.startsWith(`${hint} `))) ||
        (country && country === hint) ||
        // "CA" against "California": an abbreviation is a prefix of its region.
        (hint.length <= 3 && region.replace(/\s+/g, '').startsWith(hint.replace(/\s+/g, ''))),
    );
  });
  return matched ?? hits[0];
}

/**
 * Resolve a place name to coordinates via Open-Meteo's free geocoding API (no
 * key). This is what lets a weather question name somewhere the owner is not —
 * the ambient block only ever knows where they are right now.
 *
 * The gazetteer holds settlements and regions, not points of interest, so a
 * venue or a street address only resolves when the string also carries the town
 * it is in; `placeQueryCandidates` is what finds that town. Returns null when
 * no rung resolves, so the caller can say which place it could not find rather
 * than answering confidently about the wrong one.
 */
export async function geocodePlace(
  place: string,
  fetchImpl: FetchLike = fetch,
  opts: { signal?: AbortSignal } = {},
): Promise<GeocodedPlace | null> {
  const { candidates, hints } = placeQueryCandidates(place);
  if (candidates.length === 0) return null;
  // One deadline for the whole ladder, not one per rung.
  const signal = mergeSignals(opts.signal, GEOCODE_TOTAL_BUDGET_MS);

  for (const [index, candidate] of candidates.entries()) {
    const url =
      'https://geocoding-api.open-meteo.com/v1/search' +
      `?name=${encodeURIComponent(candidate)}&count=5&language=en&format=json`;
    const res = await fetchImpl(url, { signal });
    if (!res.ok) throw new Error(`geocode failed: ${res.status}`);
    const data = (await res.json()) as { results?: GeocodeHit[] };
    const hits = (data.results ?? []).filter(Boolean);
    if (hits.length === 0) continue;

    const hit = pickHit(hits, hints);
    if (!hit) continue;
    // The query as asked keeps the lenient best-hit rule it has always had.
    // A candidate the ladder DERIVED has to match the hit's name outright:
    // these are venue and address fragments fed to a fuzzy matcher, where
    // "Victoria Park" happily resolves to Victoria, British Columbia.
    if (
      index > 0 &&
      normalizePlaceName(clipPlacePart(hit.name)) !== normalizePlaceName(candidate)
    ) {
      continue;
    }
    const resolved = toGeocodedPlace(hit, candidate);
    if (!resolved) continue;
    return index === 0 ? resolved : { ...resolved, matchedQuery: candidate, broadened: true };
  }
  return null;
}

/**
 * What goes into `ambient_snapshots.sources`. The hourly rows are dropped: this
 * path never requests them today, and if it ever did they would add kilobytes
 * to a row rewritten every half hour for no reader.
 */
function persistableWeather(weather: WeatherNow): Omit<WeatherNow, 'hourly'> {
  const { hourly: _hourly, ...rest } = weather;
  return rest;
}

export interface AmbientSnapshotResult {
  computed: boolean;
  hasLocation: boolean;
  hasWeather: boolean;
  flags: Record<string, boolean>;
}

/**
 * Code job `ambient.refresh`: compile the current ambient block and cache it.
 * No location → the snapshot is cleared (nothing to serve) rather than kept
 * stale. Weather failures degrade to a location-only block (never old weather).
 */
export async function refreshAmbientSnapshot(
  deps: {
    db: Db;
    fetchImpl?: FetchLike;
    heartbeat?: () => Promise<void>;
    /** Portable location read and snapshot writer; both or neither. */
    portable?: { ownerContext: OwnerContextRepository; snapshots: AmbientSnapshotRepository };
  },
  opts: { agentId: string; now?: Date } = { agentId: '' },
): Promise<AmbientSnapshotResult> {
  const { db, portable } = deps;
  const now = opts.now ?? new Date();

  return withSpan('ambient.refresh', {}, async () => {
    await deps.heartbeat?.();
    const retentionDays = loadConfig().LOCATION_RETENTION_DAYS;
    const ping = await latestLocation(
      portable?.ownerContext ?? db,
      opts.agentId,
      retentionDays,
      undefined,
      now,
    );
    if (!ping) {
      // No fresh location — clear any stale snapshot so nothing outdated is served.
      if (portable) await portable.snapshots.clear(opts.agentId);
      else await db.delete(ambientSnapshots).where(eq(ambientSnapshots.agentId, opts.agentId));
      return { computed: false, hasLocation: false, hasWeather: false, flags: {} };
    }

    let weather: WeatherNow | null = null;
    try {
      weather = await fetchWeather(Number(ping.lat), Number(ping.lng), deps.fetchImpl);
    } catch (err) {
      console.error('ambient: weather fetch failed — location-only block', err);
    }
    await deps.heartbeat?.();

    const flags: Record<string, boolean> = {
      has_location: true,
      has_weather: weather !== null,
      raining_now: weather ? isWet(weather.code) : false,
      raining_soon: weather ? weather.precipProbabilityMax >= RAIN_SOON_PROBABILITY : false,
    };

    const locationLine = formatLocationLine(ping, now) ?? '';
    const lines = ['Right now (ambient context — transient, not a stored fact):', locationLine];
    if (weather) {
      lines.push(
        `Weather there: ${weather.description}, ${weather.tempC}°C (today ${weather.lowC}–${weather.highC}°C, ` +
          `${weather.precipProbabilityMax}% chance of rain, wind ${weather.windKmh} km/h` +
          (weather.humidity === undefined ? '' : `, humidity ${weather.humidity}%`) +
          ').' +
          (flags.raining_soon ? ' Rain is likely today — factor it into anything outdoors.' : ''),
      );
      if (weather.forecast.length > 0) {
        lines.push(
          'Coming days: ' +
            weather.forecast
              .map(
                (day) =>
                  `${weekdayName(day.date)} ${day.lowC}–${day.highC}°C, ${day.description}` +
                  (day.precipProbabilityMax >= 30
                    ? `, ${day.precipProbabilityMax}% chance of rain`
                    : ''),
              )
              .join('; ') +
            '.',
        );
      }
    } else {
      lines.push('Weather is unavailable right now.');
    }
    const block = lines.filter(Boolean).join('\n');
    const sources = {
      location: { capturedAt: ping.capturedAt.toISOString(), label: ping.label },
      weather: weather ? { ...persistableWeather(weather), fetchedAt: now.toISOString() } : null,
    };
    if (portable) {
      await portable.snapshots.save({
        agentId: opts.agentId,
        block,
        flags,
        sources,
        computedAt: now,
      });
      return { computed: true, hasLocation: true, hasWeather: weather !== null, flags };
    }

    await db
      .insert(ambientSnapshots)
      .values({
        agentId: opts.agentId,
        block,
        flags,
        sources,
        computedAt: now,
      })
      .onConflictDoUpdate({
        target: ambientSnapshots.agentId,
        set: {
          block,
          flags,
          sources,
          computedAt: now,
        },
      });

    return { computed: true, hasLocation: true, hasWeather: weather !== null, flags };
  });
}

/**
 * The ambient block for the owner's prompt. Returns the cached snapshot when it
 * is fresh; when it is stale or missing, degrades to the raw current-location
 * line (Phase 15) rather than serving old weather — never blocks on the network.
 */
export async function getAmbientBlock(
  store: Db | OwnerContextRepository,
  agentId: string,
  opts: { now?: Date; ttlMinutes?: number } = {},
): Promise<string | undefined> {
  const now = opts.now ?? new Date();
  const ttl = (opts.ttlMinutes ?? AMBIENT_TTL_MINUTES) * 60_000;
  const snap = isOwnerContextRepository(store)
    ? await store.getAmbientSnapshot(agentId)
    : (
        await store
          .select()
          .from(ambientSnapshots)
          .where(eq(ambientSnapshots.agentId, agentId))
          .limit(1)
      )[0];
  const ping = await latestLocation(
    store,
    agentId,
    loadConfig().LOCATION_RETENTION_DAYS,
    undefined,
    now,
  );
  if (!ping) return undefined;
  const sources = snap?.sources as { location?: { capturedAt?: string } } | undefined;
  if (
    snap?.block &&
    now.getTime() >= snap.computedAt.getTime() &&
    now.getTime() - snap.computedAt.getTime() <= ttl &&
    sources?.location?.capturedAt === ping.capturedAt.toISOString()
  ) {
    // Weather may remain cached, but the location's age must advance with time.
    return snap.block.replace(
      /^Owner's current location:.*$/m,
      formatLocationLine(ping, now) ?? '',
    );
  }
  // Stale/absent snapshot: fall back to the freshest location on its own.
  return formatLocationLine(ping, now);
}

/** The derived flags from the current snapshot (empty when none/stale). */
export function ambientFlags(snap: AmbientSnapshotRow | null | undefined): Record<string, boolean> {
  return (snap?.flags as Record<string, boolean>) ?? {};
}
