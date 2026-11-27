import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { emailIngestFixture } from '../../persistence/src/signal-test-scenarios.js';
import { createPostgresHouseholdHandoffRepository } from './household-handoffs.js';
import {
  qualifyMemoryWitnessRoleImages,
  runMemoryWitnessMigrationImage,
} from './memory-witness-role-qualification.js';
import { createPostgresHomeWeatherRepository } from './owner-context-repository.js';
import { createPostgresSavedPlacesRepository } from './saved-places.js';
import * as schema from './schema.js';
import { createPostgresSignalRepository } from './signals.js';
import { allocateTestTarget, assertAllocatedTestTarget } from './test-target.js';

const folder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
const imagesReceipt = process.env.ASSISTANT_MEMORY_WITNESS_IMAGE_RECEIPT;

async function bounded<T>(name: string, ms: number, operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${name} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function dropOwnedDatabase(
  admin: ReturnType<typeof postgres>,
  target: ReturnType<typeof allocateTestTarget>,
): Promise<{ ownershipMarkerVerified: boolean; dropped: boolean; absenceVerified: true }> {
  const rows = await admin<{ databaseName: string; marker: string | null }[]>`
    SELECT datname AS "databaseName",shobj_description(oid,'pg_database') AS marker
    FROM pg_database WHERE datname=${target.databaseName}`;
  if (rows.length && rows[0]?.marker !== `assistant-test-target:${target.token}`)
    throw new Error('Refusing to drop an unowned migration qualification database.');
  const dropped = rows.length > 0;
  if (dropped) await admin.unsafe(`DROP DATABASE "${target.databaseName}" WITH (FORCE)`);
  const remaining = await admin<{ databaseName: string }[]>`
    SELECT datname AS "databaseName" FROM pg_database WHERE datname=${target.databaseName}`;
  if (remaining.length)
    throw new Error('Owned migration qualification database remains after DROP.');
  return {
    ownershipMarkerVerified: rows.length > 0,
    dropped,
    absenceVerified: true,
  };
}

it.skipIf(!imagesReceipt)(
  'qualifies the schema 146 migration image, runtime readiness, and generic write compatibility',
  async () => {
    assertAllocatedTestTarget({
      databaseUrl: process.env.DATABASE_URL,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    });
    const target = allocateTestTarget(process.env.DATABASE_URL);
    const adminUrl = new URL(target.databaseUrl);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), {
      max: 1,
      connect_timeout: 10,
      onnotice: () => {},
    });
    let prefixDir: string | undefined;
    let created = false;
    let client: ReturnType<typeof postgres> | undefined;
    let primaryError: unknown;
    let databaseClosure:
      | {
          ownershipMarkerVerified: boolean;
          dropped: boolean;
          absenceVerified: true;
        }
      | undefined;
    try {
      await admin`SET statement_timeout = '15s'`;
      prefixDir = await mkdtemp(join(tmpdir(), 'assistant-memory-witness-role-146-'));
      await admin.unsafe(`CREATE DATABASE "${target.databaseName}"`);
      created = true;
      await admin.unsafe(
        `COMMENT ON DATABASE "${target.databaseName}" IS 'assistant-test-target:${target.token}'`,
      );
      client = postgres(target.databaseUrl, {
        max: 1,
        connect_timeout: 10,
        onnotice: () => {},
      });
      await client`SET statement_timeout = '30s'`;

      // Seed the historical 0134 state, complete the exact B5 prefix, and
      // populate B5 settings before the 146 image advances the same database.
      const forwardEntries = journal.entries.slice(135);
      expect(forwardEntries.map((entry: { tag: string }) => entry.tag)).toEqual([
        '0135_memory_write_witness',
        '0136_google_calendar_connections',
        '0137_estimated_cost_approval',
        '0138_mcp_oauth_state',
        '0139_research_assignment_state',
        '0140_cost_event_accounted_at',
        '0141_bill_email_evidence',
        '0142_signal_store',
        '0143_google_household_calendar_choices',
        '0144_home_weather',
        '0145_saved_places',
        '0146_household_handoffs',
      ]);
      const expectedForwardLedger = await Promise.all(
        forwardEntries.map(async (entry: { tag: string; when: number }) => ({
          hash: createHash('sha256')
            .update(await readFile(join(folder, `${entry.tag}.sql`)))
            .digest('hex'),
          createdAt: String(entry.when),
        })),
      );
      const prefixEntries = journal.entries.slice(0, 135);
      expect(prefixEntries).toHaveLength(135);
      expect(prefixEntries.at(-1)?.tag).toBe('0134_owner_memory_creation');
      await mkdir(join(prefixDir, 'meta'));
      await writeFile(
        join(prefixDir, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries: prefixEntries }),
      );
      for (const entry of prefixEntries)
        await writeFile(
          join(prefixDir, `${entry.tag}.sql`),
          await readFile(join(folder, `${entry.tag}.sql`)),
        );
      await bounded(
        'populated 0134 prefix construction',
        90_000,
        migrate(drizzle(client), { migrationsFolder: prefixDir }),
      );

      const owner = randomUUID();
      const legacyMemoryId = randomUUID();
      const legacyReservationId = randomUUID();
      const legacyCostEventId = randomUUID();
      const legacyMcpId = randomUUID();
      const legacyContent = 'Legacy owner corrected note at migration 0134';
      const contentHash = createHash('sha256').update(legacyContent).digest('hex');
      const priorContentHash = 'a'.repeat(64);
      const ownerCorrection = {
        version: 1,
        correctedByOwner: true,
        priorContentHash,
        currentContentHash: contentHash,
        correctedAt: '2026-11-01T00:00:00.000Z',
      };
      await client`INSERT INTO agents (id,name,email,workspace_prefix,timezone,locale,signature) VALUES (${owner},'Synthetic role qualification owner',${`${owner}@memory-witness.invalid`},${`workspace/${owner}`},'America/Los_Angeles','is','Synthetic owner signature')`;
      // drizzle(client) installs transparent JSON serializers. Bind serialized
      // fixtures as text so both this client and the later fresh client agree.
      await client`
      INSERT INTO memories
        (id,agent_id,category,kind,content,content_hash,source,owner_confirmed,pinned,origin_trust,owner_correction)
      VALUES
        (${legacyMemoryId},${owner},'knowledge','fact',${legacyContent},${contentHash},'manual',true,true,'owner',${JSON.stringify(ownerCorrection)}::text::jsonb)
    `;
      const [preMigrationColumn] = await client`
      SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema='public' AND table_name='memories' AND column_name='memory_write_witness'`;
      expect(preMigrationColumn?.count).toBe(0);
      await client`
        INSERT INTO cost_reservations (id,source,estimated_usd,status,unknown_reason)
        VALUES (${legacyReservationId},'model',0.125001,'unknown','synthetic pre-migration outcome')`;
      await client`
        INSERT INTO cost_events (id,source,usd)
        VALUES (${legacyCostEventId},'model',0.123000)`;
      await client`
        INSERT INTO mcp_connections (id,agent_id,name,endpoint,status,bearer_token_encrypted)
        VALUES (${legacyMcpId},${owner},'Fixture MCP','https://mcp.invalid/', 'ready','sealed-fixture')`;
      const b5Entries = journal.entries.slice(0, 146);
      expect(b5Entries.at(-1)?.tag).toBe('0145_saved_places');
      for (const entry of b5Entries.slice(prefixEntries.length))
        await writeFile(
          join(prefixDir, `${entry.tag}.sql`),
          await readFile(join(folder, `${entry.tag}.sql`)),
        );
      await writeFile(
        join(prefixDir, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries: b5Entries }),
      );
      await bounded(
        'populated B5 prefix construction',
        90_000,
        migrate(drizzle(client), { migrationsFolder: prefixDir }),
      );
      const b5db = drizzle(client, { schema });
      const [legacyHome] = await client`
        SELECT home_weather AS choice, home_weather IS NULL AS "isSqlNull"
        FROM agents WHERE id=${owner}`;
      expect(legacyHome).toEqual({ choice: null, isSqlNull: true });
      const [legacySavedPlaces] = await client`
        SELECT count(*)::int AS count FROM saved_places WHERE agent_id=${owner}`;
      expect(legacySavedPlaces?.count).toBe(0);
      const [calendarTable] = await client`
        SELECT to_regclass('public.google_calendar_connections')::text AS "tableName"`;
      expect(calendarTable?.tableName).toBe('google_calendar_connections');
      const calendarState = {
        version: 1,
        adopted: true,
        ownerId: owner,
        revision: 0,
        connection: null,
        flow: null,
      };
      await client`INSERT INTO google_calendar_connections (agent_id,state) VALUES (${owner},${JSON.stringify(calendarState)}::text::jsonb)`;
      const householdSettings = {
        connectionId: randomUUID(),
        revision: randomUUID(),
        choices: [{ id: 'family@example.test', purpose: 'household' }],
      };
      await client`
        INSERT INTO google_household_calendar_choices (agent_id, settings)
        VALUES (${owner}, ${JSON.stringify(householdSettings)}::text::jsonb)`;
      const home = {
        city: 'Juniper Bay',
        enabled: true,
        revision: randomUUID(),
        lat: 38.5,
        lng: -120.5,
      };
      expect(await createPostgresHomeWeatherRepository(b5db).setHomeWeather(owner, home)).toBe(
        true,
      );
      const place = {
        id: randomUUID(),
        revision: randomUUID(),
        details: {
          category: 'school' as const,
          label: 'Fixture School',
          address: '1 Fixture Lane',
        },
      };
      expect(
        await createPostgresSavedPlacesRepository(b5db).change(owner, {
          ...place,
          generation: null,
          expectedRevision: null,
        }),
      ).toBe(true);
      const observed = new Date('2026-11-19T12:00:00Z');
      const mail = emailIngestFixture(
        owner,
        'Invoice SYN-104: USD 42.15 is due on November 23, 2026.',
        observed,
      );
      await b5db.insert(schema.emailIngest).values(mail);
      const signal = await createPostgresSignalRepository(b5db).record({
        agentId: owner,
        emailIngestId: mail.id,
        at: observed,
        subjectPersonIds: ['fixture-owner'],
      });
      const ledger = (connection: ReturnType<typeof postgres>) => connection`
        SELECT hash,created_at::text AS "createdAt" FROM drizzle.__drizzle_migrations
        ORDER BY created_at,id`;
      const b5Ledger = [...(await ledger(client))];
      const [predecessorHandoffTable] =
        await client`SELECT to_regclass('public.household_handoffs') AS "tableName"`;
      expect(predecessorHandoffTable?.tableName).toBeNull();
      const lastMigration = expectedForwardLedger.at(-1);
      expect(lastMigration).toEqual({
        hash: '676b1049e2e167c5213fa062018282f261922be2b4d6261fdd55d40a4d831eb8',
        createdAt: '1795711047896',
      });
      const expectedLedger = [...b5Ledger, lastMigration];
      await client.end({ timeout: 5 });
      client = undefined;

      await runMemoryWitnessMigrationImage(imagesReceipt as string, target.databaseUrl);
      client = postgres(target.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
      await client`SET statement_timeout = '15s'`;
      expect([...(await ledger(client))]).toEqual(expectedLedger);
      await client.end({ timeout: 5 });
      client = undefined;

      await runMemoryWitnessMigrationImage(imagesReceipt as string, target.databaseUrl);
      client = postgres(target.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
      await client`SET statement_timeout = '15s'`;
      const forwardLedger = (await ledger(client)).slice(prefixEntries.length);
      expect([...forwardLedger]).toEqual(expectedForwardLedger);
      expect([...(await ledger(client))]).toEqual(expectedLedger);
      const upgraded = drizzle(client, { schema });
      expect(await createPostgresHouseholdHandoffRepository(upgraded).read(owner)).toBeNull();
      expect(await createPostgresHomeWeatherRepository(upgraded).getHomeWeather(owner)).toEqual(
        home,
      );
      expect(await createPostgresSavedPlacesRepository(upgraded).list(owner)).toEqual({
        generation: null,
        places: [place],
      });
      expect(await createPostgresSignalRepository(upgraded).get(owner, signal.id)).toEqual(signal);
      const [calendarAfter] =
        await client`SELECT state FROM google_calendar_connections WHERE agent_id=${owner}`;
      expect(calendarAfter?.state).toEqual(calendarState);
      const [householdAfter] = await client`
        SELECT settings FROM google_household_calendar_choices WHERE agent_id = ${owner}`;
      expect(householdAfter?.settings).toEqual(householdSettings);
      const budgetTables = await client`
        SELECT table_name AS "tableName" FROM information_schema.tables
        WHERE table_schema='public' AND table_name LIKE 'estimated_cost_%'
        ORDER BY table_name`;
      expect(budgetTables.map((row) => row.tableName)).toEqual([
        'estimated_cost_baselines',
        'estimated_cost_decisions',
        'estimated_cost_grants',
        'estimated_cost_quote_requests',
        'estimated_cost_requests',
      ]);
      const [legacyReservation] = await client`
        SELECT status,estimated_usd::text AS "estimatedUsd",reservation_kind AS "kind",
          cost_grant_id AS "grantId",unknown_reason AS "unknownReason"
        FROM cost_reservations WHERE id=${legacyReservationId}`;
      expect(legacyReservation).toEqual({
        status: 'unknown',
        estimatedUsd: '0.125001',
        kind: 'attempt',
        grantId: null,
        unknownReason: 'synthetic pre-migration outcome',
      });
      const [legacyCostEvent] = await client`
        SELECT usd::text,accounted_at AS "accountedAt"
        FROM cost_events WHERE id=${legacyCostEventId}`;
      expect(legacyCostEvent).toEqual({ usd: '0.123000', accountedAt: null });
      const [costAccountingColumn] = await client`
        SELECT is_nullable AS nullable, data_type AS type
        FROM information_schema.columns WHERE table_schema='public'
          AND table_name='cost_events' AND column_name='accounted_at'`;
      expect(costAccountingColumn).toEqual({ nullable: 'YES', type: 'timestamp with time zone' });
      const [billEvidence] = await client`
        SELECT is_nullable AS nullable, data_type AS type,
               to_regclass('public.email_ingest_bill_identity_idx') IS NOT NULL AS indexed
        FROM information_schema.columns WHERE table_schema='public'
          AND table_name='email_ingest' AND column_name='bill_evidence'`;
      expect(billEvidence).toEqual({ nullable: 'YES', type: 'jsonb', indexed: true });
      const [signalStore] = await client`
        SELECT to_regclass('public.signals')::text AS "tableName",
               to_regclass('public.signals_agent_kind_at_idx') IS NOT NULL AS indexed`;
      expect(signalStore).toEqual({ tableName: 'signals', indexed: true });
      const [legacyMcpConnection] = await client`
        SELECT status, enabled, bearer_token_encrypted AS "bearerTokenEncrypted", oauth_state AS "oauthState"
        FROM mcp_connections WHERE id=${legacyMcpId} AND agent_id=${owner}`;
      expect(legacyMcpConnection).toEqual({
        status: 'ready',
        enabled: true,
        bearerTokenEncrypted: 'sealed-fixture',
        oauthState: null,
      });
      const [legacyAfter] = await client`
      SELECT content,content_hash AS "contentHash",owner_correction AS "ownerCorrection",
        memory_write_witness IS NULL AS "witnessIsSqlNull"
      FROM memories WHERE id=${legacyMemoryId} AND agent_id=${owner}`;
      expect(legacyAfter).toEqual({
        content: legacyContent,
        contentHash,
        ownerCorrection,
        witnessIsSqlNull: true,
      });
      await client.end({ timeout: 5 });
      client = undefined;

      await qualifyMemoryWitnessRoleImages({
        imageReceiptPath: imagesReceipt as string,
        databaseUrl: target.databaseUrl,
        ownerId: owner,
        legacyMemoryId,
        legacyContent,
      });
      const proofDirectory = process.env.ASSISTANT_MEMORY_WITNESS_PROOF_DIR;
      if (proofDirectory) {
        await writeFile(
          join(proofDirectory, 'schema-146-forward-upgrade.json'),
          `${JSON.stringify(
            {
              prefixLastMigration: prefixEntries.at(-1)?.tag,
              forwardMigrations: forwardEntries.map((entry: { tag: string }) => entry.tag),
              appliedForwardLedger: [...forwardLedger],
              calendarTable: calendarTable?.tableName,
              disconnectedCalendarStateReadback: calendarAfter?.state,
              householdChoicesReadback: householdAfter?.settings,
              estimatedCostTables: budgetTables.map((row) => row.tableName),
              historicalUnknownReservationReadback: legacyReservation,
              legacyCostEventReadback: legacyCostEvent,
              oldOwnerHasNoHandoff: true,
              populatedB5RowsPreserved: true,
              repeatLedgerUnchanged: true,
              legacySavedPlacesStartEmpty: legacySavedPlaces?.count === 0,
              legacyHomeWeatherStartsUnconfigured: legacyHome?.isSqlNull,
              legacyMcpRecordPreserved: legacyMcpConnection?.oauthState === null,
              legacyMemoryWitnessRemainsSqlNull: legacyAfter?.witnessIsSqlNull,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
      }
    } catch (error) {
      primaryError = error;
    }

    const cleanupErrors: unknown[] = [];
    try {
      if (client) await client.end({ timeout: 5 });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      databaseClosure = await bounded(
        'owned fixture database drop and absence check',
        30_000,
        dropOwnedDatabase(admin, target),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await admin.end({ timeout: 5 });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (prefixDir)
        await bounded(
          'temporary migration directory cleanup',
          10_000,
          rm(prefixDir, { recursive: true, force: true }),
        );
    } catch (error) {
      cleanupErrors.push(error);
    }
    const proofDirectory = process.env.ASSISTANT_MEMORY_WITNESS_PROOF_DIR;
    if (proofDirectory) {
      try {
        await writeFile(
          join(proofDirectory, 'fixture-cleanup.json'),
          `${JSON.stringify(
            {
              createAcknowledged: created,
              ownershipMarkerVerified: databaseClosure?.ownershipMarkerVerified ?? null,
              dropped: databaseClosure?.dropped ?? null,
              absenceVerified: databaseClosure?.absenceVerified ?? null,
              cleanupErrorCount: cleanupErrors.length,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (primaryError && cleanupErrors.length)
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'Memory witness role qualification and cleanup failed.',
      );
    if (primaryError) throw primaryError;
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, 'Memory witness role qualification cleanup failed.');
  },
  // Budget: two 90s prefix migrations + 45s fixture DDL + 150s fixture population
  // + 15s post-migration readback + 2 x 95s migration-image passes (10s
  // create, 5s inspect, 45s attach, 5s exit inspect, 30s cleanup) + 40s
  // runtime image starts + 45s readiness + 80s runtime-container cleanup
  // (10s logs and 30s exact close per role) + 300s for at most 20 host SQL
  // statements at the helper's 15s statement timeout + 50s fixture
  // drop/client close/temp cleanup = 1095s; reserve 45s diagnostics margin.
  1_140_000,
);
