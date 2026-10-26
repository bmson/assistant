import type { ProfileContactIdentityMutation } from './profile-contact-identity.js';

/** Owner-scoped person mutations that are safe to implement per persistence provider. */
export interface ProfilePeopleCommandRepository {
  readonly kind: 'profile-people-command-repository';
  create(input: { name: string; relationship: string; aliases: string[] }): Promise<string>;
  updateRelationship(contactId: string, relationship: string): Promise<void>;
  updateIdentity(
    contactId: string,
    name: string,
    aliases: string[],
    expectedContactRevision?: string,
    relationship?: string,
  ): Promise<ProfileContactIdentityMutation>;
}

export function isProfilePeopleCommandRepository(
  value: unknown,
): value is ProfilePeopleCommandRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'profile-people-command-repository'
  );
}

/**
 * Destructive person commands that touch more records than one transaction
 * may hold. Facts are moved or forgotten in bounded steps first; the final
 * step re-checks that none remain before it removes the contact, so an
 * interrupted command can simply be retried.
 */
export interface ProfilePeopleRemovalRepository {
  readonly kind: 'profile-people-removal-repository';
  /** Throws `Person not found.` or `The owner profile cannot be deleted.`. */
  assertRemovable(contactId: string): Promise<void>;
  /** Up to `limit` of the owner's fact IDs about this person. */
  subjectMemoryIds(contactId: string, limit: number): Promise<string[]>;
  /** Re-attribute up to `limit` facts from source to target; returns how many moved. */
  reassignSubjectMemories(sourceId: string, targetId: string, limit: number): Promise<number>;
  /** Remove the person's occasions and graph links, then the person. */
  finishDelete(contactId: string): Promise<{ deletedOccasions: number }>;
  /** Move occasions, union identity fields into the target, then remove the source. */
  finishMerge(sourceId: string, targetId: string): Promise<{ movedOccasions: number }>;
}

/** Complete bounded editor read projection; issuance stays in the authenticated composition. */
export interface OwnerEditorPeopleReadSnapshot {
  ownerId: string;
  people: import('./owner-editor.js').OwnerEditorPersonOption[];
  identity: {
    contactId: string;
    name: string;
    aliases: string[];
    trust: string;
    revision: string;
  } | null;
  corrections: import('./owner-editor.js').OwnerEditorCorrectionEligibility[];
}
