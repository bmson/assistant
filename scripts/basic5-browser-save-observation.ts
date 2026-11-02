import { performance } from 'node:perf_hooks';

export type Basic5SaveObservationPhase =
  | 'click_pending'
  | 'click_done'
  | 'request_seen'
  | 'response_seen'
  | 'parse';

export type Basic5SaveObservationErrorStage = 'click' | 'wait' | 'parse' | null;
export type Basic5SaveObservationErrorCategory = 'timeout' | 'page_closed' | 'other' | null;

export interface Basic5SaveObservationDiagnostic {
  operation:
    | 'update_person_identity'
    | 'add_family_relationship'
    | 'correct_owner_family_relationship'
    | 'correct_owner_memory';
  phase: Basic5SaveObservationPhase;
  totalMatchingPostCount: number | null;
  commandMatched: boolean | null;
  httpStatus: number | null;
  nativeValid: boolean | null;
  invalidControlPresent: boolean | null;
  alertPresent: boolean | null;
  saveEnabled: boolean | null;
  pageClosed: boolean;
  errorStage: Basic5SaveObservationErrorStage;
  errorCategory: Basic5SaveObservationErrorCategory;
}

export interface Basic5SaveObservationPage<TResponse> {
  waitForResponse(
    predicate: (response: TResponse) => boolean,
    options: { timeout: number; signal: AbortSignal },
  ): Promise<TResponse>;
  on(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
  isClosed(): boolean;
}

export interface Basic5SaveObservationUi {
  nativeValid: boolean | null;
  invalidControlPresent: boolean | null;
  alertPresent: boolean | null;
  saveEnabled: boolean | null;
}

type ObservationOutcome<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown };

const OBSERVATION_TIMEOUT_MS = 30_000;
const UI_READ_TIMEOUT_MS = 250;
const BASIC5_SAVE_COMMANDS = new Set<Basic5SaveObservationDiagnostic['operation']>([
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
]);

function timeoutError(): Error {
  return new Error('BASIC5 save observation timed out');
}

function closedError(): Error {
  return new Error('BASIC5 save observation page closed');
}

function isTimeout(input: {
  error: unknown;
  ownTimeout: Error;
  isTimeoutError: (error: unknown) => boolean;
}): boolean {
  if (input.error === input.ownTimeout) return true;
  try {
    return input.isTimeoutError(input.error);
  } catch {
    return false;
  }
}

