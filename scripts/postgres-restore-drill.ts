import { isIP } from 'node:net';
import { loadConfig, validateRestoreRehearsalConfig } from '@assistant/config';

const TARGET_DATABASE = /^assistant_restore_[a-f0-9]{12}_test$/;

/**
 * Validate the identity of a local disposable restore target without connecting
 * to it. This command deliberately does not restore a dump or start Assistant.
 * The separate runtime profile has startup and ingress fences, but this CLI
 * remains configuration-only; it does not qualify a restored database.
 */
export function validatePostgresRestoreDrillTarget(databaseUrl: string | undefined): {
  database: string;
  host: string;
  port: number;
} {
  if (!databaseUrl) throw new Error('Set RESTORE_DRILL_DATABASE_URL to an explicit local target');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('RESTORE_DRILL_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new Error('Restore drill target must use PostgreSQL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(host);
  const loopback = ipVersion === 4 ? host.startsWith('127.') : ipVersion === 6 && host === '::1';
  if (!loopback) throw new Error('Restore drill target must use a loopback IP literal');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!TARGET_DATABASE.test(database))
    throw new Error('Restore drill database must be assistant_restore_<12 hex>_test');
  const runId = database.match(/^assistant_restore_([a-f0-9]{12})_test$/)?.[1];
  if (
    !runId ||
    decodeURIComponent(url.username) !== `assistant_restore_reader_${runId}` ||
    !url.password
  )
    throw new Error(
      'Restore drill target must use its run-scoped assistant_restore_reader_<run ID> credential',
    );
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Restore drill target has an invalid port');
  return { database, host, port };
}

function main(): void {
  const mode = process.argv.slice(2).join(' ');
  if (mode !== '--check-target' && mode !== '--check-profile')
    throw new Error(
      'Only --check-target and --check-profile are supported; this command never restores or starts a runtime',
    );
  if (mode === '--check-profile') {
    const config = loadConfig();
    const problems = validateRestoreRehearsalConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    if (!config.RESTORE_REHEARSAL)
      throw new Error('Set RESTORE_REHEARSAL=true to validate the inert runtime profile');
    const target = validatePostgresRestoreDrillTarget(config.DATABASE_URL);
    console.log(
      `Inert restore profile accepted for ${target.host}:${target.port}/${target.database}; the command did not connect, restore data, or start Assistant.`,
    );
    return;
  }
  const target = validatePostgresRestoreDrillTarget(process.env.RESTORE_DRILL_DATABASE_URL);
  console.log(
    `Disposable local target accepted (${target.host}:${target.port}/${target.database}). No database connection, restore, or application runtime was started.`,
  );
  console.log(
    'This check did not validate the inert runtime profile or restored data. Host-level provider egress denial, callback isolation, restored-work behavior, rollback, and promotion remain unqualified.',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Restore drill target validation failed',
    );
    process.exitCode = 1;
  }
}
