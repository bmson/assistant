import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInstallationStore, FirestoreTaskRepository } from '@assistant/firestore';
import { afterEach, describe, expect, it } from 'vitest';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore agent process without PostgreSQL', () => {
  const installationId = `agent-boot-${randomUUID()}`;
  const agentId = randomUUID();
  const store = createInstallationStore({
    projectId: 'demo-assistant-test',
    installationId,
  });
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

  it('boots, reports Firestore readiness, and executes a queued task with PostgreSQL offline', async () => {
    const tasks = new FirestoreTaskRepository(store);
    const task = await tasks.createTask({
      agentId,
      type: 'adhoc',
      trust: 'assistant',
      trigger: { source: 'internal', payload: { kind: 'application_confirmation' } },
    });
    const foreignAgentId = randomUUID();
    const foreign = await Promise.all(
      Array.from({ length: 4 }, () =>
        tasks.createTask({
          agentId: foreignAgentId,
          type: 'adhoc',
          trust: 'assistant',
          trigger: { source: 'internal', payload: { kind: 'application_confirmation' } },
        }),
      ),
    );
    const foreignRunning = foreign[0];
    if (!foreignRunning) throw new Error('Missing foreign task fixture');
    for (const [index, row] of foreign.entries()) {
      await store.doc('tasks', row.task.id).update({
        updatedAt: new Date(0),
        ...(index === 0 ? { status: 'running', lockedUntil: new Date(0) } : {}),
      });
    }
    let port: number | undefined;
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
        QUEUE_DRIVER: 'local',
        CANARY_ENABLED: 'false',
        LOCATION_PING_SECRET: '',
        AGENT_PORT: '8787',
        // The child binds a kernel-assigned port atomically. Randomly picking
        // an ephemeral port can collide with the emulator's active clients.
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (data) => {
      output += String(data);
      const match = /^agent service listening on :([1-9]\d{0,4})$/m.exec(output);
      if (match && Number(match[1]) <= 65535) port = Number(match[1]);
    });
    child.stderr?.on('data', (data) => {
      output += String(data);
    });

    let unavailable: Response | null = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`agent exited before ready: ${output}`);
      const response = port
        ? await fetch(`http://127.0.0.1:${port}/ready`).catch(() => null)
        : null;
      if (response) {
        unavailable = response;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(port, output).toBeGreaterThan(0);
    expect(unavailable?.status).toBe(503);
    // The local poller has ticked, but must not claim or reclaim while /ready is 503.
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect((await tasks.getTask(task.task.id))?.status).toBe('pending');
    expect((await tasks.getTask(foreignRunning.task.id))?.status).toBe('running');
    await store.doc('agents', agentId).set({ id: agentId, name: 'Test owner' });
    const readyResponse = await fetch(`http://127.0.0.1:${port}/ready`);
    const ready: unknown = await readyResponse.json();
    expect(ready).toMatchObject({ ready: true, database: 'firestore' });

    let status: string | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      status = (await tasks.getTask(task.task.id))?.status;
      if (status === 'cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(status, output).toBe('cancelled');
    expect((await tasks.getTask(foreignRunning.task.id))?.status).toBe('running');
    for (const row of foreign.slice(1)) {
      expect((await tasks.getTask(row.task.id))?.status).toBe('pending');
    }
    expect(output).toContain('local queue poller started');
    expect(output).not.toContain('PostgreSQL access is unavailable');
  }, 25_000);
});
