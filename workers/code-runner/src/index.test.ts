import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run, runProcess } from './index.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-runner-process-'));
  roots.push(root);
  return root;
}

async function testSandbox(root: string): Promise<string> {
  const binary = path.join(root, 'sandbox-test-fixture');
  await writeFile(
    binary,
    `#!${process.execPath}\nconst { spawnSync } = require('node:child_process');\nconst args = process.argv.slice(2);\nconst separator = args.indexOf('--');\nif (args[0] !== 'do' || separator < 0) process.exit(97);\nconst result = spawnSync(args[separator + 1], args.slice(separator + 2), { cwd: process.cwd(), stdio: 'inherit', env: process.env });\nprocess.exit(result.status ?? 98);\n`,
  );
  await chmod(binary, 0o700);
  return binary;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('isolated child process lifetime and captured output', () => {
  it('fails closed before execution when the Cloud Run sandbox launcher is absent', async () => {
    const root = await tempRoot();
    await expect(
      run(
        {
          taskId: '00000000-0000-4000-8000-000000000099',
          callbackToken: 'fixture',
          callbackUrl: 'https://example.invalid/callback',
          storage: { driver: 'local', root },
          spec: {
            goal: 'must not run unsandboxed',
            language: 'javascript',
            allowNetwork: false,
            timeoutSeconds: 5,
            source: "require('node:fs').writeFileSync('/tmp/code-runner-unsandboxed', 'bad')",
          },
        },
        undefined,
        { sandboxBinary: path.join(root, 'missing-sandbox') },
      ),
    ).rejects.toThrow(/sandbox launcher is required/);
  });

  it('rejects network-enabled code until an explicit destination policy exists', async () => {
    const root = await tempRoot();
    await expect(
      run(
        {
          taskId: '00000000-0000-4000-8000-000000000098',
          callbackToken: 'fixture',
          callbackUrl: 'https://example.invalid/callback',
          storage: { driver: 'local', root },
          spec: {
            goal: 'no arbitrary network',
            language: 'javascript',
            allowNetwork: true,
            timeoutSeconds: 5,
            source: 'process.exit(0)',
          },
        },
        undefined,
        { sandboxBinary: path.join(root, 'missing-sandbox') },
      ),
    ).rejects.toThrow(/destination allowlist/);
  });

  it('retains bounded large captured logs as immutable artifacts with explicit loss metadata', async () => {
    const root = await tempRoot();
    const sandboxBinary = await testSandbox(root);
    const result = await run(
      {
        taskId: '00000000-0000-4000-8000-000000000001',
        callbackToken: 'fixture',
        callbackUrl: 'https://example.invalid/callback',
        storage: { driver: 'local', root },
        spec: {
          goal: 'capture',
          language: 'javascript',
          allowNetwork: false,
          timeoutSeconds: 5,
          source:
            "process.stdout.write('x'.repeat(300000)); process.stderr.write('y'.repeat(300000));",
        },
      },
      undefined,
      { sandboxBinary },
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    const logs = result.logs as Record<
      string,
      { path: string; capturedBytes: number; captureTruncated: boolean }
    >;
    for (const stream of ['stdout', 'stderr']) {
      const log = logs[stream];
      if (!log) throw new Error('missing log');
      expect(log.path).toMatch(/\/logs\/(stdout|stderr)-[0-9a-f]{64}\.txt$/);
      expect(log.capturedBytes).toBe(256 * 1024);
      expect(log.captureTruncated).toBe(true);
      expect((await readFile(path.join(root, log.path))).length).toBe(log.capturedBytes);
    }
  });
  it('keeps same-named outputs from distinct runs and verifies replay hashes', async () => {
    const root = await tempRoot();
    const sandboxBinary = await testSandbox(root);
    const execute = (token: string, value: string) =>
      run(
        {
          taskId: '00000000-0000-4000-8000-000000000002',
          callbackToken: token,
          callbackUrl: 'https://example.invalid/callback',
          storage: { driver: 'local', root },
          spec: {
            goal: 'output identity',
            language: 'javascript',
            allowNetwork: false,
            timeoutSeconds: 5,
            source: `import { writeFileSync } from 'node:fs'; writeFileSync('output/result.txt', ${JSON.stringify(value)});`,
          },
        },
        undefined,
        { sandboxBinary },
      );
    const first = await execute('first-run', 'first');
    const second = await execute('second-run', 'second');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.outputs[0]).not.toBe(second.outputs[0]);
    expect(await readFile(path.join(root, first.outputs[0] ?? ''), 'utf8')).toBe('first');
    expect(await readFile(path.join(root, second.outputs[0] ?? ''), 'utf8')).toBe('second');
    const replay = await execute('second-run', 'second');
    expect(replay.outputs).toEqual(second.outputs);
    expect(replay.outputReceipts).toEqual(second.outputReceipts);
    const receipt = (
      first.outputReceipts as Array<{ path: string; bytes: number; sha256: string }>
    )[0];
    expect(receipt).toMatchObject({
      path: first.outputs[0],
      bytes: 5,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it('kills same-process-group descendants when the time limit expires', async () => {
    const cwd = await tempRoot();
    const pidFile = path.join(cwd, 'grandchild.pid');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n');

    const outcome = await runProcess(process.execPath, ['-e', script], { cwd, timeoutMs: 300 });
    expect(outcome.timedOut).toBe(true);
    const childPid = Number(await readFile(pidFile, 'utf8'));
    expect(await waitForProcessExit(childPid)).toBe(true);
  });

  it('kills the full child process group when the parent signal aborts', async () => {
    const cwd = await tempRoot();
    const pidFile = path.join(cwd, 'grandchild.pid');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const controller = new AbortController();
    const running = runProcess(process.execPath, ['-e', script], {
      cwd,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    while (!(await readFile(pidFile, 'utf8').catch(() => ''))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const childPid = Number(await readFile(pidFile, 'utf8'));
    controller.abort();
    const outcome = await running;
    expect(outcome.cancelled).toBe(true);
    expect(await waitForProcessExit(childPid)).toBe(true);
  });

  it('caps captured stdout and stderr by bytes', async () => {
    const cwd = await tempRoot();
    const source =
      "process.stdout.write('é'.repeat(400000)); process.stderr.write('x'.repeat(400000));";
    const outcome = await runProcess(process.execPath, ['-e', source], { cwd, timeoutMs: 5_000 });
    expect(outcome.exitCode).toBe(0);
    expect(Buffer.byteLength(outcome.stdout, 'utf8')).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(outcome.stderr, 'utf8')).toBeLessThanOrEqual(256 * 1024);
  });
});
