import { fetchWeather, type WeatherNow } from '@assistant/core';
import type { Db } from '@assistant/db';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { registerBuiltinTools } from './index.js';
import {
  buildTarget,
  lookupWeather,
  type WeatherLookupResult,
  type WeatherTarget,
} from './weather.js';

/**
 * The bug these cover: an owner asking "what's the weather in San Francisco?"
 * got an apology. The ambient block only knows where the owner is standing and
 * only when a location ping exists, so any other place had no source behind it.
 */

const GEOCODE_HIT = {
  name: 'San Francisco',
  latitude: 37.77493,
  longitude: -122.41942,
  admin1: 'California',
  country: 'United States',
  timezone: 'America/Los_Angeles',
};

const WEATHER_BODY = {
  current: {
    temperature_2m: 17.4,
    weather_code: 3,
    wind_speed_10m: 14,
    relative_humidity_2m: 68,
  },
  daily: {
    time: ['2026-08-28', '2026-08-29', '2026-08-30'],
    weather_code: [3, 0, 61],
    temperature_2m_max: [19.2, 22.6, 18.1],
    temperature_2m_min: [13.4, 14.2, 12.8],
    precipitation_probability_max: [10, 0, 80],
  },
};

/**
 * Routes the geocoding host and the forecast host to their own fake bodies.
 * `geocode` may be a function so a test can answer differently per rung of the
 * broadening ladder — the venue misses, the town it sits in hits.
 */
function fakeFetch(
  opts: { geocode?: unknown[] | ((query: string) => unknown[]); weather?: unknown } = {},
) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    if (!url.includes('geocoding-api')) {
      return { ok: true, json: async () => opts.weather ?? WEATHER_BODY } as unknown as Response;
    }
    const query = decodeURIComponent(/[?&]name=([^&]*)/.exec(url)?.[1] ?? '');
    const results =
      typeof opts.geocode === 'function' ? opts.geocode(query) : (opts.geocode ?? [GEOCODE_HIT]);
    return { ok: true, json: async () => ({ results }) } as unknown as Response;
  }) as unknown as (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  return { impl, calls };
}

/** Geocode calls only — the ladder's rungs, in order. */
function geocodeQueries(calls: string[]): string[] {
  return calls
    .filter((url) => url.includes('geocoding-api'))
    .map((url) => decodeURIComponent(/[?&]name=([^&]*)/.exec(url)?.[1] ?? ''));
}

/** A day of hourly rows in the place's local wall-clock, as timezone=auto returns them. */
function hourlyBody(date: string, hours: number[], overrides: Record<number, number> = {}) {
  return {
    ...WEATHER_BODY,
    timezone: 'America/Los_Angeles',
    hourly: {
      time: hours.map((hour) => `${date}T${`${hour}`.padStart(2, '0')}:00`),
      temperature_2m: hours.map((hour) => 12 + hour * 0.5),
      apparent_temperature: hours.map((hour) => 11 + hour * 0.5),
      weather_code: hours.map((hour) => overrides[hour] ?? 0),
      precipitation_probability: hours.map((hour) => (overrides[hour] === 61 ? 70 : 5)),
      wind_speed_10m: hours.map(() => 12),
    },
  };
}

/** Read the target block off a result the test knows resolved. */
function targetOf(result: unknown): WeatherTarget {
  const target = (result as WeatherLookupResult).target;
  if (!target) throw new Error('expected a target block on the result');
  return target;
}

/** lookupWeather only touches the db on the no-place branch. */
const UNUSED_DB = {} as Db;

