import { createPrivateKey, sign } from 'node:crypto';

/**
 * Apple Maps Server API (directions) and Maps Web Snapshots (a static map for
 * the web card), signed with the Apple Developer key.
 *
 * The same .p8 key can carry APNs, MapKit, and WeatherKit, so the MAPKIT_*
 * settings fall back to the APNS_* ones: an installation that already sends
 * push notifications needs no second secret to draw a route.
 */

const API = 'https://maps-api.apple.com/v1';
const SNAPSHOT = 'https://snapshot.apple-mapkit.com';
const TIMEOUT_MS = 8_000;
const TOKEN_LIFETIME_S = 30 * 60;

export type MapsFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface MapKitCredentials {
  teamId: string;
  keyId: string;
  /** The .p8 file contents, base64-encoded to fit one env line. */
  privateKeyBase64: string;
}

export function mapKitCredentials(config: {
  MAPKIT_TEAM_ID?: string;
  MAPKIT_KEY_ID?: string;
  MAPKIT_PRIVATE_KEY?: string;
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string;
}): MapKitCredentials | undefined {
  const own = config.MAPKIT_TEAM_ID && config.MAPKIT_KEY_ID && config.MAPKIT_PRIVATE_KEY;
  const teamId = own ? config.MAPKIT_TEAM_ID : config.APNS_TEAM_ID;
  const keyId = own ? config.MAPKIT_KEY_ID : config.APNS_KEY_ID;
  const privateKeyBase64 = own ? config.MAPKIT_PRIVATE_KEY : config.APNS_PRIVATE_KEY;
  return teamId && keyId && privateKeyBase64 ? { teamId, keyId, privateKeyBase64 } : undefined;
}

/** ES256 over `data`, as the raw r||s the JOSE and Snapshots formats expect. */
function es256(data: string, credentials: MapKitCredentials): string {
  const key = createPrivateKey(Buffer.from(credentials.privateKeyBase64, 'base64'));
  return sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString(
    'base64url',
  );
}

