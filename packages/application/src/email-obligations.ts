import type {
  EmailObligationDecision,
  EmailObligationRecord,
  EmailSyncRepository,
} from '@assistant/persistence';

export type EmailObligationView = EmailObligationRecord;

export function listOwnerEmailObligations(
  repository: EmailSyncRepository,
  now = new Date(),
): Promise<EmailObligationView[]> {
  return repository.listEmailObligations(now);
}

export function decideOwnerEmailObligation(
  repository: EmailSyncRepository,
  input: {
    channelMessageId: string;
    expectedVersion: number;
    decision: EmailObligationDecision;
    now?: Date;
    snoozedUntil?: Date;
  },
): Promise<boolean> {
  if (
    input.decision === 'snooze' &&
    (!input.snoozedUntil || input.snoozedUntil <= (input.now ?? new Date()))
  ) {
    throw new Error('A snooze must end in the future');
  }
  return repository.decideEmailObligation({ ...input, now: input.now ?? new Date() });
}
