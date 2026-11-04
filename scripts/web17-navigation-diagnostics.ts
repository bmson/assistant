import { z } from 'zod';

export const WEB17_NAVIGATION_DIAGNOSTIC_CAP = 8;
export const WEB17_RSC_ATTEMPT_NONCE_HEADER = 'x-web17-attempt';

export type Web17PathClass =
  | 'all_chats'
  | 'fixture_chat'
  | 'other_same_origin'
  | 'off_origin'
  | 'unknown';

const requestClasses = ['document', 'rsc', 'other'] as const;
const statusClasses = ['success', 'redirect', 'client_error', 'server_error', 'other'] as const;
const failureClasses = ['aborted', 'blocked', 'timeout', 'connection', 'other'] as const;
const count = z.number().int().min(0).max(WEB17_NAVIGATION_DIAGNOSTIC_CAP);
const statusCounts = z
  .object({
    success: count,
    redirect: count,
    client_error: count,
    server_error: count,
    other: count,
  })
  .strict();
const failureCounts = z
  .object({ aborted: count, blocked: count, timeout: count, connection: count, other: count })
  .strict();
const requestCounts = z
  .object({
    started: count,
    finished: count,
    failed: count,
    responseStatus: statusCounts,
    requestFailure: failureCounts,
  })
  .strict();
const requestGroups = z
  .object({ document: requestCounts, rsc: requestCounts, other: requestCounts })
  .strict();
const transitions = z
  .object({ all_chats: count, fixture_chat: count, other_same_origin: count, off_origin: count })
  .strict();
const correlationNonce = z.string().regex(/^[A-Za-z0-9_-]{22,32}$/);
const correlatedAttempt = z
  .object({
    nonce: correlationNonce,
    prefetch: z.boolean(),
    startedAfterClickAttempt: z.boolean(),
    finished: z.boolean(),
    failed: z.boolean(),
    responseStatus: z.enum(statusClasses).nullable(),
  })
  .strict();
const diagnosticsSchema = z
  .object({
    observerAvailable: z.boolean().nullable(),
    allChatsLinkCount: count.nullable(),
    allChatsLinkTargetMatches: z.boolean().nullable(),
    clickAttempted: z.boolean().nullable(),
    clickCompleted: z.boolean().nullable(),
    aggregateEventCountsAreUncorrelatedObservations: z.literal(true),
    mainFrameExpectedRouteCommitted: z.boolean().nullable(),
    mainFrameTransitions: transitions.nullable(),
    requests: requestGroups.nullable(),
    correlatedRscAttempts: z.array(correlatedAttempt).max(WEB17_NAVIGATION_DIAGNOSTIC_CAP),
    selectedPostClickNonPrefetchCandidateNonce: correlationNonce.nullable(),
    pageErrorCount: count.nullable(),
    overflow: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.allChatsLinkCount !== 1 && value.allChatsLinkTargetMatches !== null)
      context.addIssue({ code: 'custom', message: 'link target requires exactly one link' });
    const observed = value.observerAvailable === true;
    if (
      observed !== (value.mainFrameTransitions !== null) ||
      observed !== (value.requests !== null) ||
      (!observed && value.mainFrameExpectedRouteCommitted !== null)
    )
      context.addIssue({ code: 'custom', message: 'observer state does not match event fields' });
  });

export type Web17NavigationDiagnosticsSnapshot = z.infer<typeof diagnosticsSchema>;
type RequestGroups = NonNullable<Web17NavigationDiagnosticsSnapshot['requests']>;
type MainFrameTransitions = NonNullable<Web17NavigationDiagnosticsSnapshot['mainFrameTransitions']>;

function safeURL(value: unknown, maxLength: number): URL | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

export function classifyWeb17Path(
  value: unknown,
  expectedOrigin: string,
  fixtureChatPath: string,
): Web17PathClass {
  const url = safeURL(value, 8_192);
  const base = safeURL(expectedOrigin, 2_048);
  if (
    !url ||
    !base ||
    fixtureChatPath.length > 512 ||
    !fixtureChatPath.startsWith('/chat/') ||
    fixtureChatPath === '/chat/all'
  )
    return 'unknown';
  if (url.origin !== base.origin) return 'off_origin';
  if (url.pathname === '/chat/all') return 'all_chats';
  if (url.pathname === fixtureChatPath) return 'fixture_chat';
  return 'other_same_origin';
}

/** Playwright-serializable observation; the DOM href is never returned to Node. */
export function observeWeb17AllChatsLinks(
  elements: ArrayLike<{ getAttribute(name: string): string | null }>,
  expectedOrigin: string,
): { count: number | null; matches: boolean | null } {
  const count = elements.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > 8) return { count: null, matches: null };
  if (count !== 1) return { count, matches: null };
  const href = elements[0]?.getAttribute('href');
  if (!href || href.length > 2_048) return { count, matches: null };
  try {
    const target = new URL(href, expectedOrigin);
    return {
      count,
      matches: target.origin === expectedOrigin && target.pathname === '/chat/all',
    };
  } catch {
    return { count, matches: null };
  }
}

