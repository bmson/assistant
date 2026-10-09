import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedArtifactPath, immutableArtifactPath } from '@assistant/persistence/artifact-path';
import { callbackEnvelope } from './callback-envelope.js';
import { CODE_INPUT_PREFIXES, type JobInput, parseJobInput } from './input.js';
import { readBoundedRegularFile, readBoundedResponse } from './safe-file.js';
import { CLOUD_RUN_SANDBOX, sandboxInvocation } from './sandbox.js';
import { type BlobStore, buildWorkspace } from './storage.js';

/**
 * The Workspace code-execution job (Phase 13). The supervisor retrieves inputs
 * and owns storage/callback credentials; untrusted source runs only through
 * Cloud Run's sandbox launcher, with read-only source/input and writable
 * output mounts.
 * Missing sandbox support fails closed. Always exits 0 — failure is a callback
 * payload, not a job retry (the executor's timeout backstop covers total loss).
 */

interface JobResult {
  ok: boolean;
  goal: string;
  language: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputs: string[];
  timedOut?: boolean;
  cancelled?: boolean;
  error?: string;
  [key: string]: unknown;
}

const MAX_STREAM_BYTES = 256 * 1024; // per stream (stdout / stderr)
const MAX_OUTPUT_FILES = 50;
const MAX_OUTPUT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_STAGED_INPUT_BYTES = 50 * 1024 * 1024;

interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Run one script file to completion, bounded in time and captured output. */
export function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      // MPLCONFIGDIR keeps matplotlib's cache inside the writable temp dir.
      env: { PATH: process.env.PATH, HOME: opts.cwd, TMPDIR: opts.cwd, MPLCONFIGDIR: opts.cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTotalBytes = 0;
    let stderrTotalBytes = 0;
    let timedOut = false;
    let cancelled = false;
    const append = (chunks: Buffer[], current: number, chunk: Buffer) => {
      const remaining = MAX_STREAM_BYTES - current;
      if (remaining <= 0) return current;
      const captured = Buffer.from(chunk.subarray(0, remaining));
      chunks.push(captured);
      return current + captured.length;
    };
    const text = (chunks: Buffer[]) => {
      let value = Buffer.concat(
        chunks,
        chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      ).toString('utf8');
      // Dropping a partial trailing UTF-8 replacement keeps the reported text
      // within the byte cap as well as the captured buffer.
      while (Buffer.byteLength(value, 'utf8') > MAX_STREAM_BYTES) value = value.slice(0, -1);
      return value;
    };
    const killTree = () => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        child.kill('SIGKILL');
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', (c: Buffer) => {
      stdoutTotalBytes += c.length;
      stdoutBytes = append(stdoutChunks, stdoutBytes, c);
    });
    child.stderr.on('data', (c: Buffer) => {
      stderrTotalBytes += c.length;
      stderrBytes = append(stderrChunks, stderrBytes, c);
    });
    const killer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);
    const abort = () => {
      cancelled = true;
      killTree();
    };
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (err) => {
      clearTimeout(killer);
      opts.signal?.removeEventListener('abort', abort);
      resolve({
        exitCode: null,
        stdout: text(stdoutChunks),
        stderr: text(stderrChunks) || String(err).slice(0, MAX_STREAM_BYTES),
        timedOut,
        cancelled,
        stdoutTruncated: stdoutTotalBytes > stdoutBytes,
        stderrTruncated: stderrTotalBytes > stderrBytes,
      });
    });
    child.once('close', (code) => {
      clearTimeout(killer);
      opts.signal?.removeEventListener('abort', abort);
      // A script can leave same-process-group descendants behind and exit.
      // Reap those too before the temporary directory is removed.
      killTree();
      resolve({
        exitCode: code,
        stdout: text(stdoutChunks),
        stderr: text(stderrChunks),
        timedOut,
        cancelled,
        stdoutTruncated: stdoutTotalBytes > stdoutBytes,
        stderrTruncated: stderrTotalBytes > stderrBytes,
      });
    });
  });
}

