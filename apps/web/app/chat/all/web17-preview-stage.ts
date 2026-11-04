import type { ChatHistoryStage } from '@assistant/application/chat';

export const WEB17_CHAT_ALL_STAGE_PREFIX = '[WEB17_CHAT_ALL_STAGE] ';
export const WEB17_CHAT_ALL_STAGE_EVENT_CAP = 20;

const requestStages = [
  'request_received',
  'auth_started',
  'auth_completed',
  'auth_failed',
  'search_params_completed',
  'search_params_failed',
  'history_started',
  'history_completed',
  'history_failed',
  'page_data_ready',
] as const;

const historyStages: readonly ChatHistoryStage[] = [
  'agent_started',
  'agent_completed',
  'agent_failed',
  'conversations_started',
  'conversations_completed',
  'conversations_failed',
  'archived_count_started',
  'archived_count_completed',
  'archived_count_failed',
  'scope_count_started',
  'scope_count_completed',
  'scope_count_failed',
  'active_ids_started',
  'active_ids_completed',
  'active_ids_failed',
];

export const WEB17_CHAT_ALL_PHASES = [...requestStages, ...historyStages] as const;
export type Web17ChatAllPhase = (typeof WEB17_CHAT_ALL_PHASES)[number];
export type Web17ElapsedBucket = 'under_1s' | 'under_5s' | 'under_20s' | '20s_or_more';

export type Web17ChatAllStageEvent = {
  kind: 'WEB17_CHAT_ALL_STAGE';
  nonce: string;
  prefetch: boolean;
  phase: Web17ChatAllPhase;
  elapsed: Web17ElapsedBucket;
};

export type Web17ChatAllStageObserver = {
  record(phase: Web17ChatAllPhase | ChatHistoryStage): void;
  recordHistoryStage(phase: ChatHistoryStage): void;
};

export function isWeb17ChatAllPreviewEnabled(input: {
  nodeEnv: unknown;
  previewEnabled: unknown;
  diagnosticsEnabled: unknown;
}): boolean {
  return (
    input.nodeEnv === 'development' &&
    input.previewEnabled === 'true' &&
    input.diagnosticsEnabled === '1'
  );
}

function isLoopbackHost(value: unknown): boolean {
  return (
    typeof value === 'string' && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(value)
  );
}

function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22,32}$/.test(value);
}

function isPhase(value: unknown): value is Web17ChatAllPhase {
  return typeof value === 'string' && (WEB17_CHAT_ALL_PHASES as readonly string[]).includes(value);
}

export function elapsedBucket(milliseconds: unknown): Web17ElapsedBucket {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0)
    return '20s_or_more';
  if (milliseconds < 1_000) return 'under_1s';
  if (milliseconds < 5_000) return 'under_5s';
  if (milliseconds < 20_000) return 'under_20s';
  return '20s_or_more';
}

export function createWeb17ChatAllStageObserver(input: {
  enabled: boolean;
  host: unknown;
  rsc: unknown;
  prefetch: unknown;
  nonce: unknown;
  now?: () => number;
  write?: (line: string) => void;
}): Web17ChatAllStageObserver | undefined {
  if (!input.enabled || !isLoopbackHost(input.host) || input.rsc !== '1' || !isNonce(input.nonce))
    return undefined;

  const nonce = input.nonce;
  const prefetch = typeof input.prefetch === 'string' && input.prefetch.length > 0;
  const now = input.now ?? (() => performance.now());
  const write = input.write ?? ((line: string) => console.error(line));
  let startedAt = Number.NaN;
  try {
    startedAt = now();
  } catch {
    // An unavailable clock must not prevent the page from rendering.
  }
  let events = 0;

  const record = (phase: Web17ChatAllPhase | ChatHistoryStage) => {
    if (!isPhase(phase) || events >= WEB17_CHAT_ALL_STAGE_EVENT_CAP) return;
    events += 1;
    let elapsed = Number.POSITIVE_INFINITY;
    try {
      elapsed = now() - startedAt;
    } catch {
      // An unavailable clock is represented by the coarsest bucket.
    }
    const event: Web17ChatAllStageEvent = {
      kind: 'WEB17_CHAT_ALL_STAGE',
      nonce,
      prefetch,
      phase,
      elapsed: elapsedBucket(elapsed),
    };
    try {
      write(`${WEB17_CHAT_ALL_STAGE_PREFIX}${JSON.stringify(event)}`);
    } catch {
      // Diagnostics are best-effort and cannot interrupt rendering.
    }
  };

  return { record, recordHistoryStage: record };
}

export function isWeb17ChatAllPhase(value: unknown): value is Web17ChatAllPhase {
  return isPhase(value);
}

export function isWeb17ChatAllNonce(value: unknown): value is string {
  return isNonce(value);
}
