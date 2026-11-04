import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, fchmodSync, fsyncSync, openSync, writeSync } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  allocateTestTarget,
  isolatedTestEnvironment,
  testTargetMarkerPath,
} from './test-target.js';

type SqlClient = ((
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>) & {
  end(options?: { timeout?: number }): Promise<void>;
};
const requireFromDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
type PostgresFactory = (url: string, options: { max: number; onnotice: () => void }) => SqlClient;
const postgresModule: unknown = requireFromDb('postgres');
const postgresFactory: unknown =
  typeof postgresModule === 'function'
    ? postgresModule
    : postgresModule !== null && typeof postgresModule === 'object' && 'default' in postgresModule
      ? postgresModule.default
      : undefined;
if (typeof postgresFactory !== 'function')
  throw new TypeError('The postgres module does not expose a callable client factory.');
const postgres = postgresFactory as PostgresFactory;

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function emulatorArgsBindToHostPort(args: string, hostPort: string): boolean {
  const separator = hostPort.lastIndexOf(':');
  const host = hostPort.slice(0, separator);
  const port = hostPort.slice(separator + 1);
  if (!/^(127\.0\.0\.1|localhost)$/.test(host) || !/^\d+$/.test(port)) return false;
  const tokens = args
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, ''));
  const hasOption = (option: string, value: string) =>
    tokens.some(
      (token, index) =>
        token === `${option}=${value}` || (token === option && tokens[index + 1] === value),
    );
  const emulatorCommand = /firestore/i.test(args);
  const exactHostPort = hasOption('--host-port', hostPort);
  const exactSeparateHostPort = hasOption('--host', host) && hasOption('--port', port);
  return emulatorCommand && (exactHostPort || exactSeparateHostPort);
}

async function writeDurableReceipt(path: string, value: unknown): Promise<void> {
  const file = await openFile(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2));
    await file.chmod(0o600);
    await file.sync();
  } finally {
    await file.close();
  }
}

const node26Path = process.env.ASSISTANT_TEST_NODE26_BIN;
const pnpmCjsPath = process.env.ASSISTANT_TEST_PNPM_CJS;
const node26Sha256 = process.env.ASSISTANT_TEST_NODE26_SHA256;
const pnpmCjsSha256 = process.env.ASSISTANT_TEST_PNPM_CJS_SHA256;
if (!node26Path || !pnpmCjsPath || !isAbsolute(node26Path) || !isAbsolute(pnpmCjsPath))
  throw new Error('Set absolute pinned Node 26 and pnpm 10.34.5 executable paths before running.');
const runnerNodePath = node26Path;
const runnerPnpmCjsPath = pnpmCjsPath;
if (
  !node26Sha256 ||
  !/^[0-9a-f]{64}$/.test(node26Sha256) ||
  !pnpmCjsSha256 ||
  !/^[0-9a-f]{64}$/.test(pnpmCjsSha256)
)
  throw new Error('Pin the Node 26 and pnpm CJS binary SHA-256 values before running.');
