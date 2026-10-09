import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { agents, createDb } from '@assistant/db';
import { afterEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

describe.skipIf(!databaseUrl)('PostgreSQL agent process without Firestore', () => {
  let child: ChildProcess | undefined;
  let output = '';
  let db: ReturnType<typeof createDb> | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        child?.once('exit', () => resolve());
        setTimeout(resolve, 3_000).unref();
      });
    }
    await db?.$client.end();
    db = undefined;
    child = undefined;
    output = '';
  });

  it('serves PostgreSQL readiness with an unreachable Firestore endpoint and no provider call', async () => {
    if (!databaseUrl) throw new Error('The isolated PostgreSQL test target is unavailable');
    db = createDb(databaseUrl, { max: 1 });
    const owners = await db.select({ id: agents.id }).from(agents).limit(2);
    expect(owners).toHaveLength(1);
    const workspaceId = 'assistant';

    const port = await unusedPort();
    const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
    child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        METADATA_SERVER_DETECTION: 'none',
        DATABASE_URL: databaseUrl,
        PERSISTENCE_DRIVER: 'postgres',
        // The reserved documentation-only address proves PG composition does
        // not try to initialize the other persistence adapter. If it does,
        // the shared test-only egress preloader will refuse the connection.
        FIRESTORE_EMULATOR_HOST: '198.51.100.17:8787',
        ASSISTANT_MODULES: 'minimal',
        ASSISTANT_WORKSPACE_ID: workspaceId,
        QUEUE_DRIVER: 'cloudtasks',
        CLOUD_TASKS_QUEUE: 'agent-steps',
        AGENT_URL: 'https://agent.example.test',
        PUBLIC_URL: 'https://agent.example.test',
        INTERNAL_AUTH_MODE: 'oidc',
        INTERNAL_OIDC_AUDIENCE: 'https://agent.example.test',
        INTERNAL_OIDC_SERVICE_ACCOUNT: 'invoker@demo-assistant-test.iam.gserviceaccount.com',
        LLM_PROVIDER: 'vertex',
        VERTEX_PROJECT: 'demo-assistant-test',
        VERTEX_LOCATION: 'us-central1',
        OPENROUTER_API_KEY: '',
        GOOGLE_APPLICATION_CREDENTIALS: '/no-such-test-credentials.json',
        GCP_PROJECT: 'demo-assistant-test',
        CANARY_ENABLED: 'false',
        LOCATION_PING_SECRET: '',
        OTEL_EXPORTER: 'none',
        AGENT_PORT: String(port),
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (data) => {
      output += String(data);
    });
    child.stderr?.on('data', (data) => {
      output += String(data);
    });

    let response: Response | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`agent exited before ready: ${output}`);
      response = await fetch(`http://127.0.0.1:${port}/ready`).catch(() => null);
      if (response) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(response?.status, output).toBe(200);
    expect(await response?.json()).toMatchObject({ ready: true, database: 'postgres' });
    expect(output).toContain('agent service listening');
    expect(output).not.toContain('198.51.100.17');
    expect(output).not.toContain('no-such-test-credentials.json');
  }, 25_000);
});
