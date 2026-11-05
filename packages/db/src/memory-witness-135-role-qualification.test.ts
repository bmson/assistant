import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import {
  qualifyMemoryWitnessRoleImages,
  runMemoryWitnessMigrationImage,
} from './memory-witness-role-qualification.js';
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
  'qualifies the schema 135 migration image, runtime readiness, and generic write compatibility',
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
      prefixDir = await mkdtemp(join(tmpdir(), 'assistant-memory-witness-role-135-'));
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
      await client`
      INSERT INTO memories
        (id,agent_id,category,kind,content,content_hash,source,owner_confirmed,pinned,origin_trust,owner_correction)
      VALUES
        (${legacyMemoryId},${owner},'knowledge','fact',${legacyContent},${contentHash},'manual',true,true,'owner',${JSON.stringify(ownerCorrection)}::jsonb)
    `;
      const [preMigrationColumn] = await client`
      SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema='public' AND table_name='memories' AND column_name='memory_write_witness'`;
      expect(preMigrationColumn?.count).toBe(0);
      await client.end({ timeout: 5 });
      client = undefined;

      await runMemoryWitnessMigrationImage(imagesReceipt as string, target.databaseUrl);
      await runMemoryWitnessMigrationImage(imagesReceipt as string, target.databaseUrl);
      client = postgres(target.databaseUrl, {
        max: 1,
        connect_timeout: 10,
        onnotice: () => {},
      });
      await client`SET statement_timeout = '15s'`;
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
  // Budget: 90s prefix migration + 45s fixture DDL + 90s legacy row setup
  // + 15s post-migration readback + 2 x 95s migration-image passes (10s
  // create, 5s inspect, 45s attach, 5s exit inspect, 30s cleanup) + 40s
  // runtime image starts + 45s readiness + 80s runtime-container cleanup
  // (10s logs and 30s exact close per role) + 240s for at most 16 host SQL
  // statements at the helper's 15s statement timeout + 50s fixture
  // drop/client close/temp cleanup = 885s; reserve 15s diagnostics margin.
  900_000,
);
