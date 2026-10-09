import { createHmac } from 'node:crypto';
import { createDb, type Db, locationPings } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import {
  formatLocationLine,
  latestLocation,
  locationPingFresh,
  purgeStaleLocations,
  recordLocationPing,
  verifyLocationSignature,
} from './location.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('location context — pure helpers', () => {
  it('verifies an HMAC signature and rejects forged/unsigned/secretless pings', () => {
    const secret = 'shortcut-secret';
    const body = JSON.stringify({ lat: 64.1466, lng: -21.9426 });
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(verifyLocationSignature(secret, body, sig)).toBe(true);
    expect(verifyLocationSignature(secret, body, sig.toUpperCase())).toBe(true); // case-insensitive
    expect(verifyLocationSignature(secret, body, 'deadbeef')).toBe(false);
    expect(verifyLocationSignature(secret, `${body} `, sig)).toBe(false); // body tampered
    expect(verifyLocationSignature(secret, body, null)).toBe(false);
    expect(verifyLocationSignature('', body, sig)).toBe(false); // ingest disabled
  });

  it('requires a recent capturedAt so a captured body cannot replay', () => {
    const now = new Date('2026-07-21T12:00:00Z');
    const at = (iso: string) => ({
      lat: 0,
      lng: 0,
      label: '',
      source: 'shortcut',
      capturedAt: iso,
    });
    // Fresh within the skew window.
    expect(locationPingFresh(at('2026-07-21T11:58:00Z'), now)).toBe(true);
    // Stale beyond the window — a replayed old ping.
    expect(locationPingFresh(at('2026-07-21T11:00:00Z'), now)).toBe(false);
    // Fail closed with no timestamp: a captured signed body would otherwise
    // replay forever, re-asserting a stale location as current.
    expect(locationPingFresh({ lat: 0, lng: 0, label: '', source: 'shortcut' }, now)).toBe(false);
  });

  it('formats an ambient location line, or nothing when there is no ping', () => {
    expect(formatLocationLine(null)).toBeUndefined();
    const now = new Date('2026-07-21T12:00:00Z');
    const line = formatLocationLine(
      {
        id: 'x',
        agentId: 'a',
        lat: '64.146600',
        lng: '-21.942600',
        label: 'Reykjavík',
        accuracyM: 20,
        source: 'shortcut',
        timeZone: null,
        capturedAt: new Date('2026-07-21T11:48:00Z'),
        createdAt: now,
        arrivalExpiresAt: null,
      },
      now,
    );
    expect(line).toContain('near Reykjavík');
    expect(line).toContain('64.1466, -21.9426');
    expect(line).toContain('12 min ago');
    expect(line).toContain('Approximate accuracy: 20 metres');
    expect(line).toContain('not proof the owner is still there');
  });

  it('names the device time zone when the ping carries one', () => {
    const now = new Date('2026-07-21T12:00:00Z');
    const row = {
      id: 'x',
      agentId: 'a',
      lat: '39.739200',
      lng: '-104.990300',
      label: '',
      accuracyM: 20,
      source: 'ios-app',
      timeZone: 'America/Denver',
      capturedAt: now,
      createdAt: now,
      arrivalExpiresAt: null,
    };
    expect(formatLocationLine(row, now)).toContain('device clock is in America/Denver');
    expect(formatLocationLine({ ...row, timeZone: null }, now)).not.toContain('device clock');
    expect(formatLocationLine({ ...row, accuracyM: null }, now)).toContain('Accuracy is unknown');
    expect(formatLocationLine({ ...row, accuracyM: 5000 }, now)).toBeUndefined();
    expect(
      formatLocationLine({ ...row, capturedAt: new Date(now.getTime() - 31 * 60_000) }, now),
    ).toBeUndefined();
    expect(
      formatLocationLine({ ...row, capturedAt: new Date(now.getTime() + 60_000) }, now),
    ).toBeUndefined();
  });
});

describe('location context — storage', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;

  async function cleanup() {
    await db.delete(locationPings).where(eq(locationPings.source, 'xtest'));
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup();
    } catch {
      console.warn('location.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('records a ping, returns the freshest within window, and purges stale ones', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // A stale ping (2 days ago) and a fresh one (now).
    await recordLocationPing(db, agentId, {
      lat: 40,
      lng: -74,
      label: 'old',
      source: 'xtest',
      capturedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    });
    const fresh = await recordLocationPing(db, agentId, {
      lat: 64.1466,
      lng: -21.9426,
      label: 'Reykjavík',
      source: 'xtest',
      timeZone: 'Atlantic/Reykjavik',
      capturedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    // Scoped to the test's own source so live pings from a real device cannot
    // outrank these rows and flake the run.
    const latest = await latestLocation(db, agentId, 1, 'xtest');
    expect(latest?.id).toBe(fresh.id);
    expect(latest?.label).toBe('Reykjavík');
    expect(latest?.timeZone).toBe('Atlantic/Reykjavik');

    // With a 1-day window, the 2-day-old ping is stale and purged; the fresh one stays.
    const purged = await purgeStaleLocations(db, 1);
    expect(purged).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(locationPings).where(eq(locationPings.source, 'xtest'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(fresh.id);

    // Narrowing the window (~1.4 min) past the 10-min-old ping yields nothing.
    const none = await latestLocation(db, agentId, 0.001, 'xtest');
    expect(none).toBeNull();
  });
});
