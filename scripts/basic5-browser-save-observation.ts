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
  reply?: Basic5ReplyObservation;
}

export type Basic5ReplyObservationStep = 'response_json' | 'reply_decode' | 'reply_decoded';

export type Basic5ReplyContentTypeClass = 'json' | 'html' | 'other' | 'missing' | 'unknown';

export interface Basic5ReplyObservation {
  step: Basic5ReplyObservationStep;
  contentTypeClass: Basic5ReplyContentTypeClass;
  decoderCallable: boolean;
  jsonReadCompleted: boolean;
  topLevelObject: boolean | null;
  wireKeysAllowed: boolean | null;
  receiptKeysPresent: boolean | null;
  versionTypeNumber: boolean | null;
  versionOne: boolean | null;
  wireTypesValid: boolean | null;
  decoderAccepted: boolean | null;
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
const BASIC5_REPLY_WIRE_KEYS = new Set([
  'version',
  'authority',
  'command',
  'operationId',
  'requestHash',
  'statusVersion',
  'outcome',
  'ids',
  'revision',
  'refreshPending',
  'reason',
  'fieldErrors',
  'originalOperationTerminal',
  'receiptBindingToken',
]);
const BASIC5_RECEIPT_KEYS = [
  'version',
  'authority',
  'command',
  'operationId',
  'requestHash',
  'statusVersion',
  'outcome',
  'ids',
  'revision',
] as const;

function replyContentTypeClass(headers: unknown): Basic5ReplyContentTypeClass {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return 'unknown';
  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > 256) return 'other';
  const raw = entries.find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  if (raw === undefined) return 'missing';
  if (typeof raw !== 'string' || raw.length > 256) return 'other';
  const mediaType = raw.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (
    mediaType === 'application/json' ||
    (mediaType.startsWith('application/') && mediaType.endsWith('+json'))
  )
    return 'json';
  if (mediaType === 'text/html') return 'html';
  return 'other';
}

function observedReplyShape(
  value: unknown,
): Pick<
  Basic5ReplyObservation,
  | 'topLevelObject'
  | 'wireKeysAllowed'
  | 'receiptKeysPresent'
  | 'versionTypeNumber'
  | 'versionOne'
  | 'wireTypesValid'
> {
  const topLevelObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!topLevelObject)
    return {
      topLevelObject: false,
      wireKeysAllowed: null,
      receiptKeysPresent: null,
      versionTypeNumber: null,
      versionOne: null,
      wireTypesValid: null,
    };

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const has = (key: string) => Object.hasOwn(record, key);
  const versionTypeNumber = typeof record.version === 'number';
  const baseTypes: [string, (field: unknown) => boolean][] = [
    ['version', (field) => typeof field === 'number'],
    ['authority', (field) => typeof field === 'string'],
    ['command', (field) => typeof field === 'string' || field === null],
    ['operationId', (field) => typeof field === 'string' || field === null],
    ['requestHash', (field) => typeof field === 'string'],
    ['statusVersion', (field) => typeof field === 'number'],
    ['outcome', (field) => typeof field === 'string'],
    ['ids', (field) => typeof field === 'object' && field !== null && !Array.isArray(field)],
    ['revision', (field) => typeof field === 'string'],
    ['refreshPending', (field) => typeof field === 'boolean'],
    ['reason', (field) => typeof field === 'string'],
    [
      'fieldErrors',
      (field) => typeof field === 'object' && field !== null && !Array.isArray(field),
    ],
    ['originalOperationTerminal', (field) => typeof field === 'boolean'],
    ['receiptBindingToken', (field) => typeof field === 'string'],
  ];

  return {
    topLevelObject: true,
    wireKeysAllowed:
      keys.length <= BASIC5_REPLY_WIRE_KEYS.size &&
      keys.every((key) => BASIC5_REPLY_WIRE_KEYS.has(key)),
    receiptKeysPresent: BASIC5_RECEIPT_KEYS.every(has),
    versionTypeNumber,
    versionOne: versionTypeNumber ? record.version === 1 : null,
    wireTypesValid: baseTypes.every(([key, accepts]) => !has(key) || accepts(record[key])),
  };
}

/** Read and strictly decode one untrusted HTTP JSON body without exposing its contents. */
export async function decodeBasic5ObservedReply<T>(input: {
  response: {
    headers(): Record<string, string>;
    json(): Promise<unknown>;
  };
  decode: unknown;
  onDiagnostic: (diagnostic: Basic5ReplyObservation) => void;
}): Promise<T | null> {
  const decoderCallable = typeof input.decode === 'function';
  let contentTypeClass: Basic5ReplyContentTypeClass = 'unknown';
  try {
    contentTypeClass = replyContentTypeClass(input.response.headers());
  } catch {
    // Header inspection is diagnostic only; the single body read remains authoritative.
  }
  let diagnostic: Basic5ReplyObservation = {
    step: 'response_json',
    contentTypeClass,
    decoderCallable,
    jsonReadCompleted: false,
    topLevelObject: null,
    wireKeysAllowed: null,
    receiptKeysPresent: null,
    versionTypeNumber: null,
    versionOne: null,
    wireTypesValid: null,
    decoderAccepted: null,
  };
  const publish = () => {
    try {
      input.onDiagnostic(diagnostic);
    } catch {
      // Diagnostic callbacks are observational and cannot replace the body result.
    }
  };
  publish();

  let raw: unknown;
  try {
    raw = await input.response.json();
  } catch (error) {
    publish();
    throw error;
  }
  diagnostic = {
    ...diagnostic,
    step: 'reply_decode',
    jsonReadCompleted: true,
    ...observedReplyShape(raw),
  };
  publish();

  if (!decoderCallable) throw new Error('BASIC5 observed reply decoder is unavailable');
  let decoded: unknown;
  try {
    decoded = await (input.decode as (value: unknown) => T | null | Promise<T | null>)(raw);
  } catch (error) {
    publish();
    throw error;
  }
  const decoderAccepted = decoded !== null && decoded !== undefined;
  diagnostic = {
    ...diagnostic,
    step: decoderAccepted ? 'reply_decoded' : 'reply_decode',
    decoderAccepted,
  };
  publish();
  return decoderAccepted ? (decoded as T) : null;
}

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
