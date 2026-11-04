import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

export const WEB17_PREVIEW_LOG_BYTE_CAP = 64 * 1024;
export const WEB17_PREVIEW_LINE_CAP = 256;
export const WEB17_PREVIEW_COUNT_CAP = 8;
export const WEB17_PREVIEW_CHAT_ALL_STAGE_EVENT_CAP = 40;

const routes = ['api_health', 'chat_home', 'chat_all', 'chat_detail'] as const;
const chatAllPhases = new Set([
  'request_received',
  'auth_started',
  'auth_completed',
  'auth_failed',
  'search_params_started',
  'search_params_completed',
  'search_params_failed',
  'history_started',
  'history_completed',
  'history_failed',
  'page_data_ready',
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
]);
const chatAllElapsedBuckets = new Set([
  'under_1s',
  'under_5s',
  'under_20s',
  '20s_or_more',
  'unknown',
]);
const chatAllStageMarker = '[WEB17_CHAT_ALL_STAGE] ';
const chatAllNonce = /^[A-Za-z0-9_-]{22,32}$/;
type Route = (typeof routes)[number];
type DurationBucket = 'under_1s' | 'under_5s' | 'under_20s' | '20s_or_more' | 'unknown';

type RouteDiagnostics = {
  compileStarted: number;
  compiled: number;
  compileDuration: Record<DurationBucket, number>;
  completedResponses: number;
  responseStatus: { success: number; redirect: number; clientError: number; serverError: number };
};

export type Web17PreviewDiagnostics = {
  kind: 'WEB17_PREVIEW_DIAGNOSTICS';
  logAvailable: boolean;
  inputTruncated: boolean;
  linesScanned: number;
  overflow: boolean;
  readyMarkers: number;
  routes: Record<Route, RouteDiagnostics>;
  serverStageStatus: 'unavailable' | 'no_matching_event' | 'observed' | 'incomplete';
  chatAllStageEvents: Array<{
    kind: 'WEB17_CHAT_ALL_STAGE';
    nonce: string;
    prefetch: boolean;
    phase: string;
    elapsed: DurationBucket;
  }>;
  errors: {
    compileFailure: number;
    moduleResolution: number;
    syntax: number;
    runtime: number;
    other: number;
  };
};

function emptyRoute(): RouteDiagnostics {
  return {
    compileStarted: 0,
    compiled: 0,
    compileDuration: {
      under_1s: 0,
      under_5s: 0,
      under_20s: 0,
      '20s_or_more': 0,
      unknown: 0,
    },
    completedResponses: 0,
    responseStatus: { success: 0, redirect: 0, clientError: 0, serverError: 0 },
  };
}

