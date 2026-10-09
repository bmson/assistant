import { createPostgresExecutionJobRepository, type Db } from '@assistant/db';
import type { ExecutionJobRepository } from '@assistant/persistence';
import { type JobCallbackOutcome, recordJobCallback } from './job-callback.js';

const MIME_BY_EXT: Record<string, string> = {
  json: 'application/json',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export type CodeCallbackOutcome = JobCallbackOutcome;

/**
 * The code job's one-shot callback: verify the launch token against the task's
 * pendingJob checkpoint, replace the sentinel result on the tool_calls row with
 * the job's real result, inventory any output files the script wrote, and wake
 * the task. Mirrors recordBrowserJobResult — the security checks are identical
 * (UUID guard → task lock → pending exists → constant-time token compare →
 * status gate → sentinel replace → wake); only the artifact inventory differs.
 */
export async function recordCodeJobResult(
  store: Db | ExecutionJobRepository,
  input: {
    taskId: string;
    token: string;
    result: Record<string, unknown>;
    idempotencyKey?: string;
  },
): Promise<CodeCallbackOutcome> {
  // Inventory the files the script wrote (already uploaded to the workspace).
  const outputs = Array.isArray(input.result.outputs)
    ? (input.result.outputs as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const files = outputs.slice(0, 100).map((p) => ({ workspacePath: p, mime: mimeForPath(p) }));
  const jobs =
    'kind' in store && store.kind === 'execution-job-repository'
      ? (store as ExecutionJobRepository)
      : createPostgresExecutionJobRepository(store as Db);
  return recordJobCallback(jobs, 'code', { ...input, files });
}
