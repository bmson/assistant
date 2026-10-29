import type { OwnerEditorCommand } from '@assistant/persistence/owner-editor';

/**
 * Commands supported by the bounded basic-editing release. Keep this allowlist
 * explicit so adding a wire-level command never silently enables a new writer.
 */
export const BASIC_OWNER_EDITOR_COMMANDS = Object.freeze([
  'create_person',
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
] as const satisfies readonly OwnerEditorCommand[]);

export type BasicOwnerEditorCommand = (typeof BASIC_OWNER_EDITOR_COMMANDS)[number];

const basicCommandSet: ReadonlySet<string> = new Set(BASIC_OWNER_EDITOR_COMMANDS);

export function isBasicOwnerEditorCommand(value: unknown): value is BasicOwnerEditorCommand {
  return typeof value === 'string' && basicCommandSet.has(value);
}
