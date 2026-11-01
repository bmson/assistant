import type { OwnerEditorCommand, OwnerEditorReply } from '@assistant/persistence/owner-editor';

export type OwnerEditorRoute =
  | '/api/people/editor'
  | '/api/profile/knowledge/family'
  | '/api/profile/knowledge/memory';

const COMMAND_ROUTE: Record<OwnerEditorCommand, OwnerEditorRoute> = {
  create_person: '/api/people/editor',
  update_person_identity: '/api/people/editor',
  remove_person: '/api/people/editor',
  add_family_relationship: '/api/profile/knowledge/family',
  correct_owner_family_relationship: '/api/profile/knowledge/family',
  remove_owner_family_relationship: '/api/profile/knowledge/family',
  correct_owner_memory: '/api/profile/knowledge/memory',
};

export function ownerEditorRoute(command: OwnerEditorCommand): OwnerEditorRoute {
  return COMMAND_ROUTE[command];
}

const COMMANDS = new Set<string>([
  'create_person',
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
  'remove_person',
  'remove_owner_family_relationship',
]);
const TERMINAL_OUTCOMES = new Set([
  'saved',
  'unchanged',
  'conflict',
  'invalid',
  'unavailable',
  'not_applied',
]);
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function stringMap(value: unknown): value is Record<string, string> {
  return record(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

/** Decode untrusted JSON without granting authority based on HTTP status or outcome wording. */
export function decodeOwnerEditorReply(value: unknown): OwnerEditorReply | null {
  if (!record(value) || value.version !== 1 || typeof value.authority !== 'string') return null;

  if (value.authority === 'operation_receipt') {
    if (
      !exactKeys(value, [
        'version',
        'authority',
        'command',
        'operationId',
        'requestHash',
        'statusVersion',
        'outcome',
        ...(value.outcome === 'saved' || value.outcome === 'unchanged'
          ? [
              'ids',
              'revision',
              ...(Object.hasOwn(value, 'refreshPending') ? ['refreshPending'] : []),
            ]
          : value.outcome === 'conflict' || value.outcome === 'unavailable'
            ? ['reason']
            : value.outcome === 'invalid'
              ? ['fieldErrors']
              : value.outcome === 'not_applied'
                ? ['reason']
                : []),
      ]) ||
      !COMMANDS.has(String(value.command)) ||
      !uuid(value.operationId) ||
      typeof value.requestHash !== 'string' ||
      !HEX_SHA256.test(value.requestHash) ||
      !Number.isSafeInteger(value.statusVersion) ||
      (value.statusVersion as number) < 1 ||
      !TERMINAL_OUTCOMES.has(String(value.outcome))
    )
      return null;
    if (value.outcome === 'saved' || value.outcome === 'unchanged') {
      if (
        !record(value.ids) ||
        Object.keys(value.ids).length === 0 ||
        !Object.values(value.ids).every(uuid) ||
        typeof value.revision !== 'string' ||
        !HEX_SHA256.test(value.revision) ||
        (Object.hasOwn(value, 'refreshPending') && typeof value.refreshPending !== 'boolean')
      )
        return null;
      const allowedIds = new Set([
        'contactId',
        'relationId',
        'previousRelationId',
        'memoryId',
        'assertionId',
      ]);
      if (Object.keys(value.ids).some((key) => !allowedIds.has(key))) return null;
      const requiredIds =
        value.command === 'create_person' ||
        value.command === 'update_person_identity' ||
        value.command === 'remove_person'
          ? ['contactId']
          : value.command === 'correct_owner_memory'
            ? ['memoryId']
            : ['relationId', 'memoryId', 'assertionId'];
      const ids = value.ids;
      if (requiredIds.some((key) => !uuid(ids[key]))) return null;
      if (value.command === 'correct_owner_memory' && Object.keys(ids).length !== 1) return null;
    } else if (value.outcome === 'conflict' || value.outcome === 'unavailable') {
      if (typeof value.reason !== 'string' || !value.reason) return null;
    } else if (value.outcome === 'invalid') {
      if (!stringMap(value.fieldErrors)) return null;
    } else if (value.reason !== 'claim_abandoned' && value.reason !== 'preparation_failed')
      return null;
    return value as unknown as OwnerEditorReply;
  }

  if (value.authority === 'scope_retirement') {
    if (
      !exactKeys(value, ['version', 'authority', 'command', 'operationId', 'outcome', 'reason']) ||
      !COMMANDS.has(String(value.command)) ||
      !uuid(value.operationId) ||
      value.outcome !== 'voided' ||
      !['scope_retired', 'replay_window_retired'].includes(String(value.reason))
    )
      return null;
    return value as unknown as OwnerEditorReply;
  }

  if (value.authority === 'request_rejection') {
    if (
      !exactKeys(value, [
        'version',
        'authority',
        'command',
        'operationId',
        'outcome',
        'originalOperationTerminal',
        'reason',
        ...(Object.hasOwn(value, 'fieldErrors') ? ['fieldErrors'] : []),
      ]) ||
      (value.command !== null && !COMMANDS.has(String(value.command))) ||
      (value.operationId !== null && !uuid(value.operationId)) ||
      !['invalid', 'conflict', 'unavailable'].includes(String(value.outcome)) ||
      value.originalOperationTerminal !== false ||
      typeof value.reason !== 'string' ||
      !value.reason ||
      (Object.hasOwn(value, 'fieldErrors') && !stringMap(value.fieldErrors))
    )
      return null;
    return value as unknown as OwnerEditorReply;
  }

  if (value.authority === 'unresolved') {
    if (
      !exactKeys(value, [
        'version',
        'authority',
        'command',
        'operationId',
        'outcome',
        'reason',
        ...(Object.hasOwn(value, 'receiptBindingToken') ? ['receiptBindingToken'] : []),
      ]) ||
      !COMMANDS.has(String(value.command)) ||
      !uuid(value.operationId) ||
      value.outcome !== 'outcome_unknown' ||
      !['preparing', 'receipt_unavailable', 'proof_changed', 'receipt_missing'].includes(
        String(value.reason),
      ) ||
      (Object.hasOwn(value, 'receiptBindingToken') &&
        (typeof value.receiptBindingToken !== 'string' || !value.receiptBindingToken))
    )
      return null;
    return value as unknown as OwnerEditorReply;
  }
  return null;
}

export interface OwnerEditorPendingMarker {
  id: string;
  command: OwnerEditorCommand;
  targetId: string | null;
}

export interface OwnerEditorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function markerKey(ownerId: string, formSessionScope: string): string {
  if (!ownerId || !formSessionScope) throw new Error('Owner editor scope is required.');
  return `owner-editor:v1:${encodeURIComponent(ownerId)}:${encodeURIComponent(formSessionScope)}`;
}

function decodeMarker(raw: string): OwnerEditorPendingMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Pending owner editor marker is malformed.');
  }
  if (
    !record(parsed) ||
    !exactKeys(parsed, ['id', 'command', 'targetId']) ||
    typeof parsed.id !== 'string' ||
    !parsed.id ||
    !COMMANDS.has(String(parsed.command)) ||
    (parsed.targetId !== null && !uuid(parsed.targetId))
  ) {
    throw new Error('Pending owner editor marker is invalid.');
  }
  return parsed as unknown as OwnerEditorPendingMarker;
}

