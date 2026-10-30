/** Fixed, content-free failure diagnostics. Never serialize an exception or provider payload. */
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
  try {
    if (error instanceof InventoryHttpError) {
      errorClass = 'HttpError';
      if (
        typeof error.status === 'number' &&
        Number.isInteger(error.status) &&
        error.status >= 100 &&
        error.status <= 599
      )
        httpStatus = error.status;
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
    readiness: 'unknown',
    authorityEstablished: false,
    mutationAuthorized: false,
  };
}
