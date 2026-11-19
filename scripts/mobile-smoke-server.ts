import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, cp, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext } from 'playwright';
import { allocateTestTarget } from './test-target.js';

export function mobileSmokeRequest(
  context: APIRequestContext,
  origin: string,
  serverRunning = () => true,
) {
  return (location: string, options?: Parameters<APIRequestContext['fetch']>[1]) => {
    const url = new URL(location, origin);
    if (url.origin !== origin) throw new Error('Mobile smoke request left its private origin.');
    if (!serverRunning()) throw new Error('The owned mobile smoke server has stopped.');
    return context.fetch(url.href, { ...options, maxRedirects: 0 });
  };
}

async function reservePort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not reserve mobile smoke port.');
  listener.close();
  await once(listener, 'close');
  return address.port;
}

async function databaseCommand(command: string, env: NodeJS.ProcessEnv) {
  const child = spawn('pnpm', ['--filter', '@assistant/db', command], { env, stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`Mobile smoke ${command} failed.`);
}

export async function withMobileSmokeServer(
  run: (origin: string, serverRunning: () => boolean) => Promise<void>,
) {
  if (process.env.SMOKE_BASE_URL !== undefined)
    throw new Error(
      'SMOKE_BASE_URL is unsupported. Mobile smoke launches its own disposable server.',
    );
  const root = fileURLToPath(new URL('../', import.meta.url));
  const web = path.join(root, 'apps/web');
  const app = path.join(web, '.next/standalone/apps/web');
  const entry = path.join(app, 'server.js');
  await access(entry).catch(() => {
    throw new Error('Build the standalone web app before running mobile smoke (pnpm build).');
  });
  const source =
    process.env.TEST_DATABASE_URL ?? 'postgres://assistant:assistant@127.0.0.1:55432/assistant';
  try {
    const database = new URL(source);
    if (
      !['127.0.0.1', '[::1]'].includes(database.hostname) ||
      !database.port ||
      database.search ||
      database.hash
    )
      throw new Error('Unsupported database location.');
  } catch {
    throw new Error(
      'Mobile smoke requires TEST_DATABASE_URL to be a literal loopback PostgreSQL URL with a port and no connection overrides.',
    );
  }
  const target = allocateTestTarget(source);
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const scratch = await mkdtemp(path.join(tmpdir(), 'assistant-mobile-smoke-'));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ASSISTANT_REPO_ROOT: scratch,
    ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS: '1',
    ASSISTANT_TEST_TARGET_KIND: target.kind,
    ASSISTANT_TEST_TARGET_TOKEN: target.token,
    DATABASE_URL: target.databaseUrl,
    TEST_DATABASE_URL: target.databaseUrl,
    PERSISTENCE_DRIVER: 'postgres',
    QUEUE_DRIVER: 'local',
    AUTH_LOCALHOST_BYPASS: 'true',
    AUTH_URL: origin,
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    NEXT_TELEMETRY_DISABLED: '1',
  };
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  try {
    await cp(path.join(web, '.next/static'), path.join(app, '.next/static'), { recursive: true });
    await cp(path.join(web, 'public'), path.join(app, 'public'), { recursive: true });
    await databaseCommand('test:prepare', env);
    child = spawn(
      process.execPath,
      [`--import=${new URL('./deny-test-egress.mjs', import.meta.url).href}`, entry],
      { env, cwd: scratch, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let output = '';
    let launchError: Error | undefined;
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      output = (output + chunk.toString()).slice(-4096);
    });
    exited = new Promise<void>((resolve) => {
      child?.once('error', (error) => {
        launchError = error;
        resolve();
      });
      child?.once('exit', () => resolve());
    });
    const serverRunning = () =>
      !launchError && child?.exitCode === null && child.signalCode === null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (!serverRunning())
        throw new Error('The owned standalone mobile smoke server could not start.');
      // Next prints this address only after its own HTTP listener has bound.
      if (output.includes(`Local:         ${origin}`)) {
        const health = await fetch(`${origin}/api/health`, {
          redirect: 'error',
          signal: AbortSignal.timeout(1_000),
        }).catch(() => null);
        if (health?.ok) {
          await run(origin, serverRunning);
          return;
        }
      }
      await setTimeout(200);
    }
    throw new Error('The owned standalone mobile smoke server did not become healthy.');
  } finally {
    child?.kill('SIGTERM');
    await exited;
    try {
      await databaseCommand('test:cleanup', { ...env, ASSISTANT_TEST_CLEANUP: '1' });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