describe('lookupWeather', () => {
  it('answers for a named place the owner is nowhere near', async () => {
    const { impl, calls } = fakeFetch();
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 7,
      fetchImpl: impl,
    });

    expect(result).toMatchObject({
      place: 'San Francisco, California, United States',
      usedCurrentLocation: false,
      current: {
        tempC: 17,
        description: 'overcast',
        highC: 19,
        lowC: 13,
        precipProbabilityMax: 10,
        windKmh: 14,
        humidity: 68,
      },
    });
    // The forecast is read at the resolved coordinates, not the raw query.
    expect(calls[1]).toContain('latitude=37.77493');
    expect(calls[1]).toContain('longitude=-122.41942');
  });

  it('names the day on every forecast row', async () => {
    // The response contract forbids bare "morning"/"afternoon" rows, so the
    // weekday has to reach the model as data rather than be derived by it.
    const { impl } = fakeFetch();
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 7,
      fetchImpl: impl,
    });
    expect('forecast' in result && result.forecast).toEqual([
      {
        date: '2026-08-29',
        weekday: 'Sat',
        description: 'clear',
        lowC: 14,
        highC: 23,
        precipProbabilityMax: 0,
      },
      {
        date: '2026-08-30',
        weekday: 'Sun',
        description: 'light rain',
        lowC: 13,
        highC: 18,
        precipProbabilityMax: 80,
      },
    ]);
  });

  it('honours the requested number of days', async () => {
    const { impl } = fakeFetch();
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 1,
      fetchImpl: impl,
    });
    expect('forecast' in result && result.forecast).toHaveLength(1);
  });

  it('reports an unfindable place instead of answering about the wrong one', async () => {
    const { impl, calls } = fakeFetch({ geocode: [] });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'Atlantis',
      days: 7,
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ retryWith: 'city', tried: ['Atlantis'] });
    expect((result as { error: string }).error).toContain('is not a town or city');
    // The copy has to name the next move; the old wording sent the model to the
    // owner, and it duly told them to go and check a weather service.
    expect((result as { error: string }).error).toContain(
      'Call weather.lookup again with the town',
    );
    // No forecast call once the place could not be resolved.
    expect(calls).toHaveLength(1);
  });

  it('broadens a venue-and-address string to the town it names', async () => {
    // The reported failure's other half: a calendar location carries the venue,
    // the street and the city, and only the city is in a settlement gazetteer.
    const { impl, calls } = fakeFetch({
      geocode: (query) => (query === 'San Francisco' ? [GEOCODE_HIT] : []),
    });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'Crocker Amazon Soccer Fields, 1580 Geneva Ave, San Francisco, CA 94112',
      days: 6,
      fetchImpl: impl,
    });
    expect(result).toMatchObject({
      place: 'San Francisco, California, United States',
      broadened: true,
      resolvedFrom: 'Crocker Amazon Soccer Fields, 1580 Geneva Ave, San Francisco, CA 94112',
    });
    // The street line is never queried, and the forecast used the town's coords.
    expect(geocodeQueries(calls)).toEqual([
      'Crocker Amazon Soccer Fields, 1580 Geneva Ave, San Francisco, CA 94112',
      'Crocker Amazon Soccer Fields',
      'San Francisco',
    ]);
    // The street line is never a rung of its own — only the venue and the town.
    expect(geocodeQueries(calls)).not.toContain('1580 Geneva Ave');
    expect(calls[calls.length - 1]).toContain('latitude=37.77493');
  });

  it('rejects a fuzzy near-match on a broadened candidate', async () => {
    // "Crocker" is a real settlement. Accepting it would answer confidently
    // about somewhere the owner has never been.
    const { impl } = fakeFetch({
      geocode: (query) =>
        query === 'San Francisco'
          ? [GEOCODE_HIT]
          : query === 'Crocker Amazon Soccer Fields'
            ? [{ ...GEOCODE_HIT, name: 'Crocker', latitude: 39.3, longitude: -121.0 }]
            : [],
    });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'Crocker Amazon Soccer Fields, San Francisco',
      days: 6,
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ place: 'San Francisco, California, United States' });
  });

  it('keeps the verbatim query lenient, so a plain name still resolves', async () => {
    const { impl, calls } = fakeFetch({
      geocode: [{ ...GEOCODE_HIT, name: 'San Francisco Bay' }],
    });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 6,
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ place: 'San Francisco Bay, California, United States' });
    expect(geocodeQueries(calls)).toEqual(['San Francisco']);
  });

  it('uses the region hint to pick between same-named towns', async () => {
    const { impl } = fakeFetch({
      geocode: (query) =>
        query === 'Portland'
          ? [
              {
                ...GEOCODE_HIT,
                name: 'Portland',
                admin1: 'Maine',
                latitude: 43.6,
                longitude: -70.2,
              },
              {
                ...GEOCODE_HIT,
                name: 'Portland',
                admin1: 'Oregon',
                latitude: 45.5,
                longitude: -122.6,
              },
            ]
          : [],
    });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'Portland, Oregon',
      days: 6,
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ place: 'Portland, Oregon, United States' });
  });

  it('tells the model to retry with a town when only a venue was given', async () => {
    // This is the reported bug. A bare venue has nothing to broaden to, so the
    // only thing that rescues the turn is copy the model acts on.
    const { impl, calls } = fakeFetch({ geocode: [] });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'Crocker Amazon Soccer Fields',
      days: 6,
      fetchImpl: impl,
    });
    expect(result).toMatchObject({
      retryWith: 'city',
      tried: ['Crocker Amazon Soccer Fields'],
    });
    // One rung, one call: there is no second form of a bare venue name to try.
    expect(calls).toHaveLength(1);
  });

  it('asks for no hourly data unless a date or time was requested', async () => {
    const { impl, calls } = fakeFetch();
    await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 6,
      fetchImpl: impl,
    });
    expect(calls[calls.length - 1]).not.toContain('hourly=');
  });

  it('answers for a named part of the day', async () => {
    const hours = Array.from({ length: 24 }, (_, hour) => hour);
    const { impl, calls } = fakeFetch({
      weather: hourlyBody('2026-08-29', hours, { 12: 61, 13: 61 }),
    });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 6,
      date: '2026-08-29',
      timeOfDay: 'midday',
      fetchImpl: impl,
    });
    expect(calls[calls.length - 1]).toContain('hourly=temperature_2m');
    const target = targetOf(result);
    expect(target.windows).toHaveLength(1);
    expect(target.windows[0]).toMatchObject({
      date: '2026-08-29',
      // Every row names its day — the response contract forbids a bare "midday".
      weekday: 'Sat',
      window: '11:00–14:00',
      label: 'midday',
      precipProbabilityMax: 70,
    });
  });

  it('matches the requested hour on a short DST day', async () => {
    // 23 entries: 02:00 does not exist. Anything that indexed by hour would
    // report 14:00's weather for a 13:00 kick-off.
    const hours = Array.from({ length: 24 }, (_, hour) => hour).filter((hour) => hour !== 2);
    const { impl } = fakeFetch({ weather: hourlyBody('2026-08-29', hours) });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 6,
      date: '2026-08-29',
      startHour: 13,
      endHour: 14,
      fetchImpl: impl,
    });
    const target = targetOf(result);
    expect(target.hours.map((hour) => hour.hour)).toEqual([13, 14]);
  });

  it('names the range it covers when the date is outside the forecast', async () => {
    const { impl } = fakeFetch({
      weather: hourlyBody('2026-08-29', [11, 12, 13]),
    });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 6,
      date: '2026-12-24',
      fetchImpl: impl,
    });
    expect((result as { error: string }).error).toContain('2026-12-24 is outside it');
  });

  it('degrades to the day when the provider returns no hourly block', async () => {
    const { impl } = fakeFetch();
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 6,
      date: '2026-08-29',
      timeOfDay: 'midday',
      fetchImpl: impl,
    });
    const target = targetOf(result);
    expect(target.hourlyUnavailable).toBe(true);
    expect(target.day).toMatchObject({ date: '2026-08-29', weekday: 'Sat' });
  });

  it("flags a window only once it has passed in the place's own clock", async () => {
    // Compared as local wall-clock strings: parsing them through Date would
    // read Reykjavik's afternoon as the server's and mislabel by hours.
    const weather = await fetchWeather(
      64,
      -22,
      fakeFetch({
        weather: { ...hourlyBody('2026-08-29', [11, 12, 13]), timezone: 'Atlantic/Reykjavik' },
      }).impl,
      { hourly: true },
    );
    const spec = { date: '2026-08-29', startHour: 11, endHour: 13 } as const;
    expect(
      buildTarget(weather as WeatherNow, spec, new Date('2026-08-29T09:00:00Z')).inThePast,
    ).toBeUndefined();
    expect(
      buildTarget(weather as WeatherNow, spec, new Date('2026-08-29T20:00:00Z')).inThePast,
    ).toBe(true);
  });

  it('stays inside the tool-result clip', async () => {
    // weather.lookup has no entry in RESULT_CHAR_LIMITS, so it gets the 8 KB
    // default. Past that the model sees less than it does today.
    const hours = Array.from({ length: 24 }, (_, hour) => hour);
    const { impl } = fakeFetch({ weather: hourlyBody('2026-08-29', hours) });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 6,
      date: '2026-08-29',
      fetchImpl: impl,
    });
    expect(JSON.stringify(result).length).toBeLessThan(8_000);
  });

  it('asks for a place when none was given and no location is on file', async () => {
    const { impl, calls } = fakeFetch();
    const emptyDb = {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
        }),
      }),
    } as unknown as Db;

    const result = await lookupWeather({
      db: emptyDb,
      agentId: 'agent-1',
      days: 7,
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ error: expect.stringContaining('no recent location') });
    expect(calls).toHaveLength(0);
  });

  it('surfaces a reading the provider could not supply', async () => {
    // A body with no `current` block parses to null rather than throwing.
    const { impl } = fakeFetch({ weather: { daily: WEATHER_BODY.daily } });
    const result = await lookupWeather({
      db: UNUSED_DB,
      agentId: 'agent-1',
      place: 'San Francisco',
      days: 7,
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ error: expect.stringContaining('no weather reading') });
  });
});

