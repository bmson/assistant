import type { OwnerMemoryEditorSnapshot } from '@assistant/persistence';
import type {
  OwnerEditorFormGrant,
  OwnerEditorIssuanceContext,
  OwnerEditorSessionView,
} from '@assistant/persistence/owner-editor';
import { isValidFormSessionScope } from '@/app/auth-form-session-scope';
import { issueOwnerEditorFormGrant } from './owner-editor-scope';

export interface OwnerMemoryEditorView {
  snapshot: OwnerMemoryEditorSnapshot;
  session: OwnerEditorSessionView | null;
  grant: OwnerEditorFormGrant | null;
  unavailableReason: string | null;
}

/** Grant and displayed text come from the same authoritative bounded snapshot. */
export function buildOwnerMemoryEditorView(input: {
  snapshot: OwnerMemoryEditorSnapshot;
  context: OwnerEditorIssuanceContext | null;
  formSessionScope: string | undefined;
  secret: string | undefined;
  enabled: boolean;
  now?: number;
}): OwnerMemoryEditorView {
  const { snapshot, context, formSessionScope, secret } = input;
  const unavailable = (reason: string): OwnerMemoryEditorView => ({
    snapshot,
    session: null,
    grant: null,
    unavailableReason: reason,
  });
  if (!snapshot.eligible) return unavailable(snapshot.readOnlyReason ?? 'unverified_source');
  if (!input.enabled) return unavailable('maintenance');
  if (!context) return unavailable('editing_not_enabled');
  if (
    snapshot.ownerId !== context.ownerId ||
    !/^[a-f0-9]{64}$/.test(snapshot.revision) ||
    !/^[a-f0-9]{64}$/.test(snapshot.contentHash)
  )
    return unavailable('unverified_source');
  if (!secret || !isValidFormSessionScope(formSessionScope)) return unavailable('refresh_session');
  const session = { ownerId: context.ownerId, formSessionScope };
  return {
    snapshot,
    session,
    grant: issueOwnerEditorFormGrant({
      context,
      session,
      command: 'correct_owner_memory',
      targetId: snapshot.memoryId,
      secret,
      now: input.now,
    }),
    unavailableReason: null,
  };
}

export function ownerMemoryReadOnlyMessage(reason: string | null | undefined): string {
  switch (reason) {
    case 'maintenance':
      return 'Editing is temporarily paused for maintenance.';
    case 'editing_not_enabled':
      return 'Editing has not been enabled for this installation.';
    case 'refresh_session':
      return 'Refresh your session before editing this saved note.';
    case 'shared_source':
      return 'This note has shared evidence and cannot be changed here.';
    case 'conflicting_lineage':
    case 'multiple_import_sources':
    case 'multiple_import_units':
    case 'aggregate_source':
      return 'This note combines source evidence and cannot be changed here.';
    case 'superseded':
      return 'A newer saved note has replaced this one.';
    case 'tombstoned':
      return 'This note has been forgotten and cannot be edited.';
    case 'quarantined':
      return 'This note needs source review before it can be edited.';
    case 'expired_or_invalid_lifecycle':
      return 'This note is expired or its saved state cannot be verified.';
    case 'memory_content_hash_mismatch':
      return 'This note’s saved content could not be verified, so correction attribution is unavailable.';
    case 'malformed_owner_correction':
      return 'This note’s correction history could not be verified.';
    case 'unsupported_import_provenance':
      return 'A single source item for this imported note could not be verified.';
    case 'unverified_extraction_source':
      return 'The conversation or email behind this saved note could not be verified.';
    case 'incomplete_provenance':
      return 'Source verification could not be completed within the supported limits.';
    case 'unverified_subject':
      return 'The person this note belongs to could not be verified.';
    case 'unsupported_memory_category':
      return 'This item is not a durable knowledge note and cannot be edited here.';
    case 'source_identity_mismatch':
      return 'The saved source reference does not match this note.';
    default:
      return 'The exact source of this note could not be verified, so it is read-only here.';
  }
}
