export const WEB17_TRANSPORT_BYTE_CAP = 8_192;
export const WEB17_TRANSPORT_EVENT_CAP = 48;
const noncePattern = /^[A-Za-z0-9_-]{22,32}$/;
const phases = [
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
  elapsedMs: number;
};

/** Passive, bounded metadata only. Never accepts URLs, headers, bodies or error text. */
export function createWeb17TransportDiagnostics(now = () => performance.now()) {
  const started = now();
  const events: Event[] = [];
  let overflow = false;
  let selectedNonce: string | null = null;
  let result: 'passed' | 'failed' | 'interrupted' | null = null;
  const snapshot = () => ({
    version: 1,
    boundary: 'before_cleanup',
    result,
    selectedNonce,
    // App-router data-ready markers do not expose the Node response lifecycle.
    serverTransport: 'not_observed',
    overflow,
    events: events.map((event) => ({ ...event })),
  });
  return {
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
    record(nonce: unknown, phase: Web17TransportPhase, metadata: Metadata = {}) {
      if (
        result ||
        typeof nonce !== 'string' ||
        nonce !== selectedNonce ||
        !noncePattern.test(nonce) ||
        !phases.includes(phase)
      )
        return;
      const elapsed = now() - started;
      const event: Event = {
        sequence: events.length + 1,
        nonce,
        phase,
        elapsedMs: Number.isFinite(elapsed)
          ? Math.min(300_000, Math.max(0, Math.floor(elapsed)))
          : 0,
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
        Buffer.byteLength(JSON.stringify({ ...snapshot(), events: [...events, event] }), 'utf8') >
          WEB17_TRANSPORT_BYTE_CAP - 64
      ) {
        overflow = true;
        return;
      }
      events.push(event);
    },
    seal(outcome: 'passed' | 'failed' | 'interrupted') {
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
