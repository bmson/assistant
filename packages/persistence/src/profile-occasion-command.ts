import { isDeepStrictEqual } from 'node:util';
import type { Records } from './records.js';

/** Owner-scoped occasions, with provider-specific ownership and deduplication. */
export interface ProfileOccasionCommandInput {
  contactId: string;
  kind: 'birthday' | 'anniversary' | 'custom';
  label: string;
  month: number;
  day: number;
  year: number | null;
  leadDays: number;
  notes: string;
}

export interface ProfileOccasionCommandRepository {
  readonly kind: 'profile-occasion-command-repository';
  create(input: ProfileOccasionCommandInput): Promise<void>;
  update(
    occasionId: string,
    input: Omit<ProfileOccasionCommandInput, 'contactId'>,
    expectedContactId?: string,
  ): Promise<boolean>;
  forget(occasionId: string): Promise<void>;
  review(occasionId: string, verdict: 'approve' | 'reject'): Promise<void>;
}

export function isProfileOccasionCommandRepository(
  value: unknown,
): value is ProfileOccasionCommandRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'profile-occasion-command-repository'
  );
}

export interface OccasionCorrectionDate {
  month: number;
  day: number;
  year?: number | null;
}

export interface OccasionCorrectionInput {
  agentId: string;
  subject: string;
  kind: ProfileOccasionCommandInput['kind'];
  label?: string;
  expectedDate: OccasionCorrectionDate;
  date: OccasionCorrectionDate;
}

export type OccasionCorrectionReadback = Pick<
  Records['occasions'],
  'id' | 'contactId' | 'kind' | 'label' | 'month' | 'day' | 'year'
> & { person: string };

export type OccasionCorrectionResult =
  | { outcome: 'updated' | 'unchanged' | 'deleted'; occasion: OccasionCorrectionReadback }
  | {
      outcome:
        | 'contact_not_found'
        | 'ambiguous_contact'
        | 'occasion_not_found'
        | 'ambiguous_occasion'
        | 'invalid_date'
        | 'date_conflict'
        | 'stale_target';
    };

export type OccasionDeleteInput = Omit<OccasionCorrectionInput, 'date'>;
export type OccasionChatTool = 'occasions.update' | 'occasions.delete';
export interface OccasionChatOperation {
  taskId: string;
  dbToolCallId: string;
  modelToolCallId: string;
  taskLeaseToken: string;
}

export interface OccasionChatBinding {
  occasionId: string;
  contactId: string;
  expectedVersion: string;
}

export type OccasionChatResult = OccasionCorrectionResult & { ok: boolean; operationId: string };

export interface OccasionCorrectionRepository {
  correct(
    input: OccasionCorrectionInput,
    operation: OccasionChatOperation,
  ): Promise<OccasionChatResult>;
  delete(input: OccasionDeleteInput, operation: OccasionChatOperation): Promise<OccasionChatResult>;
}

export function occasionChatCallState(
  call: Records['toolCalls'] | undefined,
  input: OccasionCorrectionInput | OccasionDeleteInput,
  operation: OccasionChatOperation,
  tool: OccasionChatTool,
): {
  decision: Record<string, unknown>;
  binding?: OccasionChatBinding;
  result?: OccasionChatResult;
} {
  const { agentId: _ownerId, ...args } = input;
  const decision = call?.decision as Record<string, unknown> | null | undefined;
  if (
    !call ||
    call.id !== operation.dbToolCallId ||
    call.taskId !== operation.taskId ||
    call.toolName !== tool ||
    (tool === 'occasions.update') !== 'date' in input ||
    call.risk !== 'autonomous' ||
    call.idempotencyKey !== `${tool}:${operation.taskId}:${operation.modelToolCallId}` ||
    decision?.modelToolCallId !== operation.modelToolCallId ||
    !isDeepStrictEqual(call.args, args)
  )
    throw new Error('Occasion operation does not match its admitted call');
  const binding = decision.occasionMutation as OccasionChatBinding | undefined;
  if (
    binding !== undefined &&
    (!binding ||
      typeof binding.occasionId !== 'string' ||
      typeof binding.contactId !== 'string' ||
      typeof binding.expectedVersion !== 'string')
  )
    throw new Error('Occasion operation has an invalid target binding');
  if (call.status === 'succeeded') {
    const result = call.result as OccasionChatResult | null;
    if (
      !result ||
      result.operationId !== operation.modelToolCallId ||
      typeof result.outcome !== 'string' ||
      typeof result.ok !== 'boolean' ||
      (result.ok &&
        (!binding || !('occasion' in result) || result.occasion.id !== binding.occasionId))
    )
      throw new Error('Occasion operation has an invalid recorded result');
    return { decision, binding, result };
  }
  if (call.status !== 'executing') throw new Error('Occasion operation cannot execute');
  return { decision, binding };
}

export function occasionChatResult(
  operation: OccasionChatOperation,
  result: OccasionCorrectionResult,
): OccasionChatResult {
  return { ...result, ok: 'occasion' in result, operationId: operation.modelToolCallId };
}

export function matchesSavedOccasion(
  row: Pick<Records['occasions'], 'quarantined' | 'label' | 'year'>,
  input: OccasionDeleteInput,
): boolean {
  return (
    row.quarantined === false &&
    (input.label === undefined || row.label === input.label) &&
    (input.expectedDate.year === undefined || row.year === input.expectedDate.year)
  );
}

/** Compare full saved names only. Aliases and prefixes are deliberately excluded. */
export function sameOccasionContactName(saved: string, subject: string): boolean {
  return saved.trim().toLowerCase() === subject.trim().toLowerCase();
}

export function isOccasionCorrectionDate(date: OccasionCorrectionDate): boolean {
  const year = date.year ?? 2000;
  if (
    !Number.isInteger(year) ||
    year < 1000 ||
    year > 9999 ||
    !Number.isInteger(date.month) ||
    date.month < 1 ||
    date.month > 12 ||
    !Number.isInteger(date.day) ||
    date.day < 1 ||
    date.day > 31
  )
    return false;
  const calendarDate = new Date(Date.UTC(year, date.month - 1, date.day));
  return calendarDate.getUTCMonth() === date.month - 1 && calendarDate.getUTCDate() === date.day;
}

export function occasionCorrectionReadback(
  { id, contactId, kind, label, month, day, year }: Omit<OccasionCorrectionReadback, 'person'>,
  person: string,
): OccasionCorrectionReadback {
  return { id, contactId, kind, label, month, day, year, person };
}