export function readOwnerEditorPendingMarker(
  storage: OwnerEditorStorage,
  ownerId: string,
  formSessionScope: string,
): OwnerEditorPendingMarker | null {
  const raw = storage.getItem(markerKey(ownerId, formSessionScope));
  return raw === null ? null : decodeMarker(raw);
}

/** Persist and read back before allowing an apply request to be dispatched. */
export function writeOwnerEditorPendingMarker(
  storage: OwnerEditorStorage,
  ownerId: string,
  formSessionScope: string,
  marker: OwnerEditorPendingMarker,
): void {
  const key = markerKey(ownerId, formSessionScope);
  if (
    !marker.id ||
    !COMMANDS.has(marker.command) ||
    (marker.targetId !== null && !uuid(marker.targetId))
  ) {
    throw new Error('Pending owner editor marker is invalid.');
  }
  const existing = storage.getItem(key);
  if (existing !== null) {
    decodeMarker(existing);
    throw new Error('An owner editor operation is already pending.');
  }
  const serialized = JSON.stringify({
    id: marker.id,
    command: marker.command,
    targetId: marker.targetId,
  });
  storage.setItem(key, serialized);
  const readback = storage.getItem(key);
  if (readback !== serialized || JSON.stringify(decodeMarker(readback ?? '')) !== serialized) {
    throw new Error('Pending owner editor marker could not be verified.');
  }
}

/** Clear only when the response authoritatively names this exact original operation. */
export function mayClearOwnerEditorPendingMarker(
  reply: OwnerEditorReply | null,
  marker: OwnerEditorPendingMarker,
  originalOperationId: string,
  originalRequestHash: string,
): boolean {
  if (!reply || reply.command !== marker.command || reply.operationId !== originalOperationId)
    return false;
  if (reply.authority === 'scope_retirement') return true;
  return (
    reply.authority === 'operation_receipt' &&
    reply.requestHash === originalRequestHash &&
    reply.statusVersion >= 1
  );
}

export function clearOwnerEditorPendingMarker(
  storage: OwnerEditorStorage,
  ownerId: string,
  formSessionScope: string,
  marker: OwnerEditorPendingMarker,
  reply: OwnerEditorReply | null,
  originalOperationId: string,
  originalRequestHash: string,
): boolean {
  if (!mayClearOwnerEditorPendingMarker(reply, marker, originalOperationId, originalRequestHash))
    return false;
  const key = markerKey(ownerId, formSessionScope);
  const current = readOwnerEditorPendingMarker(storage, ownerId, formSessionScope);
  if (
    !current ||
    current.id !== marker.id ||
    current.command !== marker.command ||
    current.targetId !== marker.targetId
  )
    return false;
  storage.removeItem(key);
  if (storage.getItem(key) !== null)
    throw new Error('Pending owner editor marker removal could not be verified.');
  return true;
}
