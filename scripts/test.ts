import { spawn } from 'node:child_process';
import { allocateTestTarget, isolatedTestEnvironment } from './test-target.js';

function run(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    const forwardSignal = (signal: NodeJS.Signals) => {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    };
    process.on('SIGINT', forwardSignal);
    process.on('SIGTERM', forwardSignal);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
      resolve(code ?? (signal ? 1 : 1));
    });
  });
}

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run tests with NODE_ENV=production.');
}

const sourceUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const args = process.argv.slice(2);
const snapshotPairIndex = args.indexOf('--restore-snapshot-target');
const restoreTargetIndex = args.indexOf('--restore-target');
if (snapshotPairIndex >= 0 && restoreTargetIndex >= 0)
  throw new Error('Choose only one restore test-target mode.');
if (snapshotPairIndex >= 0) args.splice(snapshotPairIndex, 1);
if (restoreTargetIndex >= 0) args.splice(restoreTargetIndex, 1);
const targetKind = restoreTargetIndex >= 0 || snapshotPairIndex >= 0 ? 'restore' : 'standard';
const target = allocateTestTarget(sourceUrl, undefined, targetKind);
const restoreTarget =
  snapshotPairIndex >= 0 ? allocateTestTarget(sourceUrl, undefined, 'restore') : undefined;
if (restoreTarget && restoreTarget.databaseName === target.databaseName)
  throw new Error('Restore source and target allocation collided.');
const vitestArgs = args;
if (vitestArgs[0] === '--') {
  vitestArgs.shift();
}

const testEnv: NodeJS.ProcessEnv = {
  ...isolatedTestEnvironment(process.env),
  DATABASE_URL: target.databaseUrl,
  TEST_DATABASE_URL: target.databaseUrl,
  ASSISTANT_TEST_TARGET_TOKEN: target.token,
  ASSISTANT_TEST_TARGET_KIND: target.kind,
  NODE_OPTIONS: [
    process.env.NODE_OPTIONS,
    `--import=${new URL('./deny-test-egress.mjs', import.meta.url).href}`,
  ]
    .filter(Boolean)
    .join(' '),
};
// A caller's stale pair variables must never cause ordinary runs to prepare or
// remove an unrelated restore target.
delete testEnv.ASSISTANT_RESTORE_TARGET_DATABASE_URL;
delete testEnv.ASSISTANT_RESTORE_TARGET_TOKEN;
if (restoreTarget) {
  testEnv.ASSISTANT_RESTORE_TARGET_DATABASE_URL = restoreTarget.databaseUrl;
  testEnv.ASSISTANT_RESTORE_TARGET_TOKEN = restoreTarget.token;
}
const cleanupEnv = { ...testEnv, ASSISTANT_TEST_CLEANUP: '1' };
let status = 1;
try {
  status = await run(['--filter', '@assistant/db', 'test:prepare'], testEnv);
  if (status === 0) status = await run(['exec', 'vitest', 'run', ...vitestArgs], testEnv);
} finally {
  try {
    const cleanup = await run(['--filter', '@assistant/db', 'test:cleanup'], cleanupEnv);
    if (cleanup !== 0 && status === 0) status = cleanup;
  } catch (error) {
    console.error(
      `Test database cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    if (status === 0) status = 1;
  }
}
process.exitCode = status;
