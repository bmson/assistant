import { createPostgresExecutionJobRepository, type Db } from '@assistant/db';
import type { ExecutionJobRepository } from '@assistant/persistence';
import { type JobCallbackOutcome, recordJobCallback } from './job-callback.js';

export type BrowserCallbackOutcome = JobCallbackOutcome;

/**
 * The browser job's one-shot callback: verify the launch token against the
 * task's pendingJob checkpoint, replace the sentinel result on the tool_calls
 * row with the job's real result, and wake the task. Idempotent-ish: once the
 * executor settles the job, pendingJob is cleared and later callbacks get 409.
 */
export async function recordBrowserJobResult(
  store: Db | ExecutionJobRepository,
  input: {
    taskId: string;
    token: string;
    result: Record<string, unknown>;
    idempotencyKey?: string;
  },
): Promise<BrowserCallbackOutcome> {
  // Inventory the job's Workspace artifacts (screenshots + trace) in `files`.
  const screenshots = Array.isArray(input.result.screenshots)
    ? (input.result.screenshots as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const files = [
    ...screenshots.map((path) => ({ workspacePath: path, mime: 'image/png' })),
    ...(typeof input.result.tracePath === 'string'
      ? [{ workspacePath: input.result.tracePath, mime: 'application/zip' }]
      : []),
  ];
  const jobs =
    'kind' in store && store.kind === 'execution-job-repository'
      ? (store as ExecutionJobRepository)
      : createPostgresExecutionJobRepository(store as Db);
  return recordJobCallback(jobs, 'browser', { ...input, files });
}
