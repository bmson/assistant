import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInstallationStore, FirestoreTaskRepository } from '@assistant/firestore';
import { afterEach, describe, expect, it } from 'vitest';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore agent process in Cloud Tasks mode', () => {
  const installationId = `agent-boot-ct-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let child: ChildProcess | undefined;
  let output = '';

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        child?.once('exit', () => resolve());
        setTimeout(resolve, 3000).unref();
      });
    }
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
  });

  it('boots with PostgreSQL offline, starts no local dispatcher, and guards task delivery', async () => {
    await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
    const tasks = new FirestoreTaskRepository(store);
    const { task } = await tasks.createTask({
      agentId,
      type: 'adhoc',
      trust: 'assistant',
      trigger: { source: 'internal', payload: { kind: 'application_confirmation' } },
    });
    const port = 20000 + Math.floor(Math.random() * 30000);
    const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
    child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        METADATA_SERVER_DETECTION: 'none',
        DATABASE_URL: 'postgres://assistant:assistant@127.0.0.1:1/offline',
        PERSISTENCE_DRIVER: 'firestore',
        ASSISTANT_MODULES: 'minimal',
        ASSISTANT_WORKSPACE_ID: installationId,
        FIRESTORE_AGENT_ID: agentId,
        FIRESTORE_EMBEDDING_SPACE:
          '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
        GCP_PROJECT: 'demo-assistant-test',
        GCP_LOCATION: 'us-west1',
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
        CANARY_ENABLED: 'false',
        LOCATION_PING_SECRET: '',
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

    let ready: Response | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`agent exited before ready: ${output}`);
      ready = await fetch(`http://127.0.0.1:${port}/ready`).catch(() => null);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(ready?.status, output).toBe(200);
    expect(await ready?.json()).toMatchObject({ ready: true, database: 'firestore' });

    // Cloud Tasks deliveries must carry a Google-signed token for this agent.
    const unsigned = await fetch(`http://127.0.0.1:${port}/internal/tasks/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: task.id, generation: 0 }),
    });
    expect(unsigned.status).toBe(401);

    // No local poller: nothing claims the task without a Cloud Tasks delivery.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await tasks.getTask(task.id))?.status).toBe('pending');
    expect(output).not.toContain('local queue poller started');
    expect(output).not.toContain('PostgreSQL access is unavailable');
  }, 30_000);
});
