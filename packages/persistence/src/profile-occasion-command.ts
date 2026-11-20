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
  import('./records.js').Records['occasions'],
  'id' | 'contactId' | 'kind' | 'label' | 'month' | 'day' | 'year'
> & { person: string };

export type OccasionCorrectionResult =
  | { outcome: 'updated' | 'unchanged'; occasion: OccasionCorrectionReadback }
  | {
      outcome:
        | 'contact_not_found'
        | 'ambiguous_contact'
        | 'occasion_not_found'
        | 'ambiguous_occasion'
        | 'invalid_date'
        | 'date_conflict';
    };

export interface OccasionCorrectionRepository {
  correct(input: OccasionCorrectionInput): Promise<OccasionCorrectionResult>;
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
