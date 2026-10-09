const STORAGE_PREFIX = 'assistant:card-refresh:v1:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CardRefreshOperationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredRefreshOperation {
  operationId: string;
  taskId?: string;
}

function storageKey(cardId: string, revisionId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(cardId)}:${encodeURIComponent(revisionId)}`;
}

function readOperation(value: string | null): StoredRefreshOperation | undefined {
  if (value === null) return undefined;
  try {
    const row: unknown = JSON.parse(value);
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new Error('Saved-card refresh receipt is malformed');
    const record = row as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== 'operationId' && key !== 'taskId') ||
      typeof record.operationId !== 'string' ||
      !UUID_RE.test(record.operationId) ||
      ('taskId' in record && (typeof record.taskId !== 'string' || !UUID_RE.test(record.taskId)))
    )
      throw new Error('Saved-card refresh receipt is malformed');
    return {
      operationId: record.operationId,
      ...(typeof record.taskId === 'string' ? { taskId: record.taskId } : {}),
    };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Saved-card refresh receipt is malformed');
    throw error;
  }
}

/**
 * Keeps a retry on the same operation while its task result is unknown or active.
 * A new operation is allowed only after the acknowledged task itself is terminal.
 */
export function cardRefreshOperationId(
  cardId: string,
  revisionId: string,
  storage: CardRefreshOperationStorage,
  createId: () => string,
  state: { refreshState?: unknown; refreshTaskId?: unknown } = {},
): string {
  if (!cardId || !revisionId) throw new Error('Card and revision identity are required');
  const key = storageKey(cardId, revisionId);
  const existing = readOperation(storage.getItem(key));
  const terminal =
    (state.refreshState === 'idle' || state.refreshState === 'failed') &&
    typeof state.refreshTaskId === 'string' &&
    UUID_RE.test(state.refreshTaskId);
  const terminalTaskMatches = terminal && existing?.taskId === state.refreshTaskId;
  if (existing && !terminalTaskMatches) return existing.operationId;

  const operationId = createId();
  if (!UUID_RE.test(operationId)) throw new Error('A valid refresh operation ID is unavailable');
  const next: StoredRefreshOperation = { operationId };
  storage.setItem(key, JSON.stringify(next));
  return operationId;
}

/** Record the task receipt without changing an operation created by a newer view. */
export function recordCardRefreshTask(
  cardId: string,
  revisionId: string,
  operationId: string,
  taskId: string,
  storage: CardRefreshOperationStorage,
): void {
  if (!UUID_RE.test(operationId) || !UUID_RE.test(taskId))
    throw new Error('A valid refresh task receipt is required');
  const key = storageKey(cardId, revisionId);
  const existing = readOperation(storage.getItem(key));
  if (!existing || existing.operationId !== operationId) return;
  storage.setItem(key, JSON.stringify({ ...existing, taskId }));
}

export class CardRefreshReceiptStorageError extends Error {
  constructor(readonly taskId: string) {
    super('Refresh started but its task receipt could not be saved in this tab');
  }
}

export async function submitCardRefresh<T extends { ok: boolean; taskId?: string }>(input: {
  cardId: string;
  revisionId: string;
  state: { refreshState?: unknown; refreshTaskId?: unknown };
  storage: CardRefreshOperationStorage;
  createId: () => string;
  send: (cardId: string, revisionId: string, operationId: string) => Promise<T>;
}): Promise<T> {
  const operationId = cardRefreshOperationId(
    input.cardId,
    input.revisionId,
    input.storage,
    input.createId,
    input.state,
  );
  const result = await input.send(input.cardId, input.revisionId, operationId);
  if (result.ok) {
    if (!result.taskId) throw new Error('Refresh task receipt is missing');
    try {
      recordCardRefreshTask(
        input.cardId,
        input.revisionId,
        operationId,
        result.taskId,
        input.storage,
      );
    } catch {
      throw new CardRefreshReceiptStorageError(result.taskId);
    }
  }
  return result;
}