const sourcePinsRaw = process.env.ASSISTANT_MEMORY_WITNESS_COMPAT_SOURCE_PINS;
if (!sourcePinsRaw) throw new Error('Reviewed source pins are required before compatibility runs.');
let sourcePins: Record<string, string>;
try {
  sourcePins = JSON.parse(sourcePinsRaw) as Record<string, string>;
} catch {
  throw new Error('Reviewed source pin map is not valid JSON.');
}
const requiredSourcePins = [
  'packages/db/drizzle/0135_memory_write_witness.sql',
  'packages/db/drizzle/meta/0135_snapshot.json',
  'packages/db/drizzle/meta/_journal.json',
  'packages/db/src/client.ts',
  'packages/db/src/migrate.ts',
  'packages/db/src/migration-upgrade.test.ts',
  'packages/db/src/schema.ts',
  'packages/db/src/workspace-migration.ts',
  'packages/firestore/src/memory-witness-compat.integration.test.ts',
  'packages/firestore/src/installation-owner.ts',
  'packages/firestore/src/store.ts',
  'packages/firestore/src/workspace-migration.ts',
  'packages/persistence/src/migration.ts',
  'packages/db/src/test-target.ts',
  'scripts/deny-test-egress.mjs',
  'scripts/test-memory-witness-firestore-compat.ts',
  'scripts/test-target.ts',
];
for (const file of requiredSourcePins) {
  const expected = sourcePins[file];
  if (!expected || !/^[0-9a-f]{64}$/.test(expected))
    throw new Error(`Missing reviewed source pin for ${file}.`);
  const actual = createHash('sha256')
    .update(await readFile(resolve(process.cwd(), file)))
    .digest('hex');
  if (actual !== expected) throw new Error(`Reviewed source pin mismatch for ${file}.`);
}
const preflightHome = await mkdtemp(join(tmpdir(), 'assistant-memory-witness-toolchain-'));
try {
  await chmod(preflightHome, 0o700);
  if ((await sha256File(node26Path)) !== node26Sha256)
    throw new Error('Node 26 binary SHA-256 does not match the reviewed toolchain pin.');
  if ((await sha256File(pnpmCjsPath)) !== pnpmCjsSha256)
    throw new Error('pnpm CJS SHA-256 does not match the reviewed toolchain pin.');
  const preflightEnv = {
    PATH: `${dirname(node26Path)}:/usr/bin:/bin`,
    HOME: preflightHome,
  };
  const nodeVersion = execFileSync(node26Path, ['--version'], {
    encoding: 'utf8',
    env: preflightEnv,
    timeout: 5000,
  }).trim();
  const pnpmVersion = execFileSync(node26Path, [pnpmCjsPath, '--version'], {
    encoding: 'utf8',
    env: preflightEnv,
    timeout: 5000,
  }).trim();
  if (!/^v26\./.test(nodeVersion) || pnpmVersion !== '10.34.5')
    throw new Error('Offline toolchain preflight requires Node 26 and pnpm 10.34.5.');
} finally {
  await rm(preflightHome, { recursive: true, force: false });
}

const evidenceDirectory = process.env.ASSISTANT_MEMORY_WITNESS_COMPAT_EVIDENCE_DIR;
if (!evidenceDirectory || !isAbsolute(evidenceDirectory))
  throw new Error('An absolute caller-owned compatibility evidence directory is required.');
const evidenceStat = await lstat(evidenceDirectory);
if (
  !evidenceStat.isDirectory() ||
  evidenceStat.isSymbolicLink() ||
  (evidenceStat.mode & 0o777) !== 0o700
)
  throw new Error('Compatibility evidence directory must be a private non-symlink directory.');
