import { generateKeyPairSync, verify } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  appleDirections,
  clearMapsTokenCache,
  decodePolyline,
  encodePolyline,
  mapKitCredentials,
  mapsAuthToken,
  normalizeDirections,
  routeSnapshotUrl,
  simplify,
} from './apple.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const credentials = {
  teamId: 'TEAM123456',
  keyId: 'KEY1234567',
  privateKeyBase64: Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  ).toString('base64'),
};
const verifies = (data: string, signature: string) =>
  verify(
    'sha256',
    Buffer.from(data),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );

/** A trimmed /v1/directions body: Market St to Oracle Park. */
const body = {
  origin: {
    name: 'Current Location',
    coordinate: { latitude: 37.7857, longitude: -122.4011 },
    formattedAddressLines: ['181 Fremont St', 'San Francisco, CA'],
  },
  destination: {
    name: 'Oracle Park',
    coordinate: { latitude: 37.7786, longitude: -122.3893 },
    formattedAddressLines: ['24 Willie Mays Plaza', 'San Francisco, CA 94107'],
  },
  routes: [
    {
      name: 'King St',
      distanceMeters: 1850,
      durationSeconds: 540,
      hasTolls: false,
      stepIndexes: [0, 1],
      transportType: 'Automobile',
    },
  ],
  steps: [
    {
      stepPathIndex: 0,
      distanceMeters: 900,
      durationSeconds: 240,
      instructions: 'Turn right onto Howard St',
    },
    {
      stepPathIndex: 1,
      distanceMeters: 950,
      durationSeconds: 300,
      instructions: 'Turn left onto 3rd St\u0000',
    },
  ],
  stepPaths: [
    [
      { latitude: 37.7857, longitude: -122.4011 },
      { latitude: 37.7832, longitude: -122.3978 },
    ],
    [
      { latitude: 37.7832, longitude: -122.3978 },
      { latitude: 37.7786, longitude: -122.3893 },
    ],
  ],
};

beforeEach(() => clearMapsTokenCache());

describe('credentials and signing', () => {
  it('prefers MAPKIT_* and otherwise reuses the APNs key', () => {
    const apns = { APNS_TEAM_ID: 'T', APNS_KEY_ID: 'K', APNS_PRIVATE_KEY: 'P' };
    expect(mapKitCredentials(apns)).toEqual({ teamId: 'T', keyId: 'K', privateKeyBase64: 'P' });
    expect(
      mapKitCredentials({
        ...apns,
        MAPKIT_TEAM_ID: 'T2',
        MAPKIT_KEY_ID: 'K2',
        MAPKIT_PRIVATE_KEY: 'P2',
      }),
    ).toEqual({ teamId: 'T2', keyId: 'K2', privateKeyBase64: 'P2' });
    expect(mapKitCredentials({ APNS_TEAM_ID: 'T' })).toBeUndefined();
  });

  it('signs a server_api JWT with the key id and team', () => {
    const token = mapsAuthToken(credentials, new Date('2026-09-22T12:00:00Z'));
    const [header, payload, signature] = token.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
      iss: 'TEAM123456',
      scope: 'server_api',
      iat: 1790078400,
      exp: 1790080200,
    });
    expect(verifies(`${header}.${payload}`, signature)).toBe(true);
  });

  it('signs the snapshot path and query, with the signature last', () => {
    const url = new URL(
      routeSnapshotUrl(
        credentials,
        {
          origin: { lat: 37.7857, lng: -122.4011 },
          destination: { lat: 37.7786, lng: -122.3893 },
          polyline: encodePolyline([
            { lat: 37.7857, lng: -122.4011 },
            { lat: 37.7786, lng: -122.3893 },
          ]),
        },
        { colorScheme: 'dark' },
      ),
    );
    expect(url.origin).toBe('https://snapshot.apple-mapkit.com');
    const query = url.search.slice(1);
    expect(query.split('&').at(-1)).toMatch(/^signature=/);
    const signed = `${url.pathname}?${query.replace(/&signature=[^&]+$/, '')}`;
    expect(verifies(signed, url.searchParams.get('signature') as string)).toBe(true);
    expect(url.searchParams.get('colorScheme')).toBe('dark');
    expect(url.searchParams.get('teamId')).toBe('TEAM123456');
  });
});

describe('route geometry', () => {
  it('round-trips the encoded polyline at five digits', () => {
    const line = [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ];
    expect(encodePolyline(line)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodePolyline(encodePolyline(line))).toEqual(line);
  });

  it('simplifies a dense line to the cap while keeping both ends', () => {
    const dense = Array.from({ length: 1000 }, (_, i) => ({
      lat: 37 + i / 1000,
      lng: -122 + Math.sin(i / 20) / 100,
    }));
    const simple = simplify(dense, 150);
    expect(simple.length).toBeLessThanOrEqual(150);
    expect(simple[0]).toEqual(dense[0]);
    expect(simple.at(-1)).toEqual(dense.at(-1));
  });
});

