import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@assistant/config';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';
import { shouldBootstrap0019Targets } from './migration-preflight.js';
import {
  assertCompatibleOwnerEditorMigrationTail,
  IncompatibleOwnerEditorMigrationTailError,
} from './migration-tail-guard.js';

const config = loadConfig();
const migrationsFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const sql = postgres(config.DATABASE_URL, { max: 1, connect_timeout: 10, onnotice: () => {} });
let expectedOwnerEditorTail: { hash: string; folderMillis: number }[] = [];
try {
  expectedOwnerEditorTail = readMigrationFiles({ migrationsFolder })
    .slice(130)
    .map(({ hash, folderMillis }) => ({ hash, folderMillis }));
  assertCompatibleOwnerEditorMigrationTail(expectedOwnerEditorTail, []);
  await sql.begin(async (tx) => {
    const [tables] = await tx<
      { models: string | null; roles: string | null; journal: string | null }[]
    >`
      SELECT to_regclass('public.models')::text AS models,
             to_regclass('public.model_roles')::text AS roles,
             to_regclass('drizzle.__drizzle_migrations')::text AS journal
    `;
    if (tables?.journal) {
      const floor = expectedOwnerEditorTail[0]!.folderMillis;
      const appliedTail = await tx<{ hash: string | null; createdAt: string | null }[]>`
        SELECT hash, created_at::text AS "createdAt"
        FROM drizzle.__drizzle_migrations
        WHERE created_at IS NULL OR created_at >= ${floor}
        ORDER BY created_at ASC NULLS FIRST, id ASC
        LIMIT ${expectedOwnerEditorTail.length + 1}
      `;
      assertCompatibleOwnerEditorMigrationTail(expectedOwnerEditorTail, appliedTail);
    }
    if (!tables?.models || !tables.roles || !tables.journal) return;

    const [journal] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
    `;
    const [role] = await tx<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM public.model_roles WHERE role = 'extract') AS exists
    `;
    if (
      !shouldBootstrap0019Targets({
        modelsTableExists: Boolean(tables.models),
        roleTableExists: Boolean(tables.roles),
        journalExists: Boolean(tables.journal),
        appliedMigrations: journal?.count ?? 0,
        extractRoleExists: role?.exists === true,
      })
    )
      return;
    await tx`
      INSERT INTO public.models (id, label, capabilities, enabled)
      VALUES
        ('deepseek/deepseek-chat', 'Retired migration compatibility model', '{}'::jsonb, false),
        ('openai/gpt-oss-120b', 'GPT-OSS 120B', '{}'::jsonb, true)
      ON CONFLICT (id) DO NOTHING
    `;
  });
} catch (error) {
  if (error instanceof IncompatibleOwnerEditorMigrationTailError) {
    console.error(
      'Database migration history is incompatible; inspect the migration ledger and schema, then use a reviewed forward-only bridge before retrying.',
    );
  } else {
    console.error('Database migration preflight failed; schema migrations were not started.');
  }
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

if (process.exitCode !== 1) {
  const migration = spawnSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], {
    stdio: 'inherit',
  });
  process.exitCode = migration.status ?? 1;
  if (migration.status === 0) {
    const verificationSql = postgres(config.DATABASE_URL, {
      max: 1,
      connect_timeout: 10,
      onnotice: () => {},
    });
    try {
      await verificationSql.begin(async (tx) => {
        const floor = expectedOwnerEditorTail[0]!.folderMillis;
        const appliedTail = await tx<{ hash: string | null; createdAt: string | null }[]>`
          SELECT hash, created_at::text AS "createdAt"
          FROM drizzle.__drizzle_migrations
          WHERE created_at IS NULL OR created_at >= ${floor}
          ORDER BY created_at ASC NULLS FIRST, id ASC
          LIMIT ${expectedOwnerEditorTail.length + 1}
        `;
        assertCompatibleOwnerEditorMigrationTail(expectedOwnerEditorTail, appliedTail, true);
      });
    } catch (error) {
      if (error instanceof IncompatibleOwnerEditorMigrationTailError) {
        console.error(
          'Database migration history verification failed; inspect the migration ledger and schema, then use a reviewed forward-only bridge before retrying.',
        );
      } else {
        console.error(
          'Database migration verification failed; schema readiness was not confirmed.',
        );
      }
      process.exitCode = 1;
    } finally {
      await verificationSql.end({ timeout: 5 });
    }
  }
}