const logPath = join(evidenceDirectory, 'compatibility.log');
const preCleanupReceiptPath = join(evidenceDirectory, 'PRE-CLEANUP.json');
const resultReceiptPath = join(evidenceDirectory, 'RESULT.json');
const evidenceBundlePath = join(evidenceDirectory, 'postgres-export.bundle.json');
for (const path of [logPath, preCleanupReceiptPath, resultReceiptPath, evidenceBundlePath]) {
  try {
    await lstat(path);
    throw new Error('Refusing a non-fresh compatibility evidence path.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
const logFD = openSync(logPath, 'wx', 0o600);
fchmodSync(logFD, 0o600);

async function readPrivateJson(
  path: string | undefined,
  label: string,
): Promise<Record<string, unknown>> {
  if (!path || !isAbsolute(path)) throw new Error(`An absolute ${label} receipt path is required.`);
  const receiptStat = await lstat(path);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || (receiptStat.mode & 0o777) !== 0o600)
    throw new Error(`${label} receipt must be a private regular file with mode 0600.`);
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

const sourceDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!sourceDatabaseUrl) throw new Error('An explicit local PostgreSQL test endpoint is required.');
const parentReceipt = await readPrivateJson(
  process.env.ASSISTANT_TEST_POSTGRES_PARENT_RECEIPT,
  'PostgreSQL parent',
);
if (
  parentReceipt.state !== 'ready' ||
  parentReceipt.purpose !== 'synthetic local integration tests only' ||
  typeof parentReceipt.ownerToken !== 'string' ||
  !/^[a-f0-9]{32}$/.test(parentReceipt.ownerToken) ||
  typeof parentReceipt.root !== 'string' ||
  typeof parentReceipt.data !== 'string' ||
  typeof parentReceipt.binaryDirectory !== 'string' ||
  !Number.isInteger(parentReceipt.postmasterPID) ||
  !Number.isInteger(parentReceipt.port)
)
  throw new Error('PostgreSQL parent receipt lacks the owned local PG17 identity.');
const parentRoot = parentReceipt.root;
const parentData = parentReceipt.data;
const parentPid = parentReceipt.postmasterPID as number;
const parentPort = parentReceipt.port as number;
const parentRootStat = await lstat(parentRoot);
const ownerMarkerPath = join(parentRoot, 'owner.json');
const ownerMarkerStat = await lstat(ownerMarkerPath);
const parentOwner = JSON.parse(await readFile(ownerMarkerPath, 'utf8')) as Record<string, unknown>;
const postmasterPidFile = (await readFile(join(parentData, 'postmaster.pid'), 'utf8'))
  .split('\n')[0]
  ?.trim();
if (
  !parentRootStat.isDirectory() ||
  parentRootStat.isSymbolicLink() ||
  (parentRootStat.mode & 0o777) !== 0o700 ||
  resolve(parentData) !== resolve(parentRoot, 'data') ||
  !ownerMarkerStat.isFile() ||
  ownerMarkerStat.isSymbolicLink() ||
  (ownerMarkerStat.mode & 0o777) !== 0o600 ||
  parentOwner.ownerToken !== parentReceipt.ownerToken ||
  postmasterPidFile !== String(parentPid)
)
  throw new Error('PostgreSQL parent owner marker or postmaster PID does not match.');
const parentArgs = execFileSync('ps', ['-p', String(parentPid), '-o', 'args='], {
  encoding: 'utf8',
}).trim();
const expectedPostgresCommand = `${String(parentReceipt.binaryDirectory)}/postgres -D ${parentData} -h 127.0.0.1 -p ${parentPort}`;
if (!parentArgs.includes(expectedPostgresCommand))
  throw new Error('PostgreSQL process arguments do not match the owned parent receipt.');
if (sourceDatabaseUrl !== parentReceipt.databaseURL)
  throw new Error('PostgreSQL source endpoint does not match its owned parent receipt.');
if (
  process.env.DATABASE_URL !== parentReceipt.databaseURL ||
  process.env.TEST_DATABASE_URL !== parentReceipt.databaseURL
)
  throw new Error('DATABASE_URL and TEST_DATABASE_URL must both name the exact owned parent.');
const sourceDatabase = new URL(sourceDatabaseUrl);
if (
  sourceDatabase.hostname !== '127.0.0.1' ||
  sourceDatabase.port !== String(parentPort) ||
  decodeURIComponent(sourceDatabase.pathname.replace(/^\//, '')) !== 'postgres' ||
  sourceDatabase.port === '55432'
)
  throw new Error('PostgreSQL endpoint is not the exact owned loopback parent database.');
const target = allocateTestTarget(sourceDatabaseUrl);
const markerPath = testTargetMarkerPath(target.token);

const emulatorReceipt = await readPrivateJson(
  process.env.ASSISTANT_TEST_FIRESTORE_EMULATOR_RECEIPT,
  'Firestore emulator ownership',
);
if (
  emulatorReceipt.state !== 'ready' ||
  emulatorReceipt.kind !== 'firestore-emulator' ||
  emulatorReceipt.projectId !== 'demo-assistant-test' ||
  typeof emulatorReceipt.host !== 'string' ||
  typeof emulatorReceipt.root !== 'string' ||
  typeof emulatorReceipt.ownerNonce !== 'string' ||
  !/^[a-f0-9]{32}$/.test(emulatorReceipt.ownerNonce) ||
  !Number.isInteger(emulatorReceipt.pid) ||
  typeof emulatorReceipt.processArgsSha256 !== 'string' ||
  !/^[0-9a-f]{64}$/.test(emulatorReceipt.processArgsSha256) ||
  typeof emulatorReceipt.startedUTC !== 'string'
)
  throw new Error('Firestore emulator receipt lacks a fresh owned process and lease.');
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !emulatorHost ||
  emulatorReceipt.host !== emulatorHost ||
  !/^(127\.0\.0\.1|localhost):\d+$/.test(emulatorHost)
)
  throw new Error('Firestore emulator endpoint does not match the owned loopback lease.');
const emulatorRoot = emulatorReceipt.root;
const emulatorRootStat = await lstat(emulatorRoot);
const emulatorMarkerPath = join(emulatorRoot, 'firestore-emulator-owner.json');
const emulatorMarkerStat = await lstat(emulatorMarkerPath);
const emulatorMarker = JSON.parse(await readFile(emulatorMarkerPath, 'utf8')) as Record<
  string,
  unknown
>;
const emulatorPid = emulatorReceipt.pid as number;
const emulatorArgs = execFileSync('ps', ['-p', String(emulatorPid), '-o', 'args='], {
  encoding: 'utf8',
}).trim();
const emulatorAgeMs = Date.now() - Date.parse(emulatorReceipt.startedUTC);
const emulatorArgsSha256 = createHash('sha256').update(emulatorArgs).digest('hex');
if (
  !emulatorRootStat.isDirectory() ||
  emulatorRootStat.isSymbolicLink() ||
  (emulatorRootStat.mode & 0o777) !== 0o700 ||
  !emulatorMarkerStat.isFile() ||
  emulatorMarkerStat.isSymbolicLink() ||
  (emulatorMarkerStat.mode & 0o777) !== 0o600 ||
  emulatorMarker.kind !== 'firestore-emulator' ||
  emulatorMarker.state !== 'ready' ||
  emulatorMarker.ownerNonce !== emulatorReceipt.ownerNonce ||
  emulatorMarker.host !== emulatorHost ||
  emulatorMarker.projectId !== 'demo-assistant-test' ||
  emulatorMarker.pid !== emulatorPid ||
  emulatorMarker.processArgsSha256 !== emulatorArgsSha256 ||
  emulatorMarker.startedUTC !== emulatorReceipt.startedUTC ||
  emulatorReceipt.processArgsSha256 !== emulatorArgsSha256 ||
  !emulatorArgsBindToHostPort(emulatorArgs, emulatorHost) ||
  !Number.isFinite(emulatorAgeMs) ||
  emulatorAgeMs < 0 ||
  emulatorAgeMs > 60 * 60 * 1000
)
  throw new Error('Firestore emulator process, marker, or freshness check did not match.');
const emulatorResponse = await fetch(`http://${emulatorHost}`, {
  signal: AbortSignal.timeout(5000),
});
if (!emulatorResponse.ok) throw new Error('The Firestore emulator is not ready.');
const installationNonce = randomUUID();
const portableInstallationId = `memory-witness-${installationNonce}`;
const claimNonce = installationNonce.replaceAll('-', '');

const handoffDirectory = await mkdtemp(join(tmpdir(), 'assistant-memory-witness-fs-compat-'));
const toolDirectory = join(handoffDirectory, 'bin');
const emptyHome = join(handoffDirectory, 'empty-home');
const pnpmShimPath = join(toolDirectory, 'pnpm');
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
try {
  await chmod(handoffDirectory, 0o700);
  await mkdir(toolDirectory, { mode: 0o700 });
  await mkdir(emptyHome, { mode: 0o700 });
  await chmod(toolDirectory, 0o700);
  await chmod(emptyHome, 0o700);
  await writeFile(
    pnpmShimPath,
    `#!/bin/sh\nexec ${shellQuote(node26Path)} ${shellQuote(pnpmCjsPath)} "$@"\n`,
    { flag: 'wx', mode: 0o700 },
  );
  await chmod(pnpmShimPath, 0o700);
} catch (error) {
  await rm(handoffDirectory, { recursive: true, force: true });
  throw error;
}
let admin: SqlClient;
try {
  admin = postgres(sourceDatabaseUrl, { max: 1, onnotice: () => {} });
} catch (error) {
  await rm(handoffDirectory, { recursive: true, force: false });
  throw error;
}
const handoffPath = join(handoffDirectory, 'postgres-export.bundle.json');
const handoffEnv = {
  ASSISTANT_MEMORY_WITNESS_COMPAT_BUNDLE_PATH: handoffPath,
  ASSISTANT_MEMORY_WITNESS_COMPAT_HANDOFF_DIR: handoffDirectory,
};
const testEnv: NodeJS.ProcessEnv = {
  ...isolatedTestEnvironment(process.env),
  ...handoffEnv,
  PATH: `${toolDirectory}:${dirname(node26Path)}:/opt/homebrew/bin:/usr/bin:/bin`,
  HOME: emptyHome,
  DATABASE_URL: target.databaseUrl,
  TEST_DATABASE_URL: target.databaseUrl,
  ASSISTANT_TEST_TARGET_TOKEN: target.token,
  ASSISTANT_TEST_TARGET_KIND: 'standard',
  ASSISTANT_MEMORY_WITNESS_COMPAT_INSTALLATION_ID: portableInstallationId,
  ASSISTANT_MEMORY_WITNESS_COMPAT_CLAIM_NONCE: claimNonce,
  FIRESTORE_EMULATOR_HOST: emulatorHost,
  GCLOUD_PROJECT: 'demo-assistant-test',
  NODE_OPTIONS: `--import=${new URL('./deny-test-egress.mjs', import.meta.url).href}`,
};

function runVitest(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveRun, rejectRun) => {
    let timedOut = false;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(
      runnerNodePath,
      [runnerPnpmCjsPath, 'exec', 'vitest', 'run', '--testTimeout=90000', ...args],
      {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    child.stdout.on('data', (chunk: Buffer) => {
      writeSync(logFD, chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      writeSync(logFD, chunk);
      process.stderr.write(chunk);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {}
      killTimeout = setTimeout(() => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {}
      }, 5000);
    }, 170_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      rejectRun(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolveRun(timedOut ? 124 : (code ?? 1));
    });
  });
}

async function assertHandoffFile(): Promise<string> {
  const directoryStat = await lstat(handoffDirectory);
  const fileStat = await lstat(handoffPath);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o777) !== 0o700 ||
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    (fileStat.mode & 0o777) !== 0o600 ||
    dirname(resolve(handoffPath)) !== resolve(handoffDirectory) ||
    fileStat.size === 0 ||
    fileStat.size > 8 * 1024 * 1024
  )
    throw new Error('Compatibility bundle handoff is not a bounded private regular file.');
  return createHash('sha256')
    .update(await readFile(handoffPath))
    .digest('hex');
}

async function persistReviewBundle(): Promise<{ sha256: string; byteLength: number }> {
  const directoryStat = await lstat(handoffDirectory);
  const sourceStat = await lstat(handoffPath);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o777) !== 0o700 ||
    !sourceStat.isFile() ||
    sourceStat.isSymbolicLink() ||
    (sourceStat.mode & 0o777) !== 0o600 ||
    dirname(resolve(handoffPath)) !== resolve(handoffDirectory) ||
    sourceStat.size === 0 ||
    sourceStat.size > 8 * 1024 * 1024
  )
    throw new Error('Refusing to retain an unbounded or non-private bundle handoff.');
  const bytes = await readFile(handoffPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedBundleSha256 && sha256 !== expectedBundleSha256)
    throw new Error('Bundle changed before private evidence retention.');
  const evidenceFile = await openFile(evidenceBundlePath, 'wx', 0o600);
  try {
    await evidenceFile.writeFile(bytes);
    await evidenceFile.chmod(0o600);
    await evidenceFile.sync();
  } finally {
    await evidenceFile.close();
  }
  const [retainedStat, retainedBytes] = await Promise.all([
    lstat(evidenceBundlePath),
    readFile(evidenceBundlePath),
  ]);
  if (
    !retainedStat.isFile() ||
    retainedStat.isSymbolicLink() ||
    (retainedStat.mode & 0o777) !== 0o600 ||
    retainedStat.size !== bytes.length ||
    !retainedBytes.equals(bytes) ||
    createHash('sha256').update(retainedBytes).digest('hex') !== sha256
  )
    throw new Error('Private evidence bundle failed exact-byte readback verification.');
  return { sha256, byteLength: bytes.length };
}