describe('weather.lookup registration', () => {
  const registry = registerBuiltinTools(new ToolRegistry(), {
    embed: async () => [],
    workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
  });

  it('is registered and autonomous', () => {
    const registered = registry.get('weather.lookup');
    expect(typeof registered?.tool.risk).toBe('function');
    expect(registered?.tool.acceptsUntrustedInput).toBe(true);
  });

  it('stays available to every trust tier', () => {
    // Unlike web.fetch/web.search, the destination is hardwired to Open-Meteo,
    // so there is no egress to strip: a weather question asked over email or
    // SMS by a stranger is answerable, and a tainted owner turn does not have
    // to raise an approval card to say whether it will rain.
    for (const tier of ['owner', 'known', 'unknown'] as const) {
      expect(registry.toolsForTask(tier).map((tool) => tool.name)).toContain('weather.lookup');
    }
    const flags = registry.get('weather.lookup')?.flags;
    expect(flags?.networkEgress).toBeUndefined();
    expect(flags?.returnsUntrustedContent).toBeUndefined();
    expect(flags?.outwardFacing).toBeUndefined();
  });

  it('runs end to end through the registered tool, under the task signal', async () => {
    // Covers the wiring itself: deps.fetchImpl reaching the helpers, and the
    // per-call signal merge that lets a cancelled task abort the lookup.
    const { impl, calls } = fakeFetch();
    const seen: (AbortSignal | undefined)[] = [];
    const wired = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
      fetchImpl: (url, init) => {
        seen.push(init?.signal);
        return impl(url, init);
      },
    });

    const controller = new AbortController();
    const result = await wired.get('weather.lookup')?.tool.execute(
      { place: 'San Francisco', days: 6 },
      {
        taskId: 'task-1',
        agentId: 'agent-1',
        trust: 'owner',
        tainted: false,
        db: UNUSED_DB,
        now: () => new Date(),
        signal: controller.signal,
        log: async () => {},
      },
    );

    expect(result).toMatchObject({ place: 'San Francisco, California, United States' });
    expect(calls).toHaveLength(2);
    // Every leg carries a live signal, and aborting the task aborts them.
    expect(seen.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(seen.every((signal) => signal?.aborted)).toBe(false);
    controller.abort();
    expect(seen.every((signal) => signal?.aborted)).toBe(true);
  });

  it('defaults to the current location and every day the provider has', () => {
    // 6, not 7: today is reported as current conditions, so the forecast can
    // only run tomorrow onward. Promising a 7th day would return one row short.
    const schema = registry.get('weather.lookup')?.tool.inputSchema;
    expect(schema?.parse({})).toEqual({ place: '', days: 6 });
  });
});
