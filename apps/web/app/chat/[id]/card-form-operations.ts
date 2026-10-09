import {
  type CardForm,
  type CardFormSubmission,
  CardFormSubmissionSchema,
  type CardFormValues,
  canonicalCardFormValues,
} from '@assistant/persistence/card-form';

const STORAGE_PREFIX = 'assistant:card-form:v1:';
const SESSION_PREFIX = 'assistant:card-form-session:v1:';
const ACTIVE_SESSION_SCOPE_KEY = 'assistant:card-form-active-scope:v1';
const MAX_SAVED_DRAFT_CHARS = 16_384;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let callbackGeneration = 0;

/** Async form callbacks captured before a verified session transition must not write afterward. */
export function cardFormCallbackGeneration(): number {
  return callbackGeneration;
}

export interface ActiveCardFormConflict {
  taskId: string;
  taskStatus: string;
  error: string;
}

export function parseStaleCardFormConflict(value: unknown): { error: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.ok !== false ||
    row.status !== 409 ||
    row.reason !== 'stale_revision' ||
    typeof row.error !== 'string' ||
    !row.error ||
    row.error.length > 500
  )
    return null;
  return { error: row.error };
}

export function parseActiveCardFormConflict(value: unknown): ActiveCardFormConflict | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.ok !== false ||
    row.status !== 409 ||
    row.reason !== 'active_form' ||
    typeof row.activeTaskId !== 'string' ||
    !UUID_RE.test(row.activeTaskId) ||
    typeof row.taskStatus !== 'string' ||
    !row.taskStatus ||
    row.taskStatus.length > 40 ||
    typeof row.error !== 'string' ||
    row.error.length > 500
  )
    return null;
  return { taskId: row.activeTaskId, taskStatus: row.taskStatus, error: row.error };
}

export interface CardFormOperationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Keep drafts partitioned to the authenticated browser session, never just the owner or chat. */
export function sessionScopedCardFormStorage(
  storage: CardFormSessionStorage,
  scope: string,
): CardFormOperationStorage {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(scope))
    throw new Error('The authenticated form session is unavailable.');
  const activeScope = storage.getItem(ACTIVE_SESSION_SCOPE_KEY);
  if (activeScope !== scope) {
    if (activeScope && /^[A-Za-z0-9_-]{16,128}$/.test(activeScope)) {
      clearCardFormSessionStorage(storage, activeScope);
    } else if (activeScope !== null) {
      clearCardFormSessionStorage(storage);
    }
    storage.setItem(ACTIVE_SESSION_SCOPE_KEY, scope);
  }
  const prefix = `${SESSION_PREFIX}${encodeURIComponent(scope)}:`;
  return {
    getItem: (key) => storage.getItem(`${prefix}${key}`),
    setItem: (key, value) => storage.setItem(`${prefix}${key}`, value),
    removeItem: (key) => storage.removeItem(`${prefix}${key}`),
  };
}

export interface CardFormSessionStorage extends CardFormOperationStorage {
  readonly length: number;
  key(index: number): string | null;
}

/** Remove only this feature's namespaced drafts after successful sign out or a verified scope change. */
export function clearCardFormSessionStorage(storage: CardFormSessionStorage, scope?: string): void {
  if (scope !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(scope))
    throw new Error('The authenticated form session is unavailable.');
  callbackGeneration += 1;
  const prefix =
    scope === undefined ? SESSION_PREFIX : `${SESSION_PREFIX}${encodeURIComponent(scope)}:`;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) storage.removeItem(key);
  }
  const activeScope = storage.getItem(ACTIVE_SESSION_SCOPE_KEY);
  if (scope === undefined || activeScope === scope) storage.removeItem(ACTIVE_SESSION_SCOPE_KEY);
}

export interface CardFormIdentity {
  conversationId: string;
  cardId: string;
  revisionId: string;
  formId: string;
}

export interface FrozenCardFormOperation {
  submission: CardFormSubmission;
  taskId?: string;
  cursor?: string;
}

export interface BlockedCardFormDraft {
  taskId: string;
  taskStatus: string;
  submission: CardFormSubmission;
}

export interface CardFormDraft {
  version: 1;
  identity: CardFormIdentity;
  values: CardFormValues;
  reviewed?: boolean;
  composerText?: string;
  operation?: FrozenCardFormOperation;
  blockedByTask?: BlockedCardFormDraft;
  releasedBlockedTask?: boolean;
}

