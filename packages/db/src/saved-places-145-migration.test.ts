import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { expect, it } from 'vitest';
import { emailIngestFixture } from '../../persistence/src/signal-test-scenarios.js';
import { withDisposableTestDatabase } from './disposable-test-database.js';
import { createPostgresGoogleCalendarConnectionRepository } from './google-calendar-connection-repository.js';
import { createPostgresHomeWeatherRepository } from './owner-context-repository.js';
import { createPostgresSavedPlacesRepository } from './saved-places.js';
import * as schema from './schema.js';
import { createPostgresSignalRepository } from './signals.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const journal: { entries: { idx: number; tag: string; when: number }[] } = JSON.parse(
  await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
);

it('preserves a populated household and signal across the Home and Saved places upgrades', async () => {
  const prefix = await mkdtemp(join(tmpdir(), 'assistant-b5-143-to-145-'));
  const entries = journal.entries.slice(0, 146);
  expect(entries.slice(143).map((entry) => entry.tag)).toEqual([
    '0143_google_household_calendar_choices',
    '0144_home_weather',
    '0145_saved_places',
  ]);
  const selectThrough = (index: number) =>
    writeFile(
      join(prefix, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: entries.slice(0, index + 1) }),
    );
  async function ledgerEntry(index: number) {
    const entry = entries[index];
    if (!entry) throw new Error(`Missing migration ${index}`);
    const { tag, when } = entry;
    const hash = createHash('sha256')
      .update(await readFile(join(prefix, `${tag}.sql`)))
      .digest('hex');
    return { hash, at: String(when) };
  }
  try {
    await mkdir(join(prefix, 'meta'));
    await Promise.all(
      entries.map(({ tag }) =>
        copyFile(join(migrationsFolder, `${tag}.sql`), join(prefix, `${tag}.sql`)),
      ),
    );
    await selectThrough(143);
    await withDisposableTestDatabase(
      async (client) => {
        const owner = randomUUID();
        const observed = new Date('2026-11-19T12:00:00Z');
        await client`INSERT INTO agents (id, name, email, workspace_prefix)
        VALUES (${owner}, 'Synthetic owner', 'saved-places@example.test', 'synthetic')`;
        const db = drizzle(client, { schema });
        const signals = createPostgresSignalRepository(db);
        const mail = emailIngestFixture(
          owner,
          'Invoice SYN-104: USD 42.15 is due on November 23, 2026.',
          observed,
        );
        await db.insert(schema.emailIngest).values(mail);
        const signal = await signals.record({
          agentId: owner,
          emailIngestId: mail.id,
          at: observed,
          subjectPersonIds: ['synthetic-owner'],
        });
        const calendar = createPostgresGoogleCalendarConnectionRepository(db);
        const connectionId = randomUUID();
        const state = {
          version: 1,
          adopted: true,
          ownerId: owner,
          revision: 1,
          flow: null,
          connection: {
            id: connectionId,
            credentialVersion: 0,
            account: { subject: 'synthetic-subject', email: 'family@example.test' },
            scopes: [],
            status: 'connected',
            connectedAt: observed.toISOString(),
            refreshTokenEncrypted: 'fixture',
            accessTokenEncrypted: null,
            accessTokenExpiresAt: null,
            refreshLease: null,
          },
        };
        await client`INSERT INTO google_calendar_connections (agent_id, state)
        VALUES (${owner}, ${JSON.stringify(state)}::text::jsonb)`;
        const household = {
          revision: randomUUID(),
          choices: [{ id: 'school@example.test', purpose: 'school' as const }],
        };
        expect(await calendar.saveHousehold(owner, connectionId, null, household)).toBe(true);
        async function expectPriorRecords() {
          expect(await signals.get(owner, signal.id)).toEqual(signal);
          expect((await calendar.get(owner))?.household).toEqual(household);
        }
        const ledger = () =>
          client`SELECT hash, created_at::text AS "at" FROM drizzle.__drizzle_migrations ORDER BY id`;
        const before = await ledger();
        expect(before).toHaveLength(144);
        await expectPriorRecords();

        await selectThrough(144);
        await migrate(db, { migrationsFolder: prefix });
        const afterHome = [...before, await ledgerEntry(144)];
        expect(await ledger()).toEqual(afterHome);
        await expectPriorRecords();
        const weather = createPostgresHomeWeatherRepository(db);
        expect(await weather.getHomeWeather(owner)).toBeNull();
        const home = {
          city: 'Juniper Bay',
          enabled: true,
          revision: randomUUID(),
          lat: 38.5,
          lng: -120.5,
        };
        expect(await weather.setHomeWeather(owner, home)).toBe(true);
        const [predecessor] = await client`SELECT to_regclass('public.saved_places') AS table`;
        expect(predecessor?.table).toBeNull();

        await selectThrough(145);
        await migrate(db, { migrationsFolder: prefix });
        const afterPlaces = [...afterHome, await ledgerEntry(145)];
        expect(await ledger()).toEqual(afterPlaces);
        await expectPriorRecords();
        expect(await weather.getHomeWeather(owner)).toEqual(home);
        const places = createPostgresSavedPlacesRepository(db);
        expect(await places.list(owner)).toEqual({ generation: null, places: [] });
        const place = {
          id: randomUUID(),
          revision: randomUUID(),
          details: {
            category: 'school' as const,
            label: 'Oak School',
            address: '1 Example Lane, Juniper Bay',
          },
        };
        expect(
          await places.change(owner, { ...place, generation: null, expectedRevision: null }),
        ).toBe(true);
        await migrate(db, { migrationsFolder: prefix });
        expect(await ledger()).toEqual(afterPlaces);
        expect(await places.list(owner)).toEqual({ generation: null, places: [place] });
        expect(await weather.getHomeWeather(owner)).toEqual(home);
        await expectPriorRecords();
      },
      { migrationsFolder: prefix },
    );
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
}, 45_000);
