import type { CardForm, CardFormSubmission, CardFormValues } from './card-form.js';
import type { Records } from './records.js';

export const CARD_FORM_ADMISSION_PROTOCOL = 'card-form-v1' as const;

/** One owner + operation ID is the durable idempotency namespace. */
export function cardFormAdmissionExternalEventId(input: {
  agentId: string;
  operationId: string;
}): string {
  return `card-form:${input.agentId}:${input.operationId}`;
}

/** Durable one-active-submit key; stored in taskEventKeys for adapter parity. */
export function cardFormAdmissionActiveEventId(input: {
  agentId: string;
  cardId: string;
  formId: string;
}): string {
  return `card-form-active:${input.agentId}:${input.cardId}:${input.formId}`;
}

export interface CardFormAdmissionPrepared {
  /** Exact trimmed owner text that was reviewed in the editable composer. */
  ownerMessageText: string;
}

export type CardFormAdmissionResult =
  | {
      ok: true;
      created: boolean;
      taskId: string;
      messageId: string;
      taskStatus: string;
      queueGeneration: number;
      dispatch: 'notify' | 'outbox' | null;
    }
  | { ok: false; status: 404 | 409 | 422; error: string; reason?: never }
  | {
      ok: false;
      status: 409;
      /** Confirmed unadmitted operation; answers require review against a newer revision. */
      reason: 'stale_revision';
      error: string;
    }
  | {
      ok: false;
      status: 409;
      reason: 'active_form';
      /** Another confirmed request blocks this unsent draft; this is not its admission receipt. */
      activeTaskId: string;
      taskStatus: string;
      error: string;
    };

export interface CardFormAdmissionRepository {
  readonly kind: 'card-form-admission-repository';
  submit(input: {
    agentId: string;
    submission: unknown;
    prepare: (context: {
      revisionSpec: unknown;
      form: CardForm;
      values: CardFormValues;
      ownerMessageText: string;
    }) => CardFormAdmissionPrepared | null;
  }): Promise<CardFormAdmissionResult>;
}

export interface CardFormTaskAdmission extends Record<string, unknown> {
  protocol: typeof CARD_FORM_ADMISSION_PROTOCOL;
  operationId: string;
  cardId: string;
  expectedRevisionId: string;
  conversationId: string;
  formId: string;
  payloadDigest: string;
  messageId: string;
}

export function cardFormTaskAdmission(
  task: Pick<Records['tasks'], 'trigger'>,
): CardFormTaskAdmission | null {
  const trigger = task.trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null;
  const payload = (trigger as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).cardFormAdmission;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt).sort();
  if (
    keys.join(',') !==
    'cardId,conversationId,expectedRevisionId,formId,messageId,operationId,payloadDigest,protocol'
  )
    return null;
  if (
    receipt.protocol !== CARD_FORM_ADMISSION_PROTOCOL ||
    typeof receipt.operationId !== 'string' ||
    typeof receipt.cardId !== 'string' ||
    typeof receipt.expectedRevisionId !== 'string' ||
    typeof receipt.conversationId !== 'string' ||
    typeof receipt.formId !== 'string' ||
    typeof receipt.payloadDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(receipt.payloadDigest) ||
    typeof receipt.messageId !== 'string'
  )
    return null;
  return receipt as CardFormTaskAdmission;
}

export type CardFormSubmissionRequest = CardFormSubmission;
