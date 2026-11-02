/** Read-only operator-owned workflow hold verification. Every missing or partial read is a HOLD. */
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const API = 'https://api.github.com/repos/bmson/assistant';
const ACTIVE = ['queued', 'in_progress', 'waiting', 'requested', 'pending'] as const;
const WRITER_WORKFLOWS = [
  'deploy.yml',
  'cleanup.yml',
  'owner-web-tag-retirement.yml',
  'owner-web-traffic-reconciliation.yml',
  'prepare-owner-editor-index.yml',
  'owner-editor-v1-maintenance.yml',
  'workspace-import.yml',
] as const;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 10_000;
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Operator hold unavailable');
  return value as Json;
}
export type HoldFetch = (url: string, token: string) => Promise<unknown>;
export type HoldIdentity = { source: string; runId: string; attempt: string };

export async function boundedResponseJson(
  response: Response,
  maxBytes = RESPONSE_MAX_BYTES,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('Operator hold unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Operator hold unavailable');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new Error('Operator hold unavailable'));
    }, timeoutMs);
  });
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > maxBytes) {
          void reader.cancel().catch(() => undefined);
          throw new Error('Operator hold unavailable');
        }
        chunks.push(result.value);
      }
      const bytes = Buffer.concat(chunks, size);
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      await reader.cancel().catch(() => undefined);
      throw new Error('Operator hold unavailable');
    }
  };
  try {
    return await Promise.race([read(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function saveImmutable(path: string, value: unknown) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dir = openSync(dirname(path), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/**
 * Captures the pre-operator states once, waits for the manager's manual holds,
 * then verifies them and the complete active-run/job census before each phase.
 */
export async function verifyOperatorOwnedHold(
  identity: HoldIdentity,
  env: NodeJS.ProcessEnv = process.env,
  request: HoldFetch = async (url, token) => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS),
    });
    return boundedResponseJson(response);
  },
  waitForManualDisable = false,
) {
  if (
    env.GITHUB_REPOSITORY !== 'bmson/assistant' ||
    env.GITHUB_WORKFLOW_REF !== 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main' ||
    env.GITHUB_WORKFLOW_SHA !== identity.source ||
    env.GITHUB_SHA !== identity.source ||
    env.GITHUB_RUN_ID !== identity.runId ||
    env.GITHUB_RUN_ATTEMPT !== identity.attempt ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.CURRENT_ONLY_CLEANUP !== 'false' ||
    !env.GITHUB_JOB ||
    !env.GITHUB_EVENT_NAME ||
    !env.RUNNER_TEMP
  )
    throw new Error('Operator hold identity mismatch');
  const tokenPath = resolve(env.RUNNER_TEMP, 'owner-web-tag-github-token');
  const tokenStat = lstatSync(tokenPath);
  if (
    !tokenStat.isFile() ||
    tokenStat.isSymbolicLink() ||
    tokenStat.size < 1 ||
    tokenStat.size > 16384 ||
    (tokenStat.mode & 0o077) !== 0
  )
    throw new Error('Operator hold unavailable');
  const token = readFileSync(tokenPath, 'utf8');
  if (!/^[A-Za-z0-9._~-]{1,16384}$/.test(token)) throw new Error('Operator hold unavailable');
  const get = async (path: string) => object(await request(`${API}${path}`, token));
  const holdPath = resolve(
    env.RUNNER_TEMP,
    `owner-web-release-hold-${identity.runId}-${identity.attempt}.json`,
  );
  let deploy: Json, cleanup: Json, workspaceImport: Json;
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    deploy = await get('/actions/workflows/deploy.yml');
    cleanup = await get('/actions/workflows/cleanup.yml');
    workspaceImport = await get('/actions/workflows/workspace-import.yml');
    if (
      !/^[1-9][0-9]{0,19}$/.test(String(deploy.id)) ||
      !/^[1-9][0-9]{0,19}$/.test(String(cleanup.id)) ||
      !/^[1-9][0-9]{0,19}$/.test(String(workspaceImport.id)) ||
      !['active', 'disabled_manually', 'disabled_inactivity', 'disabled_fork'].includes(
        String(deploy.state),
      ) ||
      !['active', 'disabled_manually', 'disabled_inactivity', 'disabled_fork'].includes(
        String(cleanup.state),
      ) ||
      !['active', 'disabled_manually', 'disabled_inactivity', 'disabled_fork'].includes(
        String(workspaceImport.state),
      )
    )
      throw new Error('Operator hold unavailable');
    const baseline = {
      format: 1,
      source: identity.source,
      runId: identity.runId,
      attempt: identity.attempt,
      job: env.GITHUB_JOB,
      event: env.GITHUB_EVENT_NAME,
      deployId: deploy.id,
      cleanupId: cleanup.id,
      workspaceImportId: workspaceImport.id,
      deployBefore: deploy.state,
      cleanupBefore: cleanup.state,
      workspaceImportBefore: workspaceImport.state,
      cleanupVariableBefore: env.CURRENT_ONLY_CLEANUP,
    };
    let saved: Json;
    try {
      saveImmutable(holdPath, baseline);
      saved = baseline;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = lstatSync(holdPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size < 1 ||
        stat.size > 4096 ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error('Operator hold unavailable');
      saved = object(JSON.parse(readFileSync(holdPath, 'utf8')));
    }
    if (
      saved.format !== 1 ||
      saved.source !== identity.source ||
      saved.runId !== identity.runId ||
      saved.attempt !== identity.attempt ||
      saved.job !== env.GITHUB_JOB ||
      saved.event !== env.GITHUB_EVENT_NAME ||
      String(saved.deployId) !== String(deploy.id) ||
      String(saved.cleanupId) !== String(cleanup.id) ||
      String(saved.workspaceImportId) !== String(workspaceImport.id) ||
      saved.cleanupVariableBefore !== env.CURRENT_ONLY_CLEANUP ||
      !['active', 'disabled_manually', 'disabled_inactivity', 'disabled_fork'].includes(
        String(saved.deployBefore),
      ) ||
      !['active', 'disabled_manually', 'disabled_inactivity', 'disabled_fork'].includes(
        String(saved.cleanupBefore),
      ) ||
      !['active', 'disabled_manually', 'disabled_inactivity', 'disabled_fork'].includes(
        String(saved.workspaceImportBefore),
      )
    )
      throw new Error('Operator hold receipt changed');
    if (
      deploy.state === 'disabled_manually' &&
      cleanup.state === 'disabled_manually' &&
      workspaceImport.state === 'disabled_manually'
    )
      break;
    if (!waitForManualDisable) throw new Error('Operator workflow hold changed; release is held');
    if (Date.now() >= deadline) throw new Error('Operator hold was not established');
    await new Promise((resolveWait) => setTimeout(resolveWait, 5000));
  }

  for (const workflow of WRITER_WORKFLOWS) {
    for (const status of ACTIVE) {
      let page = 1;
      let seen = 0;
      let expectedTotal: number | undefined;
      const runIds = new Set<string>();
      for (;;) {
        const result = await get(
          `/actions/workflows/${workflow}/runs?status=${status}&per_page=100&page=${page}`,
        );
        if (
          !Array.isArray(result.workflow_runs) ||
          !Number.isSafeInteger(result.total_count) ||
          Number(result.total_count) < 0 ||
          Number(result.total_count) > 1000 ||
          result.workflow_runs.length > 100
        )
          throw new Error('Operator hold unavailable');
        const runs = result.workflow_runs.map(object);
        const total = Number(result.total_count);
        if (expectedTotal !== undefined && total !== expectedTotal)
          throw new Error('Operator hold census changed during pagination');
        expectedTotal = total;
        seen += runs.length;
        for (const run of runs) {
          const id = String(run.id);
          if (!/^[1-9][0-9]{0,19}$/.test(id) || runIds.has(id) || run.status !== status)
            throw new Error('Operator hold census unavailable');
          runIds.add(id);
        }
        const competingRuns =
          workflow === 'deploy.yml'
            ? runs.filter(
                (run) =>
                  String(run.id) !== identity.runId ||
                  String(run.run_attempt) !== identity.attempt ||
                  run.head_sha !== identity.source ||
                  run.event !== env.GITHUB_EVENT_NAME,
              )
            : runs;
        if (seen > total || competingRuns.length > 0)
          throw new Error('Competing release run blocks native phase');
        if (seen === total) break;
        if (runs.length === 0 || page >= 10) throw new Error('Operator hold census incomplete');
        page++;
      }
    }
  }
  const run = await get(
    `/actions/runs/${identity.runId}/attempts/${identity.attempt}/jobs?per_page=100`,
  );
  if (!Array.isArray(run.jobs) || run.jobs.length > 100 || run.total_count !== run.jobs.length)
    throw new Error('Operator hold job census incomplete');
  const jobs = run.jobs.map(object);
  const current = jobs.filter((job) => job.name === env.GITHUB_JOB && job.status === 'in_progress');
  const activeJobs = jobs.filter(
    (job) => job.status === 'queued' || job.status === 'waiting' || job.status === 'in_progress',
  );
  if (current.length !== 1 || activeJobs.length !== 1 || activeJobs[0] !== current[0])
    throw new Error('Competing release job blocks native phase');
  return {
    source: identity.source,
    runId: identity.runId,
    attempt: identity.attempt,
    currentJob: env.GITHUB_JOB,
    deployWorkflowId: deploy.id,
    cleanupWorkflowId: cleanup.id,
    workspaceImportWorkflowId: workspaceImport.id,
    cleanupVariable: env.CURRENT_ONLY_CLEANUP,
  } as const;
}

if (process.argv[1]?.endsWith('/owner-web-release-operator-hold.ts')) {
  const env = process.env;
  if (process.argv.length !== 3 || process.argv[2] !== '--wait') {
    process.stderr.write('Operator workflow hold verification stopped.\n');
    process.exitCode = 2;
  } else {
    verifyOperatorOwnedHold(
      {
        source: env.OWNER_TAG_RELEASE_SOURCE ?? '',
        runId: env.GITHUB_RUN_ID ?? '',
        attempt: env.GITHUB_RUN_ATTEMPT ?? '',
      },
      env,
      undefined,
      true,
    ).catch(() => {
      process.stderr.write('Operator workflow hold verification stopped.\n');
      process.exitCode = 1;
    });
  }
}