/** Recursively list files under a dir, relative to it, capped. */
async function listFiles(
  dir: string,
  base = dir,
  depth = 0,
  signal?: AbortSignal,
): Promise<string[]> {
  const out: string[] = [];
  if (depth > 8 || signal?.aborted) return out;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= MAX_OUTPUT_FILES) break;
    if (signal?.aborted) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base, depth + 1, signal)));
    else if (entry.isFile()) {
      const relative = path.relative(base, full);
      if (relative.length <= 512) out.push(relative);
    }
  }
  return out.slice(0, MAX_OUTPUT_FILES);
}

export async function run(
  input: JobInput,
  signal?: AbortSignal,
  options: { sandboxBinary?: string } = {},
): Promise<JobResult> {
  // The sandbox supports deny-all egress and an explicit unrestricted egress
  // switch, but this product contract has no destination allowlist yet. Do not
  // turn a boolean into arbitrary Internet access.
  if (input.spec.allowNetwork)
    throw new Error('network-enabled code runs require a configured destination allowlist');
  const sandboxBinary = options.sandboxBinary ?? CLOUD_RUN_SANDBOX;
  await access(sandboxBinary, constants.X_OK).catch(() => {
    throw new Error(
      'isolated code execution is unavailable; the Cloud Run sandbox launcher is required',
    );
  });

  const workspace: BlobStore = buildWorkspace(input.storage);
  const work = await mkdtemp(path.join(os.tmpdir(), 'code-job-'));
  const outputDir = path.join(work, 'output');
  const inputDir = path.join(work, 'input');
  const sourceDir = path.join(work, 'source');
  try {
    await mkdir(outputDir, { recursive: true });
    await mkdir(inputDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    // Stage Workspace inputs into ./input/<as> before the script runs, so a
    // script can read a CSV/doc the model already has (drive.download, an
    // ingested document, a prior code output). Paths are prefix-allowlisted and
    // `as` is a bare filename — neither can escape the input dir.
    if (input.spec.inputs?.length) {
      let stagedBytes = 0;
      for (const { workspacePath, as } of input.spec.inputs) {
        if (signal?.aborted) throw signal.reason ?? new Error('code job cancelled');
        const rel = allowedArtifactPath(workspacePath, CODE_INPUT_PREFIXES);
        if (!/^[\w.-]+$/.test(as)) throw new Error(`unsafe input filename: ${as}`);
        const bytes = await workspace.get(rel, signal);
        stagedBytes += bytes.length;
        if (stagedBytes > MAX_STAGED_INPUT_BYTES)
          throw new Error(`staged inputs exceed ${MAX_STAGED_INPUT_BYTES} bytes`);
        await writeFile(path.join(inputDir, as), bytes);
      }
    }

    const isPython = input.spec.language === 'python';
    const scriptFile = path.join(sourceDir, isPython ? 'script.py' : 'script.mjs');
    await writeFile(scriptFile, input.spec.source, 'utf8');

    const invocation = sandboxInvocation({
      sandboxBinary,
      workDir: work,
      inputDir,
      sourceDir,
      outputDir,
      scriptFile,
      language: isPython ? 'python' : 'javascript',
    });
    const outcome = await runProcess(invocation.command, invocation.args, {
      cwd: work,
      timeoutMs: input.spec.timeoutSeconds * 1000,
      signal,
    });

    // Upload whatever the script wrote to ./output into the Workspace.
    const outputs: string[] = [];
    const executionId = createHash('sha256')
      .update(JSON.stringify([input.taskId, input.callbackToken]))
      .digest('hex');
    const outputReceipts: Array<{
      path: string;
      sha256: string;
      bytes: number;
      executionId: string;
      name: string;
    }> = [];
    for (const rel of await listFiles(outputDir, outputDir, 0, signal)) {
      if (signal?.aborted) break;
      const bytes = await readBoundedRegularFile(
        outputDir,
        rel,
        MAX_OUTPUT_FILE_BYTES,
        signal,
      ).catch(() => null);
      if (!bytes || bytes.length === 0) continue;
      const safe = rel.replaceAll('\\', '/').replace(/^\/+/, '');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const workspacePath = immutableArtifactPath(
        `code/${input.taskId}/runs/`,
        executionId,
        digest,
        safe,
      );
      await workspace.put(workspacePath, bytes, 'application/octet-stream', signal);
      outputs.push(workspacePath);
      outputReceipts.push({
        path: workspacePath,
        sha256: digest,
        bytes: bytes.length,
        executionId,
        name: safe,
      });
    }

    // Captured logs are bounded even when a script writes indefinitely. Use
    // content-addressed artifacts so another job cannot overwrite this evidence.
    const logs: Record<
      string,
      { path?: string; capturedBytes: number; captureTruncated: boolean; storageFailed?: boolean }
    > = {};
    if (
      Buffer.byteLength(JSON.stringify([outcome.stdout, outcome.stderr]), 'utf8') > 128 * 1024 ||
      outcome.stdoutTruncated ||
      outcome.stderrTruncated
    ) {
      for (const stream of ['stdout', 'stderr'] as const) {
        const bytes = Buffer.from(outcome[stream], 'utf8');
        const digest = createHash('sha256').update(bytes).digest('hex');
        const logPath = `code/${input.taskId}/logs/${stream}-${digest}.txt`;
        const captured = {
          capturedBytes: bytes.length,
          captureTruncated: outcome[`${stream}Truncated`],
        };
        try {
          await workspace.put(logPath, bytes, 'text/plain; charset=utf-8', signal);
          logs[stream] = { ...captured, path: logPath };
        } catch {
          logs[stream] = { ...captured, storageFailed: true };
        }
      }
    }
    return {
      logs,
      ok: outcome.exitCode === 0 && !outcome.timedOut && !outcome.cancelled,
      goal: input.spec.goal,
      language: input.spec.language,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      outputs,
      outputReceipts,
      ...(outcome.timedOut ? { timedOut: true, error: 'the script exceeded its time limit' } : {}),
      ...(outcome.cancelled ? { cancelled: true, error: 'the script was cancelled' } : {}),
      ...(outcome.exitCode !== 0 && !outcome.timedOut && !outcome.cancelled
        ? { error: `the script exited with code ${outcome.exitCode}` }
        : {}),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function postCallback(input: JobInput, result: JobResult): Promise<void> {
  const body = callbackEnvelope(input.taskId, input.callbackToken, result);
  const delaysMs = result.cancelled ? [0] : [0, 2_000, 5_000, 15_000];
  for (const [attempt, delay] of delaysMs.entries()) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(input.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return;
      if (res.status !== 409 && res.status < 500) {
        const detail = await readBoundedResponse(res, 2_048)
          .then((body) => body.toString('utf8'))
          .catch(() => 'response body omitted');
        console.error(`callback rejected: ${res.status} ${detail}`);
        return;
      }
      console.error(`callback attempt ${attempt + 1} got ${res.status} — retrying`);
    } catch (err) {
      console.error(`callback attempt ${attempt + 1} failed: ${err}`);
    }
  }
  console.error('callback exhausted retries — the task will settle via its timeout backstop');
}

async function main(): Promise<void> {
  let input: JobInput;
  try {
    input = parseJobInput(process.env.CODE_JOB_INPUT);
  } catch (err) {
    console.error('invalid job input:', err);
    return;
  }

  const controller = new AbortController();
  const abort = () => controller.abort(new Error('code job received a termination signal'));
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const started = Date.now();
  const result = await run(input, controller.signal).catch(
    (err): JobResult => ({
      ok: false,
      goal: input.spec?.goal ?? '',
      language: input.spec?.language ?? '',
      exitCode: null,
      stdout: '',
      stderr: '',
      outputs: [],
      error: String(err).slice(0, 1000),
      ...(controller.signal.aborted ? { cancelled: true } : {}),
    }),
  );
  process.off('SIGTERM', abort);
  process.off('SIGINT', abort);
  result.durationMs = Date.now() - started;
  console.log(
    JSON.stringify({
      msg: 'code job finished',
      taskId: input.taskId,
      ok: result.ok,
      durationMs: result.durationMs,
    }),
  );
  await postCallback(input, result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
  process.exit(0);
}
