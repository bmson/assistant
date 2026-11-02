/** Fixture-injected, single-attempt native session. No fetch default, token or production caller. */

import {
  beginLifecycleAttempt,
  bindLifecycleOperation,
  type Mode,
  planLifecycleAction,
  releaseIdentity,
  type State,
  settleLifecycleAttempt,
  unknownLifecycleOutcome,
} from './owner-web-release-lifecycle-model.js';
import {
  nativeObject,
  projectNativeWebSnapshot,
  requireNative,
} from './owner-web-release-native-proof.js';
import { operationName } from './owner-web-tag-native.js';
import { HISTORICAL_WEB_TAGS, WEB_SERVICE } from './owner-web-tag-retirement.js';
import { reconciliationDigest as digest } from './owner-web-traffic-reconciliation-model.js';
export type FixtureDependencies = {
  request: (
    url: string,
    options: {
      method: 'GET' | 'PATCH';
      body?: string;
      headers?: Record<string, string>;
      signal: AbortSignal;
      redirect: 'error';
    },
  ) => Promise<Response>;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** In-memory fixture hook only. Durable authenticated history/CAS remains an unresolved integration gate. */
  recordIntent: (state: State) => Promise<void>;
};
type Reason =
  | 'input_refused'
  | 'raw_read_refused'
  | 'intent_unconfirmed'
  | 'patch_unconfirmed'
  | 'operation_unconfirmed'
  | 'postcheck_refused';
export class NativeReleaseHold extends Error {
  constructor(
    readonly reason: Reason,
    readonly mutationState: 'not_attempted' | 'may_have_been_attempted',
  ) {
    super(`Native web release held: ${reason}`);
  }
}
const ROOT = 'https://run.googleapis.com/v2/',
  CAP = 2 * 1024 * 1024;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
