import { spawnSync } from 'node:child_process';
import { loadConfig } from '@assistant/config';
import postgres from 'postgres';
import { shouldBootstrap0019Targets } from './migration-preflight.js';

const config = loadConfig();
const sql = postgres(config.DATABASE_URL, { max: 1, connect_timeout: 10, onnotice: () => {} });
try {
  await sql.begin(async (tx) => {
    const [tables] = await tx<
      { models: string | null; roles: string | null; journal: string | null }[]
    >`
      SELECT to_regclass('public.models')::text AS models,
             to_regclass('public.model_roles')::text AS roles,
             to_regclass('drizzle.__drizzle_migrations')::text AS journal
    `;
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
} catch {
  console.error('Database migration preflight failed; schema migrations were not started.');
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

if (process.exitCode !== 1) {
  const migration = spawnSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], {
    stdio: 'inherit',
  });
  process.exitCode = migration.status ?? 1;
}