describe('normalizeDirections', () => {
  const now = new Date('2026-09-22T18:00:00Z');
  it('reads distance, time, places, steps, and the joined route line', () => {
    const result = normalizeDirections(body, {
      mode: 'driving',
      destinationQuery: 'Oracle Park',
      originLabel: 'Current location',
      originIsCurrent: true,
      now,
    });
    expect(result).toMatchObject({
      durationSeconds: 540,
      distanceMeters: 1850,
      routeName: 'King St',
      hasTolls: false,
      origin: { label: 'Current Location', current: true },
      destination: {
        label: 'Oracle Park',
        address: '24 Willie Mays Plaza, San Francisco, CA 94107',
      },
      departAt: '2026-09-22T18:00:00.000Z',
      arriveAt: '2026-09-22T18:09:00.000Z',
      steps: [
        { instruction: 'Turn right onto Howard St' },
        { instruction: 'Turn left onto 3rd St' },
      ],
    });
    // Shared joints between step paths are not repeated.
    expect(decodePolyline(result?.polyline ?? '')).toHaveLength(3);
    expect(result?.mapsUrl).toBe(
      'https://maps.apple.com/directions?source=37.7857%2C-122.4011&destination=37.7786%2C-122.3893&mode=driving',
    );
  });

  it('works back from an arrival time to when to leave', () => {
    const result = normalizeDirections(body, {
      mode: 'driving',
      destinationQuery: 'Oracle Park',
      originLabel: 'Home',
      originIsCurrent: false,
      arriveBy: new Date('2026-09-22T19:00:00Z'),
      now,
    });
    expect(result?.departAt).toBe('2026-09-22T18:51:00.000Z');
    expect(result?.arriveAt).toBe('2026-09-22T19:00:00.000Z');
  });
});

describe('appleDirections', () => {
  it('exchanges a token once, then asks for the route with the owner location as the hint', async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') ?? '' });
      if (url.endsWith('/token'))
        return Response.json({ accessToken: 'access-1', expiresInSeconds: 1800 });
      return Response.json({
        ...body,
        routes: body.routes.map((route) => ({ ...route, transportType: 'Walking' })),
      });
    };
    const origin = { lat: 37.7857, lng: -122.4011 };
    const input = {
      credentials,
      origin,
      originLabel: 'Current location',
      originIsCurrent: true,
      destination: 'Oracle Park',
      mode: 'walking' as const,
      fetchImpl,
    };
    await appleDirections(input);
    const second = await appleDirections(input);
    expect(calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1);
    const directions = new URL(calls.at(-1)?.url ?? '');
    expect(directions.pathname).toBe('/v1/directions');
    expect(Object.fromEntries(directions.searchParams)).toMatchObject({
      origin: '37.7857,-122.4011',
      destination: 'Oracle Park',
      transportType: 'Walking',
      searchLocation: '37.7857,-122.4011',
    });
    expect(calls.at(-1)?.auth).toBe('Bearer access-1');
    expect(second).toMatchObject({ mode: 'walking', durationSeconds: 540 });
  });

  it('reports an unroutable destination as an error the model can relay', async () => {
    const fetchImpl = async (url: string) =>
      url.endsWith('/token')
        ? Response.json({ accessToken: 'a', expiresInSeconds: 1800 })
        : new Response('{}', { status: 404 });
    expect(
      await appleDirections({
        credentials,
        origin: 'Home',
        originLabel: 'Home',
        originIsCurrent: false,
        destination: 'Atlantis',
        mode: 'driving',
        fetchImpl,
      }),
    ).toEqual({ error: 'No route found to "Atlantis".' });
  });
});

it('preserves cycling in the external Maps link and refuses a provider driving route', () => {
  const input = {
    mode: 'cycling' as const,
    destinationQuery: 'Oracle Park',
    originLabel: 'Start',
    originIsCurrent: false,
    now: new Date('2026-10-07Z'),
  };
  expect(normalizeDirections(body, input)).toBeUndefined();
  const result = normalizeDirections(
    { ...body, routes: body.routes.map((route) => ({ ...route, transportType: 'CYCLING' })) },
    input,
  );
  expect(result?.mode).toBe('cycling');
  expect(new URL(result?.mapsUrl ?? '').searchParams.get('mode')).toBe('cycling');
  expect(result?.mapsUrl).not.toContain('dirflg=d');
});
