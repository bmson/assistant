import { allowedArtifactPath } from '@assistant/persistence/artifact-path';
import { z } from 'zod';
import { type BrowserJobPendingResult, isBrowserJobPending } from './browse.js';
import { type CallPendingResult, isCallPending } from './phone-call.js';

/**
 * Code execution (Phase 13). A second occupant of the credential-free Cloud Run
 * Job template (the first is the browser worker): the model authors a short
 * script, `code.execute` stages it exactly like `browser.execute` stages a
 * plan — launch → sleep → one-shot callback wakes the task with the result. The
 * worker has no DB access and no API keys; it runs the script in an ephemeral
 * container, captures stdout/stderr/exit, and uploads any files the script
 * wrote to its scratch output dir into the agent's Workspace under a
 * per-task `code/<taskId>/` prefix (never outside it).
 *
 * `hashCallbackToken`, the pending-sentinel machinery, and the executor's
 * park/resume flow are shared with the browser job (see browse.ts); only the
 * spec schema, the sentinel value, and the artifact inventory differ.
 */

/** The Workspace prefix a code run may write its outputs under (per task). */
export const CODE_OUTPUT_PREFIX = 'code/';

export function codeOutputPrefix(taskId: string): string {
  return `${CODE_OUTPUT_PREFIX}${taskId}/`;
}

/** Workspace areas a code input may be staged from (never profile/secrets). */
export const CODE_INPUT_PREFIXES = ['code/', 'browser/attachments/', 'documents/', 'imports/'];

export const CodeSpecSchema = z.object({
  goal: z.string().min(3).max(500).describe('One line: what this script is for.'),
  language: z.enum(['javascript', 'python']).default('javascript'),
  /** The full script source — exactly what the owner approves when gated. */
  source: z.string().min(1).max(60_000),
  /**
   * Workspace files staged into ./input/<as> before the script runs — feed a
   * CSV/doc from the Workspace (drive.download, an ingested document, a prior
   * code output) into the script. Read them at ./input/<as>.
   */
  inputs: z
    .array(
      z.object({
        workspacePath: z
          .string()
          .min(1)
          .max(300)
          .refine((value) => {
            try {
              allowedArtifactPath(value, CODE_INPUT_PREFIXES);
              return true;
            } catch {
              return false;
            }
          }, 'input path is outside the allowed namespace'),
        as: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[\w.-]+$/, 'a bare filename (no path separators)')
          .refine((value) => value !== '.' && value !== '..', 'a file name is required'),
      }),
    )
    .max(10)
    .optional(),
  /**
   * Whether the script needs network access. Off by default: a pure computation
   * is autonomous, anything that reaches the network is owner-approved.
   */
  allowNetwork: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(1).max(600).default(60),
});
export type CodeSpec = z.infer<typeof CodeSpecSchema>;

// ── Pending-job sentinel (parallel to BROWSER_JOB_PENDING) ────────────────────

export const CODE_JOB_PENDING = 'code_job_pending' as const;

export interface CodeJobPendingResult {
  pending: typeof CODE_JOB_PENDING;
  callbackToken: string;
  timeoutAt: string;
  executionName?: string;
}

/**
 * The minimal pending-sentinel shape the executor stages before launching a
 * background job. Both BrowserJobPendingResult and CodeJobPendingResult satisfy
 * it, so the staging seam (stageBrowserJob) is shared by both job kinds.
 */
export interface StagedJobPending {
  pending: string;
  callbackToken: string;
  timeoutAt: string;
  executionName?: string;
}

export function isCodeJobPending(result: unknown): result is CodeJobPendingResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { pending?: unknown }).pending === CODE_JOB_PENDING &&
    typeof (result as { callbackToken?: unknown }).callbackToken === 'string'
  );
}

/**
 * True for a still-pending job result of EITHER kind. The executor's park/resume
 * path is job-type-agnostic — it only needs to know whether the `tool_calls`
 * row still holds a pending sentinel or has been replaced by a real result. Both
 * pending shapes carry `callbackToken` + `timeoutAt`, so it narrows to the union.
 */
export function isJobPending(
  result: unknown,
): result is BrowserJobPendingResult | CodeJobPendingResult | CallPendingResult {
  return isBrowserJobPending(result) || isCodeJobPending(result) || isCallPending(result);
}

/** The result a completed code run reports back through its callback. */
export interface CodeJobResult {
  ok: boolean;
  goal: string;
  language: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Workspace paths of files the script wrote (already uploaded by the worker). */
  outputs: string[];
  timedOut?: boolean;
  error?: string;
  durationMs?: number;
  [key: string]: unknown;
}
