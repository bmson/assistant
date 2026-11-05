export const WEB17_TRANSPORT_BYTE_CAP = 8_192;
export const WEB17_TRANSPORT_EVENT_CAP = 48;
const noncePattern = /^[A-Za-z0-9_-]{22,32}$/;
const phases = [
  'request_started',
  'headers_started',
  'headers_resolved',
  'headers_failed',
  'continue_started',
  'continue_resolved',
  'continue_rejected',
  'response_headers',
  'response_body_finished',
  'response_body_failed',
  'request_finished',
  'request_failed',
  'sizes_observed',
  'sizes_unavailable',
] as const;
export type Web17TransportPhase = (typeof phases)[number];
type Metadata = { status?: number; responseBodyBytes?: number; nonceHeaderInjected?: boolean };
type Event = Metadata & {
  sequence: number;
  nonce: string;
  phase: Web17TransportPhase;
  scenarioElapsedMs: number | null;
  sinceClickMs: number | null;
  sinceRequestMs: number | null;
};

/** Diagnostic failures must never change the observed browser flow. */
export function observeWeb17Safely(observe: () => void): void {
  try {
    observe();
  } catch {}
}

/** Covers synchronous setup/logging and asynchronous artifact failures alike. */
export async function emitWeb17Safely(emit: () => Promise<void>): Promise<void> {
  try {
    await emit();
  } catch {}
}

const errorClasses = ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'Error'] as const;
/** Discards input text; outputs fixed categories and numeric coordinates only. */
export function projectWeb17BrowserError(source: 'pageerror' | 'console', text: string) {
  const bounded = text.slice(0, 4096);
  const errorClass =
    errorClasses.find((name) => new RegExp(`\\b${name}\\b`).test(bounded)) ?? 'other';
  // Only literal repository filenames or the fixed Next static prefix are recognized.
  const match =
    /(?:scripts\/(web17-delayed-old-poll\.browser\.ts)|apps\/web\/(app\/chat\/all\/page\.tsx)|(_next\/static\/))[^\s)]*?:(\d{1,6}):(\d{1,6})(?:[\s)]|$)/.exec(
      bounded,
    );
  return {
    source,
    errorClass,
    location: match?.[1]
      ? 'web17_harness'
      : match?.[2]
        ? 'chat_all_page'
        : match?.[3]
          ? 'next_static'
          : 'unavailable',
    line: match ? Number(match[4]) : null,
    column: match ? Number(match[5]) : null,
  };
}

/** Passive, bounded metadata only; no URL, header or response body access. */
export function createWeb17TransportDiagnostics(now = () => performance.now()) {
  const readClock = (): number | null => {
    try {
      const value = now();
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  };
  const started = readClock();
  let clickAt: number | null = null;
  let requestAt: number | null = null;
  let remountAssertions: 'NOT_RUN' | 'STARTED' | 'PASSED' = 'NOT_RUN';
  const browserErrors: ReturnType<typeof projectWeb17BrowserError>[] = [];
  const delta = (at: number | null, origin: number | null) =>
    at === null || origin === null || at < origin
      ? null
      : Math.min(300_000, Math.floor(at - origin));
  const events: Event[] = [];
  let overflow = false;
  let selectedNonce: string | null = null;
  let result: 'passed' | 'failed' | 'interrupted' | null = null;
  const snapshot = () => ({
    version: 2,
    boundary: 'before_cleanup',
    result,
    selectedNonce,
    // App-router data-ready markers do not expose the Node response lifecycle.
    serverTransport: 'NOT_INSTRUMENTED',
    requestStartObservation: requestAt === null ? 'unavailable' : 'observed',
    remountAssertions,
    browserErrorsAreUncorrelated: true,
    browserErrors: browserErrors.map((error) => ({ ...error })),
    overflow,
    events: events.map((event) => ({ ...event })),
  });
  const fits = (candidate: object) =>
    Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= WEB17_TRANSPORT_BYTE_CAP - 64;
  return {
    markClickAttempted() {
      if (!result && clickAt === null) clickAt = readClock();
    },
    markRemountAssertionsStarted() {
      if (!result) remountAssertions = 'STARTED';
    },
    recordBrowserError(source: 'pageerror' | 'console', text: string) {
      if (result) return;
      const error = projectWeb17BrowserError(source, text);
      if (
        browserErrors.length >= 8 ||
        !fits({ ...snapshot(), browserErrors: [...browserErrors, error] })
      ) {
        overflow = true;
        return;
      }
      browserErrors.push(error);
    },
    selectNonce(nonce: unknown) {
      if (
        result ||
        selectedNonce !== null ||
        typeof nonce !== 'string' ||
        !noncePattern.test(nonce)
      )
        return false;
      selectedNonce = nonce;
      return true;
    },
    recordRequestStart(nonce: unknown, observedAt: number | undefined) {
      if (result || nonce !== selectedNonce || requestAt !== null) return;
      requestAt =
        typeof observedAt === 'number' && Number.isFinite(observedAt) && observedAt >= 0
          ? observedAt
          : null;
      if (requestAt !== null) this.record(nonce, 'request_started', {}, requestAt);
    },
    record(
      nonce: unknown,
      phase: Web17TransportPhase,
      metadata: Metadata = {},
      observedAt?: number,
    ) {
      if (
        result ||
        typeof nonce !== 'string' ||
        nonce !== selectedNonce ||
        !noncePattern.test(nonce) ||
        !phases.includes(phase)
      )
        return;
      const at = observedAt ?? readClock();
      const event: Event = {
        sequence: events.length + 1,
        nonce,
        phase,
        scenarioElapsedMs: delta(at, started),
        sinceClickMs: delta(at, clickAt),
        sinceRequestMs: delta(at, requestAt),
      };
      if (Number.isInteger(metadata.status) && metadata.status! >= 100 && metadata.status! <= 599)
        event.status = metadata.status;
      if (
        Number.isSafeInteger(metadata.responseBodyBytes) &&
        metadata.responseBodyBytes! >= 0 &&
        metadata.responseBodyBytes! <= 1_000_000_000
      )
        event.responseBodyBytes = metadata.responseBodyBytes;
      if (typeof metadata.nonceHeaderInjected === 'boolean')
        event.nonceHeaderInjected = metadata.nonceHeaderInjected;
      if (
        events.length >= WEB17_TRANSPORT_EVENT_CAP ||
        !fits({ ...snapshot(), events: [...events, event] })
      ) {
        overflow = true;
        return;
      }
      events.push(event);
    },
    seal(outcome: 'passed' | 'failed' | 'interrupted') {
      if (!result && outcome === 'passed') remountAssertions = 'PASSED';
      result ??= outcome;
    },
    snapshot,
  };
}

/** Navigation-counter saturation must not suppress the separate transport observation. */
export function selectWeb17TransportCandidate(
  transport: ReturnType<typeof createWeb17TransportDiagnostics>,
  candidate: { nonce: string; prefetch: boolean; clickAttempted: boolean | null },
): boolean {
  return (
    candidate.clickAttempted === true &&
    !candidate.prefetch &&
    transport.selectNonce(candidate.nonce)
  );
}