const resourceTypes = new Set([
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
  'other',
]);
const zeros = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, 0]));
const emptyRequests = (): RequestGroups =>
  Object.fromEntries(
    requestClasses.map((key) => [
      key,
      {
        started: 0,
        finished: 0,
        failed: 0,
        responseStatus: zeros(statusClasses),
        requestFailure: zeros(failureClasses),
      },
    ]),
  ) as RequestGroups;

function statusClass(status: unknown): (typeof statusClasses)[number] {
  if (!Number.isSafeInteger(status)) return 'other';
  const code = Number(status);
  if (code >= 200 && code < 300) return 'success';
  if (code >= 300 && code < 400) return 'redirect';
  if (code >= 400 && code < 500) return 'client_error';
  if (code >= 500 && code < 600) return 'server_error';
  return 'other';
}

function failureClass(value: unknown): (typeof failureClasses)[number] {
  if (typeof value !== 'string' || value.length > 128) return 'other';
  if (value === 'net::ERR_ABORTED') return 'aborted';
  if (value === 'net::ERR_BLOCKED_BY_CLIENT') return 'blocked';
  if (value === 'net::ERR_TIMED_OUT') return 'timeout';
  if (
    /^net::ERR_(?:CONNECTION|NAME_NOT_RESOLVED|NETWORK_CHANGED|INTERNET_DISCONNECTED)/.test(value)
  )
    return 'connection';
  return 'other';
}

