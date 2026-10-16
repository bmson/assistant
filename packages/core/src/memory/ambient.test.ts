import { ambientSnapshots, createDb, type Db, locationPings } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import {
  fetchWeather,
  geocodePlace,
  getAmbientBlock,
  placeQueryCandidates,
  refreshAmbientSnapshot,
} from './ambient.js';
import { recordLocationPing } from './location.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

/** A fake Open-Meteo response (overcast, high rain chance today). */
function fakeWeatherFetch(code = 3, precip = 90) {
  return (async () =>
    ({
      ok: true,
      json: async () => ({
        current: {
          temperature_2m: 10.8,
          weather_code: code,
          wind_speed_10m: 9,
          relative_humidity_2m: 72,
        },
        daily: {
          weather_code: [63],
          temperature_2m_max: [12.2],
          temperature_2m_min: [10.4],
          precipitation_probability_max: [precip],
        },
      }),
    }) as unknown as Response) as unknown as typeof fetch;
}

/** Today plus two coming days, so the forecast line has real content. */
function fakeForecastFetch() {
  return (async () =>
    ({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 10.8, weather_code: 3, wind_speed_10m: 9 },
        daily: {
          time: ['2026-08-24', '2026-08-25', '2026-08-26'],
          weather_code: [3, 0, 61],
          temperature_2m_max: [12.2, 15.6, 13.1],
          temperature_2m_min: [10.4, 9.2, 8.8],
          precipitation_probability_max: [10, 0, 80],
        },
      }),
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('ambient — weather fetch (pure)', () => {
  it('keeps the ambient forecast at seven days and requests supported daily variables', async () => {
    await fetchWeather(64, -22, async (url) => {
      const parsed = new URL(String(url));
      const daily = parsed.searchParams.get('daily')?.split(',');
      expect(parsed.searchParams.get('forecast_days')).toBe('7');
      expect(daily).not.toContain('time');
      expect(daily).toContain('temperature_2m_max');
      return fakeForecastFetch()(String(url));
    });
  });

  it('supports the documented 16-day horizon only when explicitly requested', async () => {
    await fetchWeather(
      64,
      -22,
      async (url) => {
        expect(new URL(String(url)).searchParams.get('forecast_days')).toBe('16');
        return fakeForecastFetch()(String(url));
      },
      { forecastDays: 16 },
    );
    await expect(fetchWeather(64, -22, fakeForecastFetch(), { forecastDays: 17 })).rejects.toThrow(
      'forecastDays must be an integer from 7 through 16',
    );
  });
  it('parses current + daily and rounds', async () => {
    const w = await fetchWeather(64, -22, fakeWeatherFetch(3, 40));
    expect(w).toMatchObject({
      tempC: 11,
      code: 3,
      description: 'overcast',
      highC: 12,
      lowC: 10,
      humidity: 72,
    });
    expect(w?.precipProbabilityMax).toBe(40);
  });

  it('throws on a non-ok response', async () => {
    const bad = (async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch;
    await expect(fetchWeather(64, -22, bad)).rejects.toThrow('weather fetch failed');
  });

  describe('geocodePlace', () => {
    /** One gazetteer hit, in Open-Meteo's shape. */
    function fakeGeocodeFetch(results: unknown[]) {
      return (async () =>
        ({
          ok: true,
          json: async () => ({ results }),
        }) as unknown as Response) as unknown as typeof fetch;
    }

    it('resolves a named place to coordinates and a full label', async () => {
      const hit = await geocodePlace(
        'San Francisco',
        fakeGeocodeFetch([
          {
            name: 'San Francisco',
            latitude: 37.77493,
            longitude: -122.41942,
            admin1: 'California',
            country: 'United States',
            timezone: 'America/Los_Angeles',
          },
        ]),
      );
      expect(hit).toEqual({
        label: 'San Francisco, California, United States',
        lat: 37.77493,
        lng: -122.41942,
        timezone: 'America/Los_Angeles',
      });
    });

    it('returns null when the gazetteer has no match', async () => {
      // The caller must be able to say "I could not find that place" rather
      // than silently answering about somewhere else.
      expect(await geocodePlace('Nowherecity', fakeGeocodeFetch([]))).toBeNull();
      const empty = (async () =>
        ({ ok: true, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
      expect(await geocodePlace('Nowherecity', empty)).toBeNull();
    });

    it('never calls out for a blank query', async () => {
      let called = false;
      const spy = (async () => {
        called = true;
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      expect(await geocodePlace('   ', spy)).toBeNull();
      expect(called).toBe(false);
    });

    it('falls back to the query when the hit carries no usable name parts', async () => {
      const hit = await geocodePlace(
        'Somewhere',
        fakeGeocodeFetch([{ latitude: 1.5, longitude: 2.5 }]),
      );
      expect(hit).toMatchObject({ label: 'Somewhere', lat: 1.5, lng: 2.5 });
    });

    it('throws on a non-ok response', async () => {
      const bad = (async () => ({ ok: false, status: 429 }) as Response) as unknown as typeof fetch;
      await expect(geocodePlace('Tokyo', bad)).rejects.toThrow('geocode failed');
    });
  });

  it('parses the coming days, skipping today and dropping malformed entries', async () => {
    const w = await fetchWeather(64, -22, fakeForecastFetch());
    expect(w?.forecast).toEqual([
      {
        date: '2026-08-25',
        code: 0,
        description: 'clear',
        lowC: 9,
        highC: 16,
        precipProbabilityMax: 0,
      },
      {
        date: '2026-08-26',
        code: 61,
        description: 'light rain',
        lowC: 9,
        highC: 13,
        precipProbabilityMax: 80,
      },
    ]);
  });
});

describe('placeQueryCandidates', () => {
  // The gazetteer holds settlements, so the ladder is over single components:
  // a comma-joined string may match nothing where its town matches cleanly.
  const cases: Array<[string, string[], string[]]> = [
    ['San Francisco', ['San Francisco'], []],
    ['Paris, France', ['Paris, France', 'Paris', 'France'], ['France']],
    // Most specific first: Reykjavík before Iceland, or a city question gets
    // answered with a country centroid — for Iceland, a glacier.
    ['Reykjavík, Iceland', ['Reykjavík, Iceland', 'Reykjavík', 'Iceland'], ['Iceland']],
    // The reported failure's location string: the street never becomes a rung,
    // and the state is kept as a hint rather than queried on its own.
    [
      'Crocker Amazon Soccer Fields, 1580 Geneva Ave, San Francisco, CA 94112',
      [
        'Crocker Amazon Soccer Fields, 1580 Geneva Ave, San Francisco, CA 94112',
        'Crocker Amazon Soccer Fields',
        'San Francisco',
      ],
      ['San Francisco', 'CA'],
    ],
    // A bare venue has nothing to broaden to. That is not a gap in the ladder —
    // it is why the miss error has to ask for the town.
    ['Crocker Amazon Soccer Fields', ['Crocker Amazon Soccer Fields'], []],
    ['  ', [], []],
  ];

  for (const [input, candidates, hints] of cases) {
    it(`splits ${JSON.stringify(input)}`, () => {
      expect(placeQueryCandidates(input)).toEqual({ candidates, hints });
    });
  }

  it('never returns more rungs than the attempt cap', () => {
    const long = 'A Venue, B Town, C County, D Region, E Country';
    expect(placeQueryCandidates(long).candidates.length).toBeLessThanOrEqual(3);
  });
});

describe('ambient — hourly is opt-in', () => {
  function urlSpy(body: unknown) {
    const urls: string[] = [];
    const impl = (async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, urls };
  }

  const DAILY_BODY = {
    current: { temperature_2m: 11, weather_code: 3, wind_speed_10m: 9 },
    daily: {
      time: ['2026-08-28', '2026-08-29'],
      weather_code: [3, 0],
      temperature_2m_max: [14, 16],
      temperature_2m_min: [8, 9],
      precipitation_probability_max: [10, 0],
    },
  };

  it('asks for no hourly block by default, so the snapshot payload is unchanged', () => {
    // refreshAmbientSnapshot calls fetchWeather with three arguments and reads
    // only current/daily. Seven days of hourly rows would roughly triple a
    // payload it rewrites every half hour.
    const { impl, urls } = urlSpy(DAILY_BODY);
    return fetchWeather(64, -22, impl).then((weather) => {
      expect(urls[0]).not.toContain('hourly=');
      expect(weather?.hourly).toBeUndefined();
    });
  });

  it('parses hour rows when asked, dropping any the provider left incomplete', async () => {
    const { impl, urls } = urlSpy({
      ...DAILY_BODY,
      timezone: 'Atlantic/Reykjavik',
      hourly: {
        time: ['2026-08-29T11:00', '2026-08-29T12:00', '2026-08-29T13:00'],
        // The middle row is missing its temperature and must be dropped rather
        // than shifting every later row by one.
        temperature_2m: [12, null, 14],
        apparent_temperature: [11, 11, 13],
        weather_code: [0, 0, 61],
        precipitation_probability: [5, 5, 70],
        wind_speed_10m: [10, 10, 18],
      },
    });
    const weather = await fetchWeather(64, -22, impl, { hourly: true });
    expect(urls[0]).toContain('hourly=temperature_2m');
    expect(weather?.timezone).toBe('Atlantic/Reykjavik');
    expect(weather?.hourly).toEqual([
      {
        time: '2026-08-29T11:00',
        date: '2026-08-29',
        hour: 11,
        tempC: 12,
        feelsLikeC: 11,
        code: 0,
        description: 'clear',
        precipProbability: 5,
        windKmh: 10,
      },
      {
        time: '2026-08-29T13:00',
        date: '2026-08-29',
        hour: 13,
        tempC: 14,
        feelsLikeC: 13,
        code: 61,
        description: 'light rain',
        precipProbability: 70,
        windKmh: 18,
      },
    ]);
  });
});

describe('ambient — snapshot refresh + block', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;

  async function cleanup() {
    await db.delete(ambientSnapshots).where(eq(ambientSnapshots.agentId, agentId));
    await db.delete(locationPings).where(eq(locationPings.source, 'xtest-amb'));
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup();
    } catch {
      console.warn('ambient.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('fuses location + weather into a cached block with derived flags', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await recordLocationPing(db, agentId, {
      lat: 64.1466,
      lng: -21.9426,
      label: 'Reykjavík',
      source: 'xtest-amb',
    });

    const r = await refreshAmbientSnapshot(
      { db, fetchImpl: fakeWeatherFetch(63, 100) },
      { agentId },
    );
    expect(r).toMatchObject({ computed: true, hasLocation: true, hasWeather: true });
    expect(r.flags.raining_soon).toBe(true);

    const block = await getAmbientBlock(db, agentId);
    expect(block).toContain('Right now');
    expect(block).toContain('Reykjavík');
    expect(block).toContain('chance of rain');
    expect(block).toContain('factor it into anything outdoors');
  });

  it('adds a coming-days line when the forecast reaches beyond today', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await refreshAmbientSnapshot({ db, fetchImpl: fakeForecastFetch() }, { agentId });

    const block = await getAmbientBlock(db, agentId);
    expect(block).toContain(
      'Coming days: Tue 9–16°C, clear; Wed 9–13°C, light rain, 80% chance of rain.',
    );
  });

  it('falls back to the location line when the snapshot is stale', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Force a stale snapshot (computed 3h ago); getAmbientBlock's TTL is 90 min.
    await refreshAmbientSnapshot({ db, fetchImpl: fakeWeatherFetch() }, { agentId });
    await db
      .update(ambientSnapshots)
      .set({ computedAt: new Date(Date.now() - 3 * 3600 * 1000) })
      .where(eq(ambientSnapshots.agentId, agentId));

    const block = await getAmbientBlock(db, agentId);
    // Degrades to the fresh location line (no stale weather), never null here.
    expect(block).toContain('Reykjavík');
    expect(block).not.toContain('chance of rain');
  });

  it('never lets a fresh weather cache override a newer position or an expired fix', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date();
    await refreshAmbientSnapshot({ db, fetchImpl: fakeWeatherFetch() }, { agentId, now });
    const movedAt = new Date(now.getTime() + 1000);
    await recordLocationPing(db, agentId, {
      lat: 64.1123,
      lng: -21.9,
      label: 'Kópavogur',
      accuracyM: 30,
      source: 'xtest-amb',
      capturedAt: movedAt.toISOString(),
    });
    const moved = await getAmbientBlock(db, agentId, { now: movedAt });
    expect(moved).toContain('Kópavogur');
    expect(moved).not.toContain('Reykjavík');
    expect(moved).not.toContain('Weather there');
    await refreshAmbientSnapshot({ db, fetchImpl: fakeWeatherFetch() }, { agentId, now: movedAt });
    const later = await getAmbientBlock(db, agentId, {
      now: new Date(movedAt.getTime() + 10 * 60_000),
    });
    expect(later).toContain('10 min ago');
    expect(later).toContain('Weather there');
    expect(
      await getAmbientBlock(db, agentId, { now: new Date(movedAt.getTime() + 31 * 60_000) }),
    ).toBeUndefined();
  });

  it('does not fall back to an old precise place after a new uncertain observation', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const now = new Date(Date.now() + 2000);
    await recordLocationPing(db, agentId, {
      lat: 0,
      lng: 0,
      label: 'Uncertain',
      accuracyM: 5000,
      source: 'xtest-amb',
      capturedAt: now.toISOString(),
    });
    expect(await getAmbientBlock(db, agentId, { now })).toBeUndefined();
  });
});
