import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { expect, it } from 'vitest';
import { withDisposableTestDatabase } from './disposable-test-database.js';
import { readPostgresHomeWeather } from './owner-context-repository.js';
import * as schema from './schema.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const journal: { entries: { idx: number; tag: string; when: number }[] } = JSON.parse(
  await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
);
const migration = journal.entries.find(({ idx }) => idx === 144);
const prior = journal.entries.filter(({ idx }) => idx < 144);

it('upgrades populated 143 to 144 without inferring Home for either legacy owner', async () => {
  expect(migration?.tag).toBe('0144_home_weather');
  expect(prior.at(-1)?.tag).toBe('0143_google_household_calendar_choices');
  const prefix = await mkdtemp(join(tmpdir(), 'assistant-b5-schema143-'));
  try {
    await mkdir(join(prefix, 'meta'));
    const until144 = await mkdtemp(join(prefix, 'through-144-'));
    await mkdir(join(until144, 'meta'));
    await writeFile(
      join(prefix, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: prior }),
    );
    await Promise.all(
      prior.map(({ tag }) =>
        copyFile(join(migrationsFolder, `${tag}.sql`), join(prefix, `${tag}.sql`)),
      ),
    );
    await writeFile(
      join(until144, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.filter(({ idx }) => idx <= 144) }),
    );
    await Promise.all(
      journal.entries
        .filter(({ idx }) => idx <= 144)
        .map(({ tag }) =>
          copyFile(join(migrationsFolder, `${tag}.sql`), join(until144, `${tag}.sql`)),
        ),
    );
    await withDisposableTestDatabase(
      async (client) => {
        const first = randomUUID();
        const second = randomUUID();
        await client`INSERT INTO agents (id, name, email, workspace_prefix, timezone)
        VALUES (${first}, 'First fixture', 'first@example.test', 'one', 'America/Los_Angeles'),
               (${second}, 'Second fixture', 'second@example.test', 'two', 'UTC')`;
        const ledger = () => client`
        SELECT hash, created_at::text AS "at" FROM drizzle.__drizzle_migrations ORDER BY id`;
        const before = await ledger();
        expect(before).toHaveLength(144);
        const [predecessor] = await client`SELECT count(*)::int AS count
        FROM information_schema.columns WHERE table_name='agents' AND column_name='home_weather'`;
        expect(predecessor?.count).toBe(0);
        const db = drizzle(client, { schema });
        await migrate(db, { migrationsFolder: until144 });
        const sqlHash = createHash('sha256')
          .update(await readFile(join(migrationsFolder, '0144_home_weather.sql')))
          .digest('hex');
        const after = await ledger();
        expect(after).toEqual([...before, { hash: sqlHash, at: String(migration?.when) }]);
        expect(
          await client`SELECT name, timezone, home_weather IS NULL AS "unconfigured" FROM agents ORDER BY name`,
        ).toEqual([
          { name: 'First fixture', timezone: 'America/Los_Angeles', unconfigured: true },
          { name: 'Second fixture', timezone: 'UTC', unconfigured: true },
        ]);
        expect(await readPostgresHomeWeather(db, first)).toBeNull();
        expect(await readPostgresHomeWeather(db, second)).toBeNull();
        await migrate(db, { migrationsFolder: until144 });
        expect(await ledger()).toEqual(after);
      },
      { migrationsFolder: prefix },
    );
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
}, 45_000);