function boundedPostCount(read: () => number): number | null {
  try {
    const count = read();
    if (!Number.isSafeInteger(count) || count < 0 || count > 64) return null;
    return count;
  } catch {
    return null;
  }
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export async function observeBasic5Save<TResponse, TResult>(input: {
  operation: Basic5SaveObservationDiagnostic['operation'];
  page: Basic5SaveObservationPage<TResponse>;
  click: (remainingMs: number) => Promise<void>;
  parse: (response: TResponse) => Promise<TResult>;
  matchResponse: (response: TResponse) => boolean;
  status: (response: TResponse) => number;
  activateRequestObserver: (notify: (commandMatched: boolean | null) => void) => () => void;
  totalMatchingPostCount: () => number;
  readUi: () => Promise<Basic5SaveObservationUi>;
  isTimeoutError: (error: unknown) => boolean;
  onDiagnostic: (diagnostic: Basic5SaveObservationDiagnostic) => void;
}): Promise<TResult> {
  if (!BASIC5_SAVE_COMMANDS.has(input.operation))
    throw new Error('BASIC5 save observation command is not allowlisted');

  const startedAt = performance.now();
  const deadline = startedAt + OBSERVATION_TIMEOUT_MS;
  const ownTimeout = timeoutError();
  let phase: Basic5SaveObservationPhase = 'click_pending';
  let commandMatched: boolean | null = null;
  let httpStatus: number | null = null;
  let nativeValid: boolean | null = null;
  let invalidControlPresent: boolean | null = null;
  let alertPresent: boolean | null = null;
  let saveEnabled: boolean | null = null;
  let pageClosed = false;
  let errorStage: Basic5SaveObservationErrorStage = null;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposeRequestObserver: (() => void) | undefined;
  let cleaned = false;
  let responseOutcome: Promise<ObservationOutcome<TResponse>> | undefined;
  let responsePredicateError: unknown;
  const responseAbort = new AbortController();

  const remainingMs = () => Math.max(0, Math.floor(deadline - performance.now()));
  const setPhase = (next: Basic5SaveObservationPhase) => {
    const order: Basic5SaveObservationPhase[] = [
      'click_pending',
      'click_done',
      'request_seen',
      'response_seen',
      'parse',
    ];
    if (order.indexOf(next) > order.indexOf(phase)) phase = next;
  };
  // Attach a rejection handler before any wait path can race this deadline.
  const timeoutOutcome = new Promise<ObservationOutcome<never>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'error', error: ownTimeout }), remainingMs());
  });
  const pageResponse = (response: TResponse) => {
    try {
      const matched = input.matchResponse(response);
      if (matched) setPhase('response_seen');
      return matched;
    } catch (error) {
      responsePredicateError = error;
      responseAbort.abort();
      return false;
    }
  };
  const pageClose = () => {
    pageClosed = true;
    responseAbort.abort();
  };
  const startResponseWait = () => {
    const left = remainingMs();
    if (left <= 0)
      return Promise.resolve<ObservationOutcome<TResponse>>({
        kind: 'error',
        error: ownTimeout,
      });
    let wait: Promise<TResponse>;
    try {
      wait = input.page.waitForResponse(pageResponse, {
        timeout: left,
        signal: responseAbort.signal,
      });
    } catch (error) {
      wait = Promise.reject(error);
    }
    const outcome = Promise.resolve(wait).then<
      ObservationOutcome<TResponse>,
      ObservationOutcome<TResponse>
    >(
      (response) => {
        try {
          const status = input.status(response);
          if (!Number.isInteger(status) || status < 100 || status > 599)
            throw new Error('BASIC5 save response status was invalid');
          httpStatus = status;
          setPhase('response_seen');
          return { kind: 'value', value: response };
        } catch (error) {
          return { kind: 'error', error };
        }
      },
      (error) => ({ kind: 'error', error: responsePredicateError ?? error }),
    );
    void outcome.catch(() => undefined);
    responseOutcome = outcome;
    return outcome;
  };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (timer !== undefined) clearTimeout(timer);
    responseAbort.abort();
    try {
      input.page.off('close', pageClose);
    } catch {
      // Cleanup failures must not replace the original operation result/error.
    }
    try {
      disposeRequestObserver?.();
    } catch {
      // Cleanup failures must not replace the original operation result/error.
    }
    if (responseOutcome) await responseOutcome;
  };
  const readUiBounded = async () => {
    const left = remainingMs();
    if (left <= 0) return;
    let localTimer: ReturnType<typeof setTimeout> | undefined;
    const uiOutcome = Promise.resolve()
      .then(() => input.readUi())
      .then<
        ObservationOutcome<Basic5SaveObservationUi>,
        ObservationOutcome<Basic5SaveObservationUi>
      >(
        (value) => ({ kind: 'value', value }),
        (error) => ({ kind: 'error', error }),
      );
    // Ensure a late UI rejection stays handled after the bounded race completes.
    void uiOutcome.catch(() => undefined);
    const localTimeout = new Promise<ObservationOutcome<Basic5SaveObservationUi>>((resolve) => {
      localTimer = setTimeout(
        () => resolve({ kind: 'error', error: new Error('BASIC5 UI observation timed out') }),
        Math.min(UI_READ_TIMEOUT_MS, left),
      );
    });
    const outcome = await Promise.race([uiOutcome, localTimeout, timeoutOutcome]);
    if (localTimer !== undefined) clearTimeout(localTimer);
    if (outcome.kind !== 'value') return;
    if (!outcome.value || typeof outcome.value !== 'object') return;
    nativeValid = boolOrNull(outcome.value.nativeValid);
    invalidControlPresent = boolOrNull(outcome.value.invalidControlPresent);
    alertPresent = boolOrNull(outcome.value.alertPresent);
    saveEnabled = boolOrNull(outcome.value.saveEnabled);
  };
  const emitDiagnostic = () => {
    const diagnostic: Basic5SaveObservationDiagnostic = {
      operation: input.operation,
      phase,
      totalMatchingPostCount: boundedPostCount(input.totalMatchingPostCount),
      commandMatched,
      httpStatus,
      nativeValid,
      invalidControlPresent,
      alertPresent,
      saveEnabled,
      pageClosed,
      errorStage,
      errorCategory: hasPrimaryError
        ? isTimeout({ error: primaryError, ownTimeout, isTimeoutError: input.isTimeoutError })
          ? 'timeout'
          : pageClosed
            ? 'page_closed'
            : 'other'
        : null,
    };
    try {
      input.onDiagnostic(diagnostic);
    } catch {
      // Diagnostic sinks are observational and never replace the result.
    }
  };

  let result: TResult | undefined;
  try {
    input.page.on('close', pageClose);
    if (input.page.isClosed()) {
      pageClosed = true;
      errorStage = 'wait';
      throw closedError();
    }
    disposeRequestObserver = input.activateRequestObserver((matched) => {
      setPhase('request_seen');
      commandMatched = matched;
    });
    await readUiBounded();
    if (pageClosed || input.page.isClosed()) {
      pageClosed = true;
      errorStage = 'wait';
      throw closedError();
    }

    const responseWait = startResponseWait();
    const leftBeforeClick = remainingMs();
    if (leftBeforeClick <= 0) {
      errorStage = 'click';
      throw ownTimeout;
    }
    const clickOutcome = Promise.resolve()
      .then(() => input.click(leftBeforeClick))
      .then<ObservationOutcome<void>, ObservationOutcome<void>>(
        () => ({ kind: 'value', value: undefined }),
        (error) => ({ kind: 'error', error }),
      );
    // Attach immediately so a late click rejection cannot become unhandled.
    void clickOutcome.catch(() => undefined);
    const clickResult = await Promise.race([clickOutcome, timeoutOutcome]);
    if (clickResult.kind === 'error') {
      errorStage = 'click';
      throw clickResult.error;
    }
    if (clickResult.kind !== 'value') {
      errorStage = 'click';
      throw ownTimeout;
    }
    if (remainingMs() <= 0) {
      errorStage = 'click';
      throw ownTimeout;
    }
    setPhase('click_done');
    await readUiBounded();

    const responseResult = await Promise.race([responseWait, timeoutOutcome]);
    if (responseResult.kind === 'error') {
      errorStage = 'wait';
      throw responseResult.error;
    }
    if (responseResult.kind !== 'value') {
      errorStage = 'wait';
      throw ownTimeout;
    }
    if (remainingMs() <= 0) {
      errorStage = 'wait';
      throw ownTimeout;
    }

    setPhase('parse');
    const parseOutcome = Promise.resolve()
      .then(() => input.parse(responseResult.value))
      .then<ObservationOutcome<TResult>, ObservationOutcome<TResult>>(
        (value) => ({ kind: 'value', value }),
        (error) => ({ kind: 'error', error }),
      );
    void parseOutcome.catch(() => undefined);
    const parsed = await Promise.race([parseOutcome, timeoutOutcome]);
    if (parsed.kind === 'error') {
      errorStage = 'parse';
      throw parsed.error;
    }
    if (parsed.kind !== 'value') {
      errorStage = 'parse';
      throw ownTimeout;
    }
    if (remainingMs() <= 0) {
      errorStage = 'parse';
      throw ownTimeout;
    }
    result = parsed.value;
  } catch (error) {
    if (!hasPrimaryError) {
      primaryError = error;
      hasPrimaryError = true;
      if (errorStage === null) errorStage = 'wait';
    }
    await cleanup();
    await readUiBounded();
    emitDiagnostic();
    throw primaryError;
  }

  await cleanup();
  emitDiagnostic();
  return result as TResult;
}