/** The signed JWT exchanged at /v1/token for a short-lived access token. */
export function mapsAuthToken(credentials: MapKitCredentials, now = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'ES256', kid: credentials.keyId, typ: 'JWT' })}.${encode({
    iss: credentials.teamId,
    iat,
    exp: iat + TOKEN_LIFETIME_S,
    scope: 'server_api',
  })}`;
  return `${unsigned}.${es256(unsigned, credentials)}`;
}

let cachedToken: { key: string; value: string; expiresAt: number } | undefined;

/** Test seam. */
export function clearMapsTokenCache(): void {
  cachedToken = undefined;
}

async function accessToken(
  credentials: MapKitCredentials,
  fetchImpl: MapsFetch,
  signal?: AbortSignal,
): Promise<string> {
  const key = `${credentials.teamId}:${credentials.keyId}`;
  if (cachedToken?.key === key && cachedToken.expiresAt > Date.now() + 60_000)
    return cachedToken.value;
  const response = await fetchImpl(`${API}/token`, {
    headers: { authorization: `Bearer ${mapsAuthToken(credentials)}` },
    signal: withTimeout(signal),
  });
  if (!response.ok) throw new Error(`Apple Maps token request failed: HTTP ${response.status}`);
  const body = (await response.json()) as { accessToken?: string; expiresInSeconds?: number };
  if (!body.accessToken) throw new Error('Apple Maps returned no access token');
  cachedToken = {
    key,
    value: body.accessToken,
    expiresAt: Date.now() + (body.expiresInSeconds ?? 1800) * 1000,
  };
  return body.accessToken;
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type TravelMode = 'driving' | 'walking' | 'cycling';
const TRANSPORT: Record<TravelMode, string> = {
  driving: 'Automobile',
  walking: 'Walking',
  cycling: 'Cycling',
};

export interface Point {
  lat: number;
  lng: number;
}

export interface RoutePlace extends Point {
  label: string;
  address?: string;
}

export interface DirectionsResult {
  origin: RoutePlace & { current: boolean };
  destination: RoutePlace;
  mode: TravelMode;
  durationSeconds: number;
  distanceMeters: number;
  routeName?: string;
  hasTolls?: boolean;
  /** When to leave (arriveBy given) or when you would arrive (otherwise), ISO. */
  departAt: string;
  arriveAt: string;
  steps: Array<{ instruction: string; distanceMeters: number }>;
  /** The route line, Google encoded-polyline format (5-digit precision). */
  polyline: string;
  mapsUrl: string;
}

type Raw = Record<string, unknown>;
const rec = (value: unknown): Raw | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : undefined;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const text = (value: unknown, max = 120): string =>
  typeof value === 'string'
    ? value
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

function point(value: unknown): Point | undefined {
  const coordinate = rec(value);
  const lat = num(coordinate?.latitude);
  const lng = num(coordinate?.longitude);
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
}

function place(value: unknown, fallback: string): RoutePlace | undefined {
  const raw = rec(value);
  const at = point(raw?.coordinate);
  if (!at) return undefined;
  const lines = arr(raw?.formattedAddressLines)
    .map((line) => text(line))
    .filter(Boolean);
  const label = text(raw?.name) || lines[0] || fallback;
  return { ...at, label, ...(lines.length ? { address: lines.join(', ') } : {}) };
}

/** Ramer–Douglas–Peucker, tightened until the line fits `max` points. */
export function simplify(points: Point[], max = 150): Point[] {
  if (points.length <= max) return points;
  const distance = (p: Point, a: Point, b: Point) => {
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    if (!dx && !dy) return Math.hypot(p.lng - a.lng, p.lat - a.lat);
    return Math.abs(dy * p.lng - dx * p.lat + b.lng * a.lat - b.lat * a.lng) / Math.hypot(dx, dy);
  };
  const run = (tolerance: number): Point[] => {
    const keep = new Array<boolean>(points.length).fill(false);
    keep[0] = keep[points.length - 1] = true;
    const stack: Array<[number, number]> = [[0, points.length - 1]];
    while (stack.length) {
      const [start, end] = stack.pop() as [number, number];
      let worst = -1;
      let index = -1;
      for (let i = start + 1; i < end; i++) {
        const d = distance(points[i] as Point, points[start] as Point, points[end] as Point);
        if (d > worst) {
          worst = d;
          index = i;
        }
      }
      if (index > 0 && worst > tolerance) {
        keep[index] = true;
        stack.push([start, index], [index, end]);
      }
    }
    return points.filter((_, i) => keep[i]);
  };
  let tolerance = 0.00005;
  let line = run(tolerance);
  while (line.length > max) {
    tolerance *= 2;
    line = run(tolerance);
  }
  return line;
}

/** Google's encoded polyline algorithm, 5-digit precision. */
export function encodePolyline(points: Point[]): string {
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  const encode = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const { lat, lng } of points) {
    const la = Math.round(lat * 1e5);
    const ln = Math.round(lng * 1e5);
    encode(la - lastLat);
    encode(ln - lastLng);
    lastLat = la;
    lastLng = ln;
  }
  return out;
}

export function decodePolyline(encoded: string): Point[] {
  const points: Point[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/** Normalize a /v1/directions response into the tool's result. */
export function normalizeDirections(
  body: Raw,
  input: {
    mode: TravelMode;
    destinationQuery: string;
    originLabel: string;
    originIsCurrent: boolean;
    departAt?: Date;
    arriveBy?: Date;
    now: Date;
  },
): DirectionsResult | undefined {
  const route = rec(arr(body.routes)[0]);
  const reportedMode =
    typeof route?.transportType === 'string' ? route.transportType.toLowerCase() : undefined;
  if (!reportedMode || reportedMode !== TRANSPORT[input.mode]?.toLowerCase()) return undefined;
  const durationSeconds = num(route?.durationSeconds);
  const distanceMeters = num(route?.distanceMeters);
  const origin = place(body.origin, input.originLabel);
  const destination = place(body.destination, input.destinationQuery);
  if (!route || durationSeconds === undefined || distanceMeters === undefined) return undefined;
  if (!origin || !destination) return undefined;
  const steps = arr(body.steps).map(rec);
  const stepPaths = arr(body.stepPaths);
  const routeSteps = arr(route.stepIndexes)
    .map((index) => (typeof index === 'number' ? steps[index] : undefined))
    .filter((step): step is Raw => !!step);
  const line: Point[] = [];
  for (const step of routeSteps) {
    const path = arr(stepPaths[num(step.stepPathIndex) ?? -1]).map(point);
    for (const at of path) {
      const last = line.at(-1);
      if (at && !(last && last.lat === at.lat && last.lng === at.lng)) line.push(at);
    }
  }
  const departAt = input.arriveBy
    ? new Date(input.arriveBy.getTime() - durationSeconds * 1000)
    : (input.departAt ?? input.now);
  const arriveAt = input.arriveBy ?? new Date(departAt.getTime() + durationSeconds * 1000);
  const mapsUrl = `https://maps.apple.com/directions?${new URLSearchParams({
    source: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    mode: input.mode,
  })}`;
  const routeName = text(route.name);
  return {
    origin: { ...origin, current: input.originIsCurrent },
    destination,
    mode: input.mode,
    durationSeconds,
    distanceMeters,
    ...(routeName ? { routeName } : {}),
    ...(typeof route.hasTolls === 'boolean' ? { hasTolls: route.hasTolls } : {}),
    departAt: departAt.toISOString(),
    arriveAt: arriveAt.toISOString(),
    steps: routeSteps
      .map((step) => ({
        instruction: text(step.instructions, 160),
        distanceMeters: num(step.distanceMeters) ?? 0,
      }))
      .filter((step) => step.instruction)
      .slice(0, 8),
    polyline: encodePolyline(simplify(line.length ? line : [origin, destination])),
    mapsUrl,
  };
}

export async function appleDirections(input: {
  credentials: MapKitCredentials;
  /** Coordinates, or an address/place the owner named. */
  origin: Point | string;
  originLabel: string;
  originIsCurrent: boolean;
  destination: string;
  mode: TravelMode;
  departAt?: Date;
  arriveBy?: Date;
  now?: Date;
  fetchImpl?: MapsFetch;
  signal?: AbortSignal;
}): Promise<DirectionsResult | { error: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const token = await accessToken(input.credentials, fetchImpl, input.signal);
  const origin =
    typeof input.origin === 'string' ? input.origin : `${input.origin.lat},${input.origin.lng}`;
  const params = new URLSearchParams({
    origin,
    destination: input.destination,
    transportType: TRANSPORT[input.mode],
    lang: 'en-US',
  });
  // Resolve a bare place name ("Oracle Park") near where the trip starts.
  if (typeof input.origin !== 'string')
    params.set('searchLocation', `${input.origin.lat},${input.origin.lng}`);
  if (input.arriveBy)
    params.set('arrivalDate', input.arriveBy.toISOString().replace(/\.\d+Z$/, 'Z'));
  else if (input.departAt)
    params.set('departureDate', input.departAt.toISOString().replace(/\.\d+Z$/, 'Z'));
  const response = await fetchImpl(`${API}/directions?${params}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: withTimeout(input.signal),
  });
  if (response.status === 404 || response.status === 400)
    return { error: `No route found to "${input.destination.slice(0, 80)}".` };
  if (!response.ok) throw new Error(`Apple Maps directions failed: HTTP ${response.status}`);
  const result = normalizeDirections((await response.json()) as Raw, {
    mode: input.mode,
    destinationQuery: input.destination,
    originLabel: input.originLabel,
    originIsCurrent: input.originIsCurrent,
    ...(input.departAt ? { departAt: input.departAt } : {}),
    ...(input.arriveBy ? { arriveBy: input.arriveBy } : {}),
    now: input.now ?? new Date(),
  });
  return (
    result ?? {
      error: `No route with the requested ${input.mode} mode was confirmed to "${input.destination.slice(0, 80)}".`,
    }
  );
}

