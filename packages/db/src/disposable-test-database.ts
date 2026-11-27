import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { allocateTestTarget, assertAllocatedTestTarget } from './test-target.js';

export async function withDisposableTestDatabase<T>(
  run: (client: postgres.Sql, databaseUrl: string) => Promise<T>,
  options: { migrationsFolder?: string } = {},
): Promise<T> {
  assertAllocatedTestTarget({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const target = allocateTestTarget(process.env.DATABASE_URL);
  const adminUrl = new URL(target.databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  let created = false;
  let client: postgres.Sql | undefined;
  let result: { value: T } | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await admin.unsafe(`CREATE DATABASE "${target.databaseName}"`);
    created = true;
    await admin.unsafe(
      `COMMENT ON DATABASE "${target.databaseName}" IS 'assistant-test-target:${target.token}'`,
    );
    client = postgres(target.databaseUrl, { max: 1, onnotice: () => {} });
    await migrate(drizzle(client), {
      migrationsFolder:
        options.migrationsFolder ?? fileURLToPath(new URL('../drizzle/', import.meta.url)),
    });
    result = { value: await run(client, target.databaseUrl) };
  } catch (error) {
    primaryError = error;
  } finally {
    const attemptCleanup = async (cleanup: () => Promise<unknown>) => {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    const connection = client;
    if (connection) await attemptCleanup(() => connection.end({ timeout: 5 }));
    if (created)
      await attemptCleanup(async () => {
        const [owned] = await admin<{ marker: string | null }[]>`
          SELECT shobj_description(oid, 'pg_database') AS marker
          FROM pg_database WHERE datname = ${target.databaseName}
        `;
        if (owned?.marker !== `assistant-test-target:${target.token}`)
          throw new Error('Disposable test database ownership mismatch');
        await admin.unsafe(`DROP DATABASE "${target.databaseName}" WITH (FORCE)`);
      });
    await attemptCleanup(() => admin.end({ timeout: 5 }));
  }
  if (primaryError && cleanupErrors.length)
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'Disposable test and cleanup failed',
    );
  if (primaryError) throw primaryError;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'Disposable test cleanup failed');
  if (!result) throw new Error('Disposable test produced no result');
  return result.value;
}
