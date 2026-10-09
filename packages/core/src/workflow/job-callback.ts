import { createHash, timingSafeEqual } from 'node:crypto';
import {
  EXECUTION_JOB_CALLBACK_STATES,
  type ExecutionJobCallbackDecision,
  type ExecutionJobCallbackInput,
  type ExecutionJobCallbackOutcome,
  type ExecutionJobRepository,
  type Records,
} from '@assistant/persistence';
import { hashCallbackToken } from '../browse.js';
import { TaskStateSchema } from '../events.js';
import { getQueueNotifier } from '../queue.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The checks a job callback must pass, applied to the task as read under the
 * store's lock: a pending job exists, the launch token matches its stored
 * hash, and the task is still in a state that accepts the callback.
 */
function decide(
  task: Records['tasks'] | null,
  tokenHash: string,
  kind: 'browser' | 'code' | 'call',
): ExecutionJobCallbackDecision {
  if (!task) return { accept: false, status: 404, error: 'task not found' };
  const pending = TaskStateSchema.parse(task.state ?? {}).pendingJob;
  if (!pending) return { accept: false, status: 409, error: `no pending ${kind} job` };
  // Compare hashes: only the hash is stored, and the incoming raw token is
  // hashed by the caller. timingSafeEqual over equal-length hex strings.
  if (!tokensMatch(pending.callbackTokenHash, tokenHash))
    return { accept: false, status: 403, error: 'invalid token' };
  // The token is durably checkpointed BEFORE launch, so a fast callback may
  // legitimately arrive while the launching executor still owns the task.
  if (!EXECUTION_JOB_CALLBACK_STATES.includes(task.status))
    return {
      accept: false,
      status: 409,
      error: `task is ${task.status}; callback is no longer accepted`,
    };
  return { accept: true, toolCallId: pending.dbToolCallId };
}

export type JobCallbackOutcome =
  | ExecutionJobCallbackOutcome
  | { ok: false; status: 400; error: string };

/**
 * Bind a callback receipt to one launch without persisting its bearer token.
 * A later launch gets a different random token and therefore a different key.
 */
export function jobCallbackIdempotencyKey(
  kind: 'browser' | 'code' | 'call',
  taskId: string,
  token: string,
): string {
  const tokenHash = hashCallbackToken(token);
  return createHash('sha256')
    .update(`assistant:execution-job-callback:v1\0${kind}\0${taskId}\0${tokenHash}`)
    .digest('hex');
}

/** Verify a one-shot job callback, record its result, and wake the task. */
export async function recordJobCallback(
  jobs: ExecutionJobRepository,
  kind: 'browser' | 'code' | 'call',
  input: { taskId: string; token: string } & Omit<ExecutionJobCallbackInput, 'taskId'>,
): Promise<JobCallbackOutcome> {
  if (!input.taskId || !input.token) return { ok: false, status: 400, error: 'bad request' };
  // The tasks primary key is a uuid column. A malformed, unauthenticated
  // taskId would otherwise raise a Postgres 22P02 cast error inside the
  // transaction (before the token check), surfacing as an uncaught 500 and a
  // free DB/log amplification vector. Reject it structurally first.
  if (!UUID_RE.test(input.taskId)) return { ok: false, status: 400, error: 'bad request' };
  const tokenHash = hashCallbackToken(input.token);
  // Phone-call completion has a separate call-session identity/outbox. Keep
  // that established key while browser/code callbacks always use the
  // task+launch-token identity required for one-shot job replay.
  const expectedIdempotencyKey =
    kind === 'call' && input.idempotencyKey
      ? input.idempotencyKey
      : jobCallbackIdempotencyKey(kind, input.taskId, input.token);
  if (kind !== 'call' && input.idempotencyKey && input.idempotencyKey !== expectedIdempotencyKey)
    return { ok: false, status: 400, error: 'bad callback identity' };
  const idempotency = {
    idempotencyKey: expectedIdempotencyKey,
    tokenHash,
    payloadDigest: createHash('sha256')
      .update(JSON.stringify([input.result, input.files]))
      .digest('hex'),
  };
  const outcome = await jobs.recordCallback(
    { taskId: input.taskId, result: input.result, files: input.files, ...idempotency },
    (task) => decide(task, tokenHash, kind),
  );
  if (outcome.ok && !outcome.replayed)
    getQueueNotifier().notify(outcome.taskId, outcome.queueGeneration);
  return outcome;
}