let primaryError: unknown;
let catalogBefore: string[] | undefined;
let serverIdentityBefore: unknown;
let sourceStatus: number | undefined;
let consumerStatus: number | undefined;
let expectedBundleSha256: string | undefined;
let bundleBytesSize: number | undefined;
const startedUTC = new Date().toISOString();
try {
  await access(markerPath).then(
    () => {
      throw new Error('Refusing a pre-existing allocator marker for the fresh test token.');
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    },
  );
  const [identity] = await admin`
    SELECT current_database() AS database,
      current_setting('data_directory') AS data_directory,
      inet_server_port() AS port
  `;
  if (
    identity?.database !== 'postgres' ||
    identity.data_directory !== parentData ||
    Number(identity.port) !== parentPort
  )
    throw new Error('Connected PostgreSQL identity does not match the owned parent receipt.');
  const [server] = await admin`SHOW server_version_num`;
  const serverVersion = Number(server?.server_version_num);
  if (serverVersion < 170000 || serverVersion >= 180000)
    throw new Error('Owned compatibility fixture requires PostgreSQL 17.');
  serverIdentityBefore = identity;
  catalogBefore = (await admin`SELECT datname FROM pg_database ORDER BY datname`).map(
    (row) => row.datname as string,
  );
  if (!catalogBefore) throw new Error('PostgreSQL catalog preflight did not complete.');
  if (catalogBefore.includes(target.databaseName))
    throw new Error('Refusing a pre-existing PostgreSQL target database.');

  sourceStatus = await runVitest(
    [
      'packages/db/src/migration-upgrade.test.ts',
      '-t',
      'populated 0134 memory through the standard 0135 migration and portable export',
    ],
    testEnv,
  );
  if (sourceStatus !== 0)
    throw new Error(`PostgreSQL export phase failed with status ${sourceStatus}.`);

  expectedBundleSha256 = await assertHandoffFile();
  bundleBytesSize = (await lstat(handoffPath)).size;
  consumerStatus = await runVitest(
    ['packages/firestore/src/memory-witness-compat.integration.test.ts'],
    { ...testEnv, ASSISTANT_MEMORY_WITNESS_COMPAT_BUNDLE_SHA256: expectedBundleSha256 },
  );
  if (consumerStatus !== 0)
    throw new Error(`Firestore import phase failed with status ${consumerStatus}.`);
  if ((await assertHandoffFile()) !== expectedBundleSha256)
    throw new Error('Portable PostgreSQL bundle bytes changed between export and import.');
  console.log(`Verified exact PostgreSQL export handoff SHA-256: ${expectedBundleSha256}`);
} catch (error) {
  primaryError = error;
}

