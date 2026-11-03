import { randomUUID } from 'node:crypto';

export type MemoryLibraryPhase =
  | 'overall'
  | 'auth'
  | 'config'
  | 'pre_fence'
  | 'owner_guard'
  | 'list'
  | 'filters'
  | 'post_fence'
  | 'serialize';

// This route invokes at most ten phases: route overall/auth/config/serialize plus Firestore
// config/pre_fence/owner_guard/list/filters/post_fence. At most three can fail and log in one
// request: list and filters may fail together, followed by overall. Successes emit no records.

export interface MemoryLibraryDiagnosticContext {
  readonly requestId: string;
  readonly revision?: string;
}

const SAFE_ERROR_CODES = new Set([
  'ABORTED',
  'DEADLINE_EXCEEDED',
  'ECONNRESET',
  'ETIMEDOUT',
  'FAILED_PRECONDITION',
  'FIRESTORE_PROFILE_READ_LIMIT',
  'PERMISSION_DENIED',
  'POSTGRES_PROFILE_LIBRARY_FILTER_LIMIT',
  'RESOURCE_EXHAUSTED',
  'UNAVAILABLE',
  'UNAUTHENTICATED',
  '57014',
]);
const SAFE_GRPC_CODES: Readonly<Record<number, string>> = {
  4: 'DEADLINE_EXCEEDED',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  14: 'UNAVAILABLE',
  16: 'UNAUTHENTICATED',
};

function safeRevision(value: string | undefined): string | undefined {
  return value && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value) ? value : undefined;
}

export function createMemoryLibraryDiagnosticContext(): MemoryLibraryDiagnosticContext {
  const revision = safeRevision(process.env.K_REVISION);
  return Object.freeze({
    requestId: randomUUID(),
    ...(revision ? { revision } : {}),
  });
}

function safeErrorCode(error: unknown): string {
  try {
    if (!error || typeof error !== 'object' || !('code' in error)) return 'UNCLASSIFIED';
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return SAFE_GRPC_CODES[code] ?? 'UNCLASSIFIED';
    if (typeof code !== 'string') return 'UNCLASSIFIED';
    if (SAFE_ERROR_CODES.has(code)) return code;
    const numeric = Number(code);
    return Number.isInteger(numeric)
      ? (SAFE_GRPC_CODES[numeric] ?? 'UNCLASSIFIED')
      : 'UNCLASSIFIED';
  } catch {
    return 'UNCLASSIFIED';
  }
}

export async function withMemoryLibraryPhase<T>(
  context: MemoryLibraryDiagnosticContext,
  phase: MemoryLibraryPhase,
  operation: () => T | Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } catch (error) {
    const event = {
      event: 'memory_library_phase',
      requestId: context.requestId,
      ...(context.revision ? { revision: context.revision } : {}),
      phase,
      outcome: 'error',
      elapsedMs: Math.round(Math.max(0, performance.now() - startedAt) * 100) / 100,
      errorCode: safeErrorCode(error),
    };
    try {
      console.info(JSON.stringify(event));
    } catch {
      // Diagnostics must never replace the library's original error.
    }
    throw error;
  }
}
