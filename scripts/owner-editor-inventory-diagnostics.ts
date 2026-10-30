/** Fixed, content-free failure diagnostics. Never serialize an exception or provider payload. */
import {
  InventoryServiceFactsError,
  sanitizeServiceAudit,
} from './owner-editor-service-facts-diagnostics.js';
export const INVENTORY_STAGES = [
  'arguments',
  'source_capability',
  'source_manifest',
  'protected_context',
  'credential_file',
  'cli_context',
  'cli_version',
  'cli_composites',
  'cli_fields',
  'access_token',
  'index_comparison',
  'database_metadata',
  'recovery_metadata',
  'agent_service',
  'agent_revision',
  'web_service',
  'web_revision',
  'editor_metadata',
  'receipt_serialization',
  'receipt_write',
  'release_readiness',
  'unknown',
] as const;
export type InventoryStage = (typeof INVENTORY_STAGES)[number];
export type InventoryStageMarker = (stage: InventoryStage) => void;
const stages: ReadonlySet<string> = new Set(INVENTORY_STAGES);
function ownValue(value: unknown, key: string): unknown {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
const processFailures = [
  'nonzero_exit',
  'spawn_failed',
  'timeout',
  'output_bound',
  'signal',
  'unknown',
] as const;
const signals = ['SIGKILL', 'SIGTERM', 'SIGINT', 'other'] as const;
const causes = [
  'argument_rejected',
  'auth_exchange_failed',
  'permission_denied',
  'resource_not_found',
  'output_bound',
  'unknown',
] as const;
function allowed<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
}
function exitCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 255
    ? value
    : null;
}
/** These are untrusted diagnostic hints, never evidence of permission or readiness. */
export class InventoryProcessError extends Error {
  readonly processFailure: (typeof processFailures)[number];
  readonly exitCode: number | null;
  readonly signalClass: (typeof signals)[number] | null;
  readonly causeHint: (typeof causes)[number];
  constructor(error: unknown) {
    super('Inventory command failed');
    const code = ownValue(error, 'code');
    const signal = ownValue(error, 'signal');
    const killed = ownValue(error, 'killed');
    const stderr = ownValue(error, 'stderr');
    this.exitCode = exitCode(code);
    this.signalClass = typeof signal === 'string' ? (allowed(signal, signals) ?? 'other') : null;
    this.processFailure =
      code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'output_bound'
        : killed === true && signal === 'SIGKILL'
          ? 'timeout'
          : this.exitCode !== null
            ? 'nonzero_exit'
            : code === 'ENOENT' || code === 'EACCES' || code === 'ENOEXEC'
              ? 'spawn_failed'
              : this.signalClass !== null
                ? 'signal'
                : 'unknown';
    const hint = typeof stderr === 'string' ? stderr.slice(0, 65536) : '';
    this.causeHint =
      this.processFailure === 'output_bound'
        ? 'output_bound'
        : /unrecognized arguments|invalid choice|unrecognized flag/i.test(hint)
          ? 'argument_rejected'
          : /invalid_grant|invalid_target|invalid_credential|error refreshing credentials|problem refreshing your current auth tokens|failed to retrieve subject token|unable to acquire impersonated credentials|reauthentication/i.test(
                hint,
              )
            ? 'auth_exchange_failed'
            : /PERMISSION_DENIED|does not have permission/i.test(hint)
              ? 'permission_denied'
              : /NOT_FOUND|resource not found/i.test(hint)
                ? 'resource_not_found'
                : 'unknown';
  }
}
const listFailures = ['invalid_json', 'not_array', 'count_bound'] as const;
export class InventoryListError extends Error {
  constructor(readonly listFailure: (typeof listFailures)[number]) {
    super('Inventory list rejected');
  }
}
const limitFailures = ['time_bound', 'output_bound'] as const;
export class InventoryLimitError extends Error {
  constructor(readonly limitFailure: (typeof limitFailures)[number]) {
    super('Inventory limit reached');
  }
}
export function parseInventoryList(raw: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InventoryListError('invalid_json');
  }
  if (!Array.isArray(value)) throw new InventoryListError('not_array');
  if (value.length > 1000) throw new InventoryListError('count_bound');
  return value;
}
export class InventoryHttpError extends Error {
  constructor(readonly status: number) {
    super('Inventory HTTP request unavailable');
    if (!Number.isInteger(status) || status < 100 || status > 599)
      throw new RangeError('Invalid HTTP status');
  }
}
export function inventoryFailureDiagnostic(stage: unknown, error: unknown) {
  let errorClass = 'UnknownError';
  let httpStatus: number | null = null;
  let detail = {};
  try {
    if (error instanceof InventoryServiceFactsError) {
      errorClass = 'ServiceFactsError';
      detail = { serviceFacts: sanitizeServiceAudit(ownValue(error, 'facts')) };
    } else if (error instanceof InventoryProcessError) {
      errorClass = 'ProcessError';
      detail = {
        processFailure: allowed(ownValue(error, 'processFailure'), processFailures) ?? 'unknown',
        exitCode: exitCode(ownValue(error, 'exitCode')),
        signalClass: allowed(ownValue(error, 'signalClass'), signals),
        causeHint: allowed(ownValue(error, 'causeHint'), causes) ?? 'unknown',
        diagnosticHintsOnly: true,
      };
    } else if (error instanceof InventoryListError) {
      errorClass = 'ListError';
      detail = { listFailure: allowed(ownValue(error, 'listFailure'), listFailures) ?? 'unknown' };
    } else if (error instanceof InventoryLimitError) {
      errorClass = 'LimitError';
      detail = {
        limitFailure: allowed(ownValue(error, 'limitFailure'), limitFailures) ?? 'unknown',
      };
    } else if (error instanceof InventoryHttpError) {
      errorClass = 'HttpError';
      const descriptor = Object.getOwnPropertyDescriptor(error, 'status');
      const status: unknown = descriptor && 'value' in descriptor ? descriptor.value : null;
      if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599)
        httpStatus = status;
    } else if (error instanceof SyntaxError) errorClass = 'SyntaxError';
    else if (error instanceof TypeError) errorClass = 'TypeError';
    else if (error instanceof RangeError) errorClass = 'RangeError';
    else if (error instanceof Error) errorClass = 'Error';
  } catch {
    /* Untrusted getters/prototypes cannot become diagnostic content. */
  }
  return {
    format: 1,
    outcome: 'inventory_failed',
    stage: typeof stage === 'string' && stages.has(stage) ? stage : 'unknown',
    errorClass,
    httpStatus,
    ...detail,
    readiness: 'unknown',
    authorityEstablished: false,
    mutationAuthorized: false,
  };
}