const cleanupErrors: unknown[] = [];
let targetAbsent = false;
let catalogUnchanged = false;
let parentIdentityUnchanged = false;
let markerAbsent = false;
let emulatorLeaseUnchanged = false;
let preCleanupReceiptWritten = false;
let handoffDirectoryRemoved = false;
let reviewBundlePersisted = false;
let reviewBundleSha256: string | undefined;
let reviewBundleByteLength: number | undefined;
let logDurable = false;
try {
  const ownerAfter = JSON.parse(await readFile(ownerMarkerPath, 'utf8')) as Record<string, unknown>;
  const postmasterAfter = (await readFile(join(parentData, 'postmaster.pid'), 'utf8'))
    .split('\n')[0]
    ?.trim();
  const argsAfter = execFileSync('ps', ['-p', String(parentPid), '-o', 'args='], {
    encoding: 'utf8',
  }).trim();
  if (
    ownerAfter.ownerToken !== parentReceipt.ownerToken ||
    postmasterAfter !== String(parentPid) ||
    !argsAfter.includes(expectedPostgresCommand)
  )
    throw new Error('PostgreSQL parent process or owner receipt changed during the run.');
  const [remaining] = await admin`
    SELECT datname, shobj_description(oid, 'pg_database') AS marker
    FROM pg_database WHERE datname=${target.databaseName}
  `;
  targetAbsent = !remaining;
  if (remaining)
    cleanupErrors.push(new Error('Owned PostgreSQL target remains after compatibility run.'));
  const catalogAfter = (await admin`SELECT datname FROM pg_database ORDER BY datname`).map(
    (row) => row.datname as string,
  );
  catalogUnchanged =
    Boolean(catalogBefore) && JSON.stringify(catalogBefore) === JSON.stringify(catalogAfter);
  if (!catalogUnchanged)
    cleanupErrors.push(
      new Error('PostgreSQL database catalog changed outside the exact owned target.'),
    );
  const [identityAfter] = await admin`
    SELECT current_database() AS database,
      current_setting('data_directory') AS data_directory,
      inet_server_port() AS port
  `;
  parentIdentityUnchanged = JSON.stringify(serverIdentityBefore) === JSON.stringify(identityAfter);
  if (!parentIdentityUnchanged)
    cleanupErrors.push(new Error('PostgreSQL server identity changed during compatibility run.'));
} catch (error) {
  cleanupErrors.push(error);
}
try {
  await access(markerPath);
  cleanupErrors.push(
    new Error('Owned PostgreSQL allocator marker remains after compatibility run.'),
  );
} catch (error) {
  markerAbsent = (error as NodeJS.ErrnoException).code === 'ENOENT';
  if (!markerAbsent) cleanupErrors.push(error);
}
try {
  const markerStat = await lstat(emulatorMarkerPath);
  const marker = JSON.parse(await readFile(emulatorMarkerPath, 'utf8')) as Record<string, unknown>;
  const args = execFileSync('ps', ['-p', String(emulatorPid), '-o', 'args='], {
    encoding: 'utf8',
  }).trim();
  const argsHash = createHash('sha256').update(args).digest('hex');
  emulatorLeaseUnchanged =
    markerStat.isFile() &&
    !markerStat.isSymbolicLink() &&
    (markerStat.mode & 0o777) === 0o600 &&
    marker.ownerNonce === emulatorReceipt.ownerNonce &&
    marker.pid === emulatorPid &&
    marker.processArgsSha256 === argsHash &&
    argsHash === emulatorReceipt.processArgsSha256 &&
    emulatorArgsBindToHostPort(args, emulatorHost);
  if (!emulatorLeaseUnchanged)
    cleanupErrors.push(new Error('Owned Firestore emulator lease changed during the run.'));
} catch (error) {
  cleanupErrors.push(error);
}
try {
  await admin.end({ timeout: 5 });
} catch (error) {
  cleanupErrors.push(error);
}
try {
  fsyncSync(logFD);
  logDurable = true;
} catch (error) {
  cleanupErrors.push(error);
}
try {
  closeSync(logFD);
} catch (error) {
  cleanupErrors.push(error);
}
const logSha256 = await sha256File(logPath);
const preCleanupReceipt = {
  formatVersion: 1,
  startedUTC,
  capturedUTC: new Date().toISOString(),
  sourcePins,
  toolchain: {
    node26Sha256,
    pnpmCjsSha256,
    nodeVersion: 'v26.x validated before dispatch',
    pnpmVersion: '10.34.5',
  },
  postgres: {
    parentRoot,
    parentData,
    parentPort,
    parentPID: parentPid,
    parentOwnerTokenSha256: createHash('sha256')
      .update(parentReceipt.ownerToken as string)
      .digest('hex'),
    targetDatabaseName: target.databaseName,
    targetTokenSha256: createHash('sha256').update(target.token).digest('hex'),
    targetAbsent,
    markerAbsent,
    catalogUnchanged,
    parentIdentityUnchanged,
  },
  firestore: {
    host: emulatorHost,
    projectId: 'demo-assistant-test',
    ownerProcessPID: emulatorPid,
    processArgsSha256: emulatorReceipt.processArgsSha256,
    ownerNonceSha256: createHash('sha256')
      .update(emulatorReceipt.ownerNonce as string)
      .digest('hex'),
    leaseUnchanged: emulatorLeaseUnchanged,
    installationId: portableInstallationId,
    claimNonceSha256: createHash('sha256').update(claimNonce).digest('hex'),
    claimedRootAbsentAfterImport: consumerStatus === 0,
    clientClosed: consumerStatus === 0,
  },
  phases: {
    postgresExportStatus: sourceStatus ?? null,
    firestoreImportStatus: consumerStatus ?? null,
  },
  log: { sha256: logSha256, durableBeforeHandoffCleanup: logDurable },
  handoff: {
    sha256: expectedBundleSha256 ?? null,
    byteLength: bundleBytesSize ?? null,
    path: handoffPath,
    retainedThroughReceipt: true,
    reviewEvidencePath: evidenceBundlePath,
  },
  failureClass:
    primaryError instanceof Error ? primaryError.name : primaryError ? 'UnknownError' : null,
  cleanupFailureCount: cleanupErrors.length,
  limits:
    'Synthetic local PostgreSQL 17 to caller-owned Firestore emulator only; no activation, production, API writer, or complete migration claim.',
};
try {
  await writeDurableReceipt(preCleanupReceiptPath, preCleanupReceipt);
  preCleanupReceiptWritten = true;
} catch (error) {
  cleanupErrors.push(error);
}
try {
  if (preCleanupReceiptWritten && logDurable) {
    try {
      const handoffStat = await lstat(handoffPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && !expectedBundleSha256) return undefined;
        throw error;
      });
      if (handoffStat) {
        const retained = await persistReviewBundle();
        reviewBundlePersisted = true;
        reviewBundleSha256 = retained.sha256;
        reviewBundleByteLength = retained.byteLength;
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (preCleanupReceiptWritten && logDurable && (reviewBundlePersisted || !expectedBundleSha256)) {
    await rm(handoffDirectory, { recursive: true, force: false });
    handoffDirectoryRemoved = true;
  }
} catch (error) {
  cleanupErrors.push(error);
}

const resultReceipt = {
  ...preCleanupReceipt,
  completedUTC: new Date().toISOString(),
  handoff: {
    ...preCleanupReceipt.handoff,
    handoffDirectoryRemoved,
    reviewBundlePersisted,
    reviewBundleSha256: reviewBundleSha256 ?? null,
    reviewBundleByteLength: reviewBundleByteLength ?? null,
  },
  cleanupFailureCount: cleanupErrors.length,
  failureClass:
    primaryError instanceof Error ? primaryError.name : primaryError ? 'UnknownError' : null,
  logSha256,
};
try {
  await writeDurableReceipt(resultReceiptPath, resultReceipt);
} catch (error) {
  cleanupErrors.push(error);
}

if (primaryError && cleanupErrors.length)
  throw new AggregateError(
    [primaryError, ...cleanupErrors],
    'Compatibility fixture and cleanup failed.',
  );
if (primaryError) throw primaryError;
if (cleanupErrors.length)
  throw new AggregateError(cleanupErrors, 'Compatibility fixture cleanup failed.');