function classifyRoute(value: string): Route | undefined {
  const pathname = value.split(/[?#]/, 1)[0] ?? '';
  if (pathname === '/api/health') return 'api_health';
  if (pathname === '/chat') return 'chat_home';
  if (pathname === '/chat/all') return 'chat_all';
  if (/^\/chat\/[^/]+$/.test(pathname) && pathname !== '/chat/all') return 'chat_detail';
  return undefined;
}

function durationBucket(value: string): DurationBucket {
  const match = /\bin\s+(-?\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(value);
  if (!match) return 'unknown';
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return 'unknown';
  const milliseconds = match[2]?.toLowerCase() === 's' ? amount * 1_000 : amount;
  if (milliseconds < 1_000) return 'under_1s';
  if (milliseconds < 5_000) return 'under_5s';
  if (milliseconds < 20_000) return 'under_20s';
  return '20s_or_more';
}

function createResult(logAvailable: boolean, inputTruncated: boolean): Web17PreviewDiagnostics {
  return {
    kind: 'WEB17_PREVIEW_DIAGNOSTICS',
    logAvailable,
    inputTruncated,
    linesScanned: 0,
    overflow: false,
    readyMarkers: 0,
    routes: Object.fromEntries(routes.map((route) => [route, emptyRoute()])) as Record<
      Route,
      RouteDiagnostics
    >,
    serverStageStatus: !logAvailable
      ? 'unavailable'
      : inputTruncated
        ? 'incomplete'
        : 'no_matching_event',
    chatAllStageEvents: [],
    errors: { compileFailure: 0, moduleResolution: 0, syntax: 0, runtime: 0, other: 0 },
  };
}

function increment(value: number, result: Web17PreviewDiagnostics): number {
  if (value >= WEB17_PREVIEW_COUNT_CAP) {
    result.overflow = true;
    return WEB17_PREVIEW_COUNT_CAP;
  }
  return value + 1;
}

function recordError(line: string, result: Web17PreviewDiagnostics): void {
  let key: keyof Web17PreviewDiagnostics['errors'] | undefined;
  if (/failed to compile|compilation failed|build failed/i.test(line)) key = 'compileFailure';
  else if (/module not found|cannot find module|can't resolve/i.test(line))
    key = 'moduleResolution';
  else if (/syntaxerror|parsing error/i.test(line)) key = 'syntax';
  else if (/typeerror|referenceerror|uncaughtexception|\berror:/i.test(line)) key = 'runtime';
  else if (/\berror\b|\bfatal\b/i.test(line)) key = 'other';
  if (key) result.errors[key] = increment(result.errors[key], result);
}

/** Extracts only fixed route/error categories; input lines and values never appear in output. */
export function projectWeb17PreviewDiagnostics(
  input: unknown,
  options: { logAvailable?: boolean; inputTruncated?: boolean } = {},
): Web17PreviewDiagnostics {
  if (typeof input !== 'string')
    return createResult(options.logAvailable ?? false, options.inputTruncated ?? false);

  const overByteCap = Buffer.byteLength(input, 'utf8') > WEB17_PREVIEW_LOG_BYTE_CAP;
  const text = overByteCap ? input.slice(-WEB17_PREVIEW_LOG_BYTE_CAP) : input;
  const rawLines = text.split(/\r?\n/);
  const overLineCap = rawLines.length > WEB17_PREVIEW_LINE_CAP;
  const lines = overLineCap ? rawLines.slice(-WEB17_PREVIEW_LINE_CAP) : rawLines;
  const result = createResult(
    options.logAvailable ?? true,
    options.inputTruncated === true || overByteCap || overLineCap,
  );
  result.linesScanned = lines.length;

  for (const rawLine of lines) {
    const line = stripVTControlCharacters(rawLine);
    const markerIndex = line.indexOf(chatAllStageMarker);
    if (markerIndex >= 0) {
      const encoded = line.slice(markerIndex + chatAllStageMarker.length);
      if (encoded.length > 512) {
        result.overflow = true;
        result.serverStageStatus = 'incomplete';
      } else {
        try {
          const candidate = JSON.parse(encoded) as Record<string, unknown>;
          const keys = Object.keys(candidate).sort();
          const valid =
            keys.join(',') === 'elapsed,kind,nonce,phase,prefetch' &&
            candidate.kind === 'WEB17_CHAT_ALL_STAGE' &&
            typeof candidate.nonce === 'string' &&
            chatAllNonce.test(candidate.nonce) &&
            typeof candidate.prefetch === 'boolean' &&
            typeof candidate.phase === 'string' &&
            chatAllPhases.has(candidate.phase) &&
            typeof candidate.elapsed === 'string' &&
            chatAllElapsedBuckets.has(candidate.elapsed);
          if (valid) {
            if (result.chatAllStageEvents.length >= WEB17_PREVIEW_CHAT_ALL_STAGE_EVENT_CAP) {
              result.overflow = true;
              result.serverStageStatus = 'incomplete';
            } else {
              result.chatAllStageEvents.push({
                kind: 'WEB17_CHAT_ALL_STAGE',
                nonce: candidate.nonce as string,
                prefetch: candidate.prefetch as boolean,
                phase: candidate.phase as string,
                elapsed: candidate.elapsed as DurationBucket,
              });
              if (result.serverStageStatus !== 'incomplete') result.serverStageStatus = 'observed';
            }
          } else {
            result.overflow = true;
            result.serverStageStatus = 'incomplete';
          }
        } catch {
          result.overflow = true;
          result.serverStageStatus = 'incomplete';
        }
      }
    }
    if (/\bready in\b/i.test(line)) result.readyMarkers = increment(result.readyMarkers, result);

    const compileStarted = /\bcompiling\s+(\/[^\s]+)/i.exec(line)?.[1];
    if (compileStarted) {
      const route = classifyRoute(compileStarted);
      if (route) {
        const row = result.routes[route];
        row.compileStarted = increment(row.compileStarted, result);
      }
    }

    const compiled = /\bcompiled\s+(\/[^\s]+)/i.exec(line)?.[1];
    if (compiled) {
      const route = classifyRoute(compiled);
      if (route) {
        const row = result.routes[route];
        row.compiled = increment(row.compiled, result);
        const bucket = durationBucket(line);
        row.compileDuration[bucket] = increment(row.compileDuration[bucket], result);
      }
    }

    const response = /\bGET\s+(\/[^\s]+)\s+(\d{3})\b/i.exec(line);
    if (response?.[1] && response[2]) {
      const route = classifyRoute(response[1]);
      const status = Number(response[2]);
      if (route) {
        const row = result.routes[route];
        row.completedResponses = increment(row.completedResponses, result);
        if (status >= 200 && status < 300)
          row.responseStatus.success = increment(row.responseStatus.success, result);
        else if (status >= 300 && status < 400)
          row.responseStatus.redirect = increment(row.responseStatus.redirect, result);
        else if (status >= 400 && status < 500)
          row.responseStatus.clientError = increment(row.responseStatus.clientError, result);
        else if (status >= 500 && status < 600)
          row.responseStatus.serverError = increment(row.responseStatus.serverError, result);
      }
    }

    recordError(line, result);
  }
  return result;
}

function readTail(path: string): { text: string; truncated: boolean } | undefined {
  let descriptor: number | undefined;
  try {
    const stats = statSync(path);
    const length = Math.min(stats.size, WEB17_PREVIEW_LOG_BYTE_CAP);
    descriptor = openSync(path, 'r');
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, Math.max(0, stats.size - length));
    return { text: buffer.toString('utf8'), truncated: stats.size > length };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function runCli(): void {
  const path = process.argv[2];
  const tail = path ? readTail(resolve(path)) : undefined;
  const diagnostics = projectWeb17PreviewDiagnostics(tail?.text, {
    logAvailable: Boolean(tail),
    inputTruncated: tail?.truncated ?? false,
  });
  process.stdout.write(`[WEB-17] ${JSON.stringify(diagnostics)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli();