/**
 * A signed Maps Web Snapshots URL for a route: start and end pins and the
 * route line, centered automatically. Apple signs the exact path and query,
 * and the signature must be the last parameter.
 */
export function routeSnapshotUrl(
  credentials: MapKitCredentials,
  route: { origin: Point; destination: Point; polyline: string },
  options: { colorScheme?: 'light' | 'dark'; width?: number; height?: number } = {},
): string {
  const width = Math.min(Math.max(options.width ?? 600, 50), 640);
  const height = Math.min(Math.max(options.height ?? 300, 50), 640);
  const params = new URLSearchParams({
    center: 'auto',
    size: `${width}x${height}`,
    scale: '2',
    colorScheme: options.colorScheme === 'dark' ? 'dark' : 'light',
    poi: '0',
    annotations: JSON.stringify([
      { point: `${route.origin.lat},${route.origin.lng}`, color: '217a4b', glyphText: 'A' },
      {
        point: `${route.destination.lat},${route.destination.lng}`,
        color: 'c2410c',
        glyphText: 'B',
      },
    ]),
    overlays: JSON.stringify([
      { type: 'polyline', points: route.polyline, strokeColor: '217a4b', lineWidth: 5 },
    ]),
    teamId: credentials.teamId,
    keyId: credentials.keyId,
  });
  const path = `/api/v1/snapshot?${params}`;
  return `${SNAPSHOT}${path}&signature=${es256(path, credentials)}`;
}