export function projectWeb17NavigationDiagnostics(
  value: unknown,
): Web17NavigationDiagnosticsSnapshot | null {
  try {
    const result = diagnosticsSchema.safeParse(value);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function createWeb17NavigationDiagnostics(expectedOrigin: string) {
  const origin = safeURL(expectedOrigin, 2_048)?.origin ?? null;
  let fixtureChatPath: string | null = null;
  let observerAvailable: boolean | null = null;
  let allChatsLinkCount: number | null = null;
  let allChatsLinkTargetMatches: boolean | null = null;
  let clickAttempted: boolean | null = null;
  let clickCompleted: boolean | null = null;
  let mainFrameExpectedRouteCommitted: boolean | null = null;
  let pageErrorCount: number | null = null;
  let overflow = false;
  const correlatedRscAttempts: Array<z.infer<typeof correlatedAttempt>> = [];
  const mainFrameTransitions = zeros([
    'all_chats',
    'fixture_chat',
    'other_same_origin',
    'off_origin',
  ]) as MainFrameTransitions;
  const requests = emptyRequests();
  const increment = (value: number) => {
    if (value >= WEB17_NAVIGATION_DIAGNOSTIC_CAP) {
      overflow = true;
      return WEB17_NAVIGATION_DIAGNOSTIC_CAP;
    }
    return value + 1;
  };
  const classifyRequest = (value: unknown, type: unknown, navigation: unknown) => {
    const url = safeURL(value, 8_192);
    if (!url || !origin) {
      observerAvailable = false;
      mainFrameExpectedRouteCommitted = null;
      return null;
    }
    if (url.origin !== origin || url.pathname !== '/chat/all') return null;
    if (typeof type !== 'string' || !resourceTypes.has(type)) {
      observerAvailable = false;
      mainFrameExpectedRouteCommitted = null;
      return null;
    }
    return navigation === true && type === 'document'
      ? 'document'
      : url.searchParams.has('_rsc')
        ? 'rsc'
        : 'other';
  };
  return {
    setObserverAvailable(value: unknown) {
      observerAvailable = typeof value === 'boolean' ? value : null;
      if (observerAvailable !== true) mainFrameExpectedRouteCommitted = null;
    },
    setAllChatsLinkObservation(value: unknown, targetMatches: unknown) {
      if (
        Number.isSafeInteger(value) &&
        Number(value) >= 0 &&
        Number(value) <= WEB17_NAVIGATION_DIAGNOSTIC_CAP
      )
        allChatsLinkCount = Number(value);
      else {
        allChatsLinkCount = null;
        if (Number.isSafeInteger(value) && Number(value) > WEB17_NAVIGATION_DIAGNOSTIC_CAP)
          overflow = true;
      }
      allChatsLinkTargetMatches =
        allChatsLinkCount === 1 && typeof targetMatches === 'boolean' ? targetMatches : null;
    },
    markClickAttempted() {
      clickAttempted = true;
    },
    recordRscAttemptStarted(nonce: unknown, prefetch: unknown) {
      if (typeof nonce !== 'string' || !correlationNonce.safeParse(nonce).success) {
        overflow = true;
        return false;
      }
      if (
        typeof prefetch !== 'boolean' ||
        correlatedRscAttempts.some((item) => item.nonce === nonce)
      ) {
        overflow = true;
        return false;
      }
      if (correlatedRscAttempts.length >= WEB17_NAVIGATION_DIAGNOSTIC_CAP) {
        overflow = true;
        return false;
      }
      correlatedRscAttempts.push({
        nonce,
        prefetch,
        startedAfterClickAttempt: clickAttempted === true,
        finished: false,
        failed: false,
        responseStatus: null,
      });
      return true;
    },
    recordRscAttemptFinished(nonce: unknown) {
      if (typeof nonce !== 'string') return;
      const attempt = correlatedRscAttempts.find((item) => item.nonce === nonce);
      if (attempt) attempt.finished = true;
    },
    recordRscAttemptFailed(nonce: unknown) {
      if (typeof nonce !== 'string') return;
      const attempt = correlatedRscAttempts.find((item) => item.nonce === nonce);
      if (attempt) attempt.failed = true;
    },
    recordRscAttemptResponse(nonce: unknown, status: unknown) {
      if (typeof nonce !== 'string') return;
      const attempt = correlatedRscAttempts.find((item) => item.nonce === nonce);
      if (attempt) attempt.responseStatus = statusClass(status);
    },
    setClickCompleted(value: unknown) {
      clickCompleted = typeof value === 'boolean' ? value : null;
    },
    setPageErrorCount(value: unknown) {
      if (!Number.isSafeInteger(value) || Number(value) < 0) pageErrorCount = null;
      else if (Number(value) > WEB17_NAVIGATION_DIAGNOSTIC_CAP) {
        pageErrorCount = WEB17_NAVIGATION_DIAGNOSTIC_CAP;
        overflow = true;
      } else pageErrorCount = Number(value);
    },
    setFixtureChatPath(value: unknown) {
      fixtureChatPath =
        typeof value === 'string' &&
        value.length <= 512 &&
        value.startsWith('/chat/') &&
        value !== '/chat/all'
          ? value
          : null;
    },
    recordMainFrameNavigation(value: unknown) {
      if (observerAvailable !== true) return;
      const url = safeURL(value, 8_192);
      if (!url || !origin) {
        observerAvailable = false;
        mainFrameExpectedRouteCommitted = null;
        return;
      }
      const key =
        url.origin !== origin
          ? 'off_origin'
          : url.pathname === '/chat/all'
            ? 'all_chats'
            : url.pathname === fixtureChatPath
              ? 'fixture_chat'
              : 'other_same_origin';
      mainFrameTransitions[key] = increment(mainFrameTransitions[key]);
      if (key === 'all_chats') mainFrameExpectedRouteCommitted = true;
    },
    finalizeExpectedRouteObservation() {
      if (observerAvailable !== true) mainFrameExpectedRouteCommitted = null;
      else if (mainFrameExpectedRouteCommitted !== true) mainFrameExpectedRouteCommitted = false;
    },
    recordRequestStarted(url: unknown, type: unknown, navigation: unknown) {
      if (observerAvailable !== true) return;
      const key = classifyRequest(url, type, navigation);
      if (key) requests[key].started = increment(requests[key].started);
    },
    recordRequestFinished(url: unknown, type: unknown, navigation: unknown) {
      if (observerAvailable !== true) return;
      const key = classifyRequest(url, type, navigation);
      if (key) requests[key].finished = increment(requests[key].finished);
    },
    recordRequestFailed(url: unknown, type: unknown, navigation: unknown, error: unknown) {
      if (observerAvailable !== true) return;
      const key = classifyRequest(url, type, navigation);
      if (!key) return;
      requests[key].failed = increment(requests[key].failed);
      const failure = failureClass(error);
      requests[key].requestFailure[failure] = increment(requests[key].requestFailure[failure]);
    },
    recordResponse(url: unknown, type: unknown, navigation: unknown, status: unknown) {
      if (observerAvailable !== true) return;
      const key = classifyRequest(url, type, navigation);
      if (key) {
        const statusKey = statusClass(status);
        requests[key].responseStatus[statusKey] = increment(
          requests[key].responseStatus[statusKey],
        );
      }
    },
    snapshot(): Web17NavigationDiagnosticsSnapshot {
      return {
        observerAvailable,
        allChatsLinkCount,
        allChatsLinkTargetMatches,
        clickAttempted,
        clickCompleted,
        aggregateEventCountsAreUncorrelatedObservations: true,
        mainFrameExpectedRouteCommitted:
          observerAvailable === true ? mainFrameExpectedRouteCommitted : null,
        mainFrameTransitions:
          observerAvailable === true ? structuredClone(mainFrameTransitions) : null,
        requests: observerAvailable === true ? structuredClone(requests) : null,
        correlatedRscAttempts: structuredClone(correlatedRscAttempts),
        // This is a temporal candidate after the click attempt boundary, not proof of causation.
        selectedPostClickNonPrefetchCandidateNonce:
          correlatedRscAttempts.find((item) => item.startedAfterClickAttempt && !item.prefetch)
            ?.nonce ?? null,
        pageErrorCount,
        overflow,
      };
    },
  };
}