export function cardFormDraftKey(conversationId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(conversationId)}`;
}

function identityMatches(a: CardFormIdentity, b: CardFormIdentity): boolean {
  return (
    a.conversationId === b.conversationId &&
    a.cardId === b.cardId &&
    a.revisionId === b.revisionId &&
    a.formId === b.formId
  );
}

function validIdentity(value: unknown): value is CardFormIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).sort().join(',') === 'cardId,conversationId,formId,revisionId' &&
    typeof row.conversationId === 'string' &&
    UUID_RE.test(row.conversationId) &&
    typeof row.cardId === 'string' &&
    UUID_RE.test(row.cardId) &&
    typeof row.revisionId === 'string' &&
    UUID_RE.test(row.revisionId) &&
    typeof row.formId === 'string' &&
    /^[a-z0-9_-]{1,40}$/.test(row.formId)
  );
}

function validateDraft(value: unknown, conversationId: string): CardFormDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Saved form draft is malformed');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) =>
        ![
          'version',
          'identity',
          'values',
          'reviewed',
          'composerText',
          'operation',
          'blockedByTask',
          'releasedBlockedTask',
        ].includes(key),
    ) ||
    row.version !== 1 ||
    !validIdentity(row.identity) ||
    row.identity.conversationId !== conversationId ||
    (row.reviewed !== undefined && typeof row.reviewed !== 'boolean') ||
    (row.releasedBlockedTask !== undefined && typeof row.releasedBlockedTask !== 'boolean') ||
    (row.composerText !== undefined &&
      (typeof row.composerText !== 'string' || row.composerText.length > 4000)) ||
    !row.values ||
    typeof row.values !== 'object' ||
    Array.isArray(row.values) ||
    Object.keys(row.values).length > 4 ||
    Object.entries(row.values).some(
      ([key, item]) =>
        !/^[a-z0-9_-]{1,40}$/.test(key) ||
        !(typeof item === 'boolean' || (typeof item === 'string' && item.length <= 500)),
    )
  )
    throw new Error('Saved form draft is malformed');
  let operation: FrozenCardFormOperation | undefined;
  if (row.operation !== undefined) {
    if (!row.operation || typeof row.operation !== 'object' || Array.isArray(row.operation))
      throw new Error('Saved form operation is malformed');
    const saved = row.operation as Record<string, unknown>;
    if (Object.keys(saved).some((key) => !['submission', 'taskId', 'cursor'].includes(key)))
      throw new Error('Saved form operation is malformed');
    const parsed = CardFormSubmissionSchema.safeParse(saved.submission);
    if (
      !parsed.success ||
      parsed.data.conversationId !== row.identity.conversationId ||
      parsed.data.cardId !== row.identity.cardId ||
      parsed.data.expectedRevisionId !== row.identity.revisionId ||
      parsed.data.formId !== row.identity.formId ||
      ('taskId' in saved && (typeof saved.taskId !== 'string' || !UUID_RE.test(saved.taskId))) ||
      ('cursor' in saved && (typeof saved.cursor !== 'string' || saved.cursor.length > 200))
    )
      throw new Error('Saved form operation is malformed');
    operation = {
      submission: parsed.data,
      ...(typeof saved.taskId === 'string' ? { taskId: saved.taskId } : {}),
      ...(typeof saved.cursor === 'string' ? { cursor: saved.cursor } : {}),
    };
  }
  let blockedByTask: BlockedCardFormDraft | undefined;
  if (row.blockedByTask !== undefined) {
    const blocked = row.blockedByTask as Record<string, unknown> | null;
    const parsed = CardFormSubmissionSchema.safeParse(blocked?.submission);
    if (
      !blocked ||
      Array.isArray(blocked) ||
      Object.keys(blocked).some((key) => !['taskId', 'taskStatus', 'submission'].includes(key)) ||
      !parsed.success ||
      typeof blocked.taskId !== 'string' ||
      !UUID_RE.test(blocked.taskId) ||
      typeof blocked.taskStatus !== 'string' ||
      blocked.taskStatus.length > 40 ||
      parsed.data.conversationId !== row.identity.conversationId ||
      parsed.data.cardId !== row.identity.cardId ||
      parsed.data.expectedRevisionId !== row.identity.revisionId ||
      parsed.data.formId !== row.identity.formId ||
      operation
    )
      throw new Error('Saved form wait is malformed');
    blockedByTask = {
      taskId: blocked.taskId,
      taskStatus: blocked.taskStatus,
      submission: parsed.data,
    };
  }
  return {
    version: 1,
    identity: row.identity,
    values: row.values as CardFormValues,
    reviewed: row.reviewed === true,
    ...(typeof row.composerText === 'string' ? { composerText: row.composerText } : {}),
    ...(operation ? { operation } : {}),
    ...(blockedByTask ? { blockedByTask } : {}),
    ...(row.releasedBlockedTask === true ? { releasedBlockedTask: true } : {}),
  };
}

export function readCardFormDraft(
  storage: Pick<CardFormOperationStorage, 'getItem'>,
  conversationId: string,
): CardFormDraft | null {
  const raw = storage.getItem(cardFormDraftKey(conversationId));
  if (raw === null) return null;
  try {
    if (raw.length > MAX_SAVED_DRAFT_CHARS) throw new Error('Saved form draft is too large');
    return validateDraft(JSON.parse(raw) as unknown, conversationId);
  } catch {
    throw new Error('Saved form draft is unavailable. Keep the page open and try again.');
  }
}

export function saveCardFormDraft(storage: CardFormOperationStorage, draft: CardFormDraft): void {
  storage.setItem(cardFormDraftKey(draft.identity.conversationId), JSON.stringify(draft));
}

export function markCardFormReviewed(
  storage: CardFormOperationStorage,
  draft: CardFormDraft,
  composerText: string,
): CardFormDraft {
  if (composerText.length > 4000) throw new Error('The reviewed message is too long.');
  const reviewed = { ...draft, reviewed: true, composerText, releasedBlockedTask: undefined };
  saveCardFormDraft(storage, reviewed);
  return reviewed;
}

export function updateCardFormValues(input: {
  storage: CardFormOperationStorage;
  current: CardFormDraft | null;
  identity: CardFormIdentity;
  values: CardFormValues;
}): CardFormDraft {
  if (input.current?.blockedByTask)
    throw new Error(
      'Another request for this form is still running. Wait for its exact task result.',
    );
  if (input.current?.operation)
    throw new Error('This form request is still awaiting an exact task result.');
  if (input.current && !identityMatches(input.current.identity, input.identity))
    throw new Error('Review or clear the current form draft before opening another form.');
  const draft: CardFormDraft = {
    version: 1,
    identity: input.identity,
    values: input.values,
    reviewed: false,
  };
  saveCardFormDraft(input.storage, draft);
  return draft;
}

export function beginCardFormOperation(input: {
  storage: CardFormOperationStorage;
  draft: CardFormDraft;
  form: CardForm;
  ownerMessageText: string;
  createId: () => string;
}): CardFormDraft {
  if (input.draft.blockedByTask)
    throw new Error(
      'Another request for this form is still running. Wait for its exact task result.',
    );
  const values = canonicalCardFormValues(input.form, input.draft.values);
  if (!values) throw new Error('Review the form answers before sending.');
  const ownerMessageText = input.ownerMessageText.trim();
  const existing = input.draft.operation?.submission;
  if (existing) {
    if (
      existing.ownerMessageText !== ownerMessageText ||
      JSON.stringify(existing.values) !== JSON.stringify(values)
    )
      throw new Error(
        'This request is already in progress. Wait for its result before editing it.',
      );
    return input.draft;
  }
  const operationId = input.createId();
  if (!UUID_RE.test(operationId)) throw new Error('A form send ID is unavailable.');
  const parsed = CardFormSubmissionSchema.safeParse({
    protocol: 'card-form-v1',
    conversationId: input.draft.identity.conversationId,
    cardId: input.draft.identity.cardId,
    expectedRevisionId: input.draft.identity.revisionId,
    formId: input.draft.identity.formId,
    operationId,
    values,
    ownerMessageText,
  });
  if (!parsed.success) throw new Error('This form cannot be sent in its current version.');
  const draft: CardFormDraft = {
    ...input.draft,
    values,
    composerText: undefined,
    releasedBlockedTask: undefined,
    operation: { submission: parsed.data },
  };
  saveCardFormDraft(input.storage, draft);
  return draft;
}

export function recordCardFormTask(input: {
  storage: CardFormOperationStorage;
  draft: CardFormDraft;
  operationId: string;
  taskId: string;
  cursor: string;
}): CardFormDraft {
  const operation = input.draft.operation;
  if (!operation || operation.submission.operationId !== input.operationId) return input.draft;
  if (!UUID_RE.test(input.taskId) || input.cursor.length > 200)
    throw new Error('The form task receipt is malformed.');
  const draft: CardFormDraft = {
    ...input.draft,
    operation: { ...operation, taskId: input.taskId, cursor: input.cursor },
  };
  saveCardFormDraft(input.storage, draft);
  return draft;
}

/** Keep the rejected submission as an unsent draft while another same-form task finishes. */
export function blockCardFormDraftForTask(input: {
  storage: CardFormOperationStorage;
  draft: CardFormDraft;
  operationId: string;
  taskId: string;
  taskStatus: string;
}): CardFormDraft {
  const operation = input.draft.operation;
  if (!operation || operation.submission.operationId !== input.operationId) return input.draft;
  if (!UUID_RE.test(input.taskId) || !input.taskStatus || input.taskStatus.length > 40)
    throw new Error('The active form task receipt is malformed.');
  const draft: CardFormDraft = {
    ...input.draft,
    operation: undefined,
    blockedByTask: {
      taskId: input.taskId,
      taskStatus: input.taskStatus,
      submission: operation.submission,
    },
  };
  saveCardFormDraft(input.storage, draft);
  return draft;
}

export function releaseBlockedCardFormDraft(input: {
  storage: CardFormOperationStorage;
  draft: CardFormDraft;
  taskId: string;
  status: string;
}): CardFormDraft {
  if (
    input.draft.blockedByTask?.taskId !== input.taskId ||
    !TERMINAL_TASK_STATUSES.has(input.status)
  )
    return input.draft;
  const draft: CardFormDraft = {
    ...input.draft,
    reviewed: true,
    composerText: input.draft.blockedByTask.submission.ownerMessageText,
    blockedByTask: undefined,
    releasedBlockedTask: true,
  };
  saveCardFormDraft(input.storage, draft);
  return draft;
}

/** Explicitly carry compatible values to a newer revision of the same form. */
export function carryCardFormDraft(input: {
  storage: CardFormOperationStorage;
  draft: CardFormDraft;
  identity: CardFormIdentity;
  form: CardForm;
}): CardFormDraft {
  if (
    input.draft.operation ||
    input.draft.blockedByTask ||
    input.draft.identity.conversationId !== input.identity.conversationId ||
    input.draft.identity.cardId !== input.identity.cardId ||
    input.draft.identity.formId !== input.identity.formId ||
    input.draft.identity.revisionId === input.identity.revisionId ||
    input.form.id !== input.identity.formId
  )
    throw new Error('These answers cannot be carried to this form version.');

  const values: CardFormValues = Object.create(null);
  for (const field of input.form.fields) {
    if (!Object.hasOwn(input.draft.values, field.id)) continue;
    const compatible = canonicalCardFormValues(
      { ...input.form, fields: [{ ...field, required: false }] },
      { [field.id]: input.draft.values[field.id] },
    );
    if (compatible && Object.hasOwn(compatible, field.id)) values[field.id] = compatible[field.id];
  }
  const carried: CardFormDraft = {
    version: 1,
    identity: input.identity,
    values,
    reviewed: false,
  };
  saveCardFormDraft(input.storage, carried);
  return carried;
}

const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'cancelled']);

/** A validated stale-revision rejection is definitive: keep the values/text and require a fresh review. */
export function releaseStaleCardFormOperation(input: {
  storage: CardFormOperationStorage;
  draft: CardFormDraft;
  operationId: string;
}): CardFormDraft {
  if (input.draft.operation?.submission.operationId !== input.operationId) return input.draft;
  const draft: CardFormDraft = {
    ...input.draft,
    reviewed: false,
    composerText: input.draft.operation.submission.ownerMessageText,
    operation: undefined,
  };
  saveCardFormDraft(input.storage, draft);
  return draft;
}

export function settleCardFormTask(input: {
  storage: CardFormOperationStorage;
  draft: CardFormDraft;
  taskId: string;
  status: string;
}): CardFormDraft | null {
  const operation = input.draft.operation;
  if (!operation || operation.taskId !== input.taskId || !TERMINAL_TASK_STATUSES.has(input.status))
    return input.draft;
  if (input.status === 'done') {
    discardCardFormDraft(input.storage, input.draft.identity.conversationId);
    return null;
  }
  const draft: CardFormDraft = {
    ...input.draft,
    reviewed: false,
    composerText: operation.submission.ownerMessageText,
    operation: undefined,
  };
  saveCardFormDraft(input.storage, draft);
  return draft;
}

export function formatCardFormMessage(form: CardForm, values: CardFormValues): string {
  const lines = [`${form.title}:`];
  for (const field of form.fields) {
    const value = values[field.id];
    if (value === undefined || value === '') continue;
    const display =
      field.type === 'boolean'
        ? value === true
          ? 'Yes'
          : 'No'
        : field.type === 'choice'
          ? (field.options.find((option) => option.id === value)?.label ?? String(value))
          : String(value);
    lines.push(`${field.label}: ${display}`);
  }
  return lines.join('\n');
}

export function discardCardFormDraft(
  storage: CardFormOperationStorage,
  conversationId: string,
): void {
  storage.removeItem(cardFormDraftKey(conversationId));
}
