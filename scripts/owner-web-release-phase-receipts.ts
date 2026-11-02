/** Private, single-run receipts for the fixed native release lifecycle. */
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type State, verifyLifecycleState } from './owner-web-release-lifecycle-model.js';

const MAX_BYTES = 512 * 1024;
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid private release receipt');
  return value as Record<string, unknown>;
};
function writeNew(path: string, bytes: string) {
  if (Buffer.byteLength(bytes) > MAX_BYTES)
    throw new Error('Private release receipt exceeds bound');
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function replacePrivate(path: string, bytes: string) {
  if (Buffer.byteLength(bytes) > MAX_BYTES)
    throw new Error('Private release receipt exceeds bound');
  const next = `${path}.next`;
  writeNew(next, bytes);
  renameSync(next, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function phaseName(state: State): string {
  if (state.pending) return state.pending.plan.mode;
  return state.phase;
}

/**
 * One directory is created per protected workflow attempt and never reopened.
 * The current state is private runner scratch; immutable phase receipts make a
 * failed prewrite, unknown outcome, or replay fail closed within the run.
 */
export function createPrivateReleasePhaseReceipts(
  runnerTemp: string,
  identity: { source: string; runId: string; attempt: string; manifest: string },
) {
  return privateReleasePhaseReceipts(runnerTemp, identity, true);
}

/** Open only the same run's existing scratch receipt; never creates or adopts it. */
export function openPrivateReleasePhaseReceipts(
  runnerTemp: string,
  identity: { source: string; runId: string; attempt: string; manifest: string },
) {
  return privateReleasePhaseReceipts(runnerTemp, identity, false);
}

function privateReleasePhaseReceipts(
  runnerTemp: string,
  identity: { source: string; runId: string; attempt: string; manifest: string },
  create: boolean,
) {
  if (
    !/^[a-f0-9]{40}$/.test(identity.source) ||
    !/^[1-9][0-9]{0,19}$/.test(identity.runId) ||
    identity.attempt !== '1' ||
    !/^[a-f0-9]{64}$/.test(identity.manifest)
  )
    throw new Error('Untrusted release receipt identity');
  const requestedBase = resolve(runnerTemp),
    baseStat = lstatSync(requestedBase);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink())
    throw new Error('Invalid protected temporary directory');
  const base = realpathSync(requestedBase);
  const directory = resolve(base, `owner-web-release-${identity.runId}-${identity.attempt}`);
  if (create) mkdirSync(directory, { mode: 0o700 });
  const dirStat = lstatSync(directory);
  if (
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink() ||
    realpathSync(directory) !== directory ||
    (dirStat.mode & 0o077) !== 0
  )
    throw new Error('Invalid private release receipt directory');
  const statePath = resolve(directory, 'state.json');
  const envelope = (state: State) => {
    verifyLifecycleState(state);
    if (
      state.context.source !== identity.source ||
      state.context.runId !== identity.runId ||
      state.context.attempt !== identity.attempt ||
      state.context.manifest !== identity.manifest
    )
      throw new Error('Private release receipt context changed');
    return `${JSON.stringify({ format: 1, ...identity, state })}\n`;
  };
  const immutable = (kind: string, state: State) => {
    const path = resolve(directory, `${kind}-${state.ordinal}-${phaseName(state)}.json`);
    writeNew(path, envelope(state));
    return path;
  };
  const saveCurrent = (state: State, initial = false) => {
    const bytes = envelope(state);
    if (initial) writeNew(statePath, bytes);
    else replacePrivate(statePath, bytes);
  };
  const readStoredState = (): State => {
    const stat = lstatSync(statePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 1 ||
      stat.size > MAX_BYTES ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error('Private lifecycle state is missing or invalid');
    const parsed = obj(JSON.parse(readFileSync(statePath, 'utf8')));
    if (
      parsed.format !== 1 ||
      parsed.source !== identity.source ||
      parsed.runId !== identity.runId ||
      parsed.attempt !== identity.attempt ||
      parsed.manifest !== identity.manifest
    )
      throw new Error('Private lifecycle state belongs to another attempt');
    const state = obj(parsed.state) as unknown as State;
    verifyLifecycleState(state);
    return state;
  };
  return {
    directory,
    statePath,
    initialize(state: State) {
      if (!create || state.ordinal !== 0 || state.pending || state.phase !== 'captured')
        throw new Error('Lifecycle must start at its captured phase');
      saveCurrent(state, true);
      return statePath;
    },
    recordCheckpoint(state: State) {
      const prior = readStoredState();
      if (state.pending || state.retirementAttempt || state.previousReceipt !== prior.receipt)
        throw new Error('Cannot checkpoint an unresolved or stale lifecycle phase');
      immutable('checkpoint', state);
      replacePrivate(statePath, envelope(state));
    },
    writeSafeTerminalCertificate(job: string) {
      const state = this.readCurrent();
      if (
        state.phase !== 'complete' ||
        state.pending ||
        state.retirementAttempt ||
        !/^[a-z0-9_-]{1,64}$/.test(job)
      )
        throw new Error('Safe terminal lifecycle certificate is unavailable');
      const target = resolve(directory, 'terminal-safe.json');
      writeNew(
        target,
        `${JSON.stringify({
          format: 1,
          source: identity.source,
          runId: identity.runId,
          attempt: identity.attempt,
          manifest: identity.manifest,
          job,
          phase: 'complete',
          stateReceipt: state.receipt,
        })}\n`,
      );
      return target;
    },
    readCurrent(): State {
      const state = readStoredState();
      if (state.pending || state.retirementAttempt)
        throw new Error('Unresolved lifecycle phase; release is held');
      for (const name of readdirSync(directory)) {
        const attempt =
          /^attempt-([1-9][0-9]*)-(createP|attachP|promoteP|createR|attachR|promoteR|closeP|restoreC|repauseP|closeR)\.json$/.exec(
            name,
          );
        if (attempt && Number(attempt[1]) > state.ordinal)
          throw new Error('Incomplete attempted lifecycle phase; release is held');
        const retirement =
          /^retirement-(?:attempt|operation|unknown)-([1-9][0-9]*)-promotedP\.json$/.exec(name);
        const checkpoint = /^checkpoint-([1-9][0-9]*)-[A-Za-z]+\.json$/.exec(name);
        if (
          (retirement && Number(retirement[1]) > state.ordinal) ||
          (checkpoint && Number(checkpoint[1]) > state.ordinal)
        )
          throw new Error('Incomplete lifecycle receipt; release is held');
      }
      if (
        state.phase !== 'captured' &&
        ![
          `complete-${state.ordinal}-${state.phase}.json`,
          `checkpoint-${state.ordinal}-${state.phase}.json`,
        ].some((name) => {
          try {
            const stat = lstatSync(resolve(directory, name));
            return (
              stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_BYTES
            );
          } catch {
            return false;
          }
        })
      )
        throw new Error('Lifecycle completion receipt is missing; release is held');
      return state;
    },
    recordIntent(state: State) {
      const text = envelope(state);
      const prior = readStoredState();
      if (state.previousReceipt !== prior.receipt)
        throw new Error('Private lifecycle phase is stale or replayed');
      if (state.retirementAttempt) {
        const attempt = state.retirementAttempt;
        const kind =
          attempt.outcome === 'unknown'
            ? 'retirement-unknown'
            : attempt.operation
              ? 'retirement-operation'
              : 'retirement-attempt';
        immutable(kind, state);
        replacePrivate(statePath, text);
        return;
      }
      if (!state.pending) {
        immutable('complete', state);
        replacePrivate(statePath, text);
        return;
      }
      if (state.pending.outcome === 'unknown') {
        immutable('unknown', state);
        replacePrivate(statePath, text);
        return;
      }
      if (!state.pending.operation) {
        // This O_EXCL+fsync receipt is the write barrier. A failure is returned
        // to nativeFixtureSession before it can issue its one PATCH.
        immutable('attempt', state);
      } else {
        immutable('operation', state);
      }
      replacePrivate(statePath, text);
    },
  };
}