async function bounded<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  requireNative(Number.isFinite(ms) && ms > 0);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error('Native bounded operation held'));
    }, ms);
  });
  try {
    return await Promise.race([run(abort.signal), expiry]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
function age(stamp: string, now: number) {
  const at = Date.parse(stamp);
  requireNative(
    Number.isFinite(now) &&
      Number.isFinite(at) &&
      new Date(at).toISOString() === stamp &&
      at <= now &&
      now - at <= 1800000,
  );
}
/** Only separate family wrappers select the allowable mode set. */
export function nativeFixtureSession(deps: FixtureDependencies, modes: readonly Mode[]) {
  let used = false,
    recoveryUsed = false,
    attempted = false,
    calls = 0,
    phase: Reason = 'input_refused';
  let state: State | undefined, original: State | undefined, mode: Mode | undefined;
  let operationDeadline: number | undefined;
  let operationGets = 0;
  async function json(
    path: string,
    body?: Record<string, unknown>,
    deadline?: number,
    absent = false,
  ): Promise<unknown> {
    requireNative(++calls <= 100);
    const remaining = deadline === undefined ? 15000 : Math.min(15000, deadline - deps.now());
    return bounded(remaining, async (signal) => {
      const response = await deps.request(`${ROOT}${path}`, {
        method: body ? 'PATCH' : 'GET',
        ...(body
          ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
          : {}),
        signal,
        redirect: 'error',
      });
      const cancel = () => {
        try {
          void response.body?.cancel().catch(() => undefined);
        } catch {
          /* No payload disclosure. */
        }
      };
      if (absent && response.status === 404) {
        cancel();
        return undefined;
      }
      if (
        !response.ok ||
        !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
      ) {
        cancel();
        throw new Error('Native response held');
      }
      requireNative(response.body);
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      const release = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener('abort', release, { once: true });
      try {
        for (;;) {
          requireNative(!signal.aborted);
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          requireNative(size <= CAP);
          chunks.push(item.value);
        }
        requireNative(!signal.aborted);
        return nativeObject(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
        );
      } finally {
        signal.removeEventListener('abort', release);
        release();
      }
    });
  }
  function names(post: boolean) {
    requireNative(original && mode);
    const list = Object.keys(original.snapshot.revisions);
    const allowed = [
      original.context.canonical,
      releaseIdentity(original.context, 'P').revision,
      releaseIdentity(original.context, 'R').revision,
    ];
    requireNative(
      list.length > 0 && list.length <= 3 && list.every((name) => allowed.includes(name)),
    );
    if (post && (mode === 'createP' || mode === 'createR'))
      list.push(releaseIdentity(original.context, mode === 'createP' ? 'P' : 'R').revision);
    return [...new Set(list)].sort();
  }
  async function snapshot(post: boolean) {
    requireNative(original);
    const revisions = names(post);
    const raw = await json(WEB_SERVICE),
      native: Record<string, unknown> = {};
    for (const name of revisions) native[name] = await json(`${WEB_SERVICE}/revisions/${name}`);
    return projectNativeWebSnapshot(raw, native, original.context);
  }
  async function persist() {
    requireNative(state);
    await bounded(15000, () => deps.recordIntent(copy(state as State)));
  }
  async function readOperation(deadline: number) {
    requireNative(state?.pending?.operation && operationGets < 60);
    operationGets++;
    return json(state.pending.operation, undefined, deadline);
  }
  async function poll(initial: unknown) {
    requireNative(state?.pending?.operation);
    const expected = state.pending.operation;
    requireNative(operationDeadline !== undefined && operationDeadline > deps.now());
    const deadline = operationDeadline;
    return bounded(Math.min(180000, deadline - deps.now()), async (signal) => {
      let op = nativeObject(initial);
      for (let i = 0; i <= 60; i++) {
        requireNative(
          operationName(op) === expected &&
            (op.done === undefined || typeof op.done === 'boolean') &&
            op.error === undefined,
        );
        if (op.done === true) {
          requireNative(nativeObject(op.response).name === WEB_SERVICE);
          return { name: expected, done: true, responseService: WEB_SERVICE };
        }
        requireNative(i < 60 && deadline - deps.now() > 3000 && !signal.aborted);
        await bounded(Math.min(15000, deadline - deps.now()), (inner) =>
          deps.sleep(3000, AbortSignal.any([signal, inner])),
        );
        requireNative(!signal.aborted);
        op = nativeObject(await readOperation(deadline));
      }
      throw new Error('Native operation held');
    });
  }
  async function finish(initial: unknown) {
    requireNative(state);
    phase = 'operation_unconfirmed';
    const completion = await poll(initial);
    phase = 'postcheck_refused';
    const after = await snapshot(true);
    const settled = settleLifecycleAttempt(state, completion, after);
    const prior = state;
    state = settled;
    phase = 'intent_unconfirmed';
    try {
      await persist();
    } catch {
      state = prior;
      throw new Error('Native receipt held');
    }
    return copy(settled);
  }
  async function hold(): Promise<never> {
    if (attempted && state?.pending) {
      state = unknownLifecycleOutcome(state);
      try {
        await persist();
      } catch {
        /* Durable integration is unconfirmed; never retry a write. */
      }
    }
    throw new NativeReleaseHold(phase, attempted ? 'may_have_been_attempted' : 'not_attempted');
  }
  return {
    async execute(input: State, selected: Mode, reviewedAt: string): Promise<State> {
      try {
        requireNative(!used);
        used = true;
        requireNative(modes.includes(selected));
        age(reviewedAt, deps.now());
        const plan = planLifecycleAction(input, selected);
        requireNative(input.context.canonical === HISTORICAL_WEB_TAGS[1]?.revision);
        original = copy(input);
        mode = selected;
        phase = 'raw_read_refused';
        const fresh = await snapshot(false);
        requireNative(digest(fresh) === digest(original.snapshot));
        if (selected === 'createP' || selected === 'createR') {
          const id = releaseIdentity(input.context, selected === 'createP' ? 'P' : 'R');
          requireNative(
            (await json(`${WEB_SERVICE}/revisions/${id.revision}`, undefined, undefined, true)) ===
              undefined,
          );
        }
        // Regenerate exact body/mask from the just-read native state, never from a supplied projection/hash assertion.
        requireNative(digest(plan) === digest(planLifecycleAction(original, selected)));
        age(reviewedAt, deps.now());
        state = beginLifecycleAttempt(original, plan);
        phase = 'intent_unconfirmed';
        await persist();
        age(reviewedAt, deps.now());
        const mask = selected === 'createP' || selected === 'createR' ? 'template' : 'traffic';
        requireNative(
          plan.request.method === 'PATCH' &&
            plan.request.updateMask === mask &&
            Object.keys(plan.request.body).sort().join(',') ===
              (mask === 'template' ? 'etag,name,template' : 'etag,name,traffic') &&
            plan.request.body.name === WEB_SERVICE &&
            plan.request.body.etag === fresh.etag,
        );
        phase = 'patch_unconfirmed';
        attempted = true;
        const initial = await json(`${WEB_SERVICE}?updateMask=${mask}`, plan.request.body);
        phase = 'operation_unconfirmed';
        state = bindLifecycleOperation(state, operationName(initial));
        operationDeadline = deps.now() + 180000;
        await persist();
        return await finish(initial);
      } catch {
        return hold();
      }
    },
    /** GET-only, at most one recovery in the same object; no caller-supplied operation/projection. */
    async recoverSameOperation(): Promise<State> {
      try {
        requireNative(used && attempted && !recoveryUsed && state?.pending?.operation);
        recoveryUsed = true;
        phase = 'operation_unconfirmed';
        requireNative(operationDeadline !== undefined && operationDeadline > deps.now());
        return await finish(await readOperation(operationDeadline));
      } catch {
        return hold();
      }
    },
    checkpoint() {
      return {
        used,
        calls,
        operationGets,
        mutationState: attempted ? 'may_have_been_attempted' : 'not_attempted',
        receipt: state?.receipt ?? null,
        ordinal: state?.ordinal ?? null,
        operation: state?.pending?.operation ?? null,
        outcome: state?.pending?.outcome ?? null,
      };
    },
  };
}
