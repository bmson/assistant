import type {
  OwnerEditorCorrectionEligibility,
  OwnerEditorIssuanceContext,
  OwnerEditorPersonOption,
  OwnerEditorPersonRemovalImpact,
} from '@assistant/persistence/owner-editor';
import type { OwnerEditorControlsProps } from '@/app/people/owner-editor-controls';
import { isValidFormSessionScope } from '../app/auth-form-session-scope';
import { issueOwnerEditorFormGrant } from './owner-editor-scope';

/** Native snapshots are read inside the page's existing owner/privacy boundary. */
export interface OwnerEditorViewSnapshot {
  ownerId: string;
  identity?: {
    contactId: string;
    name: string;
    aliases: string[];
    trust: string;
    revision: string;
  } | null;
  people?: OwnerEditorPersonOption[];
  corrections?: OwnerEditorCorrectionEligibility[];
  personRemoval?: OwnerEditorPersonRemovalImpact;
  personRemovalUnavailableReason?: string;
  readOnlyCorrections?: { relationId: string; sourceMemoryId: string; reason: string }[];
}
export interface OwnerEditorDisplayedContact {
  id: string;
  name: string;
  aliases: string[];
  trust: string;
  identityRevision?: string | null;
}

/** No storage/activation/provider access. Null issuance keeps B1 browsing usable. */
export function buildOwnerEditorView(input: {
  enabled: boolean;
  context: OwnerEditorIssuanceContext | null;
  snapshot: OwnerEditorViewSnapshot;
  formSessionScope: string | undefined;
  secret: string | undefined;
  displayedContact?: OwnerEditorDisplayedContact;
  displayedRelationships?: {
    id: string;
    sentence: string;
    validFrom: string | null;
    validUntil: string | null;
  }[];
  now?: number;
}): OwnerEditorControlsProps | null {
  const { context, snapshot, formSessionScope, secret, displayedContact } = input;
  if (
    !input.enabled ||
    !context ||
    !secret ||
    !isValidFormSessionScope(formSessionScope) ||
    snapshot.ownerId !== context.ownerId
  )
    return null;
  const identity = snapshot.identity;
  if (
    identity &&
    (!displayedContact?.identityRevision ||
      !/^[a-f0-9]{64}$/.test(displayedContact.identityRevision) ||
      !identity ||
      identity.contactId !== displayedContact.id ||
      identity.name !== displayedContact.name ||
      identity.trust !== displayedContact.trust ||
      identity.revision !== displayedContact.identityRevision ||
      JSON.stringify(identity.aliases) !== JSON.stringify(displayedContact.aliases))
  )
    return null;
  if (identity?.trust === 'owner') return null;
  const people = snapshot.people ?? [];
  if (
    identity &&
    (!/^[a-f0-9]{64}$/.test(identity.revision) ||
      !people.some(
        (person) =>
          person.contactId === identity.contactId &&
          person.name === identity.name &&
          person.revision === identity.revision,
      ))
  )
    return null;
  try {
    const session = { ownerId: context.ownerId, formSessionScope };
    const grant = (
      command: Parameters<typeof issueOwnerEditorFormGrant>[0]['command'],
      targetId: string | null,
    ) => issueOwnerEditorFormGrant({ context, session, command, targetId, secret, now: input.now });
    return {
      session,
      createGrant: grant('create_person', null),
      readOnlyCorrections: snapshot.readOnlyCorrections,
      ...(identity
        ? {
            identity: {
              grant: grant('update_person_identity', identity.contactId),
              contactId: identity.contactId,
              name: identity.name,
              aliases: identity.aliases,
              revision: displayedContact?.identityRevision ?? '',
            },
            personRemovalUnavailableReason:
              'Deleting people is not available in this release. You can still edit saved details and relationships.',
            family: {
              grant: grant('add_family_relationship', identity.contactId),
              anchorContactId: identity.contactId,
              people,
              expectedCanonicalState: { kind: 'absent' as const },
              savedRelationships: (input.displayedRelationships ?? []).map((relationship) => ({
                relationId: relationship.id,
                sentence: relationship.sentence,
                validFrom: relationship.validFrom,
                validUntil: relationship.validUntil,
              })),
            },
            corrections: (snapshot.corrections ?? []).map((eligibility) => ({
              grant: grant('correct_owner_family_relationship', eligibility.relationId),
              eligibility,
            })),
          }
        : {}),
    };
  } catch {
    return null;
  }
}
