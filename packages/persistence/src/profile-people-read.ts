import type { Records } from './records.js';

export type ProfileContact = Records['contacts'];
export type ProfileContactSnapshot = ProfileContact & { identityRevision: string };
export type ProfileFact = Records['memories'];
export type ProfileOccasion = Records['occasions'];

/** Reads behind the owner About page and an individual person's profile. */
export interface ProfilePeopleReadRepository {
  readonly kind: 'profile-people-read-repository';
  getOwnerContact(): Promise<ProfileContactSnapshot | null>;
  getContact(id: string): Promise<ProfileContactSnapshot | null>;
  /** Complete, name-ordered list; merge suggestions must not silently lose contacts. */
  listContacts(): Promise<ProfileContactSnapshot[]>;
  /** Active knowledge facts in profile order, plus an exact unbounded count. */
  getFacts(contactId: string, limit: number): Promise<{ rows: ProfileFact[]; total: number }>;
  getOwnerCard(): Promise<Pick<Records['ownerCard'], 'content' | 'compiledAt'> | null>;
  listOccasions(contactId: string): Promise<ProfileOccasion[]>;
}

export function isProfilePeopleReadRepository(
  value: unknown,
): value is ProfilePeopleReadRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'profile-people-read-repository'
  );
}
